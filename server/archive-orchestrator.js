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
 * @param {boolean} [opts.force=false]   — Re-download even if video_local_path already set
 * @param {AbortSignal} [opts.signal]    — Cancel mid-run (cooperative; checked between lectures)
 * @param {(event: object) => void} [opts.onProgress] — Event emitter (see plan for event shapes)
 * @returns {Promise<{summary, interrupted, error}>}
 */
export async function archiveCourseVideos(courseId, opts = {}) {
    const { force = false, signal, onProgress = () => {} } = opts;
    const startedAt = Date.now();

    const ffmpeg = await checkFfmpeg();
    onProgress({ type: 'preflight', ok: ffmpeg.ok, version: ffmpeg.version || null, error: ffmpeg.ok ? null : 'ffmpeg not found on PATH' });
    if (!ffmpeg.ok) {
        return { summary: null, interrupted: false, error: 'ffmpeg not found' };
    }

    const db = getDb();

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
        "SELECT * FROM course_lectures WHERE course_id = ? AND (removed_at IS NULL OR removed_at = '') ORDER BY position"
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
                    onProgress({ ...baseEvent, status: 'done', sizeBytes: result.sizeBytes, durationSec: result.durationSec, videoCount: result.videoCount || 1 });
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
