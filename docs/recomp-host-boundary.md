# Host boundary census — irreducible human work

Target: `tools/isaac-ng.unpacked.exe`, 9,176,064 bytes, PE32, image base `0x400000`,
entry `0x00aefc46`. Static analysis only; the binary was never executed.

Reproduce every number with one command:

```
python scripts/recomp/census/run_all.py       # ~36 s, writes output/recomp/census/*.json
```

Confidence labels used below: **[M]** measured from bytes in the file,
**[D]** derived from measured data by a stated rule, **[J]** engineering
judgment applied to measured data.

---

## 0. Three premises in the brief that the binary contradicts

These change the shape of the work, so they lead.

1. **The CRT is not statically linked.** This is a `/MD` build. The C runtime is
   *imported* from `vcruntime140.dll`, `msvcp140.dll` and 11 `api-ms-win-crt-*`
   UCRT apisets — **191 symbols, 7,419 call sites**. There is no libc hiding inside
   `.text` to lift; the CRT is squarely on the host-shim side of the boundary. **[M]**
2. **Lua is not vendored either.** It is a DLL: `lua5.3.3r.dll`, 67 imported
   symbols, **14,011 call sites — 62.2% of all IAT traffic in the binary**. Zero
   bytes of Lua to lift. **[M]**
3. **The renderer is OpenGL via a statically-linked libepoxy**, not D3D. There
   are no `d3d*`/`dxgi` imports at all, and exactly one `opengl32.dll` import
   (`wglGetProcAddress`, called once, from inside GLFW). **[M]**

Also: **no delay-load import directory, no bound imports, no ordinal-only
imports.** All 622 imports are plain name imports. **[M]**

---

## 1. Import census

622 symbols across 28 DLLs, **22,513 effective call sites**. **[M]**

Method: the import directory is walked directly (`scripts/recomp/census/imports.py`),
then `.text` is scanned for every x86 form that can reference an absolute IAT
slot (`FF 15`, `FF 25`, `FF 35`, `8B /r`, `A1`). MSVC routes most calls through
an ILT thunk (`jmp dword ptr [__imp_X]`), so 133 thunks were resolved and calls
targeting them credited to the underlying import. "Call sites" therefore means
*direct indirect calls + calls/jumps reaching the symbol through its thunk*.

Two independent checks gate these numbers:

- **capstone linear sweep** decoded 7,430,187 / 7,430,656 `.text` bytes
  (**99.9937%**, 2,094,319 instructions) and agreed with the byte scan on
  **622 / 622** slots — zero disagreements. **[M]**
- **pefile cross-check** (`verify_with_pefile.py`): 622/622 symbols, same DLL,
  same name, same IAT slot VA. 0 mismatches. **CROSS-CHECK: PASS**. **[M]**

False-positive risk is negligible by construction: a hit requires a 4-byte
immediate to exactly equal one of 622 known slot VAs, so the expected number of
coincidental matches across 7.43 MB is 7.43e6 × 622 / 2³² ≈ **0.001**.

### By DLL, sorted by call sites **[M]**

| DLL | symbols | used | call sites |
|---|---:|---:|---:|
| lua5.3.3r.dll | 67 | 59 | **14,011** |
| vcruntime140.dll | 20 | 17 | 3,837 |
| api-ms-win-crt-runtime | 27 | 27 | 1,599 |
| api-ms-win-crt-math | 22 | 22 | 612 |
| api-ms-win-crt-heap | 5 | 5 | 458 |
| api-ms-win-crt-convert | 7 | 6 | 423 |
| kernel32.dll | 94 | 89 | 327 |
| user32.dll | 104 | 95 | 262 |
| EOSSDK-Win32-Shipping.dll | 82 | 78 | 215 |
| msvcp140.dll | 54 | 46 | 169 |
| api-ms-win-crt-string | 17 | 15 | 150 |
| steam_api.dll | 10 | 10 | 128 |
| api-ms-win-crt-stdio | 25 | 25 | 122 |
| OpenAL32.dll | 28 | 26 | 95 |
| api-ms-win-crt-time | 5 | 5 | 21 |
| gdi32.dll | 13 | 12 | 20 |
| api-ms-win-crt-utility | 3 | 3 | 15 |
| libcurl.dll | 11 | 10 | 12 |
| api-ms-win-crt-filesystem | 4 | 4 | 11 |
| shell32.dll | 6 | 6 | 9 |
| dbghelp.dll | 5 | 5 | 5 |
| advapi32.dll | 3 | 3 | 4 |
| winmm.dll | 3 | 3 | 3 |
| api-ms-win-crt-environment / -locale / bcrypt / ole32 / **opengl32** | 6 | 4 | 4 |

**46 imported symbols are never called** — dead weight no shim needs. **[M]**

Top single symbols: `lua_absindex` 2,350 · `lua_pushstring` 2,336 ·
`__CxxFrameHandler3` 1,833 · `lua_rotate` 1,552 · `_invalid_parameter_noinfo_noreturn`
1,458 · `lua_newuserdata` 1,202 · `lua_pushcclosure` 1,064 · `lua_type` 1,004 ·
`lua_touserdata` 833 · `__RTDynamicCast` 822. Full sorted list in
`output/recomp/census/imports.json`.

### The hidden import surface **[M]**

52 DLL-name strings appear in the image beyond the 28 in the import directory —
all reached through `LoadLibrary`/`GetProcAddress` (44 call sites across 8
loader symbols). They are: `DINPUT8`, `XInput1_1`–`1_4`, `xinput9_1_0`,
`dwmapi`, `shcore`, `ntdll`, `kernelbase`, `OSMesa`, `libEGL`, `libGLESv2`,
`GLESv1_CM`. Every one is a GLFW backend probe. The DPI/ntdll symbol strings
(`SetProcessDpiAwarenessContext`, `GetDpiForMonitor`, `RtlVerifyVersionInfo`, …)
are likewise GLFW-internal.

---

## 2. Who actually calls each import

This is the cross-cut that changes the estimate. Every call site was mapped to
its containing function, and each function to its component (§4), so the
question becomes *"is this Win32 call the game's, or the vendored library's?"*

| subsystem | syms | used | call sites | game | GLFW | other |
|---|---:|---:|---:|---:|---:|---:|
| lua-vm | 67 | 59 | 14,011 | 14,011 | 0 | 0 |
| cxx-runtime (vcruntime+msvcp) | 74 | 63 | 4,006 | 3,769 | 118 | 119 |
| crt-runtime | 27 | 27 | 1,599 | 1,351 | 194 | 54 |
| crt-math | 22 | 22 | 612 | 579 | 13 | 20 |
| crt-string/convert | 27 | 24 | 588 | 562 | 24 | 2 |
| crt-heap | 5 | 5 | 458 | 367 | 8 | 83 |
| win-window/input (user32) | 104 | 95 | 262 | 131 | 125 | 6 |
| epic-eos | 82 | 78 | 215 | 207 | 0 | 8 |
| k32-threads/sync | 24 | 23 | 134 | 102 | 26 | 6 |
| crt-stdio/fs | 29 | 29 | 133 | 90 | 4 | 39 |
| steam | 10 | 10 | 128 | 128 | 0 | 0 |
| audio-openal | 28 | 26 | 95 | 47 | 0 | 48 |
| k32-module/loader | 8 | 8 | 44 | 23 | 15 | 6 |
| k32-file-io | 18 | 16 | 43 | 31 | 9 | 3 |
| k32-error/debug | 10 | 10 | 36 | 29 | 6 | 1 |
| crt-misc | 7 | 7 | 23 | 20 | 3 | 0 |
| k32-other | 15 | 14 | 20 | 12 | 8 | 0 |
| gdi | 13 | 12 | 20 | 6 | 14 | 0 |
| win-shell/com | 18 | 16 | 20 | 13 | 7 | 0 |
| k32-memory/heap | 8 | 8 | 17 | 9 | 8 | 0 |
| k32-time | 4 | 4 | 15 | 13 | 2 | 0 |
| net-curl | 11 | 10 | 12 | 12 | 0 | 0 |
| k32-locale/encoding | 2 | 2 | 10 | 0 | 10 | 0 |
| k32-env/process | 5 | 4 | 8 | 8 | 0 | 0 |
| win-timing (winmm) | 3 | 3 | 3 | 3 | 0 | 0 |
| **gl (opengl32)** | **1** | **1** | **1** | 0 | 1 | 0 |
| **total** | **622** | **576** | **22,513** | **21,523** | **595** | **395** |

Column sums reconcile exactly with the per-symbol totals: every row's
game + GLFW + other equals its call-site count, and the totals sum to
22,513. **[M]**

The load-bearing consequence: **the entire Win32 windowing, input, GDI and
timing surface is 285 call sites, and GLFW owns 139 of them.** There is no
sprawling Win32 dependency to reimplement.

---

## 3. Subsystem verdicts

Buckets: **provided** = emscripten/musl/libc++/WebGL already implements the
semantics · **shim** = real hand-written host code · **stub** = no-op or
constant return without changing observable gameplay · **vanishes** = every
call site is inside a vendored library that gets replaced (§4), so lifted code
never calls it. Bucket assignment is **[J]**; the symbol and call-site counts
are **[M]**.

| verdict | symbols | call sites |
|---|---:|---:|
| vanishes with upstream libs | 74 | 137 |
| never called | 46 | 0 |
| provided | 247 | 16,174 |
| stub | 130 | 423 |
| **shim (real hand-written work)** | **125** | **5,779** |
| total | **622** | **22,513** |

### Provided (247 symbols / 16,174 sites)

- **lua-vm** 59 syms / 14,011 sites — link an upstream Lua 5.3.3 wasm build.
- **crt-math / string / convert / heap / stdio / misc** 86 syms / 1,813 sites — musl.
  `_libm_sse2_pow_precise` and friends are name aliases onto standard libm.
- **win-window/input** 57 syms / 199 sites — emscripten's GLFW3 port plus canvas.
- **audio-openal** 26 syms / 95 sites — emscripten OpenAL over WebAudio.
- **k32-file-io** 15 syms / 41 sites, **k32-time** 4 / 15 — emscripten FS, `performance.now`.

### Stub (130 symbols / 423 sites)

- **epic-eos** 78 syms / 215 sites and **steam** 10 / 128 — offline stubs.
  Neither is required to reach gameplay.
- **k32-error/debug** 9 / 35, **win-shell/com** 12 / 14, **net-curl** 10 / 12,
  **k32-env/process** 4 / 8, **gdi** 4 / 8, **win-timing** 3 / 3.

### Shim — the irreducible core (125 symbols / 5,779 sites)

| bucket | syms | sites | what actually has to be written |
|---|---:|---:|---|
| cxx-runtime | 59 | 4,002 | MSVC C++ ABI: `__CxxFrameHandler3` (1,833), `__RTDynamicCast` (822), `_CxxThrowException` (72), plus 46 `msvcp140` `std::` exports |
| crt-runtime | 26 | 1,598 | `_invalid_parameter_noinfo_noreturn` (1,458 — one function), `_wassert` (92), `_initterm`, `__acrt_iob_func` |
| k32-threads/sync | 19 | 112 | see below |
| k32-module/loader | 7 | 43 | a name→function table for the dynamically probed DLLs |
| k32-other | 10 | 15 | residual kernel32 |
| k32-memory/heap | 4 | 9 | `VirtualAlloc`/`VirtualFree`/`VirtualQuery` over a wasm arena |

### Genuinely hard in a browser — and much smaller than feared

**Threads.** 24 symbols, 134 call sites, and **exactly one `CreateThread` call
site**, which belongs to theoraplayer (the video-cutscene worker), not the game
loop. The rest is critical sections (`DeleteCriticalSection` 37,
`LeaveCriticalSection` 19, `EnterCriticalSection` 11, `InitializeCriticalSection` 11)
which become no-ops in a single-threaded build; `TlsGetValue`/`TlsSetValue`
(20 sites) are **entirely GLFW's**; `WaitForSingleObject` has 4 sites. There is
one `TerminateThread`, one `SetThreadPriority`, one `CreateEventW`/`SetEvent`/
`ResetEvent` each. **[M]** This is not a threaded engine, and the single
non-trivial thread is skippable video playback.

**Blocking I/O / filesystem.** 18 kernel32 file symbols / 43 sites (9 of them
GLFW's) plus 29 CRT stdio/filesystem symbols / 133 sites. Small. The real
decision is save-data persistence (IDBFS vs. in-memory), not API coverage. **[M]**

**MSVC C++ exceptions — the hardest item.** `__CxxFrameHandler3` is reached from
1,833 call sites and the binary uses `fs:[0]`-based SEH frames. Lifted code has
to unwind somehow, and this is the one shim whose difficulty is structural
rather than a matter of surface area. **[J]**

**Steam / EOS.** 92 symbols, 343 sites, all stubbable offline. Not hard, just
tedious. **[M]/[J]**

---

## 4. Statically-linked third-party code inside `.text`

Vendoring was identified from embedded `__FILE__` paths — MSVC bakes them into
`assert`/`_wassert`, and this build leaks its source tree:

```
C:\nicalis\builderbob\projects\KAGE\Source\Platforms\PC\Shared\Source\External\gl\GLFW_3.4\src\{input,window,context,monitor,wgl_context,egl_context,win32_thread}.c
C:\nicalis\builderbob\projects\KAGE\Source\Core\External\{miniz.cpp,ogg.cpp,clownresampler.h}
F:\NicalisSVN\KAGE\trunk\Build\External\LibTheora\theoraplayer\src\{VideoClip.cpp,formats\Theora\VideoClip_Theora.cpp}
```

(The engine is Nicalis "KAGE".) Byte attribution then works in three tiers:
**exact** for libepoxy (its 3,221 resolver-stub addresses are recoverable
precisely), **anchored** for functions referencing a string only that library
could own, and **closure** for functions all of whose callers are already in the
component. A purity constraint blocks a component from absorbing functions that
call APIs it would never use (GLFW never calls Lua) — this caught 2 mis-seeded
anchors that were dragging 431 functions with them, and cut the GLFW figure from
658,704 to 286,433 bytes.

Baseline: `.text` raw = 7,430,656 bytes, **29,392 functions**, 7,301,718 bytes of
function bodies (98.265%), 128,714 bytes of padding. **[M]**

| component | functions | bytes | % .text | anchored floor |
|---|---:|---:|---:|---:|
| GLFW 3.4 | 409 | 286,433 | 3.85% | 53,427 |
| **libepoxy** | 3,221 | **108,106** | 1.45% | 108,106 *(exact)* |
| libpng | 79 | 44,331 | 0.60% | 21,041 |
| ogg | 43 | 30,654 | 0.41% | 18,379 |
| miniz | 19 | 20,251 | 0.27% | 16,190 |
| theoraplayer | 34 | 15,272 | 0.21% | 6,644 |
| libjpeg | 21 | 12,976 | 0.17% | 2,123 |
| clownresampler | 4 | 1,384 | 0.02% | 1,305 |
| stb_vorbis | 2 | 538 | 0.01% | 538 |
| **replaceable total** | **3,832** | **519,945** | **7.00%** | **227,753 (3.07%)** |
| OpenAL/Steam client glue | 23 | 8,739 | 0.12% | — |
| unattributed (game + STL + CRT startup) | 25,537 | 6,773,034 | 91.15% | — |

**Searched for and found absent** (zero string evidence): Box2D, Bullet, SDL,
boost, FreeType, TinyXML/pugixml/RapidXML, JsonCpp/RapidJSON, OpenSSL,
protobuf, GLEW, Dear ImGui, PhysicsFS, ffmpeg/Bink. Physics and font rendering
are the engine's own code. **[M]**

**Correcting the brief's hypothesis.** The premise was that Lua plus media
libraries might be ~2 MB of the 7.2 MB `.text`, and that lifting them could be
skipped. The reality is better in one way and worse in another: **Lua is not in
`.text` at all** (it's a DLL — so the win is total, not partial), but the
vendored media/platform libraries only amount to **519,945 bytes, 7.00%** of
`.text`. Replacing all of them removes ~0.5 MB from the lift, not 2 MB. The
remaining 91.15% is genuinely the engine's own code and must be lifted.

The unattributed 6.77 MB is **not** all hand-written gameplay logic: this is a
C++ codebase, so an unmeasured but substantial share is inlined STL template
instantiations (`std::string`, `std::vector`, `std::map`) welded into game
functions. Those cannot be separated from the surrounding code and are not
independently replaceable — they get lifted along with everything else.
**Marking the STL-vs-gameplay split as UNVERIFIED**; separating it would need
the symbol recovery the Ghidra pass is producing.

### libepoxy — measured exactly, and the cleanest deletion in the project

The image exports **3,226 symbols from an `.exe`**, every one named `epoxy_*`.
3,221 of them are not code at all: they are *function pointers in `.data`*
(12,884 bytes of slots spread across a 147,692-byte span, `0x80f824`–`0x83390c`),
each initially pointing at its resolver stub in `.text`. Only 5 exports are code.
Reading those 3,221 initial values recovers the stub addresses exactly — they
occupy **108,106 bytes of `.text` function bodies**, laid out in 177 contiguous
runs, with stub sizes clustering at 32 and 48 bytes.

**Of 3,226 available GL entry points, the game calls 70, across 331 call
sites.** **[M]**

| family | exported | called | call sites |
|---|---:|---:|---:|
| gl* | 3,083 | 66 | 160 |
| wgl* | 139 | 2 | 66 |
| epoxy internal | 4 | 2 | 105 |

The 66 real GL calls are an unremarkable GL 2/3 core set —
`glBindFramebuffer`, `glDeleteTextures`, `glBindTexture`, `glTexImage2D`,
`glDrawElements`, `glUseProgram`, `glUniform*`, `glGetString`, `glViewport`,
`glEnable/glDisable`, shader compile/link. All of it maps onto WebGL 2 directly.

---

## 5. The `.data` / `.rdata` problem

| section | RVA | virtual | raw | BSS-like tail | fixups living here | fixups pointing here |
|---|---|---:|---:|---:|---:|---:|
| `.text` | 0x1000 | 7,430,452 | 7,430,656 | 0 | 159,426 | 30,507 |
| `.rdata` | 0x718000 | 915,784 | 915,968 | 0 | 17,363 | 97,074 |
| `.data` | 0x7f8000 | 674,468 | 433,664 | **240,804** | 4,150 | 53,350 |
| `.rsrc` | 0x89d000 | 15,136 | 15,360 | 0 | 0 | 0 |
| `.reloc` | 0x8a1000 | 379,196 | 379,392 | 0 | 0 | 0 |

**Relocations: 181,854 entries in 1,936 blocks — 180,939 `HIGHLOW`, 915
padding, 0 unresolvable.** **[M]**

`.data` raw is 433,664 bytes of which 255,792 are non-zero, plus a 240,804-byte
zero-fill tail beyond raw (the header's `SizeOfUninitializedData` field reads 0
and is misleading — the real BSS is this `virtual > raw` gap). `.rdata` has no
tail and is 709,070 / 915,968 non-zero.

**Reloc-confirmed** code pointers in data: **11,420 in `.rdata` + 3,246 in
`.data` = 14,666** (vtables, RTTI, dispatch tables), plus 6,847 reloc-confirmed
non-code intra-image pointers. A naive dword scan reports 24,473 in `.rdata`;
the 13,053-entry difference is **RVA tables misread as VAs** — chiefly the
3,226-entry export address table, whose RVAs fall inside the `.text` VA range.
Requiring a relocation at the site is what makes the count exact. This is the
same trap as the `.rdata` file-offset skew, one level up. **[M]**

The largest contiguous function-pointer run in the image is libepoxy's dispatch
table: 3,081 GL entries at `0x00c0f910` plus 139 WGL entries at `0x00c13410`.
`.data` contains essentially nothing else — 16 runs total, of which those two
are 3,220 of 3,246 pointers.

### Is snapshotting the initialized sections sufficient? No — three gaps

1. **The IAT is inside `.rdata`.** 650 slots at RVA `0x718000`. On disk they hold
   name-table RVAs, not function addresses. Every slot must be filled with a
   host pointer before any lifted code runs. **[M]**
2. **Static initializers must actually execute.** Following the entry point into
   `__scrt_common_main_seh` (`0x00aefac4`) recovers both `_initterm` bounds
   pairs: a C table at `0xb18c10..0xb18c24` (5 slots, 4 non-null) and a **C++
   table at `0xb18a2c..0xb18c04` — 118 slots, 117 non-null**, every target
   inside `.text`. The on-disk bytes are the *pre-main* state; those 117 global
   constructors must run to build the real initial state. `main` is at
   `0x00931050`. **[M]**
3. **One TLS callback** at `0x00aefec1` must run, and 180,939 `HIGHLOW` fixups
   must be applied (or the image loaded at its preferred base and left alone —
   `DllCharacteristics` is `0x8140`, so ASLR is requested but the fixups are all
   present). **[M]**

**Verdict:** a raw snapshot of `.text`/`.rdata`/`.data` plus the 240,804-byte
zero tail is a *correct starting image*, but booting lifted code additionally
requires (a) populating 650 IAT slots, (b) running 1 TLS callback, (c) running
4 C and 117 C++ initializers, in that order, before `main`. That is a bounded,
enumerable list — not an open-ended problem. **[D]**

---

## 6. Arithmetic conclusion

**Imports**

| quantity | value |
|---|---:|
| imported symbols | **622** (28 DLLs, 0 delay-load, 0 ordinal-only) |
| total IAT call sites | **22,513** |
| never called | 46 |
| vanish when vendored libs are replaced | 74 (137 sites) |
| already provided by emscripten/musl/WebGL | 247 (16,174 sites) |
| stubbable | 130 (423 sites) |
| **need real hand-written shims** | **125 (5,779 sites)** |

Load-bearing by frequency: **10 symbols carry 14,454 of 22,513 call sites
(64.2%)**, and 7 of those 10 are Lua. The other three are
`__CxxFrameHandler3` (1,833), `_invalid_parameter_noinfo_noreturn` (1,458) and
`__RTDynamicCast` (822).

**Estimated shim size** — **[J]**, scaled off the measured symbol counts above:

| bucket | symbols | est. lines |
|---|---:|---:|
| MSVC C++ EH/RTTI (`__CxxFrameHandler3`, `__RTDynamicCast`, `_CxxThrowException`) | 3 | 600–1,200 |
| `msvcp140` `std::` forwarding onto libc++ | 46 | ~200 |
| CRT runtime entry points | 26 | ~150 |
| kernel32 threads/sync/loader/memory/other | 40 | ~500 |
| stubs (EOS, Steam, curl, shell/COM, gdi, winmm, env, debug) | 130 | ~450 |
| provided-but-needs-aliasing glue | 247 | ~150 |
| GL: 70 entry points onto WebGL 2 (if not using emscripten GL) | 70 | ~350 |
| boot sequence: IAT fill, TLS callback, 121 initializers | — | ~200 |
| **total** | | **≈ 2,600–3,200 lines** |

That is the irreducible hand-written host layer. It is small because the
measurement kept collapsing surfaces that looked large: 3,226 GL entry points
became 70; 104 user32 imports became 118 game-owned call sites; 24 threading
symbols became one real thread.

**`.text` disposition (7,430,656 bytes raw)** **[M]** except where noted:

| category | bytes | % |
|---|---:|---:|
| (a) liftable engine/game logic — includes inlined STL, split UNVERIFIED | 6,773,034 | 91.15% |
| (b) replaceable third-party (GLFW, libepoxy, libpng, libjpeg, miniz, ogg, stb_vorbis, theoraplayer, clownresampler) | 519,945 | 7.00% |
| (c) vendor client glue (OpenAL/Steam wrappers — engine code, not replaceable) | 8,739 | 0.12% |
| padding | 128,714 | 1.73% |
| (d) library/CRT already provided by emscripten | **0 in `.text`** | — |

Category (d) is zero *inside `.text`* precisely because this is a `/MD` build:
the CRT lives behind 191 imports instead of in the binary. That is the good
news — 7,419 CRT call sites resolve to musl/libc++ rather than to 500 KB of
lifted-and-verified libc.

### The biggest single lever

**Lua.** It is 62.2% of all import traffic — 14,011 of 22,513 call sites, 6× the
next-largest subsystem — and it is a DLL, so there is nothing to lift and
nothing to verify. Dropping in an upstream Lua 5.3.3 built to wasm satisfies the
single largest dependency in the binary for approximately zero hand-written
lines. No other decision in this project retires that much surface that cheaply.

The runner-up is **libepoxy**: 3,221 GL dispatch stubs, 108,106 bytes of `.text`
measured exactly, of which the game exercises 70 entry points. Replacing the
whole dispatch layer with a 70-entry WebGL binding deletes 1.45% of `.text` and
converts the entire graphics boundary into a day's work.

Both levers point the same way: **the expensive-looking parts of this binary are
the parts you do not have to lift.** What is left — 6.77 MB of KAGE engine code
and ~3,000 lines of host shim — is the real work.
