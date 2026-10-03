# Removes the scheduled task and stops the daemon.
$taskName = 'Loupedeck CT'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
}
& (Join-Path $PSScriptRoot 'stop.ps1')
