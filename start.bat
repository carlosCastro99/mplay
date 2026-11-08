@echo off
title M3U Player
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
rem Stop any player server that is already running
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:8787 .*LISTENING"') do taskkill /f /pid %%p >nul 2>nul
start "" http://localhost:8787
node server.js
pause
