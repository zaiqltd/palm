#!/usr/bin/env node
// Live checks against the installed Palm on this Mac, through its private
// Tailscale address, with a temporary pairing that is always revoked.
//
//   node scripts/verify-live.mjs [--agent[=grok]] [--restart]
//
// Checks status, files, clipboard kinds, a dev server with its private preview
// and hot reload, a terminal round trip, and optionally:
//   --restart  Palm restarts the way an update does (its runtime is stopped and
//              reopened) and an open shell must survive it
//   --agent    one short real agent turn with Claude Code, or --agent=<id> for
//              another installed agent (each uses its own sign-in on the Mac)
// No phone input, no power actions, no screen input. Never prints clipboard or
// file contents. Writes docs/evidence/platform-live-verification.json.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = "http://localhost:4318";
const demo = path.join(root, "demo/phone-preview");
const installed = path.join(os.homedir(), "Applications/Palm.app");
const flags = new Set(process.argv.slice(2).map((a) => a.split("=")[0]));
const agentId = process.argv.find((a) => a.startsWith("--agent="))?.split("=")[1] || "claude";
const report = { checkedAt: new Date().toISOString() };
let token, devId, remote, terminalId;

const call = async (base, route, body, extra = {}) => {
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: base,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} → ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
};
const api = (route, body) => call(remote, route, body);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function events() {
  const socket = new WebSocket(remote.replace("https:", "wss:") + "/events", {
    headers: { origin: remote, authorization: "Bearer " + token },
  });
  const seen = [];
  socket.on("message", (raw) => seen.push(JSON.parse(raw)));
  return { socket, seen, open: new Promise((r, j) => (socket.once("open", r), socket.once("error", j))) };
}

async function terminalOutput(seen, pattern, ms = 4000) {
  for (let i = 0; i < ms / 20; i++) {
    if (seen.some((m) => (m.event === "terminal.output" || m.event === "terminal.snapshot") && pattern.test(m.data || ""))) return true;
    await wait(20);
  }
  return false;
}

try {
  const setup = await call(local, "/api/local/setup");
  if (setup.status?.synthetic) throw new Error("Port 4318 is a test host.");
  remote = setup.remoteOrigin;
  if (!remote) throw new Error("Palm has no private Tailscale address configured.");
  report.via = remote;
  const code = await call(local, "/api/local/pair-code", {});
  ({ token } = await call(local, "/api/native/pair", { code: code.code, name: "Temporary live verification" }));

  const t0 = performance.now();
  const status = await api("/api/status");
  report.status = {
    ms: Math.round(performance.now() - t0),
    serverVersion: status.serverVersion,
    screenPermission: status.screenPermission,
    controlPermission: status.controlPermission,
    homeReported: status.home === os.homedir(),
  };
  const system = await api("/api/system");
  report.system = {
    direct: system.network?.path?.direct ?? null,
    pathMs: system.network?.path?.milliseconds ?? null,
    power: system.power?.source,
    loginItem: system.loginItem?.status ?? null,
    capabilities: system.capabilities?.map((c) => `${c.id}:${c.state}`),
  };
  const places = await api("/api/fs/places");
  report.files = { places: places.places.map((p) => p.name), inboxInHome: places.inbox.startsWith(os.homedir()) };
  report.clipboardKinds = (await api("/api/clipboard")).kinds;

  // Dev server, private preview and hot reload through Tailscale.
  const started = await api("/api/dev", { cwd: demo, script: "dev" });
  devId = started.id;
  let server;
  for (let i = 0; i < 60 && !server?.port; i++) {
    await wait(500);
    server = (await api("/api/dev")).servers.find((s) => s.id === devId);
  }
  const ticket = await api("/api/dev/preview", { devId });
  const enter = await fetch(ticket.url, { redirect: "manual" });
  const cookie = enter.headers.get("set-cookie")?.split(";")[0];
  const page = await fetch(ticket.origin + "/", { headers: { cookie } }).then((r) => r.text());
  const client = await fetch(ticket.origin + "/@vite/client", { headers: { cookie } }).then((r) => r.text());
  const wsToken = /const wsToken = "([^"]+)"/.exec(client)?.[1];
  report.preview = {
    devPort: server?.port ?? null,
    enterStatus: enter.status,
    cookieSet: !!cookie,
    pageHasViteClient: page.includes("/@vite/client"),
    unauthenticatedStatus: (await fetch(ticket.origin + "/")).status,
  };
  report.hotReload = await new Promise((resolve) => {
    const url = ticket.origin.replace("https:", "wss:") + "/?token=" + encodeURIComponent(wsToken || "");
    const ws = new WebSocket(url, "vite-hmr", { headers: { cookie, origin: ticket.origin } });
    const result = { connected: false };
    let editedAt = 0;
    const timer = setTimeout(() => (ws.terminate(), resolve({ ...result, timeout: true })), 15000);
    ws.on("message", async (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "connected" && !result.connected) {
        result.connected = true;
        await fetch(ticket.origin + "/src/main.js", { headers: { cookie } });
        await fetch(ticket.origin + "/src/style.css", { headers: { cookie } });
        await wait(300);
        const file = demo + "/src/main.js";
        const original = await readFile(file, "utf8");
        editedAt = performance.now();
        await writeFile(file, original + "\n// hmr check\n");
        setTimeout(() => writeFile(file, original), 1500);
      } else if (m.type === "update" || m.type === "full-reload") {
        result.updateType = m.type;
        result.editToMessageMs = Math.round(performance.now() - editedAt);
        clearTimeout(timer);
        setTimeout(() => (ws.close(), resolve(result)), 1700);
      }
    });
    ws.on("error", (e) => (result.error = e.message));
  });
  await api(`/api/dev/${devId}/stop`, {});
  devId = null;

  // Terminal round trip over /events; the shell opens in the home folder.
  const term = await api("/api/terminals", { cols: 80, rows: 24 });
  terminalId = term.id;
  let live = events();
  await live.open;
  live.socket.send(JSON.stringify({ op: "terminal.attach", id: term.id, cols: 80, rows: 24 }));
  await wait(1500);
  const sentAt = performance.now();
  live.socket.send(JSON.stringify({ op: "terminal.input", id: term.id, data: "echo PALM_LIVE_$((20+22)) in $PWD\r" }));
  const echoed = await terminalOutput(live.seen, /PALM_LIVE_42/);
  report.terminal = {
    startsInHome: term.cwd === os.homedir(),
    snapshot: live.seen.some((m) => m.event === "terminal.snapshot"),
    commandOutputMs: echoed ? Math.round(performance.now() - sentAt) : null,
  };
  live.socket.close();

  if (flags.has("--restart")) {
    // Stop Palm's runtime the way an update does, then reopen the app.
    const before = (await api("/api/terminals")).terminals.find((t) => t.id === term.id);
    const pid = Number(execFileSync("/usr/sbin/lsof", ["-nP", "-tiTCP:4318", "-sTCP:LISTEN"], { encoding: "utf8" }).trim());
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (!command.includes(installed + "/Contents/MacOS/node")) throw new Error("Port 4318 is not the installed Palm.");
    const restartedAt = performance.now();
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 60; i++) {
      await wait(100);
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
    }
    execFileSync("/usr/bin/open", [installed, "--args", "--quiet"]);
    let back = false;
    for (let i = 0; i < 80 && !back; i++) {
      await wait(250);
      back = await fetch(local + "/api/session", { headers: { Origin: local } }).then((r) => r.ok, () => false);
    }
    const after = (await api("/api/terminals")).terminals.find((t) => t.id === term.id);
    live = events();
    await live.open;
    live.socket.send(JSON.stringify({ op: "terminal.attach", id: term.id, cols: 80, rows: 24 }));
    const screenKept = await terminalOutput(live.seen, /PALM_LIVE_42/);
    live.socket.send(JSON.stringify({ op: "terminal.input", id: term.id, data: "echo PALM_AFTER_$((40+2))\r" }));
    const stillTyping = await terminalOutput(live.seen, /PALM_AFTER_42/);
    report.restart = {
      palmBackMs: back ? Math.round(performance.now() - restartedAt) : null,
      shellRunningBefore: before?.running ?? false,
      shellRunningAfter: after?.running ?? false,
      screenKept,
      stillTyping,
    };
    live.socket.close();
  }
  await api(`/api/terminals/${term.id}/close`, {});
  terminalId = null;

  if (flags.has("--controls")) {
    // Keyboard light: read it, then set the level it already has (no visible
    // change). Sleep timer: set for three hours and cancel at once.
    const display = (await api("/api/system")).display || {};
    const keyboard = display.keyboardLight || null;
    report.controls = { keyboardLightRead: keyboard };
    if (keyboard) {
      const set = await api("/api/system/action", { action: "keyboardLight", value: keyboard.level });
      report.controls.keyboardLightSetSame = { level: set.level, auto: set.auto };
    }
    const timer = await api("/api/system/action", { action: "sleepIn", minutes: 180, confirm: true });
    const cancelled = await api("/api/system/action", { action: "cancelSleep" });
    const after = (await api("/api/system")).sleepAt ?? null;
    report.controls.sleepTimer = { scheduledFor: timer.sleepAt, cancelled: /cancelled/.test(cancelled.detail || ""), timerAfter: after };
  }

  if (flags.has("--agent")) {
    // One short real turn; no folder given, so it runs in the home folder.
    const task = await api("/api/tasks", { provider: agentId, access: "ask", text: "Palm live check: reply with just the word ready. Do not use any tools." });
    const agentStart = performance.now();
    let done;
    for (let i = 0; i < 120 && !done; i++) {
      await wait(1000);
      const detail = await api("/api/tasks/" + task.id);
      done = detail.events.find((e) => e.type === "turn" && e.status !== "started");
      if (done)
        report.agent = {
          agent: agentId,
          status: done.status,
          error: done.error,
          seconds: Math.round((performance.now() - agentStart) / 1000),
          ranInHome: detail.task.cwd === os.homedir(),
          replied: detail.events.some((e) => e.type === "assistant" && /ready/i.test(e.text || "")),
        };
    }
    if (!done) report.agent = { status: "timeout" };
    await api(`/api/tasks/${task.id}/archive`, { archived: true }).catch(() => {});
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
} finally {
  if (devId) await api(`/api/dev/${devId}/stop`, {}).catch(() => {});
  if (terminalId) await api(`/api/terminals/${terminalId}/close`, {}).catch(() => {});
  if (token) await call(remote || local, "/api/disconnect", {}).catch((e) => (report.revokeError = e.message));
  token = null;
  report.devicesAfter = await call(local, "/api/local/setup").then((s) => s.devices.map((d) => d.name), () => null);
  await writeFile(path.join(root, "docs/evidence/platform-live-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
