# Forge Dev - Windows Build Script
# Run this from PowerShell on the Windows side
#
# Prerequisites:
#   1. Install Rust: https://rustup.rs (download rustup-init.exe)
#   2. Install Node.js: https://nodejs.org (LTS version)
#   3. Install Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/
#      - Select "Desktop development with C++" workload
#   4. Install WebView2: https://developer.microsoft.com/en-us/microsoft-edge/webview2/
#      (usually pre-installed on Windows 10/11)
#
# Usage:
#   cd \\wsl$\Ubuntu\home\dmin\ai-project\jarvis-agents\forge\dev
#   .\build-windows.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== Forge Dev - Windows Build ===" -ForegroundColor Cyan

# Check prerequisites
Write-Host "`nChecking prerequisites..." -ForegroundColor Yellow

$missing = @()

if (-not (Get-Command "rustc" -ErrorAction SilentlyContinue)) {
    $missing += "Rust (install from https://rustup.rs)"
}
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    $missing += "Node.js (install from https://nodejs.org)"
}
if (-not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
    $missing += "npm (comes with Node.js)"
}

if ($missing.Count -gt 0) {
    Write-Host "`nMissing prerequisites:" -ForegroundColor Red
    foreach ($m in $missing) {
        Write-Host "  - $m" -ForegroundColor Red
    }
    Write-Host "`nInstall the above and re-run this script." -ForegroundColor Red
    exit 1
}

Write-Host "  rustc: $(rustc --version)" -ForegroundColor Green
Write-Host "  node:  $(node --version)" -ForegroundColor Green
Write-Host "  npm:   $(npm --version)" -ForegroundColor Green

# Install dependencies
Write-Host "`nInstalling npm dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }

# Build
Write-Host "`nBuilding Tauri app..." -ForegroundColor Yellow
npx tauri build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; exit 1 }

# Show output
Write-Host "`n=== Build Complete ===" -ForegroundColor Green
$exe = "src-tauri\target\release\forge-dev.exe"
$msi = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
$nsis = Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

if (Test-Path $exe) {
    $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "  Executable: $exe ($size MB)" -ForegroundColor Cyan
}
if ($msi) {
    $size = [math]::Round($msi.Length / 1MB, 1)
    Write-Host "  MSI Installer: $($msi.FullName) ($size MB)" -ForegroundColor Cyan
}
if ($nsis) {
    $size = [math]::Round($nsis.Length / 1MB, 1)
    Write-Host "  NSIS Installer: $($nsis.FullName) ($size MB)" -ForegroundColor Cyan
}

Write-Host "`nTo run: .\$exe" -ForegroundColor Yellow
