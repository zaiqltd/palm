import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJSON, writePrivateJSON } from "../platform/store.mjs";

// Shared: links, notes and files the Mac hands to the phone (and the phone to
// the Mac), kept until removed: anything the laptop wants to pass on to the
// phone. A file is shared by its path; the phone downloads it through Files' usual checks, so a file
// that holds credentials still asks first and Palm's own folder stays closed.
const MAX_ITEMS = 500;
const MAX_TEXT = 100000;
// The list carries the start of a long note; the whole note is one request away.
const PREVIEW = 4000;

export class SharedItems {
  constructor({ stateDir, policy, home = os.homedir(), onChange = () => {} }) {
    this.file = path.join(stateDir, "shared.json");
    this.policy = policy;
    this.home = home;
    this.onChange = onChange;
    this.items = null;
    this.writes = Promise.resolve();
  }

  async load() {
    if (!this.items) {
      const saved = await readJSON(this.file, null);
      this.items = Array.isArray(saved?.items) ? saved.items : [];
    }
    return this.items;
  }

  save() {
    const write = () => writePrivateJSON(this.file, { version: 1, items: this.items });
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Newest first; long notes cut to their start, files checked again. */
  async list() {
    const items = await this.load();
    return { items: await Promise.all(items.map((item) => this.present(item, true))) };
  }

  async get(id) {
    const item = (await this.load()).find((i) => i.id === id);
    if (!item) throw Object.assign(new Error("That item is no longer shared."), { status: 404 });
    return this.present(item, false);
  }

  /**
   * One item: `text` (a link when it is a single web address) or `path` (a
   * file on this Mac). `from` is "mac" or the phone's name.
   */
  async add({ text, path: file, title, from = "mac" } = {}) {
    const items = await this.load();
    const label = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const source = from === "mac" ? "mac" : "phone";
    const device = source === "phone" ? String(from).slice(0, 80) : null;
    let item;
    if (typeof file === "string" && file.trim()) {
      const absolute = this.resolve(file.trim());
      if (this.policy?.classify(absolute) === "blocked") throw new Error("Palm cannot share that file.");
      const info = await stat(absolute).catch(() => null);
      if (!info) throw new Error("That file does not exist on this Mac.");
      if (!info.isFile()) throw new Error("Share a file, not a folder.");
      item = { kind: "file", path: absolute, name: path.basename(absolute), size: info.size };
    } else {
      const value = typeof text === "string" ? text.replace(/\r\n/g, "\n").trim() : "";
      if (!value) throw new Error("Nothing to share: add a link, some text or a file.");
      if (value.length > MAX_TEXT) throw new Error("Share up to 100,000 characters at a time.");
      item = isLink(value) ? { kind: "link", url: value } : { kind: "text", text: value };
    }
    Object.assign(item, { id: randomUUID(), title: label || null, source, device, created: new Date().toISOString() });
    items.unshift(item);
    items.splice(MAX_ITEMS);
    await this.save();
    this.onChange({ added: item.id });
    return this.present(item, true);
  }

  async remove(id) {
    const items = await this.load();
    const index = items.findIndex((i) => i.id === id);
    if (index >= 0) {
      items.splice(index, 1);
      await this.save();
      this.onChange({ removed: id });
    }
    return this.list();
  }

  resolve(value) {
    const expanded = value === "~" ? this.home : value.startsWith("~/") ? path.join(this.home, value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) throw new Error("Give the file's full path.");
    return path.resolve(expanded);
  }

  async present(item, short) {
    if (item.kind === "file") {
      const info = await stat(item.path).catch(() => null);
      const sensitive = this.policy?.classify(item.path) === "sensitive";
      return { ...item, exists: !!info?.isFile(), size: info?.isFile() ? info.size : item.size, sensitive };
    }
    if (item.kind === "text" && short && item.text.length > PREVIEW)
      return { ...item, text: item.text.slice(0, PREVIEW), length: item.text.length, partial: true };
    return item.kind === "text" ? { ...item, length: item.text.length, partial: false } : item;
  }
}

/** A single http(s) address with no spaces: shown and opened as a link. */
export function isLink(value) {
  if (!/^https?:\/\/\S+$/i.test(value) || value.length > 4000) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
