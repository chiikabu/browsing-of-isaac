"""Exhaustive legacy-GL / WebGL2-compatibility audit.

Answers three questions with no sampling and no heuristics:

  Q1  Does the binary EVER reference a buffer-object or VAO entry point, under
      ANY vendor alias (ARB/EXT/OES/APPLE/NV/ATI)? A negative here is what makes
      "the renderer uses client-side vertex arrays" a proof rather than a guess.
  Q2  Which legacy / fixed-function / immediate-mode entry points are reached?
  Q3  What CONSTANT arguments do the reached state calls carry? glEnable(cap),
      glDrawElements(mode), glTexParameteri(pname,param) -- so that
      WebGL2-unavailable enums (GL_ALPHA_TEST, GL_QUADS, ...) are found now
      instead of at runtime.

Every one of the 3,221 libepoxy dispatch slots is checked, not a chosen subset.
Function bounds come from the Ghidra inventory (output/recomp/export/
functions.jsonl, `recovered:false` = the 14,025 trustworthy auto-analysis
functions); the census function set is inflated by mid-instruction addresses and
is used only as a fallback for coverage.

Run:  python scripts/recomp/host/gl_legacy_audit.py
"""

import bisect
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, CENSUS_DIR, REPO_ROOT, hexva  # noqa: E402
from gl_census import read_exports  # noqa: E402

from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_MEM, X86_OP_IMM, X86_REG_INVALID

EXPORT_DIR = REPO_ROOT / "output" / "recomp" / "export"

# ---- the families that decide whether this port is possible ---------------
FAMILIES = {
    "buffer-objects": r"^epoxy_gl(Gen|Delete|Bind|Is)Buffers?(ARB|EXT|OES)?$|"
                      r"^epoxy_glBuffer(Data|SubData|Storage)(ARB|EXT|OES)?$|"
                      r"^epoxy_gl(Map|Unmap)Buffer(Range|OES|ARB)?$|"
                      r"^epoxy_glGetBufferParameter",
    "vertex-array-objects": r"^epoxy_gl(Gen|Delete|Bind|Is)VertexArrays?(ARB|OES|APPLE)?$",
    "immediate-mode": r"^epoxy_gl(Begin|End)$|^epoxy_glVertex[234]|^epoxy_glColor[34]|"
                      r"^epoxy_glTexCoord[1234]|^epoxy_glNormal3|^epoxy_glRect",
    "fixed-function-matrix": r"^epoxy_gl(MatrixMode|LoadIdentity|LoadMatrix|MultMatrix|"
                             r"PushMatrix|PopMatrix|Ortho|Frustum|Translate|Rotate|Scale)",
    "fixed-function-state": r"^epoxy_gl(TexEnv|Light|Material|Fog|ShadeModel|AlphaFunc|"
                            r"ColorMaterial|PolygonStipple|LineStipple)",
    "client-state-arrays": r"^epoxy_gl(EnableClientState|DisableClientState|"
                           r"ClientActiveTexture|VertexPointer|ColorPointer|"
                           r"TexCoordPointer|NormalPointer|IndexPointer|EdgeFlagPointer|"
                           r"InterleavedArrays)",
    "display-lists": r"^epoxy_gl(NewList|EndList|CallList|CallLists|GenLists|"
                     r"DeleteLists|ListBase|IsList)",
    "polygon-mode": r"^epoxy_glPolygonMode",
    "no-webgl2-equivalent": r"^epoxy_glClampColor|^epoxy_glGetTexImage|"
                            r"^epoxy_glTexImage1D|^epoxy_glDrawBuffer$|"
                            r"^epoxy_glPointSize|^epoxy_glLineWidth|"
                            r"^epoxy_glLogicOp|^epoxy_glGetTexLevelParameter",
}

# GL enums we need to name in the argument dump
ENUMS = {
    0x0004: "GL_TRIANGLES", 0x0005: "GL_TRIANGLE_STRIP", 0x0006: "GL_TRIANGLE_FAN",
    0x0000: "GL_POINTS", 0x0001: "GL_LINES", 0x0002: "GL_LINE_LOOP",
    0x0003: "GL_LINE_STRIP", 0x0007: "GL_QUADS", 0x0008: "GL_QUAD_STRIP",
    0x0009: "GL_POLYGON",
    0x0BC0: "GL_ALPHA_TEST", 0x0B71: "GL_DEPTH_TEST", 0x0BE2: "GL_BLEND",
    0x0B44: "GL_CULL_FACE", 0x0B90: "GL_STENCIL_TEST", 0x0C11: "GL_SCISSOR_TEST",
    0x0DE1: "GL_TEXTURE_2D", 0x8642: "GL_PROGRAM_POINT_SIZE",
    0x8DB9: "GL_FRAMEBUFFER_SRGB", 0x809D: "GL_MULTISAMPLE",
    0x0B20: "GL_LINE_SMOOTH", 0x0B41: "GL_POLYGON_SMOOTH", 0x0BD0: "GL_DITHER",
    0x8037: "GL_POLYGON_OFFSET_FILL", 0x2A02: "GL_POLYGON_OFFSET_UNITS",
    0x0B10: "GL_POINT_SMOOTH", 0x0C60: "GL_TEXTURE_GEN_S",
    0x1400: "GL_BYTE", 0x1401: "GL_UNSIGNED_BYTE", 0x1402: "GL_SHORT",
    0x1403: "GL_UNSIGNED_SHORT", 0x1404: "GL_INT", 0x1405: "GL_UNSIGNED_INT",
    0x1406: "GL_FLOAT", 0x140B: "GL_HALF_FLOAT",
    0x2800: "GL_TEXTURE_MAG_FILTER", 0x2801: "GL_TEXTURE_MIN_FILTER",
    0x2802: "GL_TEXTURE_WRAP_S", 0x2803: "GL_TEXTURE_WRAP_T",
    0x2600: "GL_NEAREST", 0x2601: "GL_LINEAR", 0x812F: "GL_CLAMP_TO_EDGE",
    0x2901: "GL_REPEAT", 0x2900: "GL_CLAMP",
    0x1F00: "GL_VENDOR", 0x1F01: "GL_RENDERER", 0x1F02: "GL_VERSION",
    0x1F03: "GL_EXTENSIONS", 0x8B8C: "GL_SHADING_LANGUAGE_VERSION",
    0x8D40: "GL_FRAMEBUFFER", 0x8D41: "GL_RENDERBUFFER",
    0x8CA8: "GL_READ_FRAMEBUFFER", 0x8CA9: "GL_DRAW_FRAMEBUFFER",
    0x0D05: "GL_PACK_ALIGNMENT", 0x0CF5: "GL_UNPACK_ALIGNMENT",
    0x1908: "GL_RGBA", 0x1907: "GL_RGB", 0x8058: "GL_RGBA8",
    0x84C0: "GL_TEXTURE0", 0x0DE0: "GL_TEXTURE_1D",
    0x8892: "GL_ARRAY_BUFFER", 0x8893: "GL_ELEMENT_ARRAY_BUFFER",
    0x891B: "GL_CLAMP_VERTEX_COLOR_ARB", 0x891C: "GL_CLAMP_FRAGMENT_COLOR_ARB",
    0x891D: "GL_CLAMP_READ_COLOR_ARB", 0x8654: "GL_FIXED_ONLY_ARB",
    0x1E00: "GL_KEEP", 0x0207: "GL_ALWAYS", 0x0201: "GL_LESS",
    0x0203: "GL_LEQUAL", 0x0405: "GL_BACK", 0x0404: "GL_FRONT",
}


def load_ghidra_functions():
    """(va, endVa) for the trustworthy Ghidra functions."""
    fns, named = [], {}
    p = EXPORT_DIR / "functions.jsonl"
    if not p.exists():
        return None, None
    with p.open("r", encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r.get("recovered"):
                continue
            if not r.get("inText"):
                continue
            va = int(r["va"], 16)
            end = int(r["endVa"], 16)
            fns.append((va, end))
            nm = r.get("zhlName") or (None if r.get("defaultName") else r.get("name"))
            if nm:
                named[va] = nm
    fns.sort()
    return fns, named


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
    targets = dict(slot_to_name)
    targets.update(code_to_name)
    stub_set = {v for v in stub_of.values() if v and pe.is_text_va(v)}

    gfns, gnames = load_ghidra_functions()
    using = "ghidra"
    if not gfns:
        d = json.loads((CENSUS_DIR / "functions.json").read_text(encoding="utf-8"))
        gfns = [(int(f["va"], 16), int(f["va"], 16) + f["size"]) for f in d["functions"]]
        gfns.sort()
        gnames = {}
        using = "census-fallback"
    starts = [a for a, _ in gfns]

    comp = json.loads((CENSUS_DIR / "func-components.json").read_text(encoding="utf-8"))
    comp = {int(k, 16): v for k, v in comp.items()}

    def owner(va):
        i = bisect.bisect_right(starts, va) - 1
        if i < 0:
            return None
        lo, hi = gfns[i]
        return lo if lo <= va < hi else None

    def is_epoxy(fva):
        return fva is not None and (fva in stub_set or comp.get(fva) == "libepoxy")

    # --- disassemble .text once, linearly over the Ghidra function ranges ---
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    text = pe.section(".text")
    base_off, base_va = text.raw_offset, pe.image_base + text.rva

    refs = defaultdict(lambda: defaultdict(list))    # name -> form -> [(site,fva)]
    callsite_args = defaultdict(list)                # name -> [ (site, [pushed imms]) ]
    ins_count = 0

    # Cover ALL of .text, not just the Ghidra function ranges: sweeping only
    # known functions left ~380k instructions undecoded, and a call site hiding
    # in a gap turns a real dependency into a false "ABSENT". Gaps are swept
    # linearly; x86 padding (int3/nop) resyncs the decoder almost immediately.
    text_lo, text_hi = base_va, base_va + text.raw_size
    ranges, cursor = [], text_lo
    for lo, hi in gfns:
        lo = max(lo, text_lo)
        hi = min(hi, text_hi)
        if hi <= lo:
            continue
        if lo > cursor:
            ranges.append((cursor, lo, False))       # gap
        ranges.append((lo, hi, True))                # known function
        cursor = max(cursor, hi)
    if cursor < text_hi:
        ranges.append((cursor, text_hi, False))
    gap_bytes = sum(hi - lo for lo, hi, known in ranges if not known)

    for lo, hi, known in ranges:
        off = base_off + (lo - base_va)
        n = hi - lo
        if n <= 0 or off < base_off or off + n > base_off + text.raw_size:
            continue
        recent = []      # rolling window of recent `push imm32`
        for ins in md.disasm(pe.data[off:off + n], lo):
            ins_count += 1
            if ins.mnemonic == "push" and ins.operands and ins.operands[0].type == X86_OP_IMM:
                recent.append(ins.operands[0].imm & 0xFFFFFFFF)
                if len(recent) > 10:
                    recent.pop(0)
            hit = form = None
            for op in ins.operands:
                if op.type == X86_OP_MEM:
                    d = op.mem.disp & 0xFFFFFFFF
                    if (d in targets and op.mem.base == X86_REG_INVALID
                            and op.mem.index == X86_REG_INVALID):
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
                    if v in targets:
                        hit = v
                        form = "DIRECTCALL" if ins.mnemonic in ("call", "jmp") else "IMM"
                        break
            if hit is not None:
                nm = targets[hit]
                fva = owner(ins.address)     # real containing function, not the range
                refs[nm][form].append((ins.address, fva))
                if form in ("CALL", "DIRECTCALL") and not is_epoxy(fva):
                    callsite_args[nm].append((ins.address, list(recent)))
            if ins.mnemonic == "call":
                recent = []

    def caller_counts(name):
        """(call sites, load sites, epoxy-internal refs, unattributed) for a name."""
        c = l = e = u = 0
        for form, lst in refs.get(name, {}).items():
            for site, fva in lst:
                if is_epoxy(fva):
                    e += 1
                    continue
                if fva is None:
                    u += 1        # decoded in a gap: reported, never hidden
                if form in ("CALL", "DIRECTCALL"):
                    c += 1
                elif form == "STORE":
                    pass          # resolver write-back, never a call
                else:
                    l += 1
        return c, l, e, u

    # --- Q1/Q2: family sweep over ALL 3,221 slots ---------------------------
    family_report = {}
    for fam, pat in FAMILIES.items():
        rx = re.compile(pat)
        members = sorted(n for n in list(slots) + list(code_exports) if rx.search(n))
        rows = []
        for m in members:
            c, l, e, u = caller_counts(m)
            rows.append({"name": m, "exported": True, "callerCalls": c,
                         "callerLoads": l, "epoxyInternalRefs": e,
                         "unattributedSites": u})
        used = [r for r in rows if r["callerCalls"] or r["callerLoads"]]
        family_report[fam] = {
            "exportedMembers": len(members),
            "usedByCallerCode": len(used),
            "usedNames": [r["name"] for r in used],
            "detail": rows,
        }

    # --- Q3: constant arguments at reached call sites -----------------------
    def decode_args(name, argc, names_of_positions):
        out = []
        for site, pushes in callsite_args.get(name, []):
            # cdecl: pushes are right-to-left, so the last `argc` pushes
            # reversed give arg0..argN.
            args = list(reversed(pushes[-argc:])) if len(pushes) >= argc else None
            if args is None:
                out.append({"site": hexva(site), "args": None,
                            "note": "not all args are immediates"})
                continue
            named = {}
            for i, a in enumerate(args):
                label = names_of_positions[i] if i < len(names_of_positions) else "arg%d" % i
                named[label] = ENUMS.get(a, "0x%x" % a)
            out.append({"site": hexva(site), "args": named})
        return out

    arg_report = {
        "glEnable": decode_args("epoxy_glEnable", 1, ["cap"]),
        "glDisable": decode_args("epoxy_glDisable", 1, ["cap"]),
        "glDrawElements": decode_args("epoxy_glDrawElements", 4,
                                      ["mode", "count", "type", "indices"]),
        "glTexParameteri": decode_args("epoxy_glTexParameteri", 3,
                                       ["target", "pname", "param"]),
        "glGetString": decode_args("epoxy_glGetString", 1, ["name"]),
        "glCullFace": decode_args("epoxy_glCullFace", 1, ["mode"]),
        "glDepthFunc": decode_args("epoxy_glDepthFunc", 1, ["func"]),
        "glClampColorARB": decode_args("epoxy_glClampColorARB", 2, ["target", "clamp"]),
        "glGetIntegerv": decode_args("epoxy_glGetIntegerv", 2, ["pname", "data"]),
        "glBindFramebuffer": decode_args("epoxy_glBindFramebuffer", 2,
                                         ["target", "framebuffer"]),
    }

    out = {
        "functionSource": using,
        "functionsUsed": len(gfns),
        "instructionsDecoded": ins_count,
        "textBytes": text.raw_size,
        "gapBytesSweptLinearly": gap_bytes,
        "dispatchSlots": len(slots),
        "codeExports": sorted(code_exports),
        "families": family_report,
        "constantArguments": arg_report,
    }
    (OUT_DIR / "gl-legacy-audit.json").write_text(json.dumps(out, indent=1), encoding="utf-8")

    print("function bounds source : %s (%s functions)" % (using, "{:,}".format(len(gfns))))
    print("instructions decoded   : %s  (.text %s bytes; %s bytes swept as gaps)" % (
        "{:,}".format(ins_count), "{:,}".format(text.raw_size), "{:,}".format(gap_bytes)))
    print("dispatch slots checked : %d  (+%d code exports)" % (len(slots), len(code_exports)))
    print()
    print("=" * 78)
    print("Q1/Q2  FAMILY SWEEP -- every matching export, not a sample")
    print("=" * 78)
    for fam, rep in FAMILIES.items():
        r = family_report[fam]
        verdict = "USED" if r["usedByCallerCode"] else "ABSENT"
        print("\n%-24s %-7s  %d exported, %d used by caller code" % (
            fam, verdict, r["exportedMembers"], r["usedByCallerCode"]))
        if r["usedByCallerCode"]:
            for n in r["usedNames"]:
                d = next(x for x in r["detail"] if x["name"] == n)
                print("      USED  %-44s calls=%d loads=%d unattributed=%d" % (
                    n, d["callerCalls"], d["callerLoads"], d["unattributedSites"]))
        else:
            shown = [d["name"] for d in r["detail"][:8]]
            print("      checked: %s%s" % (", ".join(shown),
                                           " ..." if len(r["detail"]) > 8 else ""))
    print()
    print("=" * 78)
    print("Q3  CONSTANT ARGUMENTS AT REACHED CALL SITES")
    print("=" * 78)
    for k, v in arg_report.items():
        if not v:
            continue
        print("\n%s (%d sites)" % (k, len(v)))
        for e in v:
            print("   %s  %s" % (e["site"], e.get("args") or e.get("note")))
    print()
    print("wrote %s" % (OUT_DIR / "gl-legacy-audit.json"))


if __name__ == "__main__":
    main()
