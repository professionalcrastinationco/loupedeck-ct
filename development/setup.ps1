# One-step install for Loupedeck CT Controller (Windows 10/11).
#   powershell -ExecutionPolicy Bypass -File development\setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$backend = Join-Path $root 'backend'

# 1. Node.js 20+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20 or newer is required: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ required, found $(node --version)" }
Write-Host "Node $(node --version) OK"

# 2. Dependencies
Push-Location $backend
try {
    Write-Host 'Installing dependencies...'
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally { Pop-Location }

# 3. Conflicting software that grabs the device's COM port
$conflicts = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(Loupedeck|LoupedeckService|LogiPluginService)' }
if ($conflicts) {
    Write-Warning "These programs can hold the Loupedeck's port: $($conflicts.ProcessName -join ', ')"
    Write-Warning 'Quit them (and disable them in Task Manager > Startup apps) or the CT will stay "Searching".'
}

# 4. Device present?
$ct = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_2EC2&PID_0003&MI_00' }
if ($ct) { Write-Host "Loupedeck CT found: $($ct.FriendlyName)" } else { Write-Warning 'No Loupedeck CT detected right now. Plug it in; the service will connect when it appears.' }

# 5. Autostart + start
& (Join-Path $PSScriptRoot 'install-autostart.ps1')
Start-Process 'http://127.0.0.1:20010'
