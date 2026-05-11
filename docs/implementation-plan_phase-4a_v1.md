# Phase 4a Implementation Plan — Electron Scaffolding + In-Process Server Bootstrap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing app launchable as a desktop window via `npm run start:electron`, with the Node/Express backend running in-process inside Electron's main process. No installers yet; no UI changes yet. The existing dev workflow (`npm run dev`, CLI scripts) keeps working exactly as before.

**Architecture:** Three coordinated changes. (1) `server/server.js` is refactored to export `startServer(port)` and the Express `app`, so it can be imported and started programmatically; the file still auto-starts when invoked directly via Node CLI. (2) `server/db.js` and `server/scraper.js` honor a `DATA_DIR` env var so the Electron main process can point them at `app.getPath('userData')/data` while CLI invocations keep using `./data`. (3) A new `electron/main.cjs` boots the server on a loopback dynamic port, creates a `BrowserWindow` loading that URL, and acquires a single-instance lock.

**Tech Stack:** Node.js 22 ESM, Electron (new dependency, ^32.0.0), Express 4 (existing), `better-sqlite3-multiple-ciphers` 12.9 (existing), Vite 6 (existing — builds the renderer assets that Express serves at `/`). No test framework — verification by direct invocation per the project's existing convention.

**Predecessor docs:**
- Spec: [docs/feature-plan_phase-4_electronize_v1.md](feature-plan_phase-4_electronize_v1.md) (sub-phase 4a section)
- Prior phase: [docs/feature-plan_local-course-archive_v5.md](feature-plan_local-course-archive_v5.md) (Phase 3.1, just shipped)

**Workflow note:** No test suite by design. Each task gets:
1. Implementer subagent (worktree-isolated) — produces code + functional verification.
2. Spec-compliance reviewer subagent — verifies code matches the 4a spec.
3. Code-quality reviewer subagent — categorizes issues by severity.
4. Fix-and-re-review loop only if Important issues are found.

Same pattern as Phase 3.1.

---

## File Structure

| File | Action | Responsibility after change |
|---|---|---|
| `server/server.js` | Modify | Define routes (unchanged), export `app` and `startServer(port?)`. Auto-start when invoked as `node server/server.js`; stay dormant when imported. |
| `server/db.js` | Modify | Path-resolve via `DATA_DIR` env var (default `./data`). All `data/transcripts.db`, `data/.dbkey`, etc. references go through this resolved path. |
| `server/scraper.js` | Modify | `COOKIES_PATH` resolved via the same `DATA_DIR` env var. |
| `electron/main.cjs` | Create | Electron main process entry. Sets `DATA_DIR`, performs first-launch data migration (dev path only), boots the server, creates the `BrowserWindow`, owns single-instance lock and lifecycle. |
| `package.json` | Modify | Add `"main": "electron/main.cjs"`. Add scripts `start:electron`, `dev:electron`. Add devDependency `electron@^32.0.0`. |
| `.gitignore` | Modify | Ignore `_dist/` if not already (electron-builder output dir, used in 4d but harmless to add now). |

**Total: 5 modifications + 1 new file.** No deletions. No frontend changes. No schema changes.

---

## Task 1: Refactor `server/server.js` for in-process embedding

**Branch (worktree):** `feature/phase-4a-electron-scaffolding`

**Files:**
- Modify: `server/server.js` — currently has top-level `app.listen()` call

**Goal:** Export `app` and `startServer(port?)`. Keep CLI auto-start behavior so `node server/server.js` and `npm run start` work unchanged.

- [ ] **Step 1.1: Read the current end-of-file structure**

Locate the `app.listen(...)` call near the bottom of `server/server.js`. Modern shape is roughly:

```js
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
```

(Exact form may differ — read the actual code first.)

- [ ] **Step 1.2: Replace the auto-listen with an export + conditional CLI start**

Replace the `app.listen(...)` block with:

```js
// Phase 4a: Export app and a startServer() function so Electron's main process
// (or any other host) can start the server programmatically. When invoked
// directly as `node server/server.js`, auto-start on env PORT or 8080.

export { app };

export async function startServer(port = process.env.PORT || 8080) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => {
            const actualPort = server.address().port;
            console.log(`Server listening on http://127.0.0.1:${actualPort}`);
            resolve({ server, port: actualPort });
        });
        server.on('error', reject);
    });
}

// Auto-start when invoked directly as a CLI (preserves `npm run start` behavior).
const isMainModule = import.meta.url === `file://${process.argv[1]}`
    || import.meta.url === `file:${process.argv[1]}`;
if (isMainModule) {
    startServer().catch(err => {
        console.error('Server failed to start:', err);
        process.exit(1);
    });
}
```

Two important properties:
- Bind to `127.0.0.1` explicitly (not `0.0.0.0`). The desktop app's server must NEVER be reachable from another machine on the network.
- Allow port `0` (caller passes it to get an OS-assigned free port). The actual port is read back from `server.address().port`. This avoids "port 8080 in use" failures when Electron launches alongside another local service.

The `isMainModule` check handles both URL forms (Mac/Linux use `file://`, Windows may produce `file:` without double slash in some Node versions). This is a known cross-platform quirk; check both forms.

- [ ] **Step 1.3: Verification — CLI auto-start still works**

```bash
cd /Volumes/GMLDAS/Development/Software/General/ffa-transcript-db/.claude/worktrees/feature+phase-4a-electron-scaffolding
node server/server.js &
SERVER_PID=$!
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/api/courses
echo " <- expected 200 or 401"
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: HTTP status `200` (or `401` if no session) — confirming the server bound to port 8080 on loopback.

- [ ] **Step 1.4: Verification — `startServer(0)` returns a dynamic port**

```bash
node -e "
import('./server/server.js').then(async ({startServer}) => {
  const { server, port } = await startServer(0);
  console.log('dynamic port assigned:', port);
  if (typeof port !== 'number' || port < 1024) {
    console.error('FAIL: expected a numeric port > 1024');
    process.exit(1);
  }
  server.close();
  console.log('server closed cleanly');
}).catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

Expected: prints `dynamic port assigned: <some_number>` (a port > 1024, OS-assigned), then `server closed cleanly`.

- [ ] **Step 1.5: Verification — loopback bind (not reachable from non-loopback)**

```bash
node server/server.js &
SERVER_PID=$!
sleep 2
# Try connecting via the machine's primary IP (not 127.0.0.1)
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I | awk '{print $1}')
if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "127.0.0.1" ]; then
    curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "http://${LOCAL_IP}:8080/api/courses"
    echo " <- expected 000 (connection refused), since we bound 127.0.0.1 only"
fi
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: HTTP status `000` (curl's code for connection failure) — confirming non-loopback IPs cannot reach the server. If `LOCAL_IP` is empty (no network), skip this check.

- [ ] **Step 1.6: Commit**

```bash
git add server/server.js
git commit -m "Export server app and startServer(); bind loopback only"
```

---

## Task 2: Honor `DATA_DIR` env var in `server/db.js` and `server/scraper.js`

**Branch (worktree):** continue on `feature/phase-4a-electron-scaffolding`

**Files:**
- Modify: `server/db.js` — currently references `data/transcripts.db`, `data/.dbkey`, etc.
- Modify: `server/scraper.js` — `COOKIES_PATH` is `data/cookies.json`

**Goal:** When `DATA_DIR` env var is set, all data-folder paths resolve relative to it. Default `./data` (current behavior) when unset.

- [ ] **Step 2.1: Read current `server/db.js` path constants**

Near the top of `server/db.js`, find constants like:

```js
const DB_PATH = path.join('data', 'transcripts.db');
const DBKEY_PATH = path.join('data', '.dbkey');
```

(Exact names and form may differ — read the actual code first to learn the existing pattern.)

- [ ] **Step 2.2: Introduce `DATA_DIR` resolution**

Just below the existing `import path from 'path';` (or equivalent), add:

```js
// Phase 4a: data/ directory is configurable via DATA_DIR env var so Electron's
// main process can point us at app.getPath('userData')/data while CLI
// invocations default to ./data.
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
```

Then update each path constant to use `DATA_DIR`:

```js
const DB_PATH = path.join(DATA_DIR, 'transcripts.db');
const DBKEY_PATH = path.join(DATA_DIR, '.dbkey');
// any other data/* references — convert each
```

If the file has a `fs.mkdirSync('data', { recursive: true })` or equivalent, change it to `fs.mkdirSync(DATA_DIR, { recursive: true })`.

Be thorough — grep the file for `'data/'` and `"data/"` literals:

```bash
grep -n "['\"]data['\"]" server/db.js
grep -n "data/" server/db.js
```

Convert every match that refers to the project's `data/` folder.

- [ ] **Step 2.3: Update `server/scraper.js` similarly**

Read `server/scraper.js`; locate the `COOKIES_PATH` constant (and any other `data/*` references). Apply the same pattern:

```js
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.json');
```

If `server/scraper.js` and `server/db.js` both declare `DATA_DIR` independently — that's fine for 4a. We could extract a shared module later but YAGNI for now (the spec defers shared-config extraction).

- [ ] **Step 2.4: Verification — default behavior unchanged**

Without `DATA_DIR` set, `node server/server.js` should still find the existing `./data/transcripts.db`:

```bash
unset DATA_DIR
node -e "
import('./server/db.js').then(({getDb}) => {
  const db = getDb();
  const courses = db.prepare('SELECT COUNT(*) AS n FROM courses').get();
  console.log('default DATA_DIR: courses =', courses.n);
  if (courses.n < 1) { console.error('FAIL: no courses found'); process.exit(1); }
});
"
```

Expected: prints `default DATA_DIR: courses = 39` (or whatever the current count is).

- [ ] **Step 2.5: Verification — `DATA_DIR` env override works**

Point `DATA_DIR` at a non-existent dir; expect a clean failure (not a silent fallback):

```bash
DATA_DIR=/tmp/nonexistent-data-$$ node -e "
import('./server/db.js').then(({getDb}) => {
  try {
    const db = getDb();
    const r = db.prepare('SELECT 1 AS n').get();
    console.log('opened DB at DATA_DIR; SELECT 1 returned:', r.n);
  } catch (e) {
    console.log('expected init path under override:', e.message);
  }
});
"
```

Expected: either the script creates a fresh empty DB at `/tmp/nonexistent-data-<pid>/transcripts.db` and prints `opened DB at DATA_DIR; SELECT 1 returned: 1`, OR it prints an error mentioning the missing `.dbkey`. Both are acceptable — the point is that DATA_DIR is being honored. Cleanup:

```bash
rm -rf /tmp/nonexistent-data-*
```

- [ ] **Step 2.6: Verification — point `DATA_DIR` at a temp copy of the real data**

```bash
TMP_DATA=$(mktemp -d)
cp -R data/. "$TMP_DATA/"
DATA_DIR="$TMP_DATA" node -e "
import('./server/db.js').then(({getDb}) => {
  const courses = getDb().prepare('SELECT COUNT(*) AS n FROM courses').get();
  console.log('DATA_DIR override: courses =', courses.n);
});
"
rm -rf "$TMP_DATA"
```

Expected: prints `DATA_DIR override: courses = 39` (same as default). Confirms the env var redirects path resolution without breaking the encrypted DB open.

- [ ] **Step 2.7: Commit**

```bash
git add server/db.js server/scraper.js
git commit -m "Honor DATA_DIR env var for data folder paths"
```

---

## Task 3: Add Electron, create `electron/main.cjs`, wire up scripts

**Branch (worktree):** continue on `feature/phase-4a-electron-scaffolding`

**Files:**
- Create: `electron/main.cjs`
- Modify: `package.json` — add `main`, scripts, devDependency
- Modify: `.gitignore` — add `_dist/` (used in 4d, harmless now)

**Goal:** `npm run start:electron` opens a desktop window showing the existing app; `npm run dev` still works for browser-based development.

- [ ] **Step 3.1: Install Electron as a devDependency**

```bash
cd /Volumes/GMLDAS/Development/Software/General/ffa-transcript-db/.claude/worktrees/feature+phase-4a-electron-scaffolding
npm install --save-dev electron@^32.0.0
```

Expected: `package.json` gains `"electron": "^32.0.0"` under `devDependencies`; `node_modules/electron/` exists; `node_modules/electron/dist/Electron.app` (Mac) or platform equivalent exists.

If the install fails due to native module rebuild (e.g., `better-sqlite3-multiple-ciphers`), report the error verbatim and STOP. Don't try to fix it speculatively — escalate to the controller.

- [ ] **Step 3.2: Add `package.json` scripts and `main` field**

Open `package.json`. Add to the `"scripts"` block (preserving existing scripts):

```json
"scripts": {
    "start": "node server/server.js",
    "start:electron": "electron electron/main.cjs",
    "dev:electron": "NODE_ENV=development electron electron/main.cjs",
    "build": "npx vite build",
    "dev": "node server/server.js & npx vite --open",
    "dev:server": "node server/server.js",
    "dev:client": "npx vite",
    "import": "node server/import.js",
    "archive-videos": "node server/archive-videos.js",
    "dist": "npm run build && mkdir -p _dist && zip -r _dist/ffa-transcript-db-v2.1.0.zip dist/ server/ package.json package-lock.json README.md LICENSE .env.example start.command start.sh start.bat -x '*.DS_Store'"
}
```

Two scripts are NEW: `start:electron`, `dev:electron`. The `NODE_ENV=development` env on `dev:electron` enables DevTools auto-open. (On Windows this exact syntax won't work — but Phase 4a development is happening on Mac, and 4d will revisit cross-platform script invocation if needed.)

Then add a top-level `"main"` field, just below `"version"`:

```json
"main": "electron/main.cjs",
```

Electron requires `"main"` to find the entry file.

- [ ] **Step 3.3: Create `electron/main.cjs`**

```bash
mkdir -p electron
```

Then create `electron/main.cjs`:

```js
// Phase 4a: Electron main process entry. Boots the existing Express server
// in-process on a loopback dynamic port, then opens a BrowserWindow pointing
// at that URL. Single-instance locked. Honors NODE_ENV=development to open
// DevTools. Migrates ./data/ to userData/data on first launch when running
// from a project tree.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

async function bootServer() {
    const userDataDir = app.getPath('userData');
    const dataDir = path.join(userDataDir, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    process.env.DATA_DIR = dataDir;

    // Dev-mode one-time migration: if a project-local ./data/.dbkey exists and
    // the userData copy doesn't yet, copy it across. Packaged builds won't have
    // a project-local data/ so this is a no-op there.
    const cwdDataKey = path.join(process.cwd(), 'data', '.dbkey');
    const userDataKey = path.join(dataDir, '.dbkey');
    if (!fs.existsSync(userDataKey) && fs.existsSync(cwdDataKey)) {
        const src = path.dirname(cwdDataKey);
        fs.cpSync(src, dataDir, { recursive: true });
        console.log(`[electron] migrated data/ from ${src} to ${dataDir}`);
    }

    // Dynamic import — server/server.js is ESM, this file is CJS.
    const { startServer } = await import('../server/server.js');
    const { port } = await startServer(0);  // 0 = OS-assigned
    return port;
}

async function createMainWindow(port) {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: 'FFA Transcript Database',
    });
    await win.loadURL(`http://127.0.0.1:${port}`);
    if (isDev) {
        win.webContents.openDevTools({ mode: 'detach' });
    }
    return win;
}

// Single-instance lock: a second launch focuses the existing window rather
// than spawning a second Express server.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const wins = BrowserWindow.getAllWindows();
        if (wins.length > 0) {
            if (wins[0].isMinimized()) wins[0].restore();
            wins[0].focus();
        }
    });

    app.whenReady().then(async () => {
        try {
            const port = await bootServer();
            await createMainWindow(port);
        } catch (err) {
            console.error('[electron] boot failed:', err);
            app.quit();
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        // Mac: re-create window when dock icon is clicked and no windows are open.
        if (BrowserWindow.getAllWindows().length === 0) {
            // Server is already running; just open a new window pointing at it.
            // Track the port in module scope for re-use.
            console.warn('[electron] activate with no windows; not yet supported in 4a');
        }
    });
}
```

Note: the `activate` handler is intentionally a no-op stub for 4a. Re-opening windows after close is a Mac UX expectation but adding the wiring (storing the port in module scope, re-using it) is small but not strictly needed to clear 4a's acceptance criteria. Future polish.

- [ ] **Step 3.4: Update `.gitignore`**

Open `.gitignore`. If `_dist/` is not already there, append:

```
_dist/
```

This is the electron-builder output dir used in 4d. Adding it now avoids accidental commits later.

- [ ] **Step 3.5: Verification — `node --check` on the new file**

`node --check` doesn't natively handle `.cjs` differently from `.js`, but the file uses CommonJS `require()`. Confirm syntax:

```bash
node --check electron/main.cjs && echo "main.cjs syntax ok"
```

Expected: `main.cjs syntax ok`.

- [ ] **Step 3.6: Verification — build the renderer**

The Electron window will load from the server, which serves `dist/index.html`. Make sure the renderer is built:

```bash
npm run build
```

Expected: produces `dist/index.html`, `dist/assets/*.js`, etc. No errors.

- [ ] **Step 3.7: Verification — `npm run start:electron` opens a window**

```bash
npm run start:electron
```

Expected:
- Console prints `[electron] migrated data/ from <cwd>/data to <userData>/data` on first run (or nothing if userData/data already exists)
- Console prints `Server listening on http://127.0.0.1:<port>` (port number visible)
- A desktop window opens titled "FFA Transcript Database"
- The window shows the existing app UI — the courses list, search bar, etc.
- Closing the window quits the app (non-Mac) or keeps the app alive in the dock (Mac)

If the window opens but shows a blank page or an error, capture the DevTools console output (the window's right-click → Inspect, or in dev mode it auto-opens) and report BLOCKED with the console errors.

- [ ] **Step 3.8: Verification — single-instance lock**

With the Electron app still running from Step 3.7, run:

```bash
npm run start:electron
```

Expected: the second invocation exits immediately (no new window opens). The first window's focus should be brought to the front. The Electron process spawned by the second invocation should NOT start a second server (no second "Server listening on..." line).

- [ ] **Step 3.9: Verification — existing dev workflow still works**

Stop all Electron instances. Then:

```bash
npm run start
```

(That's the original CLI server.) Expected: prints `Server listening on http://127.0.0.1:8080`. Then `curl http://127.0.0.1:8080/api/courses` returns JSON (or 401 if no session). Kill it with Ctrl-C.

```bash
node server/server.js
```

Same expectation. The CLI auto-start path is preserved.

- [ ] **Step 3.10: Commit**

```bash
git add electron/main.cjs package.json package-lock.json .gitignore
git commit -m "Add Electron scaffolding: main.cjs + start:electron scripts"
```

---

## Acceptance Criteria for Phase 4a

Phase 4a is done when ALL of these hold:

1. **`npm run dev` still works** — Node server on 8080 + Vite dev server with hot reload. No regression.
2. **`npm run start` still works** — CLI server on 8080 (or env `PORT`). No regression.
3. **`node server/server.js` still works** — same as `npm run start`. Auto-start path preserved.
4. **`npm run start:electron` opens a desktop window** showing the existing app, with the server running in-process on a loopback dynamic port (NOT 8080 — verify a different port in the console output).
5. **Single-instance lock** — a second `npm run start:electron` exits immediately; the first window is focused.
6. **Loopback bind** — `curl http://<machine-LAN-IP>:<port>` from another device on the network fails (connection refused). The server is reachable only from `127.0.0.1`.
7. **`DATA_DIR` env override** — pointing `DATA_DIR` at a temp folder makes `getDb()` open the DB there, not in `./data/`.
8. **First-launch data migration** — on a machine where `userData/data/.dbkey` doesn't exist but `./data/.dbkey` does, Electron's first launch copies the project's `./data/` to `userData/data/`. Verified by inspecting `app.getPath('userData')` post-launch.
9. **`node --check` clean** on all modified files.
10. **No new npm dependencies in `dependencies`** — only `electron` in `devDependencies`. No production runtime changes.

---

## Verification command — full smoke test

After all three tasks land, this sequence proves 4a is complete:

```bash
# From the worktree root
npm install
npm run build
npm run start:electron &
sleep 5
# Window should be open. Visually verify the UI loads.

# Background: confirm a server is running on loopback at some non-8080 port
lsof -nP -iTCP -sTCP:LISTEN -P 2>/dev/null | grep node | grep '127.0.0.1' | head -3
# Expected: at least one node process listening on 127.0.0.1:<random-port>

# Kill the Electron app via its window (Cmd-Q on Mac).
# Then verify the original CLI server still works:
node server/server.js &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:8080/api/courses > /dev/null && echo "CLI server still works"
kill $SERVER_PID
```

---

## Out of scope for 4a

These are part of later sub-phases, NOT this PR:

- `archive-videos` HTTP endpoint + UI button (4b)
- Force-refresh UI checkbox (4b)
- ffmpeg pre-flight banner / bundling (4b/4c)
- `electron-builder` packaging / installers / icons (4d)
- App menu (File → Import existing data…, About, etc.) — 4d
- Auto-update / code signing / notarization (4e)
- Refactoring `DATA_DIR` resolution into a shared `server/paths.js` module — explicit YAGNI for 4a

---

## Self-Review (against spec section "4a — Electron scaffolding + in-process server bootstrap")

Spec coverage check:

| 4a Spec Requirement | Covered by |
|---|---|
| `electron/main.cjs` new file | Task 3 Step 3.3 |
| `server/server.js` exports `app` + `startServer(port?)` | Task 1 Step 1.2 |
| Loopback bind (`127.0.0.1`) | Task 1 Step 1.2 + verification Step 1.5 |
| Dynamic port (port `0`) | Task 1 Step 1.4 verification |
| Preserve CLI auto-start | Task 1 Step 1.2 `isMainModule` check + Step 1.3 verification |
| `DATA_DIR` env override in `server/db.js` | Task 2 Step 2.2 |
| `DATA_DIR` env override in `server/scraper.js` | Task 2 Step 2.3 |
| First-launch `./data/` migration | Task 3 Step 3.3 `cwdDataKey` block |
| `package.json` `main` field + new scripts + electron devDep | Task 3 Steps 3.1, 3.2 |
| Single-instance lock | Task 3 Step 3.3 `requestSingleInstanceLock` |
| `contextIsolation: true`, `nodeIntegration: false` | Task 3 Step 3.3 webPreferences block |
| DevTools auto-open in `dev:electron` | Task 3 Step 3.3 `if (isDev)` block |

No gaps detected. Names consistent across tasks (`DATA_DIR`, `startServer`, `port`). No placeholders.
