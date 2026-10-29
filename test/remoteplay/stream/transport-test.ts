import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import dgram from "dgram";
import { EventEmitter } from "events";
import sinon from "sinon";
import sinonChai from "sinon-chai";

import {
    ChunkType,
    decodeControlPacket,
    decodeDataAckPayload,
    encodeControlPacket,
    encodeDataPayload,
    encodeInitAckPayload,
} from "../../../src/remoteplay/stream/packets";
import {
    defaultTransportOptions,
    IDatagramChannel,
    IReceivedMessage,
    ITransportOptions,
    StreamTransport,
    TransportClosedError,
    UdpDatagramChannel,
} from "../../../src/remoteplay/stream/transport";

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();
const { expect } = chai;

const SERVER_TAG = 0x55667788;
const CLIENT_TAG = 0x01020304;

function delay(millis: number) {
    return new Promise<void>(resolve => setTimeout(resolve, millis));
}

class FakeChannel implements IDatagramChannel {
    public closed = false;
    public readonly sent: Buffer[] = [];
    public receiver?: (datagram: Buffer) => void;

    constructor(public respond = true) {}

    public send(datagram: Buffer) {
        this.sent.push(Buffer.from(datagram));
        if (!this.respond) return;

        const packet = decodeControlPacket(datagram);
        if (packet?.chunkType === ChunkType.Init) {
            setImmediate(() => this.reply(ChunkType.InitAck, encodeInitAckPayload({
                tag: SERVER_TAG,
                receiveWindow: 0x19000,
                outboundStreams: 100,
                inboundStreams: 100,
                initialTsn: 1,
                cookie: Buffer.alloc(32, 1),
            })));
        } else if (packet?.chunkType === ChunkType.Cookie) {
            setImmediate(() => this.reply(ChunkType.CookieAck, Buffer.alloc(0)));
        }
    }

    public setReceiver(receiver: (datagram: Buffer) => void) {
        this.receiver = receiver;
    }

    public close() {
        this.closed = true;
    }

    public data(payload: Buffer) {
        this.reply(ChunkType.Data, payload, 1);
    }

    public acks() {
        return this.sent
            .map(d => decodeControlPacket(d)!)
            .filter(p => p.chunkType === ChunkType.DataAck)
            .map(p => decodeDataAckPayload(p.payload).cumulativeTsn);
    }

    private reply(chunkType: ChunkType, payload: Buffer, chunkFlags = 0) {
        this.receiver?.(encodeControlPacket({
            tag: CLIENT_TAG,
            mac: Buffer.alloc(4),
            keyPos: 0,
            chunkType,
            chunkFlags,
            payload,
        }));
    }
}

function dataPayload(tsn: number, data = Buffer.from([1, 2, 3])) {
    return encodeDataPayload({
        tsn, channel: 1, dataType: 0, data,
    });
}

async function establish(
    channel: FakeChannel,
    options: Partial<ITransportOptions> = {},
) {
    const transport = new StreamTransport(
        channel,
        { ...defaultTransportOptions, ...options },
        CLIENT_TAG,
    );
    await transport.connect();
    return transport;
}

describe("Stream transport", () => {
    afterEach(() => sinon.restore());

    it("acknowledges and skips a malformed DATA payload (R11)", async () => {
        const channel = new FakeChannel();
        const transport = await establish(channel);
        const messages: IReceivedMessage[] = [];
        transport.onMessage = m => messages.push(m);

        // 8 bytes: long enough for the TSN check, too short to decode
        channel.data(dataPayload(SERVER_TAG).slice(0, 8));
        channel.acks().should.deep.equal([SERVER_TAG]);

        // the next message still arrives
        channel.data(dataPayload(SERVER_TAG + 1));
        channel.acks().should.deep.equal([SERVER_TAG, SERVER_TAG + 1]);
        messages.should.have.length(1);
        transport.close();
    });

    it("buffers only TSNs within the reorder distance (R12)", async () => {
        const channel = new FakeChannel();
        const transport = await establish(channel);
        const messages: IReceivedMessage[] = [];
        transport.onMessage = m => messages.push(m);
        const buffered = () => (transport as any).outOfOrder.size as number;

        channel.data(dataPayload(SERVER_TAG + 1000));
        buffered().should.equal(0);

        channel.data(dataPayload(SERVER_TAG + 2));
        buffered().should.equal(1);

        channel.data(dataPayload(SERVER_TAG));
        channel.data(dataPayload(SERVER_TAG + 1));
        buffered().should.equal(0);
        messages.should.have.length(3);
        transport.close();
    });

    it("stops the retransmit timer after giving up (N6)", async () => {
        const channel = new FakeChannel();
        const transport = await establish(channel, {
            retransmitMillis: 20,
            maxRetransmits: 1,
        });
        const onError = sinon.stub();
        transport.onError = onError;

        transport.sendData(1, Buffer.from([1]));
        await delay(250);
        onError.should.have.been.calledOnce;
        transport.close();
    });

    it("reports an error from the retransmit timer instead of throwing (R1)", async () => {
        const channel = new FakeChannel();
        const transport = await establish(channel, { retransmitMillis: 20 });
        const onError = sinon.stub();
        transport.onError = onError;

        transport.sendData(1, Buffer.from([1]));
        sinon.stub(channel, "send").throws(new Error("send failed"));
        await delay(100);
        onError.should.have.been.called;
        onError.firstCall.args[0].message.should.equal("send failed");
        transport.close();
    });

    it("rejects with TransportClosedError when closed during the last attempt (N5)", async () => {
        const channel = new FakeChannel(false);
        const transport = new StreamTransport(channel, {
            ...defaultTransportOptions,
            connectAttempts: 1,
            replyTimeoutMillis: 1000,
        }, CLIENT_TAG);

        const connecting = transport.connect();
        await delay(20);
        transport.close();
        await connecting.should.be.rejectedWith(TransportClosedError);
    });
});

describe("UdpDatagramChannel", () => {
    afterEach(() => sinon.restore());

    it("closes the socket if binding fails (R7)", async () => {
        const socket = Object.assign(new EventEmitter(), {
            bind() {
                setImmediate(() => socket.emit("error", new Error("EADDRNOTAVAIL")));
            },
            close: sinon.stub(),
        });
        sinon.stub(dgram, "createSocket").returns(socket as unknown as dgram.Socket);

        await UdpDatagramChannel.open("127.0.0.1", 9296, { address: "192.0.2.1" })
            .should.be.rejectedWith("EADDRNOTAVAIL");
        expect(socket.close.calledOnce).to.be.true;
    });
});
