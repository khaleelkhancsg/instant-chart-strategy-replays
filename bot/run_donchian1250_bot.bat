@echo off
:: ─────────────────────────────────────────────────────────────────
::  MNQ Donchian, $1,250-target evaluation -- TopstepX bot launcher
::  Double-click to run, or from a command prompt: run_donchian1250_bot.bat
::  Arguments pass through, e.g.  run_donchian1250_bot.bat --account "EXACT-ACCOUNT-NAME"
:: ─────────────────────────────────────────────────────────────────

:: Credentials are read from a .env file in this folder, NOT from this script.
:: bot\.env must contain:
::
::     PROJECT_X_USERNAME=your_platform_username
::     PROJECT_X_API_KEY=your_api_key
::
:: and, for phone alerts (the same ntfy topic as the signal bot):
::
::     MNQ_NOTIFY_WEBHOOK=https://ntfy.sh/your-private-topic
::
:: .env is gitignored. Never paste the key into this .bat -- it would be
:: committed to the repo in plaintext.

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

:: -- Check the bot still trades what the research measured. Offline, no credentials. --
echo Running the parity checks (quick) ...
python test_donchian1250_parity.py --quick
if errorlevel 1 (
  echo.
  echo   PARITY CHECKS FAILED - not starting the bot.
  echo   The bot no longer matches the engine that measured the strategy.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting the bot ...
python mnq_donchian1250_bot.py %*

pause
