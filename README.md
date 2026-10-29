playactor
=========

*play around with your playstation devices*

> **Fork notice:** this is `@bogderp/playactor`, a fork of
> [dhleong/playactor](https://github.com/dhleong/playactor) used by
> `@bogderp/homebridge-playstation`. It adds the unmerged upstream PRs
> [#71](https://github.com/dhleong/playactor/pull/71) (standby without a
> Remote Play login) and [#72](https://github.com/dhleong/playactor/pull/72)
> (control socket handover on modern Node.js), plus fixes for the UDP
> discovery listener leak and a crash from `got` retries. It also adds PS5
> button presses over a Remote Play stream session (see below).

## What?

playactor is a command line tool and node.js API for interacting with Sony
PS4 and PS5 devices. It is the successor to my older project,
[ps4-waker][ps4-waker]. It currently supports:

|                  | PS4 | PS5 |
|------------------|-----|-----|
| Wake             | ✅  | ✅  |
| Standby          | ✅  | ✅  |
| Keyboard control | ✅  | ❌  |
| Key/Button press | ✅  | ✅¹ |
| App/Game start   | ✅  | ❌  |

¹ On the PS5, button presses go over a Remote Play stream session (no video
or audio is decoded). The console must already be awake, and it shows
"&lt;user&gt; connected" / "disconnected" for each session. Try it with
`playactor press --ps5 right right cross`. This is a clean-room
implementation, written from a protocol description without using code from
other Remote Play clients.

## How?

The playactor CLI tool can be installed using npm:

    npm install -g playactor

## Disclaimer

I take no responsibility for your usage of this code, whatsoever. By using
this code, directly or indirectly, you agree that I shall not be held
responsible in any way for anything that may happen to you or any of your
devices, etc. as a result, directly or indirectly, of your use of this
project, in any way whatsoever, etc. etc.

[ps4-waker]: https://github.com/dhleong/ps4-waker
