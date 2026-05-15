# Changelog

All notable changes to TranscriptDB. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [2.3.0] — 2026-05-14 (later)

### Added

- **Auto-sequence checkbox on the video player** — when a multi-video lecture's current video ends, the next tab is selected automatically and playback continues. Toggle visible only on lectures with 2+ videos; setting persists in localStorage (`tdb-player-auto-sequence`).
- **Archive Videos respects the sidebar scope.** Clicking the button on a class group archives only that class's lectures; on a section, just the section. A confirm dialog names the count: *"Archive 3 lectures from class 231?"*. Bare-course-node still archives the whole course.
- **Shift-click Archive Videos = force re-download.** Bypasses both the "already archived" outer shortcut and the per-file `fs.existsSync` skip. Useful for replacing a known-bad file without manually deleting it on disk.
- **Re-scrape transcript button** on the lecture detail header — re-runs the per-video chunk extraction on a single lecture. Replaces the lecture's `course_chunks` rows in a transaction.
- **Re-order Videos button** on multi-video lecture details — repairs file-to-DOM-position alignment on lectures archived before deterministic capture. Two-step UX: first click does a dry-run and shows the rename plan in a confirm dialog; nothing is renamed until you approve. Idempotency guard early-exits when files are already in DOM order. Atomic rename via temp slots, plus a restore-or-orphan-warning step so no file can be clobbered.
- **archive_failures table** — one row per unresolved (lecture_id, video_index) failure with the ffmpeg stderr tail. Rows auto-clear on the next successful download for the same slot. `GET /api/archive-failures` (optionally `?course_id=X`) returns the joined rows for any future UI surfacing.
- **Truncation detection** — every archive run probes the m3u8 manifest upfront to learn the expected duration, then compares it against the actual downloaded duration. Mismatches > 5% are persisted to `archive_failures` so a partial download doesn't silently look complete. New column `course_lectures.video_expected_duration_sec`.
- **Archive Videos panel is non-modal.** Floats in the bottom-right corner without a backdrop, so you can keep browsing other lectures while a long multi-video archive runs in the background. Cancel still aborts; closing the panel (✕) only hides it.
- **Failure list in the Done summary.** Each per-video failure during a run is rendered with the lecture title, video index, filename, and a 240-char tail of the ffmpeg stderr — plus a hint that re-running Archive Videos retries just the missing slots.
- **Type filter wired up for course lectures.** Lessons / Pre Q&A / Post Q&A / Work Sessions chips now filter the course-detail grid via the FK-linked transcripts' `transcript_type`. (Empty results on courses with no linked transcripts is semantically correct.)
- **New endpoints:**
  - `POST /api/courses/lectures/:id/rescrape-transcripts`
  - `POST /api/courses/lectures/:id/reorder-videos` (supports `{ dryRun: true }`)
  - `GET /api/archive-failures` (optionally `?course_id=X`)

### Changed

- **Multi-video archive is now deterministic.** Each captured `.m3u8` is attributed to the iframe that fired it via Puppeteer's `request.frame()` API (walks the parent-frame chain until it finds the `/embed/<id>` iframe page). Files are written in true DOM order on the first run regardless of which iframe's player finishes loading first; the previous "capture order = DOM order" assumption that misnamed files on some lectures is gone.
- **Filenames use DOM index, not loop position.** A 3-of-5 archive writes `video.mp4 / video_3.mp4 / video_5.mp4` with gaps, not three sequential names — keeps tab labels honest about which DOM slot each file is.
- **Outer "already archived" skip** now compares `video_local_paths.length` to `video_embed_ids.length` (set by the scraper to the iframe count). A partial archive no longer wrongly short-circuits as complete; the next click on Archive Videos retries the missing slots.
- **Archive progress UI** surfaces a `Video N/M` counter alongside ffmpeg's `time=` updates and a partial-success state ("downloaded (3 of 4 videos · 1 failed)") with an amber row colour. Counts are threaded through the SSE event stream so the modal's headline stays honest about which video is being processed.
- **Course title display** strips a leading "<Month> <YYYY> " prefix from sidebar labels (e.g. "August 2025 FFA Publishing Summit" → "FFA Publishing Summit"). DB row keeps the full title so scraper and search are unaffected.
- **Wiki source links** now route through the course-lecture endpoint (`clec-<id>`) instead of mis-routing to the legacy `/api/transcripts/<id>` table — the click-through actually works now.

### Fixed

- **Scraper preserves per-video transcripts.** When a lecture page has multiple `.txt` download attachments after a video (a per-Part transcript plus a combined-all-Parts transcript at the bottom), the *first* one wins. Previously the last one overwrote the first, so Video N's chunks always ended up holding the combined block. Applies to both `scrapeCourse` and the new `rescrapeLectureTranscripts`.
- **Truncated downloads no longer look successful.** ffmpeg exiting code 0 doesn't mean the file matches the manifest — short downloads are now caught by the duration probe and recorded as failures.
- **Reorder won't ship a partial-fail state.** If any manifest probe fails (Hotmart auth tokens occasionally expire between master and variant fetches), the operation refuses entirely with a "try again" message instead of renaming some files and leaving orphan `.reorder-tmp-N` files.

### Removed

- `/tmp/`-pathed log redirects for the dev server. `dev:electron` background output now lands in `./logs/electron.log` (gitignored).

## [2.2.0] — 2026-05-14

### Added

- **LLM Wiki layer** — a Karpathy-style three-layer wiki sits on top of the transcript DB, extracting Authors, Techniques, Tools, and Debates from each scraped lecture via OpenRouter. New sidebar tab with entity grids, claim ledger, and a rebuild flow with cancellable SSE progress. Auto-ingest runs after every course scrape.
- **Multi-video transcripts** — Teachable lectures with more than one Hotmart embed now produce one transcript per video, tagged with `video_index` on `course_chunks`. The detail view filters the transcript pane to the active video tab. Archive downloads now happen in DOM order, and `video_embed_ids` is persisted alongside `video_local_paths` so file order matches what the user sees on the page.
- **Transcripts under their lectures** — legacy imported transcripts (`sources` + `transcripts` tables) can now be FK-linked to scraped course content. New nullable columns `sources.course_id` and `transcripts.lecture_id` with a one-time conservative auto-match migration (exact normalized-name equality only — never fuzzy, never overwrites manual assignments). The wiki ingest pulls FK-linked transcript text alongside scraped chunks.
- **Build version badge** in the header (`v2.2.0 · <sha>`) — auto-stamped on every build by `scripts/stamp-version.mjs`.
- **New API endpoints:**
  - `GET /api/courses/lectures/:id/transcripts` — per-lecture FK-linked transcripts
  - `GET /api/courses/:courseId/orphan-transcripts` — source-matched but lecture-unmatched
  - `GET /api/wiki/entities` / `entity/:id` / `log`
  - `POST /api/wiki/ingest/:lectureId` / `rebuild` / `lint`
- **Archive cancel** now actually cancels — the abort signal is plumbed through to ffmpeg (SIGKILL) and Puppeteer dwell (abortable sleep). Cancel responds within a second instead of waiting out the ~20s dwell.

### Changed

- **Sidebar restructure** — the standalone "Show transcripts ▾" toggle introduced in 2.1.0 is gone. Lectures with linked transcripts now expand to reveal Transcript child nodes; each course shows an "Other Transcripts" child group for source-matched-but-lecture-unmatched content; truly standalone imports (podcasts, YouTube, etc.) live in a new collapsible "Unassigned Transcripts" section at the bottom of the sidebar (auto-hidden when empty).
- **Player chrome** — hides irrelevant native menu items and centers the video container.
- **Independent pane scroll** in the detail view; the player resize handle now works on both axes.
- **Idempotency** — a complete N≥1 archive (any recorded video paths all present on disk) short-circuits without re-dwelling. Force-refresh and re-scrape still bust the cache.

### Removed

- `state.showTranscripts`, `tdb-tree-show-transcripts` localStorage flag, the `transcripts-toggle` button and its CSS. Transcripts are now first-class children inside the course tree.

## [2.1.0] — 2026-05-12

### Added

- **Desktop app** — ships as a signed `.dmg` for macOS Apple Silicon, NSIS installer + portable `.exe` for Windows x64, and AppImage for Linux x64. Previously required a Node server + localhost browser setup.
- **Inline video player** on the lecture detail view — appears above the transcript when the lecture has at least one archived video. Powered by a new HTTP-range-capable streaming endpoint (`GET /api/courses/lectures/:id/video/:filename`) so seeking is instant.
- **Click-to-seek timestamps** — every `[HH:MM:SS]` / `[MM:SS]` marker in a transcript is rendered as a clickable amber link. Clicking seeks the player to that position and starts playback.
- **Multi-video archive** — lecture pages with multiple Hotmart embeds (e.g., Bookcamp episodes) now download all videos, not just the first. Files named `video.mp4`, `video_2.mp4`, etc.
- **Multi-video tabs** — the player shows "Video 1 / Video 2 / ..." tabs when a lecture has more than one archived file.
- **Playback speed selector** (0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2×) on the player; choice persists to localStorage across lectures and app restarts.
- **Resizable sidebar** — drag the vertical seam between sidebar and content to set the sidebar width; persists to localStorage.
- **Resizable video player** — drag the bottom-right corner of the player to adjust height; persists to localStorage.
- **File-explorer tree sidebar** — replaces the flat Sources + Sessions dropdowns. Courses are grouped by tag prefix (CUT / INK / LAN / LED / MID / Other) in collapsible groups. Within a course: sections → class-number groups → individual lectures. Clicking any node filters or opens the matching content.
- **"Show transcripts ▾" toggle** below the course tree reveals non-course sources (Summit transcripts, imported collections, etc.).
- **Tag-grouped Add Course picker** — the + course picker uses the same CUT/INK/LAN/LED/MID/Other groupings as the Browse tree.
- **Media Library Path** setting with a native OS folder picker (`POST /api/system/pick-folder`).
- **First-run splash modal** — forces the user to confirm (or change) the media library path before the app is usable, with a warning that video archives can grow very large.
- **ffmpeg pre-flight banner** — appears at the top of the app when system `ffmpeg` is not on PATH, with `brew install ffmpeg` / Windows / Linux install hints. Backed by `GET /api/system/ffmpeg`.
- **Force-refresh checkbox** in the scrape modal — ignores the per-lecture skip-known fast path and re-fetches transcript text for all lectures, including already-indexed ones.
- **Archive Videos button** on course detail with an SSE-driven progress modal. Includes Cancel support; already-archived lectures are skipped automatically.
- **Smart skip-logic** on archive re-runs: lectures with multiple recorded videos and all files present are skipped immediately; single-video lectures get a full Puppeteer dwell to check for additional unfetched videos.
- **New API endpoints:**
  - `GET /api/courses/lectures/:id/videos` — list archived video files for a lecture
  - `GET /api/courses/lectures/:id/video/:filename` — stream a video file with HTTP Range support
  - `GET /api/system/ffmpeg` — check whether ffmpeg is on PATH
  - `POST /api/courses/:id/archive-videos` — start SSE archive run for a course
  - `DELETE /api/courses/:id/archive-videos` — cancel an in-progress archive run
  - `GET /api/settings/media-library` — read current media library path
  - `POST /api/settings/media-library` — update media library path
  - `GET /api/system/reveal` — reveal a file in Finder/Explorer
  - `POST /api/system/pick-folder` — open a native OS folder picker

### Changed

- **Scraper section detection rewritten** to target `.slim-section` Teachable containers correctly. Previously, lecture rows were misidentified as sections, producing too many false "sections" in the sidebar.
- **Available courses listing sorted alphabetically** by name (was Teachable's "recommended" order).
- **`course_lectures` schema** — added columns: `teachable_lecture_id` (stable identifier for upsert keying), `removed_at` (soft-delete timestamp), `video_local_paths` (JSON array storing the paths of all archived video files per lecture, replaces the legacy single-path column).
- **Scrape uses idempotent upsert** keyed on `(course_id, teachable_lecture_id)` — was a destructive DELETE+INSERT per course. Re-scraping now preserves `video_local_paths` and all indexed chunks; new lectures append; lectures removed from the course are soft-deleted via `removed_at` rather than hard-deleted.
- **Per-platform Chromium bundling** — each platform's distributable ships only that platform's Puppeteer Chromium binary, saving ~400 MB per build compared to bundling all three.
- **Settings section renamed** in help from "AI Settings" to "Settings" to reflect the broader scope (media library, AI, themes).

### Fixed

- **macOS 26 Tahoe Electron init failure** — addressed by code-signing the app bundle with the project's Developer ID Application identity.
- **ffmpeg not found in packaged Mac app** — PATH now prepends `/opt/homebrew/bin` and `/usr/local/bin` before spawning ffmpeg, so Homebrew installs are visible even when launched from the Dock.
- **DB path mismatch in packaged builds** — `DATA_DIR` env var is now honored across all server modules, so packaged Electron uses `app.getPath('userData')/data` rather than the project tree's `data/` directory.
- **Re-scrape wiped video archives** — the old DELETE+INSERT scrape flow destroyed `video_local_path` on every re-scrape. The new upsert preserves all video data across scrape runs.

### Known limitations

- macOS notarization not yet done — first launch shows Gatekeeper "unidentified developer" warning. Right-click → Open works around this; only needs to be done once.
- Windows Authenticode signing not yet done — first launch shows SmartScreen "unrecognized app" warning. "More info → Run anyway" works around this.
- ffmpeg must be installed system-wide on each platform (`brew install ffmpeg`, `choco install ffmpeg`, `apt install ffmpeg`). Future: bundle via `@ffmpeg-installer/ffmpeg`.
- YouTube and non-Hotmart video hosts are not yet supported for archiving.
- Default Electron icon in use — no custom app branding yet.

---

*Earlier versions (v2.0.x and below) were unreleased internal iterations. This is the first public changelog entry.*
