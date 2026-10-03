# Restarts the daemon (e.g. after updating the code).
& (Join-Path $PSScriptRoot 'stop.ps1')
Start-Sleep -Seconds 2
Start-Process wscript.exe -ArgumentList "`"$(Join-Path $PSScriptRoot 'start-hidden.vbs')`""
Start-Sleep -Seconds 3
try {
    $s = Invoke-RestMethod http://127.0.0.1:20010/api/status -TimeoutSec 3
    Write-Host "Daemon running. Device: $($s.device.state)"
} catch { Write-Warning 'Daemon did not answer yet. Check backend\data\logs\loupedeck.log' }
