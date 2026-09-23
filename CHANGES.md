# Changelog

## v2.0.1 — 2026-09-24

### Fixed — Chrome hang + crash on Start Recording

Reported live: clicking Start Recording pegged the CPU, the whole browser hung, and Chrome then crashed. Root cause was a message ping-pong loop between the service worker and content scripts, compounded by double injection.

- **Infinite attach handshake eliminated** — content scripts answered every `ATTACH_RECORDER` with a new `CS_HELLO`, and the background answered every `CS_HELLO` by broadcasting `ATTACH_RECORDER` to all frames of the tab again. Thousands of messages per second (each also re-reading settings storage) starved the browser process. The background now replies with a frame-targeted attach (`sendMessage` with `frameId`) and content scripts say hello exactly once per document.
- **Double injection guarded** — `content.js` is both a static `content_scripts` entry (all frames, `document_start`) and programmatically re-injected on start/navigation. Chrome runs both copies, doubling every listener and heartbeat. An idempotency guard now makes re-injection a no-op, so a single click can no longer produce duplicate steps.
- **Mask loop defused** — the sensitive-field mask refresh ran a full-DOM scan on every mutation frame; it is now throttled (≥1.2 s gap), the interval relaxed to 1.5 s, and redundant style writes skipped via a geometry key.
- **Draft flush relaxed** — debounced 400 ms → 3 s to cut IndexedDB churn on long recordings.
- **Full-page capture capped** — the stitch canvas is now bounded (≤ 12000 px tall, ≤ 3840 px wide) so very long pages can no longer allocate a multi-gigabyte `OffscreenCanvas`.

**Regression proof:** a new message-bus integration test wires the real `background.js` and the real `content.js` together over a capped bus. Old code floods past 300 messages and overflows; fixed code exchanges 6 messages and goes quiescent. The same test asserts the double-injection guard and single-event capture.

**Tests: 145/145 pass.**

## v2.0.0 — 2026-09-24

### Complete rewrite — built fresh for reliability

Every line of the extension was rewritten from scratch. Previous versions were used only as a feature reference; no code was carried over. The rewrite is organized around four reliability principles that eliminate the failure modes of v1.x:

- **Fire-and-forget event pipeline** — content scripts never wait on screenshots; a serialized capture queue processes events in order. The entire class of `sendResponse` / message-channel bugs is gone.
- **Append-only IndexedDB drafts** — steps flush incrementally instead of rewriting the whole session (with every base64 screenshot) on each event, which stalled long recordings.
- **Always-on sensitive-field masks** — password fields are covered during the whole session, removing all capture-time mask choreography.
- **Crash-safe rehydration** — a service worker restart mid-recording recovers the draft and resumes paused instead of losing everything.

### Features (full set, all rebuilt)

- Recording: 15 event types, multi-tab, SPA navigation, iframe coordinate handshake, sensitive masking (shadow DOM + iframes), excluded domains, idle auto-pause, discard, live badge
- Editor: 9 annotation tools, crop with re-anchoring, merge/split/duplicate, pointer-based drag reorder (no HTML5 drag bugs), 60-step undo, presets, recapture (viewport + full page), shortcut rebinding with conflict detection, auto-save
- Export: 7 formats (HTML, PDF/Print, GIF, Markdown, PNG, JSON, text) with destructive blur/redaction, fresh GIF89a+LZW encoder, unicode-safe filenames
- Dashboard: search, sort, grid/list, bulk export/delete; Settings: appearance, themes, storage management; Preview: guide/watch modes

**Tests: 133/133 pass** (fresh suite covering the recording state machine, sanitization, settings logic, GIF structure, exporter, and the real content script in jsdom).

## v1.0.3 — 2026-09-24

### Fixed — recording & editor reliability

- Recording not starting: resolved `sendResponse` / `return true` conflict in the background message listener (async responses were cut off).
- Recording not starting: corrected window targeting (`lastFocusedWindow` vs `currentWindow`) when attaching the content script.
- SPA navigation capture (`history.pushState`) now records correctly.
- Editor drag & drop step reordering works reliably.
- Excluded-domain changes now apply mid-recording.
- Elapsed-time display in the recording badge no longer drifts.
- Fixed tutorial ID collisions on rapid re-recording.
- Exhaustive audit: 8 additional bugs and 12 code smells fixed.
- Codebase simplified: removed redundant logic left over from earlier audit rounds.

**Tests: 173/173 pass.**

## v1.0.2 — 2026-09-23

### Code hygiene

- Stripped all comments from every source file for a clean release build.
- Removed stale internal version labels from comments and test names.

**Tests: 91/91 pass.**

## v1.0.1 — 2026-09-23

### Fixes & cleanups

- Fixed 2 real bugs found in a fresh audit.
- Applied 4 minor cleanups.

**Tests: 91/91 pass.**

## v1.0.0 — 2026-09-23

### First public release

Browser Tutorial Recorder — a Chrome extension (Manifest V3) that records browser workflows into polished, shareable step-by-step tutorials.

**Features:**
- Recording: 15 event types, multi-tab, SPA navigation, full-page capture, iframe support, sensitive-field masking
- Editor: 9 annotation tools, crop/merge/split/reorder, 60-step undo history, presets, keyboard shortcuts
- Export: 7 formats (HTML, PDF, GIF, Markdown, PNG, JSON, text) with flattened privacy treatments
- Dashboard: search, filter, sort, bulk operations, grid/list views
- Settings: shortcuts, recording prefs, appearance, storage management, cross-tab sync
- Preview: guide mode and watch mode

**Tests: 91/91 pass.**
