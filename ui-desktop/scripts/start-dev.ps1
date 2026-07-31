$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = (Resolve-Path (Join-Path $desktopRoot "..")).Path
$tauriRoot = Join-Path $desktopRoot "src-tauri"
$executable = Join-Path $tauriRoot "target\debug\friday-desktop.exe"
$logDirectory = Join-Path $env:USERPROFILE ".friday\logs"
$log = Join-Path $logDirectory "desktop-dev.log"
$viteOut = Join-Path $logDirectory "desktop-vite.log"
$viteErr = Join-Path $logDirectory "desktop-vite-error.log"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Invoke-Logged([string]$label, [scriptblock]$command) {
    "`n[$label]" | Out-File -FilePath $log -Append -Encoding utf8
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $command 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$label failed with exit code $code. See $log" }
}

$sidecar = Get-ChildItem (Join-Path $tauriRoot "binaries") -Filter "friday-app-server-*.exe" |
    Select-Object -First 1
$pythonSources = @(
    Get-ChildItem (Join-Path $repositoryRoot "src") -Recurse -File -Filter "*.py"
    Get-Item (Join-Path $repositoryRoot "pyproject.toml")
    Get-Item (Join-Path $repositoryRoot "uv.lock")
)
$rustSources = @(
    Get-ChildItem (Join-Path $tauriRoot "src") -Recurse -File
    Get-Item (Join-Path $tauriRoot "Cargo.toml")
    Get-Item (Join-Path $tauriRoot "Cargo.lock")
    Get-Item (Join-Path $tauriRoot "build.rs")
    Get-Item (Join-Path $tauriRoot "tauri.conf.json")
)
$needsSidecar = -not $sidecar
if ($sidecar) {
    $needsSidecar = [bool]$pythonSources.Where({ $_.LastWriteTimeUtc -gt $sidecar.LastWriteTimeUtc }).Count
}
$needsDesktop = -not (Test-Path $executable)
if (-not $needsDesktop) {
    $executableTime = (Get-Item $executable).LastWriteTimeUtc
    $needsDesktop = [bool]$rustSources.Where({ $_.LastWriteTimeUtc -gt $executableTime }).Count
}
$running = Get-Process -Name "friday-desktop" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $executable } |
    Select-Object -First 1

if ($running -and -not $needsSidecar -and -not $needsDesktop) {
    (New-Object -ComObject WScript.Shell).AppActivate($running.Id) | Out-Null
    exit 0
}
if ($running) {
    Stop-Process -Id $running.Id
    $running.WaitForExit(5000) | Out-Null
}

"Friday incremental launcher - $(Get-Date -Format s)" | Set-Content -Encoding utf8 $log
Push-Location $desktopRoot
try {
    $installedLock = Join-Path $desktopRoot "node_modules\.package-lock.json"
    if (-not (Test-Path $installedLock) -or (Get-Item "package-lock.json").LastWriteTimeUtc -gt (Get-Item $installedLock).LastWriteTimeUtc) {
        Invoke-Logged "npm install" { npm install }
    }
    if ($needsSidecar) {
        Invoke-Logged "Python sidecar build" { npm run sidecar }
        $sidecar = Get-ChildItem (Join-Path $tauriRoot "binaries") -Filter "friday-app-server-*.exe" |
            Select-Object -First 1
    }
    if ($needsDesktop) {
        Invoke-Logged "Tauri shell build" { cargo build --manifest-path (Join-Path $tauriRoot "Cargo.toml") }
    }

    $runtimeSidecar = Join-Path (Split-Path $executable) $sidecar.Name
    if (-not (Test-Path $runtimeSidecar) -or (Get-FileHash $runtimeSidecar).Hash -ne (Get-FileHash $sidecar.FullName).Hash) {
        Copy-Item -LiteralPath $sidecar.FullName -Destination $runtimeSidecar -Force
    }

    $vite = $null
    try {
        try {
            Invoke-WebRequest "http://127.0.0.1:1420" -UseBasicParsing -TimeoutSec 1 | Out-Null
        } catch {
            $node = (Get-Command node).Source
            $viteScript = Join-Path $desktopRoot "node_modules\vite\bin\vite.js"
            $vite = Start-Process $node `
                -ArgumentList "`"$viteScript`" --host 127.0.0.1 --port 1420 --strictPort" `
                -WorkingDirectory $desktopRoot `
                -WindowStyle Hidden `
                -RedirectStandardOutput $viteOut `
                -RedirectStandardError $viteErr `
                -PassThru
            $ready = $false
            for ($attempt = 0; $attempt -lt 100; $attempt++) {
                if ($vite.HasExited) { throw "Vite failed to start. See $viteErr" }
                try {
                    Invoke-WebRequest "http://127.0.0.1:1420" -UseBasicParsing -TimeoutSec 1 | Out-Null
                    $ready = $true
                    break
                } catch {
                    Start-Sleep -Milliseconds 50
                }
            }
            if (-not $ready) { throw "Vite did not become ready. See $viteErr" }
        }

        $app = Start-Process $executable -WorkingDirectory $desktopRoot -PassThru
        $app.WaitForExit()
    } finally {
        if ($vite -and -not $vite.HasExited) {
            Stop-Process -Id $vite.Id
        }
    }
} finally {
    Pop-Location
}
