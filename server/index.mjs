import http from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat, mkdir, rename, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import {
  Sessions,
  writePrivateJSON,
  sessionCookie,
  bearerToken,
  isLocal,
  checkOrigin,
  safeFile,
  listFiles,
  validateCommand,
} from "./security.mjs";
import { Native } from "./native.mjs";
import { CommandQueue } from "./commands.mjs";
import { EventHub } from "./platform/events.mjs";
import { FsApi, FsPolicy, FsError } from "./files/fs-api.mjs";
import { Terminals } from "./terminal/terminals.mjs";
import { TerminalService } from "./terminal/service.mjs";
import { DevServers, defaultProjectRoots } from "./dev/devservers.mjs";
import { PreviewGateway } from "./dev/preview-gateway.mjs";
import { SystemControl } from "./system/system.mjs";
import { ScreenControl } from "./agents/screen-control.mjs";
import { AgentBroker } from "./agents/broker.mjs";
import { WorkMemory } from "./memory/memory.mjs";
import { Assistant } from "./assistant/assistant.mjs";
import { Conversations } from "./assistant/conversations.mjs";
import { Voice } from "./voice/voice.mjs";
import { ApiRoute } from "./agents/api-route.mjs";
import { AgentWatch, alertsBetween } from "./agents/watch.mjs";
import { openLog, log, logCrashes } from "./platform/log.mjs";
import { ScreenFlow, MAX_IN_FLIGHT } from "./screen-flow.mjs";
import { newChallenge, verifyAssertion, verifyRegistration } from "./webauthn.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const synthetic = process.env.PALM_SYNTHETIC === "1";
// ~/Library/Logs/Palm/host.log: starts, stops, crashes and how phone
// connections ended ("the connection keeps crashing").
openLog({ synthetic });
logCrashes();
const stateDir = path.resolve(process.env.PALM_STATE_DIR || path.join(root, ".local"));
const saved = await readFile(path.join(stateDir, "runtime.json"), "utf8")
  .then(JSON.parse)
  .catch((e) => {
    if (e.code === "ENOENT") return {};
    throw e;
  });
const port = Number(process.env.PALM_PORT || 4318);
let remoteOrigin = process.env.PALM_ORIGIN ?? (synthetic && !process.env.PALM_STATE_DIR ? "" : saved.origin || "");
if (remoteOrigin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(remoteOrigin))
  throw new Error("PALM_ORIGIN must be an HTTPS origin with no path.");
const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, remoteOrigin].filter(Boolean));
const hosts = new Set([...origins].map((o) => new URL(o).host));
const shareRoot = path.resolve(process.env.PALM_SHARE_ROOT || path.join(root, "shared"));
const sessions = await Sessions.open(
  synthetic && !process.env.PALM_STATE_DIR ? null : path.join(stateDir, "native-devices.json"),
);
const native = new Native(root, { synthetic });
let controller = null;
let mediaOwner = null;
let lastMediaDiagnostics = null;
let streamConfig = null;
let dropping = false;
let keyframePending = false;
let controlEpoch = 0;
let connectionWrites = Promise.resolve();
const commands = new CommandQueue();
const inputOps = ["pointer", "scroll", "text", "key"];

// Preview slots: tailnet HTTPS port -> loopback gateway port. Configurable.
// Loopback ports are deliberately uncommon: 4321 is Astro's dev default.
const previewSlots = (process.env.PALM_PREVIEW_SLOTS || saved.previewSlots || "8444:47820,8445:47821,8446:47822")
  .toString()
  .split(",")
  .map((pair) => pair.split(":").map(Number))
  .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b))
  .map(([publicPort, localPort]) => ({ publicPort, localPort }));

const hub = new EventHub();
const inbox = await chooseInbox();
const fsApi = new FsApi({
  policy: new FsPolicy({ stateDir }),
  inbox,
  // The test host never touches the real Trash: items go to its own state folder.
  trash: synthetic ? (paths) => syntheticTrash(paths) : async (paths) => (await native.request({ op: "trash", paths })).moved,
});
const palmVersion = "0.4.0";
// The Mac's own name, as the phone shows it on results.
let computerName = synthetic ? process.env.PALM_COMPUTER_NAME || "Sample Mac" : os.hostname().replace(/\.local$/, "");
if (!synthetic)
  execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 3000 }, (error, stdout) => {
    if (!error && stdout.trim()) computerName = stdout.trim().slice(0, 80);
  });
// The installed launcher discards output; terminal service events go to a
// small private log instead (no terminal content, ever).
function noteService(message) {
  appendFile(path.join(stateDir, "terminal-service.log"), `${new Date().toISOString()} host: ${message}\n`, { mode: 0o600 }).catch(() => {});
}
const ptyHelper = process.env.PALM_PTY_PATH || path.join(root, "build/bin/palm-pty");
// (terminals is still null while the service reports its first list.)
const publishTerminals = () => terminals && hub.publish("terminals", { event: "terminals.updated", terminals: terminals.list() });
// Shells live in Palm's terminal service so they survive Palm restarting or
// updating. The test host keeps them in process (nothing outlives a test).
let terminals = null;
if (!synthetic && process.env.PALM_TERMINAL_SERVICE !== "0") {
  terminals = await new TerminalService({ stateDir, helper: ptyHelper, version: palmVersion, onChange: publishTerminals, log: noteService })
    .start()
    .catch((error) => {
      noteService(`unavailable, shells stay inside Palm this run: ${error.message}`);
      return null;
    });
}
terminals ??= new Terminals({ helper: ptyHelper, onChange: publishTerminals });
const gateway = new PreviewGateway({
  slots: previewSlots,
  publicHost: remoteOrigin ? new URL(remoteOrigin).hostname : null,
  loopback: synthetic,
  onChange: () => hub.publish("dev", { event: "dev.updated" }),
});
const dev = new DevServers({
  roots: defaultProjectRoots(),
  ownPorts: [port, ...previewSlots.map((s) => s.localPort)],
  onChange: () => hub.publish("dev", { event: "dev.updated", servers: dev.list() }),
});
const system = new SystemControl({
  native,
  synthetic,
  stateDir,
  onChange: () => hub.publish("system", { event: "system.updated" }),
});
await system.restoreSleep();
// Repairs the relay-only Tailscale fault by itself (see watchNetwork).
system.watchNetwork({ log });
const screen = new ScreenControl({
  native,
  onChange: (state) => {
    hub.publish("screen", { event: "screen.state", state });
    if (controller?.active && controller.ws.readyState === 1)
      controller.ws.send(JSON.stringify({ event: "screenOwner", ...state }));
  },
});
const broker = new AgentBroker({
  stateDir,
  hub,
  screen,
  native,
  system,
  mcpScript: path.join(root, "server/mcp/palm-mac-mcp.mjs"),
  apiOrigin: `http://127.0.0.1:${port}`,
  // The test host never runs the user's real agents unless a test asks for them.
  scripted: synthetic && process.env.PALM_REAL_AGENTS !== "1",
  // The files a turn made reach the chat as cards; blocked files never do.
  policy: fsApi.policy,
  deviceName: () => computerName,
});
await broker.open();
// Warm the slow lookups so the first assistant request is quick.
broker.providers().catch(() => {});
dev.projects().catch(() => {});
const memory = new WorkMemory({ stateDir, policy: fsApi.policy });
// Speech and short answers through the user's own OpenRouter key; the test
// host answers with fixed words and never calls OpenRouter.
const voice = new Voice({ stateDir, synthetic });
// The optional OpenRouter route: OpenCode with the user's key, paid per use,
// within the limits set on the phone.
const apiRoute = new ApiRoute({ stateDir, voice, synthetic });
broker.apiRoute = apiRoute;
// Every agent on this Mac, wherever it started (Palm, Claude Code, Codex,
// OpenCode). Read-only. While a phone listens, a scan every few seconds turns
// a finished turn, a question or an error into an alert.
const watch = new AgentWatch({
  home: os.homedir(),
  palm: () => ({ tasks: broker.list(), sessionIds: broker.providerSessionIds() }),
});
let watchLast = null;
let watchRunning = null;
const watchScan = () => (watchRunning ??= watch.scan().finally(() => (watchRunning = null)));
// What each phone was last sent per session: only changed sessions go out
// (a session whose only change is its time goes at most once a minute), so a
// busy Mac does not keep a phone's connection full.
const watchSent = new Map();
setInterval(async () => {
  if (!hub.subscribers("watch")) return;
  const before = watchLast;
  const after = await watchScan().catch(() => null);
  if (!after) return;
  watchLast = after;
  const now = Date.now();
  const upserts = [];
  for (const session of after.sessions) {
    const { updated, ...rest } = session;
    const signature = JSON.stringify(rest);
    const sent = watchSent.get(session.id);
    if (!sent || sent.signature !== signature || (sent.updated !== updated && now - sent.at > 60000)) {
      upserts.push(session);
      watchSent.set(session.id, { signature, updated, at: now });
    }
  }
  const ids = new Set(after.sessions.map((s) => s.id));
  const removed = [...watchSent.keys()].filter((id) => !ids.has(id));
  for (const id of removed) watchSent.delete(id);
  if (upserts.length || removed.length) hub.publish("watch", { event: "watch.changed", upserts, removed });
  const alerts = alertsBetween(before, after);
  if (alerts.length) hub.publish("watch", { event: "watch.alerts", alerts });
}, 4000).unref();
// The test host finds files by walking its throwaway home, not through Spotlight.
const assistant = new Assistant({
  memory, broker, dev, policy: fsApi.policy, deviceName: () => computerName,
  search: synthetic ? async () => null : undefined,
  // With an OpenRouter key and "Use AI" on, requests the fast path cannot
  // place go to a model with Palm's own tools.
  brain: {
    enabled: async () => (await voice.configured()) && (await memory.preferences()).answerQuestions !== false,
    complete: (messages, tools) => voice.complete(messages, tools),
    brief: (context) => voice.brief(context),
  },
  watch: () => watchScan(),
  // Conversations remember their results; agents' outcomes come back to them.
  conversations: new Conversations({ stateDir }),
  publish: (payload) => hub.publish("assistant", { event: "assistant.followup", ...payload }),
});

const protocol = {
  protocolVersion: 2,
  serverVersion: palmVersion,
  capabilities: {
    nativePairing: !!sessions.file,
    durableDevices: !!sessions.file,
    h264: true,
    appControls: true,
    fileDownload: true,
    fullFilesystem: true,
    upload: true,
    clipboard: true,
    agents: true,
    terminal: true,
    devServers: true,
    previews: previewSlots.length > 0,
    systemControls: true,
    screenOwnership: true,
    events: true,
    audio: false,
    wake: false,
    restart: true,
    shutdown: true,
  },
};
const requestNative = (command, guard, options) => commands.run(() => native.request(command), guard, options);
const controllerValid = (owner) =>
  controller === owner && owner.active && owner.ws.readyState === 1 && !!sessions.authorized(owner.token, false);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};
function json(res, code, data) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
async function body(req, limit = 16384) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error("Request too large.");
  }
  return JSON.parse(raw || "{}");
}
function setSession(res, s, secure, maxAge = 43200) {
  res.setHeader(
    "Set-Cookie",
    `palm_session=${s.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );
}
function securityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}
function requestToken(req) {
  return req.headers.authorization ? bearerToken(req) : sessionCookie(req);
}
/** The device behind a request, if it may use Palm now (a web pairing must be
 * unlocked with Face ID). Records use, which keeps a web pairing unlocked. */
function session(req) {
  return sessions.authorized(requestToken(req));
}
/** The device behind a request whatever its lock state (pairing, Face ID). */
function pairedDevice(req) {
  return sessions.get(requestToken(req));
}
// Face ID requests per web pairing: a minute's worth, then a pause.
const passkeyAttempts = new Map();
function passkeyAttempt(s) {
  const now = Date.now();
  const recent = (passkeyAttempts.get(s.id) || []).filter((t) => t > now - 60000);
  if (recent.length >= 20) throw new Error("Too many Face ID attempts. Wait a minute and try again.");
  recent.push(now);
  passkeyAttempts.set(s.id, recent);
}
/** The web app's Face ID steps: set up the passkey, unlock, lock. */
async function webPasskeyApi(req, res, url) {
  const device = pairedDevice(req);
  if (!device || device.kind !== "web") return json(res, 401, { error: "Pair this phone with your Mac first." });
  const origin = req.headers.origin;
  const rpId = new URL(origin).hostname;
  const state = sessions.webState(device.token);
  if (url.pathname === "/api/web/lock" && req.method === "POST") {
    sessions.lock(device.token);
    return json(res, 200, { ok: true, state: sessions.webState(device.token) });
  }
  if (url.pathname === "/api/web/passkey/options" && req.method === "POST") {
    passkeyAttempt(device);
    const purpose = (await body(req)).purpose;
    if (purpose === "register") {
      if (state !== "setup") throw new Error("Face ID is already set up for this phone.");
      const challenge = sessions.issueChallenge(device.token, "register", newChallenge());
      return json(res, 200, {
        publicKey: {
          challenge,
          rp: { id: rpId, name: "Palm" },
          user: { id: Buffer.from(device.id, "hex").toString("base64url"), name: device.name, displayName: `${device.name} · Palm` },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
          attestation: "none",
          timeout: 120000,
        },
      });
    }
    if (purpose === "unlock") {
      if (state === "setup") throw new Error("Set up Face ID for Palm first.");
      const challenge = sessions.issueChallenge(device.token, "unlock", newChallenge());
      return json(res, 200, {
        publicKey: {
          challenge,
          rpId,
          allowCredentials: [{ type: "public-key", id: device.passkey.id, transports: ["internal", "hybrid"] }],
          userVerification: "required",
          timeout: 120000,
        },
      });
    }
    throw new Error("Unknown Face ID step.");
  }
  if (url.pathname === "/api/web/passkey/register" && req.method === "POST") {
    passkeyAttempt(device);
    if (state !== "setup") throw new Error("Face ID is already set up for this phone.");
    const challenge = sessions.takeChallenge(device.token, "register");
    const passkey = verifyRegistration({ credential: (await body(req)).credential, challenge, origin, rpId });
    await sessions.setPasskey(device.token, passkey);
    log("web.passkey", { device: device.name });
    return json(res, 200, { ok: true, state: sessions.webState(device.token) });
  }
  if (url.pathname === "/api/web/passkey/unlock" && req.method === "POST") {
    passkeyAttempt(device);
    if (state === "setup") throw new Error("Set up Face ID for Palm first.");
    const challenge = sessions.takeChallenge(device.token, "unlock");
    const result = verifyAssertion({ credential: (await body(req)).credential, stored: device.passkey, challenge, origin, rpId });
    sessions.unlock(device.token);
    await sessions.updateSignCount(device.token, result.signCount);
    return json(res, 200, { ok: true, state: sessions.webState(device.token) });
  }
  return json(res, 404, { error: "Not found." });
}
function ownOrigin(req) {
  return checkOrigin(req, origins) && new URL(req.headers.origin).host === req.headers.host;
}
// Tailscale Serve forwards the phone's tailnet address; used only to report
// which network path that phone is on.
function peerAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return /^100\.\d+\.\d+\.\d+$/.test(forwarded) ? forwarded : null;
}
// Where "Send to Mac" lands by default: a Palm folder in Downloads
// (PALM_INBOX overrides it).
async function chooseInbox() {
  const preferred = process.env.PALM_INBOX || path.join(os.homedir(), "Downloads/Palm");
  try {
    await mkdir(preferred, { recursive: true });
    return preferred;
  } catch {
    return path.join(os.homedir(), "Downloads");
  }
}
// Test host only: "Trash" moves items into the host's own state folder.
async function syntheticTrash(paths) {
  const bin = path.join(stateDir, "synthetic-trash");
  await mkdir(bin, { recursive: true });
  const moved = [];
  for (const item of paths) {
    const target = path.join(bin, `${Date.now()}-${path.basename(item)}`);
    await rename(item, target);
    moved.push({ from: item, to: target });
  }
  return moved;
}
function stopController(owner, code = 1000, reason = "Disconnected") {
  if (controller !== owner || !owner.active) return;
  owner.active = false;
  owner.streaming = false;
  streamConfig = null;
  if (owner.ws.readyState === 1) owner.ws.close(code, reason);
  const terminate = setTimeout(() => owner.ws.terminate(), 2000);
  terminate.unref();
  owner.ws.once("close", () => clearTimeout(terminate));
  // Keep the lease reserved until old work has drained and capture has stopped.
  requestNative({ op: "stop" }, () => controller === owner, { cleanup: true })
    .catch(() => {})
    .finally(() => {
      if (controller === owner) {
        controller = null;
        controlEpoch++;
      }
    });
}
function mediaSnapshot(owner) {
  if (!owner) return lastMediaDiagnostics;
  return { active: owner.streaming, audioConnected: owner.audio?.readyState === 1,
    talking: owner.talking, seconds: (Date.now() - owner.opened) / 1000,
    ...owner.stats, videoInFlight: owner.videoPending.size,
    audioInFlight: owner.audioPending.size, client: owner.clientStats || null };
}
function stopMedia(owner, code = 1000, reason = "Disconnected") {
  if (mediaOwner !== owner) return;
  owner.streaming = false;
  owner.talking = false;
  owner.talkEpoch++;
  lastMediaDiagnostics = mediaSnapshot(owner);
  mediaOwner = null;
  for (const ws of [owner.ws, owner.audio]) {
    if (!ws) continue;
    if (ws.readyState === 1) ws.close(code, reason);
    const timer = setTimeout(() => ws.terminate(), 2000);
    timer.unref(); ws.once("close", () => clearTimeout(timer));
  }
  native.request({ op: "mediaStop" }).catch(() => {});
}
// The old connection of a phone that reconnected: closed, and its capture
// stopped before anything the new connection asks for (the command queue
// runs in order, and nothing from the new connection has arrived yet).
function replaceController(owner) {
  owner.active = false;
  owner.streaming = false;
  streamConfig = null;
  if (owner.ws.readyState === 1) owner.ws.close(4000, "Replaced by a newer connection");
  const terminate = setTimeout(() => owner.ws.terminate(), 2000);
  terminate.unref();
  owner.ws.once("close", () => clearTimeout(terminate));
  requestNative({ op: "stop" }, () => true, { cleanup: true }).catch(() => {});
}
function route(pattern, pathname) {
  const match = pattern.exec(pathname);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}
function flag(url, name) {
  return ["1", "true", "yes"].includes(url.searchParams.get(name) || "");
}

async function authenticatedApi(req, res, url, authenticated) {
  const p = url.pathname;
  const m = req.method;
  let params;

  if (p === "/api/status" && m === "GET")
    return json(res, 200, {
      ...(await requestNative({ op: "status" })),
      // A test host answers to the name it was given (two test Macs in one run).
      ...(synthetic ? { name: computerName } : {}),
      sharedFolder: path.basename(shareRoot),
      remoteEnabled: !!remoteOrigin,
      synthetic,
      // Demo recordings: the test host without its on-screen label.
      ...(synthetic && process.env.PALM_DEMO === "1" ? { demo: true } : {}),
      ...protocol,
      controllerConnected: !!controller?.active,
      screen: screen.state(),
      inbox,
      home: os.homedir(),
    });
  if (p === "/api/apps" && m === "GET") return json(res, 200, await requestNative({ op: "apps" }));
  if (p === "/api/apps/installed" && m === "GET") return json(res, 200, await requestNative({ op: "installedApps" }));
  if (p === "/api/displays" && m === "GET") return json(res, 200, await requestNative({ op: "displays" }));
  if (p === "/api/dock" && m === "GET") return json(res, 200, await requestNative({ op: "dockItems" }));

  // Legacy Shared-folder browsing for older phone builds.
  if (p === "/api/files" && m === "GET")
    return json(res, 200, {
      items: await listFiles(shareRoot, url.searchParams.get("path") || ""),
      folder: path.basename(shareRoot),
    });
  if (p === "/api/download" && m === "GET") {
    const file = await safeFile(shareRoot, url.searchParams.get("path") || "");
    const s = await stat(file);
    if (!s.isFile()) throw new Error("Choose a file to download.");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": s.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    });
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }

  // ---- Files: the Mac filesystem this account can reach ----
  if (p === "/api/fs/places" && m === "GET") return json(res, 200, { places: await fsApi.places(), home: os.homedir(), inbox });
  if (p === "/api/fs/list" && m === "GET")
    return json(res, 200, await fsApi.list(url.searchParams.get("path") || os.homedir(), { hidden: flag(url, "hidden") }));
  if (p === "/api/fs/stat" && m === "GET") return json(res, 200, await fsApi.stat(url.searchParams.get("path")));
  if (p === "/api/fs/hash" && m === "GET")
    return json(res, 200, await fsApi.hash(url.searchParams.get("path"), { confirmSensitive: flag(url, "confirm") }));
  if (p === "/api/fs/preview" && m === "GET")
    return json(res, 200, await fsApi.preview(url.searchParams.get("path"), { confirmSensitive: flag(url, "confirm") }));
  if (p === "/api/fs/download" && (m === "GET" || m === "HEAD"))
    return fsApi.download(url.searchParams.get("path"), req, res, { confirmSensitive: flag(url, "confirm") });
  if (p === "/api/fs/search" && m === "GET")
    return json(res, 200, await fsApi.search(url.searchParams.get("path") || os.homedir(), url.searchParams.get("q")));
  if (p === "/api/fs/upload" && m === "PUT") {
    const size = url.searchParams.get("size");
    const result = await fsApi.upload(req, {
      folder: url.searchParams.get("dir") || inbox,
      name: url.searchParams.get("name"),
      conflict: ["rename", "replace", "fail"].includes(url.searchParams.get("conflict")) ? url.searchParams.get("conflict") : "rename",
      expectedSha256: url.searchParams.get("sha256") || undefined,
      expectedSize: size === null ? undefined : Number(size),
    });
    hub.publish("files", { event: "files.changed", folder: path.dirname(result.path) });
    return json(res, 200, result);
  }
  if (p === "/api/fs/mkdir" && m === "POST") {
    const b = await body(req);
    return json(res, 200, await fsApi.mkdir(b.path, b.name));
  }
  if (p === "/api/fs/rename" && m === "POST") {
    const b = await body(req);
    return json(res, 200, await fsApi.rename(b.path, b.name));
  }
  if ((p === "/api/fs/move" || p === "/api/fs/copy") && m === "POST") {
    const b = await body(req, 262144);
    const moved = await fsApi.transfer(b.paths, b.to, { mode: p.endsWith("move") ? "move" : "copy", conflict: b.conflict });
    return json(res, 200, { items: moved });
  }
  if (p === "/api/fs/trash" && m === "POST") {
    const b = await body(req, 262144);
    return json(res, 200, { items: await fsApi.moveToTrash(b.paths) });
  }

  // ---- Clipboard ----
  if (p === "/api/clipboard" && m === "GET") return json(res, 200, await native.request({ op: "clipboardRead" }));
  if (p === "/api/clipboard" && m === "POST") {
    const b = await body(req, 18 * 1024 * 1024);
    const command = { op: "clipboardWrite" };
    if (typeof b.text === "string") command.text = b.text;
    else if (typeof b.imagePNG === "string") command.imagePNG = b.imagePNG;
    else if (Array.isArray(b.files)) {
      const files = [];
      for (const f of b.files.slice(0, 50)) files.push((await fsApi.resolveExisting(f)).absolute);
      command.files = files;
    } else throw new Error("Send text, an image or files.");
    return json(res, 200, await native.request(command));
  }

  // ---- Mac system controls ----
  if (p === "/api/system" && m === "GET") return json(res, 200, await system.status(peerAddress(req)));
  if (p === "/api/system/action" && m === "POST") {
    const b = await body(req);
    return json(res, 200, await system.action(String(b.action || ""), b));
  }

  // ---- Screen ownership (phone versus agent) ----
  if (p === "/api/screen" && m === "GET") return json(res, 200, screen.state());
  if (p === "/api/screen/takeover" && m === "POST") {
    const state = await screen.takeOver();
    if (state.from && state.from !== "manual") {
      const task = broker.tasks.get(state.from);
      if (task) broker.emit(task, { type: "screen", owner: "human", text: "You took over the Mac screen. The agent's screen actions are paused." });
    }
    return json(res, 200, state);
  }
  if (p === "/api/screen/handback" && m === "POST") {
    const b = await body(req);
    const state = await screen.handBack(typeof b.taskId === "string" ? b.taskId : undefined);
    const taskId = state.owner?.taskId;
    const task = taskId && broker.tasks.get(taskId);
    if (task) {
      broker.emit(task, { type: "screen", owner: "agent", text: "You handed the screen back to the agent." });
      if (b.continue === true)
        await broker.screenHandedBack(
          task.id,
          typeof b.message === "string" && b.message.trim() ? b.message.trim().slice(0, 4000) : "I've handed the Mac screen back to you. I may have changed things while I had control, so take a fresh screenshot and continue the task from the current state.",
        );
    }
    return json(res, 200, state);
  }

  // ---- Agents ----
  if (p === "/api/agents/providers" && m === "GET") return json(res, 200, { providers: await broker.providers({ refresh: flag(url, "refresh") }) });
  if (p === "/api/projects" && m === "GET") return json(res, 200, { projects: await dev.projects({ refresh: flag(url, "refresh") }) });
  if (p === "/api/tasks" && m === "GET") return json(res, 200, { tasks: broker.list({ archived: flag(url, "archived") }) });
  if (p === "/api/tasks" && m === "POST") return json(res, 200, await broker.create(await body(req, 65536)));
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})$/, p)) && m === "GET")
    return json(res, 200, await broker.get(params[0], Number(url.searchParams.get("after") || 0)));
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})\/messages$/, p)) && m === "POST")
    return json(res, 200, await broker.send(params[0], await body(req, 65536)));
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})\/stop$/, p)) && m === "POST") return json(res, 200, await broker.stop(params[0]));
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})\/approvals$/, p)) && m === "POST") {
    const b = await body(req);
    return json(res, 200, broker.answer(params[0], String(b.approvalId || ""), String(b.decision || "")));
  }
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})\/screen$/, p)) && m === "POST") {
    const b = await body(req);
    return json(res, 200, broker.setScreenControl(params[0], b.allowed === true));
  }
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})\/rename$/, p)) && m === "POST")
    return json(res, 200, broker.rename(params[0], (await body(req)).title));
  if ((params = route(/^\/api\/tasks\/([\w-]{8,64})\/archive$/, p)) && m === "POST") {
    const b = await body(req);
    return json(res, 200, await broker.archive(params[0], b.archived !== false));
  }

  // ---- Assistant and what Palm remembers ----
  if (p === "/api/assistant" && m === "POST") {
    const b = await body(req, 65536);
    const devices = Array.isArray(b.devices) ? b.devices.filter((d) => typeof d === "string").slice(0, 20).map((d) => d.slice(0, 60)) : [];
    return json(res, 200, await assistant.handle(b.text, { devices, conversation: b.conversation, turn: b.turn, screen: b.screen === true, access: b.access }));
  }
  if (p === "/api/assistant/handoff" && m === "POST") return json(res, 200, await assistant.startHandoff(await body(req)));
  // The file the person saved or opened from a card: "that file" from now on.
  if (p === "/api/assistant/chosen" && m === "POST") {
    const b = await body(req);
    const chosen = typeof b.path === "string" && b.path.length <= 4096 && (await assistant.conversations.choose(b.conversation, b.path));
    return json(res, 200, { ok: !!chosen });
  }
  if (p === "/api/assistant/conversation" && m === "GET") {
    const conversation = await assistant.conversations.get(url.searchParams.get("id"));
    return json(res, 200, { turns: (conversation?.turns ?? []).map((t) => ({ id: t.id, followups: t.followups ?? [] })) });
  }
  if (p === "/api/agents/watch" && m === "GET") {
    const result = await watchScan();
    watchLast ??= result;
    // The phone now holds everything: later changes are sent as differences.
    for (const session of result.sessions) {
      const { updated, ...rest } = session;
      watchSent.set(session.id, { signature: JSON.stringify(rest), updated, at: Date.now() });
    }
    return json(res, 200, result);
  }
  if (p === "/api/agents/watch/open" && m === "POST") {
    // Opens that chat in its own app on the Mac. Only a link this Mac worked
    // out itself is used; the phone sends the session's id.
    const id = String((await body(req)).id || "");
    const found = (watchLast ?? (await watchScan())).sessions.find((s) => s.id === id);
    if (!found?.link) throw new Error("That session cannot be opened directly. Open its app from the Screen tab.");
    if (synthetic) return json(res, 200, { opened: true, app: found.app });
    const bundle = found.source === "codex" ? "com.openai.codex" : "com.anthropic.claudefordesktop";
    await new Promise((resolve, reject) =>
      execFile("/usr/bin/open", ["-b", bundle, found.link], (error) => (error ? reject(new Error(`${found.app} could not open it.`)) : resolve())),
    );
    return json(res, 200, { opened: true, app: found.app });
  }
  if (p === "/api/agents/api-route" && m === "GET") {
    const installed = synthetic || !!(await broker.agentProviders()).find((a) => a.id === "opencode" && a.available);
    return json(res, 200, await apiRoute.status({ installed }));
  }
  if (p === "/api/agents/api-route" && m === "POST") return json(res, 200, await apiRoute.update(await body(req)));
  if (p === "/api/agents/api-route/models" && m === "GET") return json(res, 200, { models: await apiRoute.models() });
  if (p === "/api/voice" && m === "GET") return json(res, 200, await voice.status({ usage: url.searchParams.get("usage") === "1" }));
  if (p === "/api/voice/key" && m === "POST") return json(res, 200, await voice.setKey((await body(req)).key));
  // Up to five minutes of 16 kHz WAV, as base64 inside JSON.
  if (p === "/api/voice/transcribe" && m === "POST") return json(res, 200, await voice.transcribe(await body(req, 14_000_000)));
  if (p === "/api/voice/speak" && m === "POST") return await voice.speak((await body(req)).text, res);
  if (p === "/api/assistant/preview" && m === "POST") return json(res, 200, await assistant.previewFolder((await body(req)).cwd));
  if (p === "/api/memory" && m === "GET") return json(res, 200, await memory.snapshot());
  if (p === "/api/memory/alias" && m === "POST") return json(res, 200, await memory.setAlias(await body(req)));
  if (p === "/api/memory/workspace" && m === "POST") return json(res, 200, await memory.setWorkspace(await body(req)));
  if (p === "/api/memory/remove" && m === "POST") {
    const b = await body(req);
    return json(res, 200, await memory.remove(b.kind === "alias" ? "alias" : "workspace", String(b.id || "")));
  }
  if (p === "/api/memory/preferences" && m === "POST") return json(res, 200, await memory.setPreferences(await body(req)));

  // ---- Terminals ----
  if (p === "/api/terminals" && m === "GET") return json(res, 200, { terminals: terminals.list() });
  if (p === "/api/terminals" && m === "POST") return json(res, 200, await terminals.create(await body(req)));
  if ((params = route(/^\/api\/terminals\/([a-f0-9]{12})\/close$/, p)) && m === "POST") {
    await terminals.close(params[0]);
    return json(res, 200, { ok: true });
  }

  // ---- Dev servers and previews ----
  if (p === "/api/dev" && m === "GET")
    return json(res, 200, { servers: dev.list(), ports: await dev.running(), previews: gateway.status() });
  if (p === "/api/dev" && m === "POST") return json(res, 200, await dev.start(await body(req)));
  if ((params = route(/^\/api\/dev\/([a-f0-9]{10})\/(stop|restart|remove)$/, p)) && m === "POST") {
    const [id, action] = params;
    if (action === "stop") return json(res, 200, await dev.stop(id));
    if (action === "restart") return json(res, 200, await dev.restart(id));
    dev.remove(id);
    return json(res, 200, { ok: true });
  }
  if ((params = route(/^\/api\/dev\/([a-f0-9]{10})\/logs$/, p)) && m === "GET")
    return json(res, 200, dev.logs(params[0], Number(url.searchParams.get("after") || 0)));
  if (p === "/api/dev/preview" && m === "POST") {
    const b = await body(req);
    let target;
    if (typeof b.devId === "string") {
      const server = dev.require(b.devId);
      if (!server.port) throw new Error("This server has not opened a port yet. Wait for it to finish starting.");
      target = { port: server.port, label: server.name, devId: server.id };
    } else {
      const portNumber = Number(b.port);
      const listening = await dev.listening();
      const found = listening.find((l) => l.port === portNumber);
      if (!found) throw new Error("Nothing is listening on that port on your Mac.");
      target = { port: portNumber, label: `${found.process} · ${portNumber}` };
    }
    return json(res, 200, gateway.open(target));
  }

  // ---- Screen control commands over HTTP (named app actions etc.) ----
  if (p === "/api/command" && m === "POST") {
    const command = validateCommand(await body(req));
    if (["start", "stop", "keyframe", ...inputOps].includes(command.op))
      throw new Error("Open the live control session first.");
    if (controller && controller.token !== authenticated.token)
      return json(res, 409, { error: "Another device is controlling this Mac." });
    const epoch = controlEpoch;
    const guard = () =>
      controlEpoch === epoch &&
      !!sessions.get(authenticated.token) &&
      (!controller || (controller.active && controller.token === authenticated.token));
    if (command.op === "action")
      return json(res, 200, await commands.run(() => screen.humanInput(command), guard));
    return json(res, 200, await requestNative(command, guard));
  }
  if (p === "/api/disconnect" && m === "POST") {
    const s = authenticated;
    const revoked = sessions.revoke(s.id);
    if (controller?.token === s.token) stopController(controller, 4001, "Device disconnected");
    if (mediaOwner?.token === s.token) stopMedia(mediaOwner, 4001, "Device disconnected");
    await revoked;
    res.setHeader("Set-Cookie", "palm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    if (!hosts.has(req.headers.host)) return json(res, 403, { error: "Unrecognised host." });
    const url = new URL(req.url, "http://localhost");
    if (req.headers.authorization && !ownOrigin(req)) return json(res, 403, { error: "Request origin rejected." });
    const rawUpload = url.pathname === "/api/fs/upload" && req.method === "PUT";
    if (
      ["POST", "PUT", "DELETE"].includes(req.method) &&
      (!ownOrigin(req) || (!rawUpload && !req.headers["content-type"]?.startsWith("application/json")))
    )
      return json(res, 403, { error: "Request origin rejected." });
    if (url.pathname === "/api/session") {
      const device = pairedDevice(req);
      const web = device?.kind === "web" ? sessions.webState(device.token) : null;
      return json(res, 200, {
        paired: !!device, local: isLocal(req), synthetic, ...protocol,
        ...(web ? { web: { state: web, name: device.name, expires: device.expires } } : {}),
      });
    }
    if (url.pathname.startsWith("/api/web/") && url.pathname !== "/api/web/pair") return await webPasskeyApi(req, res, url);

    // Palm's MCP server calls back here for a running agent. Loopback only,
    // authenticated by the per-task token the broker issued.
    if (url.pathname === "/api/agent-tools/call" && req.method === "POST") {
      if (!isLocal(req)) return json(res, 403, { error: "Agent tools are local to the Mac." });
      const token = /^Palm-Agent ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || "")?.[1];
      if (!token) return json(res, 401, { error: "Missing agent token." });
      const b = await body(req, 65536);
      try {
        return json(res, 200, await broker.toolCall(token, String(b.tool || ""), b.arguments || {}));
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    if (url.pathname.startsWith("/api/local/")) {
      if (!isLocal(req)) return json(res, 403, { error: "Open setup on the Mac itself." });
      if (req.method === "GET" && url.pathname === "/api/local/diagnostics")
        return json(res, 200, { upgrades: upgradeLog, events: hub.clients.size, controller: !!controller?.active,
          screen: controller?.flow ? { ...controller.flow.snapshot(), native: await native.request({ op: "screenFlow" }).catch(() => null) } : null });
      if (req.method === "GET" && url.pathname === "/api/local/setup")
        return json(res, 200, {
          remoteOrigin,
          sharedFolder: path.basename(shareRoot),
          devices: sessions.list(),
          status: await requestNative({ op: "status" }),
          previews: gateway.status(),
        });
      if (req.method === "POST" && url.pathname === "/api/local/connection") {
        const b = await body(req);
        if (process.env.PALM_ORIGIN !== undefined)
          throw new Error("The private address is set by PALM_ORIGIN. Change that setting and restart Palm.");
        if (
          typeof b.origin !== "string" ||
          b.origin.length > 300 ||
          (b.origin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(b.origin))
        )
          throw new Error("Enter an HTTPS address with no path, or leave it empty to disable remote access.");
        if (b.origin && new URL(b.origin).origin !== b.origin)
          throw new Error("Enter a complete HTTPS origin without a default port or path.");
        const configure = async () => {
          await writePrivateJSON(path.join(stateDir, "runtime.json"), { ...saved, origin: b.origin });
          saved.origin = b.origin;
          remoteOrigin = b.origin;
          origins.clear();
          for (const o of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, remoteOrigin].filter(Boolean)) origins.add(o);
          hosts.clear();
          for (const o of origins) hosts.add(new URL(o).host);
          gateway.setPublicHost(remoteOrigin ? new URL(remoteOrigin).hostname : null);
          if (controller && !origins.has(controller.origin)) stopController(controller, 4000, "Private address changed");
          if (mediaOwner) stopMedia(mediaOwner, 4000, "Private address changed");
          return { origin: remoteOrigin, remoteEnabled: !!remoteOrigin, restartRequired: false };
        };
        const changed = connectionWrites.then(configure, configure);
        connectionWrites = changed.catch(() => {});
        return json(res, 200, await changed);
      }
      // The test Mac's last keys and text: proof that typing reaches the Mac.
      if (synthetic && req.method === "GET" && url.pathname === "/api/local/test/typing")
        return json(res, 200, await requestNative({ op: "syntheticTyping" }));
      // The test Mac's screen stops changing (a still picture is sharpened).
      if (synthetic && req.method === "POST" && url.pathname === "/api/local/test/still")
        return json(res, 200, await requestNative({ op: "syntheticStill", on: (await body(req)).on === true }));
      // The test host's sample agent sessions: set up, then one finishes.
      if (synthetic && req.method === "POST" && url.pathname === "/api/local/test/agents") {
        const { writeWatchFixture, finishWatchFixture } = await import("./agents/watch-fixture.mjs");
        const action = (await body(req)).action;
        if (action === "setup") {
          await writeWatchFixture(os.homedir());
          watch.indexedAt = 0;
        }
        else if (action === "finish") await finishWatchFixture(os.homedir());
        else throw new Error("Unknown test action.");
        return json(res, 200, { ok: true });
      }
      // Setting the OpenRouter key on the Mac itself; it never leaves the Mac
      // except to OpenRouter.
      if (req.method === "POST" && url.pathname === "/api/local/voice-key")
        return json(res, 200, await voice.setKey((await body(req)).key));
      if (req.method === "POST" && url.pathname === "/api/local/pair-code") {
        const code = sessions.rotate();
        return json(res, 200, {
          code: code.value,
          expires: code.expires,
          url: remoteOrigin ? `${remoteOrigin}/#pair=${code.value}` : null,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/local/connect") {
        const s = sessions.create("This Mac");
        setSession(res, s, false);
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/local/media-diagnostics")
        return json(res, 200, { transport: mediaSnapshot(mediaOwner), native: await requestNative({ op: "mediaDiagnostics" }) });
      if (req.method === "GET" && url.pathname === "/api/local/media-permissions")
        return json(res, 200, await requestNative({ op: "mediaPermissions" }));
      if (req.method === "POST" && url.pathname === "/api/local/permissions") {
        const b = await body(req);
        if (!["screen", "accessibility", "camera", "microphone"].includes(b.kind)) throw new Error("Unknown permission.");
        return json(res, 200, await requestNative({ op: "permission", kind: b.kind }));
      }
      if (req.method === "POST" && url.pathname === "/api/local/revoke") {
        const b = await body(req);
        const revoked = sessions.revoke(b.id);
        if (controller && !sessions.get(controller.token)) stopController(controller, 4001, "Device disconnected");
        if (mediaOwner && !sessions.get(mediaOwner.token)) stopMedia(mediaOwner, 4001, "Device disconnected");
        for (const client of hub.clients) if (!sessions.get(client.token)) client.ws.close(4001, "Device disconnected");
        await revoked;
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "Not found." });
    }
    if (url.pathname === "/api/native/pair" && req.method === "POST") {
      const b = await body(req);
      try {
        const s = await sessions.pairNative(b.code, b.name);
        return json(res, 200, { token: s.token, expires: s.expires, deviceId: s.id });
      } catch (e) {
        return json(res, 429, { error: e.message });
      }
    }
    // The web app on a phone: a durable pairing that Face ID unlocks.
    if (url.pathname === "/api/web/pair" && req.method === "POST") {
      const b = await body(req);
      try {
        const s = await sessions.pairWeb(b.code, b.name);
        setSession(res, s, req.headers.origin?.startsWith("https:"), Math.floor((s.expires - Date.now()) / 1000));
        return json(res, 200, { ok: true, state: "setup", expires: s.expires });
      } catch (e) {
        return json(res, 429, { error: e.message });
      }
    }
    // A browser session without Face ID: only on the Mac itself now; phones
    // pair as web devices above.
    if (url.pathname === "/api/pair" && req.method === "POST") {
      if (!isLocal(req)) return json(res, 403, { error: "Pair this phone from Palm's web app." });
      const b = await body(req);
      try {
        const s = sessions.pair(b.code, b.name);
        setSession(res, s, req.headers.origin?.startsWith("https:"));
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 429, { error: e.message });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      let authenticated = session(req);
      if (!authenticated) {
        const device = pairedDevice(req);
        if (device?.kind === "web" && url.pathname === "/api/disconnect" && req.method === "POST") authenticated = device;
        else if (device?.kind === "web")
          return json(res, 423, { error: device.passkey ? "Unlock Palm with Face ID." : "Set up Face ID for Palm first.", locked: true, state: sessions.webState(device.token) });
        else return json(res, 401, { error: "Pair this device with your Mac first." });
      }
      return await authenticatedApi(req, res, url, authenticated);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
    const file = path.resolve(root, "dist", rel);
    if (!file.startsWith(path.join(root, "dist") + path.sep)) return json(res, 403, { error: "Not found." });
    try {
      const data = await readFile(file);
      const type = mime[path.extname(file)] || "application/octet-stream";
      // Byte ranges: Safari plays video only from a server that answers them.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
      if (range && (range[1] !== "" || range[2] !== "")) {
        const start = range[1] === "" ? Math.max(0, data.length - Number(range[2])) : Number(range[1]);
        const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        if (start > end || start >= data.length) {
          res.writeHead(416, { "Content-Range": `bytes */${data.length}` });
          return res.end();
        }
        res.writeHead(206, {
          "Content-Type": type,
          "Content-Range": `bytes ${start}-${end}/${data.length}`,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
        });
        return res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Accept-Ranges": "bytes" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      return json(res, 404, { error: "Not found." });
    }
  } catch (e) {
    if (!res.headersSent) {
      const status = e instanceof FsError ? e.status : 400;
      json(res, status, { error: e.message || "Something went wrong.", ...(e.code && e instanceof FsError ? { code: e.code } : {}) });
    } else res.destroy();
  }
});
server.requestTimeout = 0; // Large uploads and downloads are streamed.

const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
const eventsWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

// Recent connection attempts for local diagnosis: path, result and time only.
const upgradeLog = [];
function noteUpgrade(pathname, result, req) {
  upgradeLog.push({ at: new Date().toISOString(), path: pathname.slice(0, 40), result, via: peerAddress(req) ? "tailnet" : "local" });
  if (upgradeLog.length > 100) upgradeLog.shift();
}
server.on("upgrade", (req, socket, head) => {
  const s = session(req);
  const pathname = (req.url || "").split("?")[0];
  let failure = null;
  if (!["/socket", "/events", "/media", "/media-audio"].includes(pathname)) failure = "403 Forbidden";
  else if (!hosts.has(req.headers.host)) failure = "403 Forbidden (host)";
  else if (!ownOrigin(req)) failure = "403 Forbidden (origin)";
  else if (!s) failure = pairedDevice(req)?.kind === "web" ? "423 Locked" : "401 Unauthorized";
  else if (["/media", "/media-audio"].includes(pathname) && !["native", "web"].includes(s.kind)) failure = "403 Forbidden";
  // Another device's live screen is never taken over; the Palm app's own
  // older connection is replaced (controlClient). A browser keeps one: two
  // tabs would take it from each other.
  else if (pathname === "/socket" && controller && !(["native", "web"].includes(s.kind) && controller.token === s.token)) failure = "409 Conflict";
  else if (pathname === "/media" && mediaOwner && mediaOwner.token !== s.token) failure = "409 Conflict";
  else if (pathname === "/media-audio" && (!mediaOwner?.ready || mediaOwner.token !== s.token ||
    req.headers["x-palm-media-session"] !== mediaOwner.id || mediaOwner.audio)) failure = "409 Conflict";
  noteUpgrade(pathname, failure || "101", req);
  if (failure) failure = failure.replace(/ \(.*\)$/, "");
  if (failure) {
    socket.write(`HTTP/1.1 ${failure}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  if (pathname === "/events") return eventsWss.handleUpgrade(req, socket, head, (ws) => eventsClient(ws, s));
  if (pathname === "/media") return wss.handleUpgrade(req, socket, head, (ws) => mediaClient(ws, s));
  if (pathname === "/media-audio") return wss.handleUpgrade(req, socket, head, (ws) => mediaAudioClient(ws, mediaOwner));
  wss.handleUpgrade(req, socket, head, (ws) => controlClient(ws, s, req));
});

// Video and audio have independent TCP connections and acknowledgement windows.
// At most five video frames and 25 20-ms audio packets can be in flight.
function mediaClient(ws, s) {
  if (mediaOwner?.token === s.token) stopMedia(mediaOwner, 4000, "Replaced by a newer connection");
  const owner = { ws, token: s.token, id: randomUUID(), opened: Date.now(), streaming: false,
    ready: false, talking: false, talkReady: false, talkEpoch: 0,
    audio: null, audioQueued: 0, audioWork: Promise.resolve(),
    videoSequence: 0, audioSequence: 0, videoPending: new Map(), audioPending: new Map(),
    videoConfig: null, waitingKey: true, keyRequested: false,
    stats: { videoFrames: 0, videoBytes: 0, videoDropped: 0, audioPackets: 0,
      audioBytes: 0, audioDropped: 0, talkPackets: 0, talkDropped: 0,
      videoAckMs: 0, audioAckMs: 0 } };
  mediaOwner = owner;
  let lastSeen = Date.now();
  const check = setInterval(() => {
    if (mediaOwner !== owner) return;
    if (!sessions.get(s.token)) stopMedia(owner, 4001, "Session expired");
    else if (!sessions.authorized(s.token, false)) stopMedia(owner, 4003, "Locked");
    else if (Date.now() - lastSeen > 15000) stopMedia(owner, 4000, "Connection timed out");
  }, 3000);
  const send = (message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
  ws.on("message", async (raw, binary) => {
    let starting = false;
    try {
      lastSeen = Date.now();
      if (mediaOwner !== owner || !sessions.authorized(s.token)) return;
      if (binary || raw.length > 24000) throw new Error("Invalid media command.");
      const command = JSON.parse(raw);
      if (!command || typeof command !== "object") throw new Error("Invalid media command.");
      if (raw.length > 4096 && command.op !== "rtc.offer") throw new Error("Invalid media command.");
      // The phone's WebRTC offer for the call's sound; the Mac answers (PalmRTC).
      if (command.op === "rtc.offer") {
        if (!owner.ready || !owner.rtc || typeof command.sdp !== "string" || !command.sdp.startsWith("v=0"))
          throw new Error("Invalid audio call offer.");
        try {
          const answer = await native.request({ op: "mediaRtcAnswer", sdp: command.sdp });
          if (mediaOwner === owner) send({ event: "rtc.answer", sdp: answer.sdp });
        } catch (error) { send({ event: "rtc.error", message: error.message }); }
        return;
      }
      if (command.op === "ping") return send({ event: "pong" });
      if (command.op === "stop") return stopMedia(owner);
      if (command.op === "video.ack") {
        const released = acknowledge(owner.videoPending, command.sequence, (ms) => { owner.stats.videoAckMs = ms; owner.stats.videoAckMaxMs = Math.max(owner.stats.videoAckMaxMs || 0, ms); });
        if (released) native.request({ op: "mediaVideoCredit", count: released }).catch(() => stopMedia(owner, 4000, "Camera stopped"));
        return;
      }
      if (command.op === "keyframe") { requestMediaKey(owner); return; }
      if (command.op === "stats") {
        const allowed = ["videoFrames", "videoFps", "audioPackets", "audioRenderedFrames",
          "audioNonzeroFrames", "audioPeak", "audioQueuedMs", "talkPackets", "talkDropped",
          "phoneMicPeak", "phoneMicFrames", "outputVolume", "rtcPacketsReceived", "rtcPacketsLost",
          "rtcJitterMs", "rtcBufferMs", "rtcConcealedPct", "rtcAudioLevel", "rtcPacketsSent", "rtcRttMs",
          "rtcConnected"];
        owner.clientStats = Object.fromEntries(allowed.filter((k) => Number.isFinite(command[k]))
          .map((k) => [k, Math.max(0, Math.min(1e12, command[k]))]));
        return;
      }
      if (command.op === "talk.start") {
        if (!owner.ready || owner.audio?.readyState !== 1 || owner.talking)
          throw new Error("Connect camera and audio before talking.");
        owner.talking = true;
        const epoch = ++owner.talkEpoch;
        try {
          await native.request({ op: "mediaTalkStart" });
          if (mediaOwner !== owner || !owner.talking || owner.talkEpoch !== epoch) return;
          owner.talkReady = true;
          send({ event: "media.talkStarted" });
        } catch (error) {
          owner.talking = false;
          send({ event: "media.talkError", message: error.message });
        }
        return;
      }
      if (command.op === "talk.stop") {
        owner.talking = false; owner.talkReady = false; owner.talkEpoch++;
        try {
          await owner.audioWork;
          await native.request({ op: "mediaTalkStop" });
          if (mediaOwner === owner) send({ event: "media.talkStopped" });
        } catch (error) { send({ event: "media.talkError", message: error.message }); }
        return;
      }
      if (command.op !== "start" || owner.streaming) throw new Error("Invalid media command.");
      if (command.protocolVersion !== 2) throw new Error("Update Palm on your iPhone to use the improved camera and audio stream.");
      starting = true; owner.streaming = true;
      owner.rtc = command.rtc === true;
      const result = await native.request({ op: "mediaStart", mediaSession: owner.id, ...(owner.rtc ? { rtc: true } : {}) });
      starting = false;
      if (mediaOwner !== owner) return;
      owner.ready = true;
      send({ event: "media.started", ...result, mediaSession: owner.id, protocolVersion: 2, sampleRate: 24000,
        ...(owner.rtc ? { rtc: true } : {}) });
      if (owner.videoConfig) send(owner.videoConfig);
      native.request({ op: "mediaVideoCredit", count: 5 }).catch(() => stopMedia(owner, 4000, "Camera stopped"));
    } catch (error) {
      if (!starting && owner.streaming) return stopMedia(owner, 4008, "Invalid media command");
      owner.streaming = false;
      send({ event: "media.error", message: error.message });
    }
  });
  ws.on("close", () => { clearInterval(check); stopMedia(owner); });
  ws.on("error", () => {});
  // rtc: this Mac can carry the sound as a WebRTC call (host 44+).
  send({ event: "connected", protocolVersion: 2, rtc: true });
}
function acknowledge(pending, sequence, update) {
  if (!Number.isSafeInteger(sequence)) return 0;
  const sent = pending.get(sequence);
  if (sent === undefined) return 0;
  update(Date.now() - sent);
  let released = 0;
  for (const n of pending.keys()) if (n <= sequence) { pending.delete(n); released++; }
  return released;
}
function requestMediaKey(owner) {
  if (mediaOwner !== owner || !owner.streaming || owner.keyRequested) return;
  owner.keyRequested = true;
  native.request({ op: "mediaKeyframe" }).catch(() => {});
}
function mediaAudioClient(ws, owner) {
  owner.audio = ws;
  let lastSeen = Date.now();
  let packets = 0;
  const check = setInterval(() => {
    packets = 0;
    if (mediaOwner === owner && Date.now() - lastSeen > 12000)
      stopMedia(owner, 4000, "Audio connection timed out");
  }, 1000);
  ws.on("message", async (raw, binary) => {
    try {
      if (mediaOwner !== owner || owner.audio !== ws || !sessions.authorized(owner.token)) return;
      lastSeen = Date.now();
      if (!binary) {
        if (raw.length > 512) throw new Error("Invalid audio control.");
        const command = JSON.parse(raw);
        if (command.op === "ping") return ws.send(JSON.stringify({ event: "pong" }));
        if (command.op === "ack") {
          acknowledge(owner.audioPending, command.sequence, (ms) => { owner.stats.audioAckMs = ms; owner.stats.audioAckMaxMs = Math.max(owner.stats.audioAckMaxMs || 0, ms); });
          return;
        }
        throw new Error("Invalid audio control.");
      }
      if (raw.length !== 965 || raw[0] !== 4 || ++packets > 100)
        throw new Error("Invalid phone audio packet.");
      const sequence = raw.readUInt32BE(1);
      let accepted = false;
      const reply = () => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ event: "talk.ack", sequence, accepted }));
      };
      // Bytes already in flight when Stop is pressed are discarded.
      // Sent to the Mac's speaker at once, in order, without waiting for the
      // previous packet (25 September: waiting one at a time and dropping
      // anything 0.1 s old threw away a third of the phone's voice).
      if (!owner.talkReady || owner.audioQueued >= 15) {
        owner.stats.talkDropped++; reply(); return;
      }
      owner.audioQueued++;
      const data = raw.subarray(5).toString("base64");
      owner.audioWork = native.request({ op: "mediaTalkData", data }).then(() => {
        accepted = true;
        owner.stats.talkPackets++;
      }).catch((error) => {
        if (mediaOwner === owner && owner.talking) {
          owner.talking = false; owner.talkReady = false; owner.talkEpoch++;
          if (owner.ws.readyState === 1) owner.ws.send(JSON.stringify({ event: "media.talkError", message: error.message }));
          native.request({ op: "mediaTalkStop" }).catch(() => {});
        }
      }).finally(() => { owner.audioQueued--; reply(); });
    } catch { stopMedia(owner, 4008, "Invalid audio message"); }
  });
  ws.on("close", () => { clearInterval(check); if (owner.audio === ws) stopMedia(owner, 4000, "Audio disconnected"); });
  ws.on("error", () => {});
  ws.send(JSON.stringify({ event: "audio.connected", sampleRate: 24000, packetFrames: 480 }));
}
function forwardMedia(x) {
  const owner = mediaOwner;
  if (!owner?.streaming || owner.id !== x.mediaSession || !sessions.authorized(owner.token, false)) return;
  if (x.event === "mediaError") {
    if (owner.ws.readyState === 1) owner.ws.send(JSON.stringify({ event: "media.error", message: x.message }));
    stopMedia(owner, 4000, "Media capture failed"); return;
  }
  if (x.event === "mediaVideoConfig") {
    owner.videoConfig = { event: "media.videoConfig", codec: x.codec,
      description: x.description, width: x.width, height: x.height };
    if (owner.ready && owner.ws.readyState === 1) owner.ws.send(JSON.stringify(owner.videoConfig));
    return;
  }
  if (x.event === "mediaVideo") {
    if (!owner.ready || owner.ws.readyState !== 1) return;
    // Credit is consumed BEFORE native encoding. A slow phone skips raw
    // camera samples, preserving the H.264 reference chain without freezes.
    if (owner.videoPending.size >= 5) return stopMedia(owner, 4000, "Camera flow control failed");
    if (x.key) owner.keyRequested = false;
    const data = Buffer.from(x.data || "", "base64");
    if (data.length > 500000) return;
    const sequence = ++owner.videoSequence;
    const header = Buffer.alloc(14);
    header[0] = 2; header.writeUInt32BE(sequence, 1); header[5] = x.key ? 1 : 0;
    header.writeDoubleBE(x.timestamp, 6);
    owner.videoPending.set(sequence, Date.now());
    owner.ws.send(Buffer.concat([header, data]));
    owner.stats.videoFrames++; owner.stats.videoBytes += data.length;
    return;
  }
  if (x.event === "mediaAudio") {
    if (owner.audio?.readyState !== 1) return;
    // Up to half a second in flight: confirmations took 0.4 s on home Wi-Fi
    // (25 September), and every drop is a gap in the sound.
    if (owner.audioPending.size >= 25 || owner.audio.bufferedAmount > 24000) { owner.stats.audioDropped++; return; }
    const data = Buffer.from(x.data || "", "base64");
    if (data.length !== 960) return;
    const sequence = ++owner.audioSequence;
    const header = Buffer.alloc(5); header[0] = 3; header.writeUInt32BE(sequence, 1);
    owner.audioPending.set(sequence, Date.now());
    owner.audio.send(Buffer.concat([header, data]));
    owner.stats.audioPackets++; owner.stats.audioBytes += data.length;
  }
}

// ---- /events: many listeners, JSON messages, terminal I/O ----
function eventsClient(ws, s) {
  const client = {
    ws,
    token: s.token,
    topics: new Set(),
    send(message) {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    },
  };
  const remove = hub.add(client);
  let lastSeen = Date.now();
  const opened = Date.now();
  const check = setInterval(() => {
    if (!sessions.get(s.token)) ws.close(4001, "Session expired");
    else if (!sessions.authorized(s.token, false)) ws.close(4003, "Locked");
    else if (Date.now() - lastSeen > 45000) {
      log("events.silent", { device: s.name, seconds: Math.round((Date.now() - opened) / 1000) });
      ws.terminate();
    }
  }, 5000);
  ws.on("message", async (raw, binary) => {
    lastSeen = Date.now();
    sessions.authorized(s.token);
    let message;
    try {
      if (binary) throw new Error("Send JSON text.");
      message = JSON.parse(raw);
      if (!message || typeof message !== "object") throw new Error("Invalid message.");
      const reply = await handleEvent(client, message);
      if (message.requestId !== undefined) client.send({ event: "reply", requestId: message.requestId, result: reply ?? { ok: true } });
    } catch (error) {
      client.send({ event: "error", requestId: message?.requestId, message: error.message });
    }
  });
  ws.on("close", (code, reason) => {
    log("events.closed", { device: s.name, code, reason: String(reason || "").slice(0, 60), seconds: Math.round((Date.now() - opened) / 1000) });
    clearInterval(check);
    remove();
    terminals.detachAll(client);
  });
  ws.on("error", () => {});
  client.send({ event: "connected", ...protocol, screen: screen.state() });
}

async function handleEvent(client, message) {
  switch (message.op) {
    case "ping":
      return { event: "pong", at: typeof message.at === "string" ? message.at.slice(0, 80) : null };
    case "subscribe":
    case "unsubscribe": {
      const topics = Array.isArray(message.topics) ? message.topics : [message.topic];
      for (const topic of topics.slice(0, 32)) {
        if (typeof topic !== "string" || !/^(tasks|task:[\w-]{8,64}|terminals|dev|dev:[a-f0-9]{10}|files|system|screen|watch|assistant)$/.test(topic)) continue;
        if (message.op === "subscribe") client.topics.add(topic);
        else client.topics.delete(topic);
        if (message.op === "subscribe" && topic.startsWith("dev:")) {
          const id = topic.slice(4);
          client.devUnsub?.get(id)?.();
          const unsub = dev.subscribe(id, (lines) => client.send({ topic, event: "dev.logs", id, lines }));
          client.devUnsub = client.devUnsub || new Map();
          client.devUnsub.set(id, unsub);
        }
        if (message.op === "unsubscribe" && topic.startsWith("dev:")) client.devUnsub?.get(topic.slice(4))?.();
      }
      return { topics: [...client.topics] };
    }
    case "terminal.attach":
      return terminals.attach(client, String(message.id), { cols: message.cols, rows: message.rows });
    case "terminal.detach":
      terminals.detach(client, String(message.id));
      return { ok: true };
    case "terminal.input":
      terminals.input(String(message.id), message.data);
      return undefined;
    case "terminal.resize":
      terminals.resize(String(message.id), message.cols, message.rows);
      return undefined;
    case "terminal.signal":
      await terminals.signal(String(message.id), String(message.signal));
      return { ok: true };
    default:
      throw new Error("Unsupported event request.");
  }
}

// ---- /socket: the single live screen session (video + phone input) ----
function controlClient(ws, s, req) {
  // The same phone again, while its older connection still looks open here:
  // Palm left the screen and the old connection was cut without a goodbye
  // (E2E, 23 September: "Another screen session is still open (409)" for 15 s,
  // then a black screen). The new connection replaces it at once.
  if (controller && controller.token === s.token && ["native", "web"].includes(s.kind)) {
    log("screen.replaced", { device: s.name });
    replaceController(controller);
  }
  const owner = { ws, token: s.token, origin: req.headers.origin, active: true, streaming: false, flow: null };
  controller = owner;
  // Direct or through Tailscale's relay, for the log (24 September: "at
  // dinner it didn't work" left no record of which path the phone was on).
  const peer = peerAddress(req);
  if (peer)
    system.networkPath(peer).then((n) => {
      if (n?.path) log("screen.path", { device: s.name, via: n.path.via, ms: n.path.milliseconds });
    }).catch(() => {});
  controlEpoch++;
  streamConfig = null;
  dropping = false;
  let count = 0;
  let lastSeen = Date.now();
  const opened = Date.now();
  const limit = setInterval(() => {
    count = 0;
    if (!sessions.get(s.token)) stopController(owner, 4001, "Session expired");
    else if (!sessions.authorized(s.token, false)) stopController(owner, 4003, "Locked");
    const flow = owner.flow;
    if (flow && owner.streaming && controllerValid(owner)) {
      const bitrate = flow.tick();
      if (bitrate) native.request({ op: "screenBitrate", bitrate }).catch(() => {});
      // Nothing in flight: give the Mac its full room back, in case a frame
      // went missing between the encoder and here.
      if (!flow.pending.length && Date.now() - flow.lastSent > 1000)
        native.request({ op: "screenCredit", count: MAX_IN_FLIGHT, reset: true }).catch(() => {});
    }
    if (Date.now() - lastSeen > 15000) {
      log("screen.silent", { device: s.name, seconds: Math.round((Date.now() - opened) / 1000) });
      stopController(owner);
      ws.terminate();
    }
  }, 1000);
  ws.on("message", async (raw, binary) => {
    let requestId;
    try {
      lastSeen = Date.now();
      sessions.authorized(s.token);
      if (!controllerValid(owner)) return stopController(owner, 4001, "Session expired");
      if (++count > 240) {
        stopController(owner, 4008, "Too many commands");
        return;
      }
      if (binary) throw new Error("Send commands as JSON text.");
      const x = JSON.parse(raw);
      if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Invalid command.");
      // The phone confirms frames it received; bounded by the frames sent.
      if (x.op === "ack") {
        count--;
        const flow = owner.flow;
        const released = flow && owner.streaming ? flow.ack(x.n) : 0;
        if (released) native.request({ op: "screenCredit", count: Math.min(released, MAX_IN_FLIGHT) }).catch(() => {});
        return;
      }
      if ((typeof x.requestId === "string" && x.requestId.length <= 80) || Number.isSafeInteger(x.requestId)) requestId = x.requestId;
      else if (x.requestId !== undefined) throw new Error("Invalid request identifier.");
      if (x.op === "ping") {
        ws.send(
          JSON.stringify({
            event: "pong",
            at: Number.isFinite(x.at) || (typeof x.at === "string" && x.at.length <= 80) ? x.at : null,
          }),
        );
        return;
      }
      const cmd = validateCommand(x);
      const result = await commands.run(
        async () => {
          if ([...inputOps, "keyframe", "quality"].includes(cmd.op) && !owner.streaming)
            throw new Error("Start the live screen before sending input.");
          if (cmd.op === "start") {
            owner.streaming = true;
            owner.flow?.close();
            owner.flow = cmd.flow ? new ScreenFlow(s.token) : null;
            if (owner.flow) cmd.bitrate = owner.flow.bitrate;
          }
          if (cmd.op === "stop") owner.streaming = false;
          try {
            // Phone input goes through screen ownership; an agent holding the
            // screen blocks it until Take over.
            if (inputOps.includes(cmd.op)) return await screen.humanInput(cmd);
            const result = await native.request(cmd);
            // Tells the phone to confirm frames (an older Mac never says so).
            if (cmd.op === "start" && owner.flow && result && typeof result === "object") result.flow = true;
            return result;
          } catch (e) {
            if (cmd.op === "start") {
              owner.streaming = false;
              owner.flow = null;
            }
            throw e;
          }
        },
        () => controllerValid(owner),
      );
      if (controllerValid(owner)) ws.send(JSON.stringify({ event: "reply", requestId, result }));
    } catch (e) {
      if (controllerValid(owner)) ws.send(JSON.stringify({ event: "error", requestId, message: e.message }));
    }
  });
  ws.on("error", () => {});
  ws.on("close", (code) => {
    const flow = owner.flow;
    flow?.close();
    log("screen.closed", { device: s.name, code, seconds: Math.round((Date.now() - opened) / 1000),
      ...(flow ? { flow: flow.snapshot() } : {}) });
    clearInterval(limit);
    stopController(owner);
    // A replaced connection's phone is still here on its newer one.
    if (controller?.token !== owner.token || controller === owner) void screen.releaseHuman().catch(() => {});
  });
  ws.send(JSON.stringify({ event: "connected", ...protocol, screenOwner: screen.state() }));
}

native.on("event", (x) => {
  if (x.event === "quit") {
    shutdown();
    return;
  }
  if (x.event === "curtain") {
    hub.publish("system", { event: "system.updated", curtain: !!x.on });
    return;
  }
  if (x.event === "mediaStopped") {
    if (mediaOwner?.ws.readyState === 1) mediaOwner.ws.send(JSON.stringify({ event: "media.stopped" }));
    if (mediaOwner) stopMedia(mediaOwner);
    return;
  }
  if (["mediaVideo", "mediaVideoConfig", "mediaAudio", "mediaError"].includes(x.event)) {
    forwardMedia(x);
    return;
  }
  const owner = controller;
  if (!owner) return;
  if (!sessions.get(owner.token)) {
    stopController(owner, 4001, "Session expired");
    return;
  }
  if (!controllerValid(owner)) return;
  const ws = owner.ws;
  if (x.event === "stopped") owner.streaming = false;
  if (["config", "frame"].includes(x.event) && !owner.streaming) return;
  if (x.event === "config") {
    streamConfig = x;
    ws.send(JSON.stringify(x));
    return;
  }
  if (x.event === "frame") {
    // A frame dropped here was counted against the phone's room on the Mac.
    const refund = () => { if (owner.flow) native.request({ op: "screenCredit", count: 1 }).catch(() => {}); };
    if (ws.bufferedAmount > 512000) {
      dropping = true;
      refund();
      return;
    }
    if (dropping && !x.key) {
      refund();
      if (!keyframePending) {
        keyframePending = true;
        requestNative({ op: "keyframe" }, () => controllerValid(owner) && owner.streaming)
          .catch(() => {})
          .finally(() => {
            keyframePending = false;
          });
      }
      return;
    }
    if (dropping) {
      dropping = false;
      if (streamConfig) ws.send(JSON.stringify(streamConfig));
    }
    const payload = Buffer.from(x.data, "base64"),
      header = Buffer.alloc(9);
    header[0] = x.key ? 1 : 0;
    header.writeDoubleBE(x.timestamp, 1);
    ws.send(Buffer.concat([header, payload]));
    owner.flow?.sentFrame(payload.length);
    return;
  }
  if (x.event === "layoutDiagnostic") return;
  ws.send(JSON.stringify(x));
});

await gateway.start();
server.listen(port, "127.0.0.1", () => {
  log("start", { version: palmVersion, pid: process.pid });
  console.log(`Palm is ready at http://localhost:${port}${synthetic ? " (synthetic test host)" : ""}`);
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("stop", { pid: process.pid });
  if (controller) controller.active = false;
  for (const c of wss.clients) c.close();
  for (const c of eventsWss.clients) c.close();
  server.close();
  gateway.close();
  // Shells in the terminal service keep running for the next Palm.
  if (terminals instanceof TerminalService) terminals.disconnect();
  else terminals.closeAll();
  system.stop();
  const deadline = setTimeout(() => process.exit(1), 4000);
  Promise.allSettled([dev.stopAll(), broker.close(), screen.close()])
    .then(() => native.close())
    .finally(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
