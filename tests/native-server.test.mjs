import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function harness() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "palm-native-integration-"),
  );
  const fixture = path.join(directory, "companion.mjs");
  const log = path.join(directory, "operations.jsonl");
  await writeFile(
    fixture,
    `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const output=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',async(line)=>{
 const x=JSON.parse(line);
 appendFileSync(process.env.PALM_TEST_LOG,JSON.stringify({op:x.op})+'\\n');
 if(x.op==='start') await new Promise(r=>setTimeout(r,300));
 output({id:x.id,result:x.op==='apps'?[]:{ok:true,synthetic:true,screenPermission:true,controlPermission:true}});
});
`,
    { mode: 0o700 },
  );
  const port = 52000 + (process.pid % 1000),
    base = `http://localhost:${port}`;
  let child;
  async function start() {
    const environment = {
      ...process.env,
      PALM_PORT: String(port),
      PALM_STATE_DIR: directory,
      PALM_SYNTHETIC: "1",
      PALM_NATIVE_PATH: fixture,
      PALM_TEST_LOG: log,
      PALM_INBOX: directory,
      PALM_PREVIEW_SLOTS: `${port + 2000}:${port + 1}`,
    };
    delete environment.PALM_ORIGIN;
    child = spawn(process.execPath, ["server/index.mjs"], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Server start timeout")),
        5000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Server exited during startup"));
      });
    });
  }
  async function stop() {
    if (child?.exitCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
  }
  const post = (route, data = {}, headers = {}) =>
    fetch(base + "/api/" + route, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
  const get = (route, headers = {}) =>
    fetch(base + "/api/" + route, { headers });
  const pair = async (name) => {
    const code = await (await post("local/pair-code")).json();
    const response = await post("native/pair", { code: code.code, name });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    return await response.json();
  };
  function socket(headers, route = "/socket") {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace("http:", "ws:") + route, {
        headers: { origin: base, ...headers },
      });
      ws.on("error", reject);
      ws.once("unexpected-response", (_req, response) => {
        const error = new Error("Upgrade rejected");
        error.status = response.statusCode;
        response.resume();
        ws.terminate();
        reject(error);
      });
      ws.once("open", () => resolve(ws));
    });
  }
  const operations = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s).op);
  async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await pause(20);
    }
    throw new Error("Expected test state did not arrive.");
  }
  return {
    directory,
    base,
    start,
    stop,
    post,
    get,
    pair,
    socket,
    operations,
    waitFor,
  };
}
function reply(ws, command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", receive);
      reject(new Error("Command reply timeout"));
    }, 5000);
    function receive(data, binary) {
      if (binary) return;
      const value = JSON.parse(data);
      if (value.requestId !== command.requestId) return;
      clearTimeout(timer);
      ws.off("message", receive);
      resolve(value);
    }
    ws.on("message", receive);
    ws.send(JSON.stringify(command));
  });
}

test("native HTTP and websocket pairing persist, enforce exact origins and revoke across host restart", async () => {
  const h = await harness();
  let ws;
  try {
    await h.start();
    const device = await h.pair("Integration iPhone");
    const headers = { origin: h.base, authorization: `Bearer ${device.token}` };
    assert.match(device.deviceId, /^[a-f0-9]{16}$/);
    assert.ok(device.expires > Date.now() + 29 * 86400000);
    const saved = await readFile(
      path.join(h.directory, "native-devices.json"),
      "utf8",
    );
    assert.ok(!saved.includes(device.token));
    assert.equal(
      (await stat(path.join(h.directory, "native-devices.json"))).mode & 0o777,
      0o600,
    );
    const status = await (await h.get("status", headers)).json();
    assert.equal(status.protocolVersion, 2);
    assert.equal(status.capabilities.durableDevices, true);
    assert.equal(
      (await h.get("status", { authorization: headers.authorization })).status,
      403,
    );
    assert.equal(
      (await h.get("status", { ...headers, origin: "https://foreign.invalid" }))
        .status,
      403,
    );
    const localSetup = await (await h.get("local/setup")).json();
    assert.ok(!JSON.stringify(localSetup).includes(device.token));
    assert.ok(!JSON.stringify(localSetup).includes("tokenHash"));
    assert.equal(
      (await h.post("local/connection", { origin: "http://unsafe.invalid" }))
        .status,
      400,
    );
    const changed = await (
      await h.post("local/connection", {
        origin: "https://palm.example.test:8443",
      })
    ).json();
    assert.equal(changed.restartRequired, false);
    assert.equal(changed.origin, "https://palm.example.test:8443");
    assert.equal(
      (await h.get("status", { ...headers, origin: changed.origin })).status,
      403,
    );
    assert.equal(
      (await h.get("local/setup", { "x-forwarded-host": "palm.example.test" }))
        .status,
      403,
    );
    await assert.rejects(
      h.socket({ ...headers, origin: "https://foreign.invalid" }),
      (error) => error.status === 403,
    );
    await h.stop();
    await h.start();
    assert.equal(
      (await (await h.get("local/setup")).json()).remoteOrigin,
      changed.origin,
    );
    const hostRequest = (route, requestHeaders) =>
      new Promise((resolve, reject) => {
        const request = http.get(
          h.base + "/api/" + route,
          { headers: requestHeaders },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
      });
    assert.equal(
      await hostRequest("status", {
        ...headers,
        origin: changed.origin,
        host: "palm.example.test:8443",
      }),
      200,
    );
    assert.equal(
      await hostRequest("local/setup", {
        origin: changed.origin,
        host: "palm.example.test:8443",
      }),
      403,
    );
    assert.equal((await h.get("status", headers)).status, 200);
    ws = await h.socket(headers);
    const ping = async (at) => {
      const received = new Promise((resolve) => {
        const receive = (raw, binary) => {
          if (binary) return;
          const packet = JSON.parse(raw);
          if (packet.event === "pong") {
            ws.off("message", receive);
            resolve(packet.at);
          }
        };
        ws.on("message", receive);
      });
      ws.send(JSON.stringify({ op: "ping", at }));
      return received;
    };
    assert.equal(await ping("native-heartbeat-UUID"), "native-heartbeat-UUID");
    assert.equal(await ping(12345.5), 12345.5);
    assert.equal(await ping("x".repeat(81)), null);
    const failed = await reply(ws, {
      op: "text",
      text: "synthetic test",
      requestId: "before-start",
    });
    assert.equal(failed.event, "error");
    assert.match(failed.message, /Start the live/);
    const oversizedWindow = await reply(ws, {
      op: "start",
      windowId: 0x100000000,
      requestId: "bad-window",
    });
    assert.equal(oversizedWindow.event, "error");
    assert.match(oversizedWindow.message, /Unsupported/);
    assert.equal(
      (await reply(ws, { op: "start", requestId: "begin" })).event,
      "reply",
    );
    assert.equal(
      (
        await reply(ws, {
          op: "text",
          text: "synthetic test",
          requestId: "typed",
        })
      ).event,
      "reply",
    );
    const invalid = await reply(ws, { op: "shell", requestId: "invalid" });
    assert.equal(invalid.event, "error");
    assert.match(invalid.message, /Unsupported/);
    const closed = once(ws, "close");
    assert.equal(
      (await h.post("local/revoke", { id: device.deviceId })).status,
      200,
    );
    assert.equal((await closed)[0], 4001);
    await h.stop();
    await h.start();
    assert.equal((await h.get("status", headers)).status, 401);
    await assert.rejects(h.socket(headers), (error) => error.status === 401);
    const self = await h.pair("Self revoke");
    const selfHeaders = {
      origin: h.base,
      authorization: `Bearer ${self.token}`,
    };
    assert.equal((await h.post("disconnect", {}, selfHeaders)).status, 200);
    await h.stop();
    await h.start();
    assert.equal((await h.get("status", selfHeaders)).status, 401);
  } finally {
    ws?.terminate();
    await h.stop();
  }
});

test("the same phone reconnecting replaces its own stale screen connection; another phone is still refused", async () => {
  // E2E, 23 September: Palm left the screen, its old connection was cut
  // without a goodbye, and the phone was refused (409) until the Mac timed it out.
  const h = await harness();
  let old, fresh, other;
  try {
    await h.start();
    const phone = await h.pair("Phone"),
      second = await h.pair("Other phone");
    const a = { authorization: `Bearer ${phone.token}`, origin: h.base };
    const b = { authorization: `Bearer ${second.token}`, origin: h.base };
    old = await h.socket(a);
    assert.equal((await reply(old, { op: "start", requestId: "old-start" })).event, "reply");
    const closed = once(old, "close");
    fresh = await h.socket(a);
    const [code] = await closed;
    assert.equal(code, 4000, "the old connection is told it was replaced");
    assert.equal((await reply(fresh, { op: "start", requestId: "fresh-start" })).event, "reply");
    assert.deepEqual(await h.operations(), ["start", "stop", "start"], "the old capture stopped before the new one started");
    await assert.rejects(h.socket(b), (error) => error.status === 409);
    assert.equal(
      (await reply(fresh, { op: "pointer", action: "click", x: 0.5, y: 0.5, requestId: "still-mine" })).event,
      "reply",
      "the refused phone did not disturb the live one",
    );
  } finally {
    old?.terminate();
    fresh?.terminate();
    other?.terminate();
    await h.stop();
  }
});

test("revocation drains old stream work before a new controller and cancels queued input", async () => {
  const h = await harness();
  let old, next;
  try {
    await h.start();
    const first = await h.pair("Old controller"),
      second = await h.pair("New controller");
    const a = { authorization: `Bearer ${first.token}`, origin: h.base };
    const b = { authorization: `Bearer ${second.token}`, origin: h.base };
    old = await h.socket(a);
    old.send(JSON.stringify({ op: "start", requestId: 1 }));
    await h.waitFor(async () => (await h.operations()).includes("start"));
    old.send(
      JSON.stringify({ op: "text", text: "must never execute", requestId: 2 }),
    );
    old.send(
      JSON.stringify({
        op: "activate",
        bundleId: "synthetic.stale",
        requestId: 3,
      }),
    );
    const closed = once(old, "close");
    await h.post("local/revoke", { id: first.deviceId });
    await closed;
    await assert.rejects(h.socket(b), (error) => error.status === 409);
    await h.waitFor(async () => (await h.operations()).includes("stop"));
    next = await h.socket(b);
    assert.equal(
      (await reply(next, { op: "start", requestId: "new-start" })).event,
      "reply",
    );
    assert.equal(
      (
        await reply(next, {
          op: "pointer",
          action: "click",
          x: 0.5,
          y: 0.5,
          requestId: "new-click",
        })
      ).event,
      "reply",
    );
    const operations = await h.operations();
    assert.equal(operations.includes("text"), false);
    assert.equal(operations.includes("activate"), false);
    assert.deepEqual(operations, ["start", "stop", "start", "pointer"]);
  } finally {
    old?.terminate();
    next?.terminate();
    await h.stop();
  }
});

// Media transport, ownership and playback are exercised against the real
// synthetic companion in media-stream.test.mjs.
