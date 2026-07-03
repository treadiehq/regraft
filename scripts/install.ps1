<#
.SYNOPSIS
  regraft installer for Windows — download a prebuilt binary and put it on your PATH.

.DESCRIPTION
  Run it directly from the web:

    irm https://raw.githubusercontent.com/treadiehq/regraft/main/scripts/install.ps1 | iex

  Environment overrides:
    REGRAFT_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
    REGRAFT_BIN_DIR   where to install regraft.exe (default: %LOCALAPPDATA%\regraft\bin)
    REGRAFT_REPO      owner/repo to download releases from (default: treadiehq/regraft)
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($msg) { Write-Host "-> $msg" -ForegroundColor DarkGray }
function Ok($msg)  { Write-Host "OK $msg"  -ForegroundColor Green }
function Die($msg) { Write-Host "x $msg"   -ForegroundColor Red; exit 1 }

$repo    = if ($env:REGRAFT_REPO)    { $env:REGRAFT_REPO }    else { 'treadiehq/regraft' }
$version = if ($env:REGRAFT_VERSION) { $env:REGRAFT_VERSION } else { 'latest' }
$binDir  = if ($env:REGRAFT_BIN_DIR) { $env:REGRAFT_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'regraft\bin' }

# Bun only ships a Windows x64 binary; it runs on ARM64 via emulation.
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Say "ARM64 detected — installing the x64 binary (runs under emulation)."
}

$asset = 'regraft-windows-x64.exe'
if ($version -eq 'latest') {
  $url = "https://github.com/$repo/releases/latest/download/$asset"
} else {
  $url = "https://github.com/$repo/releases/download/$version/$asset"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$dest = Join-Path $binDir 'regraft.exe'
$old  = "$dest.old"

# Clean up a stale copy left behind by a previous self-update, if it's no longer locked.
if (Test-Path $old) { try { Remove-Item $old -Force -ErrorAction Stop } catch {} }

Say "downloading $asset ($version)"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("regraft-" + [guid]::NewGuid().ToString('N') + '.exe')
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Die "download failed: $url`n  - no release asset for Windows yet, or`n  - the version tag does not exist (check: https://github.com/$repo/releases)"
}

# Windows locks a running .exe, but it can still be renamed — move the old one
# aside so an in-place `regraft update` works, then drop the freshly downloaded one in.
if (Test-Path $dest) {
  try { Move-Item -Path $dest -Destination $old -Force } catch {}
}
Move-Item -Path $tmp -Destination $dest -Force

try {
  $installed = (& $dest --version).Trim()
} catch {
  Die "the installed binary failed to run ($dest)"
}
Ok "installed regraft $installed -> $dest"

# --- ensure the install dir is on the user PATH ------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $userPath -and (($userPath -split ';') -contains $binDir)
if (-not $onPath) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$binDir"
  Say "added $binDir to your user PATH (restart terminals to pick it up)."
}

Write-Host ""
Ok "regraft installed. Get started with:"
Write-Host "    regraft add owner/repo/tree/main/src/components lib/components" -ForegroundColor White
Write-Host ""
Write-Host "Update later with:  regraft update" -ForegroundColor DarkGray
