#!/bin/sh
# Vaultora one-line install (Linux/macOS, Docker host):
#   curl -fsSL https://raw.githubusercontent.com/moresonsunn/Vaultora/main/install.sh | bash
set -eu

REPO="https://raw.githubusercontent.com/moresonsunn/Vaultora/main"
DIR="${VAULTORA_DIR:-$HOME/vaultora}"

command -v docker >/dev/null 2>&1 || { echo "Docker is required (https://docs.docker.com/engine/install/)"; exit 1; }

mkdir -p "$DIR"
cd "$DIR"
[ -f docker-compose.yml ] || curl -fsSL "$REPO/docker-compose.yml" -o docker-compose.yml
[ -f .env ] || { curl -fsSL "$REPO/.env.example" -o .env; echo "Created .env — EDIT ADMIN_PASSWORD before first login!"; }

docker compose pull 2>/dev/null || true
docker compose up -d

echo ""
echo "Vaultora is starting. Open http://<this-host>:${APP_PORT:-8080}"
echo "First login: user from ADMIN_USER in .env (default: admin)."
