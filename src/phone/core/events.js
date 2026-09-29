// The Mac's multi-listener event stream (/events): task updates and streamed
// replies, terminal I/O, dev-server logs and Mac state. The web version of
// PalmEvents: separate from the live screen, so chat and terminals work
// without video; a dropped connection only means re-reading state.
import { createStore } from "./store.js";
import { access } from "./api.js";

class PalmEvents {
  constructor() {
    this.store = createStore({ connected: false, lastError: null });
    this.socket = null;
    this.generation = 0;
    this.listeners = new Map(); // id -> { topic, handler }
    this.topicCounts = new Map();
    this.onConnected = new Map();
    this.active = document.visibilityState !== "hidden";
    this.attempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    document.addEventListener("visibilitychange", () => this.setActive(document.visibilityState !== "hidden"));
    // Self-starting: while Palm is in front and unlocked, keep a connection.
    setInterval(() => {
      if (this.active && !this.store.get().connected) this.ensureConnected();
    }, 3000);
    access.subscribe(() => {
      if (access.get().state === "unlocked") this.ensureConnected();
      else this.disconnect();
    });
  }

  get connected() {
    return this.store.get().connected;
  }

  setActive(value) {
    this.active = value;
    if (value) this.ensureConnected();
    else this.disconnect();
  }

  reconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempt = 0;
    if (this.socket && !this.connected) {
      this.socket.close();
      this.socket = null;
    }
    this.active = true;
    this.ensureConnected();
  }

  /** Every message published on `topic` ("tasks", "task:<id>", "terminal:<id>",
   * "dev", "dev:<id>", "system", "screen", "terminals", "watch", "files", "assistant"). */
  listen(topic, handler) {
    const id = crypto.randomUUID();
    this.listeners.set(id, { topic, handler });
    if (!topic.startsWith("terminal:")) {
      const count = (this.topicCounts.get(topic) || 0) + 1;
      this.topicCounts.set(topic, count);
      if (count === 1) this.sendRaw({ op: "subscribe", topics: [topic] });
    }
    this.ensureConnected();
    return () => this.stopListening(id);
  }

  stopListening(id) {
    const entry = this.listeners.get(id);
    if (!entry) return;
    this.listeners.delete(id);
    const { topic } = entry;
    if (topic.startsWith("terminal:")) return;
    const count = this.topicCounts.get(topic) || 0;
    if (count <= 1) {
      this.topicCounts.delete(topic);
      this.sendRaw({ op: "unsubscribe", topics: [topic] });
    } else this.topicCounts.set(topic, count - 1);
  }

  /** Runs after every (re)connection, e.g. to re-attach a terminal. */
  whenConnected(action) {
    const id = crypto.randomUUID();
    this.onConnected.set(id, action);
    if (this.connected) action();
    return () => this.onConnected.delete(id);
  }

  send(object) {
    this.sendRaw(object);
  }

  /** A request on the events connection, answered by its reply. */
  request(object, timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error("Live updates are reconnecting. Try again in a moment."));
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.replies?.delete(requestId);
        reject(new Error("The Mac did not answer in time."));
      }, timeout);
      this.replies = this.replies || new Map();
      this.replies.set(requestId, { resolve, reject, timer });
      this.sendRaw({ ...object, requestId });
    });
  }

  sendRaw(object) {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(object));
    } catch {
      this.dropped();
    }
  }

  ensureConnected() {
    if (!this.active || this.socket || this.reconnectTimer || access.get().state !== "unlocked") return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events`);
    const epoch = ++this.generation;
    this.socket = ws;
    setTimeout(() => {
      if (this.generation === epoch && !this.connected) {
        this.store.set({ lastError: "The Mac did not answer the live-updates connection in time." });
        this.dropped();
      }
    }, 10000);
    ws.onmessage = (event) => {
      if (this.generation !== epoch || typeof event.data !== "string") return;
      let object;
      try {
        object = JSON.parse(event.data);
      } catch {
        return;
      }
      this.dispatch(object);
    };
    ws.onclose = (event) => {
      if (this.generation !== epoch) return;
      if (event.code === 4003) access.set({ state: "locked" });
      else if (event.code === 4001) access.set({ state: "unpaired" });
      else if (!this.connected) this.store.set({ lastError: "Live updates refused." });
      this.dropped();
    };
  }

  dispatch(object) {
    if (object.event === "connected") {
      this.store.set({ connected: true, lastError: null });
      this.attempt = 0;
      const topics = [...this.topicCounts.keys()];
      if (topics.length) this.sendRaw({ op: "subscribe", topics });
      clearInterval(this.pingTimer);
      const epoch = this.generation;
      this.pingTimer = setInterval(() => {
        if (this.generation !== epoch) return clearInterval(this.pingTimer);
        this.sendRaw({ op: "ping" });
      }, 15000);
      for (const action of this.onConnected.values()) action();
      if (object.screen) this.screenState = object.screen;
      return;
    }
    if (object.event === "reply" || (object.event === "error" && object.requestId)) {
      const pending = this.replies?.get(object.requestId);
      if (pending) {
        this.replies.delete(object.requestId);
        clearTimeout(pending.timer);
        if (object.event === "reply") pending.resolve(object.result);
        else pending.reject(new Error(object.message || "The Mac could not do that."));
      }
      return;
    }
    const topic = object.topic;
    if (typeof topic !== "string") return;
    for (const { topic: t, handler } of this.listeners.values()) if (t === topic) handler(object);
  }

  dropped() {
    this.generation++;
    this.store.set({ connected: false });
    clearInterval(this.pingTimer);
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onmessage = ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    if (!this.active || this.reconnectTimer || access.get().state !== "unlocked") return;
    this.attempt++;
    const delay = Math.min(8, 0.5 * 2 ** Math.min(this.attempt, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay * 1000);
  }

  disconnect() {
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearInterval(this.pingTimer);
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onmessage = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {}
    }
    this.store.set({ connected: false });
  }
}

export const events = new PalmEvents();
