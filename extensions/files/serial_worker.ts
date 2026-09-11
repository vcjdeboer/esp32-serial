// serial_worker.ts
//
// A serial primitive as a worker process. Newline-delimited JSON requests in,
// newline-delimited JSON replies out, one reply per request, in order. No FFI:
// a USB-CDC serial port is a plain file, opened with Deno.open and put in raw
// mode with stty. Needs `-A`, because Deno 2 refuses `/dev/*` under any
// narrower grant (measured 2026-09-11, macOS, Deno 2.8.3).
//
// Two modes:
//
//   stdio (default)   deno run -A serial_worker.ts
//     One client on stdin/stdout. `close` closes the port and exits.
//
//   holder            deno run -A serial_worker.ts --serve /path/to.sock [--idle-timeout-ms N]
//     Listens on a unix socket, serves any number of sequential clients with
//     the same line protocol, and keeps the port open between them. `close`
//     closes the port but keeps serving; `release` closes and exits; so does
//     N ms without a request (default 15 min). Stale socket files are removed
//     on start.
//
// Verbs:
//   {"verb":"detect"}                                   -> {ok, os, candidates:[paths]}
//   {"verb":"open","device":"/dev/cu.usbmodem1101","baud":115200}
//   {"verb":"status"}                                   -> {ok, open, device, baud, pid, mode, requestsServed, startedAt}
//   {"verb":"write","data":"..."}
//   {"verb":"read","timeoutMs":500,"idleMs":100}        -> {ok, data, reason}
//   {"verb":"query","data":"...","until":">>>","timeoutMs":500,"idleMs":100}
//                                                       -> {ok, data, reason: "until"|"idle"|"timeout"}
//   {"verb":"close"}   {"verb":"release"}
//
// `idleMs` ends a read or query once at least one byte has arrived and the
// line has then been silent for that long. `until` ends it as soon as that
// string appears. `timeoutMs` is the hard cap; hitting it is reported, never
// thrown, and the partial bytes come back with it.

import { TextLineStream } from "jsr:@std/streams@^1/text-line-stream";

type Cmd =
  | { verb: "detect" }
  | { verb: "open"; device: string; baud?: number }
  | { verb: "status" }
  | { verb: "write"; data: string }
  | { verb: "read"; timeoutMs?: number; idleMs?: number }
  | {
    verb: "query";
    data: string;
    until?: string;
    timeoutMs?: number;
    idleMs?: number;
  }
  | {
    verb: "flash";
    device: string;
    image: string;
    chip?: string;
    erase?: boolean;
    flashBaud?: number;
    esptoolPath?: string;
    timeoutMs?: number;
  }
  | { verb: "close" }
  | { verb: "release" };

type Reply = Record<string, unknown> & { ok: boolean };

const enc = new TextEncoder();
const dec = new TextDecoder();

let file: Deno.FsFile | null = null; // write handle
let rfile: Deno.FsFile | null = null; // read handle (separate: Deno serializes ops per handle)
let openDevice: string | null = null;
let openBaud = 0;
let rx: Uint8Array[] = []; // bytes seen since last drain
let lastByteAt = 0;
let pumpDone: Promise<void> | null = null;
let requestsServed = 0;
const startedAt = new Date().toISOString();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function drain(): string {
  if (rx.length === 0) return "";
  const total = rx.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of rx) {
    out.set(c, o);
    o += c.length;
  }
  rx = [];
  return dec.decode(out);
}

// Peek without consuming, so "query" can wait for a delimiter.
function peek(): string {
  if (rx.length === 0) return "";
  return rx.map((c) => dec.decode(c)).join("");
}

async function stty(device: string, args: string[]) {
  const flag = Deno.build.os === "darwin" ? "-f" : "-F";
  const { code, stderr } = await new Deno.Command("stty", {
    args: [flag, device, ...args],
  }).output();
  if (code !== 0) throw new Error("stty: " + dec.decode(stderr));
}

/** Serial device nodes this host could reach, by OS naming convention. */
function detect(): { os: string; candidates: string[] } {
  const pattern = Deno.build.os === "darwin"
    ? /^cu\.usbmodem/
    : /^tty(ACM|USB)\d+$/;
  const names: string[] = [];
  for (const e of Deno.readDirSync("/dev")) {
    if (pattern.test(e.name)) names.push("/dev/" + e.name);
  }
  return { os: Deno.build.os, candidates: names.sort() };
}

async function open(device: string, baud = 115200) {
  if (file) throw new Error(`already open: ${openDevice}`);
  // Open first, then stty: macOS resets termios when the last holder closes the
  // port, so a stty before open would be lost. Two handles because Deno queues
  // ops per file resource; a pending blocking read would stall every write.
  file = await Deno.open(device, { read: true, write: true });
  rfile = await Deno.open(device, { read: true });
  // raw: pass bytes straight through. -hupcl clocal: do not drop DTR on close
  // and ignore carrier, so closing the port cannot reset a board that wires
  // DTR to reset. USB-CDC ignores baud; setting it keeps UART bridges right.
  await stty(device, [
    "raw",
    "-echo",
    "-onlcr",
    "-hupcl",
    "clocal",
    String(baud),
  ]);
  openDevice = device;
  openBaud = baud;
  rx = [];
  // Background read pump: keep pulling bytes so nothing is lost between commands.
  const f = rfile;
  pumpDone = (async () => {
    const buf = new Uint8Array(1024);
    while (true) {
      let n: number | null;
      try {
        n = await f.read(buf);
      } catch {
        break; // closed
      }
      if (n === null) break; // EOF
      rx.push(buf.slice(0, n));
      lastByteAt = Date.now();
    }
    // Reached on close, but also when the device vanished (EIO/ENXIO/EOF).
    // Drop the handles so `status` reports open:false and a later open works.
    if (rfile === f) {
      try {
        file?.close();
      } catch { /* gone */ }
      try {
        f.close();
      } catch { /* gone */ }
      file = null;
      rfile = null;
      openDevice = null;
    }
  })();
}

async function closePort() {
  if (file) {
    file.close();
    file = null;
  }
  if (rfile) {
    rfile.close();
    rfile = null;
    // Bound the wait: a read blocked in a thread may not notice the close.
    await Promise.race([pumpDone, sleep(500)]);
  }
  openDevice = null;
}

/**
 * Wait for a reply. Ends on `until` appearing, on `idleMs` of silence after
 * the first byte, or on the `timeoutMs` deadline, in that order of preference.
 */
async function collect(
  opts: { until?: string; timeoutMs: number; idleMs?: number },
): Promise<{ data: string; reason: "until" | "idle" | "timeout" }> {
  const deadline = Date.now() + opts.timeoutMs;
  let reason: "until" | "idle" | "timeout" = "timeout";
  while (Date.now() < deadline) {
    if (opts.until && peek().includes(opts.until)) {
      reason = "until";
      break;
    }
    if (
      opts.idleMs && rx.length > 0 && Date.now() - lastByteAt >= opts.idleMs
    ) {
      reason = "idle";
      break;
    }
    await sleep(10);
  }
  return { data: drain(), reason };
}

function status(mode: "stdio" | "holder"): Reply {
  return {
    ok: true,
    open: file !== null,
    device: openDevice,
    baud: openBaud,
    pid: Deno.pid,
    mode,
    requestsServed,
    startedAt,
  };
}

/** Handle one request. `exit: true` asks the caller to exit after replying. */
/**
 * Run one esptool invocation, draining its pipes as it goes (so it never
 * blocks on a full stdout buffer) and killing it on timeout. Returns the
 * combined text; throws on failure. This runs in the worker, i.e. under a
 * real `deno`, because esptool's stub handshake stalls when spawned from
 * swamp's compiled runtime (measured 2026-09-11).
 */
async function runEsptool(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  // esptool must be spawned by a normal deno (this worker), never directly by
  // swamp's compiled runtime, where its serial connect stalls (measured
  // 2026-09-11). The worker is that normal deno. The environment is also
  // trimmed to the essentials, as the flipper-zero extension does.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"]) {
    const v = Deno.env.get(k);
    if (v) env[k] = v;
  }
  const child = new Deno.Command(bin, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env,
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* gone */ }
  }, timeoutMs);
  let text = "";
  const drain = async (r: ReadableStream<Uint8Array>) => {
    for await (const c of r) text += dec.decode(c, { stream: true });
  };
  const [status] = await Promise.all([
    child.status,
    drain(child.stdout),
    drain(child.stderr),
  ]);
  clearTimeout(timer);
  const clean = text.replace(
    new RegExp(String.fromCharCode(0x1b) + "\\[[0-9;?]*[ -/]*[@-~]", "g"),
    "",
  ).replace(
    /\r/g,
    "",
  );
  if (!status.success) {
    const verb = args.find((a) => !a.startsWith("-") && !a.startsWith("/")) ??
      "";
    throw new Error(
      `esptool ${verb} failed (exit ${status.code}, signal ${
        status.signal ?? "none"
      }` +
        `${timedOut ? ", timed out" : ""}): ${clean.trim().slice(-500)}`,
    );
  }
  return clean;
}

/** Erase (if asked) and write a MicroPython image, reporting the chip's MAC. */
async function flash(cmd: Extract<Cmd, { verb: "flash" }>): Promise<Reply> {
  if (file || rfile) await closePort(); // esptool needs the port to itself
  const bin = cmd.esptoolPath ?? "esptool";
  const chip = cmd.chip ?? "esp32c3";
  const device = cmd.device;
  const timeoutMs = cmd.timeoutMs ?? 120_000;
  const t0 = Date.now();

  const version = (await runEsptool(bin, ["version"], 20_000))
    .split("\n").map((l) => l.trim()).find((l) =>
      /^\d/.test(l) || /^esptool/i.test(l)
    ) ?? "";
  const id = await runEsptool(bin, [
    "--chip",
    chip,
    "--port",
    device,
    "chip-id",
  ], 30_000);
  const mac = id.match(/MAC:\s*([0-9a-f:]{17})/i)?.[1] ?? "";
  const chipDescription = id.match(/Chip type:\s*(.+)/)?.[1]?.trim() ?? "";
  if (!mac) {
    throw new Error(`esptool chip-id reported no MAC: ${id.slice(-300)}`);
  }

  const erased = cmd.erase !== false;
  if (erased) {
    await runEsptool(
      bin,
      ["--chip", chip, "--port", device, "erase-flash"],
      timeoutMs,
    );
  }
  const wr = await runEsptool(bin, [
    "--chip",
    chip,
    "--port",
    device,
    "--baud",
    String(cmd.flashBaud ?? 460_800),
    "write-flash",
    "-z",
    "0x0",
    cmd.image,
  ], timeoutMs);
  const verified = /Hash of data verified/i.test(wr);

  // The board resets; wait for the node to come back.
  const tBack = Date.now();
  let back = false;
  while (Date.now() - tBack < 15_000) {
    try {
      Deno.statSync(device);
      back = true;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!back) {
    throw new Error(`${device} did not come back within 15 s after flashing`);
  }
  await sleep(1500); // first boot formats the filesystem

  return {
    ok: true,
    mac,
    chipDescription,
    esptoolVersion: version,
    erased,
    verified,
    portBackAfterMs: Date.now() - tBack,
    elapsedMs: Date.now() - t0,
  };
}

async function handle(
  cmd: Cmd,
  mode: "stdio" | "holder",
): Promise<{ reply: Reply; exit?: boolean }> {
  requestsServed++;
  switch (cmd.verb) {
    case "detect":
      return { reply: { ok: true, ...detect() } };

    case "open":
      await open(cmd.device, cmd.baud);
      return { reply: { ok: true, device: cmd.device, baud: openBaud } };

    case "status":
      return { reply: status(mode) }; // normally answered before the queue

    case "write":
      if (!file) throw new Error("not open");
      await file.write(enc.encode(cmd.data));
      return { reply: { ok: true } };

    case "read": {
      if (!file) throw new Error("not open");
      const r = await collect({
        timeoutMs: cmd.timeoutMs ?? 200,
        idleMs: cmd.idleMs,
      });
      return { reply: { ok: true, ...r } };
    }

    case "query": {
      if (!file) throw new Error("not open");
      rx = []; // start clean so we only capture this reply
      await file.write(enc.encode(cmd.data));
      const r = await collect({
        until: cmd.until,
        timeoutMs: cmd.timeoutMs ?? 500,
        idleMs: cmd.idleMs,
      });
      return { reply: { ok: true, ...r } };
    }

    case "flash":
      return { reply: await flash(cmd) };

    case "close":
      await closePort();
      return { reply: { ok: true }, exit: mode === "stdio" };

    case "release":
      await closePort();
      return { reply: { ok: true }, exit: true };
  }
}

// Requests are handled one at a time, whichever client they come from.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function serveLines(
  input: ReadableStream<Uint8Array>,
  output: WritableStreamDefaultWriter<Uint8Array>,
  mode: "stdio" | "holder",
  onRequest: () => void,
  onExit: () => Promise<void>,
) {
  const lines = input.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TextLineStream(),
  );
  for await (const line of lines) {
    if (!line.trim()) continue;
    let exit = false;
    let reply: Reply;
    try {
      const cmd = JSON.parse(line) as Cmd;
      if (cmd.verb === "status") {
        // Liveness must answer while a long read holds the queue, and a
        // probe is not activity: it must not postpone the idle exit.
        reply = status(mode);
      } else {
        onRequest();
        const r = await enqueue(() => handle(cmd, mode));
        reply = r.reply;
        exit = r.exit ?? false;
      }
    } catch (e) {
      reply = { ok: false, error: String(e) };
    }
    try {
      await output.write(enc.encode(JSON.stringify(reply) + "\n"));
    } catch {
      break; // client went away
    }
    if (exit) await onExit();
  }
}

/** True when something on `path` answers a status request within `timeoutMs`. */
async function socketAnswers(
  path: string,
  timeoutMs: number,
): Promise<boolean> {
  let conn: Deno.UnixConn;
  try {
    conn = await Deno.connect({ transport: "unix", path });
  } catch {
    return false;
  }
  try {
    const timer = setTimeout(() => conn.close(), timeoutMs);
    await conn.write(enc.encode('{"verb":"status"}\n'));
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    clearTimeout(timer);
    return n !== null && dec.decode(buf.subarray(0, n)).includes('"ok":true');
  } catch {
    return false;
  } finally {
    try {
      conn.close();
    } catch { /* closed */ }
  }
}

function argValue(flag: string): string | undefined {
  const i = Deno.args.indexOf(flag);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const socketPath = argValue("--serve");

if (!socketPath) {
  await serveLines(
    Deno.stdin.readable,
    Deno.stdout.writable.getWriter(),
    "stdio",
    () => {},
    async () => {
      await closePort();
      Deno.exit(0);
    },
  );
  await closePort();
  Deno.exit(0);
} else {
  // 0 (or anything unparseable) means never exit on idle.
  const idleRaw = Number(argValue("--idle-timeout-ms") ?? 15 * 60_000);
  const idleTimeoutMs = Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : 0;

  // Refuse to replace a live holder; only a dead socket file is removed.
  if (await socketAnswers(socketPath, 1000)) {
    console.error(`holder already live on ${socketPath}; exiting`);
    Deno.exit(3);
  }
  try {
    Deno.removeSync(socketPath);
  } catch { /* none to remove */ }
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  await Deno.chmod(socketPath, 0o600);

  const shutdown = async () => {
    await closePort();
    try {
      listener.close();
    } catch { /* already closed */ }
    try {
      Deno.removeSync(socketPath);
    } catch { /* gone */ }
    Deno.exit(0);
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (idleTimeoutMs > 0) idleTimer = setTimeout(shutdown, idleTimeoutMs);
  };
  touch();
  // unref() gives no new session, so a terminal HUP reaches the holder too.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    Deno.addSignalListener(sig, () => void shutdown());
  }

  while (true) {
    let conn: Deno.UnixConn;
    try {
      conn = await listener.accept();
    } catch (e) {
      // macOS: accept() fails with EINVAL when the peer connected and closed
      // before we accepted (a liveness probe does exactly that). Not fatal.
      if (
        e instanceof Deno.errors.BadResource ||
        e instanceof Deno.errors.Interrupted
      ) break;
      continue;
    }
    serveLines(
      conn.readable,
      conn.writable.getWriter(),
      "holder",
      touch,
      shutdown,
    )
      .catch(() => {})
      .finally(() => {
        try {
          conn.close();
        } catch { /* closed by peer */ }
      });
  }
}
