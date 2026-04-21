@echo off
set HOST=127.0.0.1
set PORT=3210
set PREVIEW_MODE=1
set PREVIEW_ACCESS_PASSWORD=666666
set OFFLINE_WORKER_DISABLED=1
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" src\server.js >> logs\preview-server.log 2>&1
