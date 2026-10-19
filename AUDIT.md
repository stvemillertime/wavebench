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
2. [x] Quota exceeded: old autosave stays, warning shown once → stale "Restored". Persistent "autosave off" indicator; skip unchanged JSON; consider IndexedDB. → indicator + retry on every change, unchanged JSON skipped. IndexedDB: My library (Batch D) keeps saved tables in IndexedDB (localStorage, then memory, where it is blocked); autosave of the session stays in localStorage.
3. [x] No flush on `pagehide`/`visibilitychange` → last edit lost on close.
4. [x] Multiple tabs clobber one `AUTOSAVE_KEY` (3119) — warn via `storage` event/BroadcastChannel. → `storage` event pauses autosave in the other tab, with the indicator.
5. [x] Keyboard changes on sliders (`#fc` 1546, FX ranges 2549) skip pushUndo; freezeHead (872) can then rewrite a past/pinned step. Push on first input of gesture; never overwrite pinned/parent steps. → `gestureUndo`; freezeHead branches an "Edit" step instead; pinning the head freezes it.
6. [x] No-op click after undo creates empty child and kills Redo (880). → pushUndo arms; the step is only made once the state changes (`settleHist`).
7. [x] Bank Remove/Overwrite (3519-3535): no undo, no confirm. → one-level "Undo remove/overwrite" button in the bank.
8. [x] Image/Resynth push a full-table undo per control tweak → floods 80-step cap. Coalesce same-label leaf steps; cap pins. → `pushUndo(label, merge)`; a new image/sample A still gets its own step; pins capped at 32.
9. [x] parseWav robustness: ch=0, fmt sz<16, use blockAlign as stride, 16/24-bit float, mix stereo (or say left only); odd chunk pad. wavBuffer: odd data pad byte, f32 cbSize/fact. → half float read, 24-bit float refused with a message; multichannel mixed to mono.
10. [x] cleanBase (1749) with Safe off: `..` → ZIP path traversal, trailing dots, `con`/`nul`, non-ASCII collapses to `___`. → Unicode letters kept (NFC), leading/trailing dots and spaces stripped, device names get `-x`, 100-char cap.

## Batch 3 — Audio / input ✅ done (branch `fix/audit-batch3`; tests: `node tools/synth.mjs`)

1. [x] Focused `<select>` (synPreset, mode, midiIn) eats piano keys and type-to-find changes preset/mode. Blur after change. → also: a focused select keeps only arrows/Enter/Space/Tab/Esc; letters and digits go to notes/shortcuts.
2. [x] MIDI: note-offs from non-selected inputs dropped (4270) → stuck notes when switching/unplugging. Always pass note-offs; allNotesOff on change/disconnect.
3. [x] Computer keys tracked by `e.key` → Option/Cmd mid-note sticks. Use `e.code`; release all on Meta keyup. → Z/X octave by `e.code` too, and piano keys are checked before letter shortcuts so other layouts can't collide.
4. [x] Click on table swap under held note (worklet `this.tab = m`, 1875). Crossfade old/new over 128-256 samples. → 256 samples.
5. [x] refreshWave (2084) is a debounce → sound never updates during a continuous drag. Throttle + trailing. → 40 ms throttle while a note sounds, 250 ms debounce when idle.
6. [x] Mip selection bias lets aliasing through (1909-1932). Bias to ceil / ~0.7. → +0.7: the brighter level tops out ~16.7 kHz at 48 kHz.
7. [x] Zipper: cutoff/vol/pos updated per block, pos per rAF. Per-sample smoothing. → 15 ms one-pole per block, then per-sample linear ramps of pos, filter g and amp.
8. [x] Voice steal/panic hard-cut → clicks. 2-5 ms forced release. → 3 ms; up to 16 voices briefly while stolen ones fade.
9. [x] Per-block allocations in process() (1898, 1920, 1892). Preallocate. → also no `filter()`, and no pos posts while silent.
10. [x] No `onprocessorerror`; no output soft-clip (12 voices + res → +28 dB). → crash falls back to the plain oscillator with a message; soft clip transparent below 0.6, max ±1.
11. [x] Shortcuts: Cmd+S/O blocked in text fields (2155); Space re-fires last clicked button; Backspace on a focused slider deletes keyframe, and auto-repeats (2167); Play button not keyboard-operable and right-click can stick a note. → Space defers to a control only when it has `:focus-visible`.
12. [x] Sweep on by default fights Scan slider / , . / image click (2199). Rebase or turn sweep off on manual scan. → turned off by Scan slider, `,` `.`, `[` `]`, strip card click, image click, spectrum click, MIDI scan CC.
13. [x] Draw canvases: no `e.button`/`isPrimary` check (1501, 1540, 3878); spectral paint strength depends on event rate. → a stroke now reaches Strength once per bin (tracks the strongest weight each bin has had).

## Batch 4 — Performance (snappiness) ✅ done (branch `fix/audit-batch4`; timings: `node tools/bench.mjs`)

Measured (node, this Mac): spectral computeFrames 5.7 ms (prototype 2.7 ms), buildMips 8.9 ms, applyFx 23-35 ms with time-domain FX, non-pow2 export 3.3 s for 64×2936.

After (node `tools/bench.mjs`, then the page with direct calls, Chrome, DPR 2): computeFrames 5.8 → 2.5 ms (1.8 ms after a one-keyframe edit with the page's cache); buildMips 9.3 → 7.7 ms and now off the main thread; applyFx (fold+sat) 32 → 24 ms, live preview 25 → 8 ms wall split over 4 workers; non-pow2 export prep 64×2936 225 → 21 ms (64×734 24 → 6 ms), and on a worker. Page: `update()` with nothing changed 0.8 → 0.1 ms, after a keyframe edit 7.1 → 2.6 ms, one scan step 0.6 → 0.1 ms. (3.3 s was before Batch 1's trig table; 225 ms was the starting point here.)

1. [x] Editor hover (1313/1323) calls full `renderEditor` per pointermove, outside rAF, incl. shadowBlur trace + spectrum. rAF-coalesce; overlay canvas for crosshair. → `#edHover`/`#edSpecHover` overlays drawn by `renderEdHover` once per frame; the editor itself redraws only when what it shows changes.
2. [x] `update()` (1404) redraws everything. Route `#scan` and image drag through `setScan`; add dirty flags. → each renderer keys on what it draws (`changed()` memo: data arrays, colours, size, DPR) and skips otherwise; `setScan` draws only scan views, next frame.
3. [x] computeFrames: cache per-keyframe spectra (WeakMap), precompute magnitudes, reuse scratch buffers, recompute only between changed keyframe's neighbours. → plus real-input `spec`/`ispec` on a half-size FFT and `mag()` instead of `Math.hypot` (both used everywhere).
4. [x] buildMips on main thread every 30 ms while a note is held → move to a worker slot, transfer to worklet. → "mips" slot, one job in flight, numbered so a late result never replaces a newer table; the first table and note-on with a changed table still build inline so a note never starts on a stale table.
5. [x] Spectral paint: ispec inside pointermove, up to ~180 iFFTs/event. Mark dirty, ispec once per rAF. → `flushStroke` in `update()` and at stroke end.
6. [x] renderSpecView rebuilds all columns per change; per-pixel array alloc in cmap. Per-frame column cache + 256-entry LUT.
7. [x] render3D: Path2D cache, per-theme colours, offscreen base layer; coalesce setScan + showPlayPos. → Path2D per frame array (drawn translated), colours per theme, one rAF for scan + play marker, and no redraw when nothing moved. Offscreen base layer not done: the 0.88-alpha fills mean a highlighted frame can't be redrawn over a cached stack without changing how the frames in front of it look.
8. [x] renderHist/renderBank/renderLib rebuild DOM + forced layout per card, even when hidden. Keyed reuse; skip when hidden. → `keyed()` reuse for history steps, pins, bank rows; thumbnails redraw only when their frames, theme or DPR change; all skip while their pane is hidden and catch up on `setDock`.
9. [x] Every update: paintRanges (all ranges), readColors (getComputedStyle), fit() getBoundingClientRect, innerHTML writes, exportOpts ×4. Use ResizeObserver-cached sizes; write only on change. → `sizeOf()` (ResizeObserver) for the page canvases, `put()` for text/value writes, slider fills written only when moved, colours read on theme change only, export info only with Export open.
10. [x] syncFx on every FX slider input; drawCurve resets canvas size each call. → `syncFxRow` for the touched transform; drawCurve skips when points/size/theme are unchanged.
11. [x] renderImg high-quality resamples source image every update → cache scaled bitmap.
12. [x] checkTable every table change (~1-2 ms) even when Export hidden → debounce/idle. → only with Export open, debounced then `requestIdleCallback`.
13. [x] renderStrip rebuilds cards during `#fc` drag; body ResizeObserver redraws library thumbs. → cards kept per keyframe id, minis redraw on data change; body observer redraws library thumbs only on a width change.
14. [x] Live FX: split frames across 2-4 workers or priority-render scan frame first. → split over up to 4 "live" workers (`fxPart`), joined and levelled on the page (`fxFinish`); identical output.
15. [x] sweepLoop rAF runs forever; worklet posts pos while silent. → loop runs only while Sweep is on; worklet posts pos only when it moves (and once when it goes silent).
16. [x] Non-pow2 export resample: cos/sin table instead of Math.cos per term; run on worker. → Bluestein chirp-z (`dftAny`) instead of the harmonic sum, so any size is O(n log n); single-file export renders on the "wav" worker.
17. [x] Random/mutate renders each state twice (tooQuiet + thumb). → the quiet check's render is kept (non-enumerable `st.frames`) for the thumbnail.
18. [x] DPR change not handled (blurry canvases across displays). → `resolution` media query re-armed on each change; every renderer keys on DPR.

## Batch 5 — UX polish / contradictions ✅ done (branch `fix/audit-batch5`)

1. [x] Three names for loudness evening: "Even out loudness" / "Transform level match" / "Even loudness" (555, 2642, 3420). → "Even out loudness" everywhere (checkbox, undo step, report).
2. [x] Bank report prints internal morph names `linear/spectral/step` (3435) — UI says Crossfade. → report prints Spectral / Crossfade / Step.
3. [x] Transforms tab badge ignores `fx.level` (2576). → counts Even out loudness too, and updates when it's toggled.
4. [x] Octave `<label>` wraps buttons → clicking "Oct" lowers octave (518). → `<span role=group aria-label="Octave">`, buttons named "Octave down/up".
5. [x] Phone width overflows (`.tp-b` needs flex-wrap, 220). → `.tp-b` wraps; editor and dock tabs wrap instead of hiding; no horizontal scroll at 375 px.
6. [x] Dark mode lacks `color-scheme` → native controls/dialog stay light. → `color-scheme: light dark`, pinned to light/dark when the theme button forces one.
7. [x] Three "Reset" buttons with very different effects; the irreversible one sits by New (309, 557, 636). → top-bar one is "Reset app…" at the far right (danger confirm); Transforms one is "Clear transforms"; template one is "Revert".
8. [x] Status bar: truncated with no way to read, no `role=status`, hints shown as red errors (2621, 1571, 3893, 3918). → `role=status`, full text on hover and click/Enter to expand; "can't do that" messages are amber `"hint"`, not red.
9. [x] Missing accessible names (#shape, #pw, #hl, #blend, #sp*, #rs*, #scan, #rate, #vol, #genAmt); tabs lack ARIA roles; segmented toggles lack aria-pressed; editor tabs overflow hidden at narrow width. → bare `<label>` before a control is tied to it (`nameControls`), #shape/#rate/FX sliders get aria-labels, tabs get `role=tab` + aria-selected, `.seg` buttons mirror "on" into aria-pressed.
10. [x] Undo/Redo tooltips could name the step; native confirm() clashes with styled dialog; "Sweep" means two things. → Undo/Redo tooltips name the step; `ask()` styled dialog replaces every `confirm()`; the Transforms "Sweep shape" is now "Start → End curve".
11. [x] Synchronous wetTable() for Export / Bake / Snapshot with no progress (1861, 2647, 3753). → `wetTableAsync`: a pending wet table renders on the "snap" worker with a progress row and Cancel, then becomes the page's table; bails if the table changed meanwhile.
12. [x] README undersells (no mention of Vital import, Library, Generate, History, Synth, MIDI; MicroFreak 32 frames). → feature list covers Vital import, Library, Generate, History, Synth, MIDI, autosave, MicroFreak 32 frames.
13. [x] Mixed drops partially ignored silently (routeFiles 3243); history/pins not saved but "Restored your last session" implies all. → files a drop didn't load are named on the status bar after the load; restore message says history and snapshots start fresh.
