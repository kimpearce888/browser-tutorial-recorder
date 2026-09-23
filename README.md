# Browser Tutorial Recorder

> Turn any browser workflow into a polished, shareable tutorial — in seconds.

**Browser Tutorial Recorder** is a Chrome extension (Manifest V3) that records your clicks, scrolls, navigations, and form interactions, then lets you edit, annotate, and export the workflow as a step-by-step guide in 7 formats.

Everything stays on your device. No accounts, no cloud uploads, no telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)](https://developer.chrome.com/docs/extensions/mv3/)
[![Tests: 173](https://img.shields.io/badge/Tests-173%20passing-success)](./test-suite.mjs)
[![CI](https://github.com/kimpearce888/browser-tutorial-recorder/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/browser-tutorial-recorder/actions/workflows/ci.yml)
[![Version: 1.0.3](https://img.shields.io/badge/Version-1.0.3-ff7352)](./manifest.json)

**Version: v1.0.3**

---

## Why you'll love it

**Record once, share forever.** Click Start, do your workflow, click Stop. The extension captures every interaction with smart, auto-generated step descriptions — "Click the Submit button" instead of "Click the selected element."

**Edit like a pro.** Nine annotation tools (highlight, arrow, blur, redaction, spotlight, numbered markers, and more), crop, merge, split, reorder, and a 60-step undo history. Everything is keyboard-accessible.

**Export anywhere.** Standalone HTML, PDF, animated GIF, Markdown, PNG, JSON, or plain text. Blur and redaction are baked in destructively — hidden content cannot be recovered.

**Privacy-first.** Password fields and sensitive inputs (configurable regex) are automatically masked in every screenshot. Sensitive data never leaves your browser.

---

## Features

### Recording

- **One-click recording** with a live status badge showing step count and elapsed time
- **15 event types captured**: CLICK, DOUBLE_CLICK, RIGHT_CLICK, MIDDLE_CLICK, TYPE, SELECT, CHECKBOX, RADIO, SUBMIT, SCROLL, KEYBOARD, DROP, NAVIGATION, NEW_TAB, NEW_WINDOW
- **Multi-tab support** — follows your workflow across tabs and new windows automatically
- **SPA navigation capture** — records URL changes from `history.pushState` (React, Vue, Angular)
- **Smart double-click detection** via `event.detail` (browser-authoritative, not timer-based)
- **Submit handling** — `preventDefault` → `await` screenshot capture → `form.requestSubmit(submitter)` guarantees the pre-submission screenshot without breaking native form semantics
- **Background-side click dedup** — double-click state machine lives in the background service worker, independent of any page's lifecycle
- **Click/submit retraction** — when a SUBMIT follows a CLICK on the same element, the background automatically retracts the preceding CLICK step
- **Auto-pause on idle** (configurable 0–600s timeout)
- **Sensitive field auto-detection** — password fields and inputs matching the configurable regex are automatically masked in screenshots
- **Excluded domains** — list domains where recording should auto-pause (changes apply mid-recording)
- **Full-page capture** — scroll-stitched screenshot of the entire page (up to ~100,000 CSS px / 200 captures)
- **Nested scroller capture** — independently scrolling containers are captured and stitched into the full-page result
- **Iframe support** — cross-origin and same-origin iframe clicks are recorded with correct viewport-coordinate translation via a cumulative transform handshake protocol
- **Service worker restore** — recording seamlessly continues after service worker termination
- **Discard option** — explicit "Cancel & discard this recording" button

### Editor

- **9 annotation tools**: highlight, rectangle, circle, arrow, text, blur, redaction, spotlight, numbered markers
- **Step management**: crop (with annotation re-positioning), merge with next step, split, duplicate, drag-to-reorder
- **Annotation presets** — save and reuse your favorite annotation styles
- **Undo / redo** with 60-step history
- **Responsive layout** — properties panel collapses into a slide-out drawer below 1100px
- **Fully customizable keyboard shortcuts** with conflict detection
- **Auto-save** with visible "✓ Saved" feedback

### Export

- **7 formats**: standalone HTML, PDF/Print, animated GIF, Markdown, plain text, PNG, JSON
- **Flattened privacy treatments** — blur and redaction are baked into exported images, cannot be reversed
- **GIF encoder** — Uint8Array-backed GIF89a + LZW encoder
- **Unicode-safe filenames** — non-Latin titles produce valid filenames

### Dashboard

- **Search, filter, sort** with debounced search
- **Bulk operations** — multi-select, bulk export, bulk delete
- **Grid and list views**
- **Lightweight summary loading** — dashboard loads metadata + thumbnails only

### Settings

- **Keyboard shortcut rebinding** with conflict detection
- **Recording preferences** — capture delay, screenshot format, JPEG quality, idle timeout, sensitive patterns
- **Appearance** — theme (light/dark/system), high contrast, GIF frame speed, preview autoplay speed
- **Storage management** — export all, import multiple, delete all, storage size indicator
- **Cross-tab sync** — settings changes propagate to every open tab instantly

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
3. **Stop recording** — click the extension icon, then **Stop recording**
4. **Edit & annotate** — click **Open editor** to crop, annotate, reorder, and refine
5. **Export** — click **Export** to download as HTML, PDF, GIF, Markdown, or other formats

---

## Keyboard shortcuts

### Global shortcuts (work anywhere in Chrome)

| Action | Shortcut |
|--------|----------|
| Start recording | `Alt+Shift+R` |
| Stop recording | `Alt+Shift+S` |
| Pause / resume | `Alt+Shift+P` |
| Open dashboard | `Ctrl+Shift+D` (Mac: `Cmd+Shift+D`) |

### Editor shortcuts (active only in the editor tab)

| Action | Shortcut |
|--------|----------|
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Save | `Ctrl+S` |
| Open preview | `Ctrl+Shift+P` |
| Open export menu | `Ctrl+E` |
| Add / duplicate / delete step | `Ctrl+N` / `Ctrl+D` / `Ctrl+Backspace` |
| Next / previous step | `Ctrl+J` / `Ctrl+K` |
| Merge / split step | `Ctrl+M` / `Ctrl+Shift+K` |
| Copy / paste annotation | `Ctrl+C` / `Ctrl+V` |
| Annotation tools 1–9 | `1` … `9` |
| Deselect annotation | `Escape` |
| Show shortcut cheat sheet | `?` |
| Back to dashboard | `Ctrl+Shift+H` |

> Reassign global shortcuts at `chrome://extensions/shortcuts`. Reassign editor shortcuts in **Settings → Keyboard shortcuts**.

---

## Privacy & security

- **No account, no cloud, no telemetry.** Every screenshot and tutorial is stored in IndexedDB on your device.
- **Sensitive field detection** — password fields and inputs matching the configurable regex are automatically masked.
- **Recursive masking** — sensitive fields inside shadow DOM and same-origin iframes are masked too.
- **Re-anchored masks** — masks are re-positioned right before each `captureVisibleTab` so layout shifts can't expose sensitive values.
- **Blur and redaction are destructive on export** — the flattened PNG/PDF/GIF cannot be reverse-engineered to reveal hidden content.
- **Excluded domains** — list domains where recording should auto-pause.
- **Internal pages blocked** — `file://`, `chrome:`, `chrome-extension://`, and other internal schemes are never recorded.
- **SVG attribute sanitization** — prevents markup injection via imported tutorial JSON.
- **Image URL sanitization** — all screenshot URLs pass through `sanitizeImageUrl()` before use, blocking `javascript:` schemes.

---

## Performance

- **Capture serialization queue** — respects Chrome's 2 captures/sec rate limit
- **Lightweight popup/dashboard loading** — uses summary endpoints that exclude per-step base64 screenshots
- **Single-record fetch** — opening a tutorial uses `dbGet(id)` instead of `dbGetAll()` + `.find()`
- **Memory-bounded event dedup** — pending events Map is capped with age + size pruning
- **Screenshot string-reference history** — undo/redo snapshots store image strings by reference (no memory duplication)
- **Session-locked operations** — all session mutations go through `withSessionLock()` to prevent concurrent read-modify-write races
- **Streaming full-page stitch** — images load one at a time (load → draw → drop reference) to cap peak memory
- **Cursor-based dashboard loading** — `dbGetAllSummaries()` uses an IndexedDB cursor to process one record at a time

---

## Project structure

```
.
├── manifest.json              # MV3 manifest
├── background.js              # Service worker — session, capture, message router
├── content.js                 # Content script — DOM event listener (all frames)
├── shared.js                  # IndexedDB wrapper + shared helpers + normalization
├── settings-store.js          # Settings + theme + shortcut definitions
├── popup.{html,js,css}       # Toolbar popup UI
├── dashboard.{html,js,css}   # Tutorial library — search, filter, sort, bulk ops
├── editor.{html,js,css}      # Step editor — annotation canvas, properties, presets
├── preview.{html,js,css}     # Step-by-step preview (guide / watch modes)
├── settings.{html,js,css}    # Settings tabs
├── print-export.{html,js,css}# Print / PDF export layout
├── exporter.js               # Renders annotated canvas + exports to 7 formats
├── gif-encoder.js            # GIF89a + LZW encoder
├── theme-boot.js             # Anti-flash theme bootstrap
├── theme.css                 # CSS variables for light/dark/high-contrast themes
├── test-suite.mjs            # Automated test suite (173 tests)
├── package.json              # Node dev dependencies (jsdom for tests)
├── .github/workflows/ci.yml  # CI workflow
└── icons/                    # Extension icons (16/32/48/128 PNG)
```

---

## Architecture highlights

### Session lifecycle
- Sessions stored in `chrome.storage.local` under `activeSession`
- All mutations through `withSessionLock()` — a serial async queue
- Session ID captured at enqueue time and verified before committing (prevents cross-session contamination)
- `pendingNewTabs` and `lastNavUrlByTab` persisted to `chrome.storage.session` for SW termination survival
- Finalized-session recovery: if `dbPut` fails, the tutorial is reconstructed from `session.steps` on retry

### Click dedup state machine
- Lives entirely in the background service worker (independent of page lifecycle)
- Content sends CLICK immediately — no holding in the content script
- Background holds each CLICK for 150ms; second CLICK on same element converts to DOUBLE_CLICK

### Iframe coordinate translation
- Cumulative transform handshake via `postMessage` (cross-origin safe)
- Handles arbitrary nesting depth and CSS scaling
- Parent re-broadcasts transforms on scroll, resize, MutationObserver, and ResizeObserver
- Recursive shadow DOM + iframe traversal for handshake matching

### Full-page capture pipeline
- 200-capture limit with `scrollHeight` re-check after each scroll
- Instant scroll (temporarily disables `scroll-behavior:smooth`)
- Sensitive-field masks refreshed after every scroll
- Fixed/sticky element hiding (recursive: shadow DOM + same-origin + cross-origin iframes via broadcast)
- Nested scroller capture with recursive discovery (shadow DOM + iframe)
- Streaming image loading (one at a time, not Promise.all)
- Truncation detection on ALL loop exit paths (not just MAX_CAPTURES)
- Capture failure aborts the operation (no misleading partial result)

### Privacy protection
- Masks re-discovered on every `REFRESH_MASKS` (handles lazy-loaded sensitive fields)
- `prepareCapture` throws if masking fails — capture is aborted, not continued with exposed content
- Full-page capture re-applies masks + fixed-element hiding before nested capture

---

## Quality assurance

- **173 automated tests** covering `shared.js`, `gif-encoder.js`, `settings-store.js`, `exporter.js`, `background.js`, and integration paths
- **Static analysis** — all 14 JS/mjs files pass syntax validation
- **CI workflow** — tests auto-run on every push and pull request via GitHub Actions
- **Deep code review** — every file has been read line-by-line across multiple audit rounds

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
