import test from "node:test";
import assert from "node:assert/strict";
import { ScreenFlow, MAX_IN_FLIGHT, MIN_BITRATE, MAX_BITRATE, START_BITRATE } from "../server/screen-flow.mjs";

// One second of frames: `frames` sent `spacing` ms apart, each confirmed `delay(i)` ms later.
function second(flow, t, { frames = 30, bytes = 12000, delay = () => 40 } = {}) {
  for (let i = 0; i < frames; i++) {
    const at = t + i * (1000 / frames);
    flow.sentFrame(bytes, at);
    assert.equal(flow.ack(flow.sent, at + delay(i)), 1);
  }
  return flow.tick();
}

test("confirmations release frames in order and never beyond what was sent", () => {
  const flow = new ScreenFlow("order", 0);
  for (let i = 0; i < MAX_IN_FLIGHT; i++) flow.sentFrame(1000, i);
  assert.equal(flow.ack(0, 10), 0);
  assert.equal(flow.ack(MAX_IN_FLIGHT + 1, 10), 0, "cannot confirm a frame never sent");
  assert.equal(flow.ack(2.5, 10), 0);
  assert.equal(flow.ack("3", 10), 0);
  assert.equal(flow.ack(3, 10), 3);
  assert.equal(flow.ack(3, 11), 0, "a repeated confirmation releases nothing");
  assert.equal(flow.ack(2, 11), 0);
  assert.equal(flow.pending.length, MAX_IN_FLIGHT - 3);
  assert.equal(flow.ack(MAX_IN_FLIGHT, 12), 3);
  assert.equal(flow.pending.length, 0);
});

test("a still screen changes nothing", () => {
  const flow = new ScreenFlow("still", 0);
  assert.equal(second(flow, 0, { frames: 2, delay: () => 2000 }), null);
  assert.equal(flow.tick(), null);
  assert.equal(flow.bitrate, START_BITRATE);
});

test("queueing lowers the rate to about what the link carried, down to the floor", () => {
  const flow = new ScreenFlow("slow", 0);
  // Prompt at first, then each frame waits behind the last (a link slower than the stream).
  assert.equal(second(flow, 0, { bytes: 3000, delay: () => 60 }), null);
  const lowered = second(flow, 1000, { bytes: 4000, delay: (i) => 60 + i * 40 });
  // What arrived (0.8 Mbit/s) is below half the rate: at most half goes in one second.
  assert.equal(lowered, START_BITRATE / 2);
  const next = second(flow, 2000, { bytes: 4000, delay: (i) => 60 + i * 40 });
  assert.ok(next <= 30 * 4000 * 8 * 0.85 + 1 && next >= START_BITRATE / 4, `then ${next}, about what arrived`);
  let t = 3000;
  for (let i = 0; i < 20; i++, t += 1000) second(flow, t, { bytes: 500, delay: (n) => 60 + n * 40 });
  assert.equal(flow.bitrate, MIN_BITRATE);
  assert.ok(flow.snapshot(t).lowered >= 2);
});

test("confirmations slower than 0.8 s lower the rate even when steady", () => {
  const flow = new ScreenFlow("standing", 0);
  assert.ok(second(flow, 0, { delay: () => 1200 }) < START_BITRATE);
});

test("prompt confirmations raise the rate only while the stream uses it", () => {
  const flow = new ScreenFlow("fast", 0);
  // Typing: small frames, nowhere near the rate. Held.
  assert.equal(second(flow, 0, { frames: 10, bytes: 800, delay: () => 30 }), null);
  // Scrolling at the rate, confirmed promptly: raised, up to the ceiling.
  const raised = second(flow, 1000, { bytes: 15000, delay: () => 30 });
  assert.equal(raised, Math.round(START_BITRATE * 1.2));
  let t = 2000;
  for (let i = 0; i < 30; i++, t += 1000) second(flow, t, { bytes: Math.ceil(flow.bitrate / 8 / 30), delay: () => 30 });
  assert.equal(flow.bitrate, MAX_BITRATE);
});

test("a reconnect starts at the rate the last session ended on", () => {
  const flow = new ScreenFlow("again", 0);
  second(flow, 0, { bytes: 3000, delay: () => 60 });
  second(flow, 1000, { bytes: 4000, delay: (i) => 60 + i * 40 });
  const ended = flow.bitrate;
  flow.close(5000);
  assert.equal(new ScreenFlow("again", 60_000).bitrate, ended);
  assert.equal(new ScreenFlow("again", 5000 + 11 * 60_000).bitrate, START_BITRATE, "forgotten after ten minutes");
  assert.equal(new ScreenFlow("someone else", 6000).bitrate, START_BITRATE);
});
