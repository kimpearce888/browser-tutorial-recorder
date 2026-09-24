# Changelog

## v2.2.0 — 2026-09-24

### New — cursor highlight options; readable full-page captures; a manageable crop; marker numbering control

Live-requested on v2.1.2: *"cursor background should have some option not only what is prefixed, it is hard to read the same thing on all pages, sometimes we need a small yellow filled circle with blur sometime else"*, *"full page capture should have fit width, zoom in/out to make a long page to view at this moment it loads the full page and nothing is recognizable"*, *"crop still hard to manage"*, *"mark has no option so it starts numbering with no control"*.

- **The cursor highlight is now fully configurable.** One fixed orange ring for every page was hard to read. Settings → Cursor highlight offers **7 presets** — including the exact ask, a **small yellow filled circle with blur** — plus fine-tuning: color (8 swatches + custom picker), size (50–200%), fill opacity (0–85%) and glow/blur (0–24 px), with a **live preview** that draws the marker over a mock page snippet exactly as the service worker stamps it. One shared module (`cursor-marker.js`) drives the settings preview, the screenshot stamp, and (as a mirrored spec) the live in-page ring, so all three always match; the config travels with every ATTACH message, and changing it in Settings updates running recordings on the next attach.
- **Full-page captures are readable.** The editor viewer used to shrink a 12,000 px tall page into the pane (`max-width/max-height: 100%` squashed the canvas) — "loads the full page and nothing is recognizable". The viewer now opens screenshots **fit-width by default**: the page fills the pane's width and scrolls vertically. A floating zoom bar adds **zoom in/out (×1.25 steps), a click-to-reset percentage, Fit width and Fit page modes**; Ctrl+wheel zooms around the cursor, Ctrl+= / Ctrl+- / Ctrl+0 mirror it. Annotation drawing, hit-testing, handles, crop and text placement all keep working at any zoom (they share the image-pixel coordinate space).
- **Crop is a standard crop tool.** The old marquee could only be redrawn from scratch. Now: **8 resize handles** (corners + edges, nearest-handle priority, screen-constant grab size at any zoom), **drag inside to move** the box (clamped to the image), **drag outside to redraw**, **live W × H readout** both on the marquee and in the crop bar, hover cursors that announce the next action, and Enter/Esc to apply/cancel as before.
- **Numbered markers count across the whole tutorial.** Markers restarted at 1 on every step with no control — step 5 got another "1". The sequence now continues tutorial-wide (like Scribe), and a **"Next #" field** in the style bar gives explicit control: type a number to restart the series from there, clear it to return to auto (highest existing + 1); pasting a marker adopts the sequence too.
- **Tests: 442/442 pass** (new: cursor-marker normalization + presets + canvas-spy stamp drawing; jsdom proof that the live ring mirrors the configured marker; end-to-end proof that the service worker stamps the CONFIGURED marker onto screenshots; viewer-scale units incl. fit-width default and clamps; crop hit-test/move/resize/bounds units; tutorial-wide marker sequencing).

## v2.1.2 — 2026-09-24

### Fixed — settings page revived; cursor ring lands at the right time

Live-reported on v2.1.1: "Uncaught SyntaxError: The requested module './shared.js' does not provide an export named 'downloadBlob'" (settings.html), "it is not taking cursor image with ring right time".

- **The settings page loads again.** `settings.js` imported `downloadBlob` from `./shared.js`, but that export lives in `./exporter.js` — a module-resolution SyntaxError thrown at load that killed the entire Settings page since the v2.0.0 rewrite (no UI, no storage tools, nothing). The import now points at the right module. This whole bug class is now dead: a new static analysis test cross-checks **every named import in every runtime module against the target's real exports** (37 import statements across all 20 modules), so a missing export anywhere fails the suite instead of blanking a page in Chrome.
- **Click steps now show the page exactly as the user saw it when the mouse went down.** The screenshot used to be taken after the click's consequences had already rendered — navigation, SPA route changes and closing menus all outran the capture queue — so the cursor ring frequently sat on the wrong page, the wrong state, or no image at all. The content script now requests a **pre-capture at mousedown**, before the click can change anything; the service worker grabs that frame through the usual quota gate, holds it per tab (2.5 s TTL), and the click-family step (CLICK / DOUBLE_CLICK / RIGHT_CLICK / MIDDLE_CLICK / SUBMIT) consumes it **instead of capturing again** — no extra quota spend, no race. Non-click mousedowns (text selections, drags) just let the held frame expire; TYPE/SELECT/CHECKBOX steps still capture live because they want the post-action state (typed text, checked box). A click with no pre-shot (capture failed at mousedown) falls back to the previous live capture.
- **Submit buttons finally carry the marker.** A form-submit click used to swap in a SUBMIT step re-captured *after* the form started navigating — racy screenshot, no ring. SUBMIT now replaces the recent same-target CLICK step and **adopts its pre-click screenshot** (marker on the button, zero extra capture, no navigation race), and SUBMIT steps are marked like the button clicks they are.
- Keep-alive ping hardened against missing `chrome.runtime.getPlatformInfo`.

**Tests: 367/367 pass** (new: full import/export cross-check + the exact settings.js regression; end-to-end pre-capture pipeline — pre-shot consumed with no second grab, live fallback, TYPE does not consume the held shot, TTL reuse, SUBMIT adopt; recorder-core SUBMIT-adopt units).

## v2.1.1 — 2026-09-24

### Fixed — steps show the full current view again; every editor tool now behaves

Live-reported on v2.1.0: "why it is taking a portion of the page instead of the current view? fix that", "text tool never worked", "every tool has its own issues nothing works".

- **Steps keep the full current view by default.** v2.1.0 shipped with the Scribe-style element auto-crop **on by default**, so every step screenshot arrived as a ~360×280 portion of the page — read, correctly, as "it is taking a portion of the page instead of the current view". Element cropping is now an explicit opt-in (Settings → Recording → "Crop each step to the clicked element", off by default); the marker is still stamped onto the full view, and Recapture stays full-view / full-page.
- **One coordinate bug was breaking every editor tool at once.** `canvasPoint()` stored pointer positions in *displayed-canvas* pixels, but rendering multiplied stored coordinates by the display scale (`fit`) again — on any screenshot larger than the editing pane (fit < 1, i.e. nearly always with full-view screenshots) **every shape drew offset and shrunken from where it was created while hit-testing looked at the raw click position**. That single mismatch is what made select/move "not working", the arrow rotate handle practically ungrabbable, the crop marquee drift away from the cursor and crop the wrong region, and committed text render away from its input box. Annotations now live in one coordinate space — natural screenshot pixels — shared by drawing, hit-testing, handles, crop, nudging and exports; hit/handle tolerances scale with the zoom so grab areas stay the same size on screen at any scale.
- **The text tool finally works.** Clicking the canvas focused the text input, then the browser's default mousedown handling **stole the focus straight back**, and the resulting blur → empty-text commit closed the box before a single character could be typed — the input flashed and vanished, forever. The opening gesture now calls `preventDefault()` (plus a focus-refit belt), so the box stays open and takes input. Also fixed while in there: clicking the canvas a second time stacked duplicate keydown/blur listeners that committed duplicate annotations; a text commit is now serialized, multi-line text sizes its box correctly, undo restores the pre-text state, and committing drops the tool back to Select like professional editors.
- **Blur sampled the wrong region.** The blur tool fed display-scaled coordinates into the full-resolution screenshot as a source rect, so the pixelated patch showed the wrong part of the image at any zoom ≠ 1 (in the editor and in every export). Source rects are now read in image pixels; the patch lands exactly where drawn.
- **Arrow edge case + spotlight look.** Arrows whose head sits exactly on x=0/y=0 no longer fall back to the wrong bbox corner, and the spotlight now dims with a neutral dark veil instead of tinting the whole page with the active swatch color at 90 % opacity (which read as a broken red overlay).

**Tests: 271/271 pass** (new: default-settings click keeps the full 1280×720 view with no crop offset; zoom-aware hit/handle tolerance units; auto-crop normalize defaults; the crop-on path is still covered end-to-end as an explicit opt-in).

## v2.1.0 — 2026-09-24

### Changed — professional behavior rework: "check how these apps actually work"

After five hotfix rounds the tools worked, but the overall product still did not behave like the recorders people know (Scribe, Tango, iorad, GoFullPage). This release rebuilds the interaction model to match how professional tutorial recorders actually behave, benchmarked feature by feature.

- **Screenshots are finally clean — the recorder's own UI is never in the shot.** The floating toolbar pill and the orange DOM click rings were ordinary page elements, so `captureVisibleTab` baked them into every single screenshot. There is now a `BTR_CAPTURE_UI` handshake: for the instant the frame is grabbed, the service worker hides **all** recorder UI in the page (rings state-preserved, toolbar), waits a compositor beat, captures, and restores. What the reader sees in a step is then drawn by us, not whatever the page happened to render.
- **Steps are cropped to the clicked element — the Scribe/Tango signature.** Every action step is auto-cropped to the region the user actually interacted with (element bounds + 56 px padding, minimum 360×280, clamped to the viewport; near-full-viewport elements skip the crop). The typed/selected element sits front and center instead of a full viewport nobody asked for. The click marker is stamped onto the cropped image at the exact click point, shifted into crop coordinates — one decode, one encode. `Recapture view` / `Recapture full page` still produce full-viewport / full-page images (and clear the stale crop), and Settings → Recording has an "Crop each step to the clicked element" toggle (on by default) for full-frame purists.
- **The click marker is always consistent.** The old logic skipped the marker whenever the live ring was on screen (i.e. almost always) and stamped only when a capture was delayed past the ring's hold — so marker style depended on timing. Now the DOM ring is purely live feedback during recording; the marker in every step is the same SW-drawn ring + cursor, same size, same style, exactly on the recorded point.
- **Scrolling is no longer a step.** Every 700 ms scroll pause used to commit a "Scroll the page" step with a redundant screenshot — pure noise in the exported guide. Scrolling is positioning: the next click's screenshot naturally shows the scrolled state, exactly like Scribe/Tango.
- **Typed text becomes part of the instruction.** Steps now read `Type "ada@example.com" into "Email"` (value captured after the 900 ms typing idle, sensitive fields masked to "••••••" per the sensitive-keywords settings) instead of the content-free "Type into the Email".
- **Every meaningful click records — SPA apps included.** Modern apps delegate click handlers from plain `<div>`/`<span>` nodes that the old actionable-selector silently dropped ("the recorder missed my clicks"). Clicks on real content (headings, paragraphs, list items, images, table cells, inline text) now record; clicks on bare container whitespace (body/html/empty wrappers) are still ignored.
- **The tutorial opens with the starting page.** Starting a recording immediately commits a "Navigate to example.com/page" step 1 with a fresh screenshot, like every professional guide — the tutorial no longer begins with the user's first click. (Fixing this also exposed a latent bug: system navigation events were re-deduplicated in `handleEvent` after `addSystemStep` had already deduplicated them, so page-load navigation steps could never commit at all.)
- **Professional phrasing everywhere.** Instructions now quote the element: `Click "Sign in"`, `Select "Option 1" in "Country"`, `Check "Newsletter"`, `Submit "Create account"` — no more grammatically awkward "Click the Sign in".
- **Steps commit faster.** The capture queue added a redundant 560 ms sleep *after* every event on top of the capture gate's own pacing — up to ~1.2 s of dead time per step. The gate alone paces all captures; steps now commit as fast as Chrome's 2-captures/second quota allows.
- **Editor interactions tightened to professional conventions.** Drawing a shape snaps the tool back to Select (no accidental twin shapes); undo snapshots are taken on the first real movement, so clicking an annotation without dragging no longer pollutes the undo stack; arrow keys nudge the selected annotation (1 px, Shift = 10 px, one undo entry per burst); Escape returns to the Select tool; the crop marquee shows rule-of-thirds guides; crop-mode Enter/Escape now win over the shortcut system (Escape actually cancels a crop); the screenshot info line marks "cropped to action" steps.
- **Full-page capture shows live progress.** The stitcher broadcasts `BTR_CAPTURE_PROGRESS` per shot and the editor shows "Capturing 3/8…" instead of a silent "Recapturing…" that could sit there for half a minute on long pages. The full-page stitcher also hides the recorder UI in every strip it captures.

**Tests: 260/260 pass** (new: `planCrop` unit section — padding, minimum-size expansion, viewport clamping, near-full-viewport skip, corner clamping; end-to-end clean-screenshot section proving the 360×280 crop canvas, the crop-origin draw offset, the stamped marker, and the hide→show UI handshake around the grab; crop-metadata round-trip through `normalizeTutorial`; system-navigation dedupe fix; per-section updates for the opener step, capture counts, quoted phrasing, and the capture-UI handshake in the jsdom overlay suite).

## v2.0.7 — 2026-09-24

### Fixed — cursor visible while not clicking, arrow rotation, broken select/move, non-standard full page, half-working crop

Live-reported after v2.0.6 (with screenshot): "the cursor is always visible like this even though i am not clicking there. it is not how tutorial steps recorder works", "arrow does not have any rotate option", "select or move is not working", "full page option is not something standard and not taking full page shot", "crop tool is not working as a perfect crop tool."

- **Nothing is drawn on the page unless you click.** The v2.0.6 live overlay included a follower ring + dot that tracked every `mousemove` and stayed visible wherever the pointer last was — the reported "cursor is always visible even though i am not clicking there" (it also froze in place whenever the pointer left the page or entered an iframe). The follower is removed entirely: between clicks the page is untouched, exactly like standard tutorial recorders. What remains is a click ring that appears **only** at `mousedown`, is anchored to page coordinates (stays glued to the content if the page scrolls before the rate-limited capture), and fades the moment its step's screenshot is committed — the service worker's `BTR_STEP_COUNT` echo retires the oldest ring 1:1 (captures are serialized in click order, so the ring is always in its own screenshot), with a 2.6 s fallback hold. `overlayActive` now reports whether a ring is actually on screen, and the SW stamp kicks in automatically for captures delayed past the ring's hold — a click step can no longer end up with no marker at all, and never gets a double-drawn one.
- **Arrows can rotate.** A selected arrow now exposes three handles: **head** and **tail** dots (drag either endpoint to stretch/re-aim) and a blue **rotate knob** on a stem above the midpoint — dragging it spins the arrow around its center while preserving its length, like presentation software. Geometry math lives in a new pure module (`annotation-geom.js`, unit-tested): `rotateAround`, `handlesAt`, `distToSegment`, `syncGeom`, `cropRemap`.
- **Select and move work for every annotation type.** Three compounding bugs made tools feel dead: (1) hit-testing used a loose `x..x2` bounding box — **text** annotations (no meaningful `x2`) were only selectable within 8 px of their anchor point and **markers** only within an 8 px core of a 26 px disc; hits now test what the user actually sees (segment distance for arrows, disc for markers, measured box for text). (2) Rect shapes kept `w/h` and `x2/y2` out of sync — after a resize or move the stale `x2` silently mis-mapped later hit tests; a `syncGeom` normalizer runs after every mutation and repairs legacy tutorials at load. (3) The draw drag **never stored `startX/startY` at pointerdown** — the first `pointermove` zeroed the shape and re-anchored its origin mid-drag, and arrows had their tail forced to the bounding-box corner, so arrows drawn upward pointed the wrong way. Drawing now anchors at the pointerdown point (arrow tail stays under the press, head follows the pointer), and accidental zero-length shapes (including arrows) are discarded.
- **Full-page capture looks standard and actually captures the full page.** Fixed/sticky elements (headers, nav bars, cookie banners) repeated in every stitched strip — from the second shot on they are hidden in-page (and restored with the scroll position in the same `finally`), so the header appears exactly once at the top like a native full-page screenshot. The canvas height cap doubled to 24,000 CSS px (72 viewport shots max) so long pages are no longer truncated, lazy content gets a longer paint settle (280 ms), captures explicitly target the tab's own window, and in editor recapture the browser switches back to the editor before the stitching pass, so the flash of the temporary tab is as short as possible.
- **Crop is a real crop tool.** Toggle Crop, drag a marquee with a live preview (outside dimmed, dashed border), then **Apply crop** (button or Enter) or **Cancel** (button or Esc) via a floating bar over the canvas — the old flow applied instantly on mouse release with no preview and no way to adjust, announced itself with a jarring `alert()`, and left annotations outside the crop floating at negative coordinates. Annotations now remap with the image and ones left fully outside are dropped. The text tool's input position also maps through the live displayed-canvas ratio now instead of the nominal fit.
- **Bonus: a double-click no longer commits two steps.** The content script reports a double-click twice (second `click` with `detail>=2`, then the `dblclick` event); `recorder-core` now suppresses the duplicate within 1.5 s of the same target.

**Tests: 233/233 pass** (new: jsdom proof that `mousemove` creates no overlay while a click ring still spawns and retires on step commit; annotation-geometry section — per-type hit-testing, stale-`x2` repair, head/tail/rotate handle detection, length-preserving rotation, crop remap/drop; double-click dedupe).

## v2.0.6 — 2026-09-24

### Fixed — cursor lag/misplacement, capture quota crashes, full-page failures, missing editor features

Live-reported after v2.0.5: "cursor is showing with delay and in wrong places", "Recapture failed: This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.", "it is not taking full page", "tools are not working and with limited features." Four defect clusters, all fixed.

- **Live cursor overlay — the cursor is now drawn INTO the page while recording.** v2.0.5 stamped the arrow + ring into screenshots *after* capture using click-time coordinates, but the screenshot happens 250 ms–1.5 s later (capture delay + serialized queue), so any scroll, animation or navigation in between left the ring hovering over stale content — the reported "delay" and "wrong places". Content scripts now render a real-time overlay (orange-red follower ring + dot that tracks `mousemove` instantly, plus a click ring spawned at `mousedown`) into a fixed, `pointer-events:none` layer. Because the overlay is part of the page, `captureVisibleTab` captures it at the exact live position with zero lag, and iframes are correct automatically (each frame composites its own overlay). Click rings are anchored to **page** coordinates and follow scroll, so they stay glued to the content they mark even when the page scrolls before the (rate-limited) screenshot. The service-worker stamp still exists as a fallback for events reported without an active overlay; a new `overlayActive` flag on every `REC_EVENT` prevents double-drawing. The Settings → "Show a cursor…" toggle now controls the overlay too.
- **Every `captureVisibleTab` call now goes through a global rate gate.** Chrome hard-limits `captureVisibleTab` to ~2 calls/second (`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND`); the full-page stitcher captured every ~310 ms, so the **third shot threw a quota error and the whole recapture / full-page capture failed** — the exact error reported. A single `captureVisible()` wrapper now enforces a global 560 ms minimum gap between captures and retries up to 4 times (700–2050 ms backoff) if a genuine quota error slips through. All three call sites (per-step capture, full-page stitching, editor recapture) share the gate, so rapid editor recaptures and recordings can no longer crash each other.
- **Full-page capture is finally reliable and always cleans up.** The scroll loop now waits (up to 900 ms) for the viewport to *actually land* on the requested offset before capturing — smooth-scroll pages and lazy layout shifts no longer produce misaligned or duplicate stitches — and the scroll position + hidden-scrollbar style are restored in a `finally` block: previously an error mid-loop left the page scrolled to the bottom with its scrollbars hidden. Verified: a 2400 px page stitches exactly 3 viewport shots under quota enforcement and restores the page exactly once.
- **In-page recording toolbar is back.** v1.x had visible in-page recording controls; the rewrite dropped them. A floating toolbar (top frames only) now shows the live step counter with **Pause/Resume** and **Stop** buttons; Stop saves the tutorial and opens the editor just like the popup does. Every toolbar interaction is explicitly excluded from recording (`closest("#__btr-toolbar")` guards in every recorder listener), and the counter updates live via a lightweight `BTR_STEP_COUNT` message after each committed step. The toolbar respects pause state, and everything is removed on stop/detach.
- **Editor: the promised-but-missing tools now exist.** `copyAnnotation` (Ctrl+C) and `pasteAnnotation` (Ctrl+V) were listed in the shortcuts settings since v2.0.0 but never implemented — pressing them did nothing. Both are implemented now (plus toolbar buttons), with smart paste offsetting, renumbered markers, and re-selection. Also wired up: `preview`, `shortcuts` (help overlay listing the active bindings), and the **V** key for the Select tool that its button tooltip always promised. Selected box/arrow annotations can now be **resized** by dragging their bottom-right corner (arrow endpoint).
- **Editor: coordinates and drag performance fixed.** `canvasPoint` mapped pointers through the nominal fit scale only — if CSS shrinks the displayed canvas below its bitmap size (`max-width/max-height`), every tool drew offset from the cursor; the mapping now uses the live rect ratio. Dragging no longer re-decodes the full multi-MB screenshot data URL on every `pointermove` (decoded bitmaps are cached per step), which made drawing feel broken/laggy. Imageless steps now show an explanatory empty state instead of silently ignoring every tool click.

**Tests: 204/204 pass** (new: quota-gate burst test — 3 rapid clicks commit 3 steps with rate-limited captures and no quota throw; quota-error retry test; end-to-end full-page stitch under Node canvas polyfills — 3 shots, correct 2400 px height, page restored; jsdom overlay/toolbar tests — follower + click ring rendering, `overlayActive` propagation, toolbar messaging, toolbar clicks never recorded, detach cleanup).

## v2.0.5 — 2026-09-24

### Fixed — no cursor in screenshots, broken editor tools, full-page capture cut short

Live-reported after v2.0.4: "no cursor, no cursor background or circle behind the cursors while taking records, tools are not working, full page is not taking full page." Three independent defects, all fixed.

- **Cursor + click-highlight ring are back in screenshots.** v1.x drew a pointer arrow and an orange-red highlight ring into the page for a split second at capture time; the v2.0.0 rewrite deleted that choreography entirely (it was part of v1.x's fragile per-capture message round-trips) and never replaced it, so every screenshot since has been cursor-less. The stamp is now composited **inside the service worker** with `OffscreenCanvas` right after `captureVisibleTab` — zero extra page round-trips, so none of v1.x's capture choreography instability returns. Clicks, double-clicks, right/middle-clicks and drops get the arrow + ring (scaled by the display's device pixel ratio); scrolls and navigations stay clean. A new **Settings → Recording → "Show a cursor and click highlight ring"** toggle (default on) controls it, and a failed stamp never blocks the step — the plain screenshot is kept.
- **Editor: the Text tool silently threw.** `commit()` called `snapshot.pop()` — `snapshot` is a function, so every commit crashed with `TypeError: snapshot.pop is not a function` right after the annotation was pushed: typed text never appeared and the step was never marked dirty. The bogus call is removed.
- **Editor: the Blur and Spotlight tools drew nothing.** The editor had its own private annotation renderer that predated those two tools — annotations of type `blur`/`spotlight` were created, saved and even exported correctly, but the editor canvas rendered nothing, so the tools looked dead. The editor now renders through the **same `drawAnnotations` pipeline as every export format**, so what you see while editing is exactly what exports (blur samples the screenshot itself; spotlight dims everything outside the ellipse).
- **Full-page capture always stopped after 2 shots.** The stitcher's scroll loop ended on `pos.y === requested && shot > 0` — but matching the requested scroll position is the *normal* case, so on every page the loop terminated on the second viewport: a 5,000 px page produced a ~1,600 px image. The loop now plans with a pure `nextScrollY(pos, requested)` helper (bottom detection, clamp handling, no-progress stop), starts from the top of the page, stitches from the **actual** scroll positions (immune to scroll clamping), and caps at the same 12,000 px canvas limit. A 5,000 px page now stitches 7 shots, not 2.

**Tests: 175/175 pass** (new: full-page scroll-planning section — scroll advance past the old 2-shot break, bottom/short-page/no-progress stops, a 5,000 px page stitching 7 shots, cursor-request semantics for click/scroll/navigation events, and `showCursor` settings normalization).

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
