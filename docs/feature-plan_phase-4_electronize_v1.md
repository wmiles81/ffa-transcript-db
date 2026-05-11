# Feature plan — Phase 4: Electronize (one-click desktop app)

**Date:** 2026-05-11
**Status:** Awaiting approval to start sub-phase 4a
**Predecessor:** [feature-plan_local-course-archive_v4.md](feature-plan_local-course-archive_v4.md) (Phases 1–3), [feature-plan_local-course-archive_v5.md](feature-plan_local-course-archive_v5.md) (Phase 3.1)
**Driver:** "We need this app to run once the user clicks on start. No servers, no 'open terminal and do this'." End users — not developers — should be able to install and use the app without touching Node, npm, ffmpeg, or a terminal.

## Goal

Ship `ffa-transcript-db` as a native desktop app for **Mac, Windows, and Linux**. One installer per platform. Double-click → window opens → everything works.

Concretely:
- Mac: a `.dmg` containing `ffa-transcript-db.app`. Drag to Applications, launch.
- Windows: an `.exe` NSIS installer (or portable `.exe`). Run, install, launch from Start menu.
- Linux: an `.AppImage`. Mark executable, launch.

Inside the app, every operation that today requires a terminal command must be a button or menu item. That includes login, scrape, force-refresh, video archive, and ffmpeg pre-flight messaging.

## Locked decisions

| Question | Decision |
|---|---|
| Desktop framework | **Electron** (`electron` + `electron-builder`) |
| Distribution targets | **Mac, Windows, Linux** (Phase 4d) |
| Code signing / notarization | **Deferred to a later phase** — initial builds run in "unidentified developer" mode; users dismiss the OS warning manually |
| Server architecture | **In-process**: `server/server.js` is imported by Electron's main process and binds Express to `http://127.0.0.1:<dynamic-port>` (loopback only). `BrowserWindow` loads from that URL. Zero refactor of existing routes |
| ffmpeg bundling | **`@ffmpeg-installer/ffmpeg`** — npm package that ships platform-specific binaries; resolved at runtime via the package's exported `path` |
| Puppeteer Chromium bundling | **Project-local cache** — Puppeteer 24 caches Chromium in `~/.cache/puppeteer/` by default, which is outside the project tree and not bundleable. Override with a `.puppeteerrc.cjs` config file that sets `cacheDirectory: path.join(__dirname, '.cache', 'puppeteer')`. The download goes to `<project>/.cache/puppeteer/` and electron-builder bundles it from there |
| SQLite encrypted DB | **Unchanged** — `better-sqlite3-multiple-ciphers` already builds a prebuilt native binary; electron-builder includes it via `nodeGypRebuild: false` + `npmRebuild: true` |
| Frontend bundling | **Existing Vite build** — `npm run build` produces `dist/` which Express already serves at `/`. No additional bundler for the renderer |
| In-app browser context for the renderer | `contextIsolation: true`, `nodeIntegration: false` — the renderer is sandboxed; all backend access goes through the HTTP API on loopback (same as today). No `preload.js` needed for v1 |
| App data location | OS-standard userData dirs via `app.getPath('userData')` — Mac: `~/Library/Application Support/ffa-transcript-db/`; Windows: `%APPDATA%\ffa-transcript-db\`; Linux: `~/.config/ffa-transcript-db/`. The `data/` folder (encrypted DB, cookies, .dbkey, ai-settings) moves there |
| Existing dev workflow | **Preserved** — `npm run dev` (Node server + browser via Vite) keeps working for development. `npm run start:electron` becomes the new "run as desktop app" command |
| Migration of existing user data | **Two paths.** In dev (`npm run start:electron` from the project root): on first launch, if `./data/.dbkey` exists and `userData/data/.dbkey` doesn't, auto-copy the entire `./data/` folder. In packaged mode (no project tree): a **File → Import existing data…** menu item opens a folder picker pointing at the user's old `data/` directory; on confirm, it copies the contents into `userData/data/`. No silent magic across machines |

## What changes, what doesn't

### Unchanged

- `server/db.js`, `server/scraper.js`, `server/media-downloader.js`, `server/media-library.js`, `server/media-providers.js`, `server/import.js` — all stay as ES modules with no changes (except for `data/` path resolution; see below).
- `server/server.js` — keeps Express routes; only change is parameterizing the bind port and not auto-starting (it exports an `async function startServer(port?)` that Electron's main process awaits).
- `server/archive-videos.js` — remains a working CLI for dev/power-user workflows. In 4b, its orchestration is extracted into a library that the new HTTP endpoint also calls.
- `src/main.js`, `src/style.css`, `src/index.html`, `src/help.html` — frontend stays as-is; Vite still bundles to `dist/`.
- All Phase 3.1 invariants — incremental scrape, video archive preservation, soft-delete — survive untouched.

### Changed (high level)

- New entry point `electron/main.cjs` (CommonJS because Electron's main process expects CJS by default; the app's `package.json` is `"type": "module"` so `.cjs` extension is required).
- `server/server.js` exports `startServer(port?)` and `app` (the Express instance) instead of starting on a fixed `8080`.
- `server/db.js` accepts `MEDIA_LIBRARY_PATH` and `DATA_DIR` env vars (existing pattern in code); Electron's main process sets `DATA_DIR=<userData>/data` before importing.
- New scripts in `package.json`: `start:electron`, `dev:electron`, `dist:electron` (replacing the current `dist` zip target with electron-builder).
- New devDependency: `electron`, `electron-builder`. New dependency: `@ffmpeg-installer/ffmpeg`.
- `electron-builder.yml` (or `build` key in package.json) configures per-platform output, icon, app id, etc.
- App icon assets in `build/` (`icon.icns` for Mac, `icon.ico` for Windows, `icon.png` for Linux).

### Removed / superseded

- `start.command`, `start.sh`, `start.bat` — superseded by the native installers. Keep them in the repo for the dev workflow; mark in README as developer-only.
- `npm run dist` zip target — replaced by `npm run dist:electron`.

## Sub-phase decomposition

Phase 4 is too large for a single PR. Decomposed into four sub-phases, each shippable on its own:

| Sub-phase | Scope | Acceptance |
|---|---|---|
| **4a** | Electron scaffolding + in-process server bootstrap | `npm run start:electron` opens a window showing the existing app. Dev workflow (`npm run dev`) still works. No installer yet. |
| **4b** | Move CLI flows into the UI | `archive-videos` exposed as `POST /api/courses/:id/archive-videos` with SSE progress + cancel; UI button + modal. Force-refresh checkbox in the scrape modal. ffmpeg pre-flight surfaced as in-app banner. |
| **4c** | Bundle ffmpeg via `@ffmpeg-installer/ffmpeg` | `media-downloader.js` resolves ffmpeg path from the installer package, falling back to system `ffmpeg` for dev. Bundled binaries verified to work on all three platforms. |
| **4d** | `electron-builder` packaging | Produces `.dmg`, `.exe` NSIS installer, `.AppImage`. App icons. Single-instance lock. About dialog. README updated. |

**4e (later, not in this plan):** code signing + notarization (Mac), authenticode signing (Windows), auto-update.

Each sub-phase gets its own implementation plan and PR. This plan is the architectural spec across all four.

---

## 4a — Electron scaffolding + in-process server bootstrap

### New files

```
electron/main.cjs        # Electron main process entry
build/icon.png           # placeholder icon (1024x1024 PNG); converted to .icns/.ico in 4d
```

### Changes to `server/server.js`

Today, `server.js` runs at module load:

```js
const app = express();
// ...routes...
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
```

Change to:

```js
const app = express();
// ...routes...

export { app };

export async function startServer(port = process.env.PORT || 8080) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => {
            const actualPort = server.address().port;
            console.log(`Listening on http://127.0.0.1:${actualPort}`);
            resolve({ server, port: actualPort });
        });
        server.on('error', reject);
    });
}

// Preserve CLI behavior: when run directly, auto-start on env PORT or 8080.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
    startServer().catch(err => {
        console.error('Server failed to start:', err);
        process.exit(1);
    });
}
```

Two important properties:
- **Loopback bind**: `'127.0.0.1'` — never reachable from another machine. The desktop app's server is process-internal only.
- **Dynamic port**: when port `0` is passed, the OS assigns a free port; we read it back from `server.address().port`. Electron picks port `0`, then uses the actual port to construct the `BrowserWindow` URL. Avoids the "port 8080 already in use" failure mode.

### `electron/main.cjs`

```js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

async function bootServer() {
    // Configure user-data paths BEFORE importing server modules
    const userDataDir = app.getPath('userData');
    const dataDir = path.join(userDataDir, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    process.env.DATA_DIR = dataDir;

    // Optional one-time migration: copy data/ from CWD if present (for dev → packaged transitions)
    const cwdData = path.join(process.cwd(), 'data');
    if (!fs.existsSync(path.join(dataDir, '.dbkey')) && fs.existsSync(path.join(cwdData, '.dbkey'))) {
        fs.cpSync(cwdData, dataDir, { recursive: true });
        console.log(`[electron] migrated data/ from ${cwdData} to ${dataDir}`);
    }

    // Dynamic import: server/server.js is ESM
    const { startServer } = await import('../server/server.js');
    const { port } = await startServer(0);  // 0 = OS-assigned
    return port;
}

async function createWindow(port) {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    await win.loadURL(`http://127.0.0.1:${port}`);
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

// Single-instance lock — second launch focuses the existing window instead of starting a second server.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length > 0) {
            wins[0].focus();
        }
    });

    app.whenReady().then(async () => {
        const port = await bootServer();
        await createWindow(port);
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
```

### `server/db.js` — honor `DATA_DIR` env var

`server/db.js` already constructs paths like `data/transcripts.db`. Change the top of the file to:

```js
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'transcripts.db');
const DBKEY_PATH = path.join(DATA_DIR, '.dbkey');
```

The CLI dev workflow (no `DATA_DIR` set) defaults to `./data` as today. The Electron main process sets `DATA_DIR` before the first import.

Same pattern in `server/scraper.js` for `COOKIES_PATH` and any other `data/*.json` references.

### `package.json` additions

```json
"scripts": {
    "start": "node server/server.js",
    "start:electron": "electron electron/main.cjs",
    "dev:electron": "NODE_ENV=development electron electron/main.cjs",
    "build": "vite build",
    "dev": "node server/server.js & npx vite --open",
    "dev:server": "node server/server.js",
    "dev:client": "npx vite",
    "import": "node server/import.js",
    "archive-videos": "node server/archive-videos.js"
},
"main": "electron/main.cjs",
"devDependencies": {
    "electron": "^32.0.0",
    "vite": "^6.0.0"
}
```

The `"main": "electron/main.cjs"` field tells Electron which file is the main process entry. Required.

### Acceptance for 4a

1. `npm run dev` still works (browser + Node server). Existing dev workflow is unchanged.
2. `npm run start:electron` (after `npm install` + `npm run build`):
   - Opens a desktop window with the existing app
   - Window title says "ffa-transcript-db" (or app name)
   - All existing UI works (login, scrape, search, course detail)
   - On a fresh machine without an existing `data/` folder, a new encrypted DB is created at `<userData>/data/`
   - On a machine with an existing `data/` folder in the CWD, the first launch copies it to userData and uses it
3. Two `npm run start:electron` invocations: the second one focuses the first window rather than starting a duplicate server (single-instance lock).
4. Loopback bind is verified: `curl http://<machine-ip>:<port>` from another machine on the network fails to connect (only 127.0.0.1 is bound).
5. `node --check` clean on `electron/main.cjs`, modified `server/server.js`, modified `server/db.js`.

### Out of scope for 4a (lands in 4b–4d)

- `archive-videos` UI button (4b)
- Force-refresh UI toggle (4b)
- ffmpeg banner / pre-flight UX (4b)
- ffmpeg bundling — system `ffmpeg` is still required for `archive-videos` until 4c
- Installers — `npm run dist:electron` doesn't exist yet (4d)
- App icons — use Electron's default for 4a; real icons land in 4d

---

## 4b — CLI flows into the UI

Replaces all remaining terminal touchpoints with UI affordances.

### New HTTP endpoints (Express, in `server/server.js`)

```
POST /api/courses/:id/archive-videos
  Body: { force?: boolean }
  Response: SSE stream:
    data: { type: 'preflight', ok: true | false, error?: string }
    data: { type: 'progress', lectureId, title, status: 'downloading' | 'skipped' | 'done' | 'error', pct?, sizeMB?, durationSec?, error? }
    data: { type: 'summary', downloaded, alreadyArchived, wrongProvider, failed, elapsedMs }
    data: { type: 'done' }
  AbortController: client can DELETE /api/courses/:id/archive-videos to cancel

GET /api/system/ffmpeg
  Response: { available: boolean, path?: string, version?: string }
```

### Refactor `server/archive-videos.js`

Extract the orchestration body into `server/archive-orchestrator.js`:

```js
export async function archiveCourseVideos(courseId, { force = false, signal, onProgress }) {
    // ... existing per-lecture loop, returning the summary object instead of console-logging it
}
```

`server/archive-videos.js` becomes a thin CLI wrapper that calls `archiveCourseVideos()` and writes progress to stdout. The new HTTP endpoint calls the same orchestrator function. Single source of truth.

The SIGINT-twice pattern in the CLI maps to the `AbortController`-via-DELETE pattern over HTTP. Both call `signal.aborted` to break out of the per-lecture loop.

### Frontend (`src/main.js` + `src/style.css`)

Two UI changes:

1. **Scrape modal**: add a checkbox "Force re-fetch transcripts" that, when checked, sends `{ forceRefresh: true }` in the POST body.
2. **Course detail view**: add an "Archive Videos" button next to the existing "Re-scrape" button. Clicking it:
   - Calls `GET /api/system/ffmpeg`; if `available: false`, shows a banner with the bundled-ffmpeg status (in 4c, this becomes a non-issue)
   - Opens a modal listing each lecture with status icons (pending → downloading → done / skipped / error)
   - Live progress percentage on the current download (from SSE)
   - Cancel button calls `DELETE /api/courses/:id/archive-videos`
   - Final summary when stream emits `type: 'summary'`

### Acceptance for 4b

1. Force-refresh checkbox in scrape modal: re-scrape with checkbox sends `forceRefresh: true`; backend honors it (verified by SSE event ordering with per-lecture "Scraping" messages).
2. Archive button on course detail view triggers the SSE-driven archive flow; per-lecture progress visible; final summary correct.
3. Cancel mid-archive: clicking cancel within 5 seconds aborts the current download cleanly, server tears down ffmpeg child, returns partial summary.
4. ffmpeg pre-flight: with system ffmpeg uninstalled and `@ffmpeg-installer/ffmpeg` not yet bundled (4c not done), the banner clearly says "ffmpeg not found"; no crashy errors.
5. Existing CLI `npm run archive-videos -- <id>` still works (same orchestrator, different shell).

---

## 4c — Bundle ffmpeg

### Dependency

```bash
npm install @ffmpeg-installer/ffmpeg
```

This package ships platform-specific binaries (`darwin-x64`, `darwin-arm64`, `win32-x64`, `linux-x64`, `linux-arm64`) and exports a `path` property pointing at the binary inside `node_modules`.

### Changes to `server/media-downloader.js`

Today, `media-downloader.js` calls `ffmpeg` as a child process via PATH lookup. Change to:

```js
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Prefer bundled binary; fall back to system PATH for dev environments where the
// installer package wasn't installed (e.g., CI).
const ffmpegPath = ffmpegInstaller?.path || 'ffmpeg';
```

Then use `ffmpegPath` wherever the existing code spawned `'ffmpeg'`.

### `electron-builder` config (incremental, full version in 4d)

The bundled ffmpeg binary in `node_modules/@ffmpeg-installer/<platform>/` must be included in the packaged app:

```yaml
files:
  - "node_modules/@ffmpeg-installer/**/*"
asarUnpack:
  - "node_modules/@ffmpeg-installer/**/*"  # Binaries must NOT be inside asar
```

### Acceptance for 4c

1. With system `ffmpeg` removed from PATH, `archive-videos -- 26` (or the UI button) still works — the bundled binary is invoked.
2. `GET /api/system/ffmpeg` returns `{ available: true, path: '...node_modules/@ffmpeg-installer/...', version: '...' }`.
3. Cross-platform: verified on Mac (arm64 + x64), Windows (x64), Linux (x64).

---

## 4d — Installers via `electron-builder`

### Dependency

```bash
npm install --save-dev electron-builder
```

### `electron-builder.yml` (top-level config)

```yaml
appId: com.gunnmilesllc.ffa-transcript-db
productName: FFA Transcript Database
copyright: Copyright © 2026 Gunn Miles LLC

directories:
  buildResources: build
  output: _dist

files:
  - "dist/**/*"
  - "server/**/*"
  - "electron/**/*"
  - "package.json"
  - "node_modules/@ffmpeg-installer/**/*"
  # Puppeteer's downloaded Chromium (via .puppeteerrc.cjs cacheDirectory)
  - ".cache/puppeteer/**/*"

asarUnpack:
  - "node_modules/@ffmpeg-installer/**/*"
  - ".cache/puppeteer/**/*"
  - "node_modules/better-sqlite3-multiple-ciphers/**/*"

mac:
  category: public.app-category.education
  target:
    - target: dmg
      arch: [arm64, x64]
  icon: build/icon.icns
  identity: null  # No signing in 4d

win:
  target:
    - target: nsis
      arch: [x64]
  icon: build/icon.ico

linux:
  target:
    - target: AppImage
      arch: [x64]
  icon: build/icon.png
  category: Education

publish: null  # No auto-update / publish in 4d
```

### `package.json` additions

```json
"scripts": {
    // ... existing ...
    "dist:electron": "npm run build && electron-builder",
    "dist:electron:mac": "npm run build && electron-builder --mac",
    "dist:electron:win": "npm run build && electron-builder --win",
    "dist:electron:linux": "npm run build && electron-builder --linux"
},
"devDependencies": {
    // ... existing ...
    "electron-builder": "^25.0.0"
}
```

### Acceptance for 4d

1. `npm run dist:electron:mac` produces:
   - `_dist/FFA Transcript Database-2.1.0-arm64.dmg`
   - `_dist/FFA Transcript Database-2.1.0-x64.dmg`
2. `npm run dist:electron:win` produces `_dist/FFA Transcript Database Setup 2.1.0.exe` (NSIS installer)
3. `npm run dist:electron:linux` produces `_dist/FFA Transcript Database-2.1.0.AppImage`
4. Installing the Mac `.dmg` on a clean machine without Node/ffmpeg/anything: drag to Applications, launch, accept "unidentified developer" warning once. App opens, full flow works (login → scrape → archive).
5. App icon visible in Dock / taskbar / launcher.
6. README updated with "Download the latest release" instructions.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| `better-sqlite3-multiple-ciphers` native binary doesn't match the Electron Node ABI | electron-builder's `npmRebuild: true` (default) rebuilds native modules against Electron's Node. If that fails, fall back to `electron-rebuild` step. |
| Puppeteer's bundled Chromium adds ~300 MB to the app size | Accepted for now. Phase 4 acceptable bundle size target: < 800 MB. Auto-update strategy in a later phase can ship binary diffs. |
| `@ffmpeg-installer/ffmpeg` is an old static build (4.x) | Today's `server/media-downloader.js` is verified working on ffmpeg 4.4.2 (per Phase 3 verification). 4.x is sufficient. Newer ffmpeg would be a future optimization. |
| Loopback port conflict if user has another loopback service on the OS-assigned port | Port 0 → OS-assigned → near-zero collision probability. Even if it happens, restart the app. |
| Existing `data/` migration: user with an in-repo `data/` runs the installed app → confusion about which DB is canonical | First-launch migration copies once. After that, the in-repo `data/` is ignored. Document this behavior in 4a's README change. |
| Code signing missing → users see scary warnings | Deferred to 4e. Initial release explains in README how to bypass (right-click → Open on Mac; "More info" → Run anyway on Windows). |
| `puppeteer` 24 vs Electron's bundled Node version | Compatibility verified at design time; both work on Node 18+. |
| User's existing `start.command` / `start.sh` / `start.bat` workflow gets confusing once the `.app` exists | Mark legacy launchers as developer-only in README. Don't delete — devs still use them. |

## Verification plan

After all four sub-phases land, the success test is:

> On a brand-new Mac (no Node, no Homebrew, no nothing), download `FFA Transcript Database-2.1.0-arm64.dmg`, drag the app to Applications, launch it, log in to Teachable, scrape a course, archive its videos, and watch a transcript open with no terminal usage at any point.

Same test on Windows (no Node, no Chocolatey) and Linux (no apt-installed Node).

## Out of scope for Phase 4 entirely

These are real follow-ups but not part of "make it work as a one-click app":

- Phase 3b (yt-dlp branch for YouTube embeds in the downloader) — orthogonal; can ship before or after Phase 4
- Phase 4e: code signing + notarization + auto-update — separate concerns, can ship anytime after 4d
- Phase 5: range-capable video streaming API + transcript-to-video click-to-seek
- Phase 6: in-app video player with click-to-seek
- Phase 7: Notion archiver — moved later because Phase 4 makes it ship-able for end users; otherwise Notion archiving would only be useful via CLI

## What this plan does NOT change

- Database schema (Phase 3.1 schema is the latest; no migrations in Phase 4)
- The encrypted SQLite library (better-sqlite3-multiple-ciphers stays)
- Puppeteer for scraping (unchanged)
- ffmpeg as the video downloader (just bundled now)
- Phase 3.1's incremental-scrape invariants (preserved through all sub-phases)
- The existing dev workflow (`npm run dev`, `npm run start`, CLI scripts) — all keep working

## Estimate

| Sub-phase | Wall-clock |
|---|---|
| 4a | ~half day (~4 hours including reviews) |
| 4b | ~1 day (~6 hours) |
| 4c | ~half day (~3 hours) |
| 4d | ~half day (~3-4 hours, mostly waiting for Windows/Linux builds) |
| **Total** | **~3 days** of focused work |

Each sub-phase ships as its own PR, with subagent-driven implementation, spec-compliance review, and code quality review (same workflow as Phase 3.1).
