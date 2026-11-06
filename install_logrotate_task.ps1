# One-time setup: register hourly Task Scheduler job for pm2_logrotate.ps1, then remove the pm2-logrotate module.
# Run in an Administrator PowerShell. Undo: Unregister-ScheduledTask pm2-logrotate; pm2 install pm2-logrotate
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "pm2_logrotate.ps1"
$a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddDays(1) -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "pm2-logrotate" -Action $a -Trigger $t -Settings $s -User "SYSTEM" -RunLevel Highest -Force | Out-Null

Start-ScheduledTask -TaskName "pm2-logrotate"
Start-Sleep 8
$info = Get-ScheduledTaskInfo -TaskName "pm2-logrotate"
"task result=$($info.LastTaskResult) next=$($info.NextRunTime)"
if ($info.LastTaskResult -ne 0) { throw "task test run failed; pm2-logrotate module kept" }

pm2 uninstall pm2-logrotate
pm2 save
"done"
