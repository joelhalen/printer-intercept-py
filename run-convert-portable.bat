@echo off
cd /d "%~dp0"
call "%~dp0find-portable-node.bat" || exit /b 1

if "%~1"=="" (
  echo Usage: run-convert-portable.bat ^<file.ps or captured_jobs folder^>
  echo Example: run-convert-portable.bat captured_jobs
  exit /b 1
)

"%NODE%" "%~dp0convert-ps.js" %*
pause
