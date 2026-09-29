import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { expandHome, loginShell, userEnvironment } from "../platform/env.mjs";

const { Terminal } = headless;
const { SerializeAddon } = serialize;

// Terminal sessions live on the Mac, not on the phone. A headless xterm keeps
// each screen's state so a phone that reconnects, rotates or switches views
// gets an exact snapshot and then the live stream, with nothing lost between.
// Sessions end only when their program exits or the user closes them.
export class Terminals {
  constructor({ helper, maxSessions = 12, onChange = () => {} }) {
    this.helper = helper;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.onChange = onChange;
  }

  list() {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }

  summary(s) {
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      command: s.commandLabel,
      cols: s.cols,
      rows: s.rows,
      created: s.created,
      lastActivity: s.lastActivity,
      running: s.exitCode === null,
      exitCode: s.exitCode,
      attached: s.clients.size,
    };
  }

  async create({ cwd, command, cols = 80, rows = 24, title } = {}) {
    if (this.sessions.size >= this.maxSessions) {
      // Retire the oldest finished session before refusing.
      const finished = [...this.sessions.values()].filter((s) => s.exitCode !== null);
      if (finished.length) this.remove(finished[0].id);
      else throw new Error("Close a terminal first; Palm keeps up to 12 open.");
    }
    const folder = path.resolve(expandHome(cwd) || os.homedir());
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Choose an existing folder for the terminal.");
    cols = clamp(cols, 20, 400, 80);
    rows = clamp(rows, 5, 200, 24);
    const env = { ...(await userEnvironment()) };
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.TERM_PROGRAM = "Palm";
    env.LANG = env.LANG || "en_US.UTF-8";
    delete env.PALM_AGENT_TOKEN;
    const shell = loginShell();
    let program;
    let commandLabel;
    if (typeof command === "string" && command.trim()) {
      if (command.length > 2000) throw new Error("That command is too long.");
      // Run the command inside an interactive login shell so aliases, nvm and
      // PATH match the user's own Terminal; the shell stays open afterwards.
      program = [shell, "-l", "-i", "-c", `${command}; exec ${shell} -l -i`];
      commandLabel = command.trim();
    } else {
      program = [shell, "-l", "-i"];
      commandLabel = path.basename(shell);
    }
    const id = randomBytes(6).toString("hex");
    const child = spawn(this.helper, [String(cols), String(rows), folder, ...program], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env,
      detached: false,
    });
    const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const session = {
      id,
      title: title || commandLabel,
      cwd: folder,
      commandLabel,
      cols,
      rows,
      created: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      exitCode: null,
      child,
      term,
      serializer,
      decoder: new TextDecoder("utf-8", { fatal: false }),
      clients: new Map(), // client -> { pending: [], ready: bool }
      outbox: "",
      flushTimer: null,
      seq: 0,
    };
    term.onTitleChange((value) => {
      const clean = String(value).replace(/[\x00-\x1f]/g, "").slice(0, 120);
      if (clean && clean !== session.title) {
        session.title = clean;
        this.onChange();
      }
    });
    child.stdout.on("data", (chunk) => this.output(session, chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => this.exited(session, 127));
    child.on("exit", (code) => this.exited(session, code ?? 1));
    child.stdin.on("error", () => {});
    child.stdio[3]?.on("error", () => {});
    this.sessions.set(id, session);
    this.onChange();
    return this.summary(session);
  }

  output(session, chunk) {
    const text = session.decoder.decode(chunk, { stream: true });
    if (!text) return;
    session.lastActivity = new Date().toISOString();
    session.seq++;
    session.term.write(text);
    // Clients waiting for their snapshot keep what arrives meanwhile.
    for (const state of session.clients.values()) if (!state.ready) state.pending.push(text);
    session.outbox += text;
    if (session.outbox.length > 65536) this.flush(session);
    else if (!session.flushTimer) session.flushTimer = setTimeout(() => this.flush(session), 8);
  }

  flush(session) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
    const data = session.outbox;
    session.outbox = "";
    if (!data) return;
    const payload = JSON.stringify({ topic: `terminal:${session.id}`, event: "terminal.output", id: session.id, data });
    for (const [client, state] of session.clients) {
      if (!state.ready) continue;
      if (client.ws.readyState !== 1) continue;
      if (client.ws.bufferedAmount > 4 * 1024 * 1024) {
        // A slow phone resynchronises from a fresh snapshot instead of
        // accumulating an unbounded backlog.
        session.clients.delete(client);
        client.send({ topic: `terminal:${session.id}`, event: "terminal.resync", id: session.id });
        continue;
      }
      client.ws.send(payload);
    }
  }

  exited(session, code) {
    if (session.exitCode !== null) return;
    this.flush(session);
    session.exitCode = code;
    for (const client of session.clients.keys())
      client.send({ topic: `terminal:${session.id}`, event: "terminal.exit", id: session.id, exitCode: code });
    this.onChange();
  }

  attach(client, id, { cols, rows } = {}) {
    const session = this.require(id);
    const state = { pending: [], ready: false };
    session.clients.set(client, state);
    if (Number.isFinite(cols) && Number.isFinite(rows)) this.resize(id, cols, rows);
    this.flush(session);
    // The empty write resolves after every earlier chunk has been parsed, so
    // the snapshot covers exactly what arrived before it; later chunks were
    // queued in state.pending.
    session.term.write("", () => {
      if (session.clients.get(client) !== state) return;
      // Deliver queued text to the other viewers first; this viewer gets the
      // same text once, as its post-snapshot backlog.
      this.flush(session);
      state.ready = true;
      const snapshot = session.serializer.serialize({ scrollback: 2000 });
      client.send({
        topic: `terminal:${session.id}`,
        event: "terminal.snapshot",
        id: session.id,
        cols: session.cols,
        rows: session.rows,
        data: snapshot,
        running: session.exitCode === null,
        exitCode: session.exitCode,
      });
      // Pending text written after the snapshot's flush point is replayed.
      const backlog = state.pending.join("");
      state.pending = [];
      if (backlog)
        client.send({ topic: `terminal:${session.id}`, event: "terminal.output", id: session.id, data: backlog });
    });
    this.onChange();
    return this.summary(session);
  }

  detach(client, id) {
    const session = this.sessions.get(id);
    if (session?.clients.delete(client)) this.onChange();
  }

  detachAll(client) {
    for (const session of this.sessions.values()) session.clients.delete(client);
  }

  input(id, data) {
    const session = this.require(id);
    if (typeof data !== "string" || data.length > 65536) throw new Error("Input too large.");
    if (session.exitCode !== null) throw new Error("This terminal has finished. Start a new one.");
    session.lastActivity = new Date().toISOString();
    session.child.stdin.write(data);
  }

  resize(id, cols, rows) {
    const session = this.require(id);
    cols = clamp(cols, 20, 400, session.cols);
    rows = clamp(rows, 5, 200, session.rows);
    if (cols === session.cols && rows === session.rows) return;
    session.cols = cols;
    session.rows = rows;
    session.term.resize(cols, rows);
    session.child.stdio[3]?.write(`R ${cols} ${rows}\n`);
  }

  signal(id, name) {
    const session = this.require(id);
    const numbers = { SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGKILL: 9, SIGTSTP: 18, SIGCONT: 19, SIGHUP: 1 };
    const number = numbers[name];
    if (!number) throw new Error("Unsupported signal.");
    session.child.stdio[3]?.write(`S ${number}\n`);
  }

  close(id) {
    const session = this.require(id);
    if (session.exitCode === null) {
      session.child.stdio[3]?.write("H\n");
      session.child.stdin.end();
      setTimeout(() => {
        if (session.exitCode === null) session.child.kill("SIGKILL");
      }, 3000).unref();
    }
    this.remove(id);
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const client of session.clients.keys())
      client.send({ topic: `terminal:${id}`, event: "terminal.closed", id });
    session.clients.clear();
    session.term.dispose();
    this.sessions.delete(id);
    this.onChange();
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) {
      try {
        this.close(id);
      } catch {}
    }
  }

  require(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("That terminal is no longer open.");
    return session;
  }
}

function clamp(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
