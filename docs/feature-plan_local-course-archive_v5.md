# Feature plan v5 — Phase 3.1: Incremental scrape

**Date:** 2026-05-10
**Status:** Awaiting approval to start implementation
**Predecessor:** [v4](feature-plan_local-course-archive_v4.md) (Phases 1–3 complete and merged to `main`)
**Driver:** "Future Fiction Academy Lab" (Teachable course `2426053`) is a *container of immutable weekly lab sessions* that grows over time. The current scraper's `DELETE + INSERT` model wipes the link to already-downloaded videos on every re-scrape, making periodic re-scraping cost-prohibitive (orphans the entire on-disk archive, forces a full re-download).

## Goal

Make `scrapeCourse()` **incremental and idempotent** at the lecture level:

1. Re-scraping a course **preserves** `video_local_path`, `video_duration_sec`, `video_downloaded_at`, and `course_chunks` for lectures that haven't changed.
2. **New** lectures appear as new rows; `archive-videos` picks them up on the next run.
3. **Removed** lectures are soft-deleted (kept in DB with `removed_at` timestamp; UI hides them by default).
4. For an immutable-content course like the Lab, a re-scrape **skips the per-lecture transcript fetch** for already-known lectures — turning a 10–20 min full re-scrape into ~30 sec.

## Decisions (locked)

| Question | Decision |
|---|---|
| Stable lecture key | Teachable's lecture ID, parsed from URL `/lectures/(\d+)` |
| Stable section key | `(course_id, title)` natural key (no Teachable section ID surfaced in DOM) |
| Removed-lecture behavior | **Soft-delete** — set `removed_at = NOW`, preserve row, chunks, and on-disk video file |
| Default transcript-fetch behavior | **Skip if lecture already in DB** (immutable-content assumption) |
| Force-refresh escape hatch | `--force-refresh` CLI flag on the scraper invocation path; default `false` |
| FK cascade on `course_lectures.section_id` | Keep existing `ON DELETE CASCADE`; sections are upserted by natural key, not deleted |
| Backfill of existing 38 courses | One-time SQL: parse `url` column, populate `teachable_lecture_id` |
| Migration safety | All schema changes additive + idempotent (`ALTER TABLE ADD COLUMN IF NOT EXISTS`-style guards); no destructive migrations |

## Schema changes

Three additive columns, two indexes. All changes idempotent in the existing migration block in [server/db.js](../server/db.js).

```sql
-- course_lectures
ALTER TABLE course_lectures ADD COLUMN teachable_lecture_id TEXT;
ALTER TABLE course_lectures ADD COLUMN removed_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lectures_teachable
  ON course_lectures(course_id, teachable_lecture_id);

-- course_sections
CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_course_title
  ON course_sections(course_id, title);
```

The unique index on `(course_id, teachable_lecture_id)` enables `INSERT … ON CONFLICT DO UPDATE`. Same for sections on `(course_id, title)`.

### Backfill

After adding the column, run once:

```sql
UPDATE course_lectures
SET teachable_lecture_id = (
  SELECT substr(url, instr(url, '/lectures/') + length('/lectures/'))
)
WHERE teachable_lecture_id IS NULL
  AND url LIKE '%/lectures/%';
```

Any row whose URL doesn't match `/lectures/<digits>` after this stays NULL and is reported by the migration as an anomaly. With existing data, all 38 courses have URL formats that match (verified during this design pass). The migration aborts with a clear error if any post-backfill row has NULL `teachable_lecture_id` (indicates schema-level data corruption that the upsert would propagate).

## Scraper changes

Three coordinated edits in [server/scraper.js](../server/scraper.js):

### 1. DOM extraction — extract `teachable_lecture_id` per lecture

Inside the existing `lectureLinks.forEach(link => { … })` block (around line 258), add:

```js
const idMatch = href.match(/\/lectures\/(\d+)/);
if (!idMatch) return; // skip — should never happen on real Teachable URLs
const teachableLectureId = idMatch[1];
```

Push it onto the `lectures.push({ … })` object.

### 2. Listing-stage skip-known optimization (Approach 3)

Before the per-lecture page navigation loop (around line 333), build the set of already-known `teachable_lecture_id`s for this course:

```js
const knownIds = new Set(
  db.prepare(
    'SELECT teachable_lecture_id FROM course_lectures WHERE course_id = ? AND teachable_lecture_id IS NOT NULL'
  ).all(courseId).map(r => r.teachable_lecture_id)
);
```

In the per-lecture loop, gate the expensive Puppeteer navigation:

```js
if (knownIds.has(lecture.teachableLectureId) && !forceRefresh) {
  // Skip the per-lecture page fetch and chunk regeneration.
  // Position/title still get refreshed by the upsert below from the listing data.
  scraped++;
  continue;
}
```

`forceRefresh` is a parameter threaded through `scrapeCourse(url, onProgress, { forceRefresh })` from the caller. Default `false`.

### 3. Replace DELETE + INSERT with stage-and-upsert

Replace the current block (server/scraper.js:323–352):

```js
db.prepare('DELETE FROM course_sections WHERE course_id = ?').run(courseId);
db.prepare('DELETE FROM course_lectures WHERE course_id = ?').run(courseId);
// then INSERT each section, INSERT each lecture
```

with:

```js
// Stage 1: Upsert sections by (course_id, title); collect resulting section_ids.
const sectionUpsert = db.prepare(`
  INSERT INTO course_sections (course_id, title, position)
  VALUES (?, ?, ?)
  ON CONFLICT(course_id, title) DO UPDATE SET position = excluded.position
  RETURNING id
`);
const sectionIdByTitle = new Map();
for (let si = 0; si < sections.length; si++) {
  const s = sections[si];
  if (s.title && PROMO_TITLES.has(s.title)) continue;
  const { id } = sectionUpsert.get(courseId, s.title, si);
  sectionIdByTitle.set(s.title, id);
}

// Stage 2: Upsert lectures by (course_id, teachable_lecture_id).
//   ON CONFLICT, refresh: section_id, title, url, duration, position, scraped_at,
//   class_number, video_url, video_provider, notion_url, removed_at=NULL.
//   PRESERVE: video_local_path, video_duration_sec, video_downloaded_at.
const lectureUpsert = db.prepare(`
  INSERT INTO course_lectures (
    course_id, section_id, teachable_lecture_id,
    title, url, duration, position, scraped_at, class_number,
    video_url, video_provider, notion_url, removed_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT(course_id, teachable_lecture_id) DO UPDATE SET
    section_id    = excluded.section_id,
    title         = excluded.title,
    url           = excluded.url,
    duration      = excluded.duration,
    position      = excluded.position,
    scraped_at    = excluded.scraped_at,
    class_number  = excluded.class_number,
    video_url     = excluded.video_url,
    video_provider= excluded.video_provider,
    notion_url    = excluded.notion_url,
    removed_at    = NULL
  RETURNING id
`);
// Capture the set of seen IDs in this scrape for the soft-delete pass.
const seenLectureIds = new Set();
// ... per-lecture loop assigns lectureId from this upsert ...
```

The `RETURNING id` clause gives us the `lectureId` whether the row is new or updated, replacing the existing `lastInsertRowid`-based logic.

> **Note on ON CONFLICT and `RETURNING`:** SQLite supports both as of 3.35. `better-sqlite3-multiple-ciphers` 12.x exposes them via `.get()` / `.all()`. Verified during this design pass against the project's `package.json` dependency.

### 4. Soft-delete pass for missing lectures

After Stage 2, set `removed_at` for any lecture in the course that wasn't seen in this scrape:

```js
const seenIds = [...seenLectureIds]; // collected during upsert loop
const placeholders = seenIds.map(() => '?').join(',');
const nowIso = new Date().toISOString();
if (seenIds.length > 0) {
  db.prepare(`
    UPDATE course_lectures
    SET removed_at = ?
    WHERE course_id = ?
      AND teachable_lecture_id NOT IN (${placeholders})
      AND removed_at IS NULL
  `).run(nowIso, courseId, ...seenIds);
} else {
  // Defensive: a scrape that returned 0 lectures shouldn't soft-delete everything;
  // bail with an error instead.
  throw new Error(`Scrape returned 0 lectures for course ${courseId} — refusing to soft-delete the entire course`);
}
```

The orphaned section rows (sections that no longer exist in Teachable) are left alone — they have no lectures pointing to them and don't break anything. A small `WHERE id NOT IN (seenSectionIds)` cleanup pass could remove them, but it's not necessary for correctness.

### 5. Transcript-chunk handling

When skip-known fires (lecture already exists, `--force-refresh` not set), the chunk-regeneration block (server/scraper.js:481–488) is bypassed. The existing chunks stay untouched.

When `--force-refresh` is set OR the lecture is new, the chunk block runs. To avoid duplicates on a forced refresh, prepend a delete:

```js
db.prepare('DELETE FROM course_chunks WHERE lecture_id = ?').run(lectureId);
```

This is safe because `course_chunks` always rebuilds in full from the freshly-fetched transcript.

## CLI changes

[server/archive-videos.js](../server/archive-videos.js) is unaffected — it reads `course_lectures` and the existing idempotency check (`video_local_path IS NOT NULL && file exists`) handles everything. No edits.

The HTTP API endpoint `POST /api/courses/scrape` accepts `{ url }` today. Add an optional `forceRefresh` field:

```js
const { url, forceRefresh = false } = req.body;
// ...
const result = await scrapeCourse(url, onProgress, { forceRefresh });
```

Frontend wiring (a checkbox in the scrape modal) is **out of scope for Phase 3.1** — the CLI/API path is enough for now.

## Migration of existing data

A separate one-shot administrative consideration, not blocking Phase 3.1:

- **Course 26** (just freshly re-scraped under Phase 3): all 6 lectures already have `video_provider` populated. After the migration runs, their `teachable_lecture_id` columns get backfilled. ✅ Future re-scrapes are idempotent.
- **Course 39** (FFA Lab Archives 2023, archived/static): same situation. Backfill works. Course is unchanging anyway.
- **Other 36 courses**: backfill populates `teachable_lecture_id`. They don't have video archives yet, but if a user runs `archive-videos -- <id>` after Phase 3.1, the upsert wires it up correctly.
- **Lecture 1923 manual UPDATE during Phase 3 verification**: still has `video_provider='hotmart'` and `video_local_path` set. Backfill picks up its `teachable_lecture_id` from URL. Works.

No data migration scripts beyond the one-time `UPDATE` in the schema-migration block.

## Implementation tasks (subagent-driven)

Same workflow as Phase 3:

| # | Task | Scope |
|---|---|---|
| **3.1.T1** | **Schema migration + backfill** | [server/db.js](../server/db.js): add 2 columns + 2 indexes idempotently; perform one-time backfill from `url` columns; abort migration if any row remains with NULL `teachable_lecture_id` after backfill |
| **3.1.T2** | **Scraper upsert refactor** | [server/scraper.js](../server/scraper.js): extract `teachable_lecture_id` from lecture URLs in DOM extraction; replace DELETE+INSERT block with stage-and-upsert; add soft-delete pass. Owns sections 1, 3, 4 of the scraper-changes design above. **Does NOT** introduce skip-known yet — full re-fetch behavior preserved at this stage so each task is independently verifiable. |
| **3.1.T3** | **Skip-known optimization + force-refresh wiring** | Build pre-loop `knownIds` set; gate per-lecture Puppeteer navigation on `knownIds.has(...) && !forceRefresh`; thread `forceRefresh` through `scrapeCourse(url, onProgress, { forceRefresh })`; force-refresh path deletes existing chunks before regenerating (section 5 of design); HTTP API accepts `forceRefresh` body field. |

Each task gets:
1. Implementer subagent (worktree-isolated)
2. Spec-compliance reviewer subagent
3. Code-quality reviewer subagent

Then a **holistic final review** before merge, then `finishing-a-development-branch`.

## Verification

Functional verification (no test suite by design):

1. **Backfill correctness** — after T1, run a query that COUNT(*)s `course_lectures` with NULL `teachable_lecture_id`. Must be 0. (T1's migration aborts if non-zero.)
2. **Re-scrape course 26 (already-archived)** — after T2, T3:
   - All 6 lectures preserved (same `id`s)
   - All 4 video files still linked (`video_local_path` unchanged for lectures 2177, 2179, 2180, 2181)
   - `archive-videos -- 26` reports `4 already archived, 2 wrong provider, 0 downloaded`
3. **Re-scrape with `forceRefresh=true`** — same lectures stay (same `id`s), but `course_chunks` rows are regenerated (timestamps refresh)
4. **Skip-known fast path** — re-scrape course 26 without force-refresh, time it; should be < 5 sec (no per-lecture Puppeteer navigation, just listing-page fetch)
5. **New-lecture detection** — manually `DELETE FROM course_lectures WHERE id = 2177` (simulate a never-seen lecture); re-scrape; row reappears with original Teachable lecture ID, NEW autoincrement `id`. (Edge: orphaned video file at `lectures/2177/` becomes unreferenced — acceptable; user re-runs `archive-videos` if they want to re-link.)
6. **Soft-delete behavior** — manually insert a fake lecture with `teachable_lecture_id='99999999'` for course 26; re-scrape; verify the fake row gets `removed_at` set, real rows untouched.
7. **Lab course scrape** — finally, `scrapeCourse('https://future-fiction-academy.teachable.com/courses/2426053/lectures/58959401')`. Initial pass: 100+ lectures, full transcript fetch (~10–20 min). Second pass (next week, after Teachable adds new sessions): only NEW lectures fetched (~30 sec for the listing page + ~1 min per new lecture).

## Open follow-ups (deferred to 3.2 or later)

These are **not in scope** for Phase 3.1:

- **Frontend "force refresh" toggle** in the scrape modal. CLI/API support is enough for now.
- **UI hide-removed-lectures filter**. The `removed_at` column is populated; the UI can ignore it for now (lectures with `removed_at` show normally). Add a filter only if it becomes a real annoyance.
- **Cleanup orphaned video files on disk** when a soft-delete fires. Manual `find` + `rm` is fine for now.
- **Section soft-delete + display**. Sections are containers; if Teachable removes one, leave the row.
- **Cross-course de-duplication**. Two courses could (in theory) point to the same `teachable_lecture_id` if Teachable reused one — extremely unlikely. Not handled.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Backfill leaves NULL `teachable_lecture_id` for some row | Low | Migration aborts with clear error; manual SQL fix per row |
| `INSERT … ON CONFLICT DO UPDATE … RETURNING` not supported by `better-sqlite3-multiple-ciphers` 12.9 | Very low | Verified at design time; `RETURNING` is SQLite ≥3.35 standard, library wraps it |
| Soft-delete fires for whole course on flaky scrape | Mitigated | Defensive `if (seenIds.length === 0) throw` guard; the listing-page parse fails fast on auth issues |
| Skip-known path misses transcript edits on Teachable | Acknowledged | User accepted this trade-off; `--force-refresh` provides the escape hatch |
| Renamed section in Teachable creates orphaned `course_sections` row | Low | Cosmetic; harmless; can be cleaned up by a future "prune orphan sections" pass |
| Concurrent re-scrape of the same course | Very low | Single-user app; not handled |

## Estimate

Same shape as Phase 3:

- **T1 (schema migration)**: ~30 min implement + 2 reviews ≈ 1 hour wall-clock
- **T2 (scraper upsert)**: ~60 min implement + 2 reviews ≈ 1.5–2 hours
- **T3 (skip-known + force-refresh)**: ~30 min implement + 2 reviews ≈ 1 hour
- **Final review + finish branch**: ~30 min

**Total: ~4 hours** including review cycles.

## Phase 3.1 → next steps

After Phase 3.1 merges:

1. Re-scrape "Future Fiction Academy Lab" (`teachable_id=2426053`) once — picks up all current lectures.
2. Run `archive-videos -- <new_course_id>` overnight — downloads the (likely large) backlog of Hotmart videos.
3. Set up a weekly recurring task (cron / launchd) to re-scrape the Lab — fast incremental run, picks up new sessions.
4. Phase 3b (yt-dlp for YouTube embeds) and Phase 4 (Notion archiver) per [v4](feature-plan_local-course-archive_v4.md).
