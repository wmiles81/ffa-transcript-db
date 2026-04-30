import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'transcripts.db');

let _db = null;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
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

  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
