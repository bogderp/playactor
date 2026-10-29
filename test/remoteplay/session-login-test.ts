import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import net from "net";
import { Duplex } from "stream";
import sinon from "sinon";

import { DeviceType } from "../../src/discovery/model";
import { RemotePlayCommand as Command } from "../../src/remoteplay/packets";
import { RemotePlayPacketCodec } from "../../src/remoteplay/codec";
import { pickCryptoStrategyForDevice } from "../../src/remoteplay/crypto";
import * as protocol from "../../src/remoteplay/protocol";
import { openSessionWithInfo } from "../../src/remoteplay/session";
import { TcpDeviceSocket } from "../../src/socket/tcp";
import * as asyncUtil from "../../src/util/async";
import { fakeRemotePlayCredentials, fakeRemotePlayDevice } from "./util";

chai.use(chaiAsPromised);
chai.should();

/** A control connection whose console never answers the login */
class SilentControlSocket extends Duplex {
    public written: Buffer[] = [];

    // eslint-disable-next-line no-underscore-dangle
    public _read() { /* supplied by the test */ }

    // eslint-disable-next-line no-underscore-dangle
    public _write(data: Buffer, _encoding: BufferEncoding, callback: () => void) {
        this.written.push(Buffer.from(data));
        callback();
    }

    public setTimeout() { return this; }

    public ref() { return this; }

    public unref() { return this; }
}

function setUpConsole() {
    const device = fakeRemotePlayDevice(DeviceType.PS5);
    const credentials = fakeRemotePlayCredentials();
    const nonce = Buffer.alloc(16, 0x42);

    sinon.stub(protocol, "request").resolves({
        headers: { "rp-nonce": nonce.toString("base64") },
    } as any);
    sinon.stub(asyncUtil, "delayMillis").resolves();

    const serverCodec = new RemotePlayPacketCodec(
        pickCryptoStrategyForDevice(device),
        credentials,
        nonce,
    );
    const serverType = Buffer.alloc(16);
    serverType[0] = 2;

    const stream = new SilentControlSocket();
    sinon.stub(net, "createConnection").callsFake(() => {
        setImmediate(() => {
            stream.emit("connect");
            stream.push(Buffer.from(
                "HTTP/1.1 200 OK\r\n"
                + `RP-Server-Type: ${serverCodec.encodeBuffer(serverType).toString("base64")}\r\n\r\n`,
            ));
        });
        return stream as unknown as net.Socket;
    });

    return { device, credentials, stream };
}

describe("RemotePlay session login", () => {
    afterEach(() => sinon.restore());

    it("closes the control socket when the login is rejected (R2)", async () => {
        const { device, credentials, stream } = setUpConsole();
        sinon.stub(TcpDeviceSocket.prototype, "execute").rejects(new Error("passcode needed"));

        await openSessionWithInfo(device, {}, credentials)
            .should.be.rejectedWith("passcode needed");
        stream.destroyed.should.be.true;
    });

    it("gives up and closes the socket if the console never answers the login (R2)", async () => {
        const { device, credentials, stream } = setUpConsole();

        await openSessionWithInfo(device, {}, credentials, { loginTimeoutMillis: 50 })
            .should.be.rejectedWith(/Timed out waiting for the login/);
        stream.destroyed.should.be.true;
        stream.written.some(d => d.length === 8 && d.readUInt16BE(4) === Command.Login)
            .should.be.true;
    });
});
