"""GL entry-point census, disassembly-based (supersedes the byte-scan pass).

A raw 4-byte scan of .text produces false positives that look convincing: the
5-byte encoding `e8 17 c1 00 00` (`call rel32`) contains the byte sequence
`e8 17 c1 00` which equals the dispatch-slot VA 0x00c117e8. That single artefact
invents calls to glGetCombinerInputParameterivNV. Every reference below is
therefore taken from a decoded instruction with a known boundary.

Classification of each reference:
  CALL   `call/jmp dword ptr [slot]`            -- a real GL call
  LOAD   `mov reg, dword ptr [slot]`, `push [slot]`, `a1 slot`
                                                -- address taken, then called
  STORE  `mov dword ptr [slot], reg`            -- libepoxy's resolver writing
                                                   the resolved pointer back
  IMM    slot VA as an immediate operand        -- address taken

A STORE is never the game calling GL. Functions are additionally attributed to
libepoxy via the census component map, so epoxy's own dispatch code is excluded
regardless of instruction form.

Run:  python scripts/recomp/host/gl_census2.py
"""

import bisect
import json
import struct
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, CENSUS_DIR, hexva  # noqa: E402
from gl_census import read_exports  # noqa: E402

import capstone
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_MEM, X86_OP_IMM, X86_REG_INVALID


def main():
    pe = PE()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta, exports = read_exports(pe)

    slots, stub_of, code_exports = {}, {}, {}
    for name, erva in exports.items():
        eva = pe.image_base + erva
        sec = pe.section_for_va(eva)
        if sec is None:
            continue
        if sec.name == ".data":
            slots[name] = eva
            stub_of[name] = pe.u32_at_va(eva)
        else:
            code_exports[name] = eva
    slot_to_name = {v: k for k, v in slots.items()}
    code_to_name = {v: k for k, v in code_exports.items()}
    all_targets = dict(slot_to_name)
    all_targets.update(code_to_name)

    # component map: function VA -> 'glfw' | 'libepoxy' | ...
    comp = json.loads((CENSUS_DIR / "func-components.json").read_text(encoding="utf-8"))
    comp = {int(k, 16): v for k, v in comp.items()}
    fdata = json.loads((CENSUS_DIR / "functions.json").read_text(encoding="utf-8"))
    funcs = [(int(f["va"], 16), int(f["va"], 16) + f["size"]) for f in fdata["functions"]]
    funcs.sort()
    starts = [a for a, _ in funcs]

    # libepoxy's own code = the 3,221 resolver stubs (exact) + anything the
    # census attributed to the libepoxy component.
    stub_set = {v for v in stub_of.values() if v and pe.is_text_va(v)}

    def owner(va):
        i = bisect.bisect_right(starts, va) - 1
        if i < 0:
            return None
        lo, hi = funcs[i]
        return lo if lo <= va < hi else None

    def is_epoxy(fva):
        return fva in stub_set or comp.get(fva) == "libepoxy"

    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True

    text = pe.section(".text")
    base_off = text.raw_offset
    base_va = pe.image_base + text.rva

    refs = defaultdict(lambda: defaultdict(list))   # name -> form -> [ (site, fva) ]
    decoded_fns = 0
    decoded_ins = 0

    for lo, hi in funcs:
        off = base_off + (lo - base_va)
        n = hi - lo
        if off < base_off or off + n > base_off + text.raw_size:
            continue
        decoded_fns += 1
        code = pe.data[off:off + n]
        for ins in md.disasm(code, lo):
            decoded_ins += 1
            hit = None
            form = None
            for op in ins.operands:
                if op.type == X86_OP_MEM:
                    d = op.mem.disp & 0xFFFFFFFF
                    if d in all_targets and op.mem.base == X86_REG_INVALID \
                            and op.mem.index == X86_REG_INVALID:
                        hit = d
                        if ins.mnemonic in ("call", "jmp"):
                            form = "CALL"
                        elif ins.mnemonic == "mov" and ins.operands[0].type == X86_OP_MEM:
                            form = "STORE"
                        else:
                            form = "LOAD"
                        break
                elif op.type == X86_OP_IMM:
                    v = op.imm & 0xFFFFFFFF
                    if v in all_targets:
                        hit = v
                        form = "IMM"
                        break
            if hit is not None:
                refs[all_targets[hit]][form].append((ins.address, lo))

    rows = []
    for name, forms in refs.items():
        rec = {"name": name,
               "slotVa": hexva(slots.get(name)),
               "isCodeExport": name in code_exports,
               "forms": {}, "callerCalls": 0, "callerLoads": 0,
               "epoxyRefs": 0, "stores": 0, "sites": []}
        for form, lst in forms.items():
            game = [(s, f) for s, f in lst if not is_epoxy(f)]
            epx = [(s, f) for s, f in lst if is_epoxy(f)]
            rec["forms"][form] = {"total": len(lst), "caller": len(game),
                                  "epoxy": len(epx)}
            rec["epoxyRefs"] += len(epx)
            if form == "CALL":
                rec["callerCalls"] += len(game)
            elif form == "STORE":
                rec["stores"] += len(game)
            else:
                rec["callerLoads"] += len(game)
            for s, f in game[:8]:
                rec["sites"].append({"form": form, "va": hexva(s),
                                     "inFunc": hexva(f),
                                     "component": comp.get(f, "(game)")})
        rec["callerRefs"] = rec["callerCalls"] + rec["callerLoads"]
        rows.append(rec)

    called = [r for r in rows if r["callerRefs"] > 0]
    called.sort(key=lambda r: -r["callerRefs"])

    census = json.loads((CENSUS_DIR / "exports.json").read_text(encoding="utf-8"))
    census_names = {e["name"] for e in census["calledEpoxy"]}
    mine = {r["name"] for r in called}

    MUST = ["epoxy_glGenBuffers", "epoxy_glBindBuffer", "epoxy_glBufferData",
            "epoxy_glBufferSubData", "epoxy_glDrawArrays", "epoxy_glDrawElements",
            "epoxy_glVertexAttribPointer", "epoxy_glEnableVertexAttribArray",
            "epoxy_glDisableVertexAttribArray",
            "epoxy_glGenVertexArrays", "epoxy_glBindVertexArray",
            "epoxy_glBlendFunc", "epoxy_glBlendFuncSeparate",
            "epoxy_glMapBuffer", "epoxy_glDrawRangeElements",
            "epoxy_glClientActiveTexture", "epoxy_glVertexPointer",
            "epoxy_glTexCoordPointer", "epoxy_glBegin", "epoxy_glEnd"]
    audit = []
    for m in MUST:
        r = next((x for x in rows if x["name"] == m), None)
        audit.append({"name": m, "exported": m in slots or m in code_exports,
                      "callerCalls": r["callerCalls"] if r else 0,
                      "callerLoads": r["callerLoads"] if r else 0,
                      "epoxyRefs": r["epoxyRefs"] if r else 0,
                      "inCensus70": m in census_names})

    out = {
        "method": "capstone per-function disassembly; reference forms classified",
        "functionsDecoded": decoded_fns,
        "instructionsDecoded": decoded_ins,
        "dispatchSlots": len(slots), "codeExports": len(code_exports),
        "entryPointsWithAnyReference": len(rows),
        "entryPointsCalledByCallerCode": len(called),
        "callerCallSites": sum(r["callerCalls"] for r in called),
        "callerLoadSites": sum(r["callerLoads"] for r in called),
        "censusListCount": len(census_names),
        "inMineNotCensus": sorted(mine - census_names),
        "inCensusNotMine": sorted(census_names - mine),
        "vertexPathAudit": audit,
        "entryPoints": called,
    }
    (OUT_DIR / "gl-census2.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    print("decoded %s functions / %s instructions" % (
        "{:,}".format(decoded_fns), "{:,}".format(decoded_ins)))
    print("dispatch slots %d, code exports %d" % (len(slots), len(code_exports)))
    print("entry points with any reference     : %d" % len(rows))
    print("entry points called by caller code  : %d" % len(called))
    print("  caller CALL sites %d, caller LOAD sites %d" % (
        out["callerCallSites"], out["callerLoadSites"]))
    print()
    print("vs census's 70:")
    print("  extra in mine (%d): %s" % (len(out["inMineNotCensus"]), out["inMineNotCensus"]))
    print("  missing vs census (%d): %s" % (len(out["inCensusNotMine"]), out["inCensusNotMine"]))
    print()
    print("VERTEX SUBMISSION PATH AUDIT")
    print("  %-36s %-8s %-6s %-6s %-6s %s" % (
        "name", "exported", "calls", "loads", "epoxy", "inCensus70"))
    for a in audit:
        print("  %-36s %-8s %-6d %-6d %-6d %s" % (
            a["name"], a["exported"], a["callerCalls"], a["callerLoads"],
            a["epoxyRefs"], a["inCensus70"]))
    print()
    print("all entry points called by caller code:")
    for r in called:
        forms = " ".join("%s:%d/%d" % (k, v["caller"], v["total"])
                         for k, v in sorted(r["forms"].items()))
        print("  %-42s calls=%-4d loads=%-4d  [%s]" % (
            r["name"], r["callerCalls"], r["callerLoads"], forms))
    print()
    print("wrote %s" % (OUT_DIR / "gl-census2.json"))


if __name__ == "__main__":
    main()
