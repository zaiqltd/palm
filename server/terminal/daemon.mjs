// Palm's terminal service. It owns the shells so they outlive a restart or
// update of Palm itself: the Palm server starts it once, in its own process
// group, and talks to it over a private Unix socket in Palm's state folder.
// When Palm comes back it reconnects and every shell is still there, screen
// and scrollback included.
//
//   node daemon.mjs <socket path> <palm version>
//
// Protocol (JSON lines). From Palm: {id?, op, ...}; replies {re: id, ok} or
// {re: id, error}. From the service: {changed: [summaries]} whenever the list
// changes, and {to: viewer, raw: "<message for that phone>"} for output.
// It exits when it has no shells and Palm has been gone for a minute.
import net from "node:net";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { PROTOCOL } from "./protocol.mjs";
import { Terminals } from "./terminals.mjs";

const [socketPath, version = "0"] = process.argv.slice(2);
if (!socketPath) {
  console.error("Usage: daemon.mjs <socket path> <version>");
  process.exit(2);
}
const idleMs = Number(process.env.PALM_TERMINALD_IDLE_MS || 60000);

const terminals = new Terminals({ helper: null, onChange: () => changed() });
const viewers = new Map(); // viewer id -> stand-in phone client
let host = null;
let idleTimer = null;
let retiring = false;

// Lifecycle only; never terminal content.
const note = (message) => console.log(`${new Date().toISOString()} service ${process.pid}: ${message}`);

function write(message) {
  if (host && !host.destroyed) host.write(JSON.stringify(message) + "\n");
}

function changed() {
  write({ changed: terminals.list() });
  scheduleIdleExit();
}

// A phone client as Terminals sees one; its messages travel through Palm.
function viewer(id) {
  let client = viewers.get(id);
  if (!client) {
    client = {
      viewer: id,
      ws: {
        get readyState() {
          return host && !host.destroyed ? 1 : 3;
        },
        get bufferedAmount() {
          return host?.writableLength || 0;
        },
        send: (raw) => write({ to: id, raw }),
      },
      send: (message) => write({ to: id, raw: JSON.stringify(message) }),
    };
    viewers.set(id, client);
  }
  return client;
}

function dropViewers() {
  for (const client of viewers.values()) terminals.detachAll(client);
  viewers.clear();
}

async function handle(message) {
  switch (message.op) {
    case "hello":
      return { protocol: PROTOCOL, version, pid: process.pid, terminals: terminals.list() };
    case "list":
      return terminals.list();
    case "create":
      if (typeof message.helper === "string") terminals.helper = message.helper;
      return terminals.create(message.options || {});
    case "attach":
      return terminals.attach(viewer(String(message.viewer)), String(message.terminal), {
        cols: message.cols,
        rows: message.rows,
      });
    case "detach":
      terminals.detach(viewer(String(message.viewer)), String(message.terminal));
      return { ok: true };
    case "detachViewer": {
      const client = viewers.get(String(message.viewer));
      if (client) terminals.detachAll(client);
      viewers.delete(String(message.viewer));
      return { ok: true };
    }
    case "input":
      terminals.input(String(message.terminal), message.data);
      return undefined;
    case "resize":
      terminals.resize(String(message.terminal), message.cols, message.rows);
      return undefined;
    case "signal":
      terminals.signal(String(message.terminal), String(message.signal));
      return { ok: true };
    case "close":
      terminals.close(String(message.terminal));
      return { ok: true };
    case "closeAll":
      terminals.closeAll();
      return { ok: true };
    case "retire":
      // A newer Palm is running: finish when the last shell ends.
      retiring = true;
      scheduleIdleExit();
      return { ok: true };
    default:
      throw new Error("Unsupported terminal request.");
  }
}

function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if ([...terminals.sessions.values()].some((s) => s.exitCode === null)) return;
  if (host && !retiring) return;
  idleTimer = setTimeout(() => shutdown(0), retiring ? 200 : idleMs);
}

async function shutdown(code) {
  note(code === 0 ? "stopping" : `stopping (${code})`);
  terminals.closeAll();
  server.close();
  await unlink(socketPath).catch(() => {});
  setTimeout(() => process.exit(code), 100).unref();
}

// Only one service per socket: if another answers, this one leaves.
const alive = await new Promise((resolve) => {
  const probe = net.connect(socketPath);
  probe.once("connect", () => {
    probe.destroy();
    resolve(true);
  });
  probe.once("error", () => resolve(false));
});
if (alive) process.exit(0);
await unlink(socketPath).catch(() => {});

const server = net.createServer((socket) => {
  // The newest Palm connection wins; an older one is closed.
  if (host && !host.destroyed) {
    dropViewers();
    host.destroy();
  }
  host = socket;
  note("Palm connected");
  clearTimeout(idleTimer);
  socket.on("error", () => {});
  socket.on("close", () => {
    if (host !== socket) return;
    host = null;
    note(`Palm disconnected; ${[...terminals.sessions.values()].filter((s) => s.exitCode === null).length} shells running`);
    dropViewers();
    scheduleIdleExit();
  });
  createInterface({ input: socket, crlfDelay: Infinity }).on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const result = await handle(message);
      if (message.id !== undefined) write({ re: message.id, ok: result ?? { ok: true } });
    } catch (error) {
      if (message.id !== undefined) write({ re: message.id, error: error.message });
    }
  });
});
const previous = process.umask(0o077);
server.listen(socketPath, () => {
  process.umask(previous);
  note(`started (Palm ${version})`);
  scheduleIdleExit();
});
server.on("error", () => process.exit(1));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => {});
