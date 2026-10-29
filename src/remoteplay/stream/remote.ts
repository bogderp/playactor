import _debug from "debug";

import { IRemotePlayCredentials } from "../../credentials/model";
import { IConnectionConfig } from "../../device/model";
import { IDiscoveredDevice } from "../../discovery/model";
import { StreamButton } from "./input";
import { IStreamSession, IStreamSessionOptions, openStreamSession } from "./session";
import { ITapResult } from "./stream";

const debug = _debug("playactor:remoteplay:stream:remote");

export const DEFAULT_REMOTE_IDLE_TIMEOUT_MILLIS = 60_000;

export interface IStreamRemoteOptions {
    /** Close the session after this long without a tap */
    idleTimeoutMillis?: number;

    session?: IStreamSessionOptions;

    /** Override how sessions are opened (tests) */
    openSession?: () => Promise<IStreamSession>;
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
    private readonly open: () => Promise<IStreamSession>;

    private session?: Promise<IStreamSession>;
    private idleTimer?: NodeJS.Timeout;

    // taps run one after another, in the order they were made
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        device: IDiscoveredDevice,
        config: IConnectionConfig,
        creds: IRemotePlayCredentials,
        options: IStreamRemoteOptions = {},
    ) {
        this.idleTimeoutMillis = options.idleTimeoutMillis
            ?? DEFAULT_REMOTE_IDLE_TIMEOUT_MILLIS;
        this.open = options.openSession
            ?? (() => openStreamSession(device, config, creds, options.session));
    }

    public get isOpen() {
        return this.session !== undefined;
    }

    public tap(button: StreamButton, holdMillis?: number): Promise<ITapResult> {
        const result = this.queue.then(() => this.tapNow(button, holdMillis));
        this.queue = result.catch(() => { /* reported to the caller */ });
        return result;
    }

    public async close() {
        this.clearIdleTimer();

        const { session } = this;
        this.session = undefined;
        if (!session) return;

        try {
            await (await session).close();
        } catch (e) {
            debug("session never opened:", e);
        }
    }

    private async tapNow(button: StreamButton, holdMillis?: number) {
        this.clearIdleTimer();

        let result: ITapResult;
        try {
            const session = await this.ensureSession();
            result = await session.tap(button, holdMillis);
        } catch (e) {
            // drop the broken session so the next tap opens a new one
            await this.close();
            throw e;
        }

        this.idleTimer = setTimeout(() => {
            debug("idle for", this.idleTimeoutMillis, "ms; closing session");
            this.close();
        }, this.idleTimeoutMillis);
        this.idleTimer.unref();

        return result;
    }

    private ensureSession() {
        if (this.session) return this.session;

        debug("opening session");
        const opening = this.open();
        this.session = opening;

        opening.then(session => session.closed.then(reason => {
            debug("session closed:", reason);

            // forget a session the console closed, so the next tap reopens
            if (this.session === opening) {
                this.session = undefined;
                this.clearIdleTimer();
            }
        }), () => { /* reported by tapNow */ });

        return opening;
    }

    private clearIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }
}
