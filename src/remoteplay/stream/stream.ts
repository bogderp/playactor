/* eslint-disable no-bitwise */

import _debug from "debug";

import { StreamKeyExchange } from "./crypto";
import {
    buildBig,
    StreamChannel,
    StreamHandshakeError,
    streamInfoReplies,
    validateBang,
} from "./handshake";
import {
    encodeButtonEvent,
    encodeControllerState,
    HistoryEventBuffer,
    IControllerState,
    IDLE_CONTROLLER_STATE,
    StreamButton,
} from "./input";
import { defaultKeepAliveIntervals, IKeepAliveIntervals, StreamKeepAlive } from "./keepalive";
import {
    defaultLaunchSpecOptions,
    encodeLaunchSpec,
    formatLaunchSpec,
    ILaunchSpecOptions,
} from "./launch-spec";
import {
    ControllerType,
    decodeTakionMessage,
    encodeDisconnect,
    encodeHeartbeat,
    ITakionMessage,
    PayloadType,
} from "./messages";
import { BaseType, DataType } from "./packets";
import {
    defaultTransportOptions,
    IDatagramChannel,
    IReceivedMessage,
    ITransportOptions,
    StreamTransport,
} from "./transport";

const debug = _debug("playactor:remoteplay:stream");

export interface IStreamOptions {
    transport: ITransportOptions;
    keepAlive: IKeepAliveIntervals;
    launchSpec: ILaunchSpecOptions;

    bangTimeoutMillis: number;
    streamInfoTimeoutMillis: number;

    /** Default press-to-release time for `tap()` (spec 9.5: >= 50 ms) */
    holdMillis: number;

    /** History tail resend offsets after the newest event (spec 9.4) */
    tailResendMillis: number[];

    /** Wait for the console to ACK CONTROLLERCONNECTION before input */
    waitForControllerAck: boolean;

    /** Controller announced in CONTROLLERCONNECTION */
    controllerType: ControllerType;

    /**
     * Send the client microphone STREAMINFO (spec 6.5, unverified). Off by
     * default: the console works without it, and it can show an extra
     * input device notification
     */
    sendMicStreamInfo: boolean;
}

export const defaultStreamOptions: IStreamOptions = {
    transport: defaultTransportOptions,
    keepAlive: defaultKeepAliveIntervals,
    launchSpec: defaultLaunchSpecOptions,
    bangTimeoutMillis: 5000,
    streamInfoTimeoutMillis: 5000,
    holdMillis: 50,
    tailResendMillis: [20, 50, 100, 200],
    waitForControllerAck: true,
    controllerType: ControllerType.DUALSHOCK4,
    sendMicStreamInfo: false,
};

export interface IStreamParams {
    channel: IDatagramChannel;

    /** Session ID from ctrl message 0x33 (spec 2.1) */
    sessionId: string;

    /** Counter-0 auth key stream of the given length (spec 2.2) */
    authKeyStream: (length: number) => Buffer;

    kex?: StreamKeyExchange;
    clientTag?: number;
    options?: Partial<IStreamOptions>;
}

export interface ITapResult {
    button: StreamButton;
    pressedAt: number;
    releasedAt: number;
}

enum State {
    IDLE,
    CONNECTING,
    WAIT_BANG,
    WAIT_STREAMINFO,
    CONNECTED,
    CLOSED,
}

function delay(millis: number) {
    return new Promise<void>(resolve => setTimeout(resolve, millis));
}

class Deferred<T> {
    public readonly promise: Promise<T>;
    public resolve!: (value: T) => void;
    public reject!: (error: Error) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        this.promise.catch(() => { /* observed elsewhere */ });
    }
}

function withTimeout<T>(promise: Promise<T>, millis: number, what: string) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamHandshakeError(`Timed out waiting for ${what}`)), millis);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * A Remote Play stream session that discards video and audio and sends
 * controller input (spec sections 5 - 11).
 */
export class RemotePlayStream {
    public readonly options: IStreamOptions;
    public readonly kex: StreamKeyExchange;
    public readonly transport: StreamTransport;

    /** Resolves with the close reason once the stream has closed */
    public readonly closed: Promise<string>;

    private state = State.IDLE;
    private readonly keepAlive: StreamKeepAlive;
    private readonly history = new HistoryEventBuffer();
    private controllerState: IControllerState = IDLE_CONTROLLER_STATE;

    private stateSequence = 0;
    private historySequence = 0;
    private tailTimers: NodeJS.Timeout[] = [];
    private tailDone?: Deferred<void>;

    private readonly bang = new Deferred<void>();
    private readonly connected = new Deferred<void>();
    private earlyStreamInfo?: ITakionMessage;
    private inputQueue: Promise<unknown> = Promise.resolve();

    private resolveClosed!: (reason: string) => void;

    constructor(
        private readonly params: IStreamParams,
    ) {
        this.options = { ...defaultStreamOptions, ...params.options };
        this.kex = params.kex ?? StreamKeyExchange.generate();
        this.transport = new StreamTransport(
            params.channel,
            this.options.transport,
            params.clientTag,
        );
        this.transport.onMessage = message => this.onMessage(message);
        this.transport.onError = error => {
            this.shutdown(`transport error: ${error.message}`, false);
        };

        this.keepAlive = new StreamKeepAlive({
            sendCongestion: () => this.sendCongestion(),
            sendFeedbackState: () => this.sendFeedbackState(),
            sendHeartbeat: () => this.sendHeartbeat(),
        }, this.options.keepAlive);

        this.closed = new Promise(resolve => {
            this.resolveClosed = resolve;
        });
    }

    public get isConnected() {
        return this.state === State.CONNECTED;
    }

    /**
     * Run the association set-up and the stream handshake. Resolves
     * once input may be sent.
     */
    public async start() {
        if (this.state !== State.IDLE) {
            throw new Error("Stream already started");
        }
        this.state = State.CONNECTING;

        try {
            this.keepAlive.startCongestion();

            await this.transport.connect();
            this.assertOpen();
            debug("transport up; sending BIG");

            const launchSpec = encodeLaunchSpec(
                formatLaunchSpec(this.kex.handshakeKey, this.options.launchSpec),
                this.params.authKeyStream,
            );
            const big = buildBig(this.kex, this.params.sessionId, launchSpec);

            this.state = State.WAIT_BANG;
            this.transport.sendData(StreamChannel.Main, big);

            await withTimeout(this.bang.promise, this.options.bangTimeoutMillis, "BANG");
            await withTimeout(
                this.connected.promise,
                this.options.streamInfoTimeoutMillis,
                "STREAMINFO",
            );
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            this.shutdown(`handshake failed: ${error.message}`, this.transport.isEstablished);
            throw error;
        }
    }

    /**
     * Press and release a button. Taps are serialized.
     */
    public tap(button: StreamButton, holdMillis = this.options.holdMillis) {
        const run = async (): Promise<ITapResult> => {
            this.assertConnected();
            this.sendButton(button, true);
            const pressedAt = Date.now();

            await delay(holdMillis);

            this.assertConnected();
            this.sendButton(button, false);
            const releasedAt = Date.now();

            return { button, pressedAt, releasedAt };
        };

        const result = this.inputQueue.then(run, run);
        this.inputQueue = result.catch(() => { /* next tap runs anyway */ });
        return result;
    }

    /** Send a single press or release event immediately */
    public sendButton(button: StreamButton, pressed: boolean) {
        this.assertConnected();
        this.sendHistoryEvent(encodeButtonEvent(button, pressed));
    }

    public setControllerState(state: IControllerState) {
        this.controllerState = state;
        if (this.isConnected) {
            this.sendFeedbackState();
            this.keepAlive.feedbackStateSent();
        }
    }

    /**
     * Close the stream: let pending history tail resends finish, send
     * DISCONNECT, stop timers and close the socket (spec 11).
     */
    public async close() {
        if (this.state === State.CLOSED) {
            return this.closed;
        }

        await this.inputQueue;
        const tail = this.tailDone;
        if (tail && this.isConnected) {
            await tail.promise;
        }

        this.shutdown("closed by client", true);
        return this.closed;
    }

    private assertOpen() {
        if (this.state === State.CLOSED) {
            throw new Error("Stream closed");
        }
    }

    private assertConnected() {
        if (this.state !== State.CONNECTED) {
            throw new Error("Stream is not connected");
        }
    }

    private shutdown(reason: string, sendDisconnect: boolean) {
        if (this.state === State.CLOSED) return;
        debug("shutdown:", reason);

        const wasEstablished = this.transport.isEstablished;
        this.state = State.CLOSED;

        this.keepAlive.stop();
        this.cancelTail();

        if (sendDisconnect && wasEstablished) {
            // fire and forget: the reference client doesn't wait for an ACK
            this.transport.sendDataOnce(StreamChannel.Main, encodeDisconnect());
        }

        this.transport.close();

        const error = new Error(`Stream closed: ${reason}`);
        this.bang.reject(error);
        this.connected.reject(error);
        this.resolveClosed(reason);
    }

    private onMessage(message: IReceivedMessage) {
        if (message.dataType !== DataType.Protobuf) {
            // rumble, pad info, trigger effects: ACK'd by the transport
            return;
        }

        let decoded: ITakionMessage;
        try {
            decoded = decodeTakionMessage(message.data);
        } catch (e) {
            debug("undecodable message:", message.data.toString("hex"), e);
            return;
        }

        debug("received", PayloadType[decoded.type] ?? decoded.type);

        switch (decoded.type) {
            case PayloadType.BANG:
                this.onBang(decoded);
                break;

            case PayloadType.STREAMINFO:
                if (this.state === State.WAIT_BANG) {
                    this.earlyStreamInfo = decoded;
                } else {
                    this.onStreamInfo(decoded);
                }
                break;

            case PayloadType.DISCONNECT:
                // the transport ACKs this DATA right after we return
                setImmediate(() => {
                    this.shutdown(`console disconnected: ${decoded.disconnectReason ?? "(no reason)"}`, false);
                });
                break;

            default:
                break;
        }
    }

    /**
     * Called synchronously from the transport, so the keys exist before
     * the DATA_ACK for BANG is sent (spec 6.3).
     */
    private onBang(message: ITakionMessage) {
        if (this.state !== State.WAIT_BANG || !message.bang) {
            return;
        }

        try {
            const { publicKey, signatureValid } = validateBang(
                message.bang,
                this.kex.handshakeKey,
            );
            if (!signatureValid) {
                debug("WARNING: BANG key signature does not match; continuing");
            }

            const { local } = this.kex.deriveContexts(publicKey);
            this.transport.setCryptoContext(local);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            this.bang.reject(error);
            return;
        }

        debug("BANG ok; server version", message.bang.serverVersion);
        this.state = State.WAIT_STREAMINFO;
        this.bang.resolve();

        const early = this.earlyStreamInfo;
        if (early) {
            this.earlyStreamInfo = undefined;
            this.onStreamInfo(early);
        }
    }

    private onStreamInfo(message: ITakionMessage) {
        if (this.state !== State.WAIT_STREAMINFO) {
            return;
        }

        debug("STREAMINFO:", message.streamInfo);
        this.state = State.CONNECTED;

        // reply after the transport has ACK'd the STREAMINFO itself
        setImmediate(() => this.sendStreamInfoReplies());
    }

    private async sendStreamInfoReplies() {
        if (this.state !== State.CONNECTED) return;

        const acks = streamInfoReplies(
            this.options.controllerType,
            this.options.sendMicStreamInfo,
        ).map(reply => this.transport.sendData(
            reply.channel,
            reply.data,
        ));

        this.keepAlive.startConnected();

        try {
            if (this.options.waitForControllerAck) {
                // [1] is CONTROLLERCONNECTION
                await acks[1];
            }
            this.connected.resolve();
        } catch (e) {
            this.connected.reject(e instanceof Error ? e : new Error(String(e)));
        }
    }

    private sendCongestion() {
        const received = this.transport.avReceived;
        this.transport.avReceived = 0;
        this.transport.sendCongestion({ word0: 0, received, lost: 0 });
    }

    private sendHeartbeat() {
        if (!this.isConnected) return;
        this.transport.sendData(StreamChannel.Main, encodeHeartbeat());
    }

    private sendFeedbackState() {
        if (!this.isConnected || !this.transport.hasKeys) return;
        const sequence = this.stateSequence;
        this.stateSequence = (this.stateSequence + 1) & 0xffff;
        this.transport.sendFeedback(
            BaseType.FeedbackState,
            sequence,
            1,
            encodeControllerState(this.controllerState),
        );
    }

    private sendHistoryPayload(payload: Buffer, count: number) {
        const sequence = this.historySequence;
        this.historySequence = (this.historySequence + 1) & 0xffff;
        this.transport.sendFeedback(BaseType.FeedbackHistory, sequence, count, payload);
    }

    private sendHistoryEvent(event: Buffer) {
        this.cancelTail();

        const { payload, count } = this.history.push(event);
        this.sendHistoryPayload(payload, count);

        // resend the same payload as loss protection (spec 9.4)
        const done = new Deferred<void>();
        this.tailDone = done;
        const offsets = this.options.tailResendMillis;
        if (!offsets.length) {
            done.resolve();
            return;
        }

        this.tailTimers = offsets.map((offset, index) => setTimeout(() => {
            if (this.isConnected) {
                this.sendHistoryPayload(payload, count);
            }
            if (index === offsets.length - 1) {
                this.tailTimers = [];
                done.resolve();
            }
        }, offset));
    }

    private cancelTail() {
        for (const timer of this.tailTimers) {
            clearTimeout(timer);
        }
        this.tailTimers = [];
        this.tailDone?.resolve();
        this.tailDone = undefined;
    }
}
