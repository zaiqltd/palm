// Screen flow control for phones that confirm every frame.
//
// On a weak connection the screen used to become unusable. The screen went
// out at 3.5-14 Mbit/s whatever the connection could carry. At home that is
// perfect; on mobile data or Tailscale's relay the video queued for seconds
// in the tunnel, the phone's heartbeat timed out and it reconnected in a loop.
//
// Now at most MAX_IN_FLIGHT frames are unconfirmed (the Mac skips raw
// pictures until the phone has room), and the encoder's rate follows how long
// the phone takes to confirm them: down fast when frames queue, up gently when
// they arrive promptly and the stream is actually using its rate. A weak link
// gets a softer picture instead of a frozen one.

export const MAX_IN_FLIGHT = 6;
export const MIN_BITRATE = 300_000;
export const MAX_BITRATE = 14_000_000;
export const START_BITRATE = 3_000_000;
// Queueing (median confirmation time above the best recent one) that lowers
// or allows raising the rate, in milliseconds.
const QUEUED_HIGH = 150;
const QUEUED_LOW = 60;
// Slower than this is too slow to use, whatever the best recent time was
// (a queue that never empties would otherwise look normal).
const CONFIRM_TOO_SLOW = 800;
// A reconnect on the same network starts where the last session ended.
const REMEMBER_MS = 10 * 60_000;
const remembered = new Map();

export class ScreenFlow {
  constructor(key, now = Date.now()) {
    const known = remembered.get(key);
    this.key = key;
    this.bitrate = known && now - known.at < REMEMBER_MS ? known.bitrate : START_BITRATE;
    this.sent = 0;
    this.acked = 0;
    this.pending = [];
    this.samples = [];
    this.bytes = 0;
    this.minima = [];
    this.base = null;
    this.median = null;
    this.lastSent = now;
    this.opened = now;
    this.totals = { frames: 0, bytes: 0, lowered: 0, raised: 0, lowest: this.bitrate, started: this.bitrate };
  }

  sentFrame(bytes, now = Date.now()) {
    this.sent++;
    this.pending.push({ sequence: this.sent, bytes, at: now });
    this.lastSent = now;
    this.totals.frames++;
    this.totals.bytes += bytes;
  }

  /** The phone has received `count` frames of this stream (cumulative). Returns how many were released. */
  ack(count, now = Date.now()) {
    if (!Number.isSafeInteger(count) || count <= this.acked || count > this.sent) return 0;
    let released = 0;
    while (this.pending.length && this.pending[0].sequence <= count) {
      const frame = this.pending.shift();
      released++;
      this.samples.push(now - frame.at);
      this.bytes += frame.bytes;
    }
    this.acked = count;
    return released;
  }

  /** Once a second. Returns the new rate when it should change, otherwise null. */
  tick() {
    const samples = this.samples.splice(0).sort((a, b) => a - b);
    const bits = this.bytes * 8;
    this.bytes = 0;
    // A still screen sends almost nothing and says nothing about the link.
    if (samples.length < 3) return null;
    this.minima.push(samples[0]);
    if (this.minima.length > 10) this.minima.shift();
    this.base = Math.min(...this.minima);
    this.median = samples[samples.length >> 1];
    const queued = this.median - this.base;
    let next = this.bitrate;
    // What arrived in the last second is about what the link carries, but
    // at most half the rate goes in one second: a short hiccup on mobile data
    // should not leave the picture at its softest while it climbs back.
    if (queued > QUEUED_HIGH || this.median > CONFIRM_TOO_SLOW)
      next = Math.max(this.bitrate * 0.5, Math.min(this.bitrate * 0.75, bits * 0.85));
    else if (queued < QUEUED_LOW && bits > this.bitrate * 0.4) next = this.bitrate * 1.2;
    next = Math.round(Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, next)));
    if (Math.abs(next - this.bitrate) < this.bitrate * 0.05) return null;
    if (next < this.bitrate) this.totals.lowered++;
    else this.totals.raised++;
    this.bitrate = next;
    this.totals.lowest = Math.min(this.totals.lowest, next);
    return next;
  }

  close(now = Date.now()) {
    remembered.set(this.key, { bitrate: this.bitrate, at: now });
  }

  /** Counts and timings only. */
  snapshot(now = Date.now()) {
    const seconds = Math.max(1, (now - this.opened) / 1000);
    return {
      bitrate: this.bitrate,
      inFlight: this.pending.length,
      confirmMs: this.median,
      bestConfirmMs: this.base,
      frames: this.totals.frames,
      kbps: Math.round((this.totals.bytes * 8) / seconds / 1000),
      lowered: this.totals.lowered,
      raised: this.totals.raised,
      lowest: this.totals.lowest,
      started: this.totals.started,
    };
  }
}
