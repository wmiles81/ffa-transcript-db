# Phase 5/6 Implementation Plan — Video Player + Click-to-Seek

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline video player on lecture detail view (with tabs for multi-video lectures), and clickable `[HH:MM:SS]` / `[MM:SS]` timestamps in transcript that seek the active player and start playback.

**Architecture:** Two new Express endpoints (`/api/courses/lectures/:id/videos` list + `/api/courses/lectures/:id/video/:filename` range-streamed) backed by the existing `course_lectures.video_local_paths` JSON array (Phase 4d). Frontend renders a `<video>` element + optional tab strip inline at the top of the lecture detail view. The existing timestamp-wrapping regex in `renderTranscriptDetail()` upgraded from `<span class="timestamp">` to `<a class="timestamp-link" data-seconds="N">`, with event-delegated click handler that seeks the player.

**Tech Stack:** Node 22 ESM, Express 4 (existing), `fs.createReadStream` for range responses, HTML5 `<video>` element, vanilla JS, no new dependencies.

**Predecessor docs:**
- Spec: [docs/feature-plan_phase-5-6_video-player_v1.md](feature-plan_phase-5-6_video-player_v1.md)
- Phase 4 (merged): in-app archive flow, multi-video support, `video_local_paths` JSON column

**Workflow note:** No test suite by design. Each task gets implementer subagent → spec compliance review → code quality review per the Phase 3.1 / 4 pattern.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/server.js` | Modify | Add `GET /api/courses/lectures/:id/videos` (list) and `GET /api/courses/lectures/:id/video/:filename` (range-streamed). Both protected by `hasSession()`. Filename validated against the lecture's `video_local_paths` JSON array. |
| `src/main.js` | Modify | In `renderTranscriptDetail()`: pre-fetch the videos list when `result_type === 'course'`, render `<video>` + tabs above `.detail-content`, change timestamp regex to produce `<a class="timestamp-link">`, attach event-delegated click handlers (one for timestamp seek, one for tab switching). |
| `src/index.html` | No change | Container `#transcript-detail` already exists; player markup is injected by JS. |
| `src/style.css` | Modify | Add styles for `.lecture-player-wrap`, `.lecture-player-tabs`, `.lecture-player-tab`, `#lecture-player`, `.timestamp-link`. |

**No schema changes.** Phase 4d's `video_local_paths` column carries the data already.

---

## Task 1: Backend — videos list endpoint

**Branch (worktree):** `feature/phase-5-6-video-player`

**Files:**
- Modify: `server/server.js` (add a new GET route)

**Goal:** New endpoint that returns the list of video files for a given course lecture, derived from `course_lectures.video_local_paths`, with size and duration where available.

- [ ] **Step 1.1: Read existing endpoint conventions in `server/server.js`**

Skim the existing `GET /api/courses/lectures/:id` endpoint (around line 720) for shape and session-check pattern. Identify where in the file the courses-related endpoints live — new endpoint goes adjacent (before or after the existing `/api/courses/lectures/:id` route).

- [ ] **Step 1.2: Add the videos list endpoint**

Insert this endpoint into `server/server.js` immediately after the existing `GET /api/courses/lectures/:id` endpoint:

```js
// Phase 5: GET /api/courses/lectures/:id/videos
// Returns the list of archived video files for a lecture.
// Response: [{ file, sizeBytes, durationSec }]
app.get('/api/courses/lectures/:id/videos', async (req, res) => {
    const db = getDb();
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId) || lectureId <= 0) {
        return res.status(400).json({ error: 'Invalid lecture id' });
    }
    const lecture = db.prepare(
        'SELECT id, video_local_paths, video_duration_sec FROM course_lectures WHERE id = ?'
    ).get(lectureId);
    if (!lecture) {
        return res.status(404).json({ error: 'Lecture not found' });
    }

    let paths = [];
    if (lecture.video_local_paths) {
        try { paths = JSON.parse(lecture.video_local_paths); }
        catch { paths = []; }
    }
    if (!Array.isArray(paths)) paths = [];

    const { resolveRelative } = await import('./media-library.js');
    const results = [];
    for (const relPath of paths) {
        try {
            const abs = resolveRelative(relPath);
            const stat = fs.statSync(abs);
            const file = path.basename(relPath);
            results.push({
                file,
                sizeBytes: stat.size,
                // For now we only know the AGGREGATE duration across all videos.
                // If exactly one video, use it; otherwise return null and let the
                // frontend display the player's own duration once loaded.
                durationSec: (paths.length === 1) ? lecture.video_duration_sec : null,
            });
        } catch {
            // file missing on disk — skip; frontend will see fewer entries than expected
        }
    }
    res.json(results);
});
```

Notes:
- Uses `path.basename(relPath)` so the filename is just `video.mp4` / `video_2.mp4` (no directory components leaked into the response)
- Returns `[]` for lectures with no archived video — frontend hides the player
- Dynamic-imports `resolveRelative` since `media-library.js` is ESM-only and the existing server uses ESM imports at module top (verify `fs` and `path` are already imported at the top of `server/server.js` — they are)

- [ ] **Step 1.3: Verification**

```bash
node --check server/server.js
```

Then start the server fresh and curl with a known archived lecture id (lecture 2177 is course 26's "Overview"; lecture 1923 is course 39's archived video):

```bash
# Kill any existing server
lsof -ti :3001 | xargs kill 2>/dev/null
node server/server.js &
SERVER_PID=$!
sleep 2

# Single-video lecture (course 26, lecture 2177)
curl -s http://127.0.0.1:3001/api/courses/lectures/2177/videos
echo

# Lecture with no archive (any non-archived lecture, e.g., 2178)
curl -s http://127.0.0.1:3001/api/courses/lectures/2178/videos
echo

# Multi-video lecture in the user's packaged-app DB (lecture id varies — for the worktree, course 26's 2177 is single)
# Just confirm response shape

# Invalid id
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/courses/lectures/abc/videos
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/courses/lectures/9999999/videos

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected:
- `/api/courses/lectures/2177/videos` → `[{"file":"video.mp4","sizeBytes":1316032,"durationSec":65}]` (or similar — exact size from the on-disk file)
- `/api/courses/lectures/2178/videos` → `[]`
- Invalid id → `400`
- Missing id → `404`

- [ ] **Step 1.4: Commit**

```bash
git add server/server.js
git commit -m "Add GET /api/courses/lectures/:id/videos endpoint"
```

---

## Task 2: Backend — range-capable video streaming endpoint

**Files:**
- Modify: `server/server.js` (add a new GET route immediately after Task 1's)

**Goal:** Stream a specific video file with HTTP `Range` support so HTML5 `<video>` can seek correctly. Filename validated against the lecture's `video_local_paths` array (prevents path traversal).

- [ ] **Step 2.1: Add the streaming endpoint**

Insert immediately after the videos-list endpoint from Task 1:

```js
// Phase 5: GET /api/courses/lectures/:id/video/:filename
// Streams a specific archived video file with HTTP Range support.
// Filename must match /^video(_\d+)?\.mp4$/ AND be present in the lecture's
// video_local_paths JSON array (defense in depth against path traversal).
app.get('/api/courses/lectures/:id/video/:filename', async (req, res) => {
    const db = getDb();
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId) || lectureId <= 0) {
        return res.status(400).json({ error: 'Invalid lecture id' });
    }
    const filename = req.params.filename;
    if (!/^video(_\d+)?\.mp4$/.test(filename)) {
        return res.status(404).end();
    }

    const lecture = db.prepare(
        'SELECT video_local_paths FROM course_lectures WHERE id = ?'
    ).get(lectureId);
    if (!lecture || !lecture.video_local_paths) {
        return res.status(404).end();
    }

    let paths = [];
    try { paths = JSON.parse(lecture.video_local_paths); } catch { /* */ }
    if (!Array.isArray(paths)) paths = [];

    // The filename must match the BASENAME of one of the recorded paths
    const matched = paths.find(p => path.basename(p) === filename);
    if (!matched) {
        return res.status(404).end();
    }

    const { resolveRelative } = await import('./media-library.js');
    let absPath;
    try {
        absPath = resolveRelative(matched);
    } catch {
        return res.status(404).end();
    }

    let stat;
    try { stat = fs.statSync(absPath); }
    catch { return res.status(404).end(); }

    const total = stat.size;
    const range = req.headers.range;

    if (!range) {
        // Full file — 200 OK
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(absPath).pipe(res);
        return;
    }

    // Parse "Range: bytes=START-END" (END optional)
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
        return res.status(416).end();
    }
    const start = Number(m[1]);
    let end = m[2] === '' ? total - 1 : Number(m[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.end();
    }

    res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
});
```

- [ ] **Step 2.2: Verification — basic streaming**

```bash
lsof -ti :3001 | xargs kill 2>/dev/null
node server/server.js &
SERVER_PID=$!
sleep 2

# Full GET (no Range) — should return 200, full content-length
curl -sI http://127.0.0.1:3001/api/courses/lectures/2177/video/video.mp4 | head -8

# Range request for first 99 bytes — should return 206, Content-Length 100, Content-Range
curl -s -o /tmp/chunk.bin -D /tmp/headers.txt -H 'Range: bytes=0-99' \
    http://127.0.0.1:3001/api/courses/lectures/2177/video/video.mp4
echo "--- chunk size ---"
ls -l /tmp/chunk.bin
echo "--- headers ---"
cat /tmp/headers.txt

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected:
- First HEAD: `HTTP/1.1 200 OK`, `Accept-Ranges: bytes`, `Content-Type: video/mp4`, `Content-Length: 1316032` (or whatever the actual file size is)
- Range request: `/tmp/chunk.bin` is exactly 100 bytes; headers show `HTTP/1.1 206 Partial Content`, `Content-Range: bytes 0-99/1316032`, `Content-Length: 100`

- [ ] **Step 2.3: Verification — path traversal blocked**

```bash
lsof -ti :3001 | xargs kill 2>/dev/null
node server/server.js &
SERVER_PID=$!
sleep 2

# Path traversal attempts
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3001/api/courses/lectures/2177/video/..%2F..%2F..%2Fetc%2Fpasswd"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3001/api/courses/lectures/2177/video/../../../etc/passwd"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3001/api/courses/lectures/2177/video/notvideo.txt"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3001/api/courses/lectures/2177/video/video.mp4.bak"

# Filename matches pattern but isn't in the lecture's path list
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3001/api/courses/lectures/2177/video/video_99.mp4"

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: all five return `404`.

- [ ] **Step 2.4: Verification — invalid range**

```bash
lsof -ti :3001 | xargs kill 2>/dev/null
node server/server.js &
SERVER_PID=$!
sleep 2

# Range beyond EOF
curl -s -o /dev/null -w "%{http_code}\n" -H 'Range: bytes=99999999-' http://127.0.0.1:3001/api/courses/lectures/2177/video/video.mp4

# Malformed
curl -s -o /dev/null -w "%{http_code}\n" -H 'Range: chars=0-99' http://127.0.0.1:3001/api/courses/lectures/2177/video/video.mp4

kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: `416` (beyond EOF) and `416` (malformed unit).

- [ ] **Step 2.5: Commit**

```bash
git add server/server.js
git commit -m "Add range-capable video streaming endpoint with path-traversal protection"
```

---

## Task 3: Frontend — render player, tabs, and timestamp links

**Files:**
- Modify: `src/main.js` — update `renderTranscriptDetail()`, add `fetchLectureVideos` helper, attach click delegation
- Modify: `src/style.css` — add player + timestamp-link styles

**Goal:** When the lecture detail view renders for a course lecture, fetch the videos list, inject a `<video>` element (with tabs if multi-video) above the transcript, and convert existing timestamp spans into clickable links that seek the player.

- [ ] **Step 3.1: Add helper to fetch videos list**

Near the top of `src/main.js` (after the existing `api()` helper), add:

```js
// Phase 5/6: fetch the video list for a course lecture
async function fetchLectureVideos(lectureId) {
    try {
        return await api(`/api/courses/lectures/${lectureId}/videos`);
    } catch {
        return [];
    }
}
```

- [ ] **Step 3.2: Update `loadTranscriptDetail()` to pre-fetch videos for course lectures**

Find `loadTranscriptDetail(id, highlightQuery)` (around line 326 of `src/main.js`). Modify it so when `result_type === 'course'`, the videos list is fetched and attached to the transcript object BEFORE calling `renderTranscriptDetail`.

The existing function:
```js
async function loadTranscriptDetail(id, highlightQuery) {
    // ... existing fetch logic that ends with:
    renderTranscriptDetail(transcript, highlightQuery);
}
```

Change the call to `renderTranscriptDetail` to:
```js
let videos = [];
const isCourseLecture = id && String(id).startsWith('clec-');
if (isCourseLecture) {
    const lectureId = String(id).replace('clec-', '');
    videos = await fetchLectureVideos(lectureId);
    transcript.lectureId = lectureId;
    transcript.videos = videos;
}
renderTranscriptDetail(transcript, highlightQuery);
```

Find both call sites of `renderTranscriptDetail` (search for `renderTranscriptDetail(` — there should be two: one in the cached-not-found-fallback branch around line 334, and the primary one at line 349). Wrap both with the same videos-pre-fetch logic, OR factor it out:

```js
// Extract this just before the render calls:
let videos = [];
const isCourseLecture = id && String(id).startsWith('clec-');
if (isCourseLecture) {
    const lectureId = String(id).replace('clec-', '');
    try { videos = await fetchLectureVideos(lectureId); } catch {}
}
```

Then before each `renderTranscriptDetail(...)`:
```js
if (isCourseLecture) {
    transcript.lectureId = String(id).replace('clec-', '');
    transcript.videos = videos;
}
renderTranscriptDetail(transcript, highlightQuery);
```

- [ ] **Step 3.3: Update timestamp regex in `renderTranscriptDetail`**

Find the existing timestamp regex (currently produces `<span class="timestamp">`):

```js
// Highlight timestamps
content = content.replace(
    /\[(\d{2}:\d{2}:\d{2})\]/g,
    '<span class="timestamp">[$1]</span>'
);
```

Replace with a regex that handles both `[HH:MM:SS]` and `[MM:SS]` and produces an `<a class="timestamp-link">`:

```js
// Phase 6: clickable timestamps — supports [HH:MM:SS] and [MM:SS] (and [H:MM:SS])
const hasPlayer = transcript.videos && transcript.videos.length > 0;
content = content.replace(
    /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g,
    (match, p1, p2, p3) => {
        const seconds = p3 != null
            ? Number(p1) * 3600 + Number(p2) * 60 + Number(p3)
            : Number(p1) * 60 + Number(p2);
        if (!hasPlayer) {
            // No video available — keep the legacy span styling
            return `<span class="timestamp">${match}</span>`;
        }
        return `<a class="timestamp-link" data-seconds="${seconds}" href="#" title="Seek to ${match}">${match}</a>`;
    }
);
```

- [ ] **Step 3.4: Inject the player markup at the top of the rendered HTML**

In `renderTranscriptDetail()`, locate the `el.transcriptDetail.innerHTML = \`...\`;` block (around line 1375). The existing structure is:

```js
el.transcriptDetail.innerHTML = `
<div class="detail-header">...</div>
<div class="detail-content">${content}</div>
`;
```

Build a `playerHtml` string just before this block and inject it between header and content:

```js
let playerHtml = '';
if (transcript.videos && transcript.videos.length > 0 && transcript.lectureId) {
    const tabs = transcript.videos.length > 1
        ? `<div class="lecture-player-tabs">${transcript.videos.map((v, i) =>
            `<button class="lecture-player-tab${i === 0 ? ' active' : ''}" data-file="${escapeHtml(v.file)}">Video ${i + 1}</button>`
          ).join('')}</div>`
        : '';
    const firstFile = transcript.videos[0].file;
    playerHtml = `
        <div class="lecture-player-wrap">
            ${tabs}
            <video id="lecture-player"
                   controls preload="metadata"
                   data-lecture-id="${escapeHtml(String(transcript.lectureId))}"
                   data-active-file="${escapeHtml(firstFile)}"
                   src="/api/courses/lectures/${encodeURIComponent(transcript.lectureId)}/video/${encodeURIComponent(firstFile)}">
            </video>
        </div>
    `;
}

el.transcriptDetail.innerHTML = `
    <div class="detail-header">...existing header markup unchanged...</div>
    ${playerHtml}
    <div class="detail-content">${content}</div>
`;
```

(Keep the existing detail-header content verbatim — only the playerHtml insertion is new.)

- [ ] **Step 3.5: Attach event delegation for tab clicks + timestamp seeks**

In `renderTranscriptDetail()`, AFTER the `innerHTML =` assignment and after any existing `.set-notion-btn` wiring, attach two delegated handlers:

```js
// Phase 6: timestamp-link click → seek + play the active video
const player = el.transcriptDetail.querySelector('#lecture-player');
if (player) {
    el.transcriptDetail.querySelectorAll('.timestamp-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const seconds = Number(link.dataset.seconds);
            if (!Number.isFinite(seconds)) return;
            player.currentTime = seconds;
            player.play().catch(() => { /* autoplay policy may reject — ignore */ });
        });
    });

    // Phase 6: tab clicks → switch player src
    el.transcriptDetail.querySelectorAll('.lecture-player-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const file = tab.dataset.file;
            if (!file) return;
            const lectureId = player.dataset.lectureId;
            player.src = `/api/courses/lectures/${encodeURIComponent(lectureId)}/video/${encodeURIComponent(file)}`;
            player.dataset.activeFile = file;
            el.transcriptDetail.querySelectorAll('.lecture-player-tab').forEach(t =>
                t.classList.toggle('active', t === tab)
            );
        });
    });
}
```

- [ ] **Step 3.6: Add CSS in `src/style.css`**

Append to the end of `src/style.css`:

```css
/* Phase 5/6: Inline video player on lecture detail view */
.lecture-player-wrap {
    margin: 0 0 1.25rem;
    width: 100%;
}
.lecture-player-tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 0.4rem;
}
.lecture-player-tab {
    padding: 0.4rem 0.85rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    color: var(--text-secondary);
    font-size: 0.82rem;
    cursor: pointer;
    font-family: var(--font-sans);
}
.lecture-player-tab:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
}
.lecture-player-tab.active {
    background: var(--accent-glow);
    color: var(--accent-light);
    border-color: var(--accent-primary);
}
#lecture-player {
    width: 100%;
    aspect-ratio: 16 / 9;
    background: black;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    display: block;
}
.timestamp-link {
    color: var(--accent-primary);
    text-decoration: none;
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--accent-glow);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
.timestamp-link:hover {
    background: var(--accent-glow-strong);
    color: var(--accent-light);
    text-decoration: none;
}
```

The existing `.timestamp` style remains untouched — used when `transcript.videos.length === 0`.

- [ ] **Step 3.7: Verification — build cleanly**

```bash
node --check src/main.js
npm run build
```

Expected: no warnings; new bundle filename.

- [ ] **Step 3.8: Verification — manual browser smoke test**

```bash
lsof -ti :3001 | xargs kill 2>/dev/null
node server/server.js &
SERVER_PID=$!
sleep 2
echo "Server up at http://127.0.0.1:3001"
echo "Manual checks (run from main repo dist/, which has 5 archived lectures):"
echo "  1. Open browser, hard-refresh"
echo "  2. Click into course 26 (💡LAN: How to Bulk Create with Canva)"
echo "  3. Click any of the 4 archived lectures (Overview, Video Walk-Through, TikTok Slides, Instagram Reels)"
echo "     → Player should appear at top of detail view"
echo "     → Click play; video should start"
echo "     → If transcript has [HH:MM:SS] timestamps, they should be amber/clickable"
echo "     → Click a timestamp; video should seek + play from there"
echo "  4. Click into a non-archived lecture (e.g., Notes & Transcripts / Other Post Types)"
echo "     → No player; transcript shown normally"
echo "press enter to kill server..."
read
kill $SERVER_PID
```

- [ ] **Step 3.9: Commit**

```bash
git add src/main.js src/style.css
git commit -m "Add inline video player + clickable timestamps on lecture detail view"
```

---

## Task 4: Rebuild signed .dmg

**Files:** none modified

**Goal:** Produce a fresh signed `.dmg` with the Phase 5/6 changes so the user can install + test in the packaged Electron app.

- [ ] **Step 4.1: Run electron-builder**

```bash
npm run dist:electron:mac 2>&1 | tail -10
```

Expected output ends with:
```
• signing  file=_dist/mac-arm64/FFA Transcript Database.app
• building target=DMG arch=arm64 file=_dist/FFA Transcript Database-2.1.0-arm64.dmg
```

Takes 3-5 minutes.

- [ ] **Step 4.2: Verify the signature on the new build**

```bash
ls -lh _dist/*.dmg
hdiutil attach "_dist/FFA Transcript Database-2.1.0-arm64.dmg" -nobrowse -readonly 2>&1 | tail -2
MOUNT=$(ls -d "/Volumes/FFA Transcript Database"* 2>/dev/null | head -1)
codesign --verify --verbose=2 "$MOUNT/FFA Transcript Database.app" 2>&1
codesign --display --verbose=4 "$MOUNT/FFA Transcript Database.app" 2>&1 | grep -E "Identifier|Authority|TeamIdentifier" | head -5
hdiutil detach "$MOUNT" 2>&1 | tail -1
```

Expected:
- `valid on disk` and `satisfies its Designated Requirement`
- `Identifier=com.gunnmilesllc.ffa-transcript-db`
- `Authority=Developer ID Application: WILLIAM MILES (76R466YDPC)`
- `TeamIdentifier=76R466YDPC`

- [ ] **Step 4.3: Document install instructions**

No commit needed for this step — the `.dmg` is a build artifact, not a tracked file. Just note for the report:

```
.dmg path: _dist/FFA Transcript Database-2.1.0-arm64.dmg
To install: open the .dmg, drag the .app to /Applications (replace), then right-click → Open the first time.
```

---

## Acceptance Criteria

Phase 5/6 is done when ALL of these hold:

1. `GET /api/courses/lectures/:id/videos` returns the correct list shape and uses on-disk file sizes
2. `GET /api/courses/lectures/:id/video/:filename` with NO range returns 200 + full file
3. Same endpoint with `Range: bytes=0-99` returns 206 + 100-byte chunk + correct Content-Range header
4. Same endpoint with invalid filename or path-traversal attempts returns 404
5. Same endpoint with out-of-range bytes returns 416
6. Frontend: course lecture detail view shows a player when the lecture has archived video(s)
7. Single-video lectures show no tab strip; multi-video lectures show "Video 1", "Video 2", etc. tabs
8. Timestamp text like `[00:04:32]` in the transcript is rendered as a clickable amber link
9. Clicking a timestamp seeks the player to that second and starts playback (no errors in console)
10. Switching tabs on a multi-video lecture changes the player's `src` correctly
11. Lecture without an archived video shows no player and renders the transcript as before
12. Signed `.dmg` rebuilds cleanly and passes `codesign --verify`

---

## Self-review against spec

| Spec requirement | Plan task |
|---|---|
| `GET /api/courses/lectures/:id/videos` endpoint | Task 1 |
| `GET /api/courses/lectures/:id/video/:filename` with Range support | Task 2 |
| Path-traversal protection (filename regex + array membership check) | Task 2 Step 2.1 |
| Player markup injected above transcript | Task 3 Step 3.4 |
| Tabs for multi-video lectures | Task 3 Step 3.4, 3.5 |
| Timestamp regex supports `[HH:MM:SS]` and `[MM:SS]` | Task 3 Step 3.3 |
| Click-to-seek + autoplay | Task 3 Step 3.5 |
| Tab click switches player src | Task 3 Step 3.5 |
| Legacy `.timestamp` style preserved for non-video lectures | Task 3 Step 3.3 (fallback span) |
| CSS for player, tabs, timestamp-link | Task 3 Step 3.6 |
| Rebuild signed .dmg | Task 4 |

No spec gaps. No placeholders in the plan. Variable/function names consistent: `fetchLectureVideos`, `transcript.videos`, `transcript.lectureId`, `data-seconds`, `data-lecture-id`, `data-file`, `data-active-file`.
