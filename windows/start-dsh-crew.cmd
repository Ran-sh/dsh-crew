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
if /i "%~1"=="--watch" (
  set "LAUNCH_MODE=watch"
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
  call :rotate_launcher_log
  >>"%LAUNCH_LOG%" echo [%date% %time%] ERROR Managed launcher helper is missing: %LAUNCH_HELPER%
  echo ERROR: DSH Crew launcher helper is missing.
  echo Repair it with: dsh-crew update
  if /i "%LAUNCH_MODE%"=="open" if not "%DSH_CREW_LAUNCHER_NO_PAUSE%"=="1" pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%LAUNCH_HELPER%" -Mode "%LAUNCH_MODE%"
set "LAUNCH_EXIT=%ERRORLEVEL%"
rem DSH_CREW_LAUNCHER_NO_PAUSE: a wrapper that reports the failure itself asks
rem for the pause to be skipped here, so the operator presses a key once.
if not "%LAUNCH_EXIT%"=="0" if /i "%LAUNCH_MODE%"=="open" if not "%DSH_CREW_LAUNCHER_NO_PAUSE%"=="1" pause
exit /b %LAUNCH_EXIT%

:invalid_argument
echo ERROR: Unsupported launcher arguments: %LAUNCH_REQUEST%
echo Use --open, --background, or --watch.
exit /b 64

:rotate_launcher_log
rem The PowerShell launcher bounds this log at 5 MiB before its first line, but the
rem emergency path that calls this is what runs when that helper is MISSING — so a
rem bounded log cannot depend on the helper whose absence is one of the failures the
rem log exists to diagnose. Same cap, same two generations, best-effort: a locked or
rem unreadable log is left alone rather than failing the launch.
set "LAUNCH_LOG_SIZE="
for %%A in ("%LAUNCH_LOG%") do set "LAUNCH_LOG_SIZE=%%~zA"
if not defined LAUNCH_LOG_SIZE goto :eof
if %LAUNCH_LOG_SIZE% LSS 5242880 goto :eof
if exist "%LAUNCH_LOG%.2" del /f /q "%LAUNCH_LOG%.2" >nul 2>&1
if exist "%LAUNCH_LOG%.1" move /y "%LAUNCH_LOG%.1" "%LAUNCH_LOG%.2" >nul 2>&1
move /y "%LAUNCH_LOG%" "%LAUNCH_LOG%.1" >nul 2>&1
goto :eof

:help
echo Usage: %~nx0 [--open ^| --background ^| --watch]
echo   --open        Open official Harness on 3080 and return once Crew is supervised;
echo                 3210 keeps starting in the background.
echo   --background  Start the Crew-owned 3210 service silently.
echo   --watch       Keep the Crew-owned 3210 service healthy.
exit /b 0
