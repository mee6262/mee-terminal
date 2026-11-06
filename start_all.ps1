# Start everything the VPS needs after a reboot. Runs at Administrator logon (Startup folder: start_all.cmd).
# Idempotent: skips whatever is already running. -DryRun prints what it would start.
param([switch]$DryRun)
$ErrorActionPreference = "Continue"
$log = Join-Path $PSScriptRoot "logs\start_all.log"
function Say($m) { $s = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $s; if (-not $DryRun) { Add-Content -Path $log -Value $s -Encoding utf8 } }
function Run($what, [scriptblock]$do) { if ($DryRun) { Say "WOULD START $what" } else { Say "start $what"; & $do } }

# 1) MT5 main terminal (cent account) — before pm2 so the worker attaches instead of launching it
$mt5 = "C:\Program Files\MetaTrader 5\terminal64.exe"
if (Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $mt5 }) { Say "ok MT5 running" }
else { Run "MT5" { Start-Process -FilePath $mt5; Start-Sleep -Seconds 30 } }

# 2) Caddy (HTTPS reverse proxy). Normally the Windows service "caddy" if installed.
$caddySvc = Get-Service caddy -ErrorAction SilentlyContinue
if ($caddySvc) { if ($caddySvc.Status -eq "Running") { Say "ok Caddy service running" } else { Run "Caddy service" { Start-Service caddy } } }
elseif (Get-Process caddy -ErrorAction SilentlyContinue) { Say "ok Caddy running" }
else { Run "Caddy" { Start-Process -FilePath "C:\Caddy\caddy.exe" -ArgumentList "run" -WorkingDirectory "C:\Caddy" -WindowStyle Minimized } }

# 3) pm2 apps (web-terminal, wt-worker-cent, wt-flow, wt-alerts) from the saved dump
$pm2 = "$env:APPDATA\npm\pm2.cmd"
$daemon = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*pm2*Daemon.js*" }
if ($daemon) { Say "ok pm2 daemon running" }
else { Run "pm2 resurrect" { & $pm2 resurrect | Out-Null } }
