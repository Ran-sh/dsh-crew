# DSH Crew Windows supervisor process control
#
# Reads one JSON request from stdin and writes exactly one JSON response to
# stdout. This helper deliberately controls one verified watcher PID at a
# time; it never uses process-tree termination.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DshCrewSupervisorControl {
  public static class NativeProcess {
    private const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int informationClass,
      IntPtr information,
      int informationLength,
      out int returnLength);

    public static string ReadCommandLine(IntPtr process) {
      int length;
      NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
      if (length <= 0 || length > 1024 * 1024) {
        throw new InvalidOperationException("Process command line length is unavailable or unsafe.");
      }
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int returned;
        int status = NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, length, out returned);
        if (status != 0) throw new InvalidOperationException("Process command line query failed.");
        UNICODE_STRING value = (UNICODE_STRING)Marshal.PtrToStructure(buffer, typeof(UNICODE_STRING));
        if (value.Buffer == IntPtr.Zero || value.Length == 0) return String.Empty;
        return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }
}
'@ | Out-Null

function Throw-ControlFailure {
  param(
    [Parameter(Mandatory = $true)] [string] $Code,
    [Parameter(Mandatory = $true)] [string] $Message
  )
  $failure = New-Object System.InvalidOperationException($Message)
  $failure.Data['dsh_crew_control_code'] = $Code
  throw $failure
}

function Get-RequestProperty {
  param(
    [Parameter(Mandatory = $true)] [psobject] $Request,
    [Parameter(Mandatory = $true)] [string] $Name,
    [bool] $Required = $false
  )
  $property = $Request.PSObject.Properties[$Name]
  if ($null -eq $property) {
    if ($Required) { Throw-ControlFailure 'REQUEST_INVALID' ("Missing required field: {0}." -f $Name) }
    return $null
  }
  return $property.Value
}

function Get-IdentitySource {
  param([Parameter(Mandatory = $true)] [psobject] $Request)
  $expected = Get-RequestProperty -Request $Request -Name 'expected'
  if ($null -ne $expected) {
    if ($expected -isnot [psobject] -or $expected -is [string]) {
      Throw-ControlFailure 'REQUEST_INVALID' 'The expected field must be an object.'
    }
    return $expected
  }
  return $Request
}

function Get-CanonicalHelperPath {
  param([object] $Value)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 32768) {
    Throw-ControlFailure 'HELPER_PATH_INVALID' 'helper_path must be a non-empty absolute path.'
  }
  if (-not [System.IO.Path]::IsPathRooted($Value) -or $Value.Contains('"')) {
    Throw-ControlFailure 'HELPER_PATH_INVALID' 'helper_path must be a safe absolute path.'
  }
  try {
    $fullPath = [System.IO.Path]::GetFullPath($Value)
  } catch {
    Throw-ControlFailure 'HELPER_PATH_INVALID' 'helper_path could not be normalized.'
  }
  if (-not [string]::Equals([System.IO.Path]::GetFileName($fullPath), 'start-dsh-crew.ps1', [System.StringComparison]::OrdinalIgnoreCase)) {
    Throw-ControlFailure 'HELPER_PATH_INVALID' 'The managed helper must be named start-dsh-crew.ps1.'
  }
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    Throw-ControlFailure 'HELPER_PATH_NOT_FOUND' 'The expected managed helper does not exist.'
  }
  try {
    return (Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop).FullName
  } catch {
    Throw-ControlFailure 'HELPER_PATH_INVALID' 'The expected managed helper cannot be inspected.'
  }
}

function Get-HelperHash {
  param([Parameter(Mandatory = $true)] [string] $HelperPath)
  $stream = $null
  $sha256 = $null
  try {
    $stream = [System.IO.File]::Open($HelperPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } catch {
    Throw-ControlFailure 'HELPER_HASH_UNAVAILABLE' ('The expected managed helper could not be hashed: {0}' -f $_.Exception.Message)
  } finally {
    if ($null -ne $sha256) { $sha256.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Get-ExpectedIdentity {
  param(
    [Parameter(Mandatory = $true)] [psobject] $Request,
    [bool] $RequireExact = $false
  )
  $source = Get-IdentitySource -Request $Request
  $pidValue = Get-RequestProperty -Request $source -Name 'pid' -Required $true
  try {
    $pid64 = [long] $pidValue
  } catch {
    Throw-ControlFailure 'REQUEST_INVALID' 'pid must be a positive integer.'
  }
  if ($pid64 -le 0 -or $pid64 -gt [int]::MaxValue -or $pidValue.ToString() -notmatch '^\d+$') {
    Throw-ControlFailure 'REQUEST_INVALID' 'pid must be a positive integer.'
  }

  $ticksValue = Get-RequestProperty -Request $source -Name 'process_started_at_utc_ticks' -Required $RequireExact
  if ($null -ne $ticksValue -and ($ticksValue -isnot [string] -or $ticksValue -notmatch '^\d+$' -or $ticksValue -eq '0')) {
    Throw-ControlFailure 'REQUEST_INVALID' 'process_started_at_utc_ticks must be a positive decimal string.'
  }

  $hashValue = Get-RequestProperty -Request $source -Name 'helper_hash' -Required $RequireExact
  if ($null -ne $hashValue -and ($hashValue -isnot [string] -or $hashValue -notmatch '^[a-fA-F0-9]{64}$')) {
    Throw-ControlFailure 'REQUEST_INVALID' 'helper_hash must be a SHA-256 hex digest when supplied.'
  }
  return [pscustomobject]@{
    pid = [int] $pid64
    process_started_at_utc_ticks = $ticksValue
    helper_hash = if ($null -eq $hashValue) { $null } else { $hashValue.ToLowerInvariant() }
  }
}

function Test-SamePath {
  param([string] $Left, [string] $Right)
  try {
    $leftFull = [System.IO.Path]::GetFullPath($Left)
    $rightFull = [System.IO.Path]::GetFullPath($Right)
    return [string]::Equals($leftFull, $rightFull, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function ConvertFrom-WindowsCommandLine {
  param([Parameter(Mandatory = $true)] [string] $CommandLine)
  $tokens = New-Object System.Collections.Generic.List[string]
  $length = $CommandLine.Length
  $index = 0
  while ($index -lt $length) {
    while ($index -lt $length -and [char]::IsWhiteSpace($CommandLine[$index])) { $index++ }
    if ($index -ge $length) { break }

    $value = New-Object System.Text.StringBuilder
    $inQuotes = $false
    while ($index -lt $length) {
      $character = $CommandLine[$index]
      if ($character -eq '\') {
        $slashStart = $index
        while ($index -lt $length -and $CommandLine[$index] -eq '\') { $index++ }
        $slashCount = $index - $slashStart
        if ($index -lt $length -and $CommandLine[$index] -eq '"') {
          for ($slash = 0; $slash -lt [Math]::Floor($slashCount / 2); $slash++) { $value.Append('\') | Out-Null }
          if ($slashCount % 2 -eq 0) { $inQuotes = -not $inQuotes } else { $value.Append('"') | Out-Null }
          $index++
        } else {
          for ($slash = 0; $slash -lt $slashCount; $slash++) { $value.Append('\') | Out-Null }
        }
        continue
      }
      if ($character -eq '"') {
        if ($inQuotes -and $index + 1 -lt $length -and $CommandLine[$index + 1] -eq '"') {
          $value.Append('"') | Out-Null
          $index += 2
        } else {
          $inQuotes = -not $inQuotes
          $index++
        }
        continue
      }
      if (-not $inQuotes -and [char]::IsWhiteSpace($character)) { break }
      $value.Append($character) | Out-Null
      $index++
    }
    $tokens.Add($value.ToString())
    while ($index -lt $length -and [char]::IsWhiteSpace($CommandLine[$index])) { $index++ }
  }
  return $tokens.ToArray()
}

function Test-ExactManagedCommand {
  param(
    [Parameter(Mandatory = $true)] [string] $CommandLine,
    [Parameter(Mandatory = $true)] [string] $HelperPath
  )
  $tokens = @(ConvertFrom-WindowsCommandLine -CommandLine $CommandLine)
  # MainModule already proves token 0 is the canonical powershell.exe. Require
  # the complete remaining argv so additional script arguments or alternate
  # execution modes cannot hide behind one valid -File/-Mode pair.
  if ($tokens.Count -ne 10) { return $false }
  $expected = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')
  for ($index = 0; $index -lt $expected.Count; $index++) {
    if (-not [string]::Equals($tokens[$index + 1], $expected[$index], [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  if (-not (Test-SamePath -Left $tokens[7] -Right $HelperPath)) { return $false }
  if (-not [string]::Equals($tokens[8], '-Mode', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  return [string]::Equals($tokens[9], 'watch', [System.StringComparison]::OrdinalIgnoreCase)
}

function Open-VerifiedManagedWatcher {
  param(
    [Parameter(Mandatory = $true)] [string] $HelperPath,
    [Parameter(Mandatory = $true)] [pscustomobject] $Expected,
    [bool] $AllowHelperDrift = $false
  )
  $helperHash = Get-HelperHash -HelperPath $HelperPath
  if (-not $AllowHelperDrift -and $null -ne $Expected.helper_hash -and -not [string]::Equals($Expected.helper_hash, $helperHash, [System.StringComparison]::OrdinalIgnoreCase)) {
    Throw-ControlFailure 'HELPER_HASH_MISMATCH' 'The managed helper hash no longer matches the expected watcher identity.'
  }

  $process = $null
  try {
    $process = Get-Process -Id $Expected.pid -ErrorAction Stop
  } catch {
    Throw-ControlFailure 'PROCESS_NOT_FOUND' 'The expected watcher PID is not live.'
  }
  try {
    # Force one native process handle open and keep it live through every
    # identity check (and through Kill for stop). Windows does not recycle the
    # PID while this process object holds the underlying kernel object.
    $openedHandle = $process.Handle
    if ($openedHandle -eq [IntPtr]::Zero) { throw 'process handle is unavailable' }
    $actualTicks = $process.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    if ($null -ne $process) { $process.Dispose() }
    Throw-ControlFailure 'PROCESS_METADATA_UNAVAILABLE' 'The expected watcher process identity metadata is unavailable.'
  }
  if ($null -ne $Expected.process_started_at_utc_ticks -and -not [string]::Equals($actualTicks, $Expected.process_started_at_utc_ticks, [System.StringComparison]::Ordinal)) {
    $process.Dispose()
    Throw-ControlFailure 'PROCESS_START_TIME_MISMATCH' 'The watcher PID belongs to a different process lifetime.'
  }

  try {
    $executablePath = $process.MainModule.FileName
    $commandLine = [DshCrewSupervisorControl.NativeProcess]::ReadCommandLine($openedHandle)
  } catch {
    $process.Dispose()
    Throw-ControlFailure 'PROCESS_METADATA_UNAVAILABLE' 'The watcher process metadata could not be read.'
  }
  if ([string]::IsNullOrWhiteSpace($executablePath)) {
    $process.Dispose()
    Throw-ControlFailure 'PROCESS_METADATA_UNAVAILABLE' 'The watcher executable path is unavailable.'
  }
  $expectedPowerShellPath = Join-Path $PSHOME 'powershell.exe'
  if (-not [string]::Equals(
    [System.IO.Path]::GetFullPath($executablePath),
    [System.IO.Path]::GetFullPath($expectedPowerShellPath),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    $process.Dispose()
    Throw-ControlFailure 'PROCESS_EXECUTABLE_MISMATCH' 'The watcher PID is not powershell.exe.'
  }
  if ([string]::IsNullOrWhiteSpace($commandLine) -or -not (Test-ExactManagedCommand -CommandLine $commandLine -HelperPath $HelperPath)) {
    $process.Dispose()
    Throw-ControlFailure 'PROCESS_COMMAND_MISMATCH' 'The watcher command line does not name the exact managed helper in watch mode.'
  }

  return [pscustomobject]@{
    Process = $process
    Watcher = [pscustomobject]@{
      pid = $Expected.pid
      process_started_at_utc_ticks = $actualTicks
      # A running PowerShell process has already loaded its script. During an
      # upgrade the stable helper file is replaced before handoff, so its
      # current disk hash is the target hash, not the old process's attested
      # hash. Drift is allowed only with the full PID/start/hash identity and
      # the exact managed command line; preserve that attested old hash here.
      helper_hash = if ($AllowHelperDrift) { $Expected.helper_hash } else { $helperHash }
    }
  }
}

function Get-ExactManagedWatcher {
  param(
    [Parameter(Mandatory = $true)] [string] $HelperPath,
    [Parameter(Mandatory = $true)] [pscustomobject] $Expected,
    [bool] $AllowHelperDrift = $false
  )
  $opened = Open-VerifiedManagedWatcher -HelperPath $HelperPath -Expected $Expected -AllowHelperDrift $AllowHelperDrift
  try {
    return $opened.Watcher
  } finally {
    $opened.Process.Dispose()
  }
}

function Start-ExactManagedWatcher {
  param([Parameter(Mandatory = $true)] [string] $HelperPath)
  $powerShellPath = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    Throw-ControlFailure 'POWERSHELL_NOT_FOUND' 'powershell.exe is unavailable.'
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powerShellPath
  $startInfo.Arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode watch' -f $HelperPath)
  # Shell execution prevents the long-lived watcher from inheriting this
  # controller's JSON stdout/stderr pipe handles.
  $startInfo.UseShellExecute = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  try {
    $started = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $started) { throw 'Process.Start returned no process.' }
    $startedTicks = $started.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    Throw-ControlFailure 'PROCESS_START_FAILED' 'The managed watcher could not be started.'
  }

  $expected = [pscustomobject]@{
    pid = [int] $started.Id
    process_started_at_utc_ticks = $startedTicks
    helper_hash = (Get-HelperHash -HelperPath $HelperPath)
  }
  $lastFailure = $null
  Start-Sleep -Milliseconds 100
  try {
    return Get-ExactManagedWatcher -HelperPath $HelperPath -Expected $expected
  } catch {
    $lastFailure = $_.Exception
  }

  # The Process object identifies the exact child started above. Cleanup is
  # single-process only; no child tree or unrelated PID is touched.
  try {
    if (-not $started.HasExited) { $started.Kill() }
  } catch { }
  if ($null -ne $lastFailure -and $lastFailure.Data.Contains('dsh_crew_control_code')) {
    Throw-ControlFailure ([string] $lastFailure.Data['dsh_crew_control_code']) $lastFailure.Message
  }
  Throw-ControlFailure 'PROCESS_START_VERIFY_FAILED' 'The newly started managed watcher could not be verified.'
}

function Stop-ExactManagedWatcher {
  param(
    [Parameter(Mandatory = $true)] [string] $HelperPath,
    [Parameter(Mandatory = $true)] [pscustomobject] $Expected,
    [bool] $AllowHelperDrift = $false
  )
  $opened = Open-VerifiedManagedWatcher -HelperPath $HelperPath -Expected $Expected -AllowHelperDrift $AllowHelperDrift
  $watcher = $opened.Watcher
  try {
    $opened.Process.Kill()
    if (-not $opened.Process.WaitForExit(5000)) {
      Throw-ControlFailure 'PROCESS_STOP_TIMEOUT' 'The exact managed watcher did not exit before the timeout.'
    }
  } catch {
    if ($_.Exception.Data.Contains('dsh_crew_control_code')) { throw }
    Throw-ControlFailure 'PROCESS_STOP_FAILED' 'The exact managed watcher could not be stopped.'
  } finally {
    $opened.Process.Dispose()
  }
  return $watcher
}

$response = $null
$exitCode = 0
try {
  $rawRequest = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawRequest)) {
    Throw-ControlFailure 'REQUEST_INVALID' 'A JSON request is required on stdin.'
  }
  try {
    $request = $rawRequest | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Throw-ControlFailure 'REQUEST_JSON_INVALID' 'The stdin request is not valid JSON.'
  }
  if ($null -eq $request -or $request -is [System.Array] -or $request -is [string]) {
    Throw-ControlFailure 'REQUEST_INVALID' 'The JSON request must be an object.'
  }
  $operationValue = Get-RequestProperty -Request $request -Name 'operation' -Required $true
  if ($operationValue -isnot [string]) {
    Throw-ControlFailure 'REQUEST_INVALID' 'operation must be a string.'
  }
  $operation = $operationValue.ToLowerInvariant()
  if ($operation -notin @('inspect', 'start', 'stop')) {
    Throw-ControlFailure 'OPERATION_UNSUPPORTED' 'operation must be inspect, start, or stop.'
  }
  $helperPath = Get-CanonicalHelperPath (Get-RequestProperty -Request $request -Name 'helper_path' -Required $true)
  $allowHelperDriftValue = Get-RequestProperty -Request $request -Name 'allow_helper_drift'
  if ($null -ne $allowHelperDriftValue -and $allowHelperDriftValue -isnot [bool]) {
    Throw-ControlFailure 'REQUEST_INVALID' 'allow_helper_drift must be a boolean when supplied.'
  }
  $allowHelperDrift = $allowHelperDriftValue -eq $true
  if ($operation -eq 'start' -and $allowHelperDrift) {
    Throw-ControlFailure 'REQUEST_INVALID' 'allow_helper_drift is not valid for start.'
  }

  if ($operation -eq 'start') {
    $requestedHash = Get-RequestProperty -Request $request -Name 'helper_hash' -Required $true
    if ($requestedHash -isnot [string] -or $requestedHash -notmatch '^[a-fA-F0-9]{64}$') {
      Throw-ControlFailure 'REQUEST_INVALID' 'helper_hash must be the expected SHA-256 digest for start.'
    }
    $actualHash = Get-HelperHash -HelperPath $helperPath
    if (-not [string]::Equals($requestedHash, $actualHash, [System.StringComparison]::OrdinalIgnoreCase)) {
      Throw-ControlFailure 'HELPER_HASH_MISMATCH' 'Refusing to start a managed helper whose hash differs from the target.'
    }
    $watcher = Start-ExactManagedWatcher -HelperPath $helperPath
    $response = [pscustomobject]@{ ok = $true; operation = 'start'; watcher = $watcher }
  } else {
    $expected = Get-ExpectedIdentity -Request $request -RequireExact ($operation -eq 'stop' -or $allowHelperDrift)
    if ($operation -eq 'inspect') {
      $watcher = Get-ExactManagedWatcher -HelperPath $helperPath -Expected $expected -AllowHelperDrift $allowHelperDrift
      $response = [pscustomobject]@{ ok = $true; operation = 'inspect'; watcher = $watcher }
    } else {
      $watcher = Stop-ExactManagedWatcher -HelperPath $helperPath -Expected $expected -AllowHelperDrift $allowHelperDrift
      $response = [pscustomobject]@{ ok = $true; operation = 'stop'; stopped = $true; watcher = $watcher }
    }
  }
} catch {
  $exitCode = 1
  $code = if ($_.Exception.Data.Contains('dsh_crew_control_code')) {
    [string] $_.Exception.Data['dsh_crew_control_code']
  } else {
    'SUPERVISOR_CONTROL_FAILED'
  }
  $response = [pscustomobject]@{
    ok = $false
    code = $code
    error = $_.Exception.Message
  }
}

[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 6))
exit $exitCode
