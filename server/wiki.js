// =============================================================================
// server/wiki.js — LLM Wiki layer on top of the transcript DB.
//
// Implements Karpathy's three-layer pattern (gist 442a6bf555914893e9891c11519de94f):
//   RAW (already exists)  →  WIKI (this module)  →  QUERY/LINT (this module + UI)
//
// Workflows:
//   - ingestLecture(lectureId)        — extract entities/notes/claims from one lecture
//   - rebuildCourse(courseId)         — wipe wiki rows for a course's lectures, re-ingest
//   - rebuildAll()                    — wipe + re-ingest every active lecture
//   - lint()                          — report orphans, contradictions, stale facts
//
// LLM access is routed through OpenRouter using the user's existing key+model
// in data/ai-settings.json (the same place /api/ai/ask reads from). No
// additional API key or SDK dependency required.
// =============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SETTINGS_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'ai-settings.json');
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// v1 entity kinds. Adding new kinds = update this array + extend the
// extraction prompt. The DB CHECK constraint also needs updating, but
// SQLite enforces it on insert so a missing entry fails loudly.
export const ENTITY_KINDS = ['author', 'technique', 'tool', 'debate'];

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return { apiKey: '', selectedModel: '' };
}

function nowIso() { return new Date().toISOString(); }

function logAction(action, { entityId = null, lectureId = null, summary = '' } = {}) {
  const db = getDb();
  db.prepare(
    'INSERT INTO wiki_log (ts, action, entity_id, lecture_id, summary) VALUES (?, ?, ?, ?, ?)'
  ).run(nowIso(), action, entityId, lectureId, summary);
}

// -----------------------------------------------------------------------------
// LLM call — OpenRouter chat completions, JSON response expected.
// Returns parsed JSON or throws.
// -----------------------------------------------------------------------------
async function callLLM({ systemPrompt, userMessage, model, apiKey, maxTokens = 2048, timeoutMs = 90_000 }) {
  // 90s hard timeout — without this a hung OpenRouter request blocks the
  // entire ingest loop indefinitely. AbortController fires both the fetch
  // abort and a meaningful error message.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        response_format: { type: 'json_object' },
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`OpenRouter timeout after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');

  // Some models still wrap JSON in markdown fences despite response_format.
  let jsonText = content.trim();
  const fenceMatch = jsonText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`LLM returned non-JSON: ${e.message}; got: ${jsonText.slice(0, 200)}`);
  }
}

// -----------------------------------------------------------------------------
// Extraction prompt — asks the LLM to surface entities, notes, claims.
// Schema is deliberately flat so reconciliation is straightforward.
// -----------------------------------------------------------------------------
const EXTRACTION_SYSTEM = `You are extracting structured knowledge from a Future Fiction Academy lecture transcript. The output feeds a domain wiki about writing craft, AI tools for authors, and publishing tactics.

Your output MUST be a single JSON object with this exact shape:

{
  "entities": [
    {
      "kind": "author" | "technique" | "tool" | "debate",
      "canonical_name": "string — the most common form of the name",
      "aliases": ["string", ...],   // other ways this entity is referenced
      "summary": "string — 1-2 sentences on what this entity is, in the context of FFA topics"
    }
  ],
  "notes": [
    {
      "entity_ref": "canonical_name of the entity this note belongs to",
      "markdown": "string — 1-3 sentences of substantive content extracted from this lecture about that entity. Quote or closely paraphrase. Cite specific advice, claims, or examples."
    }
  ],
  "claims": [
    {
      "entity_ref": "canonical_name",
      "claim_text": "string — a specific assertion that could be agreed with or disputed",
      "quote": "string — the exact words from the transcript that support the claim (1 sentence max)"
    }
  ]
}

Rules:
- Entity kinds:
  * "author" — instructors, guest speakers, named authors discussed (e.g. "Joanna Penn", "Russell Nohelty")
  * "technique" — named craft methods (e.g. "Snowflake outlining", "Save the Cat", "scene-sequel structure")
  * "tool" — software or services (e.g. "Sudowrite", "ChatGPT", "Plottr", "Atticus")
  * "debate" — topics where reasonable people disagree (e.g. "AI in fiction ethics", "KU vs wide", "trad vs indie")
- Only extract entities the transcript actually substantively discusses — skip name-drops with no content.
- Skip generic concepts ("writing", "books", "publishing") — entities must be specific.
- If the transcript discusses nothing wiki-worthy, return empty arrays.
- canonical_name must be consistent: same person across multiple notes uses the same string.
- Never invent quotes — only use exact substrings from the transcript.`;

const EXTRACTION_USER_TEMPLATE = (lectureTitle, courseTitle, transcript) =>
  `Lecture: ${lectureTitle}\nCourse: ${courseTitle}\n\nTranscript:\n${transcript}\n\nReturn the JSON object now.`;

// -----------------------------------------------------------------------------
// Reconciliation — match incoming entity to existing row by (kind, canonical_name)
// with alias fuzzy match as fallback.
// -----------------------------------------------------------------------------
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function findExistingEntity(kind, canonicalName, aliases = []) {
  const db = getDb();
  // 1. Exact (kind, canonical_name) match
  const exact = db.prepare(
    'SELECT * FROM wiki_entities WHERE kind = ? AND canonical_name = ?'
  ).get(kind, canonicalName);
  if (exact) return exact;

  // 2. Normalized canonical_name match across same kind
  const normIncoming = normalizeName(canonicalName);
  const sameKind = db.prepare(
    'SELECT * FROM wiki_entities WHERE kind = ?'
  ).all(kind);
  for (const row of sameKind) {
    if (normalizeName(row.canonical_name) === normIncoming) return row;
    let existingAliases = [];
    try { existingAliases = JSON.parse(row.aliases || '[]'); } catch { /* ignore */ }
    for (const a of existingAliases) {
      if (normalizeName(a) === normIncoming) return row;
    }
  }

  // 3. Incoming aliases match existing canonical_name
  for (const a of aliases) {
    const na = normalizeName(a);
    for (const row of sameKind) {
      if (normalizeName(row.canonical_name) === na) return row;
    }
  }
  return null;
}

function upsertEntity({ kind, canonicalName, aliases, summary, lectureId }) {
  const db = getDb();
  const existing = findExistingEntity(kind, canonicalName, aliases);
  if (existing) {
    // Merge aliases (union) and refresh summary if existing one is empty.
    let mergedAliases = [];
    try { mergedAliases = JSON.parse(existing.aliases || '[]'); } catch { /* ignore */ }
    const seen = new Set(mergedAliases.map(normalizeName));
    for (const a of aliases || []) {
      const na = normalizeName(a);
      if (na && !seen.has(na)) { mergedAliases.push(a); seen.add(na); }
    }
    // Also remember the incoming canonical_name as an alias if it differs
    if (existing.canonical_name !== canonicalName) {
      const nci = normalizeName(canonicalName);
      if (!seen.has(nci)) { mergedAliases.push(canonicalName); seen.add(nci); }
    }
    const newSummary = existing.summary && existing.summary.trim() ? existing.summary : (summary || '');
    db.prepare(
      'UPDATE wiki_entities SET aliases = ?, summary = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(mergedAliases), newSummary, nowIso(), existing.id);
    return { id: existing.id, created: false };
  }
  const info = db.prepare(`
    INSERT INTO wiki_entities (kind, canonical_name, aliases, summary, first_seen_lecture_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    kind,
    canonicalName,
    JSON.stringify(aliases || []),
    summary || '',
    lectureId,
    nowIso()
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

function addNoteForLecture({ entityId, lectureId, markdown }) {
  const db = getDb();
  // Idempotency: if a note for this (entity, lecture) already exists and the markdown
  // hasn't changed, skip. If markdown changed, update it. Avoids note duplication on
  // re-ingest of the same lecture.
  const lectureIdsJson = JSON.stringify([lectureId]);
  const existing = db.prepare(`
    SELECT id, markdown FROM wiki_notes
    WHERE entity_id = ? AND source_lecture_ids = ?
  `).get(entityId, lectureIdsJson);
  if (existing) {
    if (existing.markdown !== markdown) {
      db.prepare('UPDATE wiki_notes SET markdown = ?, updated_at = ? WHERE id = ?')
        .run(markdown, nowIso(), existing.id);
    }
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO wiki_notes (entity_id, markdown, source_lecture_ids, confidence, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityId, markdown, lectureIdsJson, 0.8, nowIso());
  return Number(info.lastInsertRowid);
}

function addClaimForLecture({ entityId, lectureId, claimText, quote }) {
  const db = getDb();
  // Append to supports[] for an existing matching claim, or create new.
  const existing = db.prepare(
    'SELECT id, supports FROM wiki_claims WHERE entity_id = ? AND claim_text = ?'
  ).get(entityId, claimText);
  if (existing) {
    let supports = [];
    try { supports = JSON.parse(existing.supports || '[]'); } catch { /* ignore */ }
    if (!supports.some(s => s.lecture_id === lectureId)) {
      supports.push({ lecture_id: lectureId, quote });
      db.prepare('UPDATE wiki_claims SET supports = ? WHERE id = ?')
        .run(JSON.stringify(supports), existing.id);
    }
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO wiki_claims (entity_id, claim_text, supports, contradicts, status)
    VALUES (?, ?, ?, ?, 'open')
  `).run(
    entityId,
    claimText,
    JSON.stringify([{ lecture_id: lectureId, quote }]),
    JSON.stringify([])
  );
  return Number(info.lastInsertRowid);
}

// -----------------------------------------------------------------------------
// Public: ingest one lecture.
// Returns { lectureId, entitiesProcessed, notesAdded, claimsAdded, skipped }.
// -----------------------------------------------------------------------------
export async function ingestLecture(lectureId, options = {}) {
  const { force = false } = options;
  const db = getDb();

  const lecture = db.prepare(`
    SELECT cl.id, cl.title, cl.scraped_at, cl.wiki_ingested_at,
           c.title as course_title
    FROM course_lectures cl
    LEFT JOIN courses c ON cl.course_id = c.id
    WHERE cl.id = ? AND cl.removed_at IS NULL
  `).get(lectureId);
  if (!lecture) throw new Error(`Lecture ${lectureId} not found or removed`);

  // Skip if already ingested and content hasn't changed.
  if (!force && lecture.wiki_ingested_at && lecture.scraped_at &&
      lecture.wiki_ingested_at >= lecture.scraped_at) {
    return { lectureId, skipped: true, reason: 'already ingested' };
  }

  const chunks = db.prepare(
    'SELECT content FROM course_chunks WHERE lecture_id = ? ORDER BY position'
  ).all(lectureId);
  // Legacy imported transcripts that have been FK-matched to this lecture
  // (via the Phase 5b sidebar rework). Concatenate them after the scraped
  // chunks so they participate in entity extraction — otherwise the wiki
  // would be blind to any pre-scraper content the user has manually linked.
  const linkedTranscripts = db.prepare(
    'SELECT content FROM transcripts WHERE lecture_id = ? ORDER BY transcript_type, filename'
  ).all(lectureId);
  const parts = [
    ...chunks.map(c => c.content),
    ...linkedTranscripts.map(t => t.content),
  ];
  const transcript = parts.join('\n\n').trim();
  if (transcript.length < 200) {
    db.prepare('UPDATE course_lectures SET wiki_ingested_at = ? WHERE id = ?')
      .run(nowIso(), lectureId);
    return { lectureId, skipped: true, reason: 'transcript too short' };
  }

  const settings = loadSettings();
  if (!settings.apiKey) throw new Error('No OpenRouter API key configured');
  if (!settings.selectedModel) throw new Error('No OpenRouter model selected');

  let extracted;
  const llmStartedAt = Date.now();
  try {
    // Cap transcript at ~12k chars to stay safely under most model context limits.
    const capped = transcript.length > 12000
      ? transcript.slice(0, 12000) + '\n\n[transcript truncated for context window]'
      : transcript;
    console.warn(`[wiki] ingest lecture ${lectureId} "${lecture.title}" — calling LLM (${settings.selectedModel}, ${capped.length} chars)`);
    extracted = await callLLM({
      systemPrompt: EXTRACTION_SYSTEM,
      userMessage: EXTRACTION_USER_TEMPLATE(lecture.title, lecture.course_title || '(unknown course)', capped),
      model: settings.selectedModel,
      apiKey: settings.apiKey,
    });
    console.warn(`[wiki] ingest lecture ${lectureId} "${lecture.title}" — LLM returned in ${Math.round((Date.now() - llmStartedAt) / 100) / 10}s`);
  } catch (err) {
    logAction('ingest_failed', {
      lectureId,
      summary: `${lecture.title}: ${err.message}`,
    });
    throw err;
  }

  const entities = Array.isArray(extracted.entities) ? extracted.entities : [];
  const notes = Array.isArray(extracted.notes) ? extracted.notes : [];
  const claims = Array.isArray(extracted.claims) ? extracted.claims : [];

  // Build canonical_name → entity_id map as we upsert entities.
  const entityMap = new Map();
  const tx = db.transaction(() => {
    for (const e of entities) {
      if (!e || !ENTITY_KINDS.includes(e.kind) || !e.canonical_name) continue;
      const { id } = upsertEntity({
        kind: e.kind,
        canonicalName: String(e.canonical_name).trim(),
        aliases: Array.isArray(e.aliases) ? e.aliases.map(a => String(a).trim()).filter(Boolean) : [],
        summary: e.summary ? String(e.summary).trim() : '',
        lectureId,
      });
      entityMap.set(String(e.canonical_name).trim(), id);
    }

    let notesAdded = 0;
    for (const n of notes) {
      if (!n || !n.entity_ref || !n.markdown) continue;
      const entityId = entityMap.get(String(n.entity_ref).trim());
      if (!entityId) continue;
      addNoteForLecture({
        entityId,
        lectureId,
        markdown: String(n.markdown).trim(),
      });
      notesAdded++;
    }

    let claimsAdded = 0;
    for (const c of claims) {
      if (!c || !c.entity_ref || !c.claim_text) continue;
      const entityId = entityMap.get(String(c.entity_ref).trim());
      if (!entityId) continue;
      addClaimForLecture({
        entityId,
        lectureId,
        claimText: String(c.claim_text).trim(),
        quote: c.quote ? String(c.quote).trim() : '',
      });
      claimsAdded++;
    }

    db.prepare('UPDATE course_lectures SET wiki_ingested_at = ? WHERE id = ?')
      .run(nowIso(), lectureId);

    logAction('ingest', {
      lectureId,
      summary: `${lecture.title}: ${entityMap.size} entities, ${notesAdded} notes, ${claimsAdded} claims`,
    });

    return { entitiesProcessed: entityMap.size, notesAdded, claimsAdded };
  });
  const counts = tx();

  return { lectureId, skipped: false, ...counts };
}

// -----------------------------------------------------------------------------
// Public: rebuild wiki for one course — wipe rows tied only to that course's
// lectures, then re-ingest each one. Entities shared with other courses are NOT
// deleted; only notes/claims tied to this course's lectures get cleared.
// -----------------------------------------------------------------------------
export async function rebuildCourse(courseId, onProgress = () => { }) {
  const db = getDb();
  const lectures = db.prepare(`
    SELECT id, title FROM course_lectures
    WHERE course_id = ? AND removed_at IS NULL
    ORDER BY position
  `).all(courseId);
  if (lectures.length === 0) {
    return { courseId, lectureCount: 0, skipped: 0, processed: 0, failed: 0 };
  }

  // Wipe notes/claims that reference any of this course's lectures, then
  // remove entities that have no remaining notes (orphaned).
  const lectureIds = lectures.map(l => l.id);
  const placeholders = lectureIds.map(() => '?').join(',');
  const wiped = db.transaction(() => {
    // wiki_notes uses JSON array; match by single-element string for v1 (notes are per-lecture).
    for (const lid of lectureIds) {
      const lidJson = JSON.stringify([lid]);
      db.prepare('DELETE FROM wiki_notes WHERE source_lecture_ids = ?').run(lidJson);
      // Strip claim support entries pointing at this lecture
      const claims = db.prepare('SELECT id, supports FROM wiki_claims').all();
      for (const c of claims) {
        let supports = [];
        try { supports = JSON.parse(c.supports || '[]'); } catch { /* skip */ }
        const filtered = supports.filter(s => s.lecture_id !== lid);
        if (filtered.length !== supports.length) {
          if (filtered.length === 0) {
            db.prepare('DELETE FROM wiki_claims WHERE id = ?').run(c.id);
          } else {
            db.prepare('UPDATE wiki_claims SET supports = ? WHERE id = ?')
              .run(JSON.stringify(filtered), c.id);
          }
        }
      }
    }
    // Drop entities now orphaned (zero notes)
    const orphanResult = db.prepare(`
      DELETE FROM wiki_entities
      WHERE id NOT IN (SELECT DISTINCT entity_id FROM wiki_notes)
    `).run();
    db.prepare(
      `UPDATE course_lectures SET wiki_ingested_at = NULL WHERE id IN (${placeholders})`
    ).run(...lectureIds);
    return { orphansRemoved: orphanResult.changes };
  })();
  logAction('rebuild_course', {
    summary: `course ${courseId}: cleared ${lectureIds.length} lectures, removed ${wiped.orphansRemoved} orphan entities`,
  });

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < lectures.length; i++) {
    const l = lectures[i];
    onProgress({ type: 'progress', current: i + 1, total: lectures.length, lecture: l.title });
    try {
      const res = await ingestLecture(l.id, { force: true });
      if (res.skipped) skipped++; else processed++;
    } catch (err) {
      failed++;
      onProgress({ type: 'error', lecture: l.title, error: err.message });
    }
  }
  return { courseId, lectureCount: lectures.length, processed, skipped, failed };
}

// -----------------------------------------------------------------------------
// Public: ingest every lecture that needs it (auto-trigger after scrape).
// Background mode: errors logged, never thrown. Returns summary.
// -----------------------------------------------------------------------------
export async function ingestPending(options = {}) {
  const { courseId = null, force = false } = options;
  const db = getDb();
  let query = `
    SELECT cl.id, cl.title, cl.scraped_at, cl.wiki_ingested_at
    FROM course_lectures cl
    WHERE cl.removed_at IS NULL
  `;
  const params = [];
  if (courseId) { query += ' AND cl.course_id = ?'; params.push(courseId); }
  if (!force) {
    query += ` AND (cl.wiki_ingested_at IS NULL OR cl.wiki_ingested_at < cl.scraped_at)`;
  }
  query += ' ORDER BY cl.id';
  const pending = db.prepare(query).all(...params);
  if (pending.length === 0) return { processed: 0, failed: 0, total: 0 };

  let processed = 0;
  let failed = 0;
  for (const l of pending) {
    try {
      await ingestLecture(l.id, { force });
      processed++;
    } catch (err) {
      failed++;
      console.error(`[wiki] ingest failed for lecture ${l.id} (${l.title}):`, err.message);
    }
  }
  return { processed, failed, total: pending.length };
}

// -----------------------------------------------------------------------------
// Public: queries used by the Wiki tab UI.
// -----------------------------------------------------------------------------
export function listEntities({ kind = null } = {}) {
  const db = getDb();
  const where = kind ? 'WHERE we.kind = ?' : '';
  const params = kind ? [kind] : [];
  return db.prepare(`
    SELECT we.id, we.kind, we.canonical_name, we.aliases, we.summary, we.updated_at,
           (SELECT COUNT(*) FROM wiki_notes wn WHERE wn.entity_id = we.id) AS note_count,
           (SELECT COUNT(*) FROM wiki_claims wc WHERE wc.entity_id = we.id) AS claim_count
    FROM wiki_entities we
    ${where}
    ORDER BY we.kind, we.canonical_name
  `).all(...params);
}

export function getEntity(id) {
  const db = getDb();
  const entity = db.prepare('SELECT * FROM wiki_entities WHERE id = ?').get(id);
  if (!entity) return null;
  const notes = db.prepare(`
    SELECT id, markdown, source_lecture_ids, confidence, updated_at
    FROM wiki_notes WHERE entity_id = ? ORDER BY updated_at DESC
  `).all(id);
  const claims = db.prepare(`
    SELECT id, claim_text, supports, contradicts, status
    FROM wiki_claims WHERE entity_id = ? ORDER BY id
  `).all(id);

  // Enrich notes with lecture titles
  const lectureTitleCache = new Map();
  const lectureTitle = (lid) => {
    if (lectureTitleCache.has(lid)) return lectureTitleCache.get(lid);
    const row = db.prepare(
      'SELECT cl.title, cl.course_id, c.title as course_title FROM course_lectures cl LEFT JOIN courses c ON cl.course_id = c.id WHERE cl.id = ?'
    ).get(lid);
    lectureTitleCache.set(lid, row || null);
    return row || null;
  };
  const enrichedNotes = notes.map(n => {
    let lids = [];
    try { lids = JSON.parse(n.source_lecture_ids || '[]'); } catch { /* ignore */ }
    return {
      ...n,
      source_lecture_ids: lids,
      sources: lids.map(lid => ({ id: lid, ...(lectureTitle(lid) || {}) })),
    };
  });
  const enrichedClaims = claims.map(c => {
    let supports = []; let contradicts = [];
    try { supports = JSON.parse(c.supports || '[]'); } catch { /* ignore */ }
    try { contradicts = JSON.parse(c.contradicts || '[]'); } catch { /* ignore */ }
    return {
      ...c,
      supports: supports.map(s => ({ ...s, ...(lectureTitle(s.lecture_id) || {}) })),
      contradicts: contradicts.map(s => ({ ...s, ...(lectureTitle(s.lecture_id) || {}) })),
    };
  });

  let aliases = [];
  try { aliases = JSON.parse(entity.aliases || '[]'); } catch { /* ignore */ }
  return { ...entity, aliases, notes: enrichedNotes, claims: enrichedClaims };
}

// -----------------------------------------------------------------------------
// Public: lint — surface wiki health issues for the UI.
// -----------------------------------------------------------------------------
export function lint() {
  const db = getDb();
  const orphanEntities = db.prepare(`
    SELECT we.id, we.kind, we.canonical_name
    FROM wiki_entities we
    WHERE NOT EXISTS (SELECT 1 FROM wiki_notes wn WHERE wn.entity_id = we.id)
  `).all();
  const contradictedClaims = db.prepare(`
    SELECT wc.id, wc.entity_id, wc.claim_text, we.canonical_name, we.kind
    FROM wiki_claims wc
    JOIN wiki_entities we ON wc.entity_id = we.id
    WHERE wc.contradicts IS NOT NULL AND wc.contradicts != '[]' AND wc.contradicts != ''
  `).all();
  const staleEntities = db.prepare(`
    SELECT we.id, we.kind, we.canonical_name, we.updated_at
    FROM wiki_entities we
    WHERE we.updated_at < datetime('now', '-180 days')
  `).all();
  const lecturesPending = db.prepare(`
    SELECT COUNT(*) AS n FROM course_lectures
    WHERE removed_at IS NULL
      AND (wiki_ingested_at IS NULL OR wiki_ingested_at < scraped_at)
  `).get().n;

  logAction('lint', {
    summary: `${orphanEntities.length} orphans, ${contradictedClaims.length} contradicted, ${staleEntities.length} stale, ${lecturesPending} pending ingest`,
  });

  return { orphanEntities, contradictedClaims, staleEntities, lecturesPending };
}

// -----------------------------------------------------------------------------
// Public: recent log entries for the Wiki tab footer.
// -----------------------------------------------------------------------------
export function recentLog(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT id, ts, action, entity_id, lecture_id, summary
    FROM wiki_log ORDER BY id DESC LIMIT ?
  `).all(limit);
}
