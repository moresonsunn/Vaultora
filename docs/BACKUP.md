# Backup & restore

Vaultora deliberately keeps a clean split: **files are files, metadata is SQLite**. Back up both and you can fully restore.

## What to back up

| # | What | Default host path (CasaOS) | Contains |
|---|---|---|---|
| 1 | Storage bind mount | `/DATA/Storage/Files` (`STORAGE_PATH` → `/data`) | All user files, shared folders, trash. Normal files — browseable without Vaultora. |
| 2 | App-data bind mount | `/DATA/AppData/vaultora` (`APPDATA_PATH` → `/app/data`) | `vaultora.db` (+ WAL) — users, password hashes, 2FA flags, sessions, shares, audit log, settings. |

Nothing else matters: the container image is disposable.

## How (examples)

```bash
# Files (rsync keeps permissions; run as a user that can read PUID:PGID files)
rsync -a --delete /DATA/Storage/Files/ /backup/vaultora-files/

# Database — checkpoint WAL first for a consistent copy:
docker exec vaultora sh -c 'wget -qO- http://127.0.0.1:8090/health'  # sanity
sqlite3 /DATA/AppData/vaultora/vaultora.db "PRAGMA wal_checkpoint(TRUNCATE);"
cp /DATA/AppData/vaultora/vaultora.db /backup/vaultora-appdata/vaultora-$(date +%F).db
```

Or back up the whole app-data dir with your existing tool (restic/borg/CasaOS backup):

```bash
restic -r /backup/restic backup /DATA/Storage/Files /DATA/AppData/vaultora
```

## Restore

1. Fresh install per `docs/CASAOS.md` (same `PUID`/`PGID`).
2. Stop the container, put the files back, fix ownership, start:
   ```bash
   docker compose stop vaultora
   rsync -a /backup/vaultora-files/ /DATA/Storage/Files/
   cp /backup/vaultora-appdata/vaultora-YYYY-MM-DD.db /DATA/AppData/vaultora/vaultora.db
   chown -R 1000:1000 /DATA/Storage/Files /DATA/AppData/vaultora
   docker compose start vaultora
   ```
3. Log in, spot-check a share link and an upload.

## Notes

- Share links reference physical relative paths (`phys_rel`): restoring **both** mounts together keeps links valid. Restoring only the DB without the files yields "source removed" on those links — by design.
- Vaultora does **not** back up your files for you and does **not** version them — that is your backup tool's job. Trash retention (`Admin → Settings`) is a safety net, not a backup.
