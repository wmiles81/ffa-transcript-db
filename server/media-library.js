import path from 'path';
import fs from 'fs';

const DEFAULT_MEDIA_LIBRARY_PATH =
    '/Volumes/GMLDAS/Development/Software/General/ffa-transcript-db-media';

export const MEDIA_LIBRARY_PATH = path.resolve(
    process.env.MEDIA_LIBRARY_PATH && process.env.MEDIA_LIBRARY_PATH.trim()
        ? process.env.MEDIA_LIBRARY_PATH
        : DEFAULT_MEDIA_LIBRARY_PATH
);

export function ensureMediaLibraryExists() {
    fs.mkdirSync(MEDIA_LIBRARY_PATH, { recursive: true });
}

export function lectureDir(courseId, lectureId) {
    const dir = path.join(
        MEDIA_LIBRARY_PATH,
        'courses',
        String(courseId),
        'lectures',
        String(lectureId)
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function relativize(absPath) {
    const rel = path.relative(MEDIA_LIBRARY_PATH, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
            `Path is outside MEDIA_LIBRARY_PATH: ${absPath}`
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
    return path.join(MEDIA_LIBRARY_PATH, normalized);
}

// Fail loudly on startup if MEDIA_LIBRARY_PATH points somewhere unwritable
ensureMediaLibraryExists();
