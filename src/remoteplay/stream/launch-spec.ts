import { IRemotePlayCredentials } from "../../credentials/model";
import { ICryptoStrategy } from "../crypto/model";

export interface ILaunchSpecOptions {
    width: number;
    height: number;
    maxFps: number;
    bitrateKbps: number;
    mtu: number;
    rttMillis: number;
    codec: "avc" | "hevc";
    dynamicRange: "SDR" | "HDR";
}

/** The lowest known-good profile (spec 8.5) */
export const defaultLaunchSpecOptions: ILaunchSpecOptions = {
    width: 640,
    height: 360,
    maxFps: 30,
    bitrateKbps: 2000,
    mtu: 1454,
    rttMillis: 1,
    codec: "avc",
    dynamicRange: "SDR",
};

function str(value: string) {
    return JSON.stringify(value);
}

function int(value: number) {
    if (!Number.isInteger(value)) {
        throw new Error(`Expected an integer: ${value}`);
    }
    return String(value);
}

/**
 * Build the launch spec JSON text (spec 6.1). It is assembled by hand
 * so that the key order and the exact formatting (`0.001000`, and the
 * single space in `"adaptiveStreamMode": "resize"`) are reproduced.
 */
export function formatLaunchSpec(
    handshakeKey: Buffer,
    options: ILaunchSpecOptions = defaultLaunchSpecOptions,
) {
    const resolution = `{"resolution":{"width":${int(options.width)},"height":${int(options.height)}},`
        + `"maxFps":${int(options.maxFps)},"score":10}`;

    const network = "{"
        + `"bwKbpsSent":${int(options.bitrateKbps)},`
        + "\"bwLoss\":0.001000,"
        + `"mtu":${int(options.mtu)},`
        + `"rtt":${int(options.rttMillis)},`
        + "\"ports\":[53,2053]"
        + "}";

    const appSpecification = "{"
        + "\"minFps\":30,"
        + "\"minBandwidth\":0,"
        + "\"extTitleId\":\"ps3\","
        + "\"version\":1,"
        + "\"timeLimit\":1,"
        + "\"startTimeout\":100,"
        + "\"afkTimeout\":100,"
        + "\"afkTimeoutDisconnect\":100"
        + "}";

    const konan = "{"
        + "\"ps3AccessToken\":\"accessToken\","
        + "\"ps3RefreshToken\":\"refreshToken\""
        + "}";

    const requestGameSpecification = "{"
        + "\"model\":\"bravia_tv\","
        + "\"platform\":\"android\","
        + "\"audioChannels\":\"5.1\","
        + "\"language\":\"sp\","
        + "\"acceptButton\":\"X\","
        + "\"connectedControllers\":[\"xinput\",\"ds3\",\"ds4\"],"
        + "\"yuvCoefficient\":\"bt601\","
        + "\"videoEncoderProfile\":\"hw4.1\","
        + "\"audioEncoderProfile\":\"audio1\","
        + "\"adaptiveStreamMode\": \"resize\""
        + "}";

    const userProfile = "{"
        + "\"onlineId\":\"psnId\","
        + "\"npId\":\"npId\","
        + "\"region\":\"US\","
        + "\"languagesUsed\":[\"en\",\"jp\"]"
        + "}";

    return "{"
        + "\"sessionId\":\"sessionId4321\","
        + `"streamResolutions":[${resolution}],`
        + `"network":${network},`
        + "\"slotId\":1,"
        + `"appSpecification":${appSpecification},`
        + `"konan":${konan},`
        + `"requestGameSpecification":${requestGameSpecification},`
        + `"userProfile":${userProfile},`
        + `"videoCodec":${str(options.codec)},`
        + `"dynamicRange":${str(options.dynamicRange)},`
        + `"handshakeKey":${str(handshakeKey.toString("base64"))}`
        + "}";
}

/**
 * The counter-0 auth key stream of the given length (spec 2.2):
 * AES-128-CFB encryption of zero bytes with a fresh counter-0 codec.
 */
export function authKeyStream(
    strategy: ICryptoStrategy,
    creds: IRemotePlayCredentials,
    serverNonce: Buffer,
    length: number,
) {
    return strategy.createCodecForAuth(creds, serverNonce, BigInt(0))
        .encode(Buffer.alloc(length));
}

/**
 * Encrypt and base64-encode a launch spec for BIG (spec 6.1)
 */
export function encodeLaunchSpec(json: string, keyStream: (length: number) => Buffer) {
    const plain = Buffer.concat([Buffer.from(json, "utf-8"), Buffer.from([0])]);
    const key = keyStream(plain.length);
    if (key.length !== plain.length) {
        throw new Error(`Key stream too short: ${key.length} < ${plain.length}`);
    }

    const cipher = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++) {
        // eslint-disable-next-line no-bitwise
        cipher[i] = plain[i] ^ key[i];
    }
    return cipher.toString("base64");
}
