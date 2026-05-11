// Set BEFORE any import that transitively imports media-library.js, so we don't
// try to mkdir on the GMLDAS volume during --help / arg-parsing. Node ESM
// hoists static imports above top-level code, so we use dynamic import() below
// to ensure this runs first.
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
    try { closeDb(); } catch { /* db may not be open */ }
    process.exit(1);
});
