#!/usr/bin/env python3
"""Build the CasaOS v2 static store output (dist/) from the source files.

Reads:
  casaos-appstore/store-config.json
  casaos-appstore/supported-languages.json
  casaos-appstore/Apps/<app>/docker-compose.yml   (source of truth)
  casaos-appstore/assets/vaultora-icon.png

Writes (committed to git so CasaOS can fetch it straight from raw.githubusercontent):
  casaos-appstore/dist/store.json
  casaos-appstore/dist/index.json
  casaos-appstore/dist/apps/<x-casaos.id>/docker-compose.yml  (runtime-only x-casaos)
  casaos-appstore/dist/apps/<x-casaos.id>/meta.json
  casaos-appstore/dist/apps/<x-casaos.id>/assets/icon.png

URLs are absolute so clients never have to guess the base URL.

Usage:
  python3 scripts/build_store_dist.py
Requires: pyyaml (preinstalled on GitHub ubuntu runners; else `pip install pyyaml`).
"""
import copy
import hashlib
import json
import pathlib
import re
import shutil
import sys

try:
    import yaml
except ImportError:
    sys.exit("pyyaml is required: pip install pyyaml")

ROOT = pathlib.Path(__file__).resolve().parent.parent
STORE = ROOT / "casaos-appstore"
DIST = STORE / "dist"
BASE = "https://raw.githubusercontent.com/moresonsunn/Vaultora/main/casaos-appstore/dist"

CATEGORIES = {"Media", "Productivity", "Home", "Networking", "AI", "Finance", "Social", "Developer", "Others"}
RUNTIME_XCASAOS = ("id", "main", "index", "port_map", "scheme", "icon", "title")


def loc(obj, locale="en_US"):
    """Resolve a locale-keyed object to a plain string (fall back to en_us / first)."""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        return obj.get(locale) or obj.get("en_us") or next(iter(obj.values()), "")
    return ""


def main() -> None:
    store_cfg = json.loads((STORE / "store-config.json").read_text(encoding="utf-8"))
    assert store_cfg.get("version") == 2, "store-config.json version must be 2"
    assert re.fullmatch(r"[A-Za-z0-9._-]+", store_cfg["store_id"] or ""), "bad store_id"

    apps_dir = STORE / "Apps"
    app_dirs = sorted(p for p in apps_dir.iterdir() if p.is_dir())
    assert app_dirs, "no apps found"

    if DIST.exists():
        shutil.rmtree(DIST)

    index_items = []
    for app_dir in app_dirs:
        src = app_dir / "docker-compose.yml"
        comp = yaml.safe_load(src.read_text(encoding="utf-8"))
        xc = comp.get("x-casaos") or {}

        app_id = str(xc.get("id", "")).lower()
        assert re.fullmatch(r"[a-z0-9._-]+", app_id) and len([s for s in app_id.split(".") if s]) >= 2, (
            f"{src}: x-casaos.id must be reverse-domain style with 2+ segments"
        )
        assert xc.get("main") in (comp.get("services") or {}), f"{src}: x-casaos.main must match a service"
        assert isinstance(xc.get("port_map"), str), f"{src}: port_map must be a quoted string"
        assert xc.get("category") in CATEGORIES, f"{src}: category must be one of {sorted(CATEGORIES)}"
        assert xc.get("version"), f"{src}: x-casaos.version is required"
        assert isinstance(xc.get("title"), dict) and "en_US" in xc["title"], f"{src}: title.en_US required"

        out_dir = DIST / "apps" / app_id
        (out_dir / "assets").mkdir(parents=True, exist_ok=True)

        icon_url = f"{BASE}/apps/{app_id}/assets/icon.png"
        thumb_url = str(xc.get("thumbnail") or icon_url)

        # --- built compose: runtime-only x-casaos, resolved title, rewritten icon
        built = copy.deepcopy(comp)
        built["x-casaos"] = {k: xc[k] for k in RUNTIME_XCASAOS if k in xc}
        built["x-casaos"]["title"] = loc(xc.get("title"))
        built["x-casaos"]["icon"] = icon_url
        compose_path = out_dir / "docker-compose.yml"
        compose_path.write_text(
            yaml.safe_dump(built, sort_keys=False, allow_unicode=True), encoding="utf-8"
        )

        # --- meta.json
        meta = {
            "tagline": loc(xc.get("tagline")),
            "description": loc(xc.get("description")),
            "thumbnail": thumb_url,
            "screenshot_link": list(xc.get("screenshot_link") or []),
            "tips": {
                scope: loc(text) for scope, text in (xc.get("tips") or {}).items()
            },
            "author": xc.get("author", ""),
            "developer": xc.get("developer", ""),
            "category": xc.get("category", ""),
            "architectures": list(xc.get("architectures") or []),
            "version": str(xc.get("version")),
            "update_at": xc.get("update_at", ""),
            "release_note": loc(xc.get("release_notes")),
            "website": xc.get("website", ""),
            "repo": xc.get("repo", ""),
            "support": xc.get("support", ""),
            "docs": xc.get("docs", ""),
        }
        meta_path = out_dir / "meta.json"
        meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        # --- icon asset (prefer app-local icon, fall back to store asset)
        icon_src = app_dir / "icon.png"
        if not icon_src.exists():
            icon_src = STORE / "assets" / "vaultora-icon.png"
        icon_dst = out_dir / "assets" / "icon.png"
        shutil.copyfile(icon_src, icon_dst)

        # --- content hash over the generated app files
        h = hashlib.sha256()
        for p in (compose_path, meta_path, icon_dst):
            h.update(p.read_bytes())
        content_hash = "sha256:" + h.hexdigest()

        compose_url = f"{BASE}/apps/{app_id}/docker-compose.yml"
        meta_url = f"{BASE}/apps/{app_id}/meta.json"
        index_items.append(
            {
                "id": app_id,
                "title": loc(xc.get("title")),
                "tagline": loc(xc.get("tagline")),
                "category": xc.get("category", ""),
                "version": str(xc.get("version")),
                "author": xc.get("author", ""),
                "developer": xc.get("developer", ""),
                "architectures": list(xc.get("architectures") or []),
                "icon": icon_url,
                "thumbnail": thumb_url,
                "compose_url": compose_url,
                "meta_url": meta_url,
                "content_hash": content_hash,
            }
        )
        print(f"app {app_id} version {xc.get('version')} hash {content_hash[:19]}...")

    (DIST / "store.json").write_text(
        json.dumps(
            {
                "version": 2,
                "store_id": store_cfg["store_id"],
                "name": loc(store_cfg.get("name")),
                "description": loc(store_cfg.get("description")),
                "maintainer": store_cfg.get("maintainer", ""),
                "url": store_cfg.get("url", ""),
                "icon": store_cfg.get("icon", ""),
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    (DIST / "index.json").write_text(
        json.dumps(
            {"store_id": store_cfg["store_id"], "apps": index_items},
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {DIST} with {len(index_items)} app(s)")


if __name__ == "__main__":
    main()
