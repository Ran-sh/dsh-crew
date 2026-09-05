# DSH Crew managed Windows launcher
[CmdletBinding()]
param(
  [ValidateSet('background', 'open', 'watch')]
  [string] $Mode = 'open'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$crewHome = Join-Path $env:USERPROFILE '.config\dsh-crew\harness'
$dshCli = Join-Path $crewHome 'runtime\node_modules\.bin\dsh.cmd'
$logRoot = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$launcherLog = Join-Path $logRoot 'dsh-crew-launcher.log'
$startedAt = Get-Date
$launcherProcessStartedAtUtcTicks = try { (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture) } catch { $null }
$supervisorInstanceId = [guid]::NewGuid().ToString()
$launcherHelperHash = $null
try {
  $hashStream = [System.IO.File]::OpenRead($PSCommandPath)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { $launcherHelperHash = (($sha256.ComputeHash($hashStream) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $sha256.Dispose() }
  } finally { $hashStream.Dispose() }
} catch { $launcherHelperHash = $null }
$services = @(
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
  # Preserve the installed extension health contract used by maintenance.
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
      # FAIL CLOSED: an unreadable/missing disk manifest is NOT healthy —
      # the process cannot be proven to match the tree it will next boot.
      $expectedDshVersion = $null
      $diskReadable = $false
      $runtimeManifest = Join-Path $crewHome 'runtime\node_modules\@deepseek-ai\dsh\package.json'
      if (Test-Path -LiteralPath $runtimeManifest -PathType Leaf) {
        try {
          $expectedDshVersion = (Get-Content -LiteralPath $runtimeManifest -Raw | ConvertFrom-Json).version
          if ($expectedDshVersion) { $diskReadable = $true }
        } catch { $expectedDshVersion = $null }
      }
      $cohortMatches = $diskReadable -and $runtime.dsh_version -eq $expectedDshVersion
      if ($response.ok -eq $true -and $version -and $cohortMatches) {
        return [pscustomobject]@{ Ready = $true; Version = [string] $version; Error = $null }
      }
      if (-not $diskReadable) {
        return [pscustomobject]@{ Ready = $false; Version = $null; Error = 'disk runtime manifest unreadable; cannot prove cohort identity' }
      }
      if ($version -and -not $cohortMatches) {
        return [pscustomobject]@{ Ready = $false; Version = [string] $version; Error = ('runtime cohort mismatch: hub reports dsh_version={0} but disk runtime is {1}' -f $runtime.dsh_version, $expectedDshVersion) }
      }
      return [pscustomobject]@{ Ready = $false; Version = $null; Error = 'Response did not contain a ready runtime contract.' }
    } catch {
      return [pscustomobject]@{ Ready = $false; Version = $null; Error = $_.Exception.Message }
    }
  }
  # The launcher supervises only the Crew-owned 3210 service. Any non-Crew
  # service is never started or health-gated here; the legacy 3080 bridge
  # is probed only diagnostically after 3210 readiness (see Write-LegacyBridgeDiagnostic).
  return [pscustomobject]@{ Ready = $false; Version = $null; Error = 'Unknown service: only the Crew-owned 3210 service is supervised.' }
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

# ---- Crew supervisor control protocol (heartbeat + restart requests) --------
# The hub (3210) never spawns itself. It writes a durable restart request;
# this watcher is the only process authority and executes it after proving
# ownership (persisted identity + live runtime_id match).

$crewSupervisorRoot = Join-Path $env:USERPROFILE '.config\dsh-crew\supervisor'
$crewHeartbeatFile = Join-Path $crewSupervisorRoot 'heartbeat.json'
$crewRequestsDir = Join-Path $crewSupervisorRoot 'restart-requests'
$crewResultsDir = Join-Path $crewSupervisorRoot 'restart-results'

# UTF-8 WITHOUT BOM: Windows PowerShell 5.1's Set-Content -Encoding UTF8
# writes a BOM, and the Node hub's JSON.parse rejects it (heartbeat/request
# files would be unreadable -> supervisor judged unavailable).
function Write-Utf8NoBom {
  param([string] $Path, [string] $Content)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Write-SupervisorHeartbeat {
  param([bool] $OwnershipReady = $false)
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $record = @{ schema_version = 1; supervisor_instance_id = $supervisorInstanceId; pid = $PID; process_started_at_utc_ticks = $launcherProcessStartedAtUtcTicks; helper_hash = $launcherHelperHash; ownership_ready = $OwnershipReady; last_seen = $now; protocol_version = 1 } | ConvertTo-Json -Compress
  try {
    if (-not (Test-Path -LiteralPath $crewSupervisorRoot -PathType Container)) { New-Item -ItemType Directory -Path $crewSupervisorRoot -Force | Out-Null }
    $temp = Join-Path $crewSupervisorRoot ("heartbeat.{0}.tmp" -f $PID)
    Write-Utf8NoBom -Path $temp -Content $record
    Move-Item -LiteralPath $temp -Destination $crewHeartbeatFile -Force
  } catch { /* heartbeat is best-effort */ }
}

function Get-SupervisorLaunchArguments {
  param([string] $ScriptPath = $PSCommandPath)
  if ([string]::IsNullOrWhiteSpace($ScriptPath) -or $ScriptPath.Contains('"')) {
    throw 'A valid launcher script path is required.'
  }
  return @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $ScriptPath),
    '-Mode', 'watch'
  )
}

function Get-SupervisorHeartbeatRecord {
  param([int] $MaxAgeSeconds = 30)
  try {
    if (-not (Test-Path -LiteralPath $crewHeartbeatFile -PathType Leaf)) { return $null }
    $record = Get-Content -LiteralPath $crewHeartbeatFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $lastSeen = [long] $record.last_seen
    $age = $now - $lastSeen
    if ($record.schema_version -ne 1 -or $record.protocol_version -ne 1 -or [int] $record.pid -le 0) { return $null }
    if ($age -lt -5000 -or $age -gt ([long] $MaxAgeSeconds * 1000)) { return $null }
    $process = Get-Process -Id ([int] $record.pid) -ErrorAction Stop
    $processStartProperty = $record.PSObject.Properties['process_started_at_utc_ticks']
    if ($null -ne $processStartProperty -and $processStartProperty.Value) {
      $expectedTicks = [long] $processStartProperty.Value
      if ($process.StartTime.ToUniversalTime().Ticks -ne $expectedTicks) { return $null }
    }
    $ownershipProperty = $record.PSObject.Properties['ownership_ready']
    $helperHashProperty = $record.PSObject.Properties['helper_hash']
    $instanceProperty = $record.PSObject.Properties['supervisor_instance_id']
    $identityReady = $null -ne $processStartProperty -and $processStartProperty.Value `
      -and $null -ne $helperHashProperty -and $helperHashProperty.Value -match '^[a-f0-9]{64}$' `
      -and $null -ne $instanceProperty -and -not [string]::IsNullOrWhiteSpace([string] $instanceProperty.Value)
    $state = if ($null -eq $ownershipProperty) { 'legacy-v1' } elseif ($ownershipProperty.Value -eq $true -and $identityReady) { 'ready' } else { 'starting' }
    return [pscustomobject]@{ State = $state; Record = $record }
  } catch {
    return $null
  }
}

function Get-FreshSupervisorHeartbeat {
  param([int] $MaxAgeSeconds = 30)
  $observed = Get-SupervisorHeartbeatRecord -MaxAgeSeconds $MaxAgeSeconds
  if ($observed -and $observed.State -eq 'ready') { return $observed.Record }
  return $null
}

function Ensure-CrewSupervisorRunning {
  param([int] $TimeoutSeconds = 90)
  $watcher = $null
  $observed = Get-SupervisorHeartbeatRecord
  if ($observed -and $observed.State -eq 'legacy-v1') {
    throw 'CREW_SUPERVISOR_UPGRADE_REQUIRED: a legacy watcher is active and must be handed off before interactive launch.'
  }
  if (-not $observed) {
    $arguments = @(Get-SupervisorLaunchArguments -ScriptPath $PSCommandPath)
    $watcher = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Write-LaunchLog ('Started persistent Crew supervisor; PID={0}.' -f $watcher.Id)
  }

  $crew = $services | Where-Object { $_.CrewOwned } | Select-Object -First 1
  if (-not $crew) { throw 'Crew-owned 3210 service definition is missing.' }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $nextProgress = (Get-Date).AddSeconds(5)
  $lastHealthError = 'not checked'
  do {
    $heartbeat = Get-FreshSupervisorHeartbeat
    $health = Get-HealthState $crew
    $lastHealthError = $health.Error
    if ($heartbeat -and $health.Ready) {
      Write-LaunchLog ('Persistent supervisor ready; PID={0}; 3210 runtime={1}.' -f $heartbeat.pid, $health.Version)
      return
    }
    if ((Get-Date) -ge $nextProgress) {
      Write-LaunchLog ('Waiting for Crew on 3210; {0:n0}s remaining. Health: {1}' -f [Math]::Max(0, ($deadline - (Get-Date)).TotalSeconds), $lastHealthError)
      $nextProgress = (Get-Date).AddSeconds(5)
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw ('Persistent supervisor did not make 3210 ready within {0}s. Last health error: {1}' -f $TimeoutSeconds, $lastHealthError)
}

function Read-RestartRequests {
  if (-not (Test-Path -LiteralPath $crewRequestsDir -PathType Container)) { return @() }
  $requests = @()
  Get-ChildItem -LiteralPath $crewRequestsDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $parsed = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
      if ($parsed.schema_version -eq 1 -and $parsed.operation -eq 'restart' -and $parsed.request_id) {
        $requests += $parsed
      }
    } catch { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  }
  return $requests
}

function Write-RestartResult {
  param([object] $Request, [string] $State, [object] $Detail = $null)
  try {
    if (-not (Test-Path -LiteralPath $crewResultsDir -PathType Container)) { New-Item -ItemType Directory -Path $crewResultsDir -Force | Out-Null }
    $result = @{
      schema_version = 1
      request_id = $Request.request_id
      operation = 'restart'
      state = $State
      runtime_id = $Request.runtime_id
      written_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      detail = $Detail
    } | ConvertTo-Json -Depth 5
    $file = Join-Path $crewResultsDir ("{0}.json" -f $Request.request_id)
    $temp = Join-Path $crewResultsDir ("{0}.{1}.tmp" -f $Request.request_id, $PID)
    Write-Utf8NoBom -Path $temp -Content $result
    Move-Item -LiteralPath $temp -Destination $file -Force
  } catch { /* best effort */ }
  Remove-Item -LiteralPath (Join-Path $crewRequestsDir ("{0}.json" -f $Request.request_id)) -Force -ErrorAction SilentlyContinue
}

function Invoke-CrewRestartRequests {
  # Consume durable restart requests from the hub. Called by the watch loop.
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($request in (Read-RestartRequests)) {
    if (($request.expires_at -as [long]) -lt $now) {
      Write-RestartResult $request 'RESTART_REQUEST_EXPIRED'
      Write-LaunchLog ('Restart request {0} expired; not executed.' -f $request.request_id) 'WARN'
      continue
    }
    # Ownership authority: the request must name the SAME runtime identity we
    # own, and that identity must still be live on 3210.
    $crew = $services | Where-Object { $_.CrewOwned } | Select-Object -First 1
    if (-not $crew) { continue }
    $health = Get-HealthState $crew
    $liveIdentityOk = $false
    try {
      $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/_dsh/dsh-crew/extension' -TimeoutSec 3
      $liveRuntimeId = $response.extension.runtime.runtime_id
      $liveIdentityOk = ($response.ok -eq $true) -and ($liveRuntimeId -eq $request.runtime_id)
    } catch { $liveIdentityOk = $false }
    if (-not $liveIdentityOk) {
      Write-RestartResult $request 'SUPERVISOR_OWNERSHIP_CONFLICT'
      Write-LaunchLog ('Restart request {0} rejected: live runtime_id does not match the request.' -f $request.request_id) 'WARN'
      continue
    }
    Write-LaunchLog ('Executing restart request {0} (reason: {1}).' -f $request.request_id, $request.reason)
    $previousRuntimeId = $request.runtime_id
    # Re-read the listener port right before the kill so the PID identity is
    # fresh: Stop-OwnedListener requires a PID that equals the tracked
    # listener and belongs to the current owned process tree.
    $port = Get-PortState $crew.Port
    if ($port.State -ne 'occupied' -or -not $port.Pid) {
      Write-RestartResult $request 'SUPERVISOR_STOP_FAILED'
      Write-LaunchLog ('Restart request {0} failed: no listener on port {1}.' -f $request.request_id, $crew.Port) 'ERROR'
      continue
    }
    $stopped = Stop-OwnedListener -Service $crew -ListenerPid ([int] $port.Pid)
    if (-not $stopped) {
      Write-RestartResult $request 'SUPERVISOR_STOP_FAILED'
      Write-LaunchLog ('Restart request {0} failed to stop the owned runtime.' -f $request.request_id) 'ERROR'
      continue
    }
    Start-CrewService $crew
    Wait-CrewServices
    # Verify: runtime_id must have changed and the cohort must still match.
    $newRuntimeId = $null
    try {
      $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/_dsh/dsh-crew/extension' -TimeoutSec 3
      $newRuntimeId = $response.extension.runtime.runtime_id
    } catch { $newRuntimeId = $null }
    if ($newRuntimeId -and $newRuntimeId -ne $previousRuntimeId) {
      Write-RestartResult $request 'VERIFIED' @{ previous_runtime_id = $previousRuntimeId; runtime_id = $newRuntimeId }
      Write-LaunchLog ('Restart request {0} verified: runtime_id {1} -> {2}.' -f $request.request_id, $previousRuntimeId, $newRuntimeId)
    } else {
      Write-RestartResult $request 'VERIFY_FAILED' @{ previous_runtime_id = $previousRuntimeId; runtime_id = $newRuntimeId }
      Write-LaunchLog ('Restart request {0} verification failed: runtime_id did not change.' -f $request.request_id) 'ERROR'
    }
  }
}

$crewMaintenanceRequestsDir = Join-Path $crewSupervisorRoot 'maintenance-requests'
$crewMaintenanceResultsDir = Join-Path $crewSupervisorRoot 'maintenance-results'
$crewMaintenanceSessionFile = Join-Path $crewSupervisorRoot 'maintenance-session.json'

function Test-MaintenanceSessionActive {
  # Fence for ordinary Crew auto-start. Returns $true when a STOPPED session
  # holds the launch right OR when the session file is present but MALFORMED
  # (fail closed: a corrupt session must not let supervision auto-start
  # 3210, because the stopped window may belong to a live npx swap).
  # ABSENT means no fence: ordinary supervision proceeds.
  $session = Read-MaintenanceSession
  if ($session -eq 'ABSENT') { return $false }
  return $true
}

function Set-MaintenanceSession {
  param([object] $Request)
  # Strong-failure semantics: the STOPPED result may only be published after
  # the session is durably written AND read back with exact identity. Any
  # failure returns $false and the caller must NOT claim the stopped window.
  try {
    $session = @{
      schema_version = 1
      state = 'STOPPED'
      lease = $Request.lease
      runtime_id = $Request.runtime_id
      stopped_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      request_id = $Request.request_id
    } | ConvertTo-Json -Compress
    $temp = Join-Path $crewSupervisorRoot ("maintenance-session.{0}.tmp" -f $PID)
    Write-Utf8NoBom -Path $temp -Content $session
    Move-Item -LiteralPath $temp -Destination $crewMaintenanceSessionFile -Force
    $back = Read-MaintenanceSession
    if ($back -is [string]) { return $false }
    return ($back.schema_version -eq 1 -and $back.state -eq 'STOPPED' -and $back.lease -eq $Request.lease -and $back.runtime_id -eq $Request.runtime_id -and $back.request_id -eq $Request.request_id)
  } catch { return $false }
}

function Clear-MaintenanceSession {
  # Verifiable one-shot consumption: returns $true only when the session
  # file is provably ABSENT afterwards (otherwise the lease is NOT consumed
  # and replay stays impossible because start re-validates the session).
  try {
    Remove-Item -LiteralPath $crewMaintenanceSessionFile -Force -ErrorAction Stop
  } catch {
    if (Test-Path -LiteralPath $crewMaintenanceSessionFile -PathType Leaf) { return $false }
    return $true
  }
  return (-not (Test-Path -LiteralPath $crewMaintenanceSessionFile -PathType Leaf))
}

function Read-MaintenanceSession {
  # Tri-state: 'ABSENT' (no file), a session object when valid, or the
  # string 'MALFORMED' (present but unreadable/invalid). MALFORMED fails
  # closed for Crew auto-start (see Test-MaintenanceSessionActive).
  try {
    if (-not (Test-Path -LiteralPath $crewMaintenanceSessionFile -PathType Leaf)) { return 'ABSENT' }
    $parsed = Get-Content -LiteralPath $crewMaintenanceSessionFile -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($parsed.schema_version -ne 1 -or $parsed.state -ne 'STOPPED' -or -not $parsed.lease -or -not $parsed.runtime_id -or -not $parsed.request_id) {
      return 'MALFORMED'
    }
    return $parsed
  } catch { return 'MALFORMED' }
}

function Write-MaintenanceResult {
  param([object] $Request, [string] $State, [object] $Detail = $null)
  try {
    if (-not (Test-Path -LiteralPath $crewMaintenanceResultsDir -PathType Container)) { New-Item -ItemType Directory -Path $crewMaintenanceResultsDir -Force | Out-Null }
    $result = @{
      schema_version = 1
      request_id = $Request.request_id
      operation = $Request.operation
      state = $State
      lease = $Request.lease
      runtime_id = $Request.runtime_id
      written_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      detail = $Detail
    } | ConvertTo-Json -Depth 5
    $file = Join-Path $crewMaintenanceResultsDir ("{0}.json" -f $Request.request_id)
    $temp = Join-Path $crewMaintenanceResultsDir ("{0}.{1}.tmp" -f $Request.request_id, $PID)
    Write-Utf8NoBom -Path $temp -Content $result
    Move-Item -LiteralPath $temp -Destination $file -Force
  } catch { /* best effort */ }
  Remove-Item -LiteralPath (Join-Path $crewMaintenanceRequestsDir ("{0}.json" -f $Request.request_id)) -Force -ErrorAction SilentlyContinue
}

function Invoke-CrewMaintenanceRequests {
  # Consume maintenance transactions from npx lifecycle (cohort migration).
  # The npx process owns the runtime TREE swap; this watcher owns the
  # PROCESS stop/start around it. Two phases, both verified:
  #   maintenance-stop  -> stop owned 3210, write STOPPED (+lease)
  #   maintenance-start -> start 3210, verify new identity + cohort, VERIFIED
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (-not (Test-Path -LiteralPath $crewMaintenanceRequestsDir -PathType Container)) { return }
  $files = Get-ChildItem -LiteralPath $crewMaintenanceRequestsDir -Filter '*.json' -File -ErrorAction SilentlyContinue
  foreach ($file in $files) {
    try {
      $request = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      continue
    }
    if ($request.schema_version -ne 1 -or -not $request.request_id -or -not $request.operation) {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      continue
    }
    if (($request.expires_at -as [long]) -lt $now) {
      Write-MaintenanceResult $request 'MAINTENANCE_EXPIRED'
      Write-LaunchLog ('Maintenance request {0} ({1}) expired; not executed.' -f $request.request_id, $request.operation) 'WARN'
      continue
    }
    $crew = $services | Where-Object { $_.CrewOwned } | Select-Object -First 1
    if (-not $crew) { continue }
    if ($request.operation -eq 'maintenance-stop') {
      # Authority: the request must name the SAME live runtime identity we own.
      $liveRuntimeId = $null
      try {
        $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/_dsh/dsh-crew/extension' -TimeoutSec 3
        $runtime = $resp.extension.runtime
        $canonical = $resp.ok -eq $true `
          -and $runtime.service -eq 'dsh-crew-hub' `
          -and $runtime.execution_plane -eq 'hub-3210' `
          -and $runtime.profile -eq 'dsh-crew' `
          -and ($runtime.listen_port -as [int]) -eq 3210 `
          -and ($runtime.protocol_version -as [int]) -eq 1
        if ($canonical) { $liveRuntimeId = $runtime.runtime_id }
      } catch { $liveRuntimeId = $null }
      if (-not $liveRuntimeId -or $liveRuntimeId -ne $request.runtime_id) {
        Write-MaintenanceResult $request 'SUPERVISOR_OWNERSHIP_CONFLICT'
        Write-LaunchLog ('Maintenance-stop {0} rejected: live runtime_id mismatch.' -f $request.request_id) 'WARN'
        continue
      }
      $port = Get-PortState $crew.Port
      if ($port.State -ne 'occupied' -or -not $port.Pid) {
        Write-MaintenanceResult $request 'SUPERVISOR_STOP_FAILED'
        continue
      }
      $stopped = Stop-OwnedListener -Service $crew -ListenerPid ([int] $port.Pid)
      if ($stopped) {
        # The stopped window now belongs to the npx lifecycle: persist the
        # STOPPED session (lease + proven runtime_id) so ordinary
        # supervision will NOT auto-start 3210 until the matching start.
        # STRONG semantics: STOPPED is published ONLY after the session is
        # durably written AND read back with exact identity. A session write
        # failure must never tell npx it owns a stopped window it cannot
        # later prove (that race auto-restarts 3210 mid tree-swap).
        $sessionDurable = Set-MaintenanceSession $request
        if ($sessionDurable) {
          Write-MaintenanceResult $request 'STOPPED' @{ lease = $request.lease; stopped_runtime_id = $request.runtime_id }
          Write-LaunchLog ('Maintenance-stop {0} executed; lease issued.' -f $request.request_id)
        } else {
          Write-MaintenanceResult $request 'SUPERVISOR_SESSION_PERSIST_FAILED'
          Write-LaunchLog ('Maintenance-stop {0} stopped the process but the STOPPED session could not be persisted; NOT publishing STOPPED.' -f $request.request_id) 'ERROR'
        }
      } else {
        Write-MaintenanceResult $request 'SUPERVISOR_STOP_FAILED'
      }
    } elseif ($request.operation -eq 'maintenance-start') {
      # Pair with the matching STOPPED session: the start request must carry
      # the SAME lease and runtime_id the stop proved. A missing session,
      # mismatched lease/identity, or a still-listening port all fail closed
      # WITHOUT starting anything. The session is consumed on VERIFIED so
      # the lease is one-shot (no replay).
      $lease = $request.lease
      $expectedCrew = $null
      $expectedDsh = $null
      if ($request.extra) {
        $expectedCrew = $request.extra.expected_crew_version
        $expectedDsh = $request.extra.expected_dsh_version
      }
      $session = Read-MaintenanceSession
      if ($session -is [string] -or $session.lease -ne $lease -or $session.runtime_id -ne $request.runtime_id) {
        Write-MaintenanceResult $request 'SUPERVISOR_OWNERSHIP_CONFLICT'
        Write-LaunchLog ('Maintenance-start {0} rejected: no matching STOPPED session (lease/identity mismatch).' -f $request.request_id) 'WARN'
        continue
      }
      $livePort = Get-PortState $crew.Port
      if ($livePort.State -ne 'free') {
        # occupied AND unknown both fail closed: the stopped window is not
        # provably clean, so no start authority.
        Write-MaintenanceResult $request 'SUPERVISOR_OWNERSHIP_CONFLICT'
        Write-LaunchLog ('Maintenance-start {0} rejected: port {1} is not provably free (state={2}).' -f $request.request_id, $crew.Port, $livePort.State) 'WARN'
        continue
      }
      Start-CrewService $crew
      Wait-CrewServices
      $newRuntime = $null
      try {
        $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/_dsh/dsh-crew/extension' -TimeoutSec 5
        if ($resp.ok -eq $true) { $newRuntime = $resp.extension.runtime }
      } catch { $newRuntime = $null }
      $ok = $newRuntime -and $newRuntime.runtime_id `
        -and $newRuntime.service -eq 'dsh-crew-hub' `
        -and $newRuntime.execution_plane -eq 'hub-3210' `
        -and $newRuntime.profile -eq 'dsh-crew' `
        -and ($newRuntime.listen_port -as [int]) -eq 3210 `
        -and ($newRuntime.protocol_version -as [int]) -eq 1 `
        -and ($expectedCrew -eq $null -or $newRuntime.runtime_version -eq $expectedCrew) `
        -and ($expectedDsh -eq $null -or $newRuntime.dsh_version -eq $expectedDsh)
      if ($ok) {
        # Verifiable one-shot consumption: only a provably-cleared session
        # completes the transaction; otherwise the lease stays live and any
        # replay is still fenced (no VERIFIED without consumption proof).
        $consumed = Clear-MaintenanceSession
        if ($consumed) {
          Write-MaintenanceResult $request 'VERIFIED' @{ lease = $lease; runtime_id = $newRuntime.runtime_id; runtime_version = $newRuntime.runtime_version; dsh_version = $newRuntime.dsh_version }
          Write-LaunchLog ('Maintenance-start {0} verified: Crew {1} + DSH {2}.' -f $request.request_id, $newRuntime.runtime_version, $newRuntime.dsh_version)
        } else {
          Write-MaintenanceResult $request 'VERIFY_FAILED' @{ lease = $lease; runtime_id = $newRuntime.runtime_id }
          Write-LaunchLog ('Maintenance-start {0} identity verified but session consumption unproven; NOT marking VERIFIED.' -f $request.request_id) 'ERROR'
        }
      } else {
        $failedRuntimeId = $null
        if ($newRuntime) { $failedRuntimeId = $newRuntime.runtime_id }
        Write-MaintenanceResult $request 'VERIFY_FAILED' @{ lease = $lease; runtime_id = $failedRuntimeId }
        Write-LaunchLog ('Maintenance-start {0} verification failed.' -f $request.request_id) 'ERROR'
      }
    } else {
      # Unknown maintenance op: remove and report.
      Write-MaintenanceResult $request 'MAINTENANCE_UNKNOWN_OP'
    }
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

function Test-CrewServiceOwnership {
  param(
    [pscustomObject] $Service,
    [pscustomObject] $PortState = $null,
    [object[]] $ProcessTable = $null
  )
  if (-not $Service.ListenerPid -or -not $Service.ListenerStartedAtUtcTicks) { return $false }
  $port = if ($null -ne $PortState) { $PortState } else { Get-PortState $Service.Port }
  if ($port.State -ne 'occupied' -or -not $port.Pid -or [int] $port.Pid -ne [int] $Service.ListenerPid) { return $false }
  try {
    $tree = if ($null -ne $ProcessTable) {
      @(Get-TrackedProcessTree -Service $Service -ProcessTable $ProcessTable)
    } else {
      @(Get-TrackedProcessTree -Service $Service)
    }
    return ([int] $port.Pid -in $tree)
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
        if ($service.CrewOwned -and -not $service.ListenerPid -and -not (Set-TrackedListenerIdentity -Service $service)) {
          throw ('{0} is healthy on {1}, but this supervisor cannot prove process ownership.' -f $service.Name, $service.Port)
        }
        if ($service.CrewOwned -and -not (Test-CrewServiceOwnership -Service $service)) {
          throw ('{0} is healthy on {1}, but its tracked listener identity is not owned.' -f $service.Name, $service.Port)
        }
        $service.State = 'ready'
        $service.ConsecutiveFailures = 0
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

# Explicit diagnostic helper; not called by normal startup or supervision.
function Write-LegacyBridgeDiagnostic {
  if (Test-LegacyBridgeAvailable) {
    Write-LaunchLog 'Diagnostic: legacy 3080 bridge still answers ping; Crew launcher owns 3210 directly, bridge ignored.'
  }
}

function Ensure-CrewServices {
  param([switch] $QuietHealthy)

  foreach ($service in $services) {
    # Maintenance fence: while a STOPPED maintenance session is active for
    # the Crew backend, ordinary supervision must NOT auto-start 3210 —
    # the stopped window belongs to the npx lifecycle's tree swap. Only a
    # matching maintenance-start owns the launch right.
    if ($service.CrewOwned -and (Test-MaintenanceSessionActive)) {
      $service.State = 'maintenance'
      $service.LastError = $null
      continue
    }
    $health = Get-HealthState $service
    if ($health.Ready) {
      $wasReady = $service.State -eq 'ready'
      if ($service.CrewOwned -and -not $service.ListenerPid -and -not (Set-TrackedListenerIdentity -Service $service)) {
        throw ('{0} is healthy on {1}, but this supervisor cannot prove process ownership.' -f $service.Name, $service.Port)
      }
      if ($service.CrewOwned -and -not (Test-CrewServiceOwnership -Service $service)) {
        throw ('{0} is healthy on {1}, but its tracked listener identity is not owned.' -f $service.Name, $service.Port)
      }
      $service.State = 'ready'
      $service.ConsecutiveFailures = 0
      $service.LastError = $null
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

    # Publish process identity before any 3210 startup/health wait. Handoff
    # callers can now distinguish a legitimate cold-starting target watcher
    # from the stale heartbeat left by the watcher it replaced.
    Write-SupervisorHeartbeat -OwnershipReady $false
    Write-LaunchLog 'Supervisor active; monitoring Crew-owned 3210 every 10 seconds.'
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
        # Maintenance stop/start is the updater's owned process handoff and
        # must remain live while the update lock fences ordinary recovery.
        Invoke-CrewMaintenanceRequests
        if ($updateHeld) {
          Write-LaunchLog 'Update in progress; maintenance only, ordinary recovery suspended.'
          $lastRecoveryError = $null
        } else {
          # Control protocol: publish this watcher's heartbeat and consume
          # any durable restart requests the hub wrote (3210 never spawns
          # itself). Maintenance was consumed above; now run the ordinary
          # health pass.
          Invoke-CrewRestartRequests
          Ensure-CrewServices -QuietHealthy
          if ($lastRecoveryError) {
            Write-LaunchLog 'Supervisor recovery succeeded; Crew-owned 3210 is healthy.'
            $lastRecoveryError = $null
          }
        }
        $ownedServices = @($services | Where-Object { $_.CrewOwned -and (Test-CrewServiceOwnership -Service $_) })
        $expectedServices = @($services | Where-Object { $_.CrewOwned })
        Write-SupervisorHeartbeat -OwnershipReady ($expectedServices.Count -gt 0 -and $ownedServices.Count -eq $expectedServices.Count)
      } catch {
        $recoveryError = $_.Exception.Message
        Write-SupervisorHeartbeat -OwnershipReady $false
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
  # The launcher never starts or requires the external official ~/.dsh web/3080 profile.

  if ($Mode -eq 'watch') {
    Start-ServiceSupervisor
    Write-LaunchLog 'Supervisor stopped.' 'WARN'
    exit 0
  }

  Ensure-CrewSupervisorRunning

  if ($Mode -eq 'open') {
    Start-Process 'http://127.0.0.1:3210/' | Out-Null
    Write-LaunchLog 'Opened Crew control at http://127.0.0.1:3210/'
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
