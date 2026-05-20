@echo off
title SOTAX Print Capture Proxy (portable)
cd /d "%~dp0"

call "%~dp0find-portable-node.bat" || ( pause & exit /b 1 )

echo ========================================
echo  SOTAX Print Capture Proxy  [portable]
echo ========================================
echo.
echo Node:   %NODE%
"%NODE%" -v
echo.
echo Folder: %~dp0
echo Config: %~dp0config.json
echo.
echo Starting proxy...  Press Ctrl+C to stop.
echo.
echo Tips for testing on this PC:
echo   - Edit config.json ^(printerHost, listenPort^)
echo   - Point the ST-50 at this PC's IP on the listen port
echo   - If connections fail, allow node.exe through Windows Firewall
echo.

"%NODE%" "%~dp0proxy.js"

pause
