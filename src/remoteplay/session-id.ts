import crypto from "crypto";
import _debug from "debug";
import os from "os";

import { IDeviceSocket } from "../socket/model";
import { RemotePlayResponseType } from "./packets";

const debug = _debug("playactor:remoteplay:session-id");

const HEADER_SIZE = 8;
const SESSION_ID_MARKER = 0x4A;
const VALID_SESSION_ID = /^[A-Za-z0-9]{24,78}$/;

/**
 * Parse the decrypted ctrl message 0x33 (header included). Returns
 * undefined if the payload doesn't hold a valid session ID (spec 2.1).
 */
export function parseSessionIdPacket(packet: Buffer): string | undefined {
    if (packet.length <= HEADER_SIZE + 1) {
        return;
    }

    const length = packet.readUInt32BE(0);
    const payload = packet.slice(HEADER_SIZE, HEADER_SIZE + length);
    if (payload[0] !== SESSION_ID_MARKER) {
        // spec ambiguity: byte 0 "should be" 0x4A and is discarded either
        // way; accept any marker as long as the ID itself is valid
        debug("unexpected session ID marker:", payload[0]);
    }

    const id = payload.slice(1).toString("latin1");
    if (!VALID_SESSION_ID.test(id)) {
        debug("invalid session ID payload:", payload.toString("hex"));
        return;
    }

    return id;
}

/**
 * Wait for the console's session ID message. The receiver is attached
 * synchronously, so call this before any packet can be dispatched.
 * Aborting the signal stops the wait (resolving undefined) and detaches
 * the receiver from the socket.
 */
export function receiveSessionId(socket: IDeviceSocket, signal?: AbortSignal) {
    const iterator = socket.receive()[Symbol.asyncIterator]();

    const aborted = new Promise<undefined>(resolve => {
        if (signal?.aborted) {
            resolve(undefined);
        } else {
            signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        }
    });

    return (async () => {
        try {
            for (;;) {
                const pending = iterator.next();
                pending.catch(() => { /* reported through the race below */ });

                // eslint-disable-next-line no-await-in-loop
                const result = await Promise.race([pending, aborted]);
                if (!result || result.done) {
                    break;
                }

                const packet = result.value;
                if (packet.type === RemotePlayResponseType.SessionId) {
                    const id = parseSessionIdPacket(packet.toBuffer());
                    if (id) {
                        debug("received session ID");
                        return id;
                    }
                }
            }
        } catch (e) {
            debug("control socket ended before session ID:", e);
        } finally {
            try {
                await iterator.return?.();
            } catch (e) {
                debug("unable to detach the session ID receiver:", e);
            }
        }
        return undefined;
    })();
}

/**
 * The fallback session ID: decimal seconds of a monotonic clock followed
 * by the base64 of 48 random bytes (spec 2.1). Acceptance by the console
 * is unverified.
 */
export function fallbackSessionId(
    uptimeSeconds: number = os.uptime(),
    random: Buffer = crypto.randomBytes(48),
) {
    // spec ambiguity: "monotonic clock" seconds; system uptime is used
    return `${Math.floor(uptimeSeconds)}${random.toString("base64")}`;
}
