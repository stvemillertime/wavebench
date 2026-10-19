// DSP timings for the hot paths, run on the worker body (index.html's /*@dsp*/ regions) in node.
//   node tools/bench.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const src = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).at(-1);
const open = "/*@" + "dsp*/", close = "/*@" + "end*/";
const body = `"use strict";\nconst WFORMULAS = [];\n${src.split(open).slice(1).map(p => p.slice(0, p.indexOf(close))).join("\n")}`;
// a plain function scope, not a vm context: vm globals go through an interceptor and run ~10x slower than a page
const P = new Function("self", body + "\nreturn e => eval(e);")(globalThis);

function time(name, fn, reps = 20) {
  for (let i = 0; i < 3; i++) fn(i);
  const t = [];
  for (let i = 0; i < reps; i++) { const a = performance.now(); fn(i); t.push(performance.now() - a); }
  t.sort((a, b) => a - b);
  console.log(`${name.padEnd(34)} median ${t[t.length >> 1].toFixed(2).padStart(8)} ms   min ${t[0].toFixed(2).padStart(8)} ms`);
}

const st = P("randomState(7)"), kfs = st.kfs;
const spectral = Array.from({ length: 4 }, (_, i) => ({ id: 100 + i, f: i / 3, data: kfs[i % kfs.length].data }));
time("computeFrames spectral 64f 4kf", () => P("computeFrames")(spectral, 64, "spectral"));
// an edit replaces one keyframe's data array; the page passes a cache, so only that keyframe's neighbours re-render
const cache = {}, edited = spectral.map(k => ({ ...k }));
time("computeFrames spectral, 1 kf edited", i => { edited[1] = { ...edited[1], data: edited[1].data.slice() }; edited[1].data[0] += 1e-6; P("computeFrames")(edited, 64, "spectral", cache); });
const frames = P("computeFrames")(spectral, 64, "spectral");
if (P("typeof buildMips") === "function") time("buildMips 64f", () => P("buildMips")(frames));
const fx = P("defaultFx()"); fx.fold.on = true; fx.sat.on = true;
time("applyFx 64f, time-domain (fold+sat)", () => P("applyFx")(frames, fx, spectral), 10);
const fx2 = P("defaultFx()"); fx2.filt.on = true; fx2.formant.on = true;
time("applyFx 64f, spectral (filt+formant)", () => P("applyFx")(frames, fx2, spectral), 10);
const o = { maxF: 64, pow2: false, dc: true, fs: 2936, fmt: "i16", sr: 48000, norm: true, clm: false };
time("export prep 64x2936 (non-pow2)", () => P("prepFrames")(frames, o), 3);
time("export prep 64x734 (non-pow2)", () => P("prepFrames")(frames, { ...o, fs: 734 }), 3);
