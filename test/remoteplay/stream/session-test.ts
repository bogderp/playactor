import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import sinon from "sinon";
import sinonChai from "sinon-chai";

import { IDiscoveredDevice } from "../../../src/discovery/model";
import * as sessionModule from "../../../src/remoteplay/session";
import { receiveSessionId } from "../../../src/remoteplay/session-id";
import { openStreamSession } from "../../../src/remoteplay/stream/session";
import { RemotePlayStream } from "../../../src/remoteplay/stream/stream";
import { IDatagramChannel } from "../../../src/remoteplay/stream/transport";
import { fakeRemotePlayCredentials, fakeRemotePlayDevice } from "../util";

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();

function fakeCtrlSocket() {
    // a ctrl connection that stays quiet until it is closed
    return {
        receive: () => ({
            [Symbol.asyncIterator]: () => ({
                next: () => new Promise<IteratorResult<never>>(() => { /* never */ }),
                return: async () => ({ value: undefined, done: true as const }),
            }),
        }),
        send: sinon.stub().resolves(),
        close: sinon.stub().resolves(),
    };
}

function fakeChannel() {
    return {
        send: sinon.stub(),
        close: sinon.stub(),
        setReceiver: sinon.stub(),
    };
}

describe("openStreamSession", () => {
    const device: IDiscoveredDevice = fakeRemotePlayDevice();
    const creds = fakeRemotePlayCredentials();

    let socket: ReturnType<typeof fakeCtrlSocket>;
    let cancelSessionId: sinon.SinonStub;
    let sessionId: Promise<string | undefined>;

    beforeEach(() => {
        socket = fakeCtrlSocket();
        cancelSessionId = sinon.stub();
        sessionId = Promise.resolve("A".repeat(30));
        sinon.stub(sessionModule, "openSessionWithInfo").callsFake(async () => ({
            socket,
            nonce: Buffer.alloc(16),
            sessionId,
            cancelSessionId,
        }) as any);
    });

    afterEach(() => sinon.restore());

    it("closes the ctrl socket when onLoggedIn throws", async () => {
        await openStreamSession(device, {}, creds, {
            onLoggedIn: () => { throw new Error("callback failed"); },
        }).should.be.rejectedWith("callback failed");
        socket.close.should.have.been.calledOnce;
    });

    it("closes the channel and the socket if the stream can't be created", async () => {
        const channel = fakeChannel();
        channel.setReceiver.throws(new Error("no receiver"));

        await openStreamSession(device, {}, creds, {
            createChannel: async () => channel as IDatagramChannel,
        }).should.be.rejectedWith("no receiver");
        channel.close.should.have.been.calledOnce;
        socket.close.should.have.been.calledOnce;
    });

    it("closes the socket and the channel if the stream fails to start", async () => {
        const channel = fakeChannel();
        sinon.stub(RemotePlayStream.prototype, "start").rejects(new Error("start failed"));

        await openStreamSession(device, {}, creds, {
            createChannel: async () => channel as IDatagramChannel,
        }).should.be.rejectedWith("start failed");
        channel.close.should.have.been.called;
        socket.close.should.have.been.calledOnce;
    });

    it("stops waiting for the session ID when it times out", async () => {
        sessionId = new Promise(() => { /* the console stays silent */ });
        const onSessionId = sinon.stub();

        await openStreamSession(device, {}, creds, {
            sessionIdTimeoutMillis: 10,
            onSessionId,
            createChannel: async () => { throw new Error("no channel"); },
        }).should.be.rejectedWith("no channel");
        onSessionId.should.have.been.calledWith(true);
        cancelSessionId.should.have.been.called;
        socket.close.should.have.been.calledOnce;
    });

    it("closes the ctrl socket when the stream ends on its own", async () => {
        const channel = fakeChannel();
        sinon.stub(RemotePlayStream.prototype, "start").resolves();

        const session = await openStreamSession(device, {}, creds, {
            createChannel: async () => channel as IDatagramChannel,
        });
        socket.close.should.not.have.been.called;

        // eg: the console sent DISCONNECT
        await session.stream.close();
        await session.closed;
        await new Promise(resolve => setImmediate(resolve));
        socket.close.should.have.been.calledOnce;

        await session.close();
        socket.close.should.have.been.calledOnce;
    });
});

describe("receiveSessionId", () => {
    it("stops and detaches its receiver when aborted", async () => {
        const iteratorReturn = sinon.stub().resolves({ value: undefined, done: true });
        const socket = {
            receive: () => ({
                [Symbol.asyncIterator]: () => ({
                    next: () => new Promise<IteratorResult<never>>(() => { /* never */ }),
                    return: iteratorReturn,
                }),
            }),
        };

        const abort = new AbortController();
        const result = receiveSessionId(socket as any, abort.signal);
        abort.abort();

        chai.expect(await result).to.equal(undefined);
        iteratorReturn.should.have.been.calledOnce;
    });
});
