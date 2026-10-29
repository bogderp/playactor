import { IStreamParams, RemotePlayStream } from "./stream";

export { StreamButton, parseStreamButton } from "./input";
export { IStreamOptions, ITapResult, RemotePlayStream } from "./stream";
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
