"""Re-derive which GL entry points the GAME actually calls.

Why this exists: the host-boundary census reports 70 called entry points, but
that list contains no glGenBuffers, glBufferData, glVertexAttribPointer,
glDrawArrays, glCreateShader, glGetUniformLocation or glBlendFunc -- all of
which are mandatory to draw a single textured triangle. A renderer that never
creates a buffer is not a renderer, so the list is re-measured here from
scratch.

Method:
  1. Walk the export directory. libepoxy exports each GL entry point as a
     FUNCTION POINTER VARIABLE living in .data; the export RVA is the SLOT, and
     the dword stored there on disk is the RESOLVER STUB in .text. Both are
     recorded; the census's epoxy-stubs.json holds only the stub side, which is
     the wrong side to scan for.
  2. Scan every 4-byte-aligned and unaligned position in .text for an immediate
     equal to a slot VA. A call through libepoxy is
     `call dword ptr [epoxy_glFoo]` = FF 15 <slot VA>.
  3. Attribute each reference to its containing function, then classify the
     function as libepoxy's own dispatch code or as caller code. References made
     BY libepoxy's own stubs are not the game calling GL.

Run:  python scripts/recomp/host/gl_census.py
"""

import bisect
import json
import re
import struct
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, CENSUS_DIR, hexva  # noqa: E402


def read_exports(pe):
    rva, size = pe.dirs["EXPORT"]
    if not rva:
        return {}, {}
    o = pe.rva_to_off(rva)
    (_flags, _ts, _mj, _mn, name_rva, ordinal_base, n_funcs, n_names,
     func_rva, name_ptr_rva, ord_rva) = struct.unpack_from("<IIHHIIIIIII", pe.data, o)
    dll = pe.cstr_at_rva(name_rva)
    fo = pe.rva_to_off(func_rva)
    no = pe.rva_to_off(name_ptr_rva)
    oo = pe.rva_to_off(ord_rva)
    by_name = {}
    for i in range(n_names):
        nrva = struct.unpack_from("<I", pe.data, no + i * 4)[0]
        idx = struct.unpack_from("<H", pe.data, oo + i * 2)[0]
        erva = struct.unpack_from("<I", pe.data, fo + idx * 4)[0]
        by_name[pe.cstr_at_rva(nrva)] = erva
    return {"dll": dll, "ordinalBase": ordinal_base,
            "functionCount": n_funcs, "nameCount": n_names}, by_name


def load_functions(pe):
    """Function starts + sizes from the census index (read-only input)."""
    d = json.loads((CENSUS_DIR / "functions.json").read_text(encoding="utf-8"))
    fns = []
    for f in d["functions"]:
        va = int(f["va"], 16)
        fns.append((va, va + f["size"]))
    fns.sort()
    starts = [a for a, _ in fns]
    return fns, starts


def main():
    pe = PE()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta, exports = read_exports(pe)

    data_sec = pe.section(".data")
    text_sec = pe.section(".text")
    d_lo = pe.image_base + data_sec.rva
    d_hi = d_lo + data_sec.virtual_span

    # --- 1. slot VA (in .data) and initial stub VA (in .text) per export ---
    slots = {}          # name -> slot VA
    stub_of = {}        # name -> initial value (resolver stub VA)
    code_exports = {}   # name -> VA, for the handful that are real code
    for name, erva in exports.items():
        eva = pe.image_base + erva
        sec = pe.section_for_va(eva)
        if sec is None:
            continue
        if sec.name == ".data":
            slots[name] = eva
            v = pe.u32_at_va(eva)
            stub_of[name] = v
        else:
            code_exports[name] = eva

    slot_to_name = {v: k for k, v in slots.items()}
    stub_vas = {v for v in stub_of.values() if v and pe.is_text_va(v)}

    # --- 2. scan .text for 4-byte immediates equal to a slot VA -------------
    t_off = text_sec.raw_offset
    t_len = text_sec.raw_size
    blob = pe.data[t_off:t_off + t_len]
    t_va = pe.image_base + text_sec.rva

    refs = defaultdict(list)     # name -> [site VA]
    codeexp_refs = defaultdict(list)
    targets = set(slot_to_name)
    code_targets = {v: k for k, v in code_exports.items()}
    all_targets = targets | set(code_targets)
    # Cheap pre-filter: every slot VA has the same top byte range (0x00c0/0x00c3),
    # so match on the high 2 bytes first, then confirm.
    hi_bytes = {(v >> 16) & 0xFFFF for v in all_targets}
    for i in range(t_len - 3):
        if ((blob[i + 2] | (blob[i + 3] << 8)) not in hi_bytes):
            continue
        v = blob[i] | (blob[i + 1] << 8) | (blob[i + 2] << 16) | (blob[i + 3] << 24)
        if v in targets:
            refs[slot_to_name[v]].append(t_va + i)
        elif v in code_targets:
            codeexp_refs[code_targets[v]].append(t_va + i)

    # --- 3. attribute each reference site to a function ---------------------
    fns, starts = load_functions(pe)

    def owner(va):
        i = bisect.bisect_right(starts, va) - 1
        if i < 0:
            return None
        lo, hi = fns[i]
        return lo if lo <= va < hi else None

    # A function is libepoxy's own dispatch code if it IS one of the resolver
    # stubs (the exact stub-address set recovered above).
    def is_epoxy_internal(fva):
        return fva in stub_vas

    result_rows = []
    for name, sites in list(refs.items()) + list(codeexp_refs.items()):
        game_sites, epoxy_sites, orphan = [], [], []
        for s in sites:
            # The immediate starts 2 bytes into `FF 15`/`FF 35`, 1 byte into
            # `68`/`A1`/`B8+r`; back off to find the owning function.
            f = owner(s)
            if f is None:
                orphan.append(s)
            elif is_epoxy_internal(f):
                epoxy_sites.append(s)
            else:
                game_sites.append(s)
        result_rows.append({
            "name": name,
            "kind": "slot" if name in slots else "code-export",
            "slotVa": hexva(slots.get(name)) if name in slots else None,
            "stubVa": hexva(stub_of.get(name)) if name in slots else hexva(code_exports.get(name)),
            "totalRefs": len(sites),
            "callerSites": len(game_sites),
            "epoxyInternalSites": len(epoxy_sites),
            "unattributedSites": len(orphan),
            "sampleCallerSites": [hexva(x) for x in game_sites[:6]],
        })

    called = [r for r in result_rows if r["callerSites"] > 0]
    called.sort(key=lambda r: -r["callerSites"])

    # --- cross-check against the census's own list --------------------------
    census = json.loads((CENSUS_DIR / "exports.json").read_text(encoding="utf-8"))
    census_names = {e["name"] for e in census["calledEpoxy"]}
    mine = {r["name"] for r in called}

    # The GL functions that must exist for ANY textured-quad renderer.
    MUST_EXIST = [
        "epoxy_glGenBuffers", "epoxy_glBindBuffer", "epoxy_glBufferData",
        "epoxy_glBufferSubData", "epoxy_glDrawArrays", "epoxy_glDrawElements",
        "epoxy_glVertexAttribPointer", "epoxy_glEnableVertexAttribArray",
        "epoxy_glCreateShader", "epoxy_glShaderSource", "epoxy_glCompileShader",
        "epoxy_glCreateProgram", "epoxy_glAttachShader", "epoxy_glLinkProgram",
        "epoxy_glUseProgram", "epoxy_glGetUniformLocation",
        "epoxy_glGetAttribLocation", "epoxy_glBindAttribLocation",
        "epoxy_glBlendFunc", "epoxy_glGenFramebuffers", "epoxy_glGenTextures",
        "epoxy_glTexImage2D", "epoxy_glActiveTexture", "epoxy_glGenVertexArrays",
        "epoxy_glBindVertexArray",
    ]
    audit = []
    for m in MUST_EXIST:
        r = next((x for x in result_rows if x["name"] == m), None)
        audit.append({
            "name": m,
            "exported": m in slots or m in code_exports,
            "callerSites": r["callerSites"] if r else 0,
            "epoxyInternalSites": r["epoxyInternalSites"] if r else 0,
            "inCensusList": m in census_names,
        })

    out = {
        "exportDirectory": meta,
        "exportsTotal": len(exports),
        "exportsInData(slots)": len(slots),
        "exportsInText(code)": len(code_exports),
        "distinctResolverStubs": len(stub_vas),
        "entryPointsWithAnyReference": len(result_rows),
        "entryPointsCalledByCallerCode": len(called),
        "callerCallSites": sum(r["callerSites"] for r in called),
        "epoxyInternalSites": sum(r["epoxyInternalSites"] for r in result_rows),
        "censusListCount": len(census_names),
        "inMineNotCensus": sorted(mine - census_names),
        "inCensusNotMine": sorted(census_names - mine),
        "sanityAudit": audit,
        "entryPoints": called,
    }
    (OUT_DIR / "gl-census.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    print("export dir      : %s, %d names, %d functions" % (
        meta["dll"], meta["nameCount"], meta["functionCount"]))
    print("exports in .data (dispatch slots): %d" % len(slots))
    print("exports in .text (real code)     : %d  %s" % (
        len(code_exports), sorted(code_exports)))
    print("distinct resolver stubs          : %d" % len(stub_vas))
    print()
    print("entry points referenced anywhere in .text : %d" % len(result_rows))
    print("entry points called by NON-epoxy code     : %d  (%d call sites)" % (
        len(called), sum(r["callerSites"] for r in called)))
    print("references made BY epoxy's own stubs      : %d" % out["epoxyInternalSites"])
    print()
    print("census said 70; this pass says %d" % len(called))
    print("  in mine but not census (%d): %s" % (
        len(out["inMineNotCensus"]), out["inMineNotCensus"][:20]))
    print("  in census but not mine (%d): %s" % (
        len(out["inCensusNotMine"]), out["inCensusNotMine"][:20]))
    print()
    print("sanity audit -- entry points a textured-quad renderer cannot omit:")
    print("  %-34s %-9s %-7s %-7s %s" % ("name", "exported", "caller", "epoxy", "inCensus"))
    for a in audit:
        flag = "" if a["callerSites"] else "   <-- NOT CALLED"
        print("  %-34s %-9s %-7d %-7d %-8s%s" % (
            a["name"], a["exported"], a["callerSites"],
            a["epoxyInternalSites"], a["inCensusList"], flag))
    print()
    print("top 40 by caller call sites:")
    for r in called[:40]:
        print("  %5d  %-40s slot %s" % (r["callerSites"], r["name"], r["slotVa"]))
    print()
    print("wrote %s" % (OUT_DIR / "gl-census.json"))


if __name__ == "__main__":
    main()
