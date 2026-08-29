# DSH Crew managed Windows launcher
[CmdletBinding()]
param(
  [ValidateSet('background', 'open')]
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
$runStamp = $startedAt.ToString('yyyyMMdd-HHmmss')
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
  $client = $null
  $async = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(800, $false)) {
      return [pscustomobject]@{ State = 'unknown'; Error = 'TCP probe timed out.'; Pid = $null }
    }
    $client.EndConnect($async)
    $ownerPid = $null
    try {
      $ownerPid = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1).OwningProcess
    } catch { }
    return [pscustomobject]@{ State = 'occupied'; Error = $null; Pid = $ownerPid }
  } catch [System.Net.Sockets.SocketException] {
    return [pscustomobject]@{ State = 'free'; Error = $null; Pid = $null }
  } catch {
    return [pscustomobject]@{ State = 'unknown'; Error = $_.Exception.Message; Pid = $null }
  } finally {
    if ($async -and $async.AsyncWaitHandle) { $async.AsyncWaitHandle.Close() }
    if ($client) { $client.Close() }
  }
}

function Start-CrewService {
  param([pscustomobject] $Service)
  $stdout = Join-Path $logRoot ('dsh-crew-{0}-{1}-{2}.out.log' -f $Service.Profile, $Service.Port, $runStamp)
  $stderr = Join-Path $logRoot ('dsh-crew-{0}-{1}-{2}.err.log' -f $Service.Profile, $Service.Port, $runStamp)
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

  foreach ($service in $services) {
    $health = Get-HealthState $service
    if ($health.Ready) {
      $service.State = 'ready'
      Write-LaunchLog ('{0} already ready on {1}; runtime={2}' -f $service.Name, $service.Port, $health.Version)
      continue
    }

    $port = Get-PortState $service.Port
    if ($port.State -eq 'occupied') {
      $owner = if ($port.Pid) { "; listener PID=$($port.Pid)" } else { '' }
      throw ('Port {0} is occupied, but {1} failed its health contract{2}. Health error: {3}' -f $service.Port, $service.Name, $owner, $health.Error)
    }
    if ($port.State -ne 'free') {
      throw ('Could not determine whether port {0} is available: {1}' -f $service.Port, $port.Error)
    }
    Start-CrewService $service
  }

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
