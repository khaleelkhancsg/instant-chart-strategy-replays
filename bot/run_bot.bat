@echo off
:: ─────────────────────────────────────────────────────────────────
::  EMA Scalp Bot — launcher
::  Place this file in the same folder as ema_scalp_bot.py
::  Double-click to run, or open a command prompt and type: run_bot.bat
:: ─────────────────────────────────────────────────────────────────

:: *** FILL IN YOUR CREDENTIALS BELOW ***
set PROJECT_X_API_KEY=ddFOOC3jqbwFoR1vpUxkKM6STSfrW2+KiquYk51lb78=
set PROJECT_X_USERNAME=ningen

:: Force UTF-8 output so emoji/box characters display correctly
chcp 65001 >nul

:: Change to the folder this .bat file lives in
cd /d "%~dp0"

:: Uncomment ONE of the lines below:

:: ── Option 1: Run the bot normally ──────────────────────────────
:: python mnq_gap_roc_bot.py

python mnq_donchian_bot.py


:: ── Option 2: Run preflight check only ──────────────────────────
:: python ema_scalp_bot.py --preflight

pause