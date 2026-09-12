// Tests for the UC2 structured protocol: pure classification via the exported
// `exchange` against a fake board (a pty served by fake_board.py that answers
// the UC2 ACK/event/DONE dance).
//
//   ~/.swamp/deno/deno test -A extensions/models/uc2_device_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { exchange, model } from "./uc2_device.ts";
import { SerialLink } from "./_lib/serial_link.ts";
import { jsonLines } from "./_lib/device.ts";

const WORKER = new URL("../files/serial_worker.ts", import.meta.url).pathname;
const FAKE = new URL("../files/fake_board.py", import.meta.url).pathname;

async function fakeBoard(): Promise<{ device: string; stop: () => Promise<void> }> {
  const child = new Deno.Command("python3", {
    args: [FAKE],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let line = "";
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

Deno.test("model exposes the UC2 methods and resources", () => {
  assertEquals(model.type, "@vcjdeboer/uc2-device");
  assertEquals(Object.keys(model.methods).sort(), ["act", "detect", "get", "hold", "release"]);
  assert("act" in model.resources && "state" in model.resources);
});

Deno.test("every method writes a spec that exists, with a spec-prefixed instance name", () => {
  const specs = Object.keys(model.resources);
  const src = Deno.readTextFileSync(new URL("./uc2_device.ts", import.meta.url));
  const writes = [...src.matchAll(/writeResource\(\s*"(\w+)",\s*"([\w-]+)"/g)];
  assertEquals(writes.length, Object.keys(model.methods).length);
  for (const [, spec, instance] of writes) {
    assert(specs.includes(spec), `unknown spec ${spec}`);
    assert(instance.startsWith(spec + "-"), `${instance} not prefixed by ${spec}`);
  }
});

Deno.test("jsonLines returns every object in order", () => {
  const objs = jsonLines('noise\r\n{"qid":1}\r\n{"qid":1,"progress":50}\r\n{"qid":1,"result":"done"}\r\n');
  assertEquals(objs.length, 3);
  assertEquals(objs[2], { qid: 1, result: "done" });
});

Deno.test("act exchange collects ACK, events and the final DONE by qid", async () => {
  const fb = await fakeBoard();
  const link = await SerialLink.create({ workerPath: WORKER });
  try {
    assert((await link.open(fb.device)).ok);
    const ex = await exchange(link, { task: "/motor_act", steps: 100 }, 7, {
      timeoutMs: 3000,
      idleMs: 150,
      mode: "act",
    });
    assertEquals(ex.acked, true);
    assertEquals(ex.events.length, 1);
    assertEquals(ex.events[0], { qid: 7, progress: 50 });
    assert(ex.final !== null);
    assertEquals(ex.final!.result, "done");
    assertEquals(ex.final!.qid, 7);
  } finally {
    await link.close();
    await fb.stop();
  }
});

Deno.test("get exchange returns the state payload for its qid", async () => {
  const fb = await fakeBoard();
  const link = await SerialLink.create({ workerPath: WORKER });
  try {
    assert((await link.open(fb.device)).ok);
    const ex = await exchange(link, { task: "/motor_get" }, 9, {
      timeoutMs: 2000,
      idleMs: 150,
      mode: "get",
    });
    assert(ex.final !== null);
    assertEquals(ex.final!.value, 42);
    assertEquals(ex.final!.qid, 9);
  } finally {
    await link.close();
    await fb.stop();
  }
});

Deno.test("a missing reply leaves final null (records as timeout upstream)", async () => {
  const fb = await fakeBoard();
  const link = await SerialLink.create({ workerPath: WORKER });
  try {
    assert((await link.open(fb.device)).ok);
    // "quiet" is not a UC2 request, so no qid reply arrives.
    const ex = await exchange(link, { task: "quiet" }, 11, {
      timeoutMs: 600,
      idleMs: 100,
      mode: "act",
    });
    assertEquals(ex.final, null);
  } finally {
    await link.close();
    await fb.stop();
  }
});
