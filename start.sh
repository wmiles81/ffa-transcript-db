#!/bin/bash
# TranscriptDB — Mac/Linux Launcher
# Mac:   double-click in Finder
# Linux: double-click in file manager, or: chmod +x start.sh && ./start.sh

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

sleep 1

# Open browser — Mac, Linux (xdg-open), fallback
URL="http://localhost:3001"
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "$URL"
elif command -v xdg-open &> /dev/null; then
    xdg-open "$URL" &
elif command -v gnome-open &> /dev/null; then
    gnome-open "$URL" &
fi

echo "  Open in browser: $URL"
echo ""
echo "  Close this window to stop TranscriptDB."
echo ""

wait $SERVER_PID
