@echo off
:: Use Node from prntserv\node\ (Windows .zip extract). No PATH or system install required.
set "NODE=%~dp0node\node.exe"

if not exist "%NODE%" (
  echo.
  echo ERROR: Portable Node.js not found.
  echo.
  echo Expected:  %NODE%
  echo.
  echo Download the Windows Binary ^(.zip^) from https://nodejs.org/en/download
  echo Extract so node.exe is here:  prntserv\node\node.exe
  echo.
  exit /b 1
)

exit /b 0
