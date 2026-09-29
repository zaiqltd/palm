import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await predicate(); if (result) return result; await pause(20); }
  throw new Error("Media state did not arrive");
}
async function port() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const value = server.address().port; await new Promise((r) => server.close(r)); return value;
}
function tone(sequence) {
  const data = Buffer.alloc(965); data[0] = 4; data.writeUInt32BE(sequence, 1);
  for (let i = 0; i < 480; i++) data.writeInt16LE(Math.round(Math.sin((sequence * 480 + i) * 2 * Math.PI * 400 / 24000) * 6000), 5 + i * 2);
  return data;
}

test("live media: H264 congestion never blocks audio; real PCM reaches the speaker renderer", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "palm-media-"));
  const home = path.join(dir, "home"); await mkdir(home);
  const base = `http://127.0.0.1:${await port()}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, HOME: home, PALM_SYNTHETIC: "1", PALM_NATIVE_PATH: "",
      PALM_STATE_DIR: path.join(dir, "state"), PALM_INBOX: home, PALM_ORIGIN: "",
      PALM_PORT: new URL(base).port, PALM_PREVIEW_SLOTS: `18444:${await port()}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sockets = [];
  t.after(async () => { sockets.forEach((ws) => ws.terminate()); if (child.exitCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; } });
  await until(async () => { try { return (await fetch(base + "/api/session")).ok; } catch { return false; } });
  const api = async (route, body) => {
    const r = await fetch(base + "/api/" + route, { method: body ? "POST" : "GET",
      headers: { origin: base, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200); return r.json();
  };
  const pair = async (name) => { const code = await api("local/pair-code", {}); return api("native/pair", { code: code.code, name }); };
  const phone = await pair("Media test"), other = await pair("Other test");
  function connect(route, token = phone.token, session) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace("http:", "ws:") + route, {
        headers: { origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(session ? { "x-palm-media-session": session } : {}) },
      });
      sockets.push(ws);
      const events = [], packets = [];
      ws.on("message", (data, binary) => {
        if (binary) packets.push(Buffer.from(data)); else events.push(JSON.parse(data));
      });
      ws.on("error", reject);
      ws.on("unexpected-response", (_, response) => {
        const error = new Error("Upgrade rejected"); error.status = response.statusCode;
        response.resume(); ws.terminate(); reject(error);
      });
      ws.once("open", () => resolve({ ws, events, packets }));
    });
  }
  await assert.rejects(connect("/media", null), (e) => e.status === 401);
  const video = await connect("/media");
  assert.equal((await api("local/media-diagnostics")).native.capture.running, false);
  video.ws.send(JSON.stringify({ op: "start", protocolVersion: 2 }));
  const started = await until(() => video.events.find((e) => e.event === "media.started"));
  await until(() => video.events.find((e) => e.event === "media.videoConfig"));
  await assert.rejects(connect("/media-audio", phone.token, "wrong-session"), (e) => e.status === 409);
  await assert.rejects(connect("/media", other.token), (e) => e.status === 409);
  const audio = await connect("/media-audio", phone.token, started.mediaSession);
  audio.ws.on("message", (data, binary) => {
    if (binary) audio.ws.send(JSON.stringify({ op: "ack", sequence: data.readUInt32BE(1) }));
  });
  await until(() => video.packets.length === 5 && audio.packets.length >= 8);
  await pause(process.env.PALM_VERIFY_MEDIA_DECODE === "1" ? 2000 : 250);
  assert.equal(video.packets.length, 5, "Video is bounded by phone acknowledgements");
  assert.ok(audio.packets.length >= 15, "Audio continued while video was stalled");
  assert.ok(audio.packets.every((p) => p.length === 965 && p[0] === 3));
  assert.ok(audio.packets.some((p) => p.subarray(5).some((n) => n !== 0)), "Test audio must contain a signal");
  video.ws.send(JSON.stringify({ op: "video.ack", sequence: video.packets.at(-1).readUInt32BE(1) }));
  await until(() => video.packets.length > 5);
  assert.equal(video.packets[5].readUInt32BE(1), 6, "Capture resumes without discarding any encoded reference frames");
  video.ws.on("message", (data, binary) => {
    if (binary) video.ws.send(JSON.stringify({ op: "video.ack", sequence: data.readUInt32BE(1) }));
  });
  video.ws.send(JSON.stringify({ op: "video.ack", sequence: video.packets.at(-1).readUInt32BE(1) }));
  video.ws.send(JSON.stringify({ op: "talk.start" }));
  await until(() => video.events.some((e) => e.event === "media.talkStarted"));
  for (let i = 1; i <= 25; i++) { audio.ws.send(tone(i)); await pause(20); }
  await until(() => audio.events.some((e) => e.event === "talk.ack" && e.sequence === 25 && e.accepted));
  const diag = await api("local/media-diagnostics");
  assert.ok(diag.native.speaker.nonzeroRenderedFrames > 8000, "Phone audio reached native rendering");
  assert.ok(diag.native.speaker.peak > 0.15);
  assert.equal(diag.transport.videoDropped, 0);
  assert.ok(diag.native.capture.videoPausedFrames > 0);
  assert.ok(diag.transport.audioInFlight <= 12);
  assert.ok(diag.native.capture.width <= 1280 && diag.native.capture.height <= 720);
  if (process.env.PALM_VERIFY_MEDIA_DECODE === "1") {
    // Optional installed ffmpeg check: all reference frames must still decode
    // after a two-second network stall. The source is synthetic only.
    const config = Buffer.from(video.events.find((e) => e.event === "media.videoConfig").description, "base64");
    const start = Buffer.from([0, 0, 0, 1]), annex = [];
    let offset = 6;
    const readSets = (count) => {
      for (let i = 0; i < count; i++) {
        const size = config.readUInt16BE(offset); offset += 2;
        annex.push(start, config.subarray(offset, offset + size)); offset += size;
      }
    };
    readSets(config[5] & 31); readSets(config[offset++]);
    const frames = [...video.packets];
    for (const frame of frames) {
      const payload = frame.subarray(14);
      for (let i = 0; i < payload.length;) {
        const size = payload.readUInt32BE(i); i += 4;
        annex.push(start, payload.subarray(i, i + size)); i += size;
      }
    }
    const decoded = execFileSync("ffmpeg", ["-v", "error", "-f", "h264", "-i", "pipe:0", "-f", "framemd5", "pipe:1"],
      { input: Buffer.concat(annex), timeout: 20000, maxBuffer: 1024 * 1024 }).toString();
    assert.equal(decoded.split("\n").filter((line) => line && !line.startsWith("#")).length, frames.length,
      "Every transmitted frame decodes after congestion");
  }
  video.ws.send(JSON.stringify({ op: "talk.stop" }));
  await until(() => video.events.some((e) => e.event === "media.talkStopped"));
  const closed = once(video.ws, "close"); audio.ws.close(); await closed;
  await until(async () => !(await api("local/media-diagnostics")).native.capture.running);

  const stale = await connect("/media");
  stale.ws.send(JSON.stringify({ op: "start" }));
  await until(() => stale.events.some((e) => e.event === "media.error" && /Update Palm/.test(e.message)));
  assert.equal((await api("local/media-diagnostics")).native.capture.running, false);
  const staleClosed = once(stale.ws, "close"); stale.ws.close(); await staleClosed;

  const next = await connect("/media");
  next.ws.send(JSON.stringify({ op: "start", protocolVersion: 2 }));
  const nextStart = await until(() => next.events.find((e) => e.event === "media.started"));
  const nextAudio = await connect("/media-audio", phone.token, nextStart.mediaSession);
  const revokedVideo = once(next.ws, "close"), revokedAudio = once(nextAudio.ws, "close");
  await api("local/revoke", { id: phone.deviceId });
  assert.equal((await revokedVideo)[0], 4001);
  assert.equal((await revokedAudio)[0], 4001);
  await until(async () => !(await api("local/media-diagnostics")).native.capture.running);
});
