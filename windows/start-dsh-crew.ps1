# DSH Crew managed Windows launcher
[CmdletBinding()]
param(
  [ValidateSet('background', 'open', 'watch')]
  [string] $Mode = 'open'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$crewHome = Join-Path $env:USERPROFILE '.config\dsh-crew\harness'
$officialHome = Join-Path $env:USERPROFILE '.dsh'
$dshCli = Join-Path $crewHome 'runtime\node_modules\.bin\dsh.cmd'
$logRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$launcherLog = Join-Path $logRoot 'dsh-crew-launcher.log'
$startedAt = Get-Date
$services = @(
  [pscustomobject]@{ Name = 'Crew backend'; Profile = 'dsh-crew'; Home = $crewHome; Port = 3210; Url = 'http://127.0.0.1:3210'; State = 'pending'; Process = $null; LastError = $null },
  [pscustomobject]@{ Name = 'Official UI'; Profile = 'web'; Home = $officialHome; Port = 3080; Url = 'http://127.0.0.1:3080'; State = 'pending'; Process = $null; LastError = $null }
)

function Write-LaunchLog {
  param([string] $Message, [ValidateSet('INFO', 'WARN', 'ERROR')] [string] $Level = 'INFO')
  $line = '[{0}] [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffK'), $Level, $Message
  Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
  if ($Mode -eq 'open') {
    if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq 'WARN') { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line }
  }
}

function Get-HealthState {
  param([pscustomobject] $Service)
  try {
    $response = Invoke-RestMethod -Uri ($Service.Url + '/_dsh/dsh-crew/extension') -TimeoutSec 2
    $version = $response.extension.runtime.runtime_version
    if ($response.ok -eq $true -and $version) {
      return [pscustomobject]@{ Ready = $true; Version = [string] $version; Error = $null }
    }
    return [pscustomobject]@{ Ready = $false; Version = $null; Error = 'Response did not contain a ready runtime contract.' }
  } catch {
    return [pscustomobject]@{ Ready = $false; Version = $null; Error = $_.Exception.Message }
  }
}

function Get-PortState {
  param([int] $Port)
  try {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    $occupied = @($listeners | Where-Object Port -eq $Port).Count -gt 0
    if (-not $occupied) {
      return [pscustomobject]@{ State = 'free'; Error = $null; Pid = $null }
    }

    $ownerPid = $null
    try {
      $ownerPid = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1).OwningProcess
    } catch { }
    return [pscustomobject]@{ State = 'occupied'; Error = $null; Pid = $ownerPid }
  } catch {
    return [pscustomobject]@{ State = 'unknown'; Error = ('Listener enumeration failed: {0}' -f $_.Exception.Message); Pid = $null }
  }
}

function Start-CrewService {
  param([pscustomobject] $Service)
  $serviceRunStamp = (Get-Date).ToString('yyyyMMdd-HHmmssfff')
  $stdout = Join-Path $logRoot ('dsh-crew-{0}-{1}-{2}.out.log' -f $Service.Profile, $Service.Port, $serviceRunStamp)
  $stderr = Join-Path $logRoot ('dsh-crew-{0}-{1}-{2}.err.log' -f $Service.Profile, $Service.Port, $serviceRunStamp)
  $previousHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $Service.Home
    $arguments = @('--profile', $Service.Profile, '--host', '127.0.0.1', '--port', [string] $Service.Port, '--no-open')
    $process = Start-Process -FilePath $dshCli -ArgumentList $arguments -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $Service.Process = $process
    $Service.State = 'starting'
    Write-LaunchLog ('Started {0} on port {1}; PID={2}; stdout={3}; stderr={4}' -f $Service.Profile, $Service.Port, $process.Id, $stdout, $stderr)
  } finally {
    $env:DSH_HOME = $previousHome
  }
}

function Wait-CrewServices {
  $deadline = (Get-Date).AddSeconds(90)
  while (@($services | Where-Object State -eq 'starting').Count -gt 0 -and (Get-Date) -lt $deadline) {
    foreach ($service in ($services | Where-Object State -eq 'starting')) {
      $health = Get-HealthState $service
      $service.LastError = $health.Error
      if ($health.Ready) {
        $service.State = 'ready'
        Write-LaunchLog ('{0} ready on {1}; runtime={2}' -f $service.Name, $service.Port, $health.Version)
      } elseif ($service.Process -and $service.Process.HasExited) {
        throw ('{0} exited before becoming ready; PID={1}; exit={2}; last health error: {3}' -f $service.Name, $service.Process.Id, $service.Process.ExitCode, $health.Error)
      }
    }
    if (@($services | Where-Object State -eq 'starting').Count -gt 0) { Start-Sleep -Milliseconds 500 }
  }

  $notReady = @($services | Where-Object State -ne 'ready')
  if ($notReady.Count -gt 0) {
    $details = ($notReady | ForEach-Object { '{0}:{1} ({2})' -f $_.Profile, $_.Port, $_.LastError }) -join '; '
    throw "Startup health deadline exceeded: $details"
  }
}

function Ensure-CrewServices {
  param([switch] $QuietHealthy)

  foreach ($service in $services) {
    $health = Get-HealthState $service
    if ($health.Ready) {
      $wasReady = $service.State -eq 'ready'
      $service.State = 'ready'
      $service.LastError = $null
      if (-not $QuietHealthy -or -not $wasReady) {
        Write-LaunchLog ('{0} already ready on {1}; runtime={2}' -f $service.Name, $service.Port, $health.Version)
      }
      continue
    }

    $service.LastError = $health.Error
    if ($service.Process -and $service.Process.HasExited) {
      Write-LaunchLog ('{0} process exited after startup; PID={1}; exit={2}' -f $service.Name, $service.Process.Id, $service.Process.ExitCode) 'WARN'
      $service.Process = $null
    }
    $service.State = 'pending'

    $port = Get-PortState $service.Port
    if ($port.State -eq 'occupied') {
      $owner = if ($port.Pid) { "; listener PID=$($port.Pid)" } else { '' }
      throw ('Port {0} is occupied, but {1} failed its health contract{2}. Health error: {3}' -f $service.Port, $service.Name, $owner, $health.Error)
    }
    if ($port.State -ne 'free') {
      throw ('Could not determine whether port {0} is available: {1}' -f $service.Port, $port.Error)
    }
    if ($Mode -eq 'watch') {
      Write-LaunchLog ('Supervisor detected {0} unavailable on {1}; restarting it.' -f $service.Name, $service.Port) 'WARN'
    }
    Start-CrewService $service
  }

  Wait-CrewServices
}

function Start-ServiceSupervisor {
  $mutex = [System.Threading.Mutex]::new($false, 'Local\DSHCrewServiceSupervisor')
  $ownsMutex = $false
  try {
    try {
      $ownsMutex = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
      $ownsMutex = $true
    }
    if (-not $ownsMutex) {
      Write-LaunchLog 'Supervisor already active; duplicate watcher exiting.'
      return
    }

    Write-LaunchLog 'Supervisor active; monitoring 3080 and 3210 every 10 seconds.'
    $lastRecoveryError = $null
    while ($true) {
      try {
        Ensure-CrewServices -QuietHealthy
        if ($lastRecoveryError) {
          Write-LaunchLog 'Supervisor recovery succeeded; both services are healthy.'
          $lastRecoveryError = $null
        }
      } catch {
        $recoveryError = $_.Exception.Message
        if ($recoveryError -ne $lastRecoveryError) {
          Write-LaunchLog ('Supervisor recovery failed; will retry: {0}' -f $recoveryError) 'WARN'
          $lastRecoveryError = $recoveryError
        }
      }
      Start-Sleep -Seconds 10
    }
  } finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

try {
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  Write-LaunchLog ('Launcher started; mode={0}; user={1}' -f $Mode, $env:USERNAME)

  if (-not (Test-Path -LiteralPath $dshCli -PathType Leaf)) {
    throw "DSH CLI was not found at $dshCli. Run: npm install -g @ran-sh/dsh-crew@latest; dsh-crew update"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $crewHome 'profiles\dsh-crew\package.json') -PathType Leaf)) {
    throw "The isolated dsh-crew profile is missing under $crewHome. Run: dsh-crew update"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $officialHome 'profiles\web\package.json') -PathType Leaf)) {
    throw "The official web profile is missing under $officialHome. Run: dsh-crew integrate"
  }

  if ($Mode -eq 'watch') {
    Start-ServiceSupervisor
    Write-LaunchLog 'Supervisor stopped.' 'WARN'
    exit 0
  }

  Ensure-CrewServices

  if ($Mode -eq 'open') {
    Start-Process 'http://127.0.0.1:3080/' | Out-Null
    Write-LaunchLog 'Opened daily console at http://127.0.0.1:3080/'
  }
  Write-LaunchLog ('Launcher completed successfully in {0:n1}s.' -f ((Get-Date) - $startedAt).TotalSeconds)
  exit 0
} catch {
  Write-LaunchLog $_.Exception.Message 'ERROR'
  if ($Mode -eq 'open') {
    Write-Host ''
    Write-Host "Diagnostic log: $launcherLog" -ForegroundColor Yellow
    Write-Host 'Startup failed. Review the diagnostic log and the service stdout/stderr paths recorded above.' -ForegroundColor Yellow
  }
  exit 1
}
