import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { VIDEO_PROVIDERS } from './media-providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Phase 4a: data/ directory is configurable via DATA_DIR env var so Electron's
// main process can point us at app.getPath('userData')/data while CLI
// invocations default to ./data relative to the project root.
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.json');
const SCHOOL_URL = process.env.TEACHABLE_SCHOOL_URL || 'https://future-fiction-academy.teachable.com';

// Teachable promotional lectures injected into every course — skip during scrape
const PROMO_TITLES = new Set([
    'Check Out the FFA Free Community Classes, Discord, and Facebook Group',
    '🗨️ Check Out the FFA Free Community Classes, Discord, and Facebook Group',
]);

// =============================================================================
// Cookie / Session Management
// =============================================================================

function loadCookies() {
    try {
        if (fs.existsSync(COOKIES_PATH)) {
            return JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        }
    } catch (e) { /* ignore */ }
    return null;
}

function saveCookies(cookies) {
    const dataDir = path.dirname(COOKIES_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

export function hasSession() {
    const cookies = loadCookies();
    if (!cookies || cookies.length === 0) return false;
    const now = Date.now() / 1000;
    // Teachable uses 'signed_in' (session) and 'sk_*_remember_me' (persistent) cookies
    return cookies.some(c => {
        if (!c.name) return false;
        const isSessionCookie = c.name === 'signed_in'
            || c.name.includes('_remember_me')
            || c.name === '_session_id';
        const notExpired = !c.expires || c.expires === -1 || c.expires > now;
        return isSessionCookie && notExpired;
    });
}

export function clearSession() {
    if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
}

// =============================================================================
// Browser-based Login
// =============================================================================

export async function openLoginBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1200, height: 800 },
        args: ['--no-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(`${SCHOOL_URL}/sign_in`, { waitUntil: 'networkidle2' });

    console.log('\n🔐 Browser opened — please log in to Teachable.');
    console.log('   The browser will close automatically once login is detected.\n');

    let loggedIn = false;
    const maxWait = 300000;
    const start = Date.now();

    while (!loggedIn && (Date.now() - start) < maxWait) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const url = page.url();
            if (!url.includes('/sign_in') && !url.includes('/login')) {
                loggedIn = true;
            }
        } catch (e) { break; }
    }

    if (loggedIn) {
        const cookies = await page.cookies();
        saveCookies(cookies);
        console.log('✅ Login successful — session saved.\n');
    } else {
        console.log('⚠  Login timed out or was cancelled.\n');
    }

    await browser.close();
    return loggedIn;
}

// =============================================================================
// Authenticated Browser
// =============================================================================

export async function createAuthenticatedBrowser() {
    const cookies = loadCookies();
    if (!cookies) throw new Error('No session found. Please log in first.');

    const browser = await puppeteer.launch({
        headless: 'new',
        defaultViewport: { width: 1400, height: 900 },
        args: ['--no-sandbox'],
    });

    const page = await browser.newPage();
    await page.setCookie(...cookies);
    return { browser, page };
}

// =============================================================================
// Fetch Available Courses from Teachable
// =============================================================================

export async function fetchAvailableCourses() {
    const { browser, page } = await createAuthenticatedBrowser();
    const allCourses = [];

    try {
        let pageNum = 1;
        let hasMore = true;

        while (hasMore) {
            const url = `${SCHOOL_URL}/l/products?sortKey=recommended&sortDirection=desc&page=${pageNum}`;
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            if (page.url().includes('/sign_in') || page.url().includes('/login')) {
                throw new Error('Session expired. Please log in again.');
            }

            const courses = await page.evaluate((schoolUrl) => {
                const cards = document.querySelectorAll('a[id^="heap_product-card-cta_"]');
                const results = [];
                cards.forEach(card => {
                    const idMatch = card.id.match(/heap_product-card-cta_(\d+)/);
                    const title = card.querySelector('h2')?.textContent?.trim()
                        || card.querySelector('[class*="title"]')?.textContent?.trim()
                        || 'Untitled';
                    const href = card.getAttribute('href') || '';
                    // Look for CTA text to determine enrollment
                    const ctaText = card.querySelector('span, div')?.textContent?.trim()?.toLowerCase() || '';
                    const enrolled = ctaText.includes('resume') || ctaText.includes('go to') || ctaText.includes('continue');

                    if (idMatch) {
                        results.push({
                            teachableId: idMatch[1],
                            title,
                            url: href.startsWith('http') ? href : `${schoolUrl}${href}`,
                            enrolled,
                        });
                    }
                });
                return results;
            }, SCHOOL_URL);

            allCourses.push(...courses);

            // Check for pagination — if fewer results or no cards, stop
            if (courses.length === 0) {
                hasMore = false;
            } else {
                // Check for a next-page link
                const hasNext = await page.evaluate(() => {
                    const links = document.querySelectorAll('a[href*="page="]');
                    const currentPage = new URL(window.location.href).searchParams.get('page') || '1';
                    const nextPage = String(parseInt(currentPage) + 1);
                    return [...links].some(link => {
                        const url = new URL(link.href, window.location.origin);
                        return url.searchParams.get('page') === nextPage;
                    });
                });
                if (hasNext) {
                    pageNum++;
                } else {
                    hasMore = false;
                }
            }
        }
    } finally {
        await browser.close();
    }

    return allCourses;
}

// =============================================================================
// Course Scraping (uses course_* tables)
// =============================================================================

export async function scrapeCourse(courseUrl, onProgress = () => { }, options = {}) {
    const { forceRefresh = false } = options ?? {};
    const db = getDb();
    // Handle both /courses/<id>/... and /courses/enrolled/<id>
    const courseMatch = courseUrl.match(/courses\/(?:enrolled\/)?(\d+)/);
    if (!courseMatch) throw new Error('Invalid course URL — expected /courses/<id>/... or /courses/enrolled/<id>');
    const teachableId = courseMatch[1];

    onProgress('Launching browser...', 0);
    const { browser, page } = await createAuthenticatedBrowser();

    try {
        onProgress('Loading course page...', 5);
        await page.goto(`${SCHOOL_URL}/courses/${teachableId}`, {
            waitUntil: 'networkidle2', timeout: 30000,
        });

        if (page.url().includes('/sign_in') || page.url().includes('/login')) {
            throw new Error('Session expired. Please log in again.');
        }

        const courseTitle = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            const heading = document.querySelector('.course-sidebar h2, .course-title, [class*="course-name"]');
            return h1?.textContent?.trim() || heading?.textContent?.trim() || 'Untitled Course';
        });

        // Extract class number from page title (e.g. "118 - Back to Basics... | FFA")
        const pageTitle = await page.title();
        const classNumMatch = pageTitle.match(/^(\d+)\s*-\s*/);
        const classNumber = classNumMatch ? classNumMatch[1] : null;

        onProgress(`Found course: ${classNumber ? `#${classNumber} ` : ''}${courseTitle}`, 10);

        // Extract curriculum from sidebar
        const curriculum = await page.evaluate((promoTitlesList) => {
            const promoTitles = new Set(promoTitlesList);
            const sections = [];
            const sectionElements = document.querySelectorAll(
                '.course-section, [class*="section"], .row.lecture-sidebar'
            );

            // Collect all section titles so we can skip lecture links that duplicate them
            const sectionTitles = new Set();
            sectionElements.forEach(sectionEl => {
                const t = sectionEl.querySelector(
                    '.section-title, [class*="section-title"], h3, h4'
                )?.textContent?.trim();
                if (t) sectionTitles.add(t);
            });

            if (sectionElements.length > 0) {
                sectionElements.forEach(sectionEl => {
                    const sectionTitle = sectionEl.querySelector(
                        '.section-title, [class*="section-title"], h3, h4'
                    )?.textContent?.trim() || '';

                    const lectureLinks = sectionEl.querySelectorAll(
                        '.section-item a, .lecture-name a, [class*="lecture"] a, li a'
                    );

                    const lectures = [];
                    lectureLinks.forEach(link => {
                        const href = link.getAttribute('href');
                        if (href && href.includes('/lectures/')) {
                            const text = link.textContent?.trim() || '';
                            const durMatch = text.match(/\((\d+:\d+)\)|\s(\d+:\d+)\s*$/);
                            const title = text.replace(/\(?\d+:\d+\)?/g, '').trim();
                            const cleanTitle = title || text;
                            // Skip Teachable nav artifacts: "Start" CTAs and promos
                            if (cleanTitle === 'Start' || promoTitles.has(cleanTitle)) return;
                            const classNumMatch = cleanTitle.match(/^(\d{2,4})[\s\-–]/);
                            const teachableLectureIdMatch = href.match(/\/lectures\/(\d+)/);
                            if (!teachableLectureIdMatch) return; // defensive; href.includes('/lectures/') already passed
                            const teachableLectureId = teachableLectureIdMatch[1];
                            lectures.push({
                                title: cleanTitle,
                                url: href,
                                duration: durMatch ? (durMatch[1] || durMatch[2]) : null,
                                classNumber: classNumMatch ? classNumMatch[1] : null,
                                teachableLectureId,
                            });
                        }
                    });

                    if (lectures.length > 0 || sectionTitle) {
                        sections.push({ title: sectionTitle, lectures });
                    }
                });
            }

            // Fallback: grab all lecture links
            if (sections.length === 0 || sections.every(s => s.lectures.length === 0)) {
                const allLinks = document.querySelectorAll('a[href*="/lectures/"]');
                const fallbackLectures = [];
                allLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    const text = link.textContent?.trim() || '';
                    if (href && text && !fallbackLectures.some(l => l.url === href)) {
                        const durMatch = text.match(/\((\d+:\d+)\)|\s(\d+:\d+)\s*$/);
                        const title = text.replace(/\(?\d+:\d+\)?/g, '').trim();
                        const cleanTitle = title || text;
                        if (cleanTitle === 'Start' || promoTitles.has(cleanTitle)) return;
                        const classNumMatch = cleanTitle.match(/^(\d{2,4})[\s\-–]/);
                        const teachableLectureIdMatch = href.match(/\/lectures\/(\d+)/);
                        if (!teachableLectureIdMatch) return;
                        const teachableLectureId = teachableLectureIdMatch[1];
                        fallbackLectures.push({
                            title: cleanTitle,
                            url: href,
                            duration: durMatch ? (durMatch[1] || durMatch[2]) : null,
                            classNumber: classNumMatch ? classNumMatch[1] : null,
                            teachableLectureId,
                        });
                    }
                });
                if (fallbackLectures.length > 0) {
                    sections.push({ title: 'All Lectures', lectures: fallbackLectures });
                }
            }

            return sections;
        }, [...PROMO_TITLES]);

        const totalLectures = curriculum.reduce((sum, s) => sum + s.lectures.length, 0);
        onProgress(`Found ${totalLectures} lectures in ${curriculum.length} section(s)`, 15);

        if (totalLectures === 0) {
            throw new Error('No lectures found. Check the URL or enrollment status.');
        }

        // Upsert course
        const existing = db.prepare('SELECT id FROM courses WHERE teachable_id = ?').get(teachableId);
        let courseId;
        if (existing) {
            courseId = existing.id;
            db.prepare('UPDATE courses SET title = ?, class_number = ?, url = ?, scraped_at = ? WHERE id = ?')
                .run(courseTitle, classNumber, courseUrl, new Date().toISOString(), courseId);
        } else {
            const result = db.prepare(
                'INSERT INTO courses (teachable_id, title, class_number, url, scraped_at) VALUES (?, ?, ?, ?, ?)'
            ).run(teachableId, courseTitle, classNumber, courseUrl, new Date().toISOString());
            courseId = result.lastInsertRowid;
        }

        // Phase 3.1: Hoist prepared statements so they're compiled once per scrape
        const sectionUpsert = db.prepare(`
            INSERT INTO course_sections (course_id, title, position)
            VALUES (?, ?, ?)
            ON CONFLICT(course_id, title) DO UPDATE SET position = excluded.position
            RETURNING id
        `);
        // Phase 3.1: Upsert by (course_id, teachable_lecture_id). On conflict, refresh metadata
        // but PRESERVE archive ownership: video_local_path, video_duration_sec, and
        // video_downloaded_at are intentionally absent from DO UPDATE SET — those are written
        // by archive-videos.js and must survive re-scrapes untouched. Adding any of those three
        // to the SET clause would silently destroy downloaded video state on the next re-scrape.
        const lectureUpsert = db.prepare(`
            INSERT INTO course_lectures (
                course_id, section_id, teachable_lecture_id,
                title, url, duration, position, scraped_at, class_number,
                video_url, video_provider, notion_url, removed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(course_id, teachable_lecture_id) DO UPDATE SET
                section_id     = excluded.section_id,
                title          = excluded.title,
                url            = excluded.url,
                duration       = excluded.duration,
                position       = excluded.position,
                scraped_at     = excluded.scraped_at,
                class_number   = excluded.class_number,
                video_url      = COALESCE(excluded.video_url, course_lectures.video_url),
                video_provider = COALESCE(excluded.video_provider, course_lectures.video_provider),
                notion_url     = COALESCE(excluded.notion_url, course_lectures.notion_url),
                removed_at     = NULL
            RETURNING id
        `);
        const seenLectureIds = new Set();

        // Phase 3.1: Pre-load known teachable_lecture_id values so we can skip
        // per-lecture page fetches for unchanged content (unless --force-refresh).
        const knownIds = new Set(
            db.prepare(
                'SELECT teachable_lecture_id FROM course_lectures WHERE course_id = ? AND teachable_lecture_id IS NOT NULL AND removed_at IS NULL'
            ).all(courseId).map(r => r.teachable_lecture_id)
        );
        if (forceRefresh) {
            onProgress(`  ⓘ force-refresh enabled; will re-fetch all ${knownIds.size} known lectures`, null);
        }

        let scraped = 0;
        for (let si = 0; si < curriculum.length; si++) {
            const section = curriculum[si];
            // Skip the promo section entirely
            if (section.title && PROMO_TITLES.has(section.title)) continue;
            const { id: sectionId } = sectionUpsert.get(courseId, section.title, si);

            for (let li = 0; li < section.lectures.length; li++) {
                const lecture = section.lectures[li];
                const pct = 15 + Math.round((scraped / totalLectures) * 80);

                const { id: lectureId } = lectureUpsert.get(
                    courseId,
                    sectionId,
                    lecture.teachableLectureId,
                    lecture.title,
                    lecture.url,
                    lecture.duration,
                    li,
                    new Date().toISOString(),
                    lecture.classNumber ?? null,
                    null, // video_url — populated by per-lecture page fetch below if found
                    null, // video_provider — same
                    null  // notion_url — same
                );
                seenLectureIds.add(lecture.teachableLectureId);

                const isKnown = knownIds.has(lecture.teachableLectureId);
                if (isKnown && !forceRefresh) {
                    // Skip per-lecture Puppeteer navigation; the upsert above already refreshed
                    // title/position/section_id/scraped_at. Keep existing chunks and video_* metadata.
                    scraped++;
                    continue;
                }

                onProgress(`Scraping: ${lecture.title}`, pct);

                try {
                    const lectureUrl = lecture.url.startsWith('http')
                        ? lecture.url
                        : `${SCHOOL_URL}${lecture.url}`;

                    await page.goto(lectureUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await new Promise(r => setTimeout(r, 1500));

                    // 0) Capture embedded video URL/provider and Notion notes URL (discovery only — no download)
                    // Real-world finding from Phase 1 verification probe: Hotmart is the
                    // dominant host on this Teachable site; Wistia is not used at all.
                    // Priority: hotmart > wistia > vimeo > youtube > direct.
                    const metadata = await page.evaluate((PROVIDERS) => {
                        const videoProbes = [
                            { provider: PROVIDERS.HOTMART, selector: 'iframe[src*="hotmart"]', attr: 'src' },
                            { provider: PROVIDERS.WISTIA, selector: 'iframe[src*="fast.wistia"]', attr: 'src' },
                            { provider: PROVIDERS.WISTIA, selector: 'iframe[src*="wistia"]', attr: 'src' },
                            { provider: PROVIDERS.VIMEO, selector: 'iframe[src*="vimeo"]', attr: 'src' },
                            { provider: PROVIDERS.YOUTUBE, selector: 'iframe[src*="youtube"]', attr: 'src' },
                            { provider: PROVIDERS.YOUTUBE, selector: 'iframe[src*="youtu.be"]', attr: 'src' },
                            { provider: PROVIDERS.DIRECT, selector: 'video[src]', attr: 'src' },
                            { provider: PROVIDERS.DIRECT, selector: 'video source[src]', attr: 'src' },
                        ];

                        let video_url = null;
                        let video_provider = null;
                        for (const { provider, selector, attr } of videoProbes) {
                            const el = document.querySelector(selector);
                            const val = el?.getAttribute(attr);
                            if (val) {
                                video_url = val;
                                video_provider = provider;
                                break;
                            }
                        }

                        // Notion link: prefer the first match in document order across anchors and iframes
                        let notion_url = null;
                        const notionCandidates = document.querySelectorAll(
                            'a[href*="notion.so"], a[href*="notion.site"], iframe[src*="notion.so"], iframe[src*="notion.site"]'
                        );
                        for (const el of notionCandidates) {
                            const val = el.getAttribute('href') || el.getAttribute('src');
                            if (val) {
                                notion_url = val;
                                break;
                            }
                        }

                        return { video_url, video_provider, notion_url };
                    }, VIDEO_PROVIDERS);

                    // Phase 3.1: COALESCE preserves existing values when the per-lecture page extract
                    // returns NULL (e.g., Hotmart iframe didn't render in time, transient auth glitch).
                    // This protects against force-refresh inadvertently NULL-ing out previously-good
                    // video metadata while video_local_path remains intact.
                    db.prepare(`
                        UPDATE course_lectures
                        SET video_url      = COALESCE(?, video_url),
                            video_provider = COALESCE(?, video_provider),
                            notion_url     = COALESCE(?, notion_url)
                        WHERE id = ?
                    `).run(metadata.video_url, metadata.video_provider, metadata.notion_url, lectureId);

                    // 1) Try downloading .txt file attachments first
                    let textContent = '';
                    const downloadUrls = await page.evaluate(() => {
                        const links = [...document.querySelectorAll('a.download')];
                        return links
                            .map(a => a.href)
                            .filter(href => href && href.endsWith('.txt'));
                    });

                    if (downloadUrls.length > 0) {
                        // Fetch each .txt file content
                        const fileTexts = [];
                        for (const url of downloadUrls) {
                            try {
                                const content = await page.evaluate(async (fileUrl) => {
                                    const res = await fetch(fileUrl);
                                    if (!res.ok) return null;
                                    return await res.text();
                                }, url);
                                if (content && content.trim().length > 10) {
                                    fileTexts.push(content.trim());
                                }
                            } catch (dlErr) {
                                // Skip failed downloads
                            }
                        }
                        if (fileTexts.length > 0) {
                            textContent = fileTexts.join('\n\n---\n\n');
                        }
                    }

                    // 2) Fallback: scrape page text if no .txt downloads found
                    if (!textContent) {
                        textContent = await page.evaluate(() => {
                            const selectorGroups = [
                                ['.fr-view'],
                                ['.lecture-text-container'],
                                ['.trix-content'],
                                ['.ql-editor'],
                                ['.lecture-attachment .text-attachment'],
                                ['[class*="text-block"]'],
                                ['.lecture-content'],
                                ['.lecture-attachment'],
                            ];

                            let texts = [];
                            for (const group of selectorGroups) {
                                for (const sel of group) {
                                    document.querySelectorAll(sel).forEach(el => {
                                        const text = el.innerText?.trim();
                                        if (text && text.length > 20) texts.push(text);
                                    });
                                }
                                if (texts.length > 0) break;
                            }

                            const deduped = [];
                            for (const t of texts) {
                                const dominated = deduped.some(existing => existing.includes(t));
                                if (!dominated) {
                                    for (let i = deduped.length - 1; i >= 0; i--) {
                                        if (t.includes(deduped[i])) deduped.splice(i, 1);
                                    }
                                    deduped.push(t);
                                }
                            }
                            return deduped.join('\n\n---\n\n');
                        });
                    }

                    if (textContent && textContent.length > 10) {
                        // Phase 3.1: For new lectures this DELETE is a no-op; for force-refresh it clears
                        // stale chunks before re-inserting. The DELETE is intentionally gated by the
                        // text-length check: if a force-refresh fetches a lecture whose page returns
                        // empty text (transient render bug, auth hiccup, etc.), we preserve the existing
                        // chunks rather than dropping data we may not be able to recover. To force a
                        // clean slate, the operator can re-run with forceRefresh once Teachable is
                        // returning text again.
                        db.prepare('DELETE FROM course_chunks WHERE lecture_id = ?').run(lectureId);
                        const chunks = chunkText(textContent);
                        const ins = db.prepare(
                            'INSERT INTO course_chunks (lecture_id, content, position) VALUES (?, ?, ?)'
                        );
                        for (let ci = 0; ci < chunks.length; ci++) {
                            ins.run(lectureId, chunks[ci], ci);
                        }
                    }
                } catch (err) {
                    onProgress(`  ⚠ Error on ${lecture.title}: ${err.message}`, pct);
                }

                scraped++;
            }
        }

        // Phase 3.1: Soft-delete lectures that are no longer in Teachable.
        // Secondary defense: the earlier `if (totalLectures === 0)` throw at this function's
        // listing-page extraction already covers the "zero lectures returned by Teachable" case.
        // This guard catches the unreachable-in-current-code scenario where lectures appeared
        // in the listing but somehow none made it into seenLectureIds — better to fail loud
        // than silently soft-delete every lecture in the course.
        if (seenLectureIds.size === 0) {
            throw new Error(
                `Scrape returned 0 lectures for course ${courseId} — refusing to soft-delete the entire course (likely auth or DOM-extraction issue)`
            );
        }
        const seenIds = [...seenLectureIds];
        const placeholders = seenIds.map(() => '?').join(',');
        const nowIso = new Date().toISOString();
        const softDeleteResult = db.prepare(`
            UPDATE course_lectures
            SET removed_at = ?
            WHERE course_id = ?
              AND teachable_lecture_id NOT IN (${placeholders})
              AND removed_at IS NULL
        `).run(nowIso, courseId, ...seenIds);
        if (softDeleteResult.changes > 0) {
            onProgress(`  ⓘ Soft-deleted ${softDeleteResult.changes} lectures no longer in Teachable`, null);
        }

        const finalCount = db.prepare(
            'SELECT COUNT(*) as count FROM course_lectures WHERE course_id = ? AND removed_at IS NULL'
        ).get(courseId);
        db.prepare('UPDATE courses SET lecture_count = ? WHERE id = ?')
            .run(finalCount.count, courseId);

        onProgress(`✅ Done — scraped ${scraped} lectures`, 100);
        await browser.close();
        return { courseId, title: courseTitle, lectureCount: scraped };

    } catch (err) {
        await browser.close();
        throw err;
    }
}

function chunkText(text, maxWords = 300) {
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let current = '';
    let currentWords = 0;

    for (const para of paragraphs) {
        const paraWords = para.split(/\s+/).length;
        if (currentWords + paraWords > maxWords && current) {
            chunks.push(current.trim());
            current = '';
            currentWords = 0;
        }
        current += (current ? '\n\n' : '') + para;
        currentWords += paraWords;
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

export function deleteCourse(courseId) {
    const db = getDb();
    // Manually clean FTS before cascade delete
    const chunkIds = db.prepare(
        'SELECT cc.id, cc.content FROM course_chunks cc JOIN course_lectures cl ON cc.lecture_id = cl.id WHERE cl.course_id = ?'
    ).all(courseId);

    const delFts = db.prepare(
        "INSERT INTO course_chunks_fts(course_chunks_fts, rowid, content) VALUES('delete', ?, ?)"
    );
    for (const { id, content } of chunkIds) {
        delFts.run(id, content);
    }

    db.prepare('DELETE FROM courses WHERE id = ?').run(courseId);
    return true;
}
