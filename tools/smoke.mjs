// Worker smoke test: builds the worker body from index.html's /*@dsp*/ regions exactly as buildWorkerURL does,
// runs it in a bare context (no DOM, so anything outside the regions is a ReferenceError, as in a real worker),
// then sends every JOB through self.onmessage and checks the replies.
//   node tools/smoke.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

// $$("script:not([src])").at(-1).textContent
const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.at(-1);

// FORMULAS on the page comes from the #fmPreset options
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const sel = html.match(/<select id="fmPreset"[^>]*>([\s\S]*?)<\/select>/)[1];
const FORMULAS = [...sel.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].filter(m => m[1]).map(m => ({ src: decode(m[1]), name: decode(m[2]) }));

// same split and wrapper as buildWorkerURL
const open = "/*@" + "dsp*/", close = "/*@" + "end*/";
const parts = src.split(open).slice(1).map(p => p.slice(0, p.indexOf(close)));
const body = `"use strict";\nconst WFORMULAS = ${JSON.stringify(FORMULAS)};\n${parts.join("\n")}
self.onmessage = e => {
  const { id, t, data } = e.data;
  let last = 0;
  const prog = p => { const now = Date.now(); if (now - last > 60) { last = now; self.postMessage({ id, prog: p }); } };
  try { const res = JOBS[t](data, prog); self.postMessage({ id, ok: true, res }, [...transferables(res)]); }
  catch (err) { self.postMessage({ id, ok: false, err: String(err && err.message || err) }); }
};`;
const wrapper = buildURLWrapper(src);
if (!wrapper.includes("self.onmessage = e =>")) fail("buildWorkerURL changed shape; update tools/smoke.mjs to match");

const replies = new Map();
const g = { console, TextEncoder, TextDecoder, Blob, URL, setTimeout, clearTimeout, performance, structuredClone };
g.self = g;
g.postMessage = (m) => { if (!("prog" in m)) replies.set(m.id, m); };
const ctx = vm.createContext(g);
try { vm.runInContext(body, ctx, { filename: "worker.js" }); }
catch (e) { fail(`worker body failed to load: ${e.message}`); }
const probe = expr => { try { return vm.runInContext(expr, ctx); } catch (e) { fail(`worker scope: ${e.message}`); } };

let seq = 0, failures = 0;
function run(t, data) {
  const id = ++seq;
  g.self.onmessage({ data: { id, t, data } });
  const r = replies.get(id);
  if (!r) throw new Error("no reply");
  if (!r.ok) throw new Error(r.err);
  return r.res;
}
const peak = a => Math.max(...a.map(Math.abs));
const finite = a => { for (const v of a) if (!Number.isFinite(v)) return false; return true; };
function check(name, fn) {
  try { const msg = fn(); console.log(`ok   ${name}${msg ? ` (${msg})` : ""}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
function fail(msg) { console.error(`FAIL ${msg}`); process.exit(1); }

const N = probe("N");
const FX_KEYS = probe("FX_SPECS.map(f => f.key)");
const st = (mode, fx = probe("defaultFx()")) => ({ fc: 16, mode, fx, kfs: probe("randomState(7)").kfs });
const allFx = () => { const fx = probe("defaultFx()"); for (const k of FX_KEYS) fx[k].on = true; fx.level = true; return fx; };

// fx / render / thumbs
for (const mode of ["linear", "spectral", "step"]) {
  check(`render ${mode}`, () => { const fr = run("render", { st: st(mode) }); assert(fr.length === 16 && fr.every(f => f.length === N && finite(f)), "bad frames"); });
}
check("render spectral stays within full scale", () => {
  const fr = run("render", { st: st("spectral") }); const p = Math.max(...fr.map(f => Math.max(...f.map(Math.abs))));
  assert(p <= 1 + 1e-6, `peak ${p}`); return `peak ${p.toFixed(3)}`;
});
check("fx with every transform on", () => {
  const s = st("spectral"), frames = run("render", { st: { ...s, fx: probe("defaultFx()") } });
  const out = run("fx", { frames, fx: allFx(), kfs: s.kfs });
  assert(out.length === frames.length && out.every(f => f.length === N && finite(f)), "bad frames");
});
check("fxPart halves joined match fx", () => {
  const s = st("spectral"), frames = run("render", { st: { ...s, fx: probe("defaultFx()") } }), fx = allFx();
  const whole = run("fx", { frames, fx, kfs: s.kfs });
  const parts = [run("fxPart", { frames: frames.slice(0, 7), fx, kfs: s.kfs, i0: 0, total: 16 }), run("fxPart", { frames: frames.slice(7), fx, kfs: s.kfs, i0: 7, total: 16 })];
  const joined = probe("fxFinish")(parts.flat(), fx);
  let e = 0; joined.forEach((f, i) => f.forEach((v, j) => { e = Math.max(e, Math.abs(v - whole[i][j])); }));
  assert(e < 1e-6, `max diff ${e}`);
});
// per-transform lanes
{
  const lfx = (on, lanes = {}, curve = "lin") => {
    const fx = probe("defaultFx()"); fx.curve = curve;
    for (const k of on) { const f = probe(`FXK.${k}`); Object.assign(fx[k], { on: true, a: f.min + (f.max - f.min) * 0.1, b: f.min + (f.max - f.min) * 0.8, lane: lanes[k] || null }); }
    return fx;
  };
  const maxDiff = (a, b) => { let e = 0; a.forEach((f, i) => f.forEach((v, j) => { e = Math.max(e, Math.abs(v - b[i][j])); })); return e; };
  const s = st("linear"), dry = run("render", { st: { ...s, fx: probe("defaultFx()") } });
  check("lane round trip through mergeFx; old and bad lanes", () => {
    const fx = lfx(["fold", "filt"], { fold: [[0, 0.2], [0.3, 1], [0.7, 0.1], [1, 0.5]] }), mf = probe("mergeFx");
    const back = mf(JSON.parse(JSON.stringify(fx)));
    assert(JSON.stringify(back.fold.lane) === JSON.stringify(fx.fold.lane) && back.filt.lane === null, JSON.stringify(back.fold.lane));
    const old = mf({ fold: { on: true, a: 1, b: 2 } }); assert(old.fold.lane === null && old.fold.on, "old project gained a lane");
    const bad = mf({ fold: { lane: "x" }, pd: { lane: [[0.6, 9], [0.2, -1], ["a", 0], [1, 0.4]] }, sat: { lane: [] } });
    assert(bad.fold.lane === null, "string lane kept");
    assert(JSON.stringify(bad.pd.lane) === "[[0,0],[0.2,0],[0.6,1],[1,0.4]]", JSON.stringify(bad.pd.lane));
    assert(JSON.stringify(bad.sat.lane) === "[[0,0],[1,1]]", JSON.stringify(bad.sat.lane));
  });
  check("a straight lane matches the plain linear ramp", () => {
    const plain = run("fx", { frames: dry, fx: lfx(["fold", "pd"]), kfs: s.kfs });
    const laned = run("fx", { frames: dry, fx: lfx(["fold", "pd"], { fold: [[0, 0], [1, 1]], pd: [[0, 0], [0.5, 0.5], [1, 1]] }), kfs: s.kfs });
    const bent = run("fx", { frames: dry, fx: lfx(["fold", "pd"], { fold: [[0, 0], [0.5, 1], [1, 0]] }), kfs: s.kfs });
    const e = maxDiff(plain, laned), d = maxDiff(plain, bent);
    assert(e < 1e-9, `straight lane differs by ${e}`); assert(d > 0.01, `bent lane changes nothing (${d})`);
    return `diff ${e.toExponential(1)}`;
  });
  for (const curve of ["in", "tri"]) check(`reversed lane (shared curve ${curve}) gives the reversed wet table`, () => {
    const fx = lfx(["fold", "pd", "filt"], { fold: [[0, 0.2], [0.3, 1], [0.7, 0.1], [1, 0.5]] }, curve);
    const fwd = run("fx", { frames: dry, fx, kfs: s.kfs });
    const kr = s.kfs.map(k => ({ ...k, f: 1 - k.f })), fr = probe("reverseFx")(JSON.parse(JSON.stringify(fx)), kr.length);
    assert(JSON.stringify(fr.fold.lane) === "[[0,0.5],[0.30000000000000004,0.1],[0.7,1],[1,0.2]]", JSON.stringify(fr.fold.lane));
    const dr = run("render", { st: { ...s, kfs: kr, fx: probe("defaultFx()") } }), rev = run("fx", { frames: dr, fx: fr, kfs: kr });
    const e = maxDiff(rev, [...fwd].reverse()); assert(e < 1e-5, `max diff ${e}`); return `diff ${e.toExponential(1)}`;
  });
  check("mix round trip through mergeFx; old and bad mixes", () => {
    const mf = probe("mergeFx"), fx = lfx(["fold"]); fx.fold.mix = 0.3;
    assert(mf(JSON.parse(JSON.stringify(fx))).fold.mix === 0.3, "mix lost");
    const bad = mf({ fold: { on: true }, pd: { mix: 5 }, sat: { mix: null }, filt: { mix: "x" }, ring: { mix: -1 } });
    assert(bad.fold.mix === 1 && bad.pd.mix === 1 && bad.sat.mix === 1 && bad.filt.mix === 1 && bad.ring.mix === 0, JSON.stringify([bad.fold.mix, bad.pd.mix, bad.sat.mix, bad.filt.mix, bad.ring.mix]));
  });
  check("mix 0 is dry, mix ½ is halfway (time and spectral transforms)", () => {
    const res = [];
    for (const k of ["fold", "filt"]) {
      const fx = lfx([k]), wet = run("fx", { frames: dry, fx, kfs: s.kfs });
      fx[k].mix = 0; const d0 = maxDiff(run("fx", { frames: dry, fx, kfs: s.kfs }), dry);
      assert(d0 < 1e-5, `${k} mix 0 differs from dry by ${d0}`);
      fx[k].mix = 0.5; const half = run("fx", { frames: dry, fx, kfs: s.kfs });
      const pk = Math.max(...wet.map(f => Math.max(...f.map(Math.abs))));
      assert(maxDiff(wet, dry) > 0.01, `${k} changes nothing`);
      if (pk < 0.999) { const e = maxDiff(half, dry.map((f, i) => f.map((v, j) => (v + wet[i][j]) / 2))); assert(e < 1e-5, `${k} mix ½ off by ${e}`); }
      res.push(`${k} ${d0.toExponential(1)}`);
    }
    return res.join(", ");
  });
  check("randomizeFx gives valid settings for every transform, curves included", () => {
    const fx = probe("defaultFx()"), mf = probe("mergeFx"), rz = probe("randomizeFx"), R = probe("rng")(7);
    for (const f of probe("FX_SPECS")) {
      rz(fx, f.key, R); const back = mf(JSON.parse(JSON.stringify(fx)))[f.key];
      assert(fx[f.key].on && JSON.stringify(back) === JSON.stringify(fx[f.key]), `${f.key}: ${JSON.stringify(fx[f.key])}`);
    }
    const out = run("fx", { frames: dry, fx, kfs: s.kfs }); assert(out.every(finite), "non-finite output");
  });
}
check("mips", () => {
  const fr = run("render", { st: st("spectral") }), m = run("mips", { frames: fr });
  assert(m.nf === 16 && m.lv.length === 11 && m.lv.every(l => l.d.length === 16 * l.len && finite(l.d)), "bad mips");
  // level 0 is the frames themselves; each level keeps a band-limited copy of the same cycle
  assert(m.lv[0].d.subarray(0, N).every((v, i) => v === fr[0][i]), "level 0 differs from the frames");
});
check("thumbs", () => { const th = run("thumbs", { items: [st("linear"), st("spectral", allFx())] }); assert(th.length === 2 && th[0].length === 3, "bad thumbs"); });

// gen (random + mutate) and lib
check("gen random", () => { const r = run("gen", { mut: false, seeds: [1, 2, 3], amt: 0.5, cur: null }); assert(r.length === 3 && r[0].st && r[0].th, "bad gen"); });
check("gen mutate", () => { const r = run("gen", { mut: true, seeds: [4, 5], amt: 0.5, cur: probe("randomState(9)") }); assert(r.length === 2, "bad mutate"); });
check("lib (every entry)", () => { const n = probe("LIB.length"), r = run("lib", { ids: [...Array(n).keys()] }); assert(r.length === n, "bad lib"); return `${n} entries`; });

// resynth: a 220 Hz tone with a few harmonics and a DC offset, every pitch method
const sr = 44100, x = new Float32Array(sr);
for (let i = 0; i < x.length; i++) { const p = 2 * Math.PI * 220 * i / sr; x[i] = 0.2 + 0.5 * Math.sin(p) + 0.25 * Math.sin(2 * p) + 0.12 * Math.sin(3 * p); }
const posA = Array.from({ length: 8 }, (_, i) => Math.round(4096 + i * (x.length - 8192) / 7));
const methods = [...html.match(/<select id="rsMethod">([\s\S]*?)<\/select>/)[1].matchAll(/value="([^"]+)"/g)].map(m => m[1]);
for (const method of methods) for (const B of [false, true]) {
  check(`resynth ${method}${B ? " A→B" : ""}`, () => {
    const s = { name: "tone", x, sr };
    const r = run("resynth", { A: s, B: B ? s : null, posA, posB: B ? posA.slice(0, 4) : null,
      p: { method, cycles: 1, onsets: false, hz: 220, formant: true, lock: true, norm: true } });
    assert(r.frames.length === 8 + (B ? 4 : 0) && r.frames.every(f => f.length === N && finite(f)), "bad frames");
    if (method !== "raw") assert(Math.abs(r.fref - 220) < 2, `pitch ${r.fref}`);
    return r.infoA;
  });
}

// vocode: unpitched input becomes a harmonic table carrying the input's spectral envelope
{
  let seed = 3; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32 - 0.5; // imul: a float product loses the low bits
  const noise = Float32Array.from({ length: sr }, rnd), sp = probe("spec"), mg = probe("mag");
  const hmag = d => { const { re, im } = sp(d); return Array.from({ length: N / 2 }, (_, k) => mg(re[k], im[k])); };
  const vrun = (x, hz, extra = {}) => run("resynth", { A: { name: "n", x, sr }, B: null, posA: [8192, 22050, 36000],
    p: { method: "vocode", cycles: 2, onsets: false, hz, formant: false, lock: true, norm: true, ...extra } });
  check("vocode: white noise gives a flat harmonic series at the set pitch", () => {
    const r = vrun(noise, 110), m = hmag(r.frames[1]), H = Math.floor(sr / 2 / 110 - 0.5);
    assert(r.fref === 110 && /vocoded onto 110 Hz/.test(r.infoA), r.infoA);
    const band = m.slice(2, H - 2), ref = Math.sqrt(band.reduce((a, v) => a + v * v, 0) / band.length);
    const db = band.map(v => 20 * Math.log10(v / ref)), lo = Math.min(...db), hi = Math.max(...db);
    assert(lo > -6 && hi < 6, `harmonics ${lo.toFixed(1)}..${hi.toFixed(1)} dB`);
    const above = Math.max(...m.slice(H + 1)); assert(above < 1e-4 * ref, `energy above Nyquist/f0: ${above}`);
    return `spread ${(hi - lo).toFixed(1)} dB over ${H} harmonics`;
  });
  check("vocode: a 1 kHz band peaks at harmonic 9 of 110 Hz", () => {
    const t = Float32Array.from(noise, (v, i) => 0.05 * v + Math.sin(2 * Math.PI * 1000 * i / sr)), m = hmag(vrun(t, 110).frames[0]);
    const top = m.indexOf(Math.max(...m.slice(1))); assert(top === 9, `peak at h${top}`);
    const m2 = hmag(vrun(t, 220).frames[0]), top2 = m2.indexOf(Math.max(...m2.slice(1))); assert(top2 === 5, `at 220 Hz peak at h${top2}`);
  });
  check("vocode: silence is refused, short samples still work", () => {
    let msg = ""; try { vrun(new Float32Array(sr), 110); } catch (e) { msg = e.message; } assert(/silent/.test(msg), msg || "no error");
    const r = run("resynth", { A: { name: "s", x: noise.slice(0, 5000), sr }, B: null, posA: [1000, 4000], p: { method: "vocode", cycles: 1, hz: 30, lock: false, norm: true } });
    assert(r.frames.every(f => finite(f) && peak(f) > 0.9), "bad frames");
  });
}

// bank + report, with and without a tuned note (o.note drives noteLabel in the report)
const noteFs = (m, sr) => Math.round(sr / (440 * 2 ** ((m - 69) / 12))); // same as the page's
const opts = note => ({ tpl: "digitakt2", suf: false, maxF: 64, pow2: false, fs: note == null ? 2048 : noteFs(note, 48000), note, fmt: "i16", sr: 48000,
  norm: true, dc: true, raw: false, clm: false, safe: true, max: 64 });
const bankD = (o, loud) => ({ o, tpl: { name: "Test", short: "T" }, loud, layout: "folder", folder: "bank", title: "Bank", date: new Date().toISOString(),
  items: [st("linear"), st("spectral", allFx())].map((s, i) => ({ file: `0${i + 1}_t.wav`, path: `bank/0${i + 1}_t.wav`, name: "t", st: s })),
  extra: [], report: "extras/bank-report.html" });
for (const note of [null, 60, 45]) for (const loud of ["off", "median", "exact"]) {
  const o = opts(note);
  check(`bank note=${note} fs=${o.fs} loud=${loud}`, () => { const r = run("bank", bankD(o, loud)); assert(r.blob instanceof Blob && r.blob.size > 1000, "bad zip"); });
}
check("wav export 64x734", () => {
  const fr = run("render", { st: st("spectral") }), buf = run("wav", { frames: fr, o: { ...opts(null), fs: 734 } }); // 16 frames, 16-bit, no clm chunk
  assert(buf.byteLength === 44 + 16 * 734 * 2, `size ${buf.byteLength}`);
});
check("table job: .wt and .vitaltable from the wet frames", () => {
  g.atob = atob; g.btoa = btoa;
  const fr = run("render", { st: st("spectral") }), o = { ...opts(null), maxF: 4, norm: true, dc: true };
  const wt = probe("parseWt")(run("table", { frames: fr, o: { ...o, fs: 256 }, kind: "wt", name: "t" }));
  assert(wt.fs === 256 && wt.frames.length === 16 && Math.abs(Math.max(...wt.frames.map(f => Math.max(...f.map(Math.abs)))) - 1) < 1e-6, "wt: no frame limit, normalized");
  const v = JSON.parse(run("table", { frames: fr, o: { ...o, fs: 734 }, kind: "vital", name: "Pad" })), k = v.groups[0].components[0].keyframes;
  assert(v.name === "Pad" && k.length === 16 && probe("b64ToF32")(k[3].wave_data).length === N, "vital: 2048-sample frames whatever the export size");
});
check("report with note", () => { const h = run("report", bankD(opts(60), "median")); assert(/one cycle of C4/.test(h), "note missing from report"); });

// direct DSP checks
check("removeDC removes DC", () => { const d = Float32Array.from({ length: 64 }, (_, i) => 0.3 + Math.sin(i)); probe("removeDC")(d); const m = d.reduce((a, b) => a + b) / d.length; assert(Math.abs(m) < 1e-6, `mean ${m}`); });
check("removeDCn(x, M) only touches M samples", () => { const d = new Float32Array(8).fill(1); probe("removeDCn")(d, 4); assert(d[0] === 0 && d[7] === 1, String([...d])); });
check("readAt never reads past the end", () => { const r = probe("readAt"), x = Float32Array.from([1, 2, 3, 4]); const v = r(x, 4, -1e-17); assert(Number.isFinite(v), `got ${v}`); });
check("resample non-pow2 round trip", () => {
  const rs = probe("resample"), d = new Float32Array(N); for (let i = 0; i < N; i++) d[i] = Math.sin(2 * Math.PI * 300 * i / N);
  let worst = 0;
  for (const M of [600, 734, 367]) {
    const h = Math.min(300, Math.ceil(M / 2) - 1), back = rs(rs(d, M), N);
    let e = 0, p = 0; for (let i = 0; i < N; i++) { const t = h === 300 ? d[i] : 0; e += (back[i] - t) ** 2; p += t * t; }
    const err = h === 300 ? Math.sqrt(e / p) : Math.sqrt(e / N); worst = Math.max(worst, err);
    assert(err < 1e-3, `M=${M} error ${err}`);
  }
  return `worst ${worst.toExponential(1)}`;
});

// new transforms, one at a time on a saw
{
  const saw = probe("genShape")("saw", 0.5, 1023), fxFrame = probe("fxFrame"), sp = probe("spec"), mg = probe("mag");
  const one = (key, v, extra = {}) => { const fx = probe("defaultFx()"); Object.assign(fx[key], { on: true, a: v, b: v }, extra); return fxFrame(saw, fx, 0.5, null); };
  const hm = d => { const { re, im } = sp(d); return k => mg(re[k], im[k]); };
  const dB = (a, b) => 20 * Math.log10(a / b);
  for (const key of ["selffm", "comb", "tilt", "wsync"]) check(`transform ${key} exists and is in the default order`, () => {
    assert(FX_KEYS.includes(key) && probe("DEFAULT_ORDER").includes(key), "missing");
    const f = probe(`FXK.${key}`), d = one(key, f.b); assert(d.length === N && finite(d), "bad frame");
    let diff = 0; for (let i = 0; i < N; i++) diff = Math.max(diff, Math.abs(d[i] - saw[i])); assert(diff > 0.01, `End value changes nothing (${diff})`);
  });
  check("self-FM at 0 leaves the wave alone; feedback mode stays finite", () => {
    const d = one("selffm", 0); let e = 0; for (let i = 0; i < N; i++) e = Math.max(e, Math.abs(d[i] - saw[i]));
    assert(e < 0.05, `diff ${e}`); assert(finite(one("selffm", 1, { mode: "fb" })), "feedback NaN");
  });
  check("tilt +6 dB/oct lifts h16 against h2 by ~18 dB", () => {
    const a = hm(saw), b = hm(one("tilt", 6)), lift = dB(b(16), b(2)) - dB(a(16), a(2));
    assert(Math.abs(lift - 18) < 0.5, `lift ${lift.toFixed(2)} dB`); return `${lift.toFixed(2)} dB`;
  });
  check("comb keeps teeth and cuts between them", () => {
    const a = hm(saw), b = hm(one("comb", 0, { space: 4, fb: 0.7 })), tooth = b(8) / a(8), gap = b(10) / a(10);
    assert(Math.abs(tooth - 1) < 0.02 && Math.abs(gap - 0.3 / 1.7) < 0.02, `tooth ${tooth.toFixed(3)} gap ${gap.toFixed(3)}`);
    const neg = hm(one("comb", 0, { space: 4, fb: -0.7 })); assert(neg(10) / a(10) > 0.95, "negative feedback should swap peaks and notches");
  });
  check("window sync has no step where the cycle restarts (hard sync does)", () => {
    const w = one("wsync", 3.3), h = one("sync", 3.3), wj = Math.abs(w[0] - w[N - 1]), hj = Math.abs(h[0] - h[N - 1]);
    assert(wj < 0.05 && hj > 0.3, `window ${wj.toFixed(3)} vs hard ${hj.toFixed(3)}`); return `${wj.toFixed(3)} vs ${hj.toFixed(3)}`;
  });
  check("mergeFx validates the new transforms' settings", () => {
    const fx = probe("mergeFx")({ comb: { on: true, a: 9, space: 999, fb: "x" }, selffm: { mode: "bogus" }, tilt: { b: -99 } });
    assert(fx.comb.on && fx.comb.a === 1 && fx.comb.space === 32 && fx.comb.fb === 0.7 && fx.selffm.mode === "self" && fx.tilt.b === -12, JSON.stringify([fx.comb, fx.selffm.mode, fx.tilt.b]));
  });
}
check("Shepard riser: fixed envelope, partials rise and the last frame steps into the first", () => {
  const kfs = probe("shepardKfs()"), sp = probe("spec"), mg = probe("mag");
  assert(kfs.length === 64 && kfs.every(k => k.data.length === N && finite(k.data)), "bad frames");
  const mags = kfs.map(k => { const { re, im } = sp(k.data); return Array.from({ length: N / 2 }, (_, j) => mg(re[j], im[j])); });
  const cen = m => { let s = 0, w = 0; for (let j = 1; j < m.length; j++) { s += m[j] ** 2 * Math.log2(j); w += m[j] ** 2; } return s / w; };
  const cs = mags.map(cen), spread = Math.max(...cs) - Math.min(...cs);
  assert(spread < 0.15, `envelope centre moves ${spread.toFixed(3)} oct`);
  const top = m => m.indexOf(Math.max(...m.slice(1)));
  assert(top(mags[0]) === 32, `frame 1 peaks at h${top(mags[0])}`);
  // half way the partials sit half an octave up (h22.6, h45.3); frame 64 is 63/64 up, so its partial at h31.65 is
  // split over h31 and h32, one step short of frame 1's pure h32: the step back to frame 1 is like any other
  assert([22, 23, 45, 46].includes(top(mags[32])), `frame 33 peaks at h${top(mags[32])}`);
  const r = mags[63][31] / mags[63][32]; assert(r > 0.6 && r < 0.8 && mags[0][31] < 1e-3 * mags[0][32], `frame 64 h31/h32 ${r.toFixed(3)}`);
  const pk = Math.max(...kfs.map(k => Math.max(...k.data.map(Math.abs)))); assert(pk <= 1, `peak ${pk}`);
  return `centre spread ${spread.toFixed(3)} oct`;
});

// node keyframes and the Shape (nodes) morph
{
  const renderNodes = probe("renderNodes"), lerpNodes = probe("lerpNodes"), computeFrames = probe("computeFrames"), validNodes = probe("validNodes");
  const saw = [{ x: 0, y: 0, c: 0 }, { x: 0.5, y: 1, c: 0 }, { x: 0.5, y: -1, c: 0 }, { x: 1, y: 0, c: 0 }];
  const tri = [{ x: 0, y: -1, c: 0.4 }, { x: 0.5, y: 1, c: -0.4 }, { x: 1, y: -1, c: 0 }];
  check("node render: curve 0 is a straight line and the ends loop", () => {
    const d = renderNodes([{ x: 0, y: -1, c: 0 }, { x: 0.5, y: 1, c: 0 }, { x: 1, y: -1, c: 0 }]);
    for (const n of [0, 256, 512, 1024, 1536, 2047]) { const x = n / N, want = x < 0.5 ? -1 + 4 * x : 3 - 4 * x; assert(Math.abs(d[n] - want) < 1e-5, `d[${n}] ${d[n]} != ${want}`); }
    const s = renderNodes(saw); assert(Math.abs(s[0] - s[N - 1]) < 4 / N + 1e-6, `seam ${s[0] - s[N - 1]}`);
    const b = renderNodes(tri); assert(b[256] < -1 + 4 * 0.125 - 0.05, "positive bend should sag a rising curve"); // c>0 bends a rising curve down
  });
  check("validNodes pins the ends and drops junk", () => {
    const v = validNodes([{ x: 0.7, y: 0.2 }, { x: "a", y: 1 }, { x: 0.1, y: 5, c: 9 }, { x: 0.4, y: -0.3 }]);
    assert(v.length === 3 && v[0].x === 0 && v[2].x === 1 && v[2].y === v[0].y && v[0].y === 1 && v[0].c === 1, JSON.stringify(v));
    assert(validNodes(null) === null && validNodes([{ x: 0, y: 0 }]) === null, "should reject");
  });
  check("pack/unpack keeps nodes (and old projects without them load)", () => {
    g.atob = atob; g.btoa = btoa;
    const fn = name => { const i = src.indexOf(`\nfunction ${name}(`); assert(i >= 0, name); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
    vm.runInContext(`${fn("f32ToB64")}${fn("b64ToF32")}${fn("validSrc")}${fn("packState")}${fn("unpackState")}globalThis.__pk = { packState, unpackState };`, ctx);
    const { packState, unpackState } = probe("__pk");
    const st = { fc: 16, mode: "shape", fx: probe("defaultFx()"), kfs: [{ id: 1, f: 0, data: renderNodes(saw), nodes: saw }, { id: 2, f: 1, data: renderNodes(tri) }] };
    const back = unpackState(JSON.parse(JSON.stringify(packState(st))));
    assert(back.mode === "shape" && JSON.stringify(back.kfs[0].nodes) === JSON.stringify(saw) && !back.kfs[1].nodes, "nodes lost");
    assert(probe("liveNodes")(back.kfs[0]) === back.kfs[0].nodes, "nodes no longer match their samples after loading");
    const old = packState(st); delete old.kfs[0].nodes; old.mode = "spectral"; assert(unpackState(old).kfs.every(k => !k.nodes), "old project");
  });
  check("shape morph at t=0.5 lands the nodes halfway", () => {
    const A = [{ x: 0, y: -0.5, c: 0 }, { x: 0.25, y: 1, c: 0.5 }, { x: 1, y: -0.5, c: 0 }], B = [{ x: 0, y: 0.5, c: 0 }, { x: 0.75, y: -1, c: -0.5 }, { x: 1, y: 0.5, c: 0 }];
    const mid = lerpNodes(A, B, 0.5); assert(Math.abs(mid[1].x - 0.5) < 1e-9 && Math.abs(mid[1].y) < 1e-9 && Math.abs(mid[1].c) < 1e-9 && mid[0].y === 0, JSON.stringify(mid));
    const kfs = [{ f: 0, data: renderNodes(A), nodes: A }, { f: 1, data: renderNodes(B), nodes: B }];
    const fr = computeFrames(kfs, 3, "shape"), want = renderNodes(mid);
    assert(fr[1].every((v, i) => Math.abs(v - want[i]) < 1e-6), "frame 2 isn't the halfway node shape");
    const r = run("render", { st: { fc: 3, mode: "shape", fx: probe("defaultFx()"), kfs } }); assert(r[1].every((v, i) => Math.abs(v - want[i]) < 1e-6), "worker render differs");
    const sp = computeFrames([{ f: 0, data: renderNodes(A), nodes: A }, { f: 1, data: renderNodes(B) }], 3, "shape"), ss = computeFrames([{ f: 0, data: renderNodes(A) }, { f: 1, data: renderNodes(B) }], 3, "spectral");
    assert(sp[1].every((v, i) => v === ss[1][i]), "a pair without nodes should fall back to spectral");
  });
  check("shape morph with different node counts stays finite and keeps the ends", () => {
    const kfs = [{ f: 0, data: renderNodes(saw), nodes: saw }, { f: 1, data: renderNodes(tri), nodes: tri }];
    const fr = computeFrames(kfs, 9, "shape"); assert(fr.every(f => finite(f) && Math.max(...f.map(Math.abs)) <= 1 + 1e-6), "bad frames");
    const split = probe("splitNodes")(tri, 4), a = renderNodes(tri), b = renderNodes(split);
    assert(split.length === 4 && a.every((v, i) => Math.abs(v - b[i]) < 1e-5), "splitting changed the shape");
  });
  check("convert to nodes fits a sine closely with few nodes", () => {
    const fn = name => { const i = src.indexOf(`\nfunction ${name}(`); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
    vm.runInContext(`${fn("fitNodes")}globalThis.__fit = fitNodes;`, ctx);
    const d = Float32Array.from({ length: N }, (_, n) => Math.sin(2 * Math.PI * n / N)), ns = probe("__fit")(d, 12), r = renderNodes(ns);
    let e = 0; for (let n = 0; n < N; n++) e = Math.max(e, Math.abs(r[n] - d[n]));
    assert(ns.length <= 12 && e < 0.02, `${ns.length} nodes, max error ${e.toFixed(4)}`);
    return `${ns.length} nodes, max error ${e.toFixed(4)}`;
  });
  check("shape morph keeps node order (mismatched counts)", () => {
    const mid = lerpNodes(saw, tri, 0.5); assert(mid.length === 4 && mid[0].x === 0 && mid[3].x === 1 && mid[0].y === mid[3].y && mid.every((q, i) => !i || q.x >= mid[i - 1].x), JSON.stringify(mid));
  });
}

// share links: only plain-maths formulas run; recipes rebuild the same keyframes; linkPlan refuses broken links
{
  const safe = probe("safeFormula"), libSrc = [...html.matchAll(/libFmKfs\("((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
  check("safeFormula accepts every example and library formula", () => {
    const all = [...FORMULAS.map(f => f.src), ...libSrc], bad = all.filter(f => !safe(f));
    assert(all.length > 10 && !bad.length, bad.join(" | ")); return `${all.length} formulas`;
  });
  check("safeFormula refuses anything that could reach an object or a global", () => {
    const evil = ["fetch(1)", "x.constructor", "constructor", "this", "self", "(k => k)(fetch)", "\\u0066etch(1)", "`x`", "'a'", "\"a\"", "[1]", "{}", "x = 1", "x == 1",
      "new Function", "import(1)", "sin.call(0)", "globalThis", "eval(1)", "arguments", "N", "S => S", "self => 1", "ab => 1; fetch(1)", "sum(3, (k) => k)", "1..toString()", "x // fetch", "@", "=> 1"];
    const passed = evil.filter(f => safe(f)); assert(!passed.length, "allowed: " + passed.join(" | "));
  });
  const fn = name => { const i = src.indexOf(`\nfunction ${name}(`); assert(i >= 0, name); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
  vm.runInContext(`${fn("validSrc")}${fn("linkPlan")}globalThis.__lp = linkPlan;`, ctx);
  const plan = probe("__lp"), blk = new Float32Array(N).fill(0.25);
  const head = (k, extra = {}) => ({ v: 1, n: "t", fc: 16, m: "linear", fx: { fold: { on: true, a: 1, b: 2 } }, fm: ["sin(p + t)"], k, ...extra });
  check("linkPlan reads every keyframe kind and fills transforms back in", () => {
    const r = plan({ head: head([[0, "s", ["saw", 0.5, 1023]], [0.3, "f", 0], [0.6, "n", [0, 0, 0, 0.5, 1, 0, 1, 0, 0]], [1, "r", 0]]), blocks: [blk] });
    assert(r.fc === 16 && r.mode === "linear" && r.fx.fold.on && r.fx.fold.b === 2 && r.fx.order.length === FX_KEYS.length, "header");
    assert(r.kfs[0].src.sh[0] === "saw" && r.kfs[1].src.fm === "sin(p + t)" && r.kfs[2].nodes.length === 3 && r.kfs[3].data === blk, JSON.stringify(r.kfs.map(k => Object.keys(k))));
  });
  check("linkPlan refuses broken and hostile links", () => {
    const cases = [{ v: 2, k: [[0, "r", 0]] }, head([]), head([[0, "r", 1]]), head([[0, "r", 0], [1, "r", 0]]), head([[0, "f", 3]]), head([[0, "s", ["noise", 0.5, 9]]]),
      head([[0, "s", ["toString", 0.5, 9]]]), head([[0, "x", 0]]), head([[0, "f", 0]], { fm: ["fetch(1)"] }), head([[0, "n", [0, 0]]]), head(Array(65).fill([0, "s", ["saw", 0.5, 9]]))];
    const passed = cases.filter(h => { try { plan({ head: h, blocks: [blk] }); return true; } catch (e) { return false; } });
    assert(!passed.length, `${passed.length} accepted: ${JSON.stringify(passed[0])}`);
  });
  check("recipes job rebuilds formula and shape keyframes exactly", () => {
    const f = probe("compileFormula")("sin(p + t*6*sin(2*p))"), want = probe("formulaFrame")(f, 0.4, 25), saw = probe("genShape")("saw", 0.5, 1023);
    const [a, b] = run("recipes", { items: [{ fm: "sin(p + t*6*sin(2*p))", t: 0.4, i: 25 }, { sh: ["saw", 0.5, 1023] }] });
    assert(a.every((v, i) => v === want[i]) && b.every((v, i) => v === saw[i]), "rebuilt keyframe differs");
    let msg = ""; try { run("recipes", { items: [{ fm: "fetch(1)", t: 0, i: 0 }] }); } catch (e) { msg = e.message; } assert(/plain maths/.test(msg), msg || "ran it");
  });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

// The template literal inside buildWorkerURL, so a change there is noticed.
function buildURLWrapper(s) { const i = s.indexOf("function buildWorkerURL()"); return i < 0 ? "" : s.slice(i, s.indexOf("\n}", i)); }
