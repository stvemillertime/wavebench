// Preview-synth worklet test: pulls SYNTH_SRC out of index.html, runs the processor in node with a stub
// AudioWorkletProcessor, and checks for clicks (table swap, panic, voice steal), bounded output and no NaN.
//   node tools/synth.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const m = html.match(/const SYNTH_SRC = `([\s\S]*?)`;/);
let failed = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failed++; };
if (!m) { console.log("FAIL SYNTH_SRC not found"); process.exit(1); }

const SR = 48000, B = 128, N = 2048;
let Proc = null;
const ctx = vm.createContext({
  sampleRate: SR, Math, Float64Array, Float32Array, console,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
  registerProcessor: (_, c) => { Proc = c; },
});
vm.runInContext(m[1], ctx, { filename: "synth-worklet.js" });

// same level layout as the page's buildMips; every level holds one cycle of sign * sin, which is band-limited at any level
const LV_H = Array.from({ length: 11 }, (_, l) => l ? 1024 >> l : N / 2 - 1);
const LV_LEN = LV_H.map(h => Math.min(N, Math.max(256, 8 * h)));
// dc: a constant level instead, so a hard cut shows up as a full-size step whatever the phase
const table = (sign, nf = 4, dc = false) => ({ t: "table", nf, lv: LV_LEN.map(len => {
  const d = new Float32Array(nf * len);
  for (let f = 0; f < nf; f++) for (let i = 0; i < len; i++) d[f * len + i] = dc ? sign : sign * Math.sin(2 * Math.PI * i / len);
  return { len, d };
}) });
const P = { posEnv: 0, lfoAmt: 0, lfoRate: 0.35, uni: 1, det: 12, spread: 0.5, velAmt: 0, cut: 20000, res: 0.1, fenv: 0,
  aA: 0.002, aD: 0.3, aS: 1, aR: 0.15, mA: 0.001, mD: 1, mS: 0, mR: 0.5, vol: 0.36 };

function make(p = P) {
  const s = new Proc(), send = d => s.port.onmessage({ data: d });
  send({ t: "p", p: { ...p } }); send(table(1));
  return { s, send, run(blocks) {
    const out = [];
    for (let b = 0; b < blocks; b++) {
      const L = new Float32Array(B), R = new Float32Array(B);
      s.process([], [[L, R]]); out.push(...L);
    }
    return out;
  } };
}
const maxJump = a => { let j = 0; for (let i = 1; i < a.length; i++) j = Math.max(j, Math.abs(a[i] - a[i - 1])); return j; };
const finite = a => a.every(Number.isFinite);

// A 55 Hz sine moves at most ~2*pi*55/48000*amp per sample; a hard swap to the inverted table jumps ~2*amp.
{
  const t = make(); t.send({ t: "on", n: 33, vel: 1 });
  const steady = t.run(200), base = maxJump(steady);
  t.send(table(-1)); const after = [steady.at(-1), ...t.run(20)];
  ok(finite(after), "table swap: output finite");
  ok(maxJump(after) < base * 3, `table swap crossfades (max step ${maxJump(after).toFixed(4)} vs steady ${base.toFixed(4)})`);
}
{
  const t = make({ ...P, cut: 20000, res: 0 }); t.send(table(1, 4, true)); t.send({ t: "on", n: 33, vel: 1 }); const pre = t.run(200).at(-1);
  t.send({ t: "panic" }); const after = [pre, ...t.run(4)];
  ok(maxJump(after) < 0.36 / 100, `panic fades instead of cutting (max step ${maxJump(after).toFixed(4)})`);
  ok(Math.max(...after.slice(1 + B * 2).map(Math.abs)) === 0, "panic is silent within 3 blocks (~8 ms)");
  ok(t.s.v.length === 0, "panic frees every voice");
}
{
  const t = make({ ...P, cut: 20000, res: 0, vol: 0.02 }); t.send(table(1, 4, true));
  for (let n = 0; n < 12; n++) t.send({ t: "on", n: 30 + n, vel: 1 });
  const pre = t.run(200).at(-1); t.send({ t: "on", n: 60, vel: 1 }); const after = [pre, ...t.run(10)];
  ok(maxJump(after) < 0.02 / 50, `voice steal fades the stolen voice (max step ${maxJump(after).toFixed(5)})`);
  ok(t.s.v.length <= 16, `voice count stays capped (${t.s.v.length})`);
  for (let n = 0; n < 40; n++) t.send({ t: "on", n: 40 + n, vel: 1 });
  t.run(2); ok(t.s.v.length <= 16, "a burst of 40 notes never exceeds 16 voices");
}
{
  const t = make({ ...P, uni: 7, det: 50, res: 1, cut: 300, vol: 0.6 });
  for (let n = 0; n < 12; n++) t.send({ t: "on", n: 36 + n, vel: 1 });
  const out = t.run(400);
  ok(finite(out), "12 voices × 7 unison, full resonance: output finite");
  ok(Math.max(...out.map(Math.abs)) <= 1, `soft clip keeps output within ±1 (peak ${Math.max(...out.map(Math.abs)).toFixed(3)})`);
}
{
  // Cutoff and volume jumps are smoothed: steps in the output envelope stay small.
  const t = make({ ...P, cut: 200, res: 0 }); t.send({ t: "on", n: 33, vel: 1 }); const a = t.run(200);
  t.send({ t: "p", p: { ...P, cut: 20000, res: 0, vol: 0.05 } }); const b = t.run(50);
  ok(finite(b) && maxJump(b) < Math.max(maxJump(a) * 3, 0.01), "cutoff/volume changes are smoothed");
  t.send({ t: "pos", v: 1 }); ok(finite(t.run(10)), "position jump: output finite");
}
{
  // Mip choice: the strongest level used for a note must not carry harmonics far past Nyquist.
  for (const n of [60, 84, 96, 108]) {
    const hz = 440 * 2 ** ((n - 69) / 12), lv = Math.min(10, Math.max(0, Math.log2(1024 * hz / (0.5 * SR)) + 0.7));
    const l0 = Math.floor(lv), w0 = 1 - (lv - l0), top = LV_H[l0] * hz;
    ok(w0 < 0.05 || top < 0.5 * SR * 1.25, `note ${n}: level ${l0} (weight ${w0.toFixed(2)}) tops out at ${(top / 1000).toFixed(1)} kHz`);
  }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
