import * as chai from "chai";
import net from "net";
import { Duplex } from "stream";
import sinon from "sinon";

import { RemotePlayDeviceConnection } from "../../src/connection/remoteplay";
import { IRemotePlayCredentials } from "../../src/credentials/model";
import { ConnectionIntent } from "../../src/device/model";
import { DeviceType, IDiscoveredDevice } from "../../src/discovery/model";
import { RemotePlayPacketCodec } from "../../src/remoteplay/codec";
import { pickCryptoStrategyForDevice } from "../../src/remoteplay/crypto";
import { RemotePlayCommand } from "../../src/remoteplay/packets";
import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";

chai.should();

const REGIST_KEY = "00112233445566778899aabbccddeeff";

/**
 * A control socket for a console that never answers the login request,
 * like a PS5 showing the "not turned off properly" dialog.
 */
class SilentControlSocket extends Duplex {
    public readonly written: Buffer[] = [];

    public get commands() {
        return this.written
            .filter(data => !data.toString("latin1").startsWith("GET "))
            .filter(data => data.length >= 8)
            .map(data => data.readUInt16BE(4));
    }

    // eslint-disable-next-line no-underscore-dangle
    public _read() {
        // the console pushes data from the test
    }

    // eslint-disable-next-line no-underscore-dangle
    public _write(
        data: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ) {
        this.written.push(Buffer.from(data));
        callback();

        if (data.readUInt16BE(4) === RemotePlayCommand.Standby) {
            // the console closes the connection as it goes to rest
            setImmediate(() => this.push(null));
        }
    }

    public setTimeout() {
        return this;
    }

    public ref() {
        return this;
    }

    public unref() {
        return this;
    }
}

describe("Remote Play session", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("sends Standby without logging in", async () => {
        const device = {
            type: DeviceType.PS5,
            systemVersion: "14100003",
            address: { address: "127.0.0.1", port: 9295, family: "IPv4" },
        } as IDiscoveredDevice;
        const creds = {
            registration: { "PS5-RegistKey": REGIST_KEY, "RP-Key": REGIST_KEY },
        } as unknown as IRemotePlayCredentials;

        const nonce = Buffer.alloc(16, 0x42);
        const serverCodec = new RemotePlayPacketCodec(
            pickCryptoStrategyForDevice(device),
            creds,
            nonce,
        );
        const serverType = serverCodec.encodeBuffer(Buffer.alloc(16, 0));
        const socket = new SilentControlSocket();

        sinon.stub(protocol, "request").resolves({
            headers: { "rp-nonce": nonce.toString("base64") },
        } as any);
        sinon.stub(net, "createConnection").callsFake(() => {
            setImmediate(() => {
                socket.emit("connect");
                socket.push(Buffer.from(
                    "HTTP/1.1 200 OK\r\n"
                    + `RP-Server-Type: ${serverType.toString("base64")}\r\n\r\n`,
                ));
            });
            return socket as unknown as net.Socket;
        });

        const session = await openSession(device, {
            intent: ConnectionIntent.STANDBY,
        }, creds);
        await new RemotePlayDeviceConnection(session).standby();

        socket.commands.should.deep.equal([RemotePlayCommand.Standby]);
    });
});
