@echo off
setlocal
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo Setting up local transcription for the first run...
  call setup-python.cmd
  if errorlevel 1 exit /b 1
)

.venv\Scripts\python.exe python\companion.py --standalone --mode sales --interval 12
