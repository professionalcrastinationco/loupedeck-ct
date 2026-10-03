# Gracefully stops the daemon (blanks the device and releases COM port).
# Note: the scheduled task's 10-minute safety net will start it again unless
# you also run uninstall-autostart.ps1 or disable the task.
try {
    Invoke-RestMethod -Method Post http://127.0.0.1:20010/api/shutdown -TimeoutSec 3 | Out-Null
    Write-Host 'Loupedeck CT daemon stopped.'
} catch {
    Write-Host 'Daemon was not running.'
}
