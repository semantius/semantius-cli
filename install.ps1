# Install script for semantius-cli (Windows)
# Usage: irm https://raw.githubusercontent.com/semantius/semantius-cli/main/install.ps1 | iex

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Semantius"
)

$ErrorActionPreference = 'Stop'

# Colors via Write-Host
function Write-Green  { param($msg) Write-Host $msg -ForegroundColor Green }
function Write-Yellow { param($msg) Write-Host $msg -ForegroundColor Yellow }
function Write-Blue   { param($msg) Write-Host $msg -ForegroundColor Cyan }
function Write-Red    { param($msg) Write-Host $msg -ForegroundColor Red }

# Detect architecture
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($arch) {
    'X64'   { $binary = 'semantius-windows-x64.exe' }
    'Arm64' { $binary = 'semantius-windows-arm64.exe' }
    default {
        Write-Red "Unsupported architecture: $arch"
        exit 1
    }
}

$githubRepo = 'semantius/semantius-cli'
$downloadUrl = "https://github.com/$githubRepo/releases/latest/download/$binary"
$checksumUrl = "https://github.com/$githubRepo/releases/latest/download/checksums.txt"
$destExe     = Join-Path $InstallDir 'semantius.exe'

# Print banner
Write-Host ""
Write-Host "Installing semantius" -ForegroundColor White -BackgroundColor DarkBlue
Write-Host ""
Write-Host "  Platform  : Windows/$arch"
Write-Host "  Binary    : $binary"
Write-Host "  Location  : $destExe"
Write-Host ""

# Check for existing installation
if (Get-Command 'semantius' -ErrorAction SilentlyContinue) {
    $existingVersion = & semantius --version 2>$null
    Write-Yellow "Note: Updating existing installation ($existingVersion)"
    Write-Host ""
}

# Create install directory if needed
if (-not (Test-Path $InstallDir)) {
    Write-Blue "Creating $InstallDir..."
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Download binary
Write-Blue "Downloading $binary..."
$tmpFile = [System.IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing
} catch {
    Write-Red "Failed to download binary. Check if releases exist at:"
    Write-Host "  https://github.com/$githubRepo/releases"
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
    exit 1
}

# Verify checksum (if available)
$tmpChecksum = [System.IO.Path]::GetTempFileName()
try {
    Invoke-WebRequest -Uri $checksumUrl -OutFile $tmpChecksum -UseBasicParsing -ErrorAction SilentlyContinue
    $checksumContent = Get-Content $tmpChecksum -ErrorAction SilentlyContinue
    if ($checksumContent) {
        $expectedLine = $checksumContent | Where-Object { $_ -match $binary }
        if ($expectedLine) {
            $expectedHash = ($expectedLine -split '\s+')[0].ToUpper()
            Write-Blue "Verifying checksum..."
            $actualHash = (Get-FileHash $tmpFile -Algorithm SHA256).Hash.ToUpper()
            if ($expectedHash -ne $actualHash) {
                Write-Red "Checksum verification failed!"
                Write-Host "Expected: $expectedHash"
                Write-Host "Actual  : $actualHash"
                Remove-Item $tmpFile -ErrorAction SilentlyContinue
                Remove-Item $tmpChecksum -ErrorAction SilentlyContinue
                exit 1
            }
            Write-Green "Checksum verified"
        }
    }
} catch {
    Write-Yellow "Warning: Could not verify checksum"
} finally {
    Remove-Item $tmpChecksum -ErrorAction SilentlyContinue
}

# Install
Write-Blue "Installing..."
Move-Item -Path $tmpFile -Destination $destExe -Force

Write-Host ""
Write-Green "semantius installed successfully!"
Write-Host ""

# Add to PATH for current user if not already present
$userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike "*$InstallDir*") {
    Write-Yellow "Adding $InstallDir to your PATH..."
    [System.Environment]::SetEnvironmentVariable(
        'PATH',
        "$userPath;$InstallDir",
        'User'
    )
    Write-Green "PATH updated. Restart your terminal (or open a new one) to use semantius."
} else {
    # Already in PATH - show installed version
    if (Test-Path $destExe) {
        & $destExe --version
    }
}

Write-Host ""
Write-Host "Get started:"
Write-Host "  semantius --help"
Write-Host ""
