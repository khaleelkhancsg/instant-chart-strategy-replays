@echo off
:: ─────────────────────────────────────────────────────────────────
::  MNQ Signal Bot — same strategy, notifications instead of orders
::  Double-click to run, or: run_signal_bot.bat
::  Test your alerts first with:  run_signal_bot.bat --demo
:: ─────────────────────────────────────────────────────────────────

:: Credentials come from bot\.env, NOT from this script:
::
::     PROJECT_X_USERNAME=your_username
::     PROJECT_X_API_KEY=your_api_key
::
:: Optional, for alerts on your phone — the only channel that helps when you
:: are away from the desk, since the ORB gives you about ninety seconds:
::
::     MNQ_NOTIFY_WEBHOOK=https://ntfy.sh/some-private-topic-name
::
:: .env is gitignored. Do not paste secrets into this .bat.

:: Force UTF-8 so the alert boxes and emoji render
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

:: --demo fires one of each alert and exits. No credentials, no connection.
if "%~1"=="--demo" (
  python mnq_signal_bot.py --demo
  pause
  exit /b 0
)

:: ── Same gate as the live bot, plus the checks specific to signal mode. ──
echo Running parity checks ...
python test_donchian_parity.py
if errorlevel 1 goto :failed
python test_orb_parity.py
if errorlevel 1 goto :failed
python test_signal_parity.py
if errorlevel 1 goto :failed

echo.
echo ─────────────────────────────────────────────────────────────
echo  SIGNAL MODE — nothing will be placed for you.
echo  Every order, stop and target is yours to enter by hand.
echo ─────────────────────────────────────────────────────────────
echo.
python mnq_signal_bot.py

pause
exit /b 0

:failed
echo.
echo   PARITY CHECKS FAILED — not starting.
echo   The strategy no longer matches the engine that measured it.
echo.
pause
exit /b 1
