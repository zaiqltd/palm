import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { mkdtemp, mkdir, writeFile, readFile, stat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { FsPolicy } from "../server/files/fs-api.mjs";
import { ScreenControl } from "../server/agents/screen-control.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (data) => createHash("sha256").update(data).digest("hex");

// One isolated synthetic host for the platform checks: its own state folder,
// inbox, ports and preview slot, the real companion in --synthetic mode and the
// real PTY helper. It never touches the installed Palm or the real desktop.
async function host() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "palm-platform-")));
  const inbox = path.join(directory, "inbox");
  await mkdir(inbox);
  const port = 53000 + (process.pid % 900);
  const slot = port + 1;
  const base = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PALM_PORT: String(port),
    PALM_STATE_DIR: path.join(directory, "state"),
    PALM_SYNTHETIC: "1",
    PALM_INBOX: inbox,
    PALM_ORIGIN: "https://palm-test.example.ts.net:8443",
    PALM_PREVIEW_SLOTS: `9444:${slot}`,
  };
  delete env.PALM_NATIVE_PATH;
  const child = spawn(process.execPath, ["server/index.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("start timeout " + stderr)), 15000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => reject(new Error("exited: " + stderr)));
  });
  const headers = (token, extra = {}) => ({ origin: base, authorization: `Bearer ${token}`, ...extra });
  const post = async (route, data, token) =>
    fetch(base + "/api/" + route, {
      method: "POST",
      headers: token ? headers(token, { "content-type": "application/json" }) : { origin: base, "content-type": "application/json" },
      body: JSON.stringify(data ?? {}),
    });
  const get = (route, token, extra) => fetch(base + "/api/" + route, { headers: headers(token, extra) });
  const code = await (await post("local/pair-code")).json();
  const pairing = await (await post("native/pair", { code: code.code, name: "Platform test" })).json();
  return {
    directory,
    inbox,
    base,
    port,
    slot,
    token: pairing.token,
    post: (route, data) => post(route, data, pairing.token),
    get: (route, extra) => get(route, pairing.token, extra),
    events() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace("http:", "ws:") + "/events", { headers: headers(pairing.token) });
        const messages = [];
        ws.on("message", (raw) => messages.push(JSON.parse(raw)));
        ws.once("open", () => resolve({ ws, messages }));
        ws.once("error", reject);
      });
    },
    async stop() {
      if (child.exitCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
    },
  };
}

async function until(predicate, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await predicate();
    if (value) return value;
    await pause(50);
  }
  throw new Error("Timed out waiting for expected state.");
}

test("filesystem policy blocks Palm state and the secondary account, gates credentials", () => {
  const home = os.homedir();
  const policy = new FsPolicy({ stateDir: "/tmp/palm-state" });
  assert.equal(policy.classify("/tmp/palm-state/native-devices.json"), "blocked");
  assert.equal(policy.classify(path.join(home, ".ssh/id_ed25519")), "sensitive");
  assert.equal(policy.classify(path.join(home, ".credentials")), "sensitive");
  assert.equal(policy.classify(path.join(home, "work/apps/palm/.git/config")), "allowed");
  assert.equal(policy.classify("/tmp/palm-stateful/file"), "allowed", "prefix match must respect folder boundaries");
});

test("screen ownership: phone input claims idle, agents need permission, takeover blocks them", async () => {
  const calls = [];
  const native = {
    request: async (command) => {
      calls.push(command.op);
      if (command.op === "release") return { quiescent: true, released: true };
      return { ok: true };
    },
  };
  const screen = new ScreenControl({ native, leaseMs: 5000 });
  try {
    await screen.humanInput({ op: "pointer", action: "click", x: 0.5, y: 0.5 });
    assert.equal(screen.state().owner.kind, "human");
    await assert.rejects(screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 }), /off for this task/);
    screen.allow("task-a", true);
    await assert.rejects(screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 }), /user is controlling/);
    await screen.handBack();
    assert.equal(screen.state().phase, "idle");
    await screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 });
    assert.deepEqual(screen.state().owner, { kind: "agent", taskId: "task-a" });
    await assert.rejects(screen.humanInput({ op: "pointer", action: "click", x: 0.1, y: 0.1 }), /Take over/);
    const taken = await screen.takeOver();
    assert.equal(taken.from, "task-a");
    assert.ok(calls.includes("release"), "takeover must run the native release barrier");
    await assert.rejects(screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 }), /taken control/);
    await screen.humanInput({ op: "pointer", action: "click", x: 0.2, y: 0.2 });
    await screen.handBack();
    assert.deepEqual(screen.state().owner, { kind: "agent", taskId: "task-a" });
    // An ordinary native rejection does not fault the authority.
    native.request = async (command) => (command.op === "release" ? { quiescent: true, released: true } : Promise.reject(new Error("That window moved.")));
    await assert.rejects(screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 }), /window moved/);
    assert.notEqual(screen.authority.snapshot().phase, "faulted");
  } finally {
    await screen.close();
  }
});

test("closing the phone's screen frees it for an agent at once; a take-over stays held", async () => {
  const native = { request: async (command) => (command.op === "release" ? { quiescent: true, released: true } : { ok: true }) };
  const screen = new ScreenControl({ native, leaseMs: 20000 });
  try {
    screen.allow("task-a", true);
    await screen.humanInput({ op: "key", key: "a" });
    await assert.rejects(screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 }), /user is controlling/);
    await screen.releaseHuman();
    await screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 });
    assert.deepEqual(screen.state().owner, { kind: "agent", taskId: "task-a" }, "no 20-second wait after the screen closed");
    await screen.takeOver();
    await screen.releaseHuman();
    assert.equal(screen.state().held, true, "Take over lasts until Hand back, even with the screen closed");
    await assert.rejects(screen.agentInput("task-a", { op: "agentInput", action: "click", x: 1, y: 1 }), /taken control/);
  } finally {
    await screen.close();
  }
});

test("platform host: files, uploads, terminals, dev previews, clipboard and system", async (t) => {
  const h = await host();
  t.after(() => h.stop());

  await t.test("camera and mic permission checks do not start capture", async () => {
    const state = await fetch(`${h.base}/api/local/media-permissions`, { headers: { origin: h.base } });
    assert.equal(state.status, 200);
    const permissions = await state.json();
    assert.equal(permissions.camera, "authorized");
    assert.equal(permissions.microphone, "authorized");
    assert.equal(permissions.cameraUsageDescription, true);
    assert.equal(permissions.microphoneUsageDescription, true);
    for (const kind of ["camera", "microphone"]) {
      const response = await h.post("local/permissions", { kind });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { state: "authorized", kind });
    }
    const diagnosis = await fetch(`${h.base}/api/local/diagnostics`, { headers: { origin: h.base } });
    assert.equal((await diagnosis.json()).controller, false);
  });

  await t.test("full filesystem listing, verified upload, range download, rename/copy/move", async () => {
    const work = path.join(h.directory, "project");
    await mkdir(work);
    await writeFile(path.join(work, ".env.local"), "HIDDEN=1\n");
    let listing = await (await h.get(`fs/list?path=${encodeURIComponent(work)}`)).json();
    assert.equal(listing.items.length, 0);
    assert.equal(listing.hiddenCount, 1);
    listing = await (await h.get(`fs/list?path=${encodeURIComponent(work)}&hidden=1`)).json();
    assert.equal(listing.items[0].name, ".env.local");

    const photo = Buffer.alloc(300000, 7);
    photo.write("PALM-PHOTO", 1000);
    const upload = await fetch(
      `${h.base}/api/fs/upload?dir=${encodeURIComponent(work)}&name=${encodeURIComponent("IMG 0001.jpg")}&sha256=${sha(photo)}&size=${photo.length}`,
      { method: "PUT", headers: { origin: h.base, authorization: `Bearer ${h.token}` }, body: photo },
    );
    assert.equal(upload.status, 200, await upload.clone().text());
    const uploaded = await upload.json();
    assert.equal(uploaded.verified, true);
    assert.equal(uploaded.sha256, sha(photo));
    assert.deepEqual(await readFile(path.join(work, "IMG 0001.jpg")), photo);

    const damaged = await fetch(
      `${h.base}/api/fs/upload?dir=${encodeURIComponent(work)}&name=bad.bin&sha256=${"0".repeat(64)}`,
      { method: "PUT", headers: { origin: h.base, authorization: `Bearer ${h.token}` }, body: Buffer.from("hello") },
    );
    assert.equal(damaged.status, 400);
    assert.match((await damaged.json()).error, /checksum/);
    await assert.rejects(stat(path.join(work, "bad.bin")));
    listing = await (await h.get(`fs/list?path=${encodeURIComponent(work)}&hidden=1`)).json();
    assert.ok(!listing.items.some((i) => i.name.includes(".palm-upload")), "no partial upload left behind");

    const again = await fetch(`${h.base}/api/fs/upload?dir=${encodeURIComponent(work)}&name=${encodeURIComponent("IMG 0001.jpg")}`, {
      method: "PUT",
      headers: { origin: h.base, authorization: `Bearer ${h.token}` },
      body: Buffer.from("second"),
    });
    assert.equal((await again.json()).name, "IMG 0001 2.jpg", "conflicts are renamed, never overwritten silently");

    const file = path.join(work, "IMG 0001.jpg");
    const ranged = await h.get(`fs/download?path=${encodeURIComponent(file)}`, { range: "bytes=1000-1009" });
    assert.equal(ranged.status, 206);
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), "PALM-PHOTO");
    const hash = await (await h.get(`fs/hash?path=${encodeURIComponent(file)}`)).json();
    assert.equal(hash.sha256, sha(photo));

    const folder = await (await h.post("fs/mkdir", { path: work, name: "public" })).json();
    assert.equal(folder.kind, "folder");
    const copied = await (await h.post("fs/copy", { paths: [file], to: folder.path })).json();
    assert.equal(copied.items[0].to, path.join(folder.path, "IMG 0001.jpg"));
    const renamed = await (await h.post("fs/rename", { path: copied.items[0].to, name: "hero.jpg" })).json();
    assert.equal(renamed.name, "hero.jpg");
    const moved = await (await h.post("fs/move", { paths: [path.join(work, "IMG 0001 2.jpg")], to: folder.path })).json();
    assert.equal(path.dirname(moved.items[0].to), folder.path);

    const blocked = await h.get(`fs/list?path=${encodeURIComponent(path.join(h.directory, "state"))}`);
    assert.equal(blocked.status, 403);
    const places = await (await h.get("fs/places")).json();
    assert.ok(places.places.some((p) => p.name === "Home"));
  });

  await t.test("terminal session: snapshot, live output, resize, control keys, reattach", async () => {
    const created = await (await h.post("terminals", { cwd: h.directory, cols: 80, rows: 24 })).json();
    assert.equal(created.running, true);
    const { ws, messages } = await h.events();
    ws.send(JSON.stringify({ op: "terminal.attach", id: created.id, cols: 90, rows: 30, requestId: 1 }));
    await until(() => messages.find((m) => m.event === "terminal.snapshot"));
    await pause(1200);
    ws.send(JSON.stringify({ op: "terminal.input", id: created.id, data: "stty size; echo PALM_$((40+2))\r" }));
    const output = () => messages.filter((m) => m.event === "terminal.output").map((m) => m.data).join("");
    await until(() => /PALM_42/.test(output()) && /30 90/.test(output()));
    ws.send(JSON.stringify({ op: "terminal.input", id: created.id, data: "sleep 20\r" }));
    await pause(300);
    ws.send(JSON.stringify({ op: "terminal.input", id: created.id, data: "\x03" }));
    ws.send(JSON.stringify({ op: "terminal.input", id: created.id, data: "echo AFTER_CTRL_C\r" }));
    await until(() => /AFTER_CTRL_C\r?\n/.test(output()));
    ws.close();
    const second = await h.events();
    second.ws.send(JSON.stringify({ op: "terminal.attach", id: created.id, cols: 90, rows: 30 }));
    const snapshot = await until(() => second.messages.find((m) => m.event === "terminal.snapshot"));
    assert.match(snapshot.data, /AFTER_CTRL_C/, "a reconnecting phone sees the session's existing screen");
    second.ws.close();
    assert.equal((await h.post(`terminals/${created.id}/close`)).status, 200);
  });

  await t.test("dev server: start, port discovery, logs, authenticated preview with WebSocket", async () => {
    const app = path.join(h.directory, "webapp");
    await mkdir(app);
    await writeFile(
      path.join(app, "server.mjs"),
      `import http from 'node:http';
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://localhost:' + server.address().port + '/landed' }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>Palm preview fixture</h1><p>host=' + req.headers.host + ' cookie=' + (req.headers.cookie || '') + ' ts=' + (req.headers['tailscale-user-login'] || '') + '</p>');
});
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
  socket.on('data', (d) => socket.write(d));
});
server.listen(0, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));
`,
    );
    const started = await (await h.post("dev", { cwd: app, command: `"${process.execPath}" server.mjs` })).json();
    const running = await until(async () => {
      const state = await (await h.get("dev")).json();
      return state.servers.find((s) => s.id === started.id && s.port);
    });
    const logs = await (await h.get(`dev/${started.id}/logs`)).json();
    assert.ok(logs.lines.some((l) => l.text.includes("Local:")));
    const preview = await (await h.post("dev/preview", { devId: started.id })).json();
    assert.match(preview.url, /^https:\/\/palm-test\.example\.ts\.net:9444\/__palm\/enter\?ticket=/);
    const ticket = new URL(preview.url).searchParams.get("ticket");
    const local = `http://127.0.0.1:${h.slot}`;
    const denied = await fetch(local + "/");
    assert.equal(denied.status, 401);
    const enter = await fetch(`${local}/__palm/enter?ticket=${ticket}`, { redirect: "manual" });
    assert.equal(enter.status, 302);
    const cookie = enter.headers.get("set-cookie").split(";")[0];
    assert.match(enter.headers.get("set-cookie"), /HttpOnly; Secure/);
    const reused = await fetch(`${local}/__palm/enter?ticket=${ticket}`, { redirect: "manual" });
    assert.equal(reused.status, 401, "tickets are single use");
    const page = await fetch(local + "/", { headers: { cookie, "tailscale-user-login": "someone@example.com" } });
    const text = await page.text();
    assert.match(text, /Palm preview fixture/);
    assert.match(text, new RegExp(`host=localhost:${running.port}`), "dev servers see a localhost Host header");
    assert.doesNotMatch(text, /palm_preview=/, "Palm's cookie is not forwarded to the app");
    assert.doesNotMatch(text, /someone@example\.com/, "tailnet identity headers are not forwarded");
    const redirect = await fetch(local + "/redirect", { headers: { cookie }, redirect: "manual" });
    assert.equal(redirect.headers.get("location"), "https://palm-test.example.ts.net:9444/landed");
    const echoed = await new Promise((resolve, reject) => {
      const socket = net.connect(h.slot, "127.0.0.1", () => {
        socket.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookie}\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (d) => {
        data += d;
        if (data.includes("101 Switching")) {
          if (!data.includes("hot-reload")) socket.write("hot-reload");
          if (data.includes("hot-reload")) {
            socket.destroy();
            resolve(data);
          }
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("upgrade timeout " + data)), 4000);
    });
    assert.match(echoed, /hot-reload/);
    const stopped = await (await h.post(`dev/${started.id}/stop`)).json();
    assert.notEqual(stopped.status, "running");
  });

  await t.test("clipboard, system state and agent providers", async () => {
    const clip = await (await h.get("clipboard")).json();
    assert.deepEqual(clip.kinds, ["text"]);
    assert.equal((await h.post("clipboard", { text: "from the phone" })).status, 200);
    const system = await (await h.get("system")).json();
    assert.ok(system.capabilities.some((c) => c.id === "coldStart" && c.state === "unavailable"));
    assert.ok(["ac", "battery", "unknown"].includes(system.power.source));
    const bright = await (await h.post("system/action", { action: "brightness", value: 0.4 })).json();
    assert.ok(Math.abs(bright.brightness - 0.4) < 0.001);
    const refused = await h.post("system/action", { action: "shutdown" });
    assert.equal(refused.status, 400, "power actions need an explicit confirmation");
    const providers = await (await h.get("agents/providers")).json();
    assert.deepEqual(providers.providers.map((p) => p.id), ["claude", "codex", "grok"]);
    const tool = await fetch(`${h.base}/api/agent-tools/call`, {
      method: "POST",
      headers: { origin: h.base, "content-type": "application/json", authorization: "Palm-Agent " + "x".repeat(32) },
      body: JSON.stringify({ tool: "screenshot" }),
    });
    assert.equal(tool.status, 401, "unknown agent tokens are refused");
  });
});

test("test host system control never touches the real Mac", async () => {
  const { SystemControl } = await import("../server/system/system.mjs");
  const requests = [];
  const native = { request: async (command) => (requests.push(command.op), { ok: true, synthetic: true }) };
  const system = new SystemControl({ native, synthetic: true });
  assert.equal((await system.power()).source, "ac", "sample power data");
  assert.equal((await system.networkPath()).path.direct, true, "sample network path");
  assert.equal((await system.action("displaySleep")).synthetic, true);
  assert.equal((await system.action("sleep", { confirm: true })).synthetic, true);
  assert.equal((await system.action("repairNetwork")).synthetic, true);
  assert.deepEqual(await system.action("keepAwake", { on: true }), { on: true });
  assert.equal(system.keepAwake.child, null, "no caffeinate process on the test host");
  await system.action("keepAwake", { on: false });
  await assert.rejects(system.action("sleep"), /Confirm/, "sleep still needs confirmation");
  assert.deepEqual(requests, [], "no companion call was needed for these");
});

test("scripted test agents stream, ask, obey Stop and start in the home folder", async () => {
  const { AgentBroker } = await import("../server/agents/broker.mjs");
  const { EventHub } = await import("../server/platform/events.mjs");
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-scripted-"));
  const hub = new EventHub();
  const screen = { allow() {}, ownerTask: () => null, releaseAgent: async () => {}, state: () => ({}) };
  const broker = new AgentBroker({ stateDir, hub, screen, native: null, system: null, mcpScript: "", apiOrigin: "", scripted: true });
  await broker.open();
  const providers = await broker.providers();
  assert.deepEqual(providers.map((p) => p.id), ["claude", "codex", "grok"]);
  const task = await broker.create({ provider: "claude", text: "Say hello" });
  assert.equal(task.cwd, os.homedir(), "no folder means the home folder");
  const settle = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return true;
      await pause(50);
    }
    return false;
  };
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "idle"), "the reply completes");
  const events = await broker.log(task.id).readAll();
  assert.ok(events.some((e) => e.type === "assistant" && e.text.includes("Test agent reply")));
  assert.ok(events.some((e) => e.type === "tool" && e.status === "completed"));

  await broker.send(task.id, { text: "please approve" });
  assert.ok(await settle(() => broker.tasks.get(task.id).pendingApprovals.length === 1), "an approval is pending");
  broker.answer(task.id, broker.tasks.get(task.id).pendingApprovals[0], "allow");
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "idle"));

  await broker.send(task.id, { text: "slow please" });
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "running"));
  await broker.stop(task.id);
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "stopped"), "Stop ends the turn");

  // Removing a chat that is still working stops it, takes it off the list and
  // keeps its log on the Mac.
  const busy = await broker.create({ provider: "claude", text: "slow chat to remove" });
  assert.ok(await settle(() => broker.tasks.get(busy.id).status === "running"));
  const removed = await broker.archive(busy.id, true);
  assert.equal(removed.archived, true);
  assert.equal(broker.running.has(busy.id), false, "the removed chat stopped working");
  assert.ok(!broker.list().some((t) => t.id === busy.id), "it left the list");
  assert.ok(broker.list({ archived: true }).some((t) => t.id === busy.id), "it is kept, archived");
  await broker.log(busy.id).writes;
  assert.ok((await broker.log(busy.id).readAll()).length > 0, "its log stays on the Mac");
  await pause(600);
  assert.equal(broker.tasks.get(busy.id).status, "stopped", "no late output restarts it");
  await broker.save();
});

test("a screen handed back during an agent's turn reaches the agent when that turn ends", async () => {
  // E2E, 23 September: Codex looked while the phone held the screen, then
  // ended its turn "waiting for the handback" that had already happened.
  const { AgentBroker } = await import("../server/agents/broker.mjs");
  const { EventHub } = await import("../server/platform/events.mjs");
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-handback-"));
  const screen = { allow() {}, ownerTask: () => null, releaseAgent: async () => {}, state: () => ({}) };
  const broker = new AgentBroker({ stateDir, hub: new EventHub(), screen, native: null, system: null, mcpScript: "", apiOrigin: "", scripted: true });
  await broker.open();
  const settle = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return true;
      await pause(50);
    }
    return false;
  };
  const said = async (id) => (await broker.log(id).readAll()).filter((e) => e.type === "user").map((e) => e.text);
  const task = await broker.create({ provider: "codex", text: "Look at the screen" });
  assert.ok(await settle(() => broker.running.has(task.id)), "its turn is running");
  await broker.screenHandedBack(task.id, "The screen is yours again.");
  assert.deepEqual(await said(task.id), ["Look at the screen"], "nothing is sent into a running turn");
  assert.ok(await settle(async () => (await said(task.id)).includes("The screen is yours again.")), "sent when the turn ends");
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "idle"));

  // Between turns it is sent at once; a stopped turn is not resumed.
  await broker.screenHandedBack(task.id, "Carry on.");
  assert.ok((await said(task.id)).includes("Carry on."));
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "idle"));
  await broker.send(task.id, { text: "slow work" });
  assert.ok(await settle(() => broker.running.has(task.id)));
  await broker.screenHandedBack(task.id, "Not after a Stop.");
  await broker.stop(task.id);
  assert.ok(await settle(() => broker.tasks.get(task.id).status === "stopped"));
  await pause(300);
  assert.equal((await said(task.id)).includes("Not after a Stop."), false);
  await broker.save();
});

test("sleep timer: scheduled, cancelled, restored after a restart, never acted on late", async () => {
  const { SystemControl } = await import("../server/system/system.mjs");
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-sleep-"));
  const native = { request: async () => ({ ok: true, synthetic: true }) };
  const system = new SystemControl({ native, synthetic: true, stateDir });
  await assert.rejects(system.action("sleepIn", { minutes: 30 }), /Confirm/, "a sleep timer needs confirmation");
  await assert.rejects(system.action("sleepIn", { minutes: 0, confirm: true }), /between/);
  const set = await system.action("sleepIn", { minutes: 60, confirm: true });
  const due = new Date(set.sleepAt).getTime() - Date.now();
  assert.ok(due > 59 * 60000 && due <= 60 * 60000, "due in an hour");
  assert.equal((await system.status()).sleepAt, set.sleepAt);

  // Palm restarts: the timer comes back from the state folder.
  system.stop();
  const again = new SystemControl({ native, synthetic: true, stateDir });
  await again.restoreSleep();
  assert.equal(again.sleepTimer?.at, set.sleepAt);
  assert.match((await again.action("cancelSleep")).detail, /cancelled/);
  assert.equal((await again.status()).sleepAt, null);

  // A time that passed while Palm was not running is dropped, not acted on.
  await writeFile(path.join(stateDir, "sleep-timer.json"), JSON.stringify({ at: new Date(Date.now() - 1000).toISOString() }));
  const late = new SystemControl({ native, synthetic: true, stateDir });
  await late.restoreSleep();
  assert.equal(late.sleepTimer, null);
  again.stop();
  late.stop();
});

test("keyboard light: level and automatic setting pass to the companion, out-of-range refused", async () => {
  const { SystemControl } = await import("../server/system/system.mjs");
  const sent = [];
  const native = { request: async (command) => (sent.push(command), { level: command.level ?? 0.5, auto: command.auto ?? true }) };
  const system = new SystemControl({ native, synthetic: true });
  await system.action("keyboardLight", { value: 0.25 });
  await system.action("keyboardLight", { auto: false });
  await assert.rejects(system.action("keyboardLight", { value: 2 }), /between 0 and 1/);
  assert.deepEqual(sent, [
    { op: "keyboardLight", level: 0.25 },
    { op: "keyboardLight", auto: false },
  ]);
});

test("the relay-only Tailscale fault is repaired by itself, not repeatedly", async () => {
  const { SystemControl } = await import("../server/system/system.mjs");
  // Not the test host (which never restarts anything), but every reading and
  // the restart itself are stand-ins: nothing reaches this Mac's network.
  const system = new SystemControl({ native: null });
  const broken = ["The MagicSock function ReceiveIPv4 is not running. You might experience connectivity issues."];
  let health = [];
  const repairs = [];
  const logged = [];
  const check = system.watchNetwork({
    everyMs: 3_600_000, readStatus: async () => ({ state: "Running", health }), repair: async () => repairs.push(Date.now()),
    log: (kind) => logged.push(kind),
  });
  try {
    await check();
    health = broken;
    await check();
    assert.equal(repairs.length, 0, "one sighting could be a blip");
    await check();
    assert.equal(repairs.length, 1, "seen twice in a row: reconnected");
    await check();
    await check();
    assert.equal(repairs.length, 1, "not again within ten minutes");
    health = [];
    await check();
    assert.deepEqual(logged, ["network.relayOnly", "network.repair", "network.relayOnly"]);
  } finally {
    clearInterval(system.networkWatch);
  }
});

test("the network repair waits for an awake Mac and never leaves Tailscale off", async () => {
  // 24 September: a repair during a sleeping Mac's brief wake-up at 02:43
  // left Tailscale stopped all morning.
  const { SystemControl } = await import("../server/system/system.mjs");
  const system = new SystemControl({ native: null });
  const broken = ["The MagicSock function ReceiveIPv4 is not running. You might experience connectivity issues."];
  const minute = 60_000;
  let clock = 0;
  let status = { state: "Running", health: broken };
  const repairs = [];
  const restarts = [];
  const logged = [];
  const check = system.watchNetwork({
    everyMs: minute, now: () => clock, readStatus: async () => status, log: (kind) => logged.push(kind),
    repair: async () => repairs.push(clock), restart: async () => (restarts.push(clock), { ok: true }),
  });
  try {
    await check();
    clock += 18 * minute; // the Mac slept in between
    await check();
    assert.equal(repairs.length, 0, "two sightings either side of a sleep are not two in a row");
    clock += minute;
    await check();
    assert.equal(repairs.length, 1, "a minute apart with the Mac awake: repaired");

    // The repair's restart did not take: Tailscale is switched back on, once.
    status = { state: "Stopped", health: ["Tailscale is stopped."] };
    clock += minute;
    await check();
    assert.equal(restarts.length, 1);
    clock += minute;
    await check();
    assert.equal(restarts.length, 1, "switched on once, not over and over");
    assert.ok(logged.includes("network.restart"));

    // Seen running after a repair, a later stop is the user's and is left alone.
    status = { state: "Running", health: [] };
    system.lastRepair = { at: clock };
    clock += minute;
    await check();
    status = { state: "Stopped", health: ["Tailscale is stopped."] };
    clock += minute;
    await check();
    assert.equal(restarts.length, 1, "Tailscale switched off by its user stays off");
  } finally {
    clearInterval(system.networkWatch);
  }
});
