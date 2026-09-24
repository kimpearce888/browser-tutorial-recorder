# Browser Tutorial Recorder

> Turn any browser workflow into a polished, shareable tutorial — in seconds.

**Browser Tutorial Recorder** is a Chrome extension (Manifest V3) that records your clicks, typing, navigation, and form interactions, then lets you edit, annotate, and export the workflow as a step-by-step guide in 7 formats.

Everything stays on your device. No accounts, no cloud uploads, no telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)](https://developer.chrome.com/docs/extensions/mv3/)
[![Tests: 485](https://img.shields.io/badge/Tests-485%20passing-success)](./test-suite.mjs)
[![CI](https://github.com/kimpearce888/browser-tutorial-recorder/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/browser-tutorial-recorder/actions/workflows/ci.yml)
[![Version: 2.2.2](https://img.shields.io/badge/Version-2.2.2-ff7352)](./manifest.json)

**Version: v2.2.2** — a complete, from-scratch rewrite of the recording engine built for reliability.

---

## Why you'll love it

**Record once, share forever.** Click Start, do your workflow, click Stop. Every meaningful interaction becomes a step with a smart, auto-generated description — Click "Submit", Type "ada@example.com" into "Email" — showing the full current view with a click marker stamped on the image, exactly like Scribe and Tango.

**Edit like a pro.** Nine annotation tools (highlight, rectangle, circle, arrow, text, blur, redaction, spotlight, numbered markers), crop, merge, split, duplicate, reorder by drag, and a 60-step undo history.

**Export anywhere.** Standalone HTML, PDF/Print, animated GIF, Markdown, PNG, JSON, or plain text. Blur and redaction are baked in destructively — hidden content cannot be recovered.

**Privacy-first.** Password fields and sensitive inputs (configurable keywords) are masked on-page during recording, so secrets never reach a screenshot.

---

## Features

### Recording

- **One-click recording** with a live toolbar badge showing the step count
- **Action-focused event capture**: CLICK, DOUBLE_CLICK, RIGHT_CLICK, MIDDLE_CLICK, TYPE (with the typed text), SELECT, CHECKBOX, RADIO, SUBMIT, KEYBOARD, DROP, NAVIGATION, NEW_TAB — scrolling is positioning, not a step; a "Navigate to …" opener step starts every tutorial
- **Fire-and-forget event pipeline** — user actions are never dropped waiting on a screenshot
- **Clean, professional screenshots** — recorder UI is hidden during capture, steps keep the full current view by default (Scribe-style element close-ups are an opt-in in Settings), and the click marker is stamped onto the image by the service worker for a consistent look
- **Customizable cursor highlight** — pick a preset (classic ring, small yellow filled circle with blur, high-visibility, …) or fine-tune color, size, fill strength and glow in Settings, with a live preview; the live recording ring and the stamped marker always match
- **Multi-tab support** — follows your workflow across tabs and new windows automatically
- **SPA navigation capture** — records `history.pushState` / `hashchange` (React, Vue, Angular)
- **Smart double-click detection** via `event.detail` (browser-authoritative)
- **Submit retraction** — a SUBMIT following a CLICK on the same element retracts the redundant CLICK step
- **Auto-pause on idle** (configurable 0–600s timeout)
- **Sensitive field masking** — password fields and keyword-matched inputs are covered by opaque overlays while recording, including inside shadow DOM and iframes
- **Excluded domains** — recording pauses on listed domains (applies mid-recording)
- **Iframe support** — clicks inside iframes are located via same-origin walk or a cross-origin postMessage handshake
- **Discard option** — "Discard" deletes the in-progress recording instantly

### Editor

- **9 annotation tools**: highlight, rectangle, circle, arrow, text, blur, redaction, spotlight, numbered markers (sequential across the whole tutorial, with a "Next #" control to restart the series anywhere)
- **Step management**: crop (8-handle marquee: drag inside to move, outside to redraw, live W×H readout; annotations re-anchored), merge with next, split, duplicate, pointer-based drag-to-reorder
- **Readable full-page captures** — the editor opens screenshots fit-width by default (a 12,000 px tall page fills the pane and scrolls instead of shrinking into an unrecognizable strip), with zoom in/out buttons, Ctrl+wheel, fit-page mode and keyboard shortcuts
- **Annotation presets** — save and reuse your favorite styles
- **Undo / redo** with 60-step history (screenshots stored by reference — no memory bloat)
- **Recapture** — re-take a step's screenshot (viewport or scroll-stitched full page)
- **Fully customizable keyboard shortcuts** with conflict detection
- **Auto-save** with visible "Saved ✓" feedback

### Export

- **7 formats**: standalone HTML, PDF/Print, animated GIF, Markdown, plain text, PNG, JSON
- **Destructive privacy treatments** — blur and redaction are baked into exported images
- **GIF encoder** — fresh GIF89a + LZW implementation with a web-safe palette
- **Unicode-safe filenames**

### Dashboard

- **Search, filter, sort** with debounced search
- **Bulk operations** — multi-select, bulk export, bulk delete
- **Grid and list views**

### Settings

- **Keyboard shortcut rebinding** with conflict detection
- **Recording preferences** — capture delay, screenshot format, JPEG quality, idle timeout, sensitive keywords, excluded domains
- **Appearance** — light/dark/system theme, high contrast, GIF frame speed, preview auto-advance speed
- **Storage management** — export all, import, delete all, storage size indicator

### Preview

- **Guide mode** — step-by-step with Previous / Next
- **Watch mode** — auto-advances at configurable speed

---

## Install

### From source (developer mode)

1. Download and extract the ZIP from the [latest release](https://github.com/kimpearce888/browser-tutorial-recorder/releases/latest)
2. Open `chrome://extensions` in Chrome, Edge, Brave, Arc, or any Chromium browser
3. Toggle **Developer mode** on (top-right corner)
4. Click **Load unpacked** and select the extracted folder
5. Pin the Browser Tutorial Recorder icon to your toolbar

### Upgrading

Click the extension's **refresh icon** in `chrome://extensions` after updating. Your existing tutorials are preserved.

---

## Quick start

1. **Start recording** — click the extension icon, then **Start recording**
2. **Do your workflow** — navigate, click, type, scroll on any webpage
3. **Stop recording** — click the extension icon, then **Stop & save**
4. **Edit & annotate** — the editor opens automatically
5. **Export** — click **Export ▾** to download as HTML, PDF, GIF, Markdown, or other formats

---

## Keyboard shortcuts

### Global shortcuts (work anywhere in Chrome)

| Action | Shortcut |
|--------|----------|
| Start recording | `Alt+Shift+R` |
| Stop recording | `Alt+Shift+S` |
| Pause / resume | `Alt+Shift+P` |
| Open dashboard | `Ctrl+Shift+D` (Mac: `Cmd+Shift+D`) |

> Reassign global shortcuts at `chrome://extensions/shortcuts`.

---

## Privacy & security

- **No account, no cloud, no telemetry.** Every screenshot and tutorial is stored in IndexedDB on your device.
- **On-page masking** — sensitive fields are covered by opaque overlays *before* any screenshot is taken; the data is never rendered into pixels.
- **Recursive masking** — fields inside shadow DOM and same-origin/cross-origin iframes are masked too (each frame masks its own DOM).
- **Blur and redaction are destructive on export** — the flattened PNG/PDF/GIF cannot be reverse-engineered.
- **Excluded domains** — recording pauses on listed domains.
- **Internal pages blocked** — `file://`, `chrome://`, and other internal schemes are never recorded.
- **Image URL sanitization** — all screenshot URLs are validated `data:image/*` before use, blocking `javascript:` injection.

---

## Architecture (v2.0.0 — fresh rewrite, hardened in v2.0.1–v2.0.4)

The v2.0.0 recording engine was rebuilt from scratch around four reliability principles:

1. **Fire-and-forget event pipeline** — content scripts never wait for a response; the background processes events through a serialized capture queue. No `sendResponse` channel races.
2. **Append-only drafts** — steps live in memory and flush to IndexedDB incrementally (no multi-megabyte `storage.local` rewrites per event).
3. **Always-on masks** — sensitive-field overlays exist for the whole recording session, so capture needs zero coordination.
4. **Crash-safe rehydration** — if the service worker restarts mid-recording, the draft is recovered and the session resumes paused.
5. **Frame-targeted attach handshake** — content scripts say hello once per document; the background replies to the sending frame only, so the attach exchange can never ping-pong (the crash fixed in v2.0.1).
6. **Lifecycle-hardened session** — a 20 s keep-alive ping holds the service worker open for the whole recording, and if the worker ever restarts mid-session the draft resumes recording automatically instead of silently pausing (the lost-steps bug fixed in v2.0.2).

### Session lifecycle
- Sessions live in the service worker via `recorder-core.js` (pure state machine, fully unit-tested)
- Light UI state mirrors to `chrome.storage.session` for the popup
- Steps flush to an IndexedDB draft (debounced 400 ms) and finalize into a tutorial on Stop

### Project structure

```
.
├── manifest.json              # MV3 manifest
├── background.js              # Service worker — session wiring, capture queue, messages
├── recorder-core.js           # Pure recording state machine (unit-tested)
├── content.js                 # Content script — events, masks, iframe offsets, SPA nav
├── shared.js                  # IndexedDB + normalization + sanitization helpers
├── settings-store.js          # Settings defaults, sync, shortcut logic
├── common-ui.js               # Shared helpers for extension pages
├── popup.{html,js,css}        # Toolbar popup UI
├── dashboard.{html,js,css}    # Tutorial library — search, sort, bulk ops
├── editor.{html,js,css}       # Step editor — 9 annotation tools, crop, undo
├── preview.{html,js,css}      # Guide / watch mode playback
├── settings.{html,js,css}     # Settings tabs
├── print-export.{html,js,css} # Print / PDF export layout
├── exporter.js                # Renders annotated canvas + exports 7 formats
├── annotation-geom.js         # Pure annotation hit/rotate/crop geometry (unit-tested)
├── gif-encoder.js             # GIF89a + LZW encoder
├── theme-boot.js, theme.css   # Theme bootstrap + variables
├── test-suite.mjs             # Automated test suite (260 tests)
├── package.json               # Node dev dependencies (jsdom for tests)
├── .github/workflows/ci.yml   # CI workflow
└── icons/                     # Extension icons (16/32/48/128 PNG)
```

---

## Quality assurance

- **485 automated tests** covering `recorder-core.js`, `shared.js`, `settings-store.js`, `gif-encoder.js`, `exporter.js`, `cursor-marker.js`, `annotation-geom.js`, the real `content.js` (evaluated in jsdom), the full background ⇄ content message bus, and a static import/export cross-check of every module
- **Static analysis** — all JS files pass `node --check` syntax validation
- **CI workflow** — tests auto-run on every push and pull request via GitHub Actions

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes. Run `npm test` to verify tests pass
4. Commit with a clear message
5. Open a PR describing the change

---

## License

MIT — see [LICENSE](./LICENSE).
