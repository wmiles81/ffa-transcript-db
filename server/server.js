import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initializeDb, getDb, closeDb } from './db.js';
import { scrapeCourse, deleteCourse, openLoginBrowser, hasSession, clearSession, fetchAvailableCourses } from './scraper.js';

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
// Teachable Course Management
// =============================================================================

app.get('/api/courses', (req, res) => {
    const db = getDb();
    const courses = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM course_lectures WHERE course_id = c.id) as lecture_count,
               (SELECT COUNT(*) FROM course_chunks cc JOIN course_lectures cl ON cc.lecture_id = cl.id WHERE cl.course_id = c.id) as chunk_count
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
    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.end();
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

// GET /api/courses/:id/sections — List sections for a course with lecture counts
app.get('/api/courses/:id/sections', (req, res) => {
    const db = getDb();
    const sections = db.prepare(`
        SELECT cs.id, cs.title, cs.position,
               COUNT(cl.id) as lecture_count
        FROM course_sections cs
        LEFT JOIN course_lectures cl ON cl.section_id = cs.id
        WHERE cs.course_id = ?
          AND cs.title NOT LIKE '%Check Out the FFA Free Community Classes%'
        GROUP BY cs.id
        ORDER BY cs.position
    `).all(req.params.id);
    res.json(sections);
});

// GET /api/courses/:id/lectures — List lectures, excluding Teachable nav artifacts
app.get('/api/courses/:id/lectures', (req, res) => {
    const db = getDb();
    const sectionId = req.query.section_id ? parseInt(req.query.section_id) : null;
    const whereClause = sectionId
        ? 'WHERE cl.course_id = ? AND cl.section_id = ?'
        : 'WHERE cl.course_id = ?';
    const params = sectionId ? [req.params.id, sectionId] : [req.params.id];

    const lectures = db.prepare(`
        SELECT cl.*, cs.title as section_title
        FROM course_lectures cl
        LEFT JOIN course_sections cs ON cl.section_id = cs.id
        ${whereClause}
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
