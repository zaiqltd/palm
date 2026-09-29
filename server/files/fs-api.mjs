import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "../platform/env.mjs";

// Palm's full-filesystem model: the paired phone may
// browse and work with any path this macOS account can reach, including hidden
// project files. Three deliberate limits remain:
//  1. Palm's own private state (device-token hashes, settings) is never served.
//  2. Other identities' credentials stay put: the secondary Codex account home
//     is blocked outright; the owner's credential stores need an explicit
//     per-request confirmation before content leaves the Mac.
//  3. Nothing is permanently deleted: removal moves items to the macOS Trash.
// macOS privacy permissions (Files & Folders, Full Disk Access) still apply to
// the Palm process and are reported as such rather than bypassed.

const home = os.homedir();

export class FsPolicy {
  constructor({ stateDir, blocked = [], sensitive = [] } = {}) {
    this.blocked = [
      stateDir,
      path.join(home, "Library/Application Support/Palm"),
      ...blocked,
    ]
      .filter(Boolean)
      .map((p) => path.resolve(p));
    this.sensitive = [
      path.join(home, ".credentials"),
      path.join(home, ".ssh"),
      path.join(home, ".gnupg"),
      path.join(home, ".aws"),
      path.join(home, ".netrc"),
      path.join(home, "Library/Keychains"),
      path.join(home, ".codex/auth.json"),
      path.join(home, ".claude/.credentials.json"),
      path.join(home, ".config/gh"),
      ...sensitive,
    ].map((p) => path.resolve(p));
  }
  static inside(child, parent) {
    return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
  }
  classify(absolute) {
    if (this.blocked.some((b) => FsPolicy.inside(absolute, b))) return "blocked";
    if (this.sensitive.some((s) => FsPolicy.inside(absolute, s))) return "sensitive";
    return "allowed";
  }
}

export class FsError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireAbsolute(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0"))
    throw new FsError("Choose a file or folder on your Mac.");
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new FsError("Use a full path on your Mac.");
  return path.resolve(expanded);
}

function friendlyFsError(error, target) {
  if (error instanceof FsError) return error;
  const name = path.basename(target || "") || "that item";
  switch (error?.code) {
    case "ENOENT":
      return new FsError(`${name} no longer exists on your Mac.`, 404, "missing");
    case "EACCES":
    case "EPERM":
      return new FsError(
        `macOS blocked Palm from ${name}. Allow Palm in System Settings › Privacy & Security › Files and Folders or Full Disk Access.`,
        403,
        "permission",
      );
    case "EEXIST":
      return new FsError(`${name} already exists.`, 409, "exists");
    case "ENOTDIR":
      return new FsError(`${name} is not a folder.`, 400, "notFolder");
    case "EISDIR":
      return new FsError(`${name} is a folder.`, 400, "folder");
    case "ENOSPC":
      return new FsError("Your Mac is out of disk space.", 507, "space");
    case "EXDEV":
      return new FsError("That move crosses disks; use Copy instead.", 400, "crossDevice");
    default:
      return new FsError(error?.message || "The file operation failed.", 400, "failed");
  }
}

function validName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  )
    throw new FsError("Use a file name without slashes.");
  return name.normalize("NFC");
}

export class FsApi {
  constructor({ policy, trash, inbox }) {
    this.policy = policy;
    this.trash = trash; // async (paths) => [{from, to}] — native Trash with Put Back
    this.inbox = inbox;
  }

  // Resolve an existing path through symlinks, then apply policy to the real
  // location. A link inside an allowed folder cannot reach Palm's state.
  async resolveExisting(value, { confirmSensitive = false, forContent = false } = {}) {
    const absolute = requireAbsolute(value);
    let real;
    try {
      real = await realpath(absolute);
    } catch (error) {
      throw friendlyFsError(error, absolute);
    }
    for (const candidate of [absolute, real]) {
      const kind = this.policy.classify(candidate);
      if (kind === "blocked")
        throw new FsError("Palm keeps this location private.", 403, "blocked");
      if (kind === "sensitive" && forContent && !confirmSensitive)
        throw new FsError(
          "This location holds credentials. Confirm on the phone to open it.",
          428,
          "sensitive",
        );
    }
    return { absolute, real };
  }

  // A destination that may not exist yet: its parent must exist and be allowed.
  async resolveNew(folder, name) {
    const dir = await this.resolveExisting(folder);
    const info = await stat(dir.real).catch((e) => {
      throw friendlyFsError(e, dir.real);
    });
    if (!info.isDirectory()) throw new FsError("Choose a folder as the destination.");
    const target = path.join(dir.real, validName(name));
    if (this.policy.classify(target) === "blocked")
      throw new FsError("Palm keeps this location private.", 403, "blocked");
    return target;
  }

  describe(absolute, info, linkInfo) {
    const name = path.basename(absolute) || absolute;
    return {
      name,
      path: absolute,
      kind: info?.isDirectory() ? "folder" : info?.isFile() ? "file" : "other",
      size: info?.isFile() ? info.size : null,
      modified: info ? info.mtime.toISOString() : null,
      hidden: name.startsWith("."),
      symlink: !!linkInfo?.isSymbolicLink(),
      sensitive: this.policy.classify(absolute) === "sensitive",
      package: !!info?.isDirectory() && /\.(app|bundle|framework|xcodeproj|xcworkspace|photoslibrary)$/i.test(name),
    };
  }

  async places() {
    const candidates = [
      ["Home", home, "house"],
      ["Work", path.join(home, "work"), "briefcase"],
      ["Inbox", this.inbox, "tray.and.arrow.down"],
      ["Desktop", path.join(home, "Desktop"), "menubar.dock.rectangle"],
      ["Documents", path.join(home, "Documents"), "doc"],
      ["Downloads", path.join(home, "Downloads"), "arrow.down.circle"],
      ["Applications", "/Applications", "square.grid.3x3"],
    ];
    const volumes = await readdir("/Volumes").catch(() => []);
    for (const v of volumes) if (!v.startsWith(".")) candidates.push([v, path.join("/Volumes", v), "externaldrive"]);
    const out = [];
    for (const [name, p, symbol] of candidates) {
      if (!p) continue;
      try {
        const info = await stat(p);
        if (info.isDirectory()) out.push({ name, path: p, symbol });
      } catch {}
    }
    return out;
  }

  async list(folder, { hidden = false, limit = 2000 } = {}) {
    const { absolute, real } = await this.resolveExisting(folder || home);
    let entries;
    try {
      const info = await stat(real);
      if (!info.isDirectory()) throw new FsError("Choose a folder to browse.");
      entries = await readdir(real, { withFileTypes: true });
    } catch (error) {
      throw friendlyFsError(error, absolute);
    }
    const items = [];
    let hiddenCount = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        hiddenCount++;
        if (!hidden) continue;
      }
      if (items.length >= limit) break;
      const child = path.join(absolute, entry.name);
      if (this.policy.classify(child) === "blocked") continue;
      try {
        const linkInfo = await lstat(child);
        const info = linkInfo.isSymbolicLink() ? await stat(child).catch(() => null) : linkInfo;
        items.push(this.describe(child, info, linkInfo));
      } catch {}
    }
    items.sort(
      (a, b) =>
        Number(b.kind === "folder") - Number(a.kind === "folder") ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    const parent = path.dirname(absolute);
    return {
      path: absolute,
      name: path.basename(absolute) || absolute,
      parent: parent === absolute ? null : parent,
      items,
      hiddenCount,
      truncated: entries.length > items.length + (hidden ? 0 : hiddenCount),
    };
  }

  async stat(value) {
    const { absolute, real } = await this.resolveExisting(value);
    try {
      const linkInfo = await lstat(absolute);
      const info = await stat(real);
      return this.describe(absolute, info, linkInfo);
    } catch (error) {
      throw friendlyFsError(error, absolute);
    }
  }

  async hash(value, options = {}) {
    const { absolute, real } = await this.resolveExisting(value, { ...options, forContent: true });
    const info = await stat(real).catch((e) => {
      throw friendlyFsError(e, absolute);
    });
    if (!info.isFile()) throw new FsError("Choose a file to verify.");
    const digest = createHash("sha256");
    await pipeline(createReadStream(real), digest);
    return { path: absolute, size: info.size, sha256: digest.digest("hex") };
  }

  // Stream a file to an HTTP response with single-range support so iOS can
  // resume or preview large downloads.
  async download(value, req, res, options = {}) {
    const { absolute, real } = await this.resolveExisting(value, { ...options, forContent: true });
    let info;
    try {
      info = await stat(real);
    } catch (error) {
      throw friendlyFsError(error, absolute);
    }
    if (!info.isFile()) throw new FsError("Choose a file to download.");
    const headers = {
      "Content-Type": contentType(absolute),
      "Accept-Ranges": "bytes",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(absolute))}`,
      "X-Palm-Size": String(info.size),
      "X-Palm-Modified": info.mtime.toISOString(),
    };
    let start = 0;
    let end = info.size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && info.size > 0) {
      if (range[1]) start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), info.size - 1);
      if (!range[1] && range[2]) {
        start = Math.max(0, info.size - Number(range[2]));
        end = info.size - 1;
      }
      if (start > end || start >= info.size) {
        res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": String(end - start + 1),
      });
    } else res.writeHead(200, { ...headers, "Content-Length": String(info.size) });
    if (req.method === "HEAD" || info.size === 0) return res.end();
    const stream = createReadStream(real, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  async preview(value, options = {}) {
    const { absolute, real } = await this.resolveExisting(value, { ...options, forContent: true });
    const info = await stat(real).catch((e) => {
      throw friendlyFsError(e, absolute);
    });
    if (!info.isFile()) throw new FsError("Choose a file to preview.");
    const handle = await open(real, "r");
    try {
      const size = Math.min(info.size, 256 * 1024);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      const binary = buffer.subarray(0, 8000).includes(0);
      return {
        path: absolute,
        size: info.size,
        truncated: info.size > size,
        binary,
        text: binary ? null : buffer.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }

  async uniqueTarget(target) {
    const dir = path.dirname(target);
    const ext = path.extname(target);
    const base = path.basename(target, ext);
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? target : path.join(dir, `${base} ${i + 1}${ext}`);
      try {
        await lstat(candidate);
      } catch (error) {
        if (error.code === "ENOENT") return candidate;
        throw friendlyFsError(error, candidate);
      }
    }
    throw new FsError("Too many files with that name.");
  }

  async placeTarget(target, conflict) {
    let exists = false;
    try {
      await lstat(target);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw friendlyFsError(error, target);
    }
    if (!exists) return { target, replaced: false };
    if (conflict === "replace") return { target, replaced: true };
    if (conflict === "rename") return { target: await this.uniqueTarget(target), replaced: false };
    throw new FsError(`${path.basename(target)} already exists in that folder.`, 409, "exists");
  }

  // Stream an upload to a temporary sibling, hash it on the way through, verify
  // length and the phone's SHA-256, then atomically rename into place. An
  // interrupted or corrupted upload never leaves a partial file behind.
  async upload(req, { folder, name, conflict = "rename", expectedSha256, expectedSize }) {
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw new FsError("Invalid upload checksum.");
    const requested = await this.resolveNew(folder, name);
    const { target, replaced } = await this.placeTarget(requested, conflict);
    const temporary = path.join(path.dirname(target), `.palm-upload-${randomBytes(6).toString("hex")}.part`);
    const digest = createHash("sha256");
    let size = 0;
    const counter = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        digest.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(temporary, { flags: "wx", mode: 0o644 }));
      const sha256 = digest.digest("hex");
      if (expectedSize !== undefined && size !== expectedSize)
        throw new FsError(`The upload was interrupted (${size} of ${expectedSize} bytes). Nothing was saved.`, 400, "incomplete");
      if (expectedSha256 && sha256 !== expectedSha256)
        throw new FsError("The upload arrived damaged (checksum mismatch). Nothing was saved.", 400, "checksum");
      if (replaced && this.trash) await this.trash([target]);
      await rename(temporary, target);
      return { path: target, name: path.basename(target), size, sha256, verified: !!expectedSha256, replaced };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw friendlyFsError(error, target);
    }
  }

  async mkdir(folder, name) {
    const target = await this.resolveNew(folder, name);
    try {
      await mkdir(target);
    } catch (error) {
      throw friendlyFsError(error, target);
    }
    return this.stat(target);
  }

  async rename(value, name) {
    const { absolute } = await this.resolveExisting(value);
    const target = await this.resolveNew(path.dirname(absolute), name);
    await this.placeTarget(target, "fail");
    try {
      await rename(absolute, target);
    } catch (error) {
      throw friendlyFsError(error, absolute);
    }
    return this.stat(target);
  }

  async transfer(paths, destination, { mode, conflict = "rename" }) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 200)
      throw new FsError("Choose up to 200 items.");
    const dest = await this.resolveExisting(destination);
    const destInfo = await stat(dest.real).catch((e) => {
      throw friendlyFsError(e, dest.absolute);
    });
    if (!destInfo.isDirectory()) throw new FsError("Choose a folder as the destination.");
    const results = [];
    for (const value of paths) {
      const { absolute, real } = await this.resolveExisting(value);
      if (FsPolicy.inside(dest.real, real)) throw new FsError("A folder cannot go inside itself.");
      const { target } = await this.placeTarget(
        await this.resolveNew(dest.absolute, path.basename(absolute)),
        conflict === "replace" ? "rename" : conflict,
      );
      try {
        if (mode === "move") {
          try {
            await rename(absolute, target);
          } catch (error) {
            if (error.code !== "EXDEV") throw error;
            await cp(absolute, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
            if (this.trash) await this.trash([absolute]);
          }
        } else
          await cp(absolute, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      } catch (error) {
        throw friendlyFsError(error, absolute);
      }
      results.push({ from: absolute, to: target });
    }
    return results;
  }

  async moveToTrash(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 200)
      throw new FsError("Choose up to 200 items.");
    const resolved = [];
    for (const value of paths) {
      const { absolute } = await this.resolveExisting(value);
      if (absolute === home || absolute === "/" || path.dirname(absolute) === "/")
        throw new FsError("Palm will not move that folder to the Trash.");
      resolved.push(absolute);
    }
    if (!this.trash) throw new FsError("Trash is unavailable.");
    return this.trash(resolved);
  }

  async search(folder, query, { limit = 200 } = {}) {
    if (typeof query !== "string" || !query.trim() || query.length > 200)
      throw new FsError("Enter something to search for.");
    const { absolute } = await this.resolveExisting(folder || home);
    const q = query.trim();
    // Spotlight name search first; it is fast and respects macOS privacy.
    const escaped = q.replace(/["\\*]/g, "");
    const result = await run(
      "/usr/bin/mdfind",
      ["-onlyin", absolute, `kMDItemFSName == "*${escaped}*"cd`],
      { timeout: 8000 },
    );
    const paths = result.stdout.split("\n").filter(Boolean).slice(0, limit * 2);
    const items = [];
    for (const p of paths) {
      if (items.length >= limit) break;
      if (this.policy.classify(p) === "blocked") continue;
      try {
        const linkInfo = await lstat(p);
        const info = linkInfo.isSymbolicLink() ? await stat(p).catch(() => null) : linkInfo;
        items.push(this.describe(p, info, linkInfo));
      } catch {}
    }
    return { path: absolute, query: q, items };
  }

  async readText(value) {
    const { real } = await this.resolveExisting(value, { forContent: true });
    return readFile(real, "utf8");
  }
}

const types = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
  ".csv": "text/csv; charset=utf-8",
};
export function contentType(file) {
  return types[path.extname(file).toLowerCase()] || "application/octet-stream";
}
