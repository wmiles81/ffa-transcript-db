import Database from 'better-sqlite3-multiple-ciphers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Phase 4a: data/ directory is configurable via DATA_DIR env var so Electron's
// main process can point us at app.getPath('userData')/data while CLI
// invocations default to ./data relative to the project root.
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'transcripts.db');
const KEY_PATH = path.join(DATA_DIR, '.dbkey');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Generate and persist a per-installation encryption key
function getOrCreateKey() {
    if (fs.existsSync(KEY_PATH)) {
        return fs.readFileSync(KEY_PATH, 'utf8').trim();
    }
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
    return key;
}

// Detect an unencrypted SQLite file by its magic header bytes
function isPlainSqlite(dbPath) {
    if (!fs.existsSync(dbPath)) return false;
    const buf = Buffer.alloc(15);
    const fd = fs.openSync(dbPath, 'r');
    fs.readSync(fd, buf, 0, 15, 0);
    fs.closeSync(fd);
    return buf.toString('utf8') === 'SQLite format 3';
}

const DB_KEY = getOrCreateKey();

// One-time migration: encrypt an existing plain database in place
if (isPlainSqlite(DB_PATH)) {
    console.log('[db] Encrypting existing database (first run with encryption)...');
    const tmpPath = DB_PATH + '.encrypting';
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

    const plain = new Database(DB_PATH);
    const enc = new Database(tmpPath);
    enc.pragma(`key = '${DB_KEY}'`);

    const schema = plain.prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid"
    ).all();

    // FTS5 virtual tables auto-generate shadow tables; identify both
    const fts5Names = schema
        .filter(o => /CREATE VIRTUAL TABLE/i.test(o.sql) && /USING fts5/i.test(o.sql))
        .map(o => o.name);
    const isShadow = name => fts5Names.some(f => name.startsWith(f + '_'));

    // Step 1: create and populate all regular (non-virtual, non-shadow) tables
    enc.exec('BEGIN');
    for (const obj of schema) {
        if (obj.type !== 'table') continue;
        if (/CREATE VIRTUAL TABLE/i.test(obj.sql)) continue;
        if (isShadow(obj.name)) continue;
        if (obj.name.startsWith('sqlite_')) continue; // SQLite-managed internal tables
        enc.exec(obj.sql);
        const rows = plain.prepare(`SELECT * FROM "${obj.name}"`).all();
        if (rows.length > 0) {
            const cols = Object.keys(rows[0]);
            const insert = enc.prepare(
                `INSERT INTO "${obj.name}" (${cols.map(c => `"${c}"`).join(',')}) ` +
                `VALUES (${cols.map(() => '?').join(',')})`
            );
            for (const row of rows) insert.run(cols.map(c => row[c]));
        }
    }
    enc.exec('COMMIT');

    // Carry over AUTOINCREMENT counters if present
    try {
        const seqs = plain.prepare('SELECT name, seq FROM sqlite_sequence').all();
        if (seqs.length) {
            enc.exec('BEGIN');
            const ins = enc.prepare('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)');
            for (const s of seqs) ins.run(s.name, s.seq);
            enc.exec('COMMIT');
        }
    } catch (_) { /* sqlite_sequence may not exist */ }

    // Step 2: create FTS5 virtual tables and rebuild their indexes from the copied content
    for (const name of fts5Names) {
        const vtbl = schema.find(o => o.name === name);
        enc.exec(vtbl.sql);
        enc.exec(`INSERT INTO "${name}"("${name}") VALUES('rebuild')`);
    }

    // Step 3: create indexes and triggers
    for (const obj of schema) {
        if (obj.type === 'index' || obj.type === 'trigger') enc.exec(obj.sql);
    }

    enc.close();
    plain.close();
    fs.renameSync(DB_PATH, DB_PATH + '.bak');
    // Remove stale WAL files from the plain database — they don't apply to the encrypted file
    for (const ext of ['-wal', '-shm']) {
        const p = DB_PATH + ext;
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.renameSync(tmpPath, DB_PATH);
    console.log('[db] Done. Original saved as transcripts.db.bak');
}

let _db = null;

export function getDb() {
    if (!_db) {
        _db = new Database(DB_PATH);
        _db.pragma(`key = '${DB_KEY}'`);   // must be first pragma
        _db.pragma('journal_mode = WAL');
        _db.pragma('foreign_keys = ON');
    }
    return _db;
}

export function initializeDb() {
  const db = getDb();

  db.exec(`
    -- ==========================================================================
    -- Original Transcript Tables (from JSON import)
    -- ==========================================================================

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      original_id INTEGER,
      lecture TEXT NOT NULL,
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      lecture_date TEXT,
      duration_minutes REAL,
      transcript_type TEXT,
      FOREIGN KEY (source_id) REFERENCES sources(id)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      start_timestamp TEXT,
      end_timestamp TEXT,
      FOREIGN KEY (transcript_id) REFERENCES transcripts(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_text,
      content='chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
      INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END;

    CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source_id);
    CREATE INDEX IF NOT EXISTS idx_transcripts_lecture ON transcripts(lecture);
    CREATE INDEX IF NOT EXISTS idx_transcripts_type ON transcripts(transcript_type);
    CREATE INDEX IF NOT EXISTS idx_chunks_transcript ON chunks(transcript_id);

    -- ==========================================================================
    -- Teachable Course Tables (from scraper)
    -- ==========================================================================

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teachable_id TEXT UNIQUE,
      title TEXT NOT NULL,
      class_number TEXT,
      url TEXT NOT NULL,
      lecture_count INTEGER DEFAULT 0,
      scraped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS course_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS course_lectures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      section_id INTEGER,
      title TEXT NOT NULL,
      url TEXT,
      duration TEXT,
      position INTEGER DEFAULT 0,
      scraped_at TEXT,
      video_url TEXT,
      video_provider TEXT,
      notion_url TEXT,
      video_local_path TEXT,
      video_duration_sec INTEGER,
      video_downloaded_at TEXT,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES course_sections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS course_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecture_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      FOREIGN KEY (lecture_id) REFERENCES course_lectures(id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS course_chunks_fts USING fts5(
      content,
      content='course_chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS cc_ai AFTER INSERT ON course_chunks BEGIN
      INSERT INTO course_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS cc_ad AFTER DELETE ON course_chunks BEGIN
      INSERT INTO course_chunks_fts(course_chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS cc_au AFTER UPDATE ON course_chunks BEGIN
      INSERT INTO course_chunks_fts(course_chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO course_chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE INDEX IF NOT EXISTS idx_course_lectures_course ON course_lectures(course_id);
    CREATE INDEX IF NOT EXISTS idx_course_chunks_lecture ON course_chunks(lecture_id);

    -- ==========================================================================
    -- LLM Wiki Tables (Karpathy three-layer pattern)
    -- ==========================================================================

    CREATE TABLE IF NOT EXISTS wiki_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('author','technique','tool','debate')),
      canonical_name TEXT NOT NULL,
      aliases TEXT,
      summary TEXT,
      first_seen_lecture_id INTEGER,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, canonical_name)
    );

    CREATE TABLE IF NOT EXISTS wiki_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      markdown TEXT NOT NULL,
      source_lecture_ids TEXT NOT NULL,
      confidence REAL DEFAULT 0.8,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES wiki_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      claim_text TEXT NOT NULL,
      supports TEXT,
      contradicts TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','retired')),
      FOREIGN KEY (entity_id) REFERENCES wiki_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wiki_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_id INTEGER,
      lecture_id INTEGER,
      summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_entities_kind ON wiki_entities(kind);
    CREATE INDEX IF NOT EXISTS idx_wiki_notes_entity ON wiki_notes(entity_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_claims_entity ON wiki_claims(entity_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_log_lecture ON wiki_log(lecture_id);
  `);

  // Migration: add class_number and notion_url to courses if missing
  const courseCols = db.prepare("PRAGMA table_info(courses)").all();
  if (!courseCols.some(c => c.name === 'class_number')) {
    db.exec("ALTER TABLE courses ADD COLUMN class_number TEXT");
  }
  if (!courseCols.some(c => c.name === 'notion_url')) {
    db.exec("ALTER TABLE courses ADD COLUMN notion_url TEXT");
  }

  // Migration: add class_number to course_lectures if missing, then backfill from titles
  const lectureCols = db.prepare("PRAGMA table_info(course_lectures)").all();
  if (!lectureCols.some(c => c.name === 'class_number')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN class_number TEXT");
    const lectures = db.prepare('SELECT id, title FROM course_lectures').all();
    const update = db.prepare('UPDATE course_lectures SET class_number = ? WHERE id = ?');
    for (const { id, title } of lectures) {
      const m = title.match(/^(\d{2,4})[\s\-–]/);
      if (m) update.run(m[1], id);
    }
  }

  // Migration: add video_url, video_provider, notion_url to course_lectures if missing
  if (!lectureCols.some(c => c.name === 'video_url')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN video_url TEXT");
  }
  if (!lectureCols.some(c => c.name === 'video_provider')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN video_provider TEXT");
  }
  if (!lectureCols.some(c => c.name === 'notion_url')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN notion_url TEXT");
  }
  if (!lectureCols.some(c => c.name === 'video_local_path')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN video_local_path TEXT");
  }
  if (!lectureCols.some(c => c.name === 'video_duration_sec')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN video_duration_sec INTEGER");
  }
  if (!lectureCols.some(c => c.name === 'video_downloaded_at')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN video_downloaded_at TEXT");
  }

  // Phase 3.1: Add teachable_lecture_id for idempotent upserts
  if (!lectureCols.some(c => c.name === 'teachable_lecture_id')) {
    db.prepare('ALTER TABLE course_lectures ADD COLUMN teachable_lecture_id TEXT').run();
  }
  if (!lectureCols.some(c => c.name === 'removed_at')) {
    db.prepare('ALTER TABLE course_lectures ADD COLUMN removed_at TEXT').run();
  }

  // Phase 3.1: One-time backfill: extract teachable_lecture_id from URL.
  // URL format: '/courses/<slug>/lectures/<id>' or 'https://.../courses/<slug>/lectures/<id>'
  // Assumes a clean numeric-only suffix (no trailing slash, no query string). The forward
  // scraper (T2) uses a regex /\/lectures\/(\d+)/ that protects new rows; the abort guard
  // below catches any backfilled row that ended up with a non-extractable value.
  db.prepare(`
    UPDATE course_lectures
    SET teachable_lecture_id = substr(url, instr(url, '/lectures/') + length('/lectures/'))
    WHERE teachable_lecture_id IS NULL
      AND url LIKE '%/lectures/%'
  `).run();

  const stillNull = db.prepare(
    'SELECT COUNT(*) AS n FROM course_lectures WHERE teachable_lecture_id IS NULL'
  ).get().n;
  if (stillNull > 0) {
    const samples = db.prepare(
      'SELECT id, course_id, title, url FROM course_lectures WHERE teachable_lecture_id IS NULL LIMIT 5'
    ).all();
    throw new Error(
      `Phase 3.1 migration: ${stillNull} course_lectures rows have NULL teachable_lecture_id after backfill. ` +
      `Sample rows: ${JSON.stringify(samples)}. Fix the URL data or this migration before retrying.`
    );
  }

  // Phase 3.1: Deduplicate before creating unique index — scraper historically produced
  // two rows per lecture URL (position 0 and 1); keep the highest-id (most recent) row.
  const lectureDedupResult = db.prepare(`
    DELETE FROM course_lectures
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM course_lectures
      GROUP BY course_id, teachable_lecture_id
    )
  `).run();
  if (lectureDedupResult.changes > 0) {
    console.warn(`[db] Phase 3.1 migration: removed ${lectureDedupResult.changes} duplicate course_lectures rows (kept MAX(id) per (course_id, teachable_lecture_id))`);
  }

  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lectures_teachable
    ON course_lectures(course_id, teachable_lecture_id)
  `).run();

  // Phase 3.1: Guard against silent cascade-deletion of lecture rows when section
  // dedup deletes a section that lectures still reference. The course_lectures
  // FK is ON DELETE CASCADE, so deleting an under-referenced section silently
  // takes its lectures (and any video_local_path on them) with it. Fail loud
  // and require manual investigation if this scenario is detected.
  const orphanedLectureCount = db.prepare(`
    SELECT COUNT(*) AS n FROM course_lectures
    WHERE section_id IS NOT NULL
      AND section_id NOT IN (SELECT MAX(id) FROM course_sections GROUP BY course_id, title)
  `).get().n;
  if (orphanedLectureCount > 0) {
    const samples = db.prepare(`
      SELECT cl.id, cl.course_id, cl.title, cl.section_id, cl.video_local_path
      FROM course_lectures cl
      WHERE cl.section_id IS NOT NULL
        AND cl.section_id NOT IN (SELECT MAX(id) FROM course_sections GROUP BY course_id, title)
      LIMIT 5
    `).all();
    throw new Error(
      `Phase 3.1 migration: ${orphanedLectureCount} course_lectures rows reference section IDs that would be cascade-deleted by section dedup. ` +
      `Manual investigation required — these lectures may have video archives that would be silently lost. ` +
      `Sample rows: ${JSON.stringify(samples)}.`
    );
  }

  // Phase 3.1: Deduplicate course_sections before creating unique index.
  const sectionDedupResult = db.prepare(`
    DELETE FROM course_sections
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM course_sections
      GROUP BY course_id, title
    )
  `).run();
  if (sectionDedupResult.changes > 0) {
    console.warn(`[db] Phase 3.1 migration: removed ${sectionDedupResult.changes} duplicate course_sections rows (kept MAX(id) per (course_id, title))`);
  }

  db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_course_title
    ON course_sections(course_id, title)
  `).run();

  // Phase 5 (LLM Wiki): track when each lecture was last ingested into the wiki layer.
  // Compared against scraped_at to decide whether re-ingest is needed.
  if (!lectureCols.some(c => c.name === 'wiki_ingested_at')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN wiki_ingested_at TEXT");
  }

  // Phase 4d follow-up: support multiple videos per lecture (e.g., Hotmart playlists with N embeds)
  // Re-read lectureCols after all prior migrations so we see the latest schema.
  const lectureColsLatest = db.prepare("PRAGMA table_info(course_lectures)").all();
  if (!lectureColsLatest.some(c => c.name === 'video_local_paths')) {
    db.prepare('ALTER TABLE course_lectures ADD COLUMN video_local_paths TEXT').run();
    // Backfill: existing single-video rows get a JSON array with their single path
    db.prepare(`
      UPDATE course_lectures
      SET video_local_paths = json_array(video_local_path)
      WHERE video_local_path IS NOT NULL
        AND video_local_paths IS NULL
    `).run();
    const backfilled = db.prepare(`SELECT COUNT(*) AS n FROM course_lectures WHERE video_local_paths IS NOT NULL`).get().n;
    if (backfilled > 0) {
      console.warn(`[db] Phase 4d migration: backfilled video_local_paths on ${backfilled} rows`);
    }
  }

  // Multi-video transcript support: tag each course_chunks row with the index
  // of the video it belongs to (0-based, matches the position in
  // course_lectures.video_local_paths). NULL means "no specific video" — used
  // for single-video lectures (current behavior) and for any chunk that
  // didn't sit under a particular video iframe in DOM order.
  const chunkCols = db.prepare("PRAGMA table_info(course_chunks)").all();
  if (!chunkCols.some(c => c.name === 'video_index')) {
    db.exec("ALTER TABLE course_chunks ADD COLUMN video_index INTEGER");
  }

  // Per-video embed IDs from the lecture page (e.g., Hotmart's "4qXBW07EZv"
  // from .../embed/4qXBW07EZv). JSON array, indexed alongside
  // video_local_paths. Lets the archiver match a captured manifest URL to a
  // specific iframe so downloaded files land in the same order the user sees
  // on the page.
  if (!lectureColsLatest.some(c => c.name === 'video_embed_ids')) {
    db.exec("ALTER TABLE course_lectures ADD COLUMN video_embed_ids TEXT");
  }

  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
