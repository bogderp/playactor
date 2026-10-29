import _debug from "debug";

import { IRemotePlayCredentials } from "../../credentials/model";
import { ConnectionIntent, IConnectionConfig } from "../../device/model";
import { DeviceType, IDiscoveredDevice } from "../../discovery/model";
import { TcpDeviceSocket } from "../../socket/tcp";
import { pickCryptoStrategyForDevice } from "../crypto";
import { RemotePlayCommand, RemotePlayOutgoingPacket } from "../packets";
import { openSessionWithInfo } from "../session";
import { fallbackSessionId } from "../session-id";
import { StreamButton } from "./input";
import { authKeyStream } from "./launch-spec";
import { IStreamOptions, ITapResult, RemotePlayStream } from "./stream";
import { IDatagramChannel, STREAM_PORT, UdpDatagramChannel } from "./transport";

const debug = _debug("playactor:remoteplay:stream:session");

export interface IStreamSessionOptions {
    stream?: Partial<IStreamOptions>;

    /** How long to wait for ctrl message 0x33 after login */
    sessionIdTimeoutMillis?: number;

    /** Send the optional ctrl messages of spec 2.4 (default: false) */
    sendOptionalCtrlMessages?: boolean;

    /** Progress callbacks, eg: for timing output */
    onLoggedIn?: () => void;
    onSessionId?: (fallback: boolean) => void;

    /** Override the datagram channel (tests) */
    createChannel?: (device: IDiscoveredDevice) => Promise<IDatagramChannel>;
}

export interface IStreamSession {
    readonly stream: RemotePlayStream;
    readonly closed: Promise<string>;

    tap(button: StreamButton, holdMillis?: number): Promise<ITapResult>;
    close(): Promise<void>;
}

function timeout<T>(promise: Promise<T>, millis: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise,
        new Promise<undefined>(resolve => {
            timer = setTimeout(() => resolve(undefined), millis);
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function sendOptionalCtrlMessages(socket: TcpDeviceSocket) {
    // spec 2.4: microphone toggle (twice) and display devices
    const mic = Buffer.from([0x00, 0x01, 0x01, 0x59]);
    await socket.send(new RemotePlayOutgoingPacket(RemotePlayCommand.MicToggle, mic));
    await socket.send(new RemotePlayOutgoingPacket(RemotePlayCommand.MicToggle, mic));
    await socket.send(new RemotePlayOutgoingPacket(
        RemotePlayCommand.DisplayDevices,
        Buffer.alloc(4),
    ));
}

/**
 * Log in on the ctrl socket and open a stream session on top of it.
 * This never wakes the console: callers should check that it is awake.
 */
export async function openStreamSession(
    device: IDiscoveredDevice,
    config: IConnectionConfig,
    creds: IRemotePlayCredentials,
    options: IStreamSessionOptions = {},
): Promise<IStreamSession> {
    if (device.type !== DeviceType.PS5) {
        throw new Error("The Remote Play stream is only implemented for the PS5");
    }

    const { socket, nonce, sessionId: sessionIdPromise } = await openSessionWithInfo(
        device,
        { ...config, intent: ConnectionIntent.LOGIN },
        creds,
    );
    options.onLoggedIn?.();

    let stream: RemotePlayStream | undefined;
    try {
        let sessionId = await timeout(
            sessionIdPromise,
            options.sessionIdTimeoutMillis ?? 3000,
        );
        options.onSessionId?.(!sessionId);
        if (!sessionId) {
            debug("no session ID from the console; using a fallback");
            sessionId = fallbackSessionId();
        }

        if (options.sendOptionalCtrlMessages ?? false) {
            await sendOptionalCtrlMessages(socket);
        }

        const strategy = pickCryptoStrategyForDevice(device);
        const channel = options.createChannel
            ? await options.createChannel(device)
            : await UdpDatagramChannel.open(device.address.address, STREAM_PORT, {
                address: config.network?.localBindAddress,
            });

        const newStream = new RemotePlayStream({
            channel,
            sessionId,
            authKeyStream: length => authKeyStream(strategy, creds, nonce, length),
            options: options.stream,
        });
        stream = newStream;

        // the stream ends whenever the ctrl connection does (spec 8.6)
        (async () => {
            try {
                for await (const packet of socket.receive()) {
                    debug("ctrl <<", packet.type);
                }
            } catch (e) {
                debug("ctrl socket error:", e);
            }
            debug("ctrl socket closed; closing stream");
            await newStream.close();
        })();

        await newStream.start();
    } catch (e) {
        if (stream) await stream.close();
        await socket.close();
        throw e;
    }

    const ready = stream;
    return {
        stream: ready,
        closed: ready.closed,
        tap: (button, holdMillis) => ready.tap(button, holdMillis),
        async close() {
            await ready.close();
            await socket.close();
        },
    };
}
