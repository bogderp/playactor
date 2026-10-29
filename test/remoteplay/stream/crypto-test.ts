import * as chai from "chai";

import {
    deriveContextKeys,
    leAdd,
    macKeyGeneration,
    signPublicKey,
    StreamCryptoContext,
    StreamKeyExchange,
} from "../../../src/remoteplay/stream/crypto";
import {
    DERIVED, hex, V1, V2, V3, V4, V5, V6, V7,
} from "./vectors";

chai.should();
const { expect } = chai;

const HIGH_KEY_POS = BigInt("0x100000420");

describe("Remote Play stream crypto", () => {
    describe("LE-add", () => {
        it("carries toward higher byte indexes", () => {
            leAdd(hex("ff ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00"), 1)
                .should.deep.equal(hex("00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00"));
        });

        it("wraps at 2^128", () => {
            leAdd(Buffer.alloc(16, 0xff), 2)
                .should.deep.equal(hex("01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00"));
        });
    });

    describe("V1: ECDH and signatures", () => {
        it("derives the local public key", () => {
            const kex = new StreamKeyExchange(V1.handshakeKey, V1.localPrivateKey);
            kex.publicKey.should.deep.equal(V1.localPublicKey);
        });

        it("signs the local public key", () => {
            const kex = new StreamKeyExchange(V1.handshakeKey, V1.localPrivateKey);
            kex.publicKeySignature.should.deep.equal(V1.localSignature);
        });

        it("signs the remote public key", () => {
            signPublicKey(V1.handshakeKey, V1.remotePublicKey)
                .should.deep.equal(V1.remoteSignature);
        });

        it("computes the shared secret", () => {
            const kex = new StreamKeyExchange(V1.handshakeKey, V1.localPrivateKey);
            kex.computeSecret(V1.remotePublicKey).should.deep.equal(V1.secret);
        });
    });

    describe("V2: key derivation and key stream", () => {
        it("derives the cipher key and base IV", () => {
            const { cipherKey, baseIv } = deriveContextKeys(V2.secret, V2.handshakeKey, V2.index);
            cipherKey.should.deep.equal(V2.cipherKey);
            baseIv.should.deep.equal(V2.baseIv);
        });

        it("produces the key stream at 0x30", () => {
            const ctx = StreamCryptoContext.derive(V2.secret, V2.handshakeKey, V2.index);
            ctx.keyStream(BigInt(0x30), 32).should.deep.equal(V2.streamLow);
        });

        it("produces the key stream at 0x1_0000_0420", () => {
            const ctx = StreamCryptoContext.derive(V2.secret, V2.handshakeKey, V2.index);
            ctx.keyStream(HIGH_KEY_POS, 32).should.deep.equal(V2.streamHigh);
        });
    });

    describe("V3: unaligned encryption", () => {
        it("derives the cipher key and base IV", () => {
            const { cipherKey, baseIv } = deriveContextKeys(V3.secret, V3.handshakeKey, V3.index);
            cipherKey.should.deep.equal(V3.cipherKey);
            baseIv.should.deep.equal(V3.baseIv);
        });

        it("encrypts at 0x11", () => {
            const ctx = StreamCryptoContext.derive(V3.secret, V3.handshakeKey, V3.index);
            ctx.encrypt(BigInt(0x11), V3.plaintext).should.deep.equal(V3.ciphertextLow);
        });

        it("encrypts at 0x1_0000_0420", () => {
            const ctx = StreamCryptoContext.derive(V3.secret, V3.handshakeKey, V3.index);
            ctx.encrypt(HIGH_KEY_POS, V3.plaintext).should.deep.equal(V3.ciphertextHigh);
        });

        it("decrypts back to the plaintext", () => {
            const ctx = StreamCryptoContext.derive(V3.secret, V3.handshakeKey, V3.index);
            ctx.encrypt(BigInt(0x11), V3.ciphertextLow).should.deep.equal(V3.plaintext);
        });
    });

    describe("V4: audio datagram MAC", () => {
        it("matches at generation 0", () => {
            const ctx = new StreamCryptoContext(Buffer.alloc(16), V4.baseIv, V4.macKey0);
            ctx.mac(BigInt(0x69A0), V4.input).should.deep.equal(V4.macLow);
        });

        it("matches at generation 95443 (zero generation-0 key)", () => {
            macKeyGeneration(HIGH_KEY_POS).should.equal(BigInt(95443));
            const ctx = new StreamCryptoContext(Buffer.alloc(16), V4.baseIv, Buffer.alloc(16));
            ctx.mac(HIGH_KEY_POS, V4.input).should.deep.equal(V4.macHigh);
        });
    });

    describe("V5: MAC key rollover", () => {
        it("derives the generation-1 key", () => {
            const ctx = new StreamCryptoContext(Buffer.alloc(16), V5.baseIv, V5.macKey0);
            ctx.macKeyForGeneration(BigInt(1)).should.deep.equal(V5.macKey1);
        });

        it("places generation boundaries with the -1 rule", () => {
            macKeyGeneration(BigInt(0)).should.equal(BigInt(0));
            macKeyGeneration(BigInt(1)).should.equal(BigInt(0));
            macKeyGeneration(BigInt(45000)).should.equal(BigInt(0));
            macKeyGeneration(BigInt(45001)).should.equal(BigInt(1));
            macKeyGeneration(BigInt(90000)).should.equal(BigInt(1));
            macKeyGeneration(BigInt(90001)).should.equal(BigInt(2));
        });
    });

    describe("V6: video datagram MAC", () => {
        it("matches at generation 0", () => {
            const ctx = new StreamCryptoContext(Buffer.alloc(16), V6.baseIv, V6.macKey0);
            ctx.mac(BigInt(0xADF0), V6.input).should.deep.equal(V6.macLow);
        });

        it("matches at generation 95443 (zero generation-0 key)", () => {
            const ctx = new StreamCryptoContext(Buffer.alloc(16), V6.baseIv, Buffer.alloc(16));
            ctx.mac(HIGH_KEY_POS, V6.input).should.deep.equal(V6.macHigh);
        });
    });

    describe("V7: MAC on a generation boundary", () => {
        it("uses generation 155 and matches the full chain", () => {
            macKeyGeneration(V7.keyPos).should.equal(BigInt(155));
            const ctx = StreamCryptoContext.derive(V7.secret, V7.handshakeKey, V7.index);
            ctx.mac(V7.keyPos, V7.input).should.deep.equal(V7.mac);
        });
    });

    describe("13.2 shared parameters", () => {
        it("derives cipher key, base IV and MAC key 0", () => {
            const ctx = StreamCryptoContext.derive(
                DERIVED.secret, DERIVED.handshakeKey, DERIVED.index,
            );
            ctx.cipherKey.should.deep.equal(DERIVED.cipherKey);
            ctx.baseIv.should.deep.equal(DERIVED.baseIv);
            ctx.macKey0.should.deep.equal(DERIVED.macKey0);
        });
    });

    it("rejects a short handshake key", () => {
        expect(() => deriveContextKeys(V2.secret, Buffer.alloc(8), 2)).to.throw();
    });

    describe("bad key positions", () => {
        const ctx = StreamCryptoContext.derive(
            V2.secret, V2.handshakeKey, 2,
        );

        it("keyStream throws on a negative key position", () => {
            expect(() => ctx.keyStream(BigInt(-5), 4)).to.throw(/Negative/);
        });

        it("encrypt throws on a negative key position", () => {
            expect(() => ctx.encrypt(BigInt(-5), Buffer.alloc(4))).to.throw(/Negative/);
        });
    });
});
