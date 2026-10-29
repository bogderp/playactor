import {
    Command,
    command,
    ExpectedError,
    option,
    params,
} from "clime";

import { DiskCredentialsStorage } from "../../credentials/disk-storage";
import { isRemotePlay } from "../../credentials/model";
import { DeviceStatus, DeviceType } from "../../discovery/model";
import { ControllerType, openStreamSession, parseStreamButton } from "../../remoteplay/stream";
import { DeviceOptions } from "../options";

export class PressOptions extends DeviceOptions {
    @option({
        name: "hold",
        description: "How long to hold each button before releasing it",
        placeholder: "millis",
        default: 50,
    })
    public holdMillis = 50;

    @option({
        name: "gap",
        description: "Pause between taps",
        placeholder: "millis",
        default: 300,
    })
    public gapMillis = 300;

    @option({
        name: "controller",
        description: "Controller type to announce (only ds4 is supported)",
        default: "ds4",
        type: String,
    })
    public controller = "ds4";

    @option({
        name: "mic",
        description: "Also send the optional microphone and display messages",
        toggle: true,
    })
    public mic = false;
}

// DualSense and mobile aren't covered by the protocol description (the
// DualSense also needs ctrl messages we don't send), so they're not offered
const controllerTypes = new Map<string, ControllerType>([
    ["ds4", ControllerType.DUALSHOCK4],
]);

/** setTimeout accepts at most 2^31 - 1 ms */
const MAX_MILLIS = 2 ** 31 - 1;
const MIN_RECOMMENDED_HOLD = 50;

function parseMillis(name: string, value: number) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_MILLIS) {
        throw new ExpectedError(`--${name} must be between 0 and ${MAX_MILLIS} milliseconds`);
    }
    return value;
}

function delay(millis: number) {
    return new Promise<void>(resolve => setTimeout(resolve, millis));
}

@command({
    brief: "Press controller buttons over a Remote Play stream (PS5)",
    description: `
Open a Remote Play stream session on an awake PS5 and tap each button in
order, then close the session. Valid buttons are:

    up, down, left, right, cross, circle, square, triangle,
    options, share, ps, l1, r1, l3, r3, touchpad

The console is never woken: if it is in rest mode, nothing is sent.
Timings are printed for login, stream set-up and each press.
    `.trim(),
})
export default class extends Command {
    /* eslint-disable @typescript-eslint/indent */
    public async execute(
        @params({
            description: "The buttons to press",
            required: true,
            type: String,
        })
        buttonNames: string[],
        options: PressOptions,
    ) {
        const holdMillis = parseMillis("hold", options.holdMillis);
        const gapMillis = parseMillis("gap", options.gapMillis);
        if (holdMillis < MIN_RECOMMENDED_HOLD) {
            options.logInfo(
                `Warning: --hold below ${MIN_RECOMMENDED_HOLD} ms may be missed by the game`,
            );
        }

        const buttons = buttonNames.map(name => {
            try {
                return parseStreamButton(name);
            } catch (e) {
                throw new ExpectedError(`Unknown button: ${name}`);
            }
        });

        const controllerType = controllerTypes.get(options.controller);
        if (controllerType === undefined) {
            throw new ExpectedError(`Unknown controller type: ${options.controller}`);
        }

        const start = Date.now();
        const elapsed = () => `${String(Date.now() - start).padStart(5)} ms`;

        // NOTE: never use device.openConnection() or device.wake() here;
        // both wake a console in rest mode.
        const device = await options.findDevice();
        const discovered = await device.discover();
        if (discovered.type !== DeviceType.PS5) {
            throw new ExpectedError("press needs a PS5 (Remote Play stream)");
        }
        if (discovered.status !== DeviceStatus.AWAKE) {
            throw new ExpectedError(
                `${discovered.name} is in rest mode; press doesn't wake consoles. `
                + "Turn it on first (eg: playactor wake).",
            );
        }

        const storage = new DiskCredentialsStorage(options.credentialsPath);
        const creds = await storage.read(discovered.id);
        if (!creds || !isRemotePlay(creds)) {
            throw new ExpectedError(
                `No Remote Play credentials for ${discovered.name} in ${storage.filePath}; `
                + "run `playactor login --ps5` first.",
            );
        }

        options.logResult(`${elapsed()}  found ${discovered.name} (awake)`);

        const session = await openStreamSession(discovered, options.connectionConfig, creds, {
            stream: {
                holdMillis,
                controllerType,
                sendMicStreamInfo: options.mic,
            },
            sendOptionalCtrlMessages: options.mic,
            onLoggedIn: () => options.logResult(`${elapsed()}  login done`),
            onSessionId: fallback => {
                if (fallback) {
                    options.logResult(`${elapsed()}  no session ID from console; using fallback`);
                }
            },
        });

        // Ctrl-C: end the session politely (sends DISCONNECT), then exit
        const onSignal = (signal: NodeJS.Signals) => {
            const code = signal === "SIGINT" ? 130 : 143;
            session.close().then(
                () => process.exit(code),
                () => process.exit(code),
            );
        };
        const onInt = () => onSignal("SIGINT");
        const onTerm = () => onSignal("SIGTERM");
        process.once("SIGINT", onInt);
        process.once("SIGTERM", onTerm);

        let failure: { error: unknown } | undefined;
        try {
            options.logResult(`${elapsed()}  stream ready (first press possible)`);

            for (let i = 0; i < buttons.length; i++) {
                if (i > 0) {
                    // eslint-disable-next-line no-await-in-loop
                    await delay(gapMillis);
                }

                // eslint-disable-next-line no-await-in-loop
                const tap = await session.tap(buttons[i], holdMillis);
                options.logResult(
                    `${String(tap.pressedAt - start).padStart(5)} ms  press ${tap.button} sent`
                    + ` (released after ${tap.releasedAt - tap.pressedAt} ms)`,
                );
            }
        } catch (error) {
            failure = { error };
        }

        process.removeListener("SIGINT", onInt);
        process.removeListener("SIGTERM", onTerm);

        try {
            await session.close();
            options.logResult(`${elapsed()}  closed`);
        } catch (closeError) {
            // don't mask the error that ended the presses
            if (!failure) throw closeError;
            options.logInfo(`Error while closing the session: ${closeError}`);
        }

        if (failure) throw failure.error;
    }
}
