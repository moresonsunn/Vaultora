# Vaultora one-line install (Windows, PowerShell as Admin):
#   irm https://raw.githubusercontent.com/moresonsunn/Vaultora/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Repo = 'https://raw.githubusercontent.com/moresonsunn/Vaultora/main'
$Dir = if ($env:VAULTORA_DIR) { $env:VAULTORA_DIR } else { Join-Path $HOME 'vaultora' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is required (https://docs.docker.com/desktop/install/windows-install/)'
}

New-Item -ItemType Directory -Path $Dir -Force | Out-Null
Set-Location $Dir
if (-not (Test-Path 'docker-compose.yml')) {
  Invoke-WebRequest "$Repo/docker-compose.yml" -OutFile 'docker-compose.yml'
}
if (-not (Test-Path '.env')) {
  Invoke-WebRequest "$Repo/.env.example" -OutFile '.env'
  Write-Host 'Created .env — EDIT ADMIN_PASSWORD before first login!' -ForegroundColor Yellow
}

docker compose pull 2>$null
docker compose up -d

Write-Host ''
Write-Host 'Vaultora is starting. Open http://localhost:8090 (or your APP_PORT).'
Write-Host 'First login: user from ADMIN_USER in .env (default: admin).'
