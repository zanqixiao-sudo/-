@echo off
set HOST=0.0.0.0
set PORT=3210
set SHARED_MODE=0
set PREVIEW_MODE=0
set OFFLINE_WORKER_DISABLED=0
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" src\server.js >> logs\server.log 2>&1
