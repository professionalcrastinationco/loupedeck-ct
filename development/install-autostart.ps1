# Registers a per-user scheduled task that starts the Loupedeck CT daemon at
# logon (hidden) and re-checks every 10 minutes as a safety net. No admin needed.
$ErrorActionPreference = 'Stop'
$taskName = 'Loupedeck CT'
$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Installed scheduled task '$taskName'. Starting it now..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
try {
    $s = Invoke-RestMethod http://127.0.0.1:20010/api/status -TimeoutSec 3
    Write-Host "Daemon running. Device: $($s.device.state). Config UI: http://127.0.0.1:20010"
} catch {
    Write-Warning "Daemon did not answer yet. Check backend\data\logs\loupedeck.log"
}
