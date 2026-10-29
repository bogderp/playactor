import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { ExpectedError } from "clime";
import sinon from "sinon";
import sinonChai from "sinon-chai";

import PressCommand, { PressOptions } from "../../../src/cli/commands/press";
import { IDevice } from "../../../src/device/model";
import { DeviceStatus, DeviceType, IDiscoveredDevice } from "../../../src/discovery/model";
import { DiskCredentialsStorage } from "../../../src/credentials/disk-storage";
import * as session from "../../../src/remoteplay/session";
import * as streamSession from "../../../src/remoteplay/stream/session";
import { fakeRemotePlayCredentials } from "../../remoteplay/util";

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.should();

function fakeDevice(status: DeviceStatus) {
    const discovered = {
        type: DeviceType.PS5,
        status,
        name: "PS5-123",
        id: "ID",
        address: { address: "127.0.0.1", port: 9302, family: "IPv4" },
    } as IDiscoveredDevice;

    return {
        discover: sinon.stub().resolves(discovered),
        wake: sinon.stub().rejects(new Error("must not wake")),
        openConnection: sinon.stub().rejects(new Error("must not open a connection")),
    };
}

function fakeStreamSession() {
    return {
        stream: {},
        closed: new Promise<string>(() => { /* never */ }),
        tap: sinon.stub().callsFake(async (button: string) => ({
            button,
            pressedAt: Date.now(),
            releasedAt: Date.now() + 50,
        })),
        close: sinon.stub().resolves(),
    };
}

/** Stub everything `press` needs to reach the stream session */
function setUpAwakeConsole() {
    const options = new PressOptions();
    sinon.stub(options, "findDevice")
        .resolves(fakeDevice(DeviceStatus.AWAKE) as unknown as IDevice);
    sinon.stub(options, "logResult");
    const logInfo = sinon.stub(options, "logInfo");
    sinon.stub(DiskCredentialsStorage.prototype, "read").resolves(fakeRemotePlayCredentials());

    const fakeSession = fakeStreamSession();
    const open = sinon.stub(streamSession, "openStreamSession").resolves(fakeSession as any);
    return {
        options, logInfo, fakeSession, open,
    };
}

describe("press command", () => {
    afterEach(() => sinon.restore());

    it("doesn't wake or connect to a console in rest mode", async () => {
        const device = fakeDevice(DeviceStatus.STANDBY);
        const options = new PressOptions();
        sinon.stub(options, "findDevice").resolves(device as unknown as IDevice);
        const openSession = sinon.stub(session, "openSessionWithInfo")
            .rejects(new Error("must not log in"));

        await new PressCommand().execute(["ps"], options)
            .should.be.rejectedWith(ExpectedError, /rest mode/);

        device.wake.should.not.have.been.called;
        device.openConnection.should.not.have.been.called;
        openSession.should.not.have.been.called;
    });

    it("rejects unknown buttons before looking for the device", async () => {
        const options = new PressOptions();
        const find = sinon.stub(options, "findDevice");
        await new PressCommand().execute(["select"], options)
            .should.be.rejectedWith(ExpectedError, /Unknown button/);
        find.should.not.have.been.called;
    });

    it("rejects names from Object.prototype as buttons (N1)", async () => {
        const options = new PressOptions();
        const find = sinon.stub(options, "findDevice");
        await new PressCommand().execute(["constructor"], options)
            .should.be.rejectedWith(ExpectedError, /Unknown button/);
        find.should.not.have.been.called;
    });

    for (const controller of ["toString", "constructor", "dualsense", "mobile", "nope"]) {
        it(`rejects the controller type ${controller}`, async () => {
            const options = new PressOptions();
            options.controller = controller;
            const find = sinon.stub(options, "findDevice");
            await new PressCommand().execute(["ps"], options)
                .should.be.rejectedWith(ExpectedError, /Unknown controller/);
            find.should.not.have.been.called;
        });
    }

    for (const bad of [NaN, Infinity, -1, 2 ** 31]) {
        it(`rejects --hold ${bad} and --gap ${bad} (N2)`, async () => {
            const hold = new PressOptions();
            hold.holdMillis = bad;
            await new PressCommand().execute(["ps"], hold)
                .should.be.rejectedWith(ExpectedError, /--hold/);

            const gap = new PressOptions();
            gap.gapMillis = bad;
            await new PressCommand().execute(["ps"], gap)
                .should.be.rejectedWith(ExpectedError, /--gap/);
        });
    }

    it("warns about a short --hold (N2)", async () => {
        const { options, logInfo, fakeSession } = setUpAwakeConsole();
        options.holdMillis = 10;
        await new PressCommand().execute(["ps"], options);
        logInfo.should.have.been.calledWithMatch(/--hold/);
        fakeSession.tap.should.have.been.calledWith("ps", 10);
    });

    it("taps each button and closes the session", async () => {
        const { options, fakeSession } = setUpAwakeConsole();
        options.gapMillis = 0;
        await new PressCommand().execute(["up", "x"], options);
        fakeSession.tap.args.map(a => a[0]).should.deep.equal(["up", "cross"]);
        fakeSession.close.should.have.been.calledOnce;
    });

    it("doesn't mask a press error with a close error (N4)", async () => {
        const { options, logInfo, fakeSession } = setUpAwakeConsole();
        fakeSession.tap.rejects(new Error("press failed"));
        fakeSession.close.rejects(new Error("close failed"));

        await new PressCommand().execute(["ps"], options)
            .should.be.rejectedWith("press failed");
        logInfo.should.have.been.calledWithMatch(/close failed/);
    });

    it("closes the session on SIGINT and then exits (N4)", async () => {
        const { options, fakeSession } = setUpAwakeConsole();
        fakeSession.tap.returns(new Promise(() => { /* a press that never finishes */ }));
        const exit = sinon.stub(process, "exit");
        const before = process.listeners("SIGINT");
        const beforeTerm = process.listeners("SIGTERM");

        // leaves the command hanging on purpose
        new PressCommand().execute(["ps"], options).catch(() => { /* ignored */ });
        await new Promise(resolve => setTimeout(resolve, 20));

        const added = process.listeners("SIGINT").filter(l => !before.includes(l));
        added.should.have.length(1);
        (added[0] as () => void)();
        await new Promise(resolve => setTimeout(resolve, 10));

        fakeSession.close.should.have.been.calledOnce;
        exit.should.have.been.calledWith(130);
        process.removeListener("SIGINT", added[0]);
        for (const l of process.listeners("SIGTERM").filter(x => !beforeTerm.includes(x))) {
            process.removeListener("SIGTERM", l as () => void);
        }
    });
});
