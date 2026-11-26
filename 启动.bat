@echo off
cd /d %~dp0
if not exist node_modules call npm install --no-audit --no-fund
set PORT=8080
node server.js
pause
