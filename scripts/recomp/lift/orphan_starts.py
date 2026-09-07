#!/usr/bin/env python3
"""Functions this image reaches only through a code pointer.

Round 86b. A mod called `Isaac.GetCostumeIdByPath` and the port stopped with

    [isaac][TRAP] indirect call to 0x0086fc60 from 0x00898e8b resolves to
                  neither a host shim nor a lifted function.
                  It is inside the image, so the function was not lifted.
    [isaac] reason: unresolved indirect call

0x0086fc60 is `mov eax, dword ptr [0xc71678]; ret`. Nothing calls it: MSVC
emitted this inline getter out of line only because its address was taken, and
the two references to it are immediates (`push 0x86fc60` at 0x0086dd24, and
`mov dword ptr [eax], 0x86fc60` at 0x00895ce6, which stores it into the Lua
userdata the binding later calls through). Ghidra never made a function of it,
so it was in no inventory the lifter reads, so it was never lifted -- and the
game itself never needs it. Only a mod does.

The PE index records every address escape (`kind = 'addr'`). Most of the ones
that land in .text are constants that merely look like addresses, so a
candidate has to earn its place:

  * the index decoded an instruction at exactly that address,
  * it is 16-byte aligned, which is how MSVC aligns function entries here,
  * the instruction that ends where it begins is an int3 -- the padding this
    image puts between functions, and
  * no function the lift already knows extends across it.

That last test is load-bearing rather than tidy. `func_starts` feeds
`discover_body`: a jump to a known start is lifted as a tail call instead of
being absorbed, so inventing a start INSIDE an existing function would change
how that function is lifted. A start that an existing function merely *begins*
at is evidence for the candidate, not against it, which is why the test is
strictly-inside.

The 117 survivors are all one-line accessors -- `mov eax,[ecx+disp]; ret`,
`lea eax,[ecx+disp]; ret`, `fld [ecx+disp]; ret`, two `jmp` thunks -- and all
117 are functions the index recovered bounds for on its own.

    python scripts/recomp/lift/orphan_starts.py            # report
    python scripts/recomp/lift/orphan_starts.py --write    # fold into the union
"""
import argparse
import bisect
import glob
import io
import json
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))
UNION = os.path.join(ROOT, "output/recomp/lift/starts_union.txt")
GHIDRA = os.path.join(ROOT, "output/recomp/export/functions.jsonl")
MARKER = "# round 86b: reached only through a code pointer (orphan_starts.py)"


def known_starts_and_extents(con):
    """Everything the lift already treats as a function, and how far each runs."""
    starts, extents = set(), []
    with io.open(UNION) as fh:
        for line in fh:
            line = line.split("#")[0].strip()
            if line:
                starts.add(int(line, 0))
    with io.open(GHIDRA) as fh:
        for line in fh:
            if not line.strip():
                continue
            d = json.loads(line)
            v = d.get("start") or d.get("va") or d.get("entry") or d.get("address")
            e = d.get("end") or d.get("stop")
            if isinstance(v, str):
                v = int(v, 16 if v.startswith("0x") else 10)
            if isinstance(e, str):
                e = int(e, 16 if e.startswith("0x") else 10)
            if v:
                starts.add(int(v))
                if e and e > v:
                    extents.append((int(v), int(e)))
    for s, e in con.execute("select start, end from func"):
        if e and e > s:
            extents.append((s, e))
    extents.sort()
    return starts, extents


def census():
    db = glob.glob(os.path.join(ROOT, "output/decomp/*/index/pe-index.sqlite"))
    if not db:
        sys.exit("no PE index: python scripts/decomp/tools/build-pe-index.py")
    con = sqlite3.connect(db[0])
    lo, hi = con.execute("select min(va), max(va) from insn").fetchone()
    starts, extents = known_starts_and_extents(con)
    ext_lo = [a for a, _ in extents]

    size = {va: sz for va, sz in con.execute(
        "select va, size from insn where va >= ? and va <= ?", (lo, hi))}
    mnem = dict(con.execute(
        "select va, mn from insn where va >= ? and va <= ?", (lo, hi)))
    ordered = sorted(size)

    def inside(va):
        i = bisect.bisect_right(ext_lo, va) - 1
        return i >= 0 and extents[i][0] < va < extents[i][1]

    def padded(va):
        # image.bin is not a flat image, so bytes cannot be indexed by VA: the
        # index's own decode is the authority on what precedes an address
        i = bisect.bisect_left(ordered, va) - 1
        if i < 0:
            return False
        prev = ordered[i]
        return prev + size[prev] == va and mnem.get(prev) == "int3"

    esc = {}
    for src, dst in con.execute(
            "select src, dst from xref where kind = 'addr' and dst >= ? and dst <= ?",
            (lo, hi)):
        esc.setdefault(dst, []).append(src)

    drop = dict(known=0, unaligned=0, not_insn=0, no_pad=0, inside=0)
    keep = []
    for dst in sorted(esc):
        if dst in starts:       drop["known"] += 1;     continue
        if dst % 16:            drop["unaligned"] += 1; continue
        if dst not in size:     drop["not_insn"] += 1;  continue
        if not padded(dst):     drop["no_pad"] += 1;    continue
        if inside(dst):         drop["inside"] += 1;    continue
        keep.append(dst)
    return con, size, esc, keep, drop, len(starts)


def shape(con, size, va, n=4):
    out, at = [], va
    for _ in range(n):
        row = con.execute("select mn, ops from insn where va = ?", (at,)).fetchone()
        if not row:
            break
        out.append((row[0] + " " + (row[1] or "")).strip())
        if row[0] in ("ret", "jmp"):
            break
        at += size[at]
    return " ; ".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write", action="store_true",
                    help="append the survivors to starts_union.txt (idempotent)")
    args = ap.parse_args()

    con, size, esc, keep, drop, nstarts = census()
    print("known starts        : %d" % nstarts)
    print("address escapes     : %d distinct targets in .text" % len(esc))
    print("  already a start   : %d" % drop["known"])
    print("  not 16-aligned    : %d" % drop["unaligned"])
    print("  not an instruction: %d" % drop["not_insn"])
    print("  no int3 before it : %d" % drop["no_pad"])
    print("  inside a function : %d" % drop["inside"])
    print("orphan functions    : %d" % len(keep))
    for va in keep:
        print("  0x%08x  %d escape(s)  %s" % (va, len(esc[va]), shape(con, size, va)))

    if not args.write:
        return 0
    text = io.open(UNION).read()
    have = {int(l.split("#")[0].strip(), 0)
            for l in text.splitlines() if l.split("#")[0].strip()}
    add = [v for v in keep if v not in have]
    if not add:
        print("\nstarts_union.txt already has all %d" % len(keep))
        return 0
    with io.open(UNION, "a", newline="\n") as fh:
        if MARKER not in text:
            fh.write("%s\n" % MARKER)
        for va in add:
            fh.write("0x%08x\n" % va)
    print("\nstarts_union.txt: +%d (now %d)" % (len(add), len(have) + len(add)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
