import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// The files an agent's turn made or pointed to, so the phone can save or open
// them from the chat like the Assistant's results ("if I
// ask it to create a PDF, I can't retrieve it in chat like the Assistant does").
// Only things worth having on a phone count: documents, pictures, audio and
// video, archives, named by the agent or changed while it worked. A text file
// (txt, md, csv) or web page counts only when the turn created or changed it,
// so a coding chat is not filled with READMEs it merely mentions; code never does.

const documents = new Set([
  "pdf", "doc", "docx", "rtf", "odt", "pages", "xls", "xlsx", "ods", "numbers", "ppt", "pptx", "key", "odp", "epub",
  "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp", "svg",
  "mp3", "m4a", "wav", "aac", "mp4", "mov", "m4v", "webm", "zip", "ics", "vcf",
]);
const texts = new Set(["txt", "md", "csv", "tsv"]);
const pages = new Set(["html", "htm"]);
const skipped = new Set(["node_modules", ".git", "Library", "build", "dist", ".build", "DerivedData", "Pods", ".next", "vendor", "__pycache__"]);

const kindOf = (file) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  return documents.has(ext) ? "document" : texts.has(ext) ? "text" : pages.has(ext) ? "page" : null;
};

/** File paths in an agent's words: `/abs`, `~/x`, markdown links, and names with an extension. */
export function mentionedPaths(text, { cwd, home }) {
  const found = [];
  const add = (raw, at) => {
    const clean = String(raw).trim().replace(/^[`'"(<]+|[`'")>.,;:!?]+$/g, "");
    if (!clean || clean.includes("://") || !/\.[A-Za-z0-9]{1,6}$/.test(clean)) return;
    let expanded = clean;
    try { expanded = decodeURIComponent(clean); } catch {}
    if (expanded.startsWith("~/")) expanded = path.join(home, expanded.slice(2));
    found.push({ at, file: path.resolve(cwd, expanded) });
  };
  const words = String(text || "");
  for (const match of words.matchAll(/`([^`\n]{1,300})`/g)) add(match[1], match.index);
  for (const match of words.matchAll(/\]\(([^)\s]{1,300})\)/g)) add(match[1], match.index);
  for (const match of words.matchAll(/(?:^|[\s(])((?:~\/|\/)[^\s`'"<>()]{1,300})/g)) add(match[1], match.index);
  for (const match of words.matchAll(/(?:^|[\s(*"'])((?:[\w.-]+\/){0,6}[\w.-]{1,120}\.[A-Za-z0-9]{2,5})(?=$|[\s)*"',.;:!?])/g)) add(match[1], match.index);
  // In the order the agent wrote them, each once.
  const seen = new Set();
  return found.sort((a, b) => a.at - b.at).map((f) => f.file).filter((f) => !seen.has(f) && seen.add(f));
}

/** Paths an agent's file tools wrote: Claude's Write/Edit (the path is the detail), Codex's file changes. */
export function toolPaths(tools, { cwd }) {
  const found = [];
  for (const tool of tools) {
    const name = String(tool.name || "");
    const detail = String(tool.detail || "");
    if (/^(Write|Edit|MultiEdit|NotebookEdit|edit|write)$/.test(name) && detail) found.push(path.resolve(cwd, detail.split("\n")[0].trim()));
    if (name === "files")
      for (const line of detail.split("\n")) {
        const match = /^(?:add|update|create|modify)\s+(.+)$/i.exec(line.trim());
        if (match) found.push(path.resolve(cwd, match[1].trim()));
      }
  }
  return found;
}

/** Documents and new files in the folder the agent works in (and one level down), changed during the turn. */
async function changedNearby(cwd, since, limit = 400) {
  const found = [];
  let seen = 0;
  const visit = async (dir, depth) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > limit) return;
      if (entry.name.startsWith(".") || skipped.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 1) await visit(full, depth + 1);
      } else if (entry.isFile() && kindOf(entry.name)) {
        const info = await stat(full).catch(() => null);
        if (info && info.mtimeMs >= since) found.push(full);
      }
    }
  };
  await visit(cwd, 0);
  return found;
}

/**
 * The turn's files, newest mention first: named by the agent, written by its
 * tools, or changed beside it while it worked. Each exists, is not blocked by
 * Palm's file policy, and is at most `limit`.
 */
export async function turnFiles({ texts: words = [], tools = [], cwd, since, home, policy = null, limit = 6 }) {
  if (!cwd) return [];
  // The turn starts when Palm sends the message, before the agent writes
  // anything; the margin only covers timestamp rounding.
  const start = since - 200;
  const mentioned = words.flatMap((t) => mentionedPaths(t, { cwd, home }));
  const namedSet = new Set(mentioned);
  const candidates = [...mentioned, ...toolPaths(tools, { cwd }), ...(await changedNearby(cwd, start))];
  const files = [];
  const done = new Set();
  for (const file of candidates) {
    if (done.has(file)) continue;
    done.add(file);
    const kind = kindOf(file);
    if (!kind) continue;
    if (policy && policy.classify(file) === "blocked") continue;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const changed = info.mtimeMs >= start;
    const created = (info.birthtimeMs || info.mtimeMs) >= start;
    // A document named or changed in the turn; a text file new, or named and
    // changed; a page named and changed.
    const named = namedSet.has(file);
    const counts = kind === "document" ? named || changed : kind === "text" ? created || (named && changed) : named && changed;
    if (!counts) continue;
    files.push({ file, info });
    if (files.length >= limit) break;
  }
  return files;
}
