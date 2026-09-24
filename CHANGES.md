# Changelog

## v2.0.4 — 2026-09-24

### Fixed — tutorials recorded with no screenshots at all

Live-reported: the editor now loads (v2.0.3 routing fix confirmed working), but **every step was missing its screenshot**.

- **Root cause: `captureVisibleTab` permission regression from the v2.0.0 rewrite.** Chrome requires the **`<all_urls>`** permission (or `activeTab`) for `chrome.tabs.captureVisibleTab` — scheme-scoped match patterns like `http://*/*` + `https://*/*` do not satisfy it. v1.x shipped `<all_urls>`; the v2.0.0 manifest switched to scheme patterns, so **every single capture threw** and every step was silently saved with `status: "FAILED"` and an empty image. The failure was invisible until now because the editor could not load before v2.0.3.
- **`host_permissions` restored to `["<all_urls>"]`** — screenshots capture again on every http/https page, matching the v1.x behavior.
- **Blocked capture is now visible, not silent** — the background tracks a `captureBlocked` flag (set when a capture throws, cleared on the next successful capture and on new recordings), exposes it in the UI state, and the popup shows a red warning: "Screenshots are being blocked. Remove the extension in chrome://extensions and load it again…". A permission problem can no longer hide behind an empty tutorial.
- **Regression test added** — a fresh background instance with a permanently throwing `captureVisibleTab`: recording starts, the click still commits a step (no fake image data), and `captureBlocked: true` surfaces in the UI state. 5 new assertions.

**Tests: 162/162 pass.**

## v2.0.3 — 2026-09-24

### Fixed — editor/dashboard/settings pages could never load: "No response from the recorder service."

Live-reported again after v2.0.2: opening the editor (`editor.html?id=…`) still failed at boot with `Error: No response from the recorder service.` (editor.js boot guard).

- **Root cause: message misrouting by `sender.tab`.** The background routed messages with `!sender.tab && sender.id === chrome.runtime.id`, assuming a missing `sender.tab` means "sent from an extension page". In reality, extension pages opened **in a browser tab** (editor, dashboard, settings, preview, print view — everything opened via `chrome.tabs.create` or `location.href`) DO carry `sender.tab`; only the popup and the service worker lack it. Every message from those pages was therefore delivered to the content-script branch, which silently dropped `GET_SETTINGS` / `GET_TUTORIAL` / `GET_SUMMARIES` / etc. after 3 retries — a deterministic boot failure. This also explains the persistently empty tutorial list on the dashboard.
- **Routing now keys on the sender URL**, never on the absence of `sender.tab`: same-extension senders whose `sender.url` starts with the extension's own `chrome-extension://<id>/` base are treated as extension pages; content scripts always carry the host page's `http(s)` URL and keep going to the content branch. Popup (`chrome-extension://…/popup.html`) is covered by the same rule.
- **Regression proven both ways**: a live harness against the old code reproduces the exact bug (no response for a tab-hosted editor sender) while the fixed code responds `ok:true`; the message-bus suite gains a dedicated routing section — tab-hosted editor/dashboard senders now receive `GET_SETTINGS`, `GET_UI_STATE`, `GET_SUMMARIES`, and `PING` responses, and a content-script sender (same extension id + `https` URL) is proven to never reach page handlers.
- **`bgCall` backoff hardened** — 2 retries @ 350 ms became 3 retries with escalating backoff (250/500/1000 ms), so a cold-starting service worker under load still gets answered.

**Tests: 157/157 pass** (new: extension-page routing section — 5 assertions incl. content-script isolation; updated bgCall retry-count semantics).

## v2.0.2 — 2026-09-24

### Fixed — empty recordings + "No response from the recorder service."

Live-reported: the badge counted steps during recording, but the saved tutorial was empty and the editor showed nothing, with `Uncaught (in promise) Error: No response from the recorder service.` in the editor console.

- **Mid-recording service-worker death eliminated** — MV3 service workers are killed after ~30 s without extension activity. Recording a slow workflow (reading a page, no clicks) let the worker die; the draft then rehydrated as **paused**, silently swallowing every click afterwards while the badge froze at the old count. The background now runs a **20 s keep-alive ping** for the whole recording session, so the worker cannot idle out mid-recording.
- **Auto-resume after worker restart** — if the worker is ever hard-killed anyway, the recovered draft now resumes **recording** and re-attaches all session tabs, instead of staying paused and eating events. Stale drafts with no live session are cleaned up at boot.
- **Page-to-background calls retry** — `bgCall` (used by popup, dashboard, editor, settings, preview, print view) now retries twice with backoff on `undefined` responses and transient "message port closed" / "receiving end" errors, which covers the cold-start race when a page messages a waking service worker.
- **Editor boot hardened** — a failed load no longer leaves a dead empty shell with an uncaught rejection; the editor surfaces "Load failed — reopen this page".
- **Invalid start tab rejected cleanly** — starting a recording on `chrome://` or other non-web pages now returns "Open a regular website tab (http/https) to start recording." instead of creating a session that could never capture anything.

**Tests: 151/151 pass** (new: bgCall retry semantics — rescue on transient no-response, exhaustion error, port-closed propagation, background error forwarding).

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
