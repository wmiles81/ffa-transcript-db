/**
 * Transcript DB — Frontend Application
 * Handles search, browse, and transcript viewing.
 */

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
};

// --- API Helpers ---
async function api(endpoint) {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
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
    lectureList: document.getElementById('lecture-list'),
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
    deleteSelectedCourses: document.getElementById('delete-selected-courses'),
    deleteConfirmBar: document.getElementById('delete-confirm-bar'),
    deleteConfirmMsg: document.getElementById('delete-confirm-msg'),
    deleteConfirmYes: document.getElementById('delete-confirm-yes'),
    deleteConfirmNo: document.getElementById('delete-confirm-no'),
    sourceDropdown: document.getElementById('source-dropdown'),
    sourceDropdownTrigger: document.getElementById('source-dropdown-trigger'),
    sourceDropdownPanel: document.getElementById('source-dropdown-panel'),
    sourceDropdownLabel: document.getElementById('source-dropdown-label'),
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

// --- Initialize ---
async function init() {
    await Promise.all([loadStats(), loadSources(), loadLectures(), loadTranscripts(), loadAiSettings(), loadCourses(), checkAuth()]);
    setupEventListeners();
    setupSettingsListeners();
    setupCourseListeners();
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
            const params = state.activeSection ? `?section_id=${state.activeSection}` : '';
            const data = await api(`/api/courses/${courseId}/lectures${params}`);
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
            return;
        }
        const params = new URLSearchParams();
        if (state.activeSource) params.set('source_id', state.activeSource);
        if (state.activeLecture) params.set('lecture', state.activeLecture);
        if (state.activeType) params.set('type', state.activeType);
        const data = await api(`/api/transcripts?${params}`);
        renderTranscriptGrid(data.transcripts);
        el.browseTitle.textContent = state.activeLecture || 'All Transcripts';
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
        // Handle course lecture IDs (clec-<id>)
        if (typeof id === 'string' && id.startsWith('clec-')) {
            const lecId = id.replace('clec-', '');
            const lecture = await api(`/api/courses/lectures/${lecId}`);
            renderTranscriptDetail({
                id: id,
                title: lecture.title,
                filename: lecture.section_title || '',
                lecture: lecture.course_title || '',
                transcript_type: 'Course',
                lecture_date: lecture.scraped_at?.split('T')[0],
                content: lecture.content || '(No text content)',
                result_type: 'course',
            }, highlightQuery);
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

// --- Render Functions ---
function renderLectureList(lectures) {
    el.lectureList.innerHTML = '';
    const isCourse = state.activeSource?.startsWith('course-');

    const allItem = document.createElement('div');
    allItem.className = `lecture-item ${(!state.activeLecture && !state.activeSection) ? 'active' : ''}`;
    allItem.innerHTML = `<span class="lecture-name">${isCourse ? 'All Sections' : 'All Lectures'}</span>`;
    allItem.onclick = () => {
        state.activeLecture = '';
        state.activeSection = null;
        loadLectures();
        loadTranscripts();
        if (state.searchQuery) doSearch(state.searchQuery);
    };
    el.lectureList.appendChild(allItem);

    for (const lecture of lectures) {
        const item = document.createElement('div');
        const isActive = isCourse
            ? state.activeSection === lecture.sectionId
            : state.activeLecture === lecture.lecture;
        item.className = `lecture-item ${isActive ? 'active' : ''}`;
        const datePart = lecture.lecture_date || '';
        const nameParts = lecture.lecture.replace(/\(\d+:\d+\)/, '').trim();
        item.innerHTML = `
      ${datePart ? `<span class="lecture-date">${datePart}</span>` : ''}
      <span class="lecture-name">${escapeHtml(nameParts)}</span>
    `;
        item.onclick = () => {
            if (isCourse) {
                state.activeSection = lecture.sectionId;
            } else {
                state.activeLecture = lecture.lecture;
            }
            loadLectures();
            loadTranscripts();
            if (state.searchQuery) doSearch(state.searchQuery);
        };
        el.lectureList.appendChild(item);
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
            card.onclick = () => loadTranscriptDetail(r.transcript_id, state.searchQuery);
        }

        el.resultsList.appendChild(card);
    }
}

function renderTranscriptDetail(transcript, highlightQuery) {
    let content = escapeHtml(transcript.content);

    // Highlight timestamps
    content = content.replace(
        /\[(\d{2}:\d{2}:\d{2})\]/g,
        '<span class="timestamp">[$1]</span>'
    );

    // Highlight speaker names (Name: pattern at start of line or after newline)
    content = content.replace(
        /^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*:/gm,
        '<span class="speaker">$1:</span>'
    );

    // Highlight search terms if present
    if (highlightQuery) {
        const terms = highlightQuery.split(/\s+/).filter(t => t.length > 1);
        for (const term of terms) {
            const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
            content = content.replace(regex, '<mark>$1</mark>');
        }
    }

    const badgeClass = getBadgeClass(transcript.transcript_type);
    const durationStr = transcript.duration_minutes
        ? `${Math.round(transcript.duration_minutes)} min`
        : '';

    el.transcriptDetail.innerHTML = `
    <div class="detail-header">
      <div class="detail-title">${escapeHtml(transcript.lecture)}</div>
      <div class="detail-subtitle">${escapeHtml(transcript.filename)}</div>
      <div class="detail-meta">
        <span class="card-badge ${badgeClass}">${escapeHtml(transcript.transcript_type || '')}</span>
        ${transcript.lecture_date ? `<span class="card-date">${transcript.lecture_date}</span>` : ''}
        ${durationStr ? `<span class="card-duration">${durationStr}</span>` : ''}
        <span class="card-date">${escapeHtml(transcript.source_name)}</span>
      </div>
    </div>
    <div class="detail-content">${content}</div>
  `;
}

// --- View Management ---
function switchView(view) {
    state.view = view;
    el.browseView.classList.toggle('hidden', view !== 'browse');
    el.searchView.classList.toggle('hidden', view !== 'search');
    el.detailView.classList.toggle('hidden', view !== 'detail');
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

    // Source filter
    el.filterSource.addEventListener('change', (e) => {
        state.activeSource = e.target.value;
        state.activeSection = null;
        state.activeLecture = '';
        loadLectures();
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
    if (el.deleteSelectedCourses) el.deleteSelectedCourses.classList.add('hidden');

    const allItems = [];

    // Add transcript sources
    for (const s of (state.sources || [])) {
        allItems.push({
            type: 'source',
            id: `src-${s.id}`,
            title: s.name,
            meta: `${s.transcript_count || 0} transcripts`,
            sourceId: s.id,
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
        });
    }

    if (allItems.length === 0) {
        el.courseList.innerHTML = '<div class="course-empty-msg">No sources yet</div>';
        if (el.sourceDropdownLabel) el.sourceDropdownLabel.textContent = 'No sources';
        return;
    }

    // Update dropdown trigger label
    if (el.sourceDropdownLabel) {
        el.sourceDropdownLabel.textContent = `${allItems.length} source${allItems.length !== 1 ? 's' : ''}`;
    }

    el.courseList.innerHTML = allItems.map(item => `
        <label class="course-checklist-item" data-type="${item.type}" data-id="${item.id}">
            <input type="checkbox" class="course-check" value="${item.id}" />
            <span class="course-checklist-title">${escapeHtml(item.title)}</span>
            <span class="course-checklist-meta">${item.meta}</span>
        </label>
    `).join('');

    // Toggle delete button visibility on check change
    el.courseList.querySelectorAll('.course-check').forEach(cb => {
        cb.addEventListener('change', () => {
            const anyChecked = el.courseList.querySelector('.course-check:checked');
            if (el.deleteSelectedCourses) {
                el.deleteSelectedCourses.classList.toggle('hidden', !anyChecked);
            }
        });
    });

    // Click on title loads the source/course
    el.courseList.querySelectorAll('.course-checklist-title').forEach(span => {
        span.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const label = span.closest('.course-checklist-item');
            const type = label.dataset.type;
            const id = label.dataset.id;
            if (type === 'course') {
                const courseId = Number(id.replace('crs-', ''));
                state.activeSource = `course-${courseId}`;
                state.activeSection = null;
                state.activeLecture = '';
                el.filterSource.value = `course-${courseId}`;
                loadLectures();
                loadTranscripts();
            } else if (type === 'source') {
                const sourceId = id.replace('src-', '');
                state.activeSource = sourceId;
                el.filterSource.value = sourceId;
                el.filterSource.dispatchEvent(new Event('change'));
            }
            // Close dropdown after selection
            if (el.sourceDropdownPanel) el.sourceDropdownPanel.classList.add('hidden');
            if (el.sourceDropdown) el.sourceDropdown.classList.remove('open');
        });
    });
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

if (el.deleteSelectedCourses) {
    el.deleteSelectedCourses.addEventListener('click', async (e) => {
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

        // Close dropdown
        el.sourceDropdown.classList.remove('open');
        if (el.sourceDropdownPanel) el.sourceDropdownPanel.classList.add('hidden');

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
    });
}

function getSelectedCourseIds() {
    if (!el.courseList) return [];
    return [...el.courseList.querySelectorAll('.course-check:checked')].map(cb => Number(cb.value));
}

// Source dropdown toggle
if (el.sourceDropdownTrigger) {
    el.sourceDropdownTrigger.addEventListener('click', () => {
        const isOpen = el.sourceDropdown.classList.toggle('open');
        el.sourceDropdownPanel.classList.toggle('hidden', !isOpen);
    });
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (el.sourceDropdown && !el.sourceDropdown.contains(e.target)) {
        el.sourceDropdown.classList.remove('open');
        if (el.sourceDropdownPanel) el.sourceDropdownPanel.classList.add('hidden');
    }
});

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

    try {
        const res = await fetch('/api/courses/scrape', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
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

                    el.coursePickerList.innerHTML = available.map(c => `
                        <label class="course-picker-item ${c.alreadyScraped ? 'already-scraped' : ''}">
                            <input type="checkbox" class="picker-check" value="${escapeHtml(c.url)}" 
                                   data-title="${escapeHtml(c.title)}" />
                            <span class="picker-title">${escapeHtml(c.title)}</span>
                            ${c.alreadyScraped ? '<span class="picker-badge">↻ Re-scrape</span>' : ''}
                        </label>
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
            el.loginBtn.textContent = '⏳ Opening browser...';
            el.loginBtn.disabled = true;
            try {
                const res = await fetch('/api/auth/login', { method: 'POST' });
                const data = await res.json();
                if (data.success) state.loggedIn = true;
            } catch (e) { alert('Login failed: ' + e.message); }
            el.loginBtn.disabled = false;
            updateAuthUI();
        });
    }
}
