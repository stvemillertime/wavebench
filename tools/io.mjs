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
const cnst = name => { const m = html.match(new RegExp(`\\nconst ${name} = .*\\n`)); assert(m, name); return m[0]; };
const my = new Function(`${cnst("MY_DB")}${cnst("parseTags")}${cnst("mySort")}${fn("validMyRec")}${fn("myMatch")}${fn("lsStore")}return { parseTags, mySort, validMyRec, myMatch, lsStore };`)();
const afn = name => { const i = html.indexOf(`\nasync function ${name}(`); assert(i >= 0, name); return html.slice(i, html.indexOf("\n}\n", i) + 3); };
const lk = new Function(`const N = 2048; ${cnst("clampN")}${cnst("SHARE_BASE")}${cnst("b64uEnc")}${cnst("b64uDec")}${cnst("canZip")}${afn("zbytes")}${afn("encodeLink")}${afn("decodeLink")}return { encodeLink, decodeLink, zbytes };`)();
const { micTake } = new Function(`${line("peak")}${line("removeDC")}${fn("micTake")}return { micTake };`)();

let fails = 0;
const pending = [], bad = (name, e) => { fails++; console.log("FAIL", name, "\n     ", e.message); };
const test = (name, f) => { // async tests are awaited before the summary
  try { const r = f(); if (r?.then) pending.push(r.then(() => console.log("ok  ", name), e => bad(name, e))); else console.log("ok  ", name); } catch (e) { bad(name, e); }
};
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

// My library: tags, record checks, filter, order and the localStorage backend
test("parseTags trims, lowercases, dedupes and caps", () => {
  assert.deepEqual(my.parseTags(" Pad, #Dark ,pad,, bright  sweep ,#"), ["pad", "dark", "bright sweep"]);
  assert.deepEqual(my.parseTags(null), []);
  assert.equal(my.parseTags(Array.from({ length: 20 }, (_, i) => "t" + i).join(",")).length, 12);
  assert.equal(my.parseTags("x".repeat(40))[0].length, 24);
});
const rec = (o = {}) => ({ id: "a", name: "Glass Pad", tags: ["pad", "glass"], fav: false, created: 1, updated: 2, st: { kfs: [{ f: 0, data: "" }] }, th: null, ...o });
test("validMyRec rejects junk and repairs fields", () => {
  for (const bad of [null, 5, {}, rec({ id: "" }), rec({ id: 3 }), rec({ st: null }), rec({ st: { kfs: [] } })]) assert.equal(my.validMyRec(bad), null);
  const r = my.validMyRec(rec({ name: "  ", tags: "A, b", fav: "yes", created: "x", th: [[0], [1], ["a"]] }));
  assert.equal(r.name, "untitled"); assert.deepEqual(r.tags, ["a", "b"]); assert.equal(r.fav, false); assert(Number.isFinite(r.created)); assert.equal(r.th, null);
  assert.deepEqual(my.validMyRec(rec({ th: [[0, 1], [0], [0.5]] })).th, [[0, 1], [0], [0.5]]);
});
test("myMatch: words match the name or a tag's start; #tag is exact; ★ only", () => {
  const r = my.validMyRec(rec());
  for (const q of ["", "glass", "PAD", "gla pa", "#pad", "#", "  "]) assert(my.myMatch(r, q, false), q);
  for (const q of ["lead", "#pa", "glass lead"]) assert(!my.myMatch(r, q, false), q);
  assert(!my.myMatch(r, "", true)); assert(my.myMatch({ ...r, fav: true }, "pad", true));
});
test("mySort: favourites first, then newest", () => {
  const l = [rec({ id: "1", updated: 5 }), rec({ id: "2", updated: 9 }), rec({ id: "3", fav: true, updated: 1 })];
  assert.deepEqual(my.mySort(l).map(r => r.id), ["3", "2", "1"]);
});
test("lsStore: put replaces by id, del removes, bad JSON entries are dropped", async () => {
  const m = new Map(), ls = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }, st = my.lsStore(ls);
  assert.deepEqual(await st.all(), []);
  await st.put(rec({ id: "x" })); await st.put(rec({ id: "y", name: "Two" })); await st.put(rec({ id: "x", name: "One again" }));
  let all = await st.all(); assert.deepEqual(all.map(r => r.name).sort(), ["One again", "Two"]);
  await st.del("y"); all = await st.all(); assert.deepEqual(all.map(r => r.id), ["x"]);
  m.set("wavetable-lab.mylib", JSON.stringify([null, { id: 1 }, rec({ id: "z" })])); assert.deepEqual((await st.all()).map(r => r.id), ["z"]);
});

// share links: header + 16-bit sample blocks, deflated and base64url'd, back again
test("encodeLink / decodeLink round trip, deflated and plain", async () => {
  const N = 2048, a = Float32Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * i / N) * 0.9 + (i === 7 ? 0.1 : 0)), b = new Float32Array(N).fill(-1);
  b[0] = 1; b[1] = NaN; b[2] = 5; // full-scale steps (deltas that don't fit 16 bits), junk
  const head = { v: 1, n: "Café ✓", k: [[0, "r", 0], [1, "r", 1]] }, s = await lk.encodeLink(head, [a, b]);
  assert.match(s, /^wt=[A-Za-z0-9_-]+$/);
  const back = await lk.decodeLink("#" + s);
  assert.deepEqual(back.head, head); assert.equal(back.blocks.length, 2);
  back.blocks[0].forEach((v, i) => near(v, a[i], 1 / 32767));
  assert.deepEqual([...back.blocks[1].slice(0, 4)], [1, 0, 1, -1]);
  const plain = "wt0=" + Buffer.from(await lk.zbytes(Buffer.from(s.slice(3), "base64url"), true)).toString("base64url"); // what a browser without CompressionStream writes
  assert.deepEqual((await lk.decodeLink(plain)).head, head);
  const smooth = await lk.encodeLink({ v: 1 }, [a]); assert(smooth.length < 2 * N, `a sine packs to ${smooth.length} chars`);
});
test("decodeLink refuses junk, cut-short and oversized links", async () => {
  const ok = await lk.encodeLink({ v: 1, k: [] }, [new Float32Array(2048).fill(0.3)]);
  for (const bad of ["", "#xyz=abc", "#wt=", "#wt=@@@", "#" + ok.slice(0, ok.length >> 1), "#wt0=AAAA"]) await assert.rejects(lk.decodeLink(bad), Error, bad.slice(0, 20));
  const bomb = "wt=" + Buffer.from(await lk.zbytes(new Uint8Array(4 << 20), false)).toString("base64url");
  await assert.rejects(lk.decodeLink(bomb), /more than a table/);
});

await Promise.all(pending);
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
