#!/usr/bin/env python3
"""audit_shims.py -- which imports does the shim table PROMISE (PROVIDED /
REAL) that the host objects do not actually define?

The generated shim_weak.c gives every import a weak trap body, so a promised
import with no strong imp_* definition compiles, links and then traps the
first time the game reaches it (round 14e: _CIfmod, at the first entity
spawn). The link is the truth: llvm-nm over the host objects lists the
strong `T imp_*` symbols; every PROVIDED/REAL table row must be among them.

    python scripts/recomp/host/audit_shims.py            # prints the gaps, exit 1 if any
    python scripts/recomp/host/audit_shims.py --json     # machine-readable

Needs the built host objects (output/recomp/lift/boot/obj/*.o) and the emsdk
llvm-nm; without them it reports "not built" and exits 0 so the test suite
stays green on a clean checkout. Imports listed in KNOWN_WEAK are accepted
gaps: the C++ exception machinery and the codecvt facets, which this runtime
cannot honour and which are documented as loud traps.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TABLE = os.path.join(ROOT, "scripts", "recomp", "host", "generated", "shim_table.c")
OBJ_DIR = os.path.join(ROOT, "output", "recomp", "lift", "boot", "obj")

# Documented, deliberate: nothing here can unwind a guest throw or run a
# real codecvt facet; the weak trap names them loudly if ever reached.
KNOWN_WEAK = {
    "__current_exception", "__current_exception_context", "_except_handler4_common",
    "_seh_filter_exe", "CreateFileA",
    "?_Getcat@?$codecvt@DDU_Mbstatet@@@std@@SAIPAPBVfacet@locale@2@PBV42@@Z",
    "?in@?$codecvt@DDU_Mbstatet@@@std@@QBEHAAU_Mbstatet@@PBD1AAPBDPAD3AAPAD@Z",
    "?out@?$codecvt@DDU_Mbstatet@@@std@@QBEHAAU_Mbstatet@@PBD1AAPBDPAD3AAPAD@Z",
    "?unshift@?$codecvt@DDU_Mbstatet@@@std@@QBEHAAU_Mbstatet@@PAD1AAPAD@Z",
    "?id@?$codecvt@DDU_Mbstatet@@@std@@2V0locale@2@A",
}


def find_nm() -> str | None:
    cands = [os.path.expanduser("~/emsdk/upstream/bin/llvm-nm.exe"),
             os.path.expanduser("~/emsdk/upstream/bin/llvm-nm"),
             os.path.join(os.environ.get("EMSDK", ""), "upstream", "bin", "llvm-nm.exe")]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


def strong_symbols(nm: str) -> set[str]:
    objs = [o for o in glob.glob(os.path.join(OBJ_DIR, "*.o"))
            if not o.endswith("shim_weak.o") and ".web." not in os.path.basename(o)]
    out: set[str] = set()
    for o in objs:
        text = subprocess.run([nm, o], capture_output=True, text=True).stdout
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[-2] == "T" and parts[-1].startswith("imp_"):
                out.add(parts[-1])
    return out


def table_rows():
    text = open(TABLE, encoding="utf-8").read()
    return re.findall(r'\{\s*"([^"]+)",\s*"([^"]+)",[^}]*?(ISAAC_V_[A-Z_]+),\s*\d+,\s*(imp_\w+)\s*\}', text)


def main() -> int:
    as_json = "--json" in sys.argv
    nm = find_nm()
    if not nm or not glob.glob(os.path.join(OBJ_DIR, "*.o")):
        print(json.dumps({"status": "not built"}) if as_json else "audit_shims: host objects or llvm-nm not present; nothing audited")
        return 0
    strong = strong_symbols(nm)
    rows = table_rows()
    gaps = [(dll, sym, verdict) for dll, sym, verdict, fn in rows
            if verdict in ("ISAAC_V_PROVIDED", "ISAAC_V_REAL") and fn not in strong and sym not in KNOWN_WEAK]
    accepted = [(dll, sym, verdict) for dll, sym, verdict, fn in rows
                if verdict in ("ISAAC_V_PROVIDED", "ISAAC_V_REAL") and fn not in strong and sym in KNOWN_WEAK]
    if as_json:
        print(json.dumps({"status": "ok", "rows": len(rows), "strong": len(strong),
                          "gaps": gaps, "acceptedWeak": accepted}, indent=1))
    else:
        print("audit_shims: %d table rows, %d strong imp_ bodies, %d promised-but-weak (%d accepted)"
              % (len(rows), len(strong), len(gaps) + len(accepted), len(accepted)))
        for dll, sym, verdict in gaps:
            print("  GAP  %-38s %-40s %s" % (dll, sym, verdict))
    return 1 if gaps else 0


if __name__ == "__main__":
    sys.exit(main())
