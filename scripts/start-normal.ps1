$root = Join-Path $PSScriptRoot ".."
$node = "C:\Program Files\nodejs\node.exe"
$command =
  "$env:HOST='127.0.0.1'; " +
  "$env:PORT='3210'; " +
  "$env:SHARED_MODE='0'; " +
  "$env:PREVIEW_MODE='0'; " +
  "$env:OFFLINE_WORKER_DISABLED='0'; " +
  "Set-Location '$root'; " +
  "& '$node' 'src/server.js' >> 'logs/server.log' 2>&1"

Start-Process -FilePath "powershell.exe" `
  -ArgumentList "-NoLogo", "-NoProfile", "-WindowStyle", "Hidden", "-Command", $command `
  -WorkingDirectory $root `
  -WindowStyle Hidden
