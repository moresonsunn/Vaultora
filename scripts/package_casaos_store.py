#!/usr/bin/env python3
"""Package the CasaOS third-party store into a zip for GitHub Releases.

The zip contains the store layout at its root (index.json + Apps/), so it can
be added in CasaOS as a Custom Source via:
  https://github.com/moresonsunn/Vaultora/releases/latest/download/vaultora-store.zip

Usage:
  python3 scripts/package_casaos_store.py [--out vaultora-store.zip]
"""
import argparse
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
STORE = ROOT / "casaos-appstore"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="vaultora-store.zip")
    args = ap.parse_args()

    index = STORE / "index.json"
    apps = STORE / "Apps"
    if not index.exists():
        raise SystemExit("missing casaos-appstore/index.json")
    if not apps.is_dir():
        raise SystemExit("missing casaos-appstore/Apps/")

    out = pathlib.Path(args.out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(index, "index.json")
        for p in sorted(apps.rglob("*")):
            if p.is_file():
                z.write(p, str(pathlib.Path("Apps") / p.relative_to(apps)))
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
