@echo off
:: Resolve node.exe — bundled node\ first, then PATH, then standard installs.
set "NODE="

if exist "%~dp0node\node.exe" (
  set "NODE=%~dp0node\node.exe"
  goto :found
)

where node >nul 2>&1 && set "NODE=node" && goto :found

if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE=%ProgramFiles%\nodejs\node.exe"
  goto :found
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
  goto :found
)
if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
  set "NODE=%LOCALAPPDATA%\Programs\node\node.exe"
  goto :found
)

echo.
echo ERROR: Node.js was not found.
echo.
echo Install it from https://nodejs.org  (choose the LTS Windows installer)
echo During setup, leave checked: "Add to PATH"
echo Then CLOSE this window, open a NEW PowerShell, and try again.
echo.
exit /b 1

:found
exit /b 0
