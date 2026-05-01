#!/bin/bash
# TranscriptDB — Mac Launcher
# Double-click this file in Finder to start the app.

cd "$(dirname "$0")"

echo ""
echo "  TranscriptDB"
echo "  ============"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "  Node.js is not installed."
    echo ""
    echo "  Download it from: https://nodejs.org"
    echo "  Install version 18 or newer, then try again."
    echo ""
    read -p "  Press Enter to close..."
    exit 1
fi

# Install dependencies on first run
if [ ! -d "node_modules" ]; then
    echo "  First run — installing dependencies (one-time, takes ~30 seconds)..."
    echo ""
    npm install --omit=dev
    echo ""
fi

# Start the server
echo "  Starting server..."
node server/server.js &
SERVER_PID=$!

# Give it a moment to start
sleep 1

# Open browser
open "http://localhost:3001"

echo "  Open in browser: http://localhost:3001"
echo ""
echo "  Close this window to stop TranscriptDB."
echo ""

# Keep running until server exits
wait $SERVER_PID
