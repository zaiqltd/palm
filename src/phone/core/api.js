// Requests to the Mac: the same routes and the same wording as the iPhone
// app (PalmConnection.api / checkResponse / friendly). The web app is served
// by the Mac it talks to, so every request is same-origin and the pairing is
// an HttpOnly cookie that scripts never see.
import { createStore } from "./store.js";

export class PalmError extends Error {
  constructor(message, { status = 0, expired = false, locked = false, code } = {}) {
    super(message);
    this.status = status;
    this.expired = expired;
    this.locked = locked;
    this.code = code;
  }
}

export const EXPIRED = "This pairing has expired or was revoked. Pair with your Mac again.";
export const UNREACHABLE = "Cannot reach your Mac. Keep it awake with Palm running, and check Tailscale is connected on both devices.";

/** The pairing's state as the Mac last reported it: unpaired, setup (Face ID
 * not set up yet), locked, unlocked. The app shows pairing or Face ID from it. */
export const access = createStore({ state: "unknown", name: "", expires: 0 });

function url(path, query) {
  const u = new URL(path, location.origin);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u;
}

async function send(path, { method = "GET", body, query, timeout = 12000, signal, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = timeout ? setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeout) : null;
  signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  const init = {
    method,
    credentials: "same-origin",
    redirect: "error", // never follow a redirect with the pairing attached
    cache: "no-store",
    signal: controller.signal,
    headers: { Accept: "application/json", ...headers },
  };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) init.body = body;
    else {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  try {
    return await fetch(url(path, query), init);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PalmError(UNREACHABLE, { status: 0 });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Throws the Mac's own message (or a plain one) for a failed response. */
export async function check(response) {
  if (response.status === 401) {
    access.set({ state: "unpaired" });
    throw new PalmError(EXPIRED, { status: 401, expired: true });
  }
  if (response.status === 423) {
    const data = await response.json().catch(() => ({}));
    access.set({ state: data.state === "setup" ? "setup" : "locked" });
    throw new PalmError(data.error || "Unlock Palm with Face ID.", { status: 423, locked: true });
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (data && typeof data.error === "string") throw new PalmError(data.error.slice(0, 400), { status: response.status, code: data.code });
    if (response.status === 409) throw new PalmError("Another device is controlling this Mac. Stop its session and retry.", { status: 409 });
    throw new PalmError(`The Mac rejected this request (${response.status}).`, { status: response.status });
  }
  return response;
}

export async function request(path, options = {}) {
  const response = await check(await send(path, options));
  const text = await response.text();
  if (text.length > 16 * 1024 * 1024) throw new PalmError("The Mac response is too large.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new PalmError("The Mac sent a reply this version of Palm cannot read. Update Palm on the Mac and the iPhone.");
  }
}

export const get = (path, query, options = {}) => request(path, { ...options, query });
export const post = (path, body = {}, options = {}) => request(path, { ...options, method: "POST", body });
/** A streaming request (downloads, uploads) with the same checks. */
export const raw = async (path, options = {}) => check(await send(path, options));

export function friendly(error) {
  if (error instanceof PalmError) return error.message;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return UNREACHABLE;
  return error?.message || "Something went wrong.";
}

/** Reads the pairing's state from the Mac (never fails: offline keeps the last state). */
export async function readAccess() {
  try {
    const session = await request("/api/session", { timeout: 8000 });
    const state = !session.paired ? "unpaired" : session.web ? session.web.state : "unlocked";
    access.set({ state, name: session.web?.name || "", expires: session.web?.expires || 0, synthetic: !!session.synthetic, local: !!session.local });
    return access.get();
  } catch (error) {
    if (access.get().state === "unknown") access.set({ state: "offline" });
    throw error;
  }
}
