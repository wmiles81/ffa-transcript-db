import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { createAuthenticatedBrowser } from './scraper.js';
import { lectureDir, relativize, resolveRelative } from './media-library.js';
import { VIDEO_PROVIDERS } from './media-providers.js';
import { getDb } from './db.js';

// Verified by deeper-dwell probe — 1/10 cases needed >10s, so use 20s for safety
const HLS_DWELL_MS = 20_000;
const NAVIGATE_TIMEOUT_MS = 30_000;
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const SCHOOL_URL = process.env.TEACHABLE_SCHOOL_URL || 'https://future-fiction-academy.teachable.com';

export async function downloadLectureVideo(lecture, { onProgress = () => { }, force = false } = {}) {
    if (lecture.video_provider !== VIDEO_PROVIDERS.HOTMART) {
        return { skipped: true, reason: `provider ${lecture.video_provider} not handled by this module` };
    }

    // Idempotency: if a path is recorded AND the file exists, skip. If the path
    // is recorded but the file is gone, fall through and re-download.
    // force=true bypasses this check so the download runs again.
    if (!force && lecture.video_local_path) {
        try {
            const fullPath = resolveRelative(lecture.video_local_path);
            if (fs.existsSync(fullPath)) {
                return { skipped: true, reason: 'already archived' };
            }
        } catch (_) { /* invalid stored path — re-download */ }
    }

    const lectureUrl = lecture.url.startsWith('http')
        ? lecture.url
        : `${SCHOOL_URL}${lecture.url}`;

    onProgress(`Opening lecture page (${lectureUrl})...`, 0);

    // Re-resolve master URL via Puppeteer — Hotmart manifest URLs are session-bound and short-lived
    const { browser, page } = await createAuthenticatedBrowser();
    const manifests = [];
    page.on('request', (req) => {
        if (req.url().toLowerCase().includes('.m3u8')) {
            manifests.push({ url: req.url(), headers: req.headers() });
        }
    });

    try {
        try {
            await page.goto(lectureUrl, { waitUntil: 'networkidle2', timeout: NAVIGATE_TIMEOUT_MS });
        } catch (err) {
            return { error: 'Navigation failed', details: err.message };
        }

        onProgress(`Waiting ${HLS_DWELL_MS / 1000}s for player to load manifest...`, 5);
        await new Promise((r) => setTimeout(r, HLS_DWELL_MS));
    } finally {
        await browser.close();
    }

    if (manifests.length === 0) {
        return { error: 'No HLS manifest captured within dwell window' };
    }

    const master = manifests[0];
    const dir = lectureDir(lecture.course_id, lecture.id);
    const dest = path.join(dir, 'video.mp4');
    // Atomic rename strategy — crash-safe idempotency: if ffmpeg dies mid-write,
    // no video.mp4 exists and the next run retries cleanly.
    const tmpDest = path.join(dir, 'video.mp4.partial');

    if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);

    // ffmpeg replays the headers Hotmart's player set so the CDN accepts the request
    const headerArg = Object.entries(master.headers)
        .filter(([k]) => k.toLowerCase() !== 'host' && !k.startsWith(':'))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n';

    onProgress('Downloading via ffmpeg...', 15);

    try {
        await runFfmpeg([
            '-y',
            '-headers', headerArg,
            '-i', master.url,
            '-c', 'copy',
            // Force mp4 output container — the `.partial` extension prevents ffmpeg
            // from inferring the format from the filename.
            '-f', 'mp4',
            tmpDest,
        ], onProgress);
    } catch (err) {
        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
        return { error: 'ffmpeg failed', details: err.message };
    }

    fs.renameSync(tmpDest, dest);

    const durationSec = await probeDuration(dest);
    const stat = fs.statSync(dest);

    const db = getDb();
    db.prepare(
        'UPDATE course_lectures SET video_local_path = ?, video_duration_sec = ?, video_downloaded_at = ? WHERE id = ?'
    ).run(relativize(dest), durationSec, new Date().toISOString(), lecture.id);

    onProgress(
        `Downloaded ${(stat.size / 1024 / 1024).toFixed(1)} MB${durationSec ? ` (${durationSec}s of video)` : ''}`,
        100
    );
    return { ok: true, path: dest, sizeBytes: stat.size, durationSec };
}

function runFfmpeg(args, onProgress) {
    return new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => {
            const s = d.toString();
            stderr += s;
            // Parse "time=HH:MM:SS.ms" lines for elapsed-video updates. We don't know
            // total duration mid-stream, so we emit textual updates rather than %.
            const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
            if (m) {
                onProgress(`ffmpeg: ${m[1]}:${m[2]}:${m[3]} of video processed`);
            }
        });
        ff.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exit ${code}\n${stderr.split('\n').slice(-30).join('\n')}`));
        });
        ff.on('error', reject);
    });
}

// Returns null on any failure — duration probing is best-effort, never fatal
function probeDuration(filePath) {
    return new Promise((resolve) => {
        const ff = spawn(FFMPEG_BIN, ['-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', () => {
            const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})/);
            if (m) {
                resolve(+m[1] * 3600 + +m[2] * 60 + +m[3]);
            } else {
                resolve(null);
            }
        });
        ff.on('error', () => resolve(null));
    });
}
