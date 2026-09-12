# @vcjdeboer/esp32 v2026.09.12.2 — Swamp Club Extension

Drive an ESP32 running MicroPython from swamp over USB serial, with no Arduino
IDE. Flash the board, run Python through the raw REPL, speak your own firmware
line-protocol, scan WiFi and Bluetooth — every exchange is recorded as versioned
swamp data, keyed to the chip from the moment it is flashed, and every record
carries an explicit `outcome`.

Developed and verified on an **AYWHP ESP32-C3 Super Mini (model XD055), chip
ESP32-C3 revision v1.1**, running MicroPython v1.29.0. Any MicroPython board on
a USB-CDC serial port works for the generic methods; flashing is ESP-family.

## Installation

```
swamp extension pull @vcjdeboer/esp32
```

Needs [esptool](https://github.com/espressif/esptool) on `PATH` for the `flash`
method (`pipx install esptool`) and a MicroPython image (from
[micropython.org](https://micropython.org/download/)). Deno is provided by
swamp; `mpremote` is not required — `upload` writes files over the raw REPL.

## Usage

Create one model instance per board. Leave `device` unset to auto-detect a
single attached board, or pass the port (`/dev/cu.usbmodem*` on macOS,
`/dev/ttyACM*` on Linux):

```
swamp model create @vcjdeboer/esp32-serial c3 --global-arg holder=true
```

Take a bare chip to a running board and record its identity:

```
# flash MicroPython, recording the chip's MAC and the image hash
swamp model method run c3 flash --input image=ESP32_GENERIC_C3-20260824-v1.29.0.bin
# identify the build, then run Python on the board
swamp model method run c3 establish
swamp model method run c3 repl --input 'code=print(2 ** 10)'
# scan the radios (joins nothing, stores nothing)
swamp model method run c3 wifi
swamp model method run c3 ble
```

Read back any result as versioned data:

```
swamp data get c3 flash-latest --json     # MAC, image sha256, verified
swamp data get c3 link-current --json     # MicroPython build, files on board
swamp data get c3 wifi-latest --json      # networks seen, strongest first
```

Put your own firmware on the board with `upload` (over the raw REPL, each file
verified by sha256 on the device), then talk to it with `command`, which sends
one line and parses the JSON object the firmware answers with:

```
swamp model method run c3 upload --input files=main.py
swamp model method run c3 command --input line=ping
```

For faster back-to-back calls, keep the port open in a detached worker with
`swamp model method run c3 hold` (about 25 ms per command versus ~215 ms), and
`... release` when done. With `holder: true`, methods use it automatically.

## Models

One model type on a modular serial transport: `_lib` (plus the worker) moves
bytes and lines over a port, holds it open, and flashes; the model gives those
lines MicroPython meaning.

| Model type | For | Methods |
| --- | --- | --- |
| `@vcjdeboer/esp32-serial` | A MicroPython board over USB serial | `detect`, `flash`, `establish`, `repl`, `command`, `read`, `write`, `upload`, `wifi`, `ble`, `hold`, `release` |

Describe the type with
`swamp model type describe @vcjdeboer/esp32-serial --compact --json`. Records are
named `<spec>-latest` / `<spec>-current` (e.g. `command-latest`); reference them
in workflows as `data.latest("c3", "flash-latest")`. Every record carries an
explicit `outcome` (ok, error, partial, or timeout), so a run that fails partway
is always distinguishable in the data.

## Operational limits

### Flashing (`flash`)
- ESP-family chips only; needs `esptool` on `PATH`. esptool runs inside the
  serial worker (a normal Deno child), never directly from the method, because
  spawning it from swamp's compiled runtime stalls its serial connect.
- Erases all flash by default and writes the image at `0x0`; MicroPython
  reformats its filesystem on first boot. The board resets and re-enumerates.

### Serial and the REPL
- USB-CDC boards only. A board with a CP2102/CH340 bridge enumerates under a
  different device name (`usbserial-*`, `wchusbserial-*`) that auto-detect does
  not yet match — pass `device` explicitly.
- `repl` and the radio methods interrupt the running firmware; pass
  `resume=true` to soft-reset back into `main.py` afterward. Code that runs
  longer than the timeout is recorded as `timedOut` with partial output, not
  silently dropped.
- `command` expects a firmware that answers one JSON object per line; if the
  board is at a REPL prompt it soft-resets once and retries.

### Data
- Every method records a versioned resource; radio methods and device
  exchanges are kept long (high garbage-collection retention), observations
  short. `wifi` stores no credentials and `ble` advertises nothing.
