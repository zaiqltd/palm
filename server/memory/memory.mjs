import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome } from "../platform/env.mjs";
import { readJSON, writePrivateJSON } from "../platform/store.mjs";

// What Palm remembers about this computer's work, outside any chat: folder
// aliases ("normal work folder"), workspaces (a friendly name for a real
// folder, of documents or code) and preferences such as the default agent.
// It lives on each computer, because its paths belong to that computer, and
// every remembered folder is checked again before it is used.
export class WorkMemory {
  constructor({ stateDir, policy, home = os.homedir() }) {
    this.file = path.join(stateDir, "memory.json");
    this.policy = policy;
    this.home = home;
    this.data = null;
  }

  async load() {
    if (!this.data) {
      const saved = await readJSON(this.file, null);
      this.data = {
        version: 1,
        aliases: Array.isArray(saved?.aliases) ? saved.aliases : [],
        workspaces: Array.isArray(saved?.workspaces) ? saved.workspaces : [],
        preferences: saved?.preferences && typeof saved.preferences === "object" ? saved.preferences : {},
      };
    }
    return this.data;
  }

  async save() {
    await writePrivateJSON(this.file, this.data);
  }

  /** Everything remembered, each folder marked with whether it still exists. */
  async snapshot() {
    const data = await this.load();
    const check = async (item) => ({ ...item, exists: await isFolder(item.path) });
    return {
      aliases: await Promise.all(data.aliases.map(check)),
      workspaces: await Promise.all(data.workspaces.map(check)),
      preferences: { defaultAgent: data.preferences.defaultAgent || null, answerQuestions: data.preferences.answerQuestions !== false },
    };
  }

  async folder(value) {
    const text = String(value || "").trim();
    const expanded = text === "~" ? this.home : text.startsWith("~/") ? path.join(this.home, text.slice(2)) : expandHome(text);
    const folder = path.resolve(expanded || this.home);
    if (this.policy?.classify(folder) === "blocked") throw new Error("Palm cannot use that folder.");
    if (!(await isFolder(folder))) throw new Error("That folder does not exist on this Mac.");
    return folder;
  }

  async setAlias({ id, name, path: value } = {}) {
    const data = await this.load();
    const label = cleanName(name);
    const folder = await this.folder(value);
    const existing = data.aliases.find((a) => a.id === id || a.name.toLowerCase() === label.toLowerCase());
    if (existing) Object.assign(existing, { name: label, path: folder });
    else data.aliases.push({ id: randomUUID(), name: label, path: folder });
    await this.save();
    return this.snapshot();
  }

  async setWorkspace({ id, name, path: value } = {}) {
    const data = await this.load();
    const label = cleanName(name);
    const folder = await this.folder(value);
    const existing = data.workspaces.find((w) => w.id === id || w.name.toLowerCase() === label.toLowerCase());
    if (existing) Object.assign(existing, { name: label, path: folder });
    else data.workspaces.push({ id: randomUUID(), name: label, path: folder, created: new Date().toISOString() });
    await this.save();
    return this.snapshot();
  }

  async remove(kind, id) {
    const data = await this.load();
    const list = kind === "alias" ? data.aliases : data.workspaces;
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) list.splice(index, 1);
    await this.save();
    return this.snapshot();
  }

  async setPreferences({ defaultAgent, answerQuestions } = {}) {
    const data = await this.load();
    if (defaultAgent === null || (typeof defaultAgent === "string" && /^[\w-]{1,40}$/.test(defaultAgent)))
      data.preferences.defaultAgent = defaultAgent;
    if (typeof answerQuestions === "boolean") data.preferences.answerQuestions = answerQuestions;
    await this.save();
    return this.snapshot();
  }

  async preferences() {
    return (await this.load()).preferences;
  }

  /**
   * A folder named in plain words: an alias ("normal work folder"), a
   * workspace ("website"), a project found on this Mac, a folder in the home
   * folder, or the home folder itself. Only folders that exist are returned.
   */
  async resolveFolder(phrase, { projects: projectSource = [] } = {}) {
    // An exact path is used exactly, or not at all.
    const raw = String(phrase || "").trim().replace(/[?.!,;]+$/, "");
    if (raw.startsWith("~") || raw.startsWith("/")) {
      const folder = await this.folder(raw).catch(() => null);
      return folder ? { path: folder, label: folder === this.home ? "Home folder" : path.basename(folder), source: "path" } : null;
    }
    const words = normalise(phrase);
    if (!words) return null;
    const data = await this.load();
    if (/^(home|my home|home folder|my home folder|~)$/.test(words)) return { path: this.home, label: "Home folder", source: "home" };
    const byName = (items) =>
      items.find((item) => normalise(item.name) === words) ||
      items.find((item) => words.includes(normalise(item.name)) && normalise(item.name).length >= 3);
    for (const [items, source] of [
      [data.aliases, "alias"],
      [data.workspaces, "workspace"],
    ]) {
      const match = byName(items);
      if (match && (await isFolder(match.path))) return { path: match.path, label: match.name, source, id: match.id };
    }
    // Scanning for projects is the slow part: only when nothing above matched.
    // Several projects fitting the words are offered as choices, never guessed.
    const projects = typeof projectSource === "function" ? await projectSource() : projectSource;
    const levels = [
      projects.filter((p) => normalise(p.name) === words),
      projects.filter((p) => p.packageName && normalise(p.packageName) === words),
      words.length >= 3 ? projects.filter((p) => normalise(p.name).includes(words)) : [],
    ];
    for (const level of levels) {
      const found = [];
      for (const p of level) if (await isFolder(p.path)) found.push({ path: p.path, label: p.name, source: "project" });
      if (found.length === 1) return found[0];
      if (found.length > 1) return { choices: found.sort((a, b) => a.label.length - b.label.length).slice(0, 5) };
    }
    // A folder right in the home folder, such as "Documents" or "work".
    for (const candidate of [words, capitalised(words)]) {
      const folder = path.join(this.home, candidate);
      if (!candidate.includes("/") && (await isFolder(folder))) return { path: folder, label: path.basename(folder), source: "folder" };
    }
    return null;
  }
}

async function isFolder(value) {
  const info = await stat(value).catch(() => null);
  return !!info?.isDirectory();
}

function cleanName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 60) throw new Error("Give it a name of up to 60 characters.");
  return name;
}

/** Lowercase words without "my", "the", "folder" and punctuation. */
export function normalise(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s~/-]/gu, " ")
    .replace(/\b(my|the|our|a|an|project|repo|repository|workspace|folder|directory)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalised(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
