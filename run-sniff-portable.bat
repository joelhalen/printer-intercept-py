@echo off
cd /d "%~dp0"
call "%~dp0find-portable-node.bat" || exit /b 1

if "%~1"=="" (
  echo Usage: run-sniff-portable.bat ^<xerox-ip^> [--job file.ps]
  echo Example: run-sniff-portable.bat 10.3.10.209
  exit /b 1
)

"%NODE%" "%~dp0sniff.js" %*
pause
