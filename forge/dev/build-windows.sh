#!/bin/bash
# Build Forge Dev Windows exe from WSL
# Usage: ./build-windows.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WIN_SRC="C:\\Users\\Admin\\forge-dev-src"
WIN_SRC_UNC="\\\\wsl.localhost\\Ubuntu-24.04${SCRIPT_DIR}"

echo "==> Killing running forge-dev.exe if any..."
/mnt/c/Windows/System32/cmd.exe /c "taskkill /F /IM forge-dev.exe" 2>&1 || true

echo "==> Syncing source to Windows (excluding node_modules, target, .git)..."
cd /tmp
/mnt/c/Windows/System32/cmd.exe /c \
  "robocopy ${WIN_SRC_UNC} ${WIN_SRC} /E /XD node_modules target .git /NFL /NDL /PURGE" \
  || true  # robocopy returns non-zero on copy

echo "==> Installing npm dependencies on Windows..."
/mnt/c/Windows/System32/cmd.exe /c \
  "cd /d ${WIN_SRC} && npm install" 2>&1

echo "==> Invalidating Rust build cache..."
/mnt/c/Windows/System32/cmd.exe /c \
  "del /q ${WIN_SRC}\\src-tauri\\target\\release\\forge-dev.exe 2>nul & copy /b ${WIN_SRC}\\src-tauri\\build.rs+,, ${WIN_SRC}\\src-tauri\\build.rs >nul" 2>&1 || true

echo "==> Building Tauri Windows exe..."
/mnt/c/Windows/System32/cmd.exe /c \
  "set LIB=C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools\\VC\\Tools\\MSVC\\14.29.30037\\lib\\x64;%LIB% && cd /d ${WIN_SRC} && npx tauri build" 2>&1

echo ""
echo "==> Done! Binary at: ${WIN_SRC}\\src-tauri\\target\\release\\forge-dev.exe"
