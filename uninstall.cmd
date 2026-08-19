@echo off
rem One-click DSH Crew uninstaller. Thin wrapper over scripts/setup.mjs.
rem Keeps config / backups / credentials by default.
setlocal
cd /d "%~dp0"
if not exist "scripts\setup.mjs" (
  echo [dsh-crew] setup.mjs not found. Run this from the repository root.
  exit /b 1
)
node scripts\setup.mjs uninstall %*
exit /b %errorlevel%
