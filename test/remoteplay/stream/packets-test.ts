import * as chai from "chai";

import { DeviceType, IDiscoveredDevice } from "../../../src/discovery/model";
import { pickCryptoStrategyForDevice } from "../../../src/remoteplay/crypto";
import { RemotePlayResponseType } from "../../../src/remoteplay/packets";
import { fallbackSessionId, parseSessionIdPacket } from "../../../src/remoteplay/session-id";
import { StreamCryptoContext } from "../../../src/remoteplay/stream/crypto";
import {
    compressQuaternion,
    encodeButtonEvent,
    encodeControllerState,
    encodeTriggerEvent,
    HistoryEventBuffer,
    IDLE_CONTROLLER_STATE,
    parseStreamButton,
    StreamButton,
} from "../../../src/remoteplay/stream/input";
import {
    authKeyStream,
    encodeLaunchSpec,
    formatLaunchSpec,
} from "../../../src/remoteplay/stream/launch-spec";
import {
    ControllerType,
    decodeAudioHeader,
    decodeTakionMessage,
    encodeAudioHeader,
    encodeBang,
    encodeBig,
    encodeClientStreamInfo,
    encodeControllerConnection,
    encodeDisconnect,
    encodeHeartbeat,
    encodeServerStreamInfo,
    encodeStreamInfoAck,
    PayloadType,
} from "../../../src/remoteplay/stream/messages";
import {
    BaseType,
    ChunkType,
    decodeCongestion,
    decodeControlPacket,
    decodeDataAckPayload,
    decodeDataPayload,
    decodeFeedback,
    decodeInitAckPayload,
    decodeInitPayload,
    decodeVideoHeader,
    encodeCongestion,
    encodeControlPacket,
    encodeCookie,
    encodeDataAckPayload,
    encodeDataPayload,
    encodeFeedback,
    encodeInit,
    encodeInitAckPayload,
    reconstructKeyPos,
    serialGreater,
} from "../../../src/remoteplay/stream/packets";
import {
    sealCongestion, sealControlPacket, sealFeedback,
} from "../../../src/remoteplay/stream/seal";
import { keyPosAdvance, planFragments } from "../../../src/remoteplay/stream/transport";
import { fakeRemotePlayCredentials } from "../util";
import {
    DERIVED, hex, V8, V9,
} from "./vectors";

chai.should();
const { expect } = chai;

function derivedContext() {
    return StreamCryptoContext.derive(DERIVED.secret, DERIVED.handshakeKey, DERIVED.index);
}

describe("Remote Play stream packets", () => {
    describe("V8: congestion datagram", () => {
        it("encodes the fields at the documented offsets", () => {
            const encoded = encodeCongestion({
                word0: V8.word0, received: V8.received, lost: V8.lost,
            });
            const expected = Buffer.from(V8.beforeMac);
            expected.fill(0, 11, 15); // KP is written by the sealing step
            encoded.should.deep.equal(expected);
        });

        it("matches the full chain after MAC", () => {
            const ctx = StreamCryptoContext.derive(V8.secret, V8.handshakeKey, V8.index);
            const datagram = encodeCongestion({
                word0: V8.word0, received: V8.received, lost: V8.lost,
            });
            sealCongestion(ctx, V8.keyPos, datagram).should.deep.equal(V8.afterMac);
        });

        it("decodes the literal datagram", () => {
            const decoded = decodeCongestion(V8.afterMac);
            decoded.word0.should.equal(0x42);
            decoded.received.should.equal(26);
            decoded.lost.should.equal(10);
            decoded.keyPos.should.equal(0x1E5);
            decoded.mac.should.deep.equal(hex("64 8a 7c 74"));
        });

        it("has MAC and KP zero before keys exist", () => {
            const datagram = encodeCongestion({ word0: 0, received: 3, lost: 0 });
            sealCongestion(undefined, BigInt(0), datagram)
                .should.deep.equal(hex("05 0000 0003 0000 00000000 00000000"));
        });
    });

    describe("V9: received video header", () => {
        it("parses the documented fields", () => {
            const header = decodeVideoHeader(V9.datagram);
            header.baseType.should.equal(BaseType.Video);
            header.packetIndex.should.equal(45);
            header.frameIndex.should.equal(5);
            header.unitIndex.should.equal(6);
            header.unitsInFrame.should.equal(8);
            header.fecUnits.should.equal(1);
            header.codec.should.equal(3);
            header.payloadOffset.should.equal(0x15);
            (V9.datagram.length - header.payloadOffset).should.equal(0x99);
        });
    });

    describe("7.8: inbound KP reconstruction", () => {
        it("follows the documented sequence", () => {
            const steps: [number, bigint][] = [
                [0, BigInt(0)],
                [0x1337, BigInt(0x1337)],
                [0xFFFF0000, BigInt(0xFFFF0000)],
                [0x1337, BigInt("0x100001337")],
                [0xFFFF1337, BigInt(0xFFFF1337)],
                [0x50000000, BigInt("0x150000000")],
                [0xB0000000, BigInt("0x1B0000000")],
                [0, BigInt("0x200000000")],
            ];

            let prev = BigInt(0);
            for (const [low, expected] of steps) {
                prev = reconstructKeyPos(prev, low);
                prev.should.equal(expected);
            }
        });

        it("compares TSNs with serial arithmetic", () => {
            serialGreater(1, 0).should.be.true;
            serialGreater(0, 0xFFFFFFFF).should.be.true;
            serialGreater(0xFFFFFFFF, 0).should.be.false;
            serialGreater(5, 5).should.be.false;
        });
    });

    describe("13.2: derived examples", () => {
        it("builds the HEARTBEAT DATA datagram", () => {
            const datagram = encodeControlPacket({
                tag: 0x11223344,
                mac: Buffer.alloc(4),
                keyPos: 0,
                chunkType: ChunkType.Data,
                chunkFlags: 1,
                payload: encodeDataPayload({
                    tsn: 0xAABBCCDD,
                    channel: 1,
                    dataType: 0,
                    data: encodeHeartbeat(),
                }),
            });
            sealControlPacket(derivedContext(), BigInt(0x40), datagram)
                .should.deep.equal(DERIVED.heartbeat);
        });

        it("builds the idle feedback state datagram", () => {
            sealFeedback(derivedContext(), BigInt(0x40), {
                baseType: BaseType.FeedbackState,
                sequence: 0,
                itemCount: 1,
            }, encodeControllerState()).should.deep.equal(DERIVED.idleState);
        });

        it("builds the D-pad up press history datagram", () => {
            sealFeedback(derivedContext(), BigInt(0x80), {
                baseType: BaseType.FeedbackHistory,
                sequence: 0,
                itemCount: 1,
            }, encodeButtonEvent(StreamButton.UP, true)).should.deep.equal(DERIVED.upPress);
        });

        it("builds the D-pad up release history datagram", () => {
            const history = new HistoryEventBuffer();
            history.push(encodeButtonEvent(StreamButton.UP, true));
            const { payload, count } = history.push(encodeButtonEvent(StreamButton.UP, false));
            payload.should.deep.equal(hex("80 80 00 80 80 FF"));

            sealFeedback(derivedContext(), BigInt(0xB0), {
                baseType: BaseType.FeedbackHistory,
                sequence: 1,
                itemCount: count,
            }, payload).should.deep.equal(DERIVED.upRelease);
        });

        it("decrypts the idle state datagram back to the payload", () => {
            const { header, payload } = decodeFeedback(DERIVED.idleState);
            header.keyPos.should.equal(0x40);
            derivedContext().encrypt(BigInt(0x40 + 16), payload)
                .should.deep.equal(encodeControllerState());
        });
    });

    describe("control packets", () => {
        it("decodes the literal HEARTBEAT datagram", () => {
            const packet = decodeControlPacket(DERIVED.heartbeat);
            expect(packet).to.not.be.undefined;
            packet!.tag.should.equal(0x11223344);
            packet!.mac.should.deep.equal(hex("ac936c89"));
            packet!.keyPos.should.equal(0x40);
            packet!.chunkType.should.equal(ChunkType.Data);
            packet!.chunkFlags.should.equal(1);

            const data = decodeDataPayload(packet!.payload);
            data.tsn.should.equal(0xAABBCCDD);
            data.channel.should.equal(1);
            data.dataType!.should.equal(0);
            data.data.should.deep.equal(hex("08 03"));

            encodeControlPacket(packet!).should.deep.equal(DERIVED.heartbeat);
        });

        it("rejects a datagram whose chunk length doesn't match", () => {
            const broken = Buffer.from(DERIVED.heartbeat);
            broken.writeUInt16BE(0x10, 15);
            expect(decodeControlPacket(broken)).to.be.undefined;
        });

        it("encodes INIT as documented (33 bytes)", () => {
            encodeInit(0x01020304).should.deep.equal(hex(`
                00 00000000 00000000 00000000 01 00 0014
                01020304 00019000 0064 0064 01020304
            `));
        });

        it("round-trips the INIT payload", () => {
            const init = {
                tag: 0xDEADBEEF,
                receiveWindow: 0x19000,
                outboundStreams: 100,
                inboundStreams: 100,
                initialTsn: 0xDEADBEEF,
            };
            decodeInitPayload(encodeInitAckPayload({
                ...init, cookie: Buffer.alloc(32),
            })).should.deep.equal(init);
        });

        it("decodes a literal INIT_ACK (65 bytes)", () => {
            const cookie = Buffer.alloc(32, 0xC0);
            const datagram = Buffer.concat([
                hex("00 01020304 00000000 00000000 02 00 0034"),
                hex("55667788 00019000 0064 0064 99AABBCC"),
                cookie,
            ]);
            datagram.length.should.equal(65);

            const packet = decodeControlPacket(datagram)!;
            packet.chunkType.should.equal(ChunkType.InitAck);
            const ack = decodeInitAckPayload(packet.payload);
            ack.tag.should.equal(0x55667788);
            ack.outboundStreams.should.equal(100);
            ack.inboundStreams.should.equal(100);
            ack.initialTsn.should.equal(0x99AABBCC);
            ack.cookie.should.deep.equal(cookie);
        });

        it("encodes COOKIE as documented (49 bytes)", () => {
            const cookie = Buffer.alloc(32, 0x5A);
            encodeCookie(0x55667788, cookie).should.deep.equal(Buffer.concat([
                hex("00 55667788 00000000 00000000 0A 00 0024"),
                cookie,
            ]));
        });

        it("decodes a literal COOKIE_ACK (17 bytes)", () => {
            const packet = decodeControlPacket(hex("00 01020304 00000000 00000000 0B 00 0004"))!;
            packet.chunkType.should.equal(ChunkType.CookieAck);
            packet.payload.length.should.equal(0);
        });

        it("encodes DATA_ACK as documented (29 bytes)", () => {
            const datagram = encodeControlPacket({
                tag: 0x55667788,
                mac: Buffer.alloc(4),
                keyPos: 0,
                chunkType: ChunkType.DataAck,
                chunkFlags: 0,
                payload: encodeDataAckPayload({
                    cumulativeTsn: 0x55667790,
                    receiveWindow: 0x19000,
                    gapAckBlocks: 0,
                    duplicateTsns: 0,
                }),
            });
            datagram.should.deep.equal(hex(`
                00 55667788 00000000 00000000 03 00 0010
                55667790 00019000 0000 0000
            `));
            decodeDataAckPayload(decodeControlPacket(datagram)!.payload).should.deep.equal({
                cumulativeTsn: 0x55667790,
                receiveWindow: 0x19000,
                gapAckBlocks: 0,
                duplicateTsns: 0,
            });
        });

        it("rejects a DATA_ACK payload that is too short", () => {
            expect(() => decodeDataAckPayload(Buffer.alloc(11))).to.throw();
        });

        it("reads the cumulative TSN of a DATA_ACK with trailing gap blocks", () => {
            const payload = Buffer.concat([
                encodeDataAckPayload({
                    cumulativeTsn: 0x55667790,
                    receiveWindow: 0x19000,
                    gapAckBlocks: 1,
                    duplicateTsns: 0,
                }),
                Buffer.from([0, 2, 0, 3]),
            ]);
            decodeDataAckPayload(payload).cumulativeTsn.should.equal(0x55667790);
        });

        it("encodes a continuation DATA fragment without a data type (25 + n)", () => {
            const data = Buffer.from("hello");
            const datagram = encodeControlPacket({
                tag: 1,
                mac: Buffer.alloc(4),
                keyPos: 0,
                chunkType: ChunkType.Data,
                chunkFlags: 0,
                payload: encodeDataPayload({ tsn: 7, channel: 1, data }),
            });
            datagram.length.should.equal(25 + data.length);
            datagram.readUInt16BE(15).should.equal(12 + data.length);
            datagram.slice(25).should.deep.equal(data);

            const decoded = decodeDataPayload(decodeControlPacket(datagram)!.payload, true);
            decoded.tsn.should.equal(7);
            expect(decoded.dataType).to.be.undefined;
            decoded.data.should.deep.equal(data);
        });

        it("encodes a whole DATA message (26 + n)", () => {
            const data = Buffer.from("hello");
            const datagram = encodeControlPacket({
                tag: 1,
                mac: Buffer.alloc(4),
                keyPos: 0,
                chunkType: ChunkType.Data,
                chunkFlags: 1,
                payload: encodeDataPayload({
                    tsn: 7, channel: 9, dataType: 0, data,
                }),
            });
            datagram.length.should.equal(26 + data.length);
            datagram.readUInt16BE(15).should.equal(13 + data.length);
        });
    });

    describe("feedback header", () => {
        it("round-trips", () => {
            const header = {
                baseType: BaseType.FeedbackHistory as const,
                sequence: 0xBEEF,
                itemCount: 2,
                keyPos: 0x12345678,
                mac: hex("01020304"),
            };
            const payload = hex("80 88 00 80 88 FF");
            const datagram = encodeFeedback(header, payload);
            datagram.length.should.equal(12 + payload.length);
            datagram.should.deep.equal(hex("01 BEEF 02 12345678 01020304 808800 8088FF"));

            const decoded = decodeFeedback(datagram);
            decoded.header.should.deep.equal(header);
            decoded.payload.should.deep.equal(payload);
        });
    });

    describe("fragmentation", () => {
        it("sends a short message as one fragment", () => {
            planFragments(100).should.deep.equal([
                {
                    offset: 0, length: 100, first: true, last: true,
                },
            ]);
        });

        it("splits a typical BIG into two datagrams within 1404 bytes", () => {
            const fragments = planFragments(1400);
            fragments.should.deep.equal([
                {
                    offset: 0, length: 1378, first: true, last: false,
                },
                {
                    offset: 1378, length: 22, first: false, last: true,
                },
            ]);
            (26 + fragments[0].length).should.equal(1404);
        });

        it("never lets a continuation consume the whole remainder", () => {
            const fragments = planFragments(1378 + 1379);
            fragments.length.should.equal(3);
            fragments[2].last.should.be.true;
            fragments[2].length.should.be.greaterThan(0);
            fragments.reduce((sum, f) => sum + f.length, 0).should.equal(1378 + 1379);
        });
    });

    describe("key position allocation", () => {
        it("matches the documented advances", () => {
            keyPosAdvance(29).should.equal(42);
            keyPosAdvance(15).should.equal(30);
            keyPosAdvance(2).should.equal(4);
            keyPosAdvance(44).should.equal(56);
            keyPosAdvance(19).should.equal(22);
            keyPosAdvance(22).should.equal(28);
        });
    });
});

describe("Remote Play stream messages", () => {
    it("encodes HEARTBEAT and STREAMINFOACK", () => {
        encodeHeartbeat().should.deep.equal(hex("08 03"));
        encodeStreamInfoAck().should.deep.equal(hex("08 0E"));
    });

    it("encodes CONTROLLERCONNECTION (DS4)", () => {
        encodeControllerConnection().should.deep.equal(hex("08 15 B2 01 04 10 01 18 02"));
        decodeTakionMessage(encodeControllerConnection()).controllerConnection!
            .should.deep.equal({
                controllerId: undefined,
                connected: true,
                controllerType: ControllerType.DUALSHOCK4,
            });
    });

    it("encodes the client STREAMINFO with the mic header", () => {
        const audio = encodeAudioHeader();
        audio.should.deep.equal(hex("01 10 00 00 BB 80 00 00 01 E0 00 00 00 01"));
        decodeAudioHeader(audio).should.deep.equal({
            channels: 1, bitsPerSample: 16, sampleRate: 48000, frameSize: 480, unknown: 1,
        });

        encodeClientStreamInfo(audio).should.deep.equal(Buffer.concat([
            hex("08 0D 7A 10 12 0E"),
            audio,
        ]));
    });

    it("encodes DISCONNECT (26 bytes)", () => {
        const encoded = encodeDisconnect();
        encoded.length.should.equal(26);
        encoded.should.deep.equal(Buffer.concat([
            hex("08 08 52 16 0A 14"),
            Buffer.from("Client Disconnecting"),
        ]));
        const decoded = decodeTakionMessage(encoded);
        decoded.type.should.equal(PayloadType.DISCONNECT);
        decoded.disconnectReason!.should.equal("Client Disconnecting");
    });

    it("encodes BIG with the type emitted first", () => {
        const big = {
            clientVersion: 12,
            sessionKey: "abc",
            launchSpec: "spec",
            encryptedKey: Buffer.alloc(4),
            ecdhPublicKey: Buffer.alloc(65, 4),
            ecdhSignature: Buffer.alloc(32, 9),
        };
        const encoded = encodeBig(big);
        const innerLength = 2 + 5 + 6 + 6 + 67 + 34;
        encoded.slice(0, 5).should.deep.equal(hex(`08 00 12 ${innerLength.toString(16)} 08`));
        encoded.slice(4, 4 + 2 + 5 + 6 + 6).should.deep.equal(hex(`
            08 0C
            12 03 616263
            1A 04 73706563
            22 04 00000000
        `));

        const decoded = decodeTakionMessage(encoded);
        decoded.type.should.equal(PayloadType.BIG);
        decoded.big!.should.deep.equal(big);
    });

    it("round-trips BANG", () => {
        const bang = {
            serverVersion: 12,
            encryptedKeyAccepted: true,
            versionAccepted: true,
            ecdhPublicKey: Buffer.alloc(65, 1),
            ecdhSignature: Buffer.alloc(32, 2),
        };
        const decoded = decodeTakionMessage(encodeBang(bang));
        decoded.type.should.equal(PayloadType.BANG);
        decoded.bang!.should.deep.equal(bang);
    });

    it("decodes a console STREAMINFO and skips unknown fields", () => {
        const encoded = Buffer.concat([
            encodeServerStreamInfo({
                resolutions: [
                    { width: 640, height: 360, videoHeader: Buffer.alloc(30, 1) },
                    { width: 1280, height: 720, videoHeader: Buffer.alloc(30, 2) },
                ],
                audioHeader: Buffer.alloc(14),
                startTimeout: 100,
                afkTimeout: 200,
            }),
            hex("A8 06 01"), // unknown top-level varint field 101
        ]);
        const decoded = decodeTakionMessage(encoded);
        decoded.type.should.equal(PayloadType.STREAMINFO);
        decoded.streamInfo!.resolutionCount.should.equal(2);
        decoded.streamInfo!.audioHeader!.length.should.equal(14);
        decoded.streamInfo!.startTimeout!.should.equal(100);
        decoded.streamInfo!.afkTimeout!.should.equal(200);
    });
});

describe("Remote Play stream input", () => {
    it("encodes the idle state as documented", () => {
        encodeControllerState(IDLE_CONTROLLER_STATE).should.deep.equal(hex(`
            A0 FF 7F FF 7F FF 7F FF 7F 99 99 FF 7F FE F7 EF 1F
            00 00 00 00 00 00 00 00 00 00 01
        `));
    });

    it("compresses a negative largest quaternion component", () => {
        // largest = x (index 0), negative: bit 0 set, index bits 0
        // eslint-disable-next-line no-bitwise
        (compressQuaternion({
            x: -1, y: 0, z: 0, w: 0,
        }) & 0x7).should.equal(1);
    });

    it("encodes button events from the table", () => {
        const table: [StreamButton, string, string][] = [
            [StreamButton.UP, "80 80 FF", "80 80 00"],
            [StreamButton.DOWN, "80 81 FF", "80 81 00"],
            [StreamButton.LEFT, "80 82 FF", "80 82 00"],
            [StreamButton.RIGHT, "80 83 FF", "80 83 00"],
            [StreamButton.L1, "80 84 FF", "80 84 00"],
            [StreamButton.R1, "80 85 FF", "80 85 00"],
            [StreamButton.CROSS, "80 88 FF", "80 88 00"],
            [StreamButton.CIRCLE, "80 89 FF", "80 89 00"],
            [StreamButton.SQUARE, "80 8A FF", "80 8A 00"],
            [StreamButton.TRIANGLE, "80 8B FF", "80 8B 00"],
            [StreamButton.OPTIONS, "80 AC", "80 8C"],
            [StreamButton.SHARE, "80 AD", "80 8D"],
            [StreamButton.PS, "80 AE", "80 8E"],
            [StreamButton.L3, "80 AF", "80 8F"],
            [StreamButton.R3, "80 B0", "80 90"],
            [StreamButton.TOUCHPAD, "80 B1", "80 91"],
        ];
        for (const [button, press, release] of table) {
            encodeButtonEvent(button, true).should.deep.equal(hex(press), `${button} press`);
            encodeButtonEvent(button, false).should.deep.equal(hex(release), `${button} release`);
        }
        encodeTriggerEvent("left", 0x40).should.deep.equal(hex("80 86 40"));
        encodeTriggerEvent("right", 0).should.deep.equal(hex("80 87 00"));
    });

    it("builds tap payloads newest first", () => {
        const history = new HistoryEventBuffer();
        history.push(encodeButtonEvent(StreamButton.OPTIONS, true))
            .should.deep.equal({ payload: hex("80 AC"), count: 1 });
        history.push(encodeButtonEvent(StreamButton.OPTIONS, false))
            .should.deep.equal({ payload: hex("80 8C 80 AC"), count: 2 });
    });

    it("keeps at most 8 older events", () => {
        const history = new HistoryEventBuffer();
        for (let i = 0; i < 20; i++) {
            history.push(encodeButtonEvent(StreamButton.CROSS, i % 2 === 0));
        }
        history.current().count.should.equal(9);
    });

    it("parses button names", () => {
        parseStreamButton("PS").should.equal(StreamButton.PS);
        parseStreamButton("x").should.equal(StreamButton.CROSS);
        parseStreamButton("options").should.equal(StreamButton.OPTIONS);
        expect(() => parseStreamButton("select")).to.throw();
    });

    it("rejects names from Object.prototype as buttons", () => {
        for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
            expect(() => parseStreamButton(name), name).to.throw(/Unknown button/);
        }
    });
});

describe("Remote Play launch spec", () => {
    const device = { type: DeviceType.PS5, systemVersion: "1" } as IDiscoveredDevice;
    const creds = fakeRemotePlayCredentials();
    const nonce = Buffer.alloc(16, 0x42);
    const strategy = pickCryptoStrategyForDevice(device);

    it("serializes compactly with the documented quirks", () => {
        const json = formatLaunchSpec(Buffer.alloc(16, 0xAB));
        json.length.should.equal(907);
        json.should.contain("\"bwLoss\":0.001000,");
        json.should.contain("\"adaptiveStreamMode\": \"resize\"}");
        json.should.contain(`"handshakeKey":"${Buffer.alloc(16, 0xAB).toString("base64")}"}`);
        Object.keys(JSON.parse(json)).should.deep.equal([
            "sessionId", "streamResolutions", "network", "slotId", "appSpecification",
            "konan", "requestGameSpecification", "userProfile", "videoCodec",
            "dynamicRange", "handshakeKey",
        ]);
    });

    it("uses the CFB encryption of zero bytes as key stream", () => {
        const stream = authKeyStream(strategy, creds, nonce, 64);
        stream.should.deep.equal(
            strategy.createCodecForAuth(creds, nonce, BigInt(0)).encode(Buffer.alloc(64)),
        );

        // and that is not the same as CFB-encrypting the plaintext
        const plain = Buffer.alloc(64, 0x7B);
        // eslint-disable-next-line no-bitwise
        const xored = Buffer.from(plain.map((b, i) => b ^ stream[i]));
        const cfb = strategy.createCodecForAuth(creds, nonce, BigInt(0)).encode(plain);
        xored.slice(0, 16).should.deep.equal(cfb.slice(0, 16));
        xored.slice(16).should.not.deep.equal(cfb.slice(16));
    });

    it("appends a NUL byte, XORs and base64-encodes", () => {
        const json = formatLaunchSpec(Buffer.alloc(16));
        const encoded = encodeLaunchSpec(
            json,
            n => authKeyStream(strategy, creds, nonce, n),
        );
        encoded.length.should.equal(1212);

        const cipher = Buffer.from(encoded, "base64");
        const key = authKeyStream(strategy, creds, nonce, cipher.length);
        // eslint-disable-next-line no-bitwise
        const plain = Buffer.from(cipher.map((b, i) => b ^ key[i]));
        plain.should.deep.equal(Buffer.concat([Buffer.from(json), Buffer.from([0])]));
    });
});

describe("Remote Play session ID", () => {
    function packet(payload: Buffer) {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(payload.length, 0);
        header.writeUInt16BE(RemotePlayResponseType.SessionId, 4);
        return Buffer.concat([header, payload]);
    }

    it("parses the ID after the marker byte", () => {
        const id = "AbCdEfGhIjKlMnOpQrStUvWx0123456789";
        expect(parseSessionIdPacket(packet(Buffer.concat([
            hex("4A"), Buffer.from(id),
        ])))).to.equal(id);
    });

    it("rejects IDs that are too short or not alphanumeric", () => {
        expect(parseSessionIdPacket(packet(Buffer.concat([
            hex("4A"), Buffer.from("short"),
        ])))).to.be.undefined;
        expect(parseSessionIdPacket(packet(Buffer.concat([
            hex("4A"), Buffer.from("AbCdEfGhIjKlMnOpQrStUvWx+"),
        ])))).to.be.undefined;
    });

    it("builds the fallback ID from seconds and 64 base64 chars", () => {
        const id = fallbackSessionId(1234.9, Buffer.alloc(48, 0xFF));
        id.should.equal(`1234${"/".repeat(64)}`);
    });
});
