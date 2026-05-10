import Database from 'better-sqlite3-multiple-ciphers';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
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

  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
