"""Build upstream Lua 5.3.3 as wasm with the ABI the shipped DLL actually has.

WHY THIS IS A SCRIPT AND NOT A README
-------------------------------------
The flags are not defaults, and one of them is an active trap:

  * Upstream's own Makefile ships **-DLUA_COMPAT_5_2**. The shipped
    Lua5.3.3r.dll was built WITHOUT it, and it changes the exported surface.
    Following upstream's default breaks the ABI.
  * **LUA_32BITS must stay off** -- it switches lua_Integer to int and
    lua_Number to float, silently halving both. LUAL_NUMSIZES = 136 in the DLL
    proves Integer 8 / Number 8.
  * **LUA_C89_NUMBERS must stay off.** LUA_USE_C89 *was* on in the DLL; the two
    are different switches and only the latter applies.
  * Build as **C, not C++** -- lua.hpp changes error handling to exceptions.

Getting any of these wrong produces a library that links and runs and corrupts
values, which is the worst failure mode available.

FETCHING THE SOURCE
-------------------
This script does NOT download anything on its own. Downloading is an action
that needs the operator's explicit go-ahead, so the tarball must be placed at
  tools/lua-5.3.3.tar.gz
(or a directory at tools/lua-5.3.3/) before running with --build. tools/ is a
gitignored private root -- the tarball and the extracted source are build
inputs, never tracked source (the same rule that keeps the game binary there).

  source : https://www.lua.org/ftp/lua-5.3.3.tar.gz
  size   : 294,290 bytes (measured)
  sha256 : 5113c06884f7de453ce57702abaac1d618307f33f6789fa870e87a59d772aca2
           (published on the lua.org/ftp index, verified against the download)
  sha1   : a0341bc3d1415b814cc738b2ec01ae56045d64ef  (same file, cross-check)

Run `python scripts/recomp/host/lua_build.py` with no arguments to print the
exact command line and verify the environment without touching the network.
After `--build`, run `python scripts/recomp/host/build_selftest.py` with NO
extra flags: it auto-detects third_party/lua-5.3.3/src/lua.h, adds the include
path itself, links output/recomp/host/lua/liblua.a, and the selftest then
executes the 15 Lua runtime checks (ABI round-trips, VM execution, trampolines).
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import OUT_DIR, REPO_ROOT  # noqa: E402
from build_selftest import find_emcc  # noqa: E402

INPUT_DIR = REPO_ROOT / "tools"      # private input root (gitignored), like the game binary
SRC_DIR = INPUT_DIR / "lua-5.3.3"
TARBALL = INPUT_DIR / "lua-5.3.3.tar.gz"
BUILD = OUT_DIR / "lua"
# Round 25: the JSPI web profile links with -sSUPPORT_LONGJMP=wasm (Wasm-EH
# setjmp/longjmp: no invoke_* JS trampolines on the stack, which a JSPI
# suspension cannot cross), and an archive compiled the emscripten way cannot
# be mixed into that link. lua_pcall is a setjmp, so Lua gets its own build.
BUILD_WASM_SJLJ = OUT_DIR / "lua-wasmsjlj"


def build_dir(sjlj):
    return BUILD_WASM_SJLJ if sjlj == "wasm" else BUILD


def sjlj_cflags(sjlj):
    return ["-sSUPPORT_LONGJMP=wasm"] if sjlj == "wasm" else []

# The core + libraries, minus lua.c and luac.c which are the standalone
# interpreter and compiler front ends.
CORE = """lapi lcode lctype ldebug ldo ldump lfunc lgc llex lmem lobject lopcodes
lparser lstate lstring ltable ltm lundump lvm lzio lauxlib lbaselib lbitlib
lcorolib ldblib liolib lmathlib loslib lstrlib ltablib lutf8lib loadlib
linit""".split()

# Defines, each with the reason it is here rather than the default.
DEFINES = [
    ("LUA_USE_POSIX", "the DLL was built with LUA_USE_C89 semantics; POSIX is "
                      "the closest emscripten equivalent for os/io"),
    ("LUA_USE_LONGJMP", "build as C, not C++: error handling must be longjmp, "
                        "not exceptions"),
]
FORBIDDEN = [
    ("LUA_COMPAT_5_2", "upstream's Makefile ships this ON; the DLL was built "
                       "without it and it changes the exported surface"),
    ("LUA_32BITS", "would make lua_Integer int and lua_Number float; "
                   "LUAL_NUMSIZES=136 proves both are 8 bytes"),
    ("LUA_C89_NUMBERS", "distinct from LUA_USE_C89; would change the numeric "
                        "types"),
]

CFLAGS = ["-O2", "-std=gnu99", "-fno-strict-aliasing",
          "-Wall", "-Wextra", "-Wno-unused-parameter",
          "-Wno-string-plus-int", "-Wno-empty-body"]


def expected_abi():
    """The measurements the built library has to reproduce."""
    return {
        "LUAL_NUMSIZES": 136,
        "sizeof(lua_Number)": 8,
        "sizeof(lua_Integer)": 8,
        "sizeof(TValue)": 16,
        "sizeof(LG)": 824,
        "sizeof(lua_Debug)": 100,
        "LUAI_MAXSTACK": 1000000,
        "LUA_IDSIZE": 60,
        "LUA_EXTRASPACE": 4,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true",
                    help="compile (requires the source to be present already)")
    ap.add_argument("--sjlj", choices=("emscripten", "wasm"), default="emscripten",
                    help="setjmp/longjmp implementation: 'emscripten' (default, output in lua/) "
                         "or 'wasm' (Wasm EH, no invoke_* JS frames; what the JSPI web profile "
                         "links, output in lua-wasmsjlj/)")
    args = ap.parse_args()

    emcc = find_emcc()
    print("emcc              : %s" % (emcc or "NOT FOUND"))
    print("source directory  : %s  %s" % (
        SRC_DIR, "present" if SRC_DIR.exists() else "ABSENT"))
    print("tarball           : %s  %s" % (
        TARBALL, "present" if TARBALL.exists() else "ABSENT"))
    print()
    print("defines that MUST be set:")
    for d, why in DEFINES:
        print("   -D%-18s %s" % (d, why))
    print("defines that MUST NOT be set:")
    for d, why in FORBIDDEN:
        print("   %-19s %s" % (d, why))
    print()
    print("ABI the build has to reproduce (measured from the shipped DLL):")
    for k, v in expected_abi().items():
        print("   %-22s %s" % (k, v))
    print()
    print("The static assertions in src/host_lua.c enforce these at compile "
          "time, so a mismatched build fails to compile rather than corrupting "
          "values at runtime.")
    print()

    if not SRC_DIR.exists() and TARBALL.exists():
        print("extracting %s ..." % TARBALL.name)
        with tarfile.open(TARBALL) as tf:
            tf.extractall(THIRD_PARTY)

    if not args.build:
        print("Dry run. Place the source and re-run with --build.")
        print("  source: https://www.lua.org/ftp/lua-5.3.3.tar.gz (~303 KB)")
        print("  NOTE: this script does not download it. Fetching is an action "
              "that needs the operator's explicit go-ahead.")
        return 0

    if not SRC_DIR.exists():
        print("cannot build: %s is absent" % SRC_DIR)
        return 2
    if not emcc:
        print("cannot build: emcc not found")
        return 2

    csrc = SRC_DIR / "src"
    build = build_dir(args.sjlj)
    build.mkdir(parents=True, exist_ok=True)
    objs, errors = [], 0
    for name in CORE:
        f = csrc / (name + ".c")
        if not f.exists():
            print("missing source: %s" % f)
            errors += 1
            continue
        obj = build / (name + ".o")
        cmd = [emcc, "-c"] + CFLAGS + sjlj_cflags(args.sjlj)
        for d, _ in DEFINES:
            cmd += ["-D" + d]
        cmd += [str(f), "-o", str(obj)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        msg = (r.stderr or "") + (r.stdout or "")
        if r.returncode != 0:
            errors += 1
            print("%s: FAILED" % name)
            for line in msg.splitlines():
                if "error:" in line:
                    print("   ", line)
        else:
            objs.append(str(obj))
    if errors:
        print("\n%d source files failed" % errors)
        return 1

    lib = build / "liblua.a"
    ar = str(Path(emcc).with_name("emar.exe"))
    if not Path(ar).exists():
        ar = str(Path(emcc).with_name("emar"))
    r = subprocess.run([ar, "rcs", str(lib)] + objs, capture_output=True, text=True)
    if r.returncode != 0:
        print("archive failed:", (r.stderr or "")[:400])
        return 1
    print("built %s (%d objects, %d bytes)" % (lib, len(objs), lib.stat().st_size))
    print()
    print("Now rebuild the host layer; host_lua.c picks up lua.h automatically:")
    print("   EMCC_CFLAGS='-I%s' python scripts/recomp/host/build_selftest.py"
          % csrc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
