@echo off
cd /d "%~dp0"
call "%~dp0find-portable-node.bat" || exit /b 1

if "%~1"=="" (
  echo Usage: run-diagnose-portable.bat ^<host^> [port]
  echo Example: run-diagnose-portable.bat 10.3.25.25
  exit /b 1
)

echo Running diagnose against %1 ^(portable Node^)...
"%NODE%" "%~dp0diagnose.js" %*
pause
