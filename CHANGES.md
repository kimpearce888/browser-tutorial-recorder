# Changelog

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
