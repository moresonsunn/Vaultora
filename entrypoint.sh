#!/bin/sh
# Vaultora entrypoint: honor PUID/PGID + TZ, fix ownership of bind mounts, drop privileges.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
STORAGE_ROOT="${STORAGE_ROOT:-/data}"
APP_DATA="${APP_DATA:-/app/data}"

# Timezone
if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  cp "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null || true
  echo "${TZ}" > /etc/timezone 2>/dev/null || true
fi

mkdir -p "${STORAGE_ROOT}" "${APP_DATA}" "${STORAGE_ROOT}/users" "${STORAGE_ROOT}/.tmp" "${STORAGE_ROOT}/.thumbs" "${STORAGE_ROOT}/.trash" 2>/dev/null || true

# Adjust appuser to requested UID/GID (runs as root at this point in Docker)
if [ "$(id -u)" = "0" ]; then
  # ensure group exists with PGID
  if ! getent group "${PGID}" >/dev/null 2>&1; then
    if getent group appuser >/dev/null 2>&1; then
      # rename/reuse: addgroup may conflict; just create numeric group via addgroup -g
      addgroup -g "${PGID}" appgroup 2>/dev/null || true
      GROUP="$(getent group "${PGID}" | cut -d: -f1)"
    else
      addgroup -g "${PGID}" appuser 2>/dev/null || true
      GROUP="appuser"
    fi
  else
    GROUP="$(getent group "${PGID}" | cut -d: -f1)"
  fi
  GROUP="${GROUP:-appuser}"
  # ensure user exists with PUID
  if ! id appuser >/dev/null 2>&1; then
    adduser -S -u "${PUID}" -G "${GROUP}" appuser 2>/dev/null || adduser -S -G "${GROUP}" appuser 2>/dev/null || true
  fi
  chown -R "${PUID}:${PGID}" "${APP_DATA}" 2>/dev/null || true
  # Only chown storage root top-level entries we own the layout for; never recursive-chown user TBs on every boot.
  chown "${PUID}:${PGID}" "${STORAGE_ROOT}" 2>/dev/null || true
  for d in users .tmp .thumbs .trash; do
    if [ -e "${STORAGE_ROOT}/${d}" ]; then chown "${PUID}:${PGID}" "${STORAGE_ROOT}/${d}" 2>/dev/null || true; fi
  done
  echo "Vaultora: storage=${STORAGE_ROOT} appdata=${APP_DATA} uid=${PUID} gid=${PGID} tz=${TZ:-unset}"
  exec su-exec "${PUID}:${PGID}" "$@"
else
  echo "Vaultora (non-root): storage=${STORAGE_ROOT} appdata=${APP_DATA}"
  exec "$@"
fi
