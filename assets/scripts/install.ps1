$ErrorActionPreference = "Stop"

function Write-Info($msg)  { Write-Host "▸ $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "▸ $msg" -ForegroundColor Yellow }
function Write-Error($msg) { Write-Host "▸ $msg" -ForegroundColor Red; exit 1 }

# check if node is installed
function Ensure-Node {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $version = (node -v) -replace 'v' -split '\.' | Select-Object -First 1
        if ([int]$version -ge 18) {
            Write-Info "Node.js v$(node -v) found"
            return
        } else {
            Write-Warn "Node.js v$(node -v) found but v18+ is required"
        }
    }

    Write-Info "Installing Node.js..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install nodejs-lts -y
    } elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
        scoop install nodejs-lts
    } else {
        Write-Error "couldn't install node.js, please install from the website itself."
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "node.js installation failed. Install manually from https://nodejs.org"
    }
    Write-Info "Node.js v$(node -v) installed"
}

# install yoinks
function Install-Yoinks {
    Write-Info "Installing yoinks..."
    npm install -g yoinks 2>&1 | Out-Null

    if (Get-Command yoinks -ErrorAction SilentlyContinue) {
        Write-Info "yoinks installed successfully!"
    } else {
        Write-Error "Installation failed. Try: npm install -g yoinks"
    }
}

# main
Write-Host ""
Write-Info "Installing yoinks — yoink any video"
Write-Host ""
Ensure-Node
Install-Yoinks
Write-Host ""
Write-Info "Done! Run 'yoinks' to start downloading."
Write-Info "Example: yoinks https://youtu.be/dQw4w9WgXcQ"
Write-Host ""
