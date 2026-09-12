/**
 * `@vcjdeboer/uc2-device`: a device whose firmware speaks the UC2-ESP
 * structured task protocol, reached over USB serial from swamp.
 *
 * Where `esp32-serial` speaks MicroPython's REPL and a bare one-JSON-line
 * protocol, this model speaks the request/response shape from UC2-ESP
 * (Diederich et al., J. Microscopy 2026): each request is a JSON object
 * `{ "task": "/endpoint", "qid": <n>, ... }`, and the board answers with an
 * immediate ACK echoing the qid, then optional async events, then a final
 * DONE carrying the result — all correlated by the request id. `act` runs a
 * command endpoint (`/motor_act`, `/laser_act`, ...); `get` reads a state
 * endpoint (`/motor_get`, ...).
 *
 * It shares the transport and holder with `esp32-serial` through
 * `_lib/device.ts`; only the protocol on top differs. That is the boundary:
 * the transport moves lines, this model gives them qid/ACK/DONE meaning.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { SerialLink } from "./_lib/serial_link.ts";
import {
  type DeviceCtx,
  DevicesSchema,
  HolderSchema,
  holderSocketPath,
  holderState,
  jsonLines,
  OUTCOME,
  resolveDevice,
  selectDevice,
  stripEscapes,
  withLink,
  WORKER,
} from "./_lib/device.ts";

const GlobalArgsSchema = z.object({
  device: z.string().optional().describe(
    "Serial device path: /dev/cu.usbmodemXXXX on macOS, /dev/ttyACM0 on Linux. " +
      "Leave unset to auto-detect a single attached board.",
  ),
  baud: z.number().int().positive().default(115200),
  timeoutMs: z.number().int().positive().default(5000).describe(
    "Hard cap on waiting for a request's final reply.",
  ),
  idleMs: z.number().int().positive().default(150).describe(
    "Silence that ends a read burst once bytes have arrived.",
  ),
  settleMs: z.number().int().nonnegative().default(100).describe(
    "Discard this many ms of stale bytes after opening the port.",
  ),
  holder: z.boolean().default(false).describe(
    "Keep the port open between calls in a detached worker (start with `hold`).",
  ),
  holderIdleTimeoutMs: z.number().int().positive().default(15 * 60_000),
  denoPath: z.string().optional(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const OBSERVATIONAL = { lifetime: "infinite", garbageCollection: 20 } as const;
const EVIDENTIARY = {
  lifetime: "infinite",
  garbageCollection: 10_000,
} as const;

const ActSchema = z.object({
  task: z.string().describe("The endpoint, e.g. /motor_act"),
  qid: z.number().describe("The request id correlated across ACK/event/DONE"),
  args: z.record(z.string(), z.unknown()).describe(
    "Parameters sent with the task",
  ),
  acked: z.boolean().describe("True when the board echoed the qid as an ACK"),
  events: z.array(z.record(z.string(), z.unknown())).describe(
    "Async event lines for this qid seen before the final reply",
  ),
  result: z.record(z.string(), z.unknown()).describe("The final DONE object"),
  raw: z.string().describe("Everything received while waiting"),
  outcome: OUTCOME,
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

const StateSchema = z.object({
  task: z.string().describe("The GET endpoint, e.g. /motor_get"),
  qid: z.number(),
  state: z.record(z.string(), z.unknown()).describe(
    "The state the board returned",
  ),
  raw: z.string(),
  outcome: OUTCOME,
  observedAt: z.iso.datetime(),
  elapsedMs: z.number(),
});

/** The method context this model uses (transport glue plus writeResource). */
interface MethodContext extends DeviceCtx {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The correlated outcome of one UC2 request. */
export interface Exchange {
  acked: boolean;
  events: Record<string, unknown>[];
  final: Record<string, unknown> | null;
  raw: string;
}

/** A line with our qid that is only an acknowledgement, not a payload. */
function isAck(obj: Record<string, unknown>): boolean {
  if ("ack" in obj) return true;
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === "qid";
}

/** True when a line for our qid is the final reply, given the mode. */
function isFinal(obj: Record<string, unknown>, mode: "act" | "get"): boolean {
  if (typeof obj.qid === "number" && obj.qid < 0) return true; // error qid
  if (isAck(obj)) return false;
  if (mode === "get") return true; // a GET's payload line is the answer
  return "result" in obj || "success" in obj || "done" in obj || "state" in obj;
}

/**
 * Send one UC2 request and correlate the reply stream by qid: collect the
 * interim ACK and any async events, and stop at the final DONE (or the hard
 * timeout). Exported so tests can drive it against a fake board.
 */
export async function exchange(
  link: SerialLink,
  message: Record<string, unknown>,
  qid: number,
  opts: { timeoutMs: number; idleMs: number; mode: "act" | "get" },
): Promise<Exchange> {
  await link.write(JSON.stringify({ ...message, qid }) + "\n");
  const deadline = Date.now() + opts.timeoutMs;
  let raw = "";
  let acked = false;
  const events: Record<string, unknown>[] = [];
  let final: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const budget = Math.min(700, deadline - Date.now());
    const r = await link.read(budget, opts.idleMs);
    raw += r.data ?? "";
    for (const obj of jsonLines(r.data ?? "")) {
      if (typeof obj.qid === "number" && obj.qid !== qid && obj.qid >= 0) {
        continue; // a reply for a different request
      }
      if (isFinal(obj, opts.mode)) {
        final = obj;
      } else if (isAck(obj)) {
        acked = true;
      } else {
        events.push(obj);
      }
    }
    if (final) break;
  }
  return { acked, events, final, raw: stripEscapes(raw) };
}

let _qid = 0;
/** Next request id. Positive and monotonic within this process. */
function nextQid(): number {
  _qid = (_qid % 1_000_000) + 1;
  return _qid;
}

/** Model definition for a UC2-ESP structured-protocol device over USB serial. */
export const model = {
  type: "@vcjdeboer/uc2-device",
  version: "2026.09.12.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "devices": {
      description:
        "Serial device nodes on this host and which one this model would use",
      schema: DevicesSchema,
      ...OBSERVATIONAL,
    },
    "act": {
      description:
        "One UC2 ACT request and the ACK/events/DONE the board answered with",
      schema: ActSchema,
      ...EVIDENTIARY,
    },
    "state": {
      description: "One UC2 GET request and the state the board returned",
      schema: StateSchema,
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
        "List serial device nodes on this host without opening any, and record " +
        "which one this model would use.",
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
        const handle = await ctx.writeResource("devices", "devices-host", {
          os: d.os,
          candidates: d.candidates,
          selected,
          outcome: "ok",
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    act: {
      description:
        "Run a UC2 ACT endpoint: send {task, qid, ...args}, correlate the board's " +
        "ACK, async events and final DONE by qid, and record the exchange. A " +
        "missing DONE within timeoutMs is recorded as outcome=timeout, then thrown.",
      arguments: z.object({
        task: z.string().describe("The ACT endpoint, e.g. /motor_act"),
        args: z.record(z.string(), z.unknown()).default({}).describe(
          "Parameters merged into the request object",
        ),
        timeoutMs: z.number().int().positive().optional(),
      }),
      execute: async (
        args: {
          task: string;
          args: Record<string, unknown>;
          timeoutMs?: number;
        },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const timeoutMs = args.timeoutMs ?? g.timeoutMs;
        const qid = nextQid();
        const t0 = performance.now();
        const ex = await withLink(
          ctx,
          ({ link }) =>
            exchange(link, { task: args.task, ...args.args }, qid, {
              timeoutMs,
              idleMs: g.idleMs,
              mode: "act",
            }),
        );
        const errored = typeof ex.final?.qid === "number" &&
          (ex.final.qid as number) < 0;
        const outcome = ex.final ? (errored ? "error" : "ok") : "timeout";
        ctx.logger.info("act {task} qid {qid}: {outcome} ({events} events)", {
          task: args.task,
          qid,
          outcome,
          events: ex.events.length,
        });
        const handle = await ctx.writeResource("act", "act-latest", {
          task: args.task,
          qid,
          args: args.args,
          acked: ex.acked,
          events: ex.events,
          result: ex.final ?? {},
          raw: ex.raw,
          outcome,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        if (!ex.final) {
          throw new Error(
            `no DONE for ${
              JSON.stringify(args.task)
            } qid ${qid} within ${timeoutMs} ms ` +
              `(recorded as act-latest, outcome=timeout).`,
          );
        }
        if (errored) {
          throw new Error(
            `board reported an error for qid ${qid} (recorded as act-latest)`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    get: {
      description:
        "Read a UC2 GET endpoint: send {task, qid} and record the state the board " +
        "returns. A missing reply within timeoutMs is recorded as outcome=timeout, " +
        "then thrown.",
      arguments: z.object({
        task: z.string().describe("The GET endpoint, e.g. /motor_get"),
        timeoutMs: z.number().int().positive().optional(),
      }),
      execute: async (
        args: { task: string; timeoutMs?: number },
        ctx: MethodContext,
      ) => {
        const g = ctx.globalArgs;
        const timeoutMs = args.timeoutMs ?? g.timeoutMs;
        const qid = nextQid();
        const t0 = performance.now();
        const ex = await withLink(
          ctx,
          ({ link }) =>
            exchange(link, { task: args.task }, qid, {
              timeoutMs,
              idleMs: g.idleMs,
              mode: "get",
            }),
        );
        const outcome = ex.final ? "ok" : "timeout";
        const handle = await ctx.writeResource("state", "state-latest", {
          task: args.task,
          qid,
          state: ex.final ?? {},
          raw: ex.raw,
          outcome,
          observedAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - t0),
        });
        if (!ex.final) {
          throw new Error(
            `no reply to GET ${
              JSON.stringify(args.task)
            } qid ${qid} within ${timeoutMs} ms ` +
              `(recorded as state-latest, outcome=timeout).`,
          );
        }
        return { dataHandles: [handle] };
      },
    },

    hold: {
      description:
        "Start a detached worker that keeps the port open between calls " +
        "(idempotent). Methods use it automatically while holder is true.",
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
          ctx.logger.info("holder started, pid {pid}", { pid });
        }
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
        "Stop the holder: close the port and let the detached worker exit.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: MethodContext) => {
        const socket = await holderSocketPath(ctx.modelId);
        const before = await holderState(ctx);
        if (before.live) {
          const link = await SerialLink.create({ socketPath: socket });
          await link.release();
        }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && await SerialLink.holderLive(socket)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const live = await SerialLink.holderLive(socket);
        const handle = await ctx.writeResource("holder", "holder-current", {
          ...before,
          live,
          outcome: live ? "error" : "ok",
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
