// The live Mac picture and every gesture on it: the web version of
// PalmRemoteSurface / PalmSurfaceView. Imperative (pointer events, CSS
// transforms) so touches never wait for React.
//
// Touch mode: tap to click, double-tap to select a word, drag one finger to
// scroll, hold to right-click, hold then move to drag; two fingers move the
// enlarged picture; pinch zooms. Mouse mode: one finger moves the pointer
// (with acceleration), tap clicks, two fingers scroll, hold then move drags.

const HOLD_MS = 450;
const HOLD_SLOP = 12;
const PAN_SLOP = 10;
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_DISTANCE = 32;

export function framingZoom(framing, source, viewport) {
  if (!(source.width > 0 && source.height > 0 && viewport.width > 0 && viewport.height > 0)) return 1;
  const fit = Math.min(viewport.width / source.width, viewport.height / source.height);
  if (framing !== "readable") return 1;
  // Use the whole viewport without stretching; the extra is reachable by panning.
  const readable = Math.max(viewport.width / source.width, viewport.height / source.height);
  return Math.min(8, Math.max(1, readable / fit));
}

const cursorSVG =
  '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M5 3 L5 18 L9 14.2 L11.6 20 L14.2 18.9 L11.6 13.2 L17 13.2 Z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>';

export class RemoteSurface {
  constructor(host, video) {
    this.host = host;
    this.video = video;
    this.content = document.createElement("div");
    this.content.className = "remote-content";
    this.content.setAttribute("role", "img");
    this.content.setAttribute("aria-label", "Live Mac screen");
    this.content.appendChild(video.canvas);
    host.appendChild(this.content);
    this.feedback = document.createElement("div");
    this.feedback.className = "remote-feedback";
    host.appendChild(this.feedback);
    this.cursorView = document.createElement("div");
    this.cursorView.className = "remote-cursor";
    this.cursorView.innerHTML = cursorSVG;
    this.cursorView.hidden = true;
    host.appendChild(this.cursorView);
    this.overview = document.createElement("canvas");
    this.overview.className = "remote-overview";
    this.overview.width = 200;
    this.overview.height = 132;
    this.overview.setAttribute("aria-label", "Zoom map");
    this.overview.dataset.id = "remote.overview";
    host.appendChild(this.overview);

    this.source = { width: 1280, height: 800 };
    this.bounds = { width: 0, height: 0 };
    this.fitted = { width: 1, height: 1 };
    this.zoom = 1;
    this.offset = { x: 0, y: 0 };
    this.maxZoom = 4;
    this.mode = "touch";
    this.enabled = false;
    this.framing = "fit";
    this.pendingFraming = "fit";
    this.typing = false;
    this.focus = null;
    this.obscured = { top: 0, right: 0, bottom: 0, left: 0 };
    this.mapCorner = null;
    this.cursor = { x: 0.5, y: 0.5 };
    this.previousTap = null;
    this.pointers = new Map();
    this.gesture = null;
    this.dragPoint = null;
    this.reportedZoom = 0;
    this.pinching = false;
    // Handlers set by the view.
    this.onPointer = () => {};
    this.onScroll = () => {};
    this.onZoom = () => {};
    this.onSelected = () => {};
    this.onCancelSession = () => {};

    host.addEventListener("pointerdown", (e) => this.pointerDown(e));
    host.addEventListener("pointermove", (e) => this.pointerMove(e));
    host.addEventListener("pointerup", (e) => this.pointerUp(e));
    host.addEventListener("pointercancel", (e) => this.pointerCancel(e));
    host.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    host.addEventListener("contextmenu", (e) => e.preventDefault());
    // Safari's own page pinch never happens over the picture.
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) host.addEventListener(type, (e) => e.preventDefault());
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(host);
  }

  destroy() {
    this.resizeObserver.disconnect();
    if (this.dragPoint) {
      this.dragPoint = null;
      this.onCancelSession();
    }
    this.content.remove();
  }

  // ---- Configuration from the view ----

  configure({ size, enabled, mode, framing, reframeID, typing, obscured, mapCorner }) {
    const valid = size && size.width > 0 && size.height > 0 ? size : { width: 1280, height: 800 };
    let relayout = false;
    if (valid.width !== this.source.width || valid.height !== this.source.height) {
      // A sharper stream of the same shape keeps the zoom and position.
      const reshaped = Math.abs(valid.width / valid.height - this.source.width / this.source.height) > 0.01;
      this.source = { ...valid };
      if (reshaped) {
        this.pendingFraming = this.framing;
        relayout = true;
      }
    }
    if (mode !== this.mode) {
      this.finishDrag();
      this.previousTap = null;
      this.mode = mode;
      this.cursorView.hidden = mode !== "trackpad";
      this.positionCursor();
    }
    if (!enabled) {
      this.previousTap = null;
      if (this.dragPoint) {
        this.dragPoint = null;
        this.onCancelSession();
      }
    }
    this.enabled = enabled;
    if (framing !== this.framing || reframeID !== this.reframeID) {
      this.framing = framing;
      this.reframeID = reframeID;
      this.pendingFraming = framing;
      relayout = true;
    }
    if (typing !== this.typing) {
      this.typing = typing;
      this.pendingFraming = this.pendingFraming ?? this.framing;
      relayout = true;
    }
    if (obscured && (obscured.top !== this.obscured.top || obscured.bottom !== this.obscured.bottom || obscured.left !== this.obscured.left || obscured.right !== this.obscured.right)) {
      this.obscured = { ...obscured };
      relayout = true;
    }
    if (JSON.stringify(mapCorner) !== JSON.stringify(this.mapCorner)) {
      this.mapCorner = mapCorner;
      relayout = true;
    }
    if (relayout) this.layout(true);
    else this.render();
  }

  /** Shows a place on the Mac screen (the Dock, the menu bar) at a readable size. */
  focusEdge(point) {
    if (!point) return;
    this.focus = point;
    const fill = framingZoom("readable", this.source, this.bounds);
    this.setZoom(Math.min(this.maxZoom, Math.max(fill, 1)));
    this.offset = this.offsetShowing(point, this.zoom);
    this.clamp();
    this.render();
  }

  // ---- Geometry ----

  get free() {
    const b = this.bounds;
    const o = this.obscured;
    const free = { minX: o.left, minY: o.top, maxX: b.width - o.right, maxY: b.height - o.bottom };
    return free.maxX - free.minX > 120 && free.maxY - free.minY > 120 ? free : { minX: 0, minY: 0, maxX: b.width, maxY: b.height };
  }

  layout(force = false) {
    const rect = this.host.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    const changed = rect.width !== this.bounds.width || rect.height !== this.bounds.height;
    this.bounds = { width: rect.width, height: rect.height };
    if (!changed && !force && this.pendingFraming === null) return this.render();
    if (changed || this.pendingFraming !== null) {
      this.finishDrag();
      this.previousTap = null;
      const ratio = Math.min(rect.width / this.source.width, rect.height / this.source.height);
      this.fitted = { width: this.source.width * ratio, height: this.source.height * ratio };
      this.content.style.width = `${this.fitted.width}px`;
      this.content.style.height = `${this.fitted.height}px`;
      const desired = this.pendingFraming ?? this.framing;
      this.pendingFraming = null;
      const zoom = framingZoom(desired, this.source, this.bounds);
      this.maxZoom = Math.max(4, Math.min(16, framingZoom("readable", this.source, this.bounds) * 2));
      if (this.typing && this.focus) {
        // Keyboard up: zoom until the source fills the width, at least 1.6x,
        // and keep the field being typed into in view.
        const fill = framingZoom("readable", this.source, this.bounds);
        this.setZoom(Math.min(this.maxZoom, Math.max(zoom, fill, 1.6)));
        this.offset = this.offsetShowing(this.focus, this.zoom);
      } else {
        this.setZoom(zoom);
        this.offset = { x: (this.bounds.width - this.fitted.width * this.zoom) / 2, y: (this.bounds.height - this.fitted.height * this.zoom) / 2 };
      }
    }
    this.clamp();
    this.render();
  }

  setZoom(z) {
    this.zoom = Math.min(this.maxZoom, Math.max(1, z));
  }

  /** Where the content's top-left goes so a Mac point (0...1) is in the free area. */
  offsetShowing(point, zoom) {
    const f = this.free;
    const w = this.fitted.width * zoom;
    const h = this.fitted.height * zoom;
    const x = point.x <= 0.01 ? f.minX : point.x >= 0.99 ? f.maxX - w : (f.minX + f.maxX) / 2 - point.x * w;
    const y = point.y <= 0.01 ? f.minY : point.y >= 0.99 ? f.maxY - h : (f.minY + f.maxY) / 2 - point.y * h;
    return { x, y };
  }

  /** Centres a picture smaller than the free space; zoomed in, any corner can reach the middle. */
  clamp() {
    const f = this.free;
    const b = this.bounds;
    const axis = (size, total, start, end, offset) => {
      const open = end - start;
      if (size <= open + 0.5) return start + (open - size) / 2;
      let pad = Math.max(0, (total - size) / 2);
      let lead = pad;
      let trail = pad;
      if (this.zoom > 1.01) {
        lead = Math.max(lead, total * 0.45);
        trail = Math.max(trail, total * 0.45);
      }
      return Math.min(lead, Math.max(total - size - trail, offset));
    };
    this.offset = {
      x: axis(this.fitted.width * this.zoom, b.width, f.minX, f.maxX, this.offset.x),
      y: axis(this.fitted.height * this.zoom, b.height, f.minY, f.maxY, this.offset.y),
    };
  }

  render() {
    this.content.style.transform = `translate3d(${this.offset.x}px, ${this.offset.y}px, 0) scale(${this.zoom})`;
    this.positionCursor();
    this.drawOverview();
    if (Math.abs(this.zoom - this.reportedZoom) > 0.05 && !this.pinching) {
      this.reportedZoom = this.zoom;
      this.onZoom(this.zoom);
    }
  }

  /** A point in the host (client-relative) to the Mac screen's 0...1, or null outside it. */
  normalized(clientX, clientY, clampToEdges = false) {
    const rect = this.host.getBoundingClientRect();
    const x = (clientX - rect.left - this.offset.x) / (this.fitted.width * this.zoom);
    const y = (clientY - rect.top - this.offset.y) / (this.fitted.height * this.zoom);
    if (clampToEdges) return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    if (!(x >= 0 && y >= 0 && x <= 1 && y <= 1)) return null;
    return { x, y };
  }

  local(clientX, clientY) {
    const rect = this.host.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  shownSize() {
    return { width: Math.max(1, this.fitted.width * this.zoom), height: Math.max(1, this.fitted.height * this.zoom) };
  }

  cursorPoint() {
    return { x: this.offset.x + this.cursor.x * this.fitted.width * this.zoom, y: this.offset.y + this.cursor.y * this.fitted.height * this.zoom };
  }

  positionCursor() {
    if (this.mode !== "trackpad") return;
    const p = this.cursorPoint();
    // The arrow's hotspot is its top-left tip.
    this.cursorView.style.transform = `translate3d(${p.x - 5}px, ${p.y - 3}px, 0)`;
  }

  visibleRect() {
    const w = this.fitted.width * this.zoom;
    const h = this.fitted.height * this.zoom;
    const x0 = Math.max(0, -this.offset.x / w);
    const y0 = Math.max(0, -this.offset.y / h);
    const x1 = Math.min(1, (this.bounds.width - this.offset.x) / w);
    const y1 = Math.min(1, (this.bounds.height - this.offset.y) / h);
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  drawOverview() {
    const r = this.visibleRect();
    const hidden = r.width <= 0 || r.height <= 0 || (r.width >= 0.995 && r.height >= 0.995);
    this.overview.hidden = hidden;
    if (hidden) return;
    // The top corner of the space the floating controls leave free.
    const corner = this.mapCorner;
    if (corner) {
      this.overview.style.left = `${this.bounds.width - corner.x - 100}px`;
      this.overview.style.top = `${corner.y}px`;
    } else {
      const f = this.free;
      this.overview.style.left = `${f.maxX - 108}px`;
      this.overview.style.top = `${f.minY + 8}px`;
    }
    const ctx = this.overview.getContext("2d");
    const W = 200, H = 132, inset = 14;
    ctx.clearRect(0, 0, W, H);
    const scale = Math.min((W - 2 * inset) / this.source.width, (H - 2 * inset) / this.source.height);
    const w = this.source.width * scale, h = this.source.height * scale;
    const x = (W - w) / 2, y = (H - h) / 2;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = "rgba(237,237,237,0.22)";
    ctx.strokeStyle = "#ededed";
    ctx.fillRect(x + r.x * w, y + r.y * h, r.width * w, r.height * h);
    ctx.strokeRect(x + r.x * w, y + r.y * h, r.width * w, r.height * h);
    if (this.mode === "trackpad") {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x + this.cursor.x * w, y + this.cursor.y * h, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A brief ring where input landed, so every tap is visibly acknowledged. */
  showFeedback(point, accent = false) {
    const ring = document.createElement("span");
    ring.className = accent ? "tap-ring accent" : "tap-ring";
    ring.style.left = `${point.x}px`;
    ring.style.top = `${point.y}px`;
    this.feedback.appendChild(ring);
    setTimeout(() => ring.remove(), 400);
  }

  // ---- Gestures ----

  pointerDown(e) {
    if (e.pointerType === "mouse" && e.button === 1) return;
    this.host.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, time: e.timeStamp });
    if (this.pointers.size === 1) {
      const start = this.local(e.clientX, e.clientY);
      this.gesture = { kind: "pending", start, startClient: { x: e.clientX, y: e.clientY }, last: start, time: e.timeStamp, button: e.button, mouse: e.pointerType === "mouse" };
      clearTimeout(this.holdTimer);
      // A right mouse button is an immediate right-click.
      if (e.pointerType === "mouse" && e.button === 2) {
        this.gesture.kind = "done";
        this.activatePointer(start, "right");
        this.showFeedback(this.mode === "trackpad" ? this.cursorPoint() : start, true);
        return;
      }
      this.holdTimer = setTimeout(() => {
        if (this.gesture?.kind === "pending" && this.enabled) {
          this.previousTap = null;
          this.gesture.kind = "hold";
          this.gesture.holdStart = this.gesture.last;
          this.gesture.dragging = false;
        }
      }, e.pointerType === "mouse" ? 250 : HOLD_MS);
    } else if (this.pointers.size === 2) {
      clearTimeout(this.holdTimer);
      this.finishDrag();
      this.previousTap = null;
      this.onSelected(null);
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: "two",
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        startMid: this.local((a.x + b.x) / 2, (a.y + b.y) / 2),
        lastMid: this.local((a.x + b.x) / 2, (a.y + b.y) / 2),
        startZoom: this.zoom,
        startOffset: { ...this.offset },
        pinching: false,
      };
    }
  }

  pointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      // A mouse moving without a button in Mouse mode moves the Mac pointer.
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "two" && this.pointers.size >= 2) return this.twoFingerMove();
    const point = this.local(e.clientX, e.clientY);
    const delta = { x: point.x - g.last.x, y: point.y - g.last.y };
    g.last = point;
    if (!this.enabled) return;
    if (g.kind === "pending") {
      if (Math.hypot(point.x - g.start.x, point.y - g.start.y) <= (g.mouse ? 4 : PAN_SLOP)) return;
      clearTimeout(this.holdTimer);
      this.previousTap = null;
      this.onSelected(null);
      if (g.mouse && this.mode !== "trackpad") {
        // A mouse drag (testing on a Mac, iPad trackpad): a real drag.
        g.kind = "hold";
        g.holdStart = g.start;
        g.dragging = false;
      } else {
        g.kind = "pan";
        if (this.mode === "touch") {
          // Validate the actual start, not a finger that crossed from the letterbox.
          const start = this.normalized(g.startClient.x, g.startClient.y);
          g.scrolling = !!start;
          if (start) this.onPointer("move", start.x, start.y);
        }
      }
    }
    if (g.kind === "hold") {
      if (!g.dragging && Math.hypot(point.x - g.holdStart.x, point.y - g.holdStart.y) > 8) {
        g.dragging = true;
        if (this.mode === "trackpad") {
          this.dragPoint = { ...this.cursor };
          this.onPointer("down", this.cursor.x, this.cursor.y);
        } else {
          const start = this.normalized(g.startClient.x, g.startClient.y);
          if (start) {
            this.dragPoint = start;
            this.onPointer("down", start.x, start.y);
          }
        }
      }
      if (g.dragging && this.dragPoint) {
        if (this.mode === "trackpad") {
          const shown = this.shownSize();
          this.cursor = { x: Math.min(1, Math.max(0, this.cursor.x + delta.x / shown.width)), y: Math.min(1, Math.max(0, this.cursor.y + delta.y / shown.height)) };
          this.dragPoint = { ...this.cursor };
          this.onPointer("move", this.cursor.x, this.cursor.y);
          this.positionCursor();
        } else {
          const n = this.normalized(e.clientX, e.clientY, true);
          this.dragPoint = n;
          this.onPointer("move", n.x, n.y);
        }
      }
      return;
    }
    if (g.kind === "pan") {
      if (this.mode === "touch") {
        if (g.scrolling) this.onScroll(delta.x, delta.y);
      } else {
        // Pointer acceleration: slow movement is precise, a flick crosses the screen.
        const speed = Math.hypot(delta.x, delta.y);
        const gain = Math.min(3.2, 1 + speed / 16);
        const shown = this.shownSize();
        this.cursor = {
          x: Math.min(1, Math.max(0, this.cursor.x + (delta.x * gain) / shown.width)),
          y: Math.min(1, Math.max(0, this.cursor.y + (delta.y * gain) / shown.height)),
        };
        this.focus = { ...this.cursor };
        this.onPointer("move", this.cursor.x, this.cursor.y);
        this.revealCursor();
      }
    }
  }

  twoFingerMove() {
    const g = this.gesture;
    const [a, b] = [...this.pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = this.local((a.x + b.x) / 2, (a.y + b.y) / 2);
    const ratio = distance / Math.max(1, g.startDistance);
    if (!g.pinching && Math.abs(ratio - 1) > 0.06) {
      g.pinching = true;
      this.pinching = true;
    }
    if (g.pinching) {
      const zoom = Math.min(this.maxZoom * 1.15, Math.max(0.85, g.startZoom * ratio));
      // The Mac point under the fingers stays under them.
      const contentX = (g.startMid.x - g.startOffset.x) / g.startZoom;
      const contentY = (g.startMid.y - g.startOffset.y) / g.startZoom;
      this.zoom = zoom;
      this.offset = { x: mid.x - contentX * zoom, y: mid.y - contentY * zoom };
      this.content.style.transform = `translate3d(${this.offset.x}px, ${this.offset.y}px, 0) scale(${this.zoom})`;
      this.positionCursor();
      this.drawOverview();
    } else if (this.mode === "trackpad") {
      // Mouse mode: two fingers scroll the Mac.
      if (this.enabled) this.onScroll(mid.x - g.lastMid.x, mid.y - g.lastMid.y);
    } else {
      // Touch mode: two fingers move the enlarged picture.
      this.offset = { x: this.offset.x + (mid.x - g.lastMid.x), y: this.offset.y + (mid.y - g.lastMid.y) };
      this.clamp();
      this.render();
    }
    g.lastMid = mid;
  }

  pointerUp(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!p || !g) return;
    if (g.kind === "two") {
      if (this.pointers.size < 2) {
        if (g.pinching) {
          // Settle into range, as a scroll view's zoom bounces back.
          this.pinching = false;
          this.setZoom(this.zoom);
          this.clamp();
          this.render();
        }
        this.gesture = this.pointers.size ? { kind: "done" } : null;
      }
      return;
    }
    clearTimeout(this.holdTimer);
    const point = this.local(e.clientX, e.clientY);
    if (!this.enabled) {
      this.gesture = null;
      return;
    }
    if (g.kind === "pending") {
      this.tap(g.start, e.timeStamp);
    } else if (g.kind === "hold") {
      if (g.dragging) {
        this.finishDrag();
        // Dragging usually selects text: offer Copy where the finger lifted.
        this.onSelected(this.mode === "trackpad" ? this.cursorPoint() : point);
      } else {
        this.activatePointer(g.holdStart, "right");
        this.showFeedback(this.mode === "trackpad" ? this.cursorPoint() : g.holdStart, true);
      }
    } else if (g.kind === "pan") {
      this.finishDrag();
    }
    this.gesture = null;
  }

  pointerCancel(e) {
    this.pointers.delete(e.pointerId);
    clearTimeout(this.holdTimer);
    if (this.gesture?.kind === "two" && this.pinching) {
      this.pinching = false;
      this.setZoom(this.zoom);
      this.clamp();
      this.render();
    }
    this.finishDrag();
    this.gesture = null;
  }

  /** The first click goes at once; a nearby second tap sends the Mac's double-click. */
  tap(point, time) {
    const location = this.mode === "trackpad" ? { ...this.cursor } : this.normalized(point.x + this.host.getBoundingClientRect().left, point.y + this.host.getBoundingClientRect().top);
    if (!location) {
      this.previousTap = null;
      return;
    }
    const second = this.previousTap && time - this.previousTap.time >= 0 && time - this.previousTap.time <= DOUBLE_TAP_MS && Math.hypot(point.x - this.previousTap.point.x, point.y - this.previousTap.point.y) <= DOUBLE_TAP_DISTANCE;
    this.previousTap = second ? null : { point, time };
    this.focus = location;
    this.onPointer(second ? "doubleSecond" : "click", location.x, location.y);
    const shown = this.mode === "trackpad" ? this.cursorPoint() : point;
    this.showFeedback(shown);
    this.onSelected(second ? shown : null);
  }

  activatePointer(point, action) {
    const location = this.mode === "trackpad" ? { ...this.cursor } : this.normalized(point.x + this.host.getBoundingClientRect().left, point.y + this.host.getBoundingClientRect().top);
    if (location) this.onPointer(action, location.x, location.y);
  }

  finishDrag() {
    const point = this.dragPoint;
    if (!point) return;
    this.dragPoint = null;
    if (this.enabled) this.onPointer("up", point.x, point.y);
    else this.onCancelSession();
  }

  /** Keeps the Mouse-mode pointer in view: the picture follows it near the edges. */
  revealCursor() {
    const p = this.cursorPoint();
    const margin = Math.min(36, Math.min(this.bounds.width, this.bounds.height) / 4);
    const dx = p.x - Math.min(this.bounds.width - margin, Math.max(margin, p.x));
    const dy = p.y - Math.min(this.bounds.height - margin, Math.max(margin, p.y));
    if (dx || dy) {
      this.offset = { x: this.offset.x - dx, y: this.offset.y - dy };
      this.clamp();
    }
    this.render();
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // A trackpad pinch on a Mac or iPad arrives as ctrl+wheel: zoom the picture.
      const point = this.local(e.clientX, e.clientY);
      const before = this.zoom;
      this.setZoom(this.zoom * Math.exp(-e.deltaY / 200));
      const cx = (point.x - this.offset.x) / before;
      const cy = (point.y - this.offset.y) / before;
      this.offset = { x: point.x - cx * this.zoom, y: point.y - cy * this.zoom };
      this.clamp();
      this.render();
      return;
    }
    if (this.enabled) this.onScroll(-e.deltaX, -e.deltaY);
  }
}
