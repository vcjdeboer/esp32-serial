/**
 * Device-agnostic connection glue shared by the models in this extension.
 *
 * This is the boundary between the transport (`serial_link.ts` /
 * `serial_worker.ts` / `holder_paths.ts` — bytes and lines over a port, plus
 * flashing and a detached holder) and each model's own protocol semantics
 * (`esp32_serial.ts` speaks MicroPython's REPL and a simple line protocol;
 * `uc2_device.ts` speaks the UC2-ESP structured task protocol). Everything
 * here knows how to *get a link to a board and record holder state*, and
 * nothing about what you then say over that link.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { SerialLink } from "./serial_link.ts";
import { ensureSocketDir, socketDir, socketPathFor } from "./holder_paths.ts";

/** The worker script, relative to the extension root. */
export const WORKER = "extensions/files/serial_worker.ts";

/** Global arguments any serial-device model needs for the transport. */
export interface DeviceGlobals {
  device?: string;
  baud: number;
  settleMs: number;
  holder: boolean;
  holderIdleTimeoutMs: number;
  denoPath?: string;
}

/** The slice of swamp's method context the shared glue uses. */
export interface DeviceCtx {
  globalArgs: DeviceGlobals;
  modelId: string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  extensionFile: (relPath: string) => string;
}

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

/** Strip ANSI escape sequences and carriage returns. */
export function stripEscapes(s: string): string {
  return s.replace(ESCAPE_RE, "");
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

/** Parse every complete JSON object line in a chunk (order preserved). */
export function jsonLines(data: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stripEscapes(data).split("\n")) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        out.push(JSON.parse(t) as Record<string, unknown>);
      } catch { /* skip noise */ }
    }
  }
  return out;
}

/** Pick the device: configured, else the single candidate, else null. */
export function selectDevice(
  configured: string | undefined,
  candidates: string[],
): string | null {
  if (configured) return configured;
  return candidates.length === 1 ? candidates[0] : null;
}

/** Where this model instance's holder socket lives (private, hashed, bounded). */
export async function holderSocketPath(modelId: string): Promise<string> {
  const dir = socketDir("swamp-esp32");
  await ensureSocketDir(dir);
  return await socketPathFor(dir, modelId);
}

/** The holder's status when up, null when down; only when `holder` is on. */
export function holderIfEnabled(
  ctx: DeviceCtx,
  socket: string,
): Promise<Awaited<ReturnType<typeof SerialLink.holderStatus>>> {
  if (!ctx.globalArgs.holder) return Promise.resolve(null);
  return SerialLink.holderStatus(socket);
}

/** A live link plus the resolved device and which transport carried it. */
export interface Attached {
  link: SerialLink;
  device: string;
  transport: "spawn" | "socket";
}

/** The configured device, or the one candidate on this host. */
export async function resolveDevice(
  ctx: DeviceCtx,
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
 * Get a link to the board: through the holder when enabled and running, else a
 * per-call worker. Opens the port if the worker does not already hold it,
 * resolving the device by auto-detect when none is configured, then drains
 * `settleMs` of stale bytes. Always closes (or disconnects).
 */
export async function withLink<T>(
  ctx: DeviceCtx,
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

/** Every device record carries an explicit outcome (see swamp lab #1430). */
export const OUTCOME = z.string().describe(
  "Run result: ok, error, partial, or timeout",
);

/** Serial device nodes on this host and which one the model would use. */
export const DevicesSchema = z.object({
  os: z.string(),
  candidates: z.array(z.string()).describe("Serial device nodes under /dev"),
  selected: z.string().nullable().describe(
    "The configured device, or the single candidate, or null when ambiguous",
  ),
  outcome: OUTCOME,
  observedAt: z.iso.datetime(),
});

/** Whether a detached worker is keeping the port open, and what it holds. */
export const HolderSchema = z.object({
  live: z.boolean(),
  socket: z.string(),
  pid: z.number().nullable(),
  device: z.string().nullable().describe(
    "The port the holder has open, if any",
  ),
  requestsServed: z.number(),
  idleTimeoutMs: z.number(),
  outcome: OUTCOME,
  observedAt: z.iso.datetime(),
});

/** Read the holder's state through a fresh connection, or report it down. */
export async function holderState(
  ctx: DeviceCtx & { globalArgs: { holderIdleTimeoutMs: number } },
): Promise<z.infer<typeof HolderSchema>> {
  const socket = await holderSocketPath(ctx.modelId);
  const base = {
    socket,
    idleTimeoutMs: ctx.globalArgs.holderIdleTimeoutMs,
    observedAt: new Date().toISOString(),
  };
  const st = await SerialLink.holderStatus(socket);
  if (!st) {
    return {
      ...base,
      live: false,
      pid: null,
      device: null,
      requestsServed: 0,
      outcome: "error",
    };
  }
  return {
    ...base,
    live: true,
    pid: st.pid,
    device: st.device,
    requestsServed: st.requestsServed,
    outcome: "ok",
  };
}
