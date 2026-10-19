# Wavebench audit — 2026-10-18

Five-way read-only audit of `index.html` (UI perf, DSP, state/export, audio/input, UX). Line numbers are as of commit 7dddea5.
✔ = verified against source or reproduced in node/browser.

## Batch 1 — Correctness bugs ✅ done (branch `fix/audit-batch1`; regression test: `node tools/smoke.mjs`)

1. [x] ✔ **`removeDC` defined twice (778 and 2215), both inside `/*@dsp*/`.** The 2-arg one wins, so every 1-arg call is a no-op: Remove DC button (1441), Table › Remove DC (1466), genShape (814: halfsine/abssine/pulse keep DC), formulas (2678), resynth (2752/2759), importMany (3190), image wave mode (3290). Export "Remove DC per frame" (1776, `frames.forEach(removeDC)`) is *worse*: index passed as M → a step into frame i. Fix: rename FX one `removeDCn(x, M)` (callers ~2341/2360/2373/2411 + Flip), and change 1776 to `frames.forEach(f => removeDC(f))`.
2. [x] ✔ **Worker ReferenceErrors.** `NOTES` (1705) and `noteLabel` (1706) are outside `/*@dsp*/`, but `noteName` (2791) and `bankReportHTML` (3429) use them inside the worker → Resynth fails for every method except "raw"; Bank ZIP with report / Build report fail when "Tuned to" is set (Digitakt II default). Fix: wrap NOTES/noteLabel/noteFs in `/*@dsp*/`. Add a node smoke test that builds the worker body and runs every JOB.
3. [x] **`readAt` (2214) can read `x[M]`** when q is a tiny negative → whole frame NaN (Phase mod a=0 b=0.81 curve "in" ratio 6, frame 35). Fix: `i0 % M`; scrub non-finite in fxFrame output.
4. [x] **NaN/Inf from float WAVs** not scrubbed in parseWav/importFile/importMany; f32 export writes unclamped `s` (1618).
5. [x] **mergeFx (2463) accepts `__proto__`/`constructor`** in `order` → TypeError every frame, persisted via autosave. Use `Object.hasOwn`.
6. [x] ✔ **Table menu undo label always "Table…"** (1452: value reset before reading selectedOptions).
7. [x] **Export check runs on `table`, not `prepFrames(table, o)`** (1843) → misses clipping/jumps from resampling/thinning.
8. [x] **Spectral morph overshoot** (peaks to 1.30) unnormalized when no transforms → silent clipping in int exports with Normalize off.
9. [x] **resample for non-pow2 cycles** (750) uses linear interp + wrong H cap → −5 dB HF loss + images (AKWF 600, Digitakt 734/367 round trips).

## Batch 2 — Data safety (state / autosave / history) ✅ done (branch `fix/audit-batch2`; tests: `node tools/io.mjs`)

1. [x] Failed `restoreAutosave` (3133) silently overwritten by defaults ~1.2 s later (also: older index.html copy opened under file:// wipes newer session, Chrome shares file:// storage). Back up raw value, block autosave, show error. → raw copied to `…autosave.unreadable`, autosave stays off until you choose; dialog offers Download / Save project / Turn autosave on.
2. [x] Quota exceeded: old autosave stays, warning shown once → stale "Restored". Persistent "autosave off" indicator; skip unchanged JSON; consider IndexedDB. → indicator + retry on every change, unchanged JSON skipped. IndexedDB not done.
3. [x] No flush on `pagehide`/`visibilitychange` → last edit lost on close.
4. [x] Multiple tabs clobber one `AUTOSAVE_KEY` (3119) — warn via `storage` event/BroadcastChannel. → `storage` event pauses autosave in the other tab, with the indicator.
5. [x] Keyboard changes on sliders (`#fc` 1546, FX ranges 2549) skip pushUndo; freezeHead (872) can then rewrite a past/pinned step. Push on first input of gesture; never overwrite pinned/parent steps. → `gestureUndo`; freezeHead branches an "Edit" step instead; pinning the head freezes it.
6. [x] No-op click after undo creates empty child and kills Redo (880). → pushUndo arms; the step is only made once the state changes (`settleHist`).
7. [x] Bank Remove/Overwrite (3519-3535): no undo, no confirm. → one-level "Undo remove/overwrite" button in the bank.
8. [x] Image/Resynth push a full-table undo per control tweak → floods 80-step cap. Coalesce same-label leaf steps; cap pins. → `pushUndo(label, merge)`; a new image/sample A still gets its own step; pins capped at 32.
9. [x] parseWav robustness: ch=0, fmt sz<16, use blockAlign as stride, 16/24-bit float, mix stereo (or say left only); odd chunk pad. wavBuffer: odd data pad byte, f32 cbSize/fact. → half float read, 24-bit float refused with a message; multichannel mixed to mono.
10. [x] cleanBase (1749) with Safe off: `..` → ZIP path traversal, trailing dots, `con`/`nul`, non-ASCII collapses to `___`. → Unicode letters kept (NFC), leading/trailing dots and spaces stripped, device names get `-x`, 100-char cap.

## Batch 3 — Audio / input

1. Focused `<select>` (synPreset, mode, midiIn) eats piano keys and type-to-find changes preset/mode. Blur after change.
2. MIDI: note-offs from non-selected inputs dropped (4270) → stuck notes when switching/unplugging. Always pass note-offs; allNotesOff on change/disconnect.
3. Computer keys tracked by `e.key` → Option/Cmd mid-note sticks. Use `e.code`; release all on Meta keyup.
4. Click on table swap under held note (worklet `this.tab = m`, 1875). Crossfade old/new over 128-256 samples.
5. refreshWave (2084) is a debounce → sound never updates during a continuous drag. Throttle + trailing.
6. Mip selection bias lets aliasing through (1909-1932). Bias to ceil / ~0.7.
7. Zipper: cutoff/vol/pos updated per block, pos per rAF. Per-sample smoothing.
8. Voice steal/panic hard-cut → clicks. 2-5 ms forced release.
9. Per-block allocations in process() (1898, 1920, 1892). Preallocate.
10. No `onprocessorerror`; no output soft-clip (12 voices + res → +28 dB).
11. Shortcuts: Cmd+S/O blocked in text fields (2155); Space re-fires last clicked button; Backspace on a focused slider deletes keyframe, and auto-repeats (2167); Play button not keyboard-operable and right-click can stick a note.
12. Sweep on by default fights Scan slider / , . / image click (2199). Rebase or turn sweep off on manual scan.
13. Draw canvases: no `e.button`/`isPrimary` check (1501, 1540, 3878); spectral paint strength depends on event rate.

## Batch 4 — Performance (snappiness)

Measured (node, this Mac): spectral computeFrames 5.7 ms (prototype 2.7 ms), buildMips 8.9 ms, applyFx 23-35 ms with time-domain FX, non-pow2 export 3.3 s for 64×2936.

1. Editor hover (1313/1323) calls full `renderEditor` per pointermove, outside rAF, incl. shadowBlur trace + spectrum. rAF-coalesce; overlay canvas for crosshair.
2. `update()` (1404) redraws everything. Route `#scan` and image drag through `setScan`; add dirty flags.
3. computeFrames: cache per-keyframe spectra (WeakMap), precompute magnitudes, reuse scratch buffers, recompute only between changed keyframe's neighbours.
4. buildMips on main thread every 30 ms while a note is held → move to a worker slot, transfer to worklet.
5. Spectral paint: ispec inside pointermove, up to ~180 iFFTs/event. Mark dirty, ispec once per rAF.
6. renderSpecView rebuilds all columns per change; per-pixel array alloc in cmap. Per-frame column cache + 256-entry LUT.
7. render3D: Path2D cache, per-theme colours, offscreen base layer; coalesce setScan + showPlayPos.
8. renderHist/renderBank/renderLib rebuild DOM + forced layout per card, even when hidden. Keyed reuse; skip when hidden.
9. Every update: paintRanges (all ranges), readColors (getComputedStyle), fit() getBoundingClientRect, innerHTML writes, exportOpts ×4. Use ResizeObserver-cached sizes; write only on change.
10. syncFx on every FX slider input; drawCurve resets canvas size each call.
11. renderImg high-quality resamples source image every update → cache scaled bitmap.
12. checkTable every table change (~1-2 ms) even when Export hidden → debounce/idle.
13. renderStrip rebuilds cards during `#fc` drag; body ResizeObserver redraws library thumbs.
14. Live FX: split frames across 2-4 workers or priority-render scan frame first.
15. sweepLoop rAF runs forever; worklet posts pos while silent.
16. Non-pow2 export resample: cos/sin table instead of Math.cos per term; run on worker.
17. Random/mutate renders each state twice (tooQuiet + thumb).
18. DPR change not handled (blurry canvases across displays).

## Batch 5 — UX polish / contradictions

1. Three names for loudness evening: "Even out loudness" / "Transform level match" / "Even loudness" (555, 2642, 3420).
2. Bank report prints internal morph names `linear/spectral/step` (3435) — UI says Crossfade.
3. Transforms tab badge ignores `fx.level` (2576).
4. Octave `<label>` wraps buttons → clicking "Oct" lowers octave (518).
5. Phone width overflows (`.tp-b` needs flex-wrap, 220).
6. Dark mode lacks `color-scheme` → native controls/dialog stay light.
7. Three "Reset" buttons with very different effects; the irreversible one sits by New (309, 557, 636).
8. Status bar: truncated with no way to read, no `role=status`, hints shown as red errors (2621, 1571, 3893, 3918).
9. Missing accessible names (#shape, #pw, #hl, #blend, #sp*, #rs*, #scan, #rate, #vol, #genAmt); tabs lack ARIA roles; segmented toggles lack aria-pressed; editor tabs overflow hidden at narrow width.
10. Undo/Redo tooltips could name the step; native confirm() clashes with styled dialog; "Sweep" means two things.
11. Synchronous wetTable() for Export / Bake / Snapshot with no progress (1861, 2647, 3753).
12. README undersells (no mention of Vital import, Library, Generate, History, Synth, MIDI; MicroFreak 32 frames).
13. Mixed drops partially ignored silently (routeFiles 3243); history/pins not saved but "Restored your last session" implies all.
