# Phase 4b Implementation Plan — UI Integration of CLI Flows

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the remaining terminal-only flows by exposing `archive-videos` as an HTTP+SSE endpoint, surfacing it as an "Archive Videos" button in the course detail UI with a live progress modal, adding a force-refresh checkbox to the scrape modal, and showing an in-app banner when ffmpeg is missing.

**Architecture:** Refactor `server/archive-videos.js` into a thin CLI wrapper around a new `server/archive-orchestrator.js` module that exposes `archiveCourseVideos(courseId, { force?, signal, onProgress })` returning the summary. The same function backs a new `POST /api/courses/:id/archive-videos` SSE endpoint (with `DELETE` for cancel via AbortController). A `GET /api/system/ffmpeg` endpoint reports availability. Frontend gets an Archive button on course detail and a progress modal that consumes the SSE stream.

**Tech Stack:** Node.js 22 ESM, Express 4 (existing SSE pattern from `/api/courses/scrape`), AbortController/AbortSignal (Node 18+), vanilla JS frontend with `EventSource` or `fetch + ReadableStream` for SSE. No new dependencies.

**Predecessor docs:**
- Spec: [docs/feature-plan_phase-4_electronize_v2.md](feature-plan_phase-4_electronize_v2.md) (Phase 4b section)
- Phase 4a: `server.js` exports `startServer()`; DATA_DIR honored; electron/main.cjs created (verification deferred pending Apple Developer cert)

**Testable without Electron.** All 4b work runs under `npm run dev` (browser + Node) — once Apple signing lands, the same code runs unchanged inside the Electron window.

**Workflow note:** Same as Phase 3.1 — implementer subagent + spec-compliance review + code-quality review per task. No test suite by design; verification via direct invocation + browser smoke tests.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/archive-orchestrator.js` | Create | `archiveCourseVideos(courseId, { force, signal, onProgress })` — the single source of truth for per-lecture orchestration. Returns the summary object. |
| `server/archive-videos.js` | Modify | Becomes a thin CLI wrapper that calls `archiveCourseVideos()` and prints to stdout. SIGINT handling translates to AbortController. |
| `server/server.js` | Modify | Add `POST /api/courses/:id/archive-videos` (SSE), `DELETE /api/courses/:id/archive-videos` (cancel), `GET /api/system/ffmpeg`. |
| `src/main.js` | Modify | Add force-refresh checkbox handling in scrape modal; add Archive button + progress modal on course detail view; consume SSE stream. |
| `src/index.html` | Modify | Add modal markup for the archive-progress dialog; add the force-refresh checkbox to the scrape modal markup; add the ffmpeg banner placeholder. |
| `src/style.css` | Modify | Styles for the archive progress modal + ffmpeg banner. |

**Total: 1 new file, 5 modified.** No deletions. No new dependencies.

---

## Task 1: Backend — orchestrator + endpoints

**Goal:** Extract the archive orchestration from `server/archive-videos.js` into a reusable module, then expose it via HTTP with SSE progress + AbortController cancel. CLI keeps working as a thin wrapper.

**Files:**
- Create: `server/archive-orchestrator.js`
- Modify: `server/archive-videos.js` (becomes thin CLI wrapper)
- Modify: `server/server.js` (add 3 endpoints)

### Step 1.1: Read existing archive-videos.js end-to-end

Before writing anything, read the entire current `server/archive-videos.js` (about 200 lines). Understand:
- The dynamic-import pattern (`MEDIA_LIBRARY_AUTOENSURE='0'` set before any import)
- The SIGINT handler that sets `interrupted = true`
- The per-lecture loop with `downloadLectureVideo()` calls and tally tracking
- The summary print at the end

Identify what's CLI-specific (console.log, process.exit, SIGINT, argv parsing) vs what's domain logic (per-lecture iteration, tally counting, abort checks).

### Step 1.2: Create `server/archive-orchestrator.js`

```js
// Phase 4b: Single source of truth for per-course video archive orchestration.
// Called by both the archive-videos CLI and the POST /api/courses/:id/archive-videos
// HTTP endpoint. Progress is reported via the onProgress callback; cancellation
// is via an AbortSignal (so HTTP DELETE and Ctrl-C use the same mechanism).

import { spawn } from 'child_process';
import { downloadLectureVideo } from './media-downloader.js';
import { ensureMediaLibraryExists } from './media-library.js';
import { VIDEO_PROVIDERS, isValidProvider } from './media-providers.js';
import { getDb } from './db.js';

export async function checkFfmpeg() {
    return new Promise((resolve) => {
        const ff = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        ff.stdout.on('data', (d) => { out += d.toString(); });
        ff.on('error', () => resolve({ ok: false }));
        ff.on('close', () => {
            const firstLine = out.split('\n')[0] || 'ffmpeg (version unknown)';
            resolve({ ok: true, version: firstLine.trim() });
        });
    });
}

/**
 * Archive every Hotmart-hosted lecture in a course.
 *
 * @param {number} courseId
 * @param {object} opts
 * @param {boolean} [opts.force=false]            — Re-download even if video_local_path already set
 * @param {AbortSignal} [opts.signal]             — Cancel mid-run (cooperative; checked between lectures)
 * @param {(event: object) => void} [opts.onProgress] — Event emitter. Events:
 *   { type: 'preflight', ok, error?, version? }
 *   { type: 'course', courseId, title, total }
 *   { type: 'lecture', index, total, lectureId, title, classNumber, status: 'start' | 'downloading' | 'done' | 'skipped' | 'error', detail? }
 *   { type: 'summary', downloaded, alreadyArchived, wrongProvider, failed, elapsedMs }
 * @returns {Promise<{summary, interrupted}>}
 */
export async function archiveCourseVideos(courseId, opts = {}) {
    const { force = false, signal, onProgress = () => {} } = opts;
    const startedAt = Date.now();

    const ffmpeg = await checkFfmpeg();
    onProgress({ type: 'preflight', ok: ffmpeg.ok, version: ffmpeg.version, error: ffmpeg.ok ? null : 'ffmpeg not found on PATH' });
    if (!ffmpeg.ok) {
        return { summary: null, interrupted: false, error: 'ffmpeg not found' };
    }

    const db = getDb();

    // Validate provider values in DB (warn on unknowns; doesn't abort)
    const rows = db.prepare(
        'SELECT DISTINCT video_provider FROM course_lectures WHERE video_provider IS NOT NULL'
    ).all();
    for (const { video_provider } of rows) {
        if (!isValidProvider(video_provider)) {
            onProgress({ type: 'warning', message: `Unknown video_provider in DB: '${video_provider}' (rows will be skipped)` });
        }
    }

    const course = db.prepare('SELECT id, title FROM courses WHERE id = ?').get(courseId);
    if (!course) {
        return { summary: null, interrupted: false, error: `No course found with id ${courseId}` };
    }

    const lectures = db.prepare(
        'SELECT * FROM course_lectures WHERE course_id = ? AND (removed_at IS NULL OR removed_at = \'\') ORDER BY position'
    ).all(courseId);

    onProgress({ type: 'course', courseId: course.id, title: course.title, total: lectures.length });

    ensureMediaLibraryExists();

    const tally = { downloaded: 0, alreadyArchived: 0, wrongProvider: 0, failed: 0 };
    let interrupted = false;

    for (let i = 0; i < lectures.length; i++) {
        if (signal?.aborted) { interrupted = true; break; }
        const lecture = lectures[i];
        const baseEvent = {
            type: 'lecture',
            index: i + 1,
            total: lectures.length,
            lectureId: lecture.id,
            title: lecture.title,
            classNumber: lecture.class_number || null,
        };

        onProgress({ ...baseEvent, status: 'start' });

        if (lecture.video_provider === VIDEO_PROVIDERS.HOTMART) {
            try {
                const result = await downloadLectureVideo(lecture, {
                    force,
                    onProgress: (msg) => onProgress({ ...baseEvent, status: 'downloading', detail: msg }),
                });
                if (result.ok) {
                    tally.downloaded++;
                    onProgress({ ...baseEvent, status: 'done', sizeBytes: result.sizeBytes, durationSec: result.durationSec });
                } else if (result.skipped) {
                    if (result.reason === 'already archived') tally.alreadyArchived++;
                    else tally.wrongProvider++;
                    onProgress({ ...baseEvent, status: 'skipped', detail: result.reason });
                } else if (result.error) {
                    tally.failed++;
                    onProgress({ ...baseEvent, status: 'error', detail: result.error });
                }
            } catch (err) {
                tally.failed++;
                onProgress({ ...baseEvent, status: 'error', detail: err.message });
            }
        } else {
            tally.wrongProvider++;
            const p = lecture.video_provider == null ? 'null' : lecture.video_provider;
            onProgress({ ...baseEvent, status: 'skipped', detail: `provider ${p} not yet supported` });
        }
    }

    const summary = {
        ...tally,
        elapsedMs: Date.now() - startedAt,
        interrupted,
    };
    onProgress({ type: 'summary', ...summary });
    return { summary, interrupted, error: null };
}
```

Note: this assumes `downloadLectureVideo()` accepts a `force` option. Read [server/media-downloader.js](../server/media-downloader.js) to confirm. If it doesn't, T1 needs to extend it (one-line change — pass `force` through to the existing-file check). Don't speculate; verify by reading the file.

### Step 1.3: Refactor `server/archive-videos.js` into a thin CLI wrapper

Replace the entire body of `main()` and the surrounding setup with a thin wrapper:

```js
process.env.MEDIA_LIBRARY_AUTOENSURE = '0';

const { archiveCourseVideos } = await import('./archive-orchestrator.js');
const { closeDb } = await import('./db.js');

function parseArgs(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log('Usage: node server/archive-videos.js <courseId> [--force]');
        process.exit(2);
    }
    const courseId = Number(args[0]);
    if (!Number.isInteger(courseId) || courseId <= 0) {
        console.log('Usage: node server/archive-videos.js <courseId> [--force]');
        process.exit(2);
    }
    const force = args.includes('--force');
    return { courseId, force };
}

function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return '?:??';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
    if (!bytes || !Number.isFinite(bytes)) return '? MB';
    return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

async function main() {
    const { courseId, force } = parseArgs(process.argv);

    const controller = new AbortController();
    let interruptCount = 0;
    process.on('SIGINT', () => {
        interruptCount++;
        if (interruptCount === 1) {
            console.log('\n⚠ Interrupt received — finishing current operation, please wait...');
            controller.abort();
        } else {
            process.exit(130);
        }
    });

    const onProgress = (event) => {
        switch (event.type) {
            case 'preflight':
                if (event.ok) console.log(event.version);
                else console.error(`❌ ${event.error}. Install with: brew install ffmpeg`);
                break;
            case 'warning':
                console.log(`⚠ ${event.message}`);
                break;
            case 'course':
                console.log(`Course: ${event.title} (id ${event.courseId})`);
                console.log(`Lectures: ${event.total}`);
                console.log('');
                break;
            case 'lecture':
                if (event.status === 'start') {
                    const classNum = event.classNumber ? `L${event.classNumber} — ` : '';
                    console.log(`[${event.index} of ${event.total}] ${classNum}${event.title}`);
                } else if (event.status === 'downloading') {
                    console.log(`  → ${event.detail}`);
                } else if (event.status === 'done') {
                    console.log(`  ✓ Downloaded (${formatSize(event.sizeBytes)}, ${formatDuration(event.durationSec)})`);
                } else if (event.status === 'skipped') {
                    console.log(`  · Skipped (${event.detail})`);
                } else if (event.status === 'error') {
                    console.log(`  ✗ Failed: ${event.detail}`);
                }
                break;
            case 'summary':
                console.log('');
                console.log('— Summary —');
                console.log(`  downloaded:        ${event.downloaded}`);
                console.log(`  already archived:  ${event.alreadyArchived}`);
                console.log(`  wrong provider:    ${event.wrongProvider}`);
                console.log(`  failed:            ${event.failed}`);
                console.log(`  elapsed:           ${formatElapsed(event.elapsedMs)}`);
                if (event.interrupted) console.log('  (interrupted by Ctrl-C)');
                break;
        }
    };

    const { error } = await archiveCourseVideos(courseId, { force, signal: controller.signal, onProgress });
    closeDb();
    process.exit(error ? 1 : (controller.signal.aborted ? 130 : 0));
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
```

This preserves the exact CLI behavior (same output lines, exit codes, SIGINT pattern) while delegating logic to the orchestrator.

### Step 1.4: Add HTTP endpoints in `server/server.js`

After the existing scrape SSE endpoint (around line 717), add:

```js
// Phase 4b: GET /api/system/ffmpeg — report ffmpeg availability for UI pre-flight
import { checkFfmpeg, archiveCourseVideos } from './archive-orchestrator.js';

app.get('/api/system/ffmpeg', async (_req, res) => {
    try {
        const r = await checkFfmpeg();
        res.json(r);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Phase 4b: POST /api/courses/:id/archive-videos — SSE stream of archive progress
// Active jobs tracked so DELETE can abort by courseId.
const _activeArchiveJobs = new Map(); // courseId -> AbortController

app.post('/api/courses/:id/archive-videos', async (req, res) => {
    const courseId = Number(req.params.id);
    if (!Number.isInteger(courseId) || courseId <= 0) {
        return res.status(400).json({ error: 'Invalid courseId' });
    }
    const { force = false } = req.body || {};

    if (_activeArchiveJobs.has(courseId)) {
        return res.status(409).json({ error: 'An archive job is already running for this course' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const controller = new AbortController();
    _activeArchiveJobs.set(courseId, controller);

    // If the client disconnects (closes the browser tab), abort the job.
    req.on('close', () => {
        if (_activeArchiveJobs.get(courseId) === controller) {
            controller.abort();
        }
    });

    try {
        const { error } = await archiveCourseVideos(courseId, {
            force,
            signal: controller.signal,
            onProgress: (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            },
        });
        if (error) res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    } finally {
        _activeArchiveJobs.delete(courseId);
        res.end();
    }
});

app.delete('/api/courses/:id/archive-videos', (req, res) => {
    const courseId = Number(req.params.id);
    const controller = _activeArchiveJobs.get(courseId);
    if (!controller) {
        return res.status(404).json({ error: 'No active archive job for this course' });
    }
    controller.abort();
    res.json({ ok: true, courseId });
});
```

Important: the `import { checkFfmpeg, archiveCourseVideos } from './archive-orchestrator.js';` line goes with the other imports at the top of `server/server.js`, not inline. Place it adjacent to the existing `import { scrapeCourse, ... } from './scraper.js';` line.

### Step 1.5: Verification — CLI still works

```bash
node server/archive-videos.js 26 2>&1 | tail -10
```

Expected: prints "Course: 💡LAN: How to Bulk Create with Canva (id 26)", per-lecture status lines, then the summary block ending with `elapsed: 0s` (course 26 is already fully archived, so it's a fast no-op skip-known run).

### Step 1.6: Verification — `--force` flag works

```bash
node server/archive-videos.js 26 --force 2>&1 | tail -5
```

Expected: same summary shape. If `--force` causes redownload, this will take several minutes. If `--force` is a no-op (because the orchestrator doesn't yet thread force through to `downloadLectureVideo`), the summary still shows `already archived: 4`. Note which case fires in your report.

### Step 1.7: Verification — GET ffmpeg endpoint

```bash
node server/server.js &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:3001/api/system/ffmpeg
echo
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: JSON like `{"ok":true,"version":"ffmpeg version 4.4.2 ..."}`.

### Step 1.8: Verification — POST archive-videos SSE

```bash
node server/server.js &
SERVER_PID=$!
sleep 2
curl -s -N -X POST http://127.0.0.1:3001/api/courses/26/archive-videos \
    -H 'Content-Type: application/json' \
    -d '{"force":false}' | head -20
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: SSE event stream with lines like:
```
data: {"type":"preflight","ok":true,"version":"..."}

data: {"type":"course","courseId":26,"title":"...","total":6}

data: {"type":"lecture","index":1,"total":6,"lectureId":2177,"title":"Overview","classNumber":null,"status":"start"}

data: {"type":"lecture","index":1,"total":6,"lectureId":2177,"title":"Overview","classNumber":null,"status":"skipped","detail":"already archived"}

... more lecture events ...

data: {"type":"summary","downloaded":0,"alreadyArchived":4,"wrongProvider":2,"failed":0,"elapsedMs":...,"interrupted":false}

data: {"type":"done"}
```

### Step 1.9: Verification — DELETE cancels an in-flight job

This is harder to test without a long-running job. Skip the full E2E test; instead verify the conflict-detection path:

```bash
node server/server.js &
SERVER_PID=$!
sleep 2
# DELETE without any active job returns 404
curl -s -X DELETE http://127.0.0.1:3001/api/courses/26/archive-videos
echo
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: `{"error":"No active archive job for this course"}`.

### Step 1.10: Commit

```bash
git add server/archive-orchestrator.js server/archive-videos.js server/server.js
git commit -m "Extract archive orchestrator; add SSE archive-videos endpoint and ffmpeg pre-flight"
```

---

## Task 2: Frontend — Archive button + progress modal + force-refresh checkbox + ffmpeg banner

**Goal:** Surface all the new backend capabilities in the UI. Three UX changes: (a) force-refresh checkbox in the scrape modal, (b) Archive Videos button + progress modal on the course detail view, (c) ffmpeg-missing banner.

**Files:**
- Modify: `src/index.html` (add markup for archive modal + ffmpeg banner + force-refresh checkbox)
- Modify: `src/main.js` (event handlers + SSE consumption + cancel)
- Modify: `src/style.css` (modal/banner styles)

### Step 2.1: Read the existing scrape modal markup in src/index.html

```bash
grep -n "scrape-modal\|coursePickerModal\|start-scrape-btn\|course-picker-list" src/index.html | head -20
```

Locate the existing scrape modal block. Identify where to inject the force-refresh checkbox (typically near the `<button id="start-scrape-btn">` element).

### Step 2.2: Add force-refresh checkbox to the scrape modal

In `src/index.html`, inside the scrape modal block — specifically just above the action buttons row — add:

```html
<label class="scrape-modal-option">
    <input type="checkbox" id="scrape-force-refresh" />
    <span>Force re-fetch transcripts (slower; pulls fresh transcripts even for known lectures)</span>
</label>
```

Match the existing indentation and class-naming conventions of the surrounding modal markup. If the existing modal uses different class names like `modal-option` instead of `scrape-modal-option`, follow the established pattern.

### Step 2.3: Wire force-refresh to the existing startScrape() call in src/main.js

Locate `async function startScrape(url, { hideOnDone = true } = {}) {` (around line 1275). Inside, find the `fetch('/api/courses/scrape', ...)` call's body. Currently it sends just `{ url }`. Change it to read the checkbox state:

```js
const forceRefresh = document.getElementById('scrape-force-refresh')?.checked || false;
// ... existing fetch call ...
body: JSON.stringify({ url, forceRefresh }),
```

The existing backend already accepts `forceRefresh` (Phase 3.1 wired it through to `scrapeCourse`), so no backend changes needed here.

After the scrape completes successfully, uncheck the box so it doesn't stay sticky for the next scrape:

```js
const cb = document.getElementById('scrape-force-refresh');
if (cb) cb.checked = false;
```

### Step 2.4: Add the Archive button on course detail view

In `src/index.html`, locate the course detail header area — where the "Re-scrape" button (or equivalent course-level action) sits. Add an "Archive Videos" button adjacent:

```html
<button id="archive-videos-btn" class="course-action-btn" data-course-id="">
    <span class="btn-icon">↓</span>
    Archive Videos
</button>
```

(Match the class names of the existing course-level action buttons. If they use `secondary-btn` or `btn-secondary`, use that.)

### Step 2.5: Add the Archive progress modal markup

In `src/index.html`, near the existing modals block (toward the end of `<body>`), add:

```html
<div id="archive-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="archive-modal-title">
    <div class="modal-backdrop"></div>
    <div class="modal-content archive-modal-content">
        <header class="modal-header">
            <h2 id="archive-modal-title">Archiving Videos</h2>
            <button id="archive-modal-close" class="modal-close" aria-label="Close">×</button>
        </header>
        <div class="modal-body">
            <div id="archive-status-line" class="archive-status-line">Starting…</div>
            <div id="archive-current-lecture" class="archive-current-lecture"></div>
            <div id="archive-progress-bar" class="archive-progress-bar">
                <div id="archive-progress-fill" class="archive-progress-fill"></div>
            </div>
            <ul id="archive-lecture-list" class="archive-lecture-list"></ul>
            <div id="archive-summary" class="archive-summary hidden"></div>
        </div>
        <footer class="modal-footer">
            <button id="archive-cancel-btn" class="danger-btn">Cancel</button>
            <button id="archive-done-btn" class="primary-btn hidden">Done</button>
        </footer>
    </div>
</div>
```

(Match the existing modal HTML structure in the file — class names like `modal`, `modal-backdrop`, `modal-content`, `hidden`, etc. should mirror what's already in use elsewhere in `index.html`.)

### Step 2.6: Add the ffmpeg pre-flight banner markup

At the top of the main content area in `src/index.html` (just inside `<main>` or whatever the equivalent root container is), add:

```html
<div id="ffmpeg-banner" class="ffmpeg-banner hidden">
    <strong>ffmpeg is required to download videos</strong>
    <p>Install via <code>brew install ffmpeg</code> (macOS) or your system package manager. Video archiving is disabled until ffmpeg is available.</p>
    <button id="ffmpeg-banner-recheck" class="secondary-btn">Recheck</button>
</div>
```

### Step 2.7: Add JS handlers in src/main.js — ffmpeg pre-flight on load

Near the existing app-init code (typically at the bottom of `src/main.js`, where `DOMContentLoaded` handlers attach), add:

```js
// Phase 4b: ffmpeg pre-flight banner
async function checkFfmpegAvailability() {
    try {
        const res = await fetch('/api/system/ffmpeg');
        const data = await res.json();
        const banner = document.getElementById('ffmpeg-banner');
        const archiveBtn = document.getElementById('archive-videos-btn');
        if (!data.ok) {
            banner?.classList.remove('hidden');
            if (archiveBtn) archiveBtn.disabled = true;
        } else {
            banner?.classList.add('hidden');
            if (archiveBtn) archiveBtn.disabled = false;
        }
    } catch (err) {
        console.warn('ffmpeg check failed:', err.message);
    }
}
checkFfmpegAvailability();
document.getElementById('ffmpeg-banner-recheck')?.addEventListener('click', checkFfmpegAvailability);
```

### Step 2.8: Add JS handlers — Archive button click → open modal → consume SSE

Add a new function and wire the button:

```js
// Phase 4b: Archive Videos modal handler
async function startArchive(courseId) {
    const modal = document.getElementById('archive-modal');
    const statusLine = document.getElementById('archive-status-line');
    const currentLecture = document.getElementById('archive-current-lecture');
    const progressFill = document.getElementById('archive-progress-fill');
    const lectureList = document.getElementById('archive-lecture-list');
    const summary = document.getElementById('archive-summary');
    const cancelBtn = document.getElementById('archive-cancel-btn');
    const doneBtn = document.getElementById('archive-done-btn');

    // Reset UI
    statusLine.textContent = 'Starting…';
    currentLecture.textContent = '';
    progressFill.style.width = '0%';
    lectureList.innerHTML = '';
    summary.classList.add('hidden');
    summary.textContent = '';
    cancelBtn.classList.remove('hidden');
    doneBtn.classList.add('hidden');
    modal.classList.remove('hidden');

    let total = 0;
    const lectureRows = new Map(); // lectureId -> <li> element

    let aborted = false;
    cancelBtn.onclick = async () => {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling…';
        try {
            await fetch(`/api/courses/${courseId}/archive-videos`, { method: 'DELETE' });
        } catch (err) {
            console.warn('cancel failed:', err.message);
        }
    };

    try {
        const res = await fetch(`/api/courses/${courseId}/archive-videos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: false }),
        });
        if (!res.ok) {
            statusLine.textContent = `Error: ${res.status} ${res.statusText}`;
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE messages are separated by blank lines; each message starts with "data: "
            const messages = buffer.split('\n\n');
            buffer = messages.pop(); // keep incomplete tail

            for (const msg of messages) {
                if (!msg.startsWith('data: ')) continue;
                let event;
                try {
                    event = JSON.parse(msg.slice('data: '.length));
                } catch (e) {
                    continue;
                }

                switch (event.type) {
                    case 'preflight':
                        if (!event.ok) {
                            statusLine.textContent = `ffmpeg unavailable: ${event.error}`;
                            return;
                        }
                        break;
                    case 'course':
                        total = event.total;
                        statusLine.textContent = `Course: ${event.title} — ${total} lectures`;
                        break;
                    case 'lecture': {
                        let li = lectureRows.get(event.lectureId);
                        if (!li) {
                            li = document.createElement('li');
                            li.className = 'archive-lecture-row';
                            li.dataset.lectureId = event.lectureId;
                            lectureList.appendChild(li);
                            lectureRows.set(event.lectureId, li);
                        }
                        if (event.status === 'start') {
                            currentLecture.textContent = `[${event.index}/${total}] ${event.title}`;
                            const pct = ((event.index - 1) / total) * 100;
                            progressFill.style.width = `${pct}%`;
                            li.textContent = `[${event.index}/${total}] ${event.title} — starting…`;
                            li.className = 'archive-lecture-row pending';
                        } else if (event.status === 'downloading') {
                            li.textContent = `[${event.index}/${total}] ${event.title} — ${event.detail}`;
                            li.className = 'archive-lecture-row downloading';
                        } else if (event.status === 'done') {
                            li.textContent = `[${event.index}/${total}] ${event.title} — ✓ downloaded`;
                            li.className = 'archive-lecture-row done';
                        } else if (event.status === 'skipped') {
                            li.textContent = `[${event.index}/${total}] ${event.title} — ${event.detail}`;
                            li.className = 'archive-lecture-row skipped';
                        } else if (event.status === 'error') {
                            li.textContent = `[${event.index}/${total}] ${event.title} — ✗ ${event.detail}`;
                            li.className = 'archive-lecture-row error';
                        }
                        break;
                    }
                    case 'summary': {
                        progressFill.style.width = '100%';
                        summary.classList.remove('hidden');
                        summary.innerHTML = `
                            <h3>Summary</h3>
                            <ul>
                                <li>Downloaded: ${event.downloaded}</li>
                                <li>Already archived: ${event.alreadyArchived}</li>
                                <li>Wrong provider: ${event.wrongProvider}</li>
                                <li>Failed: ${event.failed}</li>
                                <li>Elapsed: ${Math.round(event.elapsedMs / 1000)}s</li>
                                ${event.interrupted ? '<li><em>Cancelled</em></li>' : ''}
                            </ul>
                        `;
                        cancelBtn.classList.add('hidden');
                        doneBtn.classList.remove('hidden');
                        break;
                    }
                    case 'error':
                        statusLine.textContent = `Error: ${event.error}`;
                        cancelBtn.classList.add('hidden');
                        doneBtn.classList.remove('hidden');
                        break;
                    case 'done':
                        // Stream complete
                        break;
                }
            }
        }
    } catch (err) {
        statusLine.textContent = `Connection error: ${err.message}`;
    } finally {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel';
    }
}

document.getElementById('archive-videos-btn')?.addEventListener('click', (e) => {
    const courseId = e.currentTarget.dataset.courseId;
    if (!courseId) return;
    startArchive(Number(courseId));
});

document.getElementById('archive-modal-close')?.addEventListener('click', () => {
    document.getElementById('archive-modal')?.classList.add('hidden');
});
document.getElementById('archive-done-btn')?.addEventListener('click', () => {
    document.getElementById('archive-modal')?.classList.add('hidden');
});
```

The button's `data-course-id` attribute needs to be set whenever the course detail view loads. Find the existing code that renders course detail (search for the existing course-id-related dataset access) and add:

```js
const archiveBtn = document.getElementById('archive-videos-btn');
if (archiveBtn) archiveBtn.dataset.courseId = String(courseId);
```

### Step 2.9: Add CSS in src/style.css

Append:

```css
/* Phase 4b: ffmpeg pre-flight banner */
.ffmpeg-banner {
    background: #fff3cd;
    color: #664d03;
    border-left: 4px solid #ffc107;
    padding: 12px 16px;
    margin: 12px;
    border-radius: 4px;
}
.ffmpeg-banner code {
    background: rgba(0, 0, 0, 0.05);
    padding: 2px 6px;
    border-radius: 3px;
}

/* Phase 4b: Archive videos modal */
.archive-modal-content {
    max-width: 720px;
    width: 90%;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
}
.archive-status-line {
    font-weight: 500;
    margin-bottom: 8px;
}
.archive-current-lecture {
    color: var(--muted, #666);
    font-size: 0.9em;
    margin-bottom: 12px;
    min-height: 1.2em;
}
.archive-progress-bar {
    height: 8px;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 16px;
}
.archive-progress-fill {
    height: 100%;
    background: var(--primary, #2962ff);
    transition: width 0.2s ease-out;
}
.archive-lecture-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    max-height: 40vh;
}
.archive-lecture-row {
    padding: 6px 8px;
    border-radius: 3px;
    font-size: 0.85em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.archive-lecture-row.pending { color: var(--muted, #666); }
.archive-lecture-row.downloading { background: rgba(41, 98, 255, 0.08); }
.archive-lecture-row.done { color: var(--success, #2e7d32); }
.archive-lecture-row.skipped { color: var(--muted, #999); }
.archive-lecture-row.error { background: rgba(244, 67, 54, 0.08); color: var(--danger, #c62828); }
.archive-summary {
    margin-top: 16px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.04);
    border-radius: 4px;
}
.archive-summary h3 { margin-top: 0; }

/* Phase 4b: scrape modal force-refresh checkbox */
.scrape-modal-option {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0;
    font-size: 0.9em;
}
.scrape-modal-option input[type="checkbox"] {
    margin: 0;
}
```

Adjust class/variable names if the existing stylesheet uses different conventions (e.g., `--accent-primary` vs `--primary`). Read the surrounding CSS first.

### Step 2.10: Build and verify in browser

```bash
npm run build
npm run start &
SERVER_PID=$!
sleep 2
echo "Open http://127.0.0.1:3001 in a browser. Verify:"
echo "  1. ffmpeg banner does NOT appear (ffmpeg is installed)"
echo "  2. Scrape modal has the force-refresh checkbox"
echo "  3. Course detail view (open course 26) has an 'Archive Videos' button"
echo "  4. Clicking it opens the progress modal and streams events"
echo "  5. The modal correctly shows '4 already archived' summary for course 26"
echo "(Press Enter to kill the server when done)"
read
kill $SERVER_PID 2>/dev/null
```

Capture screenshots or the JSON event stream from DevTools Network tab if anything looks off. If this is being run by a subagent that can't drive a browser, the subagent should:
- Verify `npm run build` succeeds
- Verify `curl http://127.0.0.1:3001/` returns HTML that contains the new IDs (`archive-videos-btn`, `archive-modal`, `ffmpeg-banner`, `scrape-force-refresh`)
- Verify `curl POST /api/courses/26/archive-videos` SSE stream works (this is T1 territory, but the FE consumes it — confirm one more time end-to-end)

### Step 2.11: Commit

```bash
git add src/index.html src/main.js src/style.css
git commit -m "Add Archive Videos UI: button, SSE progress modal, force-refresh checkbox, ffmpeg banner"
```

---

## Acceptance Criteria for Phase 4b

Phase 4b is done when ALL of these hold:

1. `npm run archive-videos -- <id>` CLI still works with identical output to the pre-refactor version.
2. `npm run archive-videos -- <id> --force` works as a no-op for already-archived lectures (or re-downloads if `downloadLectureVideo` honors `force`).
3. `GET /api/system/ffmpeg` returns `{ok: true, version: "..."}` when ffmpeg is on PATH.
4. `POST /api/courses/:id/archive-videos` streams SSE events (preflight, course, lecture×N, summary, done) for the course's lectures.
5. `DELETE /api/courses/:id/archive-videos` returns 404 when no job is running; returns 200 and aborts when one is active.
6. Concurrent POST for the same course returns 409.
7. The scrape modal has a "Force re-fetch transcripts" checkbox that, when checked, sends `forceRefresh: true` to the backend.
8. The course detail view has an "Archive Videos" button that opens a progress modal.
9. The modal shows per-lecture status (start/downloading/done/skipped/error), a progress bar, and a summary at the end.
10. Cancel button aborts the job; closing the modal does NOT abort the job; closing the browser tab aborts the job (via `req.on('close')`).
11. ffmpeg-missing banner appears at top of UI when `GET /api/system/ffmpeg` returns `{ok: false}`; disappears when ffmpeg is installed (Recheck button verified).
12. `node --check` clean on all modified files; no new npm dependencies.

---

## Out of scope for 4b

These are deferred to 4c, 4d, or a separate phase:

- Bundling ffmpeg via `@ffmpeg-installer/ffmpeg` (Phase 4c)
- `electron-builder` packaging (Phase 4d)
- App icons, About dialog, File menu (Phase 4d)
- Per-lecture retry buttons in the modal
- Resume archive after app restart (would need DB-level job persistence)
- Notion archiver UI (later phase)

---

## Self-Review (against spec section "4b — Move CLI flows into the UI")

| v2 Spec Requirement | Covered by |
|---|---|
| `POST /api/courses/:id/archive-videos` SSE | T1 Step 1.4 |
| `DELETE /api/courses/:id/archive-videos` cancel | T1 Step 1.4 |
| `GET /api/system/ffmpeg` | T1 Step 1.4 |
| Extract orchestrator | T1 Steps 1.2, 1.3 |
| AbortController for cancel | T1 (orchestrator signal threading + DELETE handler) |
| CLI keeps working (thin wrapper) | T1 Step 1.3 |
| Force-refresh checkbox in scrape modal | T2 Steps 2.2, 2.3 |
| Archive Videos button on course detail | T2 Steps 2.4, 2.8 |
| Progress modal with SSE consumption + cancel | T2 Steps 2.5, 2.8 |
| ffmpeg pre-flight banner | T2 Steps 2.6, 2.7 |

No gaps. Names consistent: `archiveCourseVideos`, `checkFfmpeg`, `archive-modal`, `ffmpeg-banner`, `scrape-force-refresh`.
