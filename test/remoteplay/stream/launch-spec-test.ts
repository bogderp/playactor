import * as chai from "chai";

import {
    defaultLaunchSpecOptions,
    formatLaunchSpec,
    ILaunchSpecOptions,
} from "../../../src/remoteplay/stream/launch-spec";

chai.should();
const { expect } = chai;

const key = Buffer.alloc(16, 7);

function build(overrides: Partial<ILaunchSpecOptions>) {
    return () => formatLaunchSpec(key, { ...defaultLaunchSpecOptions, ...overrides });
}

describe("Remote Play launch spec options", () => {
    it("accepts the defaults", () => {
        build({})().should.contain("\"videoCodec\":\"avc\"");
    });

    it("accepts HDR with HEVC", () => {
        build({ codec: "hevc", dynamicRange: "HDR" })()
            .should.contain("\"dynamicRange\":\"HDR\"");
    });

    it("rejects HDR with AVC", () => {
        expect(build({ dynamicRange: "HDR" })).to.throw(/HDR/);
    });

    it("rejects an unknown codec", () => {
        expect(build({ codec: "vp9" as any })).to.throw(/codec/);
    });

    it("rejects an unknown dynamic range", () => {
        expect(build({ dynamicRange: "DV" as any })).to.throw(/dynamic range/);
    });

    for (const field of ["width", "height", "maxFps", "bitrateKbps", "mtu", "rttMillis"]) {
        it(`rejects a negative ${field}`, () => {
            expect(build({ [field]: -1 })).to.throw(/positive integer/);
        });
        it(`rejects a zero ${field}`, () => {
            expect(build({ [field]: 0 })).to.throw(/positive integer/);
        });
        it(`rejects a fractional ${field}`, () => {
            expect(build({ [field]: 1.5 })).to.throw(/positive integer/);
        });
    }
});
