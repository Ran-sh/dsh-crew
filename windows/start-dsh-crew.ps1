# DSH Crew managed Windows launcher
[CmdletBinding()]
param(
  [ValidateSet('background', 'open', 'watch')]
  [string] $Mode = 'open'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$crewHome = Join-Path $env:USERPROFILE '.config\dsh-crew\harness'
$configuredDshCli = [string] $env:DSH_CREW_DSH_CLI
if ($env:DSH_CREW_LAUNCHER_TEST_IMPORT -eq '1') { $configuredDshCli = '' }
if (-not $configuredDshCli.Trim() -and $env:DSH_CREW_LAUNCHER_TEST_IMPORT -ne '1') {
  # Crew-managed npm runtime: the normal install path, written by dsh-crew
  # update and carrying whatever cohort that release pinned. An explicit
  # DSH_CREW_DSH_CLI always wins so an operator can still pin another entry.
  $runtimeEntry = Join-Path $crewHome 'runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path -LiteralPath $runtimeEntry -PathType Leaf) {
    $configuredDshCli = $runtimeEntry
  }
}
if (-not $configuredDshCli.Trim() -and $env:DSH_CREW_LAUNCHER_TEST_IMPORT -ne '1') {
  # Crew-managed source cohort: a runtime-source-<label>.json sidecar names the
  # CLI entry. The sidecar's recorded version must equal the checkout's own
  # manifest, so a stale sidecar can never pin a half-updated tree.
  foreach ($sidecar in @(Get-ChildItem -LiteralPath $crewHome -Filter 'runtime-source-*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
    try {
      $metadata = Get-Content -LiteralPath $sidecar.FullName -Raw | ConvertFrom-Json
      if ($metadata.managed_by -ne 'dsh-crew') { continue }
      $candidate = [string] $metadata.cli_entry
      if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
      $sourceRoot = [IO.Path]::GetFullPath((Join-Path $crewHome ([IO.Path]::GetFileNameWithoutExtension($sidecar.Name))))
      $candidateFull = [IO.Path]::GetFullPath($candidate)
      $sourcePrefix = $sourceRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      $sourceManifest = Join-Path $sourceRoot 'apps\cli\package.json'
      $sourceVersion = if (Test-Path -LiteralPath $sourceManifest -PathType Leaf) {
        [string] (Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json).version
      } else { $null }
      $candidateValid = $sourceVersion -and $sourceVersion -eq [string] $metadata.version `
        -and $candidateFull.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) `
        -and (Test-Path -LiteralPath $candidateFull -PathType Leaf)
      if ($candidateValid) {
        $configuredDshCli = $candidateFull
        break
      }
    } catch { }
  }
}
$dshCli = if ($configuredDshCli.Trim()) {
  try { [IO.Path]::GetFullPath($configuredDshCli) } catch { $configuredDshCli }
} else {
  Join-Path $crewHome 'runtime\node_modules\.bin\dsh.cmd'
}
if ($configuredDshCli.Trim()) { $env:DSH_CREW_DSH_CLI = $dshCli }
# DSH_HOME that owns the selected CLI. The managed npm runtime shares the Crew
# home; a Crew-managed source cohort is its own home (its profiles, sessions and
# settings live inside that tree). Derived from the selected entry so an explicit
# DSH_CREW_DSH_CLI override resolves correctly too.
$dshHome = $crewHome
$sourceRootMatch = [regex]::Match($dshCli, '^(?<root>.+?[\\/]runtime-source-[^\\/]+)[\\/]')
if ($sourceRootMatch.Success) {
  $candidateRoot = $sourceRootMatch.Groups['root'].Value
  if (Test-Path -LiteralPath (Join-Path $candidateRoot 'profiles') -PathType Container) { $dshHome = $candidateRoot }
}
$dshCliIsNodeEntry = [IO.Path]::GetExtension($dshCli).ToLowerInvariant() -eq '.js'
$dshCommand = if ($dshCliIsNodeEntry) {
  (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
} else { $dshCli }

function Get-CrewDshManifest {
  param([string] $Entry)
  if (-not $Entry) { return $null }
  try { $cursor = [IO.Path]::GetFullPath($Entry) } catch { return $null }
  if ([IO.Path]::GetExtension($cursor).ToLowerInvariant() -eq '.js') {
    $cursor = Split-Path -Parent $cursor
  } else {
    $cursor = Split-Path -Parent $cursor
  }
  for ($depth = 0; $depth -lt 12 -and $cursor; $depth += 1) {
    $candidates = @(
      (Join-Path $cursor 'package.json'),
      (Join-Path $cursor 'node_modules\@deepseek-ai\dsh\package.json')
    )
    foreach ($candidate in $candidates) {
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
      try {
        $manifest = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
        $knownOfficial = -not $configuredDshCli.Trim() -or $manifest.name -eq '@deepseek-ai/dsh'
        if ($knownOfficial -and [string] $manifest.version) { return $manifest }
      } catch { }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
  return $null
}

$dshManifest = Get-CrewDshManifest -Entry $dshCli
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
  [pscustomobject]@{ Name = 'Crew backend'; Profile = 'dsh-crew'; Home = $dshHome; Port = 3210; Url = 'http://127.0.0.1:3210'; CrewOwned = $true; State = 'pending'; Process = $null; RootPid = $null; RootStartedAtUtcTicks = $null; ListenerPid = $null; ListenerStartedAtUtcTicks = $null; ConsecutiveFailures = 0; LastError = $null }
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

function Resolve-OfficialHarnessCommand {
  $shim = Get-Command dsh.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $root = Join-Path (Split-Path -Parent $shim.Source) 'node_modules\@deepseek-ai\dsh'
  $manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($manifest.name -ne '@deepseek-ai/dsh') { throw 'The dsh command is not a verified official Harness installation.' }
  $entrySpec = [string] $manifest.bin.dsh
  if (-not $entrySpec -or [IO.Path]::IsPathRooted($entrySpec) -or $entrySpec.Contains(':') -or ($entrySpec.Replace('\', '/').Split('/') -contains '..')) {
    throw 'The official Harness CLI entry is invalid.'
  }
  $entry = [IO.Path]::GetFullPath((Join-Path $root $entrySpec))
  $rootPrefix = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $entry.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'The official Harness CLI entry was not found.'
  }
  $node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
  return [pscustomobject]@{ NodePath = $node.Source; Entry = $entry }
}

function Test-OfficialHarnessListener {
  param([int] $OwnerPid, [pscustomobject] $Official, [string] $Profile = 'web')
  if ($OwnerPid -le 0) { return $false }
  try {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $OwnerPid) -ErrorAction Stop
    if (-not $owner -or [IO.Path]::GetFileName([string] $owner.ExecutablePath) -ine 'node.exe') { return $false }
    $line = ([string] $owner.CommandLine).Replace('/', '\')
    $entry = [regex]::Escape($Official.Entry.Replace('/', '\'))
    $node = [regex]::Escape($Official.NodePath.Replace('/', '\'))
    $profileToken = [regex]::Escape($Profile)
    $pattern = '^\s*(?:"?' + $node + '"?|"?node(?:\.exe)?"?)\s+"?' + $entry + '"?\s+(?:"?' + $profileToken + '"?|--profile\s+"?' + $profileToken + '"?)(?:\s|$)'
    return $line -match $pattern
  } catch { return $false }
}

function Test-CrewDshCliPreflight {
  if ($null -eq $dshManifest -or [string]::IsNullOrWhiteSpace([string] $dshManifest.version)) {
    throw "The DSH CLI at $dshCli is not a verified @deepseek-ai/dsh package entry."
  }
  if ($dshCliIsNodeEntry -and -not (Test-Path -LiteralPath (Join-Path (Join-Path $dshHome 'profiles') 'web\package.json') -PathType Leaf)) {
    throw ('The Harness web profile is missing under {0}. Run: dsh-crew update' -f $dshHome)
  }
  $versionArgs = if ($dshCliIsNodeEntry) { @($dshCli, '--version') } else { @('--version') }
  $reported = try { (& $dshCommand @versionArgs 2>&1 | Out-String).Trim() } catch { '' }
  if ($LASTEXITCODE -ne 0 -or $reported -ne [string] $dshManifest.version) {
    throw ('DSH CLI preflight failed: manifest={0}, reported={1}' -f $dshManifest.version, ($reported -replace '\s+', ' '))
  }
}

function Get-CrewWebSessionUrl {
  param([string] $OutputLog = $null)
  $logs = if ($OutputLog) {
    @(Get-Item -LiteralPath $OutputLog -ErrorAction SilentlyContinue)
  } else {
    @(Get-ChildItem -LiteralPath $logRoot -Filter 'dsh-crew-web-*.out.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  }
  foreach ($log in $logs) {
    try {
      $text = Get-Content -LiteralPath $log.FullName -Raw -ErrorAction Stop
      $match = [regex]::Match($text, 'https?://127\.0\.0\.1:3080/\?token=[^\s\r\n]+')
      if ($match.Success) { return $match.Value }
    } catch { }
  }
  return $null
}

function Open-CrewBrowserUrl {
  param([Parameter(Mandatory = $true)] [string] $Url)
  $edge = Get-Command msedge.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $edge) {
    $edgeCandidates = @(
      @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
      ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    )
    if ($edgeCandidates.Count -gt 0) { $edge = [pscustomobject]@{ Source = $edgeCandidates[0] } }
  }
  if ($edge) {
    Start-Process -FilePath $edge.Source -ArgumentList @('--new-window', $Url) | Out-Null
    return
  }
  Start-Process $Url | Out-Null
}

function Test-CrewWebSessionUrl {
  param([string] $Url)
  if (-not $Url) { return $false }
  try {
    # The token endpoint intentionally answers with a 303 + Set-Cookie and
    # redirects to `/`; do not follow it here or PowerShell loses the cookie
    # and falsely reports the authenticated page as 404.
    $response = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri $Url -TimeoutSec 3
    return [int] $response.StatusCode -ge 200 -and [int] $response.StatusCode -lt 400
  } catch {
    $status = if ($_.Exception.Response) { [int] $_.Exception.Response.StatusCode } else { 0 }
    return $status -in @(301, 302, 303, 307, 308)
  }
}

function Open-CrewManagedFrontend {
  param([int] $TimeoutSeconds = 90, [switch] $Quiet)
  # The 3080 frontend boots from the same Crew-managed Harness entry as 3210,
  # against that entry's own DSH_HOME (npm runtime -> Crew home, source cohort
  # -> its own tree). No official ~/.dsh state is read or written here.
  $managedHome = $dshHome
  $managedProfile = 'web'
  $profileManifest = Join-Path (Join-Path $managedHome 'profiles') ('{0}\package.json' -f $managedProfile)
  if (-not $dshCliIsNodeEntry -or -not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
    return $false
  }
  $official = [pscustomobject]@{ NodePath = $dshCommand; Entry = $dshCli; Profile = $managedProfile }
  $frontend = Get-OfficialFrontendOverlay
  $mutex = New-Object System.Threading.Mutex($false, 'Local\DSHCrewOfficialFrontendLauncher')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another desktop launch is still starting the Crew-managed Harness frontend.' }
    $port = Get-PortState -Port 3080
    if ($port.State -eq 'unknown') { throw $port.Error }
    if ($port.State -eq 'occupied') {
      if (-not (Test-OfficialHarnessListener -OwnerPid $port.Pid -Official $official -Profile $managedProfile)) {
        throw 'Port 3080 is occupied by a non-Crew-managed process; it was left untouched.'
      }
      if (-not (Test-OfficialWebReady)) { throw 'The Crew-managed 3080 frontend is not ready; its process was left running.' }
      $existingUrl = Get-CrewWebSessionUrl
      if ($existingUrl -and (Test-CrewWebSessionUrl -Url $existingUrl)) {
        if (-not $Quiet) { Open-CrewBrowserUrl -Url $existingUrl }
        Write-LaunchLog 'Opened the existing Crew-managed Harness frontend on 3080 with its session URL.'
        return $true
      }
      Write-LaunchLog 'The existing Crew-managed 3080 session URL is stale; restarting the verified listener.' 'WARN'
      Stop-Process -Id $port.Pid -Force -ErrorAction Stop
      $freeDeadline = (Get-Date).AddSeconds(5)
      do { Start-Sleep -Milliseconds 250; $port = Get-PortState -Port 3080 } while ($port.State -ne 'free' -and (Get-Date) -lt $freeDeadline)
      if ($port.State -ne 'free') { throw 'The stale Crew-managed 3080 listener did not release the port.' }
    }

    $stamp = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmssfff'), $PID
    $stdout = Join-Path $logRoot ('dsh-crew-web-{0}.out.log' -f $stamp)
    $stderr = Join-Path $logRoot ('dsh-crew-web-{0}.err.log' -f $stamp)
    $previousHome = $env:DSH_HOME
    $previousCli = $env:DSH_CREW_DSH_CLI
    try {
      $env:DSH_HOME = $managedHome
      $env:DSH_CREW_DSH_CLI = $dshCli
      $arguments = @($dshCli, '--profile', $managedProfile, '--patch', ('"{0}"' -f $frontend.Path), '--host', '127.0.0.1', '--port', '3080')
      $process = Start-Process -FilePath $dshCommand -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally {
      $env:DSH_HOME = $previousHome
      $env:DSH_CREW_DSH_CLI = $previousCli
    }
    Write-LaunchLog ('Started Crew-managed Harness on 3080; PID={0}. Logs: {1}, {2}' -f $process.Id, $stdout, $stderr)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
      $port = Get-PortState -Port 3080
      if ($port.State -eq 'occupied') {
        if (-not (Test-OfficialHarnessListener -OwnerPid $port.Pid -Official $official -Profile $managedProfile)) {
          throw 'Port 3080 became occupied by an unverified process; it was left untouched.'
        }
        if (Test-OfficialWebReady) {
          $startedUrl = Get-CrewWebSessionUrl -OutputLog $stdout
          if ($startedUrl) {
            if (-not $Quiet) { Open-CrewBrowserUrl -Url $startedUrl }
            return $true
          }
        }
      }
      if ($process.HasExited) { throw ('Crew-managed Harness exited before readiness. Diagnostic log: {0}' -f $stderr) }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw ('The Crew-managed Harness did not become ready within {0}s; inspect {1}.' -f $TimeoutSeconds, $stderr)
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Test-OfficialWebReady {  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3080/' -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    # An authenticated official UI may reject this cookie-free health request.
    if ($_.Exception.Response) { return [int] $_.Exception.Response.StatusCode -in @(401, 403) }
    return $false
  }
}

# ---- The other server on this DSH home -------------------------------------
# The Crew-managed frontend on 3080 boots from the same Crew-managed entry as the
# hub, so it runs on the same DSH home: same sessions, same settings, and the
# same `storages/workspace.json`. DSH's JSON storage replaces that whole file and
# lets the last writer win, so an external rewrite of it only sticks while no
# server holds the file in memory. A history maintenance is exactly such an
# external rewrite, which is why it asks for this server to be stopped too —
# stopping the hub alone is what let a cleanup be undone minutes later.
function Stop-CrewManagedFrontend {
  param([int] $TimeoutSeconds = 15)
  $port = Get-PortState -Port 3080
  if ($port.State -eq 'free') { return $true }
  # An unenumerable listener is not provably free: fail closed rather than write
  # under a server that might hold the very file being rewritten.
  if ($port.State -ne 'occupied' -or -not $port.Pid) { return $false }
  $ours = $false
  if ($dshCliIsNodeEntry) {
    $official = [pscustomobject]@{ NodePath = $dshCommand; Entry = $dshCli; Profile = 'web' }
    $ours = Test-OfficialHarnessListener -OwnerPid ([int] $port.Pid) -Official $official -Profile 'web'
  }
  if (-not $ours) {
    # Crew did not start this listener, so it cannot be proven to share the
    # workspace store. A Crew-patched one is on a Crew home either way and is
    # refused; the legacy official frontend and anything unrelated keep running,
    # exactly as the start path leaves a foreign 3080 alone.
    $patched = $false
    try {
      $probe = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/_dsh/dsh-crew/bridge-status' -TimeoutSec 2
      $patched = $probe.surface -eq 'official-bridge'
    } catch { $patched = $false }
    if ($patched) { return $false }
    Write-LaunchLog 'A 3080 listener that is not the Crew-managed frontend was left running; it does not serve this DSH home.' 'WARN'
    return $true
  }
  try { Stop-Process -Id ([int] $port.Pid) -Force -ErrorAction Stop } catch { return $false }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $port = Get-PortState -Port 3080
    if ($port.State -eq 'free') { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  Write-LaunchLog ('The Crew-managed frontend on 3080 did not release the port within {0}s.' -f $TimeoutSeconds) 'WARN'
  return $false
}

function Start-CrewManagedFrontendQuietly {
  # Give back what a maintenance window took. Never fatal: the next desktop
  # launch starts the frontend anyway, and that is where the operator reloads
  # from, because a restarted frontend answers on a new session URL.
  try {
    if (Open-CrewManagedFrontend -Quiet) { Write-LaunchLog 'Crew-managed frontend on 3080 is serving again after maintenance.' }
    else { Write-LaunchLog 'Crew-managed frontend on 3080 was not restarted after maintenance; the next desktop launch will start it.' 'WARN' }
  } catch {
    Write-LaunchLog ('Crew-managed frontend on 3080 could not be restarted after maintenance: {0}' -f $_.Exception.Message) 'WARN'
  }
}

function Get-OfficialFrontendOverlay {
  $frontendRoot = Join-Path $env:USERPROFILE '.config\dsh-crew\frontend'
  $path = Join-Path $frontendRoot 'official-web.patch.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Crew frontend overlay is missing. Run dsh-crew update with the current GitHub candidate.' }
  # Windows PowerShell 5.1 keeps a JSON root array as one pipeline object;
  # direct `$patch[0].insert[0]` therefore resolves `insert` as IList.Insert
  # instead of indexing the JSON property. Flatten both PowerShell generations
  # explicitly and read properties through PSObject so StrictMode reports a
  # useful validation error instead of "property id cannot be found".
  $parsed = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  $patch = @($parsed | ForEach-Object { $_ })
  $root = if ($patch.Count -eq 1) { $patch[0] } else { $null }
  $insertProperty = if ($null -ne $root) { $root.PSObject.Properties['insert'] } else { $null }
  $insertValue = if ($null -ne $insertProperty) { $insertProperty.Value } else { $null }
  $inserts = @($insertValue | ForEach-Object { $_ })
  $bridge = if ($inserts.Count -eq 1) { $inserts[0] } else { $null }
  $idProperty = if ($null -ne $bridge) { $bridge.PSObject.Properties['id'] } else { $null }
  $nameProperty = if ($null -ne $bridge) { $bridge.PSObject.Properties['name'] } else { $null }
  if ($patch.Count -ne 1 -or $inserts.Count -ne 1 -or $null -eq $idProperty -or [string] $idProperty.Value -ne 'dsh-crew-official-web-bridge' -or $null -eq $nameProperty) {
    throw 'Crew frontend overlay has an unexpected structure.'
  }
  $uri = [Uri] ([string] $nameProperty.Value)
  if (-not $uri.IsFile) { throw 'Crew frontend must load from its local snapshot.' }
  $entry = [IO.Path]::GetFullPath($uri.LocalPath)
  $prefix = [IO.Path]::GetFullPath((Join-Path $frontendRoot 'revisions')) + [IO.Path]::DirectorySeparatorChar
  if (-not $entry.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Crew frontend snapshot is outside its owned directory.' }
  $metadata = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $entry) 'package.json') -Raw | ConvertFrom-Json
  $revision = [string] $metadata.dshCrewFrontendRevision
  if ($metadata.dshCrewManagedFrontend -ne $true -or $revision -notmatch '^[a-f0-9]{64}$' -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'Crew frontend snapshot is incomplete.'
  }
  return [pscustomobject]@{ Path = $path; Revision = $revision }
}

function Test-OfficialFrontendAttached {
  param([string] $Revision)
  try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/_dsh/dsh-crew/bridge-status' -TimeoutSec 2
    return $response.ok -eq $true -and $response.surface -eq 'official-bridge' -and $response.frontend_revision -eq $Revision
  } catch { return $false }
}

function Open-OfficialFrontend {
  param([int] $TimeoutSeconds = 90)
  # Preferred path: the Crew-managed Harness serves 3080 with the Crew panel
  # already loaded. The legacy fallback below (separate official install in
  # ~/.dsh) is only reached when no Crew-managed frontend is available.
  if (Open-CrewManagedFrontend -TimeoutSeconds $TimeoutSeconds) { return }
  $official = Resolve-OfficialHarnessCommand
  $frontend = Get-OfficialFrontendOverlay
  $mutex = New-Object System.Threading.Mutex($false, 'Local\DSHCrewOfficialFrontendLauncher')
  $locked = $false
  try {
    try { $locked = $mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another desktop launch is still starting the official frontend.' }
    $port = Get-PortState -Port 3080
    if ($port.State -eq 'unknown') { throw $port.Error }
    if ($port.State -eq 'occupied') {
      if (-not (Test-OfficialHarnessListener -OwnerPid $port.Pid -Official $official)) { throw 'Port 3080 is occupied by an unverified process; it was left untouched.' }
      if (-not (Test-OfficialWebReady)) { throw 'The official 3080 frontend is not ready; its process was left running.' }
      if (-not (Test-OfficialFrontendAttached -Revision $frontend.Revision)) { throw 'The running official frontend has not loaded the current Crew panel. Stop that official instance when idle, then launch from the desktop again. It was left untouched.' }
      Start-Process 'http://127.0.0.1:3080/' | Out-Null
      Write-LaunchLog 'Opened the existing official Harness frontend on 3080.'
      return
    }

    $stamp = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmssfff'), $PID
    $stdout = Join-Path $logRoot ('dsh-official-web-{0}.out.log' -f $stamp)
    $stderr = Join-Path $logRoot ('dsh-official-web-{0}.err.log' -f $stamp)
    $previousHome = $env:DSH_HOME
    try {
      # The official application owns its normal state; no Crew plugin/profile
      # registration or repair is performed in this home by the launcher.
      $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
      $arguments = @(('"{0}"' -f $official.Entry), 'web', '--patch', ('"{0}"' -f $frontend.Path), '--host', '127.0.0.1', '--port', '3080')
      $process = Start-Process -FilePath $official.NodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally { $env:DSH_HOME = $previousHome }
    Write-LaunchLog ('Started official Harness on 3080; PID={0}. The official CLI opens the browser. Logs: {1}, {2}' -f $process.Id, $stdout, $stderr)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $nextProgress = (Get-Date).AddSeconds(5)
    do {
      $port = Get-PortState -Port 3080
      if ($port.State -eq 'occupied') {
        if (-not (Test-OfficialHarnessListener -OwnerPid $port.Pid -Official $official)) { throw 'Port 3080 became occupied by an unverified process; it was left untouched.' }
        if ((Test-OfficialWebReady) -and (Test-OfficialFrontendAttached -Revision $frontend.Revision)) { return }
      }
      if ($process.HasExited) { throw ('Official Harness exited before readiness. Diagnostic log: {0}' -f $stderr) }
      if ((Get-Date) -ge $nextProgress) {
        Write-LaunchLog 'Waiting for the official Harness frontend on 3080...'
        $nextProgress = (Get-Date).AddSeconds(5)
      }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw ('Official Harness did not become ready within {0}s; inspect {1}. No official process was stopped.' -f $TimeoutSeconds, $stderr)
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
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
      $activeDshManifest = Get-CrewDshManifest -Entry $dshCli
      if ($null -ne $activeDshManifest -and [string] $activeDshManifest.version) {
        $expectedDshVersion = [string] $activeDshManifest.version
        $diskReadable = $true
      }
      $cohortMatches = $diskReadable -and $runtime.dsh_version -eq $expectedDshVersion
      # Read through PSObject: StrictMode is on, so a response that simply omits the
      # property would throw and be swallowed as "not ready" rather than being
      # reported absent.
      $runtimeId = $null
      if ($null -ne $runtime) {
        $runtimeIdProperty = $runtime.PSObject.Properties['runtime_id']
        if ($null -ne $runtimeIdProperty -and $null -ne $runtimeIdProperty.Value) { $runtimeId = [string] $runtimeIdProperty.Value }
      }
      if ($response.ok -eq $true -and $version -and $cohortMatches) {
        return [pscustomobject]@{ Ready = $true; Version = [string] $version; RuntimeId = $runtimeId; Error = $null }
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

# ---- Persisted ownership of the live Hub -----------------------------------
# A watcher can exit while the Hub it started keeps serving. Nothing else on the
# machine can tell a later watcher that such a listener is Crew's: port health
# says a process answers, not whose it is, and adopting on health alone would put
# a stranger's listener within reach of Stop-OwnedListener. So the identity is
# written down when it is established, and re-proven field by field — PID, start
# time, port, profile, Crew home and live runtime_id — before any later watcher
# adopts it. A record that merely exists is not authority; it may name a Hub from
# a previous cohort, another profile, or a PID the system has since recycled.

$crewOwnedServiceFile = Join-Path $crewSupervisorRoot 'owned-service.json'

function Write-OwnedServiceRecord {
  param([pscustomobject] $Service, [string] $RuntimeId = $null)
  if (-not $Service.CrewOwned -or -not $Service.RootPid -or -not $Service.RootStartedAtUtcTicks) { return }
  $record = @{
    schema_version = 1
    profile = [string] $Service.Profile
    home = [string] $Service.Home
    port = [int] $Service.Port
    root_pid = [int] $Service.RootPid
    root_started_at_utc_ticks = [long] $Service.RootStartedAtUtcTicks
    listener_pid = if ($Service.ListenerPid) { [int] $Service.ListenerPid } else { $null }
    listener_started_at_utc_ticks = if ($Service.ListenerStartedAtUtcTicks) { [long] $Service.ListenerStartedAtUtcTicks } else { $null }
    runtime_id = $RuntimeId
    recorded_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json -Compress
  try {
    if (-not (Test-Path -LiteralPath $crewSupervisorRoot -PathType Container)) { New-Item -ItemType Directory -Path $crewSupervisorRoot -Force | Out-Null }
    $temp = Join-Path $crewSupervisorRoot ("owned-service.{0}.tmp" -f $PID)
    Write-Utf8NoBom -Path $temp -Content $record
    Move-Item -LiteralPath $temp -Destination $crewOwnedServiceFile -Force
  } catch { /* ownership record is best-effort, like the heartbeat */ }
}

function Clear-OwnedServiceRecord {
  try {
    if (Test-Path -LiteralPath $crewOwnedServiceFile -PathType Leaf) { Remove-Item -LiteralPath $crewOwnedServiceFile -Force }
  } catch { }
}

function Get-OwnedServiceRecord {
  try {
    if (-not (Test-Path -LiteralPath $crewOwnedServiceFile -PathType Leaf)) { return $null }
    $record = Get-Content -LiteralPath $crewOwnedServiceFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($record.schema_version -ne 1) { return $null }
    return $record
  } catch {
    return $null
  }
}

function Restore-OwnedServiceRecord {
  param([pscustomobject] $Service, [pscustomobject] $Health = $null)
  if (-not $Service.CrewOwned) { return $false }
  $record = Get-OwnedServiceRecord
  if (-not $record) { return $false }
  if ([string] $record.profile -ne [string] $Service.Profile) { return $false }
  if ([string] $record.home -ne [string] $Service.Home) { return $false }
  if ([int] $record.port -ne [int] $Service.Port) { return $false }
  if (-not $record.root_pid -or -not $record.root_started_at_utc_ticks) { return $false }
  if (-not $record.listener_pid -or -not $record.listener_started_at_utc_ticks) { return $false }
  # Without this, an interrupted write could leave a record whose listener half is
  # simply absent, and "absent" must never read as "the Hub this record names".
  if ([string]::IsNullOrWhiteSpace([string] $record.runtime_id)) { return $false }
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    return $false
  }
  # Start times come from Get-Process, since Win32_Process carries none: the table
  # only has to establish that the PID exists before the ticks are compared.
  if (-not (Test-TrackedProcessIdentity -ProcessId ([int] $record.root_pid) -ExpectedStartTicks ([long] $record.root_started_at_utc_ticks) -ProcessTable $processes)) { return $false }
  if (-not (Test-TrackedProcessIdentity -ProcessId ([int] $record.listener_pid) -ExpectedStartTicks ([long] $record.listener_started_at_utc_ticks) -ProcessTable $processes)) { return $false }
  $port = Get-PortState $Service.Port
  if ($port.State -ne 'occupied' -or -not $port.Pid -or [int] $port.Pid -ne [int] $record.listener_pid) { return $false }
  $live = if ($Health) { $Health } else { Get-HealthState $Service }
  if (-not $live.Ready) { return $false }
  if ([string] $live.RuntimeId -ne [string] $record.runtime_id) { return $false }
  $Service.RootPid = [int] $record.root_pid
  $Service.RootStartedAtUtcTicks = [long] $record.root_started_at_utc_ticks
  $Service.ListenerPid = [int] $record.listener_pid
  $Service.ListenerStartedAtUtcTicks = [long] $record.listener_started_at_utc_ticks
  return $true
}

# Spawns the persistent watcher when no live one is present, and returns its
# heartbeat record when one already is. Shared so that the interactive and the
# blocking entries agree on what counts as "a supervisor is already running" —
# two answers to that question would let one entry spawn a duplicate that the
# mutex immediately kills.
function Start-CrewSupervisorProcess {
  $observed = Get-SupervisorHeartbeatRecord
  if ($observed -and $observed.State -eq 'legacy-v1') {
    throw 'CREW_SUPERVISOR_UPGRADE_REQUIRED: a legacy watcher is active and must be handed off before interactive launch.'
  }
  if ($observed) { return $observed }
  $arguments = @(Get-SupervisorLaunchArguments -ScriptPath $PSCommandPath)
  $watcher = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Write-LaunchLog ('Started persistent Crew supervisor; PID={0}.' -f $watcher.Id)
  return $null
}

# Waits only for the watcher to exist, not for 3210 to answer. The watcher
# publishes its heartbeat before it first touches the port, so this returns as
# soon as Crew is being supervised. Used by the interactive entry: 3080 is
# already serving by then, and making the operator's window wait for a first
# 3210 boot (measured 18-78s on this machine, longer under load) delays nothing
# they can see — the watcher performs that same wait either way.
function Wait-CrewSupervisorStarted {
  param([int] $TimeoutSeconds = 30)
  $observed = Start-CrewSupervisorProcess
  if ($observed) {
    Write-LaunchLog ('Persistent Crew supervisor already running; PID={0}.' -f $observed.Record.pid)
    return $true
  }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $record = Get-SupervisorHeartbeatRecord
    if ($record) {
      Write-LaunchLog ('Persistent Crew supervisor started; PID={0}; state={1}.' -f $record.Record.pid, $record.State)
      return $true
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Ensure-CrewSupervisorRunning {  param([int] $TimeoutSeconds = 90)
  $null = Start-CrewSupervisorProcess

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
  param([object] $Request, [bool] $FrontendStopped = $false)
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
      # Recorded so the matching start restores what this window stopped: the
      # 3080 frontend shares the workspace store the maintenance is rewriting.
      frontend_stopped = $FrontendStopped
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
      # `refresh_frontend` is how a history maintenance asks for the whole DSH
      # home to be quiet, not just 3210: the managed frontend shares the
      # workspace store this operation rewrites. The npx lifecycle does not ask,
      # because a runtime-tree swap does not touch that store.
      $refreshFrontend = $false
      if ($request.extra) {
        $refreshFlag = $request.extra.PSObject.Properties['refresh_frontend']
        $refreshFrontend = $null -ne $refreshFlag -and $refreshFlag.Value -eq $true
      }
      $frontendStopped = $false
      if ($refreshFrontend) {
        # Stopped BEFORE the backend: a failure here must abort with everything
        # still running. Aborting after 3210 is down would leave no session
        # published, and ordinary supervision would restart it mid-transaction.
        if (-not (Stop-CrewManagedFrontend)) {
          Write-MaintenanceResult $request 'SUPERVISOR_FRONTEND_STOP_FAILED'
          Write-LaunchLog ('Maintenance-stop {0} could not stop the Crew-managed frontend on 3080; nothing was stopped.' -f $request.request_id) 'ERROR'
          continue
        }
        $frontendStopped = $true
      }
      $port = Get-PortState $crew.Port
      if ($port.State -ne 'occupied' -or -not $port.Pid) {
        if ($frontendStopped) { Start-CrewManagedFrontendQuietly }
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
        $sessionDurable = Set-MaintenanceSession $request $frontendStopped
        if ($sessionDurable) {
          Write-MaintenanceResult $request 'STOPPED' @{ lease = $request.lease; stopped_runtime_id = $request.runtime_id; frontend_stopped = $frontendStopped }
          Write-LaunchLog ('Maintenance-stop {0} executed; lease issued.' -f $request.request_id)
        } else {
          Write-MaintenanceResult $request 'SUPERVISOR_SESSION_PERSIST_FAILED'
          Write-LaunchLog ('Maintenance-stop {0} stopped the process but the STOPPED session could not be persisted; NOT publishing STOPPED.' -f $request.request_id) 'ERROR'
        }
      } else {
        if ($frontendStopped) { Start-CrewManagedFrontendQuietly }
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
      $frontendProperty = $session.PSObject.Properties['frontend_stopped']
      $restoreFrontend = $null -ne $frontendProperty -and $frontendProperty.Value -eq $true
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
      # After the result, so a slow frontend boot never delays the transaction
      # this start is here to close.
      if ($restoreFrontend) { Start-CrewManagedFrontendQuietly }
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
  param([pscustomobject] $Service, [string] $RuntimeId = $null)
  $port = Get-PortState $Service.Port
  if ($port.State -ne 'occupied' -or -not $port.Pid) { return $false }
  $tree = @(Get-TrackedProcessTree -Service $Service)
  if ($port.Pid -notin $tree) { return $false }
  try {
    $listener = Get-Process -Id $port.Pid -ErrorAction Stop
    $Service.ListenerPid = [int] $port.Pid
    $Service.ListenerStartedAtUtcTicks = $listener.StartTime.ToUniversalTime().Ticks
    Write-OwnedServiceRecord -Service $Service -RuntimeId $RuntimeId
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

function Assert-HistoryStartAllowed {
  param([string] $StatePath = (Join-Path $crewHome '..\history\active.json'))
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  try {
    $state = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($state.schemaVersion -eq 1 -and $state.phase -in @('STARTING', 'VERIFYING', 'DONE', 'FAILED', 'ROLLED_BACK')) { return }
  } catch { }
  throw 'HISTORY_RECOVERY_REQUIRED: Crew history maintenance is unfinished. Run dsh-crew history recover. Official 3080 is unchanged.'
}

function Start-CrewService {
  param([pscustomobject] $Service)
  Assert-HistoryStartAllowed
  $serviceRunStamp = (Get-Date).ToString('yyyyMMdd-HHmmssfff')
  $stdout = Join-Path $logRoot ('dsh-crew-{0}-{1}-{2}.out.log' -f $Service.Profile, $Service.Port, $serviceRunStamp)
  $stderr = Join-Path $logRoot ('dsh-crew-{0}-{1}-{2}.err.log' -f $Service.Profile, $Service.Port, $serviceRunStamp)
  $previousHome = $env:DSH_HOME
  try {
    $env:DSH_HOME = $Service.Home
    $arguments = @('--profile', $Service.Profile, '--host', '127.0.0.1', '--port', [string] $Service.Port, '--no-open')
    $launchArguments = if ($dshCliIsNodeEntry) { @($dshCli) + $arguments } else { $arguments }
    $process = Start-Process -FilePath $dshCommand -ArgumentList $launchArguments -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $Service.Process = $process
    $Service.RootPid = $process.Id
    $Service.RootStartedAtUtcTicks = $process.StartTime.ToUniversalTime().Ticks
    $Service.ListenerPid = $null
    $Service.ListenerStartedAtUtcTicks = $null
    $Service.ConsecutiveFailures = 0
    $Service.State = 'starting'
    # Recorded before the Hub is healthy on purpose: the record is written again
    # with the listener identity once it is, and only that later write is
    # adoptable, because this one carries no runtime_id to prove itself against.
    Write-OwnedServiceRecord -Service $Service
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
        if ($service.CrewOwned -and -not $service.ListenerPid -and -not (Set-TrackedListenerIdentity -Service $service -RuntimeId $health.RuntimeId)) {
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
      # Say why, rather than clearing the field: an empty reason reaches the
      # startup wait as "deadline exceeded: dsh-crew:3210 ()", which reads like a
      # fault when the fence is the supervisor doing exactly as it was told.
      $service.LastError = 'a maintenance session holds the launch right (an update is mid-handoff); auto-start deferred'
      continue
    }
    $health = Get-HealthState $service
    if ($health.Ready) {
      $wasReady = $service.State -eq 'ready'
      if ($service.CrewOwned -and -not $service.ListenerPid) {
        # A watcher that exited leaves its Hub serving with nothing in memory to
        # say whose it is. Re-prove the persisted identity before touching it;
        # this is the only path by which a later watcher may adopt a live Hub,
        # and it never adopts on port health alone.
        if (Restore-OwnedServiceRecord -Service $service -Health $health) {
          Write-LaunchLog ('{0} on {1} recovered from the persisted ownership record; listener PID={2}.' -f $service.Name, $service.Port, $service.ListenerPid)
        }
      }
      if ($service.CrewOwned -and -not $service.ListenerPid -and -not (Set-TrackedListenerIdentity -Service $service -RuntimeId $health.RuntimeId)) {
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
        Clear-OwnedServiceRecord
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
    throw "DSH CLI was not found at $dshCli. Configure DSH_CREW_DSH_CLI to a Crew-owned official CLI entry, or run: npm install -g @ran-sh/dsh-crew@latest; dsh-crew update"
  }
  Test-CrewDshCliPreflight
  if (-not (Test-Path -LiteralPath (Join-Path $crewHome 'profiles\dsh-crew\package.json') -PathType Leaf)) {
    throw "The isolated dsh-crew profile is missing under $crewHome. Run: dsh-crew update"
  }
  if ($Mode -eq 'open') { Open-OfficialFrontend }
  # Background/watch modes remain independent of the official frontend.

  if ($Mode -eq 'watch') {
    Start-ServiceSupervisor
    Write-LaunchLog 'Supervisor stopped.' 'WARN'
    exit 0
  }

  if ($Mode -eq 'open') {
    # A desktop launch promises the frontend on 3080, and that is up in about a
    # second. The supervisor owns 3210 from the moment it starts — it publishes
    # its heartbeat before it first touches the port — so this waits for the
    # watcher to be running, reports where 3210 actually is, and returns. Holding
    # the operator's window for 3210 readiness bought nothing: the watcher is
    # doing that wait anyway, and under load a first boot here has taken 78s.
    if (-not (Wait-CrewSupervisorStarted)) {
      throw 'No Crew supervisor started within 30s; 3210 has nothing watching it.'
    }
    $crew = $services | Where-Object { $_.CrewOwned } | Select-Object -First 1
    $health = if ($crew) { Get-HealthState $crew } else { $null }
    if ($health -and $health.Ready) {
      Write-LaunchLog 'Official frontend is on 3080; Crew is ready on 3210.'
    } else {
      Write-LaunchLog ('Official frontend is on 3080; the supervisor is bringing 3210 up in the background. Last health: {0}' -f $health.Error) 'WARN'
    }
    # Operator-facing summary rather than a log line: clicking Crew before 3210
    # answers looks like a broken feature, so say that it is still coming up.
    Write-Host ''
    Write-Host 'DSH Crew: the frontend is on http://127.0.0.1:3080.' -ForegroundColor Green
    if ($health -and $health.Ready) {
      Write-Host 'Backend 3210 is ready.' -ForegroundColor Green
    } else {
      Write-Host 'Backend 3210 is still starting; Crew features appear once it answers.' -ForegroundColor Yellow
    }
    Write-Host ("Diagnostic log: {0}" -f $launcherLog) -ForegroundColor DarkGray
  } else {
    Ensure-CrewSupervisorRunning
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
