@echo off
cd /d "%~dp0"
call "%~dp0find-node.bat" || exit /b 1

if "%~1"=="" (
  echo Usage: run-diagnose.bat ^<host^> [port]
  echo Example: run-diagnose.bat 10.3.25.25
  exit /b 1
)

echo Running diagnose against %1 ...
"%NODE%" "%~dp0diagnose.js" %*
pause
