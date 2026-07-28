$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$rustc = if (Get-Command rustc -ErrorAction SilentlyContinue) {
    "rustc"
} else {
    Join-Path $cargoBin "rustc.exe"
}
$triple = (& $rustc --print host-tuple).Trim()
if (-not $triple) {
    throw "Could not determine the Rust target triple."
}

$build = Join-Path $root "ui-desktop\.sidecar-build"
$binaries = Join-Path $root "ui-desktop\src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $build, $binaries | Out-Null

Push-Location $root
try {
    uv run --with pyinstaller pyinstaller `
        --noconfirm `
        --clean `
        --onefile `
        --noupx `
        --name "friday-app-server-$triple" `
        --paths (Join-Path $root "src") `
        --collect-data friday `
        --distpath $binaries `
        --workpath (Join-Path $build "work") `
        --specpath $build `
        (Join-Path $root "src\friday\app_server.py")
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
