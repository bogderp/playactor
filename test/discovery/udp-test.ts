import * as chai from "chai";

import { DiscoveryVersions } from "../../src/discovery/model";
import { UdpDiscoveryNetworkFactory } from "../../src/discovery/udp";

chai.should();

describe("UdpDiscoveryNetworkFactory", () => {
    it("removes its message listener when a network closes", () => {
        const factory = new UdpDiscoveryNetworkFactory(9302, DiscoveryVersions.PS5);
        const config = { localBindPort: 0 };

        // keep the shared socket open while other networks come and go
        const anchor = factory.createRawMessages(config, () => {});
        const { socket } = anchor as any;
        const baseline = socket.listenerCount("message");

        for (let i = 0; i < 20; ++i) {
            factory.createRawMessages(config, () => {}).close();
        }

        socket.listenerCount("message").should.equal(baseline);
        anchor.close();
    });
});
