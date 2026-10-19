// WAV and file-name tests: pulls parseWav, wavBuffer and cleanBase out of index.html and feeds them crafted inputs
// (odd chunk sizes, short fmt chunks, zero channels, wide containers, half floats, stereo; "..", device names, Unicode).
//   node tools/io.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
// a top-level function's source: from "function name(" to the "}" that closes it at column 0
const fn = name => { const i = html.indexOf(`\nfunction ${name}(`); assert(i >= 0, name); return html.slice(i, html.indexOf("\n}\n", i) + 3); };
const { parseWav, wavBuffer, cleanBase } = new Function(`${fn("parseWav")}${fn("wavBuffer")}${fn("cleanBase")}return { parseWav, wavBuffer, cleanBase };`)();
const line = name => { const m = html.match(new RegExp(`\\nfunction ${name}\\(.*\\n`)); assert(m, name); return m[0]; }; // one-line helpers
const { micTake } = new Function(`${line("peak")}${line("removeDC")}${fn("micTake")}return { micTake };`)();

let fails = 0;
const test = (name, f) => { try { f(); console.log("ok  ", name); } catch (e) { fails++; console.log("FAIL", name, "\n     ", e.message); } };
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) <= eps, `${a} != ${b}`);

// a RIFF/WAVE file from [id, bytes] chunks, padded the way the caller says (pad: false leaves odd chunks unpadded)
function riff(chunks, { pad = true } = {}) {
  const body = [];
  for (const [id, b] of chunks) {
    const h = new Uint8Array(8); h.set([...id].map(c => c.charCodeAt(0))); new DataView(h.buffer).setUint32(4, b.length, true);
    body.push(h, b); if (pad && b.length & 1) body.push(new Uint8Array(1));
  }
  const len = body.reduce((s, b) => s + b.length, 4), out = new Uint8Array(8 + len);
  out.set([..."RIFF"].map(c => c.charCodeAt(0))); new DataView(out.buffer).setUint32(4, len, true); out.set([..."WAVE"].map(c => c.charCodeAt(0)), 8);
  let o = 12; for (const b of body) { out.set(b, o); o += b.length; }
  return out.buffer;
}
function fmtChunk({ af = 1, ch = 1, sr = 44100, bits = 16, align, size = 16, sub }) {
  const b = new Uint8Array(size), v = new DataView(b.buffer);
  align ??= Math.ceil(bits / 8) * ch;
  if (size >= 2) v.setUint16(0, af, true);
  if (size >= 4) v.setUint16(2, ch, true);
  if (size >= 8) v.setUint32(4, sr, true);
  if (size >= 12) v.setUint32(8, sr * align, true);
  if (size >= 14) v.setUint16(12, align, true);
  if (size >= 16) v.setUint16(14, bits, true);
  if (sub != null && size >= 26) v.setUint16(24, sub, true);
  return b;
}
const i16 = xs => { const b = new Uint8Array(xs.length * 2), v = new DataView(b.buffer); xs.forEach((x, i) => v.setInt16(i * 2, x, true)); return b; };

test("plain 16-bit mono", () => {
  const w = parseWav(riff([["fmt ", fmtChunk({})], ["data", i16([0, 16384, -32768])]]));
  assert.equal(w.samples.length, 3); near(w.samples[1], 0.5); near(w.samples[2], -1); assert.equal(w.sr, 44100);
});
test("odd-sized chunk before data is skipped with its pad byte", () => {
  const w = parseWav(riff([["fmt ", fmtChunk({})], ["LIST", new Uint8Array(5)], ["data", i16([1000, 2000])]]));
  assert.equal(w.samples.length, 2); near(w.samples[0], 1000 / 32768);
});
test("clm chunk is read (odd length)", () => {
  const clm = new TextEncoder().encode("<!>2048 10000000 wavetable (www.xferrecords.com)");
  const w = parseWav(riff([["fmt ", fmtChunk({})], ["clm ", clm], ["data", i16([0, 0])]]));
  assert.match(w.clm, /^<!>2048/);
});
test("fmt chunk shorter than 16 bytes is rejected", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({ size: 14 })], ["data", i16([0])]])), /fmt chunk is too short/);
});
test("truncated fmt chunk at end of file is rejected, not read past the end", () => {
  const ab = riff([["data", i16([0])], ["fmt ", fmtChunk({})]]);
  assert.throws(() => parseWav(ab.slice(0, ab.byteLength - 6)), /too short|missing/);
});
test("zero channels is rejected (no divide by zero / endless loop)", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({ ch: 0, align: 0 })], ["data", i16([1, 2])]])), /no channels/);
});
test("zero bits is rejected", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({ bits: 0, align: 0 })], ["data", i16([1, 2])]])), /no bits/);
});
test("missing data chunk", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({})]])), /missing/);
});
test("not a WAV", () => { assert.throws(() => parseWav(new ArrayBuffer(4)), /isn't a WAV/); });
test("data size past end of file is clamped", () => {
  const ab = riff([["fmt ", fmtChunk({})], ["data", i16([100, 200, 300])]]);
  new DataView(ab).setUint32(40, 0xFFFFFFFF, true);
  assert.equal(parseWav(ab).samples.length, 3);
});
test("stereo is mixed to mono, stepping by blockAlign", () => {
  const w = parseWav(riff([["fmt ", fmtChunk({ ch: 2 })], ["data", i16([16384, 0, -16384, -16384])]]));
  assert.equal(w.samples.length, 2); assert.equal(w.channels, 2); near(w.samples[0], 0.25); near(w.samples[1], -0.5);
});
test("12-bit samples in a 16-bit container", () => {
  const w = parseWav(riff([["fmt ", fmtChunk({ bits: 12, align: 2 })], ["data", i16([0x4000, -0x8000])]]));
  near(w.samples[0], 0.5); near(w.samples[1], -1);
});
test("20-bit in a 24-bit container", () => {
  const d = new Uint8Array([0, 0, 0x40]);
  near(parseWav(riff([["fmt ", fmtChunk({ bits: 20, align: 3 })], ["data", d]])).samples[0], 0.5);
});
test("24-bit with odd sample count and padded data", () => {
  const d = new Uint8Array([0, 0, 0x40, 0, 0, 0xC0, 0xFF, 0xFF, 0x7F]); // 0.5, -0.5, ~1
  const w = parseWav(riff([["fmt ", fmtChunk({ bits: 24 })], ["data", d]]));
  assert.equal(w.samples.length, 3); near(w.samples[0], 0.5); near(w.samples[1], -0.5); near(w.samples[2], 1, 1e-6);
});
test("blockAlign wider than needed (padding bytes per frame)", () => {
  const w = parseWav(riff([["fmt ", fmtChunk({ bits: 16, align: 4 })], ["data", new Uint8Array([0, 0x40, 9, 9, 0, 0xC0, 9, 9])]]));
  assert.equal(w.samples.length, 2); near(w.samples[0], 0.5); near(w.samples[1], -0.5);
});
test("16-bit float (half)", () => {
  const d = new Uint8Array(6), v = new DataView(d.buffer);
  v.setUint16(0, 0x3800, true); v.setUint16(2, 0xBC00, true); v.setUint16(4, 0x7C00, true); // 0.5, -1, +Inf
  const w = parseWav(riff([["fmt ", fmtChunk({ af: 3, bits: 16 })], ["data", d]]));
  near(w.samples[0], 0.5); near(w.samples[1], -1); assert.equal(w.samples[2], 0);
});
test("24-bit float is refused with a message", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({ af: 3, bits: 24 })], ["data", new Uint8Array(3)]])), /Unsupported float WAV: 24-bit/);
});
test("32-bit float NaN/Inf scrubbed", () => {
  const d = new Uint8Array(12), v = new DataView(d.buffer);
  v.setFloat32(0, NaN, true); v.setFloat32(4, -Infinity, true); v.setFloat32(8, 0.25, true);
  const w = parseWav(riff([["fmt ", fmtChunk({ af: 3, bits: 32 })], ["data", d]]));
  assert.deepEqual([...w.samples], [0, 0, 0.25]);
});
test("64-bit float", () => {
  const d = new Uint8Array(8); new DataView(d.buffer).setFloat64(0, -0.75, true);
  near(parseWav(riff([["fmt ", fmtChunk({ af: 3, bits: 64 })], ["data", d]])).samples[0], -0.75);
});
test("WAVE_FORMAT_EXTENSIBLE float", () => {
  const d = new Uint8Array(4); new DataView(d.buffer).setFloat32(0, 0.5, true);
  near(parseWav(riff([["fmt ", fmtChunk({ af: 0xFFFE, bits: 32, size: 40, sub: 3 })], ["data", d]])).samples[0], 0.5);
});
test("extensible with a short fmt chunk is rejected", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({ af: 0xFFFE, size: 18 })], ["data", i16([0])]])), /too short/);
});
test("unsupported encoding", () => {
  assert.throws(() => parseWav(riff([["fmt ", fmtChunk({ af: 2 })], ["data", i16([0])]])), /format 2/);
});
test("random garbage never hangs or throws a non-Error", () => {
  let seed = 1; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let t = 0; t < 3000; t++) {
    const good = new Uint8Array(riff([["fmt ", fmtChunk({ ch: 1 + (t % 3), bits: [8, 16, 24, 32][t % 4] })], ["data", new Uint8Array(64)]]));
    for (let k = 0; k < 6; k++) good[12 + Math.floor(rnd() * (good.length - 12))] = rnd() * 256;
    const ab = good.buffer.slice(0, 12 + Math.floor(rnd() * (good.length - 11)));
    try { const w = parseWav(ab); assert(w.samples.every(Number.isFinite)); } catch (e) { assert(e instanceof Error, String(e)); assert(!(e instanceof RangeError), `RangeError: ${e.message}`); }
  }
});

// wavBuffer round trips through parseWav, and its chunk layout is valid RIFF
const tbl = Float32Array.from({ length: 7 }, (_, i) => Math.sin(i) * 0.9);
for (const fmt of ["i16", "i24", "f32"]) for (const clm of ["", "<!>2048 10000000 wavetable (www.xferrecords.com)", "<!>256 1"]) {
  test(`wavBuffer ${fmt}${clm ? ` clm ${clm.length}` : ""}: valid layout and round trip`, () => {
    const ab = wavBuffer(tbl, 48000, fmt, clm), v = new DataView(ab);
    assert.equal(ab.byteLength % 2, 0, "file length is even");
    assert.equal(v.getUint32(4, true), ab.byteLength - 8, "RIFF size");
    // walk the chunks: each must end within the file at an even offset
    const ids = []; let o = 12;
    while (o < ab.byteLength) { const id = String.fromCharCode(...new Uint8Array(ab, o, 4)), sz = v.getUint32(o + 4, true); ids.push(id); o += 8 + sz + (sz & 1); }
    assert.equal(o, ab.byteLength, "chunks fill the file exactly");
    assert.deepEqual(ids, ["fmt ", ...(clm ? ["clm "] : []), ...(fmt === "f32" ? ["fact"] : []), "data"]);
    if (fmt === "f32") { assert.equal(v.getUint32(16, true), 18, "float fmt has cbSize"); assert.equal(v.getUint16(36, true), 0, "cbSize 0"); }
    const w = parseWav(ab);
    assert.equal(w.sr, 48000); assert.equal(w.samples.length, tbl.length); if (clm) assert.equal(w.clm, clm);
    w.samples.forEach((s, i) => near(s, tbl[i], fmt === "i16" ? 1e-4 : 1e-6));
  });
}
test("wavBuffer scrubs NaN and clamps ints", () => {
  const w = parseWav(wavBuffer(Float32Array.of(NaN, 2, -2), 44100, "i16"));
  near(w.samples[0], 0); near(w.samples[1], 32767 / 32768); near(w.samples[2], -32767 / 32768);
});

// cleanBase: names with Safe names off
const cases = [
  ["..", "wavetable"], [".", "wavetable"], ["...", "wavetable"], ["  ", "wavetable"], ["", "wavetable"], [null, "wavetable"],
  ["../../etc/passwd", "_.._etc_passwd"], ["..\\..\\boot", "_.._boot"], ["/abs/path", "_abs_path"], ["a/../b", "a_.._b"],
  ["name.", "name"], ["name. . .", "name"], ["name ", "name"], [".hidden", "hidden"], ["pad.wav", "pad"], ["pad.WAV.", "pad.WAV"],
  ["con", "con-x"], ["NUL", "NUL-x"], ["com1", "com1-x"], ["LPT9", "LPT9-x"], ["con.txt", "con-x.txt"], ["aux.tar.gz", "aux-x.tar.gz"],
  ["console", "console"], ["nully", "nully"], ["com10", "com10"],
  ["Café Ölfeld", "Café Ölfeld"], ["日本語の波", "日本語の波"], ["Ελληνικά", "Ελληνικά"], ["a<b>c:d\"e|f?g*h", "a_b_c_d_e_f_g_h"], ["tab\there", "tab_here"],
  ["é", "é"], ["😀 smile", "_ smile"], ["Pad (warm) #2", "Pad _warm_ _2"],
];
for (const [inp, want] of cases) test(`cleanBase(${JSON.stringify(inp)}) = ${JSON.stringify(want)}`, () => assert.equal(cleanBase(inp), want));
test("cleanBase never yields a path component that escapes or is reserved", () => {
  const bits = ["..", ".", "/", "\\", " ", "con", "nul", "a", "é", ":", "\u0000", "‮", "~"];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let t = 0; t < 20000; t++) {
    let s = ""; for (let k = 0, n = 1 + Math.floor(rnd() * 6); k < n; k++) s += bits[Math.floor(rnd() * bits.length)];
    const c = cleanBase(s);
    assert(c.length > 0 && !/[/\\:\u0000-\u001f]/.test(c), `${JSON.stringify(s)} -> ${JSON.stringify(c)}`);
    assert(c !== "." && c !== ".." && !/^[\s.]|[\s.]$/.test(c), `${JSON.stringify(s)} -> ${JSON.stringify(c)}`);
    assert(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(c), `${JSON.stringify(s)} -> ${JSON.stringify(c)}`);
  }
});
test("cleanBase caps length at 100 characters without splitting a surrogate pair", () => {
  const c = cleanBase("𝄞".repeat(150)); // not a letter, so it collapses
  assert.equal(c, "_");
  const l = cleanBase("ä".repeat(150)); assert.equal([...l].length, 100);
});

// micTake: microphone chunks -> one sample, DC off, leading silence trimmed, ends faded
test("micTake joins chunks, trims the silence before the first sound and fades the ends", () => {
  const sr = 48000, quiet = new Float32Array(sr / 2).fill(0.1), tone = Float32Array.from({ length: sr }, (_, i) => 0.1 + 0.5 * Math.sin(2 * Math.PI * 220 * i / sr));
  const y = micTake([quiet.subarray(0, 4096), quiet.subarray(4096), tone], sr);
  const lead = Math.round(sr * 0.02);
  assert(Math.abs(y.length - (tone.length + lead)) < 64, `length ${y.length}`);
  assert.equal(y[0], 0); assert(Math.abs(y.at(-1)) < 1e-6, `tail ${y.at(-1)}`);
  const m = y.reduce((a, v) => a + v, 0) / y.length; assert(Math.abs(m) < 0.02, `DC ${m}`);
});
test("micTake refuses silence and too-short takes", () => {
  assert.throws(() => micTake([new Float32Array(48000)], 48000), /silent/);
  assert.throws(() => micTake([Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i))], 48000), /too short/);
  assert.throws(() => micTake([], 48000), /silent/);
});

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
