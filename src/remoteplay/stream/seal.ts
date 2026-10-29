/* eslint-disable no-bitwise */

import { StreamCryptoContext } from "./crypto";
import {
    CONGESTION_KEY_POS_OFFSET,
    CONGESTION_MAC_OFFSET,
    CONTROL_KEY_POS_OFFSET,
    CONTROL_MAC_OFFSET,
    encodeFeedback,
    FEEDBACK_MAC_OFFSET,
    IFeedbackHeader,
} from "./packets";

function low32(keyPos: bigint) {
    return Number(keyPos & BigInt(0xffffffff));
}

/**
 * MAC a datagram whose MAC input has both the MAC and KP fields zeroed,
 * then write the MAC and the KP (control and congestion packets; spec
 * 7.6). Modifies and returns `datagram`.
 */
function sealZeroingKeyPos(
    context: StreamCryptoContext | undefined,
    keyPos: bigint,
    datagram: Buffer,
    macOffset: number,
    keyPosOffset: number,
) {
    datagram.fill(0, macOffset, macOffset + 4);
    datagram.fill(0, keyPosOffset, keyPosOffset + 4);
    if (!context) {
        // before BANG: MAC = 0 and KP = 0
        return datagram;
    }

    context.mac(keyPos, datagram).copy(datagram, macOffset);
    datagram.writeUInt32BE(low32(keyPos), keyPosOffset);
    return datagram;
}

export function sealControlPacket(
    context: StreamCryptoContext | undefined,
    keyPos: bigint,
    datagram: Buffer,
) {
    return sealZeroingKeyPos(
        context, keyPos, datagram, CONTROL_MAC_OFFSET, CONTROL_KEY_POS_OFFSET,
    );
}

export function sealCongestion(
    context: StreamCryptoContext | undefined,
    keyPos: bigint,
    datagram: Buffer,
) {
    return sealZeroingKeyPos(
        context, keyPos, datagram, CONGESTION_MAC_OFFSET, CONGESTION_KEY_POS_OFFSET,
    );
}

/**
 * Build a feedback datagram: encrypt the payload at KP + 16, write the
 * KP, then MAC the whole datagram (KP included, MAC zeroed; spec 7.6).
 */
export function sealFeedback(
    context: StreamCryptoContext,
    keyPos: bigint,
    header: Omit<IFeedbackHeader, "keyPos" | "mac">,
    payload: Buffer,
) {
    const datagram = encodeFeedback({
        ...header,
        keyPos: low32(keyPos),
        mac: Buffer.alloc(4),
    }, context.encrypt(keyPos + BigInt(16), payload));

    context.mac(keyPos, datagram).copy(datagram, FEEDBACK_MAC_OFFSET);
    return datagram;
}
