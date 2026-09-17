# Vaultora

[![CI](https://github.com/moresonsunn/Vaultora/actions/workflows/ci.yml/badge.svg)](https://github.com/moresonsunn/Vaultora/actions/workflows/ci.yml) [![Docker Pulls](https://img.shields.io/docker/pulls/moresonsun/vaultora)](https://hub.docker.com/r/moresonsun/vaultora) [![GH Release](https://img.shields.io/github/v/release/moresonsunn/Vaultora)](https://github.com/moresonsunn/Vaultora/releases)

**Your server's storage — nothing else.** A simple, private, self-hosted web file manager for a CasaOS / Docker homelab. Not Nextcloud: no sync client, no office suite, no calendar/contacts, no collaborative editing. Open it and you immediately see your server's files.

- 📁 Browse / upload / download / organize real files (normal files on disk, never blobs in a DB)
- 🖱️ Drag-and-drop uploader with progress, speed, ETA, cancel/retry + **chunked resumable uploads** for large files, folder upload
- 👁️ Previews: images, video, audio, PDF, TXT/Markdown/JSON/CSV/code
- 🔗 Secure share links (`/s/abc123`, filesystem path never exposed): password, expiry, max downloads, disable/regenerate
- 🗑️ Trash with restore / empty / auto-cleanup
- 👤 Users, quotas, shared storage roots with read/write access, admin panel, audit log
- 🔐 Sessions, bcrypt, optional TOTP 2FA, login rate limiting, CSRF, secure cookies, ClamAV-hook (optional)
- 📱 Responsive + dark/light, keyboard shortcuts (`/`, `u`, `n`, `Del`, `Ctrl+A`, `g`, `r`)
- 🐳 Docker-first, CasaOS-friendly: bind mounts, PUID/PGID, TZ, healthcheck, SQLite metadata

## Updates (automatic builds)

Every push to `main` triggers GitHub Actions: tests run, then a multi-arch
(`amd64`/`arm64`) image is built and pushed to
[`moresonsun/vaultora:latest`](https://hub.docker.com/r/moresonsun/vaultora).
Versioned releases are cut by pushing a tag (`git tag v1.1.0 && git push --tags`).

- **CasaOS (store install):** an **Update** button appears on the app when a new
  image is published — click it, done. The running version is shown at the
  bottom of the sidebar and in Admin → Settings.
- **Plain Docker host:** `docker compose pull && docker compose up -d`.

See [docs/CASAOS.md](docs/CASAOS.md) for the one-time store setup.

## Quick start (Docker Compose)

```bash
cp .env.example .env   # edit ADMIN_PASSWORD, STORAGE_PATH, APPDATA_PATH, TZ, PUID/PGID
docker compose up -d --build
# open http://<host>:8080  → login with ADMIN_USER / ADMIN_PASSWORD
```

Change the **host** paths only (`STORAGE_PATH`, `APPDATA_PATH`); the container paths stay `/data` and `/app/data`.

| Env | Default | Meaning |
|---|---|---|
| `STORAGE_PATH` | `./storage` | Host dir for your files → `/data` |
| `APPDATA_PATH` | `./appdata` | Host dir for `vaultora.db` → `/app/data` |
| `APP_PORT` | `8080` | Host port |
| `TZ` | `UTC` | Timezone (e.g. `Europe/Berlin`) |
| `PUID`/`PGID` | `1000` | File ownership for created files (avoid root-owned uploads) |
| `ADMIN_USER`/`ADMIN_PASSWORD` | `admin`/`changeme123` | Seed admin (first boot only — **change it**) |
| `APP_URL` | `http://localhost:8080` | Base URL used in share links |
| `MAX_FILE_SIZE` | `21474836480` | Max upload bytes (20 GiB) |
| `COOKIE_SECURE` | `0` | Set `1` behind HTTPS |

## Layout inside the container

- `/data/users/<username>/…` — private files ("My Files")
- `/data/<SharedRoot>/…` — admin-created shared folders
- `/data/.trash/<username>/…` — trash · `/data/.tmp/` — in-progress uploads · `/data/.thumbs/` — reserved
- `/app/data/vaultora.db` — SQLite metadata (users, sessions, shares, audit, settings)

## CasaOS

See **[docs/CASAOS.md](docs/CASAOS.md)** — install via Compose import, set two bind mounts, done. No source edits needed.

## Backup

Back up exactly two things (see [docs/BACKUP.md](docs/BACKUP.md)):

1. The storage bind mount (`/DATA/Storage/Files` → the files themselves)
2. The app-data bind mount (`vaultora.db` → users/shares/settings/audit)

## Development / tests

```bash
npm install
npm test        # node:test suite (auth, files, shares, traversal guard, persistence)
npm start       # PORT=8080 STORAGE_ROOT=./storage APP_DATA=./appdata node src/index.js
```

API reference: [openapi.yaml](openapi.yaml) (also served live at `/api/openapi.yaml`).

## Security notes

- Auth required for everything except `/health` and token-guessed `/s/:token` links.
- Every file access resolves the virtual path → physical path and verifies containment under `STORAGE_ROOT` with realpath (symlink-safe). Filenames are sanitized per segment.
- Uploads are served with `Content-Disposition` + `nosniff`; the app never executes uploaded files.
- Optional ClamAV: run the `clamav` service in compose, then enable it in Admin → Settings (INSTREAM scan; infected uploads are rejected).
