import { signPublicKey, StreamKeyExchange } from "./crypto";
import {
    encodeAudioHeader,
    encodeBig,
    encodeClientStreamInfo,
    encodeControllerConnection,
    encodeStreamInfoAck,
    IBangPayload,
    TAKION_VERSION,
} from "./messages";

/** DATA channels used by the client (spec 5.4) */
export enum StreamChannel {
    Main = 1,
    Video = 2,
    StreamInfoAck = 9,
}

export class StreamHandshakeError extends Error {}

/**
 * Build the BIG message (spec 6.2)
 */
export function buildBig(
    kex: StreamKeyExchange,
    sessionId: string,
    launchSpec: string,
) {
    return encodeBig({
        clientVersion: TAKION_VERSION,
        sessionKey: sessionId,
        launchSpec,
        encryptedKey: Buffer.alloc(4),
        ecdhPublicKey: kex.publicKey,
        ecdhSignature: kex.publicKeySignature,
    });
}

/**
 * Check a BANG and return the console public key (spec 6.3). The key
 * signature is checked but, like the reference behaviour, a mismatch is
 * only reported, not fatal.
 */
export function validateBang(
    bang: IBangPayload,
    handshakeKey: Buffer,
) {
    if (!bang.encryptedKeyAccepted || !bang.versionAccepted) {
        throw new StreamHandshakeError(
            `Console rejected BIG (key accepted: ${bang.encryptedKeyAccepted}, `
            + `version accepted: ${bang.versionAccepted})`,
        );
    }

    if (!bang.ecdhPublicKey || !bang.ecdhSignature) {
        throw new StreamHandshakeError("BANG is missing the console key");
    }

    const expected = signPublicKey(handshakeKey, bang.ecdhPublicKey);
    return {
        publicKey: bang.ecdhPublicKey,
        signatureValid: expected.equals(bang.ecdhSignature),
    };
}

/**
 * The client's replies to STREAMINFO, in order (spec 6.5)
 */
export function streamInfoReplies() {
    return [
        { channel: StreamChannel.StreamInfoAck, data: encodeStreamInfoAck() },
        { channel: StreamChannel.Main, data: encodeControllerConnection() },
        { channel: StreamChannel.Main, data: encodeClientStreamInfo(encodeAudioHeader()) },
    ];
}
