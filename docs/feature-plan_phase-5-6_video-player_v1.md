# Feature plan — Phase 5/6: In-app video player + click-to-seek timestamps

**Date:** 2026-05-12
**Status:** Approved by author (user away; reasonable defaults documented inline)
**Predecessor:** Phase 4 — Electronize (merged to main, commit `d6c3556`)
**Driver:** Original session-1 ask: *"I want to be able to jump from a transcript time mark to the video for that time."* Phase 4 made the desktop app shippable; Phase 5/6 closes the loop on the core transcript ↔ video connection.

## Goal

When viewing a course lecture in the app:

1. A video player appears at the top of the lecture detail view, playing the lecture's archived video file (the one(s) downloaded by `archive-videos`).
2. Multi-video lectures (e.g., FFA Software Support Class Episodes with 3–4 videos each) show tabs above the player to switch between them.
3. Every `[HH:MM:SS]` or `[MM:SS]` timestamp in the transcript text becomes a clickable link. Clicking it seeks the currently-displayed video to that time and starts playback.

Out of scope for v1: timestamp ↔ scroll sync (highlight the current paragraph as the video plays); position persistence across visits; keyboard shortcuts; multi-video stacked layout.

## Locked decisions (defaults chosen in user's absence)

| Question | Decision | Reason |
|---|---|---|
| Player position | Inline, at top of `.transcript-detail`, above the existing `.detail-content` | Aligns with most learning platforms; keeps transcript scroll independent |
| Multi-video UX | Tabs above the player (one video shown at a time) | Simpler than stacked; matches FFA's own embed pattern |
| Auto-play on timestamp click | Yes — `video.currentTime = N; video.play()` | "Jump to that moment" implies playback |
| Auto-play on page load | No — player loads paused | User controls when to start |
| Mute on load | No — system default | Same |
| Click-to-seek target | The currently-displayed video (the active tab) | Each video has its own internal timeline; cross-video seek doesn't make sense |
| Timestamp format support | `[HH:MM:SS]` and `[MM:SS]` (and `[H:MM:SS]` for short videos) | Covers existing transcript artifacts |
| Position persistence | No | Defer; premature for v1 |
| Highlight active paragraph | No | Defer; needs more design |
| Player size | Full content width, 16:9 aspect via CSS | Standard |
| Range request chunk size | Browser-driven (no server-side cap) | Standard HTML5 video behavior |
| Auth on video endpoint | Same session model as the rest of the API (Express session via cookies) | No new auth surface |
| Streaming endpoint shape | `GET /api/courses/lectures/:id/video/:filename` with HTTP Range support | RESTful; filename allows switching between video.mp4 / video_2.mp4 |
| Video listing endpoint | `GET /api/courses/lectures/:id/videos` returns `[{file, sizeBytes, durationSec}]` | Frontend uses this to render tabs |
| Behavior when no video archived | Player hidden; transcript shown as-is | Don't show a broken element |

## Architecture

### Phase 5 — Streaming backend (`server/server.js`)

Two new endpoints. Both check session via `hasSession()` (same as existing endpoints).

**`GET /api/courses/lectures/:id/videos`**

Returns the list of video files available for this lecture, derived from `course_lectures.video_local_paths` (the JSON array added in Phase 4d) with stat() to confirm each file exists on disk.

Response shape:
```json
[
  { "file": "video.mp4",   "sizeBytes": 81920000, "durationSec": 1832 },
  { "file": "video_2.mp4", "sizeBytes": 45670000, "durationSec": 982 }
]
```

Returns `[]` for lectures with no archived video (frontend hides the player).

**`GET /api/courses/lectures/:id/video/:filename`**

Streams a specific video file. Handles HTTP `Range` headers correctly:

- No `Range` → `200 OK`, full file streamed, `Content-Length` set
- `Range: bytes=START-` → `206 Partial Content`, `Content-Range: bytes START-END/TOTAL`, `Content-Length` set to chunk size
- `Range: bytes=START-END` → same as above with explicit end
- Always sets `Accept-Ranges: bytes` and `Content-Type: video/mp4`
- Validates `:filename` against the lecture's `video_local_paths` array — only filenames listed there are served (prevents path traversal)

**Path validation:** filename must match `^video(_\d+)?\.mp4$` regex AND be present in the row's `video_local_paths` JSON array. Reject anything else with `404` (so the endpoint can't be used to read arbitrary files).

### Phase 6 — Player + click-to-seek (`src/main.js`, `src/index.html`, `src/style.css`)

`renderTranscriptDetail()` already injects timestamps as `<span class="timestamp">[HH:MM:SS]</span>`. Change two things:

1. **Pre-render fetch:** if `transcript.result_type === 'course'`, fetch `/api/courses/lectures/<id>/videos` before rendering. Cache the result on the transcript object as `transcript.videos`.

2. **HTML structure injected at top of `el.transcriptDetail`:**

```html
<div class="lecture-player-wrap">
  <div class="lecture-player-tabs">                <!-- only shown if videos.length > 1 -->
    <button class="lecture-player-tab active" data-file="video.mp4">Video 1</button>
    <button class="lecture-player-tab"        data-file="video_2.mp4">Video 2</button>
  </div>
  <video id="lecture-player" controls preload="metadata"
         src="/api/courses/lectures/123/video/video.mp4">
  </video>
</div>
```

When `videos.length === 0`, the whole wrap is omitted.

3. **Timestamp transformation:** change the existing regex from a `<span>` to a clickable `<a>`:

```js
content = content.replace(
    /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g,
    (match, p1, p2, p3) => {
        // [MM:SS] → p3 undefined → seconds = p1*60 + p2
        // [HH:MM:SS] → p3 defined → seconds = p1*3600 + p2*60 + p3
        const seconds = p3 != null
            ? Number(p1) * 3600 + Number(p2) * 60 + Number(p3)
            : Number(p1) * 60 + Number(p2);
        return `<a class="timestamp-link" data-seconds="${seconds}" href="#">${match}</a>`;
    }
);
```

4. **Event delegation on `.detail-content`:**

```js
el.transcriptDetail.addEventListener('click', (e) => {
    const link = e.target.closest('.timestamp-link');
    if (!link) return;
    e.preventDefault();
    const player = document.getElementById('lecture-player');
    if (!player) return;
    const seconds = Number(link.dataset.seconds);
    if (!Number.isFinite(seconds)) return;
    player.currentTime = seconds;
    player.play().catch(() => { /* user-gesture policy may reject; ignore */ });
});
```

5. **Tab click delegation:**

```js
el.transcriptDetail.addEventListener('click', (e) => {
    const tab = e.target.closest('.lecture-player-tab');
    if (!tab) return;
    const file = tab.dataset.file;
    if (!file) return;
    const player = document.getElementById('lecture-player');
    if (!player) return;
    const lectureId = player.dataset.lectureId;
    player.src = `/api/courses/lectures/${lectureId}/video/${encodeURIComponent(file)}`;
    player.dataset.activeFile = file;
    el.transcriptDetail.querySelectorAll('.lecture-player-tab').forEach(t => {
        t.classList.toggle('active', t === tab);
    });
});
```

### CSS

```css
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
    padding: 0.35rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    color: var(--text-secondary);
    font-size: 0.82rem;
    cursor: pointer;
}
.lecture-player-tab:hover { background: var(--bg-hover); }
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
}
.timestamp-link {
    color: var(--accent-primary);
    text-decoration: none;
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--accent-glow);
    cursor: pointer;
    transition: background 0.15s;
}
.timestamp-link:hover {
    background: var(--accent-glow-strong);
    color: var(--accent-light);
    text-decoration: none;
}
```

The existing `.timestamp` class still applies for chunks rendered outside the click-to-seek context (legacy / non-course transcripts where there's no video) — leave it alone; the new `.timestamp-link` class supersedes it only for `result_type === 'course'` chunks.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| HTTP Range parsing bugs cause video to fail to play | Use standard pattern: `fs.statSync` → parse `Range: bytes=` header → `fs.createReadStream(path, { start, end })`. Set `Content-Range`, `Content-Length`, status 206. Well-trodden territory; many open-source examples (eg express-range-request). |
| Path traversal via `:filename` param | Only allow filenames matching `^video(_\d+)?\.mp4$` AND that exist in the lecture row's `video_local_paths` JSON array. |
| `.mp4` files in non-streamable formats (e.g., MOV-in-mp4-container with `moov` atom at end) | Phase 3 / 3.1's ffmpeg call uses `-c copy -f mp4`, which produces a streamable mp4 (moov at start). Verified during Phase 3 verification. |
| Browser blocks `video.play()` due to autoplay policy | `play().catch(() => {})` swallows the rejection. User can click play manually if needed. In Electron, `webPreferences.autoplayPolicy: 'no-user-gesture-required'` could be set, but defer — current behavior is acceptable. |
| `video.src =` change mid-playback loses position | Each video has its own timeline; switching tabs means switching videos, so position is expected to reset. Document in the tab label or accept. |
| Range request for a not-yet-fully-downloaded file (race during archive) | The endpoint stat()s the file at request time and uses live file size for `Content-Length`. If a download is in progress, the browser would request bytes past EOF and get a 416. Acceptable — user can refresh after archive completes. |

## Verification plan

1. **Backend smoke test:**
   - `curl -I http://127.0.0.1:3001/api/courses/lectures/<id>/video/video.mp4` returns 200 + `Accept-Ranges: bytes` + `Content-Type: video/mp4`
   - `curl -H 'Range: bytes=0-99' http://127.0.0.1:3001/api/courses/lectures/<id>/video/video.mp4 -o /tmp/chunk.bin -D /tmp/headers.txt` returns 206 + `Content-Range: bytes 0-99/<TOTAL>` and `/tmp/chunk.bin` is 100 bytes
   - Path traversal attempt (`../../../../etc/passwd`) returns 404
   - Filename not in `video_local_paths` returns 404
2. **Video list endpoint:**
   - `curl http://127.0.0.1:3001/api/courses/lectures/<id>/videos` returns the array; multi-video lectures show all entries; lectures with no archive return `[]`
3. **Frontend:**
   - Open a course lecture with an archived video → player appears, plays via controls
   - Multi-video lecture → tabs appear, switching tabs swaps `src` and resets playback
   - Click a `[00:04:32]` timestamp in the transcript → video seeks and starts playing at 4m32s
   - Lecture with no archived video → no player, transcript shown normally
4. **Packaged app:**
   - Same flow in the signed `.dmg`-installed app — verify file:// vs http://127.0.0.1:<port> doesn't break anything (server runs on loopback in Electron; player loads via http loopback URL, which is fine)

## Implementation order

1. **Phase 5 first** — backend endpoints + curl-tested
2. **Phase 6 second** — frontend wiring; tested in browser dev mode
3. **Rebuild .dmg** — `npm run dist:electron:mac`; verify in packaged app

Single PR after both phases pass verification. Same Phase 4 merge pattern.

## Estimate

| Sub-phase | Wall-clock |
|---|---|
| Phase 5 (streaming + listing endpoints, curl tests) | ~1 hour |
| Phase 6 (player markup + JS wiring + CSS) | ~1.5 hours |
| Rebuild .dmg + verify in packaged app | ~30 min |
| **Total** | **~3 hours** |

## Out of scope (Phase 7+ later)

- Timestamp ↔ scroll sync: highlight the current transcript paragraph as the video plays; auto-scroll the transcript pane to keep the active paragraph in view.
- Playback position persistence: remember where each lecture was paused, restore on revisit.
- Notion archiver: the original Phase 4 spec's deferred Notion offline-snapshot feature.
- Search results: when a search hit is in a course lecture with a video, auto-seek the player to the timestamp closest to the highlighted text.
- Speed controls beyond browser default (1.0x, 1.25x, 1.5x, 2.0x).
- Keyboard shortcuts (space, J/K/L, arrow keys).

These would each be small focused PRs after Phase 5/6 lands.
