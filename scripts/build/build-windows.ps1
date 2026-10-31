<#
.SYNOPSIS
  Release build for Windows, run on Windows (x64).

.DESCRIPTION
  Checks the tools, installs exactly what package-lock.json names (npm ci), runs lint, the type check and the unit
  tests, builds the NSIS installer (dist\hf-cache-manager-<version>-setup.exe) with npm run build:win, and prints
  where it is, with its size and SHA-256.

  Code signing is optional. With CSC_LINK (or WIN_CSC_LINK) and CSC_KEY_PASSWORD (or WIN_CSC_KEY_PASSWORD) set to a
  code-signing certificate (.pfx) and its password, electron-builder signs the app and the installer. Without them
  the build is unsigned and SmartScreen warns on first run (More info, then Run anyway).

  The same build step (npm run build:win) also makes the installer on Linux, where electron-builder needs Wine to
  finish it; this script is for building it on Windows, where no Wine is needed.

.PARAMETER E2E
  Also run the end-to-end suite against the build (npm run e2e).

.PARAMETER SkipChecks
  Skip lint, the type check and the unit tests (not for a release).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build\build-windows.ps1
#>
[CmdletBinding()]
param(
  [switch]$E2E,
  [switch]$SkipChecks
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host "build-windows: $Text" -ForegroundColor Red; exit 1 }

# Runs a native command and stops when it fails ($ErrorActionPreference does not apply to native commands' exit codes
# in Windows PowerShell 5.1).
function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "$Exe $($Arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

Step 'Checking prerequisites'
if ($env:OS -ne 'Windows_NT') { Fail 'this script runs on Windows; on Linux use npm run build:win or scripts/build/build-linux.sh' }
$Arch = $env:PROCESSOR_ARCHITEW6432
if (-not $Arch) { $Arch = $env:PROCESSOR_ARCHITECTURE }
if ($Arch -ne 'AMD64') { Fail "the Windows build is x64; this machine is $Arch" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed (see package.json engines)' }
# npm.cmd, not npm: the npm.ps1 shim can be blocked by the execution policy.
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail 'npm is not installed' }
$Npm = 'npm.cmd'
Invoke-Checked 'node' @('scripts/build/check-node.mjs')
Write-Host "npm $(& $Npm --version)"
if (Get-Command git -ErrorAction SilentlyContinue) {
  $dirty = & git status --porcelain 2>$null
  if ($dirty) { Write-Host 'note: the working tree has uncommitted changes; they go into this build' }
}
$Version = (& node -p "require('./package.json').version").Trim()
Write-Host "Building HF Cache Manager $Version for Windows"

$HasCert = ($env:CSC_LINK -or $env:WIN_CSC_LINK)
if ($HasCert) {
  Write-Host 'Signing: a certificate is set (CSC_LINK or WIN_CSC_LINK); the app and installer will be signed'
} else {
  Write-Host 'Signing: no CSC_LINK or WIN_CSC_LINK; building UNSIGNED.'
  Write-Host '  SmartScreen warns on first run: More info, then Run anyway.'
  # Keeps electron-builder from looking for a certificate in the store.
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
}

Step 'Installing dependencies (npm ci)'
Invoke-Checked $Npm @('ci')

if (-not $SkipChecks) {
  Step 'Lint'
  Invoke-Checked $Npm @('run', 'lint')
  Step 'Type check'
  Invoke-Checked $Npm @('run', 'typecheck')
  Step 'Unit tests'
  Invoke-Checked $Npm @('test')
}

Step 'Building the installer (npm run build:win)'
Invoke-Checked $Npm @('run', 'build:win')

if ($E2E) {
  Step 'End-to-end tests (npm run e2e)'
  Invoke-Checked $Npm @('run', 'e2e')
}

Step 'Artifacts'
$Found = @(Get-ChildItem -Path 'dist' -Filter "*-$Version-setup.exe" -File -ErrorAction SilentlyContinue)
if ($Found.Count -eq 0) { Fail "no installer for $Version in dist\" }
foreach ($f in $Found) {
  $mb = '{0:N1} MB' -f ($f.Length / 1MB)
  $sum = (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash.ToLowerInvariant()
  Write-Host "  $($f.FullName)  $mb"
  Write-Host "  sha256 $sum"
}
Write-Host "  unpacked app: $(Join-Path $Root 'dist\win-unpacked')"
if (-not $HasCert) { Write-Host ''; Write-Host 'This build is not code signed; see the Signing note above.' }
