// Phase 4a: Electron main process entry. Boots the existing Express server
// in-process on a loopback dynamic port, then opens a BrowserWindow pointing
// at that URL. Single-instance locked. Honors NODE_ENV=development to open
// DevTools. Migrates ./data/ to userData/data on first launch when running
// from a project tree.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

// Phase 4d: macOS GUI apps inherit only a minimal PATH ('/usr/bin:/bin:...'),
// so Homebrew binaries (ffmpeg, etc.) at /opt/homebrew/bin or /usr/local/bin
// are invisible to spawn(). Prepend common install locations so the
// archive-videos pre-flight (server/archive-orchestrator.js → checkFfmpeg)
// can find them. Phase 4c will bundle ffmpeg via @ffmpeg-installer; until
// then we rely on the user's system installation.
const EXTRA_PATH = [
    '/opt/homebrew/bin',     // Apple Silicon Homebrew
    '/opt/homebrew/sbin',
    '/usr/local/bin',        // Intel Homebrew, MacPorts, manual installs
    '/usr/local/sbin',
    `${process.env.HOME || ''}/.nodenv/shims`,
    `${process.env.HOME || ''}/.nvm/versions/node`,
];
const existingPath = process.env.PATH || '';
const pathParts = existingPath.split(':').filter(Boolean);
for (const p of EXTRA_PATH) {
    if (p && !pathParts.includes(p)) pathParts.unshift(p);
}
process.env.PATH = pathParts.join(':');

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
        // Mac: re-create window when dock icon is clicked. Stub for 4a.
        if (BrowserWindow.getAllWindows().length === 0) {
            console.warn('[electron] activate with no windows; not yet supported in 4a');
        }
    });
}
