@echo off
if "%FRIDAY_CWD%"=="" set "FRIDAY_CWD=%CD%"
node "%~dp0dist\friday.js" %*
