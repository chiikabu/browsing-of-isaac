#!/usr/bin/env python3
"""The shipping bundle: which files of a game instance the port needs, decided by census.

  build    INSTANCE OUT [--original DIR] [--copy] [--strict] [--json REPORT]
           assemble OUT from INSTANCE by the rule set below (hard links, or copies with
           --copy; nothing is re-encoded here), write OUT/.bundle.json (the manifest: every
           file with its size and sha256), print the size table
  check    BUNDLE [--quick]      verify a bundle against its manifest: every listed file
           present with its size and hash (--quick: sizes only), no file that is not listed
  classify INSTANCE [--all]      every file of an instance with its verdict and the rule
  table    --original DIR --instance DIR --bundle DIR      the size table on its own
  rules                          print the rule set

The rules are the round-28 census (docs/recomp-architecture.md 21.43): the node fast profile
booted from the optimised instance with ISAAC_FS_TRACE=1 (every probe the RAM-FS shim
answers) plus a host-level fs hook (every open/read the node process makes, which is where
the host Lua's NODERAWFS reads live -- the shim never sees them), through the scripted
timeline to a Basement at 3,000 frames and through ISAAC_CUTSCENE=300:3 (the video path);
and the browser runner's served-files index (run_web.mjs served_files.json). What the runs
opened: the ten archives the engine mounts (in this order: animations, config, fonts,
graphics, music, rooms, sfx, videos, afterbirth, afterbirthp -- the exe's static list at
0xbfae60 minus the seven language packs it also names and the secret.a it asks for and
lacks), savedatapath.txt (one fopen at boot), and resources/scripts/enums.lua + main.lua
(read by the host Lua from the cwd; the engine's own fopen of them may miss). Everything
else in the instance was registered by size and never opened, or not even registered:
the loose extracted tree (gfx/, font/, rooms/, the root xml tables, the resources/ copies
-- the archive index answers before a mount root's loose map, and afterbirthp.a shadows
the whole tree), repentance.a (this exe never names it), the language packs (a mounted
pack overwrites equal-hash entries and would shadow English assets), the executables and
runtime DLLs (the lifted module IS the exe), and run-time state (the game creates
Documents/My Games/..., data/ and mods/ itself with CreateDirectoryA and writes its saves
there).

A bundle is hard-linked by default: it costs no disk space next to its instance, and a
hard link IS the same file -- edit through one name and the other sees it. --copy makes
independent copies. The manifest is metadata only (paths, sizes, hashes); no game bytes
enter the repository through this tool.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import shutil
import sys
import time
from dataclasses import dataclass

MANIFEST_NAME = ".bundle.json"
MANIFEST_FORMAT = "isaac-recomp-bundle/1"
KEEP = "keep"
DROP = "drop"

# The archives the engine mounts, in mount order (the first fopen of each in the trace).
MOUNTED_ARCHIVES = ("animations", "config", "fonts", "graphics", "music", "rooms", "sfx", "videos",
                    "afterbirth", "afterbirthp")
LANGUAGE_CODES = ("de", "es", "fr", "jp", "kr", "ru", "zh")


@dataclass(frozen=True)
class Rule:
    name: str
    verdict: str
    patterns: tuple[str, ...]
    group: str
    evidence: str


# First match wins. Patterns are fnmatch patterns over the forward-slash relative path
# (`*` crosses directory separators, so "gfx/*" is the whole subtree).
RULES: tuple[Rule, ...] = (
    Rule("mounted-archive", KEEP, tuple("resources/packed/%s.a" % n for n in MOUNTED_ARCHIVES), "archives",
         "the ten archives the mount loop (0x00a179c0) opens, every run: 11,830 / 2,898 / 2,627 / 494 / 90 / 25 / "
         "18 / 14 / 13 / 2 fopen hits in the timeline census"),
    Rule("lua-scripts", KEEP, ("resources/scripts/*.lua", "resources/scripts/licenses"), "scripts + save path",
         "enums.lua and main.lua are read by the host Lua from the cwd (NODERAWFS: 158,046 + 46,813 bytes through "
         "openSync/readSync in the host census) and probed by the engine's fopen; the rest of the Lua tree is what "
         "`require` can reach from them (json, mobdebug, socket) and its licence text"),
    Rule("save-path-note", KEEP, ("savedatapath.txt",), "scripts + save path",
         "one fopen hit at boot in every run (the engine reads it; the saves then go to ./Documents/My Games/...)"),
    Rule("page-assets", KEEP, ("page-assets/*",), "page assets",
         "round 52: the shipping page's EDIT FILE menu -- the patched save-select sheet, the seed paper, the cursor, "
         "the Team Meat font and seven menu sounds, extracted from the archives by page_assets.py (menu.json has the "
         "crop rectangles); the page fetches them, the engine never opens them"),
    Rule("repentance-archive", DROP, ("resources/packed/repentance.a",), "repentance.a",
         "this exe never names it (whole-.text census, round 26; not in the 0xbfae60 mount list); 0 opens; "
         "unregistered by both drivers"),
    Rule("language-pack", DROP, tuple("resources/packed/*_%s.a" % c for c in LANGUAGE_CODES), "language packs",
         "must stay unmounted: the mount loop overwrites an equal-hash entry (0x00a17e22), so a mounted pack would "
         "shadow English assets; the engine logs 'Failed to open archive file' for the seven it names and carries on"),
    Rule("packed-other", DROP, ("resources/packed/*",), "dev leftovers",
         "not in the engine's mount list; 0 opens (readme.txt)"),
    Rule("native-binary", DROP, ("*.exe", "*.dll", "*.so", "run.bat", "steam_appid.txt"), "executables, libraries",
         "the lifted module is the exe and the host shims are its DLLs; the drivers never register these; 0 opens"),
    Rule("runtime-state", DROP, ("Documents/*", "data/*", "mods/*", ".*", "*/.*", "*.log"), "run-time state, provenance",
         "created by the game itself at run time (CreateDirectoryA; the saves and options.ini are written, then "
         "re-opened) -- nothing under them was registered in the census runs; dot files and logs are provenance"),
    Rule("loose-tree", DROP,
         ("gfx/*", "font/*", "rooms/*", "minigames/*", "shaders/*", "scripts/*", "scripts_v2/*", "packed/*",
          "resources/gfx/*", "resources/font/*", "resources/shaders/*", "resources/scripts/*", "resources/*.xml",
          "*.xml", "*.sta", "*.ini", "*.b", "keeper.a", "secret.a", "profanity_list.txt"),
         "loose extracted tree",
         "the ResourceExtractor dump of the archives' contents: registered by size (11,198 files) and read 0 times "
         "in every traced run -- KAGE resolves a key against the archive index before a mount root's loose map, "
         "and the mounted set holds the Repentance+ files; secret.a is asked for as resources/secret.a (MISS) and "
         "keeper.a never"),
)
UNCLASSIFIED = Rule("unclassified", DROP, (), "unclassified", "no rule matched -- look at it before shipping")


def classify(rel: str) -> Rule:
    rel = rel.replace("\\", "/")
    for r in RULES:
        for pat in r.patterns:
            if fnmatch.fnmatchcase(rel, pat):
                return r
    return UNCLASSIFIED


# ---------------------------------------------------------------------------
# trees
# ---------------------------------------------------------------------------

def walk_tree(root: str) -> dict[str, int]:
    """{relative forward-slash path: size} for every regular file under root, links followed
    (an instance can be a tree of junctions/symlinks onto another one)."""
    out: dict[str, int] = {}
    root = os.path.abspath(root)
    for dp, dn, fn in os.walk(root, followlinks=True):
        dn.sort()
        for f in sorted(fn):
            full = os.path.join(dp, f)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root).replace("\\", "/")
            out[rel] = st.st_size
    return out


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fmt(n: int | None) -> str:
    return "-" if n is None else format(n, ",")


# ---------------------------------------------------------------------------
# the size table
# ---------------------------------------------------------------------------

def size_rows(original: dict[str, int] | None, instance: dict[str, int], bundle: dict[str, int] | None) -> list[dict]:
    """Rows: one per mounted archive (mount order), then one per group. Each row carries the
    three columns (None where the tree does not hold it) and the file counts."""
    rows = []
    for name in MOUNTED_ARCHIVES:
        rel = "resources/packed/%s.a" % name
        rows.append({"row": rel, "kind": "file", "files": 1,
                     "original": original.get(rel) if original is not None else None,
                     "instance": instance.get(rel),
                     "bundle": bundle.get(rel) if bundle is not None else None})
    groups: dict[str, dict] = {}
    order = []
    for tree_name, tree in (("original", original), ("instance", instance), ("bundle", bundle)):
        if tree is None:
            continue
        for rel, size in tree.items():
            r = classify(rel)
            if r.name == "mounted-archive":
                continue
            g = groups.get(r.group)
            if g is None:
                g = groups[r.group] = {"row": r.group, "kind": "group", "verdict": r.verdict,
                                       "original": None, "instance": None, "bundle": None, "files": 0, "rules": set()}
                order.append(r.group)
            g[tree_name] = (g[tree_name] or 0) + size
            if tree_name == "instance":
                g["files"] += 1
            g["rules"].add(r.name)
    for name in order:
        g = groups[name]
        g["rules"] = sorted(g["rules"])
        rows.append(g)
    return rows


def totals(tree: dict[str, int] | None) -> tuple[int, int] | None:
    if tree is None:
        return None
    return len(tree), sum(tree.values())


def print_table(rows: list[dict], original: dict[str, int] | None, instance: dict[str, int],
                bundle: dict[str, int] | None, out=sys.stdout) -> None:
    cols = [("original", original is not None), ("instance", True), ("bundle", bundle is not None)]
    w = 34
    head = "%-*s" % (w, "archive / group") + "".join("  %16s" % c for c, on in cols if on) + "  files"
    print(head, file=out)
    print("-" * len(head), file=out)
    for r in rows:
        line = "%-*s" % (w, r["row"][:w])
        for c, on in cols:
            if on:
                line += "  %16s" % fmt(r[c])
        line += "  %5d" % r["files"]
        if r["kind"] == "group":
            line += "  (%s)" % ("kept" if r["verdict"] == KEEP else "dropped")
        print(line, file=out)
    print("-" * len(head), file=out)
    line = "%-*s" % (w, "TOTAL")
    for c, tree in (("original", original), ("instance", instance), ("bundle", bundle)):
        t = totals(tree)
        if t is not None:
            line += "  %16s" % fmt(t[1])
    line += "  %5d" % len(instance)
    print(line, file=out)
    base = totals(original) or totals(instance)
    if bundle is not None and base and base[1]:
        tb = totals(bundle)
        print("bundle: %s bytes in %d files = %.2f%% of the %s (%s bytes, %d files)" % (
            fmt(tb[1]), tb[0], 100.0 * tb[1] / base[1], "original instance" if original is not None else "instance",
            fmt(base[1]), base[0]), file=out)


# ---------------------------------------------------------------------------
# build / check
# ---------------------------------------------------------------------------

def link_or_copy(src: str, dst: str, copy: bool) -> str:
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    if os.path.lexists(dst):
        os.unlink(dst)
    if not copy:
        try:
            os.link(src, dst)
            return "link"
        except OSError:
            pass
    shutil.copyfile(src, dst)
    return "copy"


def cmd_build(args) -> int:
    t0 = time.time()
    instance = os.path.abspath(args.instance)
    out = os.path.abspath(args.out)
    if os.path.abspath(out) == instance:
        print("refusing to build a bundle onto its own instance", file=sys.stderr)
        return 2
    tree = walk_tree(instance)
    kept = {rel: size for rel, size in tree.items() if classify(rel).verdict == KEEP}
    unclassified = sorted(rel for rel in tree if classify(rel) is UNCLASSIFIED)
    if unclassified:
        print("%d unclassified file(s) (dropped):" % len(unclassified))
        for rel in unclassified[:50]:
            print("   %s" % rel)
        if args.strict:
            print("--strict: refusing to build with unclassified files", file=sys.stderr)
            return 1
    os.makedirs(out, exist_ok=True)
    # a stale bundle: remove files that are no longer in the plan (never anything outside it)
    if os.path.isdir(out):
        for rel in walk_tree(out):
            if rel != MANIFEST_NAME and rel not in kept:
                os.unlink(os.path.join(out, rel))
    files = []
    how = {"link": 0, "copy": 0}
    for rel in sorted(kept):
        src = os.path.join(instance, rel)
        dst = os.path.join(out, rel)
        how[link_or_copy(os.path.realpath(src), dst, args.copy)] += 1
        files.append({"path": rel, "size": kept[rel], "sha256": sha256_file(dst), "rule": classify(rel).name})
    # prune directories left empty by the removal above
    for dp, dn, fn in os.walk(out, topdown=False):
        if dp != out and not dn and not fn:
            os.rmdir(dp)
    original = walk_tree(args.original) if args.original else None
    bundle = walk_tree(out)
    bundle.pop(MANIFEST_NAME, None)
    rows = size_rows(original, tree, bundle)
    dropped = [{"group": r["row"], "files": r["files"], "bytes": r["instance"] or 0, "rules": r["rules"]}
               for r in rows if r["kind"] == "group" and r["verdict"] == DROP]
    manifest = {
        "format": MANIFEST_FORMAT,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "source": {"instance": instance.replace("\\", "/"), "files": len(tree), "bytes": sum(tree.values())},
        "original": ({"dir": os.path.abspath(args.original).replace("\\", "/"), "files": len(original),
                      "bytes": sum(original.values())} if original is not None else None),
        "mount_order": list(MOUNTED_ARCHIVES),
        "files": files,
        "dropped": dropped,
        "unclassified": unclassified,
        "totals": {"files": len(files), "bytes": sum(f["size"] for f in files)},
        "linked": how["link"], "copied": how["copy"],
    }
    with open(os.path.join(out, MANIFEST_NAME), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print_table(rows, original, tree, bundle)
    print("built %s: %d files (%d hard-linked, %d copied), manifest %s, %.1f s" % (
        out, len(files), how["link"], how["copy"], MANIFEST_NAME, time.time() - t0))
    # round 52: the page's EDIT FILE assets (the patched sheet into afterbirthp.a
    # -- the bundle's own copy, the instance stays pristine -- and the menu's
    # art, font and sounds beside it); the manifest is updated by the step
    import page_assets
    page_assets.build(out)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"manifest": manifest, "rows": rows,
                       "totals": {"original": totals(original), "instance": totals(tree), "bundle": totals(bundle)}},
                      f, indent=1, default=list)
            f.write("\n")
    return 0


def check_bundle(bundle_dir: str, quick: bool = False) -> tuple[list[str], dict]:
    """Return (problems, manifest). An empty problem list is a pass."""
    problems: list[str] = []
    mpath = os.path.join(bundle_dir, MANIFEST_NAME)
    if not os.path.isfile(mpath):
        return ["no %s in %s" % (MANIFEST_NAME, bundle_dir)], {}
    with open(mpath, encoding="utf-8") as f:
        manifest = json.load(f)
    if manifest.get("format") != MANIFEST_FORMAT:
        problems.append("manifest format %r, expected %r" % (manifest.get("format"), MANIFEST_FORMAT))
    listed = {}
    for entry in manifest.get("files", []):
        rel = entry["path"]
        listed[rel] = entry
        full = os.path.join(bundle_dir, rel)
        if not os.path.isfile(full):
            problems.append("missing: %s" % rel)
            continue
        size = os.stat(full).st_size
        if size != entry["size"]:
            problems.append("size: %s is %d bytes, manifest says %d" % (rel, size, entry["size"]))
            continue
        if not quick and sha256_file(full) != entry["sha256"]:
            problems.append("hash: %s does not match its manifest sha256" % rel)
        if classify(rel).verdict != KEEP:
            problems.append("rule: %s is listed but the current rules would drop it (%s)" % (rel, classify(rel).name))
    for rel in walk_tree(bundle_dir):
        if rel != MANIFEST_NAME and rel not in listed:
            problems.append("extra: %s is not in the manifest" % rel)
    t = manifest.get("totals", {})
    if t and (t.get("files") != len(listed) or t.get("bytes") != sum(e["size"] for e in listed.values())):
        problems.append("totals: the manifest's totals do not add up to its file list")
    return problems, manifest


def cmd_check(args) -> int:
    problems, manifest = check_bundle(os.path.abspath(args.bundle), quick=args.quick)
    t = manifest.get("totals", {})
    if problems:
        print("bundle check FAILED: %d problem(s)" % len(problems))
        for p in problems[:100]:
            print("   %s" % p)
        return 1
    print("bundle check OK: %d files, %s bytes%s" % (t.get("files", 0), fmt(t.get("bytes", 0)),
                                                     " (sizes only)" if args.quick else ", every sha256 matches"))
    return 0


def cmd_classify(args) -> int:
    tree = walk_tree(args.instance)
    counts: dict[str, list[int]] = {}
    for rel in sorted(tree):
        r = classify(rel)
        c = counts.setdefault(r.name, [0, 0])
        c[0] += 1
        c[1] += tree[rel]
        if args.all or r.verdict == KEEP or r is UNCLASSIFIED:
            print("%-4s %-18s %12s  %s" % (r.verdict, r.name, fmt(tree[rel]), rel))
    print("--")
    for name, (n, b) in sorted(counts.items(), key=lambda kv: -kv[1][1]):
        print("%-18s %6d files %16s bytes" % (name, n, fmt(b)))
    return 0


def cmd_table(args) -> int:
    original = walk_tree(args.original) if args.original else None
    instance = walk_tree(args.instance)
    bundle = None
    if args.bundle:
        bundle = walk_tree(args.bundle)
        bundle.pop(MANIFEST_NAME, None)
    print_table(size_rows(original, instance, bundle), original, instance, bundle)
    return 0


def cmd_rules(_args) -> int:
    for r in RULES + (UNCLASSIFIED,):
        print("%-4s %-18s %s" % (r.verdict, r.name, ", ".join(r.patterns) or "(anything else)"))
        print("     group: %s" % r.group)
        print("     evidence: %s" % r.evidence)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build", help="assemble a bundle from an instance dir")
    p.add_argument("instance"); p.add_argument("out")
    p.add_argument("--original", help="the pristine instance, for the size table's first column")
    p.add_argument("--copy", action="store_true", help="copy files instead of hard-linking them")
    p.add_argument("--strict", action="store_true", help="fail if any file matches no rule")
    p.add_argument("--json", help="write the manifest, rows and totals as JSON")
    p.set_defaults(fn=cmd_build)
    p = sub.add_parser("check", help="verify a bundle against its manifest")
    p.add_argument("bundle"); p.add_argument("--quick", action="store_true", help="sizes only, no hashing")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("classify", help="print each file's verdict"); p.add_argument("instance")
    p.add_argument("--all", action="store_true", help="also list the dropped files")
    p.set_defaults(fn=cmd_classify)
    p = sub.add_parser("table", help="the size table")
    p.add_argument("--original"); p.add_argument("--instance", required=True); p.add_argument("--bundle")
    p.set_defaults(fn=cmd_table)
    p = sub.add_parser("rules", help="print the rule set"); p.set_defaults(fn=cmd_rules)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
