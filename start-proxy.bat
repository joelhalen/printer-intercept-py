@echo off
title SOTAX Print Capture Proxy
cd /d "%~dp0"

call "%~dp0find-node.bat" || ( pause & exit /b 1 )

echo Starting SOTAX Print Capture Proxy...
echo Press Ctrl+C to stop.
echo.

"%NODE%" "%~dp0proxy.js"

pause
