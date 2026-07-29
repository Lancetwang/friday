$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $desktopRoot "..")).Path
$executable = Join-Path $desktopRoot "src-tauri\target\debug\friday-desktop.exe"
$running = Get-Process -Name "friday-desktop" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $executable } |
    Select-Object -First 1

if ($running) {
    (New-Object -ComObject WScript.Shell).AppActivate($running.Id) | Out-Null
    exit 0
}

$logDirectory = Join-Path $env:USERPROFILE ".friday\logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$log = Join-Path $logDirectory "desktop-dev.log"
$sidecar = Get-ChildItem (Join-Path $desktopRoot "src-tauri\binaries") -Filter "friday-app-server-*.exe" |
    Select-Object -First 1
$sources = @(
    Get-ChildItem (Join-Path $repositoryRoot "src") -Recurse -File -Filter "*.py"
    Get-Item (Join-Path $repositoryRoot "pyproject.toml")
    Get-Item (Join-Path $repositoryRoot "uv.lock")
)
$needsSidecar = -not $sidecar -or $sources.Where({ $_.LastWriteTimeUtc -gt $sidecar.LastWriteTimeUtc }).Count

"Friday development launcher - $(Get-Date -Format s)" | Set-Content $log
Set-Location $desktopRoot
if ($needsSidecar) {
    npm run sidecar *>> $log
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

npx tauri dev *>> $log
