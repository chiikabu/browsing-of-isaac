#!/usr/bin/env python3
"""Split giant lifted functions into trampolined parts (round 43, a build-time text pass).

The lifter emits one C function per x86 function. A few of the game's routines
are enormous -- sub_005d4380 is 338,000 lines of C, 5,042 labels, 1.57 MB of
wasm -- and V8 pays for them quadratically: a wasm function's baseline compile
keeps a register/stack snapshot at every jump target, sized by the function's
locals, and these functions have thousands of both. The browser's memory-infra
dump caught `v8/main/malloc` (zone memory) at 1.1 GB with tier-up on and 2.5 GB
with it off at the first run start, when the giants are compiled lazily.

This pass rewrites such a function, in the lifted C, into

    static uint32_t sub_X__pend, sub_X__next;
    static void sub_X__p0(CpuState *restrict s, uint32_t nb) { ... }   /* a contiguous slice of blocks */
    ...
    void sub_X(CpuState *restrict s) {                                  /* the trampoline */
        nb = start (or g_reentry_eip, consumed);
        for (;;) { pend = 0; route nb to its part; if (!pend) return; nb = next; }
    }

Each part carries the function's prologue (the x86 registers and flags loaded
from the CpuState) and only the temporaries it uses, enters through a switch
over its own labels, keeps every goto inside itself, and turns a goto into
another part into `spill the registers; next = target; pend = 1; return;` --
the trampoline re-enters the target part with a loop, never a nested call, so
a loop that crosses a cut cannot grow the native stack. An x86 `ret`, a parked
tail jump or a trap returns with pend clear and the trampoline returns. Block
re-entry (patch_reentry's g_reentry_eip) is consumed by the trampoline, whose
routing table lists every label of every part, so the parts need no guard.

Only functions above SPLIT_MIN_LINES are touched; a part is at most about
SPLIT_PART_LINES, cut at block labels. The pass is idempotent (a split
function is marked `/* LIFT-SPLIT */`) and `--check` reports without writing.

    python split_giants.py [--dir LIFT_DIR] [--check] [--min N] [--part N]
"""
import argparse
import os
import re
import sys
from pathlib import Path

SPLIT_MIN_LINES = 60000
SPLIT_PART_LINES = 25000
MARK = "/* LIFT-SPLIT"
VERSION = "v2"           # v2: a part ends with a jump to the next part (fall-through), parts are noinline

RE_FN = re.compile(r"^void (sub_[0-9a-f]{8}[A-Za-z0-9_]*)\(CpuState \*restrict s\) \{$")
RE_ROOT = re.compile(r"^  (uint(?:8|16|32|64)_t) ([A-Za-z_]\w*) = s->\2;$")
RE_UNIQ = re.compile(r"^  (uint(?:8|16|32|64)_t) ([A-Za-z_]\w*) = 0;$")
RE_BIG = re.compile(r"^  uint8_t ([A-Za-z_]\w*)\[(\d+)\] = \{0\};$")
RE_LBL = re.compile(r"^L_([0-9a-f]{8}): ;$")
RE_GOTO = re.compile(r"\bgoto (L_[0-9a-f]{8}|P_[0-9a-f]{8}_\d+);")
RE_IDENT = re.compile(r"[A-Za-z_]\w*")


class SplitSkip(Exception):
    pass


def split_function(name, lines, part_lines):
    """lines: the function's lines from the header to the closing brace (no line endings).
    Returns the replacement lines, or raises SplitSkip."""
    assert RE_FN.match(lines[0]) and lines[-1] == "}"
    start = int(name[4:12], 16)
    i = 1
    roots, others = [], []          # (type, name) ; other decl lines verbatim with their identifier
    while i < len(lines):
        m = RE_ROOT.match(lines[i])
        if m:
            roots.append((m.group(1), m.group(2))); i += 1; continue
        m = RE_UNIQ.match(lines[i])
        if m:
            others.append((m.group(2), lines[i])); i += 1; continue
        m = RE_BIG.match(lines[i])
        if m:
            others.append((m.group(1), lines[i])); i += 1; continue
        # the re-entry guard (patch_reentry) sits inside the declarations -- it is
        # inserted after the first declaration block its own regex recognises, and
        # the 64-bit temporaries follow it; the trampoline replaces it
        if lines[i] == "  if (g_reentry_eip != 0u) {":
            j = i + 1
            while j < len(lines) and lines[j] != "  }":
                j += 1
            if j >= len(lines):
                raise SplitSkip("unterminated re-entry guard")
            i = j + 1
            continue
        break
    if i >= len(lines) or lines[i] != "  (void)0;":
        raise SplitSkip("not the goto shape (no `(void)0;` after the declarations)")
    i += 1
    if i < len(lines) and lines[i].startswith("  goto L_") and "entry block" in lines[i]:
        i += 1                       # the entry-first goto: the trampoline routes to the entry itself
    body = lines[i:-1]
    if any(l.startswith("  for (;;) { switch (") for l in body[:3]):
        raise SplitSkip("dispatch shape")
    if not roots:
        raise SplitSkip("no register prologue")
    # cut at block labels into parts of about part_lines
    cuts = [0]
    since = 0
    for k, l in enumerate(body):
        since += 1
        if since >= part_lines and RE_LBL.match(l) and k > cuts[-1]:
            cuts.append(k); since = 0
    if len(cuts) < 2:
        raise SplitSkip("fits one part")
    cuts.append(len(body))
    parts = [body[cuts[p]:cuts[p + 1]] for p in range(len(cuts) - 1)]
    start_label = "L_%08x" % start
    have_start = any(RE_LBL.match(l) and l[:10] == start_label for p in parts for l in p)
    if not have_start:
        parts[0].insert(0, start_label + ": ;")      # the lowest block is the entry: give it its label
    label_part = {}
    for pi, p in enumerate(parts):
        for l in p:
            m = RE_LBL.match(l)
            if m:
                label_part["L_" + m.group(1)] = pi
            elif l.startswith("P_") and l.endswith(": ;"):
                label_part[l[:-3]] = pi
    spill = "".join("s->%s = %s; " % (r, r) for _, r in roots)
    out = []
    out.append("extern uint32_t g_reentry_eip;")
    out.append("static uint32_t %s__pend, %s__next;" % (name, name))
    for pi, p in enumerate(parts):
        text = "\n".join(p)
        used = set(RE_IDENT.findall(text))
        rewritten = []
        for l in p:
            def rep(m):
                tgt = m.group(1)
                tp = label_part.get(tgt)
                if tp is None:
                    raise SplitSkip("goto to an unknown label %s" % tgt)
                if tp == pi:
                    return m.group(0)
                if tgt.startswith("P_"):
                    raise SplitSkip("a sub-label jump crosses a cut (%s)" % tgt)
                return "{ %s%s__next = 0x%su; %s__pend = 1u; return; }" % (spill, name, tgt[2:], name)
            rewritten.append(RE_GOTO.sub(rep, l))
        out.append("static void __attribute__((noinline)) %s__p%d(CpuState *restrict s, uint32_t nb) {" % (name, pi))
        for t, r in roots:
            out.append("  %s %s = s->%s;" % (t, r, r))
        for ident, decl in others:
            if ident in used:
                out.append(decl)
        out.append("  switch (nb) {")
        for l in p:
            m = RE_LBL.match(l)
            if m:
                out.append("  case 0x%su: goto L_%s;" % (m.group(1), m.group(1)))
        out.append("  default: recomp_unreachable(s, nb); return;")
        out.append("  }")
        out.extend(rewritten)
        if pi + 1 < len(parts):
            # blocks are emitted in address order and a block falls through into
            # the next one without a goto; a cut between them must not fall off
            # the part, so the part ends with a jump to the next part's first label
            first = next(RE_LBL.match(l).group(1) for l in parts[pi + 1] if RE_LBL.match(l))
            out.append("  { %s%s__next = 0x%su; %s__pend = 1u; return; }   /* fall-through across the cut */" % (spill, name, first, name))
        out.append("}")
    out.append("void %s(CpuState *restrict s) {   %s %s %s: %d parts, %d lines */" % (name, MARK, VERSION, name, len(parts), len(body)))
    out.append("  uint32_t nb = 0x%08xu;" % start)
    out.append("  if (g_reentry_eip != 0u) { nb = g_reentry_eip; g_reentry_eip = 0u; }")
    out.append("  for (;;) {")
    out.append("    %s__pend = 0u;" % name)
    out.append("    switch (nb) {")
    for pi, p in enumerate(parts):
        cases = ["case 0x%su:" % RE_LBL.match(l).group(1) for l in p if RE_LBL.match(l)]
        for k in range(0, len(cases), 8):
            out.append("    " + " ".join(cases[k:k + 8]))
        out.append("      %s__p%d(s, nb); break;" % (name, pi))
    out.append("    default: recomp_unreachable(s, nb); return;")
    out.append("    }")
    out.append("    if (!%s__pend) return;" % name)
    out.append("    nb = %s__next;" % name)
    out.append("  }")
    out.append("}")
    return out


RE_PEND = re.compile(r"^static uint32_t (sub_[0-9a-f]{8}[A-Za-z0-9_]*)__pend, \1__next;$")


def unsplit_function(name, region):
    """The inverse of split_function on a region (from the __pend line to the
    trampoline's closing brace): the function as the lifter left it, minus the
    re-entry guard (the trampoline's job now) -- the input for a re-split."""
    roots, others, seen, body = [], [], set(), []
    xpart = re.compile(r"\{ (?:s->\w+ = \w+; )+%s__next = 0x([0-9a-f]{8})u; %s__pend = 1u; return; \}" % (name, name))
    i = 1
    while i < len(region) and not region[i].startswith("void %s(CpuState *restrict s) {" % name):
        if region[i].startswith("static void") and ("%s__p" % name) in region[i]:
            i += 1
            while i < len(region) and (RE_ROOT.match(region[i]) or RE_UNIQ.match(region[i]) or RE_BIG.match(region[i])):
                m = RE_ROOT.match(region[i])
                if m:
                    if not any(r == m.group(2) for _, r in roots):
                        roots.append((m.group(1), m.group(2)))
                else:
                    ident = (RE_UNIQ.match(region[i]) or RE_BIG.match(region[i])).group(2 if RE_UNIQ.match(region[i]) else 1)
                    if ident not in seen:
                        seen.add(ident); others.append(region[i])
                i += 1
            if i >= len(region) or region[i] != "  switch (nb) {":
                raise SplitSkip("a part without its entry switch")
            while region[i] != "  }":
                i += 1
            i += 1
            while i < len(region) and region[i] != "}":
                l = region[i]
                if "/* fall-through across the cut */" not in l:
                    body.append(xpart.sub(lambda m: "goto L_%s;" % m.group(1), l))
                i += 1
            i += 1
        else:
            i += 1
    if not roots:
        raise SplitSkip("no parts to unsplit")
    fn = ["void %s(CpuState *restrict s) {" % name]
    fn += ["  %s %s = s->%s;" % (t, r, r) for t, r in roots]
    fn += others
    fn.append("  (void)0;")
    fn += body
    fn.append("}")
    return fn


def split_text(text, min_lines, part_lines, log=None):
    """Returns (new_text, [(name, parts, lines)], [(name, reason)])."""
    # the lifter writes LF and patch_reentry rewrites its lines with CRLF, so a TU
    # is mixed: normalise per line, write back with the majority ending
    crlf = text.count("\r\n") > text.count("\n") // 2
    lines = [l[:-1] if l.endswith("\r") else l for l in text.split("\n")]
    out, done, skipped = [], [], []
    i = 0
    while i < len(lines):
        # an earlier split (another version): unsplit the region and redo it
        mp = RE_PEND.match(lines[i])
        if mp:
            name = mp.group(1)
            j = i + 1
            while j < len(lines) and not lines[j].startswith("void %s(CpuState *restrict s) {" % name):
                j += 1
            k = j
            while k < len(lines) and lines[k] != "}":
                k += 1
            if j < len(lines) and k < len(lines):
                if ("%s %s " % (MARK, VERSION)) in lines[j]:
                    out.extend(lines[i:k + 1]); i = k + 1; continue      # current version: keep
                if out and out[-1] == "extern uint32_t g_reentry_eip;":
                    out.pop()
                try:
                    fn = unsplit_function(name, lines[i:k + 1])
                    rep = split_function(name, fn, part_lines)
                    done.append((name, sum(1 for l in rep if l.startswith("static void") and ("%s__p" % name) in l), len(fn)))
                    out.extend(rep)
                except SplitSkip as e:
                    skipped.append((name, "re-split: " + str(e)))
                    out.extend(lines[i:k + 1])
                i = k + 1
                continue
        m = RE_FN.match(lines[i])
        if not m or MARK in lines[i]:
            out.append(lines[i]); i += 1; continue
        j = i + 1
        while j < len(lines) and lines[j] != "}":
            j += 1
        if j >= len(lines):
            out.extend(lines[i:]); break
        fn = lines[i:j + 1]
        if len(fn) <= min_lines:
            out.extend(fn); i = j + 1; continue
        try:
            rep = split_function(m.group(1), fn, part_lines)
            done.append((m.group(1), sum(1 for l in rep if l.startswith("static void") and ("%s__p" % m.group(1)) in l), len(fn)))
            out.extend(rep)
        except SplitSkip as e:
            skipped.append((m.group(1), str(e)))
            out.extend(fn)
        i = j + 1
    return ("\r\n" if crlf else "\n").join(out), done, skipped


def apply_split_giants(lift_dir, min_lines=SPLIT_MIN_LINES, part_lines=SPLIT_PART_LINES, check=False):
    """Split every giant in every lifted TU; returns the list of modified files."""
    modified = []
    for path in sorted(Path(lift_dir).glob("lifted_*.c")):
        text = path.read_text(encoding="utf-8", errors="surrogateescape")
        if not any(len(l) for l in ()) and text.count("\n") <= min_lines:
            continue
        new, done, skipped = split_text(text, min_lines, part_lines)
        for name, parts, n in done:
            print("split : %s in %s -> %d parts (%d lines)" % (name, path.name, parts, n))
        for name, why in skipped:
            print("split : %s in %s left whole (%s)" % (name, path.name, why))
        if done and new != text and not check:
            path.write_text(new, encoding="utf-8", errors="surrogateescape")
            modified.append(str(path))
        elif done and new != text:
            modified.append(str(path))
    return modified


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=None)
    ap.add_argument("--check", action="store_true", help="report what would be split, write nothing")
    ap.add_argument("--min", type=int, default=SPLIT_MIN_LINES)
    ap.add_argument("--part", type=int, default=SPLIT_PART_LINES)
    args = ap.parse_args()
    lift_dir = args.dir
    if lift_dir is None:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from build_boot import default_lift_dir  # noqa: E402
        lift_dir = default_lift_dir()
    mod = apply_split_giants(lift_dir, args.min, args.part, args.check)
    print("split : %d file(s) %s" % (len(mod), "would change" if args.check else "changed"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
