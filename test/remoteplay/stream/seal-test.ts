import * as chai from "chai";

import { StreamCryptoContext } from "../../../src/remoteplay/stream/crypto";
import {
    BaseType,
    CONGESTION_KEY_POS_OFFSET,
    CONGESTION_MAC_OFFSET,
    CONGESTION_SIZE,
    CONTROL_HEADER_SIZE,
    CONTROL_KEY_POS_OFFSET,
    CONTROL_MAC_OFFSET,
    FEEDBACK_KEY_POS_OFFSET,
    FEEDBACK_MAC_OFFSET,
} from "../../../src/remoteplay/stream/packets";
import {
    sealCongestion,
    sealControlPacket,
    sealFeedback,
} from "../../../src/remoteplay/stream/seal";

chai.should();

const context = new StreamCryptoContext(Buffer.alloc(16, 1), Buffer.alloc(16, 2));
const WRAPPED_KEY_POS = BigInt("0x100001234");

function filled(size: number) {
    return Buffer.alloc(size, 0xaa);
}

describe("Remote Play stream sealing", () => {
    describe("before BANG", () => {
        it("zeroes the MAC and KP of a control packet", () => {
            const sealed = sealControlPacket(
                undefined, BigInt(100), filled(CONTROL_HEADER_SIZE),
            );
            sealed.slice(CONTROL_MAC_OFFSET, CONTROL_MAC_OFFSET + 4)
                .should.deep.equal(Buffer.alloc(4));
            sealed.slice(CONTROL_KEY_POS_OFFSET, CONTROL_KEY_POS_OFFSET + 4)
                .should.deep.equal(Buffer.alloc(4));
        });

        it("zeroes the MAC and KP of a congestion packet", () => {
            const sealed = sealCongestion(
                undefined, BigInt(100), filled(CONGESTION_SIZE),
            );
            sealed.slice(CONGESTION_MAC_OFFSET, CONGESTION_MAC_OFFSET + 4)
                .should.deep.equal(Buffer.alloc(4));
            sealed.slice(CONGESTION_KEY_POS_OFFSET, CONGESTION_KEY_POS_OFFSET + 4)
                .should.deep.equal(Buffer.alloc(4));
        });
    });

    describe("key positions above 2^32", () => {
        it("writes the low 32 bits of a control packet KP", () => {
            const sealed = sealControlPacket(
                context, WRAPPED_KEY_POS, filled(CONTROL_HEADER_SIZE),
            );
            sealed.readUInt32BE(CONTROL_KEY_POS_OFFSET).should.equal(0x1234);
        });

        it("MACs a control packet with the full key position", () => {
            const sealed = sealControlPacket(
                context, WRAPPED_KEY_POS, filled(CONTROL_HEADER_SIZE),
            );
            const zeroed = filled(CONTROL_HEADER_SIZE);
            zeroed.fill(0, CONTROL_MAC_OFFSET, CONTROL_MAC_OFFSET + 4);
            zeroed.fill(0, CONTROL_KEY_POS_OFFSET, CONTROL_KEY_POS_OFFSET + 4);
            sealed.slice(CONTROL_MAC_OFFSET, CONTROL_MAC_OFFSET + 4)
                .should.deep.equal(context.mac(WRAPPED_KEY_POS, zeroed));
        });

        it("writes the low 32 bits of a congestion packet KP", () => {
            const sealed = sealCongestion(
                context, WRAPPED_KEY_POS, filled(CONGESTION_SIZE),
            );
            sealed.readUInt32BE(CONGESTION_KEY_POS_OFFSET).should.equal(0x1234);
        });

        it("writes the low 32 bits of a feedback KP and encrypts at the full one", () => {
            const payload = Buffer.from("hello feedback");
            const sealed = sealFeedback(
                context,
                WRAPPED_KEY_POS,
                { baseType: BaseType.FeedbackState, sequence: 1, itemCount: 1 },
                payload,
            );
            sealed.readUInt32BE(FEEDBACK_KEY_POS_OFFSET).should.equal(0x1234);
            context.encrypt(
                WRAPPED_KEY_POS + BigInt(16), sealed.slice(FEEDBACK_MAC_OFFSET + 4),
            ).should.deep.equal(payload);
        });
    });
});
