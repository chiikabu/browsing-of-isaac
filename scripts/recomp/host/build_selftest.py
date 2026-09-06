"""Compile, link and RUN the host layer, and record the result.

emcc is not on PATH in this environment; the lifter locates it by absolute path
and so does this. Writes output/recomp/host/build-selftest.json so the test
suite can assert on a real build rather than on source structure alone.

Run:  python scripts/recomp/host/build_selftest.py
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import OUT_DIR, REPO_ROOT  # noqa: E402

def find_emcc():
    """Locate emcc without relying on PATH.

    The bare name `emcc` resolves under a POSIX shell on Windows because the
    shell probes extensions, but Python's Path.exists() does not -- the real
    file is emcc.exe. Probing explicitly avoids a false "emcc not found",
    which is exactly the mistake that led to shipping this layer
    compile-unverified the first time round.
    """
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


EMCC = find_emcc()
HOST = Path(__file__).resolve().parent
BUILD = OUT_DIR / "selftest"

SOURCES = sorted(HOST.glob("src/*.c")) + sorted(HOST.glob("generated/*.c")) + \
          [HOST / "selftest.c"]

# The guest image lives at 0x00400000 and the selftest touches .rdata (the IAT)
# and the shim arena at 0x0e000000/0x0f000000, so linear memory has to cover
# them. GLOBAL_BASE keeps host statics below the image, which the host layer
# asserts at boot.
CFLAGS = ["-O1", "-std=gnu11", "-Wall", "-Wextra", "-Wno-unused-parameter", "-msimd128",   # round 62: the v128 paths run here too (node has SIMD)
          "-I", str(HOST / "include"), "-I", str(HOST / "generated")]

# Upstream Lua 5.3.3, if present: host_lua.c compiles its real 59-symbol
# binding only when lua.h is visible, and the built liblua.a must be linked or
# every Lua shim is an undefined reference. Both are detected here so the
# earlier EMCC_CFLAGS handoff (documented but never read) could not silently
# degrade the build to the stub layer. Lua is a build input, not source: it
# lives in the gitignored tools/ private root; run lua_build.py to build it.
LUA_SRC = REPO_ROOT / "tools" / "lua-5.3.3" / "src"
LUA_LIB = OUT_DIR / "lua" / "liblua.a"
LUA_LINKED = LUA_SRC.joinpath("lua.h").exists() and LUA_LIB.exists()
if LUA_SRC.joinpath("lua.h").exists():
    CFLAGS += ["-I", str(LUA_SRC)]
# GLOBAL_BASE puts every host-owned byte above the 1 MiB guard at 0x0ff00000,
# so a wild guest write cannot reach the dispatch table or CpuState. See the
# address-space map in isaac_host.h. INITIAL_MEMORY must clear GLOBAL_BASE plus
# the host's own needs (14.2 MB dispatch table + statics + stack + malloc).
LDFLAGS = ["-sINITIAL_MEMORY=536870912", "-sALLOW_MEMORY_GROWTH=1",
           "-sMAXIMUM_MEMORY=4294967296",
           "-sGLOBAL_BASE=469762048", "-sSTACK_SIZE=1048576",   # round 66: host base 0x24000000
           "-sEXIT_RUNTIME=1", "-sASSERTIONS=1",
           "-sENVIRONMENT=node", "-sNODERAWFS=1", "-o"]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    if not EMCC:
        print("emcc not found; set EMCC=<path to emcc.exe>")
        return 2

    result = {"emcc": EMCC, "sources": [str(s.relative_to(REPO_ROOT)) for s in SOURCES]}
    v = run([EMCC, "--version"])
    result["emccVersion"] = v.stdout.splitlines()[0] if v.stdout else None

    # ---- compile each TU separately so errors are attributable ----
    t0 = time.time()
    objs, per_file, errors, warnings = [], [], 0, 0
    for src in SOURCES:
        obj = BUILD / (src.stem + ".o")
        r = run([EMCC, "-c"] + CFLAGS + [str(src), "-o", str(obj)])
        msg = (r.stderr or "") + (r.stdout or "")
        e = msg.count("error:")
        w = msg.count("warning:")
        errors += e
        warnings += w
        per_file.append({"file": src.name, "exit": r.returncode,
                         "errors": e, "warnings": w,
                         "diagnostics": [l for l in msg.splitlines()
                                         if "error:" in l or "warning:" in l][:20]})
        if r.returncode == 0:
            objs.append(str(obj))
    result["compile"] = {"files": len(SOURCES), "errors": errors,
                         "warnings": warnings, "perFile": per_file,
                         "seconds": round(time.time() - t0, 1)}

    if errors:
        result["ok"] = False
        (OUT_DIR / "build-selftest.json").write_text(
            json.dumps(result, indent=1), encoding="utf-8")
        for f in per_file:
            if f["errors"]:
                print("%s: %d errors" % (f["file"], f["errors"]))
                for d in f["diagnostics"]:
                    print("   ", d)
        return 1

    # ---- link ----
    # liblua.a goes on the link line only when the header is also visible to
    # host_lua.c; otherwise the 59 Lua shims would be undefined references.
    link_objs = list(objs)
    if LUA_LINKED:
        link_objs.append(str(LUA_LIB))
    js = BUILD / "selftest.js"
    r = run([EMCC] + link_objs + LDFLAGS + [str(js)])
    linkmsg = (r.stderr or "") + (r.stdout or "")
    result["lua"] = {
        "header": str(LUA_SRC.joinpath("lua.h")),
        "lib": str(LUA_LIB),
        "linked": LUA_LINKED,
    }
    result["link"] = {
        "exit": r.returncode,
        "duplicateSymbolErrors": linkmsg.count("duplicate symbol"),
        "undefinedSymbolErrors": linkmsg.count("undefined symbol"),
        "diagnostics": [l for l in linkmsg.splitlines()
                        if "error" in l.lower() or "undefined" in l.lower()][:25],
    }
    if r.returncode != 0:
        result["ok"] = False
        (OUT_DIR / "build-selftest.json").write_text(
            json.dumps(result, indent=1), encoding="utf-8")
        print("LINK FAILED")
        for d in result["link"]["diagnostics"]:
            print("   ", d)
        return 1

    wasm = BUILD / "selftest.wasm"
    result["artifact"] = {"wasmBytes": wasm.stat().st_size if wasm.exists() else None,
                          "jsBytes": js.stat().st_size}

    # ---- run ----
    # The repo's package.json sets "type": "module", so a .js file is parsed as
    # ESM and emcc's CommonJS output fails on `require`. Running the same bytes
    # under a .cjs extension is the whole fix.
    cjs = BUILD / "selftest.cjs"
    cjs.write_text(js.read_text(encoding="utf-8"), encoding="utf-8")
    mem = OUT_DIR / "isaac.mem"
    r = run(["node", str(cjs), str(mem)], cwd=str(BUILD))
    out = (r.stdout or "") + (r.stderr or "")
    result["run"] = {
        "exit": r.returncode,
        "checks": out.count("\nok    ") + (1 if out.startswith("ok    ") else 0),
        "failures": out.count("FAIL  "),
        "passed": "PASSED" in out,
        "output": out.splitlines(),
    }
    result["ok"] = (r.returncode == 0 and "PASSED" in out)

    (OUT_DIR / "build-selftest.json").write_text(
        json.dumps(result, indent=1), encoding="utf-8")

    print(out)
    print("compile: %d files, %d errors, %d warnings (%.1fs)" % (
        len(SOURCES), errors, warnings, result["compile"]["seconds"]))
    print("link   : exit %d, %d duplicate-symbol, %d undefined-symbol" % (
        result["link"]["exit"], result["link"]["duplicateSymbolErrors"],
        result["link"]["undefinedSymbolErrors"]))
    print("wasm   : %s bytes" % result["artifact"]["wasmBytes"])
    print("run    : %d checks, %d failures -> %s" % (
        result["run"]["checks"], result["run"]["failures"],
        "PASS" if result["ok"] else "FAIL"))
    print("lua    : %s" % ("linked, " + str(LUA_LIB) if LUA_LINKED
                           else "NOT LINKED -- run lua_build.py first"))
    print("wrote %s" % (OUT_DIR / "build-selftest.json"))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
