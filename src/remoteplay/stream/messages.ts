import { ProtoMessage, ProtoWriter } from "./protobuf";

/** Takion protocol version used by the PS5 stream (spec 2.3) */
export const TAKION_VERSION = 12;

export enum PayloadType {
    BIG = 0,
    BANG = 1,
    INFO = 2,
    HEARTBEAT = 3,
    PACKETLOSS = 4,
    CORRUPTFRAME = 5,
    CURSOR = 6,
    TIMER = 7,
    DISCONNECT = 8,
    LOG = 9,
    HEADERREQUEST = 10,
    DEBUG = 11,
    SENKUSHA = 12,
    STREAMINFO = 13,
    STREAMINFOACK = 14,
    XMBCOMMAND = 15,
    CONNECTIONQUALITY = 16,
    CLIENTMETRIC = 17,
    PLAYTIMELEFT = 18,
    SERVERMESSAGE = 19,
    FPSCHANGE = 20,
    CONTROLLERCONNECTION = 21,
    CLIENTINFO = 22,
    VIDEOCAPTURE = 23,
    AUDIOCAPTURE = 24,
    IDRREQUEST = 25,
}

/** TakionMessage field numbers (spec 6.6) */
const enum Field {
    Type = 1,
    Big = 2,
    Bang = 3,
    Disconnect = 10,
    StreamInfo = 15,
    ControllerConnection = 22,
}

export enum ControllerType {
    NOTSET = 0,
    DUALSHOCK3 = 1,
    DUALSHOCK4 = 2,
    VITA = 3,
    XINPUT = 4,
    MOBILE = 5,
    DUALSENSE = 6,
    VR2SENSE = 7,
}

export interface IBigPayload {
    clientVersion: number;
    sessionKey: string;
    launchSpec: string;
    encryptedKey: Buffer;
    ecdhPublicKey: Buffer;
    ecdhSignature: Buffer;
}

export function encodeBig(big: IBigPayload) {
    const payload = new ProtoWriter()
        .varint(1, big.clientVersion)
        .bytes(2, big.sessionKey)
        .bytes(3, big.launchSpec)
        .bytes(4, big.encryptedKey)
        .bytes(5, big.ecdhPublicKey)
        .bytes(6, big.ecdhSignature);

    return new ProtoWriter()
        .varint(Field.Type, PayloadType.BIG)
        .message(Field.Big, payload)
        .toBuffer();
}

export function encodeHeartbeat() {
    return new ProtoWriter()
        .varint(Field.Type, PayloadType.HEARTBEAT)
        .toBuffer();
}

export function encodeStreamInfoAck() {
    return new ProtoWriter()
        .varint(Field.Type, PayloadType.STREAMINFOACK)
        .toBuffer();
}

export function encodeControllerConnection(
    controllerType: ControllerType = ControllerType.DUALSHOCK4,
    connected = true,
) {
    return new ProtoWriter()
        .varint(Field.Type, PayloadType.CONTROLLERCONNECTION)
        .message(Field.ControllerConnection, new ProtoWriter()
            .varint(2, connected)
            .varint(3, controllerType))
        .toBuffer();
}

/** Client STREAMINFO carrying only the microphone audio header (spec 6.5) */
export function encodeClientStreamInfo(audioHeader: Buffer) {
    return new ProtoWriter()
        .varint(Field.Type, PayloadType.STREAMINFO)
        .message(Field.StreamInfo, new ProtoWriter()
            .bytes(2, audioHeader))
        .toBuffer();
}

export function encodeDisconnect(reason = "Client Disconnecting") {
    return new ProtoWriter()
        .varint(Field.Type, PayloadType.DISCONNECT)
        .message(Field.Disconnect, new ProtoWriter()
            .bytes(1, reason))
        .toBuffer();
}

export interface IAudioHeader {
    channels: number;
    bitsPerSample: number;
    sampleRate: number;
    frameSize: number;
    unknown: number;
}

export const MIC_AUDIO_HEADER: IAudioHeader = {
    channels: 1,
    bitsPerSample: 16,
    sampleRate: 48000,
    frameSize: 480,
    unknown: 1,
};

/** 14-byte audio header (spec 6.5) */
export function encodeAudioHeader(header: IAudioHeader = MIC_AUDIO_HEADER) {
    const buffer = Buffer.alloc(14);
    buffer[0] = header.channels;
    buffer[1] = header.bitsPerSample;
    buffer.writeUInt32BE(header.sampleRate, 2);
    buffer.writeUInt32BE(header.frameSize, 6);
    buffer.writeUInt32BE(header.unknown, 10);
    return buffer;
}

export function decodeAudioHeader(buffer: Buffer): IAudioHeader {
    if (buffer.length !== 14) {
        throw new Error(`Unexpected audio header length: ${buffer.length}`);
    }
    return {
        channels: buffer[0],
        bitsPerSample: buffer[1],
        sampleRate: buffer.readUInt32BE(2),
        frameSize: buffer.readUInt32BE(6),
        unknown: buffer.readUInt32BE(10),
    };
}

// ======= Decoding ========================================================

export interface IBangPayload {
    serverVersion?: number;
    encryptedKeyAccepted: boolean;
    versionAccepted: boolean;
    ecdhPublicKey?: Buffer;
    ecdhSignature?: Buffer;
}

export type IBigDecoded = IBigPayload;

export interface IStreamInfo {
    resolutionCount: number;
    audioHeader?: Buffer;
    startTimeout?: number;
    afkTimeout?: number;
    afkTimeoutDisconnect?: number;
    congestionControlInterval?: number;
}

export interface IControllerConnection {
    controllerId?: number;
    connected?: boolean;
    controllerType?: number;
}

export interface ITakionMessage {
    type: number;
    big?: IBigDecoded;
    bang?: IBangPayload;
    disconnectReason?: string;
    streamInfo?: IStreamInfo;
    controllerConnection?: IControllerConnection;
}

export function decodeTakionMessage(buffer: Buffer): ITakionMessage {
    const message = ProtoMessage.decode(buffer);
    const type = message.number(Field.Type);
    if (type === undefined) {
        throw new Error("TakionMessage without a type");
    }

    const result: ITakionMessage = { type };

    const big = message.message(Field.Big);
    if (big) {
        result.big = {
            clientVersion: big.number(1) ?? 0,
            sessionKey: big.string(2) ?? "",
            launchSpec: big.string(3) ?? "",
            encryptedKey: big.bytes(4) ?? Buffer.alloc(0),
            ecdhPublicKey: big.bytes(5) ?? Buffer.alloc(0),
            ecdhSignature: big.bytes(6) ?? Buffer.alloc(0),
        };
    }

    const bang = message.message(Field.Bang);
    if (bang) {
        result.bang = {
            serverVersion: bang.number(1),
            encryptedKeyAccepted: bang.bool(3) ?? false,
            versionAccepted: bang.bool(4) ?? false,
            ecdhPublicKey: bang.bytes(8),
            ecdhSignature: bang.bytes(9),
        };
    }

    const disconnect = message.message(Field.Disconnect);
    if (disconnect) {
        result.disconnectReason = disconnect.string(1);
    }

    const streamInfo = message.message(Field.StreamInfo);
    if (streamInfo) {
        result.streamInfo = {
            resolutionCount: streamInfo.fields.filter(f => f.field === 1).length,
            audioHeader: streamInfo.bytes(2),
            startTimeout: streamInfo.number(3),
            afkTimeout: streamInfo.number(4),
            afkTimeoutDisconnect: streamInfo.number(5),
            congestionControlInterval: streamInfo.number(6),
        };
    }

    const controller = message.message(Field.ControllerConnection);
    if (controller) {
        result.controllerConnection = {
            controllerId: controller.number(1),
            connected: controller.bool(2),
            controllerType: controller.number(3),
        };
    }

    return result;
}

/** Encode a BANG; used by tests to simulate the console */
export function encodeBang(bang: IBangPayload & { sessionKey?: string }) {
    const payload = new ProtoWriter();
    if (bang.serverVersion !== undefined) payload.varint(1, bang.serverVersion);
    payload.varint(3, bang.encryptedKeyAccepted);
    payload.varint(4, bang.versionAccepted);
    if (bang.sessionKey !== undefined) payload.bytes(5, bang.sessionKey);
    if (bang.ecdhPublicKey) payload.bytes(8, bang.ecdhPublicKey);
    if (bang.ecdhSignature) payload.bytes(9, bang.ecdhSignature);

    return new ProtoWriter()
        .varint(Field.Type, PayloadType.BANG)
        .message(Field.Bang, payload)
        .toBuffer();
}

/** Encode a console-style STREAMINFO; used by tests */
export function encodeServerStreamInfo(info: {
    resolutions: { width: number, height: number, videoHeader: Buffer }[],
    audioHeader: Buffer,
    startTimeout?: number,
    afkTimeout?: number,
}) {
    const payload = new ProtoWriter();
    for (const r of info.resolutions) {
        payload.message(1, new ProtoWriter()
            .varint(1, r.width)
            .varint(2, r.height)
            .bytes(3, r.videoHeader));
    }
    payload.bytes(2, info.audioHeader);
    if (info.startTimeout !== undefined) payload.varint(3, info.startTimeout);
    if (info.afkTimeout !== undefined) payload.varint(4, info.afkTimeout);

    return new ProtoWriter()
        .varint(Field.Type, PayloadType.STREAMINFO)
        .message(Field.StreamInfo, payload)
        .toBuffer();
}
