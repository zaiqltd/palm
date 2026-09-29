// The web version of PalmConnection: the Mac's status and apps, and the one
// live-screen session (/socket) with its video, input and reconnection.
// Same protocol, same rules and the same messages as the iPhone app.
import { createStore } from "./store.js";
import { access, friendly, get, post, request, PalmError, EXPIRED } from "./api.js";
import { PalmVideo } from "./video.js";
import { prefs, KEYS } from "./prefs.js";
import { timings } from "./timings.js";

const RECONNECT_ATTEMPTS = 6;
const reconnectDelay = (attempt) => (attempt >= 0 && attempt < RECONNECT_ATTEMPTS ? Math.min(2 ** attempt, 15) : null);
const INPUT_OPS = new Set(["pointer", "scroll", "text", "key"]);

class PingTracker {
  pending = new Map();
  issue(now) {
    for (const [nonce, at] of this.pending) if (now - at >= 12000) this.pending.delete(nonce);
    if (this.pending.size >= 12) this.pending.delete(this.pending.keys().next().value);
    const nonce = crypto.randomUUID();
    this.pending.set(nonce, now);
    return nonce;
  }
  receive(nonce, now) {
    const sent = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (sent === undefined || now - sent >= 12000) return null;
    return Math.round(now - sent);
  }
  reset() {
    this.pending.clear();
  }
}

export class PalmConnection {
  constructor() {
    this.store = createStore({
      connectionState: "unpaired", // unpaired, ready, connecting, live, reconnecting, offline
      hostStatus: null,
      apps: [],
      installedApps: [],
      errorMessage: null,
      fps: 0,
      latencyMilliseconds: null,
      targetName: "Desktop",
      targetWindowID: 0,
      videoSize: { width: 16, height: 10 },
      phoneLayout: null,
      windowLayout: "fill",
      isBusy: false,
      screenOwner: null,
      displays: [],
      displayID: null,
      actions: [],
      actionsApp: "",
      hasPicture: false,
    });
    this.video = new PalmVideo();
    this.video.onFrame = () => this.frameArrived();
    this.video.onNeedsKeyframe = () => this.sendEphemeral({ op: "keyframe" });
    this.video.onFatal = (error) => this.transportFailed(error);
    this.socket = null;
    this.generation = 0;
    this.intentGeneration = 0;
    this.actionGeneration = 0;
    this.pending = new Map();
    this.wantedWindow = null;
    this.viewport = null;
    this.streamViewport = null;
    this.viewportTimer = null;
    this.sceneActive = document.visibilityState !== "hidden";
    this.networkAvailable = navigator.onLine !== false;
    this.reconnectAttempt = 0;
    this.reconnects = 0;
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.heartbeat = null;
    this.pingTracker = new PingTracker();
    this.receivedFrames = 0;
    this.streamFramesReceived = 0;
    this.confirmsFrames = false;
    this.acceptingVideo = false;
    this.streamConfirmed = false;
    this.lastPong = 0;
    this.lastFrame = 0;
    this.streamStarted = 0;
    this.startupAsked = 0;
    this.inputAt = 0;
    this.inputInFlight = 0;
    this.streamQuality = 1;
    this.connectedWaiter = null;
    document.addEventListener("visibilitychange", () => this.setSceneActive(document.visibilityState !== "hidden"));
    window.addEventListener("online", () => this.networkChanged(true));
    window.addEventListener("offline", () => this.networkChanged(false));
  }

  get state() {
    return this.store.get();
  }
  set(partial) {
    this.store.set(partial);
  }
  get isPaired() {
    return access.get().state === "unlocked";
  }
  get isStreaming() {
    return this.state.connectionState === "live";
  }
  get prefersPhoneLayout() {
    return this.state.windowLayout === "phone" && this.state.targetWindowID > 0;
  }
  /** The picture is the whole Mac screen (the desktop, or an app filling it). */
  get showsWholeScreen() {
    return this.state.targetWindowID === 0 || this.state.windowLayout === "fill";
  }
  get canControlBase() {
    const s = this.state;
    return this.sceneActive && s.connectionState === "live" && s.hostStatus?.controlPermission === true && this.video.hasPicture && !s.isBusy && s.screenOwner?.kind !== "agent";
  }

  // ---- Status and apps ----

  async refresh() {
    try {
      const status = await get("/api/status");
      this.set({ hostStatus: status });
      if (status.home) this.home = status.home;
      if (status.screen) this.noteScreenOwner(status.screen);
      await this.refreshApps();
      if (!this.socket && !this.reconnectTimer) this.set({ connectionState: "ready" });
      this.set({ errorMessage: null });
    } catch (error) {
      if (!this.socket) this.set({ connectionState: this.isPaired ? "offline" : "unpaired" });
      throw error;
    }
  }

  async refreshApps() {
    this.set({ apps: await get("/api/apps") });
  }

  async refreshDisplays() {
    try {
      const list = await get("/api/displays");
      this.set({ displays: list.displays || [] });
    } catch {}
  }

  get currentDisplay() {
    const s = this.state;
    if (s.targetWindowID !== 0) return null;
    return s.displays.find((d) => (s.displayID === null ? d.main : d.id === s.displayID)) || null;
  }

  async show(display) {
    this.set({ displayID: display.main ? null : display.id });
    await this.start(0, display.name);
  }

  async revealEdge(top) {
    try {
      await post("/api/command", { op: "revealEdge", edge: top ? "top" : "bottom" });
    } catch {}
  }

  noteScreenOwner(state) {
    const owner = state?.owner ? { kind: state.owner.kind ?? null, taskId: state.owner.taskId ?? null, held: !!state.held } : { kind: null, taskId: null, held: !!state?.held };
    const current = this.state.screenOwner;
    if (!current || current.kind !== owner.kind || current.taskId !== owner.taskId || current.held !== owner.held) this.set({ screenOwner: owner });
  }

  // ---- Opening apps and windows ----

  async open(app, windowID = null, layout = "fill") {
    if (this.state.isBusy) throw new PalmError("Wait for the current app to finish opening.");
    this.set({ isBusy: true });
    try {
      const intent = ++this.intentGeneration;
      if (windowID !== null && !app.windows.some((w) => w.id === windowID))
        throw new PalmError("That window is no longer in this app. Refresh the app list.");
      const result = await post("/api/command", { op: "activate", bundleId: app.bundleId });
      if (this.intentGeneration !== intent || !this.sceneActive) throw new PalmError("The connection ended. Input was not repeated.");
      if (!result.ok) throw new PalmError("The Mac could not bring this app forward.");
      const selected = windowID ?? result.windowId;
      this.set({ isBusy: false });
      if (!(selected > 0)) return await this.startStream(0, app.name, "original");
      const document = app.windows.find((w) => w.id === selected)?.title || "";
      await this.startStream(selected, !document || document === app.name ? app.name : document, layout);
    } finally {
      this.set({ isBusy: false });
    }
  }

  /** The Screen tab's estimate, so opening in landscape starts at that shape. */
  prepareViewport(size) {
    if (this.wantedWindow !== null || this.state.isBusy) return;
    this.viewport = this.validViewport(size);
  }

  updateViewport(size) {
    const next = this.validViewport(size);
    if (!next) return;
    this.viewport = next;
    const window = this.wantedWindow;
    if (!this.prefersPhoneLayout || !(window > 0)) return;
    const previous = this.streamViewport ?? { width: 460, height: 860 };
    if (!this.needsViewportChange(previous, next)) return;
    clearTimeout(this.viewportTimer);
    const intent = this.intentGeneration;
    this.viewportTimer = setTimeout(async () => {
      for (let i = 0; i < 40; i++) {
        if (this.intentGeneration !== intent || !this.sceneActive || this.wantedWindow !== window || !this.prefersPhoneLayout) return;
        if (!this.state.isBusy && this.isStreaming) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const current = this.viewport;
      if (this.intentGeneration !== intent || !this.sceneActive || this.wantedWindow !== window || !this.prefersPhoneLayout || this.state.isBusy || !this.isStreaming || !current || !this.needsViewportChange(this.streamViewport ?? previous, current)) return;
      this.set({ isBusy: true });
      try {
        await this.openStream(window, false);
      } catch (error) {
        if (this.intentGeneration === intent && this.sceneActive && this.wantedWindow === window) {
          this.set({ errorMessage: friendly(error) });
          this.scheduleReconnect();
        }
      } finally {
        this.set({ isBusy: false });
      }
    }, 200);
  }

  validViewport(size) {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
    if (size.width < 240 || size.width > 1400 || size.height < 200 || size.height > 1400) return null;
    return { width: Math.round(size.width), height: Math.round(size.height) };
  }

  needsViewportChange(old, next) {
    return old.width > old.height !== next.width > next.height || Math.abs(Math.log(next.width / next.height / (old.width / old.height))) > 0.12;
  }

  cancelViewportChange() {
    clearTimeout(this.viewportTimer);
    this.viewportTimer = null;
  }

  async start(windowID = 0, name = "Desktop", layout = "original") {
    if (this.state.isBusy) throw new PalmError("Wait for the current connection change to finish.");
    this.set({ isBusy: true });
    try {
      this.streamQuality = 1;
      this.startupAsked = performance.now();
      await this.startStream(windowID, name, layout);
    } finally {
      this.set({ isBusy: false });
    }
  }

  /** Zoomed in, the Mac sends a sharper stream (up to the display's own
   * pixels). The zoom is kept: the screen frames itself (zoomed in to a
   * readable size) before the stream is live, so it is sent again once the
   * stream goes live, and after every restart. */
  setStreamQuality(zoom) {
    if (!Number.isFinite(zoom)) return;
    this.wantedZoom = zoom;
    this.applyStreamQuality();
  }

  applyStreamQuality() {
    const zoom = this.wantedZoom ?? 1;
    if (!this.isStreaming) return;
    const step = zoom < 1.25 ? 1 : zoom < 1.75 ? 1.5 : zoom < 2.5 ? 2 : zoom < 3.5 ? 3 : 4;
    if (step === this.streamQuality) return;
    this.streamQuality = step;
    this.sendEphemeral({ op: "quality", zoom: step });
  }

  async startStream(windowID, name, layout) {
    if (!this.isPaired) throw new PalmError(EXPIRED);
    if (!(windowID >= 0 && windowID <= 0xffffffff)) throw new PalmError("That window identifier is invalid. Refresh the Mac’s app list.");
    if (!this.sceneActive) throw new PalmError("Return to Palm to begin sharing.");
    if (this.state.hostStatus?.screenPermission === false)
      throw new PalmError("Enable Screen Recording for Palm on your Mac, then reopen Palm on the Mac.");
    this.cancelViewportChange();
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    this.wantedWindow = Math.max(0, windowID);
    const intent = ++this.intentGeneration;
    this.set({ windowLayout: windowID > 0 ? layout : "original", targetWindowID: Math.max(0, windowID), targetName: name, errorMessage: null });
    try {
      await this.openStream(Math.max(0, windowID), false);
    } catch (error) {
      if (this.intentGeneration !== intent || !this.sceneActive) return;
      this.set({ errorMessage: friendly(error) });
      if (this.isPaired) this.scheduleReconnect();
      throw error;
    }
  }

  stop() {
    this.cancelViewportChange();
    this.intentGeneration++;
    this.wantedWindow = null;
    this.cancelReconnect();
    this.closeTransport();
    this.set({ connectionState: this.isPaired ? "ready" : "unpaired" });
  }

  async disconnect() {
    if (this.state.isBusy) throw new PalmError("Wait for the current connection change to finish.");
    this.stop();
    try {
      await post("/api/disconnect", {});
    } finally {
      access.set({ state: "unpaired" });
      this.set({ hostStatus: null, apps: [], actions: [], connectionState: "unpaired", errorMessage: null });
    }
  }

  // ---- App controls (named buttons) ----

  async refreshActions() {
    const epoch = this.generation;
    const refresh = ++this.actionGeneration;
    const response = await post("/api/command", { op: "actions" });
    if (this.generation !== epoch || this.actionGeneration !== refresh) return;
    this.set({ actionsApp: response.app, actions: response.actions || [] });
  }

  async performAction(id) {
    if (!this.isStreaming || !this.sceneActive || !this.video.hasPicture) throw new PalmError("Start live control before using app controls.");
    await post("/api/command", { op: "action", actionId: id });
    await this.refreshActions();
  }

  // ---- Input ----

  sendPointer(action, x, y) {
    if (!["click", "double", "doubleSecond", "right", "move", "down", "up"].includes(action) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.sendInput({ op: "pointer", action, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  }

  sendScroll(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const sign = prefs.get(KEYS.invertScroll, false) ? -1 : 1;
    this.sendInput({ op: "scroll", dx: Math.min(500, Math.max(-500, sign * dx)), dy: Math.min(500, Math.max(-500, sign * dy)) });
  }

  sendText(text) {
    if (!text || text.length > 4000) {
      this.set({ errorMessage: "Send up to 4,000 characters at a time." });
      return;
    }
    this.sendInput({ op: "text", text });
  }

  sendKey(key, modifiers = []) {
    const object = { op: "key", key };
    if (modifiers.length) object.modifiers = modifiers;
    this.sendInput(object);
  }

  /** Text or a picture from this phone onto the Mac's clipboard, then pasted
   * where the Mac's cursor is. */
  async pasteOnMac({ text, pngBase64 } = {}) {
    if (pngBase64) await post("/api/clipboard", { imagePNG: pngBase64 });
    else if (text) await post("/api/clipboard", { text: text.slice(0, 200000) });
    else throw new PalmError("Nothing is copied on this iPhone.");
    await new Promise((r) => setTimeout(r, 150));
    this.sendKey("v", ["cmd"]);
  }

  /** A new stream takes input once its first picture shows (up to three seconds). */
  async waitUntilControllable(seconds = 3) {
    const end = performance.now() + seconds * 1000;
    while (performance.now() < end) {
      if (this.isStreaming && this.sceneActive && this.video.isReadyForDisplay) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.isStreaming && this.sceneActive && this.video.isReadyForDisplay;
  }

  sendInput(object) {
    const s = this.state;
    if (!this.isStreaming || !this.sceneActive || !this.video.hasPicture || s.hostStatus?.controlPermission !== true) {
      this.set({ errorMessage: "Start live control and enable Accessibility on your Mac before sending input." });
      if (object.action === "up") this.stop();
      return;
    }
    // Inputs are bounded and tied to this transport; none enter the reconnect path.
    if (this.inputInFlight >= 32 || (this.socket?.bufferedAmount ?? 0) > 262144) {
      if (object.op !== "scroll" && object.action !== "move")
        this.set({ errorMessage: "The connection is busy. Wait for the Mac to catch up, then try that input again." });
      if (object.action === "up") this.stop();
      return;
    }
    this.inputInFlight++;
    const epoch = this.generation;
    const timed = object.op === "text" || object.op === "key" || object.action === "up" || object.action === "click";
    const sent = performance.now();
    if (timed) this.inputAt = sent;
    this.beginRequest(object, (error) => {
      if (this.generation !== epoch) return;
      this.inputInFlight = Math.max(0, this.inputInFlight - 1);
      if (timed && !error) timings.record("inputAck", performance.now() - sent);
      if (error) {
        this.set({ errorMessage: friendly(error) });
        if (object.action === "up") this.stop();
      }
    });
  }

  // ---- The live-screen socket ----

  async openStream(windowID, reconnecting) {
    if (!this.isPaired) throw new PalmError(EXPIRED);
    if (!this.networkAvailable) throw new PalmError("Your iPhone is offline. Connect it to a network and Tailscale.");
    if (!PalmVideo.supported) throw new PalmError("This browser cannot show the live screen. Use Safari on iOS 17 or later.");
    const reuse = this.socket !== null && !reconnecting;
    if (!reuse) this.closeTransport();
    const epoch = this.generation;
    this.set({ connectionState: reconnecting ? "reconnecting" : "connecting", actions: [], actionsApp: "", phoneLayout: null });
    this.acceptingVideo = false;
    this.streamConfirmed = false;
    this.actionGeneration++;
    try {
      if (reuse) {
        // The ordered stop reply is a barrier: older inputs and frames have drained.
        await this.socketRequest({ op: "stop" });
        if (this.generation !== epoch || !this.socket) throw new PalmError("The connection ended. Input was not repeated.");
        this.actionGeneration++;
        this.set({ actions: [], actionsApp: "" });
        // Switching window or app: the last picture stays until the new stream's first frame.
        this.video.reset(true);
        this.set({ fps: 0 });
        this.receivedFrames = 0;
      } else {
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/socket`);
        ws.binaryType = "arraybuffer";
        this.socket = ws;
        this.lastPong = performance.now();
        const connected = new Promise((resolve, reject) => {
          this.connectedWaiter = { resolve, reject };
          setTimeout(() => {
            if (this.connectedWaiter?.resolve === resolve) {
              this.connectedWaiter = null;
              reject(new PalmError("The Mac did not open the live connection in time. Check Tailscale on both devices, then retry."));
            }
          }, 12000);
        });
        ws.onmessage = (event) => {
          if (this.generation !== epoch) return;
          try {
            this.handle(event.data);
          } catch (error) {
            this.transportFailed(error);
          }
        };
        ws.onclose = (event) => {
          if (this.generation !== epoch) return;
          if (this.connectedWaiter) {
            const waiter = this.connectedWaiter;
            this.connectedWaiter = null;
            waiter.reject(this.upgradeFailure(event));
            return;
          }
          if (event.code === 4001) return this.expirePairing();
          if (event.code === 4003) return this.lockedOut();
          this.transportFailed(new PalmError(event.code === 4000 ? "Another connection took over the screen." : "The Mac stopped responding. Reconnecting."));
        };
        await connected;
        this.startHeartbeat(epoch);
      }
      this.streamStarted = performance.now();
      this.lastFrame = 0;
      this.acceptingVideo = true;
      this.streamFramesReceived = 0;
      this.confirmsFrames = false;
      const s = this.state;
      const start = { op: "start", windowId: windowID, phoneLayout: this.prefersPhoneLayout && windowID > 0, flow: true };
      if (s.windowLayout === "fill" && windowID > 0) {
        start.fill = true;
        start.wholeScreen = true;
      }
      if (windowID === 0 && s.displayID !== null) start.displayId = s.displayID;
      this.streamViewport = this.prefersPhoneLayout && windowID > 0 ? this.viewport : null;
      if (this.streamViewport) {
        start.phoneLayoutWidth = this.streamViewport.width;
        start.phoneLayoutHeight = this.streamViewport.height;
      }
      const result = await this.socketRequest(start);
      this.refreshDisplays();
      if (this.generation !== epoch) throw new PalmError("The connection ended. Input was not repeated.");
      if (!(result?.width > 0) || !(result?.height > 0)) throw new PalmError("The Mac sent a reply this version of Palm cannot read. Update Palm on the Mac and the iPhone.");
      if (result.flow) {
        this.confirmsFrames = true;
        if (this.streamFramesReceived > 0) this.sendEphemeral({ op: "ack", n: this.streamFramesReceived });
      }
      this.set({ videoSize: { width: result.width, height: result.height }, phoneLayout: result.phoneLayout ?? null });
      this.streamConfirmed = true;
      if (this.lastFrame > 0 && this.video.isReadyForDisplay) {
        this.set({ connectionState: "live" });
        this.applyStreamQuality();
      }
    } catch (error) {
      if (this.generation === epoch) this.closeTransport();
      throw error;
    }
  }

  upgradeFailure(event) {
    // Browsers do not expose the refusal's status; ask the Mac what it thinks.
    if (event.code === 1006) {
      request("/api/session", { timeout: 6000 })
        .then((session) => {
          if (!session.paired) access.set({ state: "unpaired" });
          else if (session.web && session.web.state !== "unlocked") access.set({ state: session.web.state });
        })
        .catch(() => {});
    }
    return new PalmError("Cannot open the live screen. Another screen session may still be open on the Mac; Palm will retry in a moment.");
  }

  handle(data) {
    if (data instanceof ArrayBuffer) {
      this.streamFramesReceived++;
      if (this.confirmsFrames) this.sendEphemeral({ op: "ack", n: this.streamFramesReceived });
      if (this.acceptingVideo) this.video.enqueue(data);
      return;
    }
    if (typeof data !== "string" || data.length > 1024 * 1024) throw new PalmError("The Mac sent an unsupported video frame.");
    const object = JSON.parse(data);
    switch (object.event) {
      case "config":
        if (!this.acceptingVideo) return;
        this.lastVideoConfig = object;
        this.video.configure(object);
        this.set({ videoSize: { width: object.width, height: object.height } });
        return;
      case "reply":
        this.finishRequest(object.requestId, null, object.result);
        return;
      case "error": {
        const failure = new PalmError(String(object.message || "The Mac could not complete that action.").slice(0, 400));
        if (object.requestId && this.pending.has(object.requestId)) this.finishRequest(object.requestId, failure);
        else throw failure;
        return;
      }
      case "pong": {
        const latency = this.pingTracker.receive(object.at, performance.now());
        if (latency !== null) {
          this.lastPong = performance.now();
          this.set({ latencyMilliseconds: latency });
        }
        return;
      }
      case "stopped":
        this.stop();
        this.set({ errorMessage: "Sharing was stopped on your Mac. Tap Start when you are ready." });
        return;
      case "connected":
        if (this.connectedWaiter) {
          const waiter = this.connectedWaiter;
          this.connectedWaiter = null;
          waiter.resolve();
        }
        if (object.screenOwner) this.noteScreenOwner(object.screenOwner);
        return;
      case "screenOwner":
        this.noteScreenOwner(object);
        return;
      default:
    }
  }

  frameArrived() {
    if (!this.socket || !this.sceneActive) return;
    this.receivedFrames++;
    this.lastFrame = performance.now();
    if (!this.state.hasPicture) this.set({ hasPicture: true });
    if (this.startupAsked > 0 && this.video.isReadyForDisplay) {
      timings.record("screenStart", this.lastFrame - this.startupAsked);
      this.startupAsked = 0;
    }
    if (this.inputAt > 0) {
      const elapsed = this.lastFrame - this.inputAt;
      if (elapsed < 2000) timings.record("inputToPicture", elapsed);
      this.inputAt = 0;
    }
    if (this.streamConfirmed && this.video.isReadyForDisplay && this.state.connectionState !== "live") {
      this.set({ connectionState: "live" });
      this.applyStreamQuality();
    }
  }

  socketRequest(object) {
    return new Promise((resolve, reject) => this.beginRequest(object, (error, result) => (error ? reject(error) : resolve(result))));
  }

  beginRequest(object, completion) {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return completion(new PalmError("The connection ended. Input was not repeated."));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => this.finishRequest(id, new PalmError("The Mac did not confirm that action. It was not repeated.")), 18000);
    this.pending.set(id, { completion, timer });
    try {
      ws.send(JSON.stringify({ ...object, requestId: id }));
    } catch (error) {
      this.finishRequest(id, new PalmError("The connection ended. Input was not repeated."));
      this.transportFailed(error);
    }
  }

  finishRequest(id, error, result) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.completion(error, result);
  }

  sendEphemeral(object) {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(object));
    } catch (error) {
      this.transportFailed(error);
    }
  }

  startHeartbeat(epoch) {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.generation !== epoch) return clearInterval(this.heartbeat);
      const now = performance.now();
      this.set({ fps: this.receivedFrames });
      this.receivedFrames = 0;
      if (this.streamConfirmed && this.lastFrame > 0 && this.video.isReadyForDisplay && this.state.connectionState !== "live") {
        this.set({ connectionState: "live" });
        this.applyStreamQuality();
      }
      // Ten seconds of a working stream clears the reconnect count (a still Mac screen included).
      if (now - this.streamStarted > 10000 && this.lastFrame > 0 && now - this.lastPong < 3000) this.reconnectAttempt = 0;
      if (now - this.lastPong > 12000 || (!this.video.hasPicture && now - this.streamStarted > 20000) || (this.lastFrame > 0 && now - this.lastFrame > 15000)) {
        this.transportFailed(new PalmError("The Mac stopped responding. Reconnecting."));
        return;
      }
      this.sendEphemeral({ op: "ping", at: this.pingTracker.issue(now) });
    }, 1000);
  }

  closeTransport() {
    if (this.connectedWaiter) {
      const waiter = this.connectedWaiter;
      this.connectedWaiter = null;
      waiter.reject(new PalmError("The connection ended. Input was not repeated."));
    }
    this.acceptingVideo = false;
    this.streamConfirmed = false;
    this.confirmsFrames = false;
    this.generation++;
    this.actionGeneration++;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onmessage = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {}
    }
    for (const id of [...this.pending.keys()]) this.finishRequest(id, new PalmError("The connection ended. Input was not repeated."));
    this.inputInFlight = 0;
    this.video.reset();
    this.receivedFrames = 0;
    this.pingTracker.reset();
    this.set({ fps: 0, latencyMilliseconds: null, actions: [], actionsApp: "", phoneLayout: null, hasPicture: false });
  }

  transportFailed(error) {
    this.closeTransport();
    this.set({ errorMessage: friendly(error), connectionState: this.isPaired ? "offline" : "unpaired" });
    this.scheduleReconnect();
  }

  cancelReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
  }

  scheduleReconnect() {
    if (this.reconnecting || !this.sceneActive || !this.networkAvailable || !this.isPaired || this.wantedWindow === null) return;
    this.reconnecting = true;
    this.set({ connectionState: "reconnecting" });
    const attempt = async () => {
      const delay = reconnectDelay(this.reconnectAttempt);
      if (delay === null) {
        this.reconnecting = false;
        this.set({
          connectionState: "offline",
          errorMessage: "Your Mac is unreachable. Check that it is awake, Palm is running, and Tailscale is connected on both devices. Tap Retry to reconnect.",
        });
        return;
      }
      this.reconnectAttempt++;
      this.reconnects++;
      this.reconnectTimer = setTimeout(async () => {
        if (!this.reconnecting) return;
        const window = this.wantedWindow;
        if (!this.sceneActive || !this.networkAvailable || window === null || !this.isPaired) {
          this.reconnecting = false;
          return;
        }
        try {
          await this.refresh();
          if (!this.reconnecting || !this.sceneActive || this.wantedWindow !== window) return;
          await this.openStream(window, true);
          this.reconnecting = false;
          this.set({ errorMessage: null });
        } catch (error) {
          this.set({ errorMessage: friendly(error) });
          if (!this.isPaired) {
            this.reconnecting = false;
            return;
          }
          attempt();
        }
      }, delay * 1000);
    };
    attempt();
  }

  setSceneActive(active) {
    if (active === this.sceneActive) return;
    this.sceneActive = active;
    if (!active) {
      this.cancelViewportChange();
      this.cancelReconnect();
      this.closeTransport();
      this.set({ connectionState: this.isPaired ? "ready" : "unpaired" });
    } else if (this.isPaired) {
      if (this.wantedWindow !== null) this.scheduleReconnect();
      else this.refresh().catch(() => {});
    }
  }

  networkChanged(available) {
    if (this.networkAvailable === available) return;
    this.networkAvailable = available;
    if (!available) {
      this.cancelViewportChange();
      this.cancelReconnect();
      this.closeTransport();
      this.set({ connectionState: this.isPaired ? "offline" : "unpaired" });
      if (this.isPaired) this.set({ errorMessage: "Your iPhone is offline. Palm reconnects when the network returns." });
    } else if (this.sceneActive && this.isPaired) {
      if (this.wantedWindow !== null) this.scheduleReconnect();
      else this.refresh().catch(() => {});
    }
  }

  async retry() {
    this.set({ errorMessage: null });
    try {
      await this.refresh();
      if (this.wantedWindow !== null) await this.start(this.wantedWindow, this.state.targetName, this.state.windowLayout);
    } catch (error) {
      this.set({ errorMessage: friendly(error) });
    }
  }

  expirePairing() {
    this.wantedWindow = null;
    this.cancelReconnect();
    this.closeTransport();
    access.set({ state: "unpaired" });
    this.set({ hostStatus: null, apps: [], actions: [], connectionState: "unpaired", errorMessage: EXPIRED });
  }

  /** Face ID timed out while the screen was open: back to the unlock screen. */
  lockedOut() {
    this.cancelReconnect();
    this.closeTransport();
    access.set({ state: "locked" });
    this.set({ connectionState: "ready" });
  }
}

export const connection = new PalmConnection();
