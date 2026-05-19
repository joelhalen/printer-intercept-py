@echo off
title SOTAX Print Capture Proxy

:: Check if Node.js is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found in PATH.
    echo Download it from https://nodejs.org and install, then re-run this script.
    pause
    exit /b 1
)

echo Starting SOTAX Print Capture Proxy...
echo Press Ctrl+C to stop.
echo.

node "%~dp0proxy.js"

pause
