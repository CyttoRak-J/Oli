# Starts the test window on a fresh user-data folder. usage: powershell -File run-window.ps1 <userDataDir> [deny]
param([string]$Data, [string]$Deny = '')
$repo = Resolve-Path "$PSScriptRoot\..\.."
if (Test-Path $Data) { Remove-Item -Recurse -Force $Data }
New-Item -ItemType Directory -Force $Data | Out-Null
if ($Deny -eq 'deny') { $env:OLI_HARNESS_DENY = '1' } else { Remove-Item Env:OLI_HARNESS_DENY -ErrorAction SilentlyContinue }
Start-Process -FilePath "$repo\node_modules\electron\dist\electron.exe" -ArgumentList "`"$PSScriptRoot\main.cjs`"", "`"$repo\out\renderer-android-test`"", "`"$Data`"", "9333"
