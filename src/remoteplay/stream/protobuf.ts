/**
 * A tiny hand-written protobuf (proto2) wire-format reader and writer;
 * just enough for the few Takion messages the stream needs.
 */

/* eslint-disable no-bitwise */

export enum WireType {
    Varint = 0,
    Fixed64 = 1,
    LengthDelimited = 2,
    StartGroup = 3,
    EndGroup = 4,
    Fixed32 = 5,
}

export function encodeVarint(value: number | bigint): Buffer {
    let v = BigInt(value);
    if (v < BigInt(0)) {
        // negative int32/int64 values are sign-extended to 64 bits
        v += BigInt(1) << BigInt(64);
    }

    const bytes: number[] = [];
    do {
        let byte = Number(v & BigInt(0x7f));
        v >>= BigInt(7);
        if (v > BigInt(0)) {
            byte |= 0x80;
        }
        bytes.push(byte);
    } while (v > BigInt(0));

    return Buffer.from(bytes);
}

export class ProtoWriter {
    private readonly parts: Buffer[] = [];

    public varint(field: number, value: number | bigint | boolean) {
        const numeric = typeof value === "boolean" ? Number(value) : value;
        this.parts.push(encodeVarint((field << 3) | WireType.Varint));
        this.parts.push(encodeVarint(numeric));
        return this;
    }

    public bytes(field: number, value: Buffer | string) {
        const data = typeof value === "string"
            ? Buffer.from(value, "utf-8")
            : value;
        this.parts.push(encodeVarint((field << 3) | WireType.LengthDelimited));
        this.parts.push(encodeVarint(data.length));
        this.parts.push(data);
        return this;
    }

    public message(field: number, writer: ProtoWriter) {
        return this.bytes(field, writer.toBuffer());
    }

    public toBuffer() {
        return Buffer.concat(this.parts);
    }
}

export interface IProtoField {
    field: number;
    wireType: WireType;

    /** For varint, fixed32 and fixed64 */
    int?: bigint;

    /** For length-delimited fields; also the raw bytes of fixed fields */
    bytes?: Buffer;
}

export function decodeFields(buffer: Buffer): IProtoField[] {
    const fields: IProtoField[] = [];
    let offset = 0;

    function readVarint() {
        let result = BigInt(0);
        let shift = BigInt(0);
        for (;;) {
            if (offset >= buffer.length) {
                throw new Error("Truncated protobuf varint");
            }
            const byte = buffer[offset++];
            result |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                return result;
            }
            shift += BigInt(7);
            if (shift > BigInt(63)) {
                throw new Error("Protobuf varint too long");
            }
        }
    }

    function take(length: number) {
        if (offset + length > buffer.length) {
            throw new Error("Truncated protobuf field");
        }
        const slice = buffer.slice(offset, offset + length);
        offset += length;
        return slice;
    }

    function readKey() {
        const key = readVarint();
        if (key > BigInt(0xffffffff)) {
            throw new Error("Protobuf field key too large");
        }
        const field = Number(key >> BigInt(3));
        if (field === 0) {
            throw new Error("Protobuf field number 0");
        }
        return { field, wireType: Number(key & BigInt(7)) };
    }

    function readLength() {
        return Number(readVarint());
    }

    /** Skip a group body whose start key has been read, up to its end */
    function skipGroup(field: number) {
        const open = [field];
        while (open.length > 0) {
            const key = readKey();
            switch (key.wireType) {
                case WireType.Varint:
                    readVarint();
                    break;
                case WireType.Fixed64:
                    take(8);
                    break;
                case WireType.LengthDelimited:
                    take(readLength());
                    break;
                case WireType.Fixed32:
                    take(4);
                    break;
                case WireType.StartGroup:
                    open.push(key.field);
                    break;
                case WireType.EndGroup:
                    if (open.pop() !== key.field) {
                        throw new Error("Mismatched protobuf end-group");
                    }
                    break;
                default:
                    throw new Error(`Unsupported protobuf wire type ${key.wireType}`);
            }
        }
    }

    while (offset < buffer.length) {
        const { field, wireType } = readKey();

        switch (wireType) {
            case WireType.Varint:
                fields.push({ field, wireType, int: readVarint() });
                break;

            case WireType.Fixed64: {
                const bytes = take(8);
                fields.push({
                    field, wireType, bytes, int: bytes.readBigUInt64LE(0),
                });
                break;
            }

            case WireType.LengthDelimited: {
                fields.push({ field, wireType, bytes: take(readLength()) });
                break;
            }

            case WireType.Fixed32: {
                const bytes = take(4);
                fields.push({
                    field, wireType, bytes, int: BigInt(bytes.readUInt32LE(0)),
                });
                break;
            }

            case WireType.StartGroup:
                skipGroup(field);
                break;

            case WireType.EndGroup:
                throw new Error("Unexpected protobuf end-group");

            default:
                throw new Error(`Unsupported protobuf wire type ${wireType}`);
        }
    }

    return fields;
}

/**
 * Convenience accessors over decoded fields; the last occurrence of a
 * non-repeated field wins, as in protobuf.
 */
export class ProtoMessage {
    public static decode(buffer: Buffer) {
        return new ProtoMessage(decodeFields(buffer));
    }

    constructor(
        public readonly fields: IProtoField[],
    ) {}

    public has(field: number) {
        return this.fields.some(f => f.field === field);
    }

    public int(field: number): bigint | undefined {
        return this.last(field)?.int;
    }

    public number(field: number): number | undefined {
        const value = this.int(field);
        return value === undefined ? undefined : Number(value);
    }

    public bool(field: number): boolean | undefined {
        const value = this.int(field);
        return value === undefined ? undefined : value !== BigInt(0);
    }

    public bytes(field: number): Buffer | undefined {
        return this.last(field)?.bytes;
    }

    public string(field: number): string | undefined {
        return this.bytes(field)?.toString("utf-8");
    }

    public message(field: number): ProtoMessage | undefined {
        const bytes = this.bytes(field);
        return bytes ? ProtoMessage.decode(bytes) : undefined;
    }

    private last(field: number) {
        for (let i = this.fields.length - 1; i >= 0; i--) {
            if (this.fields[i].field === field) {
                return this.fields[i];
            }
        }
    }
}
