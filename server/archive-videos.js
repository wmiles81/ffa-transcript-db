// Set BEFORE any import that transitively imports media-library.js, so we don't
// try to mkdir on the GMLDAS volume during --help / arg-parsing. Node ESM
// hoists static imports above top-level code, so we use dynamic import() below
// to ensure this runs first. We re-enable later by explicitly calling
// ensureMediaLibraryExists() when we actually need to write files.
process.env.MEDIA_LIBRARY_AUTOENSURE = '0';

import { spawn } from 'child_process';

// Register a minimal SIGINT handler BEFORE any long-running work (dynamic
// imports, encrypted-DB open, pre-flight). This ensures Ctrl-C during pre-flight
// is caught instead of falling through to Node's default handler (which exits
// without giving us a chance to closeDb()). The handler just sets a flag; the
// natural exit path checks the flag and shuts down cleanly. A second Ctrl-C
// (e.g., user really wants to stop NOW, not after the current lecture finishes)
// triggers an immediate exit.
let interrupted = false;
process.on('SIGINT', () => {
    if (interrupted) {
        // Second Ctrl-C — exit immediately
        process.exit(130);
    }
    interrupted = true;
    console.log('\n⚠ Interrupt received — finishing current operation, please wait...');
});

// Dynamic imports — see comment above. These transitively import media-library.js.
const { downloadLectureVideo } = await import('./media-downloader.js');
const { ensureMediaLibraryExists } = await import('./media-library.js');
const { VIDEO_PROVIDERS, isValidProvider } = await import('./media-providers.js');
const { getDb, closeDb } = await import('./db.js');

function usage() {
    console.log('Usage: node server/archive-videos.js <courseId>');
    console.log('');
    console.log('Walks every Hotmart-hosted lecture in the given course and downloads');
    console.log('each video to the local media library. Idempotent across re-runs.');
    console.log('');
    console.log('Set MEDIA_LIBRARY_PATH to override the default media library location.');
}

function parseArgs(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        usage();
        process.exit(2);
    }
    const courseId = Number(args[0]);
    if (!Number.isInteger(courseId) || courseId <= 0) {
        usage();
        process.exit(2);
    }
    return { courseId };
}

function checkFfmpeg() {
    return new Promise((resolve) => {
        const ff = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        ff.stdout.on('data', (d) => { out += d.toString(); });
        ff.on('error', () => resolve({ ok: false }));
        // Any exit code counts as "ffmpeg is on PATH" — only spawn failure (ENOENT) is fatal
        ff.on('close', () => {
            const firstLine = out.split('\n')[0] || 'ffmpeg (version unknown)';
            resolve({ ok: true, version: firstLine.trim() });
        });
    });
}

function validateProvidersInDb(db) {
    const rows = db.prepare(
        'SELECT DISTINCT video_provider FROM course_lectures WHERE video_provider IS NOT NULL'
    ).all();
    for (const { video_provider } of rows) {
        if (!isValidProvider(video_provider)) {
            console.log(`⚠ Unknown video_provider value in DB: '${video_provider}' (rows will be skipped)`);
        }
    }
}

function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return '?:??';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
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
    const { courseId } = parseArgs(process.argv);
    const startedAt = Date.now();

    const ffmpeg = await checkFfmpeg();
    if (!ffmpeg.ok) {
        console.error('❌ ffmpeg not found. Install with: brew install ffmpeg');
        process.exit(1);
    }
    console.log(ffmpeg.version);

    const db = getDb();

    validateProvidersInDb(db);

    const course = db.prepare('SELECT id, title FROM courses WHERE id = ?').get(courseId);
    if (!course) {
        console.error(`❌ No course found with id ${courseId}`);
        closeDb();
        process.exit(1);
    }

    const lectures = db.prepare(
        'SELECT * FROM course_lectures WHERE course_id = ? ORDER BY position'
    ).all(courseId);

    console.log(`Course: ${course.title} (id ${course.id})`);
    console.log(`Lectures: ${lectures.length}`);
    console.log('');

    // We're about to write files — explicitly create the media library now.
    ensureMediaLibraryExists();

    const tally = { downloaded: 0, already_archived: 0, wrong_provider: 0, failed: 0 };
    let completed = 0;

    for (let i = 0; i < lectures.length; i++) {
        if (interrupted) break;
        const lecture = lectures[i];
        const classNum = lecture.class_number ? `L${lecture.class_number} — ` : '';
        console.log(`[${i + 1} of ${lectures.length}] ${classNum}${lecture.title}`);

        if (lecture.video_provider === VIDEO_PROVIDERS.HOTMART) {
            try {
                const result = await downloadLectureVideo(lecture, {
                    onProgress: (msg) => console.log(`  → ${msg}`),
                });
                if (result.ok) {
                    tally.downloaded++;
                    console.log(`  ✓ Downloaded (${formatSize(result.sizeBytes)}, ${formatDuration(result.durationSec)})`);
                } else if (result.skipped) {
                    if (result.reason === 'already archived') tally.already_archived++;
                    else tally.wrong_provider++;
                    console.log(`  · Skipped (${result.reason})`);
                } else if (result.error) {
                    tally.failed++;
                    console.log(`  ✗ Failed: ${result.error}`);
                    if (result.details) {
                        const tail = String(result.details).split('\n').filter(Boolean).slice(-1)[0] || '';
                        if (tail) console.log(`    ${tail}`);
                    }
                }
            } catch (err) {
                tally.failed++;
                console.log(`  ✗ Failed: ${err.message}`);
            }
        } else {
            tally.wrong_provider++;
            const p = lecture.video_provider == null ? 'null' : lecture.video_provider;
            console.log(`  · Skipped (provider ${p} not yet supported)`);
        }
        completed++;
    }

    if (interrupted) {
        console.log('');
        console.log(`Interrupted; ${completed} lectures completed before stopping.`);
        closeDb();
        process.exit(130);
    }

    console.log('');
    console.log('— Summary —');
    console.log(`  downloaded:        ${tally.downloaded}`);
    console.log(`  already archived:  ${tally.already_archived}`);
    console.log(`  wrong provider:    ${tally.wrong_provider}`);
    console.log(`  failed:            ${tally.failed}`);
    console.log(`  elapsed:           ${formatElapsed(Date.now() - startedAt)}`);

    closeDb();
}

main().catch((err) => {
    console.error('Fatal error:', err);
    closeDb();
    process.exit(1);
});
