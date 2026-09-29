// The avcC rewrite that tells a browser's decoder pictures are never
// reordered (src/phone/core/h264.js): the Mac's real setup, and one with a
// VUI already present, both come back with max_num_reorder_frames 0 and every
// other field unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { lowLatencyAvcC } from "../src/phone/core/h264.js";

function reader(bytes) {
  const rbsp = [];
  for (let i = 0; i < bytes.length; i++) {
    if (i >= 2 && bytes[i] === 3 && bytes[i - 1] === 0 && bytes[i - 2] === 0 && i + 1 < bytes.length && bytes[i + 1] <= 3) continue;
    rbsp.push(bytes[i]);
  }
  let p = 0;
  const bit = () => (rbsp[p >> 3] >> (7 - (p++ & 7))) & 1;
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
  const ue = () => { let z = 0; while (!bit()) z++; return 2 ** z - 1 + bits(z); };
  return { bit, bits, ue, se: () => { const k = ue(); return k % 2 ? (k + 1) / 2 : -(k / 2); } };
}

/** Reads a baseline-profile SPS (what the Mac sends) into its fields. */
function parse(sps) {
  const r = reader(sps);
  const f = { header: r.bits(8), profile: r.bits(8), constraints: r.bits(8), level: r.bits(8), id: r.ue(), log2MaxFrameNum: r.ue(), pocType: r.ue() };
  if (f.pocType === 0) f.log2MaxPoc = r.ue();
  f.refFrames = r.ue();
  f.gaps = r.bit();
  f.widthMbs = r.ue();
  f.heightMbs = r.ue();
  f.frameMbsOnly = r.bit();
  if (!f.frameMbsOnly) f.mbaff = r.bit();
  f.direct8x8 = r.bit();
  f.cropping = r.bit();
  if (f.cropping) f.crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  f.vui = r.bit();
  if (f.vui) {
    f.aspect = r.bit();
    if (f.aspect) f.aspectIdc = r.bits(8);
    f.overscan = r.bit();
    f.signal = r.bit();
    if (f.signal) {
      f.format = r.bits(3);
      f.fullRange = r.bit();
      f.colour = r.bit();
      if (f.colour) f.colourValues = [r.bits(8), r.bits(8), r.bits(8)];
    }
    f.chromaLoc = r.bit();
    f.timing = r.bit();
    if (f.timing) f.timingValues = [r.bits(32), r.bits(32), r.bit()];
    f.nalHrd = r.bit();
    f.vclHrd = r.bit();
    f.picStruct = r.bit();
    f.restriction = r.bit();
    if (f.restriction) f.restrictionValues = { mvOverBoundaries: r.bit(), bytesDenom: r.ue(), bitsDenom: r.ue(), mvH: r.ue(), mvV: r.ue(), reorder: r.ue(), decBuffering: r.ue() };
  }
  return f;
}

const firstSPS = (avcC) => avcC.subarray(8, 8 + ((avcC[6] << 8) | avcC[7]));
const b64 = (text) => Uint8Array.from(Buffer.from(text, "base64"));

test("the Mac's own setup (baseline, no VUI) gains no-reordering and keeps its fields", () => {
  // Captured from the test host's stream (the same encoder as a real Mac).
  const avcC = b64("AUIAIP/hAAonQgAgq0AoAyyAAQAEKM48gA==");
  const before = parse(firstSPS(avcC));
  const out = lowLatencyAvcC(avcC);
  const after = parse(firstSPS(out));
  assert.equal(before.vui, 0);
  assert.equal(after.restrictionValues.reorder, 0);
  assert.equal(after.restrictionValues.decBuffering, Math.max(1, before.refFrames));
  for (const key of ["profile", "constraints", "level", "id", "refFrames", "widthMbs", "heightMbs", "frameMbsOnly", "cropping", "pocType"])
    assert.deepEqual(after[key], before[key], key);
  // The picture parameter set after it is unchanged.
  const tail = (b) => b.subarray(8 + ((b[6] << 8) | b[7]));
  assert.deepEqual([...tail(out)], [...tail(avcC)]);
});

test("an SPS that already has a VUI (colour and timing) keeps it and gains the restriction", () => {
  // Build a baseline SPS with a VUI: colour description and timing, no restriction.
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) % 2); };
  const ue = (v) => { const x = v + 1; const n = Math.floor(Math.log2(x)); put(0, n); put(x, n + 1); };
  put(0x67, 8); put(66, 8); put(0xc0, 8); put(31, 8); ue(0); ue(0); ue(2); ue(1); put(0, 1); ue(119); ue(67); put(1, 1); put(1, 1); put(0, 1);
  put(1, 1); // vui present
  put(0, 1); put(0, 1); put(1, 1); put(5, 3); put(0, 1); put(1, 1); put(1, 8); put(1, 8); put(1, 8); // signal type + colour
  put(0, 1); put(1, 1); put(1, 32); put(60, 32); put(0, 1); // timing
  put(0, 1); put(0, 1); put(0, 1); put(0, 1); // no HRD, no pic_struct, no restriction
  put(1, 1); while (bits.length % 8) put(0, 1);
  const sps = Uint8Array.from({ length: bits.length / 8 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2));
  const pps = Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
  const avcC = Uint8Array.from([1, 66, 0xc0, 31, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps]);
  const before = parse(sps);
  const after = parse(firstSPS(lowLatencyAvcC(avcC)));
  assert.equal(before.restriction, 0);
  assert.deepEqual(after.colourValues, before.colourValues);
  assert.deepEqual(after.timingValues, before.timingValues);
  assert.equal(after.restriction, 1);
  assert.equal(after.restrictionValues.reorder, 0);
  assert.equal(after.widthMbs, 119);
});

test("anything unexpected is passed through unchanged", () => {
  const junk = Uint8Array.from([2, 1, 2, 3]);
  assert.equal(lowLatencyAvcC(junk), junk);
});
