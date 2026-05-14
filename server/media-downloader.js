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

export async function downloadLectureVideo(lecture, { onProgress = () => { }, force = false, signal } = {}) {
    if (lecture.video_provider !== VIDEO_PROVIDERS.HOTMART) {
        return { skipped: true, reason: `provider ${lecture.video_provider} not handled by this module` };
    }
    if (signal?.aborted) return { skipped: true, reason: 'aborted' };

    // Idempotency: trust any complete N≥1 recorded path-set with all files on
    // disk. Single-path records used to be treated as incomplete (re-dwell
    // every run), but once a course has been re-archived under the multi-video
    // code the record is authoritative. Force-rescrape or force=true busts it.
    if (!force && lecture.video_local_paths) {
        try {
            const recorded = JSON.parse(lecture.video_local_paths);
            if (Array.isArray(recorded) && recorded.length >= 1) {
                const allExist = recorded.every(p => {
                    try { return fs.existsSync(resolveRelative(p)); } catch { return false; }
                });
                if (allExist) {
                    return { skipped: true, reason: 'already archived' };
                }
            }
        } catch { /* malformed JSON — fall through and re-check */ }
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

    // The scraper records the iframe embed IDs in DOM order. If they're absent
    // (legacy row from before this fix) we'll re-extract from the page below.
    let domEmbedIds = [];
    try {
        if (lecture.video_embed_ids) {
            const parsed = JSON.parse(lecture.video_embed_ids);
            if (Array.isArray(parsed)) domEmbedIds = parsed.filter(Boolean);
        }
    } catch { /* fall through */ }

    // If the caller aborts while we hold the Puppeteer browser open, force-close
    // it so the dwell timer doesn't hold cleanup hostage for ~20 seconds.
    const onAbortClose = () => { browser.close().catch(() => { /* ignore */ }); };
    signal?.addEventListener('abort', onAbortClose, { once: true });

    try {
        try {
            await page.goto(lectureUrl, { waitUntil: 'networkidle2', timeout: NAVIGATE_TIMEOUT_MS });
        } catch (err) {
            if (signal?.aborted) return { skipped: true, reason: 'aborted' };
            return { error: 'Navigation failed', details: err.message };
        }

        // Always re-read iframe embed IDs from the live page so the archiver
        // doesn't rely on stale scraper output. If the lecture row has IDs
        // recorded, they take precedence for the eventual ordering.
        const liveEmbedIds = await page.evaluate(() => {
            const frames = document.querySelectorAll('iframe[src*="hotmart"], iframe[src*="cf-embed"], iframe[src*="player.hotmart"]');
            return [...frames].map(f => {
                const src = f.src || '';
                const m = src.match(/\/embed\/([A-Za-z0-9_-]+)/);
                return m ? m[1] : null;
            }).filter(Boolean);
        }).catch(() => []);
        if (domEmbedIds.length === 0) domEmbedIds = liveEmbedIds;

        if (liveEmbedIds.length > 1) {
            // Scroll each iframe into view in DOM order so the embedded players
            // load their manifests sequentially — keeps capture order
            // deterministic instead of racing on page settle.
            onProgress(`Found ${liveEmbedIds.length} video embeds — scanning in document order...`, 3);
            const PER_IFRAME_DWELL = 6000;
            for (let i = 0; i < liveEmbedIds.length; i++) {
                if (signal?.aborted) break;
                try {
                    await page.evaluate((idx) => {
                        const fs = document.querySelectorAll('iframe[src*="hotmart"], iframe[src*="cf-embed"], iframe[src*="player.hotmart"]');
                        if (fs[idx]) fs[idx].scrollIntoView({ block: 'center', behavior: 'instant' });
                    }, i);
                } catch { /* page navigated away */ }
                onProgress(`Scanning video ${i + 1}/${liveEmbedIds.length}...`, 3 + Math.round((i / liveEmbedIds.length) * 6));
                await abortableSleep(PER_IFRAME_DWELL, signal);
            }
        } else {
            onProgress(`Waiting ${HLS_DWELL_MS / 1000}s for player to load manifest...`, 5);
            await abortableSleep(HLS_DWELL_MS, signal);
        }
        if (signal?.aborted) return { skipped: true, reason: 'aborted' };
    } finally {
        signal?.removeEventListener('abort', onAbortClose);
        await browser.close().catch(() => { /* ignore — may already be closed by abort handler */ });
    }

    if (manifests.length === 0) {
        return { error: 'No HLS manifest captured within dwell window' };
    }

    // Dedupe by URL parent directory (quality variants of one video share a
    // parent path on Hotmart's CDN). Keep insertion order so document-order
    // scrolling translates to ordered downloads.
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
    // Total-known signal: emit once with videoTotal so the UI can keep showing
    // "Video X/N" through the rest of the lecture instead of losing the count
    // after the next text message replaces it.
    onProgress(`Found ${masterList.length} video(s) on this lecture page`, 10, { videoTotal: masterList.length });

    const dir = lectureDir(lecture.course_id, lecture.id);
    const downloadedPaths = [];
    const sizesBytes = [];
    const durationsSec = [];

    for (let i = 0; i < masterList.length; i++) {
        if (signal?.aborted) return { skipped: true, reason: 'aborted' };
        const master = masterList[i];
        const videoInfo = { videoIndex: i + 1, videoTotal: masterList.length };
        // Wrap onProgress so every ffmpeg-line callback gets tagged with the
        // current video's index — the orchestrator merges this into the SSE
        // event so the UI can render "Video N/M" for the whole download.
        const onProgressForVideo = (msg, pct) => onProgress(msg, pct, videoInfo);

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
            onProgress(`Video ${i + 1}/${masterList.length}: already exists, skipping`, Math.round(15 + (i / masterList.length) * 80), videoInfo);
            continue;
        }

        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);

        // ffmpeg replays the headers Hotmart's player set so the CDN accepts the request
        const headerArg = Object.entries(master.headers)
            .filter(([k]) => k.toLowerCase() !== 'host' && !k.startsWith(':'))
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') + '\r\n';

        // Probe the manifest upfront so we can detect truncated downloads
        // (ffmpeg-exit-0 with output shorter than the playlist claimed). Best-
        // effort: probe failures don't block the download, just leave us
        // without a denominator for the post-flight completeness check.
        let expectedDurationSec = null;
        let hasEndList = null;
        try {
            const probe = await probeManifestDuration(master.url, master.headers, signal);
            expectedDurationSec = probe.durationSec || null;
            hasEndList = probe.hasEndList;
            if (!hasEndList) {
                console.warn(`[archive] lecture ${lecture.id} video ${i + 1} manifest missing EXT-X-ENDLIST — ffmpeg may treat as live and truncate`);
            }
        } catch (probeErr) {
            console.warn(`[archive] lecture ${lecture.id} video ${i + 1} manifest probe failed: ${probeErr.message}`);
        }

        onProgress(`Downloading video ${i + 1}/${masterList.length} via ffmpeg...`, Math.round(15 + (i / masterList.length) * 80), videoInfo);

        let ffStderrTail = '';
        try {
            const ffResult = await runFfmpeg([
                '-y',
                '-headers', headerArg,
                '-i', master.url,
                '-c', 'copy',
                // Force mp4 output container — the `.partial` extension prevents ffmpeg
                // from inferring the format from the filename.
                '-f', 'mp4',
                tmpDest,
            ], onProgressForVideo, signal);
            ffStderrTail = ffResult?.stderrTail || '';
        } catch (err) {
            if (fs.existsSync(tmpDest)) {
                try { fs.unlinkSync(tmpDest); } catch { /* ignore */ }
            }
            if (signal?.aborted || err.message === 'aborted') {
                return { skipped: true, reason: 'aborted' };
            }
            // Per-video failure: persist for diagnosis, console-warn the full
            // stderr tail (already embedded in err.message by runFfmpeg), then
            // continue with the remaining videos so one bad manifest doesn't
            // kill the whole multi-video archive.
            console.warn(`[archive] lecture ${lecture.id} video ${i + 1}/${masterList.length} (${filename}) failed:\n${err.message}`);
            try {
                getDb().prepare(`
                    INSERT INTO archive_failures (lecture_id, video_index, filename, error_message, attempted_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(lecture_id, video_index) DO UPDATE SET
                        filename = excluded.filename,
                        error_message = excluded.error_message,
                        attempted_at = excluded.attempted_at
                `).run(lecture.id, i + 1, filename, String(err.message || 'unknown error'));
            } catch (dbErr) {
                console.warn(`[archive] failed to record archive_failures row: ${dbErr.message}`);
            }
            onProgress(`Video ${i + 1} failed: ${err.message}`, null, {
                ...videoInfo,
                videoError: true,
                errorMessage: String(err.message || ''),
                filename,
            });
            continue;
        }

        fs.renameSync(tmpDest, dest);
        downloadedPaths.push(relativize(dest));
        try { sizesBytes.push(fs.statSync(dest).size); } catch { sizesBytes.push(null); }
        let actualDurationSec = null;
        try {
            actualDurationSec = await probeDuration(dest);
            durationsSec.push(actualDurationSec);
        } catch {
            durationsSec.push(null);
        }

        // Truncation check: if we know what the manifest claimed and the
        // file came back short, ffmpeg exited code 0 but the download is
        // incomplete (most often: live-style playlist with no ENDLIST). Mark
        // as failure with the stderr tail so the next archive run retries.
        const truncated = (
            expectedDurationSec && actualDurationSec &&
            actualDurationSec < expectedDurationSec * 0.95
        );
        if (truncated) {
            const pct = (actualDurationSec / expectedDurationSec * 100).toFixed(1);
            const reason = `truncated: got ${actualDurationSec.toFixed(1)}s of ${expectedDurationSec.toFixed(1)}s expected (${pct}%)${hasEndList === false ? ' — manifest missing EXT-X-ENDLIST' : ''}`;
            const errorMsg = `${reason}\n--- ffmpeg stderr tail ---\n${ffStderrTail}`;
            console.warn(`[archive] lecture ${lecture.id} video ${i + 1}/${masterList.length} ${reason}`);
            try {
                getDb().prepare(`
                    INSERT INTO archive_failures (lecture_id, video_index, filename, error_message, attempted_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(lecture_id, video_index) DO UPDATE SET
                        filename = excluded.filename,
                        error_message = excluded.error_message,
                        attempted_at = excluded.attempted_at
                `).run(lecture.id, i + 1, filename, errorMsg);
            } catch (dbErr) {
                console.warn(`[archive] failed to record truncation row: ${dbErr.message}`);
            }
            onProgress(`Video ${i + 1} truncated: ${reason}`, null, {
                ...videoInfo,
                videoError: true,
                errorMessage: reason,
                filename,
            });
        } else {
            // Successful download — clear any prior failure row for this slot.
            try {
                getDb().prepare("DELETE FROM archive_failures WHERE lecture_id = ? AND video_index = ?")
                    .run(lecture.id, i + 1);
            } catch { /* ignore */ }
        }

        // Persist the expected duration for this lecture (max across its videos
        // — they shouldn't differ, but in a multi-video lecture we want the
        // largest known number to compare against future cached-skip checks).
        if (expectedDurationSec) {
            try {
                const current = getDb().prepare('SELECT video_expected_duration_sec FROM course_lectures WHERE id = ?').get(lecture.id);
                const prev = current?.video_expected_duration_sec || 0;
                const next = Math.max(prev, expectedDurationSec);
                if (next > prev) {
                    getDb().prepare('UPDATE course_lectures SET video_expected_duration_sec = ? WHERE id = ?').run(next, lecture.id);
                }
            } catch { /* best-effort */ }
        }
    }

    if (downloadedPaths.length === 0) {
        return { error: 'All video downloads failed' };
    }

    // Aggregate totals
    const totalSize = sizesBytes.reduce((sum, s) => sum + (s || 0), 0);
    const totalDuration = durationsSec.reduce((sum, d) => sum + (d || 0), 0);
    const firstPath = downloadedPaths[0];

    // Persist to DB — update legacy single-path, the array column, and (when we
    // re-extracted embed IDs from the page) the embed-id sequence so the
    // archiver's source of truth stays consistent with what we just downloaded.
    const db = getDb();
    db.prepare(`
        UPDATE course_lectures
        SET video_local_path = ?,
            video_local_paths = ?,
            video_duration_sec = ?,
            video_downloaded_at = ?
        WHERE id = ?
    `).run(firstPath, JSON.stringify(downloadedPaths), totalDuration || null, new Date().toISOString(), lecture.id);
    if (domEmbedIds.length > 0) {
        db.prepare('UPDATE course_lectures SET video_embed_ids = ? WHERE id = ?')
            .run(JSON.stringify(domEmbedIds), lecture.id);
    }

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
        videoTotal: masterList.length,     // includes per-video failures
        videoFailed: masterList.length - downloadedPaths.length,
    };
}

// Sleep that resolves early when the signal aborts (instead of holding the
// caller for the full duration). Used for the Hotmart Puppeteer dwell so cancel
// doesn't have to wait out the ~20s timer.
function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function runFfmpeg(args, onProgress, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        const ff = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let abortedByUs = false;
        const onAbort = () => {
            abortedByUs = true;
            try { ff.kill('SIGKILL'); } catch { /* already exited */ }
        };
        signal?.addEventListener('abort', onAbort, { once: true });

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
            signal?.removeEventListener('abort', onAbort);
            if (abortedByUs || signal?.aborted) return reject(new Error('aborted'));
            const stderrTail = stderr.split('\n').slice(-30).join('\n');
            if (code === 0) resolve({ stderrTail });
            else reject(new Error(`ffmpeg exit ${code}\n${stderrTail}`));
        });
        ff.on('error', (err) => {
            signal?.removeEventListener('abort', onAbort);
            reject(err);
        });
    });
}

// Fetch an HLS master playlist, follow to the first variant if needed, and
// sum its #EXTINF segment durations. Returns the total in seconds plus a
// boolean for whether the variant carried EXT-X-ENDLIST (its absence is a
// reliable predictor of ffmpeg truncating the download because it assumes
// a live stream that stopped emitting).
async function probeManifestDuration(masterUrl, requestHeaders = {}, signal) {
    const fetchText = async (url) => {
        const r = await fetch(url, { headers: requestHeaders, signal });
        if (!r.ok) throw new Error(`m3u8 ${r.status} ${r.statusText}`);
        return await r.text();
    };
    const masterText = await fetchText(masterUrl);
    const masterLines = masterText.split('\n');
    const isMaster = masterLines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

    let mediaText = masterText;
    if (isMaster) {
        // First non-comment line after a STREAM-INF declaration is the variant URL
        let nextIsVariant = false;
        let variantPath = null;
        for (const line of masterLines) {
            if (line.startsWith('#EXT-X-STREAM-INF')) { nextIsVariant = true; continue; }
            const trimmed = line.trim();
            if (nextIsVariant && trimmed && !trimmed.startsWith('#')) {
                variantPath = trimmed;
                break;
            }
        }
        if (!variantPath) throw new Error('master playlist had no variant URL');
        // Resolve relative URLs; Hotmart's variant references drop the auth
        // query string so we have to copy the master's `?hdnts=…` token across
        // or the CDN returns 403.
        const masterParsed = new URL(masterUrl);
        const variantParsed = new URL(variantPath, masterUrl);
        if (variantParsed.host === masterParsed.host && !variantParsed.search) {
            variantParsed.search = masterParsed.search;
        }
        mediaText = await fetchText(variantParsed.toString());
    }

    let durationSec = 0;
    let hasEndList = false;
    for (const line of mediaText.split('\n')) {
        const m = line.match(/^#EXTINF:([\d.]+)/);
        if (m) durationSec += parseFloat(m[1]);
        if (line.trim().startsWith('#EXT-X-ENDLIST')) hasEndList = true;
    }
    return { durationSec, hasEndList };
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
