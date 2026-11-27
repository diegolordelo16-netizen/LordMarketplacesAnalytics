@echo off
setlocal enableextensions
"%~dp0node.exe" "%~dp0start-panel.mjs" "%~1"
exit /b %ERRORLEVEL%
