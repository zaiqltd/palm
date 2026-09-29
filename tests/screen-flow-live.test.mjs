import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";

// The real companion (synthetic screen, real H.264 encoder) and host, with a
// scripted phone that withholds, gives and delays its frame confirmations.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await predicate(); if (result) return result; await pause(20); }
  throw new Error("Screen state did not arrive");
}
async function port() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const value = server.address().port; await new Promise((r) => server.close(r)); return value;
}

test("screen flow: at most six frames unconfirmed, a slow phone lowers the rate, every frame decodes", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "palm-screen-flow-"));
  const home = path.join(dir, "home"); await mkdir(home);
  const base = `http://127.0.0.1:${await port()}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, HOME: home, PALM_SYNTHETIC: "1", PALM_NATIVE_PATH: process.env.PALM_TEST_NATIVE_PATH || "",
      PALM_STATE_DIR: path.join(dir, "state"), PALM_INBOX: home, PALM_ORIGIN: "",
      PALM_PORT: new URL(base).port, PALM_PREVIEW_SLOTS: `18544:${await port()}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ws;
  t.after(async () => { ws?.terminate(); if (child.exitCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; } });
  await until(async () => { try { return (await fetch(base + "/api/session")).ok; } catch { return false; } });
  const api = async (route, body) => {
    const r = await fetch(base + "/api/" + route, { method: body ? "POST" : "GET",
      headers: { origin: base, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200); return r.json();
  };
  const code = await api("local/pair-code", {});
  const phone = await api("native/pair", { code: code.code, name: "Flow test" });
  ws = new WebSocket(base.replace("http:", "ws:") + "/socket", { headers: { origin: base, authorization: `Bearer ${phone.token}` } });
  const frames = [], events = [];
  let mode = "withhold";
  const ack = () => ws.send(JSON.stringify({ op: "ack", n: frames.length }));
  ws.on("message", (data, binary) => {
    if (!binary) return events.push(JSON.parse(data));
    frames.push(Buffer.from(data));
    const n = frames.length;
    if (mode === "prompt") ack();
    if (mode === "slow") setTimeout(() => ws.send(JSON.stringify({ op: "ack", n })), 1100);
  });
  await once(ws, "open");
  ws.send(JSON.stringify({ op: "start", flow: true, requestId: "start" }));
  const started = await until(() => events.find((e) => e.requestId === "start"));
  assert.equal(started.event, "reply");
  assert.equal(started.result.flow, true, "the host asks this phone to confirm frames");

  // Nothing confirmed: six frames, then the Mac waits (raw pictures skipped).
  await until(() => frames.length === 6);
  await pause(700);
  assert.equal(frames.length, 6, "no more than six frames unconfirmed");
  assert.equal(frames[0][0], 1, "the first frame is a full picture");
  let diag = await api("local/diagnostics");
  assert.equal(diag.screen.inFlight, 6);
  assert.ok(diag.screen.native.skipped > 5, "the Mac skipped pictures instead of queueing them");

  // Confirmed promptly: the stream runs at the capture rate.
  mode = "prompt"; ack();
  const before = frames.length;
  await pause(1000);
  assert.ok(frames.length - before >= 20, `ran at ${frames.length - before} frames a second`);

  // The screen stops changing: the last picture is encoded again three times
  // so it sharpens (at a low rate the last picture after movement is soft).
  const refinedBefore = (await api("local/diagnostics")).screen.native.refined;
  await api("local/test/still", { on: true });
  const still = frames.length;
  await pause(1800);
  const refined = (await api("local/diagnostics")).screen.native.refined - refinedBefore;
  assert.equal(refined, 3, "three sharpening frames for a still screen");
  const settled = frames.length;
  await pause(800);
  assert.equal(frames.length, settled, "then nothing for a while");
  // Every 5 s while still, one more, so the phone never takes a still screen
  // for a dead link (it gives up after 15 s without a frame).
  await until(() => frames.length === settled + 1, 6000);
  assert.equal((await api("local/diagnostics")).screen.native.refined - refinedBefore, 4);
  await api("local/test/still", { on: false });

  // A phone on a slow link: confirmations take over a second, so the rate drops.
  mode = "slow";
  await until(async () => (await api("local/diagnostics")).screen.bitrate < 3_000_000, 8000);
  diag = await api("local/diagnostics");
  assert.ok(diag.screen.inFlight <= 7, `in flight ${diag.screen.inFlight}`);
  assert.equal(diag.screen.native.bitrate, diag.screen.bitrate, "the encoder took the new rate");
  assert.ok(diag.screen.lowered >= 1);

  // Every frame sent, across the stall and the rate change, decodes.
  if (process.env.PALM_VERIFY_MEDIA_DECODE === "1") {
    const config = Buffer.from(events.find((e) => e.event === "config").description, "base64");
    const startCode = Buffer.from([0, 0, 0, 1]), annex = [];
    let offset = 6;
    const readSets = (count) => {
      for (let i = 0; i < count; i++) {
        const size = config.readUInt16BE(offset); offset += 2;
        annex.push(startCode, config.subarray(offset, offset + size)); offset += size;
      }
    };
    readSets(config[5] & 31); readSets(config[offset++]);
    const sent = [...frames];
    for (const frame of sent) {
      const payload = frame.subarray(9);
      for (let i = 0; i < payload.length;) {
        const size = payload.readUInt32BE(i); i += 4;
        annex.push(startCode, payload.subarray(i, i + size)); i += size;
      }
    }
    const decoded = execFileSync("ffmpeg", ["-v", "error", "-f", "h264", "-i", "pipe:0", "-f", "framemd5", "pipe:1"],
      { input: Buffer.concat(annex), timeout: 20000, maxBuffer: 4 * 1024 * 1024 }).toString();
    assert.equal(decoded.split("\n").filter((line) => line && !line.startsWith("#")).length, sent.length,
      "every transmitted frame decodes");
  }

  // An older phone (no flow): the stream is not held back.
  const closed = once(ws, "close"); ws.close(); await closed;
  ws = new WebSocket(base.replace("http:", "ws:") + "/socket", { headers: { origin: base, authorization: `Bearer ${phone.token}` } });
  const old = [];
  ws.on("message", (data, binary) => { if (binary) old.push(data); else events.push(JSON.parse(data)); });
  await once(ws, "open");
  ws.send(JSON.stringify({ op: "start", requestId: "old" }));
  const oldStart = await until(() => events.find((e) => e.requestId === "old"));
  assert.equal(oldStart.result.flow, undefined);
  await until(() => old.length > 20);
  assert.equal((await api("local/diagnostics")).screen, null);
});
