@echo off
:: ─────────────────────────────────────────────────────────────────
::  MNQ Donchian + Efficiency-Gate Bot — launcher
::  Double-click to run, or from a command prompt: run_donchian_bot.bat
:: ─────────────────────────────────────────────────────────────────

:: Credentials are read from a .env file in this folder, NOT from this script.
:: Create bot\.env containing:
::
::     PROJECT_X_USERNAME=your_username
::     PROJECT_X_API_KEY=your_api_key
::
:: .env is gitignored. Do not paste the key into this .bat — it would be
:: committed to the repo in plaintext.

:: Force UTF-8 so the box-drawing characters and emoji in the log render
chcp 65001 >nul

cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo   No .env found in %CD%
  echo   Create one with PROJECT_X_USERNAME and PROJECT_X_API_KEY, then re-run.
  echo.
  pause
  exit /b 1
)

:: ── Verify the port before trading. Fast, offline, no credentials needed. ──
echo Running parity checks ...
python test_donchian_parity.py
if errorlevel 1 (
  echo.
  echo   PARITY CHECKS FAILED — not starting the bot.
  echo   The strategy no longer matches the engine that measured it.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting bot ...
python mnq_donchian_bot.py

pause
