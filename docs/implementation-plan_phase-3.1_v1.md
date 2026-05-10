# Phase 3.1 Implementation Plan — Incremental Scrape

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scrapeCourse()` incremental and idempotent at the lecture level — re-scrapes preserve already-downloaded video archives, append new lectures, soft-delete removed lectures, and (for unchanged lectures) skip the expensive per-lecture transcript fetch.

**Architecture:** Add a stable `teachable_lecture_id` column extracted from the existing `url` field. Replace the scraper's `DELETE + INSERT` block with `INSERT … ON CONFLICT DO UPDATE` keyed on `(course_id, teachable_lecture_id)`. Sections handled the same way using `(course_id, title)` as the natural key. A pre-loop "known IDs" set gates Puppeteer navigation so re-scrapes of immutable-content courses (e.g., FFA Lab) finish in seconds.

**Tech Stack:** Node.js 22 ESM, `better-sqlite3-multiple-ciphers` 12.9 (encrypted SQLite, supports `ON CONFLICT … DO UPDATE` and `RETURNING`), Puppeteer 24, no test framework (functional verification by direct Node invocation).

**Predecessor docs:**
- Spec: [docs/feature-plan_local-course-archive_v5.md](feature-plan_local-course-archive_v5.md)
- Prior phase: [docs/feature-plan_local-course-archive_v4.md](feature-plan_local-course-archive_v4.md)

**Workflow note:** No test suite. Each task gets:
1. Implementer subagent (worktree-isolated) — produces code + functional verification scripts.
2. Spec-compliance reviewer subagent — verifies code matches v5 spec; does not trust implementer's self-report.
3. Code-quality reviewer subagent — categorizes issues by severity (Important / Notable / Polish) and gives a verdict.
4. Fix-and-re-review loop only if Important issues are found.

This mirrors the Phase 3 pattern documented in [docs/session-2026-05-10_local-course-archive-implementation_v1.md](session-2026-05-10_local-course-archive-implementation_v1.md).

---

## File Structure

| File | Action | Responsibility after change |
|---|---|---|
| `server/db.js` | Modify | Add 2 columns + 2 indexes idempotently; one-time backfill of `teachable_lecture_id` from `url`; abort migration if any row is left NULL |
| `server/scraper.js` | Modify | Extract `teachable_lecture_id` per lecture in DOM extraction; replace DELETE+INSERT with stage-and-upsert (sections then lectures); soft-delete pass for missing lectures; (T3) build `knownIds` Set + gate Puppeteer navigation; (T3) thread `forceRefresh` through `scrapeCourse(url, onProgress, { forceRefresh })`; (T3) delete `course_chunks` rows before regenerating in force-refresh path |
| `server/server.js` | Modify | (T3) `POST /api/courses/scrape` accepts optional `forceRefresh` body field and threads it to `scrapeCourse` |
| `server/archive-videos.js` | **Untouched** | The downloader's idempotency logic (`video_local_path IS NOT NULL && file exists`) already handles all cases |

No new files. No deletions. No package.json changes.

---

## Task 1: Schema migration + backfill

**Branch (worktree):** `feature+phase-3.1-schema`

**Files:**
- Modify: `server/db.js` (existing migration block around lines 280–298)

**Goal:** Two new columns on `course_lectures`, two unique indexes, one idempotent backfill from `url` field. Migration aborts loudly if any row remains with NULL `teachable_lecture_id` after backfill.

- [ ] **Step 1.1: Read the existing migration block**

The current block lives just below the `CREATE TABLE` statements. Look for the first `try { db.prepare('ALTER TABLE course_lectures ADD COLUMN ...').run(); } catch { /* exists */ }` pattern and add to it. The pattern guards with try/catch because SQLite ALTER TABLE doesn't support `IF NOT EXISTS` for columns.

- [ ] **Step 1.2: Add `teachable_lecture_id TEXT` column**

Append to the existing migration block:

```js
// Phase 3.1: Add teachable_lecture_id for idempotent upserts
const lectureCols = db.prepare('PRAGMA table_info(course_lectures)').all().map(c => c.name);
if (!lectureCols.includes('teachable_lecture_id')) {
    db.prepare('ALTER TABLE course_lectures ADD COLUMN teachable_lecture_id TEXT').run();
}
```

If `lectureCols` is already declared earlier in the migration block (it is, in Phase 1's block), reuse that variable instead of re-querying.

- [ ] **Step 1.3: Add `removed_at TEXT` column**

Same pattern:

```js
if (!lectureCols.includes('removed_at')) {
    db.prepare('ALTER TABLE course_lectures ADD COLUMN removed_at TEXT').run();
}
```

- [ ] **Step 1.4: Backfill `teachable_lecture_id` from existing `url` values**

After the column adds:

```js
// One-time backfill: extract teachable_lecture_id from URL.
// URL format: '/courses/<slug>/lectures/<id>' or 'https://.../courses/<slug>/lectures/<id>'
db.prepare(`
    UPDATE course_lectures
    SET teachable_lecture_id = substr(url, instr(url, '/lectures/') + length('/lectures/'))
    WHERE teachable_lecture_id IS NULL
      AND url LIKE '%/lectures/%'
`).run();
```

- [ ] **Step 1.5: Verify backfill is complete; abort if not**

After the UPDATE:

```js
const stillNull = db.prepare(
    'SELECT COUNT(*) AS n FROM course_lectures WHERE teachable_lecture_id IS NULL'
).get().n;
if (stillNull > 0) {
    const samples = db.prepare(
        'SELECT id, course_id, title, url FROM course_lectures WHERE teachable_lecture_id IS NULL LIMIT 5'
    ).all();
    throw new Error(
        `Phase 3.1 migration: ${stillNull} course_lectures rows have NULL teachable_lecture_id after backfill. ` +
        `Sample rows: ${JSON.stringify(samples)}. Fix the URL data or this migration before retrying.`
    );
}
```

- [ ] **Step 1.6: Add unique index on `(course_id, teachable_lecture_id)`**

```js
db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lectures_teachable
    ON course_lectures(course_id, teachable_lecture_id)
`).run();
```

- [ ] **Step 1.7: Add unique index on `course_sections(course_id, title)`**

```js
db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_course_title
    ON course_sections(course_id, title)
`).run();
```

- [ ] **Step 1.8: Verification — schema applied cleanly**

Run from the worktree root:

```bash
node --check server/db.js && node -e "
import('./server/db.js').then(({getDb}) => {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(course_lectures)').all().map(c => c.name);
  console.log('teachable_lecture_id present:', cols.includes('teachable_lecture_id'));
  console.log('removed_at present:', cols.includes('removed_at'));
  const idx = db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'\").all();
  console.log('indexes:', idx.map(i => i.name));
  const nullCount = db.prepare('SELECT COUNT(*) AS n FROM course_lectures WHERE teachable_lecture_id IS NULL').get().n;
  console.log('rows with NULL teachable_lecture_id:', nullCount);
  const sample = db.prepare('SELECT id, course_id, title, teachable_lecture_id FROM course_lectures WHERE course_id = 26 ORDER BY id').all();
  console.log('course 26 sample:');
  console.table(sample);
});
"
```

Expected output:
- `teachable_lecture_id present: true`
- `removed_at present: true`
- `indexes:` includes `idx_lectures_teachable` and `idx_sections_course_title`
- `rows with NULL teachable_lecture_id: 0`
- Course 26 sample shows `teachable_lecture_id` populated with values like `65369679`, `65162754`, etc. (the trailing numeric segment of each lecture URL)

- [ ] **Step 1.9: Verification — duplicate-insert refused by unique index**

```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  const db = getDb();
  const r = db.prepare('SELECT id, course_id, teachable_lecture_id FROM course_lectures WHERE course_id = 26 LIMIT 1').get();
  try {
    db.prepare('INSERT INTO course_lectures (course_id, teachable_lecture_id, title, url, position, scraped_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.course_id, r.teachable_lecture_id, 'dupe', 'x', 0, '2026-05-10');
    console.log('PROBLEM: duplicate insert succeeded');
    process.exit(1);
  } catch (e) {
    console.log('OK: duplicate refused with:', e.message);
  }
});
"
```

Expected: `OK: duplicate refused with: UNIQUE constraint failed: course_lectures.course_id, course_lectures.teachable_lecture_id`

- [ ] **Step 1.10: Commit**

```bash
git add server/db.js
git commit -m "Add teachable_lecture_id and removed_at columns with idempotent backfill"
```

---

## Task 2: Scraper upsert refactor

**Branch (worktree):** continue on `feature+phase-3.1-schema` after T1 reviews complete, OR fresh `feature+phase-3.1-upsert` worktree branched from T1 (subagent-driven-development decides per its rules).

**Files:**
- Modify: `server/scraper.js` (DOM extraction around line 258, INSERT block around lines 323–352)

**Goal:** Extract `teachable_lecture_id` from each lecture URL during DOM scraping; replace the `DELETE + INSERT` block with stage-and-upsert (sections by `(course_id, title)`, lectures by `(course_id, teachable_lecture_id)`); add a soft-delete pass for missing lectures.

**Out of scope for T2** (handled in T3): skip-known optimization, `forceRefresh` parameter, force-refresh chunk-delete path.

- [ ] **Step 2.1: Add `teachableLectureId` extraction in the DOM-evaluate function**

Locate the `lectureLinks.forEach(link => { … })` block (around server/scraper.js:258). Inside the `if (href && href.includes('/lectures/'))` branch, after the `durMatch` line and before `lectures.push(...)`, add:

```js
const teachableLectureIdMatch = href.match(/\/lectures\/(\d+)/);
if (!teachableLectureIdMatch) return; // defensive; href.includes('/lectures/') already passed
const teachableLectureId = teachableLectureIdMatch[1];
```

Then add `teachableLectureId` to the pushed object:

```js
lectures.push({
    title: cleanTitle,
    url: href,
    duration: durMatch ? (durMatch[1] || durMatch[2]) : null,
    classNumber: classNumMatch ? classNumMatch[1] : null,
    teachableLectureId,
});
```

- [ ] **Step 2.2: Replace the section DELETE + INSERT with upsert**

Locate `db.prepare('DELETE FROM course_sections WHERE course_id = ?').run(courseId);` (around line 324). Replace it AND the subsequent section-insertion logic. Find the existing section loop (around line 339):

```js
for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    if (section.title && PROMO_TITLES.has(section.title)) continue;
    const secResult = db.prepare(
        'INSERT INTO course_sections (course_id, title, position) VALUES (?, ?, ?)'
    ).run(courseId, section.title, si);
    const sectionId = secResult.lastInsertRowid;
    // ... lecture loop ...
}
```

Change to:

```js
const sectionUpsert = db.prepare(`
    INSERT INTO course_sections (course_id, title, position)
    VALUES (?, ?, ?)
    ON CONFLICT(course_id, title) DO UPDATE SET position = excluded.position
    RETURNING id
`);
for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    if (section.title && PROMO_TITLES.has(section.title)) continue;
    const { id: sectionId } = sectionUpsert.get(courseId, section.title, si);
    // ... lecture loop (changes in Step 2.3) ...
}
```

Remove the two `DELETE` statements at the top of the block:

```js
// DELETE these two lines:
db.prepare('DELETE FROM course_sections WHERE course_id = ?').run(courseId);
db.prepare('DELETE FROM course_lectures WHERE course_id = ?').run(courseId);
```

- [ ] **Step 2.3: Replace lecture INSERT with upsert; collect seen IDs**

Inside the section loop, locate the existing lecture INSERT (around line 351):

```js
const lectureResult = db.prepare(
    'INSERT INTO course_lectures (course_id, section_id, title, url, duration, position, scraped_at, class_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
).run(courseId, sectionId, lecture.title, lecture.url, lecture.duration, li, new Date().toISOString(), lecture.classNumber ?? null);
const lectureId = lectureResult.lastInsertRowid;
```

Change to upsert. **Important:** Hoist the prepared statement and the `seenLectureIds` Set above the section loop so they're created once per scrape.

Above the section loop (where `sectionUpsert` was hoisted in step 2.2), add:

```js
const lectureUpsert = db.prepare(`
    INSERT INTO course_lectures (
        course_id, section_id, teachable_lecture_id,
        title, url, duration, position, scraped_at, class_number,
        video_url, video_provider, notion_url, removed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(course_id, teachable_lecture_id) DO UPDATE SET
        section_id     = excluded.section_id,
        title          = excluded.title,
        url            = excluded.url,
        duration       = excluded.duration,
        position       = excluded.position,
        scraped_at     = excluded.scraped_at,
        class_number   = excluded.class_number,
        video_url      = COALESCE(excluded.video_url, course_lectures.video_url),
        video_provider = COALESCE(excluded.video_provider, course_lectures.video_provider),
        notion_url     = COALESCE(excluded.notion_url, course_lectures.notion_url),
        removed_at     = NULL
    RETURNING id
`);
const seenLectureIds = new Set();
```

The `COALESCE(excluded.video_url, course_lectures.video_url)` pattern matters: T2 doesn't yet skip the per-lecture page fetch (that's T3), so `video_url`/`video_provider`/`notion_url` are populated fresh from the per-lecture extraction below the upsert. The COALESCE is defensive — ensures that if the per-lecture extraction temporarily returns NULL (e.g., a Hotmart iframe didn't render in time), the existing populated value isn't wiped. Same for `notion_url`.

The upsert deliberately does NOT include `video_local_path`, `video_duration_sec`, or `video_downloaded_at` — those are owned by `archive-videos.js` and must survive re-scrapes untouched.

Replace the original INSERT with the upsert call:

```js
const { id: lectureId } = lectureUpsert.get(
    courseId,
    sectionId,
    lecture.teachableLectureId,
    lecture.title,
    lecture.url,
    lecture.duration,
    li,
    new Date().toISOString(),
    lecture.classNumber ?? null,
    null, // video_url — populated by per-lecture page fetch below if found
    null, // video_provider — same
    null  // notion_url — same
);
seenLectureIds.add(lecture.teachableLectureId);
```

The per-lecture page-fetch logic that currently UPDATEs `video_url`/`video_provider`/`notion_url` (look for the existing `UPDATE course_lectures SET video_url = ?` statement around the per-lecture loop) stays as-is. T2 does not change per-lecture page fetching.

- [ ] **Step 2.4: Soft-delete pass for lectures missing from the scrape**

After the outer section loop completes and before the final `UPDATE courses SET lecture_count` statement (around server/scraper.js:498):

```js
// Phase 3.1: Soft-delete lectures that are no longer in Teachable.
if (seenLectureIds.size === 0) {
    throw new Error(
        `Scrape returned 0 lectures for course ${courseId} — refusing to soft-delete the entire course (likely auth or DOM-extraction issue)`
    );
}
const seenIds = [...seenLectureIds];
const placeholders = seenIds.map(() => '?').join(',');
const softDeleteSql = `
    UPDATE course_lectures
    SET removed_at = ?
    WHERE course_id = ?
      AND teachable_lecture_id NOT IN (${placeholders})
      AND removed_at IS NULL
`;
const softDeleteResult = db.prepare(softDeleteSql).run(
    new Date().toISOString(),
    courseId,
    ...seenIds
);
if (softDeleteResult.changes > 0) {
    onProgress(`  ⓘ Soft-deleted ${softDeleteResult.changes} lectures no longer in Teachable`, null);
}
```

- [ ] **Step 2.5: Update lecture-count tally to exclude soft-deleted rows**

The existing `UPDATE courses SET lecture_count = ?` query just below counts ALL rows. Adjust to count only active lectures:

```js
const finalCount = db.prepare(
    'SELECT COUNT(*) as count FROM course_lectures WHERE course_id = ? AND removed_at IS NULL'
).get(courseId);
db.prepare('UPDATE courses SET lecture_count = ? WHERE id = ?')
    .run(finalCount.count, courseId);
```

- [ ] **Step 2.6: Verification — re-scrape course 26 preserves video archives**

Pre-condition: Course 26 has 6 lectures, 4 with downloaded videos at `courses/26/lectures/{2177,2179,2180,2181}/video.mp4`.

Capture the pre-scrape state:

```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  const db = getDb();
  const before = db.prepare('SELECT id, title, video_local_path, video_duration_sec FROM course_lectures WHERE course_id = 26 ORDER BY id').all();
  console.log('BEFORE:'); console.table(before);
  globalThis._before = before;
});
"
```

Re-scrape course 26:

```bash
node -e "
import('./server/scraper.js').then(async ({scrapeCourse}) => {
  const result = await scrapeCourse('https://future-fiction-academy.teachable.com/courses/enrolled/2946745', (m, p) => console.log(\`[\${p ?? '--'}%] \${m}\`));
  console.log('result:', result);
});
"
```

Capture post-scrape state and compare:

```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  const db = getDb();
  const after = db.prepare('SELECT id, title, video_local_path, video_duration_sec FROM course_lectures WHERE course_id = 26 ORDER BY id').all();
  console.log('AFTER:'); console.table(after);
});
"
```

Expected:
- AFTER table has same 6 rows with same `id` values as BEFORE.
- `video_local_path` and `video_duration_sec` for the 4 archived lectures (2177, 2179, 2180, 2181) match BEFORE exactly.
- No row has `removed_at` set (course content unchanged).

- [ ] **Step 2.7: Verification — `archive-videos -- 26` reports all-archived**

```bash
npm run archive-videos -- 26
```

Expected summary:
```
downloaded:        0
already archived:  4
wrong provider:    2
failed:            0
```

- [ ] **Step 2.8: Verification — soft-delete fires for synthetic missing lecture**

Insert a fake "lecture that won't appear in next scrape":

```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  const db = getDb();
  db.prepare(\"INSERT INTO course_lectures (course_id, teachable_lecture_id, title, url, position, scraped_at) VALUES (26, '99999999', 'FAKE', '/fake', 99, '2026-05-10')\").run();
  console.log('inserted fake; teachable_id=99999999');
});
"
```

Re-scrape course 26 again. Then check:

```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  const r = getDb().prepare(\"SELECT id, title, removed_at FROM course_lectures WHERE teachable_lecture_id = '99999999'\").get();
  console.log(r);
});
"
```

Expected: `removed_at` is set to a recent ISO timestamp; `title` still says `'FAKE'` (not deleted, just marked).

Cleanup:
```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  getDb().prepare(\"DELETE FROM course_lectures WHERE teachable_lecture_id = '99999999'\").run();
  console.log('cleanup done');
});
"
```

- [ ] **Step 2.9: Verification — defensive guard against zero-lecture scrape**

Verify the throw fires on 0 lectures (without actually triggering a real network failure, just by inspecting the code):

```bash
grep -n "refusing to soft-delete" server/scraper.js
```

Expected: one match. (This is a code-presence check; the actual scenario is hard to reproduce safely without breaking the live scraper.)

- [ ] **Step 2.10: Commit**

```bash
git add server/scraper.js
git commit -m "Replace scrape DELETE+INSERT with idempotent upsert; soft-delete missing lectures"
```

---

## Task 3: Skip-known optimization + force-refresh wiring

**Branch (worktree):** continue from T2.

**Files:**
- Modify: `server/scraper.js` (`scrapeCourse` signature + per-lecture loop + chunk-delete path)
- Modify: `server/server.js` (around line 697 — `POST /api/courses/scrape`)

**Goal:** Skip the per-lecture Puppeteer navigation when the lecture is already known. Add `--force-refresh` escape hatch threaded from API → `scrapeCourse`. Ensure a force-refresh deletes existing chunks before regenerating to avoid duplicates.

- [ ] **Step 3.1: Update `scrapeCourse` signature**

Locate `export async function scrapeCourse(courseUrl, onProgress = () => { }) {` (around line 197). Change to:

```js
export async function scrapeCourse(courseUrl, onProgress = () => { }, options = {}) {
    const { forceRefresh = false } = options;
```

- [ ] **Step 3.2: Build `knownIds` set before the section loop**

Just inside the `try` block, after `courseId` is known but before the section loop, add:

```js
// Phase 3.1: Pre-load known teachable_lecture_id values so we can skip
// per-lecture page fetches for unchanged content (unless --force-refresh).
const knownIds = new Set(
    db.prepare(
        'SELECT teachable_lecture_id FROM course_lectures WHERE course_id = ? AND teachable_lecture_id IS NOT NULL AND removed_at IS NULL'
    ).all(courseId).map(r => r.teachable_lecture_id)
);
if (forceRefresh) {
    onProgress(`  ⓘ force-refresh enabled; will re-fetch all ${knownIds.size} known lectures`, null);
}
```

The `removed_at IS NULL` filter ensures previously soft-deleted lectures (now reappeared) are NOT skipped — they get a fresh fetch.

- [ ] **Step 3.3: Gate the per-lecture page-fetch logic**

Locate the per-lecture page navigation inside the lecture loop. Before the `await page.goto(...)` for the lecture page, add the skip-check:

```js
const isKnown = knownIds.has(lecture.teachableLectureId);
if (isKnown && !forceRefresh) {
    // Skip per-lecture Puppeteer navigation; the upsert above already refreshed
    // title/position/section_id/scraped_at. Keep existing chunks and video_* metadata.
    scraped++;
    continue;
}
```

Insert this **after** the `lectureUpsert.get(...)` call from T2 Step 2.3 — the upsert refreshes the lightweight metadata regardless; only the expensive per-lecture page fetch is gated.

- [ ] **Step 3.4: Force-refresh path — delete existing chunks before regenerating**

In the existing chunk-insertion block (around server/scraper.js:481–488):

```js
if (textContent && textContent.length > 10) {
    const chunks = chunkText(textContent);
    const ins = db.prepare(
        'INSERT INTO course_chunks (lecture_id, content, position) VALUES (?, ?, ?)'
    );
    for (let ci = 0; ci < chunks.length; ci++) {
        ins.run(lectureId, chunks[ci], ci);
    }
}
```

Prepend a delete that runs whenever this block runs (i.e., for new lectures and force-refresh):

```js
if (textContent && textContent.length > 10) {
    // For new lectures this is a no-op; for force-refresh it clears stale chunks.
    db.prepare('DELETE FROM course_chunks WHERE lecture_id = ?').run(lectureId);
    const chunks = chunkText(textContent);
    const ins = db.prepare(
        'INSERT INTO course_chunks (lecture_id, content, position) VALUES (?, ?, ?)'
    );
    for (let ci = 0; ci < chunks.length; ci++) {
        ins.run(lectureId, chunks[ci], ci);
    }
}
```

Note: T3 changes the per-lecture loop entry, but the chunk block stays inside the same `if (!isKnown || forceRefresh)` path — it never runs for skipped lectures because the loop `continue`s before reaching it.

- [ ] **Step 3.5: HTTP API accepts `forceRefresh` body field**

Open `server/server.js`. Locate `app.post('/api/courses/scrape', async (req, res) => {` (around line 697). Change:

```js
const { url } = req.body;
```

to:

```js
const { url, forceRefresh = false } = req.body;
```

And change the `scrapeCourse` call:

```js
const result = await scrapeCourse(url, (message, pct) => { ... });
```

to:

```js
const result = await scrapeCourse(url, (message, pct) => { ... }, { forceRefresh });
```

- [ ] **Step 3.6: Verification — re-scrape course 26 fast path (skip-known)**

```bash
time node -e "
import('./server/scraper.js').then(async ({scrapeCourse}) => {
  await scrapeCourse('https://future-fiction-academy.teachable.com/courses/enrolled/2946745', (m, p) => console.log(\`[\${p ?? '--'}%] \${m}\`));
});
"
```

Expected:
- Wall-clock total < 30 sec (was ~33 sec on the full re-scrape under T2; T3 should drop this further by skipping per-lecture pages).
- Progress messages should NOT include per-lecture "Scraping: <title>" lines beyond the listing-page initial extraction.
- Course 26 lectures all preserved, `video_local_path` intact (re-verify with the BEFORE/AFTER check from T2 Step 2.6).

- [ ] **Step 3.7: Verification — force-refresh path**

```bash
node -e "
import('./server/scraper.js').then(async ({scrapeCourse}) => {
  await scrapeCourse('https://future-fiction-academy.teachable.com/courses/enrolled/2946745', (m, p) => console.log(\`[\${p ?? '--'}%] \${m}\`), { forceRefresh: true });
});
"
```

Expected:
- Progress messages include per-lecture "Scraping: <title>" for each non-PROMO lecture.
- Wall-clock similar to a full re-scrape (~30+ sec).
- `course_chunks` rows for course 26 still have content; row count per lecture unchanged or refreshed (no duplicates).

Verify no duplicate chunks:

```bash
node -e "
import('./server/db.js').then(({getDb}) => {
  const r = getDb().prepare(\`
    SELECT cl.id AS lecture_id, cl.title, COUNT(cc.id) AS chunk_count
    FROM course_lectures cl LEFT JOIN course_chunks cc ON cc.lecture_id = cl.id
    WHERE cl.course_id = 26 GROUP BY cl.id ORDER BY cl.id
  \`).all();
  console.table(r);
});
"
```

Expected: chunk counts match the pre-force-refresh state (or differ only because Teachable transcripts changed, which is the intended detection).

- [ ] **Step 3.8: Verification — HTTP API forceRefresh**

```bash
node server/server.js &
SERVER_PID=$!
sleep 2
curl -s -X POST http://localhost:8080/api/courses/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://future-fiction-academy.teachable.com/courses/enrolled/2946745","forceRefresh":true}' \
  -N | head -20
kill $SERVER_PID 2>/dev/null
```

Expected: SSE stream emits per-lecture "Scraping: <title>" progress (force-refresh path active).

A second request without `forceRefresh`:

```bash
node server/server.js &
SERVER_PID=$!
sleep 2
curl -s -X POST http://localhost:8080/api/courses/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://future-fiction-academy.teachable.com/courses/enrolled/2946745"}' \
  -N | head -20
kill $SERVER_PID 2>/dev/null
```

Expected: SSE stream finishes quickly without per-lecture messages (skip-known active by default).

- [ ] **Step 3.9: Commit**

```bash
git add server/scraper.js server/server.js
git commit -m "Add skip-known fast path and forceRefresh option to scrapeCourse"
```

---

## Final review (holistic)

After T1, T2, T3 implementer + reviewer cycles complete, dispatch one **final code review** subagent across the full diff vs `main`. Same pattern as Phase 3's final review: the reviewer takes the spec ([feature-plan_v5.md](feature-plan_local-course-archive_v5.md)) plus the diff and reports:

- Spec coverage gaps (any v5 requirement not implemented)
- Important issues (correctness bugs, broken invariants, data-loss risks)
- Notable issues (clarity, edge cases, minor contract violations)
- Polish items (naming, comments, micro-DRY)

Resolve **Important** and **Notable** before merge; **Polish** items roll into a follow-up.

---

## Acceptance criteria

Phase 3.1 is done when ALL of these hold:

1. **Migration applies cleanly on the existing DB** — no rows with NULL `teachable_lecture_id` after backfill; both indexes present; no destructive change to existing data.
2. **Re-scraping course 26** preserves all 6 lecture row IDs, all 4 `video_local_path` values, all 4 `video_duration_sec` values, and all 4 `video_downloaded_at` values. `archive-videos -- 26` reports `4 already archived`.
3. **Skip-known fast path** completes a re-scrape of course 26 in under 30 seconds without making per-lecture page navigations.
4. **Force-refresh path** re-fetches all per-lecture pages and rebuilds `course_chunks` without producing duplicates.
5. **Soft-delete behavior** — synthetic "missing" lecture gets `removed_at` set; real lectures untouched.
6. **HTTP API** accepts `forceRefresh` body field and threads it through.
7. **No regressions** — `npm run archive-videos -- 26` and `npm run archive-videos -- 39` (when 39's provider is set) still work as in Phase 3.
8. **`node --check` clean on all modified files**; no new npm dependencies; no test-suite addition (per project convention).

---

## Self-review (against [feature-plan_v5.md](feature-plan_local-course-archive_v5.md))

Spec coverage check:

| v5 spec section | Covered by |
|---|---|
| Schema: `teachable_lecture_id`, `removed_at`, two indexes | T1 Steps 1.2, 1.3, 1.6, 1.7 |
| Backfill from `url` | T1 Steps 1.4, 1.5 |
| DOM extraction of `teachable_lecture_id` | T2 Step 2.1 |
| Listing-stage skip-known | T3 Steps 3.2, 3.3 |
| Stage-and-upsert sections | T2 Step 2.2 |
| Stage-and-upsert lectures (with COALESCE on video_url/provider/notion_url) | T2 Step 2.3 |
| Soft-delete pass + zero-lecture guard | T2 Step 2.4 |
| Active-only lecture_count | T2 Step 2.5 |
| Transcript chunk handling (delete-before-insert in force-refresh path) | T3 Step 3.4 |
| `forceRefresh` parameter threading through `scrapeCourse` | T3 Step 3.1 |
| HTTP API `forceRefresh` body field | T3 Step 3.5 |
| Verification plan steps | T1 Steps 1.8–1.9, T2 Steps 2.6–2.9, T3 Steps 3.6–3.8, Acceptance Criteria block |

No gaps detected. No placeholder steps. Type and method names consistent across tasks (`teachableLectureId` in JS, `teachable_lecture_id` in SQL, `forceRefresh` in JS, `forceRefresh` in API body).
