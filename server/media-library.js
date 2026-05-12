import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The default path is a sibling of the repo root (two levels up from server/).
export const DEFAULT_MEDIA_LIBRARY_PATH = path.resolve(
    __dirname, '..', '..', 'ffa-transcript-db-media'
);

// Resolve the settings JSON path — mirrors the SETTINGS_DIR logic in server.js.
const _settingsDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
const _settingsPath = path.join(_settingsDir, 'ai-settings.json');

/**
 * Returns the currently-configured media library path.
 * Priority order:
 *   1. `media_library_path` key in data/ai-settings.json (set via Settings UI)
 *   2. MEDIA_LIBRARY_PATH environment variable
 *   3. DEFAULT_MEDIA_LIBRARY_PATH (sibling of repo root)
 */
export function getMediaLibraryPath() {
    try {
        if (fs.existsSync(_settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
            if (settings.media_library_path && String(settings.media_library_path).trim()) {
                return path.resolve(String(settings.media_library_path).trim());
            }
        }
    } catch { /* fall through */ }

    if (process.env.MEDIA_LIBRARY_PATH && process.env.MEDIA_LIBRARY_PATH.trim()) {
        return path.resolve(process.env.MEDIA_LIBRARY_PATH.trim());
    }

    return DEFAULT_MEDIA_LIBRARY_PATH;
}

export function ensureMediaLibraryExists() {
    fs.mkdirSync(getMediaLibraryPath(), { recursive: true });
}

export function lectureDir(courseId, lectureId) {
    const dir = path.join(
        getMediaLibraryPath(),
        'courses',
        String(courseId),
        'lectures',
        String(lectureId)
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function relativize(absPath) {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
        throw new Error(`relativize: expected absolute path, got: ${absPath}`);
    }
    const base = getMediaLibraryPath();
    const rel = path.relative(base, absPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
            `Path is outside or equal to MEDIA_LIBRARY_PATH: ${absPath}`
        );
    }
    return rel;
}

export function resolveRelative(relPath) {
    if (relPath == null || relPath === '') {
        throw new Error('resolveRelative: relPath is null or empty');
    }
    const normalized = path.normalize(relPath);
    if (
        normalized.startsWith('..') ||
        normalized === '..' ||
        path.isAbsolute(normalized)
    ) {
        throw new Error(`resolveRelative: invalid relative path: ${relPath}`);
    }
    return path.join(getMediaLibraryPath(), normalized);
}

// Fail loudly on startup if the media library path points somewhere unwritable.
// Set MEDIA_LIBRARY_AUTOENSURE=0 to disable the eager call (useful for CLI
// --help / --dry-run flows on machines where the volume is unmounted).
if (process.env.MEDIA_LIBRARY_AUTOENSURE !== '0') {
    ensureMediaLibraryExists();
}
