# CasaOS installation

Vaultora ships its own CasaOS App Store source, exactly like the Lynx pattern:
install once from the store, then every new release shows up as a one-click
**Update** button on the app. No SSH, no compose edits, no rebuilds.

## Option A — Vaultora App Store (recommended: one-click install + updates)

1. In CasaOS open the **App Store**, go to its settings/menu and **add a custom
   source** with this URL (the modern store format — try this first):
   ```
   https://raw.githubusercontent.com/moresonsunn/Vaultora/main/casaos-appstore/dist/store.json
   ```
   If your CasaOS version does not accept that, use one of these instead:
   ```
   https://raw.githubusercontent.com/moresonsunn/Vaultora/main/casaos-appstore/index.json
   ```
   ```
   https://github.com/moresonsunn/Vaultora/releases/latest/download/vaultora-store.zip
   ```
   (If even the zip fails, refresh the source after a minute and check you can
   open the URL in a browser — it must return JSON, not a GitHub HTML page.)
2. Open the new **Vaultora Store** source, install **Vaultora**.
3. On the install screen set:
   - `ADMIN_PASSWORD` → a long unique password (do NOT keep `changeme123`)
   - Storage volume if you want files outside the default
     (`/DATA/AppData/vaultora/files` → e.g. `/DATA/Storage/Files`)
   - `TZ` → your timezone, `PUID`/`PGID` → your host user (`id -u`, `id -g` over SSH)
4. Open the app, log in with `admin` + your password.

**Updating:** whenever a new image is published (automatically by GitHub Actions
on every `main` push, plus versioned `v*` releases), CasaOS shows an **Update**
badge on the Vaultora app — click **Update** and it pulls the new image and
recreates the container. Files, database and settings live in bind mounts, so
nothing is lost. Confirm the new build in the app: the version is printed at
the bottom of the sidebar and in **Admin → Settings**.

## Option B — Custom Compose import (no store)

1. **Apps → + → Install a custom app → Import Docker Compose**.
2. Paste the contents of this repo's `casaos-appstore/Apps/vaultora/docker-compose.yml`.
3. Adjust the two `/DATA/AppData/$AppID/...` volumes if desired, set
   `ADMIN_PASSWORD`, deploy. To move storage later, change only the **host**
   side of the `/data` mount.

## Option C — SSH / terminal (plain Docker host)

```bash
mkdir -p /DATA/Storage/Files /DATA/AppData/vaultora
cd /DATA/AppData/vaultora
# copy docker-compose.yml + .env from this repo here, edit .env:
#   STORAGE_PATH=/DATA/Storage/Files
#   APPDATA_PATH=/DATA/AppData/vaultora
docker compose up -d
docker compose logs -f vaultora
# update later:
docker compose pull && docker compose up -d
```

Or the one-liner (Linux/macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/moresonsunn/Vaultora/main/install.sh | bash
```

## First login checklist

1. Log in as admin → **Admin → Users** → create users (each gets `/data/users/<name>` automatically).
2. **Admin → Storage** → create shared folders (e.g. `Documents`, `Videos`, `Backups`) and grant users access.
3. **Admin → Settings** → verify `APP_URL`, quotas, trash retention, share defaults.
4. Test from your phone browser: upload a photo, preview it, create a share link.

## Reverse proxy (remote access)

Vaultora is plain HTTP on `:8080`. For remote access put it behind your existing proxy (Nginx Proxy Manager / Caddy / Traefik) with HTTPS, then set `APP_URL` + `COOKIE_SECURE=1`. Example Caddy:

```
files.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| No Update button appears | Give CasaOS a few minutes to poll the registry; the store install must reference `moresonsun/vaultora:latest` (it does by default) |
| Uploaded files owned by root | Set `PUID`/`PGID` to your host user (`id -u`, `id -g`), redeploy |
| Cannot write to storage | Host dir must be writable by `PUID:PGID`: `chown -R 1000:1000 /DATA/Storage/Files` |
| Wrong time on shares/audit | Set `TZ` correctly |
| Share links show localhost | Set `APP_URL` in env (or Admin → Settings → Application URL) |
| Container unhealthy | Check the app logs in CasaOS; verify the two bind mounts exist |
