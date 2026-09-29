// The H.264 decoder setup (avcC) with each sequence parameter set told that
// pictures are never reordered (VUI bitstream_restriction: max_num_reorder_frames
// 0). The Mac's encoder never reorders, but does not say so, and a browser's
// decoder then holds several pictures back in case it did (about 170 ms);
// the app's native video layer shows each at once. Spec: ITU-T H.264 7.3.2.1.1
// and E.1.1.

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
  }
  bit() {
    if (this.position >= this.bytes.length * 8) throw new Error("SPS ends early");
    const value = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1;
    this.position++;
    return value;
  }
  bits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 2 + this.bit();
    return value;
  }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new Error("Bad exp-Golomb code");
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() {
    const k = this.ue();
    return k % 2 ? (k + 1) / 2 : -(k / 2);
  }
}

class BitWriter {
  constructor() {
    this.out = [];
    this.current = 0;
    this.count = 0;
  }
  bit(value) {
    this.current = (this.current << 1) | (value & 1);
    this.count++;
    if (this.count === 8) {
      this.out.push(this.current);
      this.current = 0;
      this.count = 0;
    }
  }
  bits(value, n) {
    for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(value / 2 ** i) % 2);
  }
  ue(value) {
    const v = value + 1;
    const length = Math.floor(Math.log2(v));
    this.bits(0, length);
    this.bits(v, length + 1);
  }
  /** rbsp_trailing_bits: a 1, then zeros to the byte boundary. */
  finish() {
    this.bit(1);
    while (this.count !== 0) this.bit(0);
    return Uint8Array.from(this.out);
  }
}

/** NAL payload bytes without emulation-prevention bytes (00 00 03 → 00 00). */
function toRBSP(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0 && i + 1 < nal.length && nal[i + 1] <= 3) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function toNAL(rbsp) {
  const out = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function skipScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function skipHRD(r) {
  const count = r.ue() + 1;
  r.bits(4);
  r.bits(4);
  for (let i = 0; i < count; i++) {
    r.ue();
    r.ue();
    r.bit();
  }
  r.bits(5);
  r.bits(5);
  r.bits(5);
  r.bits(5);
}

/** An SPS NAL unit (header byte included) that says pictures are never reordered. */
export function withoutReordering(sps) {
  const rbsp = toRBSP(sps);
  const r = new BitReader(rbsp);
  r.bits(8); // NAL header
  const profile = r.bits(8);
  r.bits(8);
  r.bits(8);
  r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.bit();
    r.ue();
    r.ue();
    r.bit();
    if (r.bit()) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  const refFrames = r.ue();
  r.bit();
  r.ue();
  r.ue();
  if (!r.bit()) r.bit();
  r.bit();
  if (r.bit()) for (let i = 0; i < 4; i++) r.ue();
  const vuiFlagAt = r.position;
  let keep;
  const w = new BitWriter();
  if (!r.bit()) {
    keep = vuiFlagAt;
    copy(rbsp, keep, w);
    w.bit(1); // vui_parameters_present_flag
    for (let i = 0; i < 8; i++) w.bit(0); // no aspect, overscan, signal type, chroma location, timing, HRD, pic_struct
  } else {
    if (r.bit() && r.bits(8) === 255) {
      r.bits(16);
      r.bits(16);
    }
    if (r.bit()) r.bit();
    if (r.bit()) {
      r.bits(3);
      r.bit();
      if (r.bit()) r.bits(24);
    }
    if (r.bit()) {
      r.ue();
      r.ue();
    }
    if (r.bit()) {
      r.bits(32);
      r.bits(32);
      r.bit();
    }
    const nal = r.bit();
    if (nal) skipHRD(r);
    const vcl = r.bit();
    if (vcl) skipHRD(r);
    if (nal || vcl) r.bit();
    r.bit(); // pic_struct_present_flag
    keep = r.position; // bitstream_restriction_flag and anything after it are replaced
    copy(rbsp, keep, w);
  }
  w.bit(1); // bitstream_restriction_flag
  w.bit(1); // motion_vectors_over_pic_boundaries_flag
  w.ue(2); // max_bytes_per_pic_denom
  w.ue(1); // max_bits_per_mb_denom
  w.ue(16); // log2_max_mv_length_horizontal
  w.ue(16); // log2_max_mv_length_vertical
  w.ue(0); // max_num_reorder_frames
  w.ue(Math.max(1, refFrames)); // max_dec_frame_buffering
  return toNAL(w.finish());
}

function copy(bytes, bitCount, writer) {
  for (let i = 0; i < bitCount; i++) writer.bit((bytes[i >> 3] >> (7 - (i & 7))) & 1);
}

/** The avcC decoder configuration with every SPS rewritten; the original if anything is unexpected. */
export function lowLatencyAvcC(avcC) {
  try {
    const b = avcC;
    if (b[0] !== 1 || b.length < 7) return avcC;
    const out = [b[0], b[1], b[2], b[3], b[4]];
    let offset = 5;
    const spsCount = b[offset++] & 0x1f;
    out.push(0xe0 | spsCount);
    for (let i = 0; i < spsCount; i++) {
      const length = (b[offset] << 8) | b[offset + 1];
      offset += 2;
      const sps = withoutReordering(b.subarray(offset, offset + length));
      offset += length;
      out.push(sps.length >> 8, sps.length & 0xff, ...sps);
    }
    // The picture parameter sets and any extension bytes, unchanged.
    for (let i = offset; i < b.length; i++) out.push(b[i]);
    return Uint8Array.from(out);
  } catch {
    return avcC;
  }
}
