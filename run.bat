
@echo off
title Orme Academy Dashboard
cd /d "%~dp0"

echo ========================================
echo   THE ORME ACADEMY - LIVE DASHBOARD
echo ========================================
echo.

if not exist "server.py" (
    echo ERROR: server.py not found!
    pause
    exit /b 1
)

echo Starting dashboard...
echo.

start "" "http://127.0.0.1:3000"

python server.py

if errorlevel 1 (
    echo.
    echo Server stopped or Python could not start.
    pause
)
