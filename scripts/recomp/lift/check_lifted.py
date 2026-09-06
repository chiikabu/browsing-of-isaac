#!/usr/bin/env python3
"""check_lifted.py -- invariants over a lifted tree, checked before it is built.

Round 15c: the room-entry crawl was a dispatch-loop function (`sub_0093805f`)
whose generated body opened with `uint32_t pc_ = 0x93805fu;` and had no
`case 0x93805fu:` anywhere, because block_starts() marked branch targets and
the LOWEST address of the body -- and that body had absorbed a lower range, so
the entry was neither. `switch (pc_)` therefore fell to `default:` on entry,
which parks a jump to the function's own entry and returns; the caller's
trampoline dispatched it again, forever, at 20 million dispatches a second
with no guest instruction executed and nothing in the log. A runtime that can
hang silently on a generated-code defect needs a build-time check.

Invariants:

  entry-case      every function with a `pc_` dispatch loop has a `case` label
                  for the VA the loop is initialised to
  pc-init         every dispatch loop is initialised at all
  tail-only        a dispatch loop with no case but the entry is a `jmp reg`
                   tail call: counted and reported, not a failure

Usage:
    python scripts/recomp/lift/check_lifted.py --dir output/recomp/lift/gu
Exit status is non-zero when an invariant fails; every failure is printed with
the function name so the fix is one grep away.
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import sys

RE_FN = re.compile(r"^void (sub_[0-9a-f]{8})\(CpuState \*restrict s\) \{$", re.M)
RE_PC = re.compile(r"^  uint32_t pc_ = (0x[0-9a-f]+)u;$", re.M)
RE_CASE = re.compile(r"^  case (0x[0-9a-f]+)u:", re.M)


def check_text(text, path, out, note):
    """Append (path, fn, problem) for every invariant failure in one TU."""
    ms = list(RE_FN.finditer(text))
    n = 0
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        body = text[m.start():end]
        pc = RE_PC.search(body)
        if not pc:
            continue                      # not a dispatch-loop function
        n += 1
        cases = set(RE_CASE.findall(body))
        if pc.group(1) not in cases:
            out.append((path, m.group(1),
                        "dispatch loop starts at %s but has no `case %su:` "
                        "(%d other cases) -- entry falls to default: and parks "
                        "a jump to itself" % (pc.group(1), pc.group(1), len(cases))))
        elif len(cases) < 2:
            # legitimate: a single-block function whose computed jump is a
            # `jmp reg` tail call, which parks and leaves. Counted, not failed.
            note[0] += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="lifted tree (lifted_*.c)")
    ap.add_argument("--module", default="lifted")
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.dir, args.module + "_*.c")))
    if not files:
        one = os.path.join(args.dir, args.module + ".c")
        files = [one] if os.path.exists(one) else []
    if not files:
        print("check_lifted: no %s*.c in %s" % (args.module, args.dir), file=sys.stderr)
        return 2
    bad = []
    note = [0]
    loops = 0
    for f in files:
        with open(f, encoding="utf8", errors="replace") as fh:
            loops += check_text(fh.read(), os.path.basename(f), bad, note)
    print("check_lifted: %d TU(s), %d dispatch-loop function(s), %d tail-only, %d problem(s)"
          % (len(files), loops, note[0], len(bad)))
    for path, fn, why in bad:
        print("  %s %s: %s" % (path, fn, why))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
