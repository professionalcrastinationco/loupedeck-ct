# Architecture notes

Node 22 daemon (not the usual Python/Docker stack: it needs USB serial, USB HID,
Win32 SendInput, foreground-window detection and Core Audio, none of which work
from a container). UI is plain JS + Pico CSS served by the daemon (no build step).

```
development/start-hidden.vbs -> backend/src/run.js (watchdog, restarts on crash)
                                   -> backend/src/main.js
                                        device.js     DeviceSupervisor (serial, timeouts, heartbeat, reconnect, coalescing output queue)
                                        controller.js input -> actions, paging, long-press/swipe, app rules, diff-only rendering
                                        renderer.js   canvas drawing for keys / strips / wheel
                                        widgets.js    live values (clock, cpu, audio, litra, lutron, command, http)
                                        actions.js    action handlers (never throw)
                                        win32.js      koffi FFI: SendInput, foreground app, Core Audio
                                        light.js      Litra via `litra` pkg (own matched/timed reads)
                                        lutron.js     LEAP client via `lutron-leap`
                                        server.js     127.0.0.1:20010, Host/Origin checked, REST + websocket
```

## Device quirks found (firmware 0.2.8)

- After a previous session closes COM3, the CT often ignores the first
  websocket-upgrade handshake (measured: answers every other request).
  Upstream `loupedeck` sends it once with no timeout -> hang.
  `RobustSerialConnection` re-sends every 400 ms.
- The CT can stop answering on serial entirely (no reply to the handshake or
  even a close frame) while still enumerated fine on USB. This is very likely
  the "it just stops working" failure of the official software.
  **Fix: drop DTR for 100 ms and raise it again** -> it answers within ~300 ms.
  Done on every port open and every 3rd handshake retry.
- Upstream has no timeouts on acks; all device commands are wrapped.
- Touch x is in a 480-wide space (0-60 left strip, 60-420 keys, 420-480 right strip).

## Litra quirk

`litra` getters use blocking `readSync()` and accept the next HID report,
which may be an unsolicited notification (wrong values) or never arrive
(blocks the event loop forever). `light.js` drains, then reads with timeout
and matches the reply's feature/function bytes.

## Knob-driven levels: required pattern (bit us twice)

Fast knob turns made Lutron dimmers, and later the Litra, bounce up and down.
Devices apply changes late and report stale/in-between values while settling,
so stepping from the *reported* level goes backwards. Every level-type control
(`lutron.js`, `light.js`, and any future one) must:

1. Step from the last **commanded** value; treat it as truth for a ~1.5 s hold window
   (ignore device reports / skip reads), then re-read to pick up external changes.
2. Keep the level as an unrounded float; round only when sending (per-step rounding drifts).
3. Compute absolute targets, then write: retries must be idempotent (never re-apply a step).
4. Serialize actions per device; coalesce sends (newest value wins).
5. Add a fake-device test where writes land late; a fast spin must be monotonic and exact.

## Libraries

- `loupedeck` (MIT) – CT protocol
- `canvas` – drawing
- `koffi` – Win32 FFI without native builds
- `litra` (MIT) – Logitech Litra
- `lutron-leap` (GPL-3.0) + `node-forge` – Lutron LEAP + pairing CSR
- `ws` – websocket

## Tests

`cd backend && npm test` (node:test; fake device, no hardware needed).
Results saved under `testing/test_results/`.
