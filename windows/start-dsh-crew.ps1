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
  [pscustomobject]@{ Name = 'Official UI'; Profile = 'web'; Home = $officialHome; Port = 3080; Url = 'http://127.0.0.1:3080'; CrewOwned = $false; State = 'pending'; Process = $null; RootPid = $null; RootStartedAtUtcTicks = $null; ListenerPid = $null; ListenerStartedAtUtcTicks = $null; ConsecutiveFailures = 0; LastError = $null },
  [pscustomobject]@{ Name = 'Crew backend'; Profile = 'dsh-crew'; Home = $crewHome; Port = 3210; Url = 'http://127.0.0.1:3210'; CrewOwned = $true; State = 'pending'; Process = $null; RootPid = $null; RootStartedAtUtcTicks = $null; ListenerPid = $null; ListenerStartedAtUtcTicks = $null; ConsecutiveFailures = 0; LastError = $null }
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
  param([pscustomObject] $Service)
  # Crew-owned 3210 answers the Crew extension contract. The official 3080
  # is an external dependency: probe only its native web root, never the
  # Crew bridge endpoint, so a missing legacy bridge cannot fail 3080 health.
  if ($Service.CrewOwned) {
    try {
      $response = Invoke-RestMethod -Uri ($Service.Url + '/_dsh/dsh-crew/extension') -TimeoutSec 2
      $runtime = $response.extension.runtime
      $version = $runtime.runtime_version
      # A stale 3210 process (booted before the runtime tree was swapped) can
      # keep serving from memory while the disk tree is a different cohort.
      # Require the reported dsh_version to equal the installed disk
      # @deepseek-ai/dsh version so supervisor never treats a
      # disk-rc.1/memory-alpha.5 (or vice versa) process as healthy.
      $expectedDshVersion = $null
      $runtimeManifest = Join-Path $crewHome 'runtime\node_modules\@deepseek-ai\dsh\package.json'
      if (Test-Path -LiteralPath $runtimeManifest -PathType Leaf) {
        try { $expectedDshVersion = (Get-Content -LiteralPath $runtimeManifest -Raw | ConvertFrom-Json).version } catch { $expectedDshVersion = $null }
      }
      $cohortMatches = $null -eq $expectedDshVersion -or $runtime.dsh_version -eq $expectedDshVersion
      if ($response.ok -eq $true -and $version -and $cohortMatches) {
        return [pscustomobject]@{ Ready = $true; Version = [string] $version; Error = $null }
      }
      if ($version -and -not $cohortMatches) {
        return [pscustomobject]@{ Ready = $false; Version = [string] $version; Error = ('runtime cohort mismatch: hub reports dsh_version={0} but disk runtime is {1}' -f $runtime.dsh_version, $expectedDshVersion) }
      }
      return [pscustomobject]@{ Ready = $false; Version = $null; Error = 'Response did not contain a ready runtime contract.' }
    } catch {
      return [pscustomobject]@{ Ready = $false; Version = $null; Error = $_.Exception.Message }
    }
  }
  try {
    # The official 3080 UI may require a token (HTTP 401/403 on the bare
    # root) or redirect to the web entry (3xx). Any HTTP response means the
    # web service is up; only a connection-level failure means it is down.
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Service.Url -TimeoutSec 2
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
      return [pscustomobject]@{ Ready = $true; Version = $null; Error = $null }
    }
    return [pscustomobject]@{ Ready = $false; Version = $null; Error = ('Official UI returned HTTP {0}.' -f $response.StatusCode) }
  } catch {
    # Invoke-WebRequest surfaces 401/403 as exceptions; a response with a
    # status code still proves the listener is alive and answering.
    $status = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $status = [int] $_.Exception.Response.StatusCode
    }
    if ($null -ne $status -and $status -ge 400 -and $status -lt 500) {
      return [pscustomobject]@{ Ready = $true; Version = $null; Error = $null }
    }
    return [pscustomobject]@{ Ready = $false; Version = $null; Error = $_.Exception.Message }
  }
}

# Optional legacy compatibility probe: returns true only when a 3080 that
# still hosts the Crew bridge answers its ping endpoint. The Crew launcher
# never depends on it; 3210 always boots directly first.
function Test-LegacyBridgeAvailable {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080/_dsh/dsh-crew/ping' -TimeoutSec 3
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
  } catch {
    return $false
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

function Test-TrackedProcessIdentity {
  param([int] $ProcessId, [long] $ExpectedStartTicks, [object[]] $ProcessTable)
  if ($ProcessId -lt 1 -or $ExpectedStartTicks -lt 1) { return $false }
  $record = @($ProcessTable | Where-Object { [int] $_.ProcessId -eq $ProcessId } | Select-Object -First 1)
  if ($record.Count -eq 0) { return $false }
  $startTicks = $null
  if ($record[0].PSObject.Properties.Name -contains 'StartTicks') {
    $startTicks = [long] $record[0].StartTicks
  } else {
    try { $startTicks = (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { return $false }
  }
  return $startTicks -eq $ExpectedStartTicks
}

function Get-TrackedProcessTree {
  param([pscustomobject] $Service, [object[]] $ProcessTable = $null)
  $processes = if ($null -ne $ProcessTable) { @($ProcessTable) } else { @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  $owned = [System.Collections.Generic.HashSet[int]]::new()
  $rootMatches = Test-TrackedProcessIdentity -ProcessId $Service.RootPid -ExpectedStartTicks $Service.RootStartedAtUtcTicks -ProcessTable $processes
  $hasTrackedListener = $Service.ListenerPid -and $Service.ListenerStartedAtUtcTicks
  if ($hasTrackedListener) {
    $listenerMatches = Test-TrackedProcessIdentity -ProcessId $Service.ListenerPid -ExpectedStartTicks $Service.ListenerStartedAtUtcTicks -ProcessTable $processes
    if (-not $listenerMatches) { return @() }
    [void] $owned.Add([int] $Service.ListenerPid)
  } elseif (-not $rootMatches) {
    return @()
  }
  if ($rootMatches) { [void] $owned.Add([int] $Service.RootPid) }
  do {
    $added = $false
    foreach ($candidate in $processes) {
      $candidateId = [int] $candidate.ProcessId
      $parentId = [int] $candidate.ParentProcessId
      if ($owned.Contains($parentId) -and $owned.Add($candidateId)) { $added = $true }
    }
  } while ($added)
  return @($owned | ForEach-Object { [int] $_ })
}

function Set-TrackedListenerIdentity {
  param([pscustomobject] $Service)
  $port = Get-PortState $Service.Port
  if ($port.State -ne 'occupied' -or -not $port.Pid) { return $false }
  $tree = @(Get-TrackedProcessTree -Service $Service)
  if ($port.Pid -notin $tree) { return $false }
  try {
    $listener = Get-Process -Id $port.Pid -ErrorAction Stop
    $Service.ListenerPid = [int] $port.Pid
    $Service.ListenerStartedAtUtcTicks = $listener.StartTime.ToUniversalTime().Ticks
    return $true
  } catch {
    return $false
  }
}

function Stop-OwnedListener {
  param([pscustomobject] $Service, [int] $ListenerPid)
  if ($Mode -ne 'watch' -or -not $Service.ListenerPid -or $ListenerPid -ne $Service.ListenerPid) {
    return $false
  }
  try {
    $ownedProcessIds = @(Get-TrackedProcessTree -Service $Service)
    if ($ListenerPid -notin $ownedProcessIds) { return $false }
    Write-LaunchLog ('Supervisor confirmed owned listener PID={0} under tracked root PID={1}; stopping that process tree after {2} consecutive failed health checks.' -f $ListenerPid, $Service.RootPid, $Service.ConsecutiveFailures) 'WARN'
    foreach ($processId in $ownedProcessIds) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(5)
    do {
      $port = Get-PortState $Service.Port
      if ($port.State -eq 'free') { return $true }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
  } catch {
    Write-LaunchLog ('Supervisor could not stop its owned listener safely: {0}' -f $_.Exception.Message) 'WARN'
  }
  return $false
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
    $Service.RootPid = $process.Id
    $Service.RootStartedAtUtcTicks = $process.StartTime.ToUniversalTime().Ticks
    $Service.ListenerPid = $null
    $Service.ListenerStartedAtUtcTicks = $null
    $Service.ConsecutiveFailures = 0
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
        $service.ConsecutiveFailures = 0
        if ($service.CrewOwned) { [void] (Set-TrackedListenerIdentity -Service $service) }
        Write-LaunchLog ('{0} ready on {1}; runtime={2}' -f $service.Name, $service.Port, $health.Version)
      } elseif ($service.Process -and $service.Process.HasExited) {
        throw ('{0} exited before becoming ready; PID={1}; exit={2}; last health error: {3}' -f $service.Name, $service.Process.Id, $service.Process.ExitCode, $health.Error)
      }
    }
    if (@($services | Where-Object State -eq 'starting').Count -gt 0) { Start-Sleep -Milliseconds 500 }
  }

  $notReady = @($services | Where-Object {
    $_.State -ne 'ready'
  })
  if ($notReady.Count -gt 0) {
    $details = ($notReady | ForEach-Object { '{0}:{1} ({2})' -f $_.Profile, $_.Port, $_.LastError }) -join '; '
    throw "Startup health deadline exceeded: $details"
  }
}

# Non-critical diagnostic, called only after Ensure-CrewServices returns:
# logs legacy bridge presence for operator awareness. Never gates, delays,
# or claims 3210; never runs on the boot path.
function Write-LegacyBridgeDiagnostic {
  if (Test-LegacyBridgeAvailable) {
    Write-LaunchLog 'Diagnostic: legacy 3080 bridge still answers ping; Crew launcher owns 3210 directly, bridge ignored.'
  }
}

function Ensure-CrewServices {
  param([switch] $QuietHealthy)

  foreach ($service in $services) {
    $health = Get-HealthState $service
    if ($health.Ready) {
      $wasReady = $service.State -eq 'ready'
      $service.State = 'ready'
      $service.ConsecutiveFailures = 0
      $service.LastError = $null
      if ($service.CrewOwned -and -not $service.ListenerPid) { [void] (Set-TrackedListenerIdentity -Service $service) }
      if (-not $QuietHealthy -or -not $wasReady) {
        Write-LaunchLog ('{0} already ready on {1}; runtime={2}' -f $service.Name, $service.Port, $health.Version)
      }
      continue
    }

    # The Crew launcher owns 3210 directly and always boots it below.
    # Legacy bridge presence is diagnosed only after 3210 is ready (see
    # Wait-CrewServices tail), never on the boot path.

    $service.LastError = $health.Error
    $service.ConsecutiveFailures += 1
    if ($service.Process -and $service.Process.HasExited) {
      Write-LaunchLog ('{0} process exited after startup; PID={1}; exit={2}' -f $service.Name, $service.Process.Id, $service.Process.ExitCode) 'WARN'
      $service.Process = $null
    }
    $service.State = 'pending'

    $port = Get-PortState $service.Port
    if ($port.State -eq 'occupied') {
      if ($service.ConsecutiveFailures -lt 3) {
        throw ('Health check {0}/3 failed for {1}; owned process remains untouched until failure is confirmed. Health error: {2}' -f $service.ConsecutiveFailures, $service.Name, $health.Error)
      }
      if (Stop-OwnedListener -Service $service -ListenerPid $port.Pid) {
        $service.Process = $null
        $service.RootPid = $null
        $service.RootStartedAtUtcTicks = $null
        $service.ListenerPid = $null
        $service.ListenerStartedAtUtcTicks = $null
        $service.ConsecutiveFailures = 0
        $port = Get-PortState $service.Port
      }
    }
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
    $updateLockFile = Join-Path $crewHome '..\app\update-in-progress.lock'
    $staleLockNotified = $false
    while ($true) {
      try {
        # An installer-held update lock suspends recovery restarts: the tree
        # under Crew-owned state may be mid-migration, and a restart now
        # would boot a half-installed runtime/profile. A lock whose owner
        # process is dead is stale: log once and resume supervision instead
        # of staying observe-only forever.
        $updateHeld = $false
        if (Test-Path -LiteralPath $updateLockFile -PathType Leaf) {
          $lockAlive = $false
          try {
            $lockRecord = Get-Content -LiteralPath $updateLockFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $lockPid = [int] $lockRecord.pid
            if ($lockPid -gt 0) {
              Get-Process -Id $lockPid -ErrorAction Stop | Out-Null
              $lockAlive = $true
            }
          } catch { $lockAlive = $false }
          if ($lockAlive) {
            $updateHeld = $true
            $staleLockNotified = $false
          } elseif (-not $staleLockNotified) {
            Write-LaunchLog 'Stale update lock detected (owner process dead); resuming supervision. Re-run install/update to reconcile.' 'WARN'
            $staleLockNotified = $true
          }
        } else {
          $staleLockNotified = $false
        }
        if ($updateHeld) {
          Write-LaunchLog 'Update in progress; supervisor observing only, no restarts.'
          $lastRecoveryError = $null
        } else {
          Ensure-CrewServices -QuietHealthy
          if ($lastRecoveryError) {
            Write-LaunchLog 'Supervisor recovery succeeded; both services are healthy.'
            $lastRecoveryError = $null
          }
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

if ($env:DSH_CREW_LAUNCHER_TEST_IMPORT -eq '1') { return }

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
    throw "The official web profile is missing under $officialHome. Repair or install the official DeepSeek Harness web profile outside dsh-crew; dsh-crew never mutates the official profile."
  }

  if ($Mode -eq 'watch') {
    Start-ServiceSupervisor
    Write-LaunchLog 'Supervisor stopped.' 'WARN'
    exit 0
  }

  Ensure-CrewServices
  Write-LegacyBridgeDiagnostic

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
