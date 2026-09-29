// The Mac screen's H.264 stream, decoded with WebCodecs and drawn on a canvas:
// the web version of PalmVideoRenderer. Same packet format (1 byte key flag,
// 8 bytes big-endian float64 microseconds, then AVCC NAL units), same rules:
// wait for a keyframe after any reset, keep the last picture through a zoom
// step or format change, skip ahead to the next keyframe when behind.
import { PalmError } from "./api.js";
import { lowLatencyAvcC } from "./h264.js";

const b64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The same, on the main thread: for a browser without WebGL in workers. */
class MainThreadVideo {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 16;
    this.canvas.height = 10;
    this.canvas.className = "remote-video";
    this.context = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.decoder = null;
    this.signature = "";
    this.waitingForKeyframe = true;
    this.lastKeyframeRequest = 0;
    this.decodeFailures = 0;
    /** A picture of this stream is on screen (kept through reconfiguration). */
    this.hasPicture = false;
    this.onFrame = null;
    this.onNeedsKeyframe = null;
    this.onFatal = null;
    this.diagnostics = { receivedPackets: 0, submittedFrames: 0, keyframeWaitDrops: 0, backpressureFlushes: 0, decoderResets: 0 };
  }

  static get supported() {
    return typeof window !== "undefined" && "VideoDecoder" in window && "EncodedVideoChunk" in window;
  }

  get isReadyForDisplay() {
    return this.hasPicture && this.decoder?.state === "configured";
  }

  /** `keepPicture` leaves the last frame on screen until the next one decodes. */
  reset(keepPicture = false) {
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {}
    }
    this.decoder = null;
    this.signature = "";
    this.waitingForKeyframe = true;
    this.decodeFailures = 0;
    if (!keepPicture) {
      this.hasPicture = false;
      this.context.fillStyle = "#000";
      this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  configure(config) {
    if (!String(config.codec || "").startsWith("avc1.") || !(config.width >= 2 && config.width <= 8192) || !(config.height >= 2 && config.height <= 8192))
      throw new PalmError("The Mac sent an unsupported video frame.");
    const signature = `${config.codec}|${config.description}`;
    if (signature === this.signature && this.decoder?.state === "configured") return;
    // A new size or zoom step: the old picture stays until the new one shows.
    this.reset(true);
    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => this.decoderFailed(),
    });
    decoder.configure({
      codec: config.codec,
      description: lowLatencyAvcC(b64(config.description)),
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
    this.decoder = decoder;
    this.signature = signature;
  }

  enqueue(buffer) {
    this.diagnostics.receivedPackets++;
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    if (buffer.byteLength <= 9 || buffer.byteLength > 12 * 1024 * 1024) throw new PalmError("The Mac sent an unsupported video frame.");
    const view = new DataView(buffer);
    const flag = view.getUint8(0);
    if (flag > 1) throw new PalmError("The Mac sent an unsupported video frame.");
    const isKey = flag === 1;
    const timestamp = view.getFloat64(1);
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new PalmError("The Mac sent an unsupported video frame.");
    if (this.waitingForKeyframe && !isKey) {
      this.diagnostics.keyframeWaitDrops++;
      return;
    }
    if (decoder.decodeQueueSize > 2) {
      // Behind: skip to the next full frame, holding the last picture meanwhile.
      this.diagnostics.backpressureFlushes++;
      decoder.reset();
      decoder.configure(this.lastConfig());
      this.waitingForKeyframe = true;
      this.requestKeyframe();
      if (!isKey) return;
    }
    try {
      decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: Math.round(timestamp), data: new Uint8Array(buffer, 9) }));
      this.waitingForKeyframe = false;
      this.diagnostics.submittedFrames++;
    } catch {
      this.decoderFailed();
    }
  }

  lastConfig() {
    const [codec, description] = this.signature.split("|");
    return { codec, description: lowLatencyAvcC(b64(description)), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
  }

  draw(frame) {
    try {
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.context.drawImage(frame, 0, 0, width, height);
      this.hasPicture = true;
      this.decodeFailures = 0;
    } finally {
      frame.close();
    }
    this.onFrame?.();
  }

  decoderFailed() {
    this.decodeFailures++;
    this.diagnostics.decoderResets++;
    if (this.decodeFailures >= 3) {
      this.onFatal?.(new PalmError("Your iPhone could not decode the Mac video. Reconnect to start a fresh stream."));
      return;
    }
    const signature = this.signature;
    if (signature) {
      try {
        if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
      } catch {}
      this.decoder = new VideoDecoder({ output: (frame) => this.draw(frame), error: () => this.decoderFailed() });
      this.decoder.configure(this.lastConfig());
      this.signature = signature;
    }
    this.waitingForKeyframe = true;
    this.requestKeyframe();
  }

  requestKeyframe() {
    const now = performance.now();
    if (now - this.lastKeyframeRequest < 400) return;
    this.lastKeyframeRequest = now;
    this.onNeedsKeyframe?.();
  }
}

/**
 * The picture in a worker (video-worker.js): decoded by the phone's hardware
 * and drawn on the GPU, away from the page's own work. Same interface as the
 * main-thread version; falls back to it where a browser cannot.
 */
class WorkerVideo {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 16;
    this.canvas.height = 10;
    this.canvas.className = "remote-video";
    this.hasPicture = false;
    this.configured = false;
    this.onFrame = null;
    this.onNeedsKeyframe = null;
    this.onFatal = null;
    this.diagnostics = { receivedPackets: 0, submittedFrames: 0, keyframeWaitDrops: 0, backpressureFlushes: 0, decoderResets: 0 };
    this.worker = new Worker(new URL("./video-worker.js", import.meta.url), { type: "module" });
    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen]);
    this.worker.onmessage = (event) => {
      const m = event.data;
      if (m.type === "drawn") {
        this.hasPicture = true;
        this.onFrame?.();
      } else if (m.type === "configured") this.configured = true;
      else if (m.type === "needsKeyframe") this.onNeedsKeyframe?.();
      else if (m.type === "fatal") this.onFatal?.(new PalmError(m.message));
      else if (m.type === "stats") {
        const s = m.stats;
        this.diagnostics = { receivedPackets: s.received, submittedFrames: s.decoded, drawnFrames: s.drawn, keyframeWaitDrops: s.keyframeWaitDrops, backpressureFlushes: s.backpressureResets, decoderResets: s.decoderResets, drawMs: s.drawMs, decodeDelayAvgMs: s.decodeDelayAvgMs, maxQueue: s.maxQueue };
      }
    };
  }

  static get supported() {
    return MainThreadVideo.supported;
  }

  get isReadyForDisplay() {
    return this.hasPicture && this.configured;
  }

  reset(keepPicture = false) {
    this.configured = false;
    if (!keepPicture) this.hasPicture = false;
    this.worker.postMessage({ type: "reset", keepPicture });
  }

  configure(config) {
    if (!String(config.codec || "").startsWith("avc1.") || !(config.width >= 2 && config.width <= 8192) || !(config.height >= 2 && config.height <= 8192))
      throw new PalmError("The Mac sent an unsupported video frame.");
    this.worker.postMessage({ type: "configure", config: { codec: config.codec, description: config.description } });
  }

  enqueue(buffer) {
    this.diagnostics.receivedPackets++;
    this.worker.postMessage({ type: "frame", buffer }, [buffer]);
  }
}

const workerVideoSupported =
  typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && "transferControlToOffscreen" in HTMLCanvasElement.prototype && !/[?&]mainvideo\b/.test(location.search);

export const PalmVideo = workerVideoSupported ? WorkerVideo : MainThreadVideo;
