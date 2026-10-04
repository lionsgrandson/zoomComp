@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 was not found on PATH.
  echo Install Python 3.11 or newer, then run this file again.
  exit /b 1
)
if not exist .venv (
  python -m venv .venv
  if errorlevel 1 exit /b 1
)
call .venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 exit /b 1
call .venv\Scripts\python.exe -m pip install -r requirements-python.txt
if errorlevel 1 exit /b 1
echo.
echo Local transcription setup is complete.
