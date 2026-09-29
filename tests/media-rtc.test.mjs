import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";

// Camera-and-mic sound as a WebRTC call: a scripted phone (real WebRTC)
// offers through the host, the real companion (test mode) answers, and both
// ends must connect. Neither uses a real microphone or speaker.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = await predicate(); if (result) return result; await pause(25); }
  throw new Error("Call state did not arrive");
}
async function port() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const value = server.address().port; await new Promise((r) => server.close(r)); return value;
}

test("camera and mic: the phone's WebRTC offer reaches the Mac, the answer comes back, the call connects", { timeout: 120000 }, async (t) => {
  const webrtc = "vendor/WebRTC.xcframework/macos-x86_64_arm64";
  await mkdir(".local/rtc-tests", { recursive: true });
  execFileSync("/usr/bin/swiftc", ["-swift-version", "5", "-parse-as-library", "shared/PalmCall.swift",
    "tests/PalmCallPhone.swift", "-F", webrtc, "-framework", "WebRTC", "-Xlinker", "-rpath", "-Xlinker",
    path.resolve(webrtc), "-o", ".local/rtc-tests/phone"], { timeout: 120_000 });
  const dir = await mkdtemp(path.join(os.tmpdir(), "palm-rtc-"));
  const home = path.join(dir, "home"); await mkdir(home);
  const base = `http://127.0.0.1:${await port()}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, HOME: home, PALM_SYNTHETIC: "1", PALM_NATIVE_PATH: process.env.PALM_TEST_NATIVE_PATH || "",
      PALM_STATE_DIR: path.join(dir, "state"), PALM_INBOX: home, PALM_ORIGIN: "",
      PALM_PORT: new URL(base).port, PALM_PREVIEW_SLOTS: `18644:${await port()}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ws, phone;
  t.after(async () => { ws?.terminate(); phone?.kill(); if (child.exitCode === null) { const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; } });
  await until(async () => { try { return (await fetch(base + "/api/session")).ok; } catch { return false; } });
  const api = async (route, body) => {
    const r = await fetch(base + "/api/" + route, { method: body ? "POST" : "GET",
      headers: { origin: base, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(r.status, 200); return r.json();
  };
  const code = await api("local/pair-code", {});
  const paired = await api("native/pair", { code: code.code, name: "Call test" });
  ws = new WebSocket(base.replace("http:", "ws:") + "/media", { headers: { origin: base, authorization: `Bearer ${paired.token}` } });
  const events = [];
  ws.on("message", (data, binary) => { if (!binary) events.push(JSON.parse(data)); });
  await once(ws, "open");
  const connected = await until(() => events.find((e) => e.event === "connected"));
  assert.equal(connected.rtc, true, "the Mac says it can carry the sound as a call");
  ws.send(JSON.stringify({ op: "start", protocolVersion: 2, rtc: true }));
  const started = await until(() => events.find((e) => e.event === "media.started"));
  assert.equal(started.rtc, true);
  assert.equal((await api("local/media-diagnostics")).transport.audioConnected, false, "no raw audio socket for a call");

  phone = spawn(".local/rtc-tests/phone", [], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: phone.stdout });
  const received = [];
  lines.on("line", (line) => received.push(JSON.parse(line)));
  const offer = await until(() => received[0]);
  assert.equal(offer.opusParameters, true, "the phone asks for 64 kbit/s Opus with error correction");
  assert.match(offer.offer, /a=candidate:/, "the offer carries its candidates");
  ws.send(JSON.stringify({ op: "rtc.offer", sdp: offer.offer }));
  const answer = await until(() => events.find((e) => e.event === "rtc.answer" || e.event === "rtc.error"));
  assert.equal(answer.event, "rtc.answer", answer.message);
  assert.match(answer.sdp, /a=candidate:/);
  phone.stdin.write(JSON.stringify({ sdp: answer.sdp }) + "\n");
  const result = await until(() => received[1], 20000);
  assert.equal(result.state, "connected", "the phone's end connected");
  const mac = await until(async () => {
    const rtc = (await api("local/media-diagnostics")).native.rtc;
    return rtc.rtcState === "connected" && rtc.rtcPath && rtc;
  });
  assert.equal(mac.rtcState, "connected", "the Mac's end connected");
  assert.ok(["tailscale", "local network"].includes(mac.rtcPath));
  phone.stdin.write("hang up\n");

  ws.send(JSON.stringify({ op: "rtc.offer", sdp: "garbage" }));
  await until(() => !ws.readyState || ws.readyState > 1 || events.some((e) => e.event === "media.error"), 5000).catch(() => {});
  const closed = ws.readyState === 1 ? once(ws, "close") : null;
  if (closed) { ws.close(); await closed; }
  await until(async () => (await api("local/media-diagnostics")).native.rtc.rtcState === "ended");
});
