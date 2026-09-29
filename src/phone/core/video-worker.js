// The live picture off the main thread: H.264 decoded with WebCodecs (the
// phone's hardware decoder) and drawn on the GPU with WebGL, the browser's
// nearest thing to the app's native video layer. Gestures, the page and
// its updates never wait for a picture, and a picture never waits for them.
//
// Messages in: canvas (an OffscreenCanvas), configure, frame (an ArrayBuffer:
// 1 byte key flag, 8 bytes big-endian float64 microseconds, AVCC NAL units),
// reset. Out: configured, drawn, needsKeyframe, fatal, stats.

let canvas = null;
let gl = null;
let context2d = null;
let texture = null;
let decoder = null;
let signature = "";
let config = null;
let waitingForKeyframe = true;
let failures = 0;
let lastKeyframeRequest = 0;
const stats = { received: 0, decoded: 0, drawn: 0, keyframeWaitDrops: 0, backpressureResets: 0, decoderResets: 0, drawMs: 0, decodeDelayMs: 0, decodeDelayCount: 0, maxQueue: 0 };
// When each picture went into the decoder, to measure how long it holds pictures.
const submitted = new Map();

import { lowLatencyAvcC } from "./h264.js";

const b64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function setUpCanvas(offscreen) {
  canvas = offscreen;
  gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, desynchronized: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
  if (!gl) {
    context2d = canvas.getContext("2d", { alpha: false, desynchronized: true });
    return;
  }
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(
    program,
    shader(
      gl.VERTEX_SHADER,
      `#version 300 es
      in vec2 p;
      out vec2 uv;
      void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`,
    ),
  );
  gl.attachShader(
    program,
    shader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
      precision mediump float;
      in vec2 uv;
      uniform sampler2D picture;
      out vec4 color;
      void main() { color = texture(picture, uv); }`,
    ),
  );
  gl.linkProgram(program);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  clear();
}

function clear() {
  if (gl) {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  } else if (context2d) {
    context2d.fillStyle = "#000";
    context2d.fillRect(0, 0, canvas.width, canvas.height);
  }
}

function draw(frame) {
  const started = performance.now();
  const at = submitted.get(frame.timestamp);
  if (at !== undefined) {
    submitted.delete(frame.timestamp);
    stats.decodeDelayMs += started - at;
    stats.decodeDelayCount++;
  }
  try {
    stats.decoded++;
    if (!canvas) return;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      if (gl) gl.viewport(0, 0, width, height);
    }
    if (gl) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else context2d.drawImage(frame, 0, 0, width, height);
    stats.drawn++;
    failures = 0;
  } finally {
    frame.close();
    stats.drawMs += performance.now() - started;
  }
  postMessage({ type: "drawn", width: canvas?.width, height: canvas?.height });
}

function newDecoder() {
  const d = new VideoDecoder({ output: draw, error: () => decoderFailed() });
  d.configure({ codec: config.codec, description: lowLatencyAvcC(b64(config.description)), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
  return d;
}

function closeDecoder() {
  try {
    if (decoder && decoder.state !== "closed") decoder.close();
  } catch {}
  decoder = null;
}

function configure(next) {
  const nextSignature = `${next.codec}|${next.description}`;
  if (nextSignature === signature && decoder?.state === "configured") return;
  closeDecoder();
  config = next;
  signature = nextSignature;
  waitingForKeyframe = true;
  failures = 0;
  try {
    decoder = newDecoder();
    postMessage({ type: "configured" });
  } catch (error) {
    postMessage({ type: "fatal", message: "This browser cannot decode the Mac's video." });
  }
}

function requestKeyframe() {
  const now = performance.now();
  if (now - lastKeyframeRequest < 400) return;
  lastKeyframeRequest = now;
  postMessage({ type: "needsKeyframe" });
}

function decoderFailed() {
  failures++;
  stats.decoderResets++;
  if (failures >= 3) {
    postMessage({ type: "fatal", message: "Your phone could not decode the Mac video. Reconnect to start a fresh stream." });
    return;
  }
  closeDecoder();
  if (config) decoder = newDecoder();
  waitingForKeyframe = true;
  requestKeyframe();
}

function enqueue(buffer) {
  stats.received++;
  if (!decoder || decoder.state !== "configured") return;
  if (buffer.byteLength <= 9 || buffer.byteLength > 12 * 1024 * 1024) return;
  const view = new DataView(buffer);
  const flag = view.getUint8(0);
  if (flag > 1) return;
  const isKey = flag === 1;
  const timestamp = view.getFloat64(1);
  if (!Number.isFinite(timestamp) || timestamp < 0) return;
  if (waitingForKeyframe && !isKey) {
    stats.keyframeWaitDrops++;
    requestKeyframe();
    return;
  }
  // Well behind (the decoder still holds several pictures): skip to the next
  // full picture, keeping the last one on screen meanwhile.
  if (decoder.decodeQueueSize > 4 && !isKey) {
    stats.backpressureResets++;
    closeDecoder();
    decoder = newDecoder();
    waitingForKeyframe = true;
    requestKeyframe();
    return;
  }
  try {
    submitted.set(Math.round(timestamp), performance.now());
    if (submitted.size > 120) submitted.delete(submitted.keys().next().value);
    decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: Math.round(timestamp), data: new Uint8Array(buffer, 9) }));
    stats.maxQueue = Math.max(stats.maxQueue, decoder.decodeQueueSize);
    waitingForKeyframe = false;
  } catch {
    decoderFailed();
  }
}

function reset(keepPicture) {
  closeDecoder();
  signature = "";
  config = null;
  waitingForKeyframe = true;
  failures = 0;
  if (!keepPicture) clear();
}

setInterval(() => {
  postMessage({ type: "stats", stats: { ...stats, drawMs: Math.round(stats.drawMs), decodeDelayAvgMs: stats.decodeDelayCount ? +(stats.decodeDelayMs / stats.decodeDelayCount).toFixed(1) : null } });
}, 1000);

onmessage = (event) => {
  const m = event.data;
  if (m.type === "canvas") setUpCanvas(m.canvas);
  else if (m.type === "configure") configure(m.config);
  else if (m.type === "frame") enqueue(m.buffer);
  else if (m.type === "reset") reset(m.keepPicture);
};
