import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import crypto from "crypto";
import sinon from "sinon";

import { DeviceType, IDiscoveredDevice } from "../../../src/discovery/model";
import { pickCryptoStrategyForDevice } from "../../../src/remoteplay/crypto";
import {
    signPublicKey,
    StreamCryptoContext,
    StreamKeyExchange,
} from "../../../src/remoteplay/stream/crypto";
import { encodeButtonEvent, encodeControllerState, StreamButton } from "../../../src/remoteplay/stream/input";
import { authKeyStream, formatLaunchSpec } from "../../../src/remoteplay/stream/launch-spec";
import {
    decodeTakionMessage,
    encodeAudioHeader,
    encodeBang,
    encodeDisconnect,
    encodeServerStreamInfo,
    ITakionMessage,
    PayloadType,
} from "../../../src/remoteplay/stream/messages";
import {
    BaseType,
    baseTypeOf,
    ChunkType,
    decodeCongestion,
    decodeControlPacket,
    decodeDataAckPayload,
    decodeDataPayload,
    decodeFeedback,
    decodeInitPayload,
    encodeControlPacket,
    encodeDataAckPayload,
    encodeDataPayload,
    encodeInitAckPayload,
    IControlPacket,
} from "../../../src/remoteplay/stream/packets";
import { IStreamOptions, RemotePlayStream } from "../../../src/remoteplay/stream/stream";
import { defaultTransportOptions, IDatagramChannel } from "../../../src/remoteplay/stream/transport";
import { fakeRemotePlayCredentials } from "../util";

chai.use(chaiAsPromised);
chai.should();
const { expect } = chai;

/* eslint-disable no-bitwise */

// long enough that BIG needs two fragments, as with a real session ID
const SESSION_ID = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWx";
const SERVER_TAG = 0x55667788;

const device = { type: DeviceType.PS5, systemVersion: "1" } as IDiscoveredDevice;
const creds = fakeRemotePlayCredentials();
const nonce = Buffer.alloc(16, 0x42);
const strategy = pickCryptoStrategyForDevice(device);
const keyStream = (n: number) => authKeyStream(strategy, creds, nonce, n);

function delay(millis: number) {
    return new Promise<void>(resolve => setTimeout(resolve, millis));
}

class FakeChannel implements IDatagramChannel {
    public closed = false;
    public receiver?: (datagram: Buffer) => void;

    constructor(
        private readonly onSend: (datagram: Buffer) => void,
    ) {}

    public send(datagram: Buffer) {
        const copy = Buffer.from(datagram);
        setImmediate(() => this.onSend(copy));
    }

    public setReceiver(receiver: (datagram: Buffer) => void) {
        this.receiver = receiver;
    }

    public close() {
        this.closed = true;
    }

    public deliver(datagram: Buffer) {
        if (!this.closed) this.receiver?.(datagram);
    }
}

interface ISent {
    datagram: Buffer;
    baseType: number;
    keyPos: number;
    control?: IControlPacket;
    message?: ITakionMessage;
    channel?: number;
    tsn?: number;
    feedback?: { sequence: number, count: number, payload: Buffer };
}

/**
 * A simulated console. It verifies every MAC'd client datagram and
 * records what the client sent, in order.
 */
class FakeConsole {
    public readonly channel = new FakeChannel(d => this.onClientDatagram(d));
    public readonly sent: ISent[] = [];
    public readonly macFailures: string[] = [];
    public readonly unsealed: string[] = [];

    public clientTag = 0;
    public bigReceived?: ITakionMessage;
    public handshakeKey?: Buffer;
    public dropNextData = 0;
    public bang: Parameters<typeof encodeBang>[0] | undefined;
    public streamInfoFirst = false;
    public onMessage?: (message: ITakionMessage, channel: number) => void;

    private nextTsn = SERVER_TAG;
    private expectedClientTsn = 0;
    private fragments: Buffer[] = [];
    private readonly cookie = crypto.randomBytes(32);
    private readonly ecdh = crypto.createECDH("secp256k1");
    private clientContext?: StreamCryptoContext;

    constructor() {
        this.ecdh.generateKeys();
    }

    public sendMessage(data: Buffer, tsn = this.nextTsn++) {
        this.channel.deliver(encodeControlPacket({
            tag: this.clientTag,
            mac: Buffer.alloc(4),
            keyPos: 0,
            chunkType: ChunkType.Data,
            chunkFlags: 1,
            payload: encodeDataPayload({
                tsn, channel: 1, dataType: 0, data,
            }),
        }));
    }

    public messagesOfType(type: PayloadType) {
        return this.sent.filter(s => s.message?.type === type);
    }

    private reply(chunkType: ChunkType, payload: Buffer) {
        this.channel.deliver(encodeControlPacket({
            tag: this.clientTag,
            mac: Buffer.alloc(4),
            keyPos: 0,
            chunkType,
            chunkFlags: 0,
            payload,
        }));
    }

    private verifyMac(datagram: Buffer, name: string) {
        const ctx = this.clientContext;
        if (!ctx) return;

        const copy = Buffer.from(datagram);
        let macOffset: number;
        let keyPos: number;
        switch (baseTypeOf(datagram)) {
            case BaseType.Control:
                macOffset = 5;
                keyPos = copy.readUInt32BE(9);
                copy.fill(0, 9, 13);
                break;
            case BaseType.Congestion:
                macOffset = 7;
                keyPos = copy.readUInt32BE(11);
                copy.fill(0, 11, 15);
                break;
            default:
                macOffset = 8;
                keyPos = copy.readUInt32BE(4);
                break;
        }
        const mac = Buffer.from(copy.slice(macOffset, macOffset + 4));
        copy.fill(0, macOffset, macOffset + 4);

        if (keyPos === 0 && mac.equals(Buffer.alloc(4))) {
            // sent before the client processed BANG
            this.unsealed.push(name);
            return;
        }

        if (!ctx.mac(BigInt(keyPos), copy).equals(mac)) {
            this.macFailures.push(`${name} at KP ${keyPos}`);
        }
    }

    private onClientDatagram(datagram: Buffer) {
        const baseType = baseTypeOf(datagram);
        const entry: ISent = { datagram, baseType, keyPos: 0 };

        if (baseType === BaseType.Congestion) {
            entry.keyPos = decodeCongestion(datagram).keyPos;
            this.verifyMac(datagram, "congestion");
            this.sent.push(entry);
            return;
        }

        if (baseType === BaseType.FeedbackState || baseType === BaseType.FeedbackHistory) {
            const { header, payload } = decodeFeedback(datagram);
            entry.keyPos = header.keyPos;
            this.verifyMac(datagram, "feedback");
            entry.feedback = {
                sequence: header.sequence,
                count: header.itemCount,
                payload: this.clientContext!.encrypt(BigInt(header.keyPos + 16), payload),
            };
            this.sent.push(entry);
            return;
        }

        const packet = decodeControlPacket(datagram);
        if (!packet) throw new Error("client sent a malformed control packet");
        entry.control = packet;
        entry.keyPos = packet.keyPos;
        this.sent.push(entry);

        switch (packet.chunkType) {
            case ChunkType.Init: {
                packet.tag.should.equal(0);
                const init = decodeInitPayload(packet.payload);
                this.clientTag = init.tag;
                this.expectedClientTsn = init.initialTsn;
                this.reply(ChunkType.InitAck, encodeInitAckPayload({
                    tag: SERVER_TAG,
                    receiveWindow: 0x19000,
                    outboundStreams: 100,
                    inboundStreams: 100,
                    initialTsn: 0x01010101,
                    cookie: this.cookie,
                }));
                break;
            }

            case ChunkType.Cookie:
                packet.tag.should.equal(SERVER_TAG);
                packet.payload.should.deep.equal(this.cookie);
                this.reply(ChunkType.CookieAck, Buffer.alloc(0));
                break;

            case ChunkType.DataAck:
                packet.tag.should.equal(SERVER_TAG);
                this.verifyMac(datagram, "DATA_ACK");
                break;

            case ChunkType.Data:
                packet.tag.should.equal(SERVER_TAG);
                this.verifyMac(datagram, "DATA");
                this.onData(packet, entry);
                break;
        }
    }

    /* eslint-disable no-param-reassign */
    private onData(packet: IControlPacket, entry: ISent) {
        if (this.dropNextData > 0) {
            this.dropNextData--;
            entry.tsn = packet.payload.readUInt32BE(0);
            return;
        }

        const tsn = packet.payload.readUInt32BE(0);
        entry.tsn = tsn;
        if (tsn !== this.expectedClientTsn) {
            // duplicate or out of order; re-ack
            this.reply(ChunkType.DataAck, this.ackPayload());
            return;
        }
        this.expectedClientTsn = (this.expectedClientTsn + 1) >>> 0;

        const last = (packet.chunkFlags & 1) !== 0;
        const chunk = decodeDataPayload(packet.payload, this.fragments.length > 0);
        this.fragments.push(chunk.data);
        entry.channel = chunk.channel;

        this.reply(ChunkType.DataAck, this.ackPayload());

        if (!last) return;
        const data = Buffer.concat(this.fragments);
        this.fragments = [];

        const message = decodeTakionMessage(data);
        entry.message = message;
        this.onMessage?.(message, chunk.channel);

        if (message.type === PayloadType.BIG) {
            this.onBig(message);
        }
    }

    /* eslint-enable no-param-reassign */

    private ackPayload() {
        return encodeDataAckPayload({
            cumulativeTsn: (this.expectedClientTsn - 1) >>> 0,
            receiveWindow: 0x19000,
            gapAckBlocks: 0,
            duplicateTsns: 0,
        });
    }

    private onBig(message: ITakionMessage) {
        this.bigReceived = message;
        const big = message.big!;

        // recover the handshake key from the encrypted launch spec
        const cipher = Buffer.from(big.launchSpec, "base64");
        const key = keyStream(cipher.length);
        const plain = Buffer.from(cipher.map((b, i) => b ^ key[i]));
        plain[plain.length - 1].should.equal(0);
        const json = JSON.parse(plain.slice(0, -1).toString());
        this.handshakeKey = Buffer.from(json.handshakeKey, "base64");

        const consoleKey = this.ecdh.getPublicKey();
        const secret = this.ecdh.computeSecret(big.ecdhPublicKey);
        this.clientContext = StreamCryptoContext.derive(secret, this.handshakeKey, 2);

        const bang = encodeBang(this.bang ?? {
            serverVersion: 12,
            encryptedKeyAccepted: true,
            versionAccepted: true,
            ecdhPublicKey: consoleKey,
            ecdhSignature: signPublicKey(this.handshakeKey, consoleKey),
        });
        const streamInfo = encodeServerStreamInfo({
            resolutions: [{ width: 640, height: 360, videoHeader: Buffer.alloc(20, 7) }],
            audioHeader: encodeAudioHeader(),
        });

        setImmediate(() => {
            if (this.streamInfoFirst) {
                // STREAMINFO is delivered first, and out of TSN order
                this.sendMessage(bang, SERVER_TAG + 1);
                this.sendMessage(streamInfo, SERVER_TAG);
                this.nextTsn = SERVER_TAG + 2;
            } else {
                this.sendMessage(bang);
                this.sendMessage(streamInfo);
            }
        });
    }
}

const fastOptions: Partial<IStreamOptions> = {
    keepAlive: {
        congestionMillis: 20,
        feedbackStateMillis: 20,
        heartbeatMillis: 50,
    },
    transport: {
        ...defaultTransportOptions,
        retransmitMillis: 30,
        replyTimeoutMillis: 500,
    },
    bangTimeoutMillis: 1000,
    streamInfoTimeoutMillis: 1000,
};

const opened: RemotePlayStream[] = [];

function openFakeStream(fake: FakeConsole, options: Partial<IStreamOptions> = fastOptions) {
    const stream = new RemotePlayStream({
        channel: fake.channel,
        sessionId: SESSION_ID,
        authKeyStream: keyStream,
        options,
    });
    opened.push(stream);
    return stream;
}

describe("Remote Play stream session", function streamSessionTests() {
    this.timeout(5000);

    afterEach(async () => {
        sinon.restore();

        // don't leave timers running if a test failed half way
        await Promise.all(opened.splice(0).map(s => s.close()));
    });

    it("runs the handshake, taps a button and closes", async () => {
        const fake = new FakeConsole();
        const stream = openFakeStream(fake);
        await stream.start();

        // BIG: the session ID, protocol version and a signed key
        const big = fake.bigReceived!.big!;
        big.clientVersion.should.equal(12);
        big.sessionKey.should.equal(SESSION_ID);
        big.encryptedKey.should.deep.equal(Buffer.alloc(4));
        big.ecdhPublicKey.should.deep.equal(stream.kex.publicKey);
        big.ecdhSignature.should.deep.equal(
            signPublicKey(stream.kex.handshakeKey, stream.kex.publicKey),
        );
        fake.handshakeKey!.should.deep.equal(stream.kex.handshakeKey);
        Buffer.from(big.launchSpec, "base64").length
            .should.equal(formatLaunchSpec(stream.kex.handshakeKey).length + 1);

        // BIG went out as two fragments, KP 0 and MAC 0, TSN Tc and Tc+1
        const bigFragments = fake.sent.filter(s => s.control?.chunkType === ChunkType.Data)
            .slice(0, 2);
        bigFragments.map(s => s.tsn).should.deep.equal([
            stream.transport.clientTag,
            (stream.transport.clientTag + 1) >>> 0,
        ]);
        bigFragments.map(s => s.control!.chunkFlags).should.deep.equal([0, 1]);
        for (const s of bigFragments) {
            s.control!.mac.should.deep.equal(Buffer.alloc(4));
            s.keyPos.should.equal(0);
        }

        await stream.tap(StreamButton.CROSS, 10);
        await delay(80);
        await stream.close();
        await delay(10);

        fake.macFailures.should.deep.equal([]);

        // the first MAC'd datagram is the DATA_ACK for BANG, at KP 0
        const firstMacd = fake.sent.find(s => s.control?.mac.some(b => b !== 0)
            || (s.baseType === BaseType.Congestion && s.datagram.slice(7, 11).some(b => b !== 0)));
        firstMacd!.control!.chunkType.should.equal(ChunkType.DataAck);
        firstMacd!.keyPos.should.equal(0);
        decodeDataAckPayload(firstMacd!.control!.payload).cumulativeTsn.should.equal(SERVER_TAG);

        // replies to STREAMINFO, in order, after its ACK
        const ackOfStreamInfo = fake.sent.findIndex(s => s.control?.chunkType === ChunkType.DataAck
            && decodeDataAckPayload(s.control.payload).cumulativeTsn === SERVER_TAG + 1);
        const replies = fake.sent.filter(s => s.message
            && s.message.type !== PayloadType.BIG
            && s.message.type !== PayloadType.HEARTBEAT);
        // the microphone STREAMINFO is off by default
        replies.slice(0, 3).map(s => [s.message!.type, s.channel]).should.deep.equal([
            [PayloadType.STREAMINFOACK, 9],
            [PayloadType.CONTROLLERCONNECTION, 1],
            [PayloadType.DISCONNECT, 1],
        ]);
        fake.sent.indexOf(replies[0]).should.be.greaterThan(ackOfStreamInfo);
        replies[replies.length - 1].message!.type.should.equal(PayloadType.DISCONNECT);
        replies[replies.length - 1].message!.disconnectReason!
            .should.equal("Client Disconnecting");

        // everything after the first MAC'd datagram is MAC'd too; KPs
        // never decrease after the keys exist, and never repeat
        const macd = fake.sent.slice(fake.sent.indexOf(firstMacd!));
        for (const s of macd) {
            const macOffsets: { [type: number]: number } = {
                [BaseType.Control]: 5,
                [BaseType.Congestion]: 7,
            };
            const offset = macOffsets[s.baseType] ?? 8;
            s.datagram.slice(offset, offset + 4).should.not.deep.equal(Buffer.alloc(4));
        }
        const kps = macd.map(s => s.keyPos);
        for (let i = 1; i < kps.length; i++) {
            kps[i].should.be.greaterThan(kps[i - 1]);
        }

        // heartbeats and idle state keep the session alive
        fake.messagesOfType(PayloadType.HEARTBEAT).length.should.be.greaterThan(0);
        const states = fake.sent.filter(s => s.baseType === BaseType.FeedbackState);
        states.length.should.be.greaterThan(1);
        states[0].feedback!.payload.should.deep.equal(encodeControllerState());
        states.map(s => s.feedback!.sequence).should.deep.equal(states.map((_, i) => i));

        // the tap: press, release, then 4 tail resends of the release
        const history = fake.sent.filter(s => s.baseType === BaseType.FeedbackHistory);
        history.map(s => s.feedback!.payload.toString("hex")).should.deep.equal([
            "8088ff",
            "80880080 88ff".replace(" ", ""),
            "8088008088ff",
            "8088008088ff",
            "8088008088ff",
            "8088008088ff",
        ]);
        history.map(s => s.feedback!.count).should.deep.equal([1, 2, 2, 2, 2, 2]);
        history.map(s => s.feedback!.sequence).should.deep.equal([0, 1, 2, 3, 4, 5]);

        (await stream.closed).should.equal("closed by client");
        fake.channel.closed.should.be.true;
    });

    it("keeps an early STREAMINFO until BANG arrives", async () => {
        const fake = new FakeConsole();
        fake.streamInfoFirst = true;
        const stream = openFakeStream(fake);
        await stream.start();
        stream.isConnected.should.be.true;
        fake.macFailures.should.deep.equal([]);
        await stream.close();
    });

    it("retransmits unacknowledged DATA unchanged", async () => {
        const fake = new FakeConsole();
        fake.dropNextData = 1;
        const stream = openFakeStream(fake);
        await stream.start();
        await stream.close();

        const first = fake.sent.filter(s => s.tsn === stream.transport.clientTag);
        first.length.should.be.greaterThan(1);
        first[1].datagram.should.deep.equal(first[0].datagram);
    });

    it("closes when the console sends DISCONNECT", async () => {
        const fake = new FakeConsole();
        const stream = openFakeStream(fake);
        await stream.start();

        fake.sendMessage(encodeDisconnect("Server shutting down"));
        (await stream.closed).should.contain("Server shutting down");
        stream.isConnected.should.be.false;
        await delay(10);

        // the DISCONNECT DATA was acknowledged
        const acks = fake.sent.filter(s => s.control?.chunkType === ChunkType.DataAck);
        decodeDataAckPayload(acks[acks.length - 1].control!.payload).cumulativeTsn
            .should.equal(SERVER_TAG + 2);

        await stream.tap(StreamButton.PS).should.be.rejected;
    });

    it("fails the handshake when BIG is rejected", async () => {
        const fake = new FakeConsole();
        fake.bang = {
            encryptedKeyAccepted: true,
            versionAccepted: false,
            ecdhPublicKey: Buffer.alloc(65, 4),
            ecdhSignature: Buffer.alloc(32),
        };
        const stream = openFakeStream(fake);
        await stream.start().should.be.rejectedWith(/version accepted: false/);
        (await stream.closed).should.contain("handshake failed");
    });

    it("fails when the console never answers INIT", async () => {
        const channel = new FakeChannel(() => { /* silent console */ });
        const stream = new RemotePlayStream({
            channel,
            sessionId: SESSION_ID,
            authKeyStream: keyStream,
            options: {
                ...fastOptions,
                transport: { ...fastOptions.transport!, replyTimeoutMillis: 20 },
            },
        });
        await stream.start().should.be.rejectedWith(/INIT_ACK/);
        channel.closed.should.be.true;
    });

    it("rejects a bad stick value without crashing from a timer (B1)", async () => {
        const fake = new FakeConsole();
        const stream = openFakeStream(fake);
        await stream.start();

        const idle = encodeControllerState();
        for (const bad of [40000, -32769, NaN, Infinity]) {
            expect(() => stream.setControllerState({
                gyro: { x: 0, y: 0, z: 0 },
                accel: { x: 0, y: 1, z: 0 },
                orientation: {
                    x: 0, y: 0, z: 0, w: 1,
                },
                leftStick: { x: bad, y: 0 },
                rightStick: { x: 0, y: 0 },
            })).to.throw(RangeError);
        }

        // the keep-alive timer keeps sending the last good state
        const before = fake.sent.length;
        await delay(100);
        stream.isConnected.should.be.true;
        const states = fake.sent.slice(before).filter(s => s.feedback && s.baseType === BaseType.FeedbackState);
        states.length.should.be.greaterThan(0);
        states[0].feedback!.payload.should.deep.equal(idle);

        // valid values are rounded
        stream.setControllerState({
            gyro: { x: 0, y: 0, z: 0 },
            accel: { x: 0, y: 1, z: 0 },
            orientation: {
                x: 0, y: 0, z: 0, w: 1,
            },
            leftStick: { x: 100.4, y: -32768 },
            rightStick: { x: 0, y: 32767 },
        });
        await delay(30);
        stream.isConnected.should.be.true;
    });

    it("shuts down instead of throwing when a timer fails (R1)", async () => {
        const fake = new FakeConsole();
        const stream = openFakeStream(fake);
        await stream.start();

        sinon.stub(fake.channel, "send").throws(new Error("boom"));
        (await stream.closed).should.contain("boom");
        stream.isConnected.should.be.false;
        fake.channel.closed.should.be.true;
    });

    it("still sends the release when close() is called during a hold (R4)", async () => {
        const fake = new FakeConsole();
        const stream = openFakeStream(fake);
        await stream.start();

        const tap = stream.tap(StreamButton.CROSS, 80);
        await delay(20);
        const closing = stream.close();

        expect(() => stream.sendButton(StreamButton.SQUARE, true)).to.throw(/closing/);
        await stream.tap(StreamButton.SQUARE, 10).should.be.rejectedWith(/closing/);

        await tap;
        await closing;
        await delay(10);

        const payloads = fake.sent
            .filter(s => s.baseType === BaseType.FeedbackHistory)
            .map(s => s.feedback!.payload.toString("hex"));
        payloads.some(p => p.startsWith(encodeButtonEvent(StreamButton.CROSS, false)
            .toString("hex"))).should.be.true;
        payloads.some(p => p.includes(encodeButtonEvent(StreamButton.SQUARE, true)
            .toString("hex"))).should.be.false;
    });

    it("closes the transport even if sending DISCONNECT throws (R6)", async () => {
        const fake = new FakeConsole();
        const stream = openFakeStream(fake, {
            ...fastOptions,
            keepAlive: {
                congestionMillis: 60000,
                feedbackStateMillis: 60000,
                heartbeatMillis: 60000,
            },
        });
        await stream.start();

        sinon.stub(fake.channel, "send").throws(new Error("send failed"));
        await stream.close();
        (await stream.closed).should.equal("closed by client");
        fake.channel.closed.should.be.true;
    });

    it("rejects a console public key that is not on the curve", async () => {
        expect(() => new StreamKeyExchange(Buffer.alloc(16)).computeSecret(Buffer.alloc(65, 1)))
            .to.throw();
    });
});
