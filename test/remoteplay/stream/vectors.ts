/**
 * Test vectors from the clean-room spec, Appendix A and section 13.2.
 * Kept as hex text copied from the spec so they can be compared by eye.
 */

export function hex(text: string) {
    return Buffer.from(text.replace(/\s+/g, ""), "hex");
}

export const V1 = {
    handshakeKey: hex("fc 5d 4b a0 3a 35 3a bb 6a 7f ac 79 1b 17 bb 34"),
    localPrivateKey: hex(`
        16 e7 5d cb da 98 55 fb 6b ef dd 8a a5 f1 6e 7f 46 fd e1 d2 27 97 03 60 18 72 d8 4b 15 38 d9 00
    `),
    localPublicKey: hex(`
        04 f4 0a f1 35 a4 88 94 36 ce e5 2b 5c 73 a3 3e c5 ad 0b e0 95 2f 57 f4 f0 ed 0c 80 b0 be da 7c
        a6 43 78 93 93 a5 94 7e 9f aa 3f 67 95 c9 aa 09 a9 63 25 df e8 50 bf c3 f1 db 62 a5 0a bf b0 ff
        f7
    `),
    localSignature: hex(`
        99 b5 cb b5 37 18 0b fc 55 da 43 7f 44 76 a8 17 c9 37 fe 56 1b 8a be 0c 41 12 ab 71 f5 a6 8d 29
    `),
    remotePublicKey: hex(`
        04 df ef 08 bb a8 56 f2 b4 4b 8a 0e 4f 44 20 3f 8e 49 3f ee d4 3c e9 3a fe 5c 64 67 77 20 15 7c
        59 10 15 67 94 ae 5f 02 4a ad 0c ce fa 14 15 0a ab ee 08 0b 14 12 76 ea 3e c0 d5 65 f4 68 77 a3
        ca
    `),
    remoteSignature: hex(`
        13 c5 89 e2 3b 72 85 24 a9 9f 96 80 03 a1 81 30 59 68 f1 bb b6 4d c4 a7 6c ce f6 79 4c eb 2d 98
    `),
    secret: hex(`
        b8 1c 61 46 e7 49 73 8c 96 30 ca 13 ff 71 e5 9b 3b f9 41 98 d4 67 a5 a2 bc 78 04 92 81 43 ec 1d
    `),
};

export const V2 = {
    index: 42,
    handshakeKey: hex("83 cf 93 1a 6a a7 69 a6 c4 48 5d 19 c1 5c cc 52"),
    secret: hex(`
        73 c8 d5 49 c4 d9 db 50 2e c0 44 ea 33 64 8c 6a c9 f3 6c 41 b6 a0 50 4f e0 93 de fb 61 9b 09 73
    `),
    cipherKey: hex("08 81 6f a2 e5 55 89 61 d5 a2 86 d9 0e ec 5b 8c"),
    baseIv: hex("2a e1 bb 3d 84 dc 9a a9 c3 52 a4 cf 3f fb 8b 72"),
    streamLow: hex(`
        0f 6d 89 85 5b a7 86 74 5b a1 fe 5c 81 19 6c d5 54 c4 1c ca f6 e9 34 a4 89 26 98 b0 62 12 b3 1a
    `),
    streamHigh: hex(`
        14 31 9f f8 be 08 17 a4 fc 28 49 0b 1e 5f 7b 7e fa e9 14 de c6 df e7 5d d6 9c 75 3f 94 62 d5 2c
    `),
};

export const V3 = {
    index: 42,
    handshakeKey: hex("14 f1 e6 94 6c 5d ce a8 b7 aa 48 50 f6 4d 21 ac"),
    secret: hex(`
        0c eb 77 09 83 4d 7a fc 50 b8 46 8c c6 3c 1e 7c 4e 4a 88 93 42 80 c1 28 e6 1e e9 d4 1b 8c 69 36
    `),
    cipherKey: hex("27 7a a5 1d ac d1 5f 0e 54 12 fa ce 0d c4 63 6a"),
    baseIv: hex("ef 20 40 c2 15 3c 02 66 32 1f 42 bb f4 50 34 4d"),
    plaintext: hex(`
        4e 61 9f 94 5d 4b 8e bd 2a 15 4d 03 6a cd 49 56 9c c7 5c e3 e7 00 17 9a 38 d9 69 53 45 f9 0c b5
        8c 05 65 0f 70
    `),
    ciphertextLow: hex(`
        23 f4 8d d8 aa f9 58 9b b1 94 4f ad 2b 8d aa 8d 25 88 fa f8 b6 d4 17 f4 5f 78 ec f5 4e 37 20 b0
        76 81 07 67 9a
    `),
    ciphertextHigh: hex(`
        2b 9e e9 83 27 44 08 b1 17 f5 37 a0 d9 c2 c6 05 95 78 b2 78 fd 17 8c 52 f4 17 9d ee 3f 62 e6 30
        01 61 4c f4 a1
    `),
};

export const V4 = {
    macKey0: hex("b6 4b 1e 65 3f bb a7 ab 80 b3 1e 5a 32 4d ec c0"),
    baseIv: hex("7c c8 d0 19 9e df d8 c3 b5 0f 32 ee 36 33 6a 5a"),
    input: hex(`
        03 00 18 00 19 00 02 50 21 05 00 00 00 00 00 00 69 a0 00 f9 f8 98 24 da 56 0b 74 ec 68 15 d3 1f
        85 43 aa d3 cd b8 50 2e 90 a4 b0 85 f3 be 9a 47 97 c1 ab 5f a5 fd 62 5c 26 1a 54 36 72 30 c3 2b
        e0 2c 5a 86 07 f5 dc 12 55 b4 8e 17 5b e4 7f 96 55 86 f0 fb 45 e2 f8 e8 7d 5f 3a 8b b0 64 6c 54
        f6 8c 4e a4 12 a3 26 7f 22 5b 19 98 ba d4 ad 9f 5f 63 af 1f 97 8c 17 49 a3 30 71 d2 b0 49 2c 75
        a2 89 da 50 fd 9b 08 41 98 2d 8c 0b 92 79 ae 60 23 83 ef 5c da ce 71 08 2d 0b 17 62 56 48 c5 e2
        0f 22 1d dc cc c2 82 a6 8e ec 1e 04 0c 08 aa a2 80 6c 4f d3 6f c1 9b 76 9a 58 aa 25 56 ef f2 fd
        77 f0 32 4e 83 e2 30 25 a5 5a f1 df c8 75 a2 b6 2b fd ac bc 63 09 a1 cc 2b f5 46 ef 49 83 8f 0b
        c1 47 ac 5a 00 2e ec 1c d0 0a 66 b5 ee 9e ad c9 64 2d cb 98 0f 43 a6 e1 4c e7 9f 2d ab 94 01 d7
        52 84 19
    `),
    macLow: hex("6f 81 10 97"),
    macHigh: hex("4a 30 98 10"),
};

export const V5 = {
    macKey0: hex("be eb a0 f0 3d 05 70 7d 3a c7 3c d7 32 b9 48 01"),
    baseIv: hex("e8 71 87 e7 63 e0 df 46 3d c2 02 4a 2c d2 9c 45"),
    macKey1: hex("e3 db 92 d9 dd d3 68 99 ae fd 9b 15 e1 a6 87 8b"),
};

export const V6 = {
    macKey0: hex("35 95 81 87 eb cb 63 54 90 00 d7 d5 bd f4 c5 f4"),
    baseIv: hex("b8 de fc a4 48 f0 4c 3f d5 94 0e 1c 04 64 63 b1"),
    input: hex(`
        02 00 1e 00 09 00 20 08 01 03 00 00 00 00 00 00 ad f0 02 4e 00 2c 6f 3b 6c 2e 4a 27 9c 50 34 84
        ea 37 c7 76 ab 92 30 43 61 c7 1d cb c4 35 94 cc 44 e2 fa 89 86 47 5e c2 01 39 4c 9f 67 b3 6e 35
        44 97 f4 28 e2 51 12 da f5 2c 43 1c 49 46 2c 53 e3 e9 76 61 87 2b 7a e3 2f bb 9f 4d 66 8a 31 bc
        64 9d 06 0d 4a dd 42 21 73 3c 97 21 84 53 65 53 7a f4 57 77 61 ae 0c 7a 42 90 fc 6b bb 38 6e 52
        b6 e5 26 0f d2 2a f1 56 50 dd 65 14 9e e3 b5 70 67 55 47 cd 8e c1 ba f6 72 b1 b4 11 1b 25 d4 3d
        19 b5 f5 dd 2f ef d6 d1 af b4 dc 93 e5 3c c3 a4 64 b3 ad d3 fc 23 84 86 f7 f9 10 df 15 6e 0c 6e
        43 9a 63 3b b5 38 05 f9 4a 68 4a fb 95 94 9d 31 fd 84 31 43 85 0d 8e bb 66 ca 4d 3b 0a 75 e5 eb
        de d5 f8 82 85 b2 cc db 70 9e a9 e2 b0 ac 76 01 28 ea 10 39 b7 47 78 82 c9 a4 24 16 c3 e5 16 02
        46 92 07 db 3a b0 d0 dd c0 15 dc 05 c7 61 e5 7d 82 d0 4c 17 44 b4 fa 28 d8 94 c1 f4 d0 b3 50 6a
        25 81 98 7b 49 67 a2 19 b2 41 e5 d2 df 9a 4f c9 60 ff b2 91 e8 5f 77 67 ff c0 a1 76 57 eb 61 34
        57 80 75 db 03 c5 53 f5 b3 a8 61 df 0f b6 e6 c4 39 a0 cd e9 a6 32 b8 ba 46 9c 43 16 49 65 9d 71
        87 f3 37 e5 e0 c6 df 5e 4c c5 20 9b 16 ed 13 2d 63 79 2b d0 51 44 00 44 8c 7c 2c c6 82 20 ca ca
        1f 7f ea 71 b7 84 5b 8c 94 5b 92 b6 ef be 5f 08 3d 05 b2 fb cb 5a 01 d4 16 71 8d 9e f5 8d ae 80
        40 90 fe ef 5d a4 74 f3 e3 4a 9a 67 8b a6 b5 59 18 61 4f 42 5f 2b 74 39 a8 30 5d 8d f1 ad 25 4f
        41 ca 27 da 07 75 49 46 d7 81 aa 27 61 56 9c 29 40 90 22 0a cd 3a 7b b4 85 96 07 80 13 12 3f 25
        27 a0 f6 26 bd d1 b0 95 bd 26 ba 49 a6 81 07 31 d3 e1 25 da ab 71 b9 65 1d 13 ab 82 52 95 b3 62
        a6 48 48 b8 d8 55 26 98 a1 c9 57 66 1c ac b1 c7 5f fa 44 c6 d8 19 01 8d 41 1f c7 0f 89 1d ef 34
        9a 68 77 8c
    `),
    macLow: hex("d6 6a 07 b7"),
    macHigh: hex("f0 17 95 3c"),
};

export const V7 = {
    index: 3,
    handshakeKey: hex("70 58 37 50 91 ea d1 37 71 58 ec b3 0b ea 23 87"),
    secret: hex(`
        3c 3a f0 ec d6 33 1b b1 6d 24 4f 48 19 de 06 3d c7 0e ac 95 70 ac 24 92 86 a7 24 d0 7a 37 55 52
    `),
    input: hex(`
        03 11 a4 11 a5 00 02 50 21 05 00 00 00 00 00 6b 1d e0 00 83 f1 c4 79 71 e4 67 7c cc b7 92 07 8b
        ba 8a 08 d6 62 f5 07 5d 4a 20 14 b3 e7 0e 5c 77 fd 6d 60 a3 c5 48 a9 c0 61 f9 84 f6 37 62 ac bc
        1f 5d e4 40 90 54 71 37 ab 33 7e aa a5 f4 c4 09 03 f4 b6 a1 2f 02 27 53 c6 a5 b1 9c 8f b4 69 d6
        5c 7f 79 5f 14 47 cc a8 8b 37 f7 77 6d 01 f4 5b 59 ca 96 73 0a 20 f3 7a d1 d2 7f fe b6 66 f4 db
        10 af f3 07 ee 49 8a a1 a5 73 d8 23 83 0e 0c 0c 3a 49 dc d8 0c c8 e4 b6 f2 3c 6d 25 6a 7d a0 1c
        3a 8e 0f 3f 25 47 11 89 67 c4 f9 ac c7 e2 93 74 c6 fb dd 48 57 ae 53 e2 f4 17 80 62 f3 09 d8 d4
        7a 46 6b 08 76 9c 29 81 91 4e 57 af 70 b6 32 78 98 9e 85 f2 e3 69 15 af d4 32 54 0f d4 a2 fc f5
        36 dc 06 45 f4 06 a3 38 21 02 fd f0 51 75 ea b1 f6 8e 39 35 fd 75 74 ad bc 3e fb ee 7d 0f 2d 76
        be fd ee
    `),
    keyPos: BigInt(0x6B1DE0),
    mac: hex("20 cc a5 f1"),
};

export const V8 = {
    index: 2,
    handshakeKey: hex("54 65 4c 34 5c ac 56 b8 ea e6 15 2a de 1c e2 e8"),
    secret: hex(`
        00 34 f8 21 c7 d9 de a9 e9 11 ca 5a d6 7d 11 ce 4f 02 b1 ce 1e e7 c3 8d 54 39 fa 64 e3 db d8 0d
    `),
    word0: 0x0042,
    received: 26,
    lost: 10,
    keyPos: BigInt(0x1E5),
    beforeMac: hex("05 00 42 00 1a 00 0a 00 00 00 00 00 00 01 e5"),
    afterMac: hex("05 00 42 00 1a 00 0a 64 8a 7c 74 00 00 01 e5"),
};

export const V9 = {
    datagram: hex(`
        02 00 2d 00 05 00 c0 1c 01 03 00 00 00 00 00 00 e4 10 03 67 00 29 f3 2f 98 f6 99 82 83 78 db 29
        43 a9 e5 88 f2 11 04 20 e6 20 96 e9 06 ee 0d 27 a1 83 82 88 e6 21 49 02 75 74 32 5b f6 e9 dc 93
        ea 31 88 0d 2b 4b 34 f9 ec 1b 26 cc bb bb 81 f2 d9 2d 8e a1 b9 e2 b3 ca b2 7d a3 31 f0 42 b7 b6
        1e 8f 6d a2 70 46 fd 7e 9b 60 85 b0 ed 4f 20 b5 01 71 a9 aa 18 6b 2a 90 f3 a7 84 36 fd 6d 14 83
        68 a3 9b 3a c8 d4 3a 31 a0 9b 61 de a7 ed 46 b4 a3 df 3f 44 8f ad 64 09 fc 7a e7 24 f0 d2 42 d3
        57 5a 76 00 c5 e0 93 a9 f5 32 5d ee f7 9d
    `),
};

/** Section 13.2 derived examples (shared parameters = the V8 inputs) */
export const DERIVED = {
    handshakeKey: hex("54654c345cac56b8eae6152ade1ce2e8"),
    secret: hex("0034f821c7d9dea9e911ca5ad67d11ce4f02b1ce1ee7c38d5439fa64e3dbd80d"),
    index: 2,
    cipherKey: hex("7e30a956925b1b2aeeedc91915d2d243"),
    baseIv: hex("946fe4f374b0bc87edd24d80981ea0c4"),
    macKey0: hex("c201d82a7ee51d36aa2f6efd62bd4007"),

    heartbeat: hex("00 11223344 ac936c89 00000040 00 01 000f aabbccdd 0001 0000 00 0803"),
    idleState: hex(`
        06 0000 01 00000040 468fe178
        20aebb56701787d8ac4d4ef49af2bcd16966b8678c7c5dca35bc41b5
    `),
    upPress: hex("01 0000 01 00000080 6799b647 24a7ac"),
    upRelease: hex("01 0001 02 000000b0 4392abac a81046bc3cfc"),
};
