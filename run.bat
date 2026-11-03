
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

python server.py --open-browser

if errorlevel 1 (
    echo.
    echo Server stopped or Python could not start.
    pause
)
