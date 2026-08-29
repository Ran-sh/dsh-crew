@echo off
setlocal EnableExtensions
title DSH Crew Launcher

set "CREW_HOME=%USERPROFILE%\.config\dsh-crew\harness"
set "OFFICIAL_HOME=%USERPROFILE%\.dsh"
set "DSH_CLI=%CREW_HOME%\runtime\node_modules\.bin\dsh.cmd"
set "CREW_URL=http://127.0.0.1:3210"
set "UI_URL=http://127.0.0.1:3080"
set "LAUNCH_LOG=%TEMP%\dsh-crew-launcher.log"

if not exist "%DSH_CLI%" goto :not_installed
if not exist "%CREW_HOME%\profiles\dsh-crew\package.json" goto :not_installed
if not exist "%OFFICIAL_HOME%\profiles\web\package.json" goto :official_missing

call :ensure_service 3210 dsh-crew "%CREW_HOME%" "%CREW_URL%"
if errorlevel 1 goto :failed
call :ensure_service 3080 web "%OFFICIAL_HOME%" "%UI_URL%"
if errorlevel 1 goto :failed
exit /b 0

:ensure_service
set "LAUNCH_PORT=%~1"
set "LAUNCH_PROFILE=%~2"
set "LAUNCH_HOME=%~3"
set "LAUNCH_URL=%~4"

call :health_check "%LAUNCH_URL%"
if not errorlevel 1 exit /b 0

powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$listener=Get-NetTCPConnection -State Listen -LocalPort $env:LAUNCH_PORT -ErrorAction SilentlyContinue; if ($listener) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 exit /b 1

powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "try { $env:DSH_HOME=$env:LAUNCH_HOME; Start-Process -FilePath $env:DSH_CLI -ArgumentList @('--profile',$env:LAUNCH_PROFILE,'--host','127.0.0.1','--port',$env:LAUNCH_PORT,'--no-open') -WindowStyle Hidden -ErrorAction Stop } catch { ('['+(Get-Date -Format s)+'] Failed to start '+$env:LAUNCH_PROFILE+': '+$_.Exception.Message) | Add-Content -LiteralPath $env:LAUNCH_LOG; exit 1 }" >nul 2>&1
if errorlevel 1 exit /b 1

powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$lastError=$null; $deadline=(Get-Date).AddSeconds(90); do { try { $r=Invoke-RestMethod -Uri ($env:LAUNCH_URL+'/_dsh/dsh-crew/extension') -TimeoutSec 2; if ($r.ok -eq $true -and $r.extension.runtime.runtime_version) { exit 0 } } catch { $lastError=$_.Exception.Message }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); if (-not $lastError) { $lastError='No healthy response before the startup deadline.' }; ('['+(Get-Date -Format s)+'] '+$env:LAUNCH_PROFILE+' health check failed: '+$lastError) | Add-Content -LiteralPath $env:LAUNCH_LOG; exit 1" >nul 2>&1
exit /b %ERRORLEVEL%

:health_check
set "HEALTH_URL=%~1"
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "try { $r=Invoke-RestMethod -Uri ($env:HEALTH_URL+'/_dsh/dsh-crew/extension') -TimeoutSec 2; if ($r.ok -eq $true -and $r.extension.runtime.runtime_version) { exit 0 } } catch {}; exit 1" >nul 2>&1
exit /b %ERRORLEVEL%

:not_installed
echo [%date% %time%] DSH Crew is not installed completely.>>"%LAUNCH_LOG%"
exit /b 1

:official_missing
echo [%date% %time%] Official DeepSeek Harness web profile was not found.>>"%LAUNCH_LOG%"
exit /b 1

:failed
echo [%date% %time%] DSH Crew startup failed.>>"%LAUNCH_LOG%"
exit /b 1
