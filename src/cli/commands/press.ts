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
        description: "Controller type to announce: ds4, dualsense or mobile",
        default: "ds4",
        type: String,
    })
    public controller = "ds4";

    @option({
        name: "no-mic",
        description: "Don't send the microphone messages",
        toggle: true,
    })
    public noMic = false;
}

const controllerTypes: Record<string, ControllerType> = {
    ds4: ControllerType.DUALSHOCK4,
    dualsense: ControllerType.DUALSENSE,
    mobile: ControllerType.MOBILE,
};

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
        const buttons = buttonNames.map(name => {
            try {
                return parseStreamButton(name);
            } catch (e) {
                throw new ExpectedError(`Unknown button: ${name}`);
            }
        });

        const controllerType = controllerTypes[options.controller];
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
                holdMillis: options.holdMillis,
                controllerType,
                sendMicStreamInfo: !options.noMic,
            },
            sendOptionalCtrlMessages: !options.noMic,
            onLoggedIn: () => options.logResult(`${elapsed()}  login done`),
            onSessionId: fallback => {
                if (fallback) {
                    options.logResult(`${elapsed()}  no session ID from console; using fallback`);
                }
            },
        });

        try {
            options.logResult(`${elapsed()}  stream ready (first press possible)`);

            for (let i = 0; i < buttons.length; i++) {
                if (i > 0) {
                    // eslint-disable-next-line no-await-in-loop
                    await delay(options.gapMillis);
                }

                // eslint-disable-next-line no-await-in-loop
                const tap = await session.tap(buttons[i], options.holdMillis);
                options.logResult(
                    `${String(tap.pressedAt - start).padStart(5)} ms  press ${tap.button} sent`
                    + ` (released after ${tap.releasedAt - tap.pressedAt} ms)`,
                );
            }
        } finally {
            await session.close();
            options.logResult(`${elapsed()}  closed`);
        }
    }
}
