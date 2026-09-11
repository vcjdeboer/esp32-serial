import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  ensureSocketDir,
  socketDir,
  socketPathFor,
  UNIX_SOCKET_MAX,
} from "./holder_paths.ts";

Deno.test("socketDir prefers XDG_RUNTIME_DIR, then TMPDIR, then /tmp, within the limit", () => {
  const saved = {
    xdg: Deno.env.get("XDG_RUNTIME_DIR"),
    tmp: Deno.env.get("TMPDIR"),
  };
  try {
    Deno.env.set("XDG_RUNTIME_DIR", "/run/user/501");
    Deno.env.set("TMPDIR", "/var/tmp/x/");
    assertEquals(socketDir("swamp-esp32"), "/run/user/501/swamp-esp32");
    Deno.env.delete("XDG_RUNTIME_DIR");
    assertEquals(socketDir("swamp-esp32"), "/var/tmp/x/swamp-esp32");
    Deno.env.set("TMPDIR", "/" + "l".repeat(120));
    assertEquals(socketDir("swamp-esp32"), "/tmp/swamp-esp32");
    Deno.env.delete("TMPDIR");
    assertEquals(socketDir("swamp-esp32"), "/tmp/swamp-esp32");
  } finally {
    if (saved.xdg === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
    else Deno.env.set("XDG_RUNTIME_DIR", saved.xdg);
    if (saved.tmp === undefined) Deno.env.delete("TMPDIR");
    else Deno.env.set("TMPDIR", saved.tmp);
  }
});

Deno.test("socketDir rejects bad app names", () => {
  let threw = false;
  try {
    socketDir("Bad Name");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("socketPathFor hashes the identity to 12 hex and stays under the limit", async () => {
  const p = await socketPathFor("/tmp/swamp-esp32", "c9af358a-d040-4475-a776-a794b5fddb53");
  assert(/^\/tmp\/swamp-esp32\/[0-9a-f]{12}\.sock$/.test(p), p);
  assert(p.length <= UNIX_SOCKET_MAX);
  assertEquals(p, await socketPathFor("/tmp/swamp-esp32", "c9af358a-d040-4475-a776-a794b5fddb53"));
  assert(p !== await socketPathFor("/tmp/swamp-esp32", "other"));
  await assertRejects(() => socketPathFor("/tmp/swamp-esp32", ""));
  await assertRejects(() => socketPathFor("/" + "d".repeat(100), "x"));
});

Deno.test("ensureSocketDir creates 0700 and tightens a shared directory we own", async () => {
  const base = await Deno.makeTempDir({ prefix: "holder-paths-" });
  const good = `${base}/private`;
  await ensureSocketDir(good);
  const st = await Deno.stat(good);
  assertEquals((st.mode ?? 0) & 0o777, 0o700);
  await ensureSocketDir(good); // idempotent
  const shared = `${base}/shared`;
  await Deno.mkdir(shared, { mode: 0o755 });
  await Deno.chmod(shared, 0o755);
  await ensureSocketDir(shared);
  assertEquals(((await Deno.stat(shared)).mode ?? 0) & 0o777, 0o700);
});
