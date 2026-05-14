# Session — 2026-05-13/14: LLM Wiki experiment, then multi-video transcripts fix

## Presenting context

Two distinct arcs in one session:

1. **LLM Wiki experiment (PR #4)** — researched Karpathy's three-layer "LLM wiki" pattern, scoped a wiki layer on top of the transcript DB (authors / techniques / tools / debates as entity kinds), built it end-to-end on the `feature/phase-5-llm-wiki` branch. Along the way also bolted on version stamping, an archive-cancel fix, scroll-layout fixes, a video-player tidy-up, and a sidebar restructure. Got messy, the user pulled back to main.

2. **Multi-video transcripts fix (PR #5)** — focused, four-commit fix on `fix/multi-video-transcripts` off main. Real problem surfaced after inspection: multi-video Teachable lectures (e.g. Show Joe Show Episode 1, 3 videos × 3 transcripts on one page) were being captured as one concatenated transcript blob with no per-video association, and the videos were being archived in network-event order rather than DOM order. End-to-end verified on Episode 1.

The user's mid-session pivot — *"You've completely lost the bubble here. Can you revert to the first version with the video display?"* — was the moment the first arc ended. Reverting to main and re-grounding via DOM inspection of an actual Teachable lecture page led directly to the right fix.

## Documents produced this session

None — the work shipped as code on two branches; this session log is the only doc.

The Karpathy LLM Wiki plan written in `/Users/wmiles49/.claude/plans/we-need-to-rethink-idempotent-yao.md` was approved and partially executed under PR #4 but is not the canonical path forward; the multi-video fix in PR #5 is.

## What's on the branches

### `feature/phase-5-llm-wiki` (PR #4, open, **paused — not the path forward**)

8 commits ahead of `a62cb4d`:

```
1cf2ac8 Sidebar: merge transcript sources into main tree; archive: order videos by DOM position
8774b19 Tidy video player: hide irrelevant native menu items + center the box
32d057b Independent pane scroll + both-axis player resize
7841a67 Auto-stamp build version (v2.1.x · sha) and show it in the header
95c616d Trust any complete N≥1 video archive instead of forcing a re-dwell on N=1
a613899 Add Wiki tab UI — sidebar nav, entity grid, claim ledger, rebuild
9c98680 Wire wiki endpoints and auto-ingest hook into server.js
479fef0 Add server/wiki.js — ingest, rebuild, lint, and query for the LLM Wiki
6ecf1fa Add wiki_* tables migration for LLM Wiki layer
```

Bundles too many concerns; user reverted away from this state when video display started behaving oddly. PR is still open on remote in case any individual piece is worth cherry-picking later (most likely: the version-badge commit `7841a67`, the archive-cancel fix in PR #4's underlying work, the `≥ 1` skip threshold `95c616d` which made it independently into the next branch anyway).

### `fix/multi-video-transcripts` (PR #5, open, **the real fix**)

4 commits ahead of `a62cb4d`:

```
04ee51c UI: filter visible transcript by active video tab
cecfe6e Archiver: order downloads by iframe DOM position; persist embed-id sequence
7ccb2aa Scraper: extract transcripts per video, tagged with video_index
9eb9878 Add video_index on course_chunks + video_embed_ids on course_lectures
```

End-to-end verified on Show Joe Show! Episode 1 (lecture 3983):
- 41 chunks split 16 / 13 / 12 across `video_index` 0 / 1 / 2
- `video_embed_ids` = `["4qXBW07EZv", "Yq2x9MNWZa", "nRvVmG1zRQ"]` matches on-page DOM order
- Tab clicks swap both the video src and the transcript pane together

## Inspection finding that grounded the fix

A one-off Puppeteer script (`scripts/inspect-lecture-dom.mjs`, also created this session) dumped the DOM structure of Episode 1. The page is a clean interleaving:

```
iframe  hotmart.com/embed/4qXBW07EZv   ← Video 1 (Claw Bot)
.lecture-text-container  3,704 chars   ← Transcript 1
iframe  hotmart.com/embed/Yq2x9MNWZa   ← Video 2 (Electron Demo)
.lecture-text-container  4,878 chars   ← Transcript 2
iframe  hotmart.com/embed/nRvVmG1zRQ   ← Video 3 (Genre Research)
.lecture-text-container  5,729 chars   ← Transcript 3
```

Plus 3 `.txt` attachments at canonical CDN URLs, one per transcript. The pre-fix scraper grabbed all 3 `.txt` files and joined them with `\n\n---\n\n` — no per-video tagging.

## New / modified files (PR #5)

| File | Change |
|---|---|
| `server/db.js` | Migration: `ALTER TABLE course_chunks ADD COLUMN video_index INTEGER`; `ALTER TABLE course_lectures ADD COLUMN video_embed_ids TEXT`. Nullable, no backfill — single-video and legacy data stay NULL. |
| `server/scraper.js` | Walks `.lecture-attachment` children in DOM order; opens a new segment per Hotmart iframe; attaches the following `.txt` download + text container to that segment. Each segment's chunks are inserted with `video_index`. Persists `video_embed_ids` (Hotmart embed IDs in DOM order) on the lecture row. |
| `server/media-downloader.js` | After page.goto, scrolls each Hotmart iframe into view sequentially (6s per-iframe dwell) so manifest captures land in DOM order. Re-reads embed IDs from the live page; persists them after a successful download. Skip threshold relaxed: complete N≥1 path-set with all files on disk now short-circuits, not N≥2. |
| `src/main.js` | `loadTranscriptDetail` now includes `chunks` (with `video_index`) on the transcript object. `renderTranscriptDetail` extracts a `rawTextForVideo(videoIndex)` helper that filters chunks by `video_index` when there are multiple videos. Tab-click handler calls the helper and re-binds timestamp links so transcript-pane swaps in place. Single-video lectures and legacy NULL data still render the full transcript. |
| `scripts/inspect-lecture-dom.mjs` | One-off Puppeteer DOM inspector. Not part of the PR's product code; helped diagnose the page structure. Lives in `scripts/` so it's available for future "what's actually on this page" questions. |

## One-time data fix (not a code change)

Episode 1's `video_local_paths` was reordered in-DB from
`[video.mp4, video_2.mp4, video_3.mp4]` (legacy archive order — wrong) to
`[video_3.mp4, video.mp4, video_2.mp4]` (DOM order, matches embed IDs).

Done via an Electron-node-mode script writing through `server/db.js` with a forced `wal_checkpoint(TRUNCATE)` after the UPDATE. First attempt did not persist — likely overwritten when a phantom second Electron instance booted during a window-focus attempt and re-ran `initializeDb`. The second attempt with explicit WAL checkpoint stuck.

Files on disk are untouched — only the database mapping changed.

## Decisions and rationale

- **Don't clear the DB.** User initially suggested it (*"we may have to clear the database and start over"*). Inspection showed the underlying chunks were correctly captured — they were just concatenated, not tagged. Migration + re-scrape is enough.
- **`video_index` is nullable.** Single-video lectures and legacy data leave it NULL; the UI's filter falls through to "show full transcript" for those, so no backfill needed.
- **Walk `.lecture-attachment` rather than chasing `.fr-view` / `.lecture-text-container` directly.** Teachable wraps each lecture element (`video`, `file`, `text`) in a `.lecture-attachment` with a kind class. Walking those siblings gives a deterministic interleaving.
- **Scroll iframes into view rather than guessing manifest order.** Hotmart players lazy-load manifests when in view. Scrolling each iframe sequentially makes the network-request order match document order without parsing or matching URLs.
- **Hotmart embed ID as the cross-reference.** `iframe src` contains `/embed/<id>`, persisted to `video_embed_ids`. Lets future fixers prove which file goes with which DOM slot without re-walking the page.

## Followups (none in this PR)

- **Legacy multi-video lectures with wrong `video_local_paths` ordering.** No persistent record links the old file names to embed IDs. Options: (a) per-lecture DB reorder via a tiny admin endpoint, (b) "rescan and rename" mode that opens each lecture page, captures manifests, matches by signature, reorders without re-downloading. Episode 1 was done manually as proof of concept; the rest of the multi-video lectures still have the wrong on-disk-name → DOM-index mapping.
- **Per-tab labels from `.txt` filenames** (e.g. "Introducing Claw Bot" instead of "Video 1"). The data is already in `course_chunks` — the first chunk of each video carries the heading. Small UI change.
- **LLM Wiki (PR #4) work that's worth salvaging individually:**
    - Version-stamping (auto-bump patch on `npm run build`, `v2.1.x · sha` header badge) — cleanest standalone piece, would land as a small focused PR.
    - Make-Cancel-actually-cancel (plumb `AbortSignal` from orchestrator → `downloadLectureVideo` → `runFfmpeg` → kill ffmpeg with SIGKILL; abortable Puppeteer dwell). User saw it work; the underlying problem was real.
    - Independent pane scroll (`html`/`body`/`#app` to `height: 100%` so flex children get viewport-bounded scroll). One-line fix that addresses a real layout issue.
    - Hide native HTML5 `<video>` context menu items that don't apply (`controlsList="nodownload noremoteplayback noplaybackrate"`, `disablePictureInPicture`). Trivial and obviously correct.
- **Wiki layer itself** — the schema/server module/UI built under PR #4 is functional but tangled with the other concerns. If the user wants the LLM Wiki conceptually, a clean reland on top of main (without the version-badge/layout/sidebar churn) would be cleaner than merging #4 as-is.

## What the user said

- *"We need better internal versioning. Internal testing versions should increment the lowest level with each build, and the version should be noted somewhere in the software. I no longer know if I'm using the most recent version."* → version-stamp + header badge (PR #4, commit `7841a67`).
- *"Cancel does nothing other than change the text. This was taken five minutes after the cancel button was clicked."* → AbortSignal plumbing through `downloadLectureVideo` and `runFfmpeg` (PR #4).
- *"The two main panes should scroll independently. The video screen should be resizable."* → fixed `min-height: 100vh` → `height: 100%` on root layout; `resize: vertical` → `resize: both` on player wrap.
- *"What are we downloading? We're already seeing a downloaded video. Picture in picture of what? The video should be centered."* → `controlsList` + `disablePictureInPicture`; centered with `width: min(960px, 100%)` and `margin: 0 auto`.
- *"You've completely lost the bubble here. Can you revert to the first version with the video display?"* → reverted to `a62cb4d` then stepped back further; eventually landed on `1b6b861` (videos endpoint, no UI), then back to `main` for the focused fix.
- *"Here is the problem: We are picking up only one transcript where there should be three. This error probably runs through the entire system at this point. We may have to clear the database and start over."* → triggered the DOM inspection, which led to PR #5.
- *"Why are you deleting the files? They are not corrupted, just in the wrong order. That should be a database change."* → reverted from "force re-archive (re-download)" approach to "reorder `video_local_paths` in DB only" approach for the Episode 1 fix.
- *"Now it works."* → end-to-end verified.

## State at session end

- `main` is unchanged from session start (`a62cb4d`).
- `feature/phase-5-llm-wiki` is on the remote, PR #4 open.
- `fix/multi-video-transcripts` is on the remote, PR #5 open. **This is the recommended PR to land.**
- The Electron app DB has one one-time data fix: Episode 1 (lecture 3983) has `video_local_paths` reordered to DOM order.
- No code changes are uncommitted on the current branch.
