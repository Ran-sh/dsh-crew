@echo off
rem One-click DSH Crew installer. Thin wrapper over scripts/setup.mjs.
setlocal
cd /d "%~dp0"
if not exist "scripts\setup.mjs" (
  echo [dsh-crew] setup.mjs not found. Run this from the repository root.
  exit /b 1
)
node scripts\setup.mjs install %*
exit /b %errorlevel%
