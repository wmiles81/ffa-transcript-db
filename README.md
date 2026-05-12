# TranscriptDB

Searchable database for Future Fiction Academy content — full-text search across weekly summit transcripts and Teachable course lectures, with optional AI-powered Q&A via OpenRouter. Ships as a one-click desktop app for Mac, Windows, and Linux.

## Installation (Electron desktop app)

### macOS (Apple Silicon)
1. Download `FFA Transcript Database-2.1.0-arm64.dmg`
2. Open the `.dmg` and drag the app to `/Applications`
3. First launch: right-click the app in `/Applications` → **Open** (Gatekeeper warning expected — signed but not yet notarized)
4. Install `ffmpeg`: `brew install ffmpeg`

### Windows (x64)
1. Download `FFA Transcript Database Setup 2.1.0.exe`
2. Double-click — SmartScreen warns "unknown publisher"
3. Click **More info** → **Run anyway**
4. Install ffmpeg: `choco install ffmpeg` (or [download from ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH)

### Linux (x64)
1. Download `FFA Transcript Database-2.1.0.AppImage`
2. Make executable: `chmod +x "FFA Transcript Database-2.1.0.AppImage"`
3. Run: `./FFA\ Transcript\ Database-2.1.0.AppImage`
4. Install ffmpeg: `sudo apt install ffmpeg` (Debian/Ubuntu) or distro equivalent

### Known limitations
- Notarization not yet done — first-launch Gatekeeper (Mac) and SmartScreen (Windows) warnings are expected and require a one-time click-through.
- ffmpeg must be installed system-wide on each platform until we bundle it.
- Windows build cross-compiled from macOS via electron-builder; no Wine required.

---

## Quick Start

1. **Launch the app.** On first run, a splash modal asks you to confirm (or change) your **Media Library Path** — the folder where archived videos will be stored. This can grow large; pick a drive with room to spare. Click **Confirm** to continue.
2. **Watch for the ffmpeg banner.** If ffmpeg isn't on PATH, an orange banner appears at the top with install instructions. Video archiving won't work until ffmpeg is installed.
3. **Add a Teachable course.** Click the **🔐 Log in to Teachable** button in the sidebar, sign in, then click **+** → select courses → **Scrape Selected**. Progress is shown lecture by lecture.
4. **Browse the tree.** Courses appear in the left sidebar grouped by tag prefix (CUT / INK / LAN / LED / MID / Other). Expand a group → expand a course → drill down to a section, class, or individual lecture. Non-course sources (Summit transcripts) appear under a **Show transcripts ▾** toggle at the bottom of the tree.
5. **Search.** Type in the search bar — results appear instantly. Toggle **✨ AI** and press `Enter` for a synthesized AI answer with citations.
6. **Archive videos.** Open a course in the tree, then click **Archive Videos** in the course detail header. A progress modal shows the download for each lecture. All Hotmart-hosted videos per lecture are fetched (not just the first).
7. **Watch with click-to-seek.** After archiving, open any lecture detail. The inline video player appears above the transcript. Click any `[HH:MM:SS]` timestamp in the transcript to jump the player to that moment and start playback.

---

## Features

### Full-Text Search
Type anything into the search bar. Results appear automatically, with matched terms highlighted. Uses SQLite FTS5 with a Porter stemmer — "publish" matches "published", "publishing", etc.

### AI Search (Optional)
Toggle **✨ AI** in the search bar to ask natural-language questions. The app retrieves the most relevant transcript chunks and sends them to an AI model via OpenRouter, which streams back a synthesized answer with citations. Press `Enter` to submit; requires an OpenRouter API key and a selected model.

### File-Explorer Sidebar
Courses and transcript sources are organized in a collapsible tree, not flat dropdowns:
- **Tag groups** — courses are grouped by prefix: CUT / INK / LAN / LED / MID / Other
- **Hierarchy** — expand a course to see its sections, class groups, and individual lectures
- **Click any node** to filter the main view — group → course → section → class → lecture (opens detail)
- **Show transcripts ▾** toggle reveals non-course sources (Summit transcripts, etc.)
- **Resizable** — drag the seam between sidebar and content to widen or narrow it; persists across sessions

### Inline Video Player
When a lecture has been archived, an inline player appears above the transcript on the detail view:
- **Click-to-seek timestamps** — every `[HH:MM:SS]` marker in the transcript is a clickable link that seeks the player and starts playback
- **Multi-video tabs** — lectures with multiple Hotmart embeds (e.g., FFA Software Support Class Episodes) show "Video 1 / Video 2 / ..." tabs above the player
- **Playback speed** — choose 0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, or 2×; persists across lectures
- **Resizable player** — drag the bottom-right corner to make the player taller; height persists

### Multi-Video Archive
The **Archive Videos** button on a course detail page downloads all Hotmart-hosted videos for every lecture in the course — not just the first one. Already-archived lectures are skipped on re-runs.

### Teachable Course Scraping
Log in to Teachable once via the sidebar, then click **+** to pick courses to scrape. Each lecture's text is extracted and indexed. Progress is shown lecture by lecture. A **Force Refresh** checkbox re-fetches transcript text for known lectures even if they've already been scraped.

### Notion URL per Course
Courses can store a linked Notion notes URL. When set, a **View Notes in Notion →** bar appears above the lecture grid. Set it via "Edit URL" in the notes bar, or from inside a lecture if a `notion.site` URL is detected in the text.

### Transcript Detail
Full text of any transcript or course lecture, with:
- Timestamps (`[HH:MM:SS]`) styled as clickable amber links (seek player) when video is archived, or styled for easy scanning when it isn't
- Speaker names highlighted
- All URLs rendered as clickable links
- Search terms highlighted when arriving from a search result

---

## Where Data Lives

### App data (database, settings, cookies)

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/ffa-transcript-db/` |
| Windows | `%APPDATA%\ffa-transcript-db\` |
| Linux | `~/.config/ffa-transcript-db/` |

The SQLite database, AI settings, and Teachable session cookies all live inside this directory. It is created automatically on first launch.

### Media library (archived videos)

The media library is a separate folder you choose on first run (or later via Settings → Media Library Path). It can be on an external drive. Default path is shown in the first-run splash. The folder can be changed at any time in Settings without affecting the database.

---

## Adding Teachable Courses

1. Click **🔐 Log in to Teachable** in the sidebar
2. Sign in with your Teachable credentials (opens a Puppeteer browser window)
3. Click the **+** button next to the tree header
4. Courses are grouped by tag prefix — check the ones you want → **Scrape Selected**
5. Optionally check **Force Refresh** to re-scrape already-indexed lectures

---

## AI Search Setup

1. Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Click the gear icon **⚙** → paste the key → **Save**
3. Click **↻ Refresh** to load available models → select one
4. Toggle **✨ AI** in the search bar

For persistence across app restarts in dev mode, you can also set the key in a `.env` file:

```bash
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY=sk-or-v1-...
```

---

## Importing Transcript Sources

To import custom JSON transcript files (e.g., summit recordings):

```bash
# Place JSON files in data/ then:
npm run import
```

---

## Archiving Course Videos Locally

### Primary: in-app button (recommended)

Open a course in the sidebar tree, then click **Archive Videos** in the course detail header. An SSE-driven progress modal shows each lecture being processed. You can cancel mid-run. Lectures already fully archived are skipped automatically.

**Requirement:** `ffmpeg` must be on your system PATH. Install via `brew install ffmpeg` (Mac), `choco install ffmpeg` (Windows), or `sudo apt install ffmpeg` (Linux). The app shows a banner at startup if ffmpeg is missing.

### Fallback: CLI (power-user / headless)

```bash
npm run archive-videos -- <courseId>
```

Find the course ID in the sidebar tree or query the database directly.

### Notes
- All Hotmart-hosted videos per lecture are downloaded — multi-video lectures produce `video.mp4`, `video_2.mp4`, etc.
- YouTube and other non-Hotmart hosts are skipped in this version.
- The CLI and in-app button both use idempotent logic — safe to re-run after interruption.

---

## Development (CLI / dev mode)

If you want to run without the Electron wrapper:

```bash
npm install
npm start          # API server on :3001, open http://localhost:3001
npm run dev        # API server on :3001 + Vite dev server on :5173 (hot reload)
```

The `DATA_DIR` environment variable overrides where the database and settings are stored.

---

## Project Structure

```
ffa-transcript-db/
├── data/                      # Created at runtime (gitignored)
│   ├── transcripts.db         # SQLite database
│   ├── ai-settings.json       # AI model preferences
│   └── cookies.json           # Teachable session (not in git)
├── dist/                      # Built frontend (production)
├── electron/
│   └── main.js                # Electron main process
├── server/
│   ├── db.js                  # SQLite/FTS5 layer + migrations
│   ├── import.js              # Transcript JSON importer
│   ├── scraper.js             # Teachable scraper (Puppeteer)
│   └── server.js              # Express API server
├── src/
│   ├── index.html             # App shell
│   ├── help.html              # In-app help (? button)
│   ├── main.js                # Frontend JavaScript
│   └── style.css              # Styles (four themes)
├── .env.example
├── package.json
└── vite.config.js
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop wrapper | Electron |
| Backend | Node.js, Express, better-sqlite3 |
| Scraping | Puppeteer |
| Video download | ffmpeg, Puppeteer (Hotmart token extraction) |
| Frontend | Vanilla HTML/CSS/JS, Vite |
| Search | SQLite FTS5 |
| AI | OpenRouter API (optional) |

---

## License

MIT — see [LICENSE](LICENSE).
