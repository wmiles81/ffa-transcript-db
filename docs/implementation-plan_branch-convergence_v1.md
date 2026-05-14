# Plan: Converge open PRs into main and re-home "Show transcripts"

## Context

Two PRs have been open in parallel and are now diverging from `main`:

- **PR #5 — `fix/multi-video-transcripts`** (4 commits): scraper extracts a transcript per video in a multi-video lecture, archiver downloads in DOM order, UI filters the visible transcript to the active video tab. Schema: adds `course_chunks.video_index`, `course_lectures.video_embed_ids`.
- **PR #4 — `feature/phase-5-llm-wiki`** (10 commits): adds the LLM Wiki layer (4 wiki commits) plus a bundle of UX polish (build-version stamp, ffmpeg cancel fix, player resize, "trust N≥1 archive" tweak, and `1cf2ac8` which removes the "Show transcripts" toggle and parks transcript sources next to courses under "Other"). Schema: adds `wiki_*` tables + `course_lectures.wiki_ingested_at`.

`main` is at `2f1e91c` and only adds a session log post-PR-#5 — no code from either PR has actually landed yet.

Both branches modify `server/db.js` migrations, so a direct merge of one after the other will conflict. PR #4's sidebar commit (`1cf2ac8`) does not match the user's stated goal of "show transcripts → lectures where they belong" — it merely flattens transcript sources alongside courses, which is not where they belong either.

**Data-model surprise driving the recommendation:** the legacy `transcripts` table is *not* joined to `course_lectures`. Imported transcripts (YouTube playlists, podcasts, standalone files) live in their own `sources` + `transcripts` tables. There is no FK between them and the scraped course content. The current "Show transcripts" toggle exposes that legacy corpus as a parallel tree.

**User decisions captured this session:**

1. Final UI target: transcripts appear as a child node under each lecture.
2. Merge order: PR #5 first, then PR #4.
3. The "transcripts under lectures" rework is baked into PR #4 (not a follow-up).
4. For the data-model question, the user asked for a best-practice recommendation.

## Recommendation (best practice, long-term viable)

**Set up the right data model now; auto-match only the safe cases; show the rest under a clearly-labeled "Unassigned Transcripts" group; never throw data away.**

Concretely: replace PR #4's `1cf2ac8` with a deeper rework that adds two nullable FKs (`sources.course_id`, `transcripts.lecture_id`), runs a conservative exact-name auto-match migration, and rebuilds the sidebar so matched transcripts nest under their lecture, partially-matched ones nest under their course, and the orphans collapse into "Unassigned Transcripts." This honors the user's "where they belong" framing without inventing matches that aren't there, and leaves a clean path for a later assignment UI (or manual SQL fix-ups) to chip away at the orphan list over time.

This is preferred over the two extremes because:

- **"Just hide the toggle"** silently demotes ~12+ imported sources to search-only — a regression for any workflow that uses the sidebar to browse legacy content.
- **"Migrate everything into course_lectures"** risks fuzzy-match data loss and assumes every imported transcript actually maps to a scraped course, which is almost certainly false (podcasts, YouTube, etc.).

## Execution Plan

### Stage 1 — Merge PR #5 (multi-video transcripts) into main

Rebase `fix/multi-video-transcripts` on `main` to keep history linear.

- Files: `server/db.js`, `server/scraper.js` (or wherever per-video extraction lives), `src/main.js` (transcript tab filter), and any archiver file. No expected conflicts on top of current `main`.
- Verify: scrape a known multi-video lecture in dev, confirm `course_chunks.video_index` populated, confirm UI filters transcript when switching video tabs.
- Merge with `--no-ff` to preserve the PR boundary, push, close PR #5.

### Stage 2 — Rework PR #4 on the rebased main

Branch state after Stage 1: `fix/multi-video-transcripts` is in. Rebase `feature/phase-5-llm-wiki` onto updated `main`.

**Expected conflicts** during rebase:

1. `server/db.js` — migration block: PR #4 adds `wiki_*` tables and `course_lectures.wiki_ingested_at`; PR #5 added `course_chunks.video_index` and `course_lectures.video_embed_ids`. Both are additive; keep both, in commit order on the wiki branch.
2. `src/main.js` — PR #5 added transcript-tab filtering logic; PR #4 heavily edits the same renderer area. Resolve by preserving PR #5's filter and rebuilding PR #4's tree code on top.

Then **replace commit `1cf2ac8`** (sibling-merge of transcripts) with the new sidebar rework described below. Easiest: `git rebase -i` to drop `1cf2ac8`, then a fresh commit with the new approach.

### Stage 3 — Transcripts-under-lectures rework (inside PR #4)

**Schema migration** in [server/db.js](../server/db.js):

```sql
ALTER TABLE sources ADD COLUMN course_id TEXT REFERENCES courses(id);
ALTER TABLE transcripts ADD COLUMN lecture_id TEXT REFERENCES course_lectures(id);
CREATE INDEX idx_sources_course_id ON sources(course_id);
CREATE INDEX idx_transcripts_lecture_id ON transcripts(lecture_id);
```

**Auto-match migration** (one-time, conservative — exact normalized name match only):

```sql
-- Match sources to courses by normalized name equality
UPDATE sources SET course_id = (
  SELECT c.id FROM courses c
  WHERE LOWER(TRIM(REPLACE(REPLACE(c.title,' ',''),'-',''))) =
        LOWER(TRIM(REPLACE(REPLACE(sources.name,' ',''),'-','')))
  LIMIT 1
) WHERE id NOT LIKE 'course-%';

-- Match transcripts to lectures by (course_id, normalized lecture title)
UPDATE transcripts SET lecture_id = (
  SELECT cl.id FROM course_lectures cl
  JOIN sources s ON s.course_id = cl.course_id
  WHERE s.id = transcripts.source_id
    AND LOWER(TRIM(cl.title)) = LOWER(TRIM(transcripts.lecture))
  LIMIT 1
);
```

No fuzzy matching. If exact-normalized doesn't hit, leave NULL.

**Sidebar rebuild** in [src/main.js](../src/main.js):

- Delete `buildTranscriptsTreeRoots`, `renderTranscriptsTree`, the `transcripts-toggle` handler, and `state.showTranscripts` / `tdb-tree-show-transcripts` localStorage.
- In the course-tree renderer (`buildCourseTreeRoots` / `renderTree` / lecture node rendering, ~lines 489–870 on main), for each lecture node:
  - Query `/api/lectures/:id/transcripts` (new endpoint) for transcripts where `lecture_id = :id`.
  - If any exist, render a "Transcript" child node per transcript (or single "Transcript" if just one). Clicking loads the transcript content into the detail pane.
- Add a course-level "Other Transcripts" child group when `sources.course_id = course.id` exists but transcript rows have `lecture_id IS NULL`.
- Add a new top-level sidebar section "Unassigned Transcripts" — collapsed by default, lists sources where `course_id IS NULL`. Same render path as the old transcripts tree, just relocated and re-labeled.

**Markup change** in [src/index.html](../src/index.html) lines 126–132: remove the `transcripts-toggle` block; add the "Unassigned Transcripts" section below "Browse" with an aria-expanded chevron.

**New endpoint** in [server/server.js](../server/server.js): `GET /api/lectures/:id/transcripts` → returns transcript rows joined to source name. Reuse existing transcript-content endpoint for the detail load.

### Stage 4 — Wiki ingest awareness (small, inside PR #4)

[server/wiki.js](../server/wiki.js) currently ingests from `course_lectures` only. With Stage 3, some transcripts are now FK-linked to lectures. Update `ingestLecture` to also pull text from `transcripts WHERE lecture_id = :id` when present, concatenated with `course_chunks`. This is a few lines and prevents the wiki from being blind to merged-in legacy content.

### Stage 5 — Docs sync

Promote and prune:

- Add `docs/session-2026-05-14_branch-convergence_v1.md` summarizing this session's decisions and the migration semantics.
- Update [feature-plan_phase-5-6_video-player_v1.md](feature-plan_phase-5-6_video-player_v1.md) if it references the old "Show transcripts" toggle.
- The Wiki spec lives in [implementation-plan_phase-5-6_v1.md](implementation-plan_phase-5-6_v1.md) — add a "Transcript merge model" addendum noting the new FKs and the unassigned-transcripts UX.

No version bump of older v1–v5 plan files; they document history, not current state.

### Stage 6 — Merge PR #4

After conflict resolution, force-push the rebased branch, request final review, merge with `--no-ff`, close PR #4. Cut a `v2.2.0` tag (Wiki feature + sidebar rework + multi-video) and update `CHANGELOG.md`.

## Critical Files

- [server/db.js](../server/db.js) — migrations (conflict zone + new ALTERs)
- [src/main.js](../src/main.js) — sidebar logic (largest single edit)
- [src/index.html](../src/index.html) — sidebar markup (lines 126–132)
- [server/server.js](../server/server.js) — new transcripts-by-lecture endpoint
- [server/wiki.js](../server/wiki.js) — pull lecture-linked transcripts into ingest
- [src/style.css](../src/style.css) — drop `.transcripts-toggle` styles, add unassigned-section styles
- [CHANGELOG.md](../CHANGELOG.md) — release notes for v2.2.0

## Verification

Each stage gates on the next.

**Stage 1 (multi-video):**
- Scrape a known multi-video lecture. Confirm `SELECT DISTINCT video_index FROM course_chunks WHERE lecture_id = ?` returns 2+ values.
- Open the lecture in the app; toggle between video tabs; transcript pane filters to the active tab.

**Stage 3 (sidebar rework):**
- Fresh launch: no "Show transcripts" toggle visible.
- Expand a course where exact-name match should succeed (pick one from `SELECT s.name, c.title FROM sources s, courses c WHERE LOWER(TRIM(REPLACE(s.name,' ',''))) = LOWER(TRIM(REPLACE(c.title,' ','')))`). Confirm lectures show transcript children.
- Expand the "Unassigned Transcripts" group; confirm the orphans render and clicking still loads transcript content.
- Confirm no data was deleted: `SELECT COUNT(*) FROM transcripts` matches pre-migration count.

**Stage 4 (wiki):**
- Click "Rebuild" on a course that has a lecture with an FK-linked transcript. Inspect `wiki_log` for the lecture; confirm the source text length includes both `course_chunks` and `transcripts.content`.

**Stage 6 (release):**
- `npm run build` succeeds on all three platforms (mac, win, linux).
- Smoke test the packaged Mac build: scrape, browse, wiki rebuild, search across both course and legacy transcript content.

## Out of Scope (deliberate)

- Fuzzy matching of transcripts to lectures. Future work; user can manually assign via SQL or a future UI.
- Per-video transcript children under each lecture (one transcript node per video). The multi-video filter already handles video switching inside the detail view; sidebar stays at lecture granularity.
- Migration of any course-scraped `course_lectures` data — they're already correct; only the legacy `transcripts` table gets FKs.
- A bulk assignment UI. Useful eventually; not required to ship.
