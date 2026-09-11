/**
 * Where a holder's unix socket lives, after `swamp_rack/instruments/drive/holder_paths.ts`.
 *
 * A socket is an access path to a physical device, so the directory is
 * private (0700, refused when group/other bits are set), the base follows
 * `$XDG_RUNTIME_DIR` → `$TMPDIR` → `/tmp` so two users on one machine never
 * share a directory, and the whole path is kept under the unix-socket limit
 * (104 bytes including the terminator on macOS, so 103 usable) by hashing
 * the identity to 12 hex characters and falling back to `/tmp` when the
 * environment's directory is long.
 *
 * @module
 */

/** Longest socket path macOS accepts (sun_path is 104 bytes with NUL). */
export const UNIX_SOCKET_MAX = 103;

/** The app directory name under the base; short, lowercase, hyphens. */
const APP_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Candidate base directories, in order of preference. */
function bases(): string[] {
  const out: string[] = [];
  for (const k of ["XDG_RUNTIME_DIR", "TMPDIR"]) {
    const v = Deno.env.get(k);
    if (v) out.push(v.replace(/\/+$/, ""));
  }
  out.push("/tmp");
  return out;
}

/**
 * The directory for `app`'s sockets: the first base under which a
 * 17-byte socket filename still fits the limit.
 */
export function socketDir(app: string): string {
  if (!APP_RE.test(app) || app.length > 32) {
    throw new Error(
      `socket app name must match ${APP_RE} and be <= 32 chars: ${app}`,
    );
  }
  for (const b of bases()) {
    const dir = `${b}/${app}`;
    if (dir.length + 1 + 17 <= UNIX_SOCKET_MAX) return dir;
  }
  return `/tmp/${app}`;
}

/**
 * Create `dir` privately (0700) if needed. A directory readable by group or
 * others would hand the device to every local user, so one we own is
 * tightened to 0700 and one we do not own is refused.
 */
export async function ensureSocketDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  let st = await Deno.stat(dir);
  if (st.mode !== null && st.mode !== undefined && (st.mode & 0o077) !== 0) {
    if (st.uid === Deno.uid()) {
      await Deno.chmod(dir, 0o700);
      st = await Deno.stat(dir);
    }
    if ((st.mode ?? 0) & 0o077) {
      throw new Error(
        `socket dir ${dir} is accessible to other users (mode ${
          ((st.mode ?? 0) & 0o777).toString(8)
        }) and not ours to fix; set XDG_RUNTIME_DIR / TMPDIR to a private directory`,
      );
    }
  }
}

/** `dir/<12 hex of sha256(identity)>.sock`, length-checked. */
export async function socketPathFor(
  dir: string,
  identity: string,
): Promise<string> {
  if (!identity) throw new Error("socket identity must not be empty");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const hex = [...new Uint8Array(digest)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const path = `${dir}/${hex.slice(0, 12)}.sock`;
  if (path.length > UNIX_SOCKET_MAX) {
    throw new Error(
      `socket path too long (${path.length} > ${UNIX_SOCKET_MAX}): ${path}`,
    );
  }
  return path;
}
