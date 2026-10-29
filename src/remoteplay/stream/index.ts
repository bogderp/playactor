import { IStreamParams, RemotePlayStream } from "./stream";

export { StreamButton, parseStreamButton } from "./input";
export { ControllerType } from "./messages";
export { IStreamOptions, ITapResult, RemotePlayStream } from "./stream";
export {
    DEFAULT_REMOTE_IDLE_TIMEOUT_MILLIS,
    IStreamRemoteOptions,
    StreamRemote,
} from "./remote";
export { IStreamSession, IStreamSessionOptions, openStreamSession } from "./session";

/**
 * Open a stream session over an existing datagram channel, run the
 * handshake, and return it ready for input.
 */
export async function openStream(params: IStreamParams) {
    const stream = new RemotePlayStream(params);
    await stream.start();
    return stream;
}
