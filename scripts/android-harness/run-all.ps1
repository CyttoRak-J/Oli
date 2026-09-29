# Runs every phone-build check in the PC test window, each on a fresh profile, and prints one line per suite.
# usage (from the repo folder): powershell -File scripts\android-harness\run-all.ps1 [dataRoot]
# Builds the test bundle first (OLI_TEST_HOOKS=1 exposes the player store to the checks; normal builds do not have it).
param([string]$Root = "$env:TEMP\oli-harness-data")
$repo = Resolve-Path "$PSScriptRoot\..\.."
Set-Location $repo
# only the test window's own electron.exe processes (never this script, never a desktop Oli that may be running)
function Stop-Window { Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*android-harness*' -or $_.CommandLine -like "*$Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
Stop-Window
$env:OLI_TEST_HOOKS = '1'; $env:OLI_OUT_DIR = 'out/renderer-android-test'
npx vite build -c vite.android.config.ts 2>&1 | Select-Object -Last 1
$env:OLI_TEST_HOOKS = $null; $env:OLI_OUT_DIR = $null
$suites = @(
  @{ name = 'player (play, seek, pause, unplug, next, skip)'; script = 'e2e.cjs'; songs = '' },
  @{ name = 'phone music scan'; script = 'e2e-library.cjs'; songs = '' },
  @{ name = 'chosen music folders'; script = 'e2e-folders.cjs'; songs = ''; subdirs = '1' },
  @{ name = 'phone fixes (tap, back, Now Playing, badge, resume)'; script = 'e2e-phone.cjs'; songs = ''; subdirs = '' },
  @{ name = 'downloads, tags, backup'; script = 'e2e-downloads.cjs'; songs = '' },
  @{ name = 'YouTube'; script = 'e2e-youtube.cjs'; songs = '' },
  @{ name = 'big list (3,000 songs)'; script = 'e2e-list.cjs'; songs = '3000' }
)
$i = 0
foreach ($s in $suites) {
  $i++
  foreach ($d in @("$env:TEMP\oli-harness-files", "$env:TEMP\oli-harness-cache")) { if (Test-Path $d) { [System.IO.Directory]::Delete($d, $true) } }
  $env:OLI_HARNESS_SONGS = $s.songs
  $env:OLI_HARNESS_SUBDIRS = $s.subdirs
  & powershell -File "$PSScriptRoot\run-window.ps1" "$Root\$i"
  Start-Sleep 10
  $log = "$Root\suite-$i.log"
  $p = Start-Process node -ArgumentList "scripts\android-harness\$($s.script)" -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if (-not $p.WaitForExit(300000)) { $p.Kill(); "TIMEOUT  $($s.name)"; Stop-Window; continue }
  $last = (Get-Content $log | Select-Object -Last 1)
  "{0,-52} {1}" -f $s.name, $last
  Stop-Window
  Start-Sleep 2
}
$env:OLI_HARNESS_SONGS = $null; $env:OLI_HARNESS_SUBDIRS = $null
