# Wavebench

A wavetable workbench for the Elektron Tonverk, by [@stvemillertime](https://github.com/stvemillertime).

**Use it now: https://stvemillertime.github.io/wavebench/**

Wavebench builds 2048 × 64 wavetables in the browser. Nothing to install, no account, no server: your work stays on your machine.

- Draw keyframes from band-limited shapes, harmonic sliders, math expressions or freehand
- Import single-cycle waves or resynthesize frames from any sample (Serum `clm` and `_wt1024` names are recognised)
- Morph between keyframes (spectral or crossfade) and run an FX chain that sweeps across the table
- View the table in 3D or as a spectrum, paint harmonics directly, and play it from your computer keyboard
- Collect tables into a bank and export it ready for the Tonverk card, with a printable report
- Save and reopen projects as `.wtproj.json`

## Run it offline

Wavebench is a single self-contained file. Download [`index.html`](index.html) (Raw → Save As) and double-click it. It works from `file://` in any modern browser.

## Hosting

The site is published by GitHub Pages from `main` using [the Pages workflow](.github/workflows/pages.yml). In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.
