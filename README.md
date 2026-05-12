# TranscriptDB

Searchable database for Future Fiction Academy content — full-text search across weekly summit transcripts and Teachable course lectures, with optional AI-powered Q&A via OpenRouter.

## Installation (Electron desktop app)

### macOS (Apple Silicon)
1. Download `FFA Transcript Database-2.1.0-arm64.dmg`
2. Open the `.dmg` and drag the app to `/Applications`
3. First launch: right-click the app in `/Applications` → **Open** (Gatekeeper warning is expected — we're signed but not notarized)
4. Install `ffmpeg`: `brew install ffmpeg`

### Windows (x64)
1. Download `FFA Transcript Database Setup 2.1.0.exe`
2. Double-click — Windows SmartScreen will warn "unknown publisher"
3. Click **More info** → **Run anyway**
4. Install ffmpeg: `choco install ffmpeg` (or [download from ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH)

### Linux (x64)
1. Download `FFA Transcript Database-2.1.0.AppImage`
2. Make executable: `chmod +x "FFA Transcript Database-2.1.0.AppImage"`
3. Run: `./FFA\ Transcript\ Database-2.1.0.AppImage`
4. Install ffmpeg: `sudo apt install ffmpeg` (Debian/Ubuntu) or distro equivalent

### Known limitations
- Notarization not yet done — first-launch warnings on Mac and Windows are expected. macOS only requires right-click → Open once; Windows requires "More info → Run anyway" once.
- ffmpeg must be installed system-wide on each platform until we bundle it (Phase 4c on the roadmap).
- Multi-platform Puppeteer Chromium is bundled; courses can be scraped from any platform.
- Windows build was produced cross-compiled from macOS (electron-builder handles this natively — no Wine required).
- Unsigned Windows binaries: all `.exe` files inside the NSIS installer will show SmartScreen warnings. Future: purchase an Authenticode certificate (~$200/yr) and set `sign:` in `electron-builder.yml`.

## Quick Start

**Prerequisites:** [Node.js](https://nodejs.org/) v18+

### Option A — Double-click launcher (easiest)

| Platform | File |
|---|---|
| Mac | Double-click **`start.command`** in Finder |
| Windows | Double-click **`start.bat`** in Explorer |
| Linux | Double-click **`start.sh`** in your file manager, or `./start.sh` in a terminal |

The launcher checks for Node, installs dependencies on first run, starts the server, and opens `http://localhost:3001` in your browser automatically.

### Option B — Terminal

```bash
npm install
npm start
```

Open **http://localhost:3001** in your browser.

### Development (hot-reload)

```bash
npm run dev
```

Starts the API server on port 3001 and the Vite dev server on port 5173.

## Features

### Full-Text Search
Type anything into the search bar. Results appear automatically, with matched terms highlighted. Uses SQLite FTS5 with a Porter stemmer so "publish" matches "published", "publishing", etc.

### AI Search (Optional)
Toggle **✨ AI** in the search bar to ask natural-language questions. The app retrieves the most relevant transcript chunks and sends them to an AI model via OpenRouter, which streams back a synthesized answer with citations. Press `Enter` to submit; requires an OpenRouter API key and a selected model (configured via the gear icon).

### Browse & Filter
- **Sources dropdown** — select a transcript collection or Teachable course to browse
- **Type chips** — filter by Lesson, Pre Q&A, Post Q&A, or Work Session
- **Sessions list** — click a session (or course section) to narrow the grid

### Teachable Course Scraping
Log in to Teachable once via the sidebar, then click **+** to pick courses to scrape. Each lecture's text is extracted and indexed. Progress is shown lecture-by-lecture.

### Notion URL per Course
Courses can store a linked Notion notes URL. When set, a **View Notes in Notion →** bar appears above the lecture grid. The URL can be set manually via "Edit URL", or detected automatically from lecture content — if a lecture contains a notion.site URL, a "Set as course Notion URL" button appears in the detail view.

### Transcript Detail
Full text of any transcript or course lecture, with:
- Timestamps (`[00:15:30]`) styled for easy scanning
- Speaker names highlighted
- All URLs rendered as clickable links
- Search terms highlighted when arriving from a search result

## Adding Teachable Courses

1. Click **🔐 Log in to Teachable** in the sidebar
2. Sign in with your Teachable credentials (opens a browser window)
3. Click the **+** button next to "Sources"
4. Check the courses you want → **Scrape Selected**

## AI Search Setup

1. Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Click the gear icon **⚙** → paste the key → **Save**
3. Click **↻ Refresh** to load available models → select one
4. Toggle **✨ AI** in the search bar

Alternatively, set the key in a `.env` file for persistence across restarts:

```bash
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY=sk-or-v1-...
```

## Importing Transcript Sources

To import custom JSON transcript files (e.g., summit recordings):

```bash
# Place JSON files in data/ then:
npm run import
```

## Archiving Course Videos Locally

Download every Hotmart-hosted lecture in a course to your media library
(default location: `/Volumes/GMLDAS/Development/Software/General/ffa-transcript-db-media/`).
Override the location by setting `MEDIA_LIBRARY_PATH`.

**Prerequisites:** [`ffmpeg`](https://ffmpeg.org/) — install via `brew install ffmpeg`.

```bash
npm run archive-videos -- <courseId>
```

The CLI is idempotent — already-archived lectures are skipped, so it's safe to re-run after interruption. Use the Sources dropdown in the web UI to find the course ID, or query directly:

```bash
sqlite3 data/transcripts.db "SELECT id, title FROM courses ORDER BY scraped_at DESC LIMIT 10;"
```

(Note: the DB is encrypted; use `data/.dbkey` for sqlite3-with-cipher tools, or query via the Node REPL.)

YouTube and other non-Hotmart hosts are skipped in this version — Phase 3b will add yt-dlp support.

## Project Structure

```
ffa-transcript-db/
├── data/
│   ├── transcripts.db     # SQLite database
│   ├── ai-settings.json   # AI model preferences (auto-created)
│   └── cookies.json       # Teachable session (auto-created, not in git)
├── dist/                  # Built frontend (production)
├── server/
│   ├── db.js              # SQLite/FTS5 database layer + migrations
│   ├── import.js          # Transcript JSON importer
│   ├── scraper.js         # Teachable course scraper (Puppeteer)
│   └── server.js          # Express API server
├── src/
│   ├── index.html         # App shell
│   ├── help.html          # In-app help
│   ├── main.js            # Frontend JavaScript
│   └── style.css          # Styles (four themes)
├── start.command          # Mac double-click launcher
├── start.sh               # Linux launcher
├── start.bat              # Windows double-click launcher
├── .env.example
├── package.json
└── vite.config.js
```

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, better-sqlite3 |
| Scraping | Puppeteer |
| Frontend | Vanilla HTML/CSS/JS, Vite |
| Search | SQLite FTS5 |
| AI | OpenRouter API (optional) |

## License

MIT — see [LICENSE](LICENSE).
