import * as chai from "chai";

import { StreamHandshakeError, validateBang } from "../../../src/remoteplay/stream/handshake";
import { V1 } from "./vectors";

chai.should();
const { expect } = chai;

const good = {
    encryptedKeyAccepted: true,
    versionAccepted: true,
    ecdhPublicKey: V1.remotePublicKey,
    ecdhSignature: V1.remoteSignature,
};

describe("Remote Play stream handshake", () => {
    describe("validateBang", () => {
        it("accepts a correctly signed BANG", () => {
            const result = validateBang(good, V1.handshakeKey);
            result.signatureValid.should.equal(true);
            result.publicKey.should.deep.equal(V1.remotePublicKey);
        });

        it("rejects when the key was not accepted", () => {
            expect(() => validateBang(
                { ...good, encryptedKeyAccepted: false }, V1.handshakeKey,
            )).to.throw(StreamHandshakeError, /rejected BIG/);
        });

        it("rejects when the version was not accepted", () => {
            expect(() => validateBang(
                { ...good, versionAccepted: false }, V1.handshakeKey,
            )).to.throw(StreamHandshakeError, /rejected BIG/);
        });

        it("rejects a missing console key", () => {
            expect(() => validateBang(
                { ...good, ecdhPublicKey: undefined }, V1.handshakeKey,
            )).to.throw(StreamHandshakeError, /missing the console key/);
        });

        it("rejects a missing signature", () => {
            expect(() => validateBang(
                { ...good, ecdhSignature: undefined }, V1.handshakeKey,
            )).to.throw(StreamHandshakeError, /missing the console key/);
        });

        it("reports a bad signature without throwing", () => {
            const bad = Buffer.from(V1.remoteSignature);
            bad[0] = bad[0] === 0 ? 1 : 0;
            validateBang({ ...good, ecdhSignature: bad }, V1.handshakeKey)
                .signatureValid.should.equal(false);
        });

        it("reports a wrong-length signature without throwing", () => {
            validateBang(
                { ...good, ecdhSignature: V1.remoteSignature.slice(0, 16) },
                V1.handshakeKey,
            ).signatureValid.should.equal(false);
        });
    });
});
