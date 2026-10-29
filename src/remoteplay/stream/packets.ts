/**
 * Byte layouts of the Remote Play stream ("Takion") datagrams.
 * All integers are big-endian unless noted (spec 0).
 */

/* eslint-disable no-bitwise */

export enum BaseType {
    Control = 0,
    FeedbackHistory = 1,
    Video = 2,
    Audio = 3,
    Congestion = 5,
    FeedbackState = 6,
}

export enum ChunkType {
    Data = 0x00,
    Init = 0x01,
    InitAck = 0x02,
    DataAck = 0x03,
    Cookie = 0x0A,
    CookieAck = 0x0B,
}

export const CONTROL_HEADER_SIZE = 17;
export const CONTROL_MAC_OFFSET = 5;
export const CONTROL_KEY_POS_OFFSET = 9;

export const DATA_HEADER_SIZE = 26; // first/whole fragment, incl. data type
export const DATA_CONTINUATION_HEADER_SIZE = 25;
export const DATA_ACK_SIZE = 29;

export const CONGESTION_SIZE = 15;
export const CONGESTION_MAC_OFFSET = 7;
export const CONGESTION_KEY_POS_OFFSET = 11;

export const FEEDBACK_HEADER_SIZE = 12;
export const FEEDBACK_KEY_POS_OFFSET = 4;
export const FEEDBACK_MAC_OFFSET = 8;

export const RECEIVE_WINDOW = 0x00019000;
export const STREAM_COUNT = 0x0064;

export const COOKIE_SIZE = 32;

export enum DataType {
    Protobuf = 0,
    Rumble = 7,
    PadInfo = 9,
    TriggerEffects = 11,
}

export function baseTypeOf(datagram: Buffer) {
    return datagram[0] & 0x0f;
}

export interface IControlPacket {
    tag: number;
    mac: Buffer;
    keyPos: number; // low 32 bits
    chunkType: number;
    chunkFlags: number;
    payload: Buffer;
}

export function encodeControlPacket(packet: IControlPacket) {
    const buffer = Buffer.alloc(CONTROL_HEADER_SIZE + packet.payload.length);
    buffer[0] = BaseType.Control;
    buffer.writeUInt32BE(packet.tag >>> 0, 1);
    packet.mac.copy(buffer, CONTROL_MAC_OFFSET, 0, 4);
    buffer.writeUInt32BE(packet.keyPos >>> 0, CONTROL_KEY_POS_OFFSET);
    buffer[13] = packet.chunkType;
    buffer[14] = packet.chunkFlags;
    buffer.writeUInt16BE(packet.payload.length + 4, 15);
    packet.payload.copy(buffer, CONTROL_HEADER_SIZE);
    return buffer;
}

/**
 * Returns undefined if the datagram is not a well-formed control packet
 */
export function decodeControlPacket(datagram: Buffer): IControlPacket | undefined {
    if (datagram.length < CONTROL_HEADER_SIZE
        || baseTypeOf(datagram) !== BaseType.Control) {
        return;
    }

    const chunkLength = datagram.readUInt16BE(15);
    if (datagram.length - 1 !== chunkLength + 12) {
        return;
    }

    return {
        tag: datagram.readUInt32BE(1),
        mac: datagram.slice(CONTROL_MAC_OFFSET, CONTROL_MAC_OFFSET + 4),
        keyPos: datagram.readUInt32BE(CONTROL_KEY_POS_OFFSET),
        chunkType: datagram[13],
        chunkFlags: datagram[14],
        payload: datagram.slice(CONTROL_HEADER_SIZE),
    };
}

// ======= INIT / INIT_ACK / COOKIE ========================================

export interface IInitPayload {
    tag: number;
    receiveWindow: number;
    outboundStreams: number;
    inboundStreams: number;
    initialTsn: number;
}

export function encodeInitPayload(init: IInitPayload) {
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32BE(init.tag >>> 0, 0);
    buffer.writeUInt32BE(init.receiveWindow >>> 0, 4);
    buffer.writeUInt16BE(init.outboundStreams, 8);
    buffer.writeUInt16BE(init.inboundStreams, 10);
    buffer.writeUInt32BE(init.initialTsn >>> 0, 12);
    return buffer;
}

export function decodeInitPayload(payload: Buffer): IInitPayload {
    if (payload.length < 16) {
        throw new Error(`INIT payload too short: ${payload.length}`);
    }
    return {
        tag: payload.readUInt32BE(0),
        receiveWindow: payload.readUInt32BE(4),
        outboundStreams: payload.readUInt16BE(8),
        inboundStreams: payload.readUInt16BE(10),
        initialTsn: payload.readUInt32BE(12),
    };
}

/** INIT (client to console, 33 bytes; spec 5.3) */
export function encodeInit(clientTag: number) {
    return encodeControlPacket({
        tag: 0,
        mac: Buffer.alloc(4),
        keyPos: 0,
        chunkType: ChunkType.Init,
        chunkFlags: 0,
        payload: encodeInitPayload({
            tag: clientTag,
            receiveWindow: RECEIVE_WINDOW,
            outboundStreams: STREAM_COUNT,
            inboundStreams: STREAM_COUNT,
            initialTsn: clientTag,
        }),
    });
}

export interface IInitAck extends IInitPayload {
    cookie: Buffer;
}

export function encodeInitAckPayload(ack: IInitAck) {
    return Buffer.concat([encodeInitPayload(ack), ack.cookie]);
}

export function decodeInitAckPayload(payload: Buffer): IInitAck {
    if (payload.length !== 16 + COOKIE_SIZE) {
        throw new Error(`Unexpected INIT_ACK payload length: ${payload.length}`);
    }
    return {
        ...decodeInitPayload(payload),
        cookie: Buffer.from(payload.slice(16, 16 + COOKIE_SIZE)),
    };
}

/** COOKIE (client to console, 49 bytes; spec 5.3) */
export function encodeCookie(serverTag: number, cookie: Buffer) {
    if (cookie.length !== COOKIE_SIZE) {
        throw new Error(`Unexpected cookie length: ${cookie.length}`);
    }
    return encodeControlPacket({
        tag: serverTag,
        mac: Buffer.alloc(4),
        keyPos: 0,
        chunkType: ChunkType.Cookie,
        chunkFlags: 0,
        payload: cookie,
    });
}

// ======= DATA ============================================================

export interface IDataChunk {
    tsn: number;
    channel: number;

    /** undefined for a continuation fragment */
    dataType?: number;
    data: Buffer;
}

export function encodeDataPayload(chunk: IDataChunk) {
    const hasType = chunk.dataType !== undefined;
    const headerSize = hasType ? 9 : 8;
    const buffer = Buffer.alloc(headerSize + chunk.data.length);
    buffer.writeUInt32BE(chunk.tsn >>> 0, 0);
    buffer.writeUInt16BE(chunk.channel, 4);
    buffer.writeUInt16BE(0, 6);
    if (hasType) {
        buffer[8] = chunk.dataType as number;
    }
    chunk.data.copy(buffer, headerSize);
    return buffer;
}

export function decodeDataPayload(payload: Buffer, continuation = false): IDataChunk {
    const headerSize = continuation ? 8 : 9;
    if (payload.length < headerSize) {
        throw new Error(`DATA payload too short: ${payload.length}`);
    }
    return {
        tsn: payload.readUInt32BE(0),
        channel: payload.readUInt16BE(4),
        dataType: continuation ? undefined : payload[8],
        data: payload.slice(headerSize),
    };
}

// ======= DATA_ACK ========================================================

export interface IDataAck {
    cumulativeTsn: number;
    receiveWindow: number;
    gapAckBlocks: number;
    duplicateTsns: number;
}

export function encodeDataAckPayload(ack: IDataAck) {
    const buffer = Buffer.alloc(12);
    buffer.writeUInt32BE(ack.cumulativeTsn >>> 0, 0);
    buffer.writeUInt32BE(ack.receiveWindow >>> 0, 4);
    buffer.writeUInt16BE(ack.gapAckBlocks, 8);
    buffer.writeUInt16BE(ack.duplicateTsns, 10);
    return buffer;
}

export function decodeDataAckPayload(payload: Buffer): IDataAck {
    if (payload.length !== 12) {
        throw new Error(`Unexpected DATA_ACK payload length: ${payload.length}`);
    }
    return {
        cumulativeTsn: payload.readUInt32BE(0),
        receiveWindow: payload.readUInt32BE(4),
        gapAckBlocks: payload.readUInt16BE(8),
        duplicateTsns: payload.readUInt16BE(10),
    };
}

// ======= Congestion ======================================================

export interface ICongestionReport {
    word0: number;
    received: number;
    lost: number;
}

/** Congestion report with MAC and KP fields zeroed (spec 8.2) */
export function encodeCongestion(report: ICongestionReport) {
    const buffer = Buffer.alloc(CONGESTION_SIZE);
    buffer[0] = BaseType.Congestion;
    buffer.writeUInt16BE(report.word0 & 0xffff, 1);
    buffer.writeUInt16BE(Math.min(report.received, 0xffff), 3);
    buffer.writeUInt16BE(Math.min(report.lost, 0xffff), 5);
    return buffer;
}

export function decodeCongestion(datagram: Buffer) {
    if (datagram.length !== CONGESTION_SIZE
        || baseTypeOf(datagram) !== BaseType.Congestion) {
        throw new Error("Not a congestion report");
    }
    return {
        word0: datagram.readUInt16BE(1),
        received: datagram.readUInt16BE(3),
        lost: datagram.readUInt16BE(5),
        mac: datagram.slice(CONGESTION_MAC_OFFSET, CONGESTION_MAC_OFFSET + 4),
        keyPos: datagram.readUInt32BE(CONGESTION_KEY_POS_OFFSET),
    };
}

// ======= Feedback ========================================================

export interface IFeedbackHeader {
    baseType: BaseType.FeedbackState | BaseType.FeedbackHistory;
    sequence: number;
    itemCount: number;
    keyPos: number; // low 32 bits
    mac: Buffer;
}

export function encodeFeedback(header: IFeedbackHeader, payload: Buffer) {
    const buffer = Buffer.alloc(FEEDBACK_HEADER_SIZE + payload.length);
    buffer[0] = header.baseType;
    buffer.writeUInt16BE(header.sequence & 0xffff, 1);
    buffer[3] = header.itemCount;
    buffer.writeUInt32BE(header.keyPos >>> 0, FEEDBACK_KEY_POS_OFFSET);
    header.mac.copy(buffer, FEEDBACK_MAC_OFFSET, 0, 4);
    payload.copy(buffer, FEEDBACK_HEADER_SIZE);
    return buffer;
}

export function decodeFeedback(datagram: Buffer) {
    if (datagram.length < FEEDBACK_HEADER_SIZE) {
        throw new Error("Feedback datagram too short");
    }
    const header: IFeedbackHeader = {
        baseType: baseTypeOf(datagram) as IFeedbackHeader["baseType"],
        sequence: datagram.readUInt16BE(1),
        itemCount: datagram[3],
        keyPos: datagram.readUInt32BE(FEEDBACK_KEY_POS_OFFSET),
        mac: datagram.slice(FEEDBACK_MAC_OFFSET, FEEDBACK_MAC_OFFSET + 4),
    };
    return { header, payload: datagram.slice(FEEDBACK_HEADER_SIZE) };
}

// ======= Received AV header (diagnostics only; spec 12) ===================

export interface IVideoHeader {
    baseType: number;
    hasExtraHeader: boolean;
    packetIndex: number;
    frameIndex: number;
    unitIndex: number;
    unitsInFrame: number;
    fecUnits: number;
    codec: number;
    keyPos: number;
    payloadOffset: number;
}

export function decodeVideoHeader(datagram: Buffer): IVideoHeader {
    if (datagram.length < 21) {
        throw new Error("Video datagram too short");
    }
    const unitWord = datagram.readUInt32BE(5);
    const hasExtraHeader = (datagram[0] & 0x10) !== 0;
    return {
        baseType: baseTypeOf(datagram),
        hasExtraHeader,
        packetIndex: datagram.readUInt16BE(1),
        frameIndex: datagram.readUInt16BE(3),
        unitIndex: unitWord >>> 21,
        unitsInFrame: ((unitWord >>> 10) & 0x7ff) + 1,
        fecUnits: unitWord & 0x3ff,
        codec: datagram[9],
        keyPos: datagram.readUInt32BE(14),
        payloadOffset: 21 + (hasExtraHeader ? 3 : 0),
    };
}

// ======= Serial arithmetic (RFC 1982, 32 bits) ===========================

/** true if a > b in 32-bit serial arithmetic */
export function serialGreater(a: number, b: number) {
    const diff = ((a >>> 0) - (b >>> 0)) >>> 0;
    return diff !== 0 && diff < 0x80000000;
}

export function serialLessOrEqual(a: number, b: number) {
    return !serialGreater(a, b);
}

/**
 * Reconstruct a 64-bit key position from its low 32 bits (spec 7.8)
 */
export function reconstructKeyPos(prev: bigint, low: number): bigint {
    const prevLow = Number(prev & BigInt(0xffffffff));
    let high = prev >> BigInt(32);
    const value = low >>> 0;

    if (serialGreater(value, prevLow) && value < prevLow) {
        high += BigInt(1);
    } else if (serialGreater(prevLow, value) && value > prevLow && high > BigInt(0)) {
        high -= BigInt(1);
    }

    return (high << BigInt(32)) | BigInt(value);
}
