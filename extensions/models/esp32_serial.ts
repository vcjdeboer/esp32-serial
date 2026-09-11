/**
 * `@vcjdeboer/esp32-serial`: an ESP32 board running MicroPython, reached over
 * USB serial from swamp.
 *
 * The host owns the logic; the board runs MicroPython, and optionally your own
 * `main.py` that speaks a one-line-in, one-JSON-line-out protocol. This model
 * wraps the serial worker
 * (`extensions/files/serial_worker.ts`, driven through `SerialLink`) so every
 * exchange with the board lands in the datastore as a versioned record.
 *
 * A swamp method runs in a fresh process, so by default every method spawns
 * the worker, opens the port, does one thing, and closes it. With
 * `holder: true` the `hold` method starts the worker detached in holder mode
 * on a unix socket, the port stays open between calls, and methods connect
 * to it instead of spawning (the pattern `@shrug/serial-port` gets from
 * socat and the rack's instrument holders get from a unix socket).
 *
 * Two ways in to the board, both offered as methods:
 *
 * - `repl` runs Python through MicroPython's raw REPL (Ctrl-A), the same
 *   channel `mpremote exec` uses, so multi-line code works and stdout and the
 *   traceback come back separated.
 * - `command` sends one line to your firmware and parses the JSON object it
 *   answers with. If the board is sitting at a REPL prompt instead of running
 *   `main.py`, it soft-resets once and retries.
 *
 * Replies end on a delimiter, on a gap of silence (`idleMs`), or on the hard
 * `timeoutMs`; a timeout is recorded with the partial bytes, never swallowed.
 *
 * Verified 2026-09-11 against an ESP32-C3 Super Mini at /dev/cu.usbmodem1101
 * running MicroPython v1.29.0 (per-call mode). Holder mode and auto-detect
 * verified against a pseudo-terminal fake board; see the test file.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { SerialLink } from "./_lib/serial_link.ts";
import {
  ensureSocketDir,
  socketDir,
  socketPathFor,
} from "./_lib/holder_paths.ts";

const GlobalArgsSchema = z.object({
  device: z.string().optional().describe(
    "Serial device path: /dev/cu.usbmodemXXXX on macOS, /dev/ttyACM0 on Linux. " +
      "Leave unset to auto-detect when exactly one candidate is attached " +
      "(see the `detect` method).",
  ),
  baud: z.number().int().positive().default(115200).describe(
    "Line speed. USB-CDC ignores it; it matters for UART bridges.",
  ),
  timeoutMs: z.number().int().positive().default(2000).describe(
    "Default hard cap on waiting for the board's reply, per exchange.",
  ),
  idleMs: z.number().int().positive().default(150).describe(
    "End a firmware reply once bytes have arrived and the line has been " +
      "silent this long. Not applied to REPL runs, whose code may pause.",
  ),
  settleMs: z.number().int().nonnegative().default(100).describe(
    "After opening the port, discard whatever arrives for this long, so a " +
      "previous call's tail or boot spew is not read as this call's reply. " +
      "0 disables.",
  ),
  holder: z.boolean().default(false).describe(
    "Keep the port open between calls in a detached worker (start it with " +
      "`hold`, stop it with `release`). When the holder is not running, " +
      "methods fall back to opening the port per call.",
  ),
  holderIdleTimeoutMs: z.number().int().positive().default(15 * 60_000)
    .describe(
      "The holder exits after this long without a request.",
    ),
  denoPath: z.string().optional().describe(
    "Deno binary used to run the serial worker. Defaults to $SWAMP_DENO, " +
      "then swamp's bundled ~/.swamp/deno/deno.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Retention for observations that are cheap to regenerate. */
const OBSERVATIONAL = { lifetime: "infinite", garbageCollection: 20 } as const;
/** Retention for exchanges with the board: the record is the point. */
const EVIDENTIARY = {
  lifetime: "infinite",
  garbageCollection: 10_000,
} as const;

const DevicesSchema = z.object({
  os: z.string(),
  candidates: z.array(z.string()).describe(
    "Serial device nodes found under /dev",
  ),
  selected: z.string().nullable().describe(
    "The configured device, or the single candidate, or null when ambiguous",
  ),
  observedAt: z.iso.datetime(),
});

const LinkSchema = z.object({
  device: z.string(),
  baud: z.number(),
  implementation: z.string().describe("repr(sys.implementation)"),
  release: z.string().describe("os.uname().release, e.g. 1.29.0"),
  version: z.string().describe("os.uname().version, build string with date"),
  machine: z.string().describe("os.uname().machine"),
  files: z.array(z.string()).describe(
    "Top-level files on the board's filesystem",
  ),
  firmwareRunning: z.boolean().describe(
    "True when a firmware answered with a JSON line after the soft reset",
  ),
  banner: z.string().describe("What the board printed after the soft reset"),
  transport: z.enum(["spawn", "socket"]).describe(
    "Per-call worker, or the holder",
  ),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const ReplSchema = z.object({
  code: z.string(),
  ok: z.boolean().describe("False when the code raised or timed out"),
  output: z.string().describe("stdout of the code"),
  error: z.string().describe("Traceback, empty when ok"),
  timedOut: z.boolean().describe(
    "True when the code had not finished within timeoutMs; output is partial",
  ),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const CommandSchema = z.object({
  command: z.string(),
  response: z.record(z.string(), z.unknown()).describe(
    "The parsed JSON reply line",
  ),
  raw: z.string().describe("Everything received while waiting"),
  recovered: z.boolean().describe(
    "True when the board was at a REPL prompt and had to be soft-reset first",
  ),
  timedOut: z.boolean().describe("True when the reply hit the hard timeout"),
  reason: z.string().describe("Why the wait ended: until, idle, or timeout"),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const CaptureSchema = z.object({
  timeoutMs: z.number(),
  data: z.string(),
  bytes: z.number(),
  reason: z.string().describe(
    "idle when the line went quiet, timeout when the cap was reached",
  ),
  observedAt: z.iso.datetime(),
});

const SentSchema = z.object({
  data: z.string(),
  bytes: z.number(),
  observedAt: z.iso.datetime(),
});

const FlashSchema = z.object({
  device: z.string(),
  chip: z.string(),
  image: z.string().describe("Image path as given, relative to the repo"),
  imageBytes: z.number(),
  imageSha256: z.string(),
  mac: z.string().describe("The chip's base MAC as esptool reports it"),
  chipDescription: z.string().describe("esptool's chip type line"),
  erased: z.boolean(),
  verified: z.boolean().describe("esptool verified the written hash"),
  esptoolVersion: z.string(),
  portBackAfterMs: z.number().describe(
    "How long the port took to re-enumerate",
  ),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const UploadSchema = z.object({
  files: z.array(z.object({
    name: z.string().describe("Name on the board"),
    source: z.string().describe("Local path, relative to the repo"),
    bytes: z.number(),
    sha256: z.string(),
    verified: z.boolean().describe("The board's sha256 of the file matches"),
  })),
  resumed: z.boolean().describe("Soft-reset afterwards so main.py runs"),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const WifiSchema = z.object({
  mac: z.string(),
  count: z.number().describe("Networks seen by the scan"),
  networks: z.array(z.object({
    ssid: z.string(),
    channel: z.number(),
    rssi: z.number(),
    auth: z.number(),
  })).describe("Strongest first, capped at `top`"),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const BleSchema = z.object({
  active: z.boolean(),
  addrType: z.number(),
  mac: z.string(),
  gapName: z.string(),
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const HolderSchema = z.object({
  live: z.boolean(),
  socket: z.string(),
  pid: z.number().nullable(),
  device: z.string().nullable().describe(
    "The port the holder has open, if any",
  ),
  requestsServed: z.number(),
  idleTimeoutMs: z.number(),
  observedAt: z.iso.datetime(),
});

/** The slice of swamp's method context these methods use. */
interface MethodContext {
  globalArgs: GlobalArgs;
  modelId: string;
  repoDir: string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  extensionFile: (relPath: string) => string;
}

const WORKER = "extensions/files/serial_worker.ts";
const CTRL_A = "\x01"; // raw REPL
const CTRL_B = "\x02"; // normal REPL
const CTRL_C = "\x03"; // interrupt
const CTRL_D = "\x04"; // soft reset (normal REPL) / end of input (raw REPL)

/**
 * ANSI escape sequences (CSI, OSC, DCS and friends, two-byte escapes) and
 * carriage returns, which MicroPython and the ESP ROM bootloader both emit
 * and which otherwise defeat end-anchored matching.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ESCAPE_RE = new RegExp(
  [
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`, // CSI
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC, BEL or ST terminated
    `${ESC}[PX^_][^${ESC}]*${ESC}\\\\`, // DCS / SOS / PM / APC
    `${ESC}[@-Z\\\\-_]`, // two-byte escapes
    "\\r",
  ].join("|"),
  "g",
);

/** Strip escape sequences and carriage returns. */
export function stripEscapes(s: string): string {
  return s.replace(ESCAPE_RE, "");
}

/**
 * Where the holder's unix socket lives for this model instance: a private
 * per-user directory and a 12-hex hash of the model id (see holder_paths).
 * One model instance is one board, so the instance is the identity.
 */
export async function holderSocketPath(modelId: string): Promise<string> {
  const dir = socketDir("swamp-esp32");
  await ensureSocketDir(dir);
  return await socketPathFor(dir, modelId);
}

/**
 * The holder's status when it is up, `null` when it is not, and a thrown
 * error when something is there but broken. `holder: false` short-circuits
 * to `null` without touching the socket.
 */
async function holderIfEnabled(
  ctx: MethodContext,
  socket: string,
): Promise<Awaited<ReturnType<typeof SerialLink.holderStatus>>> {
  if (!ctx.globalArgs.holder) return null;
  return await SerialLink.holderStatus(socket);
}

/**
 * Split a raw-REPL reply into stdout and stderr.
 *
 * After `code + Ctrl-D` the raw REPL answers `OK<stdout>\x04<stderr>\x04>`.
 * Anything before `OK` is leftover echo and is dropped.
 */
export function parseRawReply(
  data: string,
): { output: string; error: string; complete: boolean } {
  const start = data.indexOf("OK");
  const body = start >= 0 ? data.slice(start + 2) : data;
  const complete = body.endsWith(CTRL_D + ">");
  const [output = "", error = ""] = body.split(CTRL_D);
  return {
    output: stripEscapes(output),
    error: stripEscapes(error),
    complete,
  };
}

/** Find the last complete JSON object line in a chunk of serial output. */
export function lastJsonLine(data: string): Record<string, unknown> | null {
  const lines = stripEscapes(data).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        return JSON.parse(t) as Record<string, unknown>;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Pick the device: configured, else the single candidate, else null. */
export function selectDevice(
  configured: string | undefined,
  candidates: string[],
): string | null {
  if (configured) return configured;
  return candidates.length === 1 ? candidates[0] : null;
}

interface Attached {
  link: SerialLink;
  device: string;
  transport: "spawn" | "socket";
}

/**
 * Get a link to the board: through the holder when enabled and running,
 * else a per-call worker. Opens the port if the worker does not hold it,
 * resolving the device by auto-detect when none is configured, then lets
 * `settleMs` of stale bytes drain. Always closes (or disconnects).
 */
async function withLink<T>(
  ctx: MethodContext,
  fn: (a: Attached) => Promise<T>,
): Promise<T> {
  const g = ctx.globalArgs;
  const socket = await holderSocketPath(ctx.modelId);
  let link: SerialLink;
  let transport: "spawn" | "socket";
  if (await holderIfEnabled(ctx, socket)) {
    link = await SerialLink.create({ socketPath: socket });
    transport = "socket";
  } else {
    if (g.holder) {
      ctx.logger.warning(
        "holder not running; opening the port for this call only",
      );
    }
    link = await SerialLink.create({
      workerPath: ctx.extensionFile(WORKER),
      denoPath: g.denoPath,
    });
    transport = "spawn";
  }
  try {
    const st = await link.status();
    let device = st.open ? st.device! : null;
    if (!device) {
      device = await resolveDevice(ctx, link);
      const opened = await link.open(device, g.baud);
      if (!opened.ok) {
        throw new Error(`cannot open ${device}: ${opened.error ?? "unknown"}`);
      }
      if (g.settleMs > 0) await link.read(g.settleMs); // discard stale bytes
    }
    return await fn({ link, device, transport });
  } finally {
    await link.close();
  }
}

/** The configured device, or the one candidate on this host. */
async function resolveDevice(
  ctx: MethodContext,
  link: SerialLink,
): Promise<string> {
  const g = ctx.globalArgs;
  if (g.device) return g.device;
  const d = await link.detect();
  const chosen = selectDevice(undefined, d.candidates);
  if (!chosen) {
    throw new Error(
      d.candidates.length === 0
        ? "no serial device found; plug the board in, or set globalArgs.device"
        : `several serial devices found (${
          d.candidates.join(", ")
        }); set globalArgs.device`,
    );
  }
  ctx.logger.info("auto-detected {device}", { device: chosen });
  return chosen;
}

/**
 * Enter the raw REPL in three steps: leave raw mode if already in it, interrupt
 * whatever runs and wait for the normal prompt, then Ctrl-A and wait for the
 * raw prompt.
 *
 * Sending `Ctrl-C Ctrl-C Ctrl-A` in one write is not enough: when main.py is
 * interrupted the board prints its banner and restarts the REPL, and input
 * that arrives during that restart is discarded, so the Ctrl-A was lost about
 * one time in two (measured 2026-09-11 on the C3). Waiting for `>>>` first
 * makes the Ctrl-A land on a REPL that is reading.
 */
async function enterRaw(link: SerialLink, timeoutMs: number): Promise<void> {
  await link.write(CTRL_B);
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const normal = await link.query(CTRL_C, ">>>", timeoutMs);
    last = stripEscapes(normal.data ?? "");
    if (!normal.ok || !last.includes(">>>")) continue;
    const raw = await link.query(CTRL_A, "raw REPL", timeoutMs);
    last = stripEscapes(raw.data ?? "");
    if (raw.ok && last.includes("raw REPL")) return;
  }
  throw new Error(
    `board did not enter raw REPL (got ${JSON.stringify(last.slice(-120))}). ` +
      "Is MicroPython flashed and is this the right device?",
  );
}

/** Run Python in the raw REPL and return its stdout and traceback. */
async function execRaw(
  link: SerialLink,
  code: string,
  timeoutMs: number,
): Promise<{ output: string; error: string; complete: boolean }> {
  const r = await link.query(code + CTRL_D, CTRL_D + ">", timeoutMs);
  if (!r.ok) throw new Error(`raw REPL exchange failed: ${r.error}`);
  return parseRawReply(r.data ?? "");
}

/** Leave the raw REPL and soft-reset so main.py (the firmware) runs again. */
async function softReset(
  link: SerialLink,
  settleMs: number,
  idleMs: number,
): Promise<string> {
  await link.write(CTRL_B + CTRL_D);
  const r = await link.read(settleMs, idleMs);
  return stripEscapes(r.data ?? "");
}

const PROBE = [
  "import sys, os, json",
  "u = os.uname()",
  "print(json.dumps({'implementation': repr(sys.implementation), 'release': u.release,",
  "  'version': u.version, 'machine': u.machine, 'files': os.listdir()}))",
].join("\n");

/** Read the holder's state through a fresh connection, or report it down. */
async function holderState(
  ctx: MethodContext,
): Promise<z.infer<typeof HolderSchema>> {
  const socket = await holderSocketPath(ctx.modelId);
  const base = {
    socket,
    idleTimeoutMs: ctx.globalArgs.holderIdleTimeoutMs,
    observedAt: new Date().toISOString(),
  };
  const st = await SerialLink.holderStatus(socket);
  if (!st) {
    return { ...base, live: false, pid: null, device: null, requestsServed: 0 };
  }
  return {
    ...base,
    live: true,
    pid: st.pid,
    device: st.device,
    requestsServed: st.requestsServed,
  };
}

/** Hex sha256 of bytes. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const d = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Resolve a repo-relative or absolute path. */
function repoPath(ctx: MethodContext, p: string): string {
  return p.startsWith("/") ? p : `${ctx.repoDir}/${p}`;
}

/** The device path without opening it: configured, or the one candidate. */
async function deviceWithoutOpening(ctx: MethodContext): Promise<string> {
  if (ctx.globalArgs.device) return ctx.globalArgs.device;
  const link = await SerialLink.create({
    workerPath: ctx.extensionFile(WORKER),
    denoPath: ctx.globalArgs.denoPath,
  });
  try {
    return await resolveDevice(ctx, link);
  } finally {
    await link.close();
  }
}

/** Python that prints one JSON line with a file's size and sha256. */
function hashProbe(name: string): string {
  return [
    "import os, json, hashlib, binascii",
    `_f = open(${JSON.stringify(name)}, 'rb')`,
    "_h = hashlib.sha256()",
    "_n = 0",
    "while True:",
    "    _b = _f.read(512)",
    "    if not _b: break",
    "    _h.update(_b); _n += len(_b)",
    "_f.close()",
    "print(json.dumps({'bytes': _n, 'sha256': binascii.hexlify(_h.digest()).decode()}))",
  ].join("\n");
}

/** Model definition for an ESP32 running MicroPython, over USB serial. */
export const model = {
  type: "@vcjdeboer/esp32-serial",
  version: "2026.09.11.5",
  globalArguments: GlobalArgsSchema,
  resources: {
    "devices": {
      description:
        "Serial device nodes on this host and which one this model would use",
      schema: DevicesSchema,
      ...OBSERVATIONAL,
    },
    "link": {
      description:
        "What the board reported about itself when the link was established",
      schema: LinkSchema,
      ...OBSERVATIONAL,
    },
    "repl": {
      description:
        "One Python snippet run through the raw REPL, with its stdout and traceback",
      schema: ReplSchema,
      ...EVIDENTIARY,
    },
    "command": {
      description:
        "One command line and the JSON object the firmware answered with",
      schema: CommandSchema,
      ...EVIDENTIARY,
    },
    "capture": {
      description: "Whatever the board printed during a timed listen",
      schema: CaptureSchema,
      ...EVIDENTIARY,
    },
    "sent": {
      description: "Raw bytes written to the board without waiting for a reply",
      schema: SentSchema,
      ...EVIDENTIARY,
    },
    "flash": {
      description:
        "One esptool flash of a MicroPython image, with the chip's MAC and the image hash",
      schema: FlashSchema,
      ...EVIDENTIARY,
    },
    "upload": {
      description:
        "Files written to the board's filesystem through the raw REPL, hash-verified",
      schema: UploadSchema,
      ...EVIDENTIARY,
    },
    "wifi": {
      description:
        "A WiFi scan from the board: what it can see and how strongly",
      schema: WifiSchema,
      ...EVIDENTIARY,
    },
    "ble": {
      description: "Bluetooth LE brought up on the board and its address",
      schema: BleSchema,
      ...EVIDENTIARY,
    },
    "holder": {
      description:
        "Whether a detached worker is keeping the port open, and what it holds",
      schema: HolderSchema,
      ...OBSERVATIONAL,
    },
  },
  methods: {
    detect: {
      description:
        "List serial device nodes on this host (cu.usbmodem* on macOS, ttyACM*/ttyUSB* " +
        "on Linux) without opening any, and record which one this model would use.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const link = await SerialLink.create({
          workerPath: ctx.extensionFile(WORKER),
          denoPath: g.denoPath,
        });
        let d;
        try {
          d = await link.detect();
        } finally {
          await link.close();
        }
        const selected = selectDevice(g.device, d.candidates);
        ctx.logger.info("{n} candidate(s); selected {selected}", {
          n: d.candidates.length,
          selected: selected ?? "none",
        });
        const handle = await ctx.writeResource("devices", "devices-host", {
          os: d.os,
          candidates: d.candidates,
          selected,
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    establish: {
      description:
        "Open the port, interrupt whatever runs, identify the MicroPython build " +
        "and list the board's files through the raw REPL, then soft-reset so the " +
        "firmware (main.py) runs again. Records the board's identity as `link`.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const t0 = performance.now();
        const data = await withLink(
          ctx,
          async ({ link, device, transport }) => {
            await enterRaw(link, g.timeoutMs);
            const probe = await execRaw(link, PROBE, g.timeoutMs);
            if (probe.error) {
              throw new Error(
                `probe raised on the board: ${probe.error}`,
              );
            }
            const info = lastJsonLine(probe.output);
            if (!info) {
              throw new Error(
                `probe returned no JSON: ${probe.output}`,
              );
            }
            const banner = await softReset(link, 1500, 300);
            const firmwareRunning = lastJsonLine(banner)?.fw !== undefined;
            return { info, banner, firmwareRunning, device, transport };
          },
        );
        ctx.logger.info(
          "established {device}: MicroPython {release} on {machine}",
          {
            device: data.device,
            release: data.info.release,
            machine: data.info.machine,
            firmwareRunning: data.firmwareRunning,
            transport: data.transport,
          },
        );
        const handle = await ctx.writeResource("link", "link-current", {
          device: data.device,
          baud: g.baud,
          implementation: String(data.info.implementation),
          release: String(data.info.release),
          version: String(data.info.version),
          machine: String(data.info.machine),
          files: data.info.files as string[],
          firmwareRunning: data.firmwareRunning,
          banner: data.banner,
          transport: data.transport,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        return { dataHandles: [handle] };
      },
    },

    repl: {
      description:
        "Run Python on the board through the raw REPL and record stdout and any " +
        "traceback. Interrupts the firmware; pass resume=true to soft-reset " +
        "afterwards so main.py runs again. A Python exception is recorded " +
        "(ok=false), not thrown; only a broken link throws. Code that runs " +
        "longer than timeoutMs is recorded as timedOut with partial output.",
      arguments: z.object({
        code: z.string().describe("Python source; may span lines"),
        timeoutMs: z.number().int().positive().optional().describe(
          "Wait for the code to finish; defaults to the global timeoutMs",
        ),
        resume: z.boolean().default(false).describe(
          "Soft-reset afterwards so the firmware runs again",
        ),
      }),
      execute: async (
        args: { code: string; timeoutMs?: number; resume: boolean },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const timeoutMs = args.timeoutMs ?? g.timeoutMs;
        const t0 = performance.now();
        const result = await withLink(ctx, async ({ link }) => {
          await enterRaw(link, g.timeoutMs);
          const r = await execRaw(link, args.code, timeoutMs);
          if (args.resume) await softReset(link, 500, g.idleMs);
          else await link.write(CTRL_B);
          return r;
        });
        if (result.error) {
          ctx.logger.warning("repl code raised: {error}", {
            error: result.error.trim(),
          });
        }
        if (!result.complete) {
          ctx.logger.warning(
            "code did not finish within {timeoutMs} ms; output is partial. Pass a larger timeoutMs.",
            { timeoutMs },
          );
        }
        const handle = await ctx.writeResource("repl", "repl-latest", {
          code: args.code,
          ok: result.error === "" && result.complete,
          output: result.output,
          error: result.error,
          timedOut: !result.complete,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        return { dataHandles: [handle] };
      },
    },

    command: {
      description:
        "Send one line to a firmware that answers one JSON object per line, and " +
        "record the reply. If the board is at a REPL prompt instead of running " +
        "main.py, soft-resets once and retries. No JSON within timeoutMs is " +
        "recorded as timedOut with the raw bytes, then thrown.",
      arguments: z.object({
        line: z.string().describe("The command line, without newline"),
        timeoutMs: z.number().int().positive().optional(),
      }),
      execute: async (
        args: { line: string; timeoutMs?: number },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const timeoutMs = args.timeoutMs ?? g.timeoutMs;
        const t0 = performance.now();
        const result = await withLink(ctx, async ({ link }) => {
          let recovered = false;
          let r = await link.query(args.line + "\n", "}", timeoutMs, g.idleMs);
          let response = lastJsonLine(r.data ?? "");
          if (
            !response && /(>>>|raw REPL|^>)/m.test(stripEscapes(r.data ?? ""))
          ) {
            ctx.logger.warning(
              "board is at a REPL prompt; soft-resetting to start the firmware",
            );
            recovered = true;
            await softReset(link, 1500, 300);
            r = await link.query(args.line + "\n", "}", timeoutMs, g.idleMs);
            response = lastJsonLine(r.data ?? "");
          }
          return {
            response,
            raw: stripEscapes(r.data ?? ""),
            recovered,
            reason: r.reason ?? "timeout",
          };
        });
        const timedOut = result.reason === "timeout";
        const handle = await ctx.writeResource("command", "command-latest", {
          command: args.line,
          response: result.response ?? {},
          raw: result.raw,
          recovered: result.recovered,
          timedOut,
          reason: result.reason,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        if (!result.response) {
          throw new Error(
            `no JSON reply to ${
              JSON.stringify(args.line)
            } within ${timeoutMs} ms ` +
              `(got ${
                JSON.stringify(result.raw.slice(-160))
              }; recorded as command-latest). ` +
              "Is a firmware that answers JSON lines on the board? Run `establish` to check `files`.",
          );
        }
        return { dataHandles: [handle] };
      },
    },

    read: {
      description:
        "Listen for up to timeoutMs and record whatever the board prints, without " +
        "sending anything. Stops early once output has arrived and the line has " +
        "been silent for idleMs. Useful for a firmware that streams events.",
      arguments: z.object({
        timeoutMs: z.number().int().positive().optional(),
        idleMs: z.number().int().positive().optional().describe(
          "Silence that ends the listen once something arrived; defaults to the global idleMs",
        ),
      }),
      execute: async (
        args: { timeoutMs?: number; idleMs?: number },
        ctx: MethodContext,
      ) => {
        const timeoutMs = args.timeoutMs ?? ctx.globalArgs.timeoutMs;
        const idleMs = args.idleMs ?? ctx.globalArgs.idleMs;
        const r = await withLink(ctx, async ({ link }) => {
          const r = await link.read(timeoutMs, idleMs);
          if (!r.ok) throw new Error(`read failed: ${r.error}`);
          return r;
        });
        const data = stripEscapes(r.data ?? "");
        const handle = await ctx.writeResource("capture", "capture-latest", {
          timeoutMs,
          data,
          bytes: new TextEncoder().encode(data).length,
          reason: r.reason ?? "timeout",
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    write: {
      description:
        "Write raw bytes to the board and record them, without waiting for a " +
        "reply. Escape sequences are sent as given (e.g. \\x04 for Ctrl-D).",
      arguments: z.object({
        data: z.string().describe("Exact bytes to send, as a string"),
      }),
      execute: async (args: { data: string }, ctx: MethodContext) => {
        await withLink(ctx, async ({ link }) => {
          const r = await link.write(args.data);
          if (!r.ok) throw new Error(`write failed: ${r.error}`);
        });
        const handle = await ctx.writeResource("sent", "sent-latest", {
          data: args.data,
          bytes: new TextEncoder().encode(args.data).length,
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    flash: {
      description:
        "Erase and write a MicroPython image with esptool, then wait for the " +
        "port to come back. Runs esptool inside the serial worker (a real " +
        "deno child), because its stub handshake stalls when spawned from " +
        "swamp's own runtime. Records the chip's MAC, the image hash and " +
        "esptool's verification. Needs esptool on PATH. esptool is run inside " +
        "the serial worker (a normal deno child), because spawning it directly " +
        "from swamp's compiled runtime stalls its serial connect (measured " +
        "2026-09-11); the worker sidesteps that, so this runs reliably under " +
        "swamp. `flash.ts` does the same from a shell if you prefer.",
      arguments: z.object({
        image: z.string().describe(
          "Image file, relative to the repo or absolute",
        ),
        chip: z.string().default("esp32c3").describe("esptool --chip value"),
        erase: z.boolean().default(true).describe(
          "Erase all flash before writing",
        ),
        flashBaud: z.number().int().positive().default(460800),
        esptoolPath: z.string().default("esptool").describe("esptool binary"),
        flashTimeoutMs: z.number().int().positive().default(120_000).describe(
          "esptool timeout; named flashTimeoutMs so the global timeoutMs does not clobber it",
        ),
      }),
      execute: async (
        args: {
          image: string;
          chip: string;
          erase: boolean;
          flashBaud: number;
          esptoolPath: string;
          flashTimeoutMs: number;
        },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const t0 = performance.now();
        const imagePath = repoPath(ctx, args.image);
        const bytes = await Deno.readFile(imagePath);
        const imageSha256 = await sha256Hex(bytes);
        const device = await deviceWithoutOpening(ctx);

        // esptool must run OUTSIDE swamp's process tree: spawned as a
        // descendant of the swamp method, its stub/connect handshake stalls
        // (measured 2026-09-11). The detached holder is reparented to init,
        // so its esptool child is clear of swamp. Prefer the holder; require
        // it, since a per-call spawn worker is still inside the tree.
        const socket = await holderSocketPath(ctx.modelId);
        let holder = await SerialLink.holderStatus(socket);
        if (!holder) {
          ctx.logger.info(
            "starting a detached holder to run esptool outside swamp's process tree",
          );
          await SerialLink.spawnHolder({
            workerPath: ctx.extensionFile(WORKER),
            socketPath: socket,
            denoPath: g.denoPath,
            idleTimeoutMs: g.holderIdleTimeoutMs,
          });
          holder = await SerialLink.holderStatus(socket);
        }
        if (!holder) throw new Error("could not start a holder for flashing");

        const link = await SerialLink.create({
          socketPath: socket,
          callTimeoutMs: args.flashTimeoutMs + 20_000,
        });
        const r = await link.flash({
          device,
          image: imagePath,
          chip: args.chip,
          erase: args.erase,
          flashBaud: args.flashBaud,
          esptoolPath: args.esptoolPath,
          timeoutMs: args.flashTimeoutMs,
        });
        if (!r.ok) throw new Error(`flash failed in the holder: ${r.error}`);

        ctx.logger.info("flashed {chip} {mac} with {image} ({verified})", {
          chip: args.chip,
          mac: r.mac,
          image: args.image,
          verified: r.verified ? "verified" : "NOT verified",
        });
        const handle = await ctx.writeResource("flash", "flash-latest", {
          device,
          chip: args.chip,
          image: args.image,
          imageBytes: bytes.length,
          imageSha256,
          mac: r.mac,
          chipDescription: r.chipDescription,
          erased: r.erased,
          verified: r.verified,
          esptoolVersion: r.esptoolVersion,
          portBackAfterMs: r.portBackAfterMs,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        if (!r.verified) {
          throw new Error(
            "esptool did not verify the written image (recorded as flash-latest)",
          );
        }
        return { dataHandles: [handle] };
      },
    },

    upload: {
      description:
        "Write local files onto the board's filesystem through the raw REPL " +
        "(no mpremote needed), verify each by sha256 on the board, and " +
        "soft-reset so main.py runs. Records names, sizes and hashes.",
      arguments: z.object({
        files: z.array(z.string()).min(1)
          .describe(
            "Local paths, relative to the repo; the basename is the name on the board",
          ),
        resume: z.boolean().default(true),
        writeMs: z.number().int().positive().default(10_000).describe(
          "Per-write timeout; named writeMs so the global timeoutMs does not clobber it",
        ),
      }),
      execute: async (
        args: { files: string[]; resume: boolean; writeMs: number },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const t0 = performance.now();
        const results = await withLink(ctx, async ({ link }) => {
          await enterRaw(link, g.timeoutMs);
          const out: z.infer<typeof UploadSchema>["files"] = [];
          for (const source of args.files) {
            const name = source.split("/").pop()!;
            const text = await Deno.readTextFile(repoPath(ctx, source));
            const bytes = new TextEncoder().encode(text);
            const sha = await sha256Hex(bytes);
            const open = await execRaw(
              link,
              `_f = open(${JSON.stringify(name)}, 'w')`,
              args.writeMs,
            );
            if (open.error) {
              throw new Error(`open ${name} on the board: ${open.error}`);
            }
            for (let i = 0; i < text.length; i += 1024) {
              const chunk = text.slice(i, i + 1024);
              const w = await execRaw(
                link,
                `_f.write(${JSON.stringify(chunk)})`,
                args.writeMs,
              );
              if (w.error) {
                throw new Error(`write ${name} on the board: ${w.error}`);
              }
            }
            const close = await execRaw(link, "_f.close()", args.writeMs);
            if (close.error) {
              throw new Error(`close ${name} on the board: ${close.error}`);
            }
            const probe = await execRaw(link, hashProbe(name), args.writeMs);
            const got = lastJsonLine(probe.output) as {
              bytes?: number;
              sha256?: string;
            } | null;
            const verified = got?.sha256 === sha && got?.bytes === bytes.length;
            if (!verified) {
              ctx.logger.warning("{name}: board hash/size mismatch ({got})", {
                name,
                got: JSON.stringify(got),
              });
            }
            out.push({
              name,
              source,
              bytes: bytes.length,
              sha256: sha,
              verified,
            });
          }
          if (args.resume) await softReset(link, 1500, 300);
          else await link.write(CTRL_B);
          return out;
        });
        ctx.logger.info("uploaded {n} file(s): {names}", {
          n: results.length,
          names: results.map((f) =>
            `${f.name}${f.verified ? "" : " (UNVERIFIED)"}`
          ).join(", "),
        });
        const handle = await ctx.writeResource("upload", "upload-latest", {
          files: results,
          resumed: args.resume,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        if (results.some((f) => !f.verified)) {
          throw new Error(
            "a file did not verify on the board (recorded as upload-latest)",
          );
        }
        return { dataHandles: [handle] };
      },
    },

    wifi: {
      description:
        "Bring the WiFi station interface up, scan, and record the board's MAC " +
        "and the networks seen (strongest first). Joins nothing. Interrupts " +
        "the firmware; resume=true (default) soft-resets afterwards.",
      arguments: z.object({
        top: z.number().int().positive().default(10).describe(
          "How many networks to record",
        ),
        resume: z.boolean().default(true),
        scanMs: z.number().int().positive().default(15_000).describe(
          "Wait for the scan; named scanMs so the global timeoutMs does not clobber this default",
        ),
      }),
      execute: async (
        args: { top: number; resume: boolean; scanMs: number },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const t0 = performance.now();
        const code = [
          "import network, json",
          "_w = network.WLAN(network.STA_IF)",
          "_w.active(True)",
          "_mac = ':'.join('%02x' % b for b in _w.config('mac'))",
          "_nets = _w.scan()",
          "_nets.sort(key=lambda n: -n[3])",
          "_out = []",
          `for _s, _b, _ch, _rssi, _auth, _hid in _nets[:${args.top}]:`,
          "    try:",
          "        _name = _s.decode()",
          "    except Exception:",
          "        _name = str(_s)",
          "    _out.append({'ssid': _name, 'channel': _ch, 'rssi': _rssi, 'auth': _auth})",
          "_w.active(False)",
          "print(json.dumps({'mac': _mac, 'count': len(_nets), 'networks': _out}))",
        ].join("\n");
        const r = await withLink(ctx, async ({ link }) => {
          await enterRaw(link, g.timeoutMs);
          const r = await execRaw(link, code, args.scanMs);
          if (args.resume) await softReset(link, 1500, 300);
          else await link.write(CTRL_B);
          return r;
        });
        if (r.error) {
          throw new Error(`wifi scan raised on the board: ${r.error.trim()}`);
        }
        if (!r.complete) {
          throw new Error(`wifi scan did not finish within ${args.scanMs} ms`);
        }
        const scan = lastJsonLine(r.output) as
          | {
            mac: string;
            count: number;
            networks: z.infer<typeof WifiSchema>["networks"];
          }
          | null;
        if (!scan) throw new Error(`wifi scan returned no JSON: ${r.output}`);
        ctx.logger.info("wifi {mac}: {count} network(s)", {
          mac: scan.mac,
          count: scan.count,
        });
        const handle = await ctx.writeResource("wifi", "wifi-latest", {
          mac: scan.mac,
          count: scan.count,
          networks: scan.networks,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        return { dataHandles: [handle] };
      },
    },

    ble: {
      description:
        "Bring Bluetooth LE up, record its address and the GAP name, and bring " +
        "it down again. Advertises nothing. Interrupts the firmware; " +
        "resume=true (default) soft-resets afterwards.",
      arguments: z.object({
        gapName: z.string().default("esp32"),
        resume: z.boolean().default(true),
        probeMs: z.number().int().positive().default(8_000).describe(
          "Wait for the probe; named probeMs so the global timeoutMs does not clobber it",
        ),
      }),
      execute: async (
        args: { gapName: string; resume: boolean; probeMs: number },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const t0 = performance.now();
        const code = [
          "import bluetooth, json",
          "_b = bluetooth.BLE()",
          "_b.active(True)",
          `_b.config(gap_name=${JSON.stringify(args.gapName)})`,
          "_t, _m = _b.config('mac')",
          "_n = _b.config('gap_name')",
          "_a = _b.active()",
          "_b.active(False)",
          "print(json.dumps({'active': _a, 'addrType': _t, 'mac': ':'.join('%02x' % x for x in _m), 'gapName': _n.decode() if isinstance(_n, bytes) else str(_n)}))",
        ].join("\n");
        const r = await withLink(ctx, async ({ link }) => {
          await enterRaw(link, g.timeoutMs);
          const r = await execRaw(link, code, args.probeMs);
          if (args.resume) await softReset(link, 1500, 300);
          else await link.write(CTRL_B);
          return r;
        });
        if (r.error) {
          throw new Error(`ble probe raised on the board: ${r.error.trim()}`);
        }
        if (!r.complete) {
          throw new Error(`ble probe did not finish within ${args.probeMs} ms`);
        }
        const b = lastJsonLine(r.output) as
          | { active: boolean; addrType: number; mac: string; gapName: string }
          | null;
        if (!b) throw new Error(`ble probe returned no JSON: ${r.output}`);
        ctx.logger.info("ble {mac} active={active}", {
          mac: b.mac,
          active: b.active,
        });
        const handle = await ctx.writeResource("ble", "ble-latest", {
          active: b.active,
          addrType: b.addrType,
          mac: b.mac,
          gapName: b.gapName,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        return { dataHandles: [handle] };
      },
    },

    hold: {
      description:
        "Start a detached worker that keeps the port open between calls (idempotent: " +
        "reports the running one). Methods use it automatically while " +
        "globalArgs.holder is true. It exits on `release` or after " +
        "holderIdleTimeoutMs without a request.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const g = ctx.globalArgs;
        const socket = await holderSocketPath(ctx.modelId);
        if (!(await SerialLink.holderStatus(socket))) {
          const pid = await SerialLink.spawnHolder({
            workerPath: ctx.extensionFile(WORKER),
            socketPath: socket,
            denoPath: g.denoPath,
            idleTimeoutMs: g.holderIdleTimeoutMs,
          });
          ctx.logger.info("holder started, pid {pid}, socket {socket}", {
            pid,
            socket,
          });
        }
        // Open the port now, so the first real call does not pay for it.
        const link = await SerialLink.create({ socketPath: socket });
        try {
          const st = await link.status();
          if (!st.open) {
            const device = await resolveDevice(ctx, link);
            const opened = await link.open(device, g.baud);
            if (!opened.ok) {
              throw new Error(
                `cannot open ${device}: ${opened.error ?? "unknown"}`,
              );
            }
          }
        } finally {
          await link.close();
        }
        if (!g.holder) {
          ctx.logger.warning(
            "holder is running but globalArgs.holder is false; methods will not use it",
          );
        }
        const handle = await ctx.writeResource(
          "holder",
          "holder-current",
          await holderState(ctx),
        );
        return { dataHandles: [handle] };
      },
    },

    release: {
      description:
        "Stop the holder: close the port and let the detached worker exit. " +
        "Safe when none is running.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const socket = await holderSocketPath(ctx.modelId);
        const before = await holderState(ctx);
        if (before.live) {
          const link = await SerialLink.create({ socketPath: socket });
          await link.release();
          ctx.logger.info("holder pid {pid} released", { pid: before.pid });
        }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && await SerialLink.holderLive(socket)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const handle = await ctx.writeResource("holder", "holder-current", {
          ...before,
          live: await SerialLink.holderLive(socket),
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
