import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

// Private phone previews of Mac dev servers.
//
// Each slot is a loopback listener (127.0.0.1:4320…) published by Tailscale
// Serve on its own tailnet-only HTTPS port (8444…). A slot proxies every path,
// including WebSocket upgrades, to one local dev-server port, so absolute
// asset paths and hot-reload sockets work unchanged. Access requires a
// single-use ticket issued through Palm's authenticated API; the ticket sets an
// HttpOnly cookie for that origin. Palm never exposes arbitrary ports: only a
// port the phone selected for preview is reachable, and only from the tailnet.
const cookieName = "palm_preview";
const ticketLifetime = 90 * 1000;
const sessionLifetime = 12 * 3600 * 1000;

export class PreviewGateway {
  // `loopback` (the test host only): with no tailnet address, previews use
  // plain http://127.0.0.1:<slot> so the Simulator can open them.
  constructor({ slots, publicHost, onChange = () => {}, loopback = false }) {
    this.loopback = loopback;
    // slots: [{ publicPort, localPort }]
    this.slots = slots.map((s, index) => ({
      ...s,
      index,
      target: null, // { port, label, devId }
      tickets: new Map(),
      sessions: new Map(),
      server: null,
      listening: false,
      lastUsed: 0,
      error: null,
    }));
    this.publicHost = publicHost; // e.g. my-mac.tail1234.ts.net
    this.onChange = onChange;
  }

  setPublicHost(host) {
    this.publicHost = host;
  }

  async start() {
    await Promise.all(
      this.slots.map(
        (slot) =>
          new Promise((resolve) => {
            const server = http.createServer((req, res) => this.request(slot, req, res));
            server.on("upgrade", (req, socket, head) => this.upgrade(slot, req, socket, head));
            server.on("error", (error) => {
              slot.error = error.code === "EADDRINUSE" ? `Port ${slot.localPort} is in use` : error.message;
              slot.listening = false;
              resolve();
            });
            server.listen(slot.localPort, "127.0.0.1", () => {
              slot.listening = true;
              resolve();
            });
            server.keepAliveTimeout = 30000;
            slot.server = server;
          }),
      ),
    );
  }

  close() {
    for (const slot of this.slots) slot.server?.close();
  }

  origin(slot) {
    if (this.publicHost) return `https://${this.publicHost}:${slot.publicPort}`;
    return this.loopback ? `http://127.0.0.1:${slot.localPort}` : null;
  }

  status() {
    return this.slots.map((slot) => ({
      slot: slot.index,
      publicPort: slot.publicPort,
      localPort: slot.localPort,
      listening: slot.listening,
      error: slot.error,
      origin: this.origin(slot),
      target: slot.target,
    }));
  }

  // Choose the slot already showing this port, else an empty or least-recently
  // used slot, then mint a single-use ticket for the phone.
  open({ port, label, devId }) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a running dev server port.");
    if (!this.origin(this.slots[0] || {})) throw new Error("Set Palm's private address on the Mac before opening previews.");
    const usable = this.slots.filter((s) => s.listening);
    if (!usable.length) throw new Error("Preview ports are not running on the Mac. Restart Palm.");
    let slot = usable.find((s) => s.target?.port === port);
    if (!slot) slot = usable.find((s) => !s.target) || usable.sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (slot.target?.port !== port) {
      slot.target = { port, label: label || `localhost:${port}`, devId: devId || null };
      // A different app in this slot gets a clean cookie jar boundary.
      slot.sessions.clear();
    }
    slot.lastUsed = Date.now();
    for (const [value, ticket] of slot.tickets) if (ticket.expires < Date.now()) slot.tickets.delete(value);
    const ticket = randomBytes(24).toString("base64url");
    slot.tickets.set(ticket, { expires: Date.now() + ticketLifetime });
    this.onChange();
    const origin = this.origin(slot);
    return {
      slot: slot.index,
      origin,
      url: `${origin}/__palm/enter?ticket=${ticket}`,
      target: slot.target,
      expiresInSeconds: ticketLifetime / 1000,
    };
  }

  release(port) {
    for (const slot of this.slots)
      if (slot.target?.port === port) {
        slot.target = null;
        slot.sessions.clear();
      }
    this.onChange();
  }

  validSession(slot, req) {
    const value = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!value || !/^[A-Za-z0-9_-]{32,64}$/.test(value)) return false;
    const session = slot.sessions.get(value);
    if (!session || session.expires < Date.now()) {
      slot.sessions.delete(value);
      return false;
    }
    return true;
  }

  request(slot, req, res) {
    const url = new URL(req.url, "http://preview.local");
    if (url.pathname === "/__palm/enter") return this.enter(slot, req, res, url);
    if (!slot.target) return page(res, 404, "No preview is open here", "Choose Open preview for a dev server in Palm on your phone.");
    if (!this.validSession(slot, req))
      return page(res, 401, "Open this preview from Palm", "This private preview needs a fresh link from the Palm app on your paired phone.");
    const headers = this.upstreamHeaders(slot, req.headers);
    const upstream = http.request(
      { host: "127.0.0.1", port: slot.target.port, method: req.method, path: req.url, headers },
      (response) => {
        const out = { ...response.headers };
        delete out["strict-transport-security"];
        if (out.location) out.location = this.publicLocation(slot, out.location);
        res.writeHead(response.statusCode || 502, out);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent)
        page(res, 502, "The dev server is not answering", `Nothing responded on port ${slot.target.port} of your Mac. Start or restart it from Palm, then reload.`);
      else res.destroy();
    });
    req.pipe(upstream);
  }

  enter(slot, req, res, url) {
    const offered = url.searchParams.get("ticket") || "";
    let matched = null;
    for (const [value, ticket] of slot.tickets) {
      if (value.length === offered.length && timingSafeEqual(Buffer.from(value), Buffer.from(offered))) {
        matched = value;
        if (ticket.expires < Date.now()) matched = null;
        break;
      }
    }
    if (!matched) return page(res, 401, "This preview link has expired", "Open the preview again from Palm on your phone.");
    slot.tickets.delete(matched);
    const session = randomBytes(24).toString("base64url");
    slot.sessions.set(session, { expires: Date.now() + sessionLifetime });
    res.writeHead(302, {
      "Set-Cookie": `${cookieName}=${session}; Path=/; HttpOnly;${this.publicHost ? " Secure;" : ""} SameSite=Lax; Max-Age=${sessionLifetime / 1000}`,
      Location: "/",
      "Cache-Control": "no-store",
    });
    res.end();
  }

  upstreamHeaders(slot, original) {
    const headers = {};
    const local = `localhost:${slot.target.port}`;
    const publicOrigin = this.origin(slot);
    for (const [key, value] of Object.entries(original)) {
      const lower = key.toLowerCase();
      // Never forward tailnet identity headers or Palm's cookie to a dev app.
      if (lower.startsWith("tailscale-") || lower.startsWith("x-forwarded-") || lower === "forwarded") continue;
      if (lower === "host") continue;
      if (lower === "cookie") {
        const kept = String(value)
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part && !part.startsWith(cookieName + "="));
        if (kept.length) headers.cookie = kept.join("; ");
        continue;
      }
      if ((lower === "origin" || lower === "referer") && publicOrigin && String(value).startsWith(publicOrigin)) {
        headers[lower] = `http://${local}` + String(value).slice(publicOrigin.length);
        continue;
      }
      headers[lower] = value;
    }
    headers.host = local;
    return headers;
  }

  publicLocation(slot, location) {
    const publicOrigin = this.origin(slot);
    return String(location).replace(
      new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0):${slot.target.port}`),
      publicOrigin,
    );
  }

  upgrade(slot, req, socket, head) {
    if (!slot.target || !this.validSession(slot, req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const headers = this.upstreamHeaders(slot, req.headers);
    const upstream = net.connect(slot.target.port, "127.0.0.1", () => {
      let head0 = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(headers))
        for (const v of Array.isArray(value) ? value : [value]) head0 += `${key}: ${v}\r\n`;
      upstream.write(head0 + "\r\n");
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const end = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", end);
    socket.on("error", end);
    upstream.setTimeout(0);
  }
}

function page(res, status, title, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font:17px -apple-system,system-ui,sans-serif;background:#161618;color:#ececee;margin:0;padding:32px 20px">` +
      `<h1 style="font-size:22px;margin:0 0 12px">${title}</h1><p style="color:#98989e;line-height:1.45">${body}</p></body>`,
  );
}

export function sameSecret(a, b) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
