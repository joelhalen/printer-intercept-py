@echo off
cd /d "%~dp0"
call "%~dp0find-portable-node.bat" || exit /b 1

if "%~2"=="" (
  echo Usage: run-compare-portable.bat ^<proxy-ip^> ^<printer-ip^> [port]
  echo Example: run-compare-portable.bat 10.3.25.25 192.168.192.103
  exit /b 1
)

echo Comparing %1 vs %2 ^(portable Node^)...
"%NODE%" "%~dp0compare.js" %*
pause
