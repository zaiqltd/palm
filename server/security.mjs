import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  realpath,
  readdir,
  stat,
  mkdir,
  chmod,
  lstat,
  open,
  rename,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const browserLifetime = 12 * 3600000;
const nativeLifetime = 30 * 24 * 3600000;
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export async function writePrivateJSON(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid()
  )
    throw new Error("Palm storage must be a folder owned by this user.");
  await chmod(directory, 0o700);
  const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const folder = await open(directory, constants.O_RDONLY);
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

export class Sessions {
  constructor(now = () => Date.now(), file = null) {
    this.now = now;
    this.file = file;
    this.sessions = new Map();
    this.pendingRevocations = new Map();
    this.code = null;
    this.attempts = [];
    this.writes = Promise.resolve();
  }
  static async open(file = null, now = () => Date.now()) {
    const sessions = new Sessions(now, file);
    if (!file) return sessions;
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== process.getuid()
    )
      throw new Error(
        "Palm device storage must be a folder owned by this user.",
      );
    await chmod(directory, 0o700);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid() || info.size > 65536)
        throw new Error("Palm device storage is invalid.");
      await handle.chmod(0o600);
      const saved = JSON.parse(await handle.readFile("utf8"));
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.devices) ||
        saved.devices.length > 32
      )
        throw new Error("Palm device storage is invalid.");
      for (const d of saved.devices) {
        if (
          !d ||
          !/^[a-f0-9]{16}$/.test(d.id) ||
          !/^[a-f0-9]{64}$/.test(d.tokenHash) ||
          d.kind !== "native" ||
          typeof d.name !== "string" ||
          d.name.length > 50 ||
          !Number.isSafeInteger(d.expires)
        )
          throw new Error("Palm device storage is invalid.");
        if (d.expires > now())
          sessions.sessions.set(d.tokenHash, {
            id: d.id,
            tokenHash: d.tokenHash,
            name: d.name,
            expires: d.expires,
            kind: "native",
          });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await handle?.close();
    }
    return sessions;
  }
  persist() {
    if (!this.file) return Promise.resolve();
    const revocations = [...this.pendingRevocations];
    const snapshot = JSON.stringify({
      version: 1,
      devices: [...this.sessions.values()].filter(
        (s) => s.kind === "native" && s.expires > this.now(),
      ),
    });
    const write = async () => {
      await writePrivateJSON(this.file, JSON.parse(snapshot));
      // Only acknowledge revocations excluded by this particular snapshot.
      // A newer queued revocation must remain visible until its own save succeeds.
      for (const [id, revoked] of revocations)
        if (this.pendingRevocations.get(id) === revoked)
          this.pendingRevocations.delete(id);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
  rotate() {
    this.code = {
      value: randomBytes(5).toString("hex").toUpperCase(),
      expires: this.now() + 120000,
    };
    return this.code;
  }
  consumeCode(value) {
    this.attempts = this.attempts.filter((t) => t > this.now() - 60000);
    if (this.attempts.length >= 8)
      throw new Error("Too many attempts. Wait a minute and try again.");
    this.attempts.push(this.now());
    const code = this.code;
    const candidate = String(value).replace(/[ -]/g, "").toUpperCase();
    if (
      !code ||
      code.expires <= this.now() ||
      !/^[A-F0-9]{10}$/.test(candidate) ||
      !timingSafeEqual(Buffer.from(candidate), Buffer.from(code.value))
    )
      throw new Error("That pairing code is incorrect or has expired.");
    this.code = null;
  }
  pair(value, name = "Phone") {
    this.consumeCode(value);
    return this.create(name);
  }
  async pairNative(value, name = "iPhone") {
    if (!this.file) throw new Error("Durable device pairing is unavailable.");
    this.consumeCode(value);
    const session = this.create(name, "native");
    try {
      await this.persist();
    } catch {
      this.sessions.delete(tokenHash(session.token));
      throw new Error(
        "Palm could not save this device. Check storage on the Mac.",
      );
    }
    return session;
  }
  create(name, kind = "browser") {
    for (const [hash, s] of this.sessions)
      if (s.expires <= this.now()) this.sessions.delete(hash);
    for (const [id, s] of this.pendingRevocations)
      if (s.expires <= this.now()) this.pendingRevocations.delete(id);
    if (
      [...this.sessions.values(), ...this.pendingRevocations.values()].filter(
        (s) => s.kind === kind,
      ).length >= (kind === "native" ? 32 : 64)
    )
      throw new Error(
        "Too many paired devices. Revoke an older device on the Mac.",
      );
    const token = randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    const s = {
      id: randomBytes(8).toString("hex"),
      tokenHash: hash,
      name:
        String(name)
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 50) || "Phone",
      kind,
      expires:
        this.now() + (kind === "native" ? nativeLifetime : browserLifetime),
    };
    this.sessions.set(hash, s);
    return { ...s, token };
  }
  get(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return null;
    const hash = tokenHash(token),
      s = this.sessions.get(hash);
    if (!s || s.expires <= this.now()) {
      this.sessions.delete(hash);
      return null;
    }
    return { ...s, token };
  }
  revoke(id) {
    for (const [hash, s] of this.sessions)
      if (s.id === id) {
        this.sessions.delete(hash);
        if (s.kind === "native") this.pendingRevocations.set(id, s);
      }
    if (!this.pendingRevocations.has(id)) return Promise.resolve();
    return this.persist().catch(() => {
      throw new Error(
        "Device access is blocked for this run, but Palm could not save its removal. Retry on the Mac before restarting Palm.",
      );
    });
  }
  list() {
    // A failed durable removal remains available for retry in Mac setup, but
    // its token stays absent from sessions and therefore cannot authenticate.
    return [...this.sessions.values(), ...this.pendingRevocations.values()]
      .filter((s) => s.expires > this.now())
      .map(({ id, name, expires, kind }) => ({ id, name, expires, kind }));
  }
}
export function bearerToken(req) {
  if (!req.headers.authorization) return null;
  return (
    /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization)?.[1] || null
  );
}
export function sessionCookie(req) {
  return (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("palm_session="))
    ?.slice(13);
}
export function isLocal(req) {
  return (
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress,
    ) &&
    !Object.keys(req.headers).some(
      (h) =>
        h === "forwarded" ||
        h.startsWith("x-forwarded-") ||
        h.startsWith("tailscale-"),
    ) &&
    ["localhost", "127.0.0.1", "[::1]"].includes(
      (req.headers.host || "").replace(/:\d+$/, ""),
    )
  );
}
export function checkOrigin(req, allowed) {
  return allowed.has(req.headers.origin);
}
export async function safeFile(root, relative = "") {
  if (
    typeof relative !== "string" ||
    relative.includes("\0") ||
    relative.includes("\\") ||
    path.isAbsolute(relative) ||
    relative.split("/").some((p) => p.startsWith("."))
  )
    throw new Error("This file is outside your shared folder.");
  const base = await realpath(root),
    file = await realpath(path.join(base, relative));
  if (file !== base && !file.startsWith(base + path.sep))
    throw new Error("This file is outside your shared folder.");
  if (
    path
      .relative(base, file)
      .split(path.sep)
      .some((p) => p.startsWith("."))
  )
    throw new Error("Hidden files are not shared.");
  return file;
}
export async function listFiles(root, relative = "") {
  const folder = await safeFile(root, relative);
  const items = await readdir(folder, { withFileTypes: true });
  const list = [];
  for (const entry of items
    .filter((x) => !x.name.startsWith("."))
    .slice(0, 500)) {
    const rel = path.posix.join(relative, entry.name);
    try {
      const p = await safeFile(root, rel),
        s = await stat(p);
      if (s.isDirectory() || s.isFile())
        list.push({
          name: entry.name,
          path: rel,
          directory: s.isDirectory(),
          size: s.size,
          modified: s.mtime.toISOString(),
        });
    } catch {}
  }
  return list.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
}
const keyNames = new Set([
  "enter",
  "escape",
  "backspace",
  "tab",
  "left",
  "right",
  "up",
  "down",
  "space",
  "save",
  "undo",
  "redo",
  "copy",
  "paste",
  "selectAll",
  "find",
  "closeWindow",
]);
// Keys the phone may press with modifiers (matches the companion's key table).
const freeKeys = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789",
  "=", "-", "]", "[", "'", ";", "\\", ",", "/", ".", "`",
  "return", "enter", "tab", "space", "delete", "backspace", "escape", "esc", "forwarddelete",
  "home", "end", "pageup", "pagedown", "left", "right", "down", "up",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
export function validateCommand(x) {
  if (!x || typeof x !== "object") throw new Error("Invalid command.");
  switch (x.op) {
    case "status":
    case "apps":
    case "installedApps":
    case "displays":
    case "dockItems":
    case "actions":
    case "stop":
    case "keyframe":
      return { op: x.op };
    case "quality":
      // The phone's zoom, so the Mac can send a sharper stream (1 to 16).
      if (!Number.isFinite(x.zoom) || x.zoom < 1 || x.zoom > 16) break;
      return { op: "quality", zoom: Math.round(x.zoom * 100) / 100 };
    case "action":
      if (
        typeof x.actionId !== "string" ||
        !/^[-A-Fa-f0-9]{36}$/.test(x.actionId)
      )
        break;
      return { op: x.op, actionId: x.actionId };
    case "start":
      if (
        (x.windowId !== undefined &&
          (!Number.isSafeInteger(x.windowId) ||
            x.windowId < 0 ||
            x.windowId > 0xffffffff)) ||
        (x.phoneLayout !== undefined && typeof x.phoneLayout !== "boolean") ||
        (x.fill !== undefined && typeof x.fill !== "boolean") ||
        (x.wholeScreen !== undefined && typeof x.wholeScreen !== "boolean") ||
        (x.displayId !== undefined && (!Number.isSafeInteger(x.displayId) || x.displayId < 0 || x.displayId > 0xffffffff)) ||
        (x.flow !== undefined && typeof x.flow !== "boolean") ||
        (x.fill === true && x.phoneLayout === true)
      )
        break;
      if (
        (x.phoneLayoutWidth !== undefined ||
          x.phoneLayoutHeight !== undefined) &&
        (x.phoneLayout !== true ||
          !Number.isFinite(x.phoneLayoutWidth) ||
          !Number.isFinite(x.phoneLayoutHeight) ||
          x.phoneLayoutWidth < 240 ||
          x.phoneLayoutWidth > 1400 ||
          x.phoneLayoutHeight < 200 ||
          x.phoneLayoutHeight > 1400)
      )
        break;
      return {
        op: "start",
        windowId: x.windowId ?? 0,
        ...(x.phoneLayout === undefined ? {} : { phoneLayout: x.phoneLayout }),
        ...(x.fill === undefined ? {} : { fill: x.fill }),
        ...(x.wholeScreen === undefined ? {} : { wholeScreen: x.wholeScreen }),
        ...(x.displayId === undefined ? {} : { displayId: x.displayId }),
        // The phone confirms every frame it receives (see screen-flow.mjs).
        ...(x.flow === true ? { flow: true } : {}),
        ...(x.phoneLayoutWidth === undefined
          ? {}
          : {
              phoneLayoutWidth: x.phoneLayoutWidth,
              phoneLayoutHeight: x.phoneLayoutHeight,
            }),
      };
    case "revealEdge":
      if (!["top", "bottom"].includes(x.edge)) break;
      return { op: x.op, edge: x.edge };
    case "dockPress":
      if (!Number.isSafeInteger(x.index) || x.index < 0 || x.index > 500) break;
      return { op: x.op, index: x.index };
    case "activate":
    case "launch":
      if (
        typeof x.bundleId !== "string" ||
        x.bundleId.length > 200 ||
        !/^[\w.-]+$/.test(x.bundleId)
      )
        break;
      return { op: x.op, bundleId: x.bundleId };
    case "pointer":
      if (
        ![
          "move",
          "down",
          "up",
          "click",
          "double",
          "doubleSecond",
          "right",
        ].includes(x.action) ||
        !Number.isFinite(x.x) ||
        !Number.isFinite(x.y)
      )
        break;
      return {
        op: x.op,
        action: x.action,
        x: Math.max(0, Math.min(1, x.x)),
        y: Math.max(0, Math.min(1, x.y)),
      };
    case "scroll":
      if (!Number.isFinite(x.dx) || !Number.isFinite(x.dy)) break;
      return {
        op: x.op,
        dx: Math.max(-500, Math.min(500, x.dx)),
        dy: Math.max(-500, Math.min(500, x.dy)),
      };
    case "text":
      if (typeof x.text !== "string" || x.text.length > 4000) break;
      return { op: x.op, text: x.text };
    case "key": {
      const modifiers = Array.isArray(x.modifiers)
        ? x.modifiers.filter((m) => ["cmd", "shift", "opt", "ctrl", "fn"].includes(m)).slice(0, 4)
        : [];
      if (keyNames.has(x.key) && !modifiers.length) return { op: x.op, key: x.key };
      if (typeof x.key !== "string" || !freeKeys.has(x.key.toLowerCase())) break;
      return { op: x.op, key: x.key.toLowerCase(), modifiers };
    }
    case "lock":
      if (x.confirm !== true) break;
      return { op: x.op };
  }
  throw new Error("Unsupported command.");
}
