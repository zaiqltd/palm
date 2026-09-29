import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PROTOCOL } from "./protocol.mjs";

const daemonScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

// Palm's side of the terminal service (daemon.mjs). Same interface as
// Terminals, so the rest of the server does not care which one it has:
// shells live in the service, and a restarted or updated Palm reconnects to
// them. Phone clients are relayed by viewer id.
export class TerminalService {
  constructor({ stateDir, helper, version, onChange = () => {}, log = () => {} }) {
    this.socketPath = path.join(stateDir, `terminals-v${PROTOCOL}.sock`);
    this.logPath = path.join(stateDir, "terminal-service.log");
    this.helper = helper;
    this.version = String(version);
    this.onChange = onChange;
    this.log = log;
    this.sessions = [];
    this.pending = new Map();
    this.seq = 0;
    this.viewers = new Map(); // phone client -> viewer id
    this.clients = new Map(); // viewer id -> phone client
    this.attached = new Map(); // viewer id -> Set(terminal ids)
    this.socket = null;
    this.connecting = null;
    this.closed = false;
  }

  async start() {
    await this.connect();
    return this;
  }

  list() {
    return this.sessions;
  }

  // A listener's mistake must never break the link to the shells.
  changed() {
    try {
      this.onChange();
    } catch (error) {
      this.log(`list update failed: ${error.message}`);
    }
  }

  async create(options = {}) {
    const summary = await this.request({ op: "create", helper: this.helper, options });
    return summary;
  }

  async attach(client, terminal, { cols, rows } = {}) {
    const viewer = this.viewerFor(client);
    const ids = this.attached.get(viewer) || new Set();
    ids.add(terminal);
    this.attached.set(viewer, ids);
    return this.request({ op: "attach", viewer, terminal, cols, rows });
  }

  detach(client, terminal) {
    const viewer = this.viewers.get(client);
    if (!viewer) return;
    this.attached.get(viewer)?.delete(terminal);
    this.notify({ op: "detach", viewer, terminal });
  }

  detachAll(client) {
    const viewer = this.viewers.get(client);
    if (!viewer) return;
    this.viewers.delete(client);
    this.clients.delete(viewer);
    this.attached.delete(viewer);
    this.notify({ op: "detachViewer", viewer });
  }

  input(terminal, data) {
    if (typeof data !== "string" || data.length > 65536) throw new Error("Input too large.");
    this.require(terminal);
    this.notify({ op: "input", terminal, data });
  }

  resize(terminal, cols, rows) {
    this.notify({ op: "resize", terminal, cols, rows });
  }

  async signal(terminal, signal) {
    return this.request({ op: "signal", terminal, signal });
  }

  async close(terminal) {
    return this.request({ op: "close", terminal });
  }

  /// Palm is stopping: leave every shell running for the next Palm.
  disconnect() {
    this.closed = true;
    this.socket?.end();
  }

  /// Ends every shell (tests, or an explicit "close all").
  async closeAll() {
    await this.request({ op: "closeAll" }).catch(() => {});
  }

  require(terminal) {
    const session = this.sessions.find((s) => s.id === terminal);
    if (!session) throw new Error("That terminal is no longer open.");
    if (!session.running) throw new Error("This terminal has finished. Start a new one.");
    return session;
  }

  viewerFor(client) {
    let viewer = this.viewers.get(client);
    if (!viewer) {
      viewer = randomBytes(8).toString("hex");
      this.viewers.set(client, viewer);
      this.clients.set(viewer, client);
    }
    return viewer;
  }

  // ---- transport ----

  async request(message) {
    const socket = await this.connect();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The terminal service did not answer."));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ ...message, id }) + "\n");
    });
  }

  notify(message) {
    if (this.socket && !this.socket.destroyed) this.socket.write(JSON.stringify(message) + "\n");
    else this.connect().then((s) => s.write(JSON.stringify(message) + "\n")).catch(() => {});
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.closed = false;
    this.connecting = (async () => {
      let socket = await dial(this.socketPath).catch(() => null);
      if (!socket) {
        this.spawnService();
        // A first start can take a few seconds on a busy Mac.
        for (let i = 0; i < 200 && !socket; i++) {
          await new Promise((r) => setTimeout(r, 50));
          socket = await dial(this.socketPath).catch(() => null);
        }
      }
      if (!socket) throw new Error("Palm could not start its terminal service.");
      this.attachSocket(socket);
      const hello = await this.requestOn(socket, { op: "hello" });
      this.sessions = hello.terminals || [];
      if (hello.version !== this.version) {
        // An older service keeps its shells; it leaves once they have ended.
        this.log(`terminal service ${hello.version} kept for its shells (Palm ${this.version})`);
        socket.write(JSON.stringify({ op: "retire" }) + "\n");
      }
      this.changed();
      return socket;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  requestOn(socket, message) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The terminal service did not answer."));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ ...message, id }) + "\n");
    });
  }

  attachSocket(socket) {
    this.socket = socket;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("The terminal service stopped."));
      }
      this.pending.clear();
      if (this.closed) return;
      this.log("connection to the terminal service dropped; reconnecting");
      setTimeout(() => this.recover(), 100);
    });
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.re !== undefined) {
        const pending = this.pending.get(message.re);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.re);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.ok);
        return;
      }
      if (message.changed) {
        this.sessions = message.changed;
        this.changed();
        return;
      }
      if (message.to) {
        const client = this.clients.get(message.to);
        if (!client || client.ws.readyState !== 1) return;
        // A phone that cannot keep up reconnects and gets a fresh snapshot.
        if (client.ws.bufferedAmount > 8 * 1024 * 1024) return client.ws.terminate?.();
        client.ws.send(message.raw);
      }
    });
  }

  // After an unexpected disconnect: reconnect (starting a new service if the
  // old one is gone), reattach phones to shells that are still running, and
  // tell them about any that ended.
  async recover() {
    const attached = [...this.attached].map(([viewer, ids]) => [viewer, [...ids]]);
    try {
      await this.connect();
    } catch (error) {
      this.log(`could not reconnect: ${error.message}`);
      this.sessions = [];
    }
    const running = new Set(this.sessions.filter((s) => s.running).map((s) => s.id));
    for (const [viewer, ids] of attached)
      for (const terminal of ids) {
        if (running.has(terminal)) {
          this.request({ op: "attach", viewer, terminal }).catch(() => {});
        } else {
          this.attached.get(viewer)?.delete(terminal);
          this.clients.get(viewer)?.send({ topic: `terminal:${terminal}`, event: "terminal.closed", id: terminal });
        }
      }
    this.changed();
  }

  spawnService() {
    let out = "ignore";
    try {
      out = openSync(this.logPath, "a", 0o600);
    } catch {}
    // Its own process group: stopping Palm (launchd, an update) leaves it
    // and its shells running.
    const child = spawn(process.execPath, [daemonScript, this.socketPath, this.version], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    if (typeof out === "number") closeSync(out);
  }
}

function dial(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
