@echo off
rem Mic Switcher - Copyright (c) 2026 volync. All rights reserved.
rem Source-available, personal non-commercial use only - see LICENSE.
rem Double-click to remove Mic Switcher autostart from Discord.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -Uninstall
pause
