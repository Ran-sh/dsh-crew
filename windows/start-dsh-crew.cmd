@echo off
setlocal EnableExtensions
title DSH Crew Launcher

set "LAUNCH_REQUEST=%*"
set "LAUNCH_MODE=open"
set "LAUNCH_DIR=%~dp0"

if "%~1"=="" goto :run
if /i "%~1"=="--background" (
  set "LAUNCH_MODE=background"
  shift
  goto :validate
)
if /i "%~1"=="--open" (
  set "LAUNCH_MODE=open"
  shift
  goto :validate
)
if /i "%~1"=="--help" goto :help
goto :invalid_argument

:validate
if not "%~1"=="" goto :invalid_argument

:run
set "LAUNCH_HELPER=%LAUNCH_DIR%start-dsh-crew.ps1"
set "LAUNCH_LOG=%TEMP%\dsh-crew-launcher.log"
if not exist "%LAUNCH_HELPER%" (
  >>"%LAUNCH_LOG%" echo [%date% %time%] ERROR Managed launcher helper is missing: %LAUNCH_HELPER%
  echo ERROR: DSH Crew launcher helper is missing.
  echo Repair it with: dsh-crew update
  if /i "%LAUNCH_MODE%"=="open" pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%LAUNCH_HELPER%" -Mode "%LAUNCH_MODE%"
set "LAUNCH_EXIT=%ERRORLEVEL%"
if not "%LAUNCH_EXIT%"=="0" if /i "%LAUNCH_MODE%"=="open" pause
exit /b %LAUNCH_EXIT%

:invalid_argument
echo ERROR: Unsupported launcher arguments: %LAUNCH_REQUEST%
echo Use --open or --background.
exit /b 64

:help
echo Usage: %~nx0 [--open ^| --background]
echo   --open        Start both services and open http://127.0.0.1:3080/.
echo   --background  Start both services silently without opening a browser.
exit /b 0
