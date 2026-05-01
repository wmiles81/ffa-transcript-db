@echo off
title TranscriptDB
cd /d "%~dp0"

echo.
echo   TranscriptDB
echo   ============
echo.

REM Check for Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo   Node.js is not installed.
    echo.
    echo   Download it from: https://nodejs.org
    echo   Install version 18 or newer, then run this file again.
    echo.
    pause
    exit /b 1
)

REM Install dependencies on first run
if not exist "node_modules\" (
    echo   First run -- installing dependencies ^(one-time, takes ~30 seconds^)...
    echo.
    npm install --omit=dev
    echo.
)

REM Start the server in a background window
echo   Starting server...
echo.
start "TranscriptDB Server" /min node server/server.js

REM Brief pause for server startup
timeout /t 2 /nobreak >nul

REM Open browser
start "" "http://localhost:3001"

echo   TranscriptDB is running at http://localhost:3001
echo.
echo   To stop the server: open Task Manager, find
echo   "TranscriptDB Server", and end that process.
echo.
pause
