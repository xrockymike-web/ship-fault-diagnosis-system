@echo off
rem Double-click to switch the app to CPU mode.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-mode.ps1" -Mode cpu
pause
