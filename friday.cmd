@echo off
setlocal enabledelayedexpansion

if "%FRIDAY_CWD%"=="" set "FRIDAY_CWD=%CD%"

:retry
uv sync --project "%~dp0." --no-dev
if errorlevel 1 (
    echo [ERROR] uv sync failed, retrying after cleaning venv...
    timeout /t 2 /nobreak >nul
    if exist "%~dp0.venv" (
        echo Cleaning .venv...
        rmdir /s /q "%~dp0.venv" 2>nul
        timeout /t 1 /nobreak >nul
    )
    uv venv --project "%~dp0." --force
    goto retry
)

uv run --project "%~dp0." friday %*
if errorlevel 1 (
    echo [ERROR] uv run failed, rebuilding venv...
    timeout /t 2 /nobreak >nul
    if exist "%~dp0.venv" (
        rmdir /s /q "%~dp0.venv" 2>nul
        timeout /t 1 /nobreak >nul
    )
    uv venv --project "%~dp0." --force
    uv sync --project "%~dp0." --no-dev
    uv run --project "%~dp0." friday %*
)