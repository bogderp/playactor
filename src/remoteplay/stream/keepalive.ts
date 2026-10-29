export interface IKeepAliveIntervals {
    congestionMillis: number;
    feedbackStateMillis: number;
    heartbeatMillis: number;
}

/** Spec 8: congestion and feedback state every 200 ms, heartbeat every 1 s */
export const defaultKeepAliveIntervals: IKeepAliveIntervals = {
    congestionMillis: 200,
    feedbackStateMillis: 200,
    heartbeatMillis: 1000,
};

export interface IKeepAliveTarget {
    sendCongestion(): void;
    sendFeedbackState(): void;
    sendHeartbeat(): void;
}

/**
 * Periodic packets that keep a stream session alive. The congestion
 * timer may run from the moment the socket opens; the others start once
 * the stream is connected (spec 6.5, 8).
 */
export class StreamKeepAlive {
    private congestionTimer?: NodeJS.Timeout;
    private feedbackTimer?: NodeJS.Timeout;
    private heartbeatTimer?: NodeJS.Timeout;

    constructor(
        private readonly target: IKeepAliveTarget,
        private readonly intervals: IKeepAliveIntervals = defaultKeepAliveIntervals,
    ) {}

    public startCongestion() {
        if (this.congestionTimer) return;
        this.congestionTimer = setInterval(
            () => this.target.sendCongestion(),
            this.intervals.congestionMillis,
        );
    }

    public startConnected() {
        if (!this.feedbackTimer) {
            this.target.sendFeedbackState();
            this.feedbackTimer = setInterval(
                () => this.target.sendFeedbackState(),
                this.intervals.feedbackStateMillis,
            );
        }

        if (!this.heartbeatTimer) {
            this.heartbeatTimer = setInterval(
                () => this.target.sendHeartbeat(),
                this.intervals.heartbeatMillis,
            );
        }
    }

    /** Restart the feedback state timer after an immediate send */
    public feedbackStateSent() {
        if (!this.feedbackTimer) return;
        clearInterval(this.feedbackTimer);
        this.feedbackTimer = setInterval(
            () => this.target.sendFeedbackState(),
            this.intervals.feedbackStateMillis,
        );
    }

    public stopFeedback() {
        if (this.feedbackTimer) clearInterval(this.feedbackTimer);
        this.feedbackTimer = undefined;
    }

    public stop() {
        this.stopFeedback();
        if (this.congestionTimer) clearInterval(this.congestionTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.congestionTimer = undefined;
        this.heartbeatTimer = undefined;
    }
}
