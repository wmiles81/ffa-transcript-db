# Changelog

All notable changes to TranscriptDB. Format based on [Keep a Changelog](https://keepachangelog.com/).

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
