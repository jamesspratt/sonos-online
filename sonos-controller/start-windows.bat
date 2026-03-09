@echo off
echo ========================================
echo  Sonos Web Controller - Quick Start
echo ========================================
echo.

:: Check for Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js found: 
node --version
echo.

:: Install deps if needed
if not exist "backend\node_modules" (
    echo Installing dependencies...
    cd backend
    npm install
    cd ..
    echo.
)

echo Starting Sonos Controller...
echo Open your browser at: http://localhost:3000
echo.
echo Press Ctrl+C to stop.
echo.

cd backend
node server.js
