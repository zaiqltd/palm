// Timings measured on this phone (the web version of PalmTimings): screen
// startup, input to picture, input round trip, assistant reply, folder open.
// Kept in this browser only (the last 500), never sent.
import { createStore } from "./store.js";

const KEY = "palm.timings.samples";

export const TIMING_KINDS = [
  ["screenStart", "Screen: tap to first picture", "From starting the live screen to the first picture shown."],
  ["inputToPicture", "Input to the next picture", "From a tap or typed key to the next picture from the Mac (a change it caused, if the screen was still)."],
  ["inputAck", "Input reaches the Mac (round trip)", "From sending a tap or key to the Mac confirming it."],
  ["assistantReply", "Assistant reply", "From sending a request to its answer on the phone."],
  ["filesFolder", "Files: folder opens", "From opening a folder to its list on the phone."],
];

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

/** The phone's network, as the browser reports it (Wi-Fi, cellular or other). */
function networkKind() {
  const type = navigator.connection?.type;
  if (type === "wifi") return "Wi-Fi";
  if (type === "cellular") return "cellular";
  if (type === "ethernet") return "wired";
  return type ? "other" : "unknown";
}

export const timings = {
  store: createStore({ samples: load() }),
  get network() {
    return networkKind();
  },
  record(kind, ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms >= 120000) return;
    const samples = [...this.store.get().samples, { kind, ms: Math.round(ms), at: new Date().toISOString(), network: networkKind() }].slice(-500);
    this.store.set({ samples });
    try {
      localStorage.setItem(KEY, JSON.stringify(samples));
    } catch {}
  },
  summary(kind, network) {
    const values = this.store.get().samples.filter((s) => s.kind === kind && (!network || s.network === network)).map((s) => s.ms);
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction))];
    return { count: values.length, median: at(0.5), p90: at(0.9), last: values.at(-1) };
  },
  networks() {
    return [...new Set(this.store.get().samples.map((s) => s.network))].sort();
  },
  clear() {
    this.store.set({ samples: [] });
    try {
      localStorage.removeItem(KEY);
    } catch {}
  },
  report(device, path) {
    const when = new Date().toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
    const lines = [`Palm timings on this iPhone, ${when}`, `Mac: ${device}${path ? `, ${path}` : ""}`];
    for (const [kind, title] of TIMING_KINDS)
      for (const network of this.networks()) {
        const s = this.summary(kind, network);
        if (s) lines.push(`${title} [${network}]: median ${s.median} ms, 90% ${s.p90} ms, ${s.count} samples`);
      }
    return lines.join("\n");
  },
};
