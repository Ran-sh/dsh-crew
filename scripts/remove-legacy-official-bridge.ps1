# One-shot operator maintenance: remove the legacy official-web bridge state
# left behind BEFORE the read-only policy. This script is NEVER invoked by
# the dsh-crew installer; the product code never writes to ~/.dsh.
#
# Preconditions (fail closed unless ALL hold):
#   1. Official 3080 is stopped and no longer listening.
#   2. ~/.dsh/profiles/web/package.json dependencies["@ran-sh/dsh-crew-web-bridge"] exists.
#   3. dsh.profile.bundles contains "@ran-sh/dsh-crew-web-bridge".
#   4. node_modules/@ran-sh/dsh-crew-web-bridge is a symlink/junction whose
#      target is an old Crew release official-web-bridge dir.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/remove-legacy-official-bridge.ps1 [-WhatIf]

[CmdletBinding(SupportsShouldProcess = $true)]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BridgePackage = '@ran-sh/dsh-crew-web-bridge'
$officialManifest = Join-Path $env:USERPROFILE '.dsh\profiles\web\package.json'
$bridgeLink = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\@ran-sh\dsh-crew-web-bridge'
$crewState = Join-Path $env:USERPROFILE '.config\dsh-crew\official-web.json'

function Fail($message) {
  Write-Host "FAIL-CLOSED: $message" -ForegroundColor Red
  exit 2
}

# 1. Official 3080 must be stopped.
try {
  $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  if (@($listeners | Where-Object Port -eq 3080).Count -gt 0) {
    Fail 'official 3080 is still listening; stop it before cleanup.'
  }
} catch {
  Fail "could not enumerate TCP listeners: $($_.Exception.Message)"
}

# 2. Read + back up the official manifest (backup goes OUTSIDE .dsh).
if (-not (Test-Path -LiteralPath $officialManifest -PathType Leaf)) {
  Fail "official manifest not found: $officialManifest"
}
$backup = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web-package.pre-crew-bridge-removal.json'
if ($PSCmdlet.ShouldProcess($officialManifest, "backup to $backup")) {
  Copy-Item -LiteralPath $officialManifest -Destination $backup -Force
  Write-Host "Backup: $backup"
}

$manifest = Get-Content -LiteralPath $officialManifest -Raw | ConvertFrom-Json -ErrorAction Stop
if (-not $manifest.dependencies.$BridgePackage) {
  Fail 'bridge dependency key absent; nothing to clean.'
}
if (-not ($manifest.dsh.profile.bundles -contains $BridgePackage)) {
  Fail 'bridge bundle entry absent; nothing to clean.'
}

# 3. The link must be a symlink/junction pointing at an old Crew release bridge.
$link = Get-Item -LiteralPath $bridgeLink -ErrorAction SilentlyContinue
if (-not $link -or $link.LinkType -notin @('SymbolicLink', 'Junction')) {
  Fail 'bridge link is not a symlink/junction; refusing to touch unknown state.'
}
$target = $link.Target
if (-not $target) {
  $target = (Get-Item -LiteralPath $bridgeLink).FullName
}
if ($target -notmatch 'dsh-crew.*official-web-bridge') {
  Fail "bridge link target does not look like a Crew release bridge: $target"
}

# 4. Remove ONLY the dependency key, the bundle entry, and the link.
if ($PSCmdlet.ShouldProcess($officialManifest, 'remove legacy bridge entries')) {
  $raw = Get-Content -LiteralPath $officialManifest -Raw | ConvertFrom-Json
  $raw.dependencies.PSObject.Properties.Remove($BridgePackage)
  $raw.dsh.profile.bundles = @($raw.dsh.profile.bundles | Where-Object { $_ -ne $BridgePackage })
  $raw | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $officialManifest -Encoding UTF8
  Remove-Item -LiteralPath $bridgeLink -Force
  Write-Host 'Removed bridge dependency key, bundle entry, and link.'
}

# 5. Remove Crew-owned legacy intent/state (Crew-owned path, safe to delete).
if ($PSCmdlet.ShouldProcess($crewState, 'remove legacy Crew bridge state')) {
  Remove-Item -LiteralPath $crewState -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed Crew-owned legacy bridge state (if present).'
}

Write-Host 'Done. Restart official 3080 natively; verify:'
Write-Host '  - 3080 / is 2xx/3xx and /_dsh/dsh-crew/{ping,bridge-status,supervisor/restart} are gone'
Write-Host '  - 3210 /_dsh/dsh-crew/extension identity is correct (Crew launcher owns 3210 directly)'
