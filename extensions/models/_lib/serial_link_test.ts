// Integration tests for the worker and SerialLink against a fake board: a
// pseudo-terminal served by fake_board.py, which is a real tty (stty works
// on it) that answers like a MicroPython board with a JSON line-protocol.
//
//   ~/.swamp/deno/deno test -A extensions/models/_lib/serial_link_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { SerialLink } from "./serial_link.ts";

const WORKER = new URL("../../files/serial_worker.ts", import.meta.url).pathname;
const FAKE = new URL("../../files/fake_board.py", import.meta.url).pathname;

/** Start the fake board; returns its tty path and a stop function. */
async function fakeBoard(): Promise<{ device: string; stop: () => Promise<void> }> {
  const child = new Deno.Command("python3", {
    args: [FAKE],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  let line = "";
  const dec = new TextDecoder();
  while (!line.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("fake board exited before printing its tty");
    line += dec.decode(value);
  }
  reader.releaseLock();
  return {
    device: line.trim(),
    stop: async () => {
      try {
        await child.stdin.close();
      } catch { /* closed */ }
      await child.status;
    },
  };
}

Deno.test("spawn transport: open, query by delimiter, idle, timeout, close", async () => {
  const fb = await fakeBoard();
  try {
    const link = await SerialLink.create({ workerPath: WORKER });
    assertEquals(link.mode, "spawn");
    const opened = await link.open(fb.device);
    assert(opened.ok, opened.error);

    const st = await link.status();
    assertEquals(st.open, true);
    assertEquals(st.device, fb.device);
    assertEquals(st.mode, "stdio");

    const ping = await link.query("ping\n", "}", 1000);
    assertEquals(ping.reason, "until");
    assert(ping.data!.includes('"fw": "fake 0.1"'));

    const spew = await link.query("spew\n", undefined, 2000, 150);
    assertEquals(spew.reason, "idle");
    assertEquals(spew.data!.replace(/\r/g, ""), "line 0\nline 1\nline 2\n");

    // A 300 ms pause inside the reply must not end it when idleMs is larger.
    const slow = await link.query("slow\n", undefined, 2000, 500);
    assertEquals(slow.reason, "idle");
    assertEquals(slow.data!.replace(/\r/g, ""), "part1part2\n");

    const quiet = await link.query("quiet\n", "}", 300, 100);
    assertEquals(quiet.reason, "timeout");
    assertEquals(quiet.data, "");

    const ctrlC = await link.query("\x03", ">>>", 500);
    assertEquals(ctrlC.reason, "until");
    assert(ctrlC.data!.endsWith(">>> "));

    await link.close();
  } finally {
    await fb.stop();
  }
});

Deno.test("detect lists device nodes for this OS", async () => {
  const link = await SerialLink.create({ workerPath: WORKER });
  try {
    const d = await link.detect();
    assert(d.ok);
    assertEquals(d.os, Deno.build.os);
    assert(Array.isArray(d.candidates));
    for (const c of d.candidates) assert(c.startsWith("/dev/"));
  } finally {
    await link.close();
  }
});

Deno.test("holder: port stays open across clients, release stops it", async () => {
  const fb = await fakeBoard();
  const socket = await Deno.makeTempDir({ prefix: "esp32-holder-" }) + "/h.sock";
  try {
    assertEquals(await SerialLink.holderLive(socket), false);
    const pid = await SerialLink.spawnHolder({ workerPath: WORKER, socketPath: socket, idleTimeoutMs: 60_000 });
    assert(pid > 0);
    assertEquals(await SerialLink.holderLive(socket), true);

    // Client 1 opens the port and leaves it open.
    const a = await SerialLink.create({ socketPath: socket });
    assertEquals(a.mode, "socket");
    assertEquals((await a.status()).open, false);
    assert((await a.open(fb.device)).ok);
    const p1 = await a.query("ping\n", "}", 1000);
    assertEquals(p1.reason, "until");
    await a.close(); // disconnect only

    // Client 2 finds it still open and sees the request count carried over.
    const b = await SerialLink.create({ socketPath: socket });
    const st = await b.status();
    assertEquals(st.open, true);
    assertEquals(st.device, fb.device);
    assertEquals(st.mode, "holder");
    assert(st.requestsServed >= 2, `requestsServed=${st.requestsServed}`);
    const p2 = await b.query("ping\n", "}", 1000);
    assertEquals(p2.reason, "until");

    await b.release();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && await SerialLink.holderLive(socket)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(await SerialLink.holderLive(socket), false);
  } finally {
    await fb.stop();
  }
});

Deno.test("holder exits on its own after the idle timeout", async () => {
  const socket = await Deno.makeTempDir({ prefix: "esp32-idle-" }) + "/h.sock";
  await SerialLink.spawnHolder({ workerPath: WORKER, socketPath: socket, idleTimeoutMs: 400 });
  assertEquals(await SerialLink.holderLive(socket), true);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && await SerialLink.holderLive(socket)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assertEquals(await SerialLink.holderLive(socket), false);
});

Deno.test("a second holder refuses to replace a live one; status answers during a long read", async () => {
  const fb = await fakeBoard();
  const socket = await Deno.makeTempDir({ prefix: "esp32-race-" }) + "/h.sock";
  try {
    const pid1 = await SerialLink.spawnHolder({ workerPath: WORKER, socketPath: socket, idleTimeoutMs: 60_000 });
    // Second spawn sees the live socket and reports the existing holder's pid.
    const pid2 = await SerialLink.spawnHolder({ workerPath: WORKER, socketPath: socket, idleTimeoutMs: 60_000 });
    assertEquals(pid2, pid1);
    const st = await SerialLink.holderStatus(socket);
    assertEquals(st?.pid, pid1);

    const link = await SerialLink.create({ socketPath: socket });
    assert((await link.open(fb.device)).ok);
    // A 700 ms read holds the queue; status must still answer promptly.
    const slow = link.read(700);
    const t0 = Date.now();
    const st2 = await link.status();
    assert(Date.now() - t0 < 300, "status waited for the read");
    assertEquals(st2.open, true);
    await slow;
    await link.release();
  } finally {
    await fb.stop();
  }
});

Deno.test("idle timeout 0 means never exit", async () => {
  const socket = await Deno.makeTempDir({ prefix: "esp32-never-" }) + "/h.sock";
  await SerialLink.spawnHolder({ workerPath: WORKER, socketPath: socket, idleTimeoutMs: 0 });
  await new Promise((r) => setTimeout(r, 600));
  assertEquals(await SerialLink.holderLive(socket), true);
  const link = await SerialLink.create({ socketPath: socket });
  await link.release();
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(await SerialLink.holderLive(socket), false);
});

Deno.test("holderStatus: null when absent, throws when the path is not a socket", async () => {
  assertEquals(await SerialLink.holderStatus("/nonexistent/dir/h.sock"), null);
  const dir = await Deno.makeTempDir({ prefix: "esp32-broken-" });
  const notSocket = `${dir}/h.sock`;
  await Deno.writeTextFile(notSocket, "not a socket");
  let threw = false;
  try {
    await SerialLink.holderStatus(notSocket);
  } catch {
    threw = true;
  }
  assert(threw, "a file that is not a socket should surface as broken");
});

Deno.test("device disappearing leaves status open:false, and the port can be reopened", async () => {
  const fb = await fakeBoard();
  const link = await SerialLink.create({ workerPath: WORKER });
  try {
    assert((await link.open(fb.device)).ok);
    assertEquals((await link.status()).open, true);
    await fb.stop(); // the pty master goes away: reads fail
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await link.status()).open, false);
    const fb2 = await fakeBoard();
    try {
      assert((await link.open(fb2.device)).ok);
      assertEquals((await link.query("ping\n", "}", 1000)).reason, "until");
    } finally {
      await fb2.stop();
    }
  } finally {
    await link.close();
  }
});

Deno.test("a verb on a dead worker rejects instead of hanging", async () => {
  const link = await SerialLink.create({ workerPath: WORKER });
  await link.close();
  let threw = false;
  try {
    await link.status();
  } catch {
    threw = true;
  }
  assert(threw);
});
