"""Compile a lifted module to wasm, measuring time / peak memory / size.

Compiles each translation unit in parallel with emcc -c, then links.
Reports per-phase wall time and peak RSS so the scaling claim can be
checked rather than estimated.
"""

import argparse
import concurrent.futures as cf
import glob
import json
import os
import re
import subprocess
import sys
import time

import psutil

EMCC = os.environ.get("EMCC", r"C:\Users\Luca\emsdk\upstream\emscripten\emcc")
HERE = os.path.dirname(os.path.abspath(__file__))


def run_measured(cmd, cwd=None):
    """Run cmd, return (rc, wall_s, peak_rss_mb, tail_of_output)."""
    t0 = time.time()
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, shell=False)
    try:
        proc = psutil.Process(p.pid)
    except psutil.NoSuchProcess:
        proc = None
    peak = 0
    out = []
    while p.poll() is None:
        if proc is not None:
            try:
                tot = proc.memory_info().rss
                for ch in proc.children(recursive=True):
                    try:
                        tot += ch.memory_info().rss
                    except psutil.Error:
                        pass
                peak = max(peak, tot)
            except psutil.Error:
                pass
        time.sleep(0.05)
    out = p.stdout.read().decode("utf8", "replace")
    return p.returncode, time.time() - t0, peak / 1048576.0, out[-4000:]


def gen_stubs(d):
    missing = [l.strip() for l in open(os.path.join(d, "missing.txt"))
               if l.strip()]
    decls = open(os.path.join(d, "lifted_decls.h")).read()
    others = re.findall(r"uint32_t recomp_other_(\w+)\(([^)]*)\);", decls)
    others_wide = re.findall(r"void recomp_otherw_(\w+)\(([^)]*)\);", decls)
    shims = re.findall(r"void (imp_\w+)\(CpuState", decls)
    path = os.path.join(d, "stubs.c")
    with open(path, "w") as fh:
        fh.write('#include "lifted_decls.h"\n#include <stdlib.h>\n')
        for va in missing:
            fh.write("void sub_%08x(CpuState *restrict s)"
                     "{ s->EIP=MEMR32(s->ESP); s->ESP+=4; }\n" % int(va, 16))
        for name, params in others:
            ps = [x.strip() for x in params.split(",")]
            args = ", ".join(p + " a%d" % i if p == "uint32_t" else p
                             for i, p in enumerate(ps))
            fh.write("uint32_t recomp_other_%s(%s){ (void)s; abort(); "
                     "return 0; }\n" % (name, args))
        for name, params in others_wide:
            fh.write("__attribute__((weak)) void recomp_otherw_%s(%s)"
                     "{ (void)s; abort(); }\n" % (name, params))
        for name in shims:
            fh.write("void %s(CpuState *restrict s)"
                     "{ s->EIP=MEMR32(s->ESP); s->ESP+=4; }\n" % name)
    return len(missing), len(others) + len(others_wide) + len(shims)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--opt", default="-O2")
    ap.add_argument("--jobs", type=int, default=os.cpu_count())
    ap.add_argument("--limit-tus", type=int, default=0)
    ap.add_argument("--out", default="mod")
    args = ap.parse_args()

    d = args.dir
    nmiss, nother = gen_stubs(d)
    tus = sorted(glob.glob(os.path.join(d, "lifted_*.c")))
    if args.limit_tus:
        tus = tus[:args.limit_tus]
    tus.append(os.path.join(d, "stubs.c"))
    tus.append(os.path.join(HERE, "recomp_rt.c"))

    csrc = sum(os.path.getsize(t) for t in tus)
    print("TUs: %d   C source: %.1f MB   stubs: %d missing / %d callother"
          % (len(tus), csrc / 1048576.0, nmiss, nother))

    inc = ["-I", HERE, "-I", d]
    objs = []
    results = []

    def compile_one(t):
        # objects always land in the output dir, never next to the sources
        o = os.path.join(d, os.path.basename(t).replace(".c", ".o"))
        cmd = [EMCC, args.opt, "-c", "-w", t, "-o", o] + inc
        rc, wall, peak, out = run_measured(cmd)
        return t, o, rc, wall, peak, out

    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for t, o, rc, wall, peak, out in ex.map(compile_one, tus):
            results.append(dict(tu=os.path.basename(t),
                                c_bytes=os.path.getsize(t),
                                obj_bytes=os.path.getsize(o) if rc == 0 else 0,
                                rc=rc, wall_s=round(wall, 1),
                                peak_mb=round(peak, 1)))
            if rc != 0:
                print("FAIL %s\n%s" % (t, out))
            objs.append(o)
    compile_wall = time.time() - t0

    # export everything so nothing is dead-stripped
    names = set()
    for t in tus:
        with open(t) as fh:
            names.update(re.findall(r"^void (sub_[0-9a-f]{8})\(CpuState",
                                    fh.read(), re.M))
    expo = os.path.join(d, "exports.json")
    with open(expo, "w") as fh:
        json.dump(sorted("_" + n for n in names), fh)

    link = [EMCC, args.opt, "--no-entry", "-w",
            "-o", os.path.join(d, args.out + ".js"),
            "-sEXPORTED_FUNCTIONS=@" + expo,
            "-sALLOW_MEMORY_GROWTH=1"] + objs
    rc, link_wall, link_peak, out = run_measured(link)
    wasm = os.path.join(d, args.out + ".wasm")
    wasm_bytes = os.path.getsize(wasm) if os.path.exists(wasm) else 0
    if rc != 0:
        print("LINK FAIL\n" + out)

    summ = json.load(open(os.path.join(d, "summary.json")))
    report = dict(
        opt=args.opt, jobs=args.jobs, tus=len(tus),
        c_bytes=csrc,
        obj_bytes=sum(r["obj_bytes"] for r in results),
        x86_bytes=summ.get("x86_bytes"),
        functions=len(names),
        compile_wall_s=round(compile_wall, 1),
        compile_cpu_s=round(sum(r["wall_s"] for r in results), 1),
        compile_peak_mb_max_tu=max(r["peak_mb"] for r in results),
        link_wall_s=round(link_wall, 1),
        link_peak_mb=round(link_peak, 1),
        link_rc=rc,
        wasm_bytes=wasm_bytes,
    )
    if summ.get("x86_bytes"):
        report["wasm_per_x86_byte"] = round(wasm_bytes / summ["x86_bytes"], 2)
    report["per_tu"] = sorted(results, key=lambda r: -r["wall_s"])[:8]
    with open(os.path.join(d, "build_report_%s.json" % args.opt.strip("-")),
              "w") as fh:
        json.dump(report, fh, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
