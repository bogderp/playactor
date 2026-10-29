/* eslint-disable no-bitwise */

import crypto from "crypto";
import dgram from "dgram";
import _debug from "debug";

import { StreamCryptoContext } from "./crypto";
import {
    BaseType,
    baseTypeOf,
    ChunkType,
    DATA_ACK_SIZE,
    DATA_CONTINUATION_HEADER_SIZE,
    DATA_HEADER_SIZE,
    DataType,
    decodeControlPacket,
    decodeDataAckPayload,
    decodeDataPayload,
    decodeInitAckPayload,
    encodeCongestion,
    encodeControlPacket,
    encodeCookie,
    encodeDataAckPayload,
    encodeDataPayload,
    encodeInit,
    ICongestionReport,
    IFeedbackHeader,
    RECEIVE_WINDOW,
    serialGreater,
    serialLessOrEqual,
} from "./packets";
import { sealCongestion, sealControlPacket, sealFeedback } from "./seal";

const debug = _debug("playactor:remoteplay:stream:transport");

export const STREAM_PORT = 9296;

/** How far ahead of the expected TSN console DATA is buffered */
const MAX_REORDER_DISTANCE = 64;
export const DEFAULT_MTU = 1454;

/** The minimum datagram transport the stream needs; UDP in practice */
export interface IDatagramChannel {
    send(datagram: Buffer): void;
    close(): void;
    setReceiver(receiver: (datagram: Buffer) => void): void;
}

export class UdpDatagramChannel implements IDatagramChannel {
    public static async open(
        address: string,
        port: number = STREAM_PORT,
        bind?: { address?: string, port?: number },
    ) {
        const socket = dgram.createSocket("udp4");
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once("error", reject);
                socket.bind(bind?.port ?? 0, bind?.address, () => {
                    socket.removeListener("error", reject);
                    resolve();
                });
            });
        } catch (e) {
            try {
                socket.close();
            } catch (closeError) {
                // already closed
            }
            throw e;
        }
        try {
            socket.setRecvBufferSize(0x19000);
        } catch (e) {
            debug("unable to set receive buffer size:", e);
        }
        return new UdpDatagramChannel(socket, address, port);
    }

    private receiver?: (datagram: Buffer) => void;
    private pendingSends = 0;
    private closing = false;
    private isClosed = false;

    constructor(
        private readonly socket: dgram.Socket,
        private readonly address: string,
        private readonly port: number,
    ) {
        socket.on("message", (msg, rinfo) => {
            if (rinfo.address !== this.address) return;
            this.receiver?.(msg);
        });
        socket.on("error", err => {
            debug("udp socket error:", err);
        });
    }

    public setReceiver(receiver: (datagram: Buffer) => void) {
        this.receiver = receiver;
    }

    public send(datagram: Buffer) {
        if (this.closing) return;
        this.pendingSends++;
        this.socket.send(datagram, this.port, this.address, err => {
            if (err) debug("udp send error:", err);
            this.pendingSends--;
            if (this.closing && this.pendingSends === 0) {
                this.closeNow();
            }
        });
    }

    /** Close once queued datagrams have left the socket */
    public close() {
        this.closing = true;
        this.receiver = undefined;
        if (this.pendingSends === 0) {
            this.closeNow();
        } else {
            setTimeout(() => this.closeNow(), 1000).unref();
        }
    }

    private closeNow() {
        if (this.isClosed) return;
        this.isClosed = true;
        try {
            this.socket.close();
        } catch (e) {
            // already closed
        }
    }
}

export interface ITransportOptions {
    replyTimeoutMillis: number;
    connectAttempts: number;
    retransmitMillis: number;
    maxRetransmits: number;
    maxInFlight: number;
    maxOutOfOrder: number;
    mtu: number;
}

export const defaultTransportOptions: ITransportOptions = {
    replyTimeoutMillis: 5000,
    connectAttempts: 3,
    retransmitMillis: 200,
    maxRetransmits: 25,
    maxInFlight: 16,
    maxOutOfOrder: 16,
    mtu: DEFAULT_MTU,
};

export interface IReceivedMessage {
    channel: number;
    dataType: number;
    data: Buffer;
}

export interface IFragment {
    offset: number;
    length: number;
    first: boolean;
    last: boolean;
}

/**
 * Split a message of `length` bytes into DATA fragments (spec 6.2).
 * With M = mtu - 50, a first fragment carries M - 26 bytes and a
 * continuation M - 25. A non-final fragment never takes the whole
 * remainder, so the last fragment always exists and carries flags 1.
 */
export function planFragments(length: number, mtu: number = DEFAULT_MTU): IFragment[] {
    const limit = mtu - 50;
    const fragments: IFragment[] = [];
    let offset = 0;

    while (length - offset + DATA_HEADER_SIZE > limit) {
        const first = offset === 0;
        const remaining = length - offset;
        const size = Math.min(
            first ? limit - DATA_HEADER_SIZE : limit - DATA_CONTINUATION_HEADER_SIZE,
            remaining - 1,
        );
        fragments.push({
            offset, length: size, first, last: false,
        });
        offset += size;
    }

    fragments.push({
        offset,
        length: length - offset,
        first: offset === 0,
        last: true,
    });
    return fragments;
}

/** KP advance for a packet of "advance size" s (spec 7.7) */
export function keyPosAdvance(size: number) {
    return size + (size % 16);
}

interface IPendingMessage {
    channel: number;
    dataType: number;
    data: Buffer;
    fragments: IFragment[];
    nextFragment: number;
    lastTsn?: number;
    resolve(): void;
    reject(e: Error): void;
}

interface IInFlight {
    tsn: number;
    datagram: Buffer;
    lastSentAt: number;
    retransmits: number;
    message: IPendingMessage;
}

type ControlPacket = NonNullable<ReturnType<typeof decodeControlPacket>>;

type Waiter = {
    accept(packet: ReturnType<typeof decodeControlPacket>): boolean;
};

export class TransportClosedError extends Error {
    constructor(reason = "Stream transport closed") {
        super(reason);
    }
}

/**
 * Client side of the "Takion" transport: association set-up, reliable
 * DATA with ACKs and retransmission, and MAC/KP handling for every
 * client datagram (spec 4, 5, 7.6, 7.7).
 */
export class StreamTransport {
    public readonly clientTag: number;

    /** Video/audio datagrams received since the counter was last read */
    public avReceived = 0;

    public onMessage?: (message: IReceivedMessage) => void;
    public onError?: (error: Error) => void;

    private serverTag = 0;
    private context?: StreamCryptoContext;
    private keyPos = BigInt(0);

    private nextTsn: number;
    private readonly queue: IPendingMessage[] = [];
    private readonly inFlight: IInFlight[] = [];
    private retransmitTimer?: NodeJS.Timeout;

    private expectedTsn = 0;
    private readonly outOfOrder = new Map<number, Buffer>();
    private reassembly?: { channel: number, dataType: number, parts: Buffer[] };

    private waiter?: Waiter;
    private cancelRequest?: () => void;
    private established = false;
    private closed = false;

    constructor(
        private readonly channel: IDatagramChannel,
        private readonly options: ITransportOptions = defaultTransportOptions,
        clientTag?: number,
        private readonly now: () => number = Date.now,
    ) {
        this.clientTag = clientTag ?? StreamTransport.randomTag();
        this.nextTsn = this.clientTag;
        channel.setReceiver(datagram => this.onDatagram(datagram));
    }

    private static randomTag() {
        for (;;) {
            const tag = crypto.randomBytes(4).readUInt32BE(0);
            if (tag !== 0) return tag;
        }
    }

    public get isEstablished() {
        return this.established;
    }

    public get hasKeys() {
        return this.context !== undefined;
    }

    /** Current client key position (for tests and diagnostics) */
    public get currentKeyPos() {
        return this.keyPos;
    }

    /**
     * Run the four-way association set-up (spec 5.3)
     */
    public async connect() {
        const initAck = await this.request(
            () => encodeInit(this.clientTag),
            packet => packet.chunkType === ChunkType.InitAck,
            "INIT_ACK",
        );

        const ack = decodeInitAckPayload(initAck.payload);
        if (ack.tag === 0) {
            throw new Error("Console sent INIT_ACK with a zero tag");
        }
        if (ack.outboundStreams < 1 || ack.outboundStreams > 100
            || ack.inboundStreams < 100) {
            throw new Error(`Unexpected INIT_ACK stream counts: ${ack.outboundStreams}/${ack.inboundStreams}`);
        }

        this.serverTag = ack.tag;

        // spec 5.3: the console's first DATA TSN is its tag, not the
        // "initial TSN" field
        this.expectedTsn = ack.tag;
        debug("INIT_ACK: server tag", ack.tag.toString(16), "initial TSN", ack.initialTsn.toString(16));

        await this.request(
            () => encodeCookie(this.serverTag, ack.cookie),
            packet => packet.chunkType === ChunkType.CookieAck,
            "COOKIE_ACK",
        );

        this.established = true;
        this.retransmitTimer = setInterval(
            () => {
                try {
                    this.retransmit();
                } catch (e) {
                    this.fail(e instanceof Error ? e : new Error(String(e)));
                }
            },
            Math.max(10, Math.floor(this.options.retransmitMillis / 4)),
        );
        debug("transport established");
    }

    /**
     * Install the client-to-console crypto context. From now on every
     * client datagram is MAC'd and takes a key position (spec 7.7).
     */
    public setCryptoContext(context: StreamCryptoContext, initialKeyPos = BigInt(0)) {
        this.context = context;
        this.keyPos = initialKeyPos;
    }

    /**
     * Send a reliable message. Resolves when the console acknowledges
     * every fragment; rejects if it gives up.
     */
    public sendData(
        channel: number,
        data: Buffer,
        dataType: number = DataType.Protobuf,
    ): Promise<void> {
        if (this.closed) {
            return Promise.reject(new TransportClosedError());
        }

        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const promise = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        // callers often don't await this; avoid unhandled rejections
        promise.catch(() => { /* reported through onError */ });

        this.queue.push({
            channel,
            dataType,
            data,
            fragments: planFragments(data.length, this.options.mtu),
            nextFragment: 0,
            resolve,
            reject,
        });
        this.pump();

        return promise;
    }

    /**
     * Send a single-datagram DATA message once, without tracking it for
     * acknowledgement; used for the final DISCONNECT (spec 11).
     */
    public sendDataOnce(
        channel: number,
        data: Buffer,
        dataType: number = DataType.Protobuf,
    ) {
        if (this.closed || !this.established) return;
        const tsn = this.nextTsn;
        this.nextTsn = (this.nextTsn + 1) >>> 0;
        const datagram = this.buildData(tsn, channel, dataType, data, true, true);
        this.channel.send(datagram);
    }

    public sendCongestion(report: ICongestionReport) {
        if (this.closed) return;
        const datagram = encodeCongestion(report);
        sealCongestion(this.context, this.allocateKeyPos(datagram.length), datagram);
        this.channel.send(datagram);
    }

    /**
     * Send a feedback state or history datagram. Needs crypto keys.
     */
    public sendFeedback(
        baseType: IFeedbackHeader["baseType"],
        sequence: number,
        itemCount: number,
        payload: Buffer,
    ) {
        if (this.closed) return;
        const { context } = this;
        if (!context) {
            throw new Error("Feedback needs stream keys");
        }

        const keyPos = this.allocateKeyPos(payload.length + 16);
        const datagram = sealFeedback(context, keyPos, {
            baseType,
            sequence,
            itemCount,
        }, payload);

        this.channel.send(datagram);
        return datagram;
    }

    /**
     * Stop timers, fail pending sends, and close the channel. Does not
     * send anything.
     */
    public close() {
        if (this.closed) return;
        this.closed = true;

        this.stopRetransmitTimer();

        this.cancelRequest?.();

        const error = new TransportClosedError();
        for (const message of this.queue) message.reject(error);
        for (const entry of this.inFlight) entry.message.reject(error);
        this.queue.length = 0;
        this.inFlight.length = 0;

        this.channel.close();
    }

    /**
     * Allocate a key position for a packet of advance size `size`.
     * Before keys exist, everything uses KP 0 (spec 7.6).
     */
    private allocateKeyPos(size: number) {
        if (!this.context) {
            return BigInt(0);
        }
        const { keyPos } = this;
        this.keyPos += BigInt(keyPosAdvance(size));
        return keyPos;
    }

    private sendDataAck() {
        const cumulativeTsn = (this.expectedTsn - 1) >>> 0;
        const datagram = encodeControlPacket({
            tag: this.serverTag,
            mac: Buffer.alloc(4),
            keyPos: 0,
            chunkType: ChunkType.DataAck,
            chunkFlags: 0,
            payload: encodeDataAckPayload({
                cumulativeTsn,
                receiveWindow: RECEIVE_WINDOW,
                gapAckBlocks: 0,
                duplicateTsns: 0,
            }),
        });
        sealControlPacket(this.context, this.allocateKeyPos(DATA_ACK_SIZE), datagram);
        this.channel.send(datagram);
    }

    private buildData(
        tsn: number,
        channel: number,
        dataType: number,
        data: Buffer,
        first: boolean,
        last: boolean,
    ) {
        const datagram = encodeControlPacket({
            tag: this.serverTag,
            mac: Buffer.alloc(4),
            keyPos: 0,
            chunkType: ChunkType.Data,
            chunkFlags: last ? 1 : 0,
            payload: encodeDataPayload({
                tsn,
                channel,
                dataType: first ? dataType : undefined,
                data,
            }),
        });
        sealControlPacket(this.context, this.allocateKeyPos(data.length), datagram);
        return datagram;
    }

    private pump() {
        while (!this.closed
            && this.established
            && this.queue.length
            && this.inFlight.length < this.options.maxInFlight
        ) {
            const message = this.queue[0];
            const fragment = message.fragments[message.nextFragment++];
            if (message.nextFragment >= message.fragments.length) {
                this.queue.shift();
            }

            const tsn = this.nextTsn;
            this.nextTsn = (this.nextTsn + 1) >>> 0;

            const datagram = this.buildData(
                tsn,
                message.channel,
                message.dataType,
                message.data.slice(fragment.offset, fragment.offset + fragment.length),
                fragment.first,
                fragment.last,
            );

            if (fragment.last) {
                message.lastTsn = tsn;
            }

            this.inFlight.push({
                tsn,
                datagram,
                lastSentAt: this.now(),
                retransmits: 0,
                message,
            });
            this.channel.send(datagram);
        }
    }

    private stopRetransmitTimer() {
        if (this.retransmitTimer) {
            clearInterval(this.retransmitTimer);
            this.retransmitTimer = undefined;
        }
    }

    private retransmit() {
        const now = this.now();
        for (const entry of this.inFlight) {
            if (now - entry.lastSentAt < this.options.retransmitMillis) {
                continue;
            }

            if (entry.retransmits >= this.options.maxRetransmits) {
                // report once; the interval must not keep firing onError
                this.stopRetransmitTimer();
                this.fail(new Error(`DATA ${entry.tsn.toString(16)} was never acknowledged`));
                return;
            }

            entry.retransmits++;
            entry.lastSentAt = now;
            debug("retransmit TSN", entry.tsn.toString(16), "#", entry.retransmits);
            this.channel.send(entry.datagram);
        }
    }

    private onDataAck(cumulativeTsn: number) {
        let removed = false;
        for (let i = this.inFlight.length - 1; i >= 0; i--) {
            const entry = this.inFlight[i];
            if (serialLessOrEqual(entry.tsn, cumulativeTsn)) {
                this.inFlight.splice(i, 1);
                removed = true;
                if (entry.message.lastTsn === entry.tsn) {
                    entry.message.resolve();
                }
            }
        }

        if (removed) {
            this.pump();
        }
    }

    private onDatagram(datagram: Buffer) {
        if (this.closed || !datagram.length) return;

        switch (baseTypeOf(datagram)) {
            case BaseType.Video:
            case BaseType.Audio:
                this.avReceived++;
                return;

            case BaseType.Control:
                break;

            default:
                return;
        }

        const packet = decodeControlPacket(datagram);
        if (!packet || packet.tag !== this.clientTag) {
            debug("dropping malformed or foreign control packet");
            return;
        }

        const { waiter } = this;
        if (waiter && waiter.accept(packet)) {
            return;
        }

        if (!this.established) {
            return;
        }

        try {
            switch (packet.chunkType) {
                case ChunkType.Data:
                    this.onDataChunk(packet.payload, packet.chunkFlags);
                    break;

                case ChunkType.DataAck:
                    this.onDataAck(decodeDataAckPayload(packet.payload).cumulativeTsn);
                    break;

                default:
                    debug("ignoring chunk type", packet.chunkType);
            }
        } catch (e) {
            debug("error handling control packet:", e);
        }
    }

    private onDataChunk(payload: Buffer, flags: number) {
        if (payload.length < 8) {
            return;
        }

        const tsn = payload.readUInt32BE(0);
        if (tsn === this.expectedTsn) {
            // advance before decoding: a malformed payload must not make
            // the console retransmit it forever
            this.expectedTsn = (this.expectedTsn + 1) >>> 0;
            this.tryDeliver(payload, flags);

            // deliver anything buffered that is now contiguous
            for (;;) {
                const next = this.outOfOrder.get(this.expectedTsn);
                if (!next) break;
                this.outOfOrder.delete(this.expectedTsn);
                this.expectedTsn = (this.expectedTsn + 1) >>> 0;
                this.tryDeliver(next.slice(1), next[0]);
            }
        } else if (serialGreater(tsn, this.expectedTsn)) {
            const ahead = (tsn - this.expectedTsn) >>> 0;
            if (ahead <= MAX_REORDER_DISTANCE
                && this.outOfOrder.size < this.options.maxOutOfOrder
                && !this.outOfOrder.has(tsn)) {
                // keep the flags byte with the payload
                this.outOfOrder.set(tsn, Buffer.concat([Buffer.from([flags]), payload]));
            }
        } else {
            debug("duplicate DATA", tsn.toString(16));
        }

        // spec 5.6: ACK after delivery; duplicates are re-acked too
        this.sendDataAck();
    }

    private tryDeliver(payload: Buffer, flags: number) {
        try {
            this.deliver(payload, flags);
        } catch (e) {
            debug("dropping undecodable DATA:", e);
            this.reassembly = undefined;
        }
    }

    private deliver(payload: Buffer, flags: number) {
        const last = (flags & 1) !== 0; // eslint-disable-line no-bitwise
        const { reassembly } = this;

        // spec ambiguity: the console's DATA chunks are documented with
        // flags 1 only. If a non-final fragment does arrive, reassemble
        // it the way the client sends them (first fragment carries the
        // data type; continuations don't).
        if (reassembly) {
            const chunk = decodeDataPayload(payload, true);
            reassembly.parts.push(chunk.data);
            if (last) {
                this.reassembly = undefined;
                this.dispatch({
                    channel: reassembly.channel,
                    dataType: reassembly.dataType,
                    data: Buffer.concat(reassembly.parts),
                });
            }
            return;
        }

        const chunk = decodeDataPayload(payload);
        if (!last) {
            this.reassembly = {
                channel: chunk.channel,
                dataType: chunk.dataType ?? 0,
                parts: [chunk.data],
            };
            return;
        }

        this.dispatch({
            channel: chunk.channel,
            dataType: chunk.dataType ?? 0,
            data: chunk.data,
        });
    }

    private dispatch(message: IReceivedMessage) {
        try {
            this.onMessage?.(message);
        } catch (e) {
            debug("message handler error:", e);
            this.fail(e instanceof Error ? e : new Error(String(e)));
        }
    }

    private fail(error: Error) {
        if (this.closed) return;
        debug("transport failure:", error);
        this.onError?.(error);
    }

    /**
     * Send a set-up packet and wait for the matching reply; resend up to
     * `connectAttempts` times in total (spec 5.3).
     */
    private async request(
        build: () => Buffer,
        matches: (packet: ControlPacket) => boolean,
        name: string,
    ) {
        for (let attempt = 1; attempt <= this.options.connectAttempts; attempt++) {
            if (this.closed) throw new TransportClosedError();

            const datagram = build();
            // eslint-disable-next-line no-await-in-loop
            const reply = await new Promise<ControlPacket | undefined>(resolve => {
                const timer = setTimeout(() => {
                    this.waiter = undefined;
                    this.cancelRequest = undefined;
                    resolve(undefined);
                }, this.options.replyTimeoutMillis);

                this.cancelRequest = () => {
                    clearTimeout(timer);
                    this.waiter = undefined;
                    this.cancelRequest = undefined;
                    resolve(undefined);
                };

                this.waiter = {
                    accept: packet => {
                        if (!packet || !matches(packet)) {
                            // eg: a repeated INIT_ACK while waiting for COOKIE_ACK
                            return true;
                        }
                        clearTimeout(timer);
                        this.waiter = undefined;
                        this.cancelRequest = undefined;
                        resolve(packet);
                        return true;
                    },
                };

                debug("sending", name === "INIT_ACK" ? "INIT" : "COOKIE", "attempt", attempt);
                this.channel.send(datagram);
            });

            if (reply) {
                return reply;
            }
        }

        if (this.closed) throw new TransportClosedError();
        throw new Error(`Timed out waiting for ${name}`);
    }
}
