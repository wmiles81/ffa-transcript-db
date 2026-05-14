/**
 * Transcript DB — Frontend Application
 * Handles search, browse, and transcript viewing.
 */
import { APP_VERSION, APP_BUILD_SHA, APP_BUILD_DIRTY, APP_BUILD_DATE } from './version.js';

// --- State ---
const state = {
    view: 'browse', // 'browse' | 'search' | 'detail'
    activeType: '',
    activeSource: '',
    activeLecture: '',
    searchQuery: '',
    searchTimeout: null,
    // Active course section filter
    activeSection: null,
    // AI search
    aiMode: false,
    aiModels: [],
    selectedModel: '',
    hasApiKey: false,
    aiAbortController: null,
    // Teachable courses
    courses: [],
    sources: [],
    loggedIn: false,
    // File-explorer tree
    tree: { cache: new Map() },
    expanded: new Set(),
    activeClassNumber: null,
    activeLectureId: null,
    activeTranscriptId: null,
    // Phase 5 (LLM Wiki) — selected kind & entity in the Wiki tab
    activeWikiKind: null,
    activeWikiEntityId: null,
    wikiEntityCache: new Map(), // entityId -> detail (avoid refetching while clicking around)
    wikiRebuildAbort: null,
};

// --- API Helpers ---
async function api(endpoint, options = {}) {
    const { method = 'GET', body, headers = {} } = options;
    const fetchOptions = { method, headers };
    if (body) {
        fetchOptions.body = body;
        fetchOptions.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(endpoint, fetchOptions);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// Phase 5/6: fetch the video list for a course lecture
async function fetchLectureVideos(lectureId) {
    try {
        return await api(`/api/courses/lectures/${lectureId}/videos`);
    } catch {
        return [];
    }
}

// --- DOM References ---
const el = {
    statsBar: document.getElementById('stats-bar'),
    statSources: document.getElementById('stat-sources'),
    statLectures: document.getElementById('stat-lectures'),
    statTranscripts: document.getElementById('stat-transcripts'),
    statChunks: document.getElementById('stat-chunks'),
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),
    searchMeta: document.getElementById('search-meta'),
    searchShortcut: document.getElementById('search-shortcut'),
    filterSource: document.getElementById('filter-source'),
    filterTypes: document.getElementById('filter-types'),
    sourceTree: document.getElementById('source-tree'),
    unassignedSection: document.getElementById('unassigned-section'),
    unassignedToggle: document.getElementById('unassigned-toggle'),
    unassignedTree: document.getElementById('unassigned-tree'),
    // Removed: sourceDropdownSelect, lectureListSelect (elements deleted from HTML)
    sourceDropdownSelect: null,
    lectureListSelect: null,
    browseView: document.getElementById('browse-view'),
    searchView: document.getElementById('search-view'),
    detailView: document.getElementById('detail-view'),
    browseTitle: document.getElementById('browse-title'),
    transcriptGrid: document.getElementById('transcript-grid'),
    searchTitle: document.getElementById('search-title'),
    resultsList: document.getElementById('results-list'),
    backBtn: document.getElementById('back-btn'),
    transcriptDetail: document.getElementById('transcript-detail'),
    // AI elements
    aiToggle: document.getElementById('ai-toggle'),
    aiAnswerContainer: document.getElementById('ai-answer-container'),
    aiAnswerBody: document.getElementById('ai-answer-body'),
    aiThinking: document.getElementById('ai-thinking'),
    aiAnswerFooter: document.getElementById('ai-answer-footer'),
    aiChunksUsed: document.getElementById('ai-chunks-used'),
    aiUsage: document.getElementById('ai-usage'),
    aiModelLabel: document.getElementById('ai-model-label'),
    // Settings modal
    settingsBtn: document.getElementById('settings-btn'),
    settingsOverlay: document.getElementById('settings-overlay'),
    settingsClose: document.getElementById('settings-close'),
    settingsApiKey: document.getElementById('settings-api-key'),
    settingsSaveKey: document.getElementById('settings-save-key'),
    settingsKeyStatus: document.getElementById('settings-key-status'),
    settingsRefreshModels: document.getElementById('settings-refresh-models'),
    settingsModelStatus: document.getElementById('settings-model-status'),
    modelTrigger: document.getElementById('model-trigger'),
    modelList: document.getElementById('model-list'),
    modelDropdown: document.getElementById('model-dropdown'),
    // Course management
    authStatus: document.getElementById('auth-status'),
    courseList: document.getElementById('course-list'),
    addCourseBtn: document.getElementById('add-course-btn'),
    loginBtn: document.getElementById('login-btn'),
    addCoursePanel: document.getElementById('add-course-panel'),
    coursePickerLoading: document.getElementById('course-picker-loading'),
    coursePickerList: document.getElementById('course-picker-list'),
    startScrapeBtn: document.getElementById('start-scrape-btn'),
    cancelAddCourse: document.getElementById('cancel-add-course'),
    scrapeProgress: document.getElementById('scrape-progress'),
    scrapeMessage: document.getElementById('scrape-message'),
    scrapePct: document.getElementById('scrape-pct'),
    scrapeBar: document.getElementById('scrape-bar'),
    notionBar: document.getElementById('notion-bar'),
    notionLink: document.getElementById('notion-link'),
    notionEditBtn: document.getElementById('notion-edit-btn'),
    // Phase 5 (LLM Wiki)
    wikiView: document.getElementById('wiki-view'),
    wikiTitle: document.getElementById('wiki-title'),
    wikiMeta: document.getElementById('wiki-meta'),
    wikiContainer: document.getElementById('wiki-container'),
    wikiNav: document.getElementById('wiki-nav'),
    wikiLintBtn: document.getElementById('wiki-lint-btn'),
    settingsWikiRebuildScope: document.getElementById('settings-wiki-rebuild-scope'),
    settingsWikiRebuildBtn: document.getElementById('settings-wiki-rebuild-btn'),
    settingsWikiCancelBtn: document.getElementById('settings-wiki-cancel-btn'),
    settingsWikiStatus: document.getElementById('settings-wiki-status'),
    settingsWikiProgress: document.getElementById('settings-wiki-progress'),
};

// --- Theme toggle ---
const THEMES = ['dark', 'light', 'hc-dark', 'hc-light'];
const THEME_ICONS = { dark: '🌙', light: '☀️', 'hc-dark': '🌑', 'hc-light': '🔆' };

function initTheme() {
    const saved = localStorage.getItem('tdb-theme') || 'dark';
    applyTheme(THEMES.includes(saved) ? saved : 'dark');

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const idx = THEMES.indexOf(current);
            const next = THEMES[(idx + 1) % THEMES.length];
            applyTheme(next);
            localStorage.setItem('tdb-theme', next);
        });
    }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const toggle = document.getElementById('theme-toggle');
    const nextIdx = (THEMES.indexOf(theme) + 1) % THEMES.length;
    if (toggle) toggle.textContent = THEME_ICONS[THEMES[nextIdx]] || '🌙';
}

// Apply immediately (before DOM paint)
initTheme();

// Stamp the header version badge from the values written by scripts/stamp-version.mjs.
(function paintVersionBadge() {
    const badge = document.getElementById('version-badge');
    if (!badge) return;
    const dirtyMark = APP_BUILD_DIRTY ? '*' : '';
    badge.textContent = `v${APP_VERSION} · ${APP_BUILD_SHA}${dirtyMark}`;
    const built = APP_BUILD_DATE ? new Date(APP_BUILD_DATE).toLocaleString() : 'unknown';
    badge.title = `Version ${APP_VERSION}\nCommit ${APP_BUILD_SHA}${APP_BUILD_DIRTY ? ' (uncommitted changes at build time)' : ''}\nBuilt ${built}\n\nClick to copy`;
    badge.addEventListener('click', () => {
        const txt = `v${APP_VERSION} · ${APP_BUILD_SHA}${dirtyMark} · built ${APP_BUILD_DATE}`;
        try { navigator.clipboard?.writeText(txt); } catch { /* ignore */ }
    });
})();

// =============================================================================
// Phase 7: Resizable sidebar
// =============================================================================

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 600;

function restoreSidebarWidth() {
    try {
        const saved = Number(localStorage.getItem('tdb-sidebar-width'));
        if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
            const sidebar = document.getElementById('sidebar');
            if (sidebar) sidebar.style.width = `${saved}px`;
        }
    } catch { /* ignore */ }
}

function attachSidebarResize() {
    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;
    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    function onMouseMove(e) {
        if (!dragging) return;
        const delta = e.clientX - startX;
        let newWidth = startWidth + delta;
        newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, newWidth));
        sidebar.style.width = `${newWidth}px`;
    }

    function onMouseUp() {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        try {
            const finalWidth = sidebar.getBoundingClientRect().width;
            localStorage.setItem('tdb-sidebar-width', String(Math.round(finalWidth)));
        } catch { /* ignore */ }
    }

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        document.body.classList.add('resizing');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// Restore sidebar width before first paint, then wire the drag handle
restoreSidebarWidth();
attachSidebarResize();

// --- Initialize ---
async function init() {
    await Promise.all([loadStats(), loadSources(), loadTranscripts(), loadAiSettings(), loadCourses(), checkAuth()]);
    setupEventListeners();
    setupSettingsListeners();
    setupCourseListeners();
    setupWikiListeners();
    setupWikiSettingsListeners();
    await initTree();
    attachMediaLibrarySettingsHandlers();
    attachSplashHandlers();
    await loadMediaLibrarySettings();
    await showFirstRunSplashIfNeeded();
    populateWikiRebuildScope();
    loadWikiKindCounts();
}

// --- Load Data ---
async function loadStats() {
    try {
        const stats = await api('/api/stats');
        el.statSources.textContent = stats.sources + (stats.courses || 0);
        el.statLectures.textContent = stats.lectures + (stats.courseLectures || 0);
        el.statTranscripts.textContent = stats.transcripts;
        el.statChunks.textContent = (stats.chunks + (stats.courseChunks || 0)).toLocaleString();
    } catch (e) {
        console.error('Failed to load stats:', e);
    }
}

async function loadSources() {
    try {
        const [sources, courses] = await Promise.all([
            api('/api/sources'),
            api('/api/courses'),
        ]);
        state.sources = sources;
        state.courses = courses;
        el.filterSource.innerHTML = '<option value="">All Sources</option>';

        // Transcript sources (flat, same level as courses)
        for (const source of sources) {
            const opt = document.createElement('option');
            opt.value = source.id;
            opt.textContent = `${source.name} — ${source.transcript_count} transcripts`;
            el.filterSource.appendChild(opt);
        }

        // Scraped courses (same level)
        for (const course of courses) {
            const opt = document.createElement('option');
            opt.value = `course-${course.id}`;
            opt.textContent = `${course.title} — ${course.lecture_count || 0} lectures · ${course.chunk_count || 0} chunks`;
            el.filterSource.appendChild(opt);
        }

        // Re-render the unified sidebar list
        renderCourseList();
        // Refresh header stats whenever source data changes
        loadStats();
        // Re-render tree with updated data
        renderTree();
    } catch (e) {
        console.error('Failed to load sources:', e);
    }
}

async function loadLectures() {
    try {
        // If a course is selected, show its sections in the sidebar
        if (state.activeSource && state.activeSource.startsWith('course-')) {
            const courseId = state.activeSource.replace('course-', '');
            try {
                const sections = await api(`/api/courses/${courseId}/sections`);
                renderLectureList(sections.map(s => ({
                    lecture: s.title,
                    lecture_date: '',
                    transcript_count: s.lecture_count,
                    sectionId: s.id,
                })));
            } catch {
                renderLectureList([]);
            }
            return;
        }
        const params = new URLSearchParams();
        if (state.activeSource) params.set('source_id', state.activeSource);
        const lectures = await api(`/api/lectures?${params}`);
        renderLectureList(lectures);
    } catch (e) {
        console.error('Failed to load lectures:', e);
    }
}

async function loadTranscripts() {
    try {
        // If a course is selected, show course content instead
        if (state.activeSource && state.activeSource.startsWith('course-')) {
            const courseId = state.activeSource.replace('course-', '');
            const q = new URLSearchParams();
            if (state.activeSection) q.set('section_id', state.activeSection);
            if (state.activeType) q.set('type', state.activeType);
            const qs = q.toString();
            let data = await api(`/api/courses/${courseId}/lectures${qs ? '?' + qs : ''}`);
            if (state.activeClassNumber) {
                data = data.filter(lec => String(lec.class_number) === String(state.activeClassNumber));
            }
            renderTranscriptGrid(data.map(lec => ({
                id: `clec-${lec.id}`,
                title: lec.title,
                filename: lec.section_title || '',
                transcript_type: 'Course',
                lecture: lec.title,
                class_number: lec.class_number || null,
                lecture_date: lec.scraped_at?.split('T')[0],
                duration_minutes: null,
                result_type: 'course',
            })));
            el.browseTitle.textContent = 'Course Lectures';
            updateNotionBar(courseId);
            // Phase 4b: show archive button for this course
            const archiveBtn = document.getElementById('archive-videos-btn');
            if (archiveBtn) {
                archiveBtn.dataset.courseId = String(courseId);
                archiveBtn.classList.remove('hidden');
            }
            switchView('browse');
            return;
        }
        const params = new URLSearchParams();
        if (state.activeSource) params.set('source_id', state.activeSource);
        if (state.activeLecture) params.set('lecture', state.activeLecture);
        if (state.activeType) params.set('type', state.activeType);
        const data = await api(`/api/transcripts?${params}`);
        renderTranscriptGrid(data.transcripts);
        el.browseTitle.textContent = state.activeLecture || 'All Transcripts';
        if (el.notionBar) el.notionBar.classList.add('hidden');
        // Phase 4b: hide archive button when not on a course view
        const archiveBtn = document.getElementById('archive-videos-btn');
        if (archiveBtn) archiveBtn.classList.add('hidden');
    } catch (e) {
        console.error('Failed to load transcripts:', e);
    }
}

async function doSearch(query) {
    if (!query || query.trim().length < 2) {
        switchView('browse');
        el.searchMeta.textContent = '';
        hideAiAnswer();
        return;
    }

    // AI mode — ask the LLM
    if (state.aiMode) {
        await doAiAsk(query);
        return;
    }

    try {
        const params = new URLSearchParams({ q: query });
        // If a course source is selected, filter to that course
        if (state.activeSource && state.activeSource.startsWith('course-')) {
            params.set('courses', state.activeSource.replace('course-', ''));
        } else {
            if (state.activeSource) params.set('source_id', state.activeSource);
            if (state.activeLecture) params.set('lecture', state.activeLecture);
            if (state.activeType) params.set('type', state.activeType);
            // Pass selected course IDs from sidebar checkboxes
            const selectedCourses = getSelectedCourseIds();
            if (selectedCourses.length > 0) params.set('courses', selectedCourses.join(','));
        }

        const data = await api(`/api/search?${params}`);
        renderSearchResults(data.results);
        el.searchTitle.textContent = `Search Results`;
        const parts = [];
        if (data.transcriptTotal) parts.push(`${data.transcriptTotal} transcript`);
        if (data.courseTotal) parts.push(`${data.courseTotal} course`);
        el.searchMeta.textContent = `${data.total} match${data.total !== 1 ? 'es' : ''} for "${query}"${parts.length > 1 ? ` (${parts.join(' + ')})` : ''}`;
        switchView('search');
        hideAiAnswer();
    } catch (e) {
        console.error('Search failed:', e);
        el.searchMeta.textContent = 'Search failed.';
    }
}

async function loadTranscriptDetail(id, highlightQuery) {
    try {
        // Pre-fetch videos for course lectures
        let videos = [];
        const isCourseLecture = id && String(id).startsWith('clec-');
        if (isCourseLecture) {
            const lectureId = String(id).replace('clec-', '');
            try { videos = await fetchLectureVideos(lectureId); } catch {}
        }

        // Handle course lecture IDs (clec-<id>)
        if (isCourseLecture) {
            const lecId = String(id).replace('clec-', '');
            const lecture = await api(`/api/courses/lectures/${lecId}`);
            const sectionPart = lecture.section_title && lecture.section_title !== lecture.title
                ? `${lecture.section_title} · ` : '';
            const transcript = {
                id: id,
                title: lecture.title,
                filename: `${sectionPart}${lecture.course_title || ''}`,
                lecture: lecture.title,
                transcript_type: 'Course',
                lecture_date: lecture.scraped_at?.split('T')[0],
                content: lecture.content || '(No text content)',
                result_type: 'course',
                course_id: lecture.course_id,
                lectureId: lecId,
                videos,
                // Chunks carry video_index so the UI can filter by active tab.
                chunks: lecture.chunks || [],
            };
            renderTranscriptDetail(transcript, highlightQuery);
            switchView('detail');
            return;
        }
        const transcript = await api(`/api/transcripts/${id}`);
        renderTranscriptDetail(transcript, highlightQuery);
        switchView('detail');
    } catch (e) {
        console.error('Failed to load transcript:', e);
    }
}

// =============================================================================
// File-explorer tree sidebar
// =============================================================================

function restoreExpanded() {
    try {
        const stored = JSON.parse(localStorage.getItem('tdb-tree-expanded') || '[]');
        state.expanded = new Set(stored);
    } catch {
        state.expanded = new Set();
    }
}

function persistExpanded() {
    try {
        localStorage.setItem('tdb-tree-expanded', JSON.stringify([...state.expanded]));
    } catch { /* quota */ }
}

const TAG_ORDER = ['CUT', 'INK', 'LAN', 'LED', 'MID'];
const TAG_LABELS = {
    CUT: '✂️ CUT',
    INK: '💻 INK',
    LAN: '💡 LAN',
    LED: '📗 LED',
    MID: '🌑 MID',
};

function extractTagFromTitle(title) {
    // Match a known tag optionally preceded by emoji/non-letter chars, followed by ':'
    // Handles: "✂️ CUT: ...", "💡LAN: ..." (no space), "💻 INK: ...", plain titles
    const m = (title || '').match(/(?:^|[^\p{L}])(CUT|INK|LAN|LED|MID)\s*:/u);
    return m ? m[1] : null;
}

function stripTagPrefix(title, tag) {
    // Strip everything up to and including "<TAG>:" plus trailing whitespace
    if (!tag) return title || '';
    const re = new RegExp(`^.*?\\b${tag}\\s*:\\s*`);
    return (title || '').replace(re, '').trim();
}

// Display-time only: drop a leading "<Month> <YYYY> " from course titles so
// recurring series like "August 2025 FFA Publishing Summit" surface as plain
// "FFA Publishing Summit" in the sidebar. The DB row keeps its full title so
// the scraper and search remain authoritative.
function displayCourseTitle(title) {
    if (!title) return '';
    return title.replace(/^(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\s+/i, '').trim() || title;
}

function buildCourseTreeRoots() {
    const all = (state.courses || []).slice();
    const groups = new Map(); // tag -> [courses]
    const other = [];
    for (const c of all) {
        const tag = extractTagFromTitle(c.title);
        if (tag) {
            if (!groups.has(tag)) groups.set(tag, []);
            groups.get(tag).push(c);
        } else {
            other.push(c);
        }
    }
    const roots = [];
    for (const tag of TAG_ORDER) {
        const list = groups.get(tag);
        if (!list || list.length === 0) continue;
        list.sort((a, b) => stripTagPrefix(a.title, tag).localeCompare(stripTagPrefix(b.title, tag)));
        roots.push({
            kind: 'tag-group',
            id: `tag-${tag}`,
            tag,
            label: `${TAG_LABELS[tag] || tag} (${list.length})`,
            courses: list,
            expandable: true,
        });
    }
    if (other.length > 0) {
        other.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        roots.push({
            kind: 'tag-group',
            id: 'tag-OTHER',
            tag: 'OTHER',
            label: `Other (${other.length})`,
            courses: other,
            expandable: true,
        });
    }
    return roots;
}

function buildUnassignedSourcesRoots() {
    // Sources that haven't been FK-matched to any scraped course. The
    // auto-match migration in server/db.js handles exact-name equality;
    // anything left in this bucket is genuinely standalone content
    // (podcasts, YouTube playlists, legacy imports) or an exact-match miss
    // a user can fix manually with a UPDATE sources SET course_id = ... .
    return (state.sources || [])
        .filter(s => s.course_id == null && !String(s.id).startsWith('course-'))
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map(s => ({
            kind: 'source',
            id: `source-${s.id}`,
            rawId: s.id,
            label: s.name || `Source ${s.id}`,
            count: s.transcript_count || 0,
            expandable: true,
        }));
}

function groupLecturesByClassNumber(lectures) {
    const groups = new Map();
    const orphans = [];
    for (const lec of lectures) {
        if (lec.class_number) {
            if (!groups.has(lec.class_number)) groups.set(lec.class_number, []);
            groups.get(lec.class_number).push(lec);
        } else {
            orphans.push(lec);
        }
    }
    const result = [];
    for (const [cn, lecs] of groups) {
        const first = lecs[0];
        const titleStripped = (first.title || '')
            .replace(/^\d{2,4}\s*[-–]\s*/, '')
            .replace(/^Class\s+\d+\s*[-–]\s*/i, '')
            .trim();
        result.push({
            kind: 'class',
            classNumber: cn,
            label: `${cn} — ${titleStripped || '(no title)'}`,
            lectures: lecs,
        });
    }
    result.sort((a, b) => Number(a.classNumber) - Number(b.classNumber));
    for (const orphan of orphans) {
        result.push({ kind: 'lecture-orphan', lecture: orphan });
    }
    return result;
}

async function ensureCourseTreeLoaded(courseId) {
    if (state.tree.cache.has(courseId)) return state.tree.cache.get(courseId);
    try {
        const sections = await api(`/api/courses/${courseId}/sections?include_lectures=true`);
        state.tree.cache.set(courseId, sections);
        return sections;
    } catch (err) {
        console.warn('failed to load course tree', courseId, err);
        return [];
    }
}

async function ensureSourceLecturesLoaded(sourceId) {
    const cacheKey = `source-${sourceId}`;
    if (state.tree.cache.has(cacheKey)) return state.tree.cache.get(cacheKey);
    try {
        const lectures = await api(`/api/lectures?source_id=${encodeURIComponent(sourceId)}`);
        state.tree.cache.set(cacheKey, lectures);
        return lectures;
    } catch (err) {
        console.warn('failed to load source lectures', sourceId, err);
        return [];
    }
}

async function ensureLectureTranscriptsLoaded(lectureId) {
    const cacheKey = `lecture-transcripts-${lectureId}`;
    if (state.tree.cache.has(cacheKey)) return state.tree.cache.get(cacheKey);
    try {
        const transcripts = await api(`/api/courses/lectures/${lectureId}/transcripts`);
        state.tree.cache.set(cacheKey, transcripts);
        return transcripts;
    } catch (err) {
        console.warn('failed to load lecture transcripts', lectureId, err);
        return [];
    }
}

async function ensureCourseOrphanTranscriptsLoaded(courseId) {
    const cacheKey = `course-orphan-transcripts-${courseId}`;
    if (state.tree.cache.has(cacheKey)) return state.tree.cache.get(cacheKey);
    try {
        const transcripts = await api(`/api/courses/${courseId}/orphan-transcripts`);
        state.tree.cache.set(cacheKey, transcripts);
        return transcripts;
    } catch (err) {
        console.warn('failed to load course orphan transcripts', courseId, err);
        return [];
    }
}

function renderTreeNode(node, depth, parentEl) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node-wrap';

    const row = document.createElement('div');
    row.className = 'tree-node';
    row.dataset.nodeId = node.id || '';
    row.dataset.kind = node.kind;
    row.style.paddingLeft = `${6 + depth * 14}px`;

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    // Lectures become expandable when they have FK-linked transcripts to surface
    // as children. Transcript nodes themselves are always leaves.
    const lectureHasTranscripts = (
        (node.kind === 'lecture' || node.kind === 'lecture-orphan')
        && node.lecture
        && Number(node.lecture.transcript_count || 0) > 0
    );
    const isLeaf = (
        node.kind === 'transcript'
        || ((node.kind === 'lecture' || node.kind === 'lecture-orphan') && !lectureHasTranscripts)
    );
    if (isLeaf) {
        chevron.classList.add('leaf');
    } else {
        chevron.textContent = '▸';
        const nodeKey = node.id || (node.kind === 'class' ? `class-${node.classNumber}` : null);
        if (nodeKey && state.expanded.has(nodeKey)) {
            chevron.classList.add('expanded');
        }
    }
    row.appendChild(chevron);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.label || node.title || '(untitled)';
    row.appendChild(label);

    if (typeof node.count === 'number' && node.count > 0) {
        const countEl = document.createElement('span');
        countEl.className = 'tree-count';
        countEl.textContent = String(node.count);
        row.appendChild(countEl);
    }

    // Active highlight
    const isActive = (
        (node.kind === 'course' && state.activeSource === node.id) ||
        (node.kind === 'source' && state.activeSource === String(node.rawId)) ||
        (node.kind === 'section' && state.activeSection === node.rawId) ||
        (node.kind === 'class' && state.activeClassNumber === node.classNumber) ||
        ((node.kind === 'lecture' || node.kind === 'lecture-orphan') && state.activeLectureId === (node.lecture && node.lecture.id)) ||
        (node.kind === 'transcript' && state.activeTranscriptId === (node.transcript && node.transcript.id))
    );
    if (isActive) row.classList.add('active');

    // Click handlers
    chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isLeaf) toggleNode(node);
    });
    row.addEventListener('click', () => {
        selectTreeNode(node);
    });

    wrap.appendChild(row);
    parentEl.appendChild(wrap);

    // Render children if expanded
    const nodeKey = node.id || (node.kind === 'class' ? `class-${node.classNumber}` : null);
    if (!isLeaf && nodeKey && state.expanded.has(nodeKey)) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'tree-children';
        wrap.appendChild(childrenEl);
        renderChildren(node, depth + 1, childrenEl);
    }
}

function renderChildren(parentNode, depth, childrenEl) {
    if (parentNode.kind === 'tag-group') {
        for (const course of parentNode.courses) {
            const courseLabel = parentNode.tag === 'OTHER'
                ? (displayCourseTitle(course.title) || `Course ${course.id}`)
                : stripTagPrefix(course.title, parentNode.tag) || course.title || `Course ${course.id}`;
            const courseNode = {
                kind: 'course',
                id: `course-${course.id}`,
                rawId: course.id,
                label: courseLabel,
                count: course.lecture_count || 0,
                expandable: true,
            };
            renderTreeNode(courseNode, depth, childrenEl);
        }
        return;
    }
    if (parentNode.kind === 'course') {
        const sections = state.tree.cache.get(parentNode.rawId) || [];
        if (sections.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.textContent = '(no sections)';
            empty.style.paddingLeft = `${6 + depth * 14}px`;
            childrenEl.appendChild(empty);
            return;
        }
        for (const sec of sections) {
            const secNode = {
                kind: 'section',
                id: `section-${sec.id}`,
                rawId: sec.id,
                label: sec.title || '(untitled section)',
                count: (sec.lectures || []).length,
                courseId: parentNode.rawId,
                lectures: sec.lectures || [],
            };
            renderTreeNode(secNode, depth, childrenEl);
        }
        // Course-level orphan transcripts: legacy imports whose source matched
        // this course but whose individual lecture didn't match any scraped
        // lecture title. Surface them as an "Other Transcripts" group so they
        // remain reachable from the course.
        const course = (state.courses || []).find(c => c.id === parentNode.rawId);
        const orphanCount = course ? Number(course.orphan_transcript_count || 0) : 0;
        if (orphanCount > 0) {
            renderTreeNode({
                kind: 'course-orphans',
                id: `course-orphans-${parentNode.rawId}`,
                courseId: parentNode.rawId,
                label: 'Other Transcripts',
                count: orphanCount,
            }, depth, childrenEl);
        }
    } else if (parentNode.kind === 'section') {
        const groups = groupLecturesByClassNumber(parentNode.lectures || []);
        for (const grp of groups) {
            if (grp.kind === 'class') {
                renderTreeNode(grp, depth, childrenEl);
            } else if (grp.kind === 'lecture-orphan') {
                renderTreeNode(makeLectureNode(grp.lecture, grp.lecture.title || '(untitled)'), depth, childrenEl);
            }
        }
    } else if (parentNode.kind === 'class') {
        for (const lec of parentNode.lectures || []) {
            const stripped = (lec.title || '')
                .replace(new RegExp(`^${parentNode.classNumber}\\s*[-–]\\s*`), '')
                .trim();
            renderTreeNode(makeLectureNode(lec, stripped || lec.title || '(untitled)'), depth, childrenEl);
        }
    } else if (parentNode.kind === 'source') {
        const lectures = state.tree.cache.get(`source-${parentNode.rawId}`) || [];
        if (lectures.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.textContent = '(no lectures)';
            empty.style.paddingLeft = `${6 + depth * 14}px`;
            childrenEl.appendChild(empty);
            return;
        }
        for (const lec of lectures) {
            renderTreeNode({
                kind: 'lecture',
                label: lec.lecture || lec.title || '(untitled)',
                lecture: lec,
            }, depth, childrenEl);
        }
    } else if (parentNode.kind === 'lecture' || parentNode.kind === 'lecture-orphan') {
        const transcripts = state.tree.cache.get(`lecture-transcripts-${parentNode.lecture.id}`) || [];
        if (transcripts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.textContent = '(no transcripts)';
            empty.style.paddingLeft = `${6 + depth * 14}px`;
            childrenEl.appendChild(empty);
            return;
        }
        for (const t of transcripts) {
            renderTreeNode({
                kind: 'transcript',
                id: `transcript-${t.id}`,
                transcript: t,
                label: transcriptLabel(t),
            }, depth, childrenEl);
        }
    } else if (parentNode.kind === 'course-orphans') {
        const transcripts = state.tree.cache.get(`course-orphan-transcripts-${parentNode.courseId}`) || [];
        if (transcripts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'tree-empty';
            empty.textContent = '(no orphan transcripts)';
            empty.style.paddingLeft = `${6 + depth * 14}px`;
            childrenEl.appendChild(empty);
            return;
        }
        for (const t of transcripts) {
            renderTreeNode({
                kind: 'transcript',
                id: `transcript-${t.id}`,
                transcript: t,
                label: `${t.lecture || '(unnamed)'} — ${transcriptLabel(t)}`,
            }, depth, childrenEl);
        }
    }
}

function makeLectureNode(lec, label) {
    return {
        kind: 'lecture',
        id: lec && lec.id != null ? `lecture-${lec.id}` : null,
        label,
        lecture: lec,
    };
}

function transcriptLabel(t) {
    // Prefer the transcript_type ("Live Class", "Q&A", …) when present —
    // it's the most useful distinguisher when a lecture has multiple
    // transcripts. Fall back to the filename.
    return t.transcript_type || t.filename || `Transcript ${t.id}`;
}

function renderTree() {
    if (!el.sourceTree) return;
    el.sourceTree.innerHTML = '';
    const roots = buildCourseTreeRoots();
    if (roots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tree-empty';
        empty.textContent = '(no courses)';
        el.sourceTree.appendChild(empty);
    } else {
        for (const root of roots) {
            renderTreeNode(root, 0, el.sourceTree);
        }
    }
    renderUnassignedSourcesTree();
}

function renderUnassignedSourcesTree() {
    if (!el.unassignedTree || !el.unassignedSection) return;
    el.unassignedTree.innerHTML = '';
    const roots = buildUnassignedSourcesRoots();
    // Hide the entire section when there's nothing to show — keeps the
    // sidebar uncluttered for users whose imports all matched a course.
    el.unassignedSection.classList.toggle('hidden', roots.length === 0);
    if (roots.length === 0) return;
    const expanded = state.expanded.has('unassigned-root');
    if (el.unassignedToggle) {
        el.unassignedToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        el.unassignedToggle.dataset.count = String(roots.length);
    }
    el.unassignedTree.classList.toggle('hidden', !expanded);
    if (!expanded) return;
    for (const root of roots) {
        renderTreeNode(root, 0, el.unassignedTree);
    }
}

async function toggleNode(node) {
    const key = node.id || (node.kind === 'class' ? `class-${node.classNumber}` : null);
    if (!key) return;
    if (state.expanded.has(key)) {
        state.expanded.delete(key);
    } else {
        state.expanded.add(key);
        // Lazy-load children
        if (node.kind === 'course') {
            await ensureCourseTreeLoaded(node.rawId);
        } else if (node.kind === 'source') {
            await ensureSourceLecturesLoaded(node.rawId);
        } else if (node.kind === 'lecture' || node.kind === 'lecture-orphan') {
            if (node.lecture && node.lecture.id != null) {
                await ensureLectureTranscriptsLoaded(node.lecture.id);
            }
        } else if (node.kind === 'course-orphans') {
            await ensureCourseOrphanTranscriptsLoaded(node.courseId);
        }
    }
    persistExpanded();
    renderTree();
}

async function selectTreeNode(node) {
    if (node.kind === 'tag-group') {
        await toggleNode(node);
        return;
    }
    if (node.kind === 'course') {
        state.activeSource = `course-${node.rawId}`;
        state.activeSection = null;
        state.activeClassNumber = null;
        state.activeLectureId = null;
        if (el.filterSource) el.filterSource.value = state.activeSource;
        await loadTranscripts();
    } else if (node.kind === 'section') {
        state.activeSource = `course-${node.courseId}`;
        state.activeSection = node.rawId;
        state.activeClassNumber = null;
        state.activeLectureId = null;
        if (el.filterSource) el.filterSource.value = state.activeSource;
        await loadTranscripts();
    } else if (node.kind === 'class') {
        // Find the parent course/section from cache
        let foundCourseId = null;
        let foundSectionId = null;
        for (const [courseId, sections] of state.tree.cache.entries()) {
            if (typeof courseId !== 'number') continue;
            for (const sec of sections) {
                if ((sec.lectures || []).some(l => l.class_number === node.classNumber)) {
                    foundCourseId = courseId;
                    foundSectionId = sec.id;
                    break;
                }
            }
            if (foundCourseId) break;
        }
        if (foundCourseId) {
            state.activeSource = `course-${foundCourseId}`;
            state.activeSection = foundSectionId;
            state.activeClassNumber = node.classNumber;
            state.activeLectureId = null;
            if (el.filterSource) el.filterSource.value = state.activeSource;
            await loadTranscripts();
        }
    } else if (node.kind === 'lecture' || node.kind === 'lecture-orphan') {
        const lec = node.lecture;
        if (lec && lec.id != null) {
            state.activeLectureId = lec.id;
            state.activeTranscriptId = null;
            // course_lectures rows have section_id; non-course lectures don't
            const detailId = lec.section_id != null ? `clec-${lec.id}` : lec.id;
            loadTranscriptDetail(detailId);
        }
    } else if (node.kind === 'transcript') {
        const t = node.transcript;
        if (t && t.id != null) {
            state.activeTranscriptId = t.id;
            loadTranscriptDetail(t.id);
        }
    } else if (node.kind === 'course-orphans') {
        await toggleNode(node);
        return;
    }
    renderTree();
}

async function expandToActive() {
    if (state.activeSource && state.activeSource.startsWith('course-')) {
        const courseId = Number(state.activeSource.replace('course-', ''));
        // Expand the tag-group ancestor so the active course is visible
        const course = (state.courses || []).find(c => c.id === courseId);
        if (course) {
            const tag = extractTagFromTitle(course.title) || 'OTHER';
            state.expanded.add(`tag-${tag}`);
        }
        state.expanded.add(`course-${courseId}`);
        await ensureCourseTreeLoaded(courseId);
        if (state.activeSection) {
            state.expanded.add(`section-${state.activeSection}`);
        }
        if (state.activeClassNumber) {
            state.expanded.add(`class-${state.activeClassNumber}`);
        }
    } else if (state.activeSource) {
        state.expanded.add(`source-${state.activeSource}`);
        state.expanded.add('unassigned-root');
        await ensureSourceLecturesLoaded(state.activeSource);
    }
}

async function initTree() {
    restoreExpanded();
    // Pre-load any already-expanded course nodes
    for (const nodeId of state.expanded) {
        if (nodeId.startsWith('course-')) {
            const courseId = Number(nodeId.replace('course-', ''));
            await ensureCourseTreeLoaded(courseId);
        } else if (nodeId.startsWith('source-')) {
            const sourceId = nodeId.replace('source-', '');
            await ensureSourceLecturesLoaded(sourceId);
        }
    }
    await expandToActive();
    renderTree();
}

function clearTreeCache(courseId) {
    if (courseId != null) {
        state.tree.cache.delete(courseId);
        state.tree.cache.delete(Number(courseId));
    } else {
        state.tree.cache.clear();
    }
}

// =============================================================================
// AI Search
// =============================================================================

function formatPrice(priceStr) {
    const p = parseFloat(priceStr);
    if (!p || isNaN(p)) return null;
    const perMillion = p * 1e6;
    return perMillion < 0.01 ? '<$0.01' : `$${perMillion.toFixed(2)}`;
}

async function loadAiSettings() {
    try {
        const settings = await api('/api/ai/settings');
        state.hasApiKey = settings.hasKey;
        state.selectedModel = settings.selectedModel || '';
        updateAiToggleState();
    } catch (e) {
        console.error('Failed to load AI settings:', e);
    }
}

function updateAiToggleState() {
    el.aiToggle.classList.toggle('active', state.aiMode);
    if (state.aiMode) {
        el.searchInput.placeholder = 'Ask a question about transcripts & courses... (AI powered)';
    } else {
        el.searchInput.placeholder = 'Search transcripts & courses... (e.g., LLC formation, pen names, Claude)';
    }
}

function hideAiAnswer() {
    el.aiAnswerContainer.classList.add('hidden');
}

async function doAiAsk(question) {
    if (!state.hasApiKey) {
        openSettings();
        el.settingsKeyStatus.textContent = 'Please add your OpenRouter API key first';
        el.settingsKeyStatus.classList.add('error');
        return;
    }
    if (!state.selectedModel) {
        openSettings();
        el.settingsModelStatus.textContent = 'Please select a model first';
        el.settingsModelStatus.classList.add('error');
        return;
    }

    // Abort any in-flight request
    if (state.aiAbortController) {
        state.aiAbortController.abort();
    }
    state.aiAbortController = new AbortController();

    // Show answer card with thinking state
    el.aiAnswerContainer.classList.remove('hidden');
    el.aiAnswerBody.innerHTML = '<div class="ai-thinking">Searching transcripts and thinking...</div>';
    el.aiAnswerFooter.classList.add('hidden');
    el.aiModelLabel.textContent = state.selectedModel;
    el.searchMeta.textContent = `AI searching for: "${question}"`;
    switchView('search');
    el.resultsList.innerHTML = '';
    el.searchTitle.textContent = 'AI Search Results';

    try {
        const body = { question };
        if (state.activeSource) body.source_id = state.activeSource;
        if (state.activeLecture) body.lecture = state.activeLecture;
        if (state.activeType) body.type = state.activeType;
        const selectedCourses = getSelectedCourseIds();
        if (selectedCourses.length > 0) body.courses = selectedCourses.join(',');

        const response = await fetch('/api/ai/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: state.aiAbortController.signal,
        });

        if (!response.ok) {
            const err = await response.json();
            el.aiAnswerBody.innerHTML = `<div style="color: #ff6b6b">${escapeHtml(err.error || 'Request failed')}</div>`;
            return;
        }

        // Stream SSE
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let chunksUsed = 0;

        el.aiAnswerBody.innerHTML = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const event = JSON.parse(line.slice(6));
                    if (event.type === 'context') {
                        chunksUsed = event.chunks;
                    } else if (event.type === 'text') {
                        fullText += event.content;
                        el.aiAnswerBody.innerHTML = renderMarkdown(fullText);
                    } else if (event.type === 'usage') {
                        const u = event.usage;
                        el.aiUsage.textContent = `${u.prompt_tokens} in / ${u.completion_tokens} out tokens`;
                    } else if (event.type === 'done') {
                        // Show footer
                        el.aiAnswerFooter.classList.remove('hidden');
                        el.aiChunksUsed.textContent = `${chunksUsed} transcript chunks used as context`;
                        el.searchMeta.textContent = `AI answer based on ${chunksUsed} relevant transcript chunks`;
                    } else if (event.type === 'error') {
                        el.aiAnswerBody.innerHTML += `<div style="color: #ff6b6b; margin-top: 8px">${escapeHtml(event.message)}</div>`;
                    }
                } catch (e) { /* skip */ }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('AI ask failed:', e);
        el.aiAnswerBody.innerHTML = `<div style="color: #ff6b6b">Failed to get AI response: ${escapeHtml(e.message)}</div>`;
    }
}

/** Simple markdown-like rendering for AI responses */
function renderMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Use placeholder tags to keep bullet vs numbered items distinct until wrapping
    html = html.replace(/^- (.+)$/gm, '<bli>$1</bli>');
    html = html.replace(/^\d+\.\s(.+)$/gm, '<oli>$1</oli>');
    html = html.replace(/(<bli>.+?<\/bli>\n?)+/g, match =>
        '<ul>' + match.replace(/<bli>(.+?)<\/bli>\n?/g, '<li>$1</li>') + '</ul>');
    html = html.replace(/(<oli>.+?<\/oli>\n?)+/g, match =>
        '<ol>' + match.replace(/<oli>(.+?)<\/oli>\n?/g, '<li>$1</li>') + '</ol>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    return `<p>${html}</p>`;
}

// =============================================================================
// Settings Modal
// =============================================================================

function openSettings() {
    el.settingsOverlay.classList.remove('hidden');
    // Load current masked key
    loadAiSettings().then(() => {
        if (state.hasApiKey) {
            el.settingsKeyStatus.textContent = '✓ API key is saved';
            el.settingsKeyStatus.classList.remove('error');
        }
        if (state.selectedModel) {
            el.modelTrigger.textContent = state.selectedModel;
        }
    });
    // Refresh media library path info
    loadMediaLibrarySettings();
}

function closeSettings() {
    el.settingsOverlay.classList.add('hidden');
    el.modelList.classList.add('hidden');
}

async function saveApiKey() {
    const key = el.settingsApiKey.value.trim();
    if (!key) return;
    try {
        const res = await fetch('/api/ai/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: key }),
        });
        const data = await res.json();
        state.hasApiKey = data.hasKey;
        el.settingsKeyStatus.textContent = '✓ API key saved';
        el.settingsKeyStatus.classList.remove('error');
        el.settingsApiKey.value = '';
        el.settingsApiKey.placeholder = data.apiKey; // Show masked key
        updateAiToggleState();
    } catch (e) {
        el.settingsKeyStatus.textContent = 'Failed to save key';
        el.settingsKeyStatus.classList.add('error');
    }
}

async function fetchModels() {
    el.settingsModelStatus.textContent = 'Loading models...';
    el.settingsModelStatus.classList.remove('error');
    try {
        const data = await api('/api/ai/models');
        state.aiModels = data.models;
        el.settingsModelStatus.textContent = `${data.count} models available`;
        renderModelList(state.aiModels);
    } catch (e) {
        el.settingsModelStatus.textContent = e.message || 'Failed to fetch models';
        el.settingsModelStatus.classList.add('error');
    }
}

function renderModelList(models, filter = '') {
    const filtered = filter
        ? models.filter(m => m.id.toLowerCase().includes(filter) || (m.name || '').toLowerCase().includes(filter))
        : models;

    // Build HTML
    let html = '<input type="text" class="model-search-input" placeholder="Filter models..." />';
    for (const m of filtered) {
        const isSelected = m.id === state.selectedModel;
        const inPrice = m.pricing ? formatPrice(m.pricing.prompt) : null;
        const outPrice = m.pricing ? formatPrice(m.pricing.completion) : null;
        const pricingStr = (inPrice || outPrice) ? `${inPrice || '-'} / ${outPrice || '-'}` : '';

        html += `<div class="model-item ${isSelected ? 'selected' : ''}" data-model-id="${escapeHtml(m.id)}">
            <span class="model-item-check">${isSelected ? '✓' : ''}</span>
            <span class="model-item-name">${escapeHtml(m.name || m.id)}</span>
            ${pricingStr ? `<span class="model-item-pricing">${pricingStr}</span>` : ''}
        </div>`;
    }

    el.modelList.innerHTML = html;

    // Re-bind search filter
    const searchInput = el.modelList.querySelector('.model-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            renderModelList(models, e.target.value.toLowerCase());
            // Re-focus the search input after re-render
            const newInput = el.modelList.querySelector('.model-search-input');
            if (newInput) { newInput.focus(); newInput.value = e.target.value; }
        });
        // Focus on first open
        if (!filter) setTimeout(() => searchInput.focus(), 50);
    }

    // Bind click to select
    el.modelList.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', async () => {
            const modelId = item.dataset.modelId;
            state.selectedModel = modelId;
            el.modelTrigger.textContent = modelId;
            el.modelList.classList.add('hidden');
            // Save to server
            await fetch('/api/ai/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selectedModel: modelId }),
            });
            el.settingsModelStatus.textContent = `Selected: ${modelId}`;
        });
    });
}

function setupSettingsListeners() {
    // Open/close settings
    el.settingsBtn.addEventListener('click', openSettings);
    el.settingsClose.addEventListener('click', closeSettings);
    el.settingsOverlay.addEventListener('click', (e) => {
        if (e.target === el.settingsOverlay) closeSettings();
    });

    // Save API key
    el.settingsSaveKey.addEventListener('click', saveApiKey);
    el.settingsApiKey.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveApiKey();
    });

    // Refresh models
    el.settingsRefreshModels.addEventListener('click', fetchModels);

    // Model dropdown toggle
    el.modelTrigger.addEventListener('click', () => {
        const isOpen = !el.modelList.classList.contains('hidden');
        el.modelList.classList.toggle('hidden');
        if (!isOpen && state.aiModels.length > 0) {
            renderModelList(state.aiModels);
        }
    });

    // AI toggle
    el.aiToggle.addEventListener('click', () => {
        state.aiMode = !state.aiMode;
        updateAiToggleState();
        if (!state.aiMode) {
            hideAiAnswer();
            if (state.searchQuery) {
                doSearch(state.searchQuery);
            }
        }
    });

    // Close model dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!el.modelDropdown.contains(e.target)) {
            el.modelList.classList.add('hidden');
        }
    });
}

// --- Notion Bar ---
function updateNotionBar(courseId) {
    if (!el.notionBar) return;
    const course = (state.courses || []).find(c => String(c.id) === String(courseId));
    if (!course) { el.notionBar.classList.add('hidden'); return; }

    if (!course.notion_url) { el.notionBar.classList.add('hidden'); return; }

    el.notionBar.classList.remove('hidden');
    if (course.notion_url) {
        el.notionLink.href = course.notion_url;
        el.notionLink.textContent = 'View Notes in Notion →';
        el.notionLink.classList.remove('hidden');
        el.notionEditBtn.textContent = 'Edit URL';
    } else {
        el.notionLink.classList.add('hidden');
        el.notionEditBtn.textContent = 'Add Notion URL';
    }

    el.notionEditBtn.onclick = async () => {
        const current = course.notion_url || '';
        const input = window.prompt('Paste the Notion URL for this course:', current);
        if (input === null) return;
        const url = input.trim();
        try {
            await api(`/api/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify({ notion_url: url || null }) });
            state.courses = await api('/api/courses');
            renderCourseList();
            updateNotionBar(courseId);
        } catch (err) {
            alert('Failed to save Notion URL: ' + err.message);
        }
    };
}

// --- Render Functions ---
function renderLectureList(lectures) {
    if (!el.lectureListSelect) return;
    const isCourse = state.activeSource?.startsWith('course-');

    // Build options: "All" entry + one per lecture/section
    let html = `<option value="">${isCourse ? 'All Sections' : 'All Sessions'}</option>`;
    for (const lecture of lectures) {
        const namePart = lecture.lecture ? lecture.lecture.replace(/\(\d+:\d+\)/, '').trim() : '';
        const datePart = lecture.lecture_date ? ` (${lecture.lecture_date})` : '';
        // For courses we store sectionId as the value; for transcripts we store the lecture name
        const value = isCourse ? String(lecture.sectionId) : lecture.lecture;
        html += `<option value="${escapeHtml(value)}">${escapeHtml(namePart)}${escapeHtml(datePart)}</option>`;
    }
    el.lectureListSelect.innerHTML = html;

    // Reflect current active state
    if (isCourse && state.activeSection != null) {
        el.lectureListSelect.value = String(state.activeSection);
    } else if (!isCourse && state.activeLecture) {
        el.lectureListSelect.value = state.activeLecture;
    } else {
        el.lectureListSelect.value = '';
    }
}

function renderTranscriptGrid(transcripts) {
    if (transcripts.length === 0) {
        el.transcriptGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">No transcripts found</div>
        <div class="empty-text">Try adjusting your filters or import data first.</div>
      </div>
    `;
        return;
    }

    el.transcriptGrid.innerHTML = '';
    for (let i = 0; i < transcripts.length; i++) {
        const t = transcripts[i];
        const card = document.createElement('div');
        card.className = 'transcript-card animate-in';
        card.style.animationDelay = `${i * 30}ms`;

        const badgeClass = getBadgeClass(t.transcript_type);
        const durationStr = t.duration_minutes
            ? `${Math.round(t.duration_minutes)} min`
            : '';

        card.innerHTML = `
      <div class="card-lecture">
        ${t.class_number ? `<span class="class-number-badge">${escapeHtml(t.class_number)}</span>` : ''}
        ${escapeHtml(t.lecture)}
      </div>
      <div class="card-filename">${escapeHtml(t.filename)}</div>
      <div class="card-meta">
        <span class="card-badge ${badgeClass}">${escapeHtml(t.transcript_type || 'Unknown')}</span>
        ${t.lecture_date ? `<span class="card-date">${t.lecture_date}</span>` : ''}
        ${durationStr ? `<span class="card-duration">${durationStr}</span>` : ''}
      </div>
    `;

        card.onclick = () => loadTranscriptDetail(t.id);
        el.transcriptGrid.appendChild(card);
    }
}

function renderSearchResults(results) {
    if (results.length === 0) {
        el.resultsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No results found</div>
        <div class="empty-text">Try different keywords or remove some filters.</div>
      </div>
    `;
        return;
    }

    el.resultsList.innerHTML = '';
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const card = document.createElement('div');
        card.className = 'result-card animate-in';
        card.style.animationDelay = `${i * 25}ms`;

        if (r.result_type === 'course') {
            card.innerHTML = `
              <div class="result-header">
                <div>
                  <div class="result-lecture">
                    ${r.class_number ? `<span class="class-number-badge">${escapeHtml(r.class_number)}</span>` : ''}
                    ${escapeHtml(r.lecture_title || '')}
                  </div>
                  <div class="result-filename">${escapeHtml(r.course_title || '')} › ${escapeHtml(r.section_title || '')}</div>
                </div>
                <span class="card-badge badge-course">Course</span>
              </div>
              <div class="result-snippet">${safeSnippet(r.snippet)}</div>
              <div class="result-meta">
                ${r.duration ? `<span class="card-duration">${r.duration}</span>` : ''}
              </div>
            `;
            card.onclick = async () => {
                const query = state.searchQuery;
                state.activeSource = `course-${r.course_id}`;
                state.activeSection = null;
                state.activeClassNumber = null;
                state.activeLecture = '';
                el.filterSource.value = state.activeSource;
                state.searchQuery = '';
                el.searchInput.value = '';
                el.searchClear.classList.add('hidden');
                loadTranscripts();
                loadTranscriptDetail(`clec-${r.lecture_id}`, query);
                await expandToActive();
                renderTree();
            };
        } else {
            const badgeClass = getBadgeClass(r.transcript_type);
            card.innerHTML = `
              <div class="result-header">
                <div>
                  <div class="result-lecture">${escapeHtml(r.lecture)}</div>
                  <div class="result-filename">${escapeHtml(r.filename)}</div>
                </div>
                <span class="card-badge ${badgeClass}">${escapeHtml(r.transcript_type || '')}</span>
              </div>
              <div class="result-snippet">${safeSnippet(r.snippet)}</div>
              <div class="result-meta">
                ${r.start_timestamp ? `<span class="result-timestamp">⏱ ${r.start_timestamp}</span>` : ''}
                ${r.lecture_date ? `<span class="card-date">${r.lecture_date}</span>` : ''}
              </div>
            `;
            card.onclick = async () => {
                const query = state.searchQuery;
                state.activeSource = String(r.source_id);
                state.activeLecture = r.lecture;
                state.activeSection = null;
                state.activeClassNumber = null;
                el.filterSource.value = state.activeSource;
                state.searchQuery = '';
                el.searchInput.value = '';
                el.searchClear.classList.add('hidden');
                loadTranscripts();
                loadTranscriptDetail(r.transcript_id, query);
                await expandToActive();
                renderTree();
            };
        }

        el.resultsList.appendChild(card);
    }
}

function renderTranscriptDetail(transcript, highlightQuery) {
    const hasPlayer = transcript.videos && transcript.videos.length > 0;

    // For multi-video lectures, the visible transcript is filtered by the
    // active video tab. Chunks carry video_index (0-based), matching the tab
    // index. If no chunks have video_index (legacy/pre-fix data or
    // single-video lecture), show the whole transcript like before.
    function rawTextForVideo(videoIndex) {
        const chunks = Array.isArray(transcript.chunks) ? transcript.chunks : [];
        if (chunks.length > 0 && transcript.videos && transcript.videos.length > 1) {
            const taggedChunks = chunks.filter(c => c.video_index !== null && c.video_index !== undefined);
            if (taggedChunks.length > 0) {
                const filtered = taggedChunks.filter(c => c.video_index === videoIndex);
                if (filtered.length > 0) {
                    return filtered
                        .sort((a, b) => (a.position || 0) - (b.position || 0))
                        .map(c => c.content)
                        .join('\n\n---\n\n');
                }
            }
        }
        return transcript.content || '';
    }

    function decorateContent(rawText) {
        let html = escapeHtml(rawText);
        html = html.replace(
            /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g,
            (match, p1, p2, p3) => {
                const seconds = p3 != null
                    ? Number(p1) * 3600 + Number(p2) * 60 + Number(p3)
                    : Number(p1) * 60 + Number(p2);
                if (!hasPlayer) return `<span class="timestamp">${match}</span>`;
                return `<a class="timestamp-link" data-seconds="${seconds}" href="#" title="Seek to ${match}">${match}</a>`;
            }
        );
        html = html.replace(
            /^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*:/gm,
            '<span class="speaker">$1:</span>'
        );
        if (highlightQuery) {
            const terms = highlightQuery.split(/\s+/).filter(t => t.length > 1);
            for (const term of terms) {
                const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
                html = html.replace(regex, '<mark>$1</mark>');
            }
        }
        html = html.replace(
            /(https?:\/\/[^\s<>"]+)/g,
            '<a href="$1" target="_blank" rel="noopener noreferrer" class="content-link">$1</a>'
        );
        return html;
    }

    let content = decorateContent(rawTextForVideo(0));

    // Detect the first Notion URL in the raw content for the "Set Notion URL" button
    const notionMatch = transcript.content?.match(/https?:\/\/[^\s]*notion\.site\/[^\s]*/);
    const notionUrlInContent = notionMatch ? notionMatch[0] : null;
    const showNotionBtn = transcript.result_type === 'course' && transcript.course_id && notionUrlInContent;

    const badgeClass = getBadgeClass(transcript.transcript_type);
    const durationStr = transcript.duration_minutes
        ? `${Math.round(transcript.duration_minutes)} min`
        : '';

    // Phase 7: restore saved player width + height (read before building HTML so
    // they can be inlined as style attributes — avoids layout flash)
    let savedPlayerHeight = null;
    let savedPlayerWidth = null;
    try {
        const h = Number(localStorage.getItem('tdb-player-height'));
        if (Number.isFinite(h) && h >= 200 && h <= window.innerHeight * 0.85) {
            savedPlayerHeight = h;
        }
        const w = Number(localStorage.getItem('tdb-player-width'));
        if (Number.isFinite(w) && w >= 280 && w <= window.innerWidth * 0.95) {
            savedPlayerWidth = w;
        }
    } catch { /* ignore */ }

    let playerHtml = '';
    let savedPlayerSpeed = 1;
    let savedAutoSequence = false;
    try {
        const s = Number(localStorage.getItem('tdb-player-speed'));
        if (Number.isFinite(s) && s >= 0.25 && s <= 4) savedPlayerSpeed = s;
        savedAutoSequence = localStorage.getItem('tdb-player-auto-sequence') === '1';
    } catch { /* ignore */ }

    if (transcript.videos && transcript.videos.length > 0 && transcript.lectureId) {
        const tabs = transcript.videos.length > 1
            ? transcript.videos.map((v, i) =>
                `<button class="lecture-player-tab${i === 0 ? ' active' : ''}" data-file="${escapeHtml(v.file)}">Video ${i + 1}</button>`
              ).join('')
            : '';
        const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
            .map(rate => `<option value="${rate}"${rate === savedPlayerSpeed ? ' selected' : ''}>${rate}×</option>`)
            .join('');
        const firstFile = transcript.videos[0].file;
        const styleParts = [];
        if (savedPlayerWidth) styleParts.push(`width: ${savedPlayerWidth}px`);
        if (savedPlayerHeight) styleParts.push(`height: ${savedPlayerHeight}px`);
        const playerStyle = styleParts.length ? ` style="${styleParts.join('; ')}"` : '';
        const autoSeqControl = transcript.videos.length > 1
            ? `<label class="lecture-player-auto-seq-label" title="When a video ends, advance to the next video in this lecture">
                    <input type="checkbox" class="lecture-player-auto-seq"${savedAutoSequence ? ' checked' : ''}>
                    <span>Auto-sequence</span>
               </label>`
            : '';
        playerHtml = `
        <div class="lecture-player-wrap"${playerStyle}>
            <div class="lecture-player-controls">
                <div class="lecture-player-tabs">${tabs}</div>
                ${autoSeqControl}
                <label class="lecture-player-speed-label">
                    <span class="lecture-player-speed-text">Speed</span>
                    <select class="lecture-player-speed" aria-label="Playback speed">${speedOptions}</select>
                </label>
            </div>
            <video id="lecture-player"
                   controls preload="metadata"
                   controlsList="nodownload noremoteplayback noplaybackrate"
                   disablePictureInPicture
                   data-lecture-id="${escapeHtml(String(transcript.lectureId))}"
                   data-active-file="${escapeHtml(firstFile)}"
                   src="/api/courses/lectures/${encodeURIComponent(transcript.lectureId)}/video/${encodeURIComponent(firstFile)}">
            </video>
        </div>
        `;
    }

    el.transcriptDetail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escapeHtml(transcript.lecture)}</div>
      <div class="detail-subtitle">${escapeHtml(transcript.filename)}</div>
      <div class="detail-meta">
        <span class="card-badge ${badgeClass}">${escapeHtml(transcript.transcript_type || '')}</span>
        ${transcript.lecture_date ? `<span class="card-date">${transcript.lecture_date}</span>` : ''}
        ${durationStr ? `<span class="card-duration">${durationStr}</span>` : ''}
        ${transcript.source_name ? `<span class="card-date">${escapeHtml(transcript.source_name)}</span>` : ''}
        ${showNotionBtn ? `<button class="set-notion-btn" data-course-id="${transcript.course_id}" data-url="${escapeHtml(notionUrlInContent)}">Set as course Notion URL</button>` : ''}
      </div>
    </div>
    ${playerHtml}
    <div class="detail-content">${content}</div>
  `;

    // Wire the Notion URL button
    const notionBtn = el.transcriptDetail.querySelector('.set-notion-btn');
    if (notionBtn) {
        notionBtn.addEventListener('click', async () => {
            const courseId = notionBtn.dataset.courseId;
            const url = notionBtn.dataset.url;
            try {
                await api(`/api/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify({ notion_url: url }) });
                state.courses = await api('/api/courses');
                renderCourseList();
                if (state.activeSource === `course-${courseId}`) loadTranscripts();
                notionBtn.textContent = 'Notion URL saved ✓';
                notionBtn.disabled = true;
            } catch (err) {
                alert('Failed to save: ' + err.message);
            }
        });
    }

    // Phase 6: timestamp-link click → seek + play the active video
    const player = el.transcriptDetail.querySelector('#lecture-player');
    if (player) {
        // Apply saved playback rate. `playbackRate` only sticks after metadata is loaded
        // (the browser may reset it during src changes), so apply both immediately AND
        // on loadedmetadata/ratechange-defeats. We also re-apply after tab switches.
        const applyRate = () => {
            try { player.playbackRate = savedPlayerSpeed; } catch { /* ignore */ }
        };
        applyRate();
        player.addEventListener('loadedmetadata', applyRate);

        // Speed selector
        const speedSelect = el.transcriptDetail.querySelector('.lecture-player-speed');
        if (speedSelect) {
            speedSelect.addEventListener('change', () => {
                const rate = Number(speedSelect.value);
                if (!Number.isFinite(rate)) return;
                savedPlayerSpeed = rate;
                try { player.playbackRate = rate; } catch { /* ignore */ }
                try { localStorage.setItem('tdb-player-speed', String(rate)); } catch { /* ignore */ }
            });
        }

        el.transcriptDetail.querySelectorAll('.timestamp-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const seconds = Number(link.dataset.seconds);
                if (!Number.isFinite(seconds)) return;
                player.currentTime = seconds;
                player.play().catch(() => { /* autoplay policy may reject — ignore */ });
                applyRate(); // play() can reset playbackRate on some platforms
            });
        });

        // Auto-sequence checkbox: persist the toggle and chain through the
        // remaining videos in this lecture when the current one ends.
        const autoSeqInput = el.transcriptDetail.querySelector('.lecture-player-auto-seq');
        let autoSequenceOn = savedAutoSequence;
        if (autoSeqInput) {
            autoSeqInput.addEventListener('change', () => {
                autoSequenceOn = autoSeqInput.checked;
                try { localStorage.setItem('tdb-player-auto-sequence', autoSequenceOn ? '1' : '0'); } catch { /* quota */ }
            });
        }

        // Phase 6: tab clicks → switch player src AND swap visible transcript
        // to the chunks tagged with the matching video_index.
        const detailContentEl = el.transcriptDetail.querySelector('.detail-content');
        const allTabs = el.transcriptDetail.querySelectorAll('.lecture-player-tab');
        el.transcriptDetail.querySelectorAll('.lecture-player-tab').forEach((tab, tabIndex) => {
            tab.addEventListener('click', () => {
                const file = tab.dataset.file;
                if (!file) return;
                const lectureId = player.dataset.lectureId;
                player.src = `/api/courses/lectures/${encodeURIComponent(lectureId)}/video/${encodeURIComponent(file)}`;
                player.dataset.activeFile = file;
                el.transcriptDetail.querySelectorAll('.lecture-player-tab').forEach(t =>
                    t.classList.toggle('active', t === tab)
                );
                applyRate(); // src change resets playbackRate

                // Swap transcript to the chunks for this video index.
                if (detailContentEl) {
                    detailContentEl.innerHTML = decorateContent(rawTextForVideo(tabIndex));
                    // Re-bind timestamp links for the new content
                    detailContentEl.querySelectorAll('.timestamp-link').forEach(link => {
                        link.addEventListener('click', (ev) => {
                            ev.preventDefault();
                            const s = Number(link.dataset.seconds);
                            if (Number.isFinite(s)) {
                                player.currentTime = s;
                                player.play().catch(() => {});
                                applyRate();
                            }
                        });
                    });
                }
            });
        });

        // Auto-sequence: when the current video finishes, jump to the next
        // tab's video and auto-play. Stops at the last tab — no cross-lecture
        // chaining by design. Toggle state is read live so flipping the
        // checkbox mid-playback takes effect on the next `ended`.
        if (allTabs.length > 1) {
            player.addEventListener('ended', () => {
                if (!autoSequenceOn) return;
                const activeIdx = [...allTabs].findIndex(t => t.classList.contains('active'));
                const nextTab = allTabs[activeIdx + 1];
                if (!nextTab) return; // last video — stop
                nextTab.click();
                // Tab click sets src; wait for the load and start playback.
                player.addEventListener('loadeddata', () => {
                    player.play().catch(() => { /* autoplay rejected — leave paused */ });
                }, { once: true });
            });
        }
    }

    // Phase 7: persist player width + height on every resize (user dragging the corner handle)
    const wrap = el.transcriptDetail.querySelector('.lecture-player-wrap');
    if (wrap && typeof ResizeObserver !== 'undefined') {
        let playerSaveTimer = null;
        const ro = new ResizeObserver(() => {
            if (playerSaveTimer) clearTimeout(playerSaveTimer);
            playerSaveTimer = setTimeout(() => {
                try {
                    const rect = wrap.getBoundingClientRect();
                    const h = Math.round(rect.height);
                    const w = Math.round(rect.width);
                    if (h >= 200) localStorage.setItem('tdb-player-height', String(h));
                    if (w >= 280) localStorage.setItem('tdb-player-width', String(w));
                } catch { /* ignore */ }
            }, 300);
        });
        ro.observe(wrap);
    }
}

// --- View Management ---
function switchView(view) {
    state.view = view;
    el.browseView.classList.toggle('hidden', view !== 'browse');
    el.searchView.classList.toggle('hidden', view !== 'search');
    el.detailView.classList.toggle('hidden', view !== 'detail');
    if (el.wikiView) el.wikiView.classList.toggle('hidden', view !== 'wiki');
}

// --- Event Listeners ---
function setupEventListeners() {
    // Search input with debounce
    el.searchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        state.searchQuery = query;
        el.searchClear.classList.toggle('hidden', !query);

        // For AI mode, don't debounce — wait for Enter
        if (state.aiMode) return;

        clearTimeout(state.searchTimeout);
        state.searchTimeout = setTimeout(() => doSearch(query), 300);
    });

    // Search on Enter (especially for AI mode)
    el.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && state.searchQuery.trim()) {
            e.preventDefault();
            clearTimeout(state.searchTimeout);
            doSearch(state.searchQuery);
        }
    });

    // Clear search
    el.searchClear.addEventListener('click', () => {
        el.searchInput.value = '';
        state.searchQuery = '';
        el.searchClear.classList.add('hidden');
        el.searchMeta.textContent = '';
        hideAiAnswer();
        switchView('browse');
        loadTranscripts();
    });

    // Keyboard shortcut: Cmd/Ctrl+K to focus search
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            el.searchInput.focus();
            el.searchInput.select();
        }
        // Escape to go back or close settings
        if (e.key === 'Escape') {
            if (!el.settingsOverlay.classList.contains('hidden')) {
                closeSettings();
            } else if (state.view === 'detail') {
                goBack();
            } else if (state.view === 'search' && !state.searchQuery) {
                switchView('browse');
            }
        }
    });

    // Source filter (hidden stub — programmatic changes only; tree drives navigation)
    el.filterSource.addEventListener('change', (e) => {
        state.activeSource = e.target.value;
        state.activeSection = null;
        state.activeLecture = '';
        loadTranscripts();
        if (state.searchQuery) doSearch(state.searchQuery);
    });

    // Type filter chips
    el.filterTypes.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        state.activeType = chip.dataset.type;
        // Update active state
        el.filterTypes.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        loadTranscripts();
        if (state.searchQuery) doSearch(state.searchQuery);
    });

    // Back button
    el.backBtn.addEventListener('click', goBack);

    // "Unassigned Transcripts" collapse toggle
    if (el.unassignedToggle) {
        el.unassignedToggle.addEventListener('click', () => {
            if (state.expanded.has('unassigned-root')) {
                state.expanded.delete('unassigned-root');
            } else {
                state.expanded.add('unassigned-root');
            }
            persistExpanded();
            renderUnassignedSourcesTree();
        });
    }
}

function goBack() {
    if (state.searchQuery) {
        switchView('search');
    } else {
        switchView('browse');
    }
}

// --- Utilities ---
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function safeSnippet(raw) {
    if (!raw) return '';
    const parts = raw.split(/(<mark>|<\/mark>)/);
    let inMark = false;
    return parts.map(part => {
        if (part === '<mark>') { inMark = true; return '<mark>'; }
        if (part === '</mark>') { inMark = false; return '</mark>'; }
        return escapeHtml(part);
    }).join('');
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBadgeClass(type) {
    switch (type) {
        case 'Lesson': return 'badge-lesson';
        case 'Pre-Lesson Q&A': return 'badge-preqa';
        case 'Post-Lesson Q&A': return 'badge-postqa';
        case 'Work Session': return 'badge-work';
        default: return 'badge-lesson';
    }
}

// --- Boot ---
init();

// =============================================================================
// Teachable Course Management
// =============================================================================

async function loadCourses() {
    try {
        state.courses = await api('/api/courses');
        renderCourseList();
        clearTreeCache();
        renderTree();
        populateWikiRebuildScope();
    } catch (e) { console.error('Failed to load courses:', e); }
}

async function checkAuth() {
    try {
        const data = await api('/api/auth/status');
        state.loggedIn = data.loggedIn;
        updateAuthUI();
    } catch (e) { /* ignore */ }
}

function updateAuthUI() {
    if (el.authStatus) {
        el.authStatus.className = `auth-dot ${state.loggedIn ? 'online' : ''}`;
        el.authStatus.title = state.loggedIn ? 'Logged in to Teachable' : 'Not logged in';
    }
    if (el.loginBtn) {
        el.loginBtn.textContent = state.loggedIn ? '✅ Logged in' : '🔐 Log in to Teachable';
        el.loginBtn.className = `auth-btn ${state.loggedIn ? 'logged-in' : ''}`;
    }
}

function renderCourseList() {
    if (!el.courseList) return;

    const allItems = [];

    // Add transcript sources
    for (const s of (state.sources || [])) {
        allItems.push({
            type: 'source',
            id: `src-${s.id}`,
            title: s.name,
            meta: `${s.transcript_count || 0} transcripts`,
            sourceId: s.id,
            selectValue: String(s.id),
        });
    }

    // Add scraped courses
    for (const c of (state.courses || [])) {
        const prefix = c.class_number ? `${c.class_number} – ` : '';
        allItems.push({
            type: 'course',
            id: `crs-${c.id}`,
            title: `${prefix}${c.title}`,
            meta: `${c.lecture_count || 0}L · ${c.chunk_count || 0}C`,
            courseId: c.id,
            selectValue: `course-${c.id}`,
        });
    }

    // Populate the source-dropdown-select (native <select>)
    if (el.sourceDropdownSelect) {
        let optHtml = '<option value="">All Sources</option>';
        for (const item of allItems) {
            const label = `${escapeHtml(item.title)} — ${item.meta}`;
            optHtml += `<option value="${escapeHtml(item.selectValue)}">${label}</option>`;
        }
        el.sourceDropdownSelect.innerHTML = optHtml;
        // Reflect current active state
        el.sourceDropdownSelect.value = state.activeSource || '';
    }

    if (allItems.length === 0) {
        el.courseList.innerHTML = '<div class="course-empty-msg">No sources yet</div>';
        return;
    }

    // Keep hidden course-list populated for multi-delete support
    el.courseList.innerHTML = allItems.map(item => `
        <label class="course-checklist-item" data-type="${item.type}" data-id="${item.id}">
            <input type="checkbox" class="course-check" value="${item.id}" />
            <span class="course-checklist-title">${escapeHtml(item.title)}</span>
            <span class="course-checklist-meta">${item.meta}</span>
        </label>
    `).join('');
}

// Delete selected sources/courses handler
// Helper: show modal and return a Promise that resolves true/false
function showDeleteModal(message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('delete-modal-overlay');
        const msg = document.getElementById('delete-modal-msg');
        const confirmBtn = document.getElementById('delete-modal-confirm');
        const cancelBtn = document.getElementById('delete-modal-cancel');
        if (!overlay) { resolve(false); return; }

        msg.textContent = message;
        overlay.classList.remove('hidden');

        function cleanup(result) {
            overlay.classList.add('hidden');
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            resolve(result);
        }
        function onConfirm(e) { e.stopPropagation(); cleanup(true); }
        function onCancel(e) { e.stopPropagation(); cleanup(false); }
        function onOverlay(e) { if (e.target === overlay) cleanup(false); }

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
    });
}

if (false /* deleteSelectedCourses UI removed — multi-delete is a follow-up feature */) {
    (async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const checked = [...el.courseList.querySelectorAll('.course-check:checked')];
        if (checked.length === 0) return;

        const items = checked.map(cb => {
            const val = cb.value;
            if (val.startsWith('crs-')) {
                const id = Number(val.replace('crs-', ''));
                const c = state.courses.find(x => x.id === id);
                return { type: 'course', id, title: c ? c.title : `Course ${id}` };
            } else {
                const id = val.replace('src-', '');
                const s = state.sources.find(x => String(x.id) === id);
                return { type: 'source', id, title: s ? s.name : `Source ${id}` };
            }
        });

        // (dropdown close no longer needed)

        // Show modal
        const msg = `Delete ${items.length} item(s)?\n\n${items.map(i => `  \u2022 ${i.title}`).join('\n')}\n\nThis removes all associated data.`;
        const confirmed = await showDeleteModal(msg);
        if (!confirmed) return;

        try {
            for (const item of items) {
                if (item.type === 'course') {
                    await fetch(`/api/courses/${item.id}`, { method: 'DELETE' });
                } else {
                    await fetch(`/api/sources/${item.id}`, { method: 'DELETE' });
                }
            }
            await loadCourses();
            await loadStats();
            await loadSources();
        } catch (err) { alert('Failed to delete items'); }
    })();
}

function getSelectedCourseIds() {
    if (!el.courseList) return [];
    return [...el.courseList.querySelectorAll('.course-check:checked')].map(cb => Number(cb.value));
}

// Phase 4b-ui: Source dropdown-select change handler
if (el.sourceDropdownSelect) {
    el.sourceDropdownSelect.addEventListener('change', (e) => {
        state.activeSource = e.target.value;
        state.activeSection = null;
        state.activeLecture = '';
        // Keep the existing filter-source select in sync (used by doSearch)
        if (el.filterSource) el.filterSource.value = state.activeSource;
        loadLectures();
        loadTranscripts();
        if (state.searchQuery) doSearch(state.searchQuery);
    });
}

// Phase 4b-ui: Sessions dropdown-select change handler
if (el.lectureListSelect) {
    el.lectureListSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        const isCourse = state.activeSource?.startsWith('course-');
        if (isCourse) {
            state.activeSection = val ? Number(val) : null;
        } else {
            state.activeLecture = val;
            if (!val) loadLectures();
        }
        loadTranscripts();
        if (state.searchQuery) doSearch(state.searchQuery);
    });
}

async function startScrape(url, { hideOnDone = true } = {}) {
    if (!state.loggedIn) {
        alert('Please log in to Teachable first.');
        return;
    }
    if (el.addCoursePanel) el.addCoursePanel.classList.add('hidden');
    if (el.scrapeProgress) el.scrapeProgress.classList.remove('hidden');
    el.scrapeMessage.textContent = 'Starting...';
    el.scrapePct.textContent = '0%';
    el.scrapeBar.style.width = '0%';

    // Phase 4b: read force-refresh checkbox
    const forceRefresh = document.getElementById('scrape-force-refresh')?.checked || false;

    try {
        const res = await fetch('/api/courses/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, forceRefresh }),
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.message) el.scrapeMessage.textContent = data.message;
                    if (data.pct !== undefined) {
                        el.scrapePct.textContent = `${data.pct}%`;
                        el.scrapeBar.style.width = `${data.pct}%`;
                    }
                    if (data.done) {
                        el.scrapeMessage.textContent = `✅ Scraped ${data.lectureCount} lectures from "${data.title}"`;
                        // Phase 4b: uncheck force-refresh after successful scrape
                        const cb = document.getElementById('scrape-force-refresh');
                        if (cb) cb.checked = false;
                        await loadCourses();
                        await loadStats();
                        if (hideOnDone) setTimeout(() => el.scrapeProgress.classList.add('hidden'), 3000);
                    }
                    if (data.error) {
                        el.scrapeMessage.textContent = `❌ ${data.error}`;
                    }
                } catch (e) { /* skip */ }
            }
        }
    } catch (e) {
        el.scrapeMessage.textContent = `❌ ${e.message}`;
    }
}

function setupCourseListeners() {
    // Add course — open picker and fetch available courses
    if (el.addCourseBtn) {
        el.addCourseBtn.addEventListener('click', async () => {
            const panel = el.addCoursePanel;
            const isHidden = panel.classList.contains('hidden');
            panel.classList.toggle('hidden');

            if (isHidden) {
                // Load available courses from Teachable
                el.coursePickerLoading.classList.remove('hidden');
                el.coursePickerList.innerHTML = '';
                el.startScrapeBtn.disabled = true;

                try {
                    const available = await api('/api/courses/available');
                    el.coursePickerLoading.classList.add('hidden');

                    if (available.length === 0) {
                        el.coursePickerList.innerHTML = '<div class="course-picker-empty">No courses found on Teachable.</div>';
                        return;
                    }

                    // Group available courses by tag prefix (same scheme as the Browse tree)
                    const groups = new Map();
                    const other = [];
                    for (const c of available) {
                        const tag = extractTagFromTitle(c.title);
                        if (tag) {
                            if (!groups.has(tag)) groups.set(tag, []);
                            groups.get(tag).push(c);
                        } else {
                            other.push(c);
                        }
                    }
                    const sections = [];
                    for (const tag of TAG_ORDER) {
                        const list = groups.get(tag);
                        if (!list || list.length === 0) continue;
                        list.sort((a, b) => stripTagPrefix(a.title, tag).localeCompare(stripTagPrefix(b.title, tag)));
                        sections.push({ label: `${TAG_LABELS[tag] || tag} (${list.length})`, tag, courses: list });
                    }
                    if (other.length > 0) {
                        other.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
                        sections.push({ label: `Other (${other.length})`, tag: 'OTHER', courses: other });
                    }
                    el.coursePickerList.innerHTML = sections.map(sec => `
                        <div class="course-picker-group">
                            <div class="course-picker-group-header">${escapeHtml(sec.label)}</div>
                            ${sec.courses.map(c => {
                                const displayTitle = sec.tag === 'OTHER' ? c.title : (stripTagPrefix(c.title, sec.tag) || c.title);
                                return `
                                    <label class="course-picker-item ${c.alreadyScraped ? 'already-scraped' : ''}">
                                        <input type="checkbox" class="picker-check" value="${escapeHtml(c.url)}"
                                               data-title="${escapeHtml(c.title)}" />
                                        <span class="picker-title">${escapeHtml(displayTitle)}</span>
                                        ${c.alreadyScraped ? '<span class="picker-badge">↻ Re-scrape</span>' : ''}
                                    </label>
                                `;
                            }).join('')}
                        </div>
                    `).join('');

                    // Enable/disable scrape button based on selection
                    el.coursePickerList.querySelectorAll('.picker-check').forEach(cb => {
                        cb.addEventListener('change', () => {
                            const anyChecked = el.coursePickerList.querySelector('.picker-check:checked');
                            el.startScrapeBtn.disabled = !anyChecked;
                        });
                    });
                } catch (err) {
                    el.coursePickerLoading.textContent = `❌ ${err.message || 'Failed to load courses'}`;
                }
            }
        });
    }

    if (el.cancelAddCourse) {
        el.cancelAddCourse.addEventListener('click', () => {
            el.addCoursePanel.classList.add('hidden');
        });
    }

    // Scrape selected courses sequentially
    if (el.startScrapeBtn) {
        el.startScrapeBtn.addEventListener('click', async () => {
            const checked = [...el.coursePickerList.querySelectorAll('.picker-check:checked')];
            if (checked.length === 0) return;

            el.addCoursePanel.classList.add('hidden');
            for (let i = 0; i < checked.length; i++) {
                const isLast = i === checked.length - 1;
                await startScrape(checked[i].value, { hideOnDone: isLast });
            }
        });
    }

    // Login
    if (el.loginBtn) {
        el.loginBtn.addEventListener('click', async () => {
            if (state.loggedIn && !confirm('You are already logged in to Teachable. Log in again?')) return;
            el.loginBtn.textContent = '⏳ Opening browser...';
            el.loginBtn.disabled = true;
            try {
                const res = await fetch('/api/auth/login', { method: 'POST' });
                const contentType = res.headers.get('content-type') || '';
                const bodyText = await res.text();
                let data = {};

                if (bodyText && contentType.includes('application/json')) {
                    data = JSON.parse(bodyText);
                }

                if (!res.ok) {
                    const msg = data.error || bodyText || `Login failed (${res.status})`;
                    throw new Error(msg);
                }

                if (data.success) state.loggedIn = true;
            } catch (e) { alert('Login failed: ' + e.message); }
            el.loginBtn.disabled = false;
            updateAuthUI();
        });
    }
}

// =============================================================================
// Phase 4b: ffmpeg pre-flight banner
// =============================================================================

async function checkFfmpegAvailability() {
    try {
        const res = await fetch('/api/system/ffmpeg');
        const data = await res.json();
        const banner = document.getElementById('ffmpeg-banner');
        const archiveBtn = document.getElementById('archive-videos-btn');
        if (!data.ok) {
            banner?.classList.remove('hidden');
            if (archiveBtn) archiveBtn.disabled = true;
        } else {
            banner?.classList.add('hidden');
            if (archiveBtn) archiveBtn.disabled = false;
        }
    } catch (err) {
        console.warn('ffmpeg check failed:', err.message);
    }
}
checkFfmpegAvailability();
document.getElementById('ffmpeg-banner-recheck')?.addEventListener('click', checkFfmpegAvailability);

// =============================================================================
// Phase 4b: Archive Videos modal handler
// =============================================================================

async function startArchive(courseId, scope = {}) {
    const { sectionId = null, classNumber = null } = scope;
    const modal = document.getElementById('archive-modal');
    const statusLine = document.getElementById('archive-status-line');
    const currentLecture = document.getElementById('archive-current-lecture');
    const progressFill = document.getElementById('archive-progress-fill');
    const lectureList = document.getElementById('archive-lecture-list');
    const summary = document.getElementById('archive-summary');
    const cancelBtn = document.getElementById('archive-cancel-btn');
    const doneBtn = document.getElementById('archive-done-btn');

    // Reset UI
    statusLine.textContent = 'Starting…';
    currentLecture.textContent = '';
    progressFill.style.width = '0%';
    lectureList.innerHTML = '';
    summary.classList.add('hidden');
    summary.textContent = '';
    cancelBtn.classList.remove('hidden');
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel';
    doneBtn.classList.add('hidden');
    modal.classList.remove('hidden');

    let total = 0;
    const lectureRows = new Map(); // lectureId -> <li> element

    cancelBtn.onclick = async () => {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling…';
        try {
            await fetch(`/api/courses/${courseId}/archive-videos`, { method: 'DELETE' });
        } catch (err) {
            console.warn('cancel failed:', err.message);
        }
    };

    try {
        const res = await fetch(`/api/courses/${courseId}/archive-videos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: false, sectionId, classNumber }),
        });
        if (!res.ok) {
            statusLine.textContent = `Error: ${res.status} ${res.statusText}`;
            cancelBtn.classList.add('hidden');
            doneBtn.classList.remove('hidden');
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE messages are separated by blank lines; each message starts with "data: "
            const messages = buffer.split('\n\n');
            buffer = messages.pop(); // keep incomplete tail

            for (const msg of messages) {
                if (!msg.startsWith('data: ')) continue;
                let event;
                try {
                    event = JSON.parse(msg.slice('data: '.length));
                } catch (e) {
                    continue;
                }

                switch (event.type) {
                    case 'preflight':
                        if (!event.ok) {
                            statusLine.textContent = `ffmpeg unavailable: ${event.error}`;
                            cancelBtn.classList.add('hidden');
                            doneBtn.classList.remove('hidden');
                            return;
                        }
                        break;
                    case 'course':
                        total = event.total;
                        statusLine.textContent = `Course: ${event.title} — ${total} lectures`;
                        break;
                    case 'lecture': {
                        let li = lectureRows.get(event.lectureId);
                        if (!li) {
                            li = document.createElement('li');
                            li.className = 'archive-lecture-row';
                            li.dataset.lectureId = event.lectureId;
                            lectureList.appendChild(li);
                            lectureRows.set(event.lectureId, li);
                        }
                        // Remember the latest videoTotal seen for this lecture so
                        // detail messages that don't re-emit it (e.g. ffmpeg time=)
                        // still display the right "Video X/Y".
                        if (event.videoTotal) li.dataset.videoTotal = String(event.videoTotal);
                        if (event.videoIndex) li.dataset.videoIndex = String(event.videoIndex);
                        const vIdx = li.dataset.videoIndex;
                        const vTot = li.dataset.videoTotal;
                        const videoPart = vIdx && vTot
                            ? ` · Video ${vIdx}/${vTot}`
                            : (vTot ? ` · ${vTot} videos` : '');

                        if (event.status === 'start') {
                            // Reset per-lecture counters on a new lecture (videoTotal
                            // is unknown until the manifest scan inside this lecture).
                            delete li.dataset.videoIndex;
                            delete li.dataset.videoTotal;
                            currentLecture.textContent = `[${event.index}/${total}] ${event.title}`;
                            const pct = ((event.index - 1) / total) * 100;
                            progressFill.style.width = `${pct}%`;
                            li.textContent = `[${event.index}/${total}] ${event.title} — starting…`;
                            li.className = 'archive-lecture-row pending';
                        } else if (event.status === 'downloading') {
                            currentLecture.textContent = `[${event.index}/${total}] ${event.title}${videoPart}`;
                            li.textContent = `[${event.index}/${total}] ${event.title}${videoPart} — ${event.detail}`;
                            li.className = 'archive-lecture-row downloading';
                        } else if (event.status === 'done') {
                            const countStr = event.videoCount && event.videoCount > 1 ? ` (${event.videoCount} videos)` : '';
                            li.textContent = `[${event.index}/${total}] ${event.title} — downloaded${countStr}`;
                            li.className = 'archive-lecture-row done';
                        } else if (event.status === 'skipped') {
                            li.textContent = `[${event.index}/${total}] ${event.title}${videoPart} — ${event.detail}`;
                            li.className = 'archive-lecture-row skipped';
                        } else if (event.status === 'error') {
                            li.textContent = `[${event.index}/${total}] ${event.title}${videoPart} — ${event.detail}`;
                            li.className = 'archive-lecture-row error';
                        }
                        break;
                    }
                    case 'summary': {
                        progressFill.style.width = '100%';
                        summary.classList.remove('hidden');
                        summary.innerHTML = `
                            <h3>Summary</h3>
                            <ul>
                                <li>Downloaded: ${event.downloaded}</li>
                                <li>Already archived: ${event.alreadyArchived}</li>
                                <li>Wrong provider: ${event.wrongProvider}</li>
                                <li>Failed: ${event.failed}</li>
                                <li>Elapsed: ${Math.round(event.elapsedMs / 1000)}s</li>
                                ${event.interrupted ? '<li><em>Cancelled</em></li>' : ''}
                            </ul>
                        `;
                        cancelBtn.classList.add('hidden');
                        doneBtn.classList.remove('hidden');
                        break;
                    }
                    case 'error':
                        statusLine.textContent = `Error: ${event.error}`;
                        cancelBtn.classList.add('hidden');
                        doneBtn.classList.remove('hidden');
                        break;
                    case 'done':
                        // Stream complete — if summary hasn't shown yet, show done button
                        if (doneBtn.classList.contains('hidden')) {
                            cancelBtn.classList.add('hidden');
                            doneBtn.classList.remove('hidden');
                        }
                        break;
                }
            }
        }
    } catch (err) {
        statusLine.textContent = `Connection error: ${err.message}`;
        cancelBtn.classList.add('hidden');
        doneBtn.classList.remove('hidden');
    } finally {
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel';
    }
}

document.getElementById('archive-videos-btn')?.addEventListener('click', async (e) => {
    const courseId = e.currentTarget.dataset.courseId;
    if (!courseId) return;
    // Scope to whatever the user has narrowed the right pane to. Without this,
    // clicking the button on a 3-lecture class view would still archive all
    // ~300 lectures in the course.
    const sectionId = state.activeSection || null;
    const classNumber = state.activeClassNumber || null;

    let count = null;
    try {
        const q = new URLSearchParams();
        if (sectionId) q.set('section_id', sectionId);
        const data = await api(`/api/courses/${courseId}/lectures${q.toString() ? '?' + q : ''}`);
        const filtered = classNumber
            ? data.filter(lec => String(lec.class_number) === String(classNumber))
            : data;
        count = filtered.length;
    } catch { /* fall through — confirmation just won't show a count */ }

    const scopeLabel = classNumber
        ? `class ${classNumber}`
        : sectionId ? 'the selected section' : 'the entire course';
    const msg = count != null
        ? `Archive ${count} lecture${count === 1 ? '' : 's'} from ${scopeLabel}?`
        : `Archive videos for ${scopeLabel}?`;
    if (!window.confirm(msg)) return;

    startArchive(Number(courseId), { sectionId, classNumber });
});

document.getElementById('archive-modal-close')?.addEventListener('click', () => {
    document.getElementById('archive-modal')?.classList.add('hidden');
});
document.getElementById('archive-done-btn')?.addEventListener('click', () => {
    document.getElementById('archive-modal')?.classList.add('hidden');
});

// =============================================================================
// Media Library settings + first-run splash
// =============================================================================

function formatBytes(bytes) {
    if (bytes == null) return '?';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    return `${(bytes / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`;
}

function renderMediaLibraryInfo(info, targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    if (!info) { el.innerHTML = ''; return; }
    const existsBadge = info.exists
        ? '<span class="info-pill info-pill-ok">&#10003; exists</span>'
        : '<span class="info-pill info-pill-error">&#10007; does not exist</span>';
    const writableBadge = info.exists
        ? (info.writable
            ? '<span class="info-pill info-pill-ok">writable</span>'
            : '<span class="info-pill info-pill-error">not writable</span>')
        : '';
    const free = info.freeSpaceBytes != null ? `${formatBytes(info.freeSpaceBytes)} free` : '';
    const used = info.exists ? `${formatBytes(info.usedBytes)} used · ${info.videoCount} video${info.videoCount === 1 ? '' : 's'}` : '';
    el.innerHTML = `${existsBadge} ${writableBadge} <span class="info-text">${free}${free && used ? ' · ' : ''}${used}</span>`;
}

async function loadMediaLibrarySettings() {
    try {
        const data = await api('/api/settings/media-library');
        const input = document.getElementById('settings-media-library-path');
        if (input) input.value = data.current_path || '';
        renderMediaLibraryInfo(data.info, 'settings-media-library-info');
        return data;
    } catch (err) {
        console.warn('failed to load media library settings:', err.message);
        return null;
    }
}

async function saveMediaLibrarySettings(acknowledged = false) {
    const input = document.getElementById('settings-media-library-path');
    if (!input) return;
    const newPath = input.value.trim();
    if (!newPath) { alert('Path is required'); return; }
    try {
        const res = await fetch('/api/settings/media-library', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: newPath, acknowledged }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(`Failed to save: ${err.error || res.statusText}`);
            return;
        }
        const data = await res.json();
        renderMediaLibraryInfo(data.info, 'settings-media-library-info');
        return data;
    } catch (err) {
        alert(`Failed to save: ${err.message}`);
    }
}

async function pickMediaLibraryFolder() {
    const input = document.getElementById('settings-media-library-path');
    if (!input) return;
    try {
        const defaultPath = input.value.trim();
        const url = '/api/system/pick-folder' + (defaultPath ? `?defaultPath=${encodeURIComponent(defaultPath)}` : '');
        const res = await fetch(url, { method: 'POST' });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            // Browser-mode fallback: just reveal in Finder
            if (res.status === 400 && errData.error?.includes('browser mode')) {
                if (defaultPath) {
                    await fetch(`/api/system/reveal?path=${encodeURIComponent(defaultPath)}`);
                } else {
                    alert('Folder picker is only available in the desktop app. Type the path directly.');
                }
                return;
            }
            alert(`Folder picker failed: ${errData.error || res.statusText}`);
            return;
        }
        const data = await res.json();
        if (data.canceled || !data.path) return;
        input.value = data.path;
        // Refresh path-info display by calling the backend with the new path (validate without saving)
        try {
            const info = await fetch('/api/settings/media-library').then(r => r.json());
            // The endpoint reports the CURRENT (saved) info, not the new path's info.
            // Calling save would commit; instead clear the info so user knows to click Save.
            renderMediaLibraryInfo(null, 'settings-media-library-info');
        } catch { /* ignore */ }
    } catch (err) {
        console.warn('pick-folder failed:', err.message);
    }
}

function attachMediaLibrarySettingsHandlers() {
    document.getElementById('settings-media-library-save')?.addEventListener('click', async () => {
        await saveMediaLibrarySettings(true);
    });
    document.getElementById('settings-media-library-reset')?.addEventListener('click', async () => {
        const data = await api('/api/settings/media-library');
        const input = document.getElementById('settings-media-library-path');
        if (input && data?.default_path) {
            input.value = data.default_path;
            renderMediaLibraryInfo(null, 'settings-media-library-info');
        }
    });
    document.getElementById('settings-media-library-browse')?.addEventListener('click', pickMediaLibraryFolder);
}

// First-run splash
async function showFirstRunSplashIfNeeded() {
    try {
        const data = await api('/api/settings/media-library');
        if (data?.acknowledged) return;
        const modal = document.getElementById('splash-modal');
        const currentPathEl = document.getElementById('splash-current-path');
        if (currentPathEl) currentPathEl.textContent = data?.current_path || '';
        renderMediaLibraryInfo(data?.info, 'splash-info');
        modal?.classList.remove('hidden');
        document.body.classList.add('splash-active');
    } catch (err) {
        console.warn('splash check failed:', err.message);
    }
}

function attachSplashHandlers() {
    document.getElementById('splash-accept-btn')?.addEventListener('click', async () => {
        try {
            const data = await api('/api/settings/media-library');
            const res = await fetch('/api/settings/media-library', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: data.current_path, acknowledged: true }),
            });
            if (res.ok) {
                document.getElementById('splash-modal')?.classList.add('hidden');
                document.body.classList.remove('splash-active');
            }
        } catch (err) {
            console.warn('splash accept failed:', err.message);
        }
    });
    document.getElementById('splash-customize-btn')?.addEventListener('click', () => {
        document.getElementById('splash-modal')?.classList.add('hidden');
        document.body.classList.remove('splash-active');
        document.getElementById('settings-btn')?.click();
    });
}

// =============================================================================
// Phase 5 — LLM Wiki tab
// =============================================================================

const WIKI_KIND_LABELS = {
    author: { singular: 'Author', plural: 'Authors' },
    technique: { singular: 'Technique', plural: 'Techniques' },
    tool: { singular: 'Tool', plural: 'Tools' },
    debate: { singular: 'Debate', plural: 'Debates' },
};

async function loadWikiKindCounts() {
    if (!el.wikiNav) return;
    try {
        const data = await api('/api/wiki/entities');
        const byKind = { author: 0, technique: 0, tool: 0, debate: 0 };
        for (const e of data.entities || []) {
            if (byKind[e.kind] !== undefined) byKind[e.kind] += 1;
        }
        for (const kind of Object.keys(byKind)) {
            const span = el.wikiNav.querySelector(`[data-kind-count="${kind}"]`);
            if (span) span.textContent = byKind[kind];
        }
    } catch (err) {
        console.warn('Wiki count fetch failed:', err.message);
    }
}

async function openWikiKind(kind) {
    if (!WIKI_KIND_LABELS[kind]) return;
    state.activeWikiKind = kind;
    state.activeWikiEntityId = null;
    switchView('wiki');
    highlightWikiNav(kind);
    el.wikiTitle.textContent = WIKI_KIND_LABELS[kind].plural;
    el.wikiMeta.textContent = 'Loading…';
    el.wikiContainer.innerHTML = '<div class="wiki-loading">Loading entities…</div>';
    try {
        const data = await api(`/api/wiki/entities?kind=${encodeURIComponent(kind)}`);
        renderWikiList(kind, data.entities || []);
    } catch (err) {
        el.wikiContainer.innerHTML = `<div class="wiki-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
        el.wikiMeta.textContent = '';
    }
}

function highlightWikiNav(kind) {
    if (!el.wikiNav) return;
    for (const btn of el.wikiNav.querySelectorAll('.wiki-nav-item')) {
        btn.classList.toggle('active', btn.getAttribute('data-kind') === kind);
    }
}

function renderWikiList(kind, entities) {
    const label = WIKI_KIND_LABELS[kind];
    if (!entities.length) {
        el.wikiMeta.textContent = '';
        el.wikiContainer.innerHTML = `
            <div class="wiki-empty">
                <p>No <strong>${escapeHtml(label.plural.toLowerCase())}</strong> in the wiki yet.</p>
                <p class="wiki-empty-hint">Scrape or re-scrape a course, or use <em>Settings → Wiki → Rebuild</em> to extract entities from existing lectures.</p>
            </div>`;
        return;
    }
    el.wikiMeta.textContent = `${entities.length} ${entities.length === 1 ? label.singular.toLowerCase() : label.plural.toLowerCase()}`;
    const cards = entities.map(e => {
        const aliases = Array.isArray(e.aliases) ? e.aliases : [];
        const aliasText = aliases.length ? `<div class="wiki-card-aliases">also: ${aliases.slice(0, 4).map(escapeHtml).join(', ')}</div>` : '';
        return `
            <button type="button" class="wiki-card" data-entity-id="${e.id}">
                <div class="wiki-card-name">${escapeHtml(e.canonical_name)}</div>
                ${aliasText}
                <div class="wiki-card-summary">${escapeHtml((e.summary || '').slice(0, 220))}</div>
                <div class="wiki-card-counts">
                    <span>${e.note_count} note${e.note_count === 1 ? '' : 's'}</span>
                    <span>${e.claim_count} claim${e.claim_count === 1 ? '' : 's'}</span>
                </div>
            </button>`;
    }).join('');
    el.wikiContainer.innerHTML = `<div class="wiki-grid">${cards}</div>`;
    el.wikiContainer.querySelectorAll('.wiki-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = Number(card.getAttribute('data-entity-id'));
            if (id) openWikiEntity(id);
        });
    });
}

async function openWikiEntity(entityId) {
    state.activeWikiEntityId = entityId;
    el.wikiContainer.innerHTML = '<div class="wiki-loading">Loading entity…</div>';
    el.wikiMeta.textContent = '';
    let entity = state.wikiEntityCache.get(entityId);
    if (!entity) {
        try {
            entity = await api(`/api/wiki/entity/${entityId}`);
            state.wikiEntityCache.set(entityId, entity);
        } catch (err) {
            el.wikiContainer.innerHTML = `<div class="wiki-empty">Failed to load entity: ${escapeHtml(err.message)}</div>`;
            return;
        }
    }
    state.activeWikiKind = entity.kind;
    highlightWikiNav(entity.kind);
    renderWikiEntity(entity);
}

function renderWikiEntity(entity) {
    const label = WIKI_KIND_LABELS[entity.kind] || { singular: entity.kind, plural: entity.kind + 's' };
    el.wikiTitle.textContent = entity.canonical_name;
    el.wikiMeta.textContent = `${label.singular.toLowerCase()} · ${entity.notes.length} note${entity.notes.length === 1 ? '' : 's'} · ${entity.claims.length} claim${entity.claims.length === 1 ? '' : 's'}`;

    const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
    const aliasBlock = aliases.length
        ? `<div class="wiki-entity-aliases"><strong>Aliases:</strong> ${aliases.map(escapeHtml).join(', ')}</div>`
        : '';
    const summaryBlock = entity.summary
        ? `<div class="wiki-entity-summary">${escapeHtml(entity.summary)}</div>`
        : '';

    const notesHtml = entity.notes.length
        ? entity.notes.map(n => {
            const sources = (n.sources || []).map(s => {
                if (!s.id) return '';
                const label = `${escapeHtml(s.course_title || '?')} › ${escapeHtml(s.title || '?')}`;
                return `<a href="#" class="wiki-source-link" data-lecture-id="${s.id}">${label}</a>`;
            }).filter(Boolean).join(' · ');
            return `
                <div class="wiki-note">
                    <div class="wiki-note-body">${escapeHtml(n.markdown)}</div>
                    <div class="wiki-note-sources">${sources || '<em>no sources</em>'}</div>
                </div>`;
        }).join('')
        : '<div class="wiki-empty-inner">No notes yet.</div>';

    const claimsHtml = entity.claims.length
        ? entity.claims.map(c => {
            const supportItems = (c.supports || []).map(s =>
                `<li><a href="#" class="wiki-source-link" data-lecture-id="${s.lecture_id}">${escapeHtml(s.title || `Lecture ${s.lecture_id}`)}</a>${s.quote ? ` — <em>"${escapeHtml(s.quote)}"</em>` : ''}</li>`
            ).join('');
            const contradictItems = (c.contradicts || []).map(s =>
                `<li><a href="#" class="wiki-source-link" data-lecture-id="${s.lecture_id}">${escapeHtml(s.title || `Lecture ${s.lecture_id}`)}</a>${s.quote ? ` — <em>"${escapeHtml(s.quote)}"</em>` : ''}</li>`
            ).join('');
            const hasContradictions = (c.contradicts || []).length > 0;
            return `
                <div class="wiki-claim ${hasContradictions ? 'has-contradictions' : ''}">
                    <div class="wiki-claim-text">${escapeHtml(c.claim_text)}</div>
                    ${supportItems ? `<div class="wiki-claim-supports"><strong>Supports:</strong><ul>${supportItems}</ul></div>` : ''}
                    ${contradictItems ? `<div class="wiki-claim-contradicts"><strong>Contradicts:</strong><ul>${contradictItems}</ul></div>` : ''}
                </div>`;
        }).join('')
        : '<div class="wiki-empty-inner">No claims yet.</div>';

    el.wikiContainer.innerHTML = `
        <div class="wiki-entity">
            <a href="#" class="wiki-back-link" id="wiki-back-link">&larr; All ${escapeHtml(label.plural.toLowerCase())}</a>
            ${aliasBlock}
            ${summaryBlock}
            <h3 class="wiki-section-heading">Notes</h3>
            <div class="wiki-notes">${notesHtml}</div>
            <h3 class="wiki-section-heading">Claims</h3>
            <div class="wiki-claims">${claimsHtml}</div>
        </div>`;

    document.getElementById('wiki-back-link')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        state.activeWikiEntityId = null;
        if (state.activeWikiKind) openWikiKind(state.activeWikiKind);
    });
    el.wikiContainer.querySelectorAll('.wiki-source-link[data-lecture-id]').forEach(link => {
        link.addEventListener('click', (ev) => {
            ev.preventDefault();
            const lid = Number(link.getAttribute('data-lecture-id'));
            if (lid) {
                state.activeLectureId = lid;
                // course_lectures detail is loaded via the `clec-<id>` form;
                // a bare numeric id would mis-route to /api/transcripts/<id>.
                loadTranscriptDetail(`clec-${lid}`);
            }
        });
    });
}

async function runWikiLint() {
    if (!el.wikiLintBtn) return;
    el.wikiLintBtn.disabled = true;
    const origText = el.wikiLintBtn.textContent;
    el.wikiLintBtn.textContent = '…';
    try {
        const res = await fetch('/api/wiki/lint', { method: 'POST' });
        if (!res.ok) throw new Error(`Lint failed: ${res.status}`);
        const data = await res.json();
        showWikiLintReport(data);
    } catch (err) {
        alert(`Wiki lint failed: ${err.message}`);
    } finally {
        el.wikiLintBtn.disabled = false;
        el.wikiLintBtn.textContent = origText;
    }
}

function showWikiLintReport(data) {
    switchView('wiki');
    state.activeWikiKind = null;
    state.activeWikiEntityId = null;
    highlightWikiNav(null);
    el.wikiTitle.textContent = 'Wiki Lint Report';
    const orphanCount = data.orphanEntities?.length || 0;
    const contradictedCount = data.contradictedClaims?.length || 0;
    const staleCount = data.staleEntities?.length || 0;
    const pending = data.lecturesPending || 0;
    el.wikiMeta.textContent = `${orphanCount} orphans · ${contradictedCount} contradicted · ${staleCount} stale · ${pending} pending ingest`;

    const section = (title, items, renderItem) => {
        if (!items?.length) return `<div class="wiki-lint-section"><h3>${title}</h3><p class="wiki-empty-inner">None.</p></div>`;
        return `<div class="wiki-lint-section"><h3>${title} (${items.length})</h3><ul>${items.map(renderItem).join('')}</ul></div>`;
    };
    const orphans = section('Orphan entities (no notes)', data.orphanEntities, e =>
        `<li><a href="#" class="wiki-source-link" data-entity-id="${e.id}">${escapeHtml(e.canonical_name)}</a> <span class="wiki-lint-kind">(${escapeHtml(e.kind)})</span></li>`
    );
    const contradicted = section('Claims with contradictions', data.contradictedClaims, c =>
        `<li><a href="#" class="wiki-source-link" data-entity-id="${c.entity_id}">${escapeHtml(c.canonical_name)}</a>: ${escapeHtml(c.claim_text)}</li>`
    );
    const stale = section('Entities not seen in 180+ days', data.staleEntities, e =>
        `<li><a href="#" class="wiki-source-link" data-entity-id="${e.id}">${escapeHtml(e.canonical_name)}</a> <span class="wiki-lint-kind">(updated ${escapeHtml((e.updated_at || '').slice(0, 10))})</span></li>`
    );
    el.wikiContainer.innerHTML = `
        <div class="wiki-lint">
            <div class="wiki-lint-summary">Pending ingest: <strong>${pending}</strong> lecture(s) have transcripts newer than their wiki state.</div>
            ${orphans}
            ${contradicted}
            ${stale}
        </div>`;
    el.wikiContainer.querySelectorAll('.wiki-source-link[data-entity-id]').forEach(link => {
        link.addEventListener('click', (ev) => {
            ev.preventDefault();
            const id = Number(link.getAttribute('data-entity-id'));
            if (id) openWikiEntity(id);
        });
    });
}

function setupWikiListeners() {
    if (!el.wikiNav) return;
    el.wikiNav.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.wiki-nav-item');
        if (!btn) return;
        const kind = btn.getAttribute('data-kind');
        if (kind) {
            // Drop the cached entity-detail so freshly-ingested data shows up
            state.wikiEntityCache.clear();
            openWikiKind(kind);
        }
    });
    if (el.wikiLintBtn) {
        el.wikiLintBtn.addEventListener('click', runWikiLint);
    }
}

// --- Settings: Rebuild wiki ---

function populateWikiRebuildScope() {
    if (!el.settingsWikiRebuildScope) return;
    // Clear all but the first "whole library" option
    while (el.settingsWikiRebuildScope.options.length > 1) {
        el.settingsWikiRebuildScope.remove(1);
    }
    for (const c of (state.courses || []).slice().sort((a, b) => a.title.localeCompare(b.title))) {
        const opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = c.title;
        el.settingsWikiRebuildScope.appendChild(opt);
    }
}

async function startWikiRebuild() {
    if (!el.settingsWikiRebuildBtn) return;
    const scopeVal = el.settingsWikiRebuildScope?.value || '';
    const courseId = scopeVal ? Number(scopeVal) : null;
    const scopeLabel = courseId
        ? (state.courses.find(c => c.id === courseId)?.title || `Course ${courseId}`)
        : 'the entire library';
    if (!confirm(`Rebuild wiki for ${scopeLabel}? This wipes existing notes/claims for those lectures and re-runs LLM extraction (slow + costs API tokens).`)) return;

    el.settingsWikiRebuildBtn.disabled = true;
    el.settingsWikiCancelBtn?.classList.remove('hidden');
    el.settingsWikiStatus.textContent = 'Starting…';
    el.settingsWikiProgress.classList.remove('hidden');
    el.settingsWikiProgress.innerHTML = '';

    const controller = new AbortController();
    state.wikiRebuildAbort = controller;
    try {
        const res = await fetch('/api/wiki/rebuild', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(courseId ? { courseId } : {}),
            signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Rebuild failed: HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const ev = JSON.parse(line.slice(6));
                    handleRebuildEvent(ev);
                } catch { /* skip */ }
            }
        }
        el.settingsWikiStatus.textContent = 'Done.';
    } catch (err) {
        if (err.name === 'AbortError') {
            el.settingsWikiStatus.textContent = 'Cancelled.';
        } else {
            el.settingsWikiStatus.textContent = `Failed: ${err.message}`;
        }
    } finally {
        el.settingsWikiRebuildBtn.disabled = false;
        el.settingsWikiCancelBtn?.classList.add('hidden');
        state.wikiRebuildAbort = null;
        // Refresh sidebar counts so the UI reflects the rebuild
        loadWikiKindCounts();
        // Invalidate cached entity details
        state.wikiEntityCache.clear();
    }
}

function handleRebuildEvent(ev) {
    if (!el.settingsWikiStatus) return;
    if (ev.type === 'course') {
        el.settingsWikiStatus.textContent = `Course ${ev.current}/${ev.total}: ${ev.course}`;
    } else if (ev.type === 'progress') {
        el.settingsWikiStatus.textContent = `${ev.current}/${ev.total} · ${ev.lecture}`;
    } else if (ev.type === 'error') {
        const line = document.createElement('div');
        line.className = 'wiki-rebuild-error';
        line.textContent = `Error on ${ev.lecture || ev.course || '?'}: ${ev.error}`;
        el.settingsWikiProgress.appendChild(line);
    } else if (ev.type === 'done') {
        const summary = `Processed ${ev.processed ?? 0}, skipped ${ev.skipped ?? 0}, failed ${ev.failed ?? 0}.`;
        el.settingsWikiStatus.textContent = summary;
    }
}

function setupWikiSettingsListeners() {
    el.settingsWikiRebuildBtn?.addEventListener('click', startWikiRebuild);
    el.settingsWikiCancelBtn?.addEventListener('click', () => {
        if (state.wikiRebuildAbort) state.wikiRebuildAbort.abort();
    });
}
