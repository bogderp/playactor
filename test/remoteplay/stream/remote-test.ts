import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as FakeTimers from "@sinonjs/fake-timers";

import { IRemotePlayCredentials } from "../../../src/credentials/model";
import { IDiscoveredDevice } from "../../../src/discovery/model";
import { StreamButton } from "../../../src/remoteplay/stream/input";
import { IStreamRemoteOptions, StreamRemote } from "../../../src/remoteplay/stream/remote";
import { IStreamSession } from "../../../src/remoteplay/stream/session";
import { RemotePlayStream } from "../../../src/remoteplay/stream/stream";

chai.use(chaiAsPromised);
chai.should();

class FakeSession implements IStreamSession {
    public readonly stream: RemotePlayStream;
    public readonly closed: Promise<string>;
    public taps: StreamButton[] = [];
    public tapTimes: number[] = [];
    public isClosed = false;
    public closeStarted = false;

    /** Set to make close() wait for this promise */
    public closeGate?: Promise<void>;

    private resolveClosed!: (reason: string) => void;

    constructor() {
        this.closed = new Promise(resolve => {
            this.resolveClosed = resolve;
        });

        const isConnected = () => !this.isClosed;
        this.stream = {
            get isConnected() { return isConnected(); },
        } as RemotePlayStream;
    }

    public async tap(button: StreamButton) {
        if (this.isClosed) throw new Error("Stream closed");
        this.taps.push(button);
        this.tapTimes.push(Date.now());
        return { button, pressedAt: 0, releasedAt: 0 };
    }

    public async close() {
        this.closeStarted = true;
        if (this.closeGate) await this.closeGate;
        this.closedBy("closed by client");
    }

    public closedBy(reason: string) {
        this.isClosed = true;
        this.resolveClosed(reason);
    }
}

describe("StreamRemote", () => {
    let clock: FakeTimers.Clock;
    let sessions: FakeSession[];
    let failNextOpen: boolean;
    let hangNextOpen: Promise<FakeSession> | undefined;
    let remote: StreamRemote;

    function createRemote(options: IStreamRemoteOptions = {}) {
        return new StreamRemote(
            {} as IDiscoveredDevice,
            {},
            {} as IRemotePlayCredentials,
            {
                idleTimeoutMillis: 60_000,
                tapGapMillis: 0,
                async openSession() {
                    if (failNextOpen) {
                        failNextOpen = false;
                        throw new Error("console is in rest mode");
                    }
                    if (hangNextOpen) {
                        const hung = hangNextOpen;
                        hangNextOpen = undefined;
                        return hung;
                    }
                    const session = new FakeSession();
                    sessions.push(session);
                    return session;
                },
                ...options,
            },
        );
    }

    beforeEach(() => {
        clock = FakeTimers.install();
        sessions = [];
        failNextOpen = false;
        hangNextOpen = undefined;
        remote = createRemote();
    });

    afterEach(async () => {
        await remote.close();
        clock.uninstall();
    });

    it("sends taps in order over one session", async () => {
        await Promise.all([
            remote.tap(StreamButton.RIGHT),
            remote.tap(StreamButton.RIGHT),
            remote.tap(StreamButton.LEFT),
        ]);

        sessions.should.have.length(1);
        sessions[0].taps.should.deep.equal([
            StreamButton.RIGHT,
            StreamButton.RIGHT,
            StreamButton.LEFT,
        ]);
    });

    it("closes the session after the idle timeout", async () => {
        await remote.tap(StreamButton.RIGHT);
        await clock.tickAsync(59_000);
        remote.isOpen.should.be.true;

        // a tap restarts the idle timer
        await remote.tap(StreamButton.RIGHT);
        await clock.tickAsync(59_000);
        sessions[0].isClosed.should.be.false;

        await clock.tickAsync(1_000);
        sessions[0].isClosed.should.be.true;
        remote.isOpen.should.be.false;

        await remote.tap(StreamButton.PS);
        sessions.should.have.length(2);
        sessions[1].taps.should.deep.equal([StreamButton.PS]);
    });

    it("opens a new session after the console closes one", async () => {
        await remote.tap(StreamButton.RIGHT);
        sessions[0].closedBy("Server shutting down");
        await clock.tickAsync(0);
        remote.isOpen.should.be.false;

        await remote.tap(StreamButton.LEFT);
        sessions.should.have.length(2);
        sessions[1].taps.should.deep.equal([StreamButton.LEFT]);
    });

    it("reopens a session whose stream is no longer connected", async () => {
        await remote.tap(StreamButton.RIGHT);

        // the stream is down, but `closed` has not resolved yet
        sessions[0].isClosed = true;

        await remote.tap(StreamButton.LEFT);
        sessions.should.have.length(2);
        sessions[1].taps.should.deep.equal([StreamButton.LEFT]);
    });

    it("ignores an old session closing after a new one opened", async () => {
        await remote.tap(StreamButton.RIGHT);
        sessions[0].isClosed = true;
        await remote.tap(StreamButton.LEFT);

        sessions[0].closedBy("late");
        await clock.tickAsync(0);
        remote.isOpen.should.be.true;

        await remote.tap(StreamButton.UP);
        sessions.should.have.length(2);
    });

    it("reports a failed open and retries on the next tap", async () => {
        failNextOpen = true;
        await remote.tap(StreamButton.RIGHT)
            .should.be.rejectedWith("console is in rest mode");
        remote.isOpen.should.be.false;

        await remote.tap(StreamButton.RIGHT);
        sessions.should.have.length(1);
        sessions[0].taps.should.deep.equal([StreamButton.RIGHT]);
    });

    it("gives up on an open that never finishes", async () => {
        let resolveHung!: (session: FakeSession) => void;
        hangNextOpen = new Promise(resolve => {
            resolveHung = resolve;
        });

        const tap = remote.tap(StreamButton.RIGHT);
        const rejected = tap.should.be.rejectedWith("Timed out opening");
        await clock.tickAsync(30_000);
        await rejected;

        // the queue moves on
        await remote.tap(StreamButton.LEFT);
        sessions.should.have.length(1);
        sessions[0].taps.should.deep.equal([StreamButton.LEFT]);

        // a session that opens after we gave up is closed
        const late = new FakeSession();
        resolveHung(late);
        await clock.tickAsync(0);
        late.isClosed.should.be.true;
        late.taps.should.be.empty;
    });

    it("does not open a second session while the idle close is running", async () => {
        await remote.tap(StreamButton.RIGHT);

        let finishClose!: () => void;
        sessions[0].closeGate = new Promise(resolve => {
            finishClose = resolve;
        });

        await clock.tickAsync(60_000);
        sessions[0].closeStarted.should.be.true;

        const tap = remote.tap(StreamButton.LEFT);
        await clock.tickAsync(0);
        sessions.should.have.length(1);

        finishClose();
        await tap;
        sessions.should.have.length(2);
        sessions[1].taps.should.deep.equal([StreamButton.LEFT]);
    });

    it("keeps a connected session when a tap fails", async () => {
        await remote.tap(StreamButton.RIGHT);
        sessions[0].tap = async () => {
            throw new Error("bad hold");
        };

        await remote.tap(StreamButton.LEFT).should.be.rejectedWith("bad hold");
        remote.isOpen.should.be.true;
        sessions.should.have.length(1);
    });

    it("drops the session when a tap fails on a dead stream", async () => {
        await remote.tap(StreamButton.RIGHT);
        const [session] = sessions;
        session.tap = async () => {
            session.isClosed = true;
            throw new Error("Stream is not connected");
        };

        await remote.tap(StreamButton.LEFT).should.be.rejectedWith("not connected");
        remote.isOpen.should.be.false;
    });

    it("close() closes the open session", async () => {
        await remote.tap(StreamButton.RIGHT);
        await remote.close();
        sessions[0].isClosed.should.be.true;
        remote.isOpen.should.be.false;
        clock.countTimers().should.equal(0);
    });

    it("rejects taps after close()", async () => {
        await remote.tap(StreamButton.RIGHT);
        await remote.close();

        await remote.tap(StreamButton.LEFT)
            .should.be.rejectedWith("StreamRemote is closed");
        sessions.should.have.length(1);
        remote.isOpen.should.be.false;
    });

    it("rejects taps still queued when close() is called", async () => {
        const tap = remote.tap(StreamButton.RIGHT);
        const closing = remote.close();

        await tap.should.be.rejectedWith("StreamRemote is closed");
        await closing;
        sessions.should.be.empty;
    });

    it("waits between taps", async () => {
        await remote.close();
        remote = createRemote({ tapGapMillis: 50 });

        const taps = Promise.all([
            remote.tap(StreamButton.RIGHT),
            remote.tap(StreamButton.RIGHT),
        ]);
        await clock.tickAsync(50);
        await taps;

        const [first, second] = sessions[0].tapTimes;
        (second - first).should.equal(50);
    });

    it("rejects invalid timeouts", () => {
        const bad = [NaN, Infinity, -1, 0, 2 ** 31];
        for (const idleTimeoutMillis of bad) {
            (() => createRemote({ idleTimeoutMillis }))
                .should.throw(RangeError, "idleTimeoutMillis");
        }

        (() => createRemote({ openTimeoutMillis: 0 }))
            .should.throw(RangeError, "openTimeoutMillis");
        (() => createRemote({ tapGapMillis: -1 }))
            .should.throw(RangeError, "tapGapMillis");
        (() => createRemote({ tapGapMillis: 0 })).should.not.throw();
    });
});
