// More › Camera and mic (PalmMediaView): the Mac's camera over the /media
// socket (H.264, the same decoder as the live screen) and its sound as a
// WebRTC call, which also carries this phone's microphone when you talk.
// Everything stays off until you turn it on, and leaving turns it off.
import React, { useEffect, useRef, useState } from "react";
import { AudioLines, Camera, Mic } from "lucide-react";
import { PalmVideo } from "../core/video.js";
import { Icon, SecondaryButton, PrimaryButton } from "../ui/kit.jsx";
import { PushedBar } from "./more.jsx";

class MediaSession {
  constructor(update) {
    this.update = update;
    this.video = new PalmVideo();
    this.generation = 0;
  }

  async start() {
    this.stop();
    const ticket = ++this.generation;
    this.update({ state: "Connecting", error: null, detail: "" });
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/media`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.video.onNeedsKeyframe = () => this.send({ op: "keyframe" });
    this.lastFrame = 0;
    socket.onmessage = (event) => ticket === this.generation && this.receive(event.data, ticket).catch((e) => this.fail(e.message));
    socket.onclose = (event) => {
      if (ticket !== this.generation) return;
      this.fail(event.code === 4003 ? "Unlock Palm with Face ID, then turn it on again." : event.code === 1006 || !event.reason ? "The camera connection stopped. Tap Turn on to reconnect." : event.reason);
    };
    this.heartbeat = setInterval(() => {
      this.send({ op: "ping" });
      const receiving = performance.now() - this.lastFrame < 2500;
      this.update({ cameraReceiving: receiving });
      this.pollAudio();
    }, 1000);
  }

  send(object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(object));
  }

  async receive(data, ticket) {
    if (typeof data !== "string") {
      const bytes = new DataView(data);
      if (data.byteLength <= 14 || bytes.getUint8(0) !== 2) return;
      const sequence = bytes.getUint32(1);
      this.video.enqueue(data.slice(5));
      this.lastFrame = performance.now();
      this.update({ cameraReceiving: true });
      this.send({ op: "video.ack", sequence });
      return;
    }
    const object = JSON.parse(data);
    switch (object.event) {
      case "connected":
        if (object.protocolVersion !== 2) throw new Error("Update Palm on your Mac to use camera and audio.");
        if (!object.rtc) throw new Error("Update Palm on your Mac to hear it in the browser.");
        this.send({ op: "start", protocolVersion: 2, rtc: true });
        this.update({ state: "Starting" });
        break;
      case "media.started":
        this.update({ active: true, state: "Live", detail: `${object.camera ?? "Camera"} · ${object.microphone ?? "Microphone"}` });
        await this.startCall(ticket);
        break;
      case "media.videoConfig":
        this.video.configure(object);
        if (object.width && object.height) this.update({ videoSize: [object.width, object.height] });
        break;
      case "rtc.answer":
        if (this.call && object.sdp) await this.call.setRemoteDescription({ type: "answer", sdp: object.sdp });
        break;
      case "rtc.error":
        throw new Error(object.message || "The Mac could not answer the audio call.");
      case "media.error":
        throw new Error(object.message || "Media capture stopped.");
      case "media.stopped":
        this.stop();
        break;
    }
  }

  /** The sound both ways as one call; this phone's microphone stays muted until Talk. */
  async startCall(ticket) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      throw new Error("Allow the microphone for this site in Safari to hear and talk to your Mac.");
    }
    if (ticket !== this.generation) return stream.getTracks().forEach((t) => t.stop());
    this.microphone = stream;
    const call = new RTCPeerConnection({ iceServers: [] });
    this.call = call;
    for (const track of stream.getAudioTracks()) {
      track.enabled = false;
      call.addTrack(track, stream);
    }
    call.ontrack = (event) => {
      const audio = this.audioElement();
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      audio.play().catch(() => this.update({ error: "Tap Turn on again to let the browser play the Mac's sound." }));
      this.update({ audioReady: true });
    };
    call.onconnectionstatechange = () => {
      if (call.connectionState === "failed" && ticket === this.generation) this.fail("The audio call could not connect over Tailscale.");
    };
    await call.setLocalDescription(await call.createOffer({ offerToReceiveAudio: true }));
    // One offer with every candidate in it (no trickle).
    await new Promise((resolve) => {
      if (call.iceGatheringState === "complete") return resolve();
      const done = () => call.iceGatheringState === "complete" && resolve();
      call.addEventListener("icegatheringstatechange", done);
      setTimeout(resolve, 2500);
    });
    if (ticket !== this.generation) return;
    this.send({ op: "rtc.offer", sdp: call.localDescription.sdp });
  }

  audioElement() {
    if (!this.audio) {
      this.audio = document.createElement("audio");
      this.audio.autoplay = true;
      this.audio.setAttribute("playsinline", "");
    }
    return this.audio;
  }

  async pollAudio() {
    if (!this.call) return;
    try {
      const stats = await this.call.getStats();
      let received = 0;
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") received = s.bytesReceived || 0;
      });
      const flowing = received > (this.lastAudioBytes ?? 0);
      this.lastAudioBytes = received;
      this.update({ microphoneReceiving: flowing });
    } catch {}
  }

  setTalking(on) {
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = on;
    this.update({ talking: on, talkState: on ? "On" : "Off" });
  }

  fail(message) {
    this.stop();
    this.update({ error: message });
  }

  stop() {
    this.generation++;
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close(1000);
      } catch {}
    }
    this.call?.close();
    this.call = null;
    this.microphone?.getTracks().forEach((t) => t.stop());
    this.microphone = null;
    if (this.audio) this.audio.srcObject = null;
    this.video.reset();
    this.lastAudioBytes = 0;
    this.update({ state: "Ready", active: false, audioReady: false, talking: false, talkState: "Off", cameraReceiving: false, microphoneReceiving: false, detail: "" });
  }
}

export function MediaScreen() {
  const [s, setS] = useState({ state: "Ready", active: false, audioReady: false, talking: false, talkState: "Off", cameraReceiving: false, microphoneReceiving: false, detail: "", error: null, videoSize: [16, 9] });
  const session = useRef(null);
  const surface = useRef();
  if (!session.current) session.current = new MediaSession((partial) => setS((current) => ({ ...current, ...partial })));
  useEffect(() => {
    const media = session.current;
    surface.current.appendChild(media.video.canvas);
    const onHidden = () => document.visibilityState === "hidden" && media.stop();
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      media.stop();
    };
  }, []);
  const media = session.current;
  const connecting = s.state === "Connecting" || s.state === "Starting";
  const status = (receiving) => (receiving ? "On" : s.active ? "Waiting" : "Off");
  return (
    <div className="stack-screen">
      <PushedBar title="Camera and mic" />
      <div className="scroll media-screen">
        <div className="media-picture" style={{ aspectRatio: `${s.videoSize[0]} / ${s.videoSize[1]}` }} ref={surface} data-id="media.picture">
          {!s.cameraReceiving && (
            <div className="media-off">
              <Icon as={Camera} size={28} />
              <span>{s.active ? "Waiting for camera" : "Camera is off"}</span>
            </div>
          )}
        </div>
        <div className="media-status">
          <div>
            <span className="label">
              <Icon as={Camera} size={19} /> Camera
            </span>
            <span className="t-subheadline w-semibold" style={{ color: s.cameraReceiving ? "var(--red)" : "var(--muted)" }} data-id="media.cameraStatus">
              {status(s.cameraReceiving)}
            </span>
          </div>
          <div>
            <span className="label">
              <Icon as={Mic} size={19} /> Microphone
            </span>
            <span className="t-subheadline w-semibold" style={{ color: s.microphoneReceiving ? "var(--red)" : "var(--muted)" }} data-id="media.microphoneStatus">
              {status(s.microphoneReceiving)}
            </span>
          </div>
          <div>
            <span className="label">
              <Icon as={AudioLines} size={19} /> Phone microphone to Mac
            </span>
            <span className="t-subheadline w-semibold" style={{ color: s.talking ? "var(--red)" : "var(--muted)" }} data-id="media.talkStatus">
              {s.talkState}
            </span>
          </div>
        </div>
        <div className="media-buttons">
          {s.active && s.audioReady && (
            <SecondaryButton onClick={() => media.setTalking(!s.talking)} id="media.talk">
              {s.talking ? "Stop talking" : "Talk to Mac"}
            </SecondaryButton>
          )}
          {s.active ? (
            <SecondaryButton onClick={() => media.stop()} id="media.stop">
              Turn off
            </SecondaryButton>
          ) : connecting ? (
            <SecondaryButton onClick={() => media.stop()} id="media.cancel">
              Cancel
            </SecondaryButton>
          ) : (
            <PrimaryButton onClick={() => media.start()} id="media.start">
              Turn on
            </PrimaryButton>
          )}
        </div>
        {connecting && <p className="t-caption muted">Connecting to Mac</p>}
        {s.detail && <p className="t-caption muted">{s.detail}</p>}
        {s.error && <p className="warning">{s.error}</p>}
        <p className="t-footnote muted">
          Camera and microphone stay off until you turn them on here. Talk to Mac turns on this phone's microphone to the Mac's current audio output; you keep hearing the Mac. Leaving this view turns everything off.
        </p>
      </div>
    </div>
  );
}
