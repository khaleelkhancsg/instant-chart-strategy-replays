@echo off
:: -----------------------------------------------------------------
::  MNQ Signal Bot - same strategy, notifications instead of orders
::  Double-click to run, or: run_signal_bot.bat
::  Test your alerts first with:  run_signal_bot.bat --demo
:: -----------------------------------------------------------------
::
::  KEEP THIS FILE PURE ASCII.
::  chcp 65001 below switches the console to UTF-8, and from that point
::  cmd.exe keeps reading this script by BYTE offset while decoding it as
::  multi-byte. Any non-ASCII character after that line - a box-drawing
::  dash, an em dash, an emoji - shifts the offset, and every following
::  line loses a leading character or two. That is what produced
::  'ython' is not recognized as an internal or external command
::  The Python it launches can print whatever it likes; this file cannot.
::
::  Credentials come from bot\.env, NOT from this script:
::
::      PROJECT_X_USERNAME=your_username
::      PROJECT_X_API_KEY=your_api_key
::
::  Optional, for alerts on your phone:
::
::      MNQ_NOTIFY_WEBHOOK=https://ntfy.sh/some-private-topic-name
::      MNQ_HEARTBEAT_MIN=60
::
::  .env is gitignored. Do not paste secrets into this .bat.

:: UTF-8 so the alert boxes and emoji the bot prints render properly.
chcp 65001 >nul

cd /d "%~dp0"

:: --demo fires one of each alert and exits. No credentials, no connection.
if "%~1"=="--demo" (
  python mnq_signal_bot.py --demo
  pause
  exit /b 0
)

echo.
echo -------------------------------------------------------------
echo  SIGNAL MODE - nothing will be placed for you.
echo  Every order, stop and target is yours to enter by hand.
echo -------------------------------------------------------------
echo.

python mnq_signal_bot.py

pause
exit /b 0
