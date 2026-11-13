@echo off
rem Double-click to switch the app to GPU (CUDA) mode.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-mode.ps1" -Mode cuda
pause
