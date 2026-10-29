/**
 * Controller input encoding: feedback state (sticks and motion) and
 * feedback history events (buttons). Spec section 9.
 */

/* eslint-disable no-bitwise */

export enum StreamButton {
    UP = "up",
    DOWN = "down",
    LEFT = "left",
    RIGHT = "right",
    L1 = "l1",
    R1 = "r1",
    CROSS = "cross",
    CIRCLE = "circle",
    SQUARE = "square",
    TRIANGLE = "triangle",
    OPTIONS = "options",
    SHARE = "share",
    PS = "ps",
    L3 = "l3",
    R3 = "r3",
    TOUCHPAD = "touchpad",
}

/** Buttons whose events are 3 bytes: `80 <id> <FF|00>` */
const valueButtons: { [button: string]: number } = {
    [StreamButton.UP]: 0x80,
    [StreamButton.DOWN]: 0x81,
    [StreamButton.LEFT]: 0x82,
    [StreamButton.RIGHT]: 0x83,
    [StreamButton.L1]: 0x84,
    [StreamButton.R1]: 0x85,
    [StreamButton.CROSS]: 0x88,
    [StreamButton.CIRCLE]: 0x89,
    [StreamButton.SQUARE]: 0x8A,
    [StreamButton.TRIANGLE]: 0x8B,
};

/** Buttons whose events are 2 bytes: `80 <press id>` / `80 <release id>` */
const toggleButtons: { [button: string]: number } = {
    [StreamButton.OPTIONS]: 0x8C,
    [StreamButton.SHARE]: 0x8D,
    [StreamButton.PS]: 0x8E,
    [StreamButton.L3]: 0x8F,
    [StreamButton.R3]: 0x90,
    [StreamButton.TOUCHPAD]: 0x91,
};

const TOGGLE_PRESS_BIT = 0x20;

export function parseStreamButton(name: string): StreamButton {
    const normalized = name.toLowerCase();
    const aliases: { [alias: string]: StreamButton } = {
        x: StreamButton.CROSS,
        o: StreamButton.CIRCLE,
        option: StreamButton.OPTIONS,
        create: StreamButton.SHARE,
    };
    // own properties only: "constructor" and "toString" are not buttons
    const button = Object.prototype.hasOwnProperty.call(aliases, normalized)
        ? aliases[normalized]
        : (Object.values(StreamButton) as string[]).find(b => b === normalized);
    if (!button) {
        throw new Error(`Unknown button: ${name}`);
    }
    return button as StreamButton;
}

/** Encode one feedback history event (spec 9.3) */
export function encodeButtonEvent(button: StreamButton, pressed: boolean): Buffer {
    const valueId = valueButtons[button];
    if (valueId !== undefined) {
        return Buffer.from([0x80, valueId, pressed ? 0xFF : 0x00]);
    }

    const toggleId = toggleButtons[button];
    if (toggleId !== undefined) {
        return Buffer.from([0x80, pressed ? toggleId | TOGGLE_PRESS_BIT : toggleId]);
    }

    throw new Error(`Unsupported button: ${button}`);
}

/** Analog trigger event: L2 (left) or R2, value 0..255 */
export function encodeTriggerEvent(side: "left" | "right", value: number) {
    const clamped = Math.max(0, Math.min(255, Math.trunc(value)));
    return Buffer.from([0x80, side === "left" ? 0x86 : 0x87, clamped]);
}

/**
 * Keeps recent events newest first and builds history payloads (spec 9.4)
 */
export class HistoryEventBuffer {
    private readonly events: Buffer[] = [];

    constructor(
        /** Older events included next to the newest one */
        private readonly maxOlderEvents = 8,
    ) {}

    /** Record a new event; returns the payload and event count to send */
    public push(event: Buffer) {
        this.events.unshift(event);
        if (this.events.length > this.maxOlderEvents + 1) {
            this.events.length = this.maxOlderEvents + 1;
        }
        return this.current();
    }

    public current() {
        return {
            payload: Buffer.concat(this.events),
            count: this.events.length,
        };
    }
}

// ======= Feedback state ==================================================

export interface IVector3 { x: number; y: number; z: number }
export interface IQuaternion { x: number; y: number; z: number; w: number }

export interface IControllerState {
    gyro: IVector3; // rad/s
    accel: IVector3; // g
    orientation: IQuaternion;
    leftStick: { x: number, y: number }; // i16, 0 = centre
    rightStick: { x: number, y: number };
}

export const IDLE_CONTROLLER_STATE: IControllerState = {
    gyro: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 1, z: 0 },
    orientation: {
        x: 0, y: 0, z: 0, w: 1,
    },
    leftStick: { x: 0, y: 0 },
    rightStick: { x: 0, y: 0 },
};

export const FEEDBACK_STATE_SIZE = 28;

function checkStick(name: string, value: number) {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded) || rounded < -0x8000 || rounded > 0x7FFF) {
        throw new RangeError(`${name} must be a number from -32768 to 32767, not ${value}`);
    }
    return rounded;
}

/**
 * Check the stick values (i16) and return the state with them rounded to
 * integers. Throws RangeError so a bad value never reaches a timer.
 */
export function validateControllerState(state: IControllerState): IControllerState {
    return {
        ...state,
        leftStick: {
            x: checkStick("leftStick.x", state.leftStick.x),
            y: checkStick("leftStick.y", state.leftStick.y),
        },
        rightStick: {
            x: checkStick("rightStick.x", state.rightStick.x),
            y: checkStick("rightStick.y", state.rightStick.y),
        },
    };
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function encodeGyro(v: number) {
    return Math.trunc((65535 * (clamp(v, -30, 30) + 30)) / 60);
}

function encodeAccel(v: number) {
    return Math.trunc((65535 * (clamp(v, -5, 5) + 5)) / 10);
}

/** Compress an orientation quaternion into 32 bits (spec 9.2) */
export function compressQuaternion(q: IQuaternion): number {
    const components = [q.x, q.y, q.z, q.w];
    let largest = 0;
    for (let i = 1; i < 4; i++) {
        if (Math.abs(components[i]) > Math.abs(components[largest])) {
            largest = i;
        }
    }

    const half = Math.SQRT1_2;
    let result = (components[largest] < 0 ? 1 : 0) | (largest << 1);
    let shift = 3;
    for (let i = 0; i < 4; i++) {
        if (i === largest) continue;
        const c = clamp(components[i], -half, half);
        const encoded = Math.trunc(((c + half) * 511) / (2 * half)) & 0x1ff;
        result |= encoded << shift;
        shift += 9;
    }

    return result >>> 0;
}

/** Encode the 28-byte feedback state payload (protocol version 12) */
export function encodeControllerState(state: IControllerState = IDLE_CONTROLLER_STATE) {
    const buffer = Buffer.alloc(FEEDBACK_STATE_SIZE);
    buffer[0] = 0xA0;
    buffer.writeUInt16LE(encodeGyro(state.gyro.x), 1);
    buffer.writeUInt16LE(encodeGyro(state.gyro.y), 3);
    buffer.writeUInt16LE(encodeGyro(state.gyro.z), 5);
    buffer.writeUInt16LE(encodeAccel(state.accel.x), 7);
    buffer.writeUInt16LE(encodeAccel(state.accel.y), 9);
    buffer.writeUInt16LE(encodeAccel(state.accel.z), 11);
    buffer.writeUInt32LE(compressQuaternion(state.orientation), 13);
    buffer.writeInt16BE(state.leftStick.x, 17);
    buffer.writeInt16BE(state.leftStick.y, 19);
    buffer.writeInt16BE(state.rightStick.x, 21);
    buffer.writeInt16BE(state.rightStick.y, 23);
    buffer[25] = 0x00;
    buffer[26] = 0x00;
    buffer[27] = 0x01;
    return buffer;
}
