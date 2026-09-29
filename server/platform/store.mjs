import { appendFile, mkdir, readFile, chmod, lstat, open } from "node:fs/promises";
import path from "node:path";
import { writePrivateJSON } from "../security.mjs";

export async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid())
    throw new Error("Palm storage must be a folder owned by this user.");
  await chmod(dir, 0o700);
  return dir;
}

export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export { writePrivateJSON };

// Append-only event log. Each line is one JSON object. Files are owner-only.
export class JsonlLog {
  constructor(file) {
    this.file = file;
    this.writes = Promise.resolve();
  }
  append(entry) {
    const line = JSON.stringify(entry) + "\n";
    const write = async () => {
      await privateDir(path.dirname(this.file));
      const handle = await open(this.file, "a", 0o600);
      try {
        await handle.write(line);
      } finally {
        await handle.close();
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
  async readAll(limit = 20000) {
    // Events emitted a moment ago are still queued; a reader must see them.
    await this.writes.catch(() => {});
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const lines = raw.split("\n").filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  }
}

export { appendFile };
