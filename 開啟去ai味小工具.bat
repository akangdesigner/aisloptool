@echo off
rem Keep this file ASCII-only. cmd.exe mis-decodes non-ASCII bytes in .bat
rem before chcp takes effect, which breaks paths and messages.
rem All Chinese output is printed by _server.mjs instead.
chcp 65001 >nul
title AI Style Checker - local server
setlocal

rem Locate the tool folder without hard-coding its (non-ASCII) name:
rem look for _server.mjs here first, then in sibling folders.
set "APP="
if exist "%~dp0_server.mjs" set "APP=%~dp0"
if not defined APP (
  for /d %%D in ("%~dp0*") do (
    if exist "%%~fD\_server.mjs" set "APP=%%~fD"
  )
)

if not defined APP (
  echo.
  echo   Tool folder not found.
  echo   Put this .bat next to the tool folder, or inside it.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Install it once from https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

cd /d "%APP%"
node "_server.mjs"

echo.
echo   Server stopped.
pause
