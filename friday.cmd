@echo off
setlocal
if "%FRIDAY_CWD%"=="" set "FRIDAY_CWD=%CD%"
uv run --project "%~dp0." friday %*
