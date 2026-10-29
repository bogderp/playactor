import _debug from "debug";

import { IRemotePlayCredentials } from "../../credentials/model";
import { IConnectionConfig } from "../../device/model";
import { IDiscoveredDevice } from "../../discovery/model";
import { delayMillis } from "../../util/async";
import { StreamButton } from "./input";
import { IStreamSession, IStreamSessionOptions, openStreamSession } from "./session";
import { ITapResult } from "./stream";

const debug = _debug("playactor:remoteplay:stream:remote");

export const DEFAULT_REMOTE_IDLE_TIMEOUT_MILLIS = 60_000;
// longer than the login, session ID and handshake timeouts together, so a
// slow console isn't logged into twice
export const DEFAULT_REMOTE_OPEN_TIMEOUT_MILLIS = 30_000;
export const DEFAULT_REMOTE_TAP_GAP_MILLIS = 50;

// the longest delay setTimeout supports
const MAX_TIMER_MILLIS = 2 ** 31 - 1;

export interface IStreamRemoteOptions {
    /** Close the session after this long without a tap */
    idleTimeoutMillis?: number;

    /** Give up on opening a session after this long */
    openTimeoutMillis?: number;

    /** Minimum time between the end of one tap and the start of the next */
    tapGapMillis?: number;

    session?: IStreamSessionOptions;

    /** @internal Override how sessions are opened (tests) */
    openSession?: () => Promise<IStreamSession>;
}

function checkMillis(name: string, value: number, min: number) {
    if (!Number.isFinite(value) || value < min || value > MAX_TIMER_MILLIS) {
        throw new RangeError(
            `${name} must be between ${min} and ${MAX_TIMER_MILLIS} ms; got ${value}`,
        );
    }
    return value;
}

/**
 * Taps buttons over one stream session that stays open while taps keep
 * coming, and closes after an idle timeout. A PS5 shows "connected" and
 * "disconnected" for every session, so this keeps it to one pair per use.
 *
 * Opening a session never wakes the console; it just fails if the console
 * is in rest mode. Callers should only tap when the console is awake.
 */
export class StreamRemote {
    private readonly idleTimeoutMillis: number;
    private readonly openTimeoutMillis: number;
    private readonly tapGapMillis: number;
    private readonly open: () => Promise<IStreamSession>;

    private session?: IStreamSession;
    private idleTimer?: NodeJS.Timeout;
    private lastTapAt?: number;
    private closed = false;

    // taps and closes run one after another, in the order they were made
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        device: IDiscoveredDevice,
        config: IConnectionConfig,
        creds: IRemotePlayCredentials,
        options: IStreamRemoteOptions = {},
    ) {
        this.idleTimeoutMillis = checkMillis(
            "idleTimeoutMillis",
            options.idleTimeoutMillis ?? DEFAULT_REMOTE_IDLE_TIMEOUT_MILLIS,
            1,
        );
        this.openTimeoutMillis = checkMillis(
            "openTimeoutMillis",
            options.openTimeoutMillis ?? DEFAULT_REMOTE_OPEN_TIMEOUT_MILLIS,
            1,
        );
        this.tapGapMillis = checkMillis(
            "tapGapMillis",
            options.tapGapMillis ?? DEFAULT_REMOTE_TAP_GAP_MILLIS,
            0,
        );
        this.open = options.openSession
            ?? (() => openStreamSession(device, config, creds, options.session));
    }

    /** True while a session is open (not while one is still opening) */
    public get isOpen() {
        return this.session !== undefined;
    }

    public tap(button: StreamButton, holdMillis?: number): Promise<ITapResult> {
        if (this.closed) return Promise.reject(new Error("StreamRemote is closed"));
        return this.enqueue(() => this.tapNow(button, holdMillis));
    }

    /**
     * Close the open session, if any. Taps made after this, and taps
     * still waiting in the queue, are rejected.
     */
    public close(): Promise<void> {
        this.closed = true;
        this.clearIdleTimer();
        return this.enqueue(() => this.closeSession());
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const result = this.queue.then(work);
        this.queue = result.catch(() => { /* reported to the caller */ });
        return result;
    }

    private async tapNow(button: StreamButton, holdMillis?: number) {
        if (this.closed) throw new Error("StreamRemote is closed");
        this.clearIdleTimer();

        const session = await this.ensureSession();
        await this.waitForTapGap();

        let result: ITapResult;
        try {
            result = await session.tap(button, holdMillis);
        } catch (e) {
            // drop a broken session so the next tap opens a new one
            if (!session.stream.isConnected) await this.closeSession();
            throw e;
        } finally {
            this.lastTapAt = Date.now();
        }

        if (this.session === session) {
            this.idleTimer = setTimeout(() => {
                debug("idle for", this.idleTimeoutMillis, "ms; closing session");
                this.enqueue(() => this.closeSession()).catch(err => {
                    debug("idle close failed:", err);
                });
            }, this.idleTimeoutMillis);
            this.idleTimer.unref();
        }

        return result;
    }

    private async ensureSession() {
        if (this.session) {
            if (this.session.stream.isConnected) return this.session;

            // the stream died without us hearing about it yet
            debug("session is no longer connected; reopening");
            await this.closeSession();
        }

        debug("opening session");
        const session = await this.openWithTimeout();
        this.session = session;

        session.closed.then(reason => {
            debug("session closed:", reason);

            // forget a session the console closed, so the next tap reopens
            if (this.session === session) {
                this.session = undefined;
                this.clearIdleTimer();
            }
        }, e => debug("session closed with error:", e));

        return session;
    }

    private async openWithTimeout() {
        const opening = this.open();

        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(
                `Timed out opening a stream session after ${this.openTimeoutMillis} ms`,
            )), this.openTimeoutMillis);
            timer.unref();
        });

        try {
            return await Promise.race([opening, timedOut]);
        } catch (e) {
            // close a session that finishes opening after we gave up on it
            opening.then(late => late.close()).catch(err => {
                debug("abandoned session failed:", err);
            });
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async waitForTapGap() {
        if (this.lastTapAt === undefined) return;

        const wait = this.lastTapAt + this.tapGapMillis - Date.now();
        if (wait > 0) await delayMillis(wait);
    }

    private async closeSession() {
        this.clearIdleTimer();

        const { session } = this;
        this.session = undefined;
        if (!session) return;

        try {
            await session.close();
        } catch (e) {
            debug("error closing session:", e);
        }
    }

    private clearIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }
}
