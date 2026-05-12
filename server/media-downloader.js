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

    // Dedupe by URL pathname — different videos have different paths; quality variants
    // of the same video share the same parent directory path.
    // Strategy: group by parent directory of the .m3u8 URL and keep only the first
    // captured URL per parent. For Hotmart, each distinct video lives in a distinct
    // CDN directory, so one entry per directory = one master playlist per video.
    const byParent = new Map();
    for (const m of manifests) {
        try {
            const u = new URL(m.url);
            const fullPath = `${u.origin}${u.pathname}`;
            const parent = fullPath.substring(0, fullPath.lastIndexOf('/'));
            if (!byParent.has(parent)) byParent.set(parent, m);
        } catch {
            // malformed URL — skip
        }
    }

    const masterList = [...byParent.values()];
    onProgress(`Found ${masterList.length} video(s) on this lecture page`, 10);

    const dir = lectureDir(lecture.course_id, lecture.id);
    const downloadedPaths = [];
    const sizesBytes = [];
    const durationsSec = [];

    for (let i = 0; i < masterList.length; i++) {
        const master = masterList[i];
        // Naming: video.mp4 for the first (back-compat), video_2.mp4, video_3.mp4 for the rest
        const filename = i === 0 ? 'video.mp4' : `video_${i + 1}.mp4`;
        const dest = path.join(dir, filename);
        // Atomic rename strategy — crash-safe idempotency
        const tmpDest = path.join(dir, `${filename}.partial`);

        // Skip if already exists AND force is not set
        if (fs.existsSync(dest) && !force) {
            downloadedPaths.push(relativize(dest));
            try { sizesBytes.push(fs.statSync(dest).size); } catch { sizesBytes.push(null); }
            durationsSec.push(null); // re-probe deferred
            onProgress(`Video ${i + 1}/${masterList.length}: already exists, skipping`, Math.round(15 + (i / masterList.length) * 80));
            continue;
        }

        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);

        // ffmpeg replays the headers Hotmart's player set so the CDN accepts the request
        const headerArg = Object.entries(master.headers)
            .filter(([k]) => k.toLowerCase() !== 'host' && !k.startsWith(':'))
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') + '\r\n';

        onProgress(`Downloading video ${i + 1}/${masterList.length} via ffmpeg...`, Math.round(15 + (i / masterList.length) * 80));

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
            // Per-video failure: log but continue with remaining videos
            onProgress(`Video ${i + 1} failed: ${err.message}`, null);
            continue;
        }

        fs.renameSync(tmpDest, dest);
        downloadedPaths.push(relativize(dest));
        try { sizesBytes.push(fs.statSync(dest).size); } catch { sizesBytes.push(null); }
        try {
            const d = await probeDuration(dest);
            durationsSec.push(d);
        } catch {
            durationsSec.push(null);
        }
    }

    if (downloadedPaths.length === 0) {
        return { error: 'All video downloads failed' };
    }

    // Aggregate totals
    const totalSize = sizesBytes.reduce((sum, s) => sum + (s || 0), 0);
    const totalDuration = durationsSec.reduce((sum, d) => sum + (d || 0), 0);
    const firstPath = downloadedPaths[0];

    // Persist to DB — update both the legacy single-path column and the new array column
    const db = getDb();
    db.prepare(`
        UPDATE course_lectures
        SET video_local_path = ?,
            video_local_paths = ?,
            video_duration_sec = ?,
            video_downloaded_at = ?
        WHERE id = ?
    `).run(firstPath, JSON.stringify(downloadedPaths), totalDuration || null, new Date().toISOString(), lecture.id);

    onProgress(
        `Downloaded ${downloadedPaths.length} video(s), ${(totalSize / 1024 / 1024).toFixed(1)} MB total${totalDuration ? ` (${totalDuration}s of video)` : ''}`,
        100
    );
    return {
        ok: true,
        path: firstPath,                  // legacy single-path field
        paths: downloadedPaths,            // new array field
        sizeBytes: totalSize,              // total across all videos
        durationSec: totalDuration || null,
        videoCount: downloadedPaths.length,
    };
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
