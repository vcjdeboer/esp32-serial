import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  holderSocketPath,
  lastJsonLine,
  model,
  parseRawReply,
  selectDevice,
  stripEscapes,
} from "./esp32_serial.ts";
import { resolveDenoPath } from "./_lib/serial_link.ts";

Deno.test("globalArguments apply defaults; device is optional", () => {
  const g = model.globalArguments.parse({});
  assertEquals(g.device, undefined);
  assertEquals(g.baud, 115200);
  assertEquals(g.timeoutMs, 2000);
  assertEquals(g.idleMs, 150);
  assertEquals(g.settleMs, 100);
  assertEquals(g.holder, false);
  assertEquals(g.holderIdleTimeoutMs, 15 * 60_000);
  assertEquals(model.globalArguments.parse({ device: "/dev/cu.usbmodem1101" }).device, "/dev/cu.usbmodem1101");
});

Deno.test("stripEscapes removes CSI, OSC, two-byte escapes and CR", () => {
  assertEquals(stripEscapes("\x1b[31mred\x1b[0m\r\n"), "red\n");
  assertEquals(stripEscapes("\x1b]0;title\x07x"), "x");
  assertEquals(stripEscapes("\x1b[?2004l>>> "), ">>> ");
  assertEquals(stripEscapes("\x1bMplain"), "plain");
  assertEquals(stripEscapes('{"ok": true}\r\n'), '{"ok": true}\n');
});

Deno.test("parseRawReply splits stdout and traceback, drops echo before OK, flags incomplete", () => {
  const r = parseRawReply("garbage\r\nOKhello\r\n\x04\x04>");
  assertEquals(r, { output: "hello\n", error: "", complete: true });
  assertEquals(parseRawReply("OKpartial").complete, false);
  const e = parseRawReply(
    "OK\x04Traceback (most recent call last):\r\n  File \"<stdin>\"\r\nNameError: x\r\n\x04>",
  );
  assertEquals(e.output, "");
  assert(e.error.startsWith("Traceback"));
  assert(e.error.includes("NameError: x"));
});

Deno.test("lastJsonLine picks the last complete object and tolerates noise and escapes", () => {
  const data = "status\r\n{\"ok\":true,\"fw\":\"fake 0.1\"}\r\n\x1b[0m{\"ok\":true,\"value\":3}\r\n";
  assertEquals(lastJsonLine(data), { ok: true, value: 3 });
  assertEquals(lastJsonLine(">>> \r\n"), null);
  assertEquals(lastJsonLine("{not json}"), null);
});

Deno.test("selectDevice: configured wins, else exactly one candidate, else null", () => {
  assertEquals(selectDevice("/dev/x", ["/dev/a", "/dev/b"]), "/dev/x");
  assertEquals(selectDevice(undefined, ["/dev/a"]), "/dev/a");
  assertEquals(selectDevice(undefined, []), null);
  assertEquals(selectDevice(undefined, ["/dev/a", "/dev/b"]), null);
});

Deno.test("holderSocketPath is a hashed, per-instance socket in a private dir", async () => {
  const p = await holderSocketPath("abc-123");
  assert(/\/swamp-esp32\/[0-9a-f]{12}\.sock$/.test(p), p);
  assertEquals(p, await holderSocketPath("abc-123"));
  assert(p !== await holderSocketPath("abc-124"));
});

Deno.test("every method writes a spec that exists, with a spec-prefixed instance name", () => {
  const specs = Object.keys(model.resources);
  const src = Deno.readTextFileSync(new URL("./esp32_serial.ts", import.meta.url));
  const writes = [...src.matchAll(/writeResource\(\s*"(\w+)",\s*"([\w-]+)"/g)];
  assertEquals(writes.length, Object.keys(model.methods).length);
  for (const [, spec, instance] of writes) {
    assert(specs.includes(spec), `unknown spec ${spec}`);
    assert(instance.startsWith(spec + "-"), `${instance} not prefixed by ${spec}`);
  }
});

Deno.test("resolveDenoPath prefers the explicit path, then SWAMP_DENO", () => {
  assertEquals(resolveDenoPath("/x/deno"), "/x/deno");
  const prev = Deno.env.get("SWAMP_DENO");
  Deno.env.set("SWAMP_DENO", "/y/deno");
  try {
    assertEquals(resolveDenoPath(), "/y/deno");
  } finally {
    if (prev === undefined) Deno.env.delete("SWAMP_DENO");
    else Deno.env.set("SWAMP_DENO", prev);
  }
  assert(resolveDenoPath().length > 0);
});
