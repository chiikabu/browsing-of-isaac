"""Driver: lift a set of functions from the PE and write compilable C."""

import argparse
import bisect
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pypcode                                        # noqa: E402
from pe import PE32                                   # noqa: E402
from lift import (RegMap, Decoder, LiftError, FuncEmitter, UTYPE,   # noqa: E402
                  discover_body, LANG)
from jumptables import JumpTables                       # noqa: E402
import scan                                            # noqa: E402


def load_fragments(path):
    """Mid-function fragments from Ghidra's gap-recovery pass.

    Ghidra's recovery split single functions into pieces; only rows with a
    real prologue are genuine entry points.  The rest must not be used as
    function boundaries -- every branch into them would turn into a tail
    call and one function would silently become many.
    """
    frags = set()
    with io.open(path, encoding="utf8") as fh:
        head = fh.readline().rstrip("\n").split("\t")
        i_va = head.index("va")
        i_pro = head.index("looksLikePrologue")
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) <= i_pro:
                continue
            if f[i_pro].strip().lower() != "true":
                frags.add(int(f[i_va], 16))
    return frags


def load_imports(path, shim_table=None):
    """Read the host-boundary census -> {iat_va: (shim_c_name, arg_bytes, shim_token)}.

    arg_bytes is the stdcall purge (0 for cdecl: the caller cleans). The
    shim-table sidecar written by gen_shims.py also carries the shim token,
    which an UNKNOWN-PURGE import needs so the lifted code can route the call
    through isaac_indirect_call, the one place that knows how to report it.
    """
    d = json.load(open(path, encoding="utf8"))
    out = {}
    if shim_table and os.path.exists(shim_table):
        st = json.load(open(shim_table, encoding="utf8"))
        meta = {r["cident"]: (r["argBytes"], r["shimVa"])
                for r in st.get("imports", [])}
    else:
        meta = {}
    for sym in d.get("symbols", []):
        va = sym.get("iatVa")
        if not va:
            continue
        stem = sym["dll"].lower()
        for suf in (".dll", "-l1-1-0", ".drv"):
            stem = stem.replace(suf, "")
        stem = "".join(c if c.isalnum() else "_" for c in stem)
        name = "".join(c if c.isalnum() or c == "_" else "_" for c in sym["symbol"])
        cname = "imp_%s__%s" % (stem, name)
        arg_bytes, token = meta.get(cname, (0, 0))
        out[int(va, 16)] = (cname, arg_bytes, token)
    return out


def load_ghidra(path):
    """Read the Ghidra headless inventory -> (starts, extents)."""
    starts = set()
    extents = {}
    with open(path, encoding="utf8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if not d.get("inText") or d.get("external"):
                continue
            va = int(d["va"], 16)
            starts.add(va)
            extents[va] = (int(d["minVa"], 16), int(d["endVa"], 16))
    return starts, extents

HERE = os.path.dirname(os.path.abspath(__file__))


def gen_state_header(regmap):
    out = ["/* generated: guest CPU state (SLEIGH x86:LE:32 root registers) */",
           "#ifndef RECOMP_STATE_H", "#define RECOMP_STATE_H",
           "#include <stdint.h>", "", "typedef struct CpuState {"]
    skipped = []
    for off, (roff, rsize, rname) in regmap.roots.items():
        if rsize in UTYPE:
            out.append("  %s %s;" % (UTYPE[rsize], rname))
        else:
            out.append("  uint8_t %s[%d];" % (rname, rsize))
            skipped.append(rname)
    out.append("} CpuState;")
    out.append("")
    out.append("#endif")
    return "\n".join(out) + "\n", skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", default="tools/isaac-ng.unpacked.exe")
    ap.add_argument("--va", action="append", default=[],
                    help="function VA to lift (repeatable)")
    ap.add_argument("--va-file", help="file with one VA per line")
    ap.add_argument("--starts-file",
                    help="every known function start (one VA per line), added to "
                         "the function-start set WITHOUT being lifted, so a worker "
                         "that lifts a subset (lift_parallel.py) makes the same "
                         "tail-call / absorb decisions as one run over the whole set")
    ap.add_argument("--no-rescue", action="store_true",
                    help="skip the fragment safety net: a lift_parallel.py "
                         "phase-1 worker lifts its wanted functions only; the "
                         "fragments are rescued once, against the coverage of "
                         "every worker, in phase 2")
    ap.add_argument("--rescue-only", action="store_true",
                    help="lift nothing but the fragments of --va-file that no "
                         "lifted body reaches (lift_parallel.py phase 2); "
                         "--covered-file supplies the bodies lifted elsewhere")
    ap.add_argument("--covered-file",
                    help="text ranges already lifted by other runs ('lo hi' "
                         "per line, hi exclusive), as emit.py writes them to "
                         "covered.txt; a fragment inside one is not rescued")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--module", default="lifted", help="base name of the .c")
    ap.add_argument("--follow", action="store_true",
                    help="also lift direct callees, transitively")
    ap.add_argument("--follow-depth", type=int, default=99)
    ap.add_argument("--split", type=int, default=0,
                    help="split output into N-function translation units")
    ap.add_argument("--split-va", type=lambda v: int(v, 0), default=0,
                    help="split into TUs by function ADDRESS: bucket = "
                         "(va - text_lo) // N, file lifted_<bucket>.c. A "
                         "function's TU then never moves, so a lifter change "
                         "that alters one function rewrites one file and "
                         "build_boot.py recompiles one object (round 14g). "
                         "0x30000 gives ~40 TUs of ~12 MB of C.")
    ap.add_argument("--split-bytes", type=int, default=0,
                    help="split on cumulative emitted C bytes instead of "
                         "function count; body sizes span 37 B (p50) to "
                         "64 KB, so counting functions produces wildly "
                         "uneven TUs and one huge TU dominates build time")
    ap.add_argument("--spill-flags", action="store_true",
                    help="spill/reload EFLAGS across calls (default: keep "
                         "flags function-local, valid for compiler output)")
    ap.add_argument("--ghidra-functions",
                    help="Ghidra headless functions.jsonl; supplies function "
                         "starts and body extents instead of the local scanner")
    ap.add_argument("--fragments-tsv",
                    help="Ghidra recovered-functions.tsv; rows without a real "
                         "prologue are treated as mid-function fragments")
    ap.add_argument("--fragments", default="absorb",
                    choices=("absorb", "split"),
                    help="absorb = fragments are not function boundaries and "
                         "are folded into their parent (lifted standalone "
                         "only if nothing else covers them); "
                         "split = treat every inventory row as a function")
    ap.add_argument("--imports",
                    help="host-boundary census imports.json; turns "
                         "`call [IAT slot]` into a direct shim call")
    ap.add_argument("--shim-table", default=None,
                    help="gen_shims.py sidecar (output/recomp/host/"
                         "shim-table.json); provides each import's stdcall "
                         "purge so lifted imp_* calls pop the return address "
                         "the way the real callee's `ret` would")
    ap.add_argument("--dispatch", default="auto"
,
                    choices=("off", "auto", "all", "force"),
                    help="per-function pc dispatch loop for computed jumps: "
                         "off = trap, auto = only functions with an "
                         "unresolved intra-function computed jump, "
                         "all = every function with any computed jump, "
                         "force = every function (cost measurement only)")
    ap.add_argument("--trace-va", action="store_true",
                    help="emit RECOMP_VA(addr) before every instruction. "
                         "Compiles to nothing unless the TU is also built "
                         "with -DRECOMP_MEM_CHECK=1, in which case a bad "
                         "guest pointer reports the instruction that made it "
                         "-- a wasm OOB trap otherwise names only a function.")
    ap.add_argument("--state-only", action="store_true",
                    help="no local register cache: every access goes through "
                         "the shared CpuState pointer (the remill/rev.ng shape)")
    ap.add_argument("--hand-written",
                    help="C file whose `void sub_XXXXXXXX(CpuState` "
                         "definitions are AUTHORITATIVE (scripts/recomp/host/"
                         "src/missing_fns.c). Those VAs are not lifted: they "
                         "are emitted as externs + weak aborting stubs, so "
                         "the hand-transcribed definition wins at link. "
                         "Without this the lifter and missing_fns.c both "
                         "define them and the link fails on duplicates.")
    ap.add_argument("--max-insns", type=int, default=20000)
    ap.add_argument("--stats", help="write per-function stats JSON here")
    args = ap.parse_args()

    t0 = time.time()
    pe = PE32(args.exe)
    ctx = pypcode.Context(LANG)
    regmap = RegMap(ctx)
    dec = Decoder(pe, ctx)
    text = pe.text()
    lo, hi = text.vaddr, text.vaddr + text.vsize

    extents = {}
    if args.ghidra_functions:
        func_starts, extents = load_ghidra(args.ghidra_functions)
    else:
        func_starts = scan.call_targets(pe)
    frags = set()
    if args.fragments_tsv and args.fragments == "absorb":
        frags = load_fragments(args.fragments_tsv)
        func_starts -= frags
    jt = JumpTables(pe)
    imports = (load_imports(args.imports, args.shim_table)
               if args.imports else {})
    t_scan = time.time()

    want = [int(v, 0) for v in args.va]
    if args.va_file:
        with open(args.va_file) as fh:
            for line in fh:
                line = line.split("#")[0].strip()
                if line:
                    want.append(int(line, 0))
    want = list(dict.fromkeys(want))
    handwritten = set()
    if args.hand_written:
        with io.open(args.hand_written, encoding="utf8") as fh:
            handwritten = {int(m, 16) for m in re.findall(
                r"^void sub_([0-9a-f]{8})\(CpuState", fh.read(), re.M)}
        # still function boundaries, so a caller does not absorb their bodies
        func_starts |= handwritten
    want = [v for v in want if v not in handwritten]
    deferred = [v for v in want if v in frags]
    want = [v for v in want if v not in frags]
    for v in want:
        func_starts.add(v)
    if args.starts_file:
        with open(args.starts_file) as fh:
            for line in fh:
                line = line.split("#")[0].strip()
                if not line:
                    continue
                v = int(line, 0)
                if v not in handwritten and v not in frags:
                    func_starts.add(v)

    opts = dict(local_flags=not args.spill_flags, max_insns=args.max_insns,
                state_only=args.state_only, imports=imports,
                shim_table=args.shim_table,
                trace_va=args.trace_va)

    lifted = {}
    stats = []
    failures = []
    data_stops = {}      # va -> decode error: data reached by fall-through (soft stop)
    callothers = []
    callothers_wide = []
    imports_used = set()
    covered = set()
    # ranges lifted by other runs (lift_parallel.py phase 1), merged so a
    # fragment absorbed by bodies in two workers is found by one bisect
    pre = []
    if args.covered_file:
        with open(args.covered_file) as fh:
            for line in fh:
                p = line.split("#")[0].split()
                if len(p) == 2:
                    pre.append((int(p[0], 0), int(p[1], 0)))
        pre.sort()
        merged = []
        for a, b in pre:
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else:
                merged.append((a, b))
        pre = merged
    pre_lo = [a for a, _b in pre]

    def pre_covered(va):
        i = bisect.bisect_right(pre_lo, va) - 1
        return i >= 0 and pre[i][0] <= va < pre[i][1]

    pending = [] if args.rescue_only else list(want)
    depth = {v: 0 for v in want}
    while pending:
        va = pending.pop(0)
        if va in lifted:
            continue
        try:
            ext = extents.get(va)
            body, jumps = discover_body(dec, va, func_starts, lo, hi, bad=data_stops,
                                        max_insns=args.max_insns, jt=jt,
                                        extent=ext)
            fopts = dict(opts)
            kinds = {k for k, _t in jumps.values()}
            if args.dispatch == "force":
                fopts["dispatch"] = True
            elif args.dispatch == "all" and jumps:
                fopts["dispatch"] = True
            elif args.dispatch == "auto" and "unknown" in kinds:
                fopts["dispatch"] = True
            em = FuncEmitter(regmap, "sub_%08x" % va, va, body, fopts, jumps)
            src = em.run()
        except LiftError as e:
            failures.append((va, str(e)))
            continue
        except Exception as e:                          # noqa: BLE001
            failures.append((va, "%s: %s" % (type(e).__name__, e)))
            continue
        lifted[va] = src
        callothers.extend(em.callother)
        callothers_wide.extend(em.callother_wide)
        imports_used.update(em.imports_used)
        for a, (ln, _ops) in body.items():
            covered.update(range(a, a + ln))
        st = dict(em.stats)
        st["va"] = va
        st["bytes"] = sum(v[0] for v in body.values())
        st["csize"] = len(src)
        st["clines"] = src.count("\n") + 1
        stats.append(st)
        if args.follow and depth.get(va, 0) < args.follow_depth:
            for t in sorted(em.direct_calls | em.tailcalls):
                if t not in lifted and lo <= t < hi:
                    depth.setdefault(t, depth.get(va, 0) + 1)
                    pending.append(t)

    # coverage safety net: a fragment nothing reached still has to be lifted
    rescued = 0
    if args.no_rescue:
        deferred = []
    for va in deferred:
        if va in covered or pre_covered(va) or va in lifted or va in handwritten:
            continue
        func_starts.add(va)
        try:
            body, jumps = discover_body(dec, va, func_starts, lo, hi, bad=data_stops,
                                        max_insns=args.max_insns, jt=jt,
                                        extent=extents.get(va))
            fopts = dict(opts)
            kinds = {k for k, _t in jumps.values()}
            if args.dispatch == "force":
                fopts["dispatch"] = True
            elif args.dispatch == "all" and jumps:
                fopts["dispatch"] = True
            elif args.dispatch == "auto" and "unknown" in kinds:
                fopts["dispatch"] = True
            em = FuncEmitter(regmap, "sub_%08x" % va, va, body, fopts, jumps)
            src = em.run()
        except LiftError as e:
            failures.append((va, str(e)))
            continue
        except Exception as e:                          # noqa: BLE001
            failures.append((va, "%s: %s" % (type(e).__name__, e)))
            continue
        lifted[va] = src
        rescued += 1
        callothers.extend(em.callother)
        callothers_wide.extend(em.callother_wide)
        imports_used.update(em.imports_used)
        st = dict(em.stats)
        st["va"] = va
        st["bytes"] = sum(v[0] for v in body.values())
        st["csize"] = len(src)
        st["clines"] = src.count("\n") + 1
        stats.append(st)
        for a, (ln, _ops) in body.items():
            covered.update(range(a, a + ln))

    t_lift = time.time()

    os.makedirs(args.out, exist_ok=True)
    hdr, big = gen_state_header(regmap)
    with open(os.path.join(args.out, "recomp_state.h"), "w") as fh:
        fh.write(hdr)

    # references that were not lifted -> extern stubs
    refs = set()
    for src in lifted.values():
        refs.update(int(m, 16) for m in re.findall(r"\bsub_([0-9a-f]{8})\(", src))
    missing = sorted((refs | handwritten) - set(lifted))
    others = {}
    for name, arity in callothers:
        others[name] = max(others.get(name, 0), arity)
    others_wide = {}
    for name, arity in callothers_wide:
        others_wide[name] = max(others_wide.get(name, 0), arity)

    decls = ["/* generated */", '#include "recomp_state.h"',
             '#include "recomp_rt.h"', ""]
    for va in sorted(set(lifted) | set(missing)):
        decls.append("void sub_%08x(CpuState *restrict s);" % va)
    for o in sorted(others):
        params = ", ".join(["CpuState *restrict s"] +
                           ["uint32_t"] * others[o])
        decls.append("uint32_t recomp_other_%s(%s);" % (o, params))
    for o in sorted(others_wide):
        # wide (SSE/AVX) CALLOTHER: every operand travels as (bytes, size)
        params = ", ".join(["CpuState *restrict s", "uint8_t *out",
                            "unsigned outsz"] +
                           ["const uint8_t *a%d, unsigned a%dsz" % (i, i)
                            for i in range(others_wide[o])])
        decls.append("void recomp_otherw_%s(%s);" % (o, params))
    for n in sorted(imports_used):
        decls.append("void %s(CpuState *restrict s);" % n)
    decls.append("")
    with open(os.path.join(args.out, "lifted_decls.h"), "w") as fh:
        fh.write("\n".join(decls) + "\n")

    order = sorted(lifted)
    chunks = []
    chunk_names = None
    if args.split_va:
        text_lo = pe.text().vaddr
        buckets = {}
        for va in order:
            buckets.setdefault((va - text_lo) // args.split_va, []).append(va)
        chunk_names = []
        for b in sorted(buckets):
            chunks.append(buckets[b])
            chunk_names.append("%s_%03d.c" % (args.module, b))
    elif args.split_bytes:
        cur, cur_bytes = [], 0
        for va in order:
            n = len(lifted[va])
            if cur and cur_bytes + n > args.split_bytes:
                chunks.append(cur)
                cur, cur_bytes = [], 0
            cur.append(va)
            cur_bytes += n
        if cur:
            chunks.append(cur)
    elif args.split and len(order) > args.split:
        for i in range(0, len(order), args.split):
            chunks.append(order[i:i + args.split])
    else:
        chunks = [order]

    total_c = 0
    files = []
    for ci, chunk in enumerate(chunks):
        if chunk_names is not None:
            name = chunk_names[ci]
        else:
            name = ("%s_%03d.c" % (args.module, ci)) if len(chunks) > 1 \
                else ("%s.c" % args.module)
        path = os.path.join(args.out, name)
        with open(path, "w") as fh:
            fh.write('#include "lifted_decls.h"\n\n')
            for va in chunk:
                fh.write(lifted[va])
                fh.write("\n\n")
        total_c += os.path.getsize(path)
        files.append(name)

    with open(os.path.join(args.out, "missing.txt"), "w") as fh:
        for va in missing:
            fh.write("%#010x\n" % va)
    with open(os.path.join(args.out, "failures.txt"), "w") as fh:
        for va, msg in failures:
            fh.write("%#010x %s\n" % (va, msg))
    # the .text ranges this run's bodies occupy, merged ('lo hi', hi exclusive):
    # lift_parallel.py unions the workers' files into the phase-2 --covered-file
    with open(os.path.join(args.out, "covered.txt"), "w") as fh:
        run_lo = prev = None
        for a in sorted(covered):
            if prev is not None and a == prev + 1:
                prev = a
                continue
            if run_lo is not None:
                fh.write("%#010x %#010x\n" % (run_lo, prev + 1))
            run_lo = prev = a
        if run_lo is not None:
            fh.write("%#010x %#010x\n" % (run_lo, prev + 1))
    with open(os.path.join(args.out, "data_stops.txt"), "w") as fh:
        for va in sorted(data_stops):
            fh.write("%#010x %s\n" % (va, data_stops[va]))

    # Reproducibility: the module directory must say how it was produced.
    # The `gu` tree was rebuilt once without this and the invocation had to be
    # reconstructed from `requested` counts and TU sizes.
    summary = dict(
        argv=[sys.argv[0]] + sys.argv[1:],
        exe=args.exe,
        func_starts_scanned=len(func_starts),
        requested=len(want),
        lifted=len(lifted),
        failed=len(failures),
        missing_callees=len(missing),
        hand_written=sorted(handwritten),
        callother_kinds=sorted(others),
        callother_wide_kinds=sorted(others_wide),
        x86_bytes=sum(s["bytes"] for s in stats),
        x86_insns=sum(s["insns"] for s in stats),
        pcode_ops=sum(s["pcode_ops"] for s in stats),
        c_bytes=total_c,
        c_lines=sum(s["clines"] for s in stats),
        files=files,
        scan_s=round(t_scan - t0, 2),
        lift_s=round(t_lift - t_scan, 2),
        big_regs=big,
        text_bytes_covered=len(covered),
        text_vsize=text.vsize,
        text_coverage_pct=round(100.0 * len(covered) / text.vsize, 2),
        import_shims_used=len(imports_used),
        fragments_excluded=len(frags),
        data_stops=len(data_stops),
        fragments_rescued=rescued,
        jt_tables=sum(x.get("jt_tables", 0) for x in stats),
        jt_entries=sum(x.get("jt_entries", 0) for x in stats),
        jt_tailcalls=sum(x.get("jt_tailcalls", 0) for x in stats),
        jt_unresolved=sum(x.get("jt_unresolved", 0) for x in stats),
        dispatch_loop_funcs=sum(x.get("dispatch", 0) for x in stats),
        callind_remaining=sum(x.get("callind", 0) for x in stats),
        callind_const_unresolved=sum(x.get("callind_const", 0) for x in stats),
    )
    if stats:
        summary["c_bytes_per_x86_byte"] = round(
            total_c / max(1, summary["x86_bytes"]), 2)
        summary["c_lines_per_x86_insn"] = round(
            summary["c_lines"] / max(1, summary["x86_insns"]), 2)
    with open(os.path.join(args.out, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    try:
        import ctypes
        class PMC(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_uint32), ("PageFaultCount", ctypes.c_uint32),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        c = PMC(); c.cb = ctypes.sizeof(PMC)
        ctypes.WinDLL("psapi").GetProcessMemoryInfo(
            ctypes.WinDLL("kernel32").GetCurrentProcess(), ctypes.byref(c), c.cb)
        summary["peak_rss_mb"] = round(c.PeakWorkingSetSize / 1048576.0, 1)
        with open(os.path.join(args.out, "summary.json"), "w") as fh:
            json.dump(summary, fh, indent=2)
    except Exception:
        pass
    if args.stats:
        with open(args.stats, "w") as fh:
            json.dump(stats, fh, indent=1)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
