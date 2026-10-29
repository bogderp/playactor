import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import * as FakeTimers from "@sinonjs/fake-timers";

import { IRemotePlayCredentials } from "../../../src/credentials/model";
import { IDiscoveredDevice } from "../../../src/discovery/model";
import { StreamButton } from "../../../src/remoteplay/stream/input";
import { StreamRemote } from "../../../src/remoteplay/stream/remote";
import { IStreamSession } from "../../../src/remoteplay/stream/session";
import { RemotePlayStream } from "../../../src/remoteplay/stream/stream";

chai.use(chaiAsPromised);
chai.should();

class FakeSession implements IStreamSession {
    public readonly stream = {} as RemotePlayStream;
    public readonly closed: Promise<string>;
    public taps: StreamButton[] = [];
    public isClosed = false;

    private resolveClosed!: (reason: string) => void;

    constructor() {
        this.closed = new Promise(resolve => {
            this.resolveClosed = resolve;
        });
    }

    public async tap(button: StreamButton) {
        if (this.isClosed) throw new Error("Stream closed");
        this.taps.push(button);
        return { button, pressedAt: 0, releasedAt: 0 };
    }

    public async close() {
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
    let remote: StreamRemote;

    beforeEach(() => {
        clock = FakeTimers.install();
        sessions = [];
        failNextOpen = false;
        remote = new StreamRemote(
            {} as IDiscoveredDevice,
            {},
            {} as IRemotePlayCredentials,
            {
                idleTimeoutMillis: 60_000,
                async openSession() {
                    if (failNextOpen) {
                        failNextOpen = false;
                        throw new Error("console is in rest mode");
                    }
                    const session = new FakeSession();
                    sessions.push(session);
                    return session;
                },
            },
        );
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

    it("reports a failed open and retries on the next tap", async () => {
        failNextOpen = true;
        await remote.tap(StreamButton.RIGHT)
            .should.be.rejectedWith("console is in rest mode");
        remote.isOpen.should.be.false;

        await remote.tap(StreamButton.RIGHT);
        sessions.should.have.length(1);
        sessions[0].taps.should.deep.equal([StreamButton.RIGHT]);
    });

    it("close() closes the open session", async () => {
        await remote.tap(StreamButton.RIGHT);
        await remote.close();
        sessions[0].isClosed.should.be.true;
        remote.isOpen.should.be.false;
    });
});
