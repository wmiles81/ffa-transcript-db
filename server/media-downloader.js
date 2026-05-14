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

    // Re-resolve master URL via Puppeteer — Hotmart manifest URLs are session-bound and short-lived.
    //
    // Capture two kinds of request as an ordered event stream:
    //  • Iframe page loads at `…/embed/<embedId>` (the Hotmart player URL).
    //    These tell us WHICH iframe is starting to load right now.
    //  • The HLS master/variant playlists that follow (`.m3u8`). These get
    //    attributed to the most recently seen embed_id, because that's the
    //    iframe whose player is firing them.
    //
    // This replaces the previous "capture any .m3u8 in network order" approach,
    // which produced non-deterministic file ordering for multi-video lectures
    // (Hotmart's iframes load asynchronously). With the event stream + embed
    // attribution, masterList ends up in DOM order regardless of player race
    // conditions on page load.
    const { browser, page } = await createAuthenticatedBrowser();
    const events = []; // ordered: { type: 'embed'|'m3u8', embedId?, url, headers }
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('hotmart')) {
            const embedMatch = url.match(/\/embed\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
            if (embedMatch) {
                events.push({ type: 'embed', embedId: embedMatch[1], url, headers: req.headers() });
                return;
            }
        }
        if (url.toLowerCase().includes('.m3u8')) {
            events.push({ type: 'm3u8', url, headers: req.headers() });
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

    if (events.filter(e => e.type === 'm3u8').length === 0) {
        return { error: 'No HLS manifest captured within dwell window' };
    }

    // Walk the event stream: every m3u8 belongs to the most recent /embed/<id>
    // request, which is the iframe that fired it. This pairs each captured
    // manifest with its source iframe deterministically, regardless of the
    // network-event order between iframes.
    const manifestsByEmbed = new Map();
    let currentEmbedId = null;
    for (const ev of events) {
        if (ev.type === 'embed') {
            currentEmbedId = ev.embedId;
            if (!manifestsByEmbed.has(currentEmbedId)) manifestsByEmbed.set(currentEmbedId, []);
        } else if (ev.type === 'm3u8' && currentEmbedId != null) {
            manifestsByEmbed.get(currentEmbedId).push({ url: ev.url, headers: ev.headers });
        }
    }

    // Build the master list in DOM order using liveEmbedIds (a static-DOM
    // querySelectorAll, so its order matches the page's actual layout). For
    // each DOM slot, pick the first dedupe-by-parent manifest seen on that
    // iframe's player. Slots with no captured manifest are skipped — the
    // archive becomes sparse instead of misnaming files. Single-iframe and
    // no-iframe pages fall back to a flat dedupe of all m3u8 events.
    const masterList = []; // [{ url, headers, embedId, domIndex }]
    if (liveEmbedIds.length > 0) {
        for (let domIndex = 0; domIndex < liveEmbedIds.length; domIndex++) {
            const embedId = liveEmbedIds[domIndex];
            const m3u8s = manifestsByEmbed.get(embedId) || [];
            if (m3u8s.length === 0) continue;
            const byParent = new Map();
            for (const m of m3u8s) {
                try {
                    const u = new URL(m.url);
                    const parent = `${u.origin}${u.pathname.substring(0, u.pathname.lastIndexOf('/'))}`;
                    if (!byParent.has(parent)) byParent.set(parent, m);
                } catch { /* skip malformed URL */ }
            }
            const master = [...byParent.values()][0];
            if (master) masterList.push({ ...master, embedId, domIndex });
        }
    } else {
        const flat = events.filter(e => e.type === 'm3u8');
        const byParent = new Map();
        for (const m of flat) {
            try {
                const u = new URL(m.url);
                const parent = `${u.origin}${u.pathname.substring(0, u.pathname.lastIndexOf('/'))}`;
                if (!byParent.has(parent)) byParent.set(parent, m);
            } catch { /* skip */ }
        }
        let i = 0;
        for (const m of byParent.values()) {
            masterList.push({ ...m, embedId: null, domIndex: i });
            i++;
        }
    }

    if (masterList.length === 0) {
        return { error: 'No HLS manifest could be attributed to any iframe' };
    }
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
        const entry = masterList[i];
        const master = { url: entry.url, headers: entry.headers };
        const domIndex = entry.domIndex;
        const videoInfo = { videoIndex: i + 1, videoTotal: masterList.length, domIndex };
        // Wrap onProgress so every ffmpeg-line callback gets tagged with the
        // current video's index — the orchestrator merges this into the SSE
        // event so the UI can render "Video N/M" for the whole download.
        const onProgressForVideo = (msg, pct) => onProgress(msg, pct, videoInfo);

        // Naming is by DOM index (the position of this iframe on the lecture
        // page), not by capture order. If liveEmbedIds had a gap (some iframe
        // produced no m3u8), the filename for the following DOM slot still
        // reflects its true DOM position — so a 3-of-5 archive produces
        // video.mp4 / video_3.mp4 / video_5.mp4 instead of squishing onto
        // video.mp4 / video_2.mp4 / video_3.mp4 (which would misalign tabs
        // with the per-video transcript chunks).
        const filename = domIndex === 0 ? 'video.mp4' : `video_${domIndex + 1}.mp4`;
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
                `).run(lecture.id, domIndex + 1, filename, String(err.message || 'unknown error'));
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
                `).run(lecture.id, domIndex + 1, filename, errorMsg);
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
                    .run(lecture.id, domIndex + 1);
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

/**
 * Repair a multi-video lecture whose mp4 files on disk are in capture
 * (network-event) order rather than DOM (on-page) order. Re-opens the lecture
 * page, captures manifests in DOM order via iframe scroll, probes each
 * manifest's expected duration, then greedy-matches each DOM position to the
 * existing file with the closest actual duration. Files are renamed atomically
 * (rename-to-temp, then rename-to-final) so a mid-flight failure leaves the
 * pre-existing files recoverable.
 *
 * Returns { plan: [{ domIndex, expectedSec, matchedFile, actualSec, finalName }],
 *           unmatchedDomPositions, summary }.
 * Throws if the page can't load or if no manifests are captured.
 */
export async function reorderLectureVideosByDom(lectureId, { dryRun = false } = {}) {
    const db = getDb();
    const lecture = db.prepare(
        'SELECT id, course_id, url, video_local_paths FROM course_lectures WHERE id = ?'
    ).get(lectureId);
    if (!lecture) throw new Error(`No lecture with id ${lectureId}`);
    if (!lecture.video_local_paths) throw new Error('Lecture has no archived videos');

    let recordedPaths;
    try { recordedPaths = JSON.parse(lecture.video_local_paths); }
    catch { throw new Error('video_local_paths is malformed JSON'); }
    if (!Array.isArray(recordedPaths) || recordedPaths.length === 0) {
        throw new Error('video_local_paths is empty');
    }

    const lectureUrl = lecture.url.startsWith('http')
        ? lecture.url
        : `${SCHOOL_URL}${lecture.url}`;

    const { browser, page } = await createAuthenticatedBrowser();
    // Same event-stream + embed-id attribution that downloadLectureVideo
    // uses. Network-completion order between iframes isn't reliable on
    // Hotmart, so we don't trust it — we pair each captured m3u8 with the
    // most recent /embed/<id> request, which is the iframe whose player
    // produced it.
    const events = [];
    page.on('request', (req) => {
        const url = req.url();
        if (url.includes('hotmart')) {
            const embedMatch = url.match(/\/embed\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
            if (embedMatch) {
                events.push({ type: 'embed', embedId: embedMatch[1], url, headers: req.headers() });
                return;
            }
        }
        if (url.toLowerCase().includes('.m3u8')) {
            events.push({ type: 'm3u8', url, headers: req.headers() });
        }
    });

    try {
        await page.goto(lectureUrl, { waitUntil: 'networkidle2', timeout: NAVIGATE_TIMEOUT_MS });

        const liveEmbedIds = await page.evaluate(() => {
            const frames = document.querySelectorAll('iframe[src*="hotmart"], iframe[src*="cf-embed"], iframe[src*="player.hotmart"]');
            return [...frames].map(f => {
                const src = f.src || '';
                const m = src.match(/\/embed\/([A-Za-z0-9_-]+)/);
                return m ? m[1] : null;
            }).filter(Boolean);
        }).catch(() => []);

        if (liveEmbedIds.length > 1) {
            const PER_IFRAME_DWELL = 6000;
            for (let i = 0; i < liveEmbedIds.length; i++) {
                try {
                    await page.evaluate((idx) => {
                        const fs = document.querySelectorAll('iframe[src*="hotmart"], iframe[src*="cf-embed"], iframe[src*="player.hotmart"]');
                        if (fs[idx]) fs[idx].scrollIntoView({ block: 'center', behavior: 'instant' });
                    }, i);
                } catch { /* page navigated */ }
                await new Promise(r => setTimeout(r, PER_IFRAME_DWELL));
            }
        } else {
            await new Promise(r => setTimeout(r, HLS_DWELL_MS));
        }

        // Group captured m3u8s by their preceding /embed/<id> request, then
        // build masterList in DOM order using liveEmbedIds (static DOM order).
        const manifestsByEmbed = new Map();
        let currentEmbedId = null;
        for (const ev of events) {
            if (ev.type === 'embed') {
                currentEmbedId = ev.embedId;
                if (!manifestsByEmbed.has(currentEmbedId)) manifestsByEmbed.set(currentEmbedId, []);
            } else if (ev.type === 'm3u8' && currentEmbedId != null) {
                manifestsByEmbed.get(currentEmbedId).push({ url: ev.url, headers: ev.headers });
            }
        }
        const masterList = [];
        for (let domIndex = 0; domIndex < liveEmbedIds.length; domIndex++) {
            const embedId = liveEmbedIds[domIndex];
            const m3u8s = manifestsByEmbed.get(embedId) || [];
            if (m3u8s.length === 0) continue;
            const byParent = new Map();
            for (const m of m3u8s) {
                try {
                    const u = new URL(m.url);
                    const parent = `${u.origin}${u.pathname.substring(0, u.pathname.lastIndexOf('/'))}`;
                    if (!byParent.has(parent)) byParent.set(parent, m);
                } catch { /* skip */ }
            }
            const master = [...byParent.values()][0];
            if (master) masterList.push({ ...master, embedId, domIndex });
        }
        if (masterList.length === 0) throw new Error('No HLS manifests captured');

        // Expected duration per DOM-ordered manifest. domIndex matches the
        // iframe's true position on the page, not capture-completion order.
        const expected = [];
        for (const entry of masterList) {
            let durationSec = null;
            try {
                const probe = await probeManifestDuration(entry.url, entry.headers);
                durationSec = probe.durationSec || null;
            } catch (e) {
                console.warn(`[reorder] lecture ${lectureId} DOM pos ${entry.domIndex} manifest probe failed: ${e.message}`);
            }
            expected.push({ domIndex: entry.domIndex, expectedSec: durationSec });
        }
        // Fill in nulls for any DOM slots that had no manifest capture so the
        // downstream matcher sees a complete picture (and the all-or-nothing
        // probe guard can detect partial coverage).
        const coveredDom = new Set(expected.map(e => e.domIndex));
        for (let d = 0; d < liveEmbedIds.length; d++) {
            if (!coveredDom.has(d)) expected.push({ domIndex: d, expectedSec: null });
        }
        expected.sort((a, b) => a.domIndex - b.domIndex);

        // Actual duration per existing file
        const actual = [];
        for (const relPath of recordedPaths) {
            const absPath = resolveRelative(relPath);
            const exists = fs.existsSync(absPath);
            const dur = exists ? await probeDuration(absPath) : null;
            actual.push({ relPath, absPath, actualSec: dur, exists });
        }

        // Globally-optimal greedy: enumerate every (domIndex, file) candidate
        // pair within tolerance, sort by smallest |expected - actual| first,
        // and claim pairs in that order. This avoids the trap of an early DOM
        // position grabbing a file that's actually a much better fit for a
        // later DOM position. 60s tolerance covers container-metadata rounding
        // plus a comfortable margin without admitting nonsense matches.
        const TOLERANCE_SEC = 60;
        const candidates = [];
        for (const e of expected) {
            if (e.expectedSec == null) continue;
            for (let j = 0; j < actual.length; j++) {
                if (!actual[j].exists || actual[j].actualSec == null) continue;
                const diff = Math.abs(actual[j].actualSec - e.expectedSec);
                if (diff <= TOLERANCE_SEC) {
                    candidates.push({ domIndex: e.domIndex, fileIdx: j, diff });
                }
            }
        }
        candidates.sort((a, b) => a.diff - b.diff);
        const claimedDom = new Set();
        const claimedFile = new Set();
        const matchByDom = new Map();
        for (const c of candidates) {
            if (claimedDom.has(c.domIndex) || claimedFile.has(c.fileIdx)) continue;
            matchByDom.set(c.domIndex, c);
            claimedDom.add(c.domIndex);
            claimedFile.add(c.fileIdx);
        }
        const plan = [];
        for (const e of expected) {
            const m = matchByDom.get(e.domIndex);
            if (!m) {
                plan.push({
                    domIndex: e.domIndex,
                    expectedSec: e.expectedSec,
                    matchedFile: null,
                    actualSec: null,
                    finalName: nameForDomIndex(e.domIndex),
                });
            } else {
                plan.push({
                    domIndex: e.domIndex,
                    expectedSec: e.expectedSec,
                    matchedFile: actual[m.fileIdx].relPath,
                    matchedAbs: actual[m.fileIdx].absPath,
                    actualSec: actual[m.fileIdx].actualSec,
                    diff: m.diff,
                    finalName: nameForDomIndex(e.domIndex),
                });
            }
        }

        const unmatchedDom = plan.filter(p => !p.matchedFile).map(p => p.domIndex);

        // Safety guard: if the page reload captured fewer manifests than the
        // files we already have on disk, something went wrong with the
        // capture (token expired, transient player state, etc.) — refuse to
        // proceed. The previous version of this function could clobber a
        // surviving file by renaming an un-temp'd target on top of it.
        const existingCount = actual.filter(a => a.exists).length;
        if (masterList.length < existingCount) {
            throw new Error(`captured ${masterList.length} manifest(s) but ${existingCount} file(s) exist on disk — likely a transient page-load issue, refusing to proceed`);
        }

        // Stricter guard: if probeManifestDuration failed for any DOM position
        // (e.g., Hotmart's per-manifest auth token expired before we could
        // fetch its variant playlist), the matcher only has expected durations
        // for a subset of slots. Stage 2 then renames only a few files; Stage 3
        // tries to restore the rest to their original names but those slots
        // may already be occupied by Stage 2's placements, leaving orphan
        // .reorder-tmp-N files. Better to refuse the whole operation than
        // ship the user a partial state.
        const probedCount = expected.filter(e => e.expectedSec != null).length;
        if (probedCount < expected.length) {
            throw new Error(`only probed ${probedCount} of ${expected.length} manifest durations — refusing to proceed (Hotmart's tokens often expire on the variant playlist; try again)`);
        }

        // Idempotency guard: if every existing file is already in the slot
        // its filename claims (and that slot's content matches the expected
        // DOM duration), there's nothing to do. Re-clicking the button when
        // things are already correct used to be the failure mode that
        // SWAPPED files when Hotmart's manifest capture order varied between
        // page loads — refuse to make any changes when no changes are needed.
        let allInOrder = true;
        for (const e of expected) {
            if (e.expectedSec == null) continue;
            const slotAbs = path.join(path.dirname(actual.find(a => a.exists)?.absPath || resolveRelative(recordedPaths[0])), nameForDomIndex(e.domIndex));
            if (!fs.existsSync(slotAbs)) continue; // empty DOM slot — OK
            const dur = await probeDuration(slotAbs);
            if (dur == null || Math.abs(dur - e.expectedSec) > 60) {
                allInOrder = false;
                break;
            }
        }
        if (allInOrder) {
            return {
                plan: expected.map(e => ({
                    domIndex: e.domIndex,
                    expectedSec: e.expectedSec,
                    matchedFile: null,
                    actualSec: null,
                    finalName: nameForDomIndex(e.domIndex),
                })),
                unmatchedDomPositions: [],
                totalDom: expected.length,
                totalMatched: existingCount,
                alreadyInOrder: true,
            };
        }

        // dryRun: return the plan without touching the filesystem so the
        // caller can show the user exactly which renames will happen and
        // require confirmation before mutating anything. This is the
        // post-mortem fix for a previous incident where re-clicking the
        // button after Hotmart returned a different manifest capture order
        // swapped two videos that were already in DOM order.
        if (dryRun) {
            return {
                plan: plan.map(p => ({
                    domIndex: p.domIndex,
                    expectedSec: p.expectedSec,
                    matchedFile: p.matchedFile,
                    actualSec: p.actualSec,
                    finalName: p.finalName,
                })),
                unmatchedDomPositions: unmatchedDom,
                totalDom: plan.length,
                totalMatched: plan.filter(p => p.matchedFile).length,
                dryRun: true,
            };
        }

        // Atomic rename in three stages, designed so any single fs.renameSync
        // failure leaves recoverable state and an un-temp'd file is never
        // overwritten:
        //   1. Move every existing file to a unique temp slot keyed by its
        //      file index in `actual`. After this nothing remains under its
        //      original name; nothing can be clobbered by a later rename.
        //   2. For each matched DOM position, rename its temp → final name.
        //   3. For each un-matched file (no DOM position claimed it), restore
        //      its temp back to its original name so the user isn't left with
        //      `.reorder-tmp-N` orphans. If the original-name slot is now
        //      occupied (a matched file landed there), leave the temp as-is
        //      and warn — caller can inspect and rename manually.
        const dirAbs = path.dirname(actual.find(a => a.exists)?.absPath || resolveRelative(recordedPaths[0]));
        const tmpByFileIdx = new Map();
        for (let j = 0; j < actual.length; j++) {
            if (!actual[j].exists) continue;
            const tmp = path.join(dirAbs, `.reorder-tmp-${j}`);
            fs.renameSync(actual[j].absPath, tmp);
            tmpByFileIdx.set(j, tmp);
        }

        const finalRelPaths = [];
        const matchedFileIdxs = new Set();
        for (const c of candidates) {
            // Re-find each claimed match in the candidates list; matchByDom
            // entries have the file idx we need.
            const m = matchByDom.get(c.domIndex);
            if (!m || m.fileIdx !== c.fileIdx) continue;
            const tmpPath = tmpByFileIdx.get(c.fileIdx);
            if (!tmpPath) continue;
            const finalAbs = path.join(dirAbs, nameForDomIndex(c.domIndex));
            fs.renameSync(tmpPath, finalAbs);
            finalRelPaths[c.domIndex] = relativize(finalAbs);
            matchedFileIdxs.add(c.fileIdx);
        }

        for (const [fileIdx, tmpPath] of tmpByFileIdx.entries()) {
            if (matchedFileIdxs.has(fileIdx)) continue;
            const origName = path.basename(actual[fileIdx].relPath);
            const restorePath = path.join(dirAbs, origName);
            if (fs.existsSync(restorePath)) {
                console.warn(`[reorder] unmatched file '${origName}' cannot be restored (slot now occupied); left as ${path.basename(tmpPath)}`);
                continue;
            }
            fs.renameSync(tmpPath, restorePath);
        }

        // Persist the new ordering. Keep unmatched DOM positions out of the
        // recorded list — those slots need a future archive run to fill.
        const newPathsCompact = finalRelPaths.filter(Boolean);
        if (newPathsCompact.length > 0) {
            db.prepare(`
                UPDATE course_lectures
                SET video_local_paths = ?,
                    video_local_path = ?
                WHERE id = ?
            `).run(JSON.stringify(newPathsCompact), newPathsCompact[0], lectureId);
        }

        return {
            plan: plan.map(p => ({
                domIndex: p.domIndex,
                expectedSec: p.expectedSec,
                matchedFile: p.matchedFile,
                actualSec: p.actualSec,
                finalName: p.finalName,
            })),
            unmatchedDomPositions: unmatchedDom,
            totalDom: plan.length,
            totalMatched: plan.filter(p => p.matchedFile).length,
        };
    } finally {
        await browser.close().catch(() => { /* ignore */ });
    }
}

function nameForDomIndex(i) {
    return i === 0 ? 'video.mp4' : `video_${i + 1}.mp4`;
}
