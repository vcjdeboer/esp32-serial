/**
 * `SerialLink`: the host side of the serial worker.
 *
 * Talks the worker's line protocol (one JSON request per line, one JSON reply
 * per line) over one of two transports:
 *
 * - **spawn**: start `extensions/files/serial_worker.ts` as a child on
 *   stdin/stdout and pipeline requests over it. The port lives as long as
 *   the child; `close()` ends both. A call that times out fails the whole
 *   link (the child is killed), because a late reply on a pipelined stream
 *   would otherwise be handed to the next request.
 * - **socket**: talk to a worker already running in holder mode on a unix
 *   socket (`SerialLink.spawnHolder` starts one, detached). One connection
 *   per request, as the rack's holder client does, so a timed-out request
 *   can never desync a later one. `close()` is a no-op; `release()` stops
 *   the holder.
 *
 * The worker runs with `--allow-all`, because Deno 2 refuses `/dev/*` under
 * any narrower grant (measured 2026-09-11 on macOS, Deno 2.8.3); the process
 * holding a `SerialLink` needs only `--allow-run` (spawn) or read/write on
 * the socket path (socket).
 *
 * @module
 */

/**
 * Where to find a Deno binary to run the worker with.
 *
 * Inside a swamp model `Deno.execPath()` is the swamp binary itself (swamp is
 * a `deno compile` build), so it cannot be used to spawn a script. Resolution
 * order: explicit argument, `$SWAMP_DENO`, swamp's bundled Deno at
 * `~/.swamp/deno/deno`, then `Deno.execPath()` when that really is a `deno`
 * binary, then a bare `deno` on PATH.
 */
export function resolveDenoPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = Deno.env.get("SWAMP_DENO");
  if (env) return env;
  const home = Deno.env.get("HOME");
  if (home) {
    const bundled = `${home}/.swamp/deno/deno`;
    try {
      if (Deno.statSync(bundled).isFile) return bundled;
    } catch { /* not installed that way */ }
  }
  const self = Deno.execPath();
  if (/(^|\/)deno(\.exe)?$/.test(self)) return self;
  return "deno";
}

/** Options for constructing a `SerialLink`. */
export interface SerialLinkOptions {
  /** Path to `serial_worker.ts` (spawn transport). */
  workerPath?: string;
  /** Unix socket of a running holder (socket transport). Wins over workerPath. */
  socketPath?: string;
  /** Deno binary to run the worker with; see `resolveDenoPath`. */
  denoPath?: string;
  /**
   * Upper bound on how long any single verb may take before the call rejects
   * (the worker's own `timeoutMs` bounds the serial wait; this bounds the
   * process boundary). Default 10 s.
   */
  callTimeoutMs?: number;
}

/** The worker's reply envelope. */
export interface WorkerReply {
  ok: boolean;
  error?: string;
  data?: string;
  /** Why a read or query ended. */
  reason?: "until" | "idle" | "timeout";
}

/** Reply to the `status` verb. */
export interface WorkerStatus extends WorkerReply {
  open: boolean;
  device: string | null;
  baud: number;
  pid: number;
  mode: "stdio" | "holder";
  requestsServed: number;
  startedAt: string;
}

/** Reply to the `detect` verb. */
export interface WorkerDetect extends WorkerReply {
  os: string;
  candidates: string[];
}

/** Reply to the `flash` verb. */
export interface WorkerFlash extends WorkerReply {
  mac: string;
  chipDescription: string;
  esptoolVersion: string;
  erased: boolean;
  verified: boolean;
  portBackAfterMs: number;
  elapsedMs: number;
}

/** True for the errors that mean "nothing is listening there". */
function isAbsent(e: unknown): boolean {
  return e instanceof Deno.errors.NotFound ||
    e instanceof Deno.errors.ConnectionRefused;
}

const enc = new TextEncoder();

/** One request over a fresh unix connection: write a line, read a line. */
async function oneShot(
  socketPath: string,
  cmd: Record<string, unknown>,
  timeoutMs: number,
): Promise<WorkerReply> {
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  const timer = setTimeout(() => {
    try {
      conn.close();
    } catch { /* closed */ }
  }, timeoutMs);
  try {
    await conn.write(enc.encode(JSON.stringify(cmd) + "\n"));
    const dec = new TextDecoder();
    let buf = "";
    const chunk = new Uint8Array(65536);
    while (!buf.includes("\n")) {
      const n = await conn.read(chunk);
      if (n === null) break;
      buf += dec.decode(chunk.subarray(0, n), { stream: true });
    }
    const line = buf.slice(
      0,
      buf.indexOf("\n") >= 0 ? buf.indexOf("\n") : undefined,
    ).trim();
    if (!line) {
      throw new Error(
        `serial ${String(cmd.verb)} got no reply within ${timeoutMs} ms`,
      );
    }
    return JSON.parse(line) as WorkerReply;
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch { /* closed */ }
  }
}

/** A serial link to one device, through a worker process. */
export class SerialLink {
  #mode: "spawn" | "socket";
  #socketPath = "";
  #child: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #pending: {
    resolve: (v: WorkerReply) => void;
    reject: (e: Error) => void;
  }[] = [];
  #stderr = "";
  #ended = false;
  #callTimeoutMs: number;

  private constructor(mode: "spawn" | "socket", callTimeoutMs: number) {
    this.#mode = mode;
    this.#callTimeoutMs = callTimeoutMs;
  }

  /** Spawn a worker, or bind to a holder's socket when `socketPath` is given. */
  static async create(opts: SerialLinkOptions): Promise<SerialLink> {
    const callTimeoutMs = opts.callTimeoutMs ?? 10_000;
    if (opts.socketPath) {
      const link = new SerialLink("socket", callTimeoutMs);
      link.#socketPath = opts.socketPath;
      return link;
    }
    if (!opts.workerPath) {
      throw new Error("SerialLink needs workerPath or socketPath");
    }
    const child = new Deno.Command(resolveDenoPath(opts.denoPath), {
      // -A: Deno 2 needs allow-all to open /dev/* device files.
      args: ["run", "-A", opts.workerPath],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const link = new SerialLink("spawn", callTimeoutMs);
    link.#child = child;
    link.#writer = child.stdin.getWriter();
    link.#pump(child.stdout);
    link.#drainStderr(child.stderr);
    child.status.then((s) => {
      link.#fail(
        new Error(
          `serial worker exited (code ${s.code})${
            link.#stderr ? ": " + link.#stderr.trim() : ""
          }`,
        ),
      );
    });
    await Promise.resolve();
    return link;
  }

  /**
   * The holder's status, or `null` when nothing listens on `socketPath`.
   * Throws when something is there but broken (permission denied, no reply
   * within `timeoutMs`, garbage), so a broken holder is surfaced rather than
   * silently fallen back from.
   */
  static async holderStatus(
    socketPath: string,
    timeoutMs = 2000,
  ): Promise<WorkerStatus | null> {
    try {
      const r = await oneShot(socketPath, { verb: "status" }, timeoutMs);
      if (!r.ok) {
        throw new Error(`holder answered status with an error: ${r.error}`);
      }
      return r as WorkerStatus;
    } catch (e) {
      if (isAbsent(e)) return null;
      throw e;
    }
  }

  /** True when a holder answers on `socketPath`; false when absent or broken. */
  static async holderLive(socketPath: string): Promise<boolean> {
    try {
      return (await SerialLink.holderStatus(socketPath)) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Start a detached worker in holder mode and wait until it answers on the
   * socket. Returns the pid of whatever holder answers, which is an existing
   * one if it was already live (the new child then exits by itself). The
   * holder outlives this process and exits on `release`, or after
   * `idleTimeoutMs` without a request (0 = never).
   */
  static async spawnHolder(opts: {
    workerPath: string;
    socketPath: string;
    denoPath?: string;
    idleTimeoutMs?: number;
    startTimeoutMs?: number;
  }): Promise<number> {
    const child = new Deno.Command(resolveDenoPath(opts.denoPath), {
      args: [
        "run",
        "-A",
        opts.workerPath,
        "--serve",
        opts.socketPath,
        "--idle-timeout-ms",
        String(opts.idleTimeoutMs ?? 15 * 60_000),
      ],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    child.unref();
    let stderr = "";
    const dec = new TextDecoder();
    (async () => {
      try {
        for await (const c of child.stderr) {
          stderr += dec.decode(c, { stream: true });
        }
      } catch { /* closed */ }
    })();
    let exited: Deno.CommandStatus | null = null;
    child.status.then((s) => exited = s);

    const startTimeoutMs = opts.startTimeoutMs ?? 10_000;
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const st = await SerialLink.holderStatus(opts.socketPath, 500).catch(() =>
        null
      );
      if (st) return st.pid;
      if (exited) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    const why = exited
      ? `exited with code ${(exited as Deno.CommandStatus).code}`
      : `did not answer within ${startTimeoutMs} ms`;
    throw new Error(
      `holder on ${opts.socketPath} ${why}${
        stderr ? ": " + stderr.trim() : ""
      }`,
    );
  }

  /** Which transport this link uses. */
  get mode(): "spawn" | "socket" {
    return this.#mode;
  }

  #fail(err: Error) {
    this.#ended = true;
    for (const p of this.#pending.splice(0)) p.reject(err);
  }

  async #pump(input: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of input) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const p = this.#pending.shift();
          if (!p) continue;
          try {
            p.resolve(JSON.parse(line) as WorkerReply);
          } catch (e) {
            p.reject(new Error(`serial worker sent non-JSON: ${line} (${e})`));
          }
        }
      }
    } catch { /* stream closed */ }
    this.#fail(new Error("serial worker connection ended"));
  }

  async #drainStderr(stderr: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    try {
      for await (const chunk of stderr) {
        this.#stderr += dec.decode(chunk, { stream: true });
        if (this.#stderr.length > 4096) {
          this.#stderr = this.#stderr.slice(-4096);
        }
      }
    } catch { /* closed */ }
  }

  #send<T extends WorkerReply = WorkerReply>(
    cmd: Record<string, unknown>,
    timeoutMs = this.#callTimeoutMs,
  ): Promise<T> {
    if (this.#mode === "socket") {
      return oneShot(this.#socketPath, cmd, timeoutMs) as Promise<T>;
    }
    if (this.#ended) {
      return Promise.reject(
        new Error("serial worker connection already ended"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late reply would be handed to the next request; end the link.
        this.#fail(
          new Error(
            `serial ${String(cmd.verb)} timed out after ${timeoutMs} ms`,
          ),
        );
        try {
          this.#child?.kill("SIGKILL");
        } catch { /* gone */ }
      }, timeoutMs);
      this.#pending.push({
        resolve: (v: WorkerReply) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#writer!.write(enc.encode(JSON.stringify(cmd) + "\n")).catch((e) =>
        this.#fail(e instanceof Error ? e : new Error(String(e)))
      );
    });
  }

  /** Serial device nodes on this host. */
  detect(): Promise<WorkerDetect> {
    return this.#send<WorkerDetect>({ verb: "detect" });
  }

  /** Open the device and put it in raw mode. */
  open(device: string, baud = 115200): Promise<WorkerReply> {
    return this.#send({ verb: "open", device, baud });
  }

  /**
   * Erase (unless `erase:false`) and write a MicroPython image with esptool,
   * then wait for the port to re-enumerate. Runs in the worker so esptool is
   * a child of a real `deno` (its stub handshake stalls under swamp's
   * compiled runtime). Spawn transport only.
   */
  flash(opts: {
    device: string;
    image: string;
    chip?: string;
    erase?: boolean;
    flashBaud?: number;
    esptoolPath?: string;
    timeoutMs?: number;
  }): Promise<WorkerFlash> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    return this.#send<WorkerFlash>(
      { verb: "flash", ...opts, timeoutMs },
      timeoutMs + this.#callTimeoutMs,
    );
  }

  /** What the worker holds right now. */
  status(): Promise<WorkerStatus> {
    return this.#send<WorkerStatus>({ verb: "status" });
  }

  /** Write bytes (as a string) to the device. */
  write(data: string): Promise<WorkerReply> {
    return this.#send({ verb: "write", data });
  }

  /**
   * Collect whatever arrives for up to `timeoutMs`; with `idleMs`, stop early
   * once something has arrived and the line has been silent that long.
   */
  read(timeoutMs = 200, idleMs?: number): Promise<WorkerReply> {
    return this.#send(
      { verb: "read", timeoutMs, idleMs },
      timeoutMs + this.#callTimeoutMs,
    );
  }

  /**
   * Clear the receive buffer, write `data`, then wait until `until` appears,
   * the line goes idle for `idleMs` after the first byte, or `timeoutMs`
   * elapses. The reply says which (`reason`) and carries the bytes either way.
   */
  query(
    data: string,
    until?: string,
    timeoutMs = 500,
    idleMs?: number,
  ): Promise<WorkerReply> {
    return this.#send(
      { verb: "query", data, until, timeoutMs, idleMs },
      timeoutMs + this.#callTimeoutMs,
    );
  }

  /** Close the port but keep the worker (holder keeps serving). */
  closePort(): Promise<WorkerReply> {
    return this.#send({ verb: "close" });
  }

  /** Ask a holder to close the port and exit. */
  async release(): Promise<void> {
    try {
      await this.#send({ verb: "release" });
    } catch { /* it exits on reply; a race here is fine */ }
    await this.close();
  }

  /**
   * Spawn transport: close the port and let the worker exit. Socket
   * transport: nothing to do, there is no persistent connection. Safe to
   * repeat.
   */
  async close(): Promise<void> {
    if (this.#mode !== "spawn") return;
    if (!this.#ended) {
      try {
        await this.#send({ verb: "close" });
      } catch { /* worker may already be gone */ }
    }
    try {
      await this.#writer?.close();
    } catch { /* already closed */ }
    if (this.#child) await this.#child.status;
  }
}
