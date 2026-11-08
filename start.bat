@echo off
title M3U Player
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
rem Get the latest player and server from GitHub (keeps the current files if offline)
set "SRC=https://raw.githubusercontent.com/carlosCastro99/mplay/main"
for %%f in (index.html server.js) do (
  curl -fsSL "%SRC%/%%f" -o "%%f.new" >nul 2>nul && move /y "%%f.new" "%%f" >nul
  if exist "%%f.new" del "%%f.new"
)
rem Stop any player server that is already running
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":8787 .*LISTENING"') do taskkill /f /pid %%p >nul 2>nul
start "" http://localhost:8787
node server.js
pause
