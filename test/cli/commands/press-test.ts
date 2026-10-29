import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { ExpectedError } from "clime";
import sinon from "sinon";
import sinonChai from "sinon-chai";

import PressCommand, { PressOptions } from "../../../src/cli/commands/press";
import { IDevice } from "../../../src/device/model";
import { DeviceStatus, DeviceType, IDiscoveredDevice } from "../../../src/discovery/model";
import * as session from "../../../src/remoteplay/session";

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
});
