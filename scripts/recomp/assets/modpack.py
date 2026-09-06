#!/usr/bin/env python3
"""Build a mod catalogue a page can browse, and the parts it downloads.

A folder of mods in, a directory a static host can serve out:

    catalogue.json      what the browser lists and searches
    m/<id>.<n>.bin      one mod, zipped, cut into parts

The parts exist because jsDelivr refuses a file over 20 MB, so nothing here is
allowed past 19. The page joins them back, unzips the result and stores the mod
in the browser (mods.mjs fetchMod/install). None of it is in the build: the page
fetches the catalogue when the browser is opened and a mod only when it is asked
for.

A mod bigger than the page's seed budget is listed but cannot be installed, so by
default one is left out entirely rather than served for nothing; --max-mb 0 keeps
everything.

usage:
  modpack.py <mods-dir> <out-dir> [--max-mb 96] [--part-mb 19] [--base URL]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import zipfile

MIB = 1 << 20
SKIP_NAMES = {"disable.it", ".ds_store", "thumbs.db", "desktop.ini"}


def human(n: int) -> str:
    return "%.2f MB" % (n / float(MIB)) if n >= MIB else "%d KB" % max(1, n // 1024)


def read_metadata(path: str) -> dict:
    """name, directory, description and version out of a mod's metadata.xml.

    Read with a regex rather than a parser on purpose: mods ship malformed XML --
    a bare ampersand, a BOM, a tag left open -- and a mod with a broken metadata
    file should lose its description, not its place in the catalogue.
    """
    out = {"name": None, "directory": None, "description": None, "version": None}
    try:
        with io.open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return out
    for tag in out:
        m = re.search(r"<%s\s*>([\s\S]*?)</%s\s*>" % (tag, tag), text, re.I)
        if not m:
            continue
        v = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", r"\1", m.group(1)).strip()
        v = re.sub(r"\s+", " ", v)
        if v:
            out[tag] = v[:400]
    return out


def mod_id(name: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", (name or "").lower()).strip("-.")
    return s[:64]


def zip_mod(folder: str) -> tuple[bytes, int, int]:
    """The mod's own tree, zipped, entries relative to the mod folder."""
    buf = io.BytesIO()
    files = skipped = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for dp, dn, fn in os.walk(folder):
            dn[:] = [d for d in dn if not d.startswith(".")]
            for f in sorted(fn):
                if f.lower() in SKIP_NAMES:
                    skipped += 1
                    continue
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, folder).replace("\\", "/")
                z.write(full, rel)
                files += 1
    return buf.getvalue(), files, skipped


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mods")
    ap.add_argument("out")
    ap.add_argument("--part-mb", type=int, default=19, help="largest part (default 19; jsDelivr refuses 20)")
    ap.add_argument("--max-mb", type=int, default=96,
                    help="leave out a mod bigger than this, which the page could not seed anyway (0 keeps every mod)")
    ap.add_argument("--base", help="where the catalogue will be served from, recorded in it for reference")
    args = ap.parse_args(argv)

    part = args.part_mb * MIB
    cap = args.max_mb * MIB
    if not os.path.isdir(args.mods):
        print("no such folder: %s" % args.mods)
        return 2
    os.makedirs(os.path.join(args.out, "m"), exist_ok=True)
    for f in os.listdir(os.path.join(args.out, "m")):
        os.remove(os.path.join(args.out, "m", f))

    entries, seen, left_out, total = [], {}, [], 0
    for name in sorted(os.listdir(args.mods)):
        folder = os.path.join(args.mods, name)
        if not os.path.isdir(folder):
            continue
        meta = read_metadata(os.path.join(folder, "metadata.xml"))
        # the folder name carries the workshop id after an underscore; the mod's
        # own <directory> is what the game would call it, so that wins
        base = meta["directory"] or re.sub(r"_\d{6,}$", "", name)
        mid = mod_id(base) or mod_id(name)
        if not mid or mid in seen:
            mid = mod_id("%s-%d" % (mid or "mod", len(entries)))
        blob, files, skipped = zip_mod(folder)
        if cap and len(blob) > cap:
            left_out.append((meta["name"] or name, len(blob)))
            continue
        n = max(1, (len(blob) + part - 1) // part)
        for i in range(n):
            with open(os.path.join(args.out, "m", "%s.%d.bin" % (mid, i)), "wb") as f:
                f.write(blob[i * part:(i + 1) * part])
        seen[mid] = True
        total += len(blob)
        entries.append({
            "id": mid,
            "name": meta["name"] or base,
            "description": meta["description"] or "",
            "version": meta["version"] or "",
            "bytes": len(blob),
            "files": files,
            "parts": n,
        })
        print("  %-46s %-10s %2d part(s), %d file(s)%s"
              % (entries[-1]["name"][:46], human(len(blob)), n, files,
                 ", %d skipped" % skipped if skipped else ""))

    catalogue = {"version": 1, "base": args.base or None, "mods": entries}
    with io.open(os.path.join(args.out, "catalogue.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(catalogue, f, indent=1, ensure_ascii=False)
        f.write("\n")
    biggest = max((os.path.getsize(os.path.join(args.out, "m", f))
                   for f in os.listdir(os.path.join(args.out, "m"))), default=0)
    print("catalogue: %d mod(s), %s in %d part(s), largest part %s"
          % (len(entries), human(total), sum(e["parts"] for e in entries), human(biggest)))
    if biggest > 20 * MIB:
        print("  WARNING: a part is over 20 MB and jsDelivr will refuse it")
        return 1
    for name, size in left_out:
        print("  left out: %-40s %s (over the %d MB the page can seed)" % (name[:40], human(size), args.max_mb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
