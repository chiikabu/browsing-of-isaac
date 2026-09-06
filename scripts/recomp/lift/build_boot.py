"""Link the host layer + lifted objects into the boot ES module.

This is the union of scripts/recomp/host/build_selftest.py (host sources,
Lua, identity-address memory flags) and scripts/recomp/lift/build_wasm.py
(parallel lifted-TU compile). The Aug-10 boot.wasm was produced by an
ad-hoc bash recipe (output/recomp/lift/boot/link_prof.sh) that was never
checked in; this script is that recipe, plus _isaac_fs_seed.

Default lift tree is output/recomp/lift/gu (23,381 functions, the 271 MB
module that reached main). output/recomp/lift/full is the earlier 7,963-
function slice and cannot reach the HUD path. Override with --dir.

Run:  python scripts/recomp/lift/build_boot.py
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOST = HERE.parent / "host"
REPO_ROOT = HERE.parents[2]
OUT_LIFT = REPO_ROOT / "output" / "recomp" / "lift"
OUT_HOST = REPO_ROOT / "output" / "recomp" / "host"
BOOT_OUT = OUT_LIFT / "boot"
LUA_SRC = REPO_ROOT / "tools" / "lua-5.3.3" / "src"
LUA_LIB = OUT_HOST / "lua" / "liblua.a"
# Round 25: the web profile links with JSPI, and a JSPI suspension cannot cross
# a JavaScript frame. The default setjmp/longjmp implementation puts invoke_*
# JS trampolines around every call made by a function that uses setjmp
# (isaac_guest_call_inner in dispatch_tbl.c, luaD_rawrunprotected in Lua), so
# the web profile compiles every setjmp/longjmp user with the Wasm-EH
# implementation (-sSUPPORT_LONGJMP=wasm) and links a Lua built the same way.
# The lifted TUs never call setjmp/longjmp themselves (the guest's _setjmp3 /
# longjmp are host shims), so their objects stay shared with the node profiles.
LUA_LIB_WASM_SJLJ = OUT_HOST / "lua-wasmsjlj" / "liblua.a"
SJLJ_CFLAGS: list = []

# Prior boot export set (link_prof.sh) plus the 2026-08-31 RAM-FS seed hook.
# boot_integration.mjs is the only JS caller; grep m._isaac_* there before
# adding more names.
EXPORTED_FUNCTIONS = [
    "_malloc",
    "_free",
    "_isaac_place_image",
    "_isaac_layout_check",
    "_isaac_guard_arm",
    "_isaac_guard_check",
    "_isaac_run_boot",
    "_isaac_run_main",
    "_isaac_fs_seed",
    "_isaac_fs_seed_lazy",
    "_isaac_stub_report",
    "_isaac_dump_va_ring",
    "_isaac_heap_report",
    "_isaac_module_report",
]


def ensure_emsdk_env():
    """emcc is not on PATH in this environment; export EMSDK every process."""
    home = Path.home()
    emsdk = Path(os.environ.get("EMSDK", home / "emsdk"))
    if emsdk.is_dir():
        os.environ["EMSDK"] = str(emsdk)
        prepend = [
            str(emsdk),
            str(emsdk / "upstream" / "emscripten"),
            str(emsdk / "upstream" / "bin"),
        ]
        os.environ["PATH"] = os.pathsep.join(
            prepend + [os.environ.get("PATH", "")])


def find_emcc():
    """Locate emcc without relying on PATH. Mirrors host/build_selftest.py."""
    cand = os.environ.get("EMCC")
    roots = [cand] if cand else []
    roots += [r"C:\Users\Luca\emsdk\upstream\emscripten\emcc",
              str(Path.home() / "emsdk" / "upstream" / "emscripten" / "emcc"),
              "emcc"]
    for r in roots:
        for ext in (".exe", ".bat", ".cmd", ""):
            p = Path(r + ext)
            if p.exists() and p.is_file():
                return str(p)
    from shutil import which
    return which("emcc")


def default_lift_dir():
    """Prefer the lift that actually booted (gu), then the 96% slice, then full."""
    for name in ("gu", "gabs", "full"):
        d = OUT_LIFT / name
        if any(d.glob("lifted_*.c")):
            return d
    return OUT_LIFT / "full"


HOST_CFLAGS = [
    "-O1", "-std=gnu11", "-Wall", "-Wextra", "-Wno-unused-parameter",
]
# Lifted TUs were built -O2 -DRECOMP_MEM_CHECK=1; reuse those objects when
# present so a relink does not wait on 492 MB of C. Recompile with the same
# flags if --recompile-lifted or an object is missing.
LIFT_CFLAGS = ["-O2", "-w", "-DRECOMP_MEM_CHECK=1"]

LDFLAGS = [
    "-O2", "-w", "--no-entry", "--profiling-funcs",
    # The wasm memory is committed the moment it is created, so INITIAL_MEMORY is
    # resident bytes on every machine that opens the page; growing it later
    # reallocates and copies the whole heap (round 15e: a 200-s play run managed
    # 900 frames instead of 7,980 when it had to grow). It has to clear the host
    # base -- the top of the guest map in isaac_host.h -- plus the host's own
    # 256 MiB. Round 66 took the guest arena from 768 MiB to 512, measured
    # against the engine's own high-water mark of 350 MiB, so the host base is
    # 0x24000000 and this is 832 MiB instead of 1088. Override with
    # --initial-memory. MAXIMUM_MEMORY lifts the 2 GiB growth ceiling wasm32
    # gets by default.
    "-sINITIAL_MEMORY=738197504",
    "-sMAXIMUM_MEMORY=4294967296",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sGLOBAL_BASE=469762048",
    "-sSTACK_SIZE=1048576",
    "-sASSERTIONS=1",
    "-sENVIRONMENT=node",
    "-sNODERAWFS=1",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32",
]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def compile_one(emcc, src, obj, flags):
    obj.parent.mkdir(parents=True, exist_ok=True)
    cmd = [emcc, "-c", *flags, str(src), "-o", str(obj)]
    r = run(cmd)
    msg = (r.stderr or "") + (r.stdout or "")
    return {
        "src": str(src),
        "obj": str(obj),
        "rc": r.returncode,
        "errors": msg.count("error:"),
        "warnings": msg.count("warning:"),
        "tail": "\n".join(msg.splitlines()[-30:]),
    }


def py_cmd(*args):
    return [sys.executable, *args]


def main():
    ensure_emsdk_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=default_lift_dir(),
                    help="lifted TU directory (default: gu, then gabs, then full)")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--recompile-lifted", action="store_true",
                    help="rebuild lifted_*.o even if objects already exist")
    ap.add_argument("--skip-dispatch-gen", action="store_true",
                    help="reuse existing dispatch_tbl.c / stubs.c")
    ap.add_argument("--fast-link", dest="fast_link", action="store_true", default=True,
                    help="(default) link at -O0: no wasm-opt pass over the 272 MB module. The "
                         "lifted objects are already -O2, so only the JS glue and dead-code "
                         "elimination differ. Measured 2026-09-01: link 474 s -> 8.0 s, whole "
                         "host-only relink 520 s -> 133 s; module 272 -> 284 MB.")
    ap.add_argument("--opt-link", dest="fast_link", action="store_false",
                    help="link at -O2 (wasm-opt over the whole module, ~8 min) for a shipping build")
    ap.add_argument("--no-lift-patches", action="store_true",
                    help="do not apply scripts/recomp/lift/lift_patches.py to the lifted TUs")
    ap.add_argument("--web", action="store_true",
                    help="browser profile: host objects rebuilt as .web.o with -DISAAC_WEB=1 "
                         "(real WebGL2 GL backend, EM_JS bridges), link with -sENVIRONMENT=web, "
                         "MEMFS (no NODERAWFS), FS/ENV exported; output in boot-web/. Driven by "
                         "scripts/recomp/web/run_web.mjs under Playwright.")
    ap.add_argument("--initial-memory", type=lambda v: int(v, 0), default=0,
                    help="override -sINITIAL_MEMORY (bytes). Growing the wasm "
                         "memory reallocates and copies the whole heap, which "
                         "on this host is a native, wasm-suspending, "
                         "compilation-free, GC-free, I/O-free burst of exactly "
                         "the shape the room-entry crawl has (round 15c). Give "
                         "the module its peak up front to test that.")
    ap.add_argument("--fast", action="store_true",
                    help="speed profile: lifted TUs with -DRECOMP_MEM_CHECK=0 (no bounds checks, VA "
                         "ring, memory watch or stall tick), objects as lifted_NNN.fast.o, output in "
                         "boot-fast/, wasm-opt link. Faults become raw wasm traps; measure with it, "
                         "debug with the default profile.")
    args = ap.parse_args()
    global BOOT_OUT, LIFT_CFLAGS, LDFLAGS, HOST_CFLAGS, LUA_LIB, SJLJ_CFLAGS
    lift_obj_suffix = ".o"
    host_obj_suffix = ".o"
    if args.initial_memory:
        LDFLAGS = [f for f in LDFLAGS if not f.startswith("-sINITIAL_MEMORY=")]
        LDFLAGS += ["-sINITIAL_MEMORY=%d" % args.initial_memory]
        print("link : INITIAL_MEMORY overridden to %d bytes (%.0f MiB)"
              % (args.initial_memory, args.initial_memory / 1048576.0))
    if args.web:
        BOOT_OUT = OUT_LIFT / "boot-web"
        HOST_CFLAGS = HOST_CFLAGS + ["-DISAAC_WEB=1"]
        host_obj_suffix = ".web.o"
        LDFLAGS = [f for f in LDFLAGS
                   if f not in ("-sENVIRONMENT=node", "-sNODERAWFS=1",
                                "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32")]
        # Round 25: JSPI. The frame present suspends the wasm stack once per
        # frame (emscripten_sleep(0)) so the page's event loop runs; the exports
        # that may be on the stack at that moment return promises. JSPI_EXPORTS
        # names WASM exports (isaac_run_main, not the JS-side _isaac_run_main).
        # A suspension cannot cross a JS frame, so setjmp/longjmp must be the
        # Wasm-EH implementation rather than the invoke_* trampolines -- in the
        # host TUs, in dispatch_tbl.c (compiled below with the lifted flags) and
        # in Lua (its own archive, built by lua_build.py --sjlj wasm).
        SJLJ_CFLAGS = ["-sSUPPORT_LONGJMP=wasm"]
        HOST_CFLAGS = HOST_CFLAGS + SJLJ_CFLAGS
        LUA_LIB = LUA_LIB_WASM_SJLJ
        # Round 56: the archive window read may answer with a promise (the
        # page's reader Worker), so it suspends the stack like the yield does.
        LDFLAGS += ["-sJSPI", "-sJSPI_EXPORTS=isaac_run_main,isaac_run_boot",
                    "-sJSPI_IMPORTS=emscripten_sleep,__asyncjs__isaac_yield_js,isaac_fs_lazy_pread_js", "-sSUPPORT_LONGJMP=wasm"]
        LDFLAGS += ["-sENVIRONMENT=web", "-sFORCE_FILESYSTEM=1",
                    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,FS,ENV",
                    "-sMAX_WEBGL_VERSION=2", "-sMIN_WEBGL_VERSION=2",
                    "-sGL_ENABLE_GET_PROC_ADDRESS=0", "-lGL"]
    if args.fast:
        # --web --fast is a browser module built with the speed profile: the
        # web flags above stay, only the lifted objects and the output
        # directory change. Round 20 measured the speed profile 20x faster in
        # gameplay, which is what makes a browser demo of more than a few
        # hundred frames practical at all.
        BOOT_OUT = OUT_LIFT / ("boot-web-fast" if args.web else "boot-fast")
        LIFT_CFLAGS = ["-O3", "-w", "-DRECOMP_MEM_CHECK=0"]
        # Round 58: the host TUs at -O3 too. They were -O1 beside -O3 lifted
        # code, and the host is a quarter to a third of the loading window
        # (the decoders, the GL emulation) and of a play frame.
        HOST_CFLAGS = ["-O3" if f == "-O1" else f for f in HOST_CFLAGS]
        # Round 61: wasm SIMD for the host TUs (every browser since 2021 and
        # node have it): clang vectorises the byte loops of the decoders, the
        # premultiply and adler32 at -O3 once it may use v128.
        HOST_CFLAGS = HOST_CFLAGS + ["-msimd128"]
        lift_obj_suffix = ".fast.o"
        args.fast_link = False

    emcc = find_emcc()
    if not emcc:
        print("emcc not found; set EMCC=<path to emcc.exe> and EMSDK=$HOME/emsdk")
        return 2

    lift_dir = args.dir.resolve()
    if not any(lift_dir.glob("lifted_*.c")):
        print("no lifted_*.c in %s" % lift_dir)
        return 2
    if args.web and not LUA_LIB.exists():
        # the wasm-sjlj Lua is a half-minute build from the same source tree
        print("lua  : building %s (setjmp/longjmp as Wasm EH, round 25)" % LUA_LIB)
        r = run(py_cmd(str(HOST / "lua_build.py"), "--build", "--sjlj", "wasm"))
        print("\n".join(((r.stdout or "") + (r.stderr or "")).splitlines()[-3:]))
    if not LUA_LIB.exists():
        print("liblua.a missing at %s -- run scripts/recomp/host/lua_build.py" % LUA_LIB)
        return 2

    # ---- source-level overrides of the generated C (idempotent) ----------
    # The canonical exe carries the project's own emulator-era hand patches;
    # the ones that break the recompiled boot are undone HERE, after the lift
    # and BEFORE dispatch generation (the patched bodies keep their RECOMP_VA
    # markers), and the touched TU's object is dropped so it recompiles.
    if not args.no_lift_patches:
        sys.path.insert(0, str(HERE))
        from lift_patches import (apply_lift_patches, apply_purge_patches,  # noqa: E402
                                  apply_wrap_patches, apply_block_patches, apply_entry_first)
        patched = (set(apply_lift_patches(lift_dir)) | set(apply_purge_patches(lift_dir))
                   | set(apply_wrap_patches(lift_dir)) | set(apply_block_patches(lift_dir))
                   | set(apply_entry_first(lift_dir)))
        # Round 43: giant functions become trampolined parts AFTER every other
        # text patch (the re-entry guard and the entry-first goto are absorbed
        # into the trampoline); the browser's baseline compiler paid quadratically
        # for a 338,000-line function.
        from split_giants import apply_split_giants  # noqa: E402
        patched |= set(apply_split_giants(lift_dir))
        print("lift-patches: %d TU(s) rewritten" % len(patched))

    BOOT_OUT.mkdir(parents=True, exist_ok=True)
    obj_dir = BOOT_OUT / "obj"
    obj_dir.mkdir(parents=True, exist_ok=True)

    inc_host = [
        "-I", str(HOST / "include"),
        "-I", str(HOST / "generated"),
        "-I", str(HERE),
        "-I", str(lift_dir),
    ]
    if (LUA_SRC / "lua.h").exists():
        inc_host += ["-I", str(LUA_SRC)]
    inc_lift = ["-I", str(HERE), "-I", str(lift_dir),
                "-I", str(HOST / "include")]

    result = {
        "emcc": emcc,
        "liftDir": str(lift_dir),
        "jobs": args.jobs,
        "recompileLifted": args.recompile_lifted,
    }
    v = run([emcc, "--version"])
    result["emccVersion"] = v.stdout.splitlines()[0] if v.stdout else None
    print("emcc : %s" % result["emccVersion"])
    print("lift : %s" % lift_dir)

    # ---- invariants over the lifted tree ----------------------------------
    # A generated-code defect that can only show up as a silent infinite hang
    # has to be caught here rather than in a run: round 15c's room-entry crawl
    # was six dispatch-loop functions with no `case` for their own entry VA.
    r = run(py_cmd(str(HERE / "check_lifted.py"), "--dir", str(lift_dir),
                   "--module", args.module if hasattr(args, "module") else "lifted"))
    print((r.stdout or "").strip() or "check_lifted.py")
    if r.returncode:
        print("check_lifted.py found a lifted-tree defect; not building it\n%s"
              % ((r.stderr or "").strip()))
        return 1

    # ---- generate dispatch + loud stubs (no imp_* : host owns those) ----
    t_gen = time.time()
    if not args.skip_dispatch_gen:
        r = run(py_cmd(str(HERE / "mkstubs.py"), "--dir", str(lift_dir),
                       "--no-import-stubs"))
        print((r.stdout or "").strip() or "mkstubs.py")
        if r.returncode:
            print("mkstubs.py failed\n%s" % ((r.stderr or "") + (r.stdout or "")))
            return 1
        r = run(py_cmd(str(HERE / "mkdispatch.py"), "--dir", str(lift_dir)))
        print((r.stdout or "").strip() or "mkdispatch.py")
        if r.returncode:
            print("mkdispatch.py failed\n%s" % ((r.stderr or "") + (r.stdout or "")))
            return 1
    result["generate_s"] = round(time.time() - t_gen, 1)

    # ---- compile host src + generated + boot entry + runtime + dispatch ----
    host_srcs = sorted(HOST.glob("src/*.c")) + sorted(HOST.glob("generated/*.c"))
    extra_srcs = [
        HERE / "boot_integration.c",
        HERE / "recomp_rt.c",
        lift_dir / "stubs.c",
        lift_dir / "dispatch_tbl.c",
    ]
    for s in extra_srcs:
        if not s.exists():
            print("missing source %s" % s)
            return 1

    t0 = time.time()
    host_objs = []
    host_fail = []
    for src in host_srcs + extra_srcs:
        obj = obj_dir / (src.stem + host_obj_suffix)
        flags = HOST_CFLAGS + inc_host
        if src in extra_srcs:
            # boot_integration.c / recomp_rt.c / dispatch / stubs need the
            # lifter headers; keep host warning flags off generated stubs.
            flags = (HOST_CFLAGS if src.name in (
                "boot_integration.c", "recomp_rt.c") else LIFT_CFLAGS + SJLJ_CFLAGS) + inc_lift
            if src.name == "recomp_rt.c":
                flags = LIFT_CFLAGS + SJLJ_CFLAGS + inc_lift
        info = compile_one(emcc, src, obj, flags)
        if info["rc"] != 0:
            host_fail.append(info)
            print("FAIL %s\n%s" % (src.name, info["tail"]))
        else:
            host_objs.append(obj)
            if info["warnings"]:
                print("%s: %d warnings" % (src.name, info["warnings"]))
    result["hostCompile_s"] = round(time.time() - t0, 1)
    result["hostTUs"] = len(host_srcs) + len(extra_srcs)
    if host_fail:
        result["ok"] = False
        (BOOT_OUT / "build_boot.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8")
        return 1
    print("host : %d TUs in %.1fs" % (len(host_objs), result["hostCompile_s"]))

    # ---- lifted objects: reuse Aug-10 .o unless asked to rebuild ----
    lifted_cs = sorted(lift_dir.glob("lifted_*.c"))
    lifted_objs = []
    need_compile = []
    # Round 14g: a TU is recompiled when its (patched) text changed since the
    # object was built -- sha256 stored beside the object -- so a re-lift
    # with --split-va rebuilds only the TUs whose functions changed.
    import hashlib
    # A TU's object also depends on the headers it includes and on the compile
    # flags, neither of which is in its own text: hashing the .c alone made a
    # `recomp_rt.h` edit a silent no-op rebuild (round 15b -- it would have
    # produced a module whose lifted code still carried the old tick
    # interval). The fingerprint covers every header the lifted TUs can
    # include plus the flag list, so touching one rebuilds all of them.
    dep_h = sorted(set(lift_dir.glob("*.h")) |
                   set((HERE / "..").resolve().glob("host/src/*.h")) |
                   set(HERE.glob("*.h")))
    dep_fp = hashlib.sha256()
    for h in dep_h:
        dep_fp.update(h.name.encode())
        dep_fp.update(h.read_bytes())
    dep_fp.update(repr(LIFT_CFLAGS + inc_lift).encode())
    dep_fp = dep_fp.hexdigest()
    print("lift : dependency fingerprint %s (%d headers + flags)" % (dep_fp[:12], len(dep_h)))

    def text_sha(path):
        return hashlib.sha256(path.read_bytes() + dep_fp.encode()).hexdigest()
    lifted_sha = {}
    skipped_same = 0
    for src in lifted_cs:
        obj = lift_dir / (src.stem + lift_obj_suffix)
        sha_file = lift_dir / (src.stem + lift_obj_suffix + ".sha")
        sha = text_sha(src)
        lifted_sha[src] = (sha, sha_file)
        if args.recompile_lifted or not obj.exists():
            need_compile.append((src, obj))
        elif sha_file.exists() and sha_file.read_text().strip() == sha:
            lifted_objs.append(obj)
            skipped_same += 1
        elif not sha_file.exists():
            # object from before the hashes existed: trust it once, record it
            sha_file.write_text(sha)
            lifted_objs.append(obj)
        else:
            need_compile.append((src, obj))
    if skipped_same:
        print("lift : %d TU(s) unchanged (hash), objects kept" % skipped_same)
    t1 = time.time()
    lift_fail = []
    if need_compile:
        print("lift : compiling %d / %d TUs (%d jobs)" % (
            len(need_compile), len(lifted_cs), args.jobs))

        def one(pair):
            src, obj = pair
            return compile_one(emcc, src, obj, LIFT_CFLAGS + inc_lift)

        with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
            for info in ex.map(one, need_compile):
                if info["rc"] != 0:
                    lift_fail.append(info)
                    print("FAIL %s\n%s" % (Path(info["src"]).name, info["tail"]))
                else:
                    lifted_objs.append(Path(info["obj"]))
                    sha, sha_file = lifted_sha[Path(info["src"])]
                    sha_file.write_text(sha)
    result["liftCompile_s"] = round(time.time() - t1, 1)
    result["liftedTUs"] = len(lifted_cs)
    result["liftedRecompiled"] = len(need_compile)
    if lift_fail:
        result["ok"] = False
        (BOOT_OUT / "build_boot.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8")
        return 1
    print("lift : %d objects (%d rebuilt) in %.1fs" % (
        len(lifted_objs), len(need_compile), result["liftCompile_s"]))

    # ---- link via response file (Windows argv limit; 40+ large .o) ----
    expo = BOOT_OUT / "exported_functions.json"
    expo.write_text(json.dumps(EXPORTED_FUNCTIONS), encoding="utf-8")
    out_mjs = BOOT_OUT / "boot.mjs"
    link_objs = [str(p) for p in lifted_objs + host_objs] + [str(LUA_LIB)]
    rsp = BOOT_OUT / "link.rsp"
    lines = []
    ldflags = list(LDFLAGS)
    if args.fast_link:
        # -O2 at link runs wasm-opt over the whole 272 MB module and dominates
        # the 8-minute link; the objects are already -O2. Measured per build.
        ldflags = ["-O0" if f == "-O2" else f for f in ldflags]
    result["fastLink"] = bool(args.fast_link)
    lines.extend(ldflags)
    lines += ["-sEXPORTED_FUNCTIONS=@" + str(expo).replace("\\", "/")]
    lines += ["-o", str(out_mjs).replace("\\", "/")]
    lines += [p.replace("\\", "/") for p in link_objs]
    rsp.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("link : %d inputs -> %s" % (len(link_objs), out_mjs))
    t2 = time.time()
    r = run([emcc, "@" + str(rsp)])
    linkmsg = (r.stderr or "") + (r.stdout or "")
    result["link_s"] = round(time.time() - t2, 1)
    result["link_rc"] = r.returncode
    result["duplicateSymbolErrors"] = linkmsg.count("duplicate symbol")
    result["undefinedSymbolErrors"] = linkmsg.count("undefined symbol")
    result["linkDiagnostics"] = [
        l for l in linkmsg.splitlines()
        if "error" in l.lower() or "undefined" in l.lower()
        or "duplicate" in l.lower()][:40]
    wasm = BOOT_OUT / "boot.wasm"
    result["wasmBytes"] = wasm.stat().st_size if wasm.exists() else None
    result["mjsBytes"] = out_mjs.stat().st_size if out_mjs.exists() else None

    if r.returncode != 0:
        result["ok"] = False
        (BOOT_OUT / "build_boot.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8")
        print("LINK FAILED (%.1fs)" % result["link_s"])
        for d in result["linkDiagnostics"]:
            print("   ", d)
        tail = "\n".join(linkmsg.splitlines()[-60:])
        if tail:
            print(tail)
        return 1

    # Driver lives next to the module (import Module from './boot.mjs').
    driver_src = HERE / "boot_integration.mjs"
    driver_dst = BOOT_OUT / "boot_integration.mjs"
    shutil.copy2(driver_src, driver_dst)
    # Round 27: the door-aware explorer the driver imports for ISAAC_DRIVE=explore.
    shutil.copy2(HERE / "explore.mjs", BOOT_OUT / "explore.mjs")
    shutil.copy2(HERE / "console_typing.mjs", BOOT_OUT / "console_typing.mjs")   # round 32: the typed console driver

    result["ok"] = True
    result["out"] = str(out_mjs)
    (BOOT_OUT / "build_boot.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8")
    print("link : exit 0 in %.1fs" % result["link_s"])
    print("wasm : %s bytes" % result["wasmBytes"])
    print("mjs  : %s bytes" % result["mjsBytes"])
    print("driver copied to %s" % driver_dst)
    print("wrote %s" % (BOOT_OUT / "build_boot.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
