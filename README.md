# Wavetable Lab

A wavetable workbench for hardware and software synths, by [@stvemillertime](https://github.com/stvemillertime).

**Use it now: https://stvemillertime.github.io/wavetable-lab/**

Wavetable Lab builds 2048 × 64 wavetables in the browser. Nothing to install, no account, no server: your work stays on your machine.

- Draw keyframes from band-limited shapes, harmonic sliders, math expressions, freehand, or nodes joined by bendable curves (Vital-style)
- Import single-cycle waves, whole wavetable WAVs (Serum `clm` and `_wt1024` names are recognised) and Vital `.vitaltable` / `.vital` files, or resynthesize frames from any sample, with an optional second sample morphed in
- Turn an image into a table: each line of pixels becomes a frame, read as a harmonic spectrum or as the waveform
- Morph between keyframes (spectral, node shape, or crossfade) and run a chain of transforms that moves from a Start to an End setting across the table
- View the table in 3D or as a spectrum, and paint harmonics directly on the spectrum
- Play it on a polyphonic preview synth (unison, filter, envelopes, LFO on the scan position) from your computer keyboard or a MIDI keyboard, with a MIDI CC for the scan position
- Start from the factory Library, or let Generate make seeded random tables and mutations of the current one
- Branching undo History: jump to any step, pin snapshots and A/B them against what you're editing
- Export with templates for the Elektron Tonverk, Serum / Vital and other DAW synths, the Elektron Digitakt II, the Arturia MicroFreak (up to 32 frames), or plain WAV
- Collect tables into a bank and export it as one ZIP, with optional loudness matching, a README and a printable report
- Save and reopen projects as `.wtproj.json`; your session is also autosaved in the browser

## Run it offline

Wavetable Lab is a single self-contained file. Download [`index.html`](index.html) (Raw → Save As) and double-click it. It works from `file://` in any modern browser.

## Hosting

The site is published by GitHub Pages from `main` using [the Pages workflow](.github/workflows/pages.yml). In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
