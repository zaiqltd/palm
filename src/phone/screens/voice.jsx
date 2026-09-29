// Voice wherever there is a keyboard (PalmVoice): the phone records, the Mac
// sends the audio to OpenRouter with the key it keeps and returns the words,
// polished when asked, or a spoken reply. Nothing is kept; dictation never
// presses Return. One microphone for the whole app.
import React from "react";
import { Check, Mic, Sparkles, Volume2, X } from "lucide-react";
import { createStore, useStore } from "../core/store.js";
import { access, friendly, post, raw } from "../core/api.js";
import { Icon, Spinner, cx } from "../ui/kit.jsx";

const MAX_SECONDS = 300;

/** 16 kHz mono 16-bit little-endian WAV from float samples at `rate`. */
function wav(samples, rate) {
  const target = 16000;
  const ratio = rate / target;
  const count = Math.floor(samples.length / ratio);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    // Average the source samples this one covers (a simple low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const v = end > start ? sum / (end - start) : 0;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

class PalmVoice {
  store = createStore({ phase: "idle", level: 0, elapsed: 0, owner: null, error: null, active: false });
  generation = 0;
  recording = null;
  speaking = null;

  get phase() {
    return this.store.get().phase;
  }
  isActive(owner) {
    const s = this.store.get();
    return s.owner === owner && ["recording", "transcribing", "polishing"].includes(s.phase);
  }
  set(partial) {
    this.store.set(partial);
    const s = this.store.get();
    const active = !!s.owner && ["recording", "transcribing", "polishing"].includes(s.phase);
    if (active !== s.active) this.store.set({ active });
  }

  /** Starts listening for `owner` ("assistant", "task", "screen", "terminal"). */
  async start(owner) {
    this.stopSpeaking();
    this.cancel();
    this.set({ error: null });
    const generation = this.generation;
    // The test Mac offers no microphone: half a second of silence instead.
    const silent = access.get().synthetic;
    let stream = null;
    if (!silent) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      } catch {
        this.set({ error: "Allow the microphone for Palm: in Safari, tap aA › Website Settings › Microphone." });
        throw new Error(this.store.get().error);
      }
    }
    if (generation !== this.generation) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    const recording = { stream, chunks: [], rate: 16000, started: performance.now(), silent };
    if (stream) {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        recording.chunks.push(new Float32Array(data));
        let sum = 0;
        for (const v of data) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / data.length) || 1e-6);
        this.set({ level: Math.max(0, Math.min(1, (db + 55) / 55)) });
      };
      source.connect(processor);
      processor.connect(context.destination);
      recording.context = context;
      recording.rate = context.sampleRate;
    }
    this.recording = recording;
    this.set({ owner, phase: "recording", level: silent ? 0.3 : 0, elapsed: 0 });
    recording.meter = setInterval(() => {
      const elapsed = (performance.now() - recording.started) / 1000;
      this.set({ elapsed });
      if (elapsed >= MAX_SECONDS) this.finish(false);
    }, 100);
  }

  stopRecording(recording) {
    clearInterval(recording.meter);
    recording.stream?.getTracks().forEach((t) => t.stop());
    recording.context?.close().catch(() => {});
  }

  /** Stops listening and returns the words (polished when asked), or null. */
  async finish(polish) {
    const recording = this.recording;
    if (this.phase !== "recording" || !recording) return null;
    this.recording = null;
    this.stopRecording(recording);
    let audio;
    if (recording.silent) audio = wav(new Float32Array(8000), 16000);
    else {
      const length = recording.chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(length);
      let offset = 0;
      for (const c of recording.chunks) (all.set(c, offset), (offset += c.length));
      audio = wav(all, recording.rate);
    }
    this.set({ phase: polish ? "polishing" : "transcribing" });
    const generation = this.generation;
    try {
      const heard = await post("/api/voice/transcribe", { audio: base64(audio), format: "wav", polish }, { timeout: 120000 });
      if (generation !== this.generation) return null;
      this.set({ phase: "idle", owner: null });
      return heard.text;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.set({ phase: "idle", owner: null, error: friendly(error) });
      return null;
    }
  }

  /** Drops the recording, or the words still on their way. */
  cancel() {
    this.generation++;
    if (this.recording) {
      this.stopRecording(this.recording);
      this.recording = null;
    }
    this.set({ phase: this.phase === "speaking" ? "speaking" : "idle", owner: null });
  }

  /** Reads a reply aloud as it arrives from the Mac (16-bit PCM). */
  async speak(text) {
    const words = String(text || "").trim();
    if (!words || this.phase !== "idle") return;
    this.stopSpeaking();
    this.set({ phase: "speaking" });
    const controller = new AbortController();
    const session = { controller, context: null };
    this.speaking = session;
    try {
      const response = await raw("/api/voice/speak", { method: "POST", body: { text: words }, timeout: 30000, signal: controller.signal });
      const rate = Number(response.headers.get("X-Audio-Sample-Rate")) || 24000;
      const reader = response.body.getReader();
      if (access.get().synthetic) {
        // The test Mac has no sound: take as long as the reply would.
        let count = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          count += value.length;
        }
        await new Promise((r) => setTimeout(r, (count / 2 / rate) * 1000));
      } else {
        const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
        session.context = context;
        let when = context.currentTime + 0.05;
        let leftover = new Uint8Array(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = new Uint8Array(leftover.length + value.length);
          bytes.set(leftover);
          bytes.set(value, leftover.length);
          const usable = bytes.length - (bytes.length % 2);
          leftover = bytes.slice(usable);
          if (!usable) continue;
          const samples = new Int16Array(bytes.buffer.slice(0, usable));
          const buffer = context.createBuffer(1, samples.length, rate);
          const channel = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
          const node = context.createBufferSource();
          node.buffer = buffer;
          node.connect(context.destination);
          when = Math.max(when, context.currentTime);
          node.start(when);
          when += buffer.duration;
        }
        await new Promise((r) => setTimeout(r, Math.max(0, (when - context.currentTime) * 1000)));
      }
    } catch (error) {
      if (!controller.signal.aborted) this.set({ error: friendly(error) });
    } finally {
      if (this.speaking === session) {
        this.speaking = null;
        session.context?.close().catch(() => {});
        if (this.phase === "speaking") this.set({ phase: "idle" });
      }
    }
  }

  stopSpeaking() {
    const session = this.speaking;
    this.speaking = null;
    if (session) {
      session.controller.abort();
      session.context?.close().catch(() => {});
    }
    if (this.phase === "speaking") this.set({ phase: "idle" });
  }
}

export const voice = new PalmVoice();

/** The microphone button: one tap starts listening. */
export function MicButton({ owner, size = 40, label = "Speak", id, onError }) {
  return (
    <button
      type="button"
      className="mic-button"
      aria-label={label}
      data-id={id || `${owner}.mic`}
      style={{ width: size, height: size, borderRadius: size / 2, background: "var(--raised)", display: "grid", placeItems: "center", color: "#fff", flex: "none" }}
      onClick={() => voice.start(owner).catch((error) => onError?.(error.message))}
    >
      <Icon as={Mic} size={size * 0.42} weight={2.4} fill="currentColor" />
    </button>
  );
}

function LevelBars({ level }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3, width: 46, height: 24 }} aria-hidden="true">
      {[0.5, 0.8, 1, 0.8, 0.5].map((weight, i) => (
        <span key={i} style={{ width: 4, height: Math.max(4, 24 * Math.min(1, level * 1.4) * weight), borderRadius: 2, background: "#fff", transition: "height 0.08s ease-out" }} />
      ))}
    </span>
  );
}

const time = (seconds) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** While listening: cancel, the level and time, then Polish or Done. */
export function VoicePill({ overVideo = false, onFinish }) {
  const v = useStore(voice.store);
  const circle = { width: 40, height: 40, borderRadius: 20, display: "grid", placeItems: "center", flex: "none" };
  return (
    <div
      className={cx("voice-pill", overVideo && "video-glass")}
      data-id="voice.pill"
      style={{ display: "flex", alignItems: "center", gap: 10, height: 56, padding: "0 8px", borderRadius: 28, background: overVideo ? undefined : "var(--panel)", width: "100%", maxWidth: 440 }}
    >
      <button type="button" aria-label="Cancel" data-id="voice.cancel" onClick={() => voice.cancel()} style={{ ...circle, background: "rgba(255,255,255,0.12)" }}>
        <Icon as={X} size={17} weight={2.6} />
      </button>
      {v.phase === "recording" ? (
        <>
          <LevelBars level={v.level} />
          <span className="t-subheadline w-semibold" style={{ fontVariantNumeric: "tabular-nums" }} aria-label={`Listening, ${Math.floor(v.elapsed)} seconds`}>
            {time(v.elapsed)}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" aria-label="Polish, then use it" data-id="voice.polish" onClick={() => onFinish(true)} className="t-subheadline w-semibold" style={{ height: 40, padding: "0 12px", borderRadius: 20, background: "rgba(255,255,255,0.12)", display: "flex", alignItems: "center", gap: 6 }}>
            <Icon as={Sparkles} size={15} /> Polish
          </button>
          <button type="button" aria-label="Done, use what I said" data-id="voice.done" onClick={() => onFinish(false)} style={{ ...circle, background: "var(--accent)", color: "var(--on-accent)" }}>
            <Icon as={Check} size={18} weight={3} />
          </button>
        </>
      ) : (
        <>
          <Spinner color="#fff" />
          <span className="t-subheadline w-semibold" data-id="voice.working">
            {v.phase === "polishing" ? "Polishing" : "Writing it down"}
          </span>
          <span style={{ flex: 1 }} />
        </>
      )}
    </div>
  );
}

/** While a reply is read aloud: a small bar to stop it. */
export function SpeakingBar() {
  const phase = useStore(voice.store, (v) => v.phase);
  if (phase !== "speaking") return null;
  return (
    <button type="button" data-id="voice.stopSpeaking" onClick={() => voice.stopSpeaking()} className="t-footnote w-semibold" style={{ height: 30, padding: "0 12px", borderRadius: 15, background: "var(--raised)", display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Icon as={Volume2} size={14} /> Speaking · Stop
    </button>
  );
}
