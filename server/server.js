import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeDb, getDb, closeDb } from './db.js';
import { scrapeCourse, deleteCourse, openLoginBrowser, hasSession, clearSession, fetchAvailableCourses } from './scraper.js';
import { checkFfmpeg, archiveCourseVideos } from './archive-orchestrator.js';
import { ingestLecture, ingestPending, rebuildCourse, listEntities, getEntity, lint as wikiLint, recentLog as wikiRecentLog } from './wiki.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// Initialize database on startup
initializeDb();

// --- API Routes ---

// GET /api/stats — Dashboard statistics
app.get('/api/stats', (req, res) => {
    const db = getDb();
    const sources = db.prepare('SELECT COUNT(*) as count FROM sources').get();
    const transcripts = db.prepare('SELECT COUNT(*) as count FROM transcripts').get();
    const chunks = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    const totalWords = db.prepare(`
    SELECT SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1) as words
    FROM transcripts
  `).get();
    const lectures = db.prepare('SELECT COUNT(DISTINCT lecture) as count FROM transcripts').get();
    // Course stats
    const courses = db.prepare('SELECT COUNT(*) as count FROM courses').get();
    const courseLectures = db.prepare('SELECT COUNT(*) as count FROM course_lectures').get();
    const courseChunks = db.prepare('SELECT COUNT(*) as count FROM course_chunks').get();

    res.json({
        sources: sources.count,
        transcripts: transcripts.count,
        chunks: chunks.count,
        lectures: lectures.count,
        estimatedWords: totalWords.words || 0,
        courses: courses.count,
        courseLectures: courseLectures.count,
        courseChunks: courseChunks.count,
    });
});

// GET /api/sources — List all sources
app.get('/api/sources', (req, res) => {
    const db = getDb();
    const sources = db.prepare(`
    SELECT s.*, COUNT(t.id) as transcript_count
    FROM sources s
    LEFT JOIN transcripts t ON t.source_id = s.id
    GROUP BY s.id
    ORDER BY s.imported_at DESC
  `).all();
    res.json(sources);
});

// GET /api/lectures — Unique lectures for filtering
app.get('/api/lectures', (req, res) => {
    const db = getDb();
    const { source_id } = req.query;

    let query = `
    SELECT DISTINCT lecture, lecture_date, duration_minutes,
      COUNT(*) as transcript_count,
      GROUP_CONCAT(DISTINCT transcript_type) as types
    FROM transcripts
  `;
    const params = [];

    if (source_id) {
        query += ' WHERE source_id = ?';
        params.push(source_id);
    }

    query += ' GROUP BY lecture ORDER BY lecture_date ASC, lecture ASC';

    const lectures = db.prepare(query).all(...params);
    res.json(lectures);
});

// GET /api/transcripts — List transcripts with optional filters
app.get('/api/transcripts', (req, res) => {
    const db = getDb();
    const { source_id, lecture, type, limit = 100, offset = 0 } = req.query;

    let where = [];
    let params = [];

    if (source_id) {
        where.push('t.source_id = ?');
        params.push(source_id);
    }
    if (lecture) {
        where.push('t.lecture = ?');
        params.push(lecture);
    }
    if (type) {
        where.push('t.transcript_type = ?');
        params.push(type);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const transcripts = db.prepare(`
    SELECT t.id, t.source_id, t.original_id, t.lecture, t.filename,
           t.lecture_date, t.duration_minutes, t.transcript_type,
           s.name as source_name,
           LENGTH(t.content) as content_length
    FROM transcripts t
    JOIN sources s ON t.source_id = s.id
    ${whereClause}
    ORDER BY t.lecture_date ASC, t.filename ASC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

    const total = db.prepare(`
    SELECT COUNT(*) as count FROM transcripts t ${whereClause}
  `).get(...params);

    res.json({ transcripts, total: total.count });
});

// GET /api/transcripts/:id — Full transcript content
app.get('/api/transcripts/:id', (req, res) => {
    const db = getDb();
    const transcript = db.prepare(`
    SELECT t.*, s.name as source_name
    FROM transcripts t
    JOIN sources s ON t.source_id = s.id
    WHERE t.id = ?
  `).get(req.params.id);

    if (!transcript) {
        return res.status(404).json({ error: 'Transcript not found' });
    }

    const chunks = db.prepare(`
    SELECT id, chunk_index, chunk_text, start_timestamp, end_timestamp
    FROM chunks
    WHERE transcript_id = ?
    ORDER BY chunk_index ASC
  `).all(req.params.id);

    res.json({ ...transcript, chunks });
});

// GET /api/search — Full-text search
app.get('/api/search', (req, res) => {
    const db = getDb();
    const { q, source_id, lecture, type, courses: courseFilter, limit = 50, offset = 0 } = req.query;

    if (!q || q.trim().length === 0) {
        return res.json({ results: [], total: 0, query: '' });
    }

    // Clean query for FTS5: wrap in quotes for phrase or use as-is for boolean
    let ftsQuery = q.trim();

    // If it's a simple query (no FTS operators), add wildcard for partial matching
    if (!/["+\-*()]/.test(ftsQuery)) {
        const words = ftsQuery.split(/\s+/).filter(w => w.length > 0);
        ftsQuery = words.map(w => `"${w}"*`).join(' ');
    }

    // --- Transcript results ---
    let transcriptResults = [];
    let transcriptTotal = 0;
    {
        let where = [];
        let params = [];

        if (source_id) { where.push('t.source_id = ?'); params.push(source_id); }
        if (lecture) { where.push('t.lecture = ?'); params.push(lecture); }
        if (type) { where.push('t.transcript_type = ?'); params.push(type); }
        const whereClause = where.length > 0 ? 'AND ' + where.join(' AND ') : '';

        try {
            transcriptResults = db.prepare(`
              SELECT c.id as chunk_id, c.chunk_index, c.start_timestamp, c.end_timestamp,
                     snippet(chunks_fts, 0, '<mark>', '</mark>', '...', 40) as snippet,
                     rank,
                     t.id as transcript_id, t.lecture, t.filename, t.lecture_date,
                     t.duration_minutes, t.transcript_type,
                     s.name as source_name,
                     'transcript' as result_type
              FROM chunks_fts
              JOIN chunks c ON c.id = chunks_fts.rowid
              JOIN transcripts t ON c.transcript_id = t.id
              JOIN sources s ON t.source_id = s.id
              WHERE chunks_fts MATCH ?
              ${whereClause}
              ORDER BY rank
              LIMIT ?
            `).all(ftsQuery, ...params, parseInt(limit));

            transcriptTotal = db.prepare(`
              SELECT COUNT(*) as count
              FROM chunks_fts
              JOIN chunks c ON c.id = chunks_fts.rowid
              JOIN transcripts t ON c.transcript_id = t.id
              JOIN sources s ON t.source_id = s.id
              WHERE chunks_fts MATCH ?
              ${whereClause}
            `).get(ftsQuery, ...params).count;
        } catch (err) {
            // FTS5 query syntax error — try simpler
            try {
                const simpleQuery = `"${q.trim()}"`;
                transcriptResults = db.prepare(`
                  SELECT c.id as chunk_id, c.chunk_index, c.start_timestamp, c.end_timestamp,
                         snippet(chunks_fts, 0, '<mark>', '</mark>', '...', 40) as snippet,
                         rank,
                         t.id as transcript_id, t.lecture, t.filename, t.lecture_date,
                         t.duration_minutes, t.transcript_type,
                         s.name as source_name,
                         'transcript' as result_type
                  FROM chunks_fts
                  JOIN chunks c ON c.id = chunks_fts.rowid
                  JOIN transcripts t ON c.transcript_id = t.id
                  JOIN sources s ON t.source_id = s.id
                  WHERE chunks_fts MATCH ?
                  ${whereClause}
                  ORDER BY rank
                  LIMIT ?
                `).all(simpleQuery, ...params, parseInt(limit));
                transcriptTotal = db.prepare(`
                  SELECT COUNT(*) as count
                  FROM chunks_fts
                  JOIN chunks c ON c.id = chunks_fts.rowid
                  JOIN transcripts t ON c.transcript_id = t.id
                  WHERE chunks_fts MATCH ?
                  ${whereClause}
                `).get(simpleQuery, ...params).count;
            } catch (err2) { /* no transcript results */ }
        }
    }

    // --- Course results ---
    // Skip when user filtered to a specific source and didn't select courses
    let courseResults = [];
    let courseTotal = 0;
    if (!(source_id && !courseFilter)) {
        let courseWhere = [];
        let courseParams = [];
        if (courseFilter) {
            const ids = courseFilter.split(',').map(Number).filter(Boolean);
            if (ids.length > 0) {
                courseWhere.push(`co.id IN (${ids.map(() => '?').join(',')})`);
                courseParams.push(...ids);
            }
        }
        const courseWhereClause = courseWhere.length > 0 ? 'AND ' + courseWhere.join(' AND ') : '';

        try {
            courseResults = db.prepare(`
              SELECT cc.id as chunk_id, cc.position as chunk_index,
                     highlight(course_chunks_fts, 0, '<mark>', '</mark>') as snippet,
                     rank,
                     cl.id as lecture_id, cl.title as lecture_title, cl.class_number, cl.duration,
                     cs.title as section_title,
                     co.id as course_id, co.title as course_title,
                     'course' as result_type
              FROM course_chunks_fts
              JOIN course_chunks cc ON cc.id = course_chunks_fts.rowid
              JOIN course_lectures cl ON cc.lecture_id = cl.id
              JOIN course_sections cs ON cl.section_id = cs.id
              JOIN courses co ON cl.course_id = co.id
              WHERE course_chunks_fts MATCH ?
              ${courseWhereClause}
              ORDER BY rank
              LIMIT ?
            `).all(ftsQuery, ...courseParams, parseInt(limit));

            courseTotal = db.prepare(`
              SELECT COUNT(*) as count
              FROM course_chunks_fts
              JOIN course_chunks cc ON cc.id = course_chunks_fts.rowid
              JOIN course_lectures cl ON cc.lecture_id = cl.id
              JOIN courses co ON cl.course_id = co.id
              WHERE course_chunks_fts MATCH ?
              ${courseWhereClause}
            `).get(ftsQuery, ...courseParams).count;
        } catch (err) {
            try {
                const simpleQuery = `"${q.trim()}"`;
                courseResults = db.prepare(`
                  SELECT cc.id as chunk_id, cc.position as chunk_index,
                         highlight(course_chunks_fts, 0, '<mark>', '</mark>') as snippet,
                         rank,
                         cl.id as lecture_id, cl.title as lecture_title, cl.class_number, cl.duration,
                         cs.title as section_title,
                         co.id as course_id, co.title as course_title,
                         'course' as result_type
                  FROM course_chunks_fts
                  JOIN course_chunks cc ON cc.id = course_chunks_fts.rowid
                  JOIN course_lectures cl ON cc.lecture_id = cl.id
                  JOIN course_sections cs ON cl.section_id = cs.id
                  JOIN courses co ON cl.course_id = co.id
                  WHERE course_chunks_fts MATCH ?
                  ${courseWhereClause}
                  ORDER BY rank
                  LIMIT ?
                `).all(simpleQuery, ...courseParams, parseInt(limit));
                courseTotal = db.prepare(`
                  SELECT COUNT(*) as count
                  FROM course_chunks_fts
                  JOIN course_chunks cc ON cc.id = course_chunks_fts.rowid
                  JOIN course_lectures cl ON cc.lecture_id = cl.id
                  JOIN courses co ON cl.course_id = co.id
                  WHERE course_chunks_fts MATCH ?
                  ${courseWhereClause}
                `).get(simpleQuery, ...courseParams).count;
            } catch (err2) { /* no course results */ }
        }
    }

    // Merge and sort by rank (lower = better match in FTS5)
    const merged = [...transcriptResults, ...courseResults].sort((a, b) => a.rank - b.rank);
    const total = transcriptTotal + courseTotal;
    const paged = merged.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
        results: paged,
        total,
        transcriptTotal,
        courseTotal,
        query: q,
    });
});

// =============================================================================
// AI Search via OpenRouter
// =============================================================================

// --- Load .env file (lightweight, no dotenv dependency) ---
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) process.env[key] = val;
        }
    }
}

// Phase 4a: ai-settings honors DATA_DIR env var (same pattern as server/db.js)
const SETTINGS_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'ai-settings.json');
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        }
    } catch (e) { /* ignore */ }
    return { apiKey: '', selectedModel: '', models: [] };
}

// Seed API key from .env if not already saved
(function seedFromEnv() {
    const envKey = process.env.OPENROUTER_API_KEY;
    if (envKey && envKey !== 'your-openrouter-api-key-here') {
        const settings = loadSettings();
        if (!settings.apiKey) {
            settings.apiKey = envKey;
            try {
                fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
                console.log('   ✓ API key loaded from .env');
            } catch (e) { /* ignore */ }
        }
    }
})();

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// Generic helpers for reading/writing the shared ai-settings.json (used by
// the Media Library settings endpoints as well as the AI settings above).
function readSettingsJson() {
    try {
        if (!fs.existsSync(SETTINGS_PATH)) return {};
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch { return {}; }
}
function writeSettingsJson(settings) {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

async function getPathInfo(pathStr) {
    const result = { path: pathStr, exists: false, writable: false, freeSpaceBytes: null, usedBytes: 0, videoCount: 0 };
    try {
        fs.statSync(pathStr);
        result.exists = true;
        try { fs.accessSync(pathStr, fs.constants.W_OK); result.writable = true; } catch { result.writable = false; }
        // Walk for video.mp4 files and accumulate size
        const walk = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) walk(full);
                    else if (entry.name === 'video.mp4') {
                        try {
                            const s = fs.statSync(full);
                            result.usedBytes += s.size;
                            result.videoCount += 1;
                        } catch { /* skip unreadable file */ }
                    }
                }
            } catch { /* skip unreadable dir */ }
        };
        walk(pathStr);
        // Free space (Node 18.15+ has statfsSync)
        try {
            const sf = fs.statfsSync(pathStr);
            result.freeSpaceBytes = Number(sf.bavail) * Number(sf.bsize);
        } catch { result.freeSpaceBytes = null; }
    } catch { /* path doesn't exist or unreadable */ }
    return result;
}

// GET /api/ai/settings
app.get('/api/ai/settings', (req, res) => {
    const settings = loadSettings();
    // Mask the API key for the frontend
    res.json({
        apiKey: settings.apiKey ? '••••' + settings.apiKey.slice(-6) : '',
        hasKey: !!settings.apiKey,
        selectedModel: settings.selectedModel || '',
    });
});

// POST /api/ai/settings
app.post('/api/ai/settings', (req, res) => {
    const current = loadSettings();
    const { apiKey, selectedModel } = req.body;
    if (apiKey !== undefined && !apiKey.startsWith('••••')) {
        current.apiKey = apiKey;
    }
    if (selectedModel !== undefined) {
        current.selectedModel = selectedModel;
    }
    saveSettings(current);
    res.json({
        apiKey: current.apiKey ? '••••' + current.apiKey.slice(-6) : '',
        hasKey: !!current.apiKey,
        selectedModel: current.selectedModel,
    });
});

// GET /api/ai/models — proxy to OpenRouter /models to avoid CORS
app.get('/api/ai/models', async (req, res) => {
    const settings = loadSettings();
    if (!settings.apiKey) {
        return res.status(400).json({ error: 'No API key configured' });
    }
    try {
        const response = await fetch(`${OPENROUTER_BASE}/models`, {
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'HTTP-Referer': 'http://localhost:5173',
            },
        });
        if (!response.ok) {
            return res.status(response.status).json({ error: `OpenRouter error: ${response.status}` });
        }
        const data = await response.json();
        // Normalize and filter to text models only, sorted by id
        const models = (data.data || [])
            .filter(m => {
                // Only include text-capable chat models
                const inputMods = m.architecture?.input_modalities || ['text'];
                const outputMods = m.architecture?.output_modalities || ['text'];
                return inputMods.includes('text') && outputMods.includes('text');
            })
            .map(m => ({
                id: m.id,
                name: m.name || m.id,
                contextLength: m.context_length,
                maxCompletionTokens: m.top_provider?.max_completion_tokens,
                pricing: m.pricing,
                supportedParameters: m.supported_parameters || [],
            }))
            .sort((a, b) => a.id.localeCompare(b.id));

        res.json({ models, count: models.length });
    } catch (err) {
        console.error('Failed to fetch OpenRouter models:', err.message);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

// POST /api/ai/ask — RAG: FTS5 context retrieval + OpenRouter LLM stream
app.post('/api/ai/ask', async (req, res) => {
    const settings = loadSettings();
    if (!settings.apiKey) {
        return res.status(400).json({ error: 'No API key configured. Open settings to add your OpenRouter key.' });
    }
    if (!settings.selectedModel) {
        return res.status(400).json({ error: 'No model selected. Open settings to choose a model.' });
    }

    const { question, source_id, lecture, type, courses: courseFilter } = req.body;
    if (!question || question.trim().length === 0) {
        return res.status(400).json({ error: 'No question provided' });
    }

    const db = getDb();

    // Step 1: Extract key terms from the question for FTS5
    const stopWords = new Set(['what', 'how', 'why', 'when', 'where', 'who', 'did', 'does', 'do', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'about', 'that', 'this', 'it', 'its', 'say', 'said', 'talk', 'talked', 'tell', 'told', 'recommend', 'recommended', 'think', 'thought', 'should', 'would', 'could', 'can', 'will', 'have', 'has', 'had', 'been', 'being', 'be', 'not', 'no', 'yes', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'we', 'our', 'you', 'your', 'my', 'me', 'i']);
    const words = question.trim().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
    const ftsQuery = words.map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');

    // Step 2a: Retrieve transcript context chunks via FTS5
    let contextChunks = [];
    if (ftsQuery.length > 0) {
        let where = [];
        let params = [];

        if (source_id) { where.push('t.source_id = ?'); params.push(source_id); }
        if (lecture) { where.push('t.lecture = ?'); params.push(lecture); }
        if (type) { where.push('t.transcript_type = ?'); params.push(type); }

        const whereClause = where.length > 0 ? 'AND ' + where.join(' AND ') : '';

        try {
            contextChunks = db.prepare(`
                SELECT c.chunk_text, c.start_timestamp,
                       t.lecture, t.filename, t.lecture_date,
                       rank, 'transcript' as source_type
                FROM chunks_fts
                JOIN chunks c ON c.id = chunks_fts.rowid
                JOIN transcripts t ON c.transcript_id = t.id
                WHERE chunks_fts MATCH ?
                ${whereClause}
                ORDER BY rank
                LIMIT 8
            `).all(ftsQuery, ...params);
        } catch (e) {
            const simpler = words.slice(0, 3).map(w => `"${w}"`).join(' OR ');
            try {
                contextChunks = db.prepare(`
                    SELECT c.chunk_text, c.start_timestamp,
                           t.lecture, t.filename, t.lecture_date,
                           rank, 'transcript' as source_type
                    FROM chunks_fts
                    JOIN chunks c ON c.id = chunks_fts.rowid
                    JOIN transcripts t ON c.transcript_id = t.id
                    WHERE chunks_fts MATCH ?
                    ${whereClause}
                    ORDER BY rank
                    LIMIT 8
                `).all(simpler, ...params);
            } catch (e2) { /* no context */ }
        }
    }

    // Step 2b: Retrieve course context chunks via FTS5
    // Skip when user filtered to a specific source and didn't select courses
    let courseContextChunks = [];
    if (ftsQuery.length > 0 && !(source_id && !courseFilter)) {
        let courseWhere = [];
        let courseParams = [];
        if (courseFilter) {
            const ids = (Array.isArray(courseFilter) ? courseFilter : courseFilter.split(','))
                .map(Number).filter(Boolean);
            if (ids.length > 0) {
                courseWhere.push(`co.id IN (${ids.map(() => '?').join(',')})`);
                courseParams.push(...ids);
            }
        }
        const courseWhereClause = courseWhere.length > 0 ? 'AND ' + courseWhere.join(' AND ') : '';

        try {
            courseContextChunks = db.prepare(`
                SELECT cc.content as chunk_text,
                       cl.title as lecture, co.title as filename,
                       NULL as start_timestamp, NULL as lecture_date,
                       rank, 'course' as source_type
                FROM course_chunks_fts
                JOIN course_chunks cc ON cc.id = course_chunks_fts.rowid
                JOIN course_lectures cl ON cc.lecture_id = cl.id
                JOIN courses co ON cl.course_id = co.id
                WHERE course_chunks_fts MATCH ?
                ${courseWhereClause}
                ORDER BY rank
                LIMIT 6
            `).all(ftsQuery, ...courseParams);
        } catch (e) { /* no course context */ }
    }

    // Merge all context, interleaved by rank
    const allContext = [...contextChunks, ...courseContextChunks].sort((a, b) => a.rank - b.rank).slice(0, 14);

    // Step 3: Build the prompt with context
    const contextText = allContext.map((ch, i) => {
        const typeLabel = ch.source_type === 'course' ? 'Course' : 'Transcript';
        const header = `[${typeLabel} Source ${i + 1}: "${ch.lecture}" — ${ch.filename}${ch.start_timestamp ? ` @ ${ch.start_timestamp}` : ''}${ch.lecture_date ? ` (${ch.lecture_date})` : ''}]`;
        return `${header}\n${ch.chunk_text.slice(0, 2000)}`;
    }).join('\n\n---\n\n');

    const systemPrompt = `You are a research assistant helping a user search through a collection of publishing summit transcripts and Teachable course content from Future Fiction Academy. The content includes weekly workshop transcripts covering topics like business structures, LLC formation, genre research, pen names, AI writing tools, Claude/MCPs, Storm Chaser Method, Series Architect, newsletters, and more — as well as course materials from Teachable.

When answering:
- Base your answers ONLY on the provided excerpts
- Include as much direct information from the source material as possible — quote or closely paraphrase rather than summarize
- Cite specific lectures, courses, and timestamps when referencing material
- If the excerpts don't contain enough information to fully answer, say so clearly
- Format your response however best fits the content — use the user's instructions for formatting preferences`;

    const userMessage = allContext.length > 0
        ? `Based on the following transcript and course excerpts, please answer this question:\n\n**Question:** ${question}\n\n---\n\n${contextText}`
        : `I couldn't find specific excerpts matching your question. Please answer based on general knowledge, but note that no matching content was found.\n\n**Question:** ${question}`;

    // Step 4: Stream to OpenRouter
    try {
        const orResponse = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:5173',
            },
            body: JSON.stringify({
                model: settings.selectedModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                stream: true,
                max_tokens: 2048,
                temperature: 0.3,
            }),
        });

        if (!orResponse.ok) {
            const errText = await orResponse.text();
            console.error('OpenRouter error:', orResponse.status, errText);
            return res.status(orResponse.status).json({ error: `OpenRouter error: ${orResponse.status}` });
        }

        // Stream SSE back to the client
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Send context info first
        res.write(`data: ${JSON.stringify({ type: 'context', chunks: contextChunks.length })}\n\n`);

        const reader = orResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                        continue;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;
                        if (delta?.content) {
                            res.write(`data: ${JSON.stringify({ type: 'text', content: delta.content })}\n\n`);
                        }
                        // Capture usage if present
                        if (parsed.usage) {
                            res.write(`data: ${JSON.stringify({ type: 'usage', usage: parsed.usage })}\n\n`);
                        }
                    } catch (e) { /* skip unparseable chunks */ }
                }
            }
        }

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
    } catch (err) {
        console.error('AI ask error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to get AI response' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        }
    }
});

// =============================================================================
// LLM Wiki — Karpathy three-layer pattern
// =============================================================================

// GET /api/wiki/entities?kind=author|technique|tool|debate
app.get('/api/wiki/entities', (req, res) => {
    try {
        const kind = req.query.kind || null;
        const entities = listEntities({ kind });
        // Parse aliases JSON for the client
        const parsed = entities.map(e => {
            let aliases = [];
            try { aliases = JSON.parse(e.aliases || '[]'); } catch { /* ignore */ }
            return { ...e, aliases };
        });
        res.json({ entities: parsed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/wiki/entity/:id
app.get('/api/wiki/entity/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Invalid entity id' });
        }
        const entity = getEntity(id);
        if (!entity) return res.status(404).json({ error: 'Entity not found' });
        res.json(entity);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wiki/ingest/:lectureId — manually ingest one lecture (dev/debug; auto-ingest covers normal flow)
app.post('/api/wiki/ingest/:lectureId', async (req, res) => {
    try {
        const lectureId = Number(req.params.lectureId);
        if (!Number.isInteger(lectureId) || lectureId <= 0) {
            return res.status(400).json({ error: 'Invalid lecture id' });
        }
        const force = req.query.force === '1' || req.body?.force === true;
        const result = await ingestLecture(lectureId, { force });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wiki/rebuild — SSE stream of rebuild progress.
// Body: { courseId?: number }  — omit for full library rebuild.
app.post('/api/wiki/rebuild', async (req, res) => {
    const { courseId } = req.body || {};
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    try {
        if (courseId) {
            const cid = Number(courseId);
            const result = await rebuildCourse(cid, (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            res.write(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`);
        } else {
            // Full rebuild: walk every course, rebuilding sequentially.
            const db = getDb();
            const courses = db.prepare('SELECT id, title FROM courses ORDER BY title').all();
            let totalProcessed = 0;
            let totalFailed = 0;
            for (let i = 0; i < courses.length; i++) {
                const c = courses[i];
                res.write(`data: ${JSON.stringify({ type: 'course', current: i + 1, total: courses.length, course: c.title })}\n\n`);
                try {
                    const r = await rebuildCourse(c.id, (event) => {
                        res.write(`data: ${JSON.stringify(event)}\n\n`);
                    });
                    totalProcessed += r.processed;
                    totalFailed += r.failed;
                } catch (err) {
                    totalFailed++;
                    res.write(`data: ${JSON.stringify({ type: 'error', course: c.title, error: err.message })}\n\n`);
                }
            }
            res.write(`data: ${JSON.stringify({ type: 'done', processed: totalProcessed, failed: totalFailed })}\n\n`);
        }
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    } finally {
        res.end();
    }
});

// POST /api/wiki/lint — run lint and return findings
app.post('/api/wiki/lint', (req, res) => {
    try {
        res.json(wikiLint());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/wiki/log — recent wiki_log entries (for UI debug panel)
app.get('/api/wiki/log', (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 500);
        res.json({ entries: wikiRecentLog(limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// Teachable Course Management
// =============================================================================

app.get('/api/courses', (req, res) => {
    const db = getDb();
    const courses = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM course_lectures WHERE course_id = c.id) as lecture_count,
               (SELECT COUNT(*) FROM course_chunks cc JOIN course_lectures cl ON cc.lecture_id = cl.id WHERE cl.course_id = c.id) as chunk_count,
               (SELECT COUNT(*) FROM transcripts t JOIN sources s ON t.source_id = s.id WHERE s.course_id = c.id AND t.lecture_id IS NULL) as orphan_transcript_count
        FROM courses c ORDER BY c.title
    `).all();
    res.json(courses);
});

// GET /api/courses/available — Fetch available courses from Teachable
app.get('/api/courses/available', async (req, res) => {
    if (!hasSession()) return res.status(401).json({ error: 'Not logged in' });
    try {
        const db = getDb();
        const available = await fetchAvailableCourses();
        // Cross-reference with already-scraped courses
        const scraped = db.prepare('SELECT teachable_id FROM courses').all().map(c => c.teachable_id);
        const enriched = available.map(c => ({
            ...c,
            alreadyScraped: scraped.includes(c.teachableId),
        }));
        res.json(enriched);
    } catch (err) {
        console.error('Failed to fetch available courses:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/courses/scrape', async (req, res) => {
    const { url, forceRefresh = false } = req.body;
    if (!url) return res.status(400).json({ error: 'Course URL is required' });
    if (!hasSession()) return res.status(401).json({ error: 'Not logged in. Please log in first.' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    try {
        const result = await scrapeCourse(url, (message, pct) => {
            res.write(`data: ${JSON.stringify({ message, pct })}\n\n`);
        }, { forceRefresh });
        res.write(`data: ${JSON.stringify({ done: true, ...result })}\n\n`);

        // Auto-ingest: kick off wiki extraction in the background for any lecture
        // whose chunks are newer than its last wiki_ingested_at. Fire-and-forget;
        // errors are logged to wiki_log but never thrown back to the scrape caller.
        ingestPending({ courseId: result.courseId })
            .then(summary => {
                if (summary.total > 0) {
                    console.log(`[wiki] auto-ingested course ${result.courseId}: ${summary.processed}/${summary.total} ok, ${summary.failed} failed`);
                }
            })
            .catch(err => console.error('[wiki] auto-ingest crashed:', err.message));
    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.end();
});

// Phase 4b: GET /api/system/ffmpeg — report ffmpeg availability for UI pre-flight
app.get('/api/system/ffmpeg', async (_req, res) => {
    try {
        const r = await checkFfmpeg();
        res.json(r);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// GET /api/archive-failures — list unresolved per-video download failures.
// Rows are inserted by media-downloader on ffmpeg error and cleared on the
// next successful download for the same (lecture_id, video_index). The UI
// reads this to surface what to retry without scrolling back through the
// archive modal's SSE log.
app.get('/api/archive-failures', (req, res) => {
    const db = getDb();
    const courseFilter = req.query.course_id ? Number(req.query.course_id) : null;
    const where = courseFilter ? 'WHERE cl.course_id = ?' : '';
    const params = courseFilter ? [courseFilter] : [];
    const rows = db.prepare(`
        SELECT af.id, af.lecture_id, af.video_index, af.filename,
               af.error_message, af.attempted_at,
               cl.title AS lecture_title,
               c.id AS course_id, c.title AS course_title
        FROM archive_failures af
        JOIN course_lectures cl ON cl.id = af.lecture_id
        JOIN courses c ON c.id = cl.course_id
        ${where}
        ORDER BY af.attempted_at DESC
    `).all(...params);
    res.json(rows);
});

// Phase 4b: POST /api/courses/:id/archive-videos — SSE stream of archive progress
// Active jobs tracked so DELETE can abort by courseId.
const _activeArchiveJobs = new Map(); // courseId -> AbortController

app.post('/api/courses/:id/archive-videos', async (req, res) => {
    const courseId = Number(req.params.id);
    if (!Number.isInteger(courseId) || courseId <= 0) {
        return res.status(400).json({ error: 'Invalid courseId' });
    }
    const { force = false, sectionId = null, classNumber = null } = req.body || {};

    if (_activeArchiveJobs.has(courseId)) {
        return res.status(409).json({ error: 'An archive job is already running for this course' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const controller = new AbortController();
    _activeArchiveJobs.set(courseId, controller);

    // If the client disconnects (closes the browser tab), abort the job.
    // Use res.on('close') — fires when the response stream closes (actual disconnect),
    // not req.on('close') which fires when the request body is fully read.
    res.on('close', () => {
        if (_activeArchiveJobs.get(courseId) === controller) {
            controller.abort();
        }
    });

    try {
        const { error } = await archiveCourseVideos(courseId, {
            force,
            sectionId,
            classNumber,
            signal: controller.signal,
            onProgress: (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            },
        });
        if (error) res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch (err) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    } finally {
        _activeArchiveJobs.delete(courseId);
        res.end();
    }
});

// Phase 4b: DELETE /api/courses/:id/archive-videos — abort the active job for this course
app.delete('/api/courses/:id/archive-videos', (req, res) => {
    const courseId = Number(req.params.id);
    const controller = _activeArchiveJobs.get(courseId);
    if (!controller) {
        return res.status(404).json({ error: 'No active archive job for this course' });
    }
    controller.abort();
    res.json({ ok: true, courseId });
});

// GET /api/courses/lectures/:id — Single lecture detail with chunks
app.get('/api/courses/lectures/:id', (req, res) => {
    const db = getDb();
    const lecture = db.prepare(`
        SELECT cl.*, cs.title as section_title, c.title as course_title
        FROM course_lectures cl
        LEFT JOIN course_sections cs ON cl.section_id = cs.id
        LEFT JOIN courses c ON cl.course_id = c.id
        WHERE cl.id = ?
    `).get(req.params.id);
    if (!lecture) return res.status(404).json({ error: 'Lecture not found' });

    const chunks = db.prepare(
        'SELECT * FROM course_chunks WHERE lecture_id = ? ORDER BY position'
    ).all(req.params.id);

    res.json({ ...lecture, chunks, content: chunks.map(c => c.content).join('\n\n---\n\n') });
});

// GET /api/courses/lectures/:id/transcripts
// Returns legacy imported transcripts that have been FK-linked to this
// scraped lecture (transcripts.lecture_id = :id). Used by the sidebar to
// render "Transcript" child nodes under each lecture.
app.get('/api/courses/lectures/:id/transcripts', (req, res) => {
    const db = getDb();
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId) || lectureId <= 0) {
        return res.status(400).json({ error: 'Invalid lecture id' });
    }
    const transcripts = db.prepare(`
        SELECT t.id, t.source_id, t.lecture, t.filename, t.transcript_type,
               t.lecture_date, t.duration_minutes,
               s.name AS source_name,
               LENGTH(t.content) AS content_length
        FROM transcripts t
        JOIN sources s ON t.source_id = s.id
        WHERE t.lecture_id = ?
        ORDER BY t.transcript_type ASC, t.filename ASC
    `).all(lectureId);
    res.json(transcripts);
});

// GET /api/courses/:courseId/orphan-transcripts
// Returns transcripts whose source is matched to this course (sources.course_id
// = :courseId) but the transcript itself has no specific lecture link
// (transcripts.lecture_id IS NULL). Rendered as "Other Transcripts" under the
// course node in the sidebar.
app.get('/api/courses/:courseId/orphan-transcripts', (req, res) => {
    const db = getDb();
    const courseId = Number(req.params.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) {
        return res.status(400).json({ error: 'Invalid course id' });
    }
    const transcripts = db.prepare(`
        SELECT t.id, t.source_id, t.lecture, t.filename, t.transcript_type,
               t.lecture_date, t.duration_minutes,
               s.name AS source_name,
               LENGTH(t.content) AS content_length
        FROM transcripts t
        JOIN sources s ON t.source_id = s.id
        WHERE s.course_id = ? AND t.lecture_id IS NULL
        ORDER BY t.lecture ASC, t.transcript_type ASC, t.filename ASC
    `).all(courseId);
    res.json(transcripts);
});

// Phase 5: GET /api/courses/lectures/:id/videos
// Returns the list of archived video files for a lecture.
// Response: [{ file, sizeBytes, durationSec }]
app.get('/api/courses/lectures/:id/videos', async (req, res) => {
    const db = getDb();
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId) || lectureId <= 0) {
        return res.status(400).json({ error: 'Invalid lecture id' });
    }
    const lecture = db.prepare(
        'SELECT id, video_local_paths, video_duration_sec FROM course_lectures WHERE id = ?'
    ).get(lectureId);
    if (!lecture) {
        return res.status(404).json({ error: 'Lecture not found' });
    }

    let paths = [];
    if (lecture.video_local_paths) {
        try { paths = JSON.parse(lecture.video_local_paths); }
        catch { paths = []; }
    }
    if (!Array.isArray(paths)) paths = [];

    const { resolveRelative } = await import('./media-library.js');
    const results = [];
    for (const relPath of paths) {
        try {
            const abs = resolveRelative(relPath);
            const stat = fs.statSync(abs);
            const file = path.basename(relPath);
            results.push({
                file,
                sizeBytes: stat.size,
                // For now we only know the AGGREGATE duration across all videos.
                // If exactly one video, use it; otherwise return null and let the
                // frontend display the player's own duration once loaded.
                durationSec: (paths.length === 1) ? lecture.video_duration_sec : null,
            });
        } catch {
            // file missing on disk — skip; frontend will see fewer entries than expected
        }
    }
    res.json(results);
});

// Phase 5: GET /api/courses/lectures/:id/video/:filename
// Streams a specific archived video file with HTTP Range support.
// Filename must match /^video(_\d+)?\.mp4$/ AND be present in the lecture's
// video_local_paths JSON array (defense in depth against path traversal).
app.get('/api/courses/lectures/:id/video/:filename', async (req, res) => {
    const db = getDb();
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId) || lectureId <= 0) {
        return res.status(400).json({ error: 'Invalid lecture id' });
    }
    const filename = req.params.filename;
    if (!/^video(_\d+)?\.mp4$/.test(filename)) {
        return res.status(404).end();
    }

    const lecture = db.prepare(
        'SELECT video_local_paths FROM course_lectures WHERE id = ?'
    ).get(lectureId);
    if (!lecture || !lecture.video_local_paths) {
        return res.status(404).end();
    }

    let paths = [];
    try { paths = JSON.parse(lecture.video_local_paths); } catch { /* */ }
    if (!Array.isArray(paths)) paths = [];

    // The filename must match the BASENAME of one of the recorded paths
    const matched = paths.find(p => path.basename(p) === filename);
    if (!matched) {
        return res.status(404).end();
    }

    const { resolveRelative } = await import('./media-library.js');
    let absPath;
    try {
        absPath = resolveRelative(matched);
    } catch {
        return res.status(404).end();
    }

    let stat;
    try { stat = fs.statSync(absPath); }
    catch { return res.status(404).end(); }

    const total = stat.size;
    const range = req.headers.range;

    if (!range) {
        // Full file — 200 OK
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(absPath).pipe(res);
        return;
    }

    // Parse "Range: bytes=START-END" (END optional)
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
        return res.status(416).end();
    }
    const start = Number(m[1]);
    let end = m[2] === '' ? total - 1 : Number(m[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.end();
    }

    res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
});

// GET /api/courses/:id/sections — List sections for a course with lecture counts
app.get('/api/courses/:id/sections', (req, res) => {
    const db = getDb();
    const includeLectures = req.query.include_lectures === 'true' || req.query.include_lectures === '1';
    const sections = db.prepare(`
        SELECT cs.id, cs.title, cs.position,
               COUNT(cl.id) as lecture_count
        FROM course_sections cs
        LEFT JOIN course_lectures cl ON cl.section_id = cs.id
          AND (cl.removed_at IS NULL OR cl.removed_at = '')
        WHERE cs.course_id = ?
          AND cs.title NOT LIKE '%Check Out the FFA Free Community Classes%'
        GROUP BY cs.id
        ORDER BY cs.position
    `).all(req.params.id);
    if (includeLectures) {
        const lecturesByCourse = db.prepare(`
            SELECT cl.id, cl.section_id, cl.title, cl.class_number, cl.position, cl.duration,
                   cl.video_provider, cl.video_local_path,
                   (SELECT COUNT(*) FROM transcripts WHERE lecture_id = cl.id) as transcript_count
            FROM course_lectures cl
            WHERE cl.course_id = ?
              AND (cl.removed_at IS NULL OR cl.removed_at = '')
            ORDER BY cl.section_id, cl.position
        `).all(req.params.id);
        const bySection = new Map();
        for (const lec of lecturesByCourse) {
            if (!bySection.has(lec.section_id)) bySection.set(lec.section_id, []);
            bySection.get(lec.section_id).push(lec);
        }
        for (const sec of sections) {
            sec.lectures = bySection.get(sec.id) || [];
        }
    }
    res.json(sections);
});

// GET /api/courses/:id/lectures — List lectures, excluding Teachable nav artifacts
// Optional ?type= filter: only return lectures that have at least one FK-linked
// transcript whose transcript_type matches. Categories come from the legacy
// `transcripts` table — for a course with no linked transcripts the result is
// empty (semantically correct: no transcripts of that type exist on this course).
app.get('/api/courses/:id/lectures', (req, res) => {
    const db = getDb();
    const sectionId = req.query.section_id ? parseInt(req.query.section_id) : null;
    const type = req.query.type ? String(req.query.type) : null;
    const whereParts = ['cl.course_id = ?'];
    const params = [req.params.id];
    if (sectionId) {
        whereParts.push('cl.section_id = ?');
        params.push(sectionId);
    }
    if (type) {
        whereParts.push(`EXISTS (
            SELECT 1 FROM transcripts t
            WHERE t.lecture_id = cl.id AND t.transcript_type = ?
        )`);
        params.push(type);
    }
    const lectures = db.prepare(`
        SELECT cl.*, cs.title as section_title
        FROM course_lectures cl
        LEFT JOIN course_sections cs ON cl.section_id = cs.id
        WHERE ${whereParts.join(' AND ')}
          AND cl.title != 'Start'
          AND cl.title NOT LIKE '%Check Out the FFA Free Community Classes%'
        ORDER BY cs.position, cl.position
    `).all(...params);
    res.json(lectures);
});

// PATCH /api/courses/:id — Update editable fields (notion_url)
app.patch('/api/courses/:id', (req, res) => {
    const db = getDb();
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const { notion_url } = req.body;
    if (notion_url !== undefined) {
        const url = notion_url ? String(notion_url).trim() : null;
        db.prepare('UPDATE courses SET notion_url = ? WHERE id = ?').run(url, req.params.id);
    }
    res.json({ success: true });
});

app.delete('/api/courses/:id', (req, res) => {
    const db = getDb();
    const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    deleteCourse(course.id);
    res.json({ success: true, deleted: course.title });
});

// Delete a transcript source and all associated transcripts + chunks
app.delete('/api/sources/:id', (req, res) => {
    const db = getDb();
    const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    try {
        const txn = db.transaction(() => {
            const transcriptIds = db.prepare('SELECT id FROM transcripts WHERE source_id = ?').all(req.params.id);
            for (const t of transcriptIds) {
                db.prepare('DELETE FROM chunks WHERE transcript_id = ?').run(t.id);
            }
            db.prepare('DELETE FROM transcripts WHERE source_id = ?').run(req.params.id);
            db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
        });
        txn();
        // Rebuild FTS index after deletion
        try { db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')"); } catch (e) { /* FTS rebuild optional */ }
        res.json({ success: true, deleted: source.name });
    } catch (err) {
        console.error('Delete source error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// =============================================================================
// Teachable Auth
// =============================================================================

app.get('/api/auth/status', (req, res) => {
    res.json({ loggedIn: hasSession() });
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const success = await openLoginBrowser();
        res.json({ success });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/logout', (req, res) => {
    clearSession();
    res.json({ success: true });
});

// =============================================================================
// Unified Course Search (searches course_chunks_fts)
// =============================================================================

app.get('/api/course-search', (req, res) => {
    const db = getDb();
    const { q, course } = req.query;
    if (!q || q.trim().length === 0) return res.json([]);

    const terms = q.trim().split(/\s+/).map(t => t.replace(/[^\w'-]/g, '')).filter(Boolean);
    if (terms.length === 0) return res.json([]);
    const ftsQuery = terms.join(' ');

    let query = `
        SELECT cc.id, cc.content, cc.position,
               cl.id as lecture_id, cl.title as lecture_title, cl.duration,
               cs.title as section_title,
               c.id as course_id, c.title as course_title,
               highlight(course_chunks_fts, 0, '<mark>', '</mark>') as highlighted
        FROM course_chunks_fts
        JOIN course_chunks cc ON cc.id = course_chunks_fts.rowid
        JOIN course_lectures cl ON cc.lecture_id = cl.id
        JOIN course_sections cs ON cl.section_id = cs.id
        JOIN courses c ON cl.course_id = c.id
        WHERE course_chunks_fts MATCH ?
    `;
    const params = [ftsQuery];
    if (course) { query += ' AND c.id = ?'; params.push(course); }
    query += ' ORDER BY rank LIMIT 100';

    try {
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        res.status(400).json({ error: 'Search error', details: err.message });
    }
});

// =============================================================================
// Media Library Settings
// =============================================================================

// GET /api/settings/media-library
app.get('/api/settings/media-library', async (_req, res) => {
    try {
        const { getMediaLibraryPath, DEFAULT_MEDIA_LIBRARY_PATH } = await import('./media-library.js');
        const currentPath = getMediaLibraryPath();
        const settings = readSettingsJson();
        const ack = settings.media_library_acknowledged === true;
        const info = await getPathInfo(currentPath);
        res.json({
            current_path: currentPath,
            default_path: DEFAULT_MEDIA_LIBRARY_PATH,
            acknowledged: ack,
            info,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/settings/media-library
app.post('/api/settings/media-library', async (req, res) => {
    const { path: newPath, acknowledged } = req.body || {};
    if (typeof newPath !== 'string' || newPath.trim() === '') {
        return res.status(400).json({ error: 'path is required and must be a non-empty string' });
    }
    try {
        const trimmed = newPath.trim();
        const info = await getPathInfo(trimmed);
        const settings = readSettingsJson();
        settings.media_library_path = trimmed;
        if (acknowledged) settings.media_library_acknowledged = true;
        writeSettingsJson(settings);
        res.json({ ok: true, current_path: trimmed, info });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/system/reveal?path=... — opens path in OS file manager
app.get('/api/system/reveal', (req, res) => {
    const targetPath = req.query.path;
    if (!targetPath || typeof targetPath !== 'string') {
        return res.status(400).json({ error: 'path query param required' });
    }
    let cmd, args;
    if (process.platform === 'darwin') {
        cmd = 'open'; args = [targetPath];
    } else if (process.platform === 'win32') {
        cmd = 'explorer'; args = [targetPath];
    } else {
        cmd = 'xdg-open'; args = [targetPath];
    }
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/system/pick-folder — opens a native folder picker (Electron only)
// Returns { canceled, path? } on success, 400 if not in Electron.
app.post('/api/system/pick-folder', async (req, res) => {
    if (!process.versions.electron) {
        return res.status(400).json({
            error: 'Folder picker unavailable in browser mode. Type the path directly into the field.',
        });
    }
    try {
        const electron = await import('electron');
        const dialog = electron.dialog;
        const result = await dialog.showOpenDialog({
            title: 'Choose Media Library Folder',
            buttonLabel: 'Use This Folder',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: (req.query && req.query.defaultPath) || undefined,
        });
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return res.json({ canceled: true });
        }
        res.json({ canceled: false, path: result.filePaths[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Serve static files (auto-detect dist/) ---
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

// Phase 4a: Export app and a startServer() function so Electron's main process
// (or any other host) can start the server programmatically. When invoked
// directly as `node server/server.js`, auto-start on env PORT or 3001.

export { app };

export async function startServer(port = process.env.PORT || 3001) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => {
            const actualPort = server.address().port;
            const servingUi = fs.existsSync(distPath);
            console.log(`\n🚀 FFA Transcript DB running at http://127.0.0.1:${actualPort}`);
            if (servingUi) {
                console.log(`   ✅ Serving app UI from dist/`);
            }
            console.log(`   📡 Teachable auth: ${hasSession() ? 'Logged in ✓' : 'Not logged in'}`);
            console.log(`\n   Open http://127.0.0.1:${actualPort} in your browser\n`);
            resolve({ server, port: actualPort });
        });
        server.on('error', reject);
    });
}

// Auto-start when invoked directly as a CLI (preserves `npm run start` behavior).
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
    startServer().catch(err => {
        console.error('Server failed to start:', err);
        process.exit(1);
    });
}

process.on('SIGINT', () => {
    closeDb();
    process.exit(0);
});
