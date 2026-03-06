/**
 * Import script: JSON → SQLite
 * Reads ffa_transcripts_complete.json and populates the database.
 *
 * Usage: node server/import.js [path-to-json] [source-name]
 *   Defaults: ../ffa_transcripts_complete.json, "FFA Publishing Summit"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDb, closeDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Configuration ---
const DEFAULT_JSON_PATH = path.join(__dirname, '..', '..', 'ffa_transcripts_complete.json');
const DEFAULT_SOURCE_NAME = 'FFA Publishing Summit';
const DEFAULT_SOURCE_DESC = 'Weekly publishing summit transcripts led by Evan, covering business structures, LLC formation, genre research, pen names, AI writing tools (Claude, MCPs), Storm Chaser Method, Series Architect, newsletters, and more. August 2025 – March 2026.';

// --- Date Parsing ---
const MONTH_MAP = {
    'january': '01', 'jan': '01',
    'february': '02', 'feb': '02',
    'march': '03', 'mar': '03',
    'april': '04', 'apr': '04',
    'may': '05',
    'june': '06', 'jun': '06',
    'july': '07', 'jul': '07',
    'august': '08', 'aug': '08',
    'september': '09', 'sep': '09',
    'october': '10', 'oct': '10',
    'november': '11', 'nov': '11',
    'december': '12', 'dec': '12',
};

function parseLectureDate(lecture) {
    // Try "Month Dayth" pattern first: "August 3rd", "December 14"
    const monthDayMatch = lecture.match(
        /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i
    );
    if (monthDayMatch) {
        const month = MONTH_MAP[monthDayMatch[1].toLowerCase()];
        const day = monthDayMatch[2].padStart(2, '0');
        // Infer year: Aug-Dec = 2025, Jan-Mar = 2026
        const monthNum = parseInt(month);
        const year = monthNum >= 8 ? '2025' : '2026';
        return `${year}-${month}-${day}`;
    }

    // Try "YYYY-MM-DD" pattern from filenames
    const isoMatch = lecture.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    // Try "M-DD-YY" or "MM-DD-YY" pattern
    const mddyyMatch = lecture.match(/(\d{1,2})-(\d{1,2})-(\d{2,4})/);
    if (mddyyMatch) {
        let year = mddyyMatch[3];
        if (year.length === 2) year = '20' + year;
        return `${year}-${mddyyMatch[1].padStart(2, '0')}-${mddyyMatch[2].padStart(2, '0')}`;
    }

    return null;
}

function parseDuration(lecture) {
    // Pattern: (MM:SS) or (H:MM:SS)
    const match = lecture.match(/\((\d+):(\d{2})(?::(\d{2}))?\)/);
    if (match) {
        if (match[3]) {
            // H:MM:SS
            return parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 60;
        }
        // MM:SS
        return parseInt(match[1]) + parseInt(match[2]) / 60;
    }
    return null;
}

function classifyTranscriptType(filename, lecture) {
    const lower = filename.toLowerCase();
    if (lower.includes('pre-lesson') || lower.includes('pre lesson') ||
        lower.includes('pre-summit') || lower.includes('pre-session') ||
        lower.includes('pre q&a') || lower.includes('pre lesson q')) {
        return 'Pre-Lesson Q&A';
    }
    if (lower.includes('post-lesson') || lower.includes('post lesson') ||
        lower.includes('post-summit') || lower.includes('post q&a') ||
        lower.includes('post lesson q')) {
        return 'Post-Lesson Q&A';
    }
    if (lower.includes('q&a') || lower.includes('q and a') || lower.includes('questions')) {
        // Generic Q&A — try to disambiguate
        if (lower.includes('pre')) return 'Pre-Lesson Q&A';
        return 'Post-Lesson Q&A';
    }
    if (lower.includes('work session')) {
        return 'Work Session';
    }
    return 'Lesson';
}

// --- Chunking ---
function chunkTranscript(content) {
    // Split on timestamp markers [HH:MM:SS]
    const timestampPattern = /\[(\d{2}:\d{2}:\d{2})\]/g;
    const chunks = [];

    // Find all timestamps and their positions
    const timestamps = [];
    let match;
    while ((match = timestampPattern.exec(content)) !== null) {
        timestamps.push({ time: match[1], index: match.index });
    }

    if (timestamps.length === 0) {
        // No timestamps, chunk by paragraphs (~800 words each)
        const paragraphs = content.split(/\n\n+/);
        let currentChunk = '';
        let chunkIdx = 0;
        for (const para of paragraphs) {
            if (currentChunk && (currentChunk + '\n\n' + para).split(/\s+/).length > 800) {
                chunks.push({
                    chunk_index: chunkIdx++,
                    chunk_text: currentChunk.trim(),
                    start_timestamp: null,
                    end_timestamp: null,
                });
                currentChunk = para;
            } else {
                currentChunk = currentChunk ? currentChunk + '\n\n' + para : para;
            }
        }
        if (currentChunk.trim()) {
            chunks.push({
                chunk_index: chunkIdx,
                chunk_text: currentChunk.trim(),
                start_timestamp: null,
                end_timestamp: null,
            });
        }
        return chunks;
    }

    // Group timestamps into chunks of ~5 minutes (or ~500-800 words)
    let chunkStart = 0;
    let chunkStartTime = timestamps[0]?.time || null;
    let chunkIdx = 0;

    // Aim for chunks roughly every 3-5 timestamp markers
    const TIMESTAMPS_PER_CHUNK = 4;

    for (let i = TIMESTAMPS_PER_CHUNK; i < timestamps.length; i += TIMESTAMPS_PER_CHUNK) {
        const chunkEnd = timestamps[i].index;
        const chunkText = content.slice(chunkStart, chunkEnd).trim();

        if (chunkText.length > 50) {
            chunks.push({
                chunk_index: chunkIdx++,
                chunk_text: chunkText,
                start_timestamp: chunkStartTime,
                end_timestamp: timestamps[i - 1]?.time || null,
            });
        }

        chunkStart = chunkEnd;
        chunkStartTime = timestamps[i].time;
    }

    // Final chunk
    const remaining = content.slice(chunkStart).trim();
    if (remaining.length > 50) {
        chunks.push({
            chunk_index: chunkIdx,
            chunk_text: remaining,
            start_timestamp: chunkStartTime,
            end_timestamp: timestamps[timestamps.length - 1]?.time || null,
        });
    }

    return chunks;
}

// --- Main Import ---
async function main() {
    const jsonPath = process.argv[2] || DEFAULT_JSON_PATH;
    const sourceName = process.argv[3] || DEFAULT_SOURCE_NAME;

    console.log(`\n📚 FFA Transcript Database Import`);
    console.log(`─────────────────────────────────`);
    console.log(`Source file: ${jsonPath}`);
    console.log(`Source name: ${sourceName}\n`);

    // Read JSON
    if (!fs.existsSync(jsonPath)) {
        console.error(`❌ File not found: ${jsonPath}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`📄 Loaded ${data.length} transcripts from JSON\n`);

    // Initialize database
    const db = initializeDb();

    // Create or get source
    const existingSource = db.prepare('SELECT id FROM sources WHERE name = ?').get(sourceName);
    let sourceId;

    if (existingSource) {
        console.log(`⚠️  Source "${sourceName}" already exists (id=${existingSource.id}). Clearing old data...`);
        // Clear old data for re-import
        const oldTranscripts = db.prepare('SELECT id FROM transcripts WHERE source_id = ?').all(existingSource.id);
        const oldIds = oldTranscripts.map(t => t.id);
        if (oldIds.length > 0) {
            db.prepare(`DELETE FROM chunks WHERE transcript_id IN (${oldIds.join(',')})`).run();
        }
        db.prepare('DELETE FROM transcripts WHERE source_id = ?').run(existingSource.id);
        sourceId = existingSource.id;
    } else {
        const result = db.prepare('INSERT INTO sources (name, description) VALUES (?, ?)').run(sourceName, DEFAULT_SOURCE_DESC);
        sourceId = result.lastInsertRowid;
        console.log(`✅ Created source "${sourceName}" (id=${sourceId})`);
    }

    // Prepare statements
    const insertTranscript = db.prepare(`
    INSERT INTO transcripts (source_id, original_id, lecture, filename, content, lecture_date, duration_minutes, transcript_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

    const insertChunk = db.prepare(`
    INSERT INTO chunks (transcript_id, chunk_index, chunk_text, start_timestamp, end_timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

    // Import in a transaction for speed
    let totalChunks = 0;
    const importAll = db.transaction(() => {
        for (const record of data) {
            const lectureDate = parseLectureDate(record.lecture) || parseLectureDate(record.filename);
            const duration = parseDuration(record.lecture);
            const transcriptType = classifyTranscriptType(record.filename, record.lecture);

            const result = insertTranscript.run(
                sourceId,
                record.id,
                record.lecture,
                record.filename,
                record.content,
                lectureDate,
                duration,
                transcriptType
            );

            const transcriptId = result.lastInsertRowid;

            // Chunk the content
            const chunks = chunkTranscript(record.content);
            for (const chunk of chunks) {
                insertChunk.run(
                    transcriptId,
                    chunk.chunk_index,
                    chunk.chunk_text,
                    chunk.start_timestamp,
                    chunk.end_timestamp
                );
                totalChunks++;
            }
        }
    });

    importAll();

    // Rebuild FTS index
    console.log(`\n🔍 Rebuilding full-text search index...`);
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);

    // Print stats
    const transcriptCount = db.prepare('SELECT COUNT(*) as c FROM transcripts WHERE source_id = ?').get(sourceId).c;
    const chunkCount = db.prepare('SELECT COUNT(*) as c FROM chunks c JOIN transcripts t ON c.transcript_id = t.id WHERE t.source_id = ?').get(sourceId).c;
    const totalSources = db.prepare('SELECT COUNT(*) as c FROM sources').get().c;

    console.log(`\n✅ Import complete!`);
    console.log(`─────────────────────────────────`);
    console.log(`   Sources:      ${totalSources}`);
    console.log(`   Transcripts:  ${transcriptCount}`);
    console.log(`   Chunks:       ${chunkCount}`);
    console.log(`   FTS indexed:  ✓`);
    console.log(`─────────────────────────────────\n`);

    // Quick search test
    const testResults = db.prepare(`
    SELECT COUNT(*) as c FROM chunks_fts WHERE chunks_fts MATCH 'LLC'
  `).get();
    console.log(`🔎 Test search for "LLC": ${testResults.c} matching chunks\n`);

    closeDb();
}

main().catch(err => {
    console.error('❌ Import failed:', err);
    process.exit(1);
});
