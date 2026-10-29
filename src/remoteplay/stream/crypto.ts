/* eslint-disable no-bitwise */

import crypto from "crypto";

/** Generation size of the MAC key schedule, in key-stream bytes (spec 7.4) */
const MAC_KEY_GENERATION_SIZE = BigInt(45000);

/** IV step between MAC key generations (spec 7.4) */
const MAC_KEY_IV_STEP = BigInt(44910);

const MAX_128 = (BigInt(1) << BigInt(128)) - BigInt(1);

export const HANDSHAKE_KEY_LENGTH = 16;
export const ECDH_CURVE = "secp256k1";

/** Context index used for client-to-console packets (spec 7) */
export const CLIENT_CONTEXT_INDEX = 2;

/**
 * Treat the 16-byte `value` as one little-endian 128-bit integer,
 * add `n`, and return the result as 16 bytes (spec 0, "LE-add").
 */
export function leAdd(value: Buffer, n: bigint | number): Buffer {
    if (value.length !== 16) {
        throw new Error(`LE-add needs 16 bytes; got ${value.length}`);
    }

    let asInt = BigInt(0);
    for (let i = 15; i >= 0; i--) {
        asInt = (asInt << BigInt(8)) | BigInt(value[i]);
    }

    asInt = (asInt + BigInt(n)) & MAX_128;

    const result = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        result[i] = Number(asInt & BigInt(0xff));
        asInt >>= BigInt(8);
    }

    return result;
}

function fold(hash: Buffer) {
    const result = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
        result[i] = hash[i] ^ hash[i + 16];
    }
    return result;
}

function sha256(...parts: Buffer[]) {
    const hash = crypto.createHash("sha256");
    for (const part of parts) {
        hash.update(part);
    }
    return hash.digest();
}

function hmacSha256(key: Buffer, message: Buffer) {
    return crypto.createHmac("sha256", key).update(message).digest();
}

export function signPublicKey(handshakeKey: Buffer, publicKey: Buffer) {
    return hmacSha256(handshakeKey, publicKey);
}

/**
 * Derive the cipher key and base IV for a crypto context (spec 7.2)
 */
export function deriveContextKeys(
    ecdhSecret: Buffer,
    handshakeKey: Buffer,
    index: number,
) {
    if (handshakeKey.length !== HANDSHAKE_KEY_LENGTH) {
        throw new Error(`Invalid handshake key length: ${handshakeKey.length}`);
    }

    const derivation = Buffer.concat([
        Buffer.from([0x01, index, 0x00]),
        handshakeKey,
        Buffer.from([0x01, 0x00]),
    ]);
    const digest = hmacSha256(ecdhSecret, derivation);

    return {
        cipherKey: digest.slice(0, 16),
        baseIv: digest.slice(16, 32),
    };
}

/** MAC key generation for a key position (spec 7.4) */
export function macKeyGeneration(keyPos: bigint) {
    if (keyPos === BigInt(0)) {
        return BigInt(0);
    }
    return (keyPos - BigInt(1)) / MAC_KEY_GENERATION_SIZE;
}

/**
 * One direction's key stream and MAC state (spec 7.3 - 7.5).
 */
export class StreamCryptoContext {
    public static derive(
        ecdhSecret: Buffer,
        handshakeKey: Buffer,
        index: number,
    ) {
        const { cipherKey, baseIv } = deriveContextKeys(
            ecdhSecret,
            handshakeKey,
            index,
        );
        return new StreamCryptoContext(cipherKey, baseIv);
    }

    public readonly macKey0: Buffer;

    private cachedGeneration = BigInt(-1);
    private cachedMacKey?: Buffer;

    /**
     * @param macKey0 Override the generation-0 MAC key (for tests);
     * normally it is derived from the cipher key and base IV.
     */
    constructor(
        public readonly cipherKey: Buffer,
        public readonly baseIv: Buffer,
        macKey0?: Buffer,
    ) {
        this.macKey0 = macKey0 ?? fold(sha256(cipherKey, baseIv));
    }

    public macKeyForGeneration(generation: bigint): Buffer {
        if (generation === BigInt(0)) {
            return this.macKey0;
        }

        if (generation === this.cachedGeneration && this.cachedMacKey) {
            return this.cachedMacKey;
        }

        const key = fold(sha256(
            this.macKey0,
            leAdd(this.baseIv, generation * MAC_KEY_IV_STEP),
        ));
        this.cachedGeneration = generation;
        this.cachedMacKey = key;
        return key;
    }

    /**
     * Key stream bytes for absolute positions [keyPos, keyPos + length)
     */
    public keyStream(keyPos: bigint, length: number): Buffer {
        if (keyPos < BigInt(0)) {
            throw new Error(`Negative key position: ${keyPos}`);
        }
        if (length <= 0) {
            return Buffer.alloc(0);
        }

        const firstBlock = keyPos / BigInt(16);
        const offset = Number(keyPos % BigInt(16));
        const blockCount = Math.ceil((offset + length) / 16);

        const counters = Buffer.alloc(blockCount * 16);
        for (let i = 0; i < blockCount; i++) {
            leAdd(this.baseIv, firstBlock + BigInt(i)).copy(counters, i * 16);
        }

        const cipher = crypto.createCipheriv("aes-128-ecb", this.cipherKey, null);
        cipher.setAutoPadding(false);
        const blocks = Buffer.concat([cipher.update(counters), cipher.final()]);

        return blocks.slice(offset, offset + length);
    }

    /** XOR `data` with the key stream at `keyPos` (encrypt == decrypt) */
    public encrypt(keyPos: bigint, data: Buffer): Buffer {
        const stream = this.keyStream(keyPos, data.length);
        if (stream.length !== data.length) {
            throw new Error(`Key stream length ${stream.length} != ${data.length}`);
        }
        const result = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = data[i] ^ stream[i];
        }
        return result;
    }

    /**
     * Compute the 4-byte MAC of an already-prepared message (spec 7.5)
     */
    public mac(keyPos: bigint, message: Buffer): Buffer {
        const key = this.macKeyForGeneration(macKeyGeneration(keyPos));
        // Spec 7.7: the key position can advance by less than 16, so two
        // consecutive small packets may share an IV block (and thus a GCM
        // IV). The spec mandates this; it can't be avoided here.
        const iv = leAdd(this.baseIv, keyPos / BigInt(16));

        const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
        cipher.setAAD(message);
        cipher.final();
        return cipher.getAuthTag().slice(0, 4);
    }
}

/**
 * Client-side ECDH state for one stream (spec 7.1, 6.2)
 */
export class StreamKeyExchange {
    public static generate() {
        return new StreamKeyExchange(crypto.randomBytes(HANDSHAKE_KEY_LENGTH));
    }

    private readonly ecdh = crypto.createECDH(ECDH_CURVE);

    constructor(
        public readonly handshakeKey: Buffer,
        privateKey?: Buffer,
    ) {
        if (privateKey) {
            this.ecdh.setPrivateKey(privateKey);
        } else {
            this.ecdh.generateKeys();
        }
    }

    /** 65-byte uncompressed public key */
    public get publicKey(): Buffer {
        return this.ecdh.getPublicKey();
    }

    /** HMAC-SHA256(handshake key, public key) */
    public get publicKeySignature(): Buffer {
        return signPublicKey(this.handshakeKey, this.publicKey);
    }

    /** The 32-byte x coordinate of the shared point */
    public computeSecret(remotePublicKey: Buffer): Buffer {
        return this.ecdh.computeSecret(remotePublicKey);
    }

    public deriveContexts(remotePublicKey: Buffer) {
        const secret = this.computeSecret(remotePublicKey);
        return {
            secret,
            local: StreamCryptoContext.derive(
                secret, this.handshakeKey, CLIENT_CONTEXT_INDEX,
            ),
        };
    }
}
