# DarkCode CLI installer (Windows).
#
#   irm https://darkcode.sh/install.ps1 | iex
#
# Downloads the prebuilt standalone binary from the latest GitHub Release,
# verifies its checksum, installs it to %USERPROFILE%\.darkcode\bin, and adds
# that to your user PATH. Override the install dir with $env:DARKCODE_INSTALL.

$ErrorActionPreference = 'Stop'

$repo = if ($env:DARKCODE_REPO) { $env:DARKCODE_REPO } else { 'vufhq/darkcode' }
$installDir = if ($env:DARKCODE_INSTALL) { $env:DARKCODE_INSTALL } else { Join-Path $env:USERPROFILE '.darkcode\bin' }

# Only an x64 build is published; Windows on ARM runs it via emulation.
$arch = 'x64'
$asset = "darkcode-windows-$arch.zip"
$url = "https://github.com/$repo/releases/latest/download/$asset"

Write-Host "> Downloading darkcode (windows-$arch)..." -ForegroundColor Cyan

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("darkcode-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zip = Join-Path $tmp $asset
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  } catch {
    throw "Download failed: $url`nThe release asset may not exist yet, or the repository's releases are private."
  }

  # Verify checksum (best effort).
  try {
    Invoke-WebRequest -Uri "$url.sha256" -OutFile "$zip.sha256" -UseBasicParsing
    $expected = (((Get-Content "$zip.sha256" -Raw).Trim()) -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($expected -and ($expected -ne $actual)) { throw "Checksum mismatch - refusing to install." }
    if ($expected) { Write-Host "> Checksum verified." -ForegroundColor Cyan }
  } catch {
    if ($_.Exception.Message -like '*Checksum mismatch*') { throw }
  }

  Write-Host "> Installing to $installDir..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Copy-Item -Path (Join-Path $tmp 'darkcode.exe') -Destination (Join-Path $installDir 'darkcode.exe') -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Add to user PATH if missing.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if ($userPath -notlike "*$installDir*") {
  $newPath = if ($userPath) { "$installDir;$userPath" } else { $installDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$installDir;$env:Path"
  Write-Host "> Added $installDir to your PATH (takes effect in new terminals)." -ForegroundColor Cyan
}

$version = & (Join-Path $installDir 'darkcode.exe') --version
Write-Host ""
Write-Host "OK darkcode $version installed -> $installDir\darkcode.exe" -ForegroundColor Green
Write-Host ""
Write-Host "Open a new terminal and run 'darkcode' to get started, then /login."
