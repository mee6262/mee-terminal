# Replaces the pm2-logrotate module (saves ~60MB RAM). Run hourly from Task Scheduler.
# Same rules as before: rotate at >= MaxMB, rotate everything non-empty in the 00:xx run, keep Retain files per log.
# Copy + truncate in place, so pm2 keeps writing to the same file handle (no pm2 reloadLogs needed).
param(
    [string]$LogDir = "$env:USERPROFILE\.pm2\logs",
    [int]$MaxMB = 10,
    [int]$Retain = 30,
    [switch]$Force
)
$ErrorActionPreference = "Stop"
$now = Get-Date
$daily = $Force -or $now.Hour -eq 0
$stamp = $now.ToString("yyyy-MM-dd_HH-mm-ss")

# active logs only: rotated copies contain "__"
Get-ChildItem -Path $LogDir -Filter *.log -File | Where-Object { $_.Name -notlike "*__*" } | ForEach-Object {
    $f = $_
    if ($f.Length -eq 0) { return }
    if (-not ($daily -or $f.Length -ge $MaxMB * 1MB)) { return }
    $base = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    $dest = Join-Path $LogDir "${base}__${stamp}.log"
    try {
        $src = [IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'ReadWrite, Delete')
        try {
            $out = [IO.File]::Create($dest)
            try { $src.CopyTo($out) } finally { $out.Close() }
            $src.SetLength(0)
        } finally { $src.Close() }
        Write-Output "rotated $($f.Name) $([int]($f.Length/1KB))KB -> $(Split-Path $dest -Leaf)"
    } catch {
        Write-Output "FAIL $($f.Name): $($_.Exception.Message)"
    }
    Get-ChildItem -Path $LogDir -Filter "${base}__*.log" -File | Sort-Object Name -Descending |
        Select-Object -Skip $Retain | ForEach-Object { Remove-Item $_.FullName -Force; Write-Output "deleted $($_.Name)" }
}
