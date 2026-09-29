import { readdir, readFile, stat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Every agent working on this Mac, wherever it was started (
// "see whats running ... get notifications as things finish ...
// no matter where the agent is from"): Palm's own sessions, Claude Code
// (the desktop app, terminals, and the subagents and background agents they
// launch), Codex (desktop, CLI and exec runs, with their subagents) and
// OpenCode. It only reads what those apps already write on this Mac; it never
// starts, changes or answers them, and it keeps nothing.
//
// The status rules come from an earlier agent monitor, checked against real
// sessions on 23 September 2026: status comes from the session's own events,
// a finished turn is not proof the task succeeded, and silence is reported as
// quiet rather than guessed.
//
// Only the primary Codex account (~/.codex) is read; the secondary account's
// folder is never opened.

export const statusRank = { attention: 0, error: 1, working: 2, quiet: 3, finished: 4, idle: 5, unknown: 6 };
const minute = 60_000;
const hour = 60 * minute;

// ---- Text ----

export function compact(input, limit = 180) {
  let s = String(input || "");
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/[#*`]+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > limit) {
    // End on a whole word, without a truncation mark.
    const cut = s.slice(0, limit);
    const space = cut.lastIndexOf(" ");
    s = (space > limit * 0.6 ? cut.slice(0, space) : cut).trim();
  }
  return s;
}

export function activityFor(tool, input = {}) {
  const low = String(tool || "").toLowerCase();
  if (low.includes("request_user_input") || low.includes("askuserquestion")) return "Waiting for your answer";
  if (low.includes("web") || low.includes("search")) return "Searching and checking sources";
  if (low.includes("edit") || low.includes("patch") || low.includes("write")) return "Updating files";
  if (low.includes("read") || low.includes("cat") || low.includes("glob") || low.includes("grep")) return "Reading project files";
  if (low.includes("bash") || low.includes("exec") || low.includes("shell")) {
    const command = String(input?.command ?? input?.cmd ?? "");
    if (command.includes("test")) return "Running checks";
    if (command.includes("build")) return "Building and checking the project";
    return "Running a command";
  }
  if (low.includes("cua") || low.includes("browser") || low.includes("computer")) return "Using the screen or browser";
  if (low.includes("wait")) return "Waiting for a running operation";
  if (low === "agent" || low === "task" || low.includes("agent")) return "Coordinating agents";
  return "Using a tool";
}

function timeOf(value) {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

// ---- One session's state, from its events ----

export class TranscriptState {
  constructor() {
    this.lastActivity = 0;
    this.status = "unknown";
    this.activity = "No recent activity";
    this.latestMessage = "";
    this.latestUser = "";
    this.title = "";
    this.pendingQuestions = new Set();
    this.pendingTools = new Set();
  }

  /** Long silence is "quiet", an old finished turn is "idle". */
  resolvedStatus(now) {
    const age = now - this.lastActivity;
    if (this.status === "working" && age > (this.pendingTools.size ? 15 * minute : 150_000)) return "quiet";
    if (this.status === "finished" && age > 24 * hour) return "idle";
    return this.status;
  }

  touch(at) {
    if (at > this.lastActivity) this.lastActivity = at;
  }

  working(at) {
    this.touch(at);
    this.status = this.pendingQuestions.size ? "attention" : "working";
  }

  ingest(event, provider, { sidechain = false } = {}) {
    const at = timeOf(event?.timestamp);
    if (provider === "codex") this.codex(event, at);
    else this.claude(event, at, sidechain);
  }

  codex(e, at) {
    const p = e?.payload;
    if (!p || typeof e.type !== "string") return;
    const type = p.type || "";
    if (e.type === "event_msg") {
      switch (type) {
        case "task_started":
          this.pendingQuestions.clear();
          this.pendingTools.clear();
          this.working(at);
          this.activity = "Working on your request";
          break;
        case "task_complete":
          this.touch(at);
          this.status = "finished";
          this.pendingQuestions.clear();
          this.pendingTools.clear();
          this.activity = "Finished this turn";
          if (typeof p.last_agent_message === "string" && p.last_agent_message) this.latestMessage = p.last_agent_message;
          break;
        case "turn_aborted":
        case "task_aborted":
          this.touch(at);
          this.status = "idle";
          this.pendingQuestions.clear();
          this.activity = "Turn stopped";
          break;
        case "error":
          this.touch(at);
          this.status = "error";
          this.activity = "The agent reported an error";
          break;
        case "agent_message":
          if (typeof p.message === "string") this.latestMessage = p.message;
          this.working(at);
          break;
        case "user_message":
          if (typeof p.message === "string") this.latestUser = p.message;
          this.pendingQuestions.clear();
          this.working(at);
          break;
        case "item_completed": {
          // Newer Codex files: finished items of the turn.
          const item = p.item || {};
          const text = (Array.isArray(item.content) ? item.content : []).map((b) => b?.text).filter((t) => typeof t === "string").join("\n");
          if (item.type === "AgentMessage" && text) {
            this.latestMessage = text;
            this.working(at);
          } else if (item.type === "CommandExecution") {
            this.activity = activityFor("exec", { command: Array.isArray(item.command) ? item.command.join(" ") : item.command });
            this.working(at);
          } else if (item.type === "SubAgentActivity") {
            this.activity = "Coordinating agents";
            this.working(at);
          }
          break;
        }
      }
    }
    if (e.type === "response_item") {
      if (type === "message") {
        const text = (Array.isArray(p.content) ? p.content : []).map((b) => b?.text).filter((t) => typeof t === "string").join("\n");
        // task_complete is authoritative; a final message may come before more work.
        if (p.role === "assistant" && text) {
          this.latestMessage = text;
          this.working(at);
        }
        if (p.role === "user" && text) {
          this.latestUser = text;
          this.pendingQuestions.clear();
          this.working(at);
        }
      } else if (type === "function_call" || type === "custom_tool_call") {
        const name = p.name || "";
        if (p.call_id) this.pendingTools.add(p.call_id);
        let input = {};
        try {
          input = typeof p.arguments === "string" ? JSON.parse(p.arguments) : {};
        } catch {}
        this.activity = activityFor(name, input);
        // Asynchronous questions do not stop the agent.
        if (name.includes("request_user_input") && !name.includes("async")) this.pendingQuestions.add(p.call_id || name);
        this.working(at);
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        if (p.call_id) {
          this.pendingQuestions.delete(p.call_id);
          this.pendingTools.delete(p.call_id);
        }
        this.working(at);
      } else if (type === "reasoning") this.working(at);
    }
  }

  claude(e, at, sidechain) {
    if (e?.isSidechain === true && !sidechain) return;
    const type = e?.type || "";
    if (type === "custom-title" && typeof e.customTitle === "string") {
      this.title = e.customTitle;
      return;
    }
    if (type === "last-prompt" && typeof e.lastPrompt === "string") {
      this.latestUser = e.lastPrompt;
      return;
    }
    const m = e?.message;
    if (!m || typeof m !== "object") return;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (type === "assistant") {
      this.working(at);
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") this.latestMessage = block.text;
        if (block?.type === "tool_use") {
          const tool = block.name || "";
          if (block.id) this.pendingTools.add(block.id);
          this.activity = activityFor(tool, block.input || {});
          if (tool === "AskUserQuestion") {
            this.pendingQuestions.add(block.id || tool);
            this.status = "attention";
          }
        }
      }
      // Claude streams thinking and text separately: only a text end_turn completes a reply.
      if (m.stop_reason === "end_turn" && blocks.some((b) => b?.type === "text")) {
        this.status = "finished";
        this.pendingQuestions.clear();
        this.pendingTools.clear();
        this.activity = "Finished this turn";
      }
      if (e.isApiErrorMessage === true) {
        this.status = "error";
        this.activity = "The agent reported an error";
      }
    } else if (type === "user") {
      let hasText = false;
      if (typeof m.content === "string") {
        this.latestUser = m.content;
        hasText = true;
      }
      for (const block of blocks) {
        if (block?.type === "text" && typeof block.text === "string") {
          this.latestUser = block.text;
          hasText = true;
        }
        if (block?.tool_use_id) {
          this.pendingQuestions.delete(block.tool_use_id);
          this.pendingTools.delete(block.tool_use_id);
        }
      }
      if (hasText) {
        this.pendingQuestions.clear();
        this.activity = "Working on your request";
      }
      this.working(at);
    }
  }

  clone() {
    const copy = Object.assign(new TranscriptState(), this);
    copy.pendingQuestions = new Set(this.pendingQuestions);
    copy.pendingTools = new Set(this.pendingTools);
    return copy;
  }
}

// ---- Reading only what was appended ----

/** Reads new lines only; a first read of a large file starts 2 MB from its end. */
export class TranscriptReader {
  constructor() {
    this.cache = new Map();
    this.initialBytes = 2 * 1024 * 1024;
    this.touched = null;
  }

  /** Files not read during a scan are forgotten after it, so the cache stays small. */
  beginScan() {
    this.touched = new Set();
  }

  endScan() {
    if (!this.touched) return;
    for (const file of this.cache.keys()) if (!this.touched.has(file)) this.cache.delete(file);
    this.touched = null;
  }

  async read(file, provider, options = {}) {
    this.touched?.add(file);
    const info = await stat(file);
    const size = info.size;
    const mtime = info.mtimeMs;
    let cached = this.cache.get(file);
    if (cached && cached.offset === size && cached.mtime === mtime) return cached.state;
    if (cached && (size < cached.offset || (size === cached.offset && mtime !== cached.mtime))) cached = null;
    const state = cached ? cached.state.clone() : new TranscriptState();
    const start = cached ? cached.offset : Math.max(0, size - this.initialBytes);
    const length = Math.min(size - start, 8 * 1024 * 1024);
    const handle = await open(file, "r");
    let chunk;
    try {
      chunk = Buffer.alloc(length);
      if (length) await handle.read(chunk, 0, length, start);
    } finally {
      await handle.close();
    }
    let data = cached?.pending?.length ? Buffer.concat([cached.pending, chunk]) : chunk;
    if (!cached && start > 0) {
      const newline = data.indexOf(10);
      data = newline >= 0 ? data.subarray(newline + 1) : Buffer.alloc(0);
    }
    const last = data.lastIndexOf(10);
    if (last >= 0) {
      for (const line of data.subarray(0, last).toString("utf8").split("\n")) {
        if (!line) continue;
        try {
          state.ingest(JSON.parse(line), provider, options);
        } catch {}
      }
      data = data.subarray(last + 1);
    }
    // Never hold an unbounded partial line.
    const pending = data.length > 8 * 1024 * 1024 ? Buffer.alloc(0) : Buffer.from(data);
    this.cache.set(file, { offset: start + length, mtime, pending, state });
    return state;
  }
}

// ---- Every source ----

export class AgentWatch {
  /**
   * palm: () => { tasks, sessionIds } — Palm's own sessions and the
   * provider session ids behind them, so they are not listed twice.
   * hookFolders: folders of Claude hook events (one file per session, from a
   * hook you install; PALM_HOOK_EVENTS names the folder), used for "needs you" and the end of a turn when present.
   */
  constructor({ home = os.homedir(), palm = () => ({ tasks: [], sessionIds: new Set() }), hookFolders, now = () => Date.now() } = {}) {
    this.home = home;
    this.palm = palm;
    this.now = now;
    this.hookFolders = hookFolders ?? (process.env.PALM_HOOK_EVENTS ? [process.env.PALM_HOOK_EVENTS] : []);
    this.reader = new TranscriptReader();
    this.claudeIndex = new Map();
    this.indexedAt = 0;
    this.last = null;
  }

  async scan() {
    const now = this.now();
    const { tasks = [], sessionIds = new Set() } = this.palm() || {};
    const issues = [];
    const sessions = [];
    for (const task of tasks) sessions.push(palmSession(task));
    this.reader.beginScan();
    for (const [name, source] of [["Claude", () => this.claude(now, sessionIds)], ["Codex", () => this.codex(now, sessionIds)], ["OpenCode", () => this.opencode(now)]]) {
      try {
        sessions.push(...(await source()));
      } catch (error) {
        issues.push(`${name}: ${error.message}`);
      }
    }
    this.reader.endScan();
    sessions.sort((a, b) => statusRank[a.status] - statusRank[b.status] || Date.parse(b.updated) - Date.parse(a.updated));
    this.last = { sessions, issues, at: new Date(now).toISOString() };
    return this.last;
  }

  // -- Claude Code --

  /** Where each Claude session's file is, by session id. */
  async indexClaude(now) {
    const projects = path.join(this.home, ".claude/projects");
    const index = new Map();
    for (const dir of await readdir(projects, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue;
      for (const file of await readdir(path.join(projects, dir.name)).catch(() => []))
        if (file.endsWith(".jsonl")) index.set(file.slice(0, -6), path.join(projects, dir.name, file));
    }
    this.claudeIndex = index;
    this.indexedAt = now;
  }

  async claude(now, palmIds) {
    if (now - this.indexedAt > 30_000) await this.indexClaude(now);
    let reindexed = false;
    const result = [];
    const seen = new Set();
    const root = path.join(this.home, "Library/Application Support/Claude/claude-code-sessions");
    const metadata = [];
    for (const a of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!a.isDirectory()) continue;
      for (const b of await readdir(path.join(root, a.name), { withFileTypes: true }).catch(() => [])) {
        if (!b.isDirectory()) continue;
        for (const file of await readdir(path.join(root, a.name, b.name)).catch(() => [])) {
          if (!file.startsWith("local_") || !file.endsWith(".json")) continue;
          const full = path.join(root, a.name, b.name, file);
          const info = await stat(full).catch(() => null);
          if (info) metadata.push([full, info.mtimeMs]);
        }
      }
    }
    metadata.sort((x, y) => y[1] - x[1]);
    for (const [file] of metadata.slice(0, 100)) {
      const meta = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (!meta || meta.isArchived === true || typeof meta.sessionId !== "string" || typeof meta.cliSessionId !== "string") continue;
      const cliId = meta.cliSessionId;
      seen.add(cliId);
      if (palmIds.has(cliId)) continue;
      // A session started since the last index: look again at once.
      // (At most every ten seconds: some desktop records have no file left.)
      if (!this.claudeIndex.has(cliId) && !reindexed && now - this.indexedAt > 10_000) {
        await this.indexClaude(now);
        reindexed = true;
      }
      const transcript = this.claudeIndex.get(cliId) || "";
      const state = await this.claudeState(transcript, now);
      await this.applyHook(state, cliId);
      const updated = state.lastActivity || timeOf(meta.lastActivityAt);
      if (now - updated > 7 * 24 * hour) continue;
      const children = await this.claudeChildren(transcript, cliId, now);
      result.push(session({
        id: `claude:${meta.sessionId}`, source: "claude", app: "Claude desktop",
        title: compact(meta.title || state.title || "Claude chat", 90), cwd: meta.cwd || "",
        state, now, updated, children, link: `claude://code/continue?session=${encodeURIComponent(meta.sessionId)}`,
        evidence: transcript ? "Claude's own session files" : "Session file unavailable",
      }));
    }
    // Terminal sessions, without repeating their desktop copies.
    const recent = [];
    for (const [id, file] of this.claudeIndex) {
      if (seen.has(id) || palmIds.has(id)) continue;
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs < 7 * 24 * hour) recent.push([id, file, info.mtimeMs]);
    }
    recent.sort((x, y) => y[2] - x[2]);
    for (const [id, file] of recent.slice(0, 25)) {
      const state = (await this.reader.read(file, "claude").catch(() => null))?.clone();
      if (!state || !state.lastActivity) continue;
      await this.applyHook(state, id);
      const children = await this.claudeChildren(file, id, now);
      result.push(session({
        id: `claude:${id}`, source: "claude", app: "Claude Code in a terminal",
        title: compact(state.title || state.latestUser || "Claude terminal chat", 90), cwd: "",
        state, now, updated: state.lastActivity, children, link: null, evidence: "Claude's own session files",
      }));
    }
    return result;
  }

  async claudeState(transcript, now) {
    if (!transcript) return new TranscriptState();
    const info = await stat(transcript).catch(() => null);
    if (!info) return new TranscriptState();
    if (now - info.mtimeMs > 48 * hour) {
      const idle = new TranscriptState();
      idle.status = "idle";
      idle.activity = "No recent activity";
      idle.lastActivity = info.mtimeMs;
      return idle;
    }
    return (await this.reader.read(transcript, "claude").catch(() => null))?.clone() ?? new TranscriptState();
  }

  /** The agents a Claude session launched (subagents, background agents). */
  async claudeChildren(transcript, id, now) {
    if (!transcript) return [];
    const folder = path.join(path.dirname(transcript), id, "subagents");
    const files = await readdir(folder).catch(() => []);
    const children = [];
    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
      const full = path.join(folder, file);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      const recent = now - info.mtimeMs < 6 * hour;
      const state = recent ? await this.reader.read(full, "claude", { sidechain: true }).catch(() => null) : null;
      const meta = await readFile(full.replace(/\.jsonl$/, ".meta.json"), "utf8").then(JSON.parse).catch(() => ({}));
      const status = state ? state.resolvedStatus(now) : "idle";
      children.push({
        id: file.slice(0, -6),
        title: compact(meta.description || meta.agentType || "Agent", 80),
        kind: typeof meta.agentType === "string" ? meta.agentType : null,
        status,
        activity: state?.activity || "No recent activity",
        updated: new Date(state?.lastActivity || info.mtimeMs).toISOString(),
      });
    }
    children.sort((a, b) => statusRank[a.status] - statusRank[b.status] || Date.parse(b.updated) - Date.parse(a.updated));
    return children.slice(0, 30);
  }

  async applyHook(state, cliId) {
    if (!/^[A-Za-z0-9_-]+$/.test(cliId)) return;
    for (const folder of this.hookFolders) {
      const event = await readFile(path.join(folder, `${cliId}.json`), "utf8").then(JSON.parse).catch(() => null);
      const at = timeOf(event?.timestamp);
      if (!event || !at || at <= state.lastActivity || typeof event.event !== "string") continue;
      switch (event.event) {
        case "PermissionRequest":
        case "Elicitation":
          state.status = "attention";
          state.activity = "Waiting for your approval or answer";
          break;
        case "Notification":
          if (!["permission_prompt", "elicitation_dialog"].includes(event.notification_type)) continue;
          state.status = "attention";
          state.activity = "Waiting for your approval or answer";
          break;
        case "UserPromptSubmit":
        case "PreToolUse":
        case "PostToolUse":
        case "ElicitationResult":
          state.status = "working";
          state.activity = activityFor(event.tool || "");
          break;
        case "Stop":
          state.status = "finished";
          state.activity = "Finished this turn";
          break;
        case "StopFailure":
          state.status = "error";
          state.activity = "The agent reported an error";
          break;
        case "SessionEnd":
          state.status = "idle";
          state.activity = "Session closed";
          break;
        default:
          continue;
      }
      state.lastActivity = at;
    }
  }

  // -- Codex (primary account only) --

  async codex(now, palmIds) {
    const root = path.join(this.home, ".codex");
    const files = (await readdir(root).catch(() => [])).filter((f) => /^state_\d+\.sqlite$/.test(f));
    files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!files.length) return [];
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      throw new Error("This Node has no SQLite reader.");
    }
    const db = new DatabaseSync(path.join(root, files[0]), { readOnly: true });
    let rows;
    let edges = [];
    try {
      db.exec("PRAGMA busy_timeout = 150");
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((c) => c.name));
      const name = columns.has("name") ? "COALESCE(NULLIF(name,''),title)" : "title";
      const notSub = columns.has("thread_source") ? "COALESCE(thread_source,'') != 'subagent' AND source NOT LIKE '%subagent%'" : "source NOT LIKE '%subagent%'";
      // Chats first: frequent tool runs (codex exec) must not push them out.
      const select = `SELECT id, ${name} AS display_title, cwd, rollout_path, updated_at, source FROM threads WHERE archived = 0 AND ${notSub}`;
      rows = [
        ...db.prepare(`${select} AND source != 'exec' ORDER BY updated_at DESC LIMIT 80`).all(),
        ...db.prepare(`${select} AND source = 'exec' ORDER BY updated_at DESC LIMIT 20`).all(),
      ];
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
      if (tables.has("thread_spawn_edges")) {
        const ids = rows.map((r) => r.id);
        if (ids.length)
          edges = db.prepare(
            `SELECT e.parent_thread_id AS parent, t.id, t.rollout_path, t.updated_at, COALESCE(t.agent_nickname, t.title, '') AS title, t.agent_role AS role
             FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
             WHERE e.parent_thread_id IN (${ids.map(() => "?").join(",")})`,
          ).all(...ids);
      }
    } finally {
      db.close();
    }
    const sessionsRoot = (await realpath(path.join(root, "sessions")).catch(() => path.join(root, "sessions"))) + path.sep;
    const own = path.join(root, "sessions") + path.sep;
    const safe = async (file) => {
      // Rejected by name first, so another account's folder is never touched.
      if (!String(file || "").startsWith(own)) return null;
      const real = await realpath(String(file)).catch(() => null);
      return real && real.startsWith(sessionsRoot) ? real : null;
    };
    const result = [];
    for (const row of rows) {
      if (palmIds.has(row.id)) continue;
      // Only this account's own session files, never a path into another folder.
      const file = await safe(row.rollout_path);
      if (!file) continue;
      const info = await stat(file).catch(() => null);
      const modified = info?.mtimeMs ?? 0;
      let state;
      if (modified && now - modified < 48 * hour) state = (await this.reader.read(file, "codex").catch(() => null))?.clone();
      if (!state) {
        state = new TranscriptState();
        state.status = "idle";
        state.activity = "No recent activity";
      }
      const updated = state.lastActivity || Number(row.updated_at || 0) * 1000;
      if (now - updated > 7 * 24 * hour) continue;
      const children = [];
      for (const child of edges.filter((e) => e.parent === row.id)) {
        const childFile = await safe(child.rollout_path);
        const childInfo = childFile ? await stat(childFile).catch(() => null) : null;
        const childState = childInfo && now - childInfo.mtimeMs < 6 * hour ? await this.reader.read(childFile, "codex").catch(() => null) : null;
        children.push({
          id: child.id, title: compact(child.title || child.role || "Agent", 80), kind: child.role || null,
          status: childState ? childState.resolvedStatus(now) : "idle",
          activity: childState?.activity || "No recent activity",
          updated: new Date(childState?.lastActivity || Number(child.updated_at || 0) * 1000).toISOString(),
        });
      }
      const app = row.source === "vscode" ? "Codex desktop" : row.source === "cli" ? "Codex in a terminal" : row.source === "exec" ? "Codex run by a tool" : "Codex";
      result.push(session({
        id: `codex:${row.id}`, source: "codex", app,
        title: compact(row.display_title || "Codex chat", 90) || "Untitled Codex chat", cwd: row.cwd || "",
        state, now, updated, children, link: `codex://threads/${encodeURIComponent(row.id)}`,
        evidence: "Codex's own session files",
      }));
    }
    return result;
  }

  // -- OpenCode --

  async opencode(now) {
    const file = path.join(this.home, ".local/share/opencode/opencode.db");
    if (!(await stat(file).catch(() => null))) return [];
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 150");
      const since = now - 7 * 24 * hour;
      const rows = db.prepare(
        "SELECT id, title, directory, time_updated FROM session WHERE time_archived IS NULL AND parent_id IS NULL AND time_updated > ? ORDER BY time_updated DESC LIMIT 25",
      ).all(since);
      const last = db.prepare("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1");
      return rows.map((row) => {
        const state = new TranscriptState();
        state.lastActivity = Number(row.time_updated) || 0;
        let data = null;
        try {
          data = JSON.parse(last.get(row.id)?.data || "null");
        } catch {}
        if (data?.error) Object.assign(state, { status: "error", activity: "The agent reported an error" });
        else if (data?.role === "assistant" && data?.time?.completed) Object.assign(state, { status: "finished", activity: "Finished this turn" });
        else if (data) Object.assign(state, { status: "working", activity: "Working on your request" });
        return session({
          id: `opencode:${row.id}`, source: "opencode", app: "OpenCode",
          title: compact(row.title || "OpenCode session", 90), cwd: row.directory || "",
          state, now, updated: state.lastActivity, children: [], link: null, evidence: "OpenCode's own session records",
        });
      });
    } finally {
      db.close();
    }
  }
}

function session({ id, source, app, title, cwd, state, now, updated, children, link, evidence }) {
  return {
    id, source, app, title, cwd,
    project: cwd ? path.basename(cwd) : "",
    status: state.resolvedStatus(now),
    activity: state.activity,
    latestMessage: compact(state.latestMessage, 600),
    latestUser: compact(state.latestUser, 300),
    updated: new Date(updated || 0).toISOString(),
    children,
    childrenWorking: children.filter((c) => c.status === "working" || c.status === "attention").length,
    openable: !!link,
    link,
    evidence,
    palmTaskId: null,
  };
}

function palmSession(task) {
  const status = task.pendingApprovals > 0 || task.status === "waiting" ? "attention"
    : ["running", "starting"].includes(task.status) ? "working"
    : task.status === "failed" ? "error"
    : task.status === "interrupted" ? "error"
    : task.status === "idle" ? "idle" : "finished";
  return {
    id: `palm:${task.id}`, source: "palm", app: task.agentName ? `${task.agentName} in Palm` : "Palm",
    title: compact(task.title || "Palm session", 90), cwd: task.cwd || "", project: task.cwd ? path.basename(task.cwd) : "",
    status,
    activity: status === "attention" ? "Waiting for your approval" : status === "working" ? "Working on your request" : status === "error" ? "Stopped with a problem" : "Finished",
    latestMessage: compact(task.preview || "", 600), latestUser: "",
    updated: task.updated || new Date(0).toISOString(), children: [], childrenWorking: 0,
    openable: false, link: null, evidence: "Palm's own session", palmTaskId: task.id,
  };
}

/**
 * What changed between two scans that deserves a notification: a session
 * that was working now needs you, finished its turn or stopped with an error.
 */
export function alertsBetween(before, after) {
  if (!before) return [];
  const previous = new Map(before.sessions.map((s) => [s.id, s]));
  // Scheduled or repeating work (mute those): a Codex run
  // started by a script or tool, or a session whose title another session
  // already has (a scheduled job asks the same thing each time).
  const titled = new Map();
  for (const s of after.sessions) titled.set(sameTitle(s.title), (titled.get(sameTitle(s.title)) || 0) + 1);
  const alerts = [];
  for (const s of after.sessions) {
    const was = previous.get(s.id);
    if (!was || was.status === s.status) continue;
    const wasActive = was.status === "working" || was.status === "quiet";
    const base = { id: s.id, title: s.title, app: s.app, source: s.source, palmTaskId: s.palmTaskId, routine: s.app === "Codex run by a tool" || titled.get(sameTitle(s.title)) > 1 };
    if (s.status === "attention" && was.status !== "attention") alerts.push({ kind: "attention", ...base, text: `${s.title} needs you` });
    else if (wasActive && s.status === "finished") alerts.push({ kind: "finished", ...base, text: `${s.title} finished` });
    else if (wasActive && s.status === "error") alerts.push({ kind: "error", ...base, text: `${s.title} stopped with an error` });
  }
  return alerts;
}

const sameTitle = (title) => String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
