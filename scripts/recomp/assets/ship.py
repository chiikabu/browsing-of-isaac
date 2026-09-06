#!/usr/bin/env python3
"""The shipping dist: one folder somebody can host, assembled from the bundle, the fast web module and the memory image.

  build  [--bundle DIR] [--module DIR] [--segs FILE] [--web DIR] [--dist DIR] [--copy]
         [--no-compress] [--no-brotli] [--brotli-quality N] [--gzip-level N] [--window-min BYTES]
         assemble DIST (default .scratch/game-dist): play.html + play.mjs + boot_web.mjs at the root,
         boot.mjs / boot.wasm / isaac.segs.bin (copied, never linked: build_boot.py relinks the module
         in place while a dist may be in use), the bundle's files under instance/ (hard links, or
         copies with --copy), instance_index.json in the shape boot_web.mjs consumes, precompressed
         siblings (.br / .gz) next to every file above 1 MB that compresses, dist.json (every file
         with its size, sha256 and encodings) and the size table
  check  DIST [--quick]   re-verify a dist against dist.json: every file present with its size and
         hash, every sibling present and decoding to its source (--quick: sizes only), nothing extra,
         the index matching instance/, the totals adding up
  table  DIST             the size table from dist.json

What ships and why (docs/recomp-architecture.md 21.49): the page (play.html, play.mjs) and the
pipeline it imports (boot_web.mjs) are the three files of scripts/recomp/web the browser needs; the
module is build_boot.py --web --fast (boot.mjs + boot.wasm); the memory image is the guest's
.data/.rdata (isaac.segs.bin); the instance is the round-28 bundle (bundle.py), served under
instance/ exactly as run_web.mjs serves an instance dir, with the same index (a JSON array of
{p, s}: relative path, size) the page registers lazily.

Precompression: a file the page fetches whole (the module, the memory image, the eagerly seeded
archives, the Lua) is worth a brotli/gzip sibling when it compresses; a lazy file of
ISAAC_FS_WINDOW_MIN MiB (32) or more under instance/ is windowed by the host -- read as 1 MB byte
slices (?off=&len=), never whole -- so a sibling of it would never be served and none is made. A
candidate is probed on three 1 MB samples first (zlib level 6); whole-file compression runs only
when the samples shrink by at least 5 %, and a sibling is kept only when it does too. Nothing
game-derived enters the repository through this tool: the dist lives under .scratch/ or output/.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zlib

try:
    import brotli  # type: ignore
except ImportError:  # pragma: no cover - depends on the machine
    brotli = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle as bundle_tool  # noqa: E402  (the sibling tool: its manifest and check)

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
MANIFEST_NAME = "dist.json"
MANIFEST_FORMAT = "isaac-recomp-dist/1"
INDEX_NAME = "instance_index.json"
INSTANCE_DIR = "instance"
PAGE_FILES = ("play.html", "play.mjs", "boot_web.mjs", "menu_overlay.mjs", "zip.mjs", "mods.mjs")
TRAIL_NAME = "boot-trail.json"       # round 59: the boot trail a drive_boot.mjs run left, shipped for first visits (--trail)
MODULE_FILES = ("boot.mjs", "boot.wasm")
SEGS_NAME = "isaac.segs.bin"
MIN_COMPRESS = 1_000_000          # "above 1 MB": a sibling is considered from here
BIG_ROW = 5_000_000               # the size table lists every file above this on its own row
WINDOW_MIN_DEFAULT = 32 << 20     # ISAAC_FS_WINDOW_MIN MiB: a lazy file this big is served as slices, never whole
KEEP_RATIO = 0.95                 # a sibling (and a probe) must save at least 5 %
PROBE_WINDOW = 1 << 20
ENCODINGS = ("br", "gz")
SIBLING_SUFFIX = {"br": ".br", "gz": ".gz"}
DEFAULTS = {
    "bundle": os.path.join(ROOT, ".scratch", "game-bundle"),
    "module": os.path.join(ROOT, "output", "recomp", "lift", "boot-web-fast"),
    "segs": os.path.join(ROOT, "output", "recomp", "host", SEGS_NAME),
    "web": os.path.join(ROOT, "scripts", "recomp", "web"),
    "dist": os.path.join(ROOT, ".scratch", "game-dist"),
}

# The index policy of run_web.mjs, mirrored: skip exe/dll/so/ogv, the top-level packed/ and
# mods/, and dot files; the archives under resources/packed/ are in (the page seeds six of them
# eagerly by name and registers the rest lazily).
SKIP_DIRS = {"packed", "mods"}
PAGE_DIRS = {"page-assets"}   # round 52: the page's own files in the bundle, not the engine's -- out of the index too
SKIP_EXT = re.compile(r"\.(exe|dll|so|ogv)$", re.IGNORECASE)


def fmt(n) -> str:
    return "-" if n is None else format(n, ",")


def sha256_file(path: str) -> str:
    return bundle_tool.sha256_file(path)


def walk_files(root: str) -> dict[str, int]:
    """{relative forward-slash path: size} for every regular file under root."""
    return bundle_tool.walk_tree(root)


def instance_index(instance_root: str, exclude: set[str] | None = None) -> list[dict]:
    out = []
    root = os.path.abspath(instance_root)
    for dp, dn, fn in os.walk(root):
        rel_dir = os.path.relpath(dp, root).replace("\\", "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        dn[:] = sorted(d for d in dn if (rel_dir + "/" + d if rel_dir else d) not in SKIP_DIRS
                       and (rel_dir + "/" + d if rel_dir else d) not in PAGE_DIRS)
        for f in sorted(fn):
            if SKIP_EXT.search(f) or f.startswith("."):
                continue
            rel = rel_dir + "/" + f if rel_dir else f
            if exclude and rel in exclude:
                continue
            out.append({"p": rel, "s": os.stat(os.path.join(dp, f)).st_size})
    out.sort(key=lambda e: e["p"])
    return out


# ---------------------------------------------------------------------------
# compression
# ---------------------------------------------------------------------------

def probe_ratio(path: str, size: int) -> float:
    """Compressed/raw over up to three 1 MB samples (start, middle, end) at zlib level 6."""
    offsets = sorted({0, max(0, size // 2 - PROBE_WINDOW // 2), max(0, size - PROBE_WINDOW)})
    raw = comp = 0
    with open(path, "rb") as f:
        for off in offsets:
            f.seek(off)
            chunk = f.read(PROBE_WINDOW)
            if not chunk:
                continue
            raw += len(chunk)
            comp += len(zlib.compress(chunk, 6))
    return comp / raw if raw else 1.0


def make_siblings(path: str, size: int, want_brotli: bool, brotli_quality: int, gzip_level: int) -> dict[str, int]:
    """Write path.gz (and path.br when the module is importable); keep each only when it saves 5 %."""
    with open(path, "rb") as f:
        data = f.read()
    out: dict[str, int] = {}
    gz = gzip.compress(data, compresslevel=gzip_level, mtime=0)
    if len(gz) < KEEP_RATIO * size:
        with open(path + ".gz", "wb") as f:
            f.write(gz)
        out["gz"] = len(gz)
    else:
        _unlink(path + ".gz")
    if want_brotli and brotli is not None:
        br = brotli.compress(data, quality=brotli_quality, lgwin=24)
        if len(br) < KEEP_RATIO * size:
            with open(path + ".br", "wb") as f:
                f.write(br)
            out["br"] = len(br)
        else:
            _unlink(path + ".br")
    return out


def decode_sibling(path: str, enc: str) -> bytes | None:
    with open(path, "rb") as f:
        data = f.read()
    if enc == "gz":
        return gzip.decompress(data)
    if brotli is None:
        return None
    return brotli.decompress(data)


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------
# the size table
# ---------------------------------------------------------------------------

def best_transfer(entry: dict) -> tuple[str, int]:
    enc, size = "raw", entry["size"]
    for e, s in entry.get("encodings", {}).items():
        if s < size:
            enc, size = e, s
    return enc, size


def totals_of(files: list[dict]) -> dict:
    raw = sum(f["size"] for f in files)
    transfer = sum(best_transfer(f)[1] for f in files)
    sib_files = sum(len(f.get("encodings", {})) for f in files)
    sib_bytes = sum(sum(f.get("encodings", {}).values()) for f in files)
    return {"files": len(files), "bytes": raw, "transfer": transfer,
            "siblings": {"files": sib_files, "bytes": sib_bytes}, "on_disk": raw + sib_bytes}


def print_table(files: list[dict], out=sys.stdout) -> None:
    w = 44
    head = "%-*s  %14s  %14s  %14s  %14s  %s" % (w, "file", "raw", "gzip", "brotli", "transfer", "encoding")
    print(head, file=out)
    print("-" * len(head), file=out)
    small = [f for f in files if f["size"] <= BIG_ROW]
    for f in sorted((f for f in files if f["size"] > BIG_ROW), key=lambda f: -f["size"]):
        enc, size = best_transfer(f)
        note = enc if enc != "raw" else ("raw (windowed: served as 1 MB slices)" if f.get("windowed")
                                          else "raw (does not compress)" if f.get("probed") else "raw")
        print("%-*s  %14s  %14s  %14s  %14s  %s" % (w, f["path"][:w], fmt(f["size"]),
                                                     fmt(f.get("encodings", {}).get("gz")),
                                                     fmt(f.get("encodings", {}).get("br")), fmt(size), note), file=out)
    if small:
        t = totals_of(small)
        print("%-*s  %14s  %14s  %14s  %14s  %s" % (w, "(%d files of 5 MB or less)" % len(small), fmt(t["bytes"]), "-", "-",
                                                     fmt(t["transfer"]), ""), file=out)
    print("-" * len(head), file=out)
    t = totals_of(files)
    print("dist: %d files, %s bytes raw; %d precompressed sibling(s), %s bytes; %s bytes on disk" % (
        t["files"], fmt(t["bytes"]), t["siblings"]["files"], fmt(t["siblings"]["bytes"]), fmt(t["on_disk"])), file=out)
    print("transfer with the best encoding: %s bytes = %.2f%% of raw" % (
        fmt(t["transfer"]), 100.0 * t["transfer"] / t["bytes"] if t["bytes"] else 0.0), file=out)


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

def place(src: str, dst: str, link: bool) -> str:
    return bundle_tool.link_or_copy(os.path.realpath(src), dst, copy=not link)


def cmd_build(args) -> int:
    t0 = time.time()
    bundle_dir = os.path.abspath(args.bundle)
    module_dir = os.path.abspath(args.module)
    segs = os.path.abspath(args.segs)
    web = os.path.abspath(args.web)
    dist = os.path.abspath(args.dist)
    for d in (bundle_dir, module_dir, web):
        if dist == d or dist.startswith(d + os.sep):
            print("refusing to build the dist inside one of its sources (%s)" % d, file=sys.stderr)
            return 2
    # --- inputs
    problems, bman = bundle_tool.check_bundle(bundle_dir, quick=True)
    if problems:
        print("the bundle at %s does not pass bundle.py check --quick:" % bundle_dir)
        for p in problems[:20]:
            print("   %s" % p)
        return 1
    missing = [os.path.join(module_dir, f) for f in MODULE_FILES if not os.path.isfile(os.path.join(module_dir, f))]
    missing += [] if os.path.isfile(segs) else [segs]
    missing += [os.path.join(web, f) for f in PAGE_FILES if not os.path.isfile(os.path.join(web, f))]
    if missing:
        print("missing input(s):")
        for m in missing:
            print("   %s" % m)
        return 1
    os.makedirs(dist, exist_ok=True)
    previous: dict[str, dict] = {}
    prev_path = os.path.join(dist, MANIFEST_NAME)
    if os.path.isfile(prev_path):
        try:
            with open(prev_path, encoding="utf-8") as f:
                previous = {e["path"]: e for e in json.load(f).get("files", [])}
        except (OSError, ValueError, KeyError):
            previous = {}

    # --- the plan: what lands where
    files: list[dict] = []
    how = {"link": 0, "copy": 0}

    def add(rel: str, src: str, kind: str, link: bool) -> dict:
        dst = os.path.join(dist, rel)
        how[place(src, dst, link)] += 1
        e = {"path": rel, "size": os.stat(dst).st_size, "sha256": sha256_file(dst), "kind": kind, "linked": link}
        files.append(e)
        return e

    for f in PAGE_FILES:
        add(f, os.path.join(web, f), "page", link=False)
    if getattr(args, "trail", ""):
        add(TRAIL_NAME, os.path.abspath(args.trail), "trail", link=False)
    for f in MODULE_FILES:
        add(f, os.path.join(module_dir, f), "module", link=False)
    add(SEGS_NAME, segs, "image", link=False)
    bundle_files = walk_files(bundle_dir)
    for rel in sorted(bundle_files):
        kind = "bundle-manifest" if rel == bundle_tool.MANIFEST_NAME else "instance"
        add(INSTANCE_DIR + "/" + rel, os.path.join(bundle_dir, rel), kind, link=not args.copy)
    index = instance_index(bundle_dir)
    index_path = os.path.join(dist, INDEX_NAME)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, separators=(",", ":"))
    files.append({"path": INDEX_NAME, "size": os.stat(index_path).st_size, "sha256": sha256_file(index_path),
                  "kind": "index", "linked": False})
    planned = {e["path"] for e in files}

    # --- stale files from an earlier build: anything not planned and not a sibling of a planned file
    for rel in walk_files(dist):
        if rel == MANIFEST_NAME or rel in planned:
            continue
        base = rel[:-3] if rel.endswith((".br", ".gz")) else None
        if base in planned:
            continue            # a sibling; the compression step decides whether it stays
        os.unlink(os.path.join(dist, rel))
    for dp, dn, fn in os.walk(dist, topdown=False):
        if dp != dist and not dn and not fn:
            os.rmdir(dp)

    # --- precompressed siblings
    want_brotli = not args.no_brotli
    if want_brotli and brotli is None:
        print("brotli: the python module is not importable -- skipping .br siblings (pip install brotli)")
        want_brotli = False
    notes = []
    for e in files:
        rel, size, full = e["path"], e["size"], os.path.join(dist, e["path"])
        e["encodings"] = {}
        if args.no_compress or size < MIN_COMPRESS:
            for enc in ENCODINGS:
                _unlink(full + SIBLING_SUFFIX[enc])
            continue
        if rel.startswith(INSTANCE_DIR + "/") and size >= args.window_min:
            e["windowed"] = True
            for enc in ENCODINGS:
                _unlink(full + SIBLING_SUFFIX[enc])
            notes.append("%s: windowed (%s bytes >= %s): served as byte slices, no sibling" % (rel, fmt(size), fmt(args.window_min)))
            continue
        # unchanged since the last build (same sha256, every recorded sibling still there at its
        # size): keep the siblings and the verdict, unless brotli is wanted now and was not there
        prev = previous.get(rel)
        reuse = (prev is not None and prev.get("sha256") == e["sha256"] and isinstance(prev.get("encodings"), dict)
                 and all(os.path.isfile(full + SIBLING_SUFFIX[k]) and os.stat(full + SIBLING_SUFFIX[k]).st_size == v
                         for k, v in prev["encodings"].items())
                 and (not want_brotli or "br" in prev["encodings"] or not prev["encodings"]))
        if reuse:
            e["encodings"] = dict(prev["encodings"])
            e["probed"] = bool(prev.get("probed"))
            for enc in ENCODINGS:
                if enc not in e["encodings"]:
                    _unlink(full + SIBLING_SUFFIX[enc])
            notes.append("%s: siblings reused (unchanged since the last build)" % rel)
            continue
        e["probed"] = True
        ratio = probe_ratio(full, size)
        if ratio >= KEEP_RATIO:
            for enc in ENCODINGS:
                _unlink(full + SIBLING_SUFFIX[enc])
            notes.append("%s: does not compress (sampled ratio %.3f), no sibling" % (rel, ratio))
            continue
        t1 = time.time()
        e["encodings"] = make_siblings(full, size, want_brotli, args.brotli_quality, args.gzip_level)
        made = ", ".join("%s %s" % (k, fmt(v)) for k, v in e["encodings"].items()) or "none kept (saved under 5 %)"
        notes.append("%s: %s bytes -> %s (%.1f s)" % (rel, fmt(size), made, time.time() - t1))

    # --- the manifest
    build_json = os.path.join(module_dir, "build_boot.json")
    module_build = None
    if os.path.isfile(build_json):
        try:
            with open(build_json, encoding="utf-8") as f:
                b = json.load(f)
            module_build = {k: b.get(k) for k in ("emccVersion", "wasmBytes", "mjsBytes", "link_s", "ok")}
        except (OSError, ValueError):
            module_build = None
    manifest = {
        "format": MANIFEST_FORMAT,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "page": "play.html",
        "sources": {
            "bundle": {"dir": bundle_dir.replace("\\", "/"), "format": bman.get("format"), "created": bman.get("created"),
                       "totals": bman.get("totals")},
            "module": {"dir": module_dir.replace("\\", "/"), "build": module_build},
            "segs": segs.replace("\\", "/"),
            "web": web.replace("\\", "/"),
        },
        "window_min": args.window_min,
        "brotli": {"available": brotli is not None, "quality": args.brotli_quality} if want_brotli else {"available": False},
        "gzip_level": args.gzip_level,
        "files": files,
        "totals": totals_of(files),
        "linked": how["link"], "copied": how["copy"],
    }
    with open(os.path.join(dist, MANIFEST_NAME), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    for n in notes:
        print("   " + n)
    print_table(files)
    print("built %s: %d files (%d hard-linked, %d copied), index %s (%d entries), manifest %s, %.1f s" % (
        dist, len(files), how["link"], how["copy"], INDEX_NAME, len(index), MANIFEST_NAME, time.time() - t0))
    return 0


# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------

def check_dist(dist: str, quick: bool = False) -> tuple[list[str], list[str], dict]:
    """Return (problems, notes, manifest). An empty problem list is a pass."""
    problems: list[str] = []
    notes: list[str] = []
    mpath = os.path.join(dist, MANIFEST_NAME)
    if not os.path.isfile(mpath):
        return ["no %s in %s" % (MANIFEST_NAME, dist)], notes, {}
    with open(mpath, encoding="utf-8") as f:
        manifest = json.load(f)
    if manifest.get("format") != MANIFEST_FORMAT:
        problems.append("manifest format %r, expected %r" % (manifest.get("format"), MANIFEST_FORMAT))
    listed: set[str] = {MANIFEST_NAME}
    files = manifest.get("files", [])
    for e in files:
        rel = e["path"]
        listed.add(rel)
        full = os.path.join(dist, rel)
        if not os.path.isfile(full):
            problems.append("missing: %s" % rel)
            continue
        size = os.stat(full).st_size
        if size != e["size"]:
            problems.append("size: %s is %d bytes, manifest says %d" % (rel, size, e["size"]))
            continue
        if not quick and sha256_file(full) != e["sha256"]:
            problems.append("hash: %s does not match its manifest sha256" % rel)
        for enc, ssize in (e.get("encodings") or {}).items():
            srel = rel + SIBLING_SUFFIX.get(enc, "." + enc)
            listed.add(srel)
            sfull = os.path.join(dist, srel)
            if not os.path.isfile(sfull):
                problems.append("missing sibling: %s" % srel)
                continue
            if os.stat(sfull).st_size != ssize:
                problems.append("size: sibling %s is %d bytes, manifest says %d" % (srel, os.stat(sfull).st_size, ssize))
                continue
            if quick:
                continue
            try:
                decoded = decode_sibling(sfull, enc)
            except Exception as ex:  # noqa: BLE001 - any decoder error is the finding
                problems.append("sibling: %s does not decode (%s)" % (srel, ex.__class__.__name__))
                continue
            if decoded is None:
                notes.append("sibling: %s not verified (no brotli module here)" % srel)
            elif hashlib.sha256(decoded).hexdigest() != e["sha256"]:
                problems.append("sibling: %s does not decode to its source" % srel)
    for f in PAGE_FILES + MODULE_FILES + (SEGS_NAME, INDEX_NAME):
        if f not in listed:
            problems.append("not listed: %s" % f)
    for rel in walk_files(dist):
        if rel not in listed:
            problems.append("extra: %s is not in the manifest" % rel)
    # the index against instance/
    ipath = os.path.join(dist, INDEX_NAME)
    if os.path.isfile(ipath):
        try:
            with open(ipath, encoding="utf-8") as f:
                index = json.load(f)
            ok_shape = isinstance(index, list) and all(isinstance(x, dict) and set(x) == {"p", "s"} for x in index)
            if not ok_shape:
                problems.append("index: %s is not an array of {p, s}" % INDEX_NAME)
            else:
                siblings = {p for p in listed if p.endswith((".br", ".gz"))}
                exclude = {p[len(INSTANCE_DIR) + 1:] for p in siblings if p.startswith(INSTANCE_DIR + "/")}
                expected = instance_index(os.path.join(dist, INSTANCE_DIR), exclude=exclude) if os.path.isdir(os.path.join(dist, INSTANCE_DIR)) else []
                got = sorted((x["p"], x["s"]) for x in index)
                want = sorted((x["p"], x["s"]) for x in expected)
                if got != want:
                    gs, ws = set(got), set(want)
                    for p, s in sorted(ws - gs)[:20]:
                        problems.append("index: %s (%d bytes) is under instance/ but not in %s" % (p, s, INDEX_NAME))
                    for p, s in sorted(gs - ws)[:20]:
                        problems.append("index: %s (%d bytes) is in %s but not under instance/ with that size" % (p, s, INDEX_NAME))
        except ValueError:
            problems.append("index: %s is not JSON" % INDEX_NAME)
    t = manifest.get("totals") or {}
    want_t = totals_of(files)
    if t.get("files") != want_t["files"] or t.get("bytes") != want_t["bytes"] or t.get("transfer") != want_t["transfer"]:
        problems.append("totals: the manifest's totals do not add up to its file list")
    return problems, notes, manifest


def cmd_check(args) -> int:
    dist = os.path.abspath(args.dist)
    problems, notes, manifest = check_dist(dist, quick=args.quick)
    for n in notes:
        print("   note: %s" % n)
    if problems:
        print("dist check FAILED: %d problem(s)" % len(problems))
        for p in problems[:100]:
            print("   %s" % p)
        return 1
    t = manifest.get("totals", {})
    print("dist check OK: %d files, %s bytes raw, %s bytes transfer with the best encoding%s" % (
        t.get("files", 0), fmt(t.get("bytes", 0)), fmt(t.get("transfer", 0)),
        " (sizes only)" if args.quick else ", every sha256 matches, every sibling decodes to its source"))
    return 0


def cmd_table(args) -> int:
    with open(os.path.join(os.path.abspath(args.dist), MANIFEST_NAME), encoding="utf-8") as f:
        manifest = json.load(f)
    print_table(manifest.get("files", []))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build", help="assemble a dist")
    p.add_argument("--bundle", default=DEFAULTS["bundle"], help="the bundle dir (bundle.py build), default .scratch/game-bundle")
    p.add_argument("--module", default=DEFAULTS["module"], help="the fast web module dir, default output/recomp/lift/boot-web-fast")
    p.add_argument("--segs", default=DEFAULTS["segs"], help="the memory image, default output/recomp/host/isaac.segs.bin")
    p.add_argument("--web", default=DEFAULTS["web"], help="where play.html, play.mjs and boot_web.mjs live")
    p.add_argument("--dist", default=DEFAULTS["dist"], help="the output folder, default .scratch/game-dist")
    p.add_argument("--copy", action="store_true", help="copy the bundle's files instead of hard-linking them")
    p.add_argument("--trail", default="", help="a boot trail (drive_boot.mjs writes <out>/boot-trail.json) shipped as /boot-trail.json: "
                   "a first visit's reader fetches the windows it names ahead of the engine")
    p.add_argument("--no-compress", action="store_true", help="no precompressed siblings at all")
    p.add_argument("--no-brotli", action="store_true", help="gzip siblings only")
    p.add_argument("--brotli-quality", type=int, default=11)
    p.add_argument("--gzip-level", type=int, default=9)
    p.add_argument("--window-min", type=int, default=WINDOW_MIN_DEFAULT,
                   help="ISAAC_FS_WINDOW_MIN in bytes: an instance file this big is windowed and gets no sibling")
    p.set_defaults(fn=cmd_build)
    p = sub.add_parser("check", help="verify a dist against dist.json")
    p.add_argument("dist")
    p.add_argument("--quick", action="store_true", help="sizes only, no hashing or decoding")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("table", help="print the size table of a dist")
    p.add_argument("dist")
    p.set_defaults(fn=cmd_table)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
