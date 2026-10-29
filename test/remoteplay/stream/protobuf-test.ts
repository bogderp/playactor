import * as chai from "chai";

import { decodeTakionMessage } from "../../../src/remoteplay/stream/messages";
import { decodeFields, ProtoMessage } from "../../../src/remoteplay/stream/protobuf";

chai.should();
const { expect } = chai;

function bytes(...values: number[]) {
    return Buffer.from(values);
}

describe("Remote Play stream protobuf reader", () => {
    describe("hostile input", () => {
        it("rejects a truncated varint", () => {
            expect(() => decodeFields(bytes(0x08, 0x80))).to.throw(/Truncated/);
        });

        it("rejects a truncated length-delimited field", () => {
            expect(() => decodeFields(bytes(0x12, 0x05, 0x01, 0x02))).to.throw(/Truncated/);
        });

        it("rejects a huge length without allocating", () => {
            const huge = bytes(
                0x12, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
            );
            expect(() => decodeFields(huge)).to.throw(/Truncated/);
        });

        it("rejects a varint longer than 10 bytes", () => {
            const long = Buffer.concat([
                bytes(0x08),
                Buffer.alloc(10, 0x80),
                bytes(0x01),
            ]);
            expect(() => decodeFields(long)).to.throw(/too long/);
        });

        it("rejects a field key above 32 bits", () => {
            // would alias onto field 1 if truncated to 32 bits
            expect(() => decodeFields(bytes(0x88, 0x80, 0x80, 0x80, 0x80, 0x10, 0x01)))
                .to.throw(/field key/);
        });

        it("rejects field number 0", () => {
            expect(() => decodeFields(bytes(0x00, 0x01))).to.throw(/field number 0/);
        });

        it("rejects a truncated fixed32 field", () => {
            expect(() => decodeFields(bytes(0x0d, 0x01, 0x02))).to.throw(/Truncated/);
        });
    });

    describe("groups", () => {
        it("skips an unknown group", () => {
            // field 5 start-group, varint field 1, end-group, then field 2 = 7
            const fields = decodeFields(bytes(0x2b, 0x08, 0x01, 0x2c, 0x10, 0x07));
            fields.map(f => f.field).should.deep.equal([2]);
            fields[0].int!.should.equal(BigInt(7));
        });

        it("skips nested groups", () => {
            // 5 { 6 { 1: 1 } 2: 2 } then 3 = 9
            const fields = decodeFields(bytes(
                0x2b, 0x33, 0x08, 0x01, 0x34, 0x10, 0x02, 0x2c, 0x18, 0x09,
            ));
            fields.map(f => f.field).should.deep.equal([3]);
        });

        it("skips length-delimited data inside a group", () => {
            // the 0x2c inside the bytes payload is not an end-group
            const fields = decodeFields(bytes(
                0x2b, 0x12, 0x01, 0x2c, 0x2c, 0x18, 0x09,
            ));
            fields.map(f => f.field).should.deep.equal([3]);
        });

        it("rejects an unterminated group", () => {
            expect(() => decodeFields(bytes(0x2b, 0x08, 0x01))).to.throw(/Truncated/);
        });

        it("rejects a mismatched end-group", () => {
            expect(() => decodeFields(bytes(0x2b, 0x34))).to.throw(/end-group/);
        });

        it("rejects a stray end-group", () => {
            expect(() => decodeFields(bytes(0x2c))).to.throw(/end-group/);
        });
    });

    describe("ProtoMessage", () => {
        it("lets the last occurrence win", () => {
            ProtoMessage.decode(bytes(0x08, 0x01, 0x08, 0x02))
                .number(1)!.should.equal(2);
        });
    });

    describe("decodeTakionMessage", () => {
        it("rejects a message without a type", () => {
            expect(() => decodeTakionMessage(bytes(0x12, 0x00)))
                .to.throw(/without a type/);
        });

        it("rejects an empty message", () => {
            expect(() => decodeTakionMessage(Buffer.alloc(0)))
                .to.throw(/without a type/);
        });
    });
});
