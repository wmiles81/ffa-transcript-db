# TranscriptDB

Searchable database for Teachable course content — full-text search across lectures, transcripts, and AI-powered semantic Q&A via OpenRouter.

## What's Included

This package ships with **3 scraped courses** (92 lectures, 664 searchable chunks) already in the database. You can add more courses from your Teachable school by logging in through the app.

## Quick Start

**Prerequisites:** [Node.js](https://nodejs.org/) v18+ must be installed.

```bash
# 1. Install dependencies
npm install

# 2. Start the app
npm start
```

Open **http://localhost:3001** in your browser. That's it.

## Adding Teachable Courses

1. Click **🔐 Log in to Teachable** in the sidebar
2. Sign in with your Teachable admin credentials (opens a browser window)
3. Once logged in, click the **+** button next to "Sources"
4. Check the courses you want to add → **Scrape Selected**
5. Each course's lectures will be downloaded and indexed for search

## AI Search (Optional)

For AI-powered semantic search using OpenRouter:

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Add your [OpenRouter API key](https://openrouter.ai/keys):
   ```
   OPENROUTER_API_KEY=sk-or-v1-your-key-here
   ```
3. Restart the server
4. Click **⚙** → **↻ Refresh** models → select one
5. Click the **✨ AI** toggle in the search bar

> You can also enter the key via the settings UI. The `.env` file just makes it persistent across restarts.

## Importing Transcript Sources

To add custom transcript sources (e.g., summit recordings, workshops):

1. Place your JSON transcript file(s) in the `data/` folder
2. Run `npm run import`

## Development

For hot-reloading during development:

```bash
npm run dev
```

This starts the API server on port 3001 and Vite dev server on port 5173.

## Project Structure

```
ffa-transcript-db/
├── data/
│   ├── transcripts.db   # SQLite database (included)
│   └── ai-settings.json # AI model preferences
├── dist/                # Built frontend (production)
├── server/
│   ├── db.js            # SQLite/FTS5 database layer
│   ├── import.js        # Transcript JSON importer
│   ├── scraper.js       # Teachable course scraper
│   └── server.js        # Express API server
├── src/
│   ├── index.html       # App HTML
│   ├── main.js          # Frontend JavaScript
│   └── style.css        # Styles
├── .env.example         # Environment variable template
├── package.json
└── vite.config.js
```

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, Puppeteer
- **Frontend:** Vanilla HTML/CSS/JS, Vite
- **Search:** SQLite FTS5 full-text search
- **AI:** OpenRouter API (optional)
