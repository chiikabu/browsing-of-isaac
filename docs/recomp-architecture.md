# Static recompilation architecture for `isaac-ng.unpacked.exe` → WebAssembly

**Status:** prototype measured, recommendation made.
**Date:** 2026-08-09.
**Scope:** the LIFTER stage — how x86-32 machine code becomes compilable code.
Does not cover the Ghidra inventory, the Unicorn oracle, or the import/host
census; those are separate workstreams and this design consumes their output.

**Provenance.** Every number in §1–§6 traces to a command in
`scripts/recomp/lift/` run against `tools/isaac-ng.unpacked.exe` on this
machine (emcc 6.0.5, Node 24.15 / V8, 16 cores). §7 and the engine-limit
constants come from a companion literature/source survey run the same day;
those are attributed inline and were **not** re-measured here. Anything I
could not verify is marked **UNVERIFIED**.

> One provenance caveat: the `/EHsc`-vs-`/EHa` and Lua-VM findings quoted in
> §5.3 and §9 were measured by the companion survey against the *Steam
> original* `isaac-ng.exe` (9,362,440 B), not this unpacked copy
> (9,176,064 B). The `.text` virtual size is identical (`0x716134`), so the
> code findings should carry over, but they are second-hand here.

---

## 0. Executive summary

**Static recompilation of this binary to wasm is viable, and the prototype
proves it end to end.** An 851-line mechanical p-code→C emitter (1,412
lines including the PE reader, driver, and hand-written runtime) lifted
7,963 functions (4.80 MB of `.text`, 1.31 M x86 instructions) with a 99.7%
success rate, produced 290 MB of C, and emcc compiled and linked all of it
into a **24.3 MB wasm module in ~4 minutes wall-clock** that V8 compiles in
**49 ms**. Three lifted functions were verified byte-identical against the
existing hand-written translations over 20,000 randomized inputs each.

The two things everyone worries about turned out to be non-problems *given
the right emitter design*, and catastrophic *given the wrong one*:

- **EFLAGS cost is zero if flags are function-local C scalars.** The wasm
  for the lifted `basic_string` destructor contains no flag computation at
  all — clang deleted all six flags per instruction and fused `cmp`/`jb`
  into a single `i32.ge_u`. Route the same state through a `CpuState*`
  instead (the remill/rev.ng shape) and the module gets **1.94× bigger and
  ~3× slower**.
- **Compile time and module size are fine.** 4-minute builds, 24 MB
  modules, 49 ms browser compile. Not 400 MB, not 30 hours.

**Round 2 (§11) drove the lifter from the real Ghidra inventory and the
host-boundary census and produced the number that matters: 96.18% of
`.text` — 21,375 functions, 2.01 M instructions — lifted at a 99.66%
success rate into 440 MB of C, compiled and linked to a 37.95 MB wasm
module in 7.2 minutes, which V8 compiles in **227 ms** and instantiates
in 429 ms. The round-1 extrapolation of "≈ 37.6 MB at 5.06 wasm bytes per
x86 byte" held exactly: the real module is 5.02.

Round 2 also dissolved what round 1 called the top risk. The inventory
reports 3,127 unresolved computed jumps in 3,107 functions; instruction-level
classification shows **2,874 of them are `jmp reg` indirect tail calls**
(99.7% are the last instruction of the body), **764 are switch tables the
emitter now recovers into `br_table`**, and only **44 functions** need an
intra-function dispatch structure — which costs +18% on an affected
function and **0.036% of the module**. The entire hand-written CPU surface
is **32 intrinsics**; the entire host surface is **587 import shims**, of
which the census says only 125 symbols need real behaviour.

**Recommendation: hybrid.** Bulk-lift everything for coverage; keep the
hand-written translations where they exist and let the lifter call into
them by address. See §8.

---

## 1. What was built

```
scripts/recomp/lift/
  pe.py           PE32 reader (read-only; never executes the image)
  scan.py         function-start discovery from direct call targets
  lift.py         SLEIGH p-code -> C emitter          <- the core
  emit.py         driver: lift a VA set, write C + CpuState header
  build_wasm.py   parallel emcc build with time/memory instrumentation
  recomp_rt.h/.c  hand-written runtime (memory, p-code helpers, boundary)
  harness.c       differential test vs native/decomp
  bench.c         runtime cost: lifted vs hand-written, same module
```

Pipeline: `PE32 → pypcode/SLEIGH raw p-code → C → emcc → wasm → node`.

**Why p-code and not remill/rev.ng/RetDec.** SLEIGH is the only lifting
front end in this space that is (a) alive, (b) Apache-2.0-clean, (c) has
first-class x86-32 semantics including x87/SSE/segments, and (d) is already
in the pipeline. `pypcode` 3.3.3 (vendoring SLEIGH from Ghidra 12.x)
installed from PyPI and worked first try. Full landscape survey in §7.

**Emitter design** (`lift.py`), three decisions that turned out to matter:

1. **Root-register mapping.** SLEIGH's register space is byte-addressed
   (142 root registers, max offset `0x2236`). Each varnode is resolved to
   the maximal named register covering it, so `AL`/`AH`/`AX`/`EAX` all
   alias one C variable correctly and for free.
2. **Per-function register cache.** Each lifted function declares plain C
   locals for the roots it touches, loads them from the shared `CpuState`
   at entry, and spills/reloads only around calls and at return. Their
   addresses never escape, so SROA/mem2reg promote them to SSA and dead
   flags get DCE'd. **This is the single most important decision in the
   whole design** — see §3.
3. **Identity memory addressing.** Guest VA == wasm linear-memory offset.
   `MEMR32(a)` is `memcpy` from `(void*)(uintptr_t)a`, which clang lowers
   to a bare `i32.load offset=…`. This matches what the existing
   `native/decomp` helpers already assume
   (`reinterpret_cast<uint8_t*>(addr)`), so lifted and hand-written code
   share one address space with zero translation.

Flags are kept function-local and **not** propagated across calls by
default (`--spill-flags` restores the conservative behaviour). This is an
assumption, not a theorem: no MSVC-generated function passes EFLAGS through
a `call`. It is measurably worth 1.4× runtime (§3).

---

## 2. Correctness: the vertical slice

Three functions lifted mechanically — no per-function hand-authored logic —
compiled into the same wasm module as the existing hand-written
translations, and differentially tested in Node.

| VA | what | bytes | reference | result |
|---|---|---|---|---|
| `0x00423480` | MSVC `traits::compare` | 116 | semantics documented in `exit_pure_helpers.cpp` | **PASS** 0/20000 |
| `0x0040d040` | `basic_string` tidy/deallocate | 76 | `isaac_frame_opaque_40d040_tidy_plan` + `_apply_reset` | **PASS** 0/20000 |
| `0x00685bc0` | `std::map<string,…>::lower_bound` | 128 | `isaac_exit_map_lower_bound` | **PASS** 0/5001 |

Reproduce:

```
python scripts/recomp/lift/emit.py --exe tools/isaac-ng.unpacked.exe \
  --va 0x0040d040 --va 0x00685bc0 --va 0x00423480 \
  --out output/recomp/lift/slice --module lifted
emcc -O2 -o output/recomp/lift/slice/test.cjs \
  -I scripts/recomp/lift -I output/recomp/lift/slice -I native/decomp \
  output/recomp/lift/slice/lifted.c scripts/recomp/lift/recomp_rt.c \
  scripts/recomp/lift/harness.c native/decomp/exit_pure_helpers.cpp \
  native/decomp/frame_opaque_pure_helpers.cpp -sINITIAL_MEMORY=64MB -sEXIT_RUNTIME=1
node output/recomp/lift/slice/test.cjs 20000
```

`lower_bound` is the interesting one: the lifted `sub_00685bc0` calls the
lifted `sub_00423480` through the emulated guest stack, walking a synthetic
MSVC red-black tree built in shared linear memory, and produces a
bit-identical out-triple and return value against the hand-written C++.

**Two side findings worth recording.**

- **Calling-convention recovery is a non-problem for the lifter, and a real
  problem for humans.** `0x00423480` is `ecx = s1, edx = len1, [esp+4] = s2,
  [esp+8] = len2` — a compiler-invented convention with no name. The lifter
  reproduced it automatically because the convention is *encoded in the
  instructions it is already lifting*. My hand-written test harness got it
  wrong on the first attempt and produced 2023/4000 mismatches until I read
  the call site. This is a direct argument for the uniform
  `void f(CpuState*)` signature: it makes convention recovery unnecessary
  for correctness.
- **A real emitter bug the differential test caught.** SLEIGH materialises
  constant-address memory operands as bare `ram`-space varnodes (`u = ram[b18894:4]`),
  *not* as `LOAD` ops. The first emitter treated those as address constants.
  Silent wrong-value bug, found immediately by execution. Any lifter needs
  a differential oracle from day one; this is exactly what the Unicorn
  oracle workstream is for.

---

## 3. The measurement that decides the emitter design

Same 499 functions, same compiler flags, three register/flag representations.

| design | C source | wasm `-O2` | lifted `lower_bound` |
|---|---|---|---|
| **register cache + function-local flags** (chosen) | 8.31 MB | **587,338 B** | **592–699 ns/call** |
| register cache + flags spilled across calls | 8.63 MB | 806,265 B (+37%) | 942–954 ns/call |
| everything through `CpuState*` (remill/rev.ng shape) | 7.90 MB | 1,136,863 B (**+94%**) | 1854–2060 ns/call (**~3×**) |

Note the C source is *smallest* for the worst design. Source size is not
the metric; emitted wasm is.

**Why.** With locals, LLVM sees pure SSA and deletes everything unused.
Here is the entire lifted `0x0040d040` prologue in wasm (`wasm-dis` output,
`output/recomp/lift/slice/only.wat`):

```wat
(func $1 (param $0 i32)
 (local $1 i32) ... (local $7 i32)
 (local.set $7 (i32.load offset=80 (local.get $0)))   ;; EIP
 ...
 (if (i32.ge_u (local.tee $2 (i32.load offset=20 align=1 (local.get $4)))
               (i32.const 16))
```

Twenty-six x86 instructions, each of which SLEIGH expands into 6 flag
computations (including `popcount` for PF and `sborrow` for OF) — 123 p-code
ops total — and **not one flag survives**. `cmp ecx,0x10` + `jb` became a
single `i32.ge_u` folded into the `if`. Total: 7 locals, no parity table,
no overflow arithmetic.

This resolves the standing question in the literature. Trail of Bits had to
write three custom dead-store-elimination passes for McSema because
remill's `State` is behind a pointer; Arancini reports its own dead-flag
pass is worth only ~2% because its flags are SSA values. **Both are right.**
The determining factor is not the optimizer, it is whether the flag lives
somewhere the optimizer is allowed to delete. Put it in an `alloca`-backed
local and a stock `-O2` gives you Rellume-quality flag elision for free.

**Consequence:** do not build a custom flag-liveness analysis. Build the
register cache instead. It is ~40 lines and it subsumes the problem.

---

## 4. Scaling: measured, not extrapolated

Full run over all 7,986 function starts recovered from direct call targets.

### Lift

| | |
|---|---|
| functions requested / lifted / failed | 7,986 / **7,963** / 23 (**99.7%**) |
| `.text` bytes covered | 4,803,097 of 7,430,452 (**64.5%**) |
| x86 instructions | 1,313,933 |
| p-code ops | 5,706,164 (4.34 per instruction) |
| C emitted | **290,624,459 B**, 8,450,702 lines |
| expansion | **60.5 C bytes / x86 byte**, 6.43 C lines / x86 insn |
| lift wall time | **173 s** single-threaded Python |

The 23 failures are all wide-varnode residue: 16 `subreg size` (SSE
sub-register reads reached through `CALLOTHER` arguments), 4 wide
`INT_NEGATE`, 2 wide `INT_SRIGHT`, 1 SLEIGH `BadDataError`. All are
mechanical to finish; none is a design problem.

### Compile and link (emcc 6.0.5, `-O2`, 32 TUs of ~250 functions each, 14 jobs)

| | |
|---|---|
| compile wall / CPU | **181 s** / 1,504 s |
| peak RSS, worst single TU | **895 MB** (23.4 MB of C) |
| object files | 25.9 MB total |
| link wall / peak RSS | **41.5 s** / **915 MB** |
| **output wasm** | **24,294,973 B** |
| **wasm bytes per x86 byte** | **5.06** |
| exported functions | 7,979 |

### Browser load (Node 24 / V8, raw `WebAssembly.compile` on the 24.3 MB module)

| | |
|---|---|
| `WebAssembly.compile` | **49 ms** |
| `WebAssembly.instantiate` | **13 ms** |
| exports resolved | 7,985 (7,979 lifted functions) |

### Extrapolation to 100% of `.text`

At the measured 5.06 wasm bytes per x86 byte, the full 7,430,452-byte
`.text` yields **≈ 37.6 MB of wasm** from **≈ 450 MB of C** in ~50 TUs,
built in **≈ 5 minutes wall-clock** on 14 cores with **< 1 GB per process**.

Against the hard engine limits (read from V8 `src/wasm/wasm-limits.h`):
`kV8MaxWasmModuleSize` 1 GiB, `kV8MaxWasmDefinedFunctions` 1,000,000,
`kV8MaxWasmFunctionSize` 7,654,321 B, `kV8MaxWasmTableSize` 10,000,000.
A 37.6 MB module with ~15,000 functions sits at 3.7% of the module limit and
1.5% of the function limit. **There is no size wall here.**

37.6 MB is a large download for a browser game, but it is a *download*
problem (Brotli, split modules, streaming) not a *feasibility* problem, and
the game already ships ~1 GB of assets.

**`-Oz` is a trap here.** The same 32 TUs built at `-Oz` produce
**27,782,727 B — 14% *larger* than `-O2`** (5.78 vs 5.06 wasm bytes per x86
byte), because the size passes skip exactly the inlining and
store-forwarding that eliminate the `CpuState` spill/reload boundary. On a
3-function slice `-Oz` *was* 19% smaller than `-O2` (6,619 vs 8,186 B), so
this only shows up at scale. **Measure, don't assume: use `-O2`.**

### Runtime cost

`bench.c`, same wasm module, same workload (64 probes into a 512-node
`std::map<string,…>`, 1500 reps), lifted `0x00685bc0` vs hand-written
`isaac_exit_map_lower_bound`:

| | ns/call |
|---|---|
| hand-written C++ translation | 134–219 |
| **mechanically lifted** | **592–699** |
| ratio | **≈ 3.4×** |

Lifted `0x0040d040` (SSO path, no call): 47 ns/call.

Caveat: `lower_bound` is pointer-chasing with a nested call per level, so
it pays the spill/reload boundary nine times per call — a pessimistic case.
A leaf compute function would do better. **The host-vs-wasm component was
not measured** (no native C toolchain on this machine); published figures
put wasm at 1.45–1.55× native for well-formed compiled C (Jangda et al.,
USENIX ATC 2019), so the lifted-vs-native figure is plausibly 4–6× but is
**UNVERIFIED here**.

---

## 5. What must still be hand-written

The lift is mechanical. These are not, and they are the actual project.

### 5.0 Computed jumps: the top risk, re-measured and mostly dissolved

**Superseded by §11.** The first pass of this document flagged mid-function
computed jumps as the thing that could hard-fail the build. Measuring
against the complete Ghidra inventory reduced it to **44 functions**, and
the structure that handles them costs **+18% wasm on an affected function**
and **0.04% on the module**. Read §11 before acting on anything in §5.1.

### 5.1 Indirect control flow — the top risk

Measured over the 4.8 MB lifted:

| | count | notes |
|---|---|---|
| direct calls | 35,916 | free |
| indirect calls, target from a **constant** slot | **14,031** | only **498 distinct slots** — the IAT plus a few global fn-ptrs. Resolvable at lift time from the import table. |
| indirect calls, **computed** target | **12,884** | C++ vtable dispatch. Needs a runtime address→funcref table. |
| computed jumps (`jmp [tbl+idx*4]`) | **568** | MSVC switch tables, in 476 functions |
| tail calls | 73 | |

The 14,031 constant-slot calls collapse to a 498-entry name table — that is
a *good* number and it is the same set the import/host census workstream is
producing. Wire it in and half the indirect-call problem disappears.

The 12,884 computed calls all target **function entries**, so a sorted
address→`funcref` table plus `call_indirect` is sound and cheap. V8's
10 M-entry table limit is not a constraint.

**The 568 computed jumps are the real hazard.** Their targets are
*mid-function basic blocks*, and wasm has no computed goto: LLVM's
WebAssembly backend fails outright with `"WebAssembly hasn't implemented
computed gotos"` on `indirectbr`/`blockaddress`. There is exactly one good
outcome — **recover the jump table statically**, emit a C `switch`, let LLVM
lower it to `br_table`, which is free. Every unrecovered table is a
hand-annotation. Ghidra recovers most MSVC x86 tables but is known to
mis-handle the two-level `movzx`-index form (Ghidra issue #6695, open since
2024-07-05). Budget a per-site annotation file, XenonRecomp-style.

My prototype currently punts all of these to `recomp_jump_indirect()`.
**Making jump tables real is the first thing to build next.**

### 5.2 The `CALLOTHER` set — surprisingly small

Across 1.31 M lifted instructions there are **2,144 `CALLOTHER` sites in
only 26 distinct kinds**:

```
LOCK, UNLOCK, in, swi, paddsw, pmulhw, psllw, psraw,
cpuid + 18 cpuid_* sub-leaf variants
```

That is a one-afternoon hand-write list, not a research project. `cpuid`
returns a fixed synthetic CPU; `LOCK`/`UNLOCK` are no-ops in a
single-threaded wasm build; `in` and `swi` (int3) abort; the four MMX ops
need real implementations.

### 5.3 SEH and the FS segment — cheaper than expected

SLEIGH models `fs:[0]` as `FS_OFFSET + 0`, a plain flat address. So the
whole MSVC x86 exception-registration chain lifts as ordinary loads and
stores into a synthetic TEB you place in linear memory. Concretely, in
lifted `sub_006eef60` (`Isaac::genrand_int32`, which carries a full
`_except_handler4` frame plus a `/GS` cookie), the prologue became
`u9100_4 = FS_OFFSET + 0` and a `MEMW32` — no special handling at all.

So: **set `FS_OFFSET` to a fake TEB and the SEH prologue/epilogue cost is
two memory ops per function and nothing else**, as long as nothing throws.
An actual dispatcher (`_except_handler4`, `__CxxFrameHandler3`) is a
separate hand-written component and can be deferred; it is imported from
`VCRUNTIME140.dll`, so it is *not even in the 7.4 MB you are lifting*.

### 5.4 Everything else

- **Host boundary**: the 498 IAT slots → OpenGL/SDL/Steam/CRT shims. This
  is the bulk of the remaining project-months and is ordinary porting work.
- **Indirect dispatch table**: generated from the function inventory.
- **Function boundaries**: 51 lifted bodies exceeded 8 KB, covering 739 KB —
  these are recursive-descent runaways that fell through a real function
  end into the neighbour. They still produce *correct* code (the neighbour
  is duplicated, not corrupted) but they inflate the module and they mean
  the boundary set is wrong. **Replace `scan.py` with the Ghidra inventory**
  as soon as it exists; that also fixes the 64.5% coverage.
- **x87 80-bit precision is lossy.** `ST0..7` are modelled as `double` in
  the low 8 bytes, the same tradeoff remill makes. 53-bit mantissa instead
  of 64-bit. For a 2D roguelike this is almost certainly invisible, but it
  is a real semantic deviation and must be on the risk list.

---

## 6. Where this is WORSE than hand translation

Stated plainly, because this is the part that decides whether to pivot.

1. **~3.4× slower per function, measured.** The hand-written
   `isaac_exit_map_lower_bound` is idiomatic C++ operating on typed
   pointers; the lifted version threads an emulated stack and a 2,776-byte
   register file. No optimizer recovers that gap.
2. **No types, no names, no comprehension.** Hand translation produces
   `IsaacFrameOpaque40d040Plan` with field names and a documented ABI. The
   lifter produces `u24d80_1` and `s->ESI`. You cannot read it, review it,
   diff it against intent, or fix a gameplay bug in it. **A lifted binary
   is a working artifact, not a codebase.** Everything the current
   `native/decomp` effort has built — the pure/host split, the ABI
   versioning, the differential test corpus — is discarded by a pure lift.
3. **Correctness is all-or-nothing and unverifiable by inspection.** Hand
   translation gives per-function evidence. A lift gives you "it ran". The
   only defence is an execution oracle over a huge input space, which is
   why the Unicorn workstream is load-bearing rather than optional.
4. **The 35.5% of `.text` I did not cover is invisible.** Hand translation
   knows what it hasn't done. A lifter silently omits whatever the function
   inventory missed, and you discover it as a runtime "unresolved indirect
   call to 0x…" mid-playtest.
5. **Mid-function indirect jumps can hard-fail the compile**, not degrade.
   Hand translation never has this failure mode.
6. **Modding.** Isaac's value is substantially its mod ecosystem. Lifted
   code cannot be patched or extended; hand-translated code can.

---

## 7. Tool landscape (why not use an existing lifter)

Surveyed 2026-08-09 with dates and issue numbers; full detail in the
research log. Ranked by usability *for this job*:

| tool | status | verdict |
|---|---|---|
| **SLEIGH / pypcode** | alive; pypcode 4.0.0 on PyPI 2026-05-16, vendors Ghidra 12.1 SLEIGH; `lifting-bits/sleigh` v12.1.2 2026-06-08, Apache-2.0 | **chosen.** Decoder only — you write the lifter. That turned out to be ~900 lines. |
| **remill** | alive, revived: v6.0.1 2026-04-21, last commit 2026-06-30, Apache-2.0. Full x86-32 incl. x87/SSE/MMX/segments. IR is retargetable (no `llvm.x86.*` intrinsics; `native_float80_t` falls back to `double` on non-x86). Scaling: issue #762 — 85 MB binary needed partitioning into 38 modules on 24 GB. | **strongest alternative.** Semantics library, not a whole-binary tool — you still write PE loading, function discovery, jump tables. Its `State`-behind-a-pointer shape is exactly the design my A/B measured at 1.94× bigger / ~3× slower. |
| **elfconv** | Apache-2.0, pushed 2026-08-01. remill → LLVM → Emscripten → wasm, runs CPython in-browser. | **existence proof that remill IR reaches wasm.** AArch64 only; x86-64 "NOT yet end-to-end" as of 2026-08-08; ELF only. |
| **evmar/theseus** | x86-32 PE → Rust → wasm32. Created 2026-03-12, pushed 2026-08-02. One Rust fn per *basic block* + continuation trampoline, so irreducible CFG never reaches the wasm backend. Expansion 22–35× source. | **read the design, do not depend on it.** No LICENSE file — all rights reserved. Author: "probably won't work on a program you try." |
| **mcsema** | archived 2022-08-23; required IDA Pro; AGPL | dead |
| **anvill / rellic** | anvill last real commit 2022-12, main branch needs a *closed-source* Ghidra plugin; rellic's 2025 commit disabled CI | dead / wrong role |
| **rev.ng** | very alive (pushed 2026-08-07) and the best PE/`__thiscall` model on paper — but issue #552: a **304 KiB** binary took 9.9 GB and 25+ h; 1 MiB and 4 MiB OOM'd. PE IAT unimplemented (#478, open). QEMU **GPLv2** helpers are linked into the output. | **killed three ways.** |
| **RetDec** | lifter frozen since 2022-12, LLVM 8, CI 100% broken, `bad_alloc` on a 1 MB PE. Lead dev, issue #45: "it has never been our goal to produce LLVM IR or C that could be recompiled." | dead |
| **p-code→LLVM projects** | newest code in the category is LukeSerne/Ghidra-to-LLVM, 2023-06-04, x86-64 only | none usable |
| **Ghidra C export** | arXiv:2202.12336: 70–89% of individual functions recompile, **1.7% of whole binaries**. Ghidra #8102 open since 2025-05-04. | not a recompilation source |
| angr/VEX, Triton, miasm, BAP, Dyninst, Reko, Mergen | all alive, all analysis/SymEx/instrumentation | wrong category |

**The 851-line emitter beat every off-the-shelf option on this binary**,
mostly because the off-the-shelf options either target the wrong thing
(readable C), the wrong ISA (x86-64/AArch64), or use a state representation
that costs 2× in wasm.

---

## 8. Recommended pipeline

```
                       tools/isaac-ng.unpacked.exe  (read-only)
                                     |
   ┌──────────────────┬──────────────┴───────────┬─────────────────────┐
   │                  │                          │                     │
Ghidra headless   import/host census      Unicorn oracle          (this repo's
function          498 IAT slots ->        golden CPU+memory        existing
inventory +       host shim names         traces per function      hand ports)
jump tables            │                       │                        │
   │                   │                       │                        │
   └────────┬──────────┘                       │                        │
            v                                  │                        │
     scripts/recomp/lift/emit.py               │                        │
     (SLEIGH p-code -> C, per-function         │                        │
      register cache, identity memory)         │                        │
            │                                  │                        │
            ├── lifted_NNN.c  (~50 TUs)        │                        │
            ├── recomp_state.h                 │                        │
            ├── dispatch.c  (VA -> funcref)    │                        │
            └── missing.txt ──────────────┐    │                        │
                                          v    v                        v
                            hand-written boundary layer  <───────────────┘
                            - 26 CALLOTHER intrinsics
                            - 498 IAT shims (GL/SDL/Steam/CRT)
                            - fake TEB + SEH dispatcher (deferrable)
                            - override table: VA -> hand-written impl
                                          |
                                    emcc -O2, parallel
                                          |
                                  ~37 MB wasm module
                                          |
                            differential replay vs oracle
```

### The hybrid, concretely

The lifter already emits every call as `sub_XXXXXXXX(CpuState*)`. Make that
name a **weak symbol** and the hybrid falls out of the linker for free:

```c
/* generated */
__attribute__((weak)) void sub_00685bc0(CpuState *s) { /* lifted body */ }

/* hand-written override, linked in later, wins */
void sub_00685bc0(CpuState *s) {
  s->EAX = isaac_exit_map_lower_bound(s->ECX, MEMR32(s->ESP + 4),
                                      MEMR32(s->ESP + 8));
  s->EIP = MEMR32(s->ESP); s->ESP += 12;   /* ret 8 */
}
```

Because both sides already use identity addressing over the same linear
memory, no marshalling is needed beyond the register/stack ABI shim — and
§2 proves the two produce identical results on identical memory. Every
hand-written translation in `native/decomp` keeps its value: it becomes the
*fast, readable, moddable* implementation of a function that also has a
mechanical fallback. Nothing is thrown away, and coverage stops being the
bottleneck.

This also gives a free continuous correctness check: run both
implementations of an overridden function on the same state and diff — the
harness in §2 is exactly that, and it generalizes.

### Explicitly rejected alternatives

- **remill as the lifter.** Would work, and elfconv proves it reaches wasm,
  but its `State`-behind-a-pointer IR is the design my A/B measured at
  1.94× module size and ~3× runtime, and undoing that is what anvill was
  for — and anvill is dead behind a closed-source dependency.
- **One giant lifted function with a dispatch loop** (the rev.ng `root`
  shape). `kV8MaxWasmFunctionSize` is 7,654,321 bytes and lifted x86 expands
  5×; a single function cannot hold `.text`.
- **A global `switch` dispatcher over all block addresses.**
  `kV8MaxWasmFunctionBrTableSize` is 65,520 and LLVM's `LowerBR_JT` does not
  split `br_table`. Use `call_indirect` through a table instead.
- **memory64.** Destroys the guard-page trick that makes wasm32 bounds
  checks free; measured elsewhere at 10–100% penalty. The image needs
  ~9.2 MB and the heap is under your control — stay on wasm32.

---

## 9. Risks, ranked

| risk | severity | evidence | mitigation |
|---|---|---|---|
| **20,148 dynamic indirect calls; 43% of real functions never direct-called** | **critical** | §11.4b / §11.5, measured over 96% of `.text` | sorted address→funcref table + `call_indirect`; runtime trap on an unknown target feeding an annotation loop. This is now the top risk. |
| **73 lift failures (wide SSE / x87 residue)** | medium | §11.4b | finish the wide-varnode paths; all mechanical |
| **~3.4× slower than hand-written** | medium | §4, measured in-module | acceptable for a 2014 2D game; hybrid overrides for hot paths |
| **x87 → `double` precision loss** | medium | ST0..7 modelled with a 53-bit mantissa | audit the x87 sites; the binary is SSE2-dominant |
| **3.82% of `.text` still uncovered** | medium | 7,146,356 of 7,430,452 bytes | mostly data-in-code plus the 73 failures |
| **SEH dispatch not implemented** | low-medium | 2,571 real functions carry SEH; prologues lift for free through `FS_OFFSET` | defer — the unwinder is imported from VCRUNTIME140, not lifted |
| **44 functions need a pc dispatch loop** | **low** | §11.1 / §11.2: +18% on an affected function, **0.036% on the module** | `--dispatch auto`; LLVM folds the loop away where `pc_` is constant |
| **440 MB of C per build** | low | §11.4b | 43 TUs, parallel, < 1 GB per process |
| **Self-modifying code / packing** | **none** | already unpacked; Lua is an external DLL | — |

---

## 10. If I had one week of compute

**Round 2 completed days 1-3 of the original plan** (§11). Coverage is 96.18%,
the IAT is bound, the jump tables are recovered. Revised plan:

1. **Day 1 — the dispatch table.** Emit a sorted VA→`funcref` table from the
   14,211 real entries plus every recovered jump-table target, and turn
   `recomp_call_indirect` into a real `call_indirect`. 43% of real functions
   are reachable *only* this way, so nothing runs until this exists.
   *Deliverable: a module where an unknown indirect target is a logged trap,
   not a link error.*
2. **Day 1-2 — static initialisers and boot.** Run the 117 C++ + 4 C static
   initialisers via the `_initterm` bounds in `__scrt_common_main_seh`, set
   `FS_OFFSET` to a synthetic TEB, then enter `main` at `0x00931050`.
   *Deliverable: the first import the lifted binary actually demands at
   runtime, in order.*
3. **Day 2-4 — differential replay against the Unicorn oracle.** It agrees
   3/3 with hand-verified work and runs 1,428 vectors/s/core; at 16 cores
   that is ~2 M vectors/day. Replay every lifted function: oracle-recorded
   entry state in, compare exit state and memory diff.
   *Deliverable: pass rate per function and a triage list. This is the only
   scalable correctness argument that exists.*
4. **Day 4-5 — the 587 import shims, demand-ordered.** Only 125 symbols /
   5,779 call sites need real behaviour; the CRT is `/MD` so UCRT calls map
   to musl/emscripten equivalents, and Lua is an external DLL (14,011 call
   sites, 62% of IAT traffic, **zero bytes to lift**) — build Lua 5.3.3 from
   source into the same module.
   *Deliverable: the first frame that reaches the GL layer.*
5. **Day 5-6 — close the 73 lift failures and the 3.82% coverage gap**, then
   re-run steps 1-3. *Deliverable: >99% coverage with the same pass rate.*
6. **Day 6-7 — wire the hybrid.** Weak symbols plus an override table; make
   every existing `native/decomp` translation an override; generalize the
   §2 harness across all of them. *Deliverable: proof that hand and lifted
   code coexist at scale.*

**Do not spend the week on:** a custom flag-liveness pass (§3 — `-O2` already
does it), a general computed-goto machinery (§11.1 — 44 functions, and
`--dispatch auto` already handles them), evaluating remill/rev.ng further
(§7), or shrinking the emitted C (build time and module size are fine).

**Abort criteria.** If step 1 leaves a large tail of indirect targets that
resolve to no known function, or step 3 shows a low per-function pass rate
that does not concentrate in a fixable category, the mechanical path does
not close and the hybrid degenerates into hand translation with extra
steps. Both are cheap to test, which is why they are first.

---

## 11. Round 2: computed jumps, the real inventory, and IAT resolution

Everything in §1–§10 was measured against a function-start set recovered
from direct call targets alone (7,986 starts, 64.5% of `.text`). The
Ghidra headless export and the host-boundary census have since landed and
the lifter now consumes both. This section supersedes §5.0/§5.1 where they
disagree.

### 11.1 The computed-goto problem is 44 functions, not 3,107

The inventory reports **3,127 `unresolvedComputedJumps` sites in 3,107
functions** — 13% of all records — which would be a serious problem if all
of them needed a computed-goto structure. They do not.

I disassembled every computed jump in every function the inventory lists
(`scripts/recomp/lift/jumptables.py`) and classified it by operand form:

| form | sites | what it actually is |
|---|---|---|
| `jmp reg` | **2,874** | indirect **tail call**. 2,865 of them (99.7%) are the last instruction of the function body. Classic MSVC lazy-import/vtable thunk: `call resolver; mov [slot],eax; pop ebp; jmp eax`. |
| `jmp [idx*4 + TBL]` | **764** | real switch table — **recovered**, 7,572 entries, 6,004 landing inside the owning function |
| `jmp [IMM]` | **103** | IAT slot tail call |
| unclassified | **35** | genuinely needs a dispatch structure |

A tail call needs `call_indirect` followed by `return`, which the lifter
already emits and which costs nothing structurally: the callee's `ret`
consumes the caller's return address off the shared guest stack, exactly
as on x86. Ghidra calls these "unresolved" because it cannot name a
target, not because they branch into the middle of a function.

**Functions that genuinely need an intra-function dispatch structure: 44**
(35 unclassified sites + 9 non-tail `jmp reg`), holding **6,998 bytes** —
0.09% of `.text`. Of those 44, **21 are real function entries and 23 are
Ghidra fragments** that get folded into their parents anyway (§11.3). The
full-binary lift independently lands on the same figure: **44 functions,
47 unresolved sites** (§11.4b), against 758 recovered tables and 2,977
tail calls.

Cross-check against the inventory's own field: of the 3,107 functions with
`unresolvedComputedJumps`, 2,945 are real entries and 162 are fragments —
so the fragment filter does *not* shrink that number. The reduction from
3,107 to 44 comes entirely from separating tail calls from computed gotos,
which is a distinction the `unresolvedComputedJumps` counter does not make.

### 11.2 What the structures cost, measured

Three emissions of the same 44 functions, `-O2`, all exported:

| computed-jump handling | C source | wasm | vs. trap |
|---|---|---|---|
| `--dispatch off` (runtime trap) | 544,565 | **49,743** | — |
| `--dispatch auto` (loop on the 33 that need it) | 557,436 | **58,717** | **+18.0%** |
| `--dispatch force` (loop on all 42 lifted) | 560,626 | **58,717** | +18.0% |

Two results worth keeping:

1. **+18% wasm on an affected function; 0.036% on the module.** 8,974
   extra bytes against a ~25 MB module. The dispatch loop is affordable
   even if the affected set grew by 100×.
2. **`force` and `auto` produce byte-identical wasm.** When no computed
   jump writes `pc_`, LLVM proves the switch has one reachable case and
   folds the entire loop away. So the loop is self-limiting: wrapping
   functions that don't need it is free, and targeting is a C-size
   optimisation, not a correctness or performance one.

I also re-tested the premise. **`indirectbr`/computed `goto` now compiles
for wasm** in emcc 6.0.5 (LLVM 21) at `-O0` and `-O2` — the historical
`"WebAssembly hasn't implemented computed gotos"` hard failure is gone.
The emitter still does not use it: an explicit `switch` over recovered
targets is strictly better because LLVM lowers a dense one to `br_table`.
Verified: the two lifted switch functions produce **6 `br_table`
instructions** in the output wasm.

Structure emitted at a recovered site (no cost to any other block):

```c
  jt41ddbd = <computed target>;
  switch (jt41ddbd) {
    case 0x41ddc4u: goto L_0041ddc4;
    case 0x41ddcau: goto L_0041ddca;
    ...                              /* 161 targets -> one br_table */
    default: break;
  }
  /* spill */ recomp_jump_indirect(s, jt41ddbd); return;
```

### 11.3 Fragments: the decision, and why it is safe either way

Ghidra's gap-recovery pass added 10,145 entries of which only **186 have a
real prologue**; the other **9,959 are mid-function fragments** covering
1,455,468 bytes. Real function entries: **14,211** (= 14,025 `recovered:false`
+ 186 recovered-with-prologue), which is the set the coordinator's
independent diff also arrived at.

**Decision: `--fragments absorb` is the default.** Fragments are removed
from the *boundary* set so a branch into one stays an internal edge and
the parent is lifted whole. They are kept as *lift targets* of last
resort: after the real functions are lifted, any fragment whose entry byte
is still uncovered gets lifted standalone, so absorbing can never open a
coverage hole. `--fragments split` restores the old behaviour for A/B.

Measured A/B over the same first 1,000 inventory rows:

| mode | functions emitted | x86 bytes lifted | wasm `-O2` |
|---|---|---|---|
| `split` (every row is a function) | 999 | 235,158 | 1,066,527 |
| **`absorb`** (fragments folded, 128 rescued) | 912 | 215,005 | **1,003,389** |

Absorbing lifts **8.6% fewer x86 bytes** (that difference is pure
duplication) and produces **5.9% smaller wasm**.

Worth stating explicitly, because it is a property of this design rather
than of the fragment data: **treating a fragment as a function is not a
correctness bug here.** With a uniform `void f(CpuState*)` ABI over shared
guest memory, `jmp frag` lifts to `sub_frag(s); return;`, the fragment's
`ret` pops the same return address the real `ret` would have, and control
lands in the same place. Splitting costs code duplication, call overhead,
and inflated byte counts — not wrong answers. That is why the earlier
64.5%-coverage run produced correct code despite 51 runaway bodies.

### 11.4 IAT-resolvable indirect calls

The census maps 622 import symbols to their IAT slot VAs. The emitter now
tracks `unique = *[ram]CONST` within an instruction, so
`call dword ptr [slot]` becomes a direct call to a named shim
(`imp_api_ms_win_crt_heap__free(s)`) instead of a runtime dispatch. Same
for `jmp [slot]` tail calls.

On a 1,000-function sample: 34 distinct shims bound, and
**`callind_const_unresolved` = 0** — every constant-slot indirect call
resolved. 414 indirect calls remained, all genuinely dynamic.

### 11.4b Full-coverage lift, driven by the real inventory

```
python scripts/recomp/lift/emit.py --exe tools/isaac-ng.unpacked.exe \
  --ghidra-functions output/recomp/export/functions.jsonl \
  --fragments-tsv   output/recomp/export/recovered-functions.tsv \
  --imports         output/recomp/census/imports.json \
  --va-file output/recomp/lift/ghidra_all.txt --dispatch auto \
  --out output/recomp/lift/gabs --module lifted --split 500
```

| | round 1 (own scanner) | **round 2 (real inventory)** |
|---|---|---|
| function starts | 7,986 | 24,170 rows → 14,211 real + rescued fragments |
| functions emitted | 7,963 | **21,375** (73 failed, **99.66%**) |
| `.text` covered | 4,803,097 (64.5%) | **7,146,356 (96.18%)** |
| x86 instructions | 1,313,933 | **2,009,975** |
| p-code ops | 5,706,164 | 8,470,164 |
| C emitted | 290.6 MB | **440.4 MB** (13.0 M lines, 43 TUs) |
| C bytes / x86 byte | 60.5 | **58.3** |
| lift wall time | 173 s | **270 s** |

Control-flow resolution over the whole binary:

| | |
|---|---|
| direct calls | 62,943 |
| **switch tables recovered** | **758 → 7,150 targets** |
| **indirect tail calls** (`jmp reg` / `jmp [slot]`) | **2,977** |
| **unresolved computed jumps** | **47, in 44 functions** |
| **import shims bound** (`call [IAT]` → named host call) | **587 distinct**, used by 3,814 functions |
| indirect calls still dynamic | **20,148** |
| of those, still through a constant slot | 544 (globals in `.data`, not the IAT) |
| CALLOTHER intrinsics to hand-write | **32 kinds** |
| missing callees needing stubs | 36 |

### 11.4c Build and load of the 96%-coverage module

emcc 6.0.5, `-O2`, 45 TUs, 14 parallel jobs, everything exported so nothing
is dead-stripped.

| | |
|---|---|
| C input | **440,457,208 B** across 45 TUs |
| compile wall / CPU | **274.5 s** / 1,988.5 s |
| peak RSS, worst TU | **1,457.7 MB** (a 49.6 MB TU) |
| object files | 40.8 MB |
| link wall / peak RSS | **158.6 s** / **1,349 MB** |
| **output wasm** | **37,952,773 B** |
| **wasm bytes per x86 byte** | **5.02** |
| exported functions | 21,375 |
| **total build** | **7.2 minutes** |

Loaded in Node 24 / V8 from the raw bytes:

| | |
|---|---|
| `WebAssembly.compile` | **227 ms** |
| `WebAssembly.instantiate` | **429 ms** |
| exports resolved | 21,381 |

**The §4 extrapolation held.** From a 500-function sample I predicted
"≈ 37.6 MB of wasm" for the whole of `.text` at 5.06 bytes per x86 byte;
the real thing at 96.18% coverage is **37.95 MB at 5.02**. Against V8's
limits: 3.7% of the 1 GiB module cap, 2.1% of the 1 M function cap.

Two practical notes for whoever builds this next:

- **The linker is now the serial bottleneck**, not compilation: 158.6 s and
  1.35 GB for one `wasm-ld` + `wasm-opt` pass that cannot be parallelised.
  Compilation is 274.5 s wall but 1,988 s CPU, so it keeps scaling with
  cores; the link does not.
- **Sub-TU balance matters.** One 49.6 MB TU took 247 s and 1.46 GB by
  itself. `--split` on function *count* produces wildly uneven TUs because
  body sizes span 37 B (p50) to 63,810 B; splitting on cumulative *bytes*
  would cut both wall time and peak memory.

The 73 failures are the same wide-varnode residue as before (37 SSE
sub-register reads reached through `CALLOTHER` arguments, 22 SLEIGH
`BadDataError`, 10 wide `INT_NEGATE`/`INT_SRIGHT`, 2 bodies over the
20,000-instruction cap, 2 wide loads).

**Where the C mass is**, matching the inventory's advice to optimise for
big functions: 772 functions of ≥2 KB hold 4,317,145 x86 bytes and produce
**222 MB — half the total C** — at 51.5 C bytes per x86 byte, while the
14,992 functions under 128 bytes run at 64.6.

### 11.5 Function-start set actually used

`--ghidra-functions output/recomp/export/functions.jsonl` plus
`--fragments-tsv output/recomp/export/recovered-functions.tsv`. Derived
counts I use in extrapolations, stated so they are not silently adopted:

- **14,211 real function entries** (Ghidra, prologue-filtered). I use this,
  not the census's 29,392 and not Ghidra's raw 24,170.
- **6,112 (43%)** of those real entries are never the target of a direct
  call — reachable only through vtables and function pointers. That is the
  population the address→funcref dispatch table must cover.
- **557 real functions of ≥2 KB hold 2,822,499 bytes — 49%** of all real
  function bytes. Emitter effort belongs on the big ones.
- 2,571 real entries carry SEH.

Identity addressing (guest VA == wasm linear-memory offset) is now
load-bearing beyond convenience: the renderer uses client-side vertex
arrays (`glVertexAttribPointer`/`glDrawElements` with raw caller pointers,
no `glGenBuffers` anywhere), so guest pointers are handed straight to the
GL layer. **Do not introduce a base offset.**

## 12. Round 3: dynamic dispatch, x87, and the residual

### 12.1 VA → wasm function: measured, and binary search is disqualified

Identity addressing means a guest code pointer *is* a VA, so every dynamic
indirect call must map a 32-bit VA to a wasm function index. Measured in
wasm over the real 21,375-entry set, 2.6 M lookups, VAs drawn from the
actual entry set in xorshift order (`scripts/recomp/lift/bench_dispatch.c`):

| strategy | memory | ns/lookup | net of 1.99 ns array-read baseline |
|---|---|---|---|
| A sorted binary search | 86 KB | **81.33** | 79.3 |
| B direct-mapped `uint16` over `.text` | **14.2 MB** | **3.98** | **2.0** |
| C open-addressed hash, 2^15, Knuth mult | 196 KB | 10.23 | 8.2 |
| C′ same, 2^16 + murmur3 finalizer | 384 KB | **6.92** | 4.9 |
| `call_indirect` alone | — | 4.57 | 2.6 |
| **B + `call_indirect` (the real cost)** | | **≈ 4.6** | |

**Binary search is disqualified**: 81 ns per virtual call, in a C++ game
that dispatches constantly, is the difference between shipping and not.
The direct-mapped table costs 14.2 MB of linear memory and **≈ 2 ns**;
with the `call_indirect` that follows, a dynamic indirect call costs
**≈ 4.6 ns**, against ~2.6 ns for a static one. That is inside the
"tens of nanoseconds is fine" bar with an order of magnitude to spare.

The table must stay byte-granular: only 75.7% of entries are 16-byte
aligned and **13.0% are not even 2-byte aligned**, so a 4-byte-granular
table needs a hash for the 4,004 unaligned entries and ends up *slower*
(7.16 ns) than the flat one. If 14.2 MB is ever unacceptable, the 384 KB
murmur hash at 6.92 ns is the fallback — not binary search.

Better still and not yet built: every one of the 14,666 code pointers in
data is reloc-listed, so the loader could **rewrite each slot from VA to
dense id at image-load time**, making dispatch a bare `call_indirect` with
no lookup at all. Left as a documented optimisation because it breaks any
code that compares or arithmetically manipulates function pointers, and I
have not proven this binary does not.

### 12.2 A virtual call through a real `.rdata` vtable — end to end

`scripts/recomp/lift/vtable_test.c`. Not a static argument: the PE regions
are copied to their real VAs in linear memory, and mechanically lifted code
reads a genuine vtable out of `.rdata`.

Call site is the real MSVC thiscall dispatcher at `0x006ee110`
(`mov ecx,[esi+0x590]; mov eax,[ecx]; call [eax+0x28]`). Two different real
vtables are pointed at it:

```
  [0x00b81270+0x28] = 0x009f3140      xor eax,eax ; ret
  [0x00b812b8+0x28] = 0x009f3160      mov eax,[ecx+0x48] ; ret
```

```
  vtbl 0x00b81270 -> EAX=0x00000000 expect=0x00000000  tail=1  PASS
  vtbl 0x00b812b8 -> EAX=0xcafebabe expect=0xcafebabe  tail=1  PASS
  vtbl 0x00b812b8 -> EAX=0x12345678 expect=0x12345678  tail=1  PASS
  RESULT: ALL PASS
```

Same call site, same object layout, different vptr → different lifted
override, with the value read out of the object by the second override.
The dispatch really does select on vtable contents, and the tail `jmp` to
`0x006acb00` fires. **C++ virtual dispatch works under static
recompilation.**

This also validates the production memory layout: built with
**`-sGLOBAL_BASE=13631488`** (0xD00000), which puts emscripten's data,
stack and heap above the image so guest VAs `0x00400000–0x00CFE000` are
addressable linear memory. Identity addressing is not a prototype
convenience — it links.

### 12.3 The residual: what a dynamic call can reach and we have not lifted

Recovered independently from the PE relocation table
(`scripts/recomp/lift/codeptrs.py`): **14,666 code pointers in data** —
11,420 in `.rdata`, 3,246 in `.data` — exactly matching the census count.
11,097 distinct targets.

| | count | |
|---|---|---|
| distinct targets that ARE a lifted entry | **8,989** | 81.0% |
| distinct targets NOT lifted | 2,108 | |
|   mid-function (inside a known body) | 43 | |
|   outside every known function body | **2,065** | |

Restricted to the 222 **vtable-shaped runs** (≥ 3 consecutive 4-byte-strided
pointers = 6,415 slots), which is what a virtual call actually reaches:

| | count | |
|---|---|---|
| slots whose target is lifted | **5,985** | **93.30%** |
| slots whose target is not | 430 | 80 distinct targets |

**The 2,065 non-vtable misses are not dispatch targets at all.** Their
first instruction is `lea ecx,[ebp-0x2c]` / `mov ecx,[ebp-0x14]` —
mid-frame code using the parent's frame pointer, i.e. **C++ EH funclets**,
not functions. All 3,978 slots pointing at them live in `.rdata` with a
dominant stride of **8** (a two-dword table, consistent with an MSVC
`__ehfuncinfo` unwind map), and only 10.8% sit in a vtable-shaped run.
They are reachable only through `__CxxFrameHandler3`, which is imported
from VCRUNTIME140 and is not code we lift. They are, however, most of the
3.82% `.text` coverage gap.

**The 80 unlifted vtable targets are real functions Ghidra missed** — tiny
C++ virtual accessors that nothing calls directly:

```
  0x005ccc00 x74   xor al, al ; ret
  0x0042bc90 x48   ret 8
  0x006a80c0 x29   xor al, al ; ret 8
  0x009f3130 x24   fldz ; ret
  0x0042bc00 x19   mov al, 1 ; ret 4
  0x00a9ff60 x10   fld dword ptr [ecx + 0x38] ; ret
```

Only 6 of the 80 are in the Ghidra inventory at all. So the fix is
mechanical and was applied: **feed the code-pointer targets back as
function starts.** The union set is 26,241 entries (24,170 inventory rows
+ 2,071 targets the inventory never knew about).

### 12.4 The 73 lift failures, named exactly

| x86 instruction | count | why |
|---|---|---|
| `pmovsxwd` | 18 | 16-byte SSE varnode arithmetic |
| `pandn` | 6 | wide `INT_NEGATE` |
| `pmulld`, `pmaddubsw`, `psrad` | 3 each | wide arithmetic / wide `INT_SRIGHT` |
| `maxps`, `vpcmpeqb`, `vpinsrd` | 2 each | 16- and **32-byte** (AVX) varnodes |
| `pshufb`, `pabsd`, `minps`, `vcvttss2usi`, `vcvttsd2usi`, `vcvttpd2uqq` | 1 each | SSSE3 / AVX-512 |
| `lds` | 1 | 6-byte far-pointer load — data misdecoded as code |
| SLEIGH `BadDataError` (body could not be decoded) | 22 | |

Every one is a wide-varnode arithmetic path, and **44 of the 73 sit at
VA ≥ 0xA00000 — the CRT / vendor tail.** That code is a `/MD` import
surface we are replacing with musl/emscripten, so most of these never need
to lift at all. The 27 in game code (0x500000–0x8FFFFF) do, and they need
the same thing: elementwise lowering for 16/32-byte `INT_*` ops. Mechanical,
not a design problem.

### 12.5 The x87 model, stated plainly

`ST0..ST7` are 10-byte SLEIGH registers. **The model stores an IEEE-754
binary64 in the low 8 bytes and zeroes the top two**; every `FLOAT_*` op
goes through C `double`. This is the same tradeoff remill makes
(`typedef double native_float80_t`).

Measured over the 24,170 inventory bodies: **655 functions use x87** (589
game, 66 CRT tail), **4,670 x87 instructions**, of which:

| | count | share |
|---|---|---|
| `fstp` + `fld` (load / store) | **4,205** | **90.0%** |
| arithmetic (`fmul` `fadd` `fdiv` `fsub` `faddp` …) | ~400 | 8.6% |
| `fld1` / `fldz` constants | 41 | |

What this means for the Lua boundary, which is the hot path:

- **`fld m64` → `fstp m64` is bit-exact under this model.** A `lua_Number`
  returned in `st(0)` and stored back to memory as a double round-trips
  with zero loss. That is exactly the 90% case.
- `fld m32` → `fstp m32` is likewise exact (float→double→float is exact).
- `fld m80` / `fstp m80` (true `long double`): **zero occurrences** in this
  binary, so the 64-bit-mantissa format is never actually materialised.
- `lua_Integer` returns in `edx:eax`, which are two ordinary registers in
  the `CpuState` — no modelling issue at all.

**Where it is lossy**: an arithmetic *chain* that hardware would have kept
at 64-bit mantissa between operations. On real x86 that does not happen
here either, because MSVC's CRT startup sets the x87 precision control to
53-bit (`_PC_53`), making the hardware round to double at every step — and
I measured that **this binary never executes `fldcw` inside a real function
body** (the 9 hits from a linear sweep are all data misdecoded as code; a
sweep restricted to Ghidra bodies finds 2, both with implausible operands
like `[ebx - 0x5425cc00]`). So the game never changes the precision it is
given, and in our port we are the one who gives it — the CRT is a DLL we
replace. The remaining honest gap is the **15-bit exponent range**:
overflow and underflow thresholds differ from binary64 at the extremes.
Marked as a known deviation, not measured against the oracle yet.

### 12.6 Closing the residual: code pointers as function starts

The 80 unlifted vtable targets and the 2,071 addresses the inventory never
knew about are all reachable evidence of function entries, so the start set
became the **union of the Ghidra inventory and every code pointer stored in
data** (26,241 entries).

| | round 2 (`gabs`) | **round 3 (`gu`)** |
|---|---|---|
| functions emitted | 21,375 | **23,381** (73 failed) |
| `.text` covered | 96.18% | **96.44%** |
| C emitted | 440.4 MB | 441.8 MB |
| **vtable slots whose target is lifted** | 5,985 / 6,415 (93.30%) | **6,408 / 6,415 (99.89%)** |
| all code-pointer targets lifted | 8,989 / 11,097 (81.0%) | **11,059 / 11,097 (99.66%)** |
| import shims bound | 587 | 591 |

**Seven vtable slots (6 distinct targets) out of 6,415 remain unlifted.**
That is the residual the coordinator asked for: after the dispatch table is
built, a virtual call has a 0.11% chance of reaching a target we do not
have, and each one is a named address that can be triaged by hand.

### 12.7 Byte-balanced translation units

`--split-bytes` replaces `--split N-functions`. Body sizes span 37 B (p50)
to 63,810 B, so splitting on count produced one 49.6 MB TU that alone took
247 s and 1.46 GB — half the build's critical path.

| | count-split (`gabs`) | **byte-split (`gu`)** |
|---|---|---|
| TUs | 45 | 37 |
| TU size min / median / **max** | — / — / **49.6 MB** | 3.6 / 12.3 / **12.5 MB** |

The largest TU shrank **4×**. Compile is already parallel, so this mostly
cuts peak memory and the tail latency of the slowest job.

### 12.8 Oracle replay at scale — a partial result, reported as such

`oracle_replay.py` + `oracle_replay.c` + `oracle_replay.mjs`: pick leaf
functions (no calls of any kind, so the module is self-contained), pull
`pure_only` vectors, replay each one in wasm, compare. **7,189 vectors
across 194 functions replay in a few seconds**, so this scales to the whole
binary — the mechanism works and it is the right correctness engine.

The result is **not yet a lifter accuracy number**, and it would be
dishonest to present it as one:

| comparison | functions passing |
|---|---|
| every register + `esp_delta` + memory writes | **74 / 194 (38.1%)** |
| EAX + `esp_delta` + memory writes only | **104 / 194 (53.6%)** |

Failure kinds at the looser setting: EAX 49, wasm trap 22, memory writes 18.

**Known harness gap, not (necessarily) a lifter gap.** The stable vector
schema exposes only `ecx`, `edx`, `stack` and `mem` as *inputs*, but
reports `ebx/esi/edi/ebp` as *outputs*. For a callee-saved register the
expected output is the oracle's own entry value, which the contract does
not publish — so my harness starts them at zero and every preserving
function mismatches. Tightening from EAX-only to all-registers costs
exactly 30 functions, which is that effect. The 22 traps are very likely
the same cause one step further on: a function that uses the caller's EBP
for locals dereferences `0 - 0x10`.

Three things this exercise did establish, all of them real:

1. **The replay harness found two bugs in itself before it found any in the
   lifter** — a field-by-field stream parser that drifted one dword and
   silently corrupted every later record (fixed by making the format
   length-prefixed and self-delimiting), and an incorrect guest frame
   (the oracle's stack top is `0x30001000`, entry ESP `0x30000FFC`, args at
   ESP+4 upward). Both produced confident, wrong numbers first.
2. **The guest image must not be lifted without being loaded.** Before
   `orc_load_image` existed, every vector trapped, because pointers read
   out of `.data`/`.rdata` were zero and the first dereference went out of
   bounds. Obvious in hindsight; it is the kind of thing a static argument
   never surfaces.
3. **Host-side state must live outside guest reach.** Running many vectors
   in one process, a lifted function's wild write corrupted the dispatch
   table itself: 1,429 vectors reported "not in module" purely as cascade
   damage, and running one vector per function made that number zero. In
   the real port the dispatch table, the CpuState and every host structure
   sit in the same wasm linear memory as the guest. **They need to be
   placed above the guest's plausible address range, or the first wild
   pointer in 7 MB of lifted code takes down the runtime rather than the
   guest.** That is an architecture requirement this exercise produced and
   nothing else would have.

**Next step, and it is cheap**: ask the oracle workstream to publish the
full entry register state (or to document a fixed seed for
`ebx/esi/edi/ebp`). That single field turns this from a 53.6% number with a
known confound into a real per-function accuracy figure over thousands of
functions.

## 13. Round 4: integration — the lifted module boots

First time any of this has run together. Lifted module (23,381 functions,
96.44% of `.text`) + host layer (`scripts/recomp/host/`, 8 TUs) + the
2.83 MiB segmented memory image, linked into one wasm module and executed.

```
python scripts/recomp/lift/mkstubs.py    --dir output/recomp/lift/gu --no-import-stubs
python scripts/recomp/lift/mkdispatch.py --dir output/recomp/lift/gu
emcc -O2 <39 lifted .o> <8 host .o> -sGLOBAL_BASE=268435456 \
     -sINITIAL_MEMORY=402653184 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576
node output/recomp/lift/boot/boot_integration.mjs \
     output/recomp/host/isaac.segs.bin main
```

**It links: 38,180,576 bytes, zero unresolved symbols.**

### 13.1 The first blocking VA

```
0x00aefa02   call 0xaf0645          ; -> jmp [0x00b18890] -> _set_app_type
```

- **Call site `0x00aefa02`**, inside `FUN_00aef9ff`.
- `FUN_00aef9ff` is **XI initialiser #2** — `[0x00b18c14] = 0x00aef9ff` — so
  the boot path got into the C static-initialiser table and the second
  entry is `__scrt_common_main_seh`'s startup helper.
- The host reports `0x00aefa07`, which is the *return address* the `call`
  pushed, not the call site. Both are useful; the instruction is at
  `0x00aefa02`.
- Reason: `api-ms-win-crt-runtime-l1-1-0.dll!_set_app_type`, verdict REAL,
  1 measured call site, **not implemented yet**. It is a host gap, not a
  lifter gap.

Everything before it worked, on real game code:

| step | result |
|---|---|
| place memory image | **50 segments** from `isaac.segs.bin` |
| layout check | **OK** (see 13.2) |
| verify placed image | OK |
| relocations | skipped (preferred base) |
| bind IAT | **622 / 622 slots**, 0 outside image |
| install fake TEB/PEB | `fs:[0]` chain head `0xFFFFFFFF` |
| **run TLS callback** | **`0x00aefec1` ran to completion** |
| `_initterm` XI | entered, blocked in entry #2 |

**The TLS callback at `0x00aefec1` is the first real, mechanically lifted
game code to execute end to end in this project**, through the host's IAT
binding and the dispatch table, and it returned normally.

`__RTDynamicCast` is not the wall yet — nothing gets far enough to reach
it. The wall is the CRT startup import surface, which is small and known.

### 13.2 Memory layout: verified in the running module

Adopted the host layer's map (`isaac_host.h`) rather than my earlier
`GLOBAL_BASE=13631488`, which put host state only 8 KiB above the image
end — one `.data` overrun from the runtime. Printed by
`isaac_layout_check()` from inside the linked module:

```
  image           0x00400000 .. 0x00cfe000
  guest heap      0x00d00000 .. 0x0cd00000
  guest stack top 0x0dff0000
  fake TEB        0x0e000000
  shim tokens     0x0f000000 .. 0x0f0026e0     (622 imports x 16)
  guard           0x0ff00000 .. 0x10000000     (1 MiB)
  host static     0x100387e4                   GLOBAL_BASE = 0x10000000
  host malloc     0x1013c7f8
  dispatch entries 23381
  layout OK
```

Guest regions are contiguous and low; every host byte is above a 1 MiB
guard. **Identity addressing is untouched** — the image is still real
linear memory at `0x00400000`, which is the whole reason the model works.
The guard is armed with a position-dependent pattern at boot and checked
after every stage; **intact after boot**. No address is hardcoded in the
lifter's integration code — it all comes from `isaac_host.h` macros, so a
later boundary move needs no change here.

### 13.3 The critical path to `main`, in order

One blocking VA is a fact; the ordered list of everything that blocks is a
work queue. `scripts/recomp/lift/mksurvey.py` generates a **survey build**:
strong overrides for the 601 imports the host has not hand-written, each
logging its symbol and guest call site once and then performing the
callee's own return using the host's **measured `arg_bytes`** — `ret 0` for
cdecl, `ret N` for stdcall — so the guest stack stays synchronised while
only the semantics are faked.

**This is a survey and its later entries are not trustworthy.** After the
first faked return the guest's state is a lie, so anything downstream may
be a consequence rather than a cause. The *order in which imports are first
demanded* is real evidence, and that is all it is offered as.

Result — the boot path demands exactly these, in this order:

| # | import | call site (ret) | conv | args | sites |
|---|---|---|---|---|---|
| 1 | `_set_app_type` | `0x00aefa07` | cdecl | 0 | 1 |
| 2 | `_set_fmode` | `0x00aefa12` | cdecl | 0 | 1 |
| 3 | `__p__commode` | `0x00aefa1e` | cdecl | 0 | 1 |
| 4 | `_crt_atexit` | `0x00aef596` | cdecl | 0 | 1 |
| 5 | `_configure_narrow_argv` | `0x00aefa4b` | cdecl | 0 | 1 |
| 6 | `InitializeSListHead` | `0x00aef955` | stdcall | 4 | 1 |
| 7 | `_controlfp_s` | `0x00af0524` | cdecl | 0 | 1 |
| 8 | `_configthreadlocale` | `0x00aefa84` | cdecl | 0 | 1 |
| 9 | `_initialize_narrow_environment` | `0x00aefa93` | cdecl | 0 | 1 |
| 10 | `InitializeCriticalSectionAndSpinCount` | `0x00aef1a3` | stdcall | 8 | 1 |
| 11 | `GetModuleHandleW` | `0x00aef1ae` | stdcall | 4 | 5 |
| 12 | `IsProcessorFeaturePresent` | `0x00af0256` | stdcall | 8 | 4 |
| 13 | `memset` | `0x00af027b` | cdecl | 0 | **444** |
| 14 | `IsDebuggerPresent` | `0x00af0322` | stdcall | 0 | 1 |
| 15 | `SetUnhandledExceptionFilter` | `0x00af0342` | stdcall | 4 | 3 |
| 16 | `UnhandledExceptionFilter` | `0x00af034c` | stdcall | 4 | 2 |

**All sixteen are CRT startup, and fifteen of them have a single-digit
call-site count.** None is a graphics, audio, Steam or Lua entry point.
`memset` is a musl forward. This is the entire critical path between a
linked module and `main`, and it is a day of host work, not a research
problem.

After #16 the survey stops on a different kind of blocker: the guest
executes `int 3`, which reaches the lifter's `swi` CALLOTHER intrinsic and
aborts. That is almost certainly **survey-induced** — faking
`IsDebuggerPresent` / `SetUnhandledExceptionFilter` /
`UnhandledExceptionFilter` walks the CRT into its `__scrt_fastfail` /
`__report_gsfailure` path, which ends in a deliberate breakpoint. It is
exactly the class of downstream artefact the survey warns about, and it is
why the strict build traps at #1 instead.

Two things the survey settles regardless:

- **`__RTDynamicCast` is not the wall yet.** It never appears. Nothing gets
  far enough. The wall is the CRT startup import surface above it.
- **`__CxxFrameHandler3` is not demanded either**, consistent with the
  independent finding that all 1,833 of its references are `jmp` tails of
  `__ehhandler$` trampolines and none is on a normal path.

### 13.4 Two integration bugs found by linking, not by reasoning


1. **Duplicate weak symbols.** Both layers emitted
   `__attribute__((weak)) imp_<stem>__<symbol>` for the same 591 imports.
   Two weak definitions do not collide — the linker silently picks one,
   and picking mine would have replaced the host's informative trap (which
   names the DLL, symbol, stdcall argument bytes and call-site count) with
   a bare abort. `mkstubs.py --no-import-stubs` now omits them entirely for
   integrated builds. Neither layer was wrong on its own; the defect only
   exists in the pair.
2. **The cdecl placeholder is gone.** `mkstubs.py` used to emit
   `s->EIP = MEMR32(s->ESP); s->ESP += 4;` for every import — correct for
   263 cdecl imports, wrong for 315 stdcall ones, and wrong *silently*: the
   guest stack ends up short by the argument bytes and every later frame is
   garbage. All placeholders now abort and name the symbol. A module that
   runs without its host layer should fail immediately, not drift.

## 14. Round 5: past CRT startup, into condition-variable detection

Rebuilt against the host layer with the 16 startup imports implemented
(`host_shims_crtstartup.c`) plus `__RTDynamicCast`, the guest heap arena
and the guarded `memset`. Strict build, no faking.

### 14.1 The new stopping point

```
0x00aef20b   push 7
0x00aef20d   call 0xaf0244        ; noreturn: fatal-exit path
0x00aef212   int3                 ; ExceptionAddress recorded here
```

Trap is reported at `0x00af0346` (returns to `0x00af034c`) —
`kernel32.dll!UnhandledExceptionFilter`, which the host deliberately traps
because there is no honest return value. **That is the messenger, not the
cause.** The host's exception dump names the cause:

```
[isaac][k32] UnhandledExceptionFilter(0x0dfedfc0) -- an exception escaped every handler.
[isaac][k32]   code 0x40000015 flags 0x00000001 at 0x00aef212, 0 parameters
```

`0x40000015` is `STATUS_FATAL_APP_EXIT` — the CRT deliberately aborting.

**Root cause: `FUN_00aef191`, the CRT's condition-variable feature
detection.** Fully disassembled:

| VA | instruction | outcome |
|---|---|---|
| `0x00aef19d` | `call [0xb181b4]` `InitializeCriticalSectionAndSpinCount` | ok |
| `0x00aef1a8` | `call [0xb18240]` `GetModuleHandleW(L"api-ms-win-core-synch-l1-2-0.dll")` | **NULL** |
| `0x00aef1b9` | `call [0xb18240]` `GetModuleHandleW(L"kernel32.dll")` | **NULL** |
| `0x00aef1c3` | `je 0xaef20b` | **taken -> fatal exit** |
| `0x00aef1cb` | `call [0xb182b0]` `GetProcAddress(h, "SleepConditionVariableCS")` | not reached |
| `0x00aef1d9` | `call [0xb182b0]` `GetProcAddress(h, "WakeAllConditionVariable")` | not reached |
| `0x00aef1fc` | `call [0xb181a4]` `CreateEventW(0,1,0,0)` | not reached — the fallback |
| `0x00aef20b` | `push 7; call 0xaf0244` | fatal exit |

**The single decision that stops the boot is `GetModuleHandleW(L"kernel32.dll")`
returning NULL at `0x00aef1b9`.** Returning NULL for the api-set DLL is
fine — the code is written to fall back — but returning NULL for
`kernel32.dll` too leaves it no path except abort.

The fix chain, in order, is fully determined by the disassembly:

1. `GetModuleHandleW(L"kernel32.dll")` returns a non-NULL pseudo-handle.
2. `GetProcAddress` for `"SleepConditionVariableCS"` / `"WakeAllConditionVariable"`
   may return NULL — the code checks both and falls through to `0x00aef1f5`.
3. `CreateEventW(NULL, TRUE, FALSE, NULL)` must return non-NULL, or the
   same `0x00aef20b` abort fires from one branch later.

That is three imports, and the binary itself specifies exactly what each
must do. Nothing here is a lifter problem.

### 14.2 What now works that did not

| | |
|---|---|
| 16 CRT startup imports | all execute, none trap |
| `_initterm` XI entry #2 (`FUN_00aef9ff`) | **completed** |
| progress inside XI | reached `FUN_00aef191`, several frames deeper |
| `__RTDynamicCast` | never reached — still not the wall |
| guard after the longer run | **intact** |
| `memset` guard / heap arena | not tripped |

Two of the host's honestly-partial shims reported their limits out loud
during the run, exactly as designed, and neither was fatal:

```
[isaac][crt] _controlfp_s(new=0x10000, mask=0x30000) asks to change the FP
             control word ... wasm has no x87 control word (caller 0x00af0524)
[isaac][k32] GetModuleHandleW("api-ms-win-core-synch-l1-2-0.dll") -> NULL
```

The `_controlfp_s` line is worth pairing with §12.5: the caller is
requesting `_PC_24`/`_PC_53` precision control, and this binary never
executes `fldcw`, so the request cannot be honoured and does not need to
be. The host logging it rather than silently ignoring it is what makes
that checkable.

**`_initterm` did not complete.** 121 static initialisers remain the
milestone; the run gets into the C table (XI) and dies inside its second
entry's callee tree, before the C++ table (XC) is reached at all.

**Heap high-water mark: not available.** `isaac_heap_report()` is wired
into the driver but the run traps before `main`, so no allocation traffic
of consequence has happened. The 64.0 MiB floor / 262.1 MiB ceiling band
stands unrefined.

### 14.3 The next work queue — and why it is static this time

**The survey build produced nothing new**, and that is the correct
outcome rather than a failure. It overrides only imports the host has NOT
hand-written; the blocker is `UnhandledExceptionFilter`, which the host
implements *and deliberately traps*, and the true cause is
`GetModuleHandleW` deliberately returning NULL. Faking either would mean
overriding a considered host decision from the outside — exactly the
"two mechanisms that happen to disagree" failure this project keeps
finding. So the dynamic technique is out of road until the host changes
that answer.

`scripts/recomp/lift/initterm_queue.py` gives the queue statically
instead: walk the direct-call graph from all **121** `_initterm` entries
and report every IAT import reachable, ordered by call depth.

**It over-approximates on purpose** — a call site on a branch never taken
still counts, and indirect calls are invisible to it. It is a priority
list, not an execution trace. 321 functions within depth 6, **67 distinct
imports**.

Depth 0 — called directly from an initializer body:

| import | table | site | measured sites |
|---|---|---|---|
| `strncpy` | XC | `0x0040688e` | 73 |
| `FlsSetValue` | XI | `0x00ae9a9e` | 7 |
| **`SteamAPI_RegisterCallback`** | XC | `0x0040697e` | 5 |
| `FlsAlloc` | XI | `0x00ae9a73` | 2 |

Depth 1 — the immediate next tranche, minus the 16 already done:

`GetProcAddress` (12 sites), `__stdio_common_vsprintf` (10),
`GetStdHandle` (2), `WriteConsoleA` (2), `CreateEventW` (1),
`__setusermatherr` (1), `_set_new_mode` (1), `_libm_sse2_sin_precise` (26),
`_invalid_parameter_noinfo_noreturn` (1458).

Depth 2 — the allocator and string core: `memset` (444), `memmove` (306),
`free` (283), `memcpy` (272), `malloc` (134), `?_Xlength_error@std@@YAXPBD@Z`
(38), `CloseHandle` (13), `GetCurrentProcess` (10), `LoadLibraryA` (9),
`toupper` (6), `_initialize_onexit_table`, `GetEnvironmentVariableA`,
`OpenProcessToken`, `strtol`, `GetSystemInfo`, `LookupPrivilegeValueA`,
`AdjustTokenPrivileges`, `GetLargePageMinimum`.

Depth 3-6 — `strstr`, `InitializeCriticalSection`, `strncpy_s`,
`QueryPerformanceCounter`/`Frequency`, `strcat_s`, `BCryptGenRandom`,
`_register_onexit_function`, `_CxxThrowException` (72),
`strncmp`, `GetLastError`, `VirtualAlloc`/`Free`/`Query`,
`OutputDebugStringA`, `Enter`/`Leave`/`TryEnterCriticalSection`, `Sleep`,
`TerminateProcess`, `GetNumaHighestNodeNumber`.

Three observations that change priorities:

1. **`SteamAPI_RegisterCallback` is a depth-0 static initializer.** A C++
   global constructor registers a Steam callback before `main`. Steam is
   not a late-stage concern that can be deferred behind the renderer.
2. **`LoadLibraryA` / `GetProcAddress` appear at depth 2 / 1.** Combined
   with the `GetModuleHandleW` blocker, the CRT and the game both do
   runtime feature detection, so the host needs a coherent story for
   "module handles and exported symbols" rather than per-call answers.
3. **`_CxxThrowException` at depth 4 with 72 sites.** C++ exceptions may
   be reachable during initialisation after all, which is a different
   claim from §5.3's "`__CxxFrameHandler3` is never on a normal path" —
   throwing and unwinding are separate mechanisms. Worth an early check.

### 14.4 Guard and heap

The guard held through both the strict and survey runs of the deeper boot:
**intact**, 0 corrupted words of the 262,144 checked, after 622 IAT binds,
a TLS callback and several frames of real CRT initialisation.

**Heap high-water mark: still unavailable.** `isaac_heap_report()` is
wired into the driver, but the run traps inside XI before any meaningful
allocation, so there is no number to report and the 64.0 MiB /
262.1 MiB band stands unrefined. It will come from the first run that
reaches `main`.

## 15. Round 6: the module layer clears the CRT, into the last XI entry

Rebuilt against the host layer with module handles, `GetProcAddress`
returning shim tokens, `CreateEventW`, and the depth-0/1 queue.

### 15.1 `_initterm` did NOT complete — but the CRT wall is gone

Stated plainly, because it is the milestone that was asked about: **the
121 static initialisers did not finish.** XC's 117 C++ entries were never
reached. What did happen:

- **XI entries 1-3 completed.**
- The run is inside **XI entry #4** — `[0x00b18c20] = 0x00ae9a40`, the
  `FlsAlloc`/`FlsSetValue` initialiser from the depth-0 queue — three call
  levels down at `FUN_00aea110`.

`FUN_00aef191`, last round's blocker, **now passes**. The module layer
behaved exactly as designed and the CRT took the fallback it was always
written to take:

```
[isaac][mod] 29 modules resolvable (EXE + 28 import DLLs); handles 0x0e010000..0x0e02d000
[isaac][mod] GetModuleHandleW("api-ms-win-core-synch-l1-2-0.dll") -> NULL  not one of the 29
```

`kernel32.dll` resolved, `GetProcAddress` returned NULL for both condition
-variable symbols, the code fell through to `CreateEventW`, and execution
continued past the function that aborted last round. **Making the rule
produce the blocker rather than special-casing it worked.**

### 15.2 The new stopping point

```
0x00aea116   lea eax, [ebp-8]
0x00aea119   push eax
0x00aea11a   call dword ptr [0xb18238]     ; kernel32!QueryPerformanceCounter
0x00aea120   mov eax, [ebp-8]              ; <- seeds a hash from the counter
```

- **Call site `0x00aea11a`** (host reports it correctly, with the return
  address `0x00aea120` alongside).
- IAT slot `0x00b18238`, `kernel32.dll!QueryPerformanceCounter`,
  **verdict=PROVIDED, 8 measured call sites** — classified as forwardable,
  not yet forwarded.
- Owner `FUN_00aea110`, reached from XI #4 `FUN_00ae9a40` at depth 3 via
  `FUN_00aea6b0`. Its body is a `lowbias32`-style avalanche
  (`imul 0x7feb352d`, `imul 0x846ca68b`) over the counter value — a seed
  generator, so a monotonic counter is all it needs.

`QueryPerformanceFrequency` (5 sites) sits at the same depth in the static
walk and should be done in the same change.

### 15.3 The module report is clean

```
[isaac][mod]   29 modules resolvable
[isaac][mod]   3 distinct NULL results:
[isaac][mod]          1 x  module not present: api-ms-win-core-synch-l1-2-0.dll
[isaac][mod]          1 x  kernel32.dll!SleepConditionVariableCS not provided
[isaac][mod]          1 x  kernel32.dll!WakeAllConditionVariable not provided
```

**All three are deliberate probes whose NULL the caller handles**, and the
disassembly in §14.1 proves it: the api-set miss drives the
`GetModuleHandleW(L"kernel32.dll")` retry, and the two missing symbols
drive the `CreateEventW` fallback at `0x00aef1f5`. **Zero unexplained
gaps.** The report is a to-do list that is currently empty, which is the
right shape for it to have.

### 15.4 Heap and guard

**Heap high-water: 0 bytes. 0 allocations, 0 frees.** The run still stops
before any allocation of consequence, so the 64.0 MiB floor / 262.1 MiB
ceiling band is **unrefined** and the 242 MiB reservation still cannot be
narrowed on evidence. `isaac_heap_report()` is wired in and printing; it
needs a run that reaches `main`.

**Guard: intact.** 0 of 262,144 words corrupted, now across a run that
resolves 622 IAT slots, executes a TLS callback, completes three static
initialisers and descends three frames into a fourth.

### 15.5 Still unverified, and why this run says nothing about it

`_libm_sse2_*_precise`'s XMM0 register convention is flagged UNVERIFIED
by the host layer. **This run provides no evidence either way**: those 26
sites are all in the XC table, and XC is never reached. The first run that
completes XI and enters C++ global construction is the one that will
exercise them.

Likewise `_CxxThrowException` (72 sites, depth 4): not reached, so the
"throw is plausible during initialisation even though unwind is not"
question stays open.

## 16. Round 7: the first lifter-side failure

Rebuilt against the host layer with the 371-trap sweep, deterministic
timing and the module layer.

### 16.1 `_initterm` still did not complete — and the failure changed kind

Plainly: **no. XC's 117 C++ entries were never reached.** But the failure
is now a different species, and that is the news.

`QueryPerformanceCounter` works, so `FUN_00aea110` (the QPC seed hash) and
everything above it now pass. Execution continues into
`FUN_00ae9cc0 -> FUN_00aea190 -> FUN_00aea6b0 -> FUN_00aea1b0 ->
FUN_00aea2a0`, and there it stops with a **raw wasm trap — "memory access
out of bounds" — inside lifted code**, not a host trap:

```
at boot.wasm.sub_00aea2a0  wasm-function[14759]
at boot.wasm.sub_00aea1b0  wasm-function[14758]
at boot.wasm.sub_00ae9cc0  wasm-function[14785]
```

**This is the first blocker in six rounds that is not a missing host
import.** Every previous one was "the host has not written this yet". This
one is the lifted code computing a pointer it should not have.

`FUN_00aea2a0` is **ChaCha20** — the `rol 16 / 12 / 8 / 7` quarter-round
pattern is unmistakable, over a 64-byte state copied in with four
`movups`. It is the CRT's internal RNG block function, refilled by
`FUN_00aea1b0` when its counter at `[esi+0x80]` runs out, and reached
because `FUN_00ae9cc0` reads `fs:[0x18]` (the TEB self-pointer) and
initialises the generator.

### 16.2 Bounds-checked lifted code, and instruction-level attribution

A wasm OOB trap names a function and nothing else. Two additions fix that,
both off by default and free in a normal build:

- **`-DRECOMP_MEM_CHECK=1`** makes every `MEMR*`/`MEMW*` validate the guest
  address against `[0x1000, ISAAC_HOST_BASE_VA)` and report width and
  direction before aborting.
- **`emit.py --trace-va`** emits `RECOMP_VA(addr)` before every
  instruction. `RECOMP_VA` expands to nothing unless `RECOMP_MEM_CHECK` is
  on, so the normal module is byte-identical; with checking on, a bad
  pointer names the instruction that computed it.

With checking enabled on the owning TU, the failure resolves from "OOB
somewhere in a 662-byte function" to:

```
[recomp][MEM] guest read of 4 byte(s) at 0x00000000 is outside the guest
              address space.
```

**A null-pointer read of exactly 4 bytes.** Not a wild pointer, not a
stack overrun: a dereference of NULL. That rules out the wide-varnode
(`movups`) path, which goes through `memcpy` on a 16-byte span and would
have reported 16 — the faulting access is an ordinary 32-bit load.

Attributing it to a specific guest VA needs the `--trace-va` build of the
whole module, which is what the tooling above exists for.

### 16.3 Symbol-table diff: clean

53 newly-strong host symbols were an opportunity for the duplicate-weak
defect that only exists in the pair. Measured with `llvm-nm` over the
built objects rather than by reading source:

| | |
|---|---|
| host strong symbols | 158 |
| host weak symbols | 625 |
| lifter weak symbols | 70 |
| lifter strong symbols | 11 |
| **host strong overriding a lifter weak** | **2** — `recomp_call_indirect`, `recomp_jump_indirect` (the intended contract) |
| **strong in both layers** | **0** |
| **weak in both layers** | **0** |

Clean. The two overrides are exactly the documented dispatch contract and
nothing else collides.

A different build defect did bite, and it is worth recording because it
cost a full run: the link script carried a **hardcoded object list** and
silently omitted `host_shims_forward.o` when that TU appeared. The run
then reported `QueryPerformanceCounter` as unimplemented when it had in
fact been implemented — a build-system lie that looked exactly like a
host gap. The script now globs and excludes, rather than enumerating.

### 16.4 Heap and guard

**Heap: still 0 allocations, 0 frees, peak 0 bytes.** The ChaCha20 refill
sits before any allocation of consequence, so the 64.0 / 262.1 MiB band is
**still unrefined** after five rounds. It needs XC.

**Guard: intact**, now across a run that additionally clears the module
layer, the deterministic clock and several more CRT frames.

### 16.5 What this run still says nothing about

`_libm_sse2_*_precise` (26 sites, XMM0 convention UNVERIFIED) and
`_CxxThrowException` (72 sites) are both XC-only. XC is not reached, so
**neither has any evidence yet**, and the questions stay open exactly as
they were.

## 17. Round 8: the wide-varnode gap closed, and a SLEIGH defect it exposed

The boot trapped on `sub_00ab2d80` because the lifter refused wide (>8-byte)
SSE varnodes in three places. This round closes them, and the harness built
to prove the new lowerings immediately found a *pre-existing* silent
miscompile that had nothing to do with them.

### 17.1 What the lifter could not do

`failures.txt` said `subreg size 16 unsupported` / `wide op ... size 16` and
nothing else. That message named the function but not the instruction, so
each one cost a probe script to locate; `_emit_all` now tags every
`LiftError` with the guest VA that raised it (`0x00ab2d80 at 0xab2f9e: ...`).
With that, the 49 failing bodies classify in one pass:

| gap | instructions | fix |
|---|---|---|
| CALLOTHER with a 16/32-byte operand | `pshuflw` `pshufhw` `pmulld` `pshufb` `pmovsxwd` `pmaddubsw` `maxps` `minps` `pabsd` `vpcmpeqb` `vpinsrd` `vcvtt*` … | new `recomp_otherw_*` convention |
| `INT_NEGATE` size 16 | `pandn` (`~XMM` before the AND) | `recomp_wide_not` |
| `SUBPIECE` with a >8-byte *output* | the xmm half of a ymm | `memcpy` slice |
| 6-byte `LOAD` | `les` / `lds` | **not fixed** — 2 bodies, both data misdecoded as code |

**47 of the 49 now lift**, including `sub_00ab2d80` and the three sibling
`psrad` functions. The two survivors are the far-pointer loads.

### 17.2 The wide CALLOTHER convention

The existing `recomp_other_*` intrinsics are `uint32_t`-shaped, which is why
the MMX ones are documented as lossy. An XMM operand cannot travel that way
at all, so wide sites get a parallel namespace:

```c
void recomp_otherw_pshuflw(CpuState *restrict s, uint8_t *out, unsigned outsz,
                           const uint8_t *a0, unsigned a0sz,   /* old dest */
                           const uint8_t *a1, unsigned a1sz,   /* source   */
                           const uint8_t *a2, unsigned a2sz);  /* imm8     */
```

Every operand is (pointer, byte size). Small operands are materialised into
temps by the existing `anyptr`, so one shape covers mixed widths — the imm8
of `pshuflw`, or `vcvttss2usi`'s 4-byte output from a 16-byte input. SLEIGH
passes the **old destination first** for the two-operand x86 forms
(`XmmReg1 = op(XmmReg1, XmmReg2_m128)`), which matters for the ops whose
result ignores it, `pmovsxwd` among them. Callees must be alias-safe:
`XMM0 = pshuflw(XMM0, XMM0, imm)` hands one pointer three times.

`mkstubs.py` emits weak self-naming aborts for the rest, so a wide intrinsic
the port actually executes fails loudly at its own name rather than silently.
Only `pshuflw` and `pshufhw` are implemented — they are what the boot needs;
the other 28 declared names stay stubs until something reaches them.

### 17.3 The harness: one instruction at a time

Whole-function replay could not verify any of this. All four `psrad`
functions call other functions, so a mismatch there names a function, not an
instruction. `scripts/recomp/oracle/wideops.py` instead:

    assemble one instruction -> lift it with the REAL lifter
                             -> compile with the REAL recomp_rt.c
                             -> run over N random XMM inputs
                             -> diff against Unicorn on the same inputs

12 instructions × 200 vectors, `tests/recomp-wideops.test.js`, 2.7 s. Four
of the twelve are **controls** (`paddd` `pxor` `pand` `movdqa`) whose
lowerings the boot already exercises: if the harness breaks, they go red
too, so a green run cannot mean "nothing was compared". Mutation-checked —
masking `pshuflw`'s selector to 1 bit reddens `pshuflw` alone; making
`recomp_wide_not` a copy reddens `pandn` alone.

### 17.4 The defect it found: `PSLLD` / `PSLLQ` shift by the wrong count

Ghidra's `ia.sinc` gives the xmm left shifts a **per-lane** count:

```
:PSLLD  XmmReg1, XmmReg2 { XmmReg1[0,32]  = XmmReg1[0,32]  << XmmReg2[0,32];
                           XmmReg1[32,32] = XmmReg1[32,32] << XmmReg2[32,32];
                           ... }
```

The hardware shifts **every lane by the low 64 bits of the source**, zeroing
lanes when that count exceeds the lane width. The right shifts in the same
file save the count into a local first (`local count:8 = XmmReg2[0,64];`)
and are correct; only the left shifts are wrong. `vpsllv*`, which *is*
genuinely per-lane, is a pcodeop, so it cannot be confused with this.

This is not theoretical. The binary has **12 real `pslld xmm, xmm` sites**
(0x926623, 0x92663f, 0x92665e, 0x926677, 0xad18a7, 0xad18d6, 0xad18f9,
0xad1915, 0xad1b17, 0xad1b46, 0xad1b69, 0xad1b85), all in vectorised index
arithmetic of the form `movd xmm2, ecx` → `pshufd` → `paddd` → `pslld` →
`paddd` → `movups`. Because the count register is loaded with `movd`, lanes
1..3 hold **zero** — so the defect leaves three of every four lanes
unshifted and writes them to the output array. No trap, no wrong-looking
control flow: exactly the failure mode that survives a boot-to-completion
test and corrupts data.

`packed_shift_defect()` recognises the shape — N consecutive same-size lane
`INT_LEFT`s whose count operands are the matching consecutive lanes of one
register — and the lowering then reads the count once as a 64-bit value,
clamped to the lane width (`recomp_shl*` already returns 0 at or above the
width). The shape test is what makes it safe: it cannot fire on a shift that
is per-lane by design.

**How it was found matters.** No amount of reading the lifter would have
surfaced it; the p-code was lowered exactly as SLEIGH wrote it. It took an
oracle at instruction granularity, and it was found within a minute of the
harness first running — against ground truth the project already had but had
never pointed at a single instruction.

### 17.5 The re-lift, measured

Full re-lift of the 16,282-VA inventory (400 s) into `output/recomp/lift/gu2`:

| | Aug-10 `gu` | this round |
|---|---|---|
| lifted | 23,381 | **23,411** |
| lift failures | 73 | **26** |
| `.text` coverage | 96.44% | **96.74%** |
| missing callees | 36 | **14** |
| wide CALLOTHER kinds declared | — | 30 (2 implemented) |

The 26 survivors are 22 `BadDataError` (SLEIGH cannot decode the body at
all), 2 bodies over the 20,000-instruction cap, and the 2 far-pointer loads.
**No wide-varnode failure remains.**

The packed-shift correction fires on exactly **48 lanes = 12 sites × 4**,
matching the independent byte-pattern census of `pslld xmm, xmm` in `.text`.
That equality is the evidence the shape test does not over-fire: if it
matched anything else in 2.02 M instructions, the count would be higher.

### 17.6 Reproducibility gap closed, and two traps in the rebuild

The `gu` module directory recorded what was produced but not how. Rebuilding
it meant reconstructing the invocation from `requested` counts and TU sizes,
and the first two attempts were wrong in ways the module only reveals at
compile time. `summary.json` now carries `argv`, and the boot lift is:

```bash
python scripts/recomp/lift/emit.py --exe tools/isaac-ng.unpacked.exe     --ghidra-functions output/recomp/export/functions.jsonl     --fragments-tsv    output/recomp/export/recovered-functions.tsv     --imports          output/recomp/census/imports.json     --shim-table       output/recomp/host/shim-table.json     --va-file          output/recomp/lift/starts_union.txt     --hand-written     scripts/recomp/host/src/missing_fns.c     --dispatch auto --max-insns 100000 --split-va 0x30000 --trace-va     --out output/recomp/lift/gu --module lifted     --stats output/recomp/lift/gu/stats.json
python scripts/recomp/lift/patch_reentry.py --dir output/recomp/lift/gu     --exe tools/isaac-ng.unpacked.exe
python scripts/recomp/lift/build_boot.py --dir output/recomp/lift/gu
```

**`--trace-va` is not optional for the boot.** It is documented as a
debugging aid, but `RECOMP_VA(...)` is also the *marker* `patch_reentry.py`
and `mkdispatch.py` scan to find call continuations. Lift without it and
`mkdispatch` reports `re-entry blocks: 0`, emits the re-entry dispatcher
against `G_NBLOCK` / `g_bva` / `g_bfn` that the `blocks`-guarded branch never
declared, and `dispatch_tbl.c` fails to compile. (`LIFT_CFLAGS` also carries
`-DRECOMP_MEM_CHECK=1`, so the markers are live in the boot build anyway.)

**`--hand-written` is new, and it encodes an invariant that was previously
maintained by hand.** `scripts/recomp/host/src/missing_fns.c` carries six
instruction-by-instruction transcriptions of callees the lifter could not
produce, and their contract is "weak aborting placeholder in `stubs.c`,
strong definition here". Round 8 made **five of the six liftable** — which
would have made both layers define the same symbol strongly. Worse, the
lifted bodies of those five reach `vcvtqq2pd` / `vpinsrd` / `vcvtt*2usi`,
which are declared wide intrinsics with no implementation, so promoting them
would have traded a verified transcription for an abort. The flag reads the
VA set out of `missing_fns.c` itself, so there is one source of truth: what
that file defines, the lifter does not emit. It also fixes a latent hole —
`0x00aa9350` has no direct caller (it is reached through a data slot), so it
never appeared in `refs`, and its declaration had been added to
`lifted_decls.h` by hand. It is now emitted like any other missing callee.

### 17.7 The boot after the re-lift

`sub_00ab2d80` lifts, so the trap it caused is gone. Rebuilt (`liftCompile
575.8 s`, `link 425.5 s`, **272,269,106 B wasm, 0 undefined, 0 duplicate
symbols**) and re-run, the boot goes far past where it stopped:

- Steam context faked, **EOS SDK** `EOS_Initialize` / `EOS_Platform_Create`
  stubbed (the game handles the null platform handle and shuts EOS down),
- GL 4.6.0, **`SwapBuffers` called twice** — frames are being presented,
- libtheora 1.2.0alpha and libvorbis 1.3.4 initialise,
- `CreateThread`, `timeBeginPeriod`, `DragAcceptFiles`, 1,997 stub calls
  across 14 distinct symbols (899 of them `EnterCriticalSection`),
- **the guest heap is live for the first time**: 31,423 allocs / 8,431
  frees, peak 53.5 MiB, largest single 6.7 MiB, 2 failures — earlier rounds
  reported "0 allocations, peak 0 bytes",
- the version banner prints: `Binding of Isaac: Repentance+ v1.9.7.17.J460`,
- guard intact after `main`.

**New stopping point, and it is not the lifter.** After the Lua layer fails
to find `resources/scripts/main.lua`, the game re-opens the packed archives
and **every open fails**, including the five that were seeded and read
successfully during asset load:

```
[odsa] [ERROR] - Failed to open archive file 'resources/packed/animations.a'
   ... config.a, fonts.a, graphics.a, music.a, rooms.a, sfx.a, videos.a, afterbirth.a
```

33 `AnmCache failed to load` follow, and the HUD path dereferences the null
ANM2 at **`0x009a26c2`** (`guest read of 4 bytes at 0x30`). Two things are
mixed together there and should be separated before either is "fixed":
`music.a`, `sfx.a`, `videos.a` and `afterbirth.a` are **never seeded**
(`BOOT_ARCHIVES` in `boot_integration.mjs` lists five), while `graphics.a`
and `animations.a` **are** seeded and still fail this second open — so the
shim FS is refusing a re-open that the first pass allowed. That is the next
unit, and it is a host-FS question, not a lifting one.

## 18. Round 9: the archive blocker, located exactly

Round 8's entry called this a *re-open* failure — archives seeded and read
during asset load, then failing a second open. **That was wrong**, and the
tools built here disprove it: there is no earlier successful archive open in
the run at all. What follows is what the evidence actually says.

### 18.1 Two tools, because guessing was the expensive part

- **`ISAAC_FS_TRACE=1`** (`host_shims_fs.c`) logs every path the FS shim is
  asked about and what it answered, for `fopen`, `GetFileAttributesA` and
  `FindFirstFileA`. Off by default: the boot makes thousands of FS calls.
- **`ISAAC_DUMP32=0xc379e8:4,0xc37b14:2`** (`boot_integration.mjs`) prints
  guest dwords *after* `main` traps. The guest address space is identity-
  mapped into the wasm heap and the harness still holds the module after the
  abort, so any engine static can be read back **without relinking the
  272 MB module to add a printf** — which is what makes this affordable at
  ~7 minutes per host-only rebuild.

### 18.2 What the trace actually shows

**The archives are never `fopen`ed.** The complete list of FS probes in a
boot run is 16 lines: the save-data directory setup, `savedatapath.txt`,
`log.txt`, `kage_mount_points.dat` (twice), the two Lua scripts, and
`options.ini`. `resources/packed/animations.a` is never asked for.

So `Failed to open archive file` is decided entirely inside the guest, before
any I/O. The path is `0x00a179c0` (the error printer) → `0x00a17180` → for a
relative path `0x00a16c60`, which resolves **only** through a per-mount-root
`std::map` keyed by a case-insensitive path hash (`0x00a159d0`, djb2 seeded
0x1505, backslash folded to slash). There is no physical-file fallback on
that path.

Read back from the trapped run:

| static | value | meaning |
|---|---|---|
| `[0x00c379e8]` / `[0x00c379ec]` | `0x00d09ca4` / `0x00d09ca8` | mount-root vector: **exactly one root** |
| root object `0x00d09c2c` | vtable `0x00b81cf8` | |
| map at `0x00d09c30` | head `0x00d09c4c`, **`_Mysize = 0`** | the root's index is **empty** |
| `[0x00c37b14]` | **0** | zero archives loaded |

`0x00a16c60` therefore skips the loaded-archive lookup (guarded on
`[0x00c37b14] > 0`), searches the one root's empty map, misses, runs out of
roots and returns 0. Every archive fails identically, 33 `AnmCache` loads
fail behind them, and the HUD dereferences the null ANM2 at `0x009a26c2`.

The single root is mounted unconditionally by `0x009abbd0` (called from
`0x009aa040` at `0x009aa74c`) from the **empty string** at `0x00b1a4ec`, and
mounting does not scan: `0x00a16e00` is 54 instructions and touches no FS
API. So nothing has ever populated that map.

**Where to resume.** Two threads, both inside the guest: (1) what fills a
mount root's map — until something does, no relative path resolves; and
(2) the archive list itself. `0x009aa040` walks a linked list at
`[0x00bfae60]` calling `0x00a179c0` per node, and that cell has **no writer
in `.text`** (so it is either NULL at this point or written through a
register-held pointer). Note `0x00a17180` has a second branch: an absolute
drive-letter path skips the VFS entirely, which is a lever if the archive
names can be made absolute.

### 18.3 One real defect found and fixed along the way

`fs_key` collapsed separators and stripped a *leading* `./` only when
something followed it, and never collapsed a `.` segment elsewhere. So the
game's probe of its own working directory, `GetFileAttributesA("./")`,
normalised to the key `c:/isaac/.` and missed — the shim reported "no such
directory" for the directory every other path resolves against. `.` segments
now collapse (with the leading `/` of an absolute path preserved), pinned by
five new host-selftest checks (**77 → 82 checks, 0 failures**) and
mutation-checked: reverting the collapse reddens four of the five.

It is a genuine fix and it changes the trace — `./` now answers `DIR`, and a
malformed doubled-USERPROFILE probe disappears — but it is **not** the
archive blocker, which is unchanged. Recorded as such rather than as
progress toward the trap.

## 19. Round 10: the archive blocker, fixed — three host-shim defects and a seeding gap

Round 9 located the failure inside the guest (§18: the mount-root's index
is empty, so no relative path resolves) and left two threads. Both are
closed, and the "no writer in `.text`" thread turns out to be a non-issue.

### 19.1 Thread 2 dissolves: the archive list is static data

`[0x00bfae60]` is **file-backed** `.data` holding `0x00c04ea4` — the head of
a static linked list of the 18 archive names (`resources/packed/*.a`,
`packed/repentance_*.a`, `secret.a`, all present as `.rdata` strings at
`0x00b80620..0x00b807c4`). Nothing needs to write it. `pequery.py u32
0xbfae60 / xrefs-to 0xbfae60` settles it in one call.

### 19.2 Thread 1, read from the decompiles: the index is a directory scan

KAGE init (`0x00a710a0`, "KAGE has already been initialized") creates the
default mount root through `0x00a15f10`: a 0x14-byte object `{vtable
0xb81cf8, map head, map size, name, aux}` with an MSVC `std::map` header
(`_Left=_Parent=_Right=self, Color/Isnil = 0x0101`), then calls **vtable+8
(`0x00a15d20`) → vtable+0x18 (`0x00a687f0`) = Scan(root->name, "")**. Scan
lists a directory through `0x00a172e0`, a `readdir` wrapper over
`0x00a16f50` (`opendir`), hashes every FILE entry's relative path with the
djb2 at `0x00a159d0` (seed 0x1505, `h*33+c`, lowercase, `\`→`/`) and
inserts `hash → path` into the root's map (`FUN_00651990`), recursing into
DIR entries. The resolver `0x00a16c60` looks that map up for every relative
path — so the map is the physical-file index, built once at init.

`0x00a16f50` is the whole story: `mbstowcs_s(dir)` → `GetFullPathNameW(name,
0, NULL, NULL)` (size query) → `malloc(n*2+0x10)` → `GetFullPathNameW(name,
n, buf, NULL)` → append `\*` → **`FindFirstFileW`**; the loop in `0x00a172e0`
then calls **`FindNextFileW` through a register-held import** (`mov edx,
[0xb1825c]` @`0x00a17369` — which is why the call-site census recorded that
import as never called) and narrows every `cFileName` with `wcstombs_s`,
storing `*pReturnValue - 1` as the name length. The find data sits at
DIR+0x218 (`cFileName` @+0x244 = +0x2c, `cAlternateFileName` @+0x44c =
+0x234); attribute 0x10 → dir, 0x40 → device, else file.

The mods scanner uses `FindFirstFileA` directly, which is why the round-9
trace showed A-probes for `mods/` and `online_logs/` but nothing for the
root: three shims on the W path were wrong, in this order of discovery:

| shim | defect | effect |
|---|---|---|
| `GetFullPathNameW` | returned 0 for the size query (NULL/0 buffer) and for a too-small buffer, instead of the required WCHAR count incl. terminator | opendir's second call saw `n == 0`, failed with errno 2; `FindFirstFileW` never reached — the trace's silence was one call earlier than the stub |
| `FindFirstFileW` | untraced stub returning `INVALID_HANDLE_VALUE` | scan empty even once the pattern was built |
| `FindNextFileW` | weak default (`NEVER_CALLED`, purge `0xFFFF`) | `isaac_indirect_call` would trap on return ("stack purge is unknown") at the first directory with two entries |
| `wcstombs_s` | weak default (`NEVER_CALLED`) | names never came back |

All four are now real (`host_shims_fs.c`, `host_shims_conv.c`), the shim
table carries `FindNextFileW` = stdcall 8 / PROVIDED and `wcstombs_s` =
PROVIDED (`gen_shims.py` curated entries explain the register-held call),
and `ISAAC_FS_TRACE=1` logs the W probes. Host selftest **82 → 103 checks,
0 failures**: each link of the chain is exercised against the same RAM-FS
the game sees (wide backslash-star pattern → attr/size/alt-name → `wcstombs_s`
length incl. terminator → `FindNextFileW` → exhaustion → `FindClose`; the
root pattern `c:/isaac/./*` lists `resources` as a directory; the
`GetFullPathNameW` two-call protocol; 700 files in one directory enumerate
and open). Mutation-checked through `scripts/decomp/mutate.mjs`: dropping
the dir attribute, reporting the length without the terminator, never
advancing `FindNextFileW`, returning 0 on the size query, and a 128 per-scan
cap each redden the selftest and were restored hash-verified.

### 19.3 The seeding gap: the install is not only archives

With the scan live the six seeded archives open and register (`[0x00c37b14]
= 6`; graphics.a is `fopen`ed 2,301 times = its TOC count + 1, sfx.a 302,
config.a 25 — KAGE opens the archive once per member to verify each
checksum). But `animations.a` in this instance has **TOC count 1**: a single
4 MB type-1 (compressed) bundle. The `.anm2` files the AnmCache asks for by
path (`gfx/ui/ui_streak.anm2`), the GLSL sources the shader init logs as
failed (`resources/shaders/*.vs`), and the Lua scripts (`resources/scripts/
main.lua`) are **loose files** under the install's `resources/` tree — 476
files, 38 MB, all present in `.scratch/game-instance/resources/` — and only
the archives had been seeded. `boot_integration.mjs` now seeds that whole
tree (everything except `packed/`, which is seeded by name) and the RAM-FS
grew from 512 to 8,192 slots with a 2,048-entry per-scan cap (`gfx/ui` alone
has 143 children; the old caps overflowed silently).

One consequence of the link flags: the host Lua module's libc is
`-sNODERAWFS=1`, so `luaL_loadfilex("resources/scripts/main.lua")` opens
the **real** filesystem relative to `process.cwd()`, not the RAM-FS. Run the
boot with cwd = the instance dir and the game's Lua init finds its scripts;
the driver prints the exact command when the cwd is anything else.

### 19.4 The last third of the blocker was our own patch

With the scan and the seed in place the six archives registered
(`[0x00c37b14] = 6`) but every `.anm2` still missed. Archive members are keyed
by their **full** path — `djb2("resources/gfx/ui/pausescreen.png")` is
graphics.a entry 1835 and its second hash is the FNV-1a (`0x00a15ab0`) of the
same string; 122 loose files match TOC entries 1:1 — while the AnmCache asks
for `gfx/ui/ui_streak.anm2` and prefixes each *mount-root name* from
`[0x00c798b8]` (`0x0040db90`). So a root named `resources/` must exist. The
function that creates it, `0x009ab970`, reads `xor eax, eax; ret` — and
`tools/isaac-ng.unpacked.exe.pre-coinit` has `push ebp; mov ebp, esp` there.
It is one of this project's own 19 emulator-era patch runs (172 bytes; the
full list is a two-file diff, reproduced in §19.5), and it silently disabled
the whole relative-path VFS. The fix is a **lift patch**
(`scripts/recomp/lift/lift_patches.py`, applied by `build_boot.py` after every
lift): the generated `sub_009ab970` emulates the two lost instructions and
enters the lifted orphan body `sub_009ab973`; one TU recompiles, the canonical
hash is untouched.

> **Superseded in round 11 (§21):** the patch is load-bearing for this
> instance, which is a ResourceExtractor dump rather than a Steam layout, and
> the override was removed again. The scan/seed fixes above stand.

**Round-10 result** (`boot_integration.mjs` from the instance dir, seeded
archives + loose tree): two mount roots, **0 `Could not open`** (every
`.anm2` loads; previously 33+ failures and the null-ANM2 trap at
`0x009a26c2`), the complete shader set initialises (Water/Mirror/Heat
Wave/Hallucination/Dizzy/… — previously "Failed to load vertex shader"),
renderbuffers allocate, OpenAL and theoraplayer initialise, and
`resources/scripts/enums.lua` + `main.lua` run to completion. The boot now
stops at the first **msvcp140.dll** call: `std::basic_ios<char>::basic_ios()`
from `0x00684d24` inside `0x00684ce0`, a `std::stringstream(const string&)`
constructor called by `0x0067f420` right after `buttonpromptwidget.anm2`
loads. The C++ standard-library iostream ABI is the next host layer: 54
msvcp140 imports (~180 call sites), five stream constructors
(`0x00414330`, `0x00684ce0`, `0x008fb120`, `0x009036b0`, `0x009e8010` — the
last opens an `fstream` through `_Fiopen`). The 32-bit reference is
`C:\Windows\SysWOW64\msvcp140.dll`.

### 19.5 Build speed: the 8-minute link was wasm-opt

`build_boot.py` linked at `-O2`, which runs wasm-opt over the 272 MB module
(474 s of a 520 s host-only relink). The lifted objects are already `-O2`, so
the link now defaults to `-O0` (`--opt-link` restores the shipping link):
**link 474 s → 8.0 s, relink 520 s → 133 s** (25 s dispatch generation +
19 s host compile + 67 s for a single recompiled lifted TU + 8 s link;
module 272 → 284 MB). A host-only iteration is now ~2 min instead of ~9.

The project's patch runs against the pristine snapshot (all in `.text` unless
noted; `pequery.py func <va>` names the owner):

| VA | pristine → patched | effect |
|---|---|---|
| `0x006f5198`, `0x007ea7ce`, `0x007eabfe`, `0x007eac91`, `0x007eae2a`, `0x007eae55`, `0x007eaedb`, `0x007f7512`, `0x009517fc` | `cmp [esi+0x38],0; jne; cmp [esi+0x3c],0; je` → `test esi,esi; je …; cmp [esi+0x38],0; je …; nop` (12 B each) | null-guarded field tests (menu/input paths) |
| `0x00931146` | `call [0xb189f4]` → `add esp,4; xor eax,eax; nop` | CoInitialize killed |
| `0x009ab970` | `55 8b ec` → `33 c0 c3` | **resources/ mount root never created — undone by the lift patch** |
| `0x00a19340`, `0x00a193c0` | prologue → `mov eax, 0x3c0 / 0x21c; ret` | forced window metrics 960 / 540 |
| `0x00a2b5c2` | `cmp byte [ebp+0x14],0; je` → `jmp +0x117` | branch forced |
| `0x00a8062d` | `push 0xba3cfc; mov [0xc75ab4],eax; call ebx` → `mov [0xc75ab4],eax; xor eax,eax; nop×5` | atom registration killed |
| `0x00a80d30` | prologue → `xor eax,eax; ret` | function stubbed |
| `0x00a81390` | `0x20` → `0x00` | one byte |
| `0x00a8c5a7` | `cmp [eax],0; je +0x36` → `jmp +0x39; nop×3` | branch forced |
| `0x00ba3da6` (.rdata) | `\0\0Win3` → `00\x00` | string edit |

Each of these was made for the BoxedWine emulator phase; under the recompiled
boot the host shims own Win32, so every one is a candidate for the same
`lift_patches.py` treatment when it is shown to block something.

## 20. Round 10b: the C++ iostream layer, and a general baked-purge bug

The round-10 boot stopped at `msvcp140!basic_ios<char>::basic_ios()`. Two
pieces landed; a third is named exactly.

### 20.1 The msvcp140 shim layer

`scripts/recomp/host/src/host_shims_msvcp.c` re-implements the streambuf /
basic_ios / istream / ostream / iostream members the game reaches, on the
**exact MSVC x86 object layout** (transcribed from
`C:\Windows\SysWOW64\msvcp140.dll` 14.44; the disassembly-tagged notes are
`output/decomp/_scratch/msvcp140/abi-notes.md`). It is not a call into the
DLL: the game's own `basic_stringbuf` overrides are lifted (its vtable is at
`0xb1b190`), and the game manipulates the stream objects' fields directly, so
every shim (a) locates the `basic_ios` virtual base as `this + [[this]+4]`,
never by a constant, so a game-side `stringstream` (basic_ios at +0x68) works
unchanged; (b) touches the streambuf only through its six indirection
pointers, which a stringbuf redirects with setg/setp; (c) dispatches the
streambuf virtuals (overflow +0xc, underflow +0x18, uflow +0x1c, sync +0x34)
through the object's real vtable into lifted game code, recognising the
base-class defaults by their IAT jump thunks at `0x00aef065..0x00aef0a1`. C++
exceptions (`_Xlength_error`, …) abort loudly: there is no unwinder. Proven
by 24 host-selftest checks (**103 → 127**) over a synthetic stringstream on
the game's layout — construct, `_Ipfx` whitespace skip, `operator>>` integer
parse, `sgetc/sbumpc/snextc`, an empty get area dispatching uflow through the
vtable, `operator<<` hex/showbase/width/fill formatting, `write`/`put`, a full
put area dispatching overflow, `flush`, and the three-vtable destruction — and
mutation-checked (`sgetc` ignoring the count, `>>` dropping eofbit, `<<`
keeping width, the iostream vtordisp) through `scripts/decomp/mutate.mjs`.

### 20.2 The lifter bakes host-import stack purges — and a stale one corrupts

The shim layer was correct but the boot faulted anyway, in
`operator>>(istream&, string&)`, reading a `rdbuf` of `1`. The stringstream's
`_Mystrbuf` had been set to `1` by our own ctor, which had received `sb == 1`.

Root cause: **the lifter bakes each direct host-import call's stack purge into
the caller at lift time**, read from the shim table —
`imp_X(s); s->EIP = MEMR32(s->ESP); s->ESP += 4u + <purge>u;`. The push-count
sweep (`gen_shims.py`) miscounts `__thiscall` constructors whose arguments are
set up inline at the caller: it read `basic_ios()` (`@@XZ`, zero args, should
pop 0) as purge **32**, and four others wrong. The lifted stringstream ctor
therefore over-popped 32 bytes after `basic_ios()`, so the following
`basic_iostream(sb, most)` args were read from a shifted stack (`sb == 1`).

`gen_shims.py` now curates the correct purge for the five ctors, but re-lifting
the whole 272 MB image to change a 4-byte constant per call site is wasteful.
`scripts/recomp/lift/lift_patches.py` gained `PURGE_PATCHES`: it rewrites the
baked constant in place at each call site (12 sites: 5+4+1+1+1) and drops the
touched TU's object, exactly like the `0x009ab970` prologue patch —
`build_boot.py` then recompiles only those 4 TUs. With it, construction is
correct (`sb`, `_Mystrbuf` = the real streambuf) and the boot advances through
the stringstream construction and the first `operator>>` parse.

This is a general hazard: **any host import whose purge was wrong at lift time
has a stale baked value.** When you correct a purge in `gen_shims.py`, add the
`(wrong, right)` pair to `PURGE_PATCHES` (or re-lift). `lift_patches.py
--check` reports which sites still carry the old value.

### 20.3 The "callee-saved register leak" was one of round 10b's own purge corrections (round 11)

After 20.2 the boot faulted just after the first `operator>>` returned, in
the tokenizer `0x0067f420` at `0x0040cf50`, with the caller's `esi` a
misaligned `0x0dfc4b2f`. The round-10b note here blamed a lifter defect
(first the `_Lock`/`_Unlock` tail-jump thunks, then "some call does not
preserve esi/edi/ebx") and proposed a register-preservation trace. Neither
was needed; the fault image already held the answer:

- `ISAAC_DUMP32=0xbf93b4:1` read the live security cookie: `0xbb40e64e`.
- The register image at the trap had `EDI = 0xb6bcaf2e` — and
  `0xbb40e64e ^ 0x0dfc4960 == 0xb6bcaf2e`, i.e. **EDI held a frame's
  `cookie ^ ebp`**, the value MSVC pushes right after the callee-saved
  registers. The frame at `ebp = 0x0dfc4960` is the `std::stringstream`
  ctor `0x00684ce0` (the tokenizer calls it with `esp = 0x0dfc4968` after
  `sub esp,8; push ecx`). So that ctor's epilogue (`pop ecx; pop edi; pop
  esi; pop ebx; mov esp,ebp; pop ebp; ret 0xc`) ran with ESP **one slot
  low**: `edi` ← cookie, `esi` ← saved edi, `ebx` ← saved esi; `mov esp,
  ebp` then hid the drift from ESP itself, which is why the ESP-only trace
  in 20.2 looked balanced.
- Inside `0x00684ce0` the only ESP movements are three baked import purges
  (20.2) and a `call 0x40cf00`/`memcpy`/`add esp,0xc` group. The baked
  purge for `??0basic_iostream(streambuf*)` at `0x00684d40` was `4` — the
  round-10b *curated* value — while the caller pushes two dwords (`push 0;
  push edi`) and msvcp140's callee is `ret 8`. The round-10b abi notes
  themselves record it (`output/decomp/_scratch/msvcp140/abi-notes.md`
  §1.5: "`ret 8` (sb, most_derived)"), and the shim reads the second arg
  (`isaac_arg(cpu, 1)`): **constructors of classes with a virtual base take
  a hidden trailing `int most_derived` that the callee pops.** The
  decorated-name sum used to curate the purge does not include it. The same
  mistake was made for `??0basic_ostream(streambuf*, bool)`: curated 8,
  real `ret 0xc`. The push-count sweep had measured both correctly (8 and
  12); the curation overrode a correct measurement.

Fix: `gen_shims.py` `CURATED_PURGE` carries 8 / 12 with the reason, and
`lift_patches.py` `PURGE_PATCHES` maps `(4 → 8)` / `(8 → 12)` so a tree
lifted before the correction is repaired in place (5 call sites; on a fresh
lift the corrected table bakes 8 / 12 and these entries match nothing).
`lift_patches.py --check` listed exactly those 5 sites. General lesson for
the curated table: **a curated purge that disagrees with the push-count
measurement must be justified by the callee's `ret N`, never by the
decorated name alone** — MSVC's hidden parameters (vbase `most_derived`,
by-value class returns) are invisible in the mangling.

The `_Lock`/`_Unlock` thunk path and `operator>>` are balanced, as 20.2 said;
`_Fiopen` + the codecvt facet family (behind the `fstream` ctor `0x009e8010`)
remain loud weak stubs until a path needs them.

## 21. Round 11: the stale-archive shadow — the instance is an extracted tree, and the 0x009ab970 patch was load-bearing

With the purge fix of §20.3 the tokenizer wall is gone (the msvcp trace goes
from 4 lines to 10,097: 1,331 `std::stringstream` constructions and their
`operator>>` parses run cleanly). The boot then faults in the `players.xml`
loader `0x006998d0` at `0x00699b81`: `first_attribute("nameimageroot")` on
the root node returns null and the loader dereferences it (the original
does not check; rapidxml in this binary is compiled non-throwing, a parse
error only sets `[0x00c7de4c]`).

### 21.1 What was parsed

`ISAAC_DUMP32` on the trapped image read the rapidxml document out of the
loader's 64 KB stack pool (`sub esp, 0x10230` = rapidxml's static pool):
the root node carries three attributes, but their sizes are `root` value
34 (the loose file's is 24), `portraitroot` value 22 (13), and a third
attribute with a **15-byte name** — `bigportraitroot`, not the 13-byte
`nameimageroot`. Dumping the text buffer confirmed an older schema
(`name="Cain"`, `portrait="PlayerPortrait_02_…"`, `bigportrait=`): the
Afterbirth+-era `players.xml`. The loose `resources/players.xml` (14,519 B,
CRLF, `#ISAAC_NAME`, `nameimageroot=`) was never opened — `ISAAC_FS_TRACE`
shows the loader's `fopen` going to `resources/packed/config.a` instead.

### 21.2 Why the archive won

Parsed `config.a`'s TOC (`ARCH000`, 24 members; the per-member key pair is
the same lowercase/`\`→`/` djb2 (`0x00a159d0`, seed 0x1505) and FNV
(`0x00a15ab0`, seed 0x5bb2220e) the loader uses): member 17 is
`resources/players.xml` at 3,154 packed bytes, and there is no
`resources-dlc3/…` member (the binary's `"-dlc3/"` string belongs to the
mods loader, `0x008f5ad0`/`0x008f99c0`). The resolver `0x00a16c60` walks the
mount roots **last-mounted first** and, for each root, tries the **archive
index before the root's loose map** (`0x00a17f40` on the prefixed key, then
`_Find_lower_bound` on the map). So with roots `["", "resources/"]` the key
`resources/players.xml` hits the stale archive member before any loose file
is considered. That is not a defect: the real Steam install
(`…\The Binding of Isaac Rebirth
esources\`) holds **only** `packed/` and
`scripts/` — no loose xml at all — plus `afterbirth.a`, `afterbirthp.a` and
`repentance.a` (1.1 GB) which this instance does not carry, and the newer
archives override the old members in the index.

### 21.3 The instance is an extracted tree, and the patch was its contract

The instance root (`.scratch/game-instance`) is a **ResourceExtractor dump**
(the Steam dir's `ResourceExtractor_log.txt` lists the 22 archives it
unpacked): `gfx/` (1,675 costumes, 722 collectibles, …), `font/`, `data/`,
34 top-level `.xml` — 10,725 files / 208 MB of png/anm2/xml/fnt/stb/wav —
on top of the 485-file `resources/` subtree round 10 seeded. The
emulator-era boot ran the canonical exe against exactly this tree, and the
canonical exe's hand patch at `0x009ab970` (`xor eax, eax; ret`: no
`resources/` mount root) is what made it work: with only the `""` root,
every relative key (`players.xml`, `gfx/ui/x.anm2`) misses the archive index
(keyed `resources/…`) and resolves through the root scan of the extracted
tree; explicit `resources/…` keys still reach the small archives for what
they hold. Round 10 read the patch as sabotage because the top-level tree
had never been seeded (only `resources/`), restored the prologue, and thereby
put the stale archives in front of the Repentance+ content.

Round 11 therefore **removes the `0x009ab970` override** (`lift_patches.py`
`PATCHES` is empty; the lifted body is the canonical stub again; the
mechanism stays for the other 18 patches), **seeds the whole extracted
tree** (`boot_integration.mjs`: everything under the instance root except
`resources/packed` (seeded by name), the duplicate top-level `packed/`,
`mods/`, and exe/dll/so/ogv), and raises the RAM-FS to **16,384 slots**
(`host_shims_fs.c`; widest directory `gfx/characters/costumes` = 1,675 <
the 2,048 per-scan cap). Faithful alternative for later: a file-backed
(lazy) RAM-FS entry so the real 1.1 GB archive set can be mounted as on
Steam — the same primitive a browser build needs (OPFS sync access handle
in a worker).

### 21.4 Next wall, and its cause: six hand-written callees never returned

With the extracted tree in place the boot parses `players.xml` from the
loose copy, loads every menu/minimap `.anm2`, opens `ambush.xml`, and stops
in `std::vector<T12>::_Tidy` (`0x0069dac0`) with the MSVC big-allocation
header check calling `_invalid_parameter_noinfo_noreturn` — the vector
object's `this` was `0x009b3d95`, a code address. The new trap-context dump
(`isaac_dump_trap_context` in `host_trap.c`: last 512 VAs, live registers,
guest stack from ESP — wired into the CRT noreturn shim) showed the frame
chain ambush loader `0x006f4740` → generic XML loader `0x00834680`
(`vector<vector<T12>>::clear()` loop) with the loader's saved `esi`/`edi`
equal to `0x0098d7bc`/`0x0098d7cd`: the **return addresses** of two `call
0x00aefca0` sites inside `0x0098d560`, the function called just before.

`0x00aefca0` is the CRT float→uint32 helper (AVX-512 `vcvttss2usi` fast
path gated on `[0xc7162c] >= 6`, SSE fallback). It is one of the 26 lift
failures, so it — and five siblings (`0x00aefcf0`, `0x00aefd70`,
`0x00aefe20`, `0x00aefe80`, `0x00aa9350`) — is a **hand-written body in
`scripts/recomp/host/src/missing_fns.c`**. Every one of them computed its
result and returned to C **without emulating the original's `ret`**. The
lifted caller pushes the return address, calls the body, and reloads ESP
from `CpuState`, so each call left 4 bytes on the guest stack; the caller's
`mov esp, ebp` epilogue re-synchronised ESP but its `pop edi; pop esi` had
already read the leftover return addresses. Fix: `rc_ret(s)` (`EIP =
[ESP]; ESP += 4`) at the end of every body, the contract comment now says
so, and `tests/recomp-host.test.js` refuses a `missing_fns.c` body without
it.

### 21.5 With the callees returning: viewport up, then the Workshop enumeration

The next run goes a long way further: `ambush.xml` and the remaining xml
tables parse, every menu/minimap/`mod_defaults` anm2 loads, the loading
spinner is built, and the engine prints `Viewport: 960x540` and the
framebuffer/window metrics. It then stops in mods-init `0x008fb120`: an
indirect call to `0x00000000` with `ecx = 0x0e00d500` — the Steam shim's
fake `CSteamAPIContext` object. The accessor slot is `0x00c5c48c`
(`ISteamUGC`, 6 sites all in `0x008fb120`), and the function walks the
interface's vtable at `+0x128` / `+0x12c` / `+0x130`
(`GetNumSubscribedItems` / `GetSubscribedItems` / `GetItemState`) to
enumerate Workshop subscriptions; the shim's fake vtable has 16 provided
slots, so slot 74 was zero. Every caller of `SteamInternal_ContextInit`
first tests `cmp [slot],0; je` — the game's own "Steam not running" arm.
`host_shims_steam.c` now carries a per-slot NULL table (`steam_null_slots`,
keyed by the static context slot the inline accessor passes) and answers
`0x00c5c48c` with a NULL context, so mods-init takes its no-Workshop branch
at `0x008fc529`; every other accessor keeps the fake context the round-9
Steam init arms depend on.

Measured with it: the boot (637 s wall, no FS trace) passes mods-init, prints
`Menu Manager Init` / `Menu Title Init` / `Menu Save Init`, logs
`[warn] AnmCache: cannot remove reference to ` with an EMPTY name, and
faults in `std::string::assign` (`0x0040ccd0`, from `Sprite::Load`
`0x0040bd50`) writing 36 bytes through a NULL heap pointer of a string whose
capacity says "heap".

**Same class, third instance.** The runtime watch (§21.6) showed the bytes
under that "string" being written by the texture premultiply loop
(`0x00a663c0`) and by nothing that constructs objects, and the stack walk
put `SaveSelectMenu::Init`'s `this` at `[0xc72a20] + 0x1dc + 0x2f4` — the
manager pointer plus `0x1dc`, which is exactly the `lea esi, [edi + 0x1dc]`
Menu Save Init performs just before calling `0x009ef5c0`. That function is
the DLC ownership check: `SteamApps()->BIsDlcInstalled(appid)` three times
(`push 0x62200 / 0x8b524 / 0x15c37c; call [vtable + 0x1c]`), a `__thiscall`
that pops 4 bytes. The fake `CSteamAPIContext` vtable serves slot `+0x1c`
as `CSteamAPIContext_ReleaseInterface`, which the dispatcher purges by 8, so
each call drifted ESP by 4 and `0x009ef5c0`'s epilogue restored `edi` from
`esi`'s slot. The fault is therefore not a dead string at all: the menu
code was reading a "Sprite" 0x1dc bytes past the real one, inside memory a
freed 64 MB texture buffer had last used.

Policy change in `host_shims_steam.c`: the fake context is now an
**allow-list** — only the two slots the round-9 init dance pushes
(`0x00bf93c8`, `0x00c5c510`) receive the fake object; every other
`SteamXxx()` accessor reads NULL, the game's own "Steam not running" arm
(every caller tests `cmp [slot],0; je` first). Any interface reached through
the fake vtable would call methods whose real purges differ from the fake
slots' — the drift is structural, not a one-off — so NULL is the only safe
answer outside the init dance.

### 21.6 Tool: a runtime guest-memory watch

Finding who wrote a corrupted field used to mean editing the compile-time
range in `recomp_rt.h`'s `RECOMP_WATCH` and recompiling all 41 lifted TUs.
The window is now runtime state: `ISAAC_WATCH=0xLO:0xHI[:w]` (parsed once
by a constructor in `recomp_rt.c`; `w` = writes only) and every access in
the window prints `[recomp][PW] W @addr n=size v=value va=<guest VA>` (reads
without the value). The old hard-wired epoxy/allocator window
(`0xc73680..0xc73740`, ~1,000 lines per boot) is gone; opt in with the same
syntax. One full lifted recompile paid for it (`build_boot.py
--recompile-lifted`); a new address costs nothing. Caveat measured while
building it: the guest heap layout is NOT identical run to run (the
MenuManager moved by 0x48 between two boots — the RNG is time-seeded), so
watch a window around the object and read the manager pointer back with
`ISAAC_DUMP32=0xc72a20:1`, and never compare a register image from one run
with a dump from another (§21.5's first reading of the Sprite fault did
exactly that).

### 21.7 Where the 11 minutes go

`ISAAC_LOG_TIME=1` on a full boot (712 s wall, no FS trace): 567 s lie
inside nine gaps that each begin right after the second `_setjmp3` of an
image load (libpng's `setjmp(png_jmpbuf)` pair, `cont=0x00a64bbb`) — i.e.
PNG decoding in lifted x86 (inflate + unfilter, bounds-checked and
VA-traced), not the RAM-FS, not the XML parsers, not the shims. The instance's
largest inputs are the 4096×4096 RGBA font atlases (`teammeatex16_0.png`
9.7 MB, `teammeatex10_0.png` 5.0 MB) and the big UI sheets; the six largest
gaps are 156 / 139 / 101 / 64 / 48 / 34 s. Everything else — 11,197-file
seed, 1,331 tokenizer stringstreams, every anm2 parse, mods-init, menu init
— fits in the remaining ~2.5 min. Two ways out when it matters: a host
`png_read_*`-level decode (the game only ever needs RGBA8 rows) or a lifted
build without `RECOMP_MEM_CHECK`/`--trace-va` for the hot TUs; measure
before choosing. Note the setjmp pair count differs between runs that take
different paths, so attribute gaps within one stamped log, not across runs.

### 21.8 Round 11c: the register-held blind spot, closed at the census

`LoadImageA` (window icon), then `SendMessageA` (WM_SETICON, ten
instructions later) are reached as `mov ebx, [slot]; ...; call ebx`. The
import census only counted `call [slot]` and ILT-thunk sites, so such an
import was NEVER_CALLED with an unknown purge, and every one of them that a
boot reached became a trap: `FindNextFileW` (round 10), `LoadImageA`
(11b), and — predictable from the code right after it — `SendMessageA`.

`gen_shims.py` now counts `mov r32, dword ptr [slot]` loads in the same
decode pass that finds the thunks (`regHeldLoads` per row) and treats them
as reachability: NEVER_CALLED means no call site AND no register load. That
exposed **27 imports reachable only register-held** (32 NEVER_CALLED rows
became 11, all genuinely dead: the seven `luaopen_*`, `DefWindowProcA`,
`__CxxLongjmpUnwind`, `__std_terminate`, `_purecall`). Each of the 27 now
has a running verdict and a signature-derived purge: inert STUBs where 0 is
the honest no-Windows answer (`SendMessageA/W` 16, `TranslateMessage` 4,
`PeekMessageA` 20, `GetClassLongW` 8, `UnregisterClassW` 8,
`GetNumaNodeProcessorMask` 8, `CoInitialize` 4, `curl_easy_setopt` cdecl, the
four decorated `_EOS_*@N`), bodies where 0 would mislead
(`GetDeviceCaps` 8 → 96 dpi / 60 Hz / 32 bpp of the emulated display;
`GetRawInputDeviceList` 12 → writes `*count = 0`; `lua_getstack` bound to
the real Lua 5.3.3). `tests/recomp-host.test.js` refuses any reachable
import that is NEVER_CALLED or carries an unknown purge, and the
stub-purge-confidence test counts register-held loads as reachability
(mutation-checked: dropping a curated purge, or blinding the census, fails
the suite). Host selftest 130/0.

### 21.9 Round 12: the frame loop, and the render target that was re-created every frame

With the 27 imports provided (§21.8) the boot leaves engine init for the
first time: `SendMessageA` (WM_SETICON) passes, and the log becomes an
endless `Renderbuffer ID: <n> size 1024x1024` — 652 lines in ten minutes,
one per iteration, names 16 apart. That is the game's main loop running:
`RenderTarget` validation (`0x00a18750`) binds the target's renderbuffer,
reads back `GL_RENDERBUFFER_WIDTH` / `HEIGHT`
(`glGetRenderbufferParameteriv`), and when they differ from the wanted size
generates a new renderbuffer and logs it. The GL shim answered 0 to every
query, so every frame allocated a fresh 1024×1024 target (a leak in the
guest, and the GL name space) instead of rendering into the old one.
`host_shims_gl.c` now keeps a 256-entry `{name, w, h, format}` table:
`glBindRenderbuffer` tracks the bound name, `glRenderbufferStorage` records
the size/format, `glGetRenderbufferParameteriv` answers `WIDTH` / `HEIGHT` /
`INTERNAL_FORMAT` (0x8D42..0x8D44) from it, `glDeleteRenderbuffers` forgets.
Selftest 130 → 134 (gen/bind/storage/query round trip, delete forgets),
mutation-checked (a 0 width answer fails it). The general rule this adds to
the GL contract: **any GL query the engine uses to decide whether a resource
is still valid must read back what the engine wrote** (the shim already did
this for shader/program status; render targets were the second case).

### 21.10 Tool: a frame cap, because the loop has no other exit

Once the boot enters the frame loop nothing ends it: the game's `main` only
returns when GLFW's window reports `shouldClose`, so an unbounded run is a
silent CPU burn with no result line. `ISAAC_MAX_FRAMES=N` bounds it the way
the real program would end: the `SwapBuffers` shim (`host_shims_win.c`, now
PROVIDED) counts presented frames and stamps every 60th; once N are
presented, `PeekMessageW` hands GLFW's own message pump a single `WM_QUIT`,
`glfwPollEvents` turns it into `shouldClose`, the loop exits, `main`
returns and the harness prints `RESULT: main returned 0` with the reports.
Unset = unlimited (the selftest pins that the pump stays silent then).
Per-frame cost is read from the `[isaac][frame]` stamps.

### 21.11 Tool: a stall watchdog inside the lifted code

The first bounded run (§21.10) never presented a second frame: after
`Menu Online Awards Init` the log went silent for good, and nothing in the
host layer runs when the guest spins without calling a shim — no timer can
fire under a synchronous wasm call, and the fault dumps only fire on a
fault. `ISAAC_STALL_DUMP=<seconds>` hooks the one place every lifted
instruction passes: `RECOMP_VA` now calls `recomp_stall_tick()` every 2²⁰
instructions, which compares the wall clock with the last `isaac_log`
stamp (`recomp_last_log_ms`, set in `isaac_log`) and, after that much
silence, prints a histogram of the hottest VAs in the 512-entry ring (the
loop body), the last 64 VAs in order, the register image from the last
spill (stale inside a call-free loop — the ring is the truth), and a stack
walk from that ESP; then re-arms. Cost: one masked compare per lifted
instruction. It needed the one full lifted recompile the runtime watch
(§21.6) had already paid for once; it will also fire, harmlessly, inside a
150-second PNG decode.

Related, for the thing it is about to name: the engine's three
`_beginthreadex` spawns all go through the trampoline `0x00a7f130`
(`fn(arg)` once, then a done flag on the thread struct), so a "thread" is
a run-to-completion job unless `fn` loops. `host_shims_module.c` now logs
each spawn's real job (`fn`/`arg` read from the 12-byte block) and, with
`ISAAC_RUN_THREADS=1`, runs pending jobs inline at the main thread's next
yield point (`Sleep`, `WaitForSingleObject`) on a guest stack below the
caller's frame — off by default because an endless mixer loop would hang
the boot.

### 21.12 Measured: the frame loop runs at ~7 fps; the first clean shutdown

A 5-frame bounded run (`ISAAC_MAX_FRAMES=5 ISAAC_LOG_TIME=1`, stamps on
every frame) settles what the silence was: frames 1 and 2 are presented
during engine init (6 s apart, the loading screen), frame 3 arrives 418 s
later (all of menu init and the first frame's asset loads), and frames
4 / 5 / 6 take **143 / 137 / 132 ms** — the game's main loop, in the fully
instrumented debug build, at about 7 fps. The stall dump's hot loop
(§21.11) was simply the character-select render in that loop. The cap then
works end to end: `WM_QUIT` posted after frame 5, one more frame presented,
`Isaac is shutting down...`, the enemy-query CPU report — and a trap in
the static-destructor pass: `_execute_onexit_table` calls `0x0069d1f0`, an
8-byte adjustor thunk (`add ecx, 4; jmp 0x0040d040`) that no function-start
scan ever recorded, so it was neither lifted nor in the dispatch table.
`missing_fns.c` carries it as a hand-written tail-jump
(`recomp_jump_indirect`), `mkdispatch.py` already includes hand-written
VAs, and the "every hand-written body emulates ret" test accepts a
tail-jump. Two more things the shutdown exposed: the host `_crt_atexit`
table was 64 entries and had been dropping the engine's static
destructors since round 9 (`table full (64); 0x00b16750 will not run`),
now 1024; and the three `_beginthreadex` spawns all resolve, one wrapper
deeper, to the same job `0x00a5a760` (running-bit around `fn(arg)`), whose
innermost `fn` the spawn log now prints.

Tools added for the loop: `ISAAC_PROFILE=1` samples `recomp_cur_va` on the
same 2²⁰-instruction tick, attributes it to the containing lifted function
(binary search over the dispatch table's `g_dva`, count exported as
`g_ndispatch`) and prints the hottest functions with the stub report,
including effective MIPS; `build_boot.py --fast` builds a speed profile
(lifted TUs with `RECOMP_MEM_CHECK=0` — no bounds checks, VA ring, watch or
stall tick — objects `lifted_NNN.fast.o`, output `boot-fast/`, wasm-opt
link) to measure how much of the 135 ms is instrumentation. Faults there
are raw wasm traps; debug with the default profile.

### 21.13 Round 12d: the host fastpath -- exact, verified, and no faster

`ISAAC_PROFILE=1` on the 5-frame run: **6.76 G lifted instructions in
584 s = 12 MIPS**, 37% in `0x00ab2d80` (libpng's SSE2 row unfilter), 27% in
`0x00adb9c0` (zlib `inflate_fast`), 8.7% in `0x00aaddd0` (zlib `adler32`),
8% in `0x00a663c0` (the engine's texture premultiply). `--fast`
(no bounds checks / VA ring, wasm-opt link, 46 MB module) and
`node --no-liftoff` change nothing (146-172 ms per frame, 469-498 s to
frame 3).

So the three deterministic leaf functions got exact host implementations
(`scripts/recomp/host/src/host_fastpath.c`): the PNG filters per the spec
(Sub/Up/Avg/Paeth over `png_row_info` at `edx`, bpp from `pixel_depth`),
RFC 1950 Adler-32, and the premultiply table lookup on the image's own
64 KB table. They are installed as **wrap patches** (`lift_patches.py`
`WRAP_PATCHES`): the lifted body is renamed `sub_X__lifted` and a wrapper
`sub_X` takes its place, so `ISAAC_FASTPATH=0` runs the lifted code,
`ISAAC_FASTPATH_VERIFY=1` runs both and byte-compares the touched range on
the game's own data (any mismatch is logged and counted), and the default
runs the host version. Spec vectors pin the host code in the selftest
(Paeth tie-break, Adler-32 modulus and NMAX chunking all
mutation-checked); `tests/recomp-fastpath.test.js` pins the wrapper
contract (lifted body reachable, mode consulted, host path ends with the
`ret` emulation -- the one-slot stack drift class).

**Measured.** Verify mode over the whole boot (533 PNG decodes, 3 frames):
**0 mismatches**. Host mode: frame 3 at **416 s** against 418-470 s with
the lifted bodies. Removing 54% of the lifted instructions removed no wall
time. The instruction profile counts lifted instructions, not seconds; at
12 MIPS overall the lifted code cannot be where the seconds go (bounds
checks off changed nothing either). The wall time is on the host side of
the boundary -- which the instruction-tick profiler is blind to. Round 12e
profiles the process with V8's sampling profiler (`node --cpu-prof`) to
find it; the fastpath stays (it is exact, verified, and cheap) but the
lesson is recorded here: **profile wall time, not guest instructions.**

### 21.14 Round 12e: the wall-time profile -- 95% of the boot was the guest allocator

`node --cpu-prof --cpu-prof-interval 2000` on the 3-frame boot (the
`.cpuprofile` is nodes + samples + timeDeltas; self time per frame summed
over samples, wasm functions keep their names in the debug link):

```
  447.69 s  95.4%  guest_malloc            (host_shims_heap.c)
    4.86 s   1.0%  sub_00adb9c0            (zlib inflate_fast)
    1.89 s   0.4%  open                    (node fs, instance seeding)
    1.00 s   0.2%  sub_00652210
    0.99 s   0.2%  isaac_fs_seed
  ---- by bucket:  lifted sub_* 3.1%, isaac_* host 0.4%, imp_* shims 0.1%, JS 0.1%
```

The guest allocator was the round-2 "auditable in one screen" first-fit
walk: every `malloc` walked every block from the arena start until the
first free one that fit. 527 k mallocs over a heap that holds ~100 k live
blocks = tens of billions of header reads through the bounds-checked
accessors. The instruction-tick profiler could not see it because the
walk is host code; `--fast` could not help because it is not lifted code.

**Replacement** (`host_shims_heap.c`): boundary tags (header `{size,
flags}` as before plus a footer `size|used`), free blocks on doubly-linked
lists segregated by size class (exact 8-byte classes below 512 bytes,
then one per power of two), `malloc` = first fit inside the request's own
class or the head of the first non-empty larger class, `free` = immediate
two-way coalescing through the footer. Used blocks are never touched.
The meter, the double-free / foreign-pointer / header-footer guards and
the API are unchanged; the report now also prints the free-block census.
Selftest: three-neighbour coalescing, a 4000-block churn with pattern
verification, realloc, the guards, and "everything freed = one block
again" -- backward/forward coalescing, the unlink and the split are each
mutation-checked.

**Result.** 5-frame bounded boot: frame 3 at **10.6 s** (was 416 s);
frames 4-6 at **3 / 2 / 1 ms** (were 143 / 137 / 132 ms); clean shutdown,
`main returned 0`. Peak live 91.4 MiB (footers cost 0.3 MiB). So the
lifted code runs at roughly 500 MIPS, not 12: the "12 MIPS" of round 12c
was the allocator's time divided by the guest's instruction count. Every
speed conclusion drawn from `ISAAC_PROFILE=1` in rounds 12c-12d was an
artefact of that; the fastpath (§21.13) stays because it is exact and
verified, but it was never needed.

**Rule, added to AGENTS.md:** a speed unit starts from a wall-time
profile of the whole process (`node --cpu-prof`), never from a
guest-instruction histogram; the two disagree by whatever the host does
per guest instruction, and here that was 30x.

**zlib note for later** (decomp-scout evidence, 2026-09-02): the embedded
zlib is 1.1.x (infblock/infcodes layering, 1.1-only tree messages), LTCG
turned every entry into ECX/EDX register conventions (`inflate(ecx=z)`
with the flush argument folded away, `inflate_fast(ecx=bl, edx=bd, 4 on
the stack)`), `inflateInit2_` hard-codes wbits 15 and skips the version
check, libpng 1.2.50 supplies `png_zalloc/png_zfree` callbacks, and
`0x00ab2140` (png_decompress_chunk) carries two inlined `inflateReset`
copies that read `z->state` directly. An API-level host zlib is therefore
a shadow-state design with those two sites patched -- and at 1% of wall
time it is not a speed unit.

### 21.15 Round 12f: the RAM-FS -- a hash index and lazy bytes

The 600-frame wall-time profile after the allocator fix (38 s sampled,
81% lifted code) still showed the FS layer: node `open` 1.5 s,
`isaac_fs_seed` 0.9 s, `read` 0.5 s, `strcmp` 1.0 s. Two causes, both in
the seeding phase before `main`: the driver read and copied every file of
the instance tree into the host heap (11,197 files, 243 MB), and each
`fs_new` ran `fs_find`, a `strcmp` over all 16,384 slots (183 M string
compares just to seed).

`host_shims_fs.c` now keeps an open-addressing FNV-1a index from key to
slot (`g_fs_hash`, 65,536 entries; deletes rebuild it, which is hygiene
rather than correctness: a stale entry points at a slot whose key no
longer matches and the probe simply continues). Entries carry a `live`
flag instead of the old "is_dir or has data" test, so an empty or lazy
file is a real entry. **Lazy bytes:** `isaac_fs_seed_lazy(path, size)`
registers a file with its size and its seed path; directory scans, stat
and `GetFileSize` see it, and the first access through `fs_file_entry`
materialises the bytes through a reader the driver installs
(`Module.isaacLazyRead`, reached from C by an `EM_JS` bridge; the
selftest installs a C reader instead). The seed path is handed to the
reader verbatim, so case and separators are the driver's own, not the
lower-cased key's.

**Measured.** 11,197 files registered lazily; a 5-frame boot reads
**643 of them (31.4 MB)**. Process wall time for the 5-frame boot,
start to exit: **12.4 s** (the frame-3 stamp is unchanged at 10.7 s
because the stamp clock starts after seeding). Host heap no longer holds
the 208 MB the eager seed copied. Selftest pins: the index finds
neighbours after a delete and finds a re-seeded key; a lazy entry is
visible to stat before any read, `fread` returns the reader's bytes, the
reader runs exactly once across two opens, and it receives the verbatim
seed path -- the index insert, the materialise call and the lazy-flag
clear are mutation-checked.

### 21.16 The three engine threads -- what they service, and why the menu needs none of them

Evidence (decomp-scout, 2026-09-02; Ghidra decompiles of `0x00a7da80`,
`0x00a220c0`, `0x00a9e950`, `0x00a7f130`). The engine's `Thread` class:
`Start` at `0x00a5a570` allocates a 0x28-byte internal block
`{HANDLE, CRITICAL_SECTION, +0x1c busy, +0x20 done, +0x24 tid}` and a job
block `{Thread, fn, arg}`, then `_beginthreadex(0x00a7f130, {0x00a5a760,
block, internal})` -- the only `_beginthreadex` site in the image. The
trampoline `0x00a7f130` stores `done = 1` at `0x00a7f19d` after the job
returns (which is why round 12d's adoption sets it: `~Thread` at
`0x00a5a700` joins with `WaitForSingleObject` and terminates when the
flag is 0). Whole-image sync census: four `WaitForSingleObject` sites
(`~Thread`, `Thread::Stop`, two unrelated), no semaphores or condition
variables; the engine `Mutex` (vtable `0xb81c0c`) is a critical section
with a busy-byte `Sleep(1000)` fallback.

| job | what it is | loop | exit flag | who waits on it |
|---|---|---|---|---|
| `0x00a7da80`, arg `SoundManager 0xc5aaa0` | OpenAL "processing thread": finished-source GC and device hotplug re-open (`0x00a9e720`) | `Sleep(5)` per iteration | `[0xc5aaa4] & 4`, set only by `SoundManager::Shutdown 0x00a9e5a0` | only `Shutdown` (join) |
| `0x00a220c0`, arg `InputManager 0xc57b18` (unread) | controller hotplug poll: `0x00a6dab0` pumps the DirectInput hidden window, re-enumerates DirectInput devices on request, polls XInput slots 0..3 and registers new devices through the main-thread callback `[0xc75da8]` | `Sleep(100)` | `[0xc57b1c] & 2` (`ControllerHotplug` option toggles it without a join) | only `Shutdown 0x00a21b70` (join) |
| `0x00a9e950`, arg `CommandThread 0xc79a7c` | EOS "Command thread": pops 24-byte commands from a ring `Queue` (`+0xc` ring, `+0x10` cap, `+0x14` head, `+0x18` count, `+0x1c` Mutex) and runs the executor `0x00a733c0` (lobby create/join, EOS calls) | **no sleep** -- a hot Lock/Unlock spin when idle | `[0xc79a7c] & 2` | `Shutdown 0x00a71770` (join) and `0x00907690`: a main-thread loop that drains `CommandSystem::ProcessQueue`, ticks EOS and `Sleep(10)`s until a pending vector empties -- 10 callers, all online-lobby flows |

Nothing on the boot or title-menu path enqueues work for any of them or
blocks on a result, which is why the 600-frame run sits at the game's
own 30 fps pacing with the threads adopted but never run. The per-job
design when it is needed: the audio and hotplug loops are "run one
iteration at a yield point" jobs (their bodies are ordinary lifted
functions, `0x00a9e720` and `0x00a6dab0`, callable through
`isaac_guest_call` from the frame's `PeekMessageW` or `Sleep`); the
command thread's iteration is "pop one ring element and call
`0x00a733c0(&elem, 0xc79a60)`", which the host can do from the `Sleep(10)`
inside `0x00907690`'s poll loop -- the exact point where the main thread
would otherwise wait forever. `ISAAC_RUN_THREADS=1`'s inline runner
(round 12) is the wrong shape for all three: it runs the whole endless
loop and never returns.

### 21.17 Round 13: the web build -- the recompiled game renders its first frame

**13a, the GL census.** Before writing a real backend, the headless fake in
`host_shims_gl.c` recorded every distinct enum tuple the game passes
(`gl_census`, printed with the stub report; 60 frames). The result: the
whole surface is WebGL2-native. Textures are `RGBA|RGB / UNSIGNED_BYTE`
with NEAREST|LINEAR and CLAMP_TO_EDGE|REPEAT; render targets are a
DEPTH_COMPONENT24 renderbuffer plus a COLOR_ATTACHMENT0 texture, and the
game reads `GL_FRAMEBUFFER_BINDING` back; state is BLEND / DEPTH_TEST /
CULL_FACE, `GL_GREATER`, `FUNC_ADD` with `(ONE, ONE_MINUS_SRC_ALPHA)`
(premultiplied, which is what the premultiply table in §21.13 is for);
geometry is client-side float arrays (strides 0x14/0x1c/0x24) drawn as
TRIANGLES with UNSIGNED_SHORT indices; 23 GLSL programs. The window is
960x540 (`glViewport`). Not one enum needed translation; the only
desktop-isms are `glClearDepth(double)` and `glDrawArraysInstancedEXT`.

**13b, the build and the harness.** `build_boot.py --web` reuses the
lifted objects and rebuilds the host TUs as `.web.o` with
`-DISAAC_WEB=1`, linking `-sENVIRONMENT=web` with MEMFS instead of
NODERAWFS, `FS`/`ENV` exported and `-lGL` (WebGL2 only). Output
`boot-web/` (a 380 MB wasm; the link takes seconds because the objects
are already optimised). `scripts/recomp/web/run_web.mjs` launches
Playwright's bundled Chromium headless with SwiftShader, serves the
module, the memory image and the instance tree from a throwaway HTTP
server on 127.0.0.1, and drives `boot_web.html` + `boot_web.mjs` -- the
same stages as the node driver, with the lazy RAM-FS reads answered by a
synchronous XHR (base64: a synchronous XHR may only read text and
Chromium strips a leading UTF-8 BOM from text whatever the charset
label, which silently emptied every BOM-prefixed `.anm2`/`.fs`/`.xml` on
the first attempt), the Lua scripts written into MEMFS, and `ENV` set
from the query string (`?frames=N&ISAAC_X=Y`). The first attempt served
`boot.wasm` through `page.route`; a 380 MB body crossing the CDP channel
as base64 killed the renderer, hence the HTTP server.

**13c, the backend.** `host_gl_webgl.c` (web build only) forwards every
opengl32 entry point to the GLES3 function emscripten binds to the
page's WebGL2 context, which `wglCreateContext` creates on `#canvas`.
Arguments come off the guest stack (`isaac_arg`), floats as raw bits,
doubles as two slots, pointers through `isaac_g()` straight into GL
(guest memory is the wasm heap). Geometry goes through the client-array
emulation of round 2 (`host_gl_clientarrays.c`), which was written for
exactly this and needed only an instanced-draw entry. `glShaderSource`
concatenates the pieces, prepends `precision highp float; precision
highp int;` to fragment shaders that declare none (desktop GLSL does not
need it, GLSL ES rejects it: "No precision specified for (float)"),
strips a desktop `#version` line, compiles at once and logs a failing
source's head. The capability gates (`glGetString` "4.6.0",
`GL_NUM_EXTENSIONS` 0, `GL_CONTEXT_PROFILE_MASK` 0) keep their headless
answers so the refresh takes the same branches as under node; state and
limit queries (`GL_FRAMEBUFFER_BINDING`, `GL_MAX_TEXTURE_SIZE`, ...) are
real. `SwapBuffers` reads the default framebuffer back (`glReadPixels`)
and hands it to the page (`Module.isaacPresent`); the runner writes the
last frames as PNGs. `ISAAC_GL_CHECK=1` polls `glGetError` after every
forwarded call and names the caller.

**Result (2026-09-02).** 5-frame run: 16 s wall including the module
load, `main returned 0`, **0 GL errors, 0 shader failures, 36 draws**,
6 frames presented at 53-59 ms each under SwiftShader; 643 lazy reads
(31 MB). Frame 4 is the main menu's paper backdrop with the pencils --
the first frame the recompiled game has ever rendered; frame 120 of a
120-frame run is the Repentance+ Beta welcome popup, its text set in the
game's fonts (the fade and the popup timing are the game's own). Frames 1-2 are
black (the loading screen draws before its assets arrive), which matches
the game's own behaviour on a cold start. The frames live under
`output/recomp/web-run*/` (binary-derived: not committed).
`tests/recomp-web.test.js` pins the two-backend contract: every
opengl32 import has a headless body and a WebGL body, the fakes are
compiled out of the web build, the frame capture and the context
creation are wired.

**What the web build does not do yet:** no input (the pump runs but no
key or mouse events reach the game), no audio (OpenAL is the same
no-op arms), the three engine threads stay adopted (§21.16), and the
page blocks inside `main` for the whole run -- the canvas is read back
from the host, not presented by the browser, so a live view needs
either a worker/OffscreenCanvas split or Asyncify at the SwapBuffers
shim. Speed: SwiftShader spends ~50 ms per frame; a GPU-backed Chromium
(`--use-gl=angle` without SwiftShader) is the same harness with a flag.

### 21.18 Round 14a: input -- the menus are navigable

The page's main thread sits inside `main` for the whole run, so no browser
event can reach the game; input is a **timeline keyed by presented
frame** (`?input=420:Enter,470:Enter,...`; `frame:mouse:x:y`, `frame:click`).
A key entry presses at its frame and releases two frames later. The
host's `PeekMessageW` shim polls `Module.isaacInputPoll(frame, out)` for
the events due (four int32s per event) and turns them into Win32
messages in a real queue (`host_shims_win.c`): `WM_KEYDOWN`/`WM_KEYUP`
with `lParam = repeat 1 | scancode << 16 | extended << 24 | (up: bits 30,
31)` -- the layout GLFW's `windowProc` decodes (`HIWORD & 0x1ff` into its
scancode table) -- and `WM_MOUSEMOVE` / `WM_xBUTTONDOWN|UP`. `PeekMessageW`
hands GLFW's pump one message per call (the frame cap's `WM_QUIT` waits
until the queue is empty), `DispatchMessageW` delivers it to the window
class's WndProc as a guest sub-call (stdcall, four arguments, the
`_initterm` shape), and `GetKeyState` / `GetCursorPos` answer from the same
state. `SetPropW`/`GetPropW` became a real property table because GLFW's
WndProc finds its window object through `GetPropW(hWnd, L"GLFW")`; a 0
answer sent every message to `DefWindowProc`. The node driver takes the
same timeline from `ISAAC_INPUT`, so a headless run can navigate too.

Two walls on the way, both instructive. First: a real window receives
`WM_ACTIVATEAPP`, `WM_ACTIVATE` and `WM_SETFOCUS` before any key, and
`GetActiveWindow` must name it (GLFW's focused query is
`GetActiveWindow() == handle`); the host now sends the three at the first
pump and answers the query with the main window. Second, the one that
actually mattered: the game creates **three** windows -- GLFW's hidden
"GLFW3 Helper", the real "GLFW30" window (WndProc `0x00a5b7b0`) and,
last, a "Message" window for DirectInput's hotplug thread (WndProc
`0x00a6cef0`). "Last created" addressed every key to the DirectInput
window, whose WndProc dutifully ignored them. The queue targets the
`GLFW3*` non-helper window; the selftest pins it with the three windows
in the game's own order and sizes (the mutant that reverts to "last
window" dies).

**The chain, from the scout's evidence (2026-09-02), so the next input
problem can be bisected instead of guessed:** GLFW 3.4's window proc
`0x00a5b7b0` takes `scancode = (lParam >> 16) & 0x1ff` (0 -> `MapVirtualKeyW`),
`key = keycodes[scancode]` from the `0xc74cc8` table `createKeyTables`
(`0x00a80770`) fills, `action = ~(lParam >> 31) & 1`, mods from eight
`GetKeyState` calls, and calls `_glfwInputKey` `0x00a25c50`, which writes
`window->keys[key]` (`window+0x7c`) and invokes `callbacks.key`
(`window+0x2a4`). The engine installs `0x00a6cec0` there (keyboard-device
init `0x00a6c3e0`, from `InputManager` init `0x00a21980`): press -> byte
`[0xc78ab0 + key] = 1`, release -> 0, repeats ignored. The frame's update
(`0x00954cd0`) calls `glfwPollEvents` (`0x00a5e660`), the pad poll, then
`InputManager::Update` `0x00a1fc00` -> per-device update -> keyboard slot
30 `0x00a6c650`, which snapshots `0xc78ab0` into cur (`0xc78c10`) and
prev (`0xc78950`); `Pressed` (`0x00a6c540`) is cur && !prev. Actions map
through the default bindings table `0xc33b10` (33 pairs): MenuConfirm
(0xe) = SPACE or ENTER, MenuBack (0xf) = ESC, MenuUp/Down (0x16/0x17) =
UP/DOWN. Nothing gates keyboard input on focus (WM_SETFOCUS only feeds a
pause flag read in-game). The beta-notice popup (`0x00420190`) creates
its ACCEPT/DENY options disabled and a timer (`0x00420760`) re-enables
them after 5,000 ms of `QueryPerformanceCounter` time, selecting ACCEPT --
which is why the Enter presses before frame ~400 did nothing and the ones
after did.

**Result (2026-09-02).** Web run, 560 frames, `Enter` at 420 / 470 / 520:
the beta notice is accepted, the title screen passes, frame 480 is the
**FILE SELECT** screen (three files, "DELETE FILE"), frame 560 the main
menu. Nine messages dispatched, 0 GL errors, `main returned 0`. The
selftest pins the queue (lParam layout, order, key-up bits, key state,
cursor, properties, the window choice) with four mutants killed;
`tests/recomp-web.test.js` pins that the page and the node driver share
one key table and that the pump drains the queue before the cap.

### 21.19 Round 14b: starting a run -- a lifter jump-table bound bug in the Basement generator

With input working, the timeline `Enter` x7 (beta notice, title, file
select, NEW RUN, character select) took the web build into a new run:
`RNG Start Seed: YHMN 99GP`, `Initialized player`, `Level::Init m_Stage 1`,
`[RoomConfig] load stage 1: #BASEMENT_NAME`, `allocate 1220 rooms`,
`generate...` -- and then `exit(1)`: an indirect jump inside the level
generator (`0x009b0b00`, at `0x009b0d7b`: `jmp dword ptr [esi*4 +
0x9b1210]`) landed on `0x009b0f8a`, an address inside the function that
the lifter never emitted as a target, so the runtime's "not a lifted
function" trap fired.

**The bug** (`scripts/recomp/lift/jumptables.py`): the switch-table
bound came from *the nearest* `cmp reg, N` before the jump. Here the
instructions before the jump were `cmp esi, 2 / je ...` -- ordinary
control flow on the index register, not a range check -- and N=2 was
taken as the table size: three targets emitted, the fourth case
(`esi == 3`, `0x9b0f8a`) dropped. The table has four in-function entries
followed by the next function's code.

**The fix, measured before it was trusted.** A census over all 785
table jumps in the image (Ghidra function bounds, linear decode) compared
three rules: the legacy nearest-`cmp` (776 tables, 7,701 entries, 9
unresolved), a strict "guard only" rule -- `cmp` on the index register
followed by an unsigned jcc -- (760 / 7,438 / 25: it fixes the
truncations but loses 16 tables whose first entry lies outside the
recorded function range, so the walk fails), and the shipped rule: a
real guard (index register first, then any register, since two-level
tables compare the pre-transformed index) is trusted; without one, both
the in-function walk and the legacy read are taken and the longer wins
(**776 / 7,757 / 9**: every legacy table kept, 56 entries recovered,
among them 0x9b0d7b 3->4, 0x5e3e62 4->12, 0x6f98ee 14->25, 0xa2c061 4->15).
`tests/recomp-jumptables.test.js` pins the rule and, where `tools/` is
present, runs the classifier on the binary for the Basement switch (four
targets). Lesson for the lifter: a rule change is a census first.

**Re-lift.** The tree was re-emitted with the recorded argv
(`summary.json` carries it) into a scratch directory and
`patch_reentry.py` applied. A per-TU diff against the live tree was the
plan; it is not possible: the split is by cumulative emitted bytes, so
one longer function moves every later boundary and all TUs differ (the
tree also went from 41 to 45 TUs). A lifter change is therefore always a
whole-tree replacement plus a full lifted recompile (41 TUs, 655 s with 8 jobs); keep the
previous tree beside it (`gu-prev/`) for a rollback.

**Result.** With the re-lifted tree the node boot is unchanged (frame 3 at 11.3 s, main returned 0) and the web play run passes the generator: the Basement is generated and the start room loads (Room 1.2). The next wall is a V8 'Maximum call stack size exceeded' while loading that room -- round 14c.

### 21.20 Round 14c: the first room -- the lifter's last two gaps on the way in

With the Basement generated, the start room loaded (`Room 1.2(Start
Room)`, `SpawnRNG seed`, `Spawn Entity with Type(6), Variant(19)`) and
the headless run trapped on an indirect call to `0x005d4380`, a function
that was never lifted. `failures.txt` said why: **"function at 0x5d4380
exceeds 20000 instructions"** -- the lifter's own `--max-insns` cap. Ghidra
had split the entity-spawn factory into fragments and the absorb policy
reassembles them into a >20k-instruction function; the cap made it
vanish, and the vtable slot at `0xb63be8` pointed into nothing. Raised
to 100,000 (the recorded argv now carries it); `0x005b39d0` was the other
victim.

The remaining 24 failures were all one thing once decoded: **jump tables
embedded in `.text`** -- `0x0062a838`, `0x006e2548`, `0x0055a7c6`,
`0x005c7659`, `0x00607231`, `0x00610438`, `0x007d58ac`, `0x008004d0` are
pointer arrays (the whole entity family around `0x00626xxx` absorbs the
same table), and `0x007b8a98` / `0x008151bc` are table bytes that decode
as `les`/`lds` ("load size 6 unsupported"). The body scanner reached
them by falling through after a noreturn call and either SLEIGH refused
the bytes (`BadDataError`) or the lowering did, and the whole function
was dropped. Two soft stops now replace the hard failure: `discover_body`
ends *that path* at an undecodable address (counted as `data_stops` in
the summary), and the block emitter lowers an instruction it cannot
translate as `recomp_unreachable(va); return;` and ends the block
(`soft_traps` in the per-function stats). Both fire only if the path
executes, and the emitter already rendered a fall-through into a missing
address as `recomp_unreachable` and a branch to it as a weak aborting
stub. Lifting the 26 failing functions alone: 0 failures, 8 data stops,
4 soft-trapped instructions in two functions.
`tests/recomp-jumptables.test.js` lifts `0x006261f0` and `0x0081516d`
in isolation and pins both behaviours (where `tools/` is present).

**Result.** With the cap raised and the soft stops in, the tree lifts with 0 failures (23,238 functions, 42 TUs) and the spawn factory runs: the first entity spawns (Type 6, Variant 19) -- and both builds then hit V8's 'Maximum call stack size exceeded' with a flat guest stack, the subject of round 14d.

### 21.21 Round 14d: the tail-jump trampoline -- native stack growth without guest frames

With every function lifted, both builds died at the same spot with V8's
"Maximum call stack size exceeded" right after the first entity spawned.
A worker with a 512 MB stack failed identically (JS recursion depth there
is 6.7 M, so the limit applied), the VA ring showed no tight loop (451
distinct addresses in the last 512), and the guest stack held only stale
frames -- 24 KB below the top, no recursion. The V8 trace, once the driver
printed it whole (`Error.stackTraceLimit = 400`, runs collapsed), named
the cycle:

```
sub_0093805f -> recomp_jump_indirect -> recomp_call_indirect -> isaac_lifted_dispatch -> sub_0093805f -> ...
```

The spawn loop's back-edge is a computed jump to an address that is also
a function entry (Ghidra's fragmentation of the big spawn dispatcher), and
the lifter emitted every guest `jmp` that leaves the current function as
`sub_T(s); return;` -- a nested C call that unwinds only when T returns.
Native frames grew one per loop iteration while the guest stack stayed
flat, which is why nothing the host could see explained it.

**The trampoline.** A jump that leaves the current lifted function now
parks its target (`recomp_jmp_target`, `recomp_jmp_pending`) and returns
-- the static tail calls, the dispatch-loop cases that leave the function,
and the computed forms (`jmp reg`, `jmp [slot]` with an unknown purge,
unresolved jumps) alike. Whoever called the function runs the target from
its own frame: lifted call sites (`sub_Y(s); if (recomp_jmp_pending)
recomp_run_pending(s);`, and the same after `recomp_call_indirect` for
`call reg` sites) and the host entry `isaac_guest_call` (plus the longjmp
replay loop). `recomp_run_pending` loops `recomp_call_indirect` until
nothing is pending, so a chain of jumps of any length costs a bounded
number of native frames, and the callee's `ret` still consumes the
original caller's return address off the guest stack, exactly as on x86.
The loop must live **only in caller frames**: the first cut also ran it
inside `isaac_lifted_dispatch`, which is what `recomp_run_pending` calls,
and the nesting simply moved (`dispatch -> run_pending -> call_indirect
-> dispatch -> ...`, the same overflow). The dispatch path only calls.
The state is two globals, not `CpuState` fields: the host struct is only
a prefix of the generated one (which continues past `ZMM3` to `TR`), so
trailing fields would sit at different offsets on the two sides -- the
patch's own layout assertion caught that before anything was built.
Execution is single-threaded and strictly LIFO across the host/guest
boundary, so the innermost dispatcher consumes the flag before an outer
frame looks at it. `tests/recomp-trampoline.test.js` pins the four parts
(emitter, runtime, header, dispatcher).

**Result.** With the trampoline, the x87 helpers and the gap shims, the headless play run passes the first entity spawn with no native stack growth and no trap: the start room loads, its entities spawn, and the run is then inside a room-entry crawl -- a 20-second rapidxml attribute-parse stall (FUN_004165a0, parse_node/parse_element recursion over a document in the guest heap) with slow asset loads around it and no frame for minutes. That crawl is round 14h's wall; the V8 profile of it is the next measurement.

### 21.22 Round 14e: the x87 register-convention CRT helpers

With the native stack flat, the first entity spawn reached
`api-ms-win-crt-math!_CIfmod` -- marked PROVIDED in the shim table but
never given a body, so the weak stub trapped. `_CIfmod` and `_CIatan2`
take their arguments on the x87 stack (MSVC emits `fld x; fld y; call
_CIfmod`: the first C argument is ST(1), the second ST(0)) and leave the
result in ST(0) with the stack popped once. The lifter models the x87
stack as `ST0..ST7` shifted by 10-byte copies on `fld`/`fstp`, values
stored as doubles in the low 8 bytes, so the shims read ST1/ST0, shift
ST2..ST7 down and write the result (`host_shims_forward.c`). Both reach
the shim through the CRT's own `jmp [__imp__CI*]` thunks
(`sub_00af08c3`, `sub_00af08c9`), which the lifter turns into the shim
call plus the thunk's ret. Selftest pins: `fmod(7.5, 2) = 1.5` with the
old ST2 becoming ST1, `atan2(1, -1) = 3pi/4`; the argument order and the
pop are mutation-checked.

### 21.23 Round 14f: pre-empting the next walls -- the link-level shim audit

`_CIfmod` was a PROVIDED verdict with no body: the generated `shim_weak.c`
gives every import a weak trap, so a promised import without a strong
`imp_*` definition compiles, links, and traps the first time the game
reaches it -- one wall per play run. `scripts/recomp/host/audit_shims.py`
asks the link instead: llvm-nm over the host objects lists the strong
`T imp_*` symbols, and every PROVIDED/REAL table row must be among them.
The first run found **40**. `host_shims_gaps.c` gives bodies to the ones
on any plausible play path -- `qsort` (a host merge sort calling the guest
comparator through the `_initterm` sub-call shape; stable, which only
narrows the orders the game can see), `_access`, `_Fiopen` (the fstream
open, routed through the fopen shim with a synthesized frame),
`__stdio_common_vsnprintf_s`, `strerror`/`perror`, `FormatMessageA`,
`GetProcessTimes`, `K32GetProcessMemoryInfo`, `WaitForSingleObjectEx`,
`TerminateProcess`, `RaiseException` (a guest C++ throw: nothing here can
unwind it, so it stops loudly with the thrown object and throwinfo),
`GetStartupInfoW`, `OpenProcess`, `K32GetProcessImageFileNameA`,
`K32GetModuleInformation`, `BCryptGenRandom`, the `__std_exception_copy`
/`destroy` pair, `__std_type_info_name`, the `__p___argc`/`argv` cells,
the onexit registrations, `always_noconv`. Ten stay weak on purpose and
are listed in the audit's `KNOWN_WEAK`: the C++ exception machinery
(`__current_exception*`, `_except_handler4_common`, `_seh_filter_exe`),
`CreateFileA` (no handle-level file layer yet) and the codecvt facets.
The audit runs in the test suite (skipping on a checkout without the
built objects) so a new promise without a body fails the suite, not the
game. Selftest pins cover `strerror`, `vsnprintf_s`, `GetStartupInfoW`,
`_access` against the RAM-FS, and the exception-copy pair.

### 21.24 Round 14g: incremental lifted rebuilds

Every lifter change cost a whole-tree recompile (42 TUs, ~17 min on 8
jobs) because the split was by cumulative emitted bytes: one longer
function moved every later boundary and every file changed. Two parts
end that. `emit.py --split-va N` puts a function in the TU of its
address bucket (`lifted_<(va - text_lo) // N>.c`; `0x30000` gives ~40
TUs), so a lifter change that alters one function rewrites one file.
`build_boot.py` records the sha256 of each TU's patched text beside its
object (`lifted_NNN.o.sha`) and recompiles only when it differs
(`--recompile-lifted` still forces everything; an object from before the
hashes is trusted once and stamped). Measured: the first build on the
new split compiled all 38 TUs (1,490 s on 12 jobs, on a loaded machine);
the no-change rebuild right after compiled 0 and linked in 8 s. The
recorded boot argv now carries `--split-va 0x30000 --max-insns 100000`.
`tests/recomp-build.test.js`
pins both halves and the documented argv. Also in this round: the stall
watchdog's `ISAAC_STALL_EXIT=1` (leave through `process.exit` after the
first dump, so a `node --cpu-prof` run writes its profile -- a kill
loses it) and `boot_worker.mjs` (the driver inside a Worker with a large
native stack, to tell deep recursion from a runaway).

### 21.25 Round 14h: the room-entry crawl

After the first entity spawn the game logs nothing for 20 s at a time and
presents no frame for minutes (a 5-minute run: 24 slow image loads and
one 20-s silence in rapidxml's attribute parser, `FUN_004165a0`). Four
measurements, in order, and what each ruled out:

1. **Guest stack and VA ring** (`ISAAC_STALL_DUMP`): ordinary recursive
   XML parsing over a heap document, no loop -- the game is doing real
   work, slowly.
2. **V8 wall-time profile** (`ISAAC_STALL_EXIT=1` so the process leaves
   through `process.exit` and the `.cpuprofile` gets written): 61.6% of
   wall time as *self* time of `isaac_lifted_dispatch`, 60 s of it under
   one caller (`sub_007f2800`, a per-room reset). The dispatcher is an
   O(1) table lookup, so that was either a per-call cost or a
   misattribution. The direct children of the dispatcher's nodes carry
   almost nothing themselves (`Mutex::Lock` 0.72 s over 6.5 M calls), and
   this node's V8 has `--wasm-inlining-call-indirect` off, so the self
   time is not inlined callees either.
3. **Dispatch census** (`[isaac][dispatch]`, printed with the stub
   report): 24.4 M dispatches by the first stall, 0 block re-entries,
   0 misses -- the engine `Mutex` `Lock`/`Unlock` 6.5 M times each through
   their vtable, a lock-increment-unlock helper `0x0040c690` 1.6 M times,
   resource lookups `0x00a12240`/`0x00a128f0`/`0x00a129a0` ~0.9-1.6 M --
   the game's own hot path. And a **micro-benchmark** (`ISAAC_BENCH_DISPATCH=N`
   before `main`: `Mutex::Init` on a fake mutex, then N Lock(-1)+Unlock
   pairs): **0.226 us per pair through `recomp_call_indirect`, 0.132 us
   direct** -- the dispatcher adds ~50 ns per call. 24 M dispatches cost
   ~3 s, not 61.
4. **V8 lazy compilation**: a wasm function is compiled on its first
   call, in the caller's frame, and the first room entry drives thousands
   of never-run functions through the dispatcher.
   `node --no-wasm-lazy-compilation` was not a usable test (instantiating
   the 380 MB module eagerly never settled: six minutes, "unsettled
   top-level await"). A compile-time trace (`node --trace-wasm-compilation-times`) then ruled that out too: by the first room Liftoff had compiled 3,679 functions in 1.1 s total (the largest took 61 ms) and TurboFan 692 in 20.6 s -- on background threads, not in the caller's frame. Lazy compilation is not the crawl. What remains is the dispatcher's own cost *in the game*, which the pre-main bench does not reproduce; round 14j measures it in place (`ISAAC_DISPATCH_TIME=1`: wall time inside every dispatched entry and the dispatcher's bookkeeping, printed with the census).

### 21.26 Round 14i: the parallel lift

The sequential lift is 1,460 s on one core. The stable split (§21.24)
makes every TU a function of the function address alone, so
`scripts/recomp/lift/lift_parallel.py` lifts address buckets in worker
processes (`--jobs 12`, greedy balance by function count) and merges. Two
cuts were wrong before the merge was byte-identical, and both failures are
the same lesson: two of emit.py's decisions are *global*.

1. **Function boundaries.** A worker that knew only its own start subset
   absorbed callees in other buckets as tail-call bodies: every TU
   differed (23,340 functions lifted against 23,238; 869 jump tables
   against 796). `--starts-file` now hands each worker the whole start set
   as boundaries without lifting them.
2. **The fragment safety net.** A Ghidra fragment (a
   `recovered-functions.tsv` row without a prologue) is lifted standalone
   only when no lifted body anywhere reached it. Each worker rescued what
   its *own* bodies missed: +102 functions, exactly the difference in
   `fragments_rescued` (7,063 against 6,961). The lift is now two phases:
   the workers run with `--no-rescue` and write `covered.txt` (the .text
   ranges their bodies occupy, merged); then one `emit.py --rescue-only
   --covered-file` pass over the whole start list rescues against the
   union -- the sequential safety net, once.

The driver then re-splits the functions by address into emit.py's TU
format (header, functions in address order), regenerates
`lifted_decls.h` sorted (a CALLOTHER's arity is the maximum any part
saw), `missing.txt` (references nobody lifted), `data_stops.txt` and
`summary.json` (sums where a sum is the sequential meaning, ratios and
coverage recomputed), and concatenates `stats.json` in lift order. One
more trap: emit.py writes in text mode, so its TUs carry CRLF on Windows;
the driver reads and writes in text mode too (the first merge refused
its own workers' files on the header check).

Result against the built `gu` tree: **36 of 38 TUs byte-identical**, the
other two differing only by the `lift_patches.py` fastpath wrappers the
build applies to the built tree; `lifted_decls.h` and `missing.txt`
identical; every summary count identical (23,238 lifted, 6,961 rescued,
796 tables, 2,048,793 instructions, 508,912,679 bytes of C). **80.4 s
wall** (phase 1 55.7 s on 12 workers, phase 2 14.9 s) against 1,460 s.
`tests/recomp-parallel-lift.test.js` pins the contract.

```
python scripts/recomp/lift/lift_parallel.py --jobs 12 \
    <the emit.py argv recorded in output/recomp/lift/gu/summary.json: argv>
python scripts/recomp/lift/patch_reentry.py --dir output/recomp/lift/gu \
    --exe tools/isaac-ng.unpacked.exe --cont output/recomp/lift/gu/call_cont.txt
python scripts/recomp/lift/build_boot.py        # recompiles only changed TUs
```

### 21.27 Round 14j: the crawl is not guest work -- V8 runtime time under the indirect call

Two more instruments, then a different profiler, and the picture changed:

- `ISAAC_DISPATCH_TIME=1` (dispatch_tbl.c): wall time inside every
  dispatched entry (inclusive) plus the dispatcher's own bookkeeping,
  printed with the census. Bench: 0.62 us per Lock+Unlock pair with it on,
  0.15 off (three `performance.now` calls per dispatch, ~78 ns each).
- `ISAAC_EXIT_AFTER=<s>` (recomp_rt.c): leave with the reports after that
  much wall time. Both it and the silence watchdog run off the 2^20-block
  tick, and in the silent phase that tick comes every 25-100 s -- or never:
  four runs (with and without the timing instrument) sat after the first
  spawn for 1-2 hours at 100% CPU without one, while two others reached
  the dump after ~100 s with the same dispatch count (24,433,467 and
  24,433,472). The guest work is deterministic; the wall time is not.
- The older stall dump's "hottest VAs" were the 5,000-iteration anm2
  array init at `0x40fc50` (`mov esi, 0x1388`), simply where the tick
  landed; a 512-block window says nothing about 20 s. The rapidxml
  reading of round 14h came from the same dump and is withdrawn.
- `node --prof` (`scripts/recomp/profile/prof_stuck.ps1`: the tick log
  survives a kill; Windows samples at 15.6 ms) restricted to the silent
  window (`prof_window.py`): **65% of ticks in ntdll.dll with
  `isaac_lifted_dispatch` as the frame beneath** (via
  `recomp_call_indirect <- sub_007f2800 <- sub_0073e0a0`), 22% in a
  straight-line 28-instruction fragment `sub_0093805f` whose stack is
  itself four deep (a broken frame chain, i.e. more native time), 6% the
  dispatcher's own code, ~1% everything lifted. The process: 101% CPU,
  19 page faults/s, 8 GB of 32 GB free -- not paging. The compile trace
  shows no function compiled more than twice (Liftoff, then TurboFan): no
  code-flush churn.

So the 61% "self time in the dispatcher" of the V8 CPU profile was native
time reached through the `call_indirect`, attributed to the nearest wasm
frame. What native work sits there is not yet proven. The candidate that
fits every measurement: the main thread waiting on V8's per-module lock
-- a lazy compile of never-run room code (3,679 Liftoff compiles by the
first room) queues behind a background TurboFan publish of one of the
giant lifted functions (692 TurboFan compiles, 20.6 s, the largest 1.2 s
each), and the wait counts as CPU because the compiler threads are busy.

**Symbolized** (`prof_ntdll.py` maps the raw tick PCs to ntdll's export
table; capstone on the bytes): 3,312 of the 3,587 ntdll ticks are one
instruction (RVA 0x102da) of an unexported linked-list walk that checks
encoded block headers -- the NT heap allocator's free-list walk. So the
main thread is inside node's malloc/free, called by V8 under the
`call_indirect` (lazy compiles, code publishing); a fragmented NT heap
walks O(n) per call, hence the nondeterministic wall time. Windows-node
specific: Chrome's PartitionAlloc and glibc have no such walk.

Next (the batch that was cut short): the same run under
`--no-wasm-tier-up`, `--no-wasm-dynamic-tiering`, `--no-wasm-inlining`,
comparing wall time from "Room 1.2" to the exit; eager compilation
(`--no-wasm-lazy-compilation`) with a long instantiate wait; and, on the
lifter side, splitting the giant functions (`--max-insns 100000` pieces)
so no single TurboFan unit holds the lock for a second. The browser has
the same V8 defaults, so the fix has to be structural or a warm-up, not
a node flag.

### 21.28 Round 15a: the crawl is TurboFan tier-up (41x, and Liftoff is faster anyway)

The flag batch round 14j asked for, measured end to end with
`ISAAC_LOG_TIME=1` (every `isaac_log` line stamped with
`performance.now()`), the same scripted input, the same build:

| flags | last log line | process wall | silent phase after it |
| --- | --- | --- | --- |
| (none) | 43.2 s | 4,479 s | **4,436 s** |
| `--no-wasm-tier-up` | 38.0 s | 145 s | **107 s** |

**The 41x is withdrawn -- see 21.29.** The `--no-wasm-tier-up` process
did not finish its silent phase in 107 s; it was killed at 145 s (by this
session's own cleanup, whose kill line named that command). An
independent run with the same flag stayed silent past 250 s. What the
table actually shows is one real number, the baseline's ~4,400-s silent
phase, and one artefact. Both runs did log the same **1,577 stamped
lines** before going quiet, so the guest reaches the same place either
way. Two things are worth keeping:

1. **The dev loop.** `ISAAC_V8_FLAGS=--no-wasm-tier-up` on the node
   driver, `tierup=0` on `run_web.mjs`. Node refuses V8 flags in
   `NODE_OPTIONS`, and `v8.setFlagsFromString` runs too late for the wasm
   compiler, so `boot_integration.mjs` re-execs itself with the flags on
   the command line (guarded by `ISAAC_V8_FLAGS_APPLIED`).
2. **Liftoff is not a sacrifice here.** Menu frame times over the same
   21 samples: median **33 ms** with tier-up off against **38 ms**
   baseline, p90 40 against 47. TurboFan's better code does not pay for
   its own compilation while the game is still loading rooms; the giant
   lifted functions are the units it is slowest on (`0x005d4380` alone is
   42,671 x86 instructions, 331,707 lines of C; 21 functions carry 9.5%
   of all instructions and the largest 2 carry 3.1%).

What this does *not* settle: whether tier-up matters at all, and whether
Chromium crawls (it allocates through PartitionAlloc, not the NT heap, and
the round-14j walk was node-specific).

### 21.29 Round 15b: why that measurement could not be trusted, and the fix

Two harness defects, both of which had to be fixed before any A/B of the
crawl means anything:

1. **No wall-clock deadline could fire inside the crawl.** The stall
   watchdog, `ISAAC_PROFILE` and `ISAAC_EXIT_AFTER` all ride the
   `RECOMP_VA` tick, which was every 2^20 lifted instructions. In a phase
   where a dispatch costs milliseconds, that is minutes between ticks --
   so a run in the crawl printed nothing, exited nowhere, and could only
   be ended by a kill, which is exactly how 21.28's 145 s was produced.
   The interval is now `RECOMP_TICK_MASK` (2^16 by default, ~370 ticks
   per room entry, same masked compare), and the profiler's
   instructions-per-sample math derives from it instead of hardcoding
   2^20.
2. **The incremental build ignored headers.** `build_boot.py` hashed each
   TU's own text only (round 14g), so editing `recomp_rt.h` -- where the
   tick interval lives -- rebuilt nothing and would have produced a
   module whose lifted code still carried the old interval, silently.
   The hash now folds in a fingerprint of every header a lifted TU can
   include plus the flag list, printed as `lift : dependency fingerprint
   <hex>`, so a header edit rebuilds all 38 TUs and a flag change does
   too.

With a deadline that fires, the fair comparison is equal wall time rather
than time-to-completion: run both configurations with the same
`ISAAC_EXIT_AFTER` and compare how far the guest got (stamped log lines,
last stamp, dispatch census).

### 21.30 Round 15c: THE GAME PLAYS. The crawl was a missing `case` label.

The room-entry crawl was never slow. It was **stuck**, and the reason is
one missing line of generated C.

A lifted function with an unresolved intra-function computed jump gets a
dispatch loop: `uint32_t pc_ = <entry>; for (;;) { switch (pc_) { ... } }`,
with a `case` per basic block. The block set came from `block_starts()`,
which marks branch targets and the **lowest address in the body** -- and a
function whose body absorbed a lower address range does not have its own
entry among those. `sub_0093805f` (body from `0x00937d63`) opened with
`pc_ = 0x93805fu` and had 288 cases, none of them `0x93805fu`. So entry
fell straight through to `default:`, which spills the registers and parks
a jump to `pc_` -- the function's own entry -- and returns. The caller's
trampoline (round 14d) dispatched it again. Forever, executing **not one
guest instruction**.

That is exactly the shape every earlier measurement reported and none
could explain: 100% CPU on one thread, no lifted-instruction ticks (so no
wall-clock deadline could fire -- round 15b), no compilation, no GC, no
file I/O, no memory growth, a nondeterministic "duration" (it had none;
runs ended only when something killed them), and a V8 profile that
charged the time to the nearest wasm frame it could name, the dispatcher.

**What found it:** `ISAAC_HEARTBEAT=<n>` in the dispatcher and at the host
boundary, printing every n-th call with the wall clock and the target.
The answer was immediate and unambiguous:

```
[isaac][hb] 3836000000 dispatches, 200.2 s, now sub_0093805f
```

3.8 billion dispatches, all to the same address, 20 million a second.

**The fix** is one line in `lift.py`: the dispatch loop's block set is
`block_starts(body) | {start}`. Six functions in the tree had the defect
(`0x93805f`, `0x93810f`, `0x938238`, `0xaa94db`, `0xaa94e8`, `0xaa94f7`);
each was a guaranteed silent hang if the guest ever reached it.

**Two guards so this class cannot hide again:**
- `scripts/recomp/lift/check_lifted.py` verifies the invariant over a
  lifted tree and `build_boot.py` runs it before compiling, so a tree with
  an entry-less dispatch loop is not built at all. It also counts the
  legitimate "entry case only" functions (a `jmp reg` tail call), which
  are not failures.
- `recomp_run_pending` now aborts with a diagnostic when the same parked
  target repeats 4,096 times with the VA-trace index unchanged: no guest
  instruction executed means it is a lifter defect, not a guest loop.

**The result.** With the fix, the same scripted run (Enter through the
menus, then movement keys) plays the game:

| | before | after |
| --- | --- | --- |
| log lines in 300 s | 2,455 | 20,202 |
| frames presented | 660, then stuck | **13,860** |
| frame time | -- | **median 4 ms, p90 5 ms** |
| room transitions | 0 | **654** (Start Room <-> Room 13.5) |
| dispatches | 24 M, then spinning | 77.9 M, 0 misses |
| exit | killed | `ISAAC_EXIT_AFTER` budget, cleanly |

One 45-s stall remains, early, in the engine `Mutex` path
(`0x00a157f0`/`0x00a159a0`), and it recovers. That is the next thing to
look at, and it is an ordinary slow patch rather than a hang.

Two things ruled out along the way and worth not re-testing: wasm
compilation (0.7 s in a 200-s silent window under
`--trace-wasm-compilation-times`) and heap size (the crawl was identical
with `--initial-memory 0x60000000`, 1.5 GiB up front).

### 21.31 Rounds 15d-15e: the archives the game opens once it plays, and the memory that costs

**15d.** `music.a` (182 MB) and `videos.a` (93 MB) sit in the instance but
the driver skipped them, with a comment saying they are "not on the boot
path". True while the boot stopped at the menu; a run that reaches
gameplay opens both and logged `Failed to open archive file` for each.
They now go through the round-12f lazy path -- registered by size, read on
first open -- so a run that never asks still pays nothing. The two errors
are gone; the ones that remain are DLC and language archives this instance
genuinely does not carry.

**15e.** That has a price, and it showed up immediately: a 200-s play run
fell from 7,980 frames to **900**. Opening `music.a` pushes the module
past `INITIAL_MEMORY`, and growing a wasm memory reallocates and copies
the whole heap. Three points, same build otherwise:

| INITIAL_MEMORY | frames in 200 s | room transitions |
| --- | --- | --- |
| 384 MiB (old default) | 900 | 1 |
| 768 MiB (new default) | 7,260 | 322 |
| 1536 MiB | 7,980 | 358 |

768 MiB is the default now; `--initial-memory` overrides it. (This is also
the measurement that ruled memory growth *out* as the room-entry crawl in
round 15c: the crawl was identical at 1.5 GiB.)

Also in 15e: the stub-hit recorder was a linear scan over every record
seen so far, run on all 66.5 M stub calls of a ten-minute run -- 65.9 M of
them the four critical-section symbols, which are inert by design. It is
now an import-index table, and the return address (a guest memory read) is
computed only on a symbol's first hit.

### 21.32 Round 15f: the fast profile, and the next boundary (an entity trail loop)

**The fast profile builds again.** `build_boot.py --fast` had two
undeclared-identifier failures, both the same shape: a declaration inside
`#if RECOMP_MEM_CHECK` with an unconditional user outside it.
`RECOMP_TICK_MASK` was round 15b's (recomp_rt.c's profiler reads it
unguarded); the host fastpath declarations predate this session (the
`lift_patches.py` WRAP_PATCHES wrappers call them in every profile, so
`lifted_034.c` could not compile). Both are hoisted, and
`tests/recomp-build.test.js` pins that the unconditional pieces stay above
the guard.

What it buys: a **50 MB module against the debug profile's 385 MB**, and a
12,000-frame run in **43 s (279 fps)** with 558 room transitions. The
debug profile's comparable figure is the 79 fps of the 30-minute soak;
these are different runs, not a controlled A/B, so read it as "roughly
3x" rather than a measured ratio.

**And the next boundary, which the soak had hidden.** That soak's "no
stall in 30 minutes" was one lucky run. Two later runs of the same shape
both stopped shortly after the first room with enemies in it:

- one hung at 900 frames right after the game's own assertion
  `[odsa] [ASSERT] - CellSpace::insert: x1 > x2`;
- one hung at 660 frames with the watchdog naming a tight loop at
  `0x00942d08..0x00942d79`, inside `FUN_00942c0e` (288 bytes), entered
  just after `Spawn Entity with Type(222)` and two `Type(244)`.

That loop fills a 120-entry ring (`cmp ecx, 0x78`) of xmm pairs at
`[esi+0x50]`, with the count at `[esi+0x58]`, the head at `[esi+0x5c]`
and the capacity at `[esi+0x54]` -- an entity trail or afterimage buffer.
Its two `idiv dword ptr [ebp-0x14]` both divide by that capacity, and the
branch at `0x00942d26` reaches a `call 0x00a112c0` (the engine
log/assert entry) when the count equals the capacity and is not positive
-- i.e. when the capacity is **zero**. A zero there makes the division
undefined and the ring never reaches its bound.

So the next unit of work is: who writes `[esi+0x54]`, and why it is zero
here. It is the same family as the `CellSpace` assertion, a struct field
that should have been initialised, and both appear only once enemies
exist, which is why every earlier run missed them.

### 21.33 Round 16: the audio pipeline

Three pieces, of which two are done and the third is now precisely located.

**The engine (host_audio.c).** `host_shims_al.c` answered all 26 openal32
names with benign constants: buffers and sources were tokens nobody
remembered, play was a no-op, and `alGetSourcei(AL_SOURCE_STATE)` always
said `AL_INITIAL`, so the slot poller reused one voice forever and a
streaming source could never report a processed buffer for the music path
to unqueue. There is now a real object model. Buffers keep their PCM with
format, channels, depth and rate, and the duration those imply. Sources
have state, gain, pitch, an optional static buffer and a queue, and they
advance on the wall clock: a source stops when its sound would have
finished, and a streaming source retires queued buffers as they play out.
That is correct with no output device at all, which is what node has.

**The backend (host_audio_web.c).** WebAudio, `-DISAAC_WEB=1` only. An AL
buffer becomes an `AudioBuffer` (interleaved 8- or 16-bit PCM
de-interleaved into float channels), a source becomes a `BufferSource`
into a `GainNode`, and gain, pitch and looping map straight across. The
hooks in host_audio.c are weak, so the node profile links and runs silent.
No entry point may throw into the guest, so each swallows its own errors.

**The thread the port does not have (round 16b).** The game mixes on a job
spawned through `_beginthreadex` that never returns:

```
while ((self[1] & 4) == 0) {          /* until asked to stop */
    if (!vt[0x20](self)) vt[0x3c](self);
    Sleep(5);
}
```

`ISAAC_RUN_THREADS=1` enters it at 19 s and never comes back (10 frames in
200 s), exactly as the cooperative runner's comment warned. But one
iteration is a pair of virtual calls, so the host is the thread instead:
the spawn hands the mixer's `this` to host_audio.c rather than adopting a
runnable job, marks the thread struct done so the engine's destructor does
not `std::terminate`, and the frame present pumps one iteration per frame.
Measured: 869 iterations over 840 frames, no trap, no slowdown.

**Where it still stops, exactly.** A run now says what the game does with
the surface: 64 sources and 64 buffers at init, three deleted, and then
**no `alBufferData` and no `alSourcePlay` at all** -- through 199 room
transitions of real play. The play path is `FUN_00a9fb80`, and it opens
with

```
if (vt[0x38](this) == 0 && this[10] != 0 && this[0xb] != 0) { ... alBufferData(..., this[10], this[0xb], ...) }
```

`this[10]` and `this[0xb]` are the sample's PCM pointer and its size. They
are zero, so nothing is ever submitted: the sound objects exist but hold
no decoded audio. The game does reach the data -- the FS trace shows
`sounds.xml` opened and `resources/packed/sfx.a` opened **303 times** --
so the gap is between reading the archive entry and decoding it into PCM.
That decode is the next thing to chase, and it is the last piece of the
audio pipeline.

Two smaller findings from the same round. The AL string answers all share
one scratch address, so a guest that keeps the pointer from `alcGetString`
reads whatever `alGetString` wrote later (the boot log's "ALC_EXTENSIONS :
wasm headless" is that aliasing, not a real answer). And copying the
user's real `options.ini` into the instance makes the boot abort after
shader init, so the port reads that file but cannot yet satisfy something
in it; the run stays on defaults for now.

### 21.34 Round 16c: following the sound from the archive to the source

The host pipeline is built (21.33), so everything here is about the guest.
Four measurements, each with a tool that stays.

**The archive layer is healthy.** `ISAAC_FS_READ_TRACE=<substring>` logs
every `fread` of the matching files with offset, requested and returned
length. On `sfx.a` the game reads the 7-byte magic, the header, the table
of contents at the end of the 25 MB file, and then sequential 1 KB payload
chunks -- **26,387 reads totalling 25,333,050 bytes, which is the whole
file**. Every sample is fetched. Nothing is failing between the RAM-FS and
the decoder.

**The play path is reached, and stops one step short.**
`ISAAC_DISPATCH_WATCH=<hex va>[,...]` says the first time each of up to
eight functions is dispatched and counts them, which neither the
hottest-16 census nor the heartbeat can do. Over a full menus-to-gameplay
run:

| function | role | dispatches |
| --- | --- | --- |
| `0x00a7cab0` | `SoundEffect::Play` | 5 |
| `0x00a9fb80` | bind a source, `alBufferData`, `alSourcePlay` | **0** |
| `0x00aa0640` | the streaming variant | 0 |

`Play` queues the sound on the manager's pending list and then plays it
only `if (this[0xd] != 0)` -- `this[0xd]` being the AL source id that
`0x00a9fb80` assigns. Nothing assigns it, so nothing plays. The pump
census confirms the queue is real and never drains: `pending=1 sounds`
for thousands of frames.

**The mixer thread is not the mixer.** Its handler `FUN_00a9e720` does
all of its work inside `if (this[0x60])`, and the only writer of that byte
is `FUN_00a9e890`, the ALC_SOFT_system_events callback that logs
"OpenAL-SOFT device has changed". So that thread watches for device
changes; OpenAL itself is the mixer. The round-16b pump is therefore
correct but not the missing piece, and it stays because the loop does have
to run.

**Forcing the flag does not help** (`ISAAC_AUDIO_DEVICE_EVENT=1`, kept as
a documented negative): setting the byte the callback would set makes the
handler take its drain path and the run ends immediately afterwards. So
the drain is a device-change rebuild, not the ordinary route to a source.

What is left is the ordinary route: something calls `0x00a9fa00`
(`vt[0x3c]` then `0x00a9fb80`) through a vtable, and in this port it never
happens. That call site is the whole remaining gap between a game that
loads every sound and a game that can be heard.

### 21.35 Round 16d-16e: the sound objects are never given a sample

The dispatch watch had said `sub_00a9fb80` was never dispatched, which was
misleading: `sub_00a9fa00` IS dispatched, and it reaches the other as a
DIRECT call, which never goes through the dispatcher. A lift-patch wrapper
that only observes (the lifted body still runs and owns its `ret`) settles
what the bind gate sees:

```
bind probe #1: this=0x0213636c vtable=0x00ba2974 pcm=0x00000000 bytes=0 format=0x0 rate=0 source=0
  sample descriptor this[0x44]=0x00000000 -> ptr=0x00000000 len=0, loaded flag this[8]=0
```

So the source-binding function runs, several times per run, on sound
objects whose PCM pointer, length, format and rate are all zero -- because
the sample descriptor they read from, `this[0x44]`, is null and their
"loaded" flag is clear. Nothing ever attached a sample.

The class is now mapped from its live vtable (`0x00ba2974`):

| slot | function | role |
| --- | --- | --- |
| +0x04 | `0x00a9fb00` | `SetSampleData(ptr, len)`: writes `this[10]`, `this[0xb]`, derives the AL format |
| +0x08 | `0x00a9f840` | getter for the descriptor's length |
| +0x2c | `0x00a9fa00` | the bind path: `vt[0x3c]` then `0x00a9fb80` |

and `0x00a9f850` is the method that would carry a sample across: it reads
`this[0x44]`, sets the loaded flag, and calls slot +0x04 with the
descriptor's `{ptr, len}`. The constructor (inside `0x00a2b1e0`, which
allocates 100 bytes for a static sound or 0xA8 for a streaming one) nulls
`this[0x44]` and the object never gets one.

So the audio question is now one specific question: **what should fill a
sound's sample descriptor after construction, and why does it not run
here.** Everything downstream of it is known good -- the archive is read
in full, the play call queues, the bind call runs, and the host side has a
complete OpenAL implementation waiting for the first `alBufferData`.

### 21.36 Round 18: the path hash, and what the grind really is

The stall watchdog now prints 16 dwords at each pointer register, not just
the register image, because a hang is nearly always a loop over an object
and reading that object used to need a bespoke rebuild. The first dump it
produced named the work immediately: ECX held
`gfx/1000.021_Tiny Bug.anm2`, and the hot addresses were the engine's
path hash (`FUN_00a159d0`) and the path normalisation above it
(`FUN_00a17180`) -- the game was grinding resource lookups while spawning
one enemy.

The hash is a pure leaf and now has a host fastpath:

```
h = 0x1505
for each byte b until NUL:
    c = ('A' <= b <= 'Z') ? b + 0x20 : b     /* lowercase */
    if (c == '\') c = '/'                    /* separator folded */
    h = h * 33 + c
```

thiscall, string in ECX, hash in EAX. Run under `ISAAC_FASTPATH_VERIFY=1`,
which executes both the host version and the lifted one and compares every
call, it produced **1,800 frames in 90 s with zero mismatches**. On the
scenario that used to stop at 660 frames it now reaches **900**.

**But the grind is not gone, and the next dump says why.** The hot loop
moved to `FUN_0041bb50` -- a spatial grid insert. It walks a rectangle of
cells (`row * width + column`), bounds-checks the index against the cell
count, and appends an entity into each cell's 40-entry list. That is the
same class as the assertion an earlier run hit,
`[odsa] [ASSERT] - CellSpace::insert: x1 > x2`.

So both symptoms are one function, and the shape of the problem is a
rectangle that should be a few cells and is not. The next step is the
computation that produces those bounds, which is entity-position float
work -- a conversion defect there would produce exactly this: an
assertion when the bounds invert, and a very long loop when they do not.

### 21.37 Round 20: the port plays at 53 fps -- the grind was the debug build

Profiling gameplay with the fixed tick (`ISAAC_PROFILE=1`) gives a clean
picture at last: **9.0 billion lifted instructions in 447 s, 21.1 MIPS**,
and two functions are 42% of it -- `0x00adb9c0` (23.1%) and `0x00a68cf0`
(19.0%), the archive stream reader and the decompressor underneath it
(zlib is in the image; its error strings are there). Asset loading is what
the game spends its time on.

Then the number that reframes everything. The same 1,380-frame scenario,
same input, same progress (one room transition each):

| profile | wall | frames/s |
| --- | --- | --- |
| `--fast` (`RECOMP_MEM_CHECK=0`) | **26 s** | **53** |
| default (bounds checks + VA trace) | 525 s | 2.6 |

**Twenty times.** Every "grind", "stall" and "hang" measured in gameplay
so far has been the debug instrumentation: a bounds check and a VA-trace
store on every guest memory access and every instruction. The port itself
plays at 53 fps with room transitions and enemies on screen.

That does not retract the defects found through those stalls -- the
`CellSpace::insert` assertion is real, and the path-hash fastpath (21.36)
is a real saving in both profiles -- but it does change what "slow" means
here. Measure with `--fast`; debug with the default, and read its wall
times as roughly 20x inflated.

### 21.38 Round 21: THE GAME PLAYS IN THE BROWSER

`--web` and `--fast` were mutually exclusive by accident -- each assigned
the output directory, so asking for both produced a browser module written
into the fast directory with the host objects half-applied. The browser is
where the speed profile matters most (21.37 measured it 20x in gameplay),
and a demo of more than a few hundred frames cannot afford the debug
build. They now combine into `boot-web-fast`, and `run_web.mjs fast=1`
serves it.

The result, in Chromium with software WebGL2 and no GPU:

| | frames | wall |
| --- | --- | --- |
| debug browser module | 300 | 46.6 s |
| **fast browser module** | **1,500** | **44.9 s** |

Five times the frames in the same wall clock, including a fixed ~16 s of
startup and 300 MB of asset fetching, with all 20 scripted inputs
delivered and `main` returning 0.

And the frames show the game. `output/recomp/web-gameplay/frame_1500.png`
is a Basement room: Isaac with a three-heart HUD, the coin/bomb/key
counters, the minimap, rocks, a door, and two enemies on screen. That is
the browser target working end to end -- boot, asset load, menus, a
started run, room generation, input, and gameplay rendering.

### 21.39 Rounds 22-24: the audio thread jobs run, and the sound path is read to its end

Three rounds on the one question left from 21.35: the game creates 64
sources and 64 buffers, parses `sounds.xml`, reads all 25 MB of `sfx.a`
at boot, and never submits a sample. Each round removed one candidate.

**Round 22** implemented the OpenAL-SOFT extension the engine asks for
(`ALC_SOFT_system_events`: `alcEventControlSOFT`, `alcEventCallbackSOFT`,
plus the `alcReopenDeviceSOFT` / `alcDevicePauseSOFT` / `alcDeviceResumeSOFT`
family the mixer probes through `alcGetProcAddress`). The device-change
event is delivered to the registered callback with the mixer's user
pointer. It changed nothing audible: the census still ends in
`no audio data was ever submitted`.

**Round 23** added observe-only probes (`PROBE_PATCHES` in
`lift_patches.py`): a wrapper that stamps its VA, calls the lifted body
exactly once and touches neither EIP nor ESP, logging under
`ISAAC_PROBE=1`. They answer what the dispatch watch cannot -- a function
whose callers reach it directly is never *dispatched*, so "dispatched 0
times" is not "called 0 times". The catalogue reader `sub_00952df0` runs
once; the WAV loader `sub_00a7b6a0` is never called by anyone.

**Round 24: the guest's threads.** The engine spawns four thread jobs and
this runtime ran none of them:

| job | spawn | loop body |
|---|---|---|
| audio device watcher | `_beginthreadex` via trampoline 0x00a7f130 | `0x00a7da80(0x00c5aaa0)`: `while(!(flags&4)){ if(!step()) idle(); Sleep(5); }` |
| 100 ms poller | same trampoline | `0x00a220c0(0x00c57b18)`: `PeekMessageA` + `Sleep(100)` |
| theora worker | `CreateThread` | `0x00aab120`: names itself, then `worker->execute()` |
| async job queue | same trampoline | `0x00a9e950(0x00c79a7c)`: lock, pop ring, run `fn(&job,arg)`, notify observers |

The trampoline's job wrapper `0x00a5a760` reads `{obj, fn, arg}` out of a
12-byte block and frees it before calling `fn(arg)`, so a job cannot be
entered twice through it (round 24b found that as "indirect call to
0x00000000 from 0x00a5a787"). Every loop above never returns and blocks
in `Sleep`, `WaitForSingleObject` or an idle lap on a critical section.

**Slices.** `isaac_threads_slice()` (host_shims_module.c) runs from
`SwapBuffers`, once per presented frame: each adopted job is entered *at
its loop function with its long-lived object* (ECX and the stack
argument), on a scratch stack 16 KB below the frame's ESP, under a
`setjmp`. The places a real thread would block are the yield points:

- `Sleep` (host_shims_forward.c) yields after advancing the deterministic
  clock;
- `WaitForSingleObject` yields only when the object is not signalled --
  round 24d moved the yield below the signalled test after seeing that a
  queue waiting on its own still-set event yielded on every slice;
- `EnterCriticalSection` reports every acquire to `isaac_threads_note_cs`;
  the same lock acquired twice with no other host-boundary call in
  between is the idle lap of a queue loop and yields. Any other shim call
  is progress (`isaac_threads_progress()` from `isaac_indirect_call`).

A yield is a `longjmp` back to the runner, which then restores the outer
guest-call frame (`isaac_guest_jmp_save/restore` in mkdispatch.py;
`isaac_guest_call` is nesting-safe now), clears `recomp_jmp_pending` and
the re-entry EIP, and moves to the next job. A job that returns is
retired and its Thread struct's done flag set. `ISAAC_THREADS=0` turns
slicing off; `ISAAC_RUN_THREADS=1` is the old inline runner.

For that to hold the critical-section family became real bodies
(`Initialize`/`Enter`/`Leave`/`Delete`/`TryEnter`, `TryEnter` always
succeeds: nothing can contend a section on one thread), `CreateThread`
adopts its job like `_beginthreadex`, and `RaiseException(0x406D1388)` --
the MSVC "SetThreadName" convention the theora worker raises first thing,
meant to be swallowed by its own `__except` -- returns instead of being
treated as an unwindable C++ throw.

Census of a 150 s node run with slices on: 4 jobs adopted, 4,269 frames
sliced, every job 4,269 slices and 4,269 yields; the device watcher's
idle step (`0x00a9e720`, the mixer's active-list drainer) dispatched once
per frame; no stall, no trap, `main` exits through `ISAAC_EXIT_AFTER`.
The thread machinery works. It did not produce sound, because the sound
path does not go through those threads at all -- see below.

**The boundary that is left, audited.** Every import the game reaches is
either a real host body or a recorded STUB verdict in `gen_shims.py`, and
the stub report at the end of a run lists the first call of each stub
with its caller. After round 24 the list is:

| import | caller | why it does not matter |
|---|---|---|
| `SteamInternal_SteamAPI_Init` | 0x00a5f0f6 | returns "no Steam"; the game runs in its offline path (no achievements upload, no cloud) |
| `EOS_Initialize` / `EOS_Platform_Create` / `EOS_Shutdown` / `EOS_Platform_Tick` | 0x00a5f8fe / 0x00a5fa11 / 0x00a5fa2d / 0x00a71745 | Epic Online Services; the platform handle is null and the per-frame tick is a no-op on it |
| `SetThreadExecutionState` | 0x00a5f167 | display/sleep inhibition |
| `timeGetDevCaps` / `timeBeginPeriod` | 0x00a5f174 / 0x00a5f180 | timer resolution; the runtime's clock is its own |
| `TranslateMessage` | message pumps 0x00a5e690 / 0x00a6db02 / 0x00a81498 | keyboard-to-character translation of queued messages; input is delivered to the game's own key state directly |
| `PeekMessageA` | 0x00a6daeb, the 100 ms poller thread | never a message; the poller sleeps |
| `DragAcceptFiles` | 0x00a5d31c | file drag-and-drop onto the window |
| `SendMessageA(WM_SETICON)` | 0x00949b3f | the window icon |

None of these carries game state. The evidence that they do not matter is
the 30-minute soak (142,680 frames, no stall) and the browser gameplay of
21.38, both taken with every one of them stubbed.

**Round 24e: why the port was silent -- three of our own doors.** With the
threads out of the way, the sound path was read to its end, and none of
it was audio code:

1. **The sounds are not in the instance.** String probes on the ogg
   stream's `Queue(path)` (0x00a7c760, the one call the music path makes
   after creating a stream) showed the first two sounds the game asks for
   are `music/Repentance/Genesis Retake Light Loop.ogg` and its Twisted
   layer -- the title theme -- and that the call returns false before
   reaching `stb_vorbis_open`. Hashing every catalogue path against the
   archive tables (the key is `djb2` + FNV-1a over `resources/<path>`,
   case-folded, `\` folded to `/`: 102 of the extracted tree's files match
   `graphics.a` that way and none match without the prefix) showed
   `music.a` holds 82 of the 179 tracks in `music.xml` and `sfx.a` 201 of
   the 1,557 samples in `sounds.xml`. The rest -- every Repentance sound --
   lives in `afterbirth.a` (145 MB), `afterbirthp.a` (604 MB) and
   `repentance.a` (385 MB), which the instance never carried. The engine
   had been logging `Failed to open archive file` for them all along.
2. **The archive index was unreachable.** The project's own emulator-era
   patch at `0x009ab970` (§19.5) stubs the function that creates the
   `resources/` mount root; round 11 kept it that way so the small base
   archives would not shadow the extracted tree. With only the `""` root,
   every relative key misses the index (keyed `resources/...`) and resolves
   through the loose files -- fine for gfx and xml, fatal for sounds that
   exist nowhere else. The round-10 override is back (`lift_patches.py
   PATCHES`), and the shadowing argument is gone with the full archive set
   mounted: the mount loop (0x00a179c0) overwrites an equal-hash entry, so
   the last archive mounted, `repentance.a`, wins, exactly as in the real
   game. The language packs stay unlisted for the same reason (they would
   win).
3. **The open itself was patched out.** `0x00a2b5c2`, listed in §19.5 as
   "branch forced", is inside the sound manager's create-source function:
   pristine `cmp byte [ebp+0x14], 0; je 0xa2b5e1` became `jmp 0xa2b6de`,
   which skips the block that opens every sound source right after its
   construction (`vt+0x1c Open(path)`, `Failed to open %s "%s"` on
   failure). That is why the WAV loader and the ogg opener were never
   called by anyone. Ghidra had split the skipped tail off as its own
   function starting on the orphaned byte (the pristine `je`'s rel8),
   decoding an `sbb` that swallowed two real instructions. The fix is a
   new block-level lift patch (`BLOCK_PATCHES`): the branch is restored as
   a tail jump into that function's re-entry switch, its first block is
   re-decoded from 0xa2b5c8, and both targets get a case.

Mounting 1.2 GB of DLC archives inside a wasm32 heap needed one more
piece: **windowed lazy files** (`host_shims_fs.c`, `boot_integration.mjs
isaacLazyPread`). A lazy entry of 32 MiB or more is never loaded whole;
`fread` serves it through two 1 MB windows refilled by positional reads
of the host file (two, because the mount loop alternates between the
entry table at the end of the archive and each entry's data: one window
turned 1.5 GB of archives into 4.7 GB of host reads). The engine reads
every archive front to back at mount -- a per-entry checksum -- so the
boot now moves ~1.5 GB through those windows before the first frame.

**Round 24f: what the open needed once it ran.** With the branch restored
the first archive-set run reached the WAV loader (`sub_00a7b6a0`, the
probe that had never fired) and stopped twice more, each one a runtime
limit rather than a game defect:

- **The re-entry index.** The restored branch is a tail jump to a block
  of another function, and the dispatcher's VA index holds function
  entries and CALL continuations only (`mkdispatch.py`, `call_cont.txt`);
  the jump died as "resolves to neither a host shim nor a lifted function".
  A RECOMP_VA line carrying `LIFT-PATCH REENTRY` is a re-entry block now;
  the two targets are declared that way by the block patch itself.
- **The guest heap.** The engine preloads its whole catalogue: 1,557
  samples, 269 MB of PCM (198 in `sfx.a`, 213 in `afterbirth.a`, 1,146 in
  `afterbirthp.a`). The 192 MiB arena ran out at 201 MB live and the last
  199 loads failed for want of memory (`Failed to open sample`, every one
  a file that hashes to an entry in `afterbirthp.a`). The arena is 768 MiB
  now and everything above it moved up by 0x24000000: stack, TEB, module
  and handle tokens, the shim arena (0x33000000) and the host base
  (`-sGLOBAL_BASE=0x34000000`, INITIAL_MEMORY 1088 MiB, MAXIMUM_MEMORY
  4 GiB). `gen_shims.py` reads the shim base from `isaac_host.h` instead
  of baking `0x0f000000`, `recomp_rt.h`'s guest bound matches the host
  base, and `tests/recomp-memory.test.js` pins the three spellings to one
  number. The selftest caught the table: 196 checks. The bigger arena
  exposed one more thing: the engine reserves address space for its Lua
  arena with a ladder (1 GiB, then 512 MB), which costs nothing on Windows
  until committed; here the arena is always committed, so the 512 MB step
  that now succeeded was real memory, and the guest's Lua allocator is
  replaced by the host's anyway. A reserve-only `VirtualAlloc` above
  `ISAAC_RESERVE_MAX_MIB` (128) fails -- what the 192 MiB arena did
  implicitly. And the move found every host-written guest scratch object
  that had been placed by a raw address in the old TEB neighbourhood (the
  fake Steam context and its vtable, the DI8 object, the GL/AL/env/vfprintf
  scratch pages, the CRT `tm` buffers, the EXE module token): after the
  move that range was inside the arena, and the first browser boot died on
  a fake vtable slot the allocator had handed out. They are all
  `ISAAC_TEB_VA`-relative now, and `tests/recomp-memory.test.js` refuses a
  raw `0x0e0xxxxx` in host code.
- **A replayable run.** The engine seeds its run RNG from the time of day,
  so every run was a different floor, and a floor-dependent defect seen in
  some runs -- the player bouncing between the start room and a neighbour
  once per game frame for ~35 frames right after the run starts -- could
  not be replayed. `ISAAC_EPOCH=<unix seconds>` pins `_time64` and
  `GetSystemTimeAsFileTime` (host_shims_crt_time.c / host_shims_misc.c);
  the deterministic frame clock is unchanged. That ping-pong is the open
  gameplay item.
- **The join.** With the thread jobs sliced, the game's shutdown aborted:
  it stops a thread by setting its stop bit and waiting on the handle, and
  `~Thread` (0x00a5a700) calls `std::terminate` if the thread is still
  joinable (0x00a7f1e0 tests the done flag). The handle was signalled at
  creation, so the wait returned at once. A wait on a thread handle is a
  join now: `isaac_threads_join` slices that one job until its loop
  returns (bounded by `ISAAC_JOIN_SLICES`, default 4,096; a loop that
  ignores its stop bit is reported and the done flag forced).

**Round 25: the browser build is interactive (JSPI).** The web module's
frame loop never returned to the event loop, so no DOM event could reach
the game while it ran. The speed profile now links with JSPI
(`-sJSPI -sJSPI_EXPORTS=isaac_run_main,isaac_run_boot
-sJSPI_IMPORTS=emscripten_sleep -sSUPPORT_LONGJMP=wasm`, the last one
reaching `dispatch_tbl.c` and a second Lua archive built with it, because
a JSPI suspension cannot cross the `invoke_*` trampolines the old setjmp
lowering leaves behind); with `ISAAC_YIELD=1` (`run_web.mjs interactive=1`)
`SwapBuffers` suspends the whole wasm stack for one macrotask per frame,
`Sleep` suspends for its delay (capped at 50 ms, never inside a thread
slice), and the clock is the wall clock. `boot_web.mjs` awaits the
promise-returning entry and feeds live keyboard and mouse events.
Measured in headless Chromium: yield off, 1,500 frames in 41.7 s (the
JSPI link costs nothing: 36.6 s like-for-like against the pre-round
module's 37.9 s); yield on, 1,469 frames in 39.3 s with all 18 live key
events delivered and the menu-to-run progression identical to the
scripted timeline, 49-59 fps during play, the page answering screenshots
between frames. The module grew 7 KB. `tests/recomp-jspi.test.js` pins the
flags and hooks.

The browser gets the archive set the same way node does: `boot_web.mjs`
registers the DLC archives lazily and refills the RAM-FS windows through
`?off=&len=` byte slices of the runner's static server (a positional read,
never the whole archive per window).

**The result.** Node, debug profile, the HANDOFF timeline, 240 s: 92-99
PCM uploads (5.7-7.2 MB, 34-52 s of audio), 17-23 `alSourcePlay`, 85/61
music-stream buffers queued/unqueued, peak guest heap 354 MiB, clean exit.
Headless Chromium, the fast module, same timeline: **329 uploads (42 MB,
385 s of audio), 102 plays, 308/76 queued/unqueued, the WebAudio context
running, 1,501 frames in 67.6 s wall** including the archive mount over
HTTP, `main` returned 0. The port has sound.

### 21.40 Round 26: the boot pays for the archives only once

**The mount's checksum pass.** With the DLC set the engine's mount loop
(0x00a179c0) read every entry of every archive -- 1.5 GB through the
RAM-FS windows -- before the first frame, folding a checksum per entry
(`h = rotr1(h) + u32` from 0xababeb98 over 0x200-byte chunks) and
comparing it with the entry's stored value. That was ~65 s of a
debug-profile boot, and in the browser every one of those bytes came over
HTTP as 1 MB slices. The archives are verified offline now
(`scripts/recomp/assets`), so the lifted mount skips the pass: a block
patch at 0x00a17cee (`lift_patches.py BLOCK_PATCHES`) asks the host once
per entry (`isaac_archive_verify_on()`, host_shims_fs.c) and, unless
`ISAAC_ARCHIVE_VERIFY=1`, leaves `esp` and `edi` as the hash-table insert
at 0x00a17dc1 expects them and jumps there. Entries are still read -- and
still decoded through the engine's own reader -- when the game opens them.
Measured on the same pinned floor (debug profile): the second frame at
**2.9 s instead of 65 s**; the audio census is identical (93 uploads, 17
plays); the run's whole archive traffic is 827 MB through 831 window
refills instead of 1.5 GB before the first frame.

**A scripted way into the video path.** Nothing in the input timeline
reaches the Theora endings (cutscenes.xml `<videopart>`, decoded by the
theoraplayer worker that runs as a per-frame slice since round 24).
`ISAAC_CUTSCENE=<frame>:<id>` makes the frame present call
`Manager::ShowCutscene(id, 1, 0)` (0x00958e60, thiscall on the Manager at
[0x00c7169c]) at that presented frame -- the same call the game makes when
a run ends; id 3 (Epilogue) is anm2, then `001_Epilogue.ogv`, then the
credits.

**Less log.** The DirectInput-region shim ENTER/EXIT trace in
`isaac_indirect_call` was unconditional; with the device poller sliced every
frame that was two `PeekMessageA` lines per frame, thousands per run. It is
`ISAAC_DSP_TRACE=1` now, like `_setjmp3`'s per-site cap (8) from round 24.

**The interactive page, state-driven.** With the boot this fast the
frame-keyed input timeline of `run_web.mjs` lands on whatever screen is up
in interactive (wall-clock) mode -- one run parked on the main menu, the
next on the beta notice. `scripts/recomp/web/drive_interactive.mjs` presses
Enter (held 120 ms: the game samples keys once per frame, and a tap inside
one tick lands between two samples -- forty taps on the beta notice, none
seen) until the game's own log says a run started, then walks. Measured:
first frame 1.45 s after load, a run after 9 Enters, walking changes the
picture, 243 PCM uploads (103 s of audio), 22 plays, the WebAudio context
running (resumed on the first key press, the autoplay policy's user
activation), `main` returned 0. The screenshot after walking is a Basement
room with the HUD and the minimap -- and the floor banner reads
`#BASEMENT_NAME I`: with the `resources/` root back the string table is
read from its `afterbirthp.a` entry (it used to come from the loose file)
and the lookups miss. Open; probes on the `.sta` parser and its stream
open are in the next build.

**The first video, and twelve intrinsics.** `ISAAC_CUTSCENE=300:3` opened
`001_Epilogue.ogv` from `videos.a` ("16 precached frames") and stopped
twice in our runtime: first on `0x00ae4820`, libtheora's `emms; ret`
reached only through its cpu-dispatch table (a hand-written body in
missing_fns.c), then on `pmaddubsw` -- one of twelve SSE wide intrinsics
the tree declares that had stayed aborting stubs (`pmaddubsw`, `pshufb`,
`paddsw`, `pmulhuw`, `pmulld`, `pabsd`, `pmovsxwd`, `pmovzxwd`, `psraw`,
`divps`, `maxps`, `minps`; the AVX2 ones stay stubs, no AVX2 is reported).
They are in `recomp_rt.c` now, alias-safe like `pshuflw`, and each is a
case in the single-instruction oracle (`wideops.py`, 200 random vectors
against Unicorn): all pass. The oracle needed two repairs to run at all
(`recomp_rt.c` had grown an unconditional `emscripten.h` and references to
the dispatch table and the stub report) and one rule: on a lane where both
engines produce a NaN the payloads may differ -- with two SNaN inputs the
SDM and this machine's own SSE quiet the first operand, Unicorn's softfloat
quiets the second -- so those lanes compare NaN-to-NaN; numeric lanes stay
byte-exact. With both in place the Epilogue plays through: the video is
created, decoded by the theoraplayer worker slice (4,338 slices in the
run), uploaded frame by frame (`glTexSubImage2D`), logs `finished
playing` and is destroyed, the credits follow and the game comes back to
the title menu -- 4,320 frames to the exit budget, no trap. **The port
plays video.**

**The archives, opened.** `scripts/recomp/assets/archive.py` reads and
writes the engine's `ARCH000` container exactly as the engine does
(reversed from the mount loop 0x00a179c0, the entry stream 0x00a68a50 /
0x00a68c50 / 0x00a68cf0 / 0x00a69510 and the v2 keystream 0x00aa93e0 /
0x00aa9580 / 0x00aa94a0 / 0x00a89d70): three container versions -- v0
(graphics, sfx, music, videos): per-dword XOR with `(h2 ^ 0xf9524287) | 1`
through an xorshift 8/9/23 stream and a byte permutation keyed by the low
nibble; v1 (animations, config, fonts, rooms): MSB-first 8..12-bit LZW with
the table persisting across pieces; v2 (every DLC and language pack):
`u32 len|final<<31` pieces of raw deflate through one persistent tinfl
state with a 0x400 window, where a non-final 0x400-byte piece is stored
bytes XORed with an ISAAC keystream seeded by PCG32 from `h2`. The table's
fifth field is the checksum the mount folds over the *decoded* bytes in
0x200 chunks through one buffer zeroed once per entry (a final partial
dword carries the previous chunk's stale bytes). Proof: **27,236 of 27,236
entries across all 22 archives recompute to the stored value**, and an
unchanged repack is byte-identical for every archive. `tests/recomp-assets.test.js`
pins the hashes against a real table entry, the checksum with its
stale-tail quirk, and a pack/verify/extract/repack round trip for v0 and v2.

What the census found: `repentance.a` (385 MB) is never named by this exe
and shares no key with anything the game opens -- the Repentance content of
this build lives in `afterbirthp.a`; the drivers no longer register it.
48.8 MiB of base-archive entries are shadowed by later mounts. The loose
extracted tree (252 MB, 11,198 files) is read **zero** times at run time
(only `scripts/*.lua` through the cwd); it can leave the bundle. Language
packs (89 MB) stay unmounted on purpose.

**Size, without a pixel changed.** Lossless PNG (oxipng level 4, every
reduction off, all chunks kept, and every output verified with Pillow:
IHDR, mode, size, samples, palette, tRNS, gamma identical): 12,757 PNGs,
169,251,008 → 106,687,721 bytes. Music re-encoded at Vorbis q3 with its
comments kept (no loop tags exist; Isaac loops whole files): 426,082,525 →
158,424,937 bytes. The ten archives the exe mounts: **1,069,689,641 →
750,186,557 bytes (−29.9 %)**; with the never-mounted `repentance.a` out
of the bundle that is 48.4 % less than today. The optimised set was
validated in-engine with `ISAAC_ARCHIVE_VERIFY=1` (the engine really
checksums) on a pinned floor: 0 checksum failures, 0 sample/stream
failures, audio census intact, clean exit. Sound effects were measured
only: 1,557 samples, 265.6 MiB of PCM as preloaded; OGG q3 would be
27.7 MiB but turns them into play-time streams, so nothing was applied
there.

**The ping-pong was a square root.** With replayable floors the
start-room ping-pong and the CellSpace grind could be chased on one seed.
The lifter emits `recomp_wr64(dst, recomp_fsqrt_f64(recomp_rd64(src)))`
for `sqrtsd` -- the operand's bit pattern in, the result's bits out, like
every other f32/f64 helper -- but `recomp_rt.h` declared that helper
`double(double)`. The bits arrived as a value: the pattern of 98800.0 is
a 4.7e18, its root a 2.2e9, and that, written back as a bit pattern, is a
denormal -- every positive root came back 0. The game's `sqrtf` wrapper
(0x00435a50) answered 0 for every vector length, every door within its
25 px radius "touched" at once, and entity positions went inf/NaN, which
is where the `x1 > x2` cell bounds came from too. The helper takes and
returns bits now (`tests/recomp-fsqrt.test.js`, mutation-checked against
the old text), and `sqrtsd`/`sqrtss` are oracle cases (the old helper
failed `sqrtsd` 200/200 with truncated-integer results). Verified on the
lifted code, not just the helper: the door-touch check `FUN_007f01c0`
(the only animation-0 caller of `Game::StartRoomTransition` 0x006fd7c0)
compares `sqrtf(dist to cell centre + 18 px outward)` with 25 px; with
the zero root the first open door in slot order fired every frame -- a
314 px "touch" on epoch 1700000000 (`door0 ... dist0=314.33`, slot 0
fired), 538 px on 1700000001 while a door 58 px away was ignored. After
the fix the same three epochs do zero transitions and zero asserts before
any movement key; the in-situ test (`ISAAC_ROOM_TEST=1`: the lifted
sqrtf and door loop on a scratch frame with the player moved host-side)
reads `sub_00435a50(98800.0) = 314.3247`, does not fire from the room
centre and fires at a door. `ISAAC_ROOM_PROBE=1` prints the door-check
inputs at every engine log line. Two harness notes from the chase:
`ISAAC_EXIT_AFTER` never fires in the fast profile (`RECOMP_VA` is
`((void)0)` there; use `ISAAC_MAX_FRAMES`), and the `[dsp] ENTER/EXIT`
trace for the poller's `PeekMessageA` (200k lines a run) is now behind
`ISAAC_DSP_TRACE=1`.

**Replayable floors.** `ISAAC_EPOCH=<unix seconds>` pins `_time64` and
`GetSystemTimeAsFileTime`, the sources of the run RNG seed; two runs with
the same epoch log the same `SpawnRNG seed` lines.

### 21.41 The string table, and 813 functions that started in the wrong place

**Symptom.** Every `#KEY` the HUD asks the string table for came back raw
(`[RoomConfig] load stage 1: #BASEMENT_NAME`), in every run ever logged
(77 logs), with the table read from `afterbirthp.a` or from the loose
file.

**The chase, in order, because each step corrected the previous one.**
A block probe at the loader (`0x00a26f20`, after the read) printed a
buffer whose first dword was the entry-stream vtable and whose tail was
correct XML, which read as an allocator overlap. `ISAAC_HEAP_TRACE=1`
(new: every guest `malloc`/`free`/`calloc`/`realloc`/`VirtualAlloc` with
its result and the guest return address) showed the stream at
`0x01b8f958+4` and the buffer at `0x01b939c4`, disjoint -- the probe had
read `[ebp-0x10190]`, a spilled stream pointer, instead of the buffer's
`[ebp-0x10090]` (a typo, now corrected in the applied text). A second
probe at the parser's return read the parser's error slot (`[0xc7de4c]`,
a static message pointer: "expected <", "unexpected end of data", ...)
as NULL and the cursor at buffer+size: the parse succeeds. A wrapper
probe on `StringTable::GetString` (`0x00a26af0`: category, language,
key, result) answered `StringTable::InvalidLanguage` for language 0 --
the loader's language map was empty. A wrapper on the XML child finder
(`0x00413c70`) showed the loader never asked for "stringtable" at all.

**Cause.** Ghidra splits the loader at the parse-error branch: the
success path is its own function, `FUN_00a27038`, entered by a tail jump
(`jz 0xa27038`), and that function's body ALSO owns the loader's shared
epilogue block at `0x00a2701b` (the `mov al,1; jmp 0xa2701b` at its end
goes there). The lifter emits a goto-shaped function's blocks in address
order, so `sub_00a27038` began with the epilogue: restore FS:0, pop, cookie
check, `ret` -- it returned at once with EAX still 0, the loader "failed"
with no error, the map stayed empty. The PROBE wrapper's "result" line
had reinforced the wrong reading: a wrapper prints EAX when the lifted
body returns to it, which for a tail jump is BEFORE the jump runs
(`recomp_run_pending` is the caller's).

**Census.** `scan_entry`: of 23,252 lifted functions, 819 begin (first
`RECOMP_VA`) below their entry; 6 are dispatch-loop shapes (`pc_ =
start`, immune since round 15c), 813 are goto shapes: 778 thunks in the
CRT region (`0x00af1270`-style `jmp` thunks whose targets Ghidra folded
in, where the skipped instructions are the thunk's own) and 35 game
functions, among them `sub_0073e5ae` (the room loader's neighbourhood),
`sub_00751e74`, the `sub_00776374..7764eb` group, `sub_009d16d8/2640/2bf7`
and `sub_00a2b5c7` (the sound-source open patched in round 24).

**Fix, twice.** `lift.py` now emits `goto L_<entry>;` as the first
statement of a goto-shaped function whose lowest block is not the entry
(and asks for the entry label). For the already-lifted tree,
`lift_patches.py apply_entry_first` (run by `build_boot.py` with the
other passes, or alone with `--entry-first [--check]`) inserts the same
goto after the re-entry guard and the `L_<entry>: ;` label after the
entry's trace line, marked `LIFT-PATCH entry-first`, idempotent; 813
functions in 11 TUs, no re-lift. `tests/recomp-entry-first.test.js` runs
the pass on a synthetic CRLF tree (goto, label, dispatch-loop and
hand-written bodies untouched, idempotent, `--check`), pins the emitter
text, and scans the lifted tree when present. Result: `GetString("Items",
0, "THE_SAD_ONION_NAME")` -> "The Sad Onion"; 0 lookups fail in the boot.

### 21.42 Round 27: the dispatch census's leaves -- it was ISAAC, not memcpy

**The census, and a wrong name.** The fast profile has no instruction tick,
so its only profile is the dispatch census (`ISAAC_PROFILE=1
ISAAC_DISPATCH_TIME=1`): how often each lifted entry is reached through the
dispatcher, and the wall time inside it. On the HANDOFF timeline (epoch
1700000000, `ISAAC_MAX_FRAMES=3000`) it counted **92.8 M dispatches**, and
71.0 M of them were four entries with the same count, 17,754,432 each:
`sub_00aa94ce / db / e8 / f7`. The round brief read them as the jump-table
tail cases of the CRT memcpy. They are not. `memcpy` is a vcruntime140
import (`0x00af05df` is its thunk; the shim serves it), and the function
whose body ends in `and eax,3; jmp [0xaa956c+eax*4]` is `0x00aa94a0` --
Bob Jenkins' `isaac()`:

```
c++; b += c
for i in 0..255:
    x = mm[i]
    a ^= {a<<13, a>>6, a<<2, a>>16}[i & 3]        <- the jump table
    a += mm[(i+128) & 255]
    mm[i] = y = mm[(x>>2) & 255] + a + b
    r[i] = b = mm[(y>>10) & 255] + x
```

on a context laid out `{index, r[256], mm[256], a, b, c}` (0x810 bytes). It
is the refill of the v2 archive keystream (21.40), called from the consumer
`0x00a89d70` every 256 words -- once per stored 1 KB piece. Each `switch`
case is its own lifted fragment, so every iteration whose case differs from
the running fragment's is a `recomp_jump_indirect` through the dispatcher:
256 dispatches per call, 277,413 calls in 3,000 frames, 284 MB of keystream.
That volume is the sound catalogue: the PCM it preloads from `afterbirthp.a`
is stored, not deflated, so every byte of it goes through the XOR loop and
every kilobyte through `isaac()`.

**Nine exact host versions** (`host_fastpath.c`, installed by
`lift_patches.py WRAP_PATCHES`; `ISAAC_FASTPATH=0` lifted,
`ISAAC_FASTPATH_VERIFY=1` both and compare, default host):

| VA | function | host path | left to the lifted body |
|---|---|---|---|
| `0x00aa94a0` | `isaac()` | the 256-step mix on the guest context; a, b kept in locals (no mm/r index can alias them), stored at the end; EAX/EDX handed back as the loop leaves them | a context outside the guest |
| `0x00a89d70` | keystream XOR (thiscall; buf, len) | byte loop, word r[idx] every fourth byte, refill on r[255] | an index past r[] (never seen) |
| `0x00a69510` | `ArchivedFile::read` (thiscall; buf, size, count; `ret 0xc`) | the copy out of the 0x400-byte window at +0x81c, pos/fill/eof at +0xc1c/+0xc20/+0xc28, stream position +0x18; also the eof-cut read | any read that needs the refill `0x00a68cf0` (LZW / deflate / keystream state) |
| `0x00a157f0` | `Mutex::Lock(timeout)` (`ret 4`) | INFINITE and uncontended: `EnterCriticalSection`'s report to the thread slicer (`isaac_threads_note_cs`, which may yield exactly where the lifted Enter would), then the locked byte at cs+0x18, EAX = 1 | a set byte (the Sleep(1000) spin), a finite timeout (QPC deadline), an uninitialised mutex (the fatal) |
| `0x00a159a0` | `Mutex::Unlock` | the byte cleared; Leave is a no-op here; EAX = 0 | uninitialised |
| `0x0040c690` | handle `AddRef` | lock, `++count` (u16 at +4), unlock; EAX = 0 as the tail jump into Unlock returns | a mutex whose vtable is not the engine's Lock/Unlock pair |
| `0x0040c6b0` | handle `TryAddRef` | lock, unlock, then `vt+8` -- checked to be AddRef -- inline; EAX = count != 0 | any other `vt+8` |
| `0x0040c630` | handle `Release` | lock, `--count`, unlock, EAX = 1 | a count of exactly 1 (the dispose path: two virtuals and a tail jump) |
| `0x00a12240` | owner check (cdecl; holder) | lock, read the count, unlock | a NULL handle, a count of 1 (calls `0x00a121b0`) |

The handle helpers explain the Mutex counts: each `TryAddRef` was six
dispatches (itself, Lock, Unlock, AddRef through `vt+8`, its Lock and its
Unlock) and every one of the 1,235,942 AddRefs came from a TryAddRef. The
mutex is embedded at handle+8 (`lea ecx,[esi+8]`), reached through its own
vtable (+0xc Lock, +0x10 Unlock), so the host path first checks that those
slots are the engine's pair; anything else runs the lifted body.

Three rules beyond the round-12 contract, all pinned by
`tests/recomp-fastpath.test.js`:

- **the decision comes before any side effect.** A wrapper reads what it
  needs (the count, the locked byte, the window fill, the vtable slots) and
  either runs the host path to its `ret` or the lifted body from its first
  instruction -- never half of each. Nothing can change between the peek and
  the lifted body's own test: the runtime is single-threaded, and a yield
  inside Enter abandons the slice, wrapper and all.
- **the purge equals the callee's `ret N`** (`s->ESP += 4u + 12u` for the
  read, `+ 8u` for the XOR, `+ 4u` for Lock): a wrong one is the one-slot
  drift of round 11 again.
- **a verify path runs the trampoline** (`if (recomp_jmp_pending)
  recomp_run_pending(s)`) after the lifted body, because these bodies end in
  parked tail jumps -- `isaac()`'s cases, AddRef's jump into Unlock -- and a
  compare without it reads the state mid-function (the same trap 21.41 met
  in the PROBE wrappers).

Verify mode compares the whole 0x810-byte context for `isaac()`, buffer
plus context for the XOR, the delivered bytes and the three fields for the
read, and count / locked byte / EAX / ESP for the mutex family; each wrapper
counts its lifted fallbacks and completed compares and the stub report
prints them (`[isaac][fastpath] ---- mode ...`), so "0 mismatches" is
stated over a number. The selftest pins the host code on its own: Jenkins'
two-half-loop formulation of `isaac()` (rand.c, `rngstep` over m/m2) is the
reference for the merged single loop the engine compiled, the XOR is
checked across a refill boundary (r[254], r[255], refill, r[0]), the
read's window arithmetic through its seven cases, and the mutex predicates;
seven mutants (shift 13->12, the second-pointer offset, the `y>>10` index,
the refill threshold, the eof clause, the Unlock slot, the byte's offset)
are killed through `mutate.mjs`. The installer also refreshes a wrapper
whose text changed since it was installed -- before this round an edited
`WRAP_PATCHES` entry silently kept the stale wrapper in the tree (it found
one: the round-26 probe on `0x00a26af0`).

**Measured** (fast node profile, the HANDOFF timeline, 3,000 frames;
another session's boot run held one core throughout):

| | before | after |
|---|---|---|
| dispatches | 92,553,339 | **11,251,305** (-88 %) |
| `sub_00aa94ce/db/e8/f7` | 4 x 17,745,088 | 0 |
| `sub_00a157f0` Lock / `sub_00a159a0` Unlock | 5,074,905 / 5,071,905 | 537,878 / 534,878 |
| `sub_0040c690` AddRef | 1,235,942 | 0 (inside TryAddRef) |
| boot to frame 3 (the catalogue preload) | 4,371 ms | **3,207 ms** |
| steady-state gameplay, median per 60 frames | 30 ms | 31 ms |
| verify (`ISAAC_FASTPATH_VERIFY=1`) | | **0 mismatches**, Basement reached, `main` returned 0 |

The verify census of that run (`ISAAC_FASTPATH_VERIFY=1`: every wrapper
computes the host result, restores, runs the lifted body and compares):

| wrapper | calls compared | ran the lifted body instead (why) |
|---|---|---|
| `Mutex::Lock` / `Unlock` | 5,071,906 / 5,071,906 | 0 (no contended lock, no finite timeout in the whole run) |
| `AddRef` / `TryAddRef` | 1,235,942 / 1,235,942 | 0 |
| `Release` | 1,037,894 | 16,551 (the count reaching zero: the dispose path) |
| owner check | 1,027,248 | 10,645 (a count of 1, or a NULL handle) |
| `isaac()` | 277,278 | 0 |
| keystream XOR | 262,684 | 0 |
| `ArchivedFile::read` | 948,597 | 10,749 (reads that need a refill: the bulk PCM copies, which loop refill-and-copy inside the lifted body) |

**16,169,397 calls compared, 0 mismatches**, over a run that reaches the
Basement, presents 3,000 frames and returns 0 from `main`.

**Wall time, A/B on one module.** The fair comparison is the same build
with `ISAAC_FASTPATH=0` (wrapper plus lifted body) against the default,
three alternating pairs, medians; module time is the `ISAAC_LOG_TIME`
stamp, so it excludes node's start-up and the 50 MB module's compile:

| phase | lifted | host | |
|---|---|---|---|
| boot to frame 3 (the catalogue preload) | 4,615 ms | **2,913 ms** | -37 % |
| the menu windows (frames 420-780, the scripted Enters) | 1,892 ms | 1,503 ms | -21 % |
| steady gameplay, median per 60 frames | 30 ms | 27 ms | -10 % (0.50 -> 0.45 ms a frame) |
| the floor-load window (frames 900-960) | 2,953 ms | 3,666 ms | **+24 %** |
| play phase, frame 3 to 3,000 | 6,273 ms | 6,503 ms | +4 % (478 -> 461 frames/s) |
| whole module run | 10,979 ms | **9,597 ms** | -12.6 % |
| process wall, start to exit (three runs) | 26.9 / 26.8 / 27.9 s | 25.8 / 25.5 / 26.3 s | -1.2 s |

Every phase is faster except one, and that one is consistent: the window
in which the run starts -- the Basement is generated, its first room and
the entities' graphics are loaded -- takes 0.7 s longer in host mode in all
three pairs (2,460-3,326 ms against 3,403-4,067 ms, the ranges do not
overlap). No wrapper is on that path in any measurable way (the reads it
makes are the same in both modes, and the census above says which ones the
host serves). What differs is *when* the window starts: 1.7 s earlier in
host mode, and V8 tiers the lifted functions up on background threads --
the giant room loader and the 42,671-instruction spawn factory
(`0x005d4380`, 2.9 s inclusive in that window) get their TurboFan code at
some wall-clock time after they first run. The test is the same pair with
tier-up off (`ISAAC_V8_FLAGS=--no-wasm-tier-up`, Liftoff code only, no
background compile, no on-stack replacement), one pair:

| Liftoff only | lifted | host |
|---|---|---|
| boot to frame 3 | 4,558 ms | 3,079 ms |
| the floor-load window | 3,398 ms | **3,110 ms** |
| play phase | 6,491 ms (462 fps) | **5,758 ms (520 fps)** |
| whole module run | 11,137 ms | **8,938 ms** (-20 %) |

With the compiler out of the picture the host mode wins the window too, so
the +0.7 s is the pipeline's timing, not the code's: the earlier the floor
load starts, the more of it runs before its functions are optimised. (One
pair, so a note rather than a claim: on this 3,000-frame budget the host
run without tier-up, 8,938 ms, also beat the host run with it, 9,597 ms,
the shape of round 15a's withdrawn observation, now on a working
measurement. The right test is the equal-wall-budget one of 21.29.)

The inclusive times from the profiled runs (`ISAAC_DISPATCH_TIME=1`
stamps every dispatch, so both columns carry the same inflation):

| entry | dispatches before -> after | inclusive ms before -> after |
|---|---|---|
| `sub_00931050` (the main loop) | 1 | 29,953 -> 12,503 |
| `sub_00a69510` `ArchivedFile::read` | 1,183,671 -> 1,054,318 | 16,783 -> 1,582 |
| `sub_00a7b6a0` WAV loader | (direct) | 15,221 -> 1,292 |
| `sub_00a64a50` `Image::LoadPNG` | (direct) | 2,783 -> 1,415 |
| `sub_00aa94ce/db/e8/f7` (`isaac()` cases) | 4 x 17,754,432 -> 0 | 4 x ~1,390 -> 0 |
| `sub_0040c6b0` TryAddRef | 1,235,942 -> 1,235,942 | 1,637 -> 128 |
| `sub_0040c630` Release | 1,054,445 -> 1,054,445 | 606 -> 110 |
| `sub_00a12240` owner check | 1,037,893 -> 1,037,893 | 595 -> 106 |
| `sub_00a157f0` Lock / `sub_00a159a0` Unlock | 5,074,928 / 5,071,928 -> 537,889 / 534,889 | 446 / 413 -> below the report's cut |
| `sub_0040c690` AddRef | 1,235,942 -> 0 | 412 -> 0 |
| all dispatched entries | 92,827,063 -> 11,369,333 | 88,887 -> 29,387 |

(The read counts differ between runs because the music stream is fed on
the wall clock: a slower run streams more.)

**The browser.** The same lifted objects link into the fast browser module
(`build_boot.py --web --fast`, the host TUs rebuilt as `.web.o`); under
headless Chromium (`run_web.mjs output/recomp/web-r27 3000 fast=1 ...`)
the 3,000-frame timeline reaches the Basement, presents all 3,000 frames,
returns 0 from `main` with 0 assertions, the WebAudio context running (310
PCM uploads, 16 plays), 14.14 M dispatches (the wall clock runs longer
there, so the music stream is read more) and the same fastpath census
shape, 0 mismatches. 77.4 s of runner wall, 13.4 s of it the 1.2 GB
archive fetch before frame 3, so ~50 frames/s in play -- the SwiftShader
software-GL bound of 21.39 (49-59 fps), which guest-side savings do not
move; the browser gains what node gains in the boot and the menus.

**What stays hot, and why it is not a wrapper.** `sub_0040c200`
(`guard_check_icall`, 568 k) is a bare `ret` reached through
`call [__guard_check_icall_fptr]`: the dispatch is the caller's indirect
call, and a wrapper cannot remove it. The WAV loader `sub_00a7b6a0`'s 15 s
of inclusive time was the read chain under it (the keystream and the
window copies), not its own code. `sub_00a129a0` / `sub_00a128f0` are the
renderer's shader and texture binding (GL calls), `sub_00a52820` is the
`fread` wrapper, and `Image::LoadPNG` (`sub_00a64a50`) is libpng's inflate
in lifted code -- a host `inflate_fast` on zlib's exact state layout is the
next exact leaf if it ever matters.

### 21.43 Round 28: the shipping bundle

**The question.** The instance the port boots from is a 1,937,711,471-byte
ResourceExtractor dump (11,263 files): three copies of the exe, the runtime
DLLs, the archives' contents extracted loose to the root and again under
`resources/`, twenty-two archives of which eleven are language packs that
must not be mounted and one (`repentance.a`) this exe never names. Round 26
made the archives smaller; this round decides what ships at all, and proves
the answer by running from it. The tool is `scripts/recomp/assets/bundle.py`
(`build` / `check` / `classify` / `table` / `rules`); the bundle is
`.scratch/game-bundle`, hard-linked from the optimised instance (nothing is
re-encoded by the bundler; nothing game-derived enters the repository).

**The census, at two levels.** Every rule below rests on what the runs
opened, not on what the tree looks like. The node fast profile was booted from
`.scratch/game-instance-opt` with `ISAAC_FS_TRACE=1` (every probe the RAM-FS
shim answers) *and* a `--require` hook on node's `fs` (every open, stat and
positional read the process makes -- which is where the host Lua's NODERAWFS
reads live; the shim never sees them), through the HANDOFF timeline to a
Basement at 3,000 frames (epoch 1700000000) and through `ISAAC_CUTSCENE=300:3`
(the Epilogue video). Both runs returned 0 from `main` with 0 asserts.

- *Guest level.* The `fopen` hits are the ten archives -- afterbirthp.a
  11,830 times, afterbirth.a 2,898, graphics.a 2,627, sfx.a 494, music.a 90,
  config.a 25, videos.a 18, rooms.a 14, fonts.a 13, animations.a 2 (the entry
  stream reopens its archive per entry) -- plus `savedatapath.txt` once, and
  the saves under `./Documents/My Games/Binding of Isaac Repentance+/`
  (MISS, then hit: the game writes them, then reads them back). Misses the
  game shrugs off: `kage_mount_points.dat`, `resources/secret.a`,
  `sharedsave{1,2,3}.dat`, the older games' save directories. The mount
  opens the archives in this order, every run: animations, config, fonts,
  graphics, music, rooms, sfx, videos, afterbirth, afterbirthp. The mount-root
  scan (`FindFirstFileW`) touched `resources` and `resources/packed` and
  nothing else; `/mods/`, `/data/` and the save directory answered `DIR`
  although nothing was registered under them -- the game creates them
  itself (`CreateDirectoryA`). `resources/scripts/enums.lua` and `main.lua`
  MISS in the RAM-FS and `Running Lua Script:` follows anyway, which is the
  host Lua reading them from the cwd.
- *Host level.* Bytes read from the instance: afterbirthp.a 740,238,288
  through 707 positional 1 MB reads, afterbirth.a 87,012,552 / 84, music.a
  6,020,642 / 6, videos.a 1,778,426 / 2 (2,827,002 / 3 with the cutscene),
  the six boot archives once each in full, `enums.lua` 158,046 bytes and
  `main.lua` 46,813 through NODERAWFS (311 + 93 reads of the host Lua's
  512-byte buffer). Everything else the driver registered was `stat`-ed for
  its size and never opened. The loose tree was read **zero** times, as in
  every traced run since round 24.
- *Browser.* `run_web.mjs` now writes `served_files.json` next to its log
  (every 200 by path: requests and bytes before base64) and takes
  `instance=<dir>`. From the bundle it served 27 distinct files over 837
  requests, 0 missing: the page and module (boot.wasm 50,764,402 bytes,
  isaac.segs.bin 8,646,165, the 1,032-byte instance index), the ten archives
  (afterbirthp.a 744,969,360 bytes in 711 slice requests, afterbirth.a
  93,395,914 / 91, music.a 9,830,214 / 10, videos.a 1,636,046 / 2, the six
  boot archives once each) and the eleven files under `resources/scripts`,
  which the page copies into MEMFS before `main`. 942,541,791 bytes in all.

**The rules** (`bundle.py rules`; first match wins). KEEP: the ten mounted
archives; `resources/scripts/*.lua` + `licenses` (enums/main are read at
boot, the rest is what `require` can reach from them); `savedatapath.txt`.
DROP, each with its evidence: `repentance.a` (never named by this exe:
whole-.text census, not in the 0xbfae60 list, 0 opens, unregistered by both
drivers; 385,003,320 bytes); the eleven language packs (the hash-table insert
at 0x00a17dc1 probes for an equal `(h1,h2)` and stores over that slot -- read
off the decompile this round, the last mount wins -- so a mounted pack would
shadow English assets; the engine logs `Failed to open archive file` for the
seven it names and carries on; 89,490,978 bytes); `resources/packed/readme.txt`;
the executables and libraries (30 files, 44,400,866 bytes; the lifted module
is the exe, the host shims are its DLLs; the drivers never register them);
run-time state and provenance (`Documents/`, `data/`, `mods/`, dot files,
a 9.6 MB `v8-stuck.log` someone left in the instance); and the loose extracted
tree (11,196 files, 339,151,040 bytes, read 0 times: KAGE resolves a key
against the archive index before a mount root's loose map and afterbirthp.a
holds the Repentance+ files; `secret.a` is asked for as `resources/secret.a`
and misses, `keeper.a` is never asked for). A file no rule matches is dropped
and listed; `--strict` refuses to build with one.

**Shadowed entries dropped.** With last-mount-wins confirmed, an entry whose
key recurs in a later archive can never be served, so `archive.py repack
--drop-shadowed-by` removed them (passthrough, byte-exact for what stays):
graphics.a 926 of 2,300 entries, afterbirth.a 1,511 of 2,647, fonts.a 6 of
10, music.a 3 of 83, rooms.a 3 of 13, sfx.a 3 of 301, videos.a 1 of 17 --
34,539,702 bytes on the optimised set (48.8 MiB measured on the pristine
archives; the PNG and music passes had already shrunk those entries).
config.a (24 of 24 shadowed) and animations.a (1 of 1) ship whole: the mount
opens them by name and 790,982 bytes is not worth an empty archive the
engine has never seen. Every rebuilt archive re-verifies entry for entry
(`archive.py verify`): graphics 1374/1374, music 80/80, videos 16/16, sfx
298/298, rooms 10/10, fonts 4/4, afterbirth 1136/1136, afterbirthp
10228/10228.

**Music quality, decided with numbers.** `optimize.py music` on the pristine
music.a (82 catalogued tracks, 182,560,078 bytes of Vorbis):

| quality | music bytes | music.a file | vs q4 |
|---|---|---|---|
| q3 | 63,507,630 | 63,692,322 | 9.8 % smaller |
| **q4** | 70,401,239 | 70,585,930 | -- |
| q5 | 89,081,846 | 89,266,534 | 26.5 % larger |

The rule was "ship q4 unless q3 is within 5 % of it": q3 is 9.8 % smaller,
not within 5 %, so **q4 ships** -- Vorbis's nominal 128 kbps point, for
17,776,343 bytes more than q3 across the three archives that carry music
(music.a +6,893,609, afterbirth.a +2,337,637, afterbirthp.a +8,545,097), 2.4 %
of the bundle. The DLC archives were re-encoded from the pristine bytes onto
the PNG-optimised ones (`optimize.py music --source <pristine.a>`, new this
round: the music entries come from the source archive by key, everything
else passes through, so no generation is lost): afterbirth.a 25 of 30 tracks
replaced (5 are 1-4 kbps layer intros already below q4), afterbirthp.a 72 of
72, comments preserved, 0 failures. Sound effects stay WAV: the engine
preloads WAV and would open OGG samples as play-time streams (round 26's
measurement: 1,557 catalogued samples, 265.6 MiB of PCM as preloaded; q3
OGG would be 27.7 MiB but changes the behaviour). Not applied.

**The size table** (`bundle.py build .scratch/game-instance-opt
.scratch/game-bundle --original .scratch/game-instance --strict`, exact bytes):

| archive / group | original | optimised instance | bundle |
|---|---|---|---|
| resources/packed/animations.a | 660,301 | 660,301 | 660,301 |
| resources/packed/config.a | 130,681 | 130,681 | 130,681 |
| resources/packed/fonts.a | 15,061 | 7,271 | 7,271 |
| resources/packed/graphics.a | 17,554,022 | 6,301,054 | 6,301,054 |
| resources/packed/music.a | 182,744,758 | 65,404,742 | 65,404,742 |
| resources/packed/rooms.a | 655,906 | 501,695 | 501,695 |
| resources/packed/sfx.a | 25,333,050 | 25,196,098 | 25,196,098 |
| resources/packed/videos.a | 93,004,538 | 85,522,126 | 85,522,126 |
| resources/packed/afterbirth.a | 145,319,513 | 86,356,974 | 86,356,974 |
| resources/packed/afterbirthp.a | 604,271,811 | 463,375,896 | 463,375,896 |
| scripts + save path (12 files, kept) | 344,101 | 344,101 | 344,101 |
| repentance.a (dropped) | 385,003,320 | 368,793,706 | -- |
| language packs (11, dropped) | 89,490,978 | 89,490,978 | -- |
| loose extracted tree (11,196, dropped) | 339,151,040 | 339,151,040 | -- |
| executables, libraries (30, dropped) | 44,400,866 | 44,400,866 | -- |
| run-time state, provenance (2, dropped) | 9,630,470 | 9,630,470 | -- |
| dev leftovers (1, dropped) | 1,055 | 1,055 | -- |
| **TOTAL** | **1,937,711,471** | **1,585,269,054** | **733,800,939** |

The ten mounted archives: 1,069,689,641 → 733,456,838 bytes (68.57 %). The
bundle: **733,800,939 bytes in 22 files, 37.87 % of the original instance**,
22 hard links, manifest `.bundle.json` (path, size, sha256 per file, the
dropped groups, the mount order). `bundle.py check .scratch/game-bundle`
re-hashes every file and refuses an extra, a missing, a resized or an altered
one, or a manifest whose totals do not add up (`tests/recomp-bundle.test.js`
breaks a synthetic bundle each of those ways).

**Proof: the port runs from the bundle.** Same epoch, same timeline, the
drivers pointed at `.scratch/game-bundle` (`ISAAC_INSTANCE_DIR=<dir>` on the
node driver, `instance=<dir>` on `run_web.mjs`, both new and pinned), the
fast modules copied to `boot-fast-r28` / `boot-web-fast-r28` so a concurrent
relink could not trap the runs:

- node, timeline: `[RoomConfig] load stage 1: Basement`, 3,000 frames, `main`
  returned 0, guard intact, **0 asserts**, `39 buffer uploads (2.4 MB of PCM,
  14.4 s of audio), 11 plays`, 804.5 MB through the archive windows, 11.4 s
  wall; 12 loose files registered (the scripts and the save-path note), 0 read
  through the RAM-FS.
- node, cutscene: `ShowCutscene(3)` at frame 300, `001_Epilogue.ogv` created
  (16 precached frames) and `finished playing`, 3,000 frames, `main` returned
  0, 0 asserts, 69 uploads / 6 plays, 16.3 s wall.
- browser (headless Chromium, fast module): 3,001 frames presented, `load
  stage 1: Basement`, `main` returned 0, 0 asserts, 314 uploads (19.6 MB,
  115.9 s of audio) / 14 plays, 76.8 s wall, 18 scripted inputs delivered;
  frame 1000 is Isaac walking to the start room's right door. The two `Failed
  to compile fragment shader` lines (Bloom, Hallucination: a GLSL ES `for`
  init) and the one GL error are in every web run since round 26, before
  this round; both shaders exist only in afterbirthp.a.
- The A/B that matters: the engine's own `[odsa]` log from the bundle run is
  **identical** to the census run's on the un-dropped q3 archives -- 523 of
  523 lines for the timeline, 750 of 750 for the cutscene, the one differing
  line a heap pointer in `CURRENT ROOM INDEX`. Room, stage and seed sequences
  match line for line. The bundle changes nothing the engine reports.
- `bundle.py check` passes again after the runs: the game writes its saves
  into the RAM-FS, not into the bundle.

What the bundle does not settle: `resources/secret.a` (the root `secret.a`
is a 10-entry version-5 archive the game asks for under `resources/` and
does not get -- shipping it there would mount content today's runs never
see), and the gameplay depth of round 27's list. Try it: HANDOFF.md.

### 21.44 The explorer: an automated play test (round 29)

**Why.** Every scripted timeline so far was blind: a held D walks the
player into the east wall on whatever row the run started, and no room was
ever left except by the sqrt defect. "Gameplay" had been verified as "a
run starts and frames present". The explorer turns the node profile into
a play test that reads the game's own state and reports a census.

**What it reads** (`scripts/recomp/lift/explore.mjs`; the guest arena is
identity-mapped into the wasm heap, so a guest VA indexes `HEAP32`; the
boot module exports `HEAP32`/`HEAPU8` only, a Float32 view is kept over the
same buffer): `Game` at `[0x00c71678]`; the current room at `Game+0x18300`
(width `+0xc`, height `+0x10`, index `Game+0x18304`); `RoomTransition` at
`Game+0x1b83c` (idle == 0); the player vector at `Game+0x1baa8..+0x1baac`;
eight door slots at `room+0x724` (state `+0xc`, open == 2; grid index
`+0x24`; target room `+0x394`; trigger point = cell centre + 18 px outward,
slot & 3 = west/north/east/south); every entity's type `+0x28` (player 1,
tear 2, NPCs 10..0x3ed), position `+0x33c/+0x340` and dead byte `+0x173`.
NPC objects are found by their vtable (`0x00b67468`, from the constructor
0x006b8590) with one linear scan of the arena (~0.3 s, once): the 512
pooled `Entity_NPC` objects; a live enemy is one with an NPC type, a
position inside the room and the dead byte clear. Tears: `0x00b64eac`.

**What it does.** Enter through the menus until a run exists; per room,
pick an open door (preferring targets not yet visited), line up on the
axis along that wall, walk through, fire along the way; when every door is
closed (enemies) hunt: chase the nearest live NPC and fire along the axis
it is farther on, alternating the line-up axis every 60 frames against
rocks; after 30 frames without movement on the way to a door, sidestep for
25 frames, alternating sides; give a door up after 600 frames or 150
still frames; on death (the player's own dead byte) release everything and
Enter through the game-over screen into the next run. `ISAAC_DRIVE=explore`
on the node driver; `ISAAC_EXPLORE_CENSUS=1` prints the NPC census at each
idle status line; `ISAAC_INPUT_WATCH=1` (timeline mode) prints the engine's
GLFW-key-indexed state tables (0x00c78c10 down, 0x15d entries) every 30
frames. `tests/recomp-explore.test.js` (8) drives the brain against a fake
heap: menus, door line-up, transition hands-off, patrol, hunt with a corpse
excluded, sidestep, death and the next run.

**What it found, in order.** Movement works (D: 320 → 570 px at 4.3
px/frame, stopped by the wall); the first explorer left the start room by
its west door into a 28x16 room whose three doors stayed closed for 19,500
frames -- the head-direction field (`+0x1624`) never turned while an arrow
was held, which in node means nothing: it is render-side and node has no
GL. The dispatcher's watch counters are blind to direct calls, so
`ISAAC_DISPATCH_WATCH` reporting 0 for `Weapon::Fire` meant nothing either.
The rendered headless browser run settled it: Isaac's head turns, tears fly
and splash on the rocks boxing him in; the room holds five moving type-244
NPCs. Hunting killed two of them within 1,200 frames (their dead byte
flipped), then the player was killed: `Game Over. Killed by (244.0)`, the
game-over screen, a clean shutdown at the frame budget.

**Census, 20,000 frames, epoch 1700000000, fast node profile:** 62 room
transitions over 9 distinct rooms (the start room, a shop, treasure and
curse rooms, six ordinary ones), 10 runs, 9 deaths, 105 door attempts, 41
stalls, 5,742 hunting frames, 0 asserts, 0 invalid positions, main
returned 0. The floor repeats because the epoch pins the seed; a second
epoch exercises another layout.

**Pickups and door spreading (the same day).** The pooled `Entity_Pickup`
objects (vtable `0x00b67f24`, constructor 0x006e0010; type 5, variant
`+0x2c`, subtype `+0x30`) are found the same way; with the doors open and
no door chosen, the explorer walks into the nearest live pickup first and
counts it collected when it vanishes (300 frames, then abandoned). The
player's counters are read back from the fields the `Add*` methods
update along with the HUD counter: coins `+0x1368` (0x00759400), bombs
`+0x1364` (0x00759500, clamped 0..99; a bomb pickup moved it 1 -> 2), keys
`+0x135c` (`Entity_Player::AddKeys` 0x007595b0); `+0x1340` reads 6 at run
start (three red hearts).
20,000 frames on the debug profile: 7 pickup attempts, 3 collected -- a key
(keys 0 -> 1 in the counter), a red heart, a bomb pickup; the pedestal
items in the shop were abandoned, as they should be with 0 coins. Door
choice was widened after the second seed (epoch 1700000001) bounced 172
times between one room and its treasure room: an open door with an
unvisited target first, then the door used least from this room (a use
count per room and slot), then the lowest slot.

**Not yet exercised:** collectibles from a pedestal (the free ones sit in
treasure rooms the explorer has not reached with coins to spare), the
trapdoor and floor descent, bosses, save/load. The explorer knows nothing
about the trapdoor's position; those are the next census targets.

### 21.45 The debug console: a floor descent and a boss through the game's own console (round 30)

**Why.** The explorer (§21.44) plays what it can reach on one floor. A
floor descent and a boss fight need either luck or the debug console, and
the console is the game's own: `stage N` and `goto` are what a modder
types. Reaching it in the port meant answering three questions with the
binary, not the wiki: how it is enabled, which key opens it and how typed
text reaches it, and what the commands are called.

**1. Enabling it.** `OptionsConfig`'s loader (0x00924440) reads
`EnableDebugConsole` (default 0; stored at Options+0x5c, which is
Manager+0x2a398; `OptionsConfig::Save` 0x00924d10 writes it back as
`EnableDebugConsole=%d`) from `<save path>/options.ini`. The path is built
by 0x00952410 as `"%s%s"` of the save-path global at 0x00c72a28 and
`options.ini`; the host resolves it to `./Documents/My Games/Binding of
Isaac Repentance+/` relative to the cwd, i.e. inside the instance dir --
`ISAAC_FS_TRACE=1` shows it opened once at boot (a MISS in a fresh
instance; the game then writes a default file into the RAM-FS). Console::Update
(0x0068b260) opens on that flag and three more gates: the online-players
vector at Manager+0x4b3d8..0x4b3dc empty (offline), Game+0x26630 == 0 (no
session) and Manager state 2 or 5 (in a run; the call site is the frame's
update 0x00954cd0). Mods are not involved (`EnableMods` is separate; the
mods vector only lets a mod claim the command first). `SaveCommandHistory`
(default 1, Options+0x65 = Manager+0x2a3a1) gates the history file below:
the loader **deletes** `cmd_history.txt` when either flag is off.

**2. The key, and how text reaches it.** The open key is GLFW key 0x60
(GRAVE_ACCENT, the backquote): with the console closed, Console::Update
asks the InputManager (`[0x00c57b18]+0x74`) with the "pressed" predicate
0x00a207d0 for key 0x60 -- the keyboard device's edge test 0x00a6c540 over
the GLFW-key-indexed tables at 0x00c78c10 / 0x00c78950. The driver sends it
as VK_OEM_3 with scancode 0x29; GLFW's WndProc decodes the scancode from
lParam, so the scancode is what the game sees. Everything else the console
reads is key state too: Enter / KP_Enter (0x101 / 0x14f) run the line
(FUN_00686b70 → the dispatcher 0x0068cdc0) or, with the line empty, close
the console (FUN_00686950); UP / DOWN (0x109 / 0x108) walk the history and
DOWN at the head clears the line; Backspace, Delete, Left, Right, Home,
End, PgUp, PgDn edit and scroll; Ctrl+V pastes `glfwGetClipboardString`
and runs every complete line of the paste; KP+ / KP- change the font.
**The characters themselves are not key state.** On its first open the
console installs its char callback FUN_00686730 on the GLFW window
(`window+0x2a8`, the window at 0x00c7999c); GLFW's `_glfwInputChar`
(0x00a25d60) reaches it only from the WndProc's WM_CHAR / WM_SYSCHAR /
WM_UNICHAR cases (0x00a5b7b0: messages 0x102 / 0x106 / 0x109). On Windows
those come from `TranslateMessage`, which the host stubs (`gen_shims.py`:
STUB, "nothing translated"), and the host's queue builds WM_KEYDOWN /
WM_KEYUP (0x100 / 0x101), mouse and focus messages only
(`host_shims_win.c`, msgq_push). Typed letters therefore land in the key
tables and never in the line. Making typing work is a host change of one
of two shapes: a `TranslateMessage` that synthesises WM_CHAR from WM_KEYDOWN
through a vk-to-character map (with Shift), or a fourth input event
`[4, codepoint]` → `msgq_push(0x102, cp, 1)`. Neither is done in this round
(the C host was off limits); the paste route needs `OpenClipboard` /
`GetClipboardData` shims, the same class of change.

**The way in without WM_CHAR: the command history.** Console+0x58 is a
ring of `std::string*` slots (capacity +0x5c, head +0x60, count +0x64;
Console is Game+0x68d78, the state at +0: 0 closed, 1 opening, 2 open, 4
closing; the input line is Console+0x1c). Console init (0x00686060, from
Game's constructor 0x006f4740) loads `<save path>/cmd_history.txt` line by
line (the save-data stream's ReadLine 0x00a28190, trailing whitespace
trimmed, at most 64 lines) with push_back; executing a line push_fronts
it (0x006864a0) -- moving an entry already in the ring to the front rather
than duplicating it: with the three seeded lines the live run recalled
them with 1, 2 and 3 UPs, which is the move-to-front count (a duplicating
ring would have needed 1, 3 and 5) -- and resets the cursor to the head;
UP shows the head slot first, then older ones; closing writes the ring
back (0x00686950). A seeded history file therefore makes the first UP
recall its first line.
`makeConsole` (explore.mjs) opens the console, taps UP until the input
line -- an MSVC std::string read back out of guest memory -- equals the
wanted command, taps Enter, waits for the line to clear, and at the end
closes with Enter on the empty line. Every step is verified against the
console's own state, so a key that did not land is retried and a command
that never appears in the line is reported, not assumed.
`ISAAC_CONSOLE_MODE=type` presses the characters' keys first (`planTyping`)
and, when the line stays empty, says so and recalls. Every key is held 3
frames (the engine samples key state per frame).

**3. The commands** (the dispatcher 0x0068cdc0 carries its own presets as
strings: "stage 9", "stage 11a", "goto s.boss.5000",
"goto x.itemdungeon.666", "debug 3", "giveitem Sad Onion"): `stage N[a-d]`,
N in 1..14, the letter selecting the alternate type (a 1, b 2, c 4, d 5),
runs Level::SetStage (0x007466d0), Level::Init(0) (0x00744940, which logs
`Level::Init m_Stage %d, m_StageType %d Seed %u`) and Level::Update, then
answers "Changed stage." -- a floor change without the stage transition
animation. `goto <s|x|d>.<type>[.<variant>]`: `s` looks the room up in
stage 0 (the special rooms), `x` in the current stage, `d` takes a default
room by variant; the type is a name (`boss` is 5);
RoomConfig::GetRoomByStageTypeAndVariant (0x0082c720; it logs
`[warn] StageID %d Room type %d, variant %d not found!`) then
Level::DEBUG_goto_room (0x0073fa20: the debug descriptor, room index -3)
and "Changed room." or "Error changing room.". Every boss room lives in
the special set: `rooms/00.special rooms.stb` (an `STB1` file: per room
`<IIIBH>` type, variant, subtype, difficulty, name length, the name,
`<fBBBBH>` weight, width, height, shape, door count, spawn count, the
doors `<hhB>` and the spawns `<hhB>` + `<HHHf>` entries; the parse consumes
all 437,972 bytes) holds **565 type-5 rooms, none with variant 0**, so a
plain `goto s.boss` answers "Error changing room."; the lowest variant is
1010, Monstro's 13x7 one-entity room; `01.basement.stb` (571,141 bytes,
1,220 rooms) has no boss rooms at all. `debug N` toggles bit N of the flag
word at Game+0x26544 (Game::GetDebugFlag 0x00431760); the dispatcher's own
presets use 3 and 4 (infinite HP, high damage). The console's replies go
to its output buffer, not the log; the engine log carries `Level::Init`,
`[RoomConfig] load stage N: <name> (mode M)`, `Room <type>.<variant>(<name>)`
(0x007f2800 prints the config's type at +8 and variant at +0xc) and
`TriggerBossDeath: %d bosses remaining.` (0x007fec00: `Room+0x7224 - 1`,
the room's live-boss counter). `censusFromLog` (explore.mjs) counts those,
plus `[odsa] [ASSERT]` lines.

**The options.ini trap.** The first console run aborted at boot: with an
options.ini present the loader applies every value it parsed, and
`OptionsConfig::SetVSync(1)` (0x00925ce0; VSync defaults to 1) calls
`glfwGetPrimaryMonitor` for the refresh rate -- NULL on the headless host,
so GLFW's `monitor != NULL` assert (monitor.c:449) fired. Without a file
the whole block is skipped, which is why every earlier run was fine. The
seed forces `VSync=0`; the block's other apply-calls (the cursor mode
`glfwSetInputMode`, the window size from GLFW's own globals) read the
window, which exists. The seeding is RAM-FS only: `consoleSeedFiles`
builds options.ini (merged with the instance's own file when there is one:
only EnableDebugConsole, SaveCommandHistory and VSync change) and
cmd_history.txt, and the driver seeds them eagerly after the lazy tree
walk -- an eager `isaac_fs_seed` replaces a lazy entry with the same key
-- so nothing is written to disk and the instance stays as it was.
`ISAAC_CONSOLE="cmd1;cmd2"` on the node driver; in explore mode the
sequence starts `ISAAC_CONSOLE_DELAY` frames (default 150) after the
explorer reports the run started and the explorer is suspended while it
runs (its held keys released; it re-reads the room, and the floor, when it
resumes); in timeline mode it starts at `ISAAC_CONSOLE_AT` and the
timeline waits.

**Census: the floor descent** (`ISAAC_CONSOLE="stage 2"`, epoch
1700000000, 3,000 frames, debug profile; `r30-stage2.log`). The run starts
at frame 322 in the Basement's start room (`Room 1.2(Start Room)`, 15x9,
type 1 variant 2). The console driver starts at 472, taps the grave key at
473 and reads state 2 at **474** (the console opened two frames after the
tap; the history ring read back holds the one seeded line, `"stage 2"`);
one UP puts `stage 2` in the line at 487, Enter runs it and the engine
logs **`Level::Init m_Stage 2, m_StageType 0 Seed 1037090446`** on that
frame; the line is empty again at 488; Enter on the empty line at 532
closes the console, state 0 at 547 (59 frames: the closing animation).
The explorer resumes at 547 and reports **`floor 1.0 -> 2.0 (stage 2 type
0); room list reset (1 room(s) on the old floor)`**: Basement II's start
room (room 84 again, `Room 1.2(Start Room)`, doors open 3/4), then its
curse room (71, `Room 10.7`, a pickup 5.360.1 attempted) and room 85
(`Room 1.1105(New Room)`); 973 hunting frames on that floor, one death at
frame 1895, and run 2 starts on a fresh Basement (`Level::Init m_Stage 1
... Seed 2677005421`), which the census keeps apart (`floors:
{run1/1.0: [84], run1/2.0: [84, 71, 85], run2/1.0: [84, 71, 85]}`). Whole
run: 6 room transitions, 7 door attempts, 2 pickup attempts, **0 asserts,
0 invalid positions**, `main` returned 0, guard intact. No new
`[RoomConfig] load stage` line appears for Basement II: stage 2 is the same
stage config (`Basement`, mode 0) the boot had loaded.

**Census: the boss** (`ISAAC_CONSOLE="debug 3;debug 4;goto s.boss.1010"`,
`ISAAC_EXPLORE_CENSUS=1`, the same epoch, 4,000 frames, `ISAAC_LOG_TIME=1`;
`r30-boss.log`). The same run start at 322; the console opens at **474**
with the three seeded lines in its ring; `debug 3` is in the line after 1
UP and runs at 488, `debug 4` after 2 UPs at 509, `goto s.boss.1010` after
3 UPs at 537 (each line cleared the frame after Enter; 6 UPs in all);
closed at 596. The engine logs **`Room 5.1010(Monstro)`** -- type 5, the
boss room -- and the explorer resumes at 807 in **room -3** (the debug
descriptor's index; 15x9, config type 5 variant 1010, `bosses 1`, its one
door closed), with the NPC census reading one typed object,
`t20.0 (320,280) dead=0`: Monstro at the room's centre. The hunt runs
from 828; at 1123 the engine logs **`TriggerBossDeath: 0 bosses
remaining.`** and `deathspawn_boss`, spawns two hearts (5.10.2) and the boss
item, a pedestal collectible **5.100.659**, and the explorer reports
`boss down in room -3 (1 -> 0 alive)`; the door reopens (the pickup branch,
which needs an open door, targets a heart at 1143), and the explorer
leaves for the start room at 1599, then rooms 85 and 97. Whole run: 852
hunting frames, `bossRoomsEntered 1`, `bossKills 1`, 6 transitions, 0
deaths in 3,555 play frames (`debug 3`), 3 pickup attempts, 0 collected
(the hearts are refused at full health and the explorer walked past the
pedestal for the exit -- fixed: an abandoned pickup now yields to the next
candidate on the following tick, pinned by a test), **0 asserts, 0 invalid
positions**, `main` returned 0, guard intact. The NPC census printed at
each idle line names the corpse afterwards (`t20.0 (431,270) dead=1`
next to two live `t289` in room 85).

**No trapdoor in a `goto`'d boss room -- the engine's own rule.** The
room's grid was scanned every frame after the clear and never held the
trapdoor's vtable. Room::Update (0x007fb250) explains it: its clear path
tests `roomIdx == -3` (Ghidra prints the 0xfffffffd compare as `-NAN`)
together with `type == 5` and takes a branch of its own -- a trophy
(pickup variant 0x154) in the challenge modes, nothing in a normal run --
while the trapdoor spawns (`SpawnGridEntity(idx, 17, 0, seed, ...)`, six
sites in the same function) sit on the floor's real boss room's clear.
The way down through a boss fight therefore needs the level's own boss
room, reached by walking (the explorer's door walk, or a door preference
toward the level's boss-room index), not the console; the census here is
the boss room, the fight, the kill and the reopened door. The boss reward
is unaffected: `deathspawn_boss` is the NPC death's own spawn.

**The silent window, quantified.** Both console runs went quiet for
minutes right after frame 360 -- the log's `music stopped playing` pair,
the Basement track restarting. With `ISAAC_LOG_TIME=1` the stamps put
frames 360 to 420 at **64.8 s to 538.5 s of wall time (474 s for 60
frames)**, every stamped frame around them at 7-16 ms; the first attempt
at the boss run sat in that window for over ten minutes at 100 % CPU and
was killed for a fresh process, which passed it in eight. That is round
14j's class (§21.27): identical guest work, wall time set by node's NT
heap history under Windows, not by the game. The `music stopped playing`
window is the next thing to profile on this platform; the runs' game
frames themselves are 7-16 ms on the debug profile.

**What the explorer gained** (explore.mjs, all read-only): the floor
(`Game+0` / `+4`: Level is Game's first member; a change within a run
resets the room list, `floorChanges` / `descents` count it and the census
keeps one room list per `run<n>/<stage>.<type>`); the room's config
through `room+4 -> desc+0x10 -> RoomConfig_Room` (type +8, variant +0xc,
logged at every room entry); the live-boss counter `room+0x7224`
(`bossRoomsEntered`, `bossKills`, and a `boss down` line when it drops);
the room's grid-entity array (`room+0x24`, 448 slots, ending exactly at the
door array) scanned for the trapdoor's vtable 0x00b6946c -- in a cleared
room with nothing left to pick up the explorer walks onto it (the cell
centre from the slot index, the engine's own formula) and abandons it after
600 frames; and `suspend()` / `resume()` for the console hand-over. The key
table is one (`KEYS`: every letter, digit, space, the grave key and the US
punctuation, `[vk, scancode, extended]`), exported to the node driver's
timeline.

**Tests.** `tests/recomp-console.test.js` (9): the key table (every key the
commands need, unique scancodes and vks, the grave key pinned to VK_OEM_3 /
0x29); `planTyping` (one key per character, Shift where needed); the two
seed files (fresh, and merged on a temp dir with an options.ini whose
`EnableDebugConsole=0`, `VSync=1` and `SaveCommandHistory=0` are the only
lines that change, the disk file untouched); the sequencer against a fake
console that behaves like Console::Update (grave -> state 1 -> 2, UP walks
the seeded ring, Enter runs and push-fronts, Enter on the empty line
closes): three commands in order with the key trace pinned, a ring that
keeps duplicates, a command missing from the history (reported, skipped),
a console that never opens (retries, then gives up), type mode (the seven
keys pressed, the empty line noticed, recall as the fallback); and
`censusFromLog`. `tests/recomp-explore.test.js` grew by four (14): the
floor change, the trapdoor walk (and its timeout), the boss counter, and
suspend/resume.

### 21.46 Saves persist (round 31)

**Before.** The RAM-FS lived for one process. The game writes its
`persistentgamedata1..3.dat` (and a dated copy under `save_backups/`) to
`Documents/My Games/Binding of Isaac Repentance+/` through `fopen`/`fwrite`
on every game over and run start -- 26 opens of the first file in one
20,000-frame soak -- and every byte of it was gone at the next boot, in
node and in the browser alike. "Save/load" was the one gameplay path the
automated player could not exercise.

**Mechanism.** The FS shim (`host_shims_fs.c`) hands a file the guest
opened for writing to the host when it is closed -- `Module.isaacPersist(key,
src, dataPtr, len)`, where `key` is the normalised FS key and `src` the seed
path the file was registered with (verbatim case; "" for a file the game
created) -- and announces `remove`/`DeleteFileA` through
`Module.isaacUnlink(key, src)`. Directories and windowed archives never
persist. The selftest holds the contract with C hooks
(`isaac_fs_set_persist_hooks`): fwrite stores, nothing reaches the host
before the close, fclose hands the five bytes and the key, DeleteFileA
unlinks (236 checks, 0 failures).

The node driver (`ISAAC_SAVE_DIR=<dir>`) writes each file under that
directory and seeds the directory back over the instance tree at the next
boot (a saved file wins over a seeded one); unset, nothing is written --
the instance and the bundle are never touched. The browser page keeps the
files in IndexedDB (`isaac-saves`/`files`, keyed by the FS key) and seeds
them back in a "restore saves" stage after the instance tree and before
main; `persist=0` on the URL turns the store off. `drive_persist.mjs` is
the proof: one browser, the headless timeline to its budget, then a reload
of the same page.

**Census.** Node: two boots of the automated player (6,000 frames, epoch 1700000000, fast profile): boot 1 persisted 36 file closes (persistentgamedata1..3.dat, their save_backups, gamestate1.dat, options.ini, log.txt), boot 2 restored 10 files, the game found every save (0 misses, no 'No Repentance save found'), same 3 runs / 2 deaths, main 0. Browser: one Chromium profile, the headless timeline to 1,500 frames then a reload: load 1 persisted 24 closes, load 2 restored 10 files before main and ran its 1,500 frames, main 0, 0 asserts (drive_persist.mjs OK). The first attempt aborted on load 2 in the game's VSync setter: with the written options.ini read back it asks GLFW for the primary monitor, and EnumDisplayDevicesW enumerated nothing -- the shims now describe one adapter, one monitor and one 1280x720@60 mode (selftest 241/0).

### 21.47 Typed console text: TranslateMessage synthesises WM_CHAR (round 32)

**Before.** Round 30 (§21.45) reached the debug console but could not type
into it. The console takes its text from GLFW's char callback; GLFW's
WndProc (0x00a5b7b0) feeds that from WM_CHAR / WM_SYSCHAR / WM_UNICHAR; on
Windows those come from `TranslateMessage`, and the host stubbed it
("nothing translated") while its queue built WM_KEYDOWN / WM_KEYUP only. A
typed letter landed in the key tables and never in the line, so the
commands were seeded into `cmd_history.txt` and recalled with UP.

**What Windows does, and the host now does.** `TranslateMessage(const
MSG*)` takes a WM_KEYDOWN (or WM_SYSKEYDOWN), asks the keyboard layout what
character that virtual key gives under the current modifier state, and
posts a WM_CHAR (WM_SYSCHAR) to the thread's queue: hwnd = the key-down's
window, wParam = the character, lParam = the key-down's lParam (repeat
count, scancode, extended bit, previous state). A posted message is
retrieved before the remaining hardware input, so the pump's next
PeekMessage is the character. It returns nonzero for any key message,
translated or not, and 0 for anything else. `host_shims_win.c` does exactly
that: `imp_user32__TranslateMessage` reads the caller's MSG (never writes
it), `vk_to_char` maps the key, and `msgq_push_front` puts the WM_CHAR at
the head of the ring -- the WM_KEYUP already queued behind it waits its
turn. The verdict in `gen_shims.py` moved from STUB to PROVIDED (the
regenerated table differs in those two rows only). The first 48 characters
are logged (`[isaac][input] frame N: TranslateMessage vk 0x53 -> WM_CHAR
0x73`), which is how a run's log shows the typing.

**The synchronous keyboard state.** Windows keeps two: the physical state
(GetAsyncKeyState) and the state "as of the key messages this thread has
retrieved" (GetKeyState); translation uses the latter. The host had one
table, written when an event was *queued* (`isaac_input_key`). A driver that
queues Shift down, S down, S up, Shift up in one frame would then have the
S translated with Shift already up. The queue now keeps a second table
(`g_keysync`), applied in `msgq_pop_into` as each key message is removed;
`GetKeyState` reads it (bit 15 down, bit 0 the CapsLock / NumLock /
ScrollLock toggle, flipped when the lock key's non-repeat key-down is
removed) and so does `vk_to_char`. A generic VK_SHIFT / VK_CONTROL /
VK_MENU message also sets its left/right vk from the scancode / extended
bit, as the kernel does (Windows posts the generic vk in wParam and lets
the scancode say which side). That last point matters beyond typing:
GLFW's pollEvents reads `GetKeyState(VK_LSHIFT)` after every pump to
release a Shift it believes stuck, and with the old table (VK_LSHIFT never
down) it released the driver's held Shift on every frame.

**The map (US layout, kbdus.c).** Letters `a`..`z`: upper with Shift;
CapsLock swaps the case Shift gives (Shift+CapsLock is lower again); Ctrl,
Shift or not, posts the control character `vk & 0x1f` (0x01..0x1a);
Ctrl+Alt (AltGr) posts nothing on this layout. Everything else is a table
of base / Shift / Ctrl columns (`g_vk_chars`, one row per line): the digit
row `0`..`9` with `)!@#$%^&*(`, space, Enter `\r` (Ctrl: `\n`), Backspace
`\b` (Ctrl: 0x7f), Tab, Escape 0x1b, the OEM keys `;:` `=+` `,<` `-_` `.>`
`/?` `` `~ `` `[{` `\|` `]}` `'"` with the Ctrl characters kbdus.c gives
them (`[` 0x1b, `\` 0x1c, `]` 0x1d, `-` 0x1f, `6` 0x1e, `2` NUL);
Shift+Ctrl has no column, so nothing; the numpad digits and operators are
unconditional because a numpad vk (VK_NUMPAD5 rather than VK_CLEAR)
already says NumLock was on. F-keys, arrows, Delete and the modifiers
themselves post nothing. What the game then sees: `_glfwInputChar`
(0x00a25d60) drops codepoints below 0x20 and 0x7f..0x9f before any
callback -- `\r`, `\b`, 0x1b and the Ctrl characters go nowhere, as on
Windows, and Enter / Backspace keep working as key state -- and the
console's callback (0x00686730) takes 0x20..0x7f only while the console is
open (state 2), inserting at its cursor (Console+0x108, a `char*` into the
line). The grave key that opens the console never puts a '`' in the line:
its WM_CHAR is dispatched in the pump, before Console::Update opens it.

**Selftest (296 checks, 0 failures; 55 new).** With the three windows of
the round-14a block in place: `a` -- the WM_KEYDOWN pops first, Translate
returns 1 and queues one message, the next pop is WM_CHAR 'a' with the
key-down's lParam and hwnd, ahead of the already queued key-up; Translate
of the WM_CHAR returns 0 and adds nothing, of the WM_KEYUP returns 1 and
adds nothing. Shift+a queued as one batch: GetKeyState(VK_SHIFT) reads up
while Shift's key-down is still queued and down once it is removed
(VK_LSHIFT with it, VK_RSHIFT not), the a posts 'A', the batch drains,
VK_LSHIFT releases with the VK_SHIFT key-up. CapsLock: its key-down sets
GetKeyState bit 0 and posts nothing, `b` posts 'B', Shift+b posts 'b', '2'
is untouched, the next fresh key-down toggles it off and a repeat (bit 30)
does not toggle. Then 34 keys one at a time (modifiers down, key down/up,
modifiers up; the WM_CHAR must follow its key-down at once): grave / ~,
CR, BS, TAB, 0x1b, space, 9, @, ), . >, - _, +, {, ], ' ", :, ,, ?, \ |,
Ctrl+c 0x03, Ctrl+Shift+z 0x1a, Ctrl+Enter LF, Ctrl+[ 0x1b, and nothing
for Ctrl+Shift+2, F1, Up, Shift+Left, Shift itself, Delete; a WM_MOUSEMOVE
translates to 0 with nothing posted.

**The typed driver.** `scripts/recomp/lift/console_typing.mjs`:
`planTyping(text)` gives the key events the node driver's poll hands the
host -- `[1, vk, scancode | extended << 8, down]` from explore.mjs's `KEYS`
and its per-character key/Shift plan -- with Shift down and up around the
characters that need it, each key held `hold` frames (3; >= 2, the engine
samples key state per frame) and a one-frame gap before the next
(`typingFrames("goto s.boss.1010")` = 64); every key-down carries the
character the host will post for it (`vkToChar`, the JS mirror of the C
rules; `VK_CHARS` mirrors `g_vk_chars` row for row) and the plan throws if
that is not the character wanted, so the two tables cannot drift apart
silently. `makeTypedConsole(commands, { mem, ready, log })` has
`makeConsole`'s contract (poll / active / done / report) and its
verification discipline: grave until state 2 (retried, timed out), then
per command: the plan is scheduled, the line (Console+0x1c, the MSVC
std::string read out of guest memory) is read back after the last key
settles and must equal the command before Enter is tapped; a wrong line is
cleared (DOWN at the head, then one Backspace per character if DOWN left
it) and typed again, twice, before the command is reported as never having
reached the console; Enter, then the line must clear (the engine ran it);
Enter on the empty line closes. `ISAAC_CONSOLE_MODE=typed` on the node
driver selects it; typed mode seeds `options.ini` only -- no
`cmd_history.txt` -- so the only way a command can be in the line is the
typing. `recall` (round 30) and `type` (round 30's probe) remain.

**Tests.** `tests/recomp-console.test.js` (14, five new): the plan for
"goto s.boss.1010" (16 down/up pairs, no Shift, the key-downs spell the
command, every event equal to `keyEvent`'s, held 3 frames, 4 frames per
character) and "Debug ~3" (Shift down with the d and up with it, again
around the grave); `VK_CHARS` against the C rows parsed out of
`host_shims_win.c` (the same vks, the same three cells each) plus the
letter / CapsLock / Ctrl / AltGr / Shift+Ctrl rules and what the line
accepts; the typed driver against a fake console that inserts what the
host would post only in state 2 (both commands typed, read back and run,
the trace `grave, s t a g e space 2, enter, g o t o space s . b o s s . 1
0 1 0, enter, enter` with no UP, every key held >= 2 frames, exactly the
commands' characters inserted, the opening grave's own '`' dropped); the
same driver on a fake without WM_CHAR (three attempts per command, the
failure reported, nothing recalled, closed at the end); and a leftover
line cleared by DOWN, or by Backspaces when DOWN leaves it.

**Census (fast node profile, epoch 1700000000, `ISAAC_DRIVE=explore
ISAAC_CONSOLE_MODE=typed`, 4,000 frames).** `stage 2`: the console opens 2
frames after the grave tap (frame 474), the 7 keys go in over 28 frames,
the line reads `stage 2` at frame 512, Enter, executed at 513 (the line
cleared after 1 frame) -- `Level::Init m_Stage 2` follows, 0 asserts, main
0. `goto s.boss.1010`: 16 keys over 64 frames, the line read back at 548,
executed at 549 -- `Room 5.1010(Monstro)`, 0 asserts, main 0. Typed is the
default mode now; `recall` stays as a fallback. Selftest 296 checks (55
new: the US map cells, Shift/CapsLock/Ctrl, the queue order, no character
for F1/arrows), `tests/recomp-console.test.js` 14.

### 21.49 The shipping page and a hostable dist (round 34)

`scripts/recomp/assets/ship.py build` assembles `.scratch/game-dist` from
the shipping bundle (§21.43), the fast web module and the memory image:
`play.html` + `play.mjs` (the player page), `boot.mjs`, `boot.wasm`,
`isaac.segs.bin`, the bundle under `instance/`, `instance_index.json` in
the shape `boot_web.mjs` consumes, precompressed siblings (`.br`, `.gz`)
for every large file that compresses, and `dist.json` with sizes and
sha256s; `ship.py check <dist>` re-hashes everything and decodes every
sibling against its source. `scripts/recomp/web/serve_dist.mjs <dist>
<port>` serves it: content types by file, `Content-Encoding` negotiation
for the siblings, `Range` and `?off=&len=` byte slices, `?b64=1` text
answers (the page's synchronous fetches), `Cache-Control`.

The page: a loading screen with a real byte-accounted progress bar per
stage (module, image, archives, boot), a Play button once the module is
ready (its click unlocks WebAudio and focuses the canvas), the canvas
scaled to the viewport at 16:9 with crisp pixels, fullscreen, a key-hint
strip, a saves menu (export/import/reset of the IndexedDB store, §21.46),
an error panel that appears only when the module fails, and no frame
budget (it plays until closed).

**Census (the assembled dist, 2026-09-04):** 30 files, 793,418,516 bytes
raw, 744,521,328 bytes transfer with the best encoding (the module
50.8 MB -> 10.5 MB brotli; the archives are already compressed). Driven
under headless Chromium against `serve_dist.mjs` (r34-drive.log): the
manifest at 138 ms, the module fetched by 651 ms, Play visible at 919 ms,
first frame 50 ms after the click, the run started after 9 held Enters,
walked, ~40 fps in play (software GL), `main` 0; the server counted 499
requests, 701.5 MB on the wire (10.5 MB of it brotli). `tests/recomp-ship.test.js`
covers the assembler on a synthetic tree, the manifest and size
arithmetic, `check` on broken dists, and the server's types, slices,
encodings and 404s on an ephemeral port.

### 21.51 Music: the streaming path (round 36)

**The report.** In the browser the sound effects play and the music does
not. Every log said the music path ran: `Queued Path
music/Repentance/Genesis Retake Light Loop.ogg`, hundreds of `alBufferData`
uploads, `202 queued / 125 unqueued` stream buffers in the census, `WebAudio
context: running`. Nothing was heard. Rounds 22-35 had measured the music
by its bookkeeping; this round measures it by the energy on the master
output, and the bookkeeping turned out to be the whole problem.

**What the engine does (read off the binary, PE index + decompile).** A
`KAGE::Sound::StreamSourceOgg` (vtable 0x00ba2b50) owns one AL source and
four AL buffers with four 64 KiB PCM slots. `Music::Play` (0x007e1d50 ->
0x007df5b0) sets the handle's looping flag, pitch and volume, then calls the
stream's Play (0x00a7cab0), which registers it with the manager and issues
**`alSourcePlay` on the still-empty source** (0x00a7cb79). The OpenAL
thread (0x00a7da80, a per-frame slice since round 24) then runs the
stream's Update (0x00aa0490) on every pass: for each queued slot it asks
`AL_BUFFERS_PROCESSED` (0x00aa04c0) and unqueues that many, one buffer per
call (0x00aa04e0); the first empty slot gets one stb_vorbis decode of
`0x10000 / (2 * channels)` frames (0x00a7c2c0: 65,536 bytes of stereo 16-bit
at 48 kHz, 0.341 s); every filled slot is then uploaded and queued
(`alBufferData` 0x00aa06d0, `alSourceQueueBuffers(src, 1, &buf)` 0x00aa06df)
and after each upload **`alSourcePlay` is issued if `AL_SOURCE_STATE` is
not `AL_PLAYING`** (0x00aa06fd; IsPlaying 0x00a9fde0 is that one compare).
Looping is a decoder seek, never `AL_LOOPING`. The gain is
`alSourcef(AL_GAIN)` (0x00a9ff30, the only AL_GAIN site): entry volume x
handle fade x master gate x slot crossfade, set before the first play and
re-applied per frame whenever the product changes. Stop (0x00aa0470)
removes the stream from the manager's list and calls `alSourceStop` when
the state is not `AL_STOPPED`; nothing is unqueued or detached, and Close
deletes the source and its four buffers outright. `AL_BUFFERS_QUEUED` is
never asked; the four `AL_BUFFER = 0` sites act on the 64-entry sample
pool, never on a stream.

**What the port did with it.** `host_audio.c` timed a source on the wall
clock from `alSourcePlay` on, so the play on the empty source started the
clock; when the first chunk was queued a third of a second later it was
retired on the spot, the second play came with `head == processed`, and the
backend hook -- which received exactly ONE buffer id, the "current" one --
got buffer 0. `host_audio_web.c` did `A.buffers.get(0)`, found nothing and
returned. No `AudioBufferSourceNode` was ever created for the title theme:
in the old trace every `play source` on a stream reads `buffer 0` (one
layer got one 0.34-s node, at gain 0). And `alSourceQueueBuffers` had no
backend hook at all -- a chunk queued while playing went nowhere. The model
kept answering "processed" off the wall clock, the game kept refilling, the
census kept counting, into silence. Sound effects worked because a static
source's buffer is bound with `AL_BUFFER` and one node is the whole sound.
Measured on the master output (`drive_audio.mjs`, the old module):
**20 of 20 one-second samples at 0.0000 RMS** with the context running and
445 audio-trace lines of queue traffic behind them.

**The fix, in three parts.**

1. *The backend sees the queue.* `host_audio.c`'s hooks are now
   `queue(src, buf)`, `unqueue(src, n)`, `clear(src)` (AL_BUFFER 0),
   `delete(src)`, `pitch`, and a `play(src, buf, gain, pitch, looping,
   streaming, head, offset_sec)` that says whether the source streams, the
   queue entry to start from and the offset into it (0 on a restart, the
   paused position on a resume).
2. *The model follows OpenAL Soft where the music path needs it*, each rule
   pinned in the host selftest on a settable clock (`isaac_audio_clock_ms`
   is weak; the selftest sets it): a play with nothing to play goes to
   `AL_STOPPED` at once and starts no clock; `AL_BUFFERS_QUEUED` is the
   whole queue, processed entries included; a stop marks every queued
   buffer processed; a play from initial/stopped/playing restarts at the
   queue head, from paused it resumes at the offset; an unqueue asking past
   the processed count takes nothing (a partial take would hand the game
   ids it never got, which it refills and re-queues as dead entries);
   `AL_BUFFER` is refused on a playing or paused source.
3. *The WebAudio backend schedules the chain.* One `GainNode` per source
   feeds a master `GainNode` (-> destination). A stream is a chain of
   `AudioBufferSourceNode`s, each `start(at)`-ed at the AudioContext time
   the previous one ends; a chunk queued while the stream plays lands at
   the chain's end; an unqueue drops bookkeeping only (the node plays out);
   a stop cancels the chain and a later play re-schedules from the head the
   model names; a suspended context (the autoplay policy) leaves chunks
   pending and the `statechange` resume schedules what is still queued
   from *now* -- the music picks up at the game's current position instead
   of replaying a backlog; a chain more than `ISAAC_AUDIO_MAX_LEAD` (3 s)
   ahead of the context clock is trimmed and re-anchored after the chunk
   that is playing. The shipping page's Play-click object (`play.mjs
   unlockAudio`: `{ ctx, buffers, sources }` made inside the user gesture)
   is adopted, not replaced. The re-upload the engine does into a buffer id
   whose node is still scheduled is safe here: the node keeps the old
   `AudioBuffer`, the queue entry takes the new one.

**Instrumentation (observe-only).** `ISAAC_AUDIO_TRACE=1` now logs, per
source and with the model's clock: static/stream; play/stop/pause with the
state before; queue/unqueue with ids and counts; gain and pitch changes;
each buffer the clock retires and how late it was seen; every refusal. The
JS side (`[isaac][audio-web]`) logs the context, every scheduled node with
its start time and duration on the AudioContext clock, and each stop, trim,
deferral and resume; it goes through the glue's `err()`, i.e. the page's
`printErr`, so it lands in the page log (`web-run.log`'s page section,
`drive_audio.mjs`'s `page.log`) while the model's lines are console
output -- each carries its own clock. The audio report gains the
stream/empty play counts, the refusals and the backend's
scheduled/trimmed/deferred/resumed census. Read on the HANDOFF timeline
(fast module, headless Chromium, 1,500 frames, `main` 0, 54 s wall) the
title theme's source goes `gain 0 -> 0.6`, a play from INITIAL with
nothing to play (STOPPED at once), the first chunk queued at t=150 ms and
played from entry 0, three more queued while PLAYING, then every 341 ms one
chunk retired (seen 0-14 ms after its end), one unqueued, one refilled and
scheduled at the chain's end -- 27 queued, 27 scheduled for the theme before
the run's music change stops it. Over the run: 203 uploads, 200 queued /
180 unqueued, **201 chunks scheduled, scheduled == queued on every stream**
(a restarted stream re-schedules its still-queued entries), 0 refusals, 0
trimmed, 0 deferred.

**Proof by energy.** `boot_web.mjs` puts an `AnalyserNode` between the
master and the destination when the backend announces its context
(`Module.isaacAudioReady`), keeps 100-ms RMS blocks, and answers
`window.isaacAudioLevel()` with the last second's RMS, the freshest block,
the peak, the context time and state and the backend census.
`scripts/recomp/web/drive_audio.mjs` drives the interactive page under
Playwright: a click on the canvas (the user activation), 20 one-second
samples of the boot screen, two held Enters, 20 samples of the screen after
them; sound effects are key-driven, so a window with no keys in it carries
music only. (In the measured runs that second window was still the beta
notice -- its ACCEPT prompt arms late, so the Enters did not pass it -- with
the title theme playing and nothing else: the screenshot the driver keeps,
`shot_title.png`, shows it.) For a module older than this
round it installs its own tap (every `connect()` to the destination routed
through an analyser), which is how the "before" number above was taken on
one page. Before (the round-35 module): the title window's 20 one-second
samples all read **0.0000 RMS** with the context running -- and no node had
connected to the destination at all until the first menu sound, the bug
seen from the tap's side. After (this round's module): **20 of 20 samples
above 0.005 RMS, median 0.0442 (0.0177-0.0682), peaks to 0.21**, two
streams playing (the theme and its layer, gain 0.6 and 0.02) and the
backend's chunk count rising by ~5.9 per second, i.e. two streams x
1/0.341 s. The boot window (the intro, one stream) reads 0.001-0.005 for
its first six seconds and 0.03 once the theme fades in. The day's
intermediate build measured the same (median 0.0457).

**Node.** The node profile links the model's weak no-op hooks and is silent
by design; the model's rules -- the processed counts the refill loop lives
on -- are the same there. It was not relinked this round.

**Pins.** `tests/recomp-audio.test.js` (10): the EM_JS bodies are extracted
from `host_audio_web.c` and run in node against a fake AudioContext (a
queue becomes a chain started back to back, a refill lands at the chain's
end, unqueue drops bookkeeping only, stop cancels and play re-schedules,
resume-from-paused starts at the offset, a suspended context defers and the
resume replays from now, the lead cap trims and re-anchors, static
loop/pitch/restart, nothing throws with no AudioContext at all), the
model's rules by their code and by the selftest's `audio:` lines, the
page's tap and the driver's verdict. The host selftest carries the 20
`audio:` checks (316 total). `tests/recomp-ship.test.js` pins the
adoption of the page-made object.

## Appendix: reproduction

```bash
PY=C:/Users/Luca/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe
$PY -m pip install pypcode          # 3.3.3, vendors Ghidra SLEIGH

# function starts (9.6 s)
$PY scripts/recomp/lift/scan.py tools/isaac-ng.unpacked.exe \
    output/recomp/lift/func_starts.txt

# full lift (173 s)
$PY scripts/recomp/lift/emit.py --exe tools/isaac-ng.unpacked.exe \
    --va-file output/recomp/lift/func_starts.txt \
    --out output/recomp/lift/full --module lifted --split 250 \
    --stats output/recomp/lift/full/stats.json

# build + measure (181 s compile, 42 s link).  Note --opt=-O2 must use '='
# or argparse eats the leading dash.
$PY scripts/recomp/lift/build_wasm.py --dir output/recomp/lift/full \
    --opt=-O2 --jobs 14

# design A/B
$PY scripts/recomp/lift/emit.py ... --state-only     # remill shape
$PY scripts/recomp/lift/emit.py ... --spill-flags    # conservative flags

# --- round 2: the real inventory (this is the pipeline to use) ---
$PY scripts/recomp/lift/emit.py --exe tools/isaac-ng.unpacked.exe \
    --ghidra-functions output/recomp/export/functions.jsonl \
    --fragments-tsv    output/recomp/export/recovered-functions.tsv \
    --imports          output/recomp/census/imports.json \
    --va-file output/recomp/lift/ghidra_all.txt --dispatch auto \
    --out output/recomp/lift/gabs --module lifted --split 500 \
    --stats output/recomp/lift/gabs/stats.json          # 270 s

$PY scripts/recomp/lift/mkstubs.py --dir output/recomp/lift/gabs
$PY scripts/recomp/lift/build_wasm.py --dir output/recomp/lift/gabs \
    --opt=-O2 --jobs 14

# computed-jump classification on its own (jumptables.py is also importable)
$PY scripts/recomp/lift/emit.py ... --dispatch off|auto|all|force
```

Round-2 flags:

| flag | meaning |
|---|---|
| `--ghidra-functions` | function starts + body extents from the headless export |
| `--fragments-tsv` + `--fragments absorb\|split` | fold Ghidra's 9,959 mid-function fragments into their parents (default) or keep them as separate functions |
| `--imports` | bind `call [IAT slot]` to a named host shim |
| `--dispatch off\|auto\|all\|force` | computed-jump handling: trap / only where needed (default) / any function with a computed jump / every function (cost measurement) |

Artifacts: `output/recomp/lift/` (gitignored via the existing `/output/`
rule in `.gitignore` — verified with `git check-ignore -v`).

### 21.52 Round 37: the host GL cache, and a yield that is not a timer (the Chromebook budget)

**The measure.** `scripts/recomp/web/drive_perf.mjs` drives the live page
under headless Chromium with the machine's real GPU (ANGLE over D3D11 on an
RTX 2060) and the DevTools CPU throttle standing in for a slow CPU
(`Emulation.setCPUThrottlingRate` 4 -- roughly a Chromebook's integrated
part). Round 32's baseline: 58 fps at full CPU, **28 fps at 4x** (27 with
SwiftShader, so the ceiling was the CPU side, not the GPU).
`scripts/recomp/web/profile_play.mjs` (new) records a V8 CPU profile of 12 s
of play under the same throttle and sums self time per function. At 4x the
frame cost 35.6 ms, and the top of the list was not the game:
`getRenderbufferParameter` 17.0 %, `(idle)` 10.9 %, `isaac_lifted_dispatch`
8.0 %, `checkFramebufferStatus` 5.9 %, `(program)` 5.6 %, `bufferSubData`
2.1 %, `readPixels` 2.0 %, `wasm-to-js` 1.7 %, `getAttribLocation` 1.6 %,
`getUniformLocation` 1.0 %, `getError` 1.0 % -- native WebGL getters 37 %
of the frame, the lifted game 27 %, the host C 14 %.

**What the engine does.** Every frame it re-validates each render target:
binds the renderbuffer and asks its width, height and internal format back
(`glGetRenderbufferParameteriv`, 9 per frame), re-attaches the same texture
to the same framebuffer attachment point (`glFramebufferTexture2D`) and asks
`glCheckFramebufferStatus`, and looks its uniforms and attributes up by
name for every draw (`glGetUniformLocation`/`glGetAttribLocation`, ~410 per
frame). In WebGL each of those is a synchronous round trip into the GPU
process; on the desktop driver it was noise, in the browser it was a third
of the frame.

**The cache (`scripts/recomp/host/src/host_gl_cache.c`).** Every one of
those answers is a function of what the game itself set, so the host keeps
that state and the web wrappers answer from it; anything the tables do not
know falls through to the real call, so the answers are exact:
- renderbuffers: name -> (width, height, internal format, samples) from
  `glRenderbufferStorage`; the sizes (`GL_RENDERBUFFER_WIDTH/HEIGHT/
  INTERNAL_FORMAT/SAMPLES`) and the component bit counts of the sized
  formats are answered from the table;
- framebuffer status: name -> the last status GL returned, kept until
  something that can change completeness happens to that framebuffer: an
  attachment point gets a *different* image (re-attaching the same texture,
  level and target -- what the engine does every frame -- changes nothing
  and keeps the memo), an attached renderbuffer gets *different* storage,
  an attached texture gets a new `glTexImage2D` (the bound 2D texture per
  unit is tracked for that), an attached object is deleted, or the
  framebuffer itself is. The default framebuffer is always complete.
- locations: (program, attrib|uniform, name) -> location, forgotten when
  the program is linked again or deleted (a 4096-slot open-addressing
  table; names of 48+ characters fall through).
The first cut forgot a framebuffer on *every* attachment call and answered
0 of 7,458 status queries -- the census showed the engine re-attaches per
frame -- hence the attachment-point rule. `glReadPixels` by the game is
counted (0 in 3,000 frames: the 2 % in the profile was the runner's own
frame capture, already gated on the page wanting a PNG), and the present
path's `glGetError` drain runs every 64th frame unless `ISAAC_GL_CHECK=1`
(errors are sticky until read, so nothing is lost; the count is a lower
bound). One pre-existing GL error (0x501 at present #2, before this round)
is still reported.

**Census (3,000 headless frames, `run_web.mjs ... fast=1`, the final
module):** renderbuffer parameters 26,922 answered / 0 to GL; framebuffer status 7,450 answered / 8 to GL (the first cut answered 0 of 7,458, the attachment-point rule 2,997 of 7,458; the 4,462 attachment changes now only switch configurations, and the 2 deletes are the forgets); locations 1,230,948 / 32; glReadPixels by the game 0 in the menus (the node explorer's GL census in play: 579 reads of a sub-64-pixel RGBA region in 3,391 play frames, the engine's own); 4,003,882 GL calls, 1 GL error (the pre-existing 0x501).

**The yield.** `SwapBuffers` handed the frame to the browser with
`emscripten_sleep(0)`, which is `setTimeout(0)` -- and Chrome clamps a
timer to 4 ms once timers nest five deep. Every frame resumes inside the
previous timer's task, so the clamp was permanent: the 10.9 % `(idle)` was
4 ms a frame. Two replacements were measured. `scheduler.yield()` has no
clamp but its continuation outranks every other task, and when the game is
CPU-bound (the 4x throttle) nothing else ever ran: the perf driver's
DevTools evaluate calls hung for minutes (the page itself rendered). A
`MessageChannel` message is a plain task with no clamp, queued behind
input, fetch completions, IndexedDB and the protocol, and the driver ran.
Unclamped, the 4x page ran **122 fps** -- the engine has no frame limiter
of its own here, and a frame the compositor never shows is wasted work --
so the yield paces: a frame that took under 15 ms of work waits for
`requestAnimationFrame` (one game frame per display refresh; a hidden tab
pauses), a slower one takes the message, so a 20 ms frame gives 50 fps
rather than the 30 that vsync quantisation would. `isaac_yield_js` is an
`EM_ASYNC_JS` import, suspended by JSPI like `emscripten_sleep`
(`-sJSPI_IMPORTS=emscripten_sleep,__asyncjs__isaac_yield_js`).

**Result (`drive_perf.mjs`, 30 s of walking and firing in the first
room, medians of 1 s samples):**
- 4x CPU throttle, real GPU: play **60.0 fps** (was 28), menu 59.9;
  samples `22.7 11.2 39.5 49.7 57.1 58.1 56.6 57 56.2 44.9 60 60.2 59.8 60.2 55 60.1 60.1 60.1 58.9 60 59.7 60.3 60 60.1 60 60 60.1 57.8 60.4 60` (the first two are the level load).
- 4x CPU throttle, SwiftShader (no GPU at all): play **35.6 fps** (was 27).
- full CPU, real GPU: play 60.0 fps (was 58; the display pacing caps it).
- the profile after, 4x: 20.5 ms per frame of which 18.1 % is `(idle)` -- the rAF wait, i.e. the frame has spare time -- lifted guest code 35.8 %, host C 19.2 %, native 14.0 %, `(program)` 8.5 %; the top functions are `isaac_lifted_dispatch` 10.9 %, `bufferSubData` 3.2 %, `wasm-to-js` 1.7 %, `isaac_indirect_call` 1.5 %, `readPixels` 1.2 % (the engine's own small readback), `isaac_glc_loc_get` 0.6 %; `getRenderbufferParameter`, `checkFramebufferStatus`, `getUniformLocation`, `getAttribLocation` and `getError` are gone from the list. The next lever is the indirect-call dispatch
- memory, the same run (`SystemInfo.getProcessInfo` + the OS working
  sets): renderer 1,198 MB working set (1,697 MB private), GPU process 507 MB working set (656 MB private), JS heap 104 MB; the SwiftShader run: renderer 1,031 MB and GPU process 576 MB working set. The wasm memory is 1088 MiB (`-sINITIAL_MEMORY`), the
  preloaded assets live in JS ArrayBuffers; the 4 GB target holds with
  room for the OS, and the two levers left are lazy asset fetches (round
  28's lazy-read path) and the audio PCM copies.

**Tests.** Selftest 354 checks / 0 failures (35 new `gl cache:`
checks driving the tables directly: the fall-throughs, the sizes, every
forget rule and the two keep rules, the location separation and flush);
`tests/recomp-web.test.js` pins the wrappers' cache calls, the sparse
error drain and the MessageChannel/rAF yield; `tests/recomp-jspi.test.js`
follows the new import. `drive_perf.mjs` also reports the memory census.

### 21.53 Round 38: the dispatcher's cache, and a hidden tab that keeps ticking

**The dispatcher.** After round 37 the largest single entry of the 4x
profile was `isaac_lifted_dispatch` at 10.9 % -- the indirect-call resolver
itself, not what it calls. It resolves a target VA through `g_index`, one
`uint16` per byte of `.text` (18 MB), so the call-site's usual target was a
cache miss into that table on every call: 17.6 M dispatches in 4,000
explorer frames (4,400 a frame), the six hottest entries 8.5 M of them
(`sub_0040c6b0`, `sub_00a69510`, `sub_0040c630`, `sub_00a12240`,
`sub_0040c200`, `sub_00a12420` -- small virtuals and vector helpers).
`mkdispatch.py` now emits `isaac_lifted_dispatch_cached`: a 4096-slot
direct-mapped (va, id) cache, 32 KB, that stays in L1/L2. A hit skips the
index, the range check and the mode checks and still counts, so the
census is unchanged; `recomp_call_indirect` tries it before the shim check
(a hit is always an image VA the index resolved once, never a shim token).
The cache is off while `ISAAC_HEARTBEAT`, `ISAAC_DISPATCH_WATCH` or
`ISAAC_DISPATCH_TIME` is on, so those modes still see every dispatch. Block
re-entries (1,567 in 4,000 frames) keep the old path.

**The hidden tab.** Round 37's yield waits on `requestAnimationFrame` when
the frame had spare time, and a hidden document gets no animation frames at
all: the desktop app's Browser pane, opened in the background, sat at frame
4. Now a hidden document waits on a 250 ms timer instead (the browser
stretches it to about a second): the game ticks along slowly as the desktop
game does unfocused, the engine's wall-clock delta stays small, and a tab
brought back after an hour does not replay the hour.

**Census and result (3,000 headless frames; `drive_perf.mjs` and
`profile_play.mjs` at the 4x throttle with the real GPU):** 32,404,049 dispatches in 3,001 frames (1,553 block re-entries, 0 misses) -- the same count the uncached dispatcher reports, since a hit still counts; the GL cache census is unchanged (renderbuffer params 26,922/0, framebuffer status 7,450/8, locations 1,230,948/32).
Play 59.0 fps median (menu 59.7); the profile: 19.0 ms per frame, 31.8 % of it `(idle)` (was 18.1 %: the frame's work fell from about 16.8 ms to about 13 ms at the 4x throttle), lifted guest code 29.9 %, host C 15.6 %, native 12.3 %, `(program)` 7.3 %; `isaac_lifted_dispatch` 10.9 % -> 7.3 % with `recomp_call_indirect` now visible at 2.3 % -- the remaining dispatcher time is the tail-jump trampoline (`recomp_run_pending`), which still resolves through the index (round 39 gives it the cache too); `readPixels` 3.0 % is the engine's own small readback in play; `bufferSubData` 1.9 %.

**Tests.** `tests/recomp-fastpath.test.js` pins the cached entry, its
counting, its mode gate and its place before the shim check; the web pins
follow the hidden-document branch; selftest 354/0 (the host links
the weak fallback).

### 21.54 Round 39: ring-buffer staging, and a two-way dispatch cache

**The rings.** The client-array emulation (§21.x, round 13) staged every
draw's vertices and indices with `glBufferSubData` at offset 0 of one VBO
and one IBO -- on top of the bytes the previous draw, still queued on the
GPU, was reading. WebGL keeps that correct, but the way ANGLE keeps it
correct is a copy or a stall per upload, and the throttled profile charged
1.9-3.2 % of the frame to `bufferSubData` for 47 draws a frame (45 KB of
vertices, 3.7 KB of indices). The buffers are rings now (`ring_put` in
`host_gl_clientarrays.c`): a write appends at the head, 16-byte aligned,
and the attribute pointers and the draw carry the offset; when the
remainder cannot hold a request the storage is orphaned with
`glBufferData(NULL)` -- the driver hands out fresh memory and the old block
dies with the draws that read it -- so no upload ever lands on bytes a
queued draw still reads. 4 MB of vertices and 1 MB of indices hold about
90 and 270 frames of the menus; the census counts the orphans.

**The cache, second cut.** Round 38's 4096-slot direct-mapped dispatch
cache left `isaac_lifted_dispatch` at 7.3 %: the game's per-frame set of
indirect targets is larger than the cache, and a direct-mapped cache
thrashes on it. Now 16,384 sets of two ways (256 KB), the older way
replaced on a fill, and the census reports the hit rate.

**Census and result (3,000 headless frames; `drive_perf.mjs` and
`profile_play.mjs` at the 4x throttle with the real GPU):** the rings were orphaned 32 (vertex) and 11 (index) times in 3,001 frames -- 142,015 draws, 136.6 MB of vertices and 11.1 MB of indices staged, every other GL count unchanged; the dispatch cache: 32,348,293 hits / 49,165 fills in the menus (99.85 %), and 12,289,187 hits / 80,576 fills (99.35 %) in a scripted run (Enter x7, then walking -- `web-census-play-r39`).
Play 58.2 fps median (menu 59.8); the profile: bimodal from run to run, and the same for the round 38 module measured back to back (`isaac_lifted_dispatch` 23.1 % / 7.5 % on this module, 25.2 % / 24.5 % / 7.3 % on round 38's) while the cache census says 99 % hits either way -- so the 23 % runs are not misses. They are V8's baseline tier: every headless run is a cold start with a fresh browser profile, the 50 MB module is compiled by Liftoff first and optimised in the background, and a 12 s window taken 40 s into the run lands before or after the optimiser reaches the dispatcher. That finding is round 40 (the wasm code cache). The steady-state figures: 20.8 ms per frame, 26.7 % idle (frame work about 15 ms), `isaac_lifted_dispatch` 7.5 %, `recomp_call_indirect` 2.2 %, `bufferSubData` 1.7 %.
The browser play test on the same module: run started after 9 Enters, screenshots after walking and after firing differ, 30 s of play at 45-60 fps (headless, software GL, another game tab live).

**Tests.** `tests/recomp-host.test.js` pins the ring (one append primitive,
orphan on wrap, offsets carried into the pointers and the draw, nothing
writes at offset 0); `tests/recomp-fastpath.test.js` pins the two ways and
the hit census; selftest 354/0.

### 21.55 Round 40: the wasm code cache -- a warm start for the returning player

**The finding.** Round 39's profiles were bimodal with the same module:
`isaac_lifted_dispatch` 7 % in one run and 24 % in the next, while the
dispatch cache's own census read 99 % hits in both. The variable was not
the module but V8's tiers. Every headless run is a cold start in a fresh
browser profile: the 50 MB module is compiled first by Liftoff (the
baseline compiler, code two to three times slower) and only then, function
by function on background threads, by TurboFan; a 12 s window taken 40 s
into the run lands before or after the optimiser reaches the hot
functions. On a 16-core desktop that catch-up takes about a minute; on a
four-core Chromebook it takes several, and the CPU throttle does not model
it (the DevTools throttle slows the main thread, not the compiler
threads) -- so every measurement before this round was optimistic about
the first minutes of a cold start and pessimistic about everything after.

**The cache.** Chrome keeps a module's optimised machine code in the HTTP
cache entry of the response it was compiled from, and reuses it on the next
visit -- no Liftoff, no catch-up -- when three things hold: the module is
at least 128 KB, it was compiled by `WebAssembly.instantiateStreaming` (or
`compileStreaming`) from the `fetch` Response itself, and that response
was cacheable. The port broke two of the three. The dev server
(`run_web.mjs`) sent `Cache-Control: no-store` on everything, which
forbids the cache entry; now a whole file served from disk carries a
validator (`ETag` from size and mtime, `no-cache`, 304 on
`If-None-Match`), while byte slices and base64 bodies stay `no-store`. The
shipping page (`play.mjs`) counted the module's bytes for its progress bar
by piping the fetch body through a `ReadableStream` into a synthetic
`new Response(stream)` -- a response with no URL and no cache entry; now
the fetch Response goes to `instantiateStreaming` and the progress bar
reads a clone of the body. The shipping server already served the module
immutable under its `?v=` hash (§21.49), so a dist visitor now gets the
cache on the second visit.

**Measured (`drive_perf.mjs ... profile_dir=<dir>`, a persistent browser
profile: the first run is the cold start, the second the returning
player; 4x CPU throttle, real GPU):** the dev page: cold play 60.0 fps median (the run start 68.4 s in, 9 Enters), warm 59.9 (fresh saves: `fresh_saves=1` drops the IndexedDB store first, or the warm run resumes the previous driver's run -- 4 Enters, another room); the dist: cold 59.7, warm 58.9 (the resumed run). The DevTools trace (`trace_wasm=1`, categories v8 / v8.wasm / blink / loading) settles what the cache does: a 120 s cold run shows `wasm.SerializeModule` x11 after `wasm.CompilationChunkFinished` x11, and the profile's `Code Cache/wasm` directory holds 155-214 MB of entries afterwards -- Chrome stores the optimised chunks -- but every reload, dev page or immutable dist alike, shows the same `wasm.StartStreamingCompilation`, `wasm.CompileLazy` x4,400 and `wasm.TopTierCompilation` x700 as a cold start and no deserialisation event. Whether that is a size limit on the entry, the lazy-compilation split, or the headless shell is not settled; the two fixes stand because they are prerequisites, and the warm start is not yet the returning player's start. The memory timeline (sampled every 5 s) found something more important: the renderer's working set peaks at 2.3-2.4 GB for about ten seconds around the run start and settles at 1.0 GB -- the same on the old `no-store` server and with the compiler limited to two threads, so neither the cache write nor TurboFan; the lazy-read census attributes it: one run start issues 812 window fetches, 808 MB, 712 MB of them from `afterbirthp.a`, as 1 MB XHR bodies the GC frees late (round 41)

**Tests.** `tests/recomp-web.test.js` pins the validator, the `no-cache`/
`no-store` split, the 304, the streamed fetch Response and the absence of
the synthetic one, and the drivers' `profile_dir=`; `tests/recomp-ship.test.js`
follows the progress-bar change.

### 21.56 Round 41: the archive windows were thrashing -- 808 MB per run start

**The finding.** Round 40's memory timeline showed the renderer at 2.3-2.4
GB for about ten seconds around every run start, settling at 1.0 GB, on
every server and with any number of compiler threads. The lazy-read
census (`window.isaacLazyStats()`, printed by `drive_perf.mjs`) named the
bytes: one run start makes 812 window fetches, 808 MB, 712 MB of them
from `afterbirthp.a` and 89 MB from `afterbirth.a`, each a 1 MB
`?off=&len=` XHR whose body the GC frees late. The first sixty offsets
(`afterbirthp.a@264 266 265 270 226 227 221 236 227 266 267 ... 270 271
272 270 271 272 273 269 270`) are not a scan: the same windows come back
within a few reads. The wasm stacks under the fetches (`new Error().stack`
inside the pread hook, names from the module's name section) run
`fread` <- `sub_00a52820` (ArchivedFile's window fill) <- `sub_00a179c0` /
`sub_009aa040` / `sub_00931050`: the level load reading its resources,
scattered over a few dozen MB of the archive. Round 24e gave each windowed
file two 1 MB windows -- enough for the mount loop, which alternates
between the entry table at the end and one entry's data -- and a level
load, touching three or more windows in rotation, refetched a window per
read.

**The fix (`host_shims_fs.c`).** A windowed entry has `FS_WIN_SLOTS` (32)
windows in an LRU set: the slot used last is tried first, then the set; a
miss fills an empty slot or evicts the least recently used. At most 32 MB
per windowed file, and only for windows actually touched; the fill/hit
census is `isaac_fs_window_stats()`.

**Measured (`drive_perf.mjs`, 4x throttle, real GPU, a cold start):**
the same cold start, before and after. Windows fetched per run start 812 (808 MB) -> 463-466 (461-464 MB; 324-327 of them distinct, so the level load really touches about 400 MB of `afterbirthp.a` and 43 MB of `afterbirth.a`, and the rest is a modest remaining re-fetch); the steady-state renderer working set 1.0 -> 1.1 GB (the resident windows). The peak did not move with the windows alone (2.8 GB): it was the fetched bodies themselves, 1 MB `ArrayBuffer`s the GC freed late, so the page now detaches each body right after copying it into the wasm heap (`ArrayBuffer.prototype.transfer(0)` frees the backing store at once; guarded for older browsers) -- peak 1.9 GB, settling to 1.1 GB within ten seconds. Neither V8's compiler (one compile thread: the same transient) nor the code-cache write is the remaining 0.8 GB; attributing it is round 42's memory dump. Play stays at 58-60 fps median at the 4x throttle; the browser play test (run start, walking and firing) and the node explorer smoke (2,000 frames, 2 runs, 1 death, main 0) pass on the relinked profiles.

**Tests.** Selftest 356/0: the three windowed reads now cost
three host reads (the far-back read finds window 0 resident), the census
counts fills and hits; `tests/recomp-archives.test.js` pins the 32 slots,
the LRU eviction and the census.

### 21.57 Round 42: the rest of the run-start transient is V8's optimiser

**The tool.** `drive_perf.mjs memdump=1` asks Chrome for a memory-infra
dump (`Tracing.requestMemoryDump` under `disabled-by-default-memory-infra`)
in the menu, at the run start and 3, 7 and 25 s into play, keeps the raw
dumps, and prints the renderer's allocators by effective size. The
renderer is the process whose dump has `v8` allocators; the wasm memory's
resident pages are not attributed to any allocator, so the totals sit
below the OS working set.

**The attribution.** In the menu the renderer's allocators total 497 MB
(`partition_alloc` 268, `gpu/mapped_memory` 98, `malloc` 87). Three seconds
into play they total 1,895 MB, and the difference is two lines:
`v8/main/malloc` 1,107 MB (absent in the menu) and `malloc/allocated_objects`
365 MB (73). Seven seconds in they are 809 and 266; at 25 s both are back
to the menu's figures. `v8/main/malloc` is the isolate's own heap outside
the JS heap -- compiler zones. The run start makes hundreds of large lifted
functions hot at once and TurboFan compiles them on every core, each job
holding its graph until it finishes; on the 16-core desktop that is a
gigabyte for ten seconds. The dispatcher cache, the archive windows and
the XHR bodies (rounds 38-41) were the rest of the 2.8 GB; this is what
remains after them, and no host code allocates it.

**What it means for the four-core target.** It does not scale with the compiler's threads, and it is not the optimiser at all: with V8 limited to two compilation tasks (`js_flags=--wasm-num-compilation-tasks=2`, a four-core machine's compiler) `v8/main/malloc` reads the same 1,100 MB three seconds in, and with tier-up disabled outright (`--no-wasm-tier-up`, Liftoff only) it reads 2,503 MB. Zone memory of that size at the first run start is the baseline compiler meeting the giant lifted functions for the first time (they are compiled lazily, on first call): a wasm function's baseline compile keeps a register/stack snapshot at every jump target, sized by the function's locals, and the game's largest routine -- `sub_005d4380`, 1.57 MB of wasm, 338,000 lines of C, 5,042 labels, thousands of temporaries -- costs that product. Eleven functions are above 256 KB. That is a property of the module, the same on any machine, and round 43 splits them.

**Where this leaves the 4 GB budget.** Steady state after a run start:
renderer 1.1 GB and GPU process 0.5 GB working sets, the JS heap under
130 MB; the transient on top of that is the optimiser's, sized by the
number of cores that run it. The two remaining levers are on the module
itself: smaller lifted functions (the lifter emits one C function per
original function, and a 100 KB routine is a graph TurboFan holds for
hundreds of MB) and a working code cache (§21.55), which would remove the
tier-up from a returning player's run start entirely. Both are lifter or
browser work, recorded in the frontier as the next memory rounds.

### 21.58 Round 43: the giant functions, split

**The cause, exactly.** Round 42 left the run-start transient with V8:
`v8/main/malloc` -- zone memory -- 1.1 GB three seconds into the first
run. It is not the optimiser: two compilation threads give the same
figure and disabling tier-up (`--no-wasm-tier-up`) gives 2.5 GB. It is the
baseline compiler meeting the giant lifted functions for the first time.
V8 compiles a wasm function lazily on its first call, and Liftoff keeps a
register/stack snapshot at every jump target, sized by the function's
locals; the lifter emits one C function per x86 routine with every p-code
temporary as a local, and the game's largest routine, `sub_005d4380`, is
1.57 MB of wasm -- 338,000 lines of C, 5,042 labels, thousands of
temporaries. Eleven functions are above 256 KB. That product is the
gigabyte, and it is a property of the module: the same on a Chromebook.

**The pass (`scripts/recomp/lift/split_giants.py`).** A build-time text
pass on the lifted C, run after every other lift patch (the re-entry
guard and the entry-first goto are absorbed), idempotent, marked
`/* LIFT-SPLIT */`. A function over 60,000 lines becomes parts of about
25,000 lines cut at block labels:
- each part `static void sub_X__pK(CpuState *s, uint32_t nb)` carries the
  function's prologue (the x86 registers and flags loaded from the
  CpuState) and only the temporaries it uses, enters through a switch over
  its own labels, and keeps every goto inside itself;
- a goto into another part becomes `spill the registers; sub_X__next =
  target; sub_X__pend = 1; return;`;
- the trampoline `sub_X(s)` starts at the entry (or at `g_reentry_eip`,
  consumed) and loops: route `nb` to its part by a switch over every label,
  call it, return if nothing is pending, else take the next target. A loop
  that crosses a cut re-enters through the loop, never a nested call, so
  the native stack cannot grow; an x86 `ret`, a parked tail jump or a trap
  returns with nothing pending.

**Measured.** Ten functions in six TUs are split (sub_005d4380 into 14 parts, sub_005b39d0 into 7, eight more into 3-4); the six TUs compile in 56 s where the whole-function versions took minutes. The node explorer's deterministic run (epoch 1700000000, 2,000 frames) is frame-identical to round 41's -- 465 menu frames, run start at frame 322, the same rooms in the same order, 2 runs, 1 death, main 0 -- so the parts execute exactly what the whole functions did. In the browser (4x throttle, real GPU, a cold start) the run-start transient is gone: the renderer's allocators read 639 MB at the run start and 631 MB three seconds in with no `v8` line at all (1,895 MB and `v8/main/malloc` 1,107 MB before); with tier-up disabled, 448 MB (2,503 before); the working-set timeline peaks at 1.22 GB where it peaked at 2.4-2.9 GB, and settles at 1.05-1.08 GB. Play stays at 58-60 fps median; the shipping dist rebuilt on the module starts cold at 58.2 fps with a 1.12 GB peak. One surprise for the record: Binaryen's link-time inliner puts the `noinline` parts back into their trampoline (the wasm has one 1.77 MB `sub_005d4380` again, the parts survive only in the object), and the cost still vanished -- the compilers pay for the shape of the control flow, not for the byte count, and LLVM compiling each part on its own leaves a shape V8 handles in a fraction of the memory.

**Tests.** `tests/recomp-split.test.js` runs the pass on a fixture (a
guard inside the declarations, an entry-first goto, 64-bit temporaries
after the guard, jumps both ways across the cut): the parts, the spill,
the routing, the untouched neighbour, idempotence, `--check`. The node explorer's deterministic 2,000-frame run before and after is the correctness proof (frame-identical census and room sequence, main 0), the browser play test passes, the test family is 170/170, selftest 356/0.

### 21.59 Round 44: below the cap -- a 6x throttle, the link level, and redundant GL state

**Measuring under the cap.** With the display pacing of round 37 every
run at the 4x throttle reads 58-60 fps, so a change to the frame's work
only shows in the profile's idle share. A 6x throttle puts the page below
60 and the play median measures throughput directly; two 40 s runs each,
fresh browser profile and saves.

**The link level.** Linking with `-O3` instead of `-O2` (wasm-opt over the whole module; 51.26 MB against 51.46) changes nothing the throttle can see: at 10x, two interleaved pairs give 33.2 / 35.4 fps for `-O2` and 36.5 / 32.4 for `-O3` (34.3 against 34.5 on average). The link stays at `-O2`. Two lessons about the measurement itself came out of it. At 6x the page straddles the cap (54 and 60 in alternate runs of the same module), so 10x is the throughput setting on this machine. And unseeded runs split into two clusters, about 28 and about 35 fps, for the same module and at 40 s and 100 s alike: the game seeds the run from the clock, and a different level costs a different frame. `run_web.mjs ... ISAAC_EPOCH=1700000000` (a server argument, passed to the page) pins it; with the seed pinned the four runs land within 3 fps of each other.

**Redundant GL state.** The node profile's GL census counts, per frame,
73 `glUseProgram`, 30 `glActiveTexture(GL_TEXTURE0)` (one distinct
argument in a whole run), 30 `glBindTexture`, 32 `glBlendFuncSeparate`
(four distinct tuples in a run) and 9 `glViewport` (eight distinct), each
a wasm-to-JS-to-native round trip in the browser. The web wrappers now
mirror those five pieces of state, update the mirror on every forwarded
call, and skip a call that would set what is already set; a program or
texture deletion clears what referred to it (a name GL still uses cannot
be handed out again, so an equal name is the same object), and the
framebuffer memo of round 37 is still told about the unit and the binding.
The census: 3,000 headless frames skip 275,740 `glUseProgram`, 136,769 `glActiveTexture`, 273,576 blend calls, 13,454 `glViewport` and 1,302 `glBindTexture` -- about 230 native calls a frame -- with the same single pre-existing GL error and the browser play test passing.

**Result.** Seeded (`ISAAC_EPOCH=1700000000`), interleaved, 10x throttle, 60 s of play: round 43's module 33.6 and 34.2 fps median (34.7 and 34.5 over the last 30 s), with the state filter 33.5 and 36.7 (34.7 and 37.2). A small gain, inside the noise on one pair; the filter stays because the census says what it removes and the play test says nothing changed. For the target: 10x this desktop core is far slower than a Chromebook's (a Celeron core is four to five times slower, where the page holds 60 fps), so the 34 fps here is the floor of a machine well below the target.

**Tests.** `tests/recomp-web.test.js` pins the five skips, the deletion
clears and the census; selftest 356/0; the browser play test
passes.

### 21.60 Round 45: the cold start, and what the browsers here will not say about the cache

**The boot, profiled.** `profile_play.mjs phase=boot` samples from the
navigation to the first presented frame. At the 4x throttle, served
locally, the first frame comes at 4.5 s: `fetchSync` 30 % (the six eager
archives and the scripts, 300 MB copied into the wasm heap through
synchronous XHRs), `(program)` 9 %, `glGetProgramiv` + `glGetShaderiv`
7.4 % (the shader compiles -- the driver's work, waited on synchronously),
`atob` 6 % (text files come through the base64 detour of a synchronous
XHR), `sub_00866960` 5 % (the engine's own init), the rest small. On a
machine served over a network the first visit is the 745 MB download
(§21.49) and nothing in this profile; the second visit, if the browser
keeps the immutable slices, is this profile.

**The caches, as far as this machine can see.** `drive_perf.mjs netlog=1`
logs how the module and the image were served. Two findings. The dist
server kept the hashes it read at start-up, so a dist rebuilt under a
running server served the module `no-cache` under the page's fresh `?v=`
(the ETag and the version did not match); it re-reads `dist.json` when
its mtime changes now, and the module is immutable again. And neither
browser available here -- Playwright's headless shell in a persistent
profile, the app's embedded Chrome -- reused the HTTP cache across
navigations even for `immutable` responses with matching validators
(`transferSize` full on every reload, `fromDiskCache` false), which is
why the wasm code cache of round 40 could never be seen to deserialise:
the precondition it keys on was never met in these environments. The
headers are the standard ones (`public, max-age=31536000, immutable`,
`ETag`, `Vary: Accept-Encoding`, `Content-Encoding: br`); a stock Chrome
on the target keeps them. That is the one thing in this stretch of work
that only the target machine can confirm.

### 21.61 Round 47: the browser's edge cases, driven for real

**The driver (`scripts/recomp/web/drive_edges.mjs`).** Against the served
page it seeds an `options.ini` with `EnableDebugConsole=1` into the
IndexedDB save store before the load (the store restores it before main),
starts a run with real Enter presses, types `stage 2` and `goto
s.boss.1010` into the debug console with real key events, forges
`document.hidden` for eight seconds (neither a headless page nor a tab
behind another reports itself hidden under Playwright, and the page's own
signal is what the yield and the audio react to), returns, and reads the
master-output RMS across it all.

**What it found.** The live keyboard path dropped every key the page's
table did not name, and the table had no punctuation: `goto s.boss.1010`
reached the console as `goto sboss1010`. The page's table carries the same
punctuation row as the node driver's now (`tests/recomp-web.test.js` keeps
the two equal). A headed run also reported the music dead behind another
tab; that was the occluded window (Chrome throttles it to 15 fps and mutes
its output), not the game -- with the hidden signal forged the music comes
back at once.

**Verified (round 47's module, 16 of 16 checks):** the console changes the
floor (`Level::Init m_Stage 2`) and reaches the boss room (`Room 5.1010`);
hidden, the game ticks at 3.7 fps and keeps its audio context; back in
front it resumes at 59.7 fps with no empty 250 ms sample; the music RMS
goes 0.067 -> 0.072 (hidden, the chain still scheduled) -> 0.047.

**The readback.** The GL cache's census now records the largest
`glReadPixels`: in play the engine makes 186 calls per 2,200 frames, every
one a 1x1 RGBA read at (60, 227), 744 bytes in all -- a probe every dozen
frames, and each a GPU pipeline drain (`readPixels` 3.3 % of a 6x-throttled
frame). Round 48 logged the wasm stack under the first three reads: `imp_opengl32__glReadPixels` <- `sub_00a69760` <- `sub_00a69700` <- `sub_007b8cb0` <- `sub_00782af0` (one of the split giants: a game update routine going through the engine's graphics layer), and the position follows the player (221, 208 in the seeded run, 60, 227 in another) -- the engine samples the pixel under the player. The value is read synchronously and used, so the drain stays; it is documented, not removed.

### 21.62 Round 48: three more redundancies in the GL stream

**The profile at 6x** (below the cap: 21.0 ms a frame, 6 % idle) put
`bufferSubData` at 3.1 %, `enableVertexAttribArray` 0.5 %,
`uniformMatrix4fv` 0.7 % with `uniform1i`/`uniform4fv` below the cut; the
node census counts per frame 41 `glUniformMatrix4fv`, 30 `glUniform1i`, 21
`glUniform4fv`, 32 `glDrawElements` with their index uploads.
- **Index blocks.** The engine draws quads with the same six-index pattern;
  an index block identical to the last upload is drawn from the ring offset
  it already has, as long as the ring's storage is the one it went into (a
  generation counter bumps on grow and wrap).
- **Attribute enables.** The engine enables its attributes before every
  draw; the wrappers mirror the enable state and skip a call that would set
  what is set.
- **Uniforms.** The current program's (location -> last value) is mirrored
  for `glUniform1i/1fv/2fv/3fv/4fv` and `glUniformMatrix4fv` (count 1); a
  re-send of the same value is skipped. Uniform values live in the program
  object and reset on a link, so a link or a delete forgets the program's
  entries; a call with no current program is forwarded.

**Census and result.** In the seeded 3,000-frame play run: 319,906 uniform re-sends skipped (107 a frame -- the projection matrix, the sampler unit and the colour vector go out with every draw), 31,262 of 65,146 index blocks reused (48 %: the quad pattern), attribute enables 0 (the engine does not re-enable), the state filter's five counters unchanged; index bytes staged 1.36 MB -> 0.90 MB; the same single pre-existing GL error. Seeded (`ISAAC_EPOCH=1700000000`), interleaved, 10x throttle, 60 s of play: round 47's module 35.1 and 36.4 fps median, round 48's 38.4 and 37.1 -- about +2.5 fps, 7 %, at the point where the page is far below the cap; at 4x it stays pinned at 60.

**Tests.** The web pins cover the five skips and the forgets; the host pins
the index reuse and its generation check; selftest 356/0; the
browser play test passes.

### 21.63 Round 49: the lifted code at -O3, a bit-exact host imdct butterfly, and two more edge checks

Three things, each measured on its own clock.

**The lifted TUs at -O3.** Round 44 tried -O3 at the link (wasm-opt) and
found nothing; this round tries it where the code is generated, on the 38
lifted TUs of the fast profile (`LIFT_CFLAGS` in `build_boot.py --fast`;
the debug and node profile keeps -O2 with the memory checks). The module
grows by 0.38 % (51,461,580 -> 51,656,632 bytes), the TUs compile in the
same time (98.4 s at -O2, 100.9 s at -O3, 16 jobs), and the automated
player's 2,000-frame census is byte-identical (the same md5 as round 43's).
Speed: the node explorer over 3,000 frames, three alternating passes, -O2
8841 / 8706 / 8537 ms against -O3 8673 / 8513 / 8509 ms -- 8695 -> 8565 ms
on the mean, 1.5 % less, every pair in -O3's favour. The browser could not
tell: the seeded 10x A/B gave r48 (-O2) 29.7, 33.1, 35.2 and 28.8 fps
against 32.8, 33.8, 33.6, 37.5, 28.0 and 37.3 for the -O3 builds, and the
same -O3 module measured 28.0 and 37.3 in consecutive passes. That
protocol's noise floor on this machine is about 15 % between passes (the
trimmed means move with the medians, so it is the whole run that shifts,
not a few samples); a change under 10 % needs the node clock (deterministic
content, no GPU) or the profiler's per-frame time. -O3 stays.

**stb_vorbis's imdct butterfly, on the host.** The 6x profile of round 47
charged 5.2 % of a frame to the vorbis decoder (sub_00aa38a0 2.2 %,
sub_00aa3270 1.2 %, sub_00aa2580 0.7 %, sub_00aa44d0 0.6 %, sub_00aa3620
0.5 %): the engine decodes two music streams and every sound effect
in-engine, one mixer iteration per frame. sub_00aa3270 is
`imdct_step3_inner_r_loop` -- the sibling iter0 loop's assert names the
source file (`KAGE\Source\Core\External\ogg.cpp`, line 0x995), and the body
is the public-domain butterfly, four per iteration, `A` advancing by `k1`
after each. Its calling convention is fastcall-shaped (lim in ecx, e in edx,
d0 / k_off / A / k1 on the stack, a plain `ret`), and the arithmetic is
scalar SSE single precision throughout (the lifted body is
`recomp_fsub_f32` / `recomp_fadd_f32` / `recomp_fmul_f32` only, no x87), so
a host loop in the same association -- products first, then the sum or
difference -- is bit-identical. `isaac_fast_imdct_r_loop` in
host_fastpath.c is that loop; the WRAP_PATCHES wrapper for 0x00aa3270 gates
it with `isaac_fast_imdct_r_loop_ok` (an empty loop, or either 8n-float run
or the twiddle reads outside guest memory, goes to the lifted body, which
traps the way the original would), and the verify mode snapshots the two
runs, runs both, and compares: 36,056 calls over the 2,000-frame explorer
run, 0 mismatches (the census line `sub_00aa3270: 0 lifted, 36056
verified`). The selftest checks the loop against the source's own
formulation on a pseudo-random buffer, the range the verify mode computes
(both runs, 80 floats for lim 16), and the gate (361 checks). In the 6x
profile of this build the frame is 18.9 ms (21.0 ms in round 47 -- round
48's GL skips and this round together), sub_00aa3270 is gone from the top
40, and the host loop is under the 0.5 % cut. What remains is inverse_mdct
itself (sub_00aa38a0, still 2.3 %) with its other three helpers (iter0 at
0x00aa30a0, the s loop at 0x00aa3430, ld654 at 0x00aa3620 at 0.6 %) and the
residue and codebook decoders (sub_00aa2580 0.8 %, sub_00aa44d0 0.6 %): the
next port is the whole inverse_mdct, one wrapper, its scratch on the host,
the same verify mode -- about 4 % of a frame.

Two build lessons the first attempt taught. The lifted TUs take their host
declarations from `recomp_rt.h`, not `isaac_host.h` -- a wrapper calling
`isaac_is_guest_va` (a static inline of the host header) failed the whole
link with `call to undeclared function`, which clang 16+ treats as an error
even under `-w`; the range checks moved into one host call, the way
`isaac_fast_guest_range` already worked. And the fastpath test pins the
wrapper's shape: after the lifted body a wrapper returns or compares, never
anything else -- so the verify branch that could not allocate its snapshots
returns at once.

**The edge suite, two checks longer.** `drive_edges.mjs` takes `hidden_s=`
(default 8): with 60 s the forged hidden tab ticks at 3.8 fps for the
minute, the audio context stays running, full rate (59.9 fps) is back
within two 250 ms samples and no catch-up stall follows. And with
`options=` (the console) it now reloads the page after the console put the
run on stage 2 and continues the run through the save menu: 17 files
persisted before the reload, 9 restored by the store before `main`, four
Enters to the run. What proves it is the same run is the seed: a continue
logs `RNG Start Seed: <seed> [Continue, n]` where a fresh run logs
`[New, n]`, and the seed must equal the one logged before the reload; the
log offers nothing better, since a continue logs no `Level::Init` (the
floor is loaded, not generated) and the room line names type.variant
(`Room 1.2(Start Room)` on stage 1 and stage 2 alike), not the stage. 22/22
on this build; the continued run plays at 59.2 fps.

**A visible page with no animation frames.** The dist, opened in the
desktop app's browser pane after this round's rebuild, sat at frame 4 with
0 fps and no "paused while hidden" note. The pane's page read as visible --
`document.hidden` false, `visibilityState` "visible", `hasFocus()` true --
and yet `requestAnimationFrame` never called back (a probe waited 1.5 s for
nothing): an occluded embedded view stops animation frames without
flipping the visibility state, and the yield's rAF branch (round 37) waited
on it forever. The JSPI suspension has no timeout of its own, so the whole
engine hung on that promise. `isaac_yield_js` now races the animation frame
against a 250 ms timer and cancels whichever loses: a page that gets no
frames ticks at 4 fps like the hidden path, and a page that gets them pays
one `setTimeout` / `clearTimeout` a frame. The fallback ticks are counted
(`Module.isaacYieldNoRaf`, mirrored on `window`), the shipping status line
names them ("no animation frames (n timer tick(s) this second: occluded?)"),
and the edge suite's check 5 forges the condition -- `requestAnimationFrame`
replaced by a no-op while the page stays visible -- and expects 2-8 fps on
the timer with the counter rising, then full rate once the real function
is back. The pane test itself: PLAY, and the status line counts frames
again.

Round numbers: explorer census identical to round 43's; dispatch census
11,730,132 dispatches, cache 11,628,857 hits / 99,718 fills; selftest
361/0; the family 176/176 (the imdct pin in recomp-fastpath, the edge pin
in recomp-web); the dist rebuilt on this module and played at 4x.

### 21.64 Round 50: the whole inverse_mdct on the host

Round 49 moved one butterfly loop of stb_vorbis's inverse MDCT to the host;
this round moves the function that owns it, sub_00aa38a0, with its other
three helpers -- the iter0 loop (0x00aa30a0), the s loop (0x00aa3430) and
ld654 (0x00aa3620) -- so that a music or effect block is transformed by one
host call instead of a lifted body making some forty lifted and host calls.

**Transcription, not translation.** The host function is the Ghidra
decompile statement by statement, temporaries and all, because the
operation order is what makes the floats bit-identical: MSVC's rendering of
the public-domain source hoists, reuses and reorders products, and the C
source's own ordering would round differently in places. The pieces the
decompile hides -- the register arguments of the helper calls -- came from
the disassembly: the iter0 count is `n >> 4`, the r-loop count `n >> (l+4)`,
the s-loop count `1 << (l+1)`, the ld654 count `n >> 5`, and `ilog` is taken
of n. The step-3 loop bounds are the binary's, not the reference's: r loops
while `l < (ld-3) >> 1`, s loops while `l < ld-6`, with `ld = ilog(n) - 1`
(the source's `ilog` is the off-by-one one, a lookup table in
FUN_00aa08f0, reproduced).

**Where the scratch lives.** The original's n/2-float scratch is
`temp_alloc`: `alloca` when the vorb has no `alloc_buffer`, otherwise a slice
of that buffer at `temp_offset - size`, given back at the end. The first
gate assumed the alloca path and refused an installed `alloc_buffer`; the
verify census answered at once -- `sub_00aa38a0: 2114 lifted, 0 verified`
-- the engine installs one (every one of the 2,114 blocks took that path),
and a gate that declines everything looks exactly like that: read the
census before the profile. The host now puts the scratch where the original
puts it, `alloc_buffer + temp_offset - n/2*4`, writes the same guest bytes,
leaves `temp_offset` as it finds it (taken and given back, the net the
original leaves), and declines only a block that would reach below
`setup_offset` -- the case the original dereferences NULL on. Without an
`alloc_buffer` the host uses its own 16 KB scratch, since the alloca bytes
below the guest stack pointer are nobody's to read.

**Verification.** `ISAAC_FASTPATH_VERIFY=1` over the 2,000-frame explorer:
`sub_00aa38a0: 0 lifted, 2114 verified`, 0 mismatches on the n floats at
buffer -- and, because the lifted body runs in that mode, the round-49 r-loop
wrapper inside it verified its 36,056 calls at the same time. The explorer's
census is byte-identical (the round-43 md5). The selftest (372 checks) pins
the gate -- a power of two in 64..8192, blocktype 0 or 1, the temp_alloc
room -- and runs a block of ones through every step against zero tables:
2,048 zeros out, nothing past the block written, `temp_offset` untouched,
the scratch bytes landing in the guest temp region. The edge suite is
22/22 with the music through the host decoder (the master RMS before,
during and after the hidden minute reads as before).

**Measurement.** Interleaved 6x profiles, two passes: r49 25.2 / 21.1
ms a frame against r50 24.3 / 19.3 -- sub_00aa38a0 (2.2 %) and sub_00aa3620
(0.6 %) gone from the top 40, `isaac_fast_inverse_mdct` at 0.6 % in their
place, about 2 % of the frame. (The machine drifts between passes -- the
same r49 build read 18.9 ms at 13:19 and 25.2 at 14:38 -- which is why the
pairs are interleaved and read as pairs.) The node clock cannot see it:
9095 -> 9020 ms over 3,000 frames, inside the noise, because the node
explorer decodes about one block a frame while the browser's mixer keeps
two streams and the effects fed. What is left of the decoder is the residue
(sub_00aa2580, 0.8-0.9 %) and codebook (sub_00aa44d0, 0.6 %) paths.

Two other lines of the profile are worth a note for later. `readPixels`
(0.9-3.2 %, the engine's own 1x1 probe every dozen frames) is a GPU sync;
an asynchronous readback through a pixel-pack buffer and a fence would
remove the stall but hand the engine a pixel one frame late -- a semantic
deviation the port does not make silently; if it is ever tried it is
opt-in. `bufferSubData` (2.6-3.2 %) is the client-array ring's uploads,
already halved by round 48's identical-block reuse.

### 21.65 Round 51: the page is the game, where the memory goes, and a leaf that was not worth it

**The loading panel that never left.** Playing the dist showed the loading
panel sitting over the game. `overlay.hidden = true` did run on the first
frame; it changed nothing, because the page's own `#overlay { display: flex
}` (and `#stages { display: grid }`) outrank the UA stylesheet's `[hidden]
{ display: none }`. The bug had been there since the page was written -- the
pane screenshots of rounds 46-49 show the panel over the game, read as "the
game behind the loader" -- and a driver reading `window.isaacFrame` cannot
see it. A global `[hidden] { display: none !important; }` gives the
attribute its meaning back; the ship test pins the rule and the two display
rules it has to outrank.

**The page is the game.** On request the shipping page lost its chrome: no
header, no description, no key hints, no Fullscreen button, no Saves button,
no Play button. It starts on its own (`autoplay` is the default now;
`?autoplay=0` keeps the Play button for a gesture before any audio -- the
AudioContext resumes on the first key or click either way, boot_web.mjs's
`resumeAudio`), the loader is one 3 px bar over black (the three fetch
stages' bytes, the boot as the last per cent) with one word under it, and the
canvas is the largest 16:9 box the viewport allows on black. A click anywhere
gives the canvas the keyboard, and F toggles fullscreen. What was chrome is opt-in: `?stats=1` shows
the round-46 status line in the top-left corner (the machine in its
tooltip), `?saves=1` the saves button; the error panel stays. The Chromebook
hand-off reads `play.html?stats=1`.

**Where the renderer's memory goes.** Chrome's memory-infra dump of the r50
build in play (`drive_perf.mjs memdump=1`): the renderer's private footprint
is 1,466 MB at +25 s (1,645 at +7 s), of which the allocators the dump can
name total 452 MB -- partition_alloc 218 (Blink's buffer partition 197),
gpu mapped memory 115, malloc 90, shared memory 116 -- and V8 reports 5 MB.
The rest is the wasm linear memory: `-sINITIAL_MEMORY` is 1,088 MiB,
committed whole (1,088 + 452 = 1,540, the private figure), of which the
working set holds what the game has touched. The guest heap report now
prints that: `touched span 355.2 MiB (highest block end 0x1702d1b8)` against
a 352 MiB peak -- the arena's high-water address, the pages that stay
resident, is the peak plus fragmentation, not more. So the resident renderer
(~1.1 GB working set) is the touched wasm memory plus Blink's buffers, the
GPU process (~520 MB working set) is the textures, and V8's code is small.
Nothing cheap moves those: the 64 MiB single allocations are the engine's
texture decodes (freed after upload), the texture set is the game's, and
the committed-but-untouched part costs nothing on ChromeOS. On the 4 GB
target the budget is tight but not broken; the numbers to watch are the
touched span (grows with what the game keeps) and the GPU process.

**A leaf that was not worth it.** MSVC's `std::map<uint32_t, ...>::find`
(sub_00a12280, 78 bytes) shows 1.0 % self in the 6x profile -- a thousand
calls a frame. A host version -- the walk transcribed, every node checked to
be in guest memory, a 64-level cap -- verified bit-exact over 124,622 calls
(0 mismatches) and measured 0.8-1.2 % against the lifted 1.0-1.1 % in the
interleaved profiles: no gain. The lifted leaf is a tight loop TurboFan
compiles well, and a wrapper's mode check plus the walk's own checks cost
what the leaf costs. Reverted; the lesson is that a fastpath needs work per
call that dwarfs the wrapper, which a 78-byte leaf does not have. Retiring
it found a gap: the patch pass had installed wrappers but never removed one,
so the lifted TU kept the stale wrapper (calling a host function that was
gone) and the module would not build; `apply_wrap_patches` now retires a
wrapper whose entry is gone -- the body back under its own name, the wrapper
and its forward declaration removed -- and the fastpath test pins it. The same
pass retired a second stale stub, the round-16d bind probe at 0x00a9fb80,
whose entry had been made opt-in long ago (an observer only; nothing changes). The two
residue and codebook decoders (sub_00aa2580, sub_00aa44d0, 1.4 % together)
are entangled with the packet reader and its stream reads; also not taken.

Round numbers: selftest 372/0; the family 181/181; edges 22/22 on the final
module (music through the host decoder); explorer census identical; the
dist rebuilt with the game-only page and played in the pane. A new
driver, `check_page.mjs`, opens the shipping page the way a player does (no
query string, no gesture) and reports the first frame's time, whether the
loader is gone and the chrome absent, the canvas box, the frame counter two
seconds apart, the audio state, and a screenshot -- the check the pane
could not run.

### 21.66 Round 52: EDIT FILE -- a menu of the page, in the game's own hand

The request: the save-select screen's DELETE FILE button becomes EDIT FILE,
opening a menu -- export, import, delete -- styled and controlled like the
game's menus, with the game's fonts, art and sounds, and an FPS viewer
option. The screen is the engine's (sprites from `saveselectmenu.png`,
logic in `Menu_Save::Update`, 0x009d9c60), so the feature is three
pieces: the art, the hook, the menu.

**The art.** "DELETE FILE" is not a string, it is paint on the sheet (crop
16,192 272x48, drawn by the anm2's Idle at 119,234). Its letters are the
Team Meat 16-bold bitmap font's -- rendering "DELETE FILE" with
`teammeatfont16bold.fnt` over the strip's paper colour reproduces the strip
-- so `page_assets.py` resets the strip's text between the skulls to "EDIT
FILE" set in that font, tinted with the strip's own ink. The sheet lives in
`afterbirthp.a`, the last archive the engine mounts (its index shadows the
base archives, and a loose file never wins: the resolver tries the archive
index before a root's loose map, §19.2), so the patched sheet goes into the
bundle's `afterbirthp.a` by a byte-for-byte repack with that one entry
replaced (`archive.py`'s writer; 10,228 entries, 10,227 passed through).
The repack is compact -- 442 MB where the instance's copy is 604 MB, every
entry verified byte-for-byte and the mount checksum recomputed -- and the
bundle's archive becomes its own file (the instance stays pristine; the node
build never sees the patched art; the bundle manifest is updated and
`bundle.py check` passes). Beside it, `page-assets/` carries what the page
draws and plays: the sheet (its prompt paper, cursor and skulls), the seed
paper (a blank note the size of the engine's prompt), the font, and seven
menu sounds pulled from the archive by the engine's own path hash
(`resources/sfx/V2/Menu_NoteAppear.wav` and friends, `sounds.xml` ids 282-284,
17-18, 569, 571), with `menu.json` naming the anm2's crop rectangles.
`bundle.py build` runs the step; `ship.py` keeps the directory out of the
game's file index.

**The hook.** In `Menu_Save::Update`, a confirm with the cursor on a file in
delete mode (state 1) sets state 2 and plays "DeleteConfirmationAppear" --
the "ARE YOU SURE? YES NO" note -- at 0x9d9d59. A block patch asks
`isaac_editfile_gate(this)` first: without a page (node, a page without the
menu) it says go and nothing changes (the explorer census is identical);
with the page it calls `window.isaacEditFile(slot)` and skips to the
function's common exit, nothing pushed, no register touched, the engine left
in delete mode. When the menu's own DELETE is chosen, the page names the
slot in `window.isaacEditFileDelete` and presses confirm for the player
(`window.isaacInjectKey`, the pipeline's key table); the gate consumes the
name, lets the transition through, and the game's own prompt and deletion
run untouched. While the menu is up the pipeline hands every key to
`window.isaacKeyCapture` and the engine sees none.

**The menu.** `menu_overlay.mjs` draws one canvas over the game's (480x270
at 2x, pixelated): the seed paper where the engine draws its prompt (the
prompt paper's crop rectangle, 240x144 at 114,59), "FILE n" and the
entries -- EXPORT FILE, IMPORT FILE, DELETE FILE, FPS VIEWER: ON/OFF, BACK
-- in the font from a BMFont v3 parser (the atlas tinted with the strip's
ink, the unselected entries lighter), the sheet's cursor beside the
selection, and the engine's sounds through the page's AudioContext: note
appear on open, menu scroll on a move, the light flip on a choice, paper
out on back, the rip on delete. Up/Down or W/S move, Enter/Space/E choose,
Escape/Backspace go back. Export zips the file's `persistentgamedata` and
`gamestate` (and their `rep_` forms) from the saves store; import takes a
zip from that export or a bare `.dat`, renumbers it into the chosen file's
slot and reloads (the engine holds the old data in memory). The FPS readout
is plain text in the top-left corner -- the frame rate in the same font, a
light shadow under the ink -- fed by the status line each second, and it is
a key, not a setting: N flips it (white, the number alone), this browser remembers it in
`localStorage`, nothing of it touches the saves store (a menu entry and a
store-backed setting were tried and taken out on request; Q was the first
key and is the game's pocket-item key, so N, which the game leaves
unbound). The game's
own Options menu is engine-drawn and engine-driven (the anm2 has one
animation per option -- Fullscreen, ChargeBars, ExtraHUD, ... -- over a
scrolling paper, and the item table is code); adding an item there is engine
work of another size (and `?stats=1` still shows the full status line).

The first cut of the strip painted a flat rectangle of the paper's median
colour under the new text, and the rectangle showed against the strip's
shading; the second erases only the ink -- every dark or anti-aliased pixel
in the letters' rows takes the median of its own row's paper pixels -- and
sets the text a pixel heavier (the glyphs land twice, a pixel apart) to
match the strip's hand-lettered weight, from the pristine sheet in the
instance's archive so a rebuild never works from its own output.

**Proof.** `drive_editfile.mjs` reaches the menu as a player does on the
shipping page -- title, Enter to the save select, Down onto EDIT FILE, Enter
into file-choosing mode, Enter on file 1 -- and checks that the page's menu
opened instead of the engine's prompt, that BACK closes it and the next
confirm reopens it, that FPS VIEWER toggles and is remembered and shows
while playing, that DELETE closes the menu with the named slot consumed by
the gate (the engine's own prompt then on screen, Backspace leaving it), and
that no page error occurred; it saves screenshots of the menu, the viewer
and the engine's prompt. The pins: the block patch and the gate
(recomp-fastpath), the key capture, the injected key, the entries, the
remembered toggle, the sheet reset and the bundle rule (recomp-web), the
menu module in the shipped page set (recomp-ship).

### 21.67 Round 53: one index buffer for every quad, and a memory soak

**The static quad index buffer.** The per-frame GL census (20,000 explorer
frames): 37 `glDrawElements` a frame, each preceded by two uploads into the
client-array rings -- the vertices and the indices -- and round 48 had found
that half the index blocks repeat the previous one. The rest of the story is
that they all repeat one thing: the engine draws its sprites as quads, six
indices per quad over four vertices, the same six offsets (0 2 1 1 2 3)
stepping by four -- so every block is a prefix of a single fixed sequence.
`host_gl_clientarrays.c` now learns those six offsets from the first block
it sees, keeps one static `ELEMENT_ARRAY_BUFFER` holding the sequence (4,096
quads to start, doubled as needed, per index type), and draws any such block
from its offset 0: no upload, no ring space, no compare. A block that is not
the pattern still goes through the ring (the ring's binding is restored
before a reused block draws). The browser census over 3,000 frames: 90,760
draws, every one on the static buffer, 0 index bytes staged, 0 blocks off
the pattern -- the index ring never fills in play. `ISAAC_GL_QUAD_IBO=0`
turns it off, which is how it was measured: the same module served twice,
interleaved 6x profiles, off 28.5 / 30.9 against on 27.2 / 26.1 ms a frame, bufferSubData 3.5 / 3.4 % against 3.1 / 2.7 % (the machine was in a slow hour; the pairs are what count). The emulation
needs a GL context, so the selftest does not cover it; the census line is
the proof, and the web pins hold the path, the rebinding and the switch.

**The soak.** 20,000 explorer frames in node (3 runs, 2 deaths, 7 room
transitions; the explorer never found a trapdoor, so no floor changes):
peak live 352.7 MiB, touched span 355.2 MiB -- the same as after 2,000
frames. The guest heap does not grow with play; a floor change is covered by
the edge suite's console `stage 2`, whose browser memory timeline stayed
flat in rounds 47-51.

**Round 52 corrections on request** (the EDIT FILE strip erased by its ink
from the pristine sheet and set a pixel heavier; the FPS readout as plain
text; then Q, then M to flip it, nothing in the saves store) are in 21.66.

### 21.68 Round 54: three edge hunts -- a ten-minute soak, a tab hidden for five minutes, every floor by console

Three runs on the round-53 module, all on the shipping-shaped page, none of
which found a fault; each is a driver that can be run again.

**The soak.** `drive_perf.mjs seconds=600` at the machine's own speed: 60 fps
median over 600 seconds with no ten-second sample under 56, the renderer's
working set 1,081 MB at the start and 1,075 MB at the end (1,053 minimum,
1,216 at one transient, 124 samples), the GPU process at 503 MB, zero page
errors. The node explorer's 20,000-frame soak (§21.67) had said the guest
heap does not grow with play; the browser's process says the same of the
whole renderer.

**Hidden for five and a half minutes.** `drive_edges.mjs hidden_s=330`:
3.8 fps for the whole of it (the 250 ms timer path), the audio context
running throughout, full rate back within two 250 ms samples, no catch-up
stall, the music audible again. One honesty about what this covers: the
driver forges `document.hidden`, so it exercises the port's hidden path for
that long, not Chrome's own background throttling -- a tab that is really
hidden for five minutes gets its timers slowed to one a minute by Chrome's
intensive throttling, so the game then ticks once a minute (paused, in
effect) and the same resume path brings it back.

**Every floor by console.** `drive_floors.mjs` (new): options.ini seeded
with the console enabled, a run started, and `stage N` typed for 2 through
13 and then the alternate path's 1c, 2c, 3c, 4c (Downpour, Mines,
Mausoleum, Corpse), each waited for its `Level::Init` line, then the frame
rate over two seconds and the browser's process memory. Sixteen floors
generated and transitioned into at 59.2-60.1 fps each; the renderer's
working set 1,075-1,193 MB once the boot transient had passed (the first
sample, 1,589 MB, is the page still holding the module's bytes and its
JavaScript heap at 307 MB; it is 1,075 MB by the seventh floor), the GPU
process 511-523 MB; no page error. The seeds show the game's own floor seeds
re-rolling per stage as they should. 21/21.

What the goal's list still lacks a driver for: the wasm code cache on a
warm start (unverifiable in the browsers here, §21.60), and a real
Chromebook (the user's device: `play.html?stats=1`).

### 21.69 Round 55: the cold start -- a boot trail fetched ahead by a Worker, and the browser's own base64

**The figure.** On the shipping page at a 4x CPU throttle (`drive_boot.mjs`,
new: the same page opened twice in a persistent profile, the first visit
cold, the second with what the first left behind), the engine reads 442
archive windows -- 440 MB of afterbirthp.a, front to back at mount and then
the title screen's resources -- before its 300th frame, every one a
synchronous base64 XMLHttpRequest decoded on the main thread, and frame 300
comes at 44-51 s (three cold runs before this round's decoder: 51.1, 44.5
and 49.2 s; the spread is the machine's). Nothing else on the page is in
that league: the first frame is at 1.9-2.7 s.

**A negative first.** A synchronous XHR can carry the raw bytes as an
8-bit text (`overrideMimeType('text/plain; charset=x-user-defined')`, the
server padding one byte), which skips the base64: measured, frame 300 came
at 70-75 s against 50 -- Chrome's decoding of that charset for a 1 MB body
is slower than atob. Reverted; the comment on `fetchSync` records it.

**The trail.** The page keeps the windows the boot read up to frame 300
(`isaac-boot-trail` in localStorage, 441 entries) and fetches them ahead on
the next visit. The first cut never wrote it: the trigger sat in
`cfg.isaacPresent`, which fires only for frames the page keeps, and the
served page keeps none (`isaacWantsFrame` says no to every frame there since
round 25), so `presented` stayed at 0. The host's frame counter, reported for
every frame, is the trigger now (`isaacWantsFrame`, and the pread path as a
fallback), and `pagehide` writes a short visit's trail.

**Who fetches.** A pump on the main thread -- six fetches in flight, each
`.then` needing a turn of this thread's event loop -- managed 106 of the 442
windows before frame 300 (51.1 s cold, 43.0 warm): the loop turns once a
frame, between long stretches of the engine and its synchronous reads. The
fetching moved into a Worker (a Blob of this origin: its loop is free, it
pulls at the network's speed and transfers each window, no copy; a
consumed or dropped window is acked back and the Worker keeps 128 MB in
flight or delivered): 138 of 442 (44.5 s cold, 40.1-41.8 warm). The
deliveries still land only when this thread yields, and the boot's
stretches between yields consume more than the budget delivers -- the
reads before the first frame, and the mount pass, see none of it. The
trail and the Worker stay (they are the shape round 56 needs); the gain is
the 3-4 s it is.

**The decoder.** `bench_decode.mjs` (new), one 1 MiB window at a 4x
throttle, medians of eight: the synchronous XHR 16.3 ms, the legacy decode
(atob and a charCodeAt loop) 16.7 ms, `Uint8Array.fromBase64` 3.1 ms and the
same bytes; a main-thread `fetch` of the raw bytes 96 ms (its body arrives
in chunks, each a task on the throttled thread -- the reason it cannot
replace the synchronous XHR). `fetchSync` decodes with the native decoder
where there is one (Chrome 140+, Firefox 133+, Safari 18.2+; the loop stays
for the rest), and it leaves no 1 MB binary string for the collector: frame
300 at 37.9 s cold and 33.8 s warm (138 hits) in the same run shape.

**Next (round 56).** The reads themselves: `isaac_fs_lazy_pread_js` becomes a
JSPI import, so a read that the Worker has to fetch suspends the wasm stack
until the Worker answers with the raw bytes, and the Worker reads ahead
along the archive (the mount pass is sequential) and along the trail; no
base64, no synchronous XHR, and no waiting for this thread to yield.

### 21.70 Round 56: every archive window read by a Worker, the wasm stack suspended meanwhile

**The read is a JSPI import.** `isaac_fs_lazy_pread_js` joins
`JSPI_IMPORTS` (build_boot.py), so when the page's hook returns a promise
the engine's stack is parked mid-read -- as the yield parks it once a
frame -- while this thread's event loop runs; a number is still the answer
at once (the node profile, `?reader=0`). Nothing else in the engine's
stack is JavaScript at that point (the audio is push-only: the engine
queues WebAudio buffers, no callback calls into the module), so the
suspension is safe wherever a windowed read happens: the mount, the
title's loading, a level's resources, a music stream.

**The reader.** A Worker of this origin (a Blob, `READER_WORKER` in
boot_web.mjs) answers every window: its loop is free, so it fetches the
raw bytes -- no base64, no synchronous XHR, no 1 MB strings for the
collector -- and transfers them; the page copies them into the heap and
resolves the read. It fetches ahead: along a file read forward by up to
four windows, and along the trail the last visit left (round 55, the
trail now lives in the Worker's cache rather than this thread's), 128 MB
at most held or in flight, six fetches at a time; a read the Worker has
in flight attaches to it, a read it has to fetch is a *wait*. A Worker
that dies hands the pending read and the rest to the synchronous path.

**Measured** (`drive_boot.mjs`, the shipping page at a 4x throttle, frame
300 = the title screen up and loaded): 27.6 s cold and 23.6 s warm,
against 40.0 s for the same module with `?reader=0`; the engine waited
3.2 s (268 waits, cold) and 1.0 s (136 waits, warm) for windows in all,
and hit 174 (cold, the read-ahead) and 306 (warm, the trail) of its 442.
The boot's window order is scattered, not sequential -- the driver prints
the first ones: the head of each archive, the table at its end, then
entries wherever the resources are -- so the forward read-ahead adds
little (183 windows ahead, 27.1 s), and a cold visit's remaining waits are
the price of not knowing the order; a trail shipped with the dist would
give a first visit the warm figure, which is 4 s here. Frame 600 follows
frame 300 by 5.0 s in every run: the rest of the cold start -- 21 s at 4x,
about 5 at full speed -- is the engine's own loading work between the
first frame (2.2 s) and the title, which the next round profiles
(`profile_play.mjs phase=start`).

**Also.** The node profile's link had been missing `isaac_editfile_gate`
since round 52 (the gate lived under `ISAAC_WEB`; the lifted block patch
calls it in every profile): a stub outside the web profile returns the
engine's own prompt. Checked on the round's module: edges 22 ok / 0 fail, EDIT FILE PASS 11/11, page 1 ok / 0 fail, floors PASS 21/21, the node explorer census md5 unchanged (r43 pin).

### 21.71 Round 57: the loading work profiled -- the keystream by words, the archive inflate_fast on the host

**The profile.** `profile_play.mjs phase=start` (new: from the first
presented frame to frame `until`, 300 by default) at the 4x throttle,
24.8 s sampled over 305 frames: 25 % idle (the reader's waits, 3 s, and
the yields' vsync waits), 32 % lifted code, 23 % host C. By self time:
`isaac_fast_keystream_xor` 11.8 % -- a host fastpath already, but a byte
loop, and every archive byte passes through it -- then `sub_00a85710`
9.5 % (1,784 instructions, a 54-way state switch: miniz's
`tinfl_decompress`, the archive stream's inflater; the next round's),
`sub_00adb9c0` 5.8 % (376 instructions: zlib's `inflate_fast` reshaped for
a ring-buffer output, the PNG side), `isaac_fast_premultiply` 2.5 %,
memcpy 2.3 %, `isaac_fast_adler32` 2.1 %, the page's 1 MB window copies
1.7 %, then a long tail. The mount's checksum pass is not in it (skipped
since round 26, §21.40); what remains is the title's resources being
decoded.

**The keystream by words.** The guest is little-endian, so XORing the
32-bit word at the buffer with r[idx] is the four byte XORs, least
significant byte first, of the loop it replaces; a trailing partial word
still takes (and drops the rest of) a fresh word. 11.8 % to 6.1 %
(2.9 s to 1.4 s over the window).

**inflate_fast on the host.** The 376 instructions transcribed from the
disassembly (`pequery body`): 8-byte code entries {op, bits, -, val}, a
20-bit prefill (a length code and its extra bits at once), second-level
tables relative to the entry that points at them, the state's window
ring (base, end, the reader's position -- the byte before it is the last
free one -- and out), wrap-around distance copies, the whole bytes left
in the bit buffer handed back to the input at the exit (the buffer itself
never masked), and the three exits: 0, 1 (end of block), -3 with the
engine's own message strings. The gate declines under 258 bytes of room
or 10 of input (the loop's own continuation terms, which the lifted body
does not check on its first iteration). Selftest: a hand-made table
(literals, a length-3 copy, end of block; a copy from before the ring's
start that wraps to its end; the input-ran-low exit; an invalid code;
the three declines), 381 checks. Verify mode on the explorer's 2,000
frames: 93,653 calls, every one byte-exact (the window, the state, the
input struct and eax); the keystream's 263,385 the same; 0 mismatches;
the explorer census md5 unchanged. And the honest figure: the host
inflate_fast takes the same time as the lifted body did (6.3 % of a
shorter window) -- the lifted decoder was already C, and a C decoder does
the same work; the gains of this kind come from an algorithm changed
(the keystream) or from code the lifter emits badly, not from
transcription itself.

**Measured.** Frame 300 at the 4x throttle: 24.0 s cold (27.1-27.6 s
last round), 22.3 s warm (22.1-23.6), no page errors. The profile after:
keystream 6.1 %, inflate_fast 6.3 %, tinfl 10.2 %, idle 25.5 %.

### 21.72 Round 58: miniz's tinfl_decompress on the host, and the host at -O3

**The function.** `sub_00a85710` -- 1,784 instructions, a 54-way jump
table on its first field, two callers (the archive stream reader
0x00a89f80 and 0x00a614d0), three calls (memset, memcpy, the security
cookie), no strings -- is miniz's `tinfl_decompress`, and the 1.x
generation of it: the coroutine states are the public source's minus 54
(a later stall check), the struct is the old `m_tables[3]` layout (0xda0
a table: code sizes, the 1024-entry lookup at +0x120, the tree at +0x920;
the raw header at +0x2920, the length codes at +0x2924), and the details
the disassembly settles are 1.x's: `TINFL_GET_BYTE` hands a 0 when the
input is gone and the caller did not say more is coming (state 38/40 in
the stored-block copy is the one place it fails instead), no put-back of
whole bytes at the exit and no mask on the bit buffer, the state-37
distance test is `dist > dist_from_out_buf_start` alone, no `code_len ==
0` checks in the fast loop, and the byte-align skip at the end only ahead
of a zlib trailer. The archive reader calls it with a 1 KB ring (out_start
== out_next, the size a power of two, no header parsing; flag 2 when more
input follows), and an eleven-year-old compressor that never reaches
past that ring.

**The port** is the public source with those details and the guest's
offsets, the coroutine kept (a call may resume the lifted body's work and
vice versa). Selftest: zlib-made raw streams -- a stored block, a fixed
block, a dynamic block over a 2,880-byte text, decoded whole and a byte at
a time (every state resumed), and a 512-byte-window stream through a
512-byte ring the reader's way, reassembled over seven HAS_MORE_OUTPUT
rounds -- 391 checks. Verify mode caught the one divergence -- the
unconditional byte-align skip, 234 of 39,902 calls, every one a DONE --
and passes now: 39,902 calls byte-exact over the whole decompressor, the
window, both sizes and eax; 0 mismatches; the explorer census md5
unchanged.

**The host at -O3.** The host TUs were compiled at -O1 beside -O3 lifted
code -- since the first host layer, and never questioned. In the fast
profile they are -O3 now (`build_boot.py`; the debug profile keeps -O1).
The play profile at 4x, the same module before and after: 21.0 to 19.8
ms a frame, the host share 25 % to 14 %. The loading window: 24.7 to 19.8
s sampled to frame 300, the host tinfl 8.7 % of the shorter window (1.7 s
against the lifted body's 2.4).

**Measured.** Frame 300 at the 4x throttle: 22.3 s cold (24.0 last
round), 18.9 s warm (22.3). Drives on this module: the saves round trip
below is round 59's.

### 21.73 Round 59: the saves round trip driven, and the dist ships its boot trail

**The saves round trip (`drive_saves.mjs`, new).** A persistentgamedata1.dat
of 1,024 known bytes is seeded into the save store with options.ini; the
player's way in; EXPORT FILE on file 1 hands the browser a zip, read back
in node: one stored entry under the save's travel name with the store's
bytes, and a manifest naming slot 1. BACK; Right onto file 2; IMPORT FILE
opens the file chooser (a hidden input's `click()` from the key event --
checked in isolation: it opens with or without a user activation, and
survives the page reloading itself), which gets that zip: the store holds
the same bytes as persistentgamedata2.dat, key and travel name renumbered,
before the page reloads itself and after. After the reload a bare .dat
goes into file 3 the same way. 15 of 15. Two things the driver learnt on
the way: the engine keeps a `save_backups/<date>.persistentgamedataN.dat`
copy of every file it opens (a regex over the store's keys counted them
as duplicates; the checks go by the exact key now), and a driver that
takes several choosers across reloads is steadier with one `filechooser`
listener and a queue than with a `waitForEvent` each time. The menu now
logs the entry chosen and its outcome, and exposes `message()`.

**The dist ships its boot trail.** `drive_boot.mjs` leaves the trail its
visit recorded as `<out>/boot-trail.json`; `ship.py build --trail <file>`
places it in the dist and the manifest as `/boot-trail.json` (23 KB, 441
windows); a page with no trail of its own fetches it (`?trail=0`
declines: the A/B). A fresh profile's first visit then reads like a
returning one: 306 of 442 windows hit, the engine waiting 1.0 s for
windows instead of 2.6-2.9. On localhost that is inside the noise of the
frame-300 time (22.9 s against 22.3), because there the cold/warm gap is
the first boot's own work (the default options and saves it writes, the
backups), not the reads. Under a 200 Mbit/s download cap (`drive_boot.mjs
net=200`, CDP's emulation, 20 ms of latency) the reads are the slower
party and the trail is worth 10-12 s: frame 300 at 38-40 s with it
against 48-52 without (the engine waited 2 s against 21). It cost the
first frame, though -- 12-13 s against 6.5 -- because the prefetch
competed with the boot's own downloads on the capped link. The prefetch now starts at the first presented frame instead of at load: the first frame is back at 5.7-6.0 s (the same as without the trail), and frame 300 comes at 32.0-32.7 s against 46.5-46.9 without -- 14-15 s sooner, the engine waiting 1.7-1.8 s for windows against 20.

**Drives on the round's module and page.** edges 22 ok / 0 fail, EDIT FILE PASS 11/11, page 1 ok / 0 fail, saves PASS 15/15, floors PASS 21/21 (59.3-59.9 fps, renderer 1181-1644 MB), family 4048/4048 pass, 0 fail.

### 21.74 Round 60: the memory map, the Worker's cache after the boot, the uploads in bands

**The driver (`drive_memory.mjs`, new).** The page boots to frame 600 and,
with `options=` and `stage=`, into a floor by console the floors driver's
way; then the OS's figures for the renderer and the GPU process (working
set and private bytes, `SystemInfo.getProcessInfo` and Get-Process), a
detailed memory-infra dump through CDP tracing (every allocator's
effective size, per process), and a census of every `texImage2D` the GL
glue made (an init script wraps the prototype). One reading is the
collector's timing: the same page read 1,094 MB and 1,634 MB of working
set at the same floor five minutes apart, the second with 78 MB of
JavaScript garbage pending -- so the driver asks for three garbage
collections first (`HeapProfiler.collectGarbage`) and reports both
readings. After that the figures repeat within 20 MB.

**What the dump says, and what it cannot.** At stage 2 the renderer's
working set is 1.06-1.10 GB, its private bytes 1.47-1.51 GB (the 1,088 MiB
wasm memory is committed whole on Windows; on ChromeOS only the touched
pages are resident), the GPU process 510-520 MB. memory-infra attributes
560 MB of it: partition_alloc 220-243 MB, `gpu/mapped_memory` 98 MB (a 64
MB and a 32 MB transfer chunk, the same bytes again as `shared_memory` and
in the GPU process), malloc 105-109 MB, the WebGL drawing buffer 26 MB,
v8 8 MB. The wasm memory and the wasm code are not in it (the v8 provider
reports its JavaScript heaps only), which is where the other half a
gigabyte lives: the guest arena's 352 MiB touched span (§21.65), the
host's LRU archive windows (32 a file, 128 MB when all four files are
touched), and the module's Liftoff code.

**The reader Worker's cache.** The Worker held up to its 128 MB budget of
windows fetched ahead and never asked for, plus the trail's leftovers, for
the page's life: 1,157 MB of working set against 1,078 with `?reader=0`.
At frame 600 (the title up, its resources read) the page now tells it to
drop its cache and the trail and to keep 8 MB of read-ahead for play
(`clear`); 1,091-1,101 MB against 1,062-1,071 with the reader off, the
rest the Worker isolate itself. The memory image's 8 MB (isaac.segs.bin)
was held by the boot function's frame for as long as main() runs -- it is
dropped once placed.

**The uploads.** The census: 702 `texImage2D` calls, 419 MB of texels in
all, 35 of 4 MB or more, 5 of 16 MB or more, the largest 64 MB (a
4096x4096 RGBA sheet). Chrome's GL client stages an upload through a
mapped transfer chunk sized for it and keeps the chunk, so that one sheet
is the 64 MB chunk (and the 32 MB one another sheet) resident in both
processes. The host's `glTexImage2D` now allocates with a null pointer and
sends the rows as `glTexSubImage2D` bands of at most 4 MB when the upload
is larger (RGBA, RGB, LUMINANCE(_ALPHA) UNSIGNED_BYTE, the default unpack
alignment: all the engine uses); `ISAAC_GL_TEX_BAND=0` keeps the whole
uploads. The pixels are the same: the headless runner's frames 100, 200, 300 and 399 hash identically with the bands and without (`ISAAC_GL_TEX_BAND=0`; 580 uploads on that run, 6 of them in 38 bands). Memory at stage 2, garbage collected first: the renderer's working set 1,002-1,004 MB against 1,090 (its `gpu` allocator 19 MB against 115: the 64 and 32 MB chunks are gone), the GPU process 409-410 MB against 511 of working set -- and 762-764 MB against 607 of private bytes, committed but not resident, ANGLE's own staging for the sub-image path on this D3D11 machine; a Chromebook's ANGLE is another backend, and resident pages are what it pays for. The page check passes.

### 21.75 Round 61: the host TUs with wasm SIMD, and a soak of the round-60 module

**The soak first.** `drive_perf.mjs seconds=600` on the round-60 module
(the reader Worker with its cache cleared at frame 600, the uploads in
bands): 60 fps median over 600 s of play at the machine's own speed (one
28.5 fps sample, the run's start), the renderer's working set 1,239 MB
at six seconds and 1,022 MB at the end -- the boot's garbage collected,
nothing growing -- the GPU process 447 MB, no error. The edge drives on
that module: 22 of 22, the EDIT FILE menu 11 of 11.

**SIMD.** The fast profile's host TUs are compiled with `-msimd128` now
(`build_boot.py`; the lifted TUs are not: their SSE is scalar by the
lifter's hand, and clang will not vectorise across it). Every browser
since 2021 and node have wasm SIMD, so nothing is lost by requiring it,
and clang at -O3 vectorises the plain byte loops -- adler32, the
premultiply, the PNG unfilter, memset/memcpy-shaped copies -- on its own.
The verify mode is the proof that the vectorised fastpaths stay
byte-exact on the game's own data. Verify mode: 0 mismatches over the explorer's 2,000 frames, the census md5 unchanged. And the honest figure: nothing measurable. The loading window is the same length (19.7 s sampled to frame 300 against 19.8; keystream 7.3 %, tinfl 9.4 %, inflate 6.8 %, premultiply 3.2 %, adler32 1.5 % -- the decoders' loops carry a dependency from byte to byte, the premultiply is a table lookup, and clang vectorises none of them), and the play frame at 4x reads 18.8, 19.9, 20.5 and 21.2 ms over four profiles against 19.8 and 22.5 before -- the spread of the method, not a difference. (A first profile after a server restart twice showed the slow dispatcher at 17 % where later ones show 3-5 %: the node census counts a 98.9 % cache hit rate, so that is the profiler's attribution on a cold module, and the reason profiles are read in interleaved pairs.) The flag stays: it costs nothing, every target has SIMD, and it is what a hand-written v128 keystream needs next.

### 21.76 Round 62: the keystream sixteen bytes at a time, and two censuses

**The keystream in v128.** Four consecutive words of r[] are the same
sixteen keystream bytes, least significant byte first, that four scalar
steps take, so where the build has wasm SIMD (`__wasm_simd128__`, the
fast profile since round 61) `isaac_fast_keystream_xor` does them with one
`v128.xor` per block; a block that would take r[255] -- the refill point
-- or lie past it goes word by word, so the refill lands exactly where the
scalar loop puts it, and the tail is the word loop. The selftest build
has SIMD too now (it runs on node), and its keystream check covers forty
bytes from r[254]: two words to the refill, then two v128 blocks of the
new block; the verify mode covers the game's 263,360 calls. Measured at 4x: the keystream's share of the loading window 7.3 % to 5.6-5.7 % (1.4 s to 1.0 s), the window 19.7 s to 18.1-18.3 s sampled to frame 300 (two profiles), a first visit's frame 300 at 20.5 s (23.7 last round, the same shipped trail); the selftest 391 checks with SIMD on, the explorer census md5 unchanged. A tab hidden in the middle of the loading (`drive_boot.mjs hide_at=60 hide_s=10`, new: `document.hidden` forged from frame 63 for 10 s, with the reader Worker's windows in flight and the engine suspended in reads): 30 frames ticked on the 250 ms path meanwhile, and the boot went on to frame 300 at 32.1 s and 600 at 37.1 s once visible, 0 page errors.

**Two censuses on the way.** The browser explorer's 3,000 frames: 32.1 M
dispatches, the cache 32.07 M hits to 49 K fills (99.85 %) -- so the two
profiles that showed the slow dispatcher at 17 % (§21.75) were the
profiler's attribution on a cold module, not misses. And the one GL error
every finite run reports (0x501, pending at a present around the title):
`ISAAC_GL_CHECK=1` names it -- `glDeleteProgram` of a name that is not a
live program, four times in 121 frames. The host forwards program names
untouched, so it is the engine's own call, as on the desktop, where the
same error is raised and never read: reproduced, not fixed.

### 21.77 Round 63: quad draws batched, and unbatched again

**The idea.** The engine draws every sprite as its own quad through the
client-array path -- a few attribute uploads, the pointers, a draw -- so
consecutive quad draws with no forwarded GL call between them, the same
attribute layout and one interleaved array each could go up as one ring
upload, one set of pointers and one draw over the static quad indices of
round 53, the pixels unchanged because one draw's primitives are
rasterised in order. It was built (`batch_add` / `batch_flush` in
`host_gl_clientarrays.c`, every entry point of `host_gl_webgl.c` flushing
on entry unless it is the draw, a query or a filtered state call that
does not forward), with a census naming the entry point that flushed each
batch, and the explorer's 1,500 frames hashed batch on and off.

**What the census said, three times.** First `glGetAttribLocation`
flushed every batch: the engine looks its attribute locations up before
every draw, the lookups are answered from the round-37 cache and change
nothing, so queries were made to keep the batch. Then
`glDisableVertexAttribArray`: the engine enables its arrays before every
draw and disables them after, a real state flip between any two draws;
since only a draw consumes that state, the enables were recorded and
applied at the draw. And then the truth of the workload: of 50,515 quad
draws, 3 merged. 37,761 batches were flushed by `glBindTexture` -- the
engine binds a different sheet between three consecutive draws in four
-- 5,990 by a `glUniform2fv` that changes per draw, the rest by the
clear, the program, the blend function and the present. There is
nothing to batch without changing what the engine binds, which is not
this port's business. The pixels hashed identically on and off (frames
500, 1,000 and 1,499), the play profiles read 19.8-20.4 ms a frame before
and after (noise), the edge drives 22 of 22 and the EDIT FILE menu 11 of
11 on the batched module. Reverted; the dist serves the round-62 code
again. What stays is the knowledge: the per-draw cost of this port is
already the engine's own draw order, and `bufferSubData` at 1.1-1.8 % of
a frame is its floor.

### 21.78 Round 64: the archive laid out in the order the boot reads it

**What the boot actually decodes.** Round 63 left the first visit's 300 MB
of archive windows as the open question, so the archive inflater was made
to report its own volume (`isaac_fast_tinfl`, counted at `common_exit:`;
the line prints with the fastpath census in every mode). To the 300th
frame it runs **36,571 calls, 22.7 MB in, 35.6 MB out, 287 streams
finished** -- nothing. The boot's archive traffic is not deflate: it is
the sound catalogue, 218 MB of PCM that `afterbirthp.a` holds as *stored*
pieces, memcpy'd and XORed with the ISAAC keystream (21.40). There is no
decode to make cheaper. What is left is where those bytes sit.

**The read order was already known -- from the archive, not a guess.** The
engine preloads its whole sound catalogue before the title screen, and it
does so in `sounds.xml` document order. That is checkable rather than
assumed: predict the 1 MiB window sequence by walking the catalogue in
document order over the entry table, simulate the host's 32-slot LRU per
file (21.55), and it reproduces the recorded boot trail exactly -- same
windows, same order, and the LRU accounts for every read the trail does
not contain. The trail is not an opaque recording; it is this sequence.

**And the shipped layout fights it.** In table order those samples are
scattered through the archive. Walking them in catalogue order steps
backwards 246 times, and 226 windows' worth of samples cost **457 window
fetches**: a window is fetched, evicted by the 31 that follow it, and
fetched again. `optimize.py layout <archive> <out>` (round 64, on
`archive.py entry_order` / `repack --order <file>`) rewrites the archive
with the catalogue's entries laid out first, in catalogue order. Payload
bytes, keys, sizes and mount checksums are untouched -- only the order of
the payloads, and so the table's offsets -- and the command verifies that
for every entry before it reports. The walk becomes one forward sweep:

| archive | fetches before | after | backward steps before / after |
|---|---|---|---|
| afterbirthp.a | 457 | **297** | 246 / 0 |
| afterbirth.a | 59 | **57** | 38 / 0 |
| sfx.a | 20 | **12** | 36 / 0 |

**The measured boot.** Rebuilt (`bundle.py build`; `page_assets.py`'s EDIT
FILE repack walks `ar.entries`, so it keeps the layout; `ship.py build
--trail`) and re-recorded, the whole boot to frame 600 fetches **305
windows, 303.1 MB, against 442 and 440 MB** -- 137 MB less on a first
visit, a third of it gone -- and every fetch is forward-adjacent, which is
what the reader Worker's read-ahead was built for. Measured as an A/B on
one machine and one module, the old archives against the laid-out ones,
each with its own shipped trail, first visit in a fresh profile at a 4x
CPU throttle:

| | windows | transferred | reader misses | reader waits | frame 300 |
|---|---|---|---|---|---|
| 200 Mbit/s, shipped layout | 442 | 440 MB | 136 | 1,908 ms | 34.0 s |
| 200 Mbit/s, laid out | **305** | **303.1 MB** | **8** | **412 ms** | 33.4 s |
| 50 Mbit/s, shipped layout | 442 | 440 MB | 142 | 14,918 ms | 80.5 s |
| 50 Mbit/s, laid out | **305** | **303.1 MB** | **9** | **3,904 ms** | 78.1 s |

Read that honestly: the **transfer** is a third smaller and the prefetch
now hits (136-142 misses become 8-9), but the *time* to the title screen
moves only 0.6-2.4 s, because round 55's trail already hid most of the
read latency behind the boot's own CPU work. What this round buys is
bandwidth -- a data cap, a CDN bill, a cleared cache -- not seconds. On
localhost frame 300 is unchanged (22.1 s at 4x), as it must be.

**What it cost.** Nothing at run time: the game reads the same bytes
through the same code. The engine's own checksum pass over the laid-out
archives (`ISAAC_ARCHIVE_VERIFY=1`, which un-skips the mount's per-entry
fold) reports no failure; the audio census is intact (198 buffer uploads,
12.3 MB of PCM over 1,500 explored frames); the page check, the EDIT FILE
menu (11 of 11), the floor sweep (21 of 21, 16 floors) and the save round
trip pass on the laid-out dist. The `archive.py` selftest covers `--order`
for versions 0 and 2 -- same keys, sizes and checksums, the listed paths'
offsets ascending from the first payload, the unlisted ones after in table
order -- and `tests/recomp-assets.test.js` pins the same through the CLI.

**What is left.** The 297 windows are 219 of samples plus ~78 the title
screen scatters over. Ordering those too needs the boot's real entry
access order rather than a catalogue -- an `ISAAC_FS_READ_TRACE` run names
every `fread` by file and offset, and the entry table turns an offset back
into an entry -- which would make the first visit a contiguous prefix of
the file that a range reader could fetch in a few large pieces instead of
300 window-sized ones.

### 21.79 Round 65: the same layout, from the boot's own trace

**The catalogue is not the whole boot.** Round 64 ordered `afterbirthp.a`
by `sounds.xml`, which is what the preload reads; the title screen reads
more -- art, xml, fonts, shaders -- and those entries stayed where they
were. The port already has a way to name them: `ISAAC_FS_READ_TRACE=packed`
logs every `fread` by file and offset (round 16 built it to tell an opened
archive from a read one), and the entry table turns an offset back into an
entry. One 300-frame headless boot writes 550 thousand `fread` lines for
`afterbirthp.a` alone; 499 thousand of them land inside an entry, and the
first touch of each gives the order the boot actually wants: **1,450
entries, 230 MB**, against the 1,218 the catalogue names.

**One order file, one command.** An order file may now name an entry by its
`h1-h2` tag as well as by path (`archive.py order_key`), because most of
what a trace finds has no recoverable name, and `optimize.py layout
--order <file>` takes that file instead of reading a catalogue. The same
verification runs: keys, sizes, mount checksums and payload bytes compared
per entry against the source. Simulated over the traced order, with the
host's 32 windows:

| archive | round 64 | round 65 | backward steps |
|---|---|---|---|
| afterbirthp.a | 258 | **231** | 39 -> 0 |
| afterbirth.a | 40 | **36** | 2 -> 0 |
| sfx.a | 12 | 12 | 0 -> 0 |
| graphics.a | 6 | **1** | 6 -> 0 |

**Measured.** A first visit now fetches **279 windows, 277.2 MB**; the
whole ladder from the layout that shipped before round 64, one machine, one
module, each layout with its own recorded trail, cold in a fresh profile at
a 4x CPU throttle:

| | windows | transferred | misses | waits | frame 300 @200 | frame 300 @50 |
|---|---|---|---|---|---|---|
| as shipped | 442 | 440 MB | 136 / 142 | 1.9 s / 14.9 s | 34.0 s | 80.5 s |
| round 64 (catalogue) | 305 | 303.1 MB | 8 / 9 | 0.4 s / 3.9 s | 33.4 s | 78.1 s |
| round 65 (trace) | **279** | **277.2 MB** | **2 / 2** | **0.3 s / 1.0 s** | **30.8 s** | **72.9 s** |

That is **163 MB and 37 % of the archive traffic**, the reader's misses
down from 136 to 2, and -3.2 s to the title screen on a 200 Mbit/s line,
-7.7 s on a 50 Mbit/s one. The remaining 279 windows are very nearly the
280 the payload needs: **the boot now reads a prefix of each archive, front
to back, and fetches every window exactly once**.

**Checks.** The engine's own per-entry checksum pass over the four
re-laid archives (`ISAAC_ARCHIVE_VERIFY=1`) is clean; the page, EDIT FILE
(11 of 11), the save round trip (15 of 15), the floor sweep (21 of 21) and
the edge drive (22 of 22) pass on the trace-ordered dist; the selftest and
`tests/recomp-assets.test.js` pin that an order file of tags lays an
archive out exactly as one of paths.

**What is left.** Every window is fetched once and in order, so the next
gain is not fewer bytes but fewer requests: a reader that recognises a
contiguous run and asks for it as one range would replace ~280 window
fetches with a handful, which is worth more on a connection with real
latency than on a 20 ms emulated one.

### 21.80 Round 66: the guest arena down to what the engine actually uses

**The number nobody had spent.** The wasm memory is committed the moment it
is created, so `-sINITIAL_MEMORY` is resident bytes on every machine that
opens the page -- 1,088 MiB of it, most of which is the guest arena. Round
24f had set that arena to 768 MiB because the old 192 ran out at 201 MB
live, and nothing since had asked what the engine really uses. It answers
itself: `host_shims_heap.c` has printed a high-water report at exit since
round 51, and it reads **350.1 MiB, at the same allocation number, after
900, 4,000 and 6,000 frames**. The catalogue preload is nearly all of it
and it happens at boot, so play adds nothing. The report even names the
fix: "Move ISAAC_GUEST_LIMIT_VA / ISAAC_HEAP_SIZE to PEAK plus deliberate
headroom, then GLOBAL_BASE and INITIAL_MEMORY follow from it."

**The map moved down by 0x10000000.** The arena is 512 MiB now, 162 MiB of
headroom over the measured peak, and everything above it followed: stack
top `0x21ff0000`, TEB `0x22000000`, shim tokens `0x23000000`, guest limit
and guard `0x23f00000`, host base `0x24000000`. `-sGLOBAL_BASE` is
603,979,776 in all three builds that link host code, and each build's
`-sINITIAL_MEMORY` came down by the same 256 MiB: the boot's from 1,088 MiB
to **832**.

**Two things had to move with it, and both said so out loud.** The
generated shim table bakes each token's address, so the selftest failed 8
checks ("every shim token resolves to its import") until `gen_shims.py`
regenerated it from the new `ISAAC_SHIM_BASE`. And the oracle harness puts
its own guest stack at a fixed address with the scratch pool above it --
both were above the new guest limit, so `oracle_replay.c`'s `ORACLE_ESP`
and `emu.py`'s `HEAP_BASE` moved down by the same amount. The lifted
objects rebuilt themselves: `build_boot.py` hashes every header the lifted
TUs include into the object fingerprint (round 15b), so editing
`RECOMP_GUEST_LIMIT` recompiles all of them rather than leaving a module
whose bound check still trusts the old limit.

**Measured.** The wasm memory is 832 MiB instead of 1,088 -- that figure is
exact, it is a link flag. What the operating system sees, on the shipping
page with a real GPU after three forced collections (`drive_memory.mjs`):
the renderer's working set is **977 MB and its private bytes 1,227 MB**,
against roughly 1.0 GB and 1.5 GB before, so the process gives back very
nearly the 256 MiB the arena lost. The GPU process is unchanged at 366 MB
(635 private) -- it holds textures, which this round does not touch.
Nothing about the frame changed: the floor sweep still reads 59-60 fps.

**Checks.** The selftest is back to 391 checks and 0 failures once the shim
table was regenerated; a 1,500-frame explored run with the engine's own
per-entry checksum pass on reports the arena at 512 MiB, a high-water mark
still of 350.1 MiB and **0 allocation failures** over 3.2 million
allocations, with the audio census intact (200 buffer uploads). The page,
the EDIT FILE menu (11 of 11), the save round trip (15 of 15), the floor
sweep (21 of 21) and the family (4,053) all pass.

**What is left.** The arena is committed because the engine's allocator
owns it; the remaining wasm memory above the host base is emscripten's own
heap and grows on demand. Below the arena the guest image and its 256 MiB
of host statics are what they are. The next memory question is the one the
GPU process asks, not this one.

### 21.81 Round 67: half the sound catalogue, where half is all there was

**Where the bytes are.** After rounds 64 and 65 a first visit fetched 277 MB,
and 218 of those were one thing: the WAV catalogue the engine preloads
before the title screen, stored uncompressed and XOR-scrambled, so nothing
downstream can squeeze it. The question is not how to pack it better. It is
whether the bytes say anything.

**They mostly do not.** A sample carries no information above its own
highest frequency, and a spectrum says where that is. Measured over all
1,553 catalogued WAVs (`r67_audio_census.py`, an FFT per sample): **976 of
them carry under 0.5 % of their energy above 11 kHz**, which is the Nyquist
of half their rate. Those bytes describe silence. The other 577 are real:
coin drops, chain breaks, splatter, up to 94 % of their energy above the
line.

Two other ideas measured worse and were dropped. Stereo whose channels are
bit-identical is a mono sample stored twice -- exactly **one** sample of
1,553. And a 32 kHz target saves 70 MB against 103, because 44,100 to
22,050 is an exact 2:1 decimation and 32 kHz is a resample.

**What was built.** `optimize.py halve-sfx <archive> <out>` walks the
catalogue, measures each sample's energy above the new Nyquist, and for the
ones under `--threshold` (0.5 % by default) filters and decimates by two --
127-tap Kaiser-windowed sinc, cutoff at 0.45 of the old Nyquist, the group
delay taken back out so a one-shot keeps its attack. 44,100 becomes 22,050
and 48,000 becomes 24,000; the bit depth and the channel count do not move,
and everything else passes through byte for byte.

| archive | samples halved | kept for treble | PCM before | after |
|---|---|---|---|---|
| afterbirthp.a | 710 | 430 | 218.6 MB | **132.1 MB** |
| afterbirth.a | 143 | 70 | 35.0 MB | **23.4 MB** |
| sfx.a | 124 | 74 | 11.9 MB | **7.6 MB** |

**What it cost, measured three ways.** Offline, against the original: the
spectrum below 90 % of the new Nyquist -- the band that is meant to survive
-- differs by a median of **1.06 %**; the length is identical to the sample;
the peak level moves by a median of 0.05 % and at worst 5.9 %. By
construction no sample lost more than 0.5 % of its energy. And in the
browser, on the real master output: the title window is **100 % of samples
above the RMS threshold**, and `drive_audio.mjs` exits 0 -- the music and
the menu sounds are there.

**What it bought.**

| | before | after |
|---|---|---|
| catalogue PCM | 265.5 MB | **163.1 MB** |
| shipping bundle | 733.8 MB | **619.3 MB** (31.96 % of the original instance) |
| dist, best encoding | 745.4 MB | **630.8 MB** |
| a first visit | 279 windows / 277.2 MB | **176 / 173.3 MB** |
| frame 300 at 200 Mbit/s | 30.8 s | **29.7 s** |
| frame 300 at 50 Mbit/s | 72.9 s | **55.4 s** |
| guest arena high-water | 350.1 MiB | **249.4 MiB** |

The 50 Mbit/s figure is the one that matters: 17.5 s off the wait for the
title screen, where rounds 64 and 65 together moved it 7.7. Those rounds
made the reads efficient; this one made them fewer, and bytes were what was
left. A first visit is now **173 MB against the 440 it was three rounds
ago**.

**Checks.** The engine's own per-entry checksum pass is clean, the arena
reports 0 allocation failures over 3.2 million allocations, and the page,
EDIT FILE (11 of 11), saves (15 of 15), floors (21 of 21), edges (22 of 22)
and the family (4,053) all pass. `tests/recomp-assets.test.js` pins the
behaviour on a synthetic pair: a 440 Hz tone is halved and keeps its length
and level, a 15 kHz tone is left byte for byte alone.

**What is left.** The arena's high-water mark fell to 249.4 MiB, so the 512
MiB round 66 gave it is now 262 MiB of headroom -- there is another 128 MiB
of committed wasm memory to hand back.

### 21.82 Round 68: the music at q2, and the textures the engine will not take

**The music.** Round 28 re-encoded the catalogue at Vorbis q3 and left it
there. q2 was measured on a sample at 24 % smaller, so it was applied the
way round 28 applies anything: from the *pristine* archives by key
(`optimize.py music --source`), so a track is encoded once from the
original and never from the q3 copy. 167 of 179 catalogued tracks were
replaced (the other 12 are 1-4 kbps layer intros already below q2), and
the shipping bundle went from 619.3 MB to **581.7 MB**. This is not on the
boot path -- the boot reads three windows of music -- so it buys total
download, not the wait for the title screen. Unlike round 67 it is a real
quality step rather than a measured-inaudible one, taken deliberately.

**The textures: a 20 % that was not there.** Round 28 ran oxipng with
every lossless reduction switched off, and this round asked why. On a
300-image sample the reductions are worth 20.0 % with the decoded RGBA
identical on every one -- so they were turned on, and 8,434 images were
rewritten, and the game did not boot:

```
Failed to load image '...bgblack.png' because the component depth is not 8-bit.
Failed to load image 'resources/gfx/shadow.png' because it has a unsupported number of channels (8)
TRAP in main @ 0x00931050: memory access out of bounds
```

The engine's own image loader takes **8-bit components in RGB or RGBA and
nothing else**. It refuses anything else, carries on with no surface, and
then walks off the end of memory -- which is why the failure arrives as a
trap in a function that has nothing to do with images. Every one of the
game's 10,158 shipped PNGs is 8-bit colour type 2 or 6, so the limit is
the engine's and the art never tests it.

With both rules enforced the only reduction left is dropping an alpha
channel from an image that is opaque everywhere: **8 images in 400, worth
0.00 %**. Round 28's conservative setting was right, and now the reason is
written down instead of assumed. `--reduce` stays as the guard that states
the two limits and refuses to break them; it is off by default and the
shipped pass is unchanged.

**The lesson.** Every offline check passed -- IHDR, mode, palette, gamma,
decoded RGBA, 8,434 of 8,434 -- and the artefact was still broken. What
caught it was rendering 1,500 frames and hashing them. An asset check that
does not run the engine is not a check.

**Measured.** With the music applied: bundle **581.7 MB**, dist transfer
**593.2 MB**, and a first visit is unchanged at 175 windows / 173.4 MB -- music is not
in it. Frame 300 reads 28.8 s at 200 Mbit/s and 54.0 s at 50, and the
reader now misses **one** window of 175. The explorer's frames hash identically to round
67 (9 of 9 kept frames, 1,501 presented), which they must -- nothing
visual changed.

**Checks.** The engine's per-entry checksum pass is clean with 0 allocation
failures; the browser's master output still carries the music (title window
100 % above the RMS threshold, `drive_audio.mjs` exit 0); page, EDIT FILE
11 of 11, saves 15 of 15, floors 21 of 21, edges 22 of 22, family 4,054.

### 21.83 Round 69: the arena follows the catalogue down

**A consequence, not an idea.** Round 66 sized the guest arena at 512 MiB
against a high-water mark of 350.1 MiB. Round 67 halved the sound
catalogue, and since the catalogue *is* the high-water mark, it fell to
**249.4 MiB** -- the same figure after 900, 1,500 and 6,000 frames, on
three separate runs. That left 262 MiB of slack in an arena that is
committed the moment the wasm memory is created, so it is resident bytes
on every machine that opens the page.

The arena is **384 MiB** now, 134 MiB of headroom over the measured peak,
and the map moved down by another 0x08000000: heap `0x00d00000..0x18d00000`,
stack top `0x19ff0000`, TEB `0x1a000000`, shims `0x1b000000`, guest limit
and guard `0x1bf00000`, host base `0x1c000000` (`-sGLOBAL_BASE` 469,762,048).
`-sINITIAL_MEMORY` follows: **704 MiB, from 832** -- and 1,088 two rounds
ago. `r69_shrink.py` reads the current values out of `isaac_host.h` rather
than carrying them, so the next move is one argument.

The two things round 66 learned still apply and were done again without
being rediscovered: the generated shim table bakes each token's address
(`gen_shims.py`), and the lifted objects rebuild themselves off
`build_boot.py`'s header fingerprint because `RECOMP_GUEST_LIMIT` moved.

**Measured.** The wasm memory is 704 MiB, exactly, because it is a link
flag. On the shipping page with a real GPU, after three forced collections:
the renderer's working set is **854 MB and its private bytes 1,088 MB**,
against 977 and 1,227 at 512 MiB and roughly 1.0 GB and 1.5 GB before round
66. Two rounds have taken 384 MiB of committed memory off every machine
that opens the page. The GPU process is unchanged at 379 MB -- it holds
textures.

**Checks.** Selftest 391 and 0 failures; a 1,500-frame explored run with
the engine's own per-entry checksum pass reports the arena at 384 MiB, the
same 249.4 MiB high-water mark and **0 allocation failures** over 3.2
million allocations; page, EDIT FILE 11 of 11, saves 15 of 15, floors 21 of
21 at 59-60 fps, family 4,054.

### 21.84 Round 70: the page carries the game -- two portable builds

**The shape of the problem.** The dist is a page plus 593 MB of files a
server hands out in slices. Two things people actually want are neither:
one file that plays with no network at all, and a page small enough to sit
on a static host with the payload beside it. `scripts/recomp/assets/portable.py`
builds both out of a finished dist, and neither touches the engine or the
module -- the page takes its bytes from `window.isaacPortable` instead of a
server (play.mjs).

**The seam.** A provider answers a read either with a **URL** (the chunked
build, so the reader Worker keeps fetching in parallel under JSPI) or with
**bytes** (the single file, which has them inline). `hooks.noReader` turns
the Worker off when there are no URLs to fetch; `hooks.preadBytes` is the
read the engine makes once it is running; `hooks.trail` hands over the boot
trail the dist would have shipped. With no provider every one of these is
null and the served page is exactly what it was.

**Two streams, because the payload is read two ways.** Part A is everything
read whole -- the module, the memory image, the six eagerly seeded archives,
the Lua -- and each piece is stored gzipped: 49 MB of module is 7 MB on the
wire. Part B is the four archives the engine reads as 1 MiB windows, stored
raw so a window costs a window. A window may not straddle a cut, so part B
is laid out on window boundaries and the padding (under 3 MB) is written as
zeroes.

**What the measurements changed.** Four things were built the obvious way
first and every one of them was wrong:

* **one chunk per window**: correct, and 559 files. The first frame took
  **23.2 s** because 49 MB of module arrived 1 MiB at a time, in order. The
  chunks are coarse now (a dozen by default) and a read gathers its pieces
  **six at a time**; a window inside a raw chunk is a `Range`, carried in
  the URL fragment where no server ever sees it. A host that answers 200
  instead of 206 is noticed on the first probe and never asked again.
* **gzipping everything**: the windowed archives went through the reader,
  which hands bytes straight to the engine. The page loaded and the game
  died. Compression is part A only.
* **one `<script>` for the inline payload**: 707.8 MB, which V8 will not
  compile -- its source limit is about 512 MB and it says nothing when it
  declines. The payload is spread over scripts of **48 MB**.
* **keying the provider by the dist path**: play.mjs strips `instance/`
  before it asks, so every lookup missed and fell through to a 404.

**Checks.** The single file plays (307 frames, the title screen reached);
the chunked build plays on a host that does ranges and on one that does
not. `tests/recomp-portable.test.js` pins the seam, the chunk arithmetic,
the key naming and the split payload.

### 21.85 Round 71: the premultiply four pixels at a time, and a measurement of the machine

**The change.** The engine premultiplies every texture it uploads: alpha
0xff leaves a pixel alone, alpha 0 zeroes it, anything between goes through
a 64 KB table. The table lookup is a gather no vector instruction helps
with, but the decision above it is testable four pixels at a time -- sprite
art is mostly solid or mostly empty. All opaque, skip sixteen bytes; all
clear, store a zero vector; anything else, the scalar loop for those four.
The same round took the inflater's per-copy counters back out: they had
answered their question (the ring path is never taken; the bytes are 57 MB
of literals and 4.8 M short matches) and an increment per literal is not
free.

**The census.** 53.6 M pixels over a boot, in 13.4 M groups of four:
**870,372 all opaque, 5,538,579 all clear, 6,995,209 mixed**. So 48% of
groups short-circuit and 52% pay for the test and then do the scalar work
anyway, against a premultiply that is 3.6% of the loading window. The
ceiling was always about 1.7%.

**And a lesson about measuring.** The first A/B said the SIMD build was
**12% slower** -- 19.0-19.2 s to frame 300 against 21.4-22.3 s -- which is
four times the size of the whole premultiply and should have been read as
impossible rather than as a result. Five `run_web.mjs` servers from earlier
rounds were still resident. With them gone, three runs of the same build:
**54.8, 54.5, 54.5 ms/frame at a 4x throttle, 23.6-24.4% idle**, against
54.6 and 54.0 with 23.8-24.2% before the change. The premultiply is a wash,
the counters coming out is a wash, and the first number was the machine.
The code stays because it is correct and costs nothing; the figure to
remember is that **a profile on this machine is only comparable against a
machine in the same state**, and `Get-CimInstance Win32_Process` before a
run is cheaper than a wrong conclusion.

### 21.86 Round 72: the images stored rather than deflated, and put back

**The idea.** A v2 archive entry is deflate pieces or stored bytes and the
packer picks whichever is smaller. A PNG is already deflate-compressed, so
it wins by a hair: 6,555 images in afterbirthp.a are 53.2 MB deflated
against 56.8 MB stored. That 3.5 MB of disk costs a full inflate pass over
56.5 MB on every boot, and the archive inflater is 22% of the loading
window. Storing them should trade bytes for time.

**Measured, and put back.** It bought **1.1%** of the inflater's work --
108.0 MB out, down to 106.8 -- while the bundle grew **3.7 MB**. tinfl's
own time did not move. The archives went back to what round 68 left; the
`store` verb stays in `optimize.py`, off by default, because it is correct
and someone will want to ask again on a different machine.

### 21.87 Round 73: the two screens before the title are settings

The build opens on a public-beta notice and a data-collection disclaimer,
each waiting on a confirm. Neither is a screen the port added: both are
flags the engine reads and writes itself, `AcceptedPublicBeta_v1.9.7.17`
and `AcceptedDataCollectionDisclaimer` in options.ini. The drivers have set
the first for rounds, which is how we knew where to look.

So a first visit gets an options.ini with both accepted and everything else
at the engine's own defaults -- **written only when the save store has
none**, so a returning player's settings, and every save beside them, are
left exactly as they are. Nothing is patched and no key is injected.

On the disclaimer: there is nothing here to consent to. The Steam and Epic
entry points are stubs that return without doing anything (`_EOS_Initialize@4`,
`_EOS_Platform_Create@4`, `_EOS_Shutdown@0`, `SteamInternal_SteamAPI_Init`
in the stub census) and no part of the host layer opens a socket.

### 21.88 Round 74: mods from the device, in the game's own list

**The trick is that there is no trick.** The game looks for mods in `mods/`
beside its executable and scans that directory itself, through the FS
shim's `FindFirstFileA` over its own table (host_shims_fs.c). Nothing in
that scan asks where the bytes came from, so a mod seeded before `main` is
a mod on disk as far as the engine is concerned. `isaac_fs_seed` creates
the parent directories on the way, which is the part that makes it work.
Confirmed on the first run: `LOADED MOD //mods/ import mod/content/`, from
the engine's own log.

**The button is a mod.** `mods/ import mod/` holds one file, a metadata.xml,
and the game lists it like any other -- the mods screen prints the folder
name, which is why the folder is named the way the row should read, and why
it begins with a space: the list is sorted and the import row stays at the
top however many mods are installed. Enter on a row toggles it, which makes
the engine write a `disable.it` into that folder. That write comes back to
the page through the FS shim's persist hook (round 31), where it is claimed
rather than stored, and the page opens its own menu. No patch, no menu
surgery, and the key is the engine's own.

**The store is a separate database.** Mods live in `isaac-mods`; saves live
in `isaac-saves` and the two never meet. Files the game writes under
`mods/` -- the `disable.it` that marks a mod off -- are routed to the mods
database too, so the save store stays saves and a mod that is later removed
does not leave a phantom folder behind at the next boot. Importing,
removing or resetting mods cannot reach a save file at all.

**Reading what was chosen.** A .zip, through `DecompressionStream`, or a
folder through the directory picker; the bytes are copied into the store,
so deleting the file afterwards changes nothing. A download is
`ModName/metadata.xml` rather than `metadata.xml`, so single roots are
peeled off until the metadata is at the top -- a mod seeded one level too
deep simply never loads, silently. A mod with no metadata.xml gets one
written for it. **RAR and 7z are named and refused**: nothing in a browser
can open either, and the message says to extract and choose the folder.

**Every path is built here.** A path out of an archive is not trusted: `..`,
a drive letter, an empty segment or a control character is dropped rather
than repaired, and the seed builds `mods/<id>/<rel>` out of an id and a
relative name that have both already been checked. `mods/` and
`Documents/My Games/` are neighbours in one key space and `../..` twice
over reaches a save file, so this is the check that matters.

**Two other things this round.** The zip reader that lived inside play.mjs
is `zip.mjs` now, imported by both menus rather than written twice. And the
portable builds carry six modules instead of four, in dependency order --
a blob URL resolves no relative import, so each module is built after
everything it imports.

**Checks.** `drive_mods.mjs` plays the whole thing through the engine --
title, file select, Tab for the mods list, Enter on the import row, a zip
built by the driver through the picker, a reload, and the engine's own
`LOADED MOD` line for the imported mod -- then removes it again, with a
witness in the save store checked byte for byte before and after: **17 of
17**. `tests/recomp-mods.test.js` pins the path rules, the peeling, the
metadata reader and the two databases: 12 tests.

### 21.89 Round 75: a Huffman table per kilobyte, on both sides

**Where the loading window actually goes.** At a 4x throttle, frames 1-300:
43.0% host C, 23.6% idle, 18.4% lifted guest. Inside the host C, one function:
`isaac_fast_tinfl` at **23.3%**, with `isaac_fast_inflate_ring` (the engine's
own zlib, decoding PNGs) at 7.2% behind it. Round 72 tried to give the archive
inflater less to do and bought 1.1%. This round asks a different question: not
how much it decodes, but what it is spending the time on.

**The format's own shape is the answer.** A version-2 entry is cut into
0x400-byte blocks and the packer full-flushes each one, because the engine's
reader has a 0x400-byte circular output window. A full flush ends the deflate
block, so **every kilobyte of the archive carries its own dynamic Huffman
header**, and every kilobyte costs the decoder a table build.

Measured, on 20.1 MB decoded out of afterbirthp.a, decoding per entry the way
the engine does:

| encoding | size | decode |
|---|---|---|
| as packed (dynamic, flushed per 1 KiB) | 16.79 MB | 189.7 MB/s |
| static Huffman, same flushing | 17.92 MB (+6.75%) | **862.7 MB/s** |
| one stream, no flushes at all | 15.57 MB | 278.2 MB/s |

Reading and building tables is **77.6%** of the inflate. The third row is the
control, and the one that decides the shape of the fix: dropping every flush
removes almost every table and is still three times slower than keeping the
flushes and making the tables free. It also cannot be done -- the reader wants
its 0x400 window -- so the interesting column was never the size one.

**Two halves, and the first one alone would have been a lie.** zlib keeps the
fixed tables in `lenfix`/`distfix` and a static block costs it nothing, which is
what the table above measures. **miniz does not.** It fills the code-size arrays
with the fixed lengths and then runs the same table build a dynamic block runs,
so a static block would have saved the header and paid for the tables anyway.
The engine's inflater is miniz, so the packer change on its own would have been
worth a fraction of what the bench promised.

So both halves landed together:

* `optimize.py huffman <in> <out>` re-encodes each block whichever way is
  wanted. `--cost N` is how many bytes a block may grow to stop carrying a
  table; the default is no limit. The format's two rules are checked per block
  as they always were: a piece is at most 0x7ff bytes, and a non-final piece is
  never exactly 0x400 (which is how the reader is told the rest is stored).
  Entries already in stored mode are passed through untouched, and the table
  order is preserved, so this runs after `layout` and does not undo round 64.
* `isaac_fast_tinfl` keeps the tables the first static block builds and copies
  them into every one after it. Nothing is precomputed by hand: the tables in
  use are the tables the decoder itself produced, which is the only way to be
  sure they are the right ones. Setting `m_type` to -1 after the copy is what
  skips the build, because that is the state the build loop exits in anyway.

**What it cost in bytes.** Re-encoding at level 9 is itself worth something,
because the entries that were passed through came from the game's own packer:
afterbirthp.a is 5.38 MB smaller with dynamic blocks throughout. Static Huffman
spends that back and a little more.

| | afterbirth.a | afterbirthp.a | the bundle |
|---|---|---|---|
| as it shipped | 65.6 MB | 331.7 MB | 581.7 MB |
| dynamic, re-encoded (`--cost 0`) | 64.0 | 326.3 | 574.7 |
| a 128-byte budget | 64.8 | 330.8 | 580.1 |
| static wherever it fits | 65.8 | 336.9 | **587.3 MB** |

Static everywhere costs **+5.42 MB** against what shipped, which is
0.98% of the download and is paid once; the decode is paid on every
load, on the slowest machine the page will ever open on. That is the trade
this round takes.

**Measured.** Three runs of the loading window at a 4x throttle, on a machine
with nothing else on it: **45.1, 45.1, 45.2 ms/frame**, against 54.8, 54.5 and
54.5 before. `isaac_fast_tinfl` falls from **23.3% to 9.3-9.5%** of the profile
and idle rises from 23.6% to 28.1-30.1%, which is the shape of a loader that has
stopped being the thing holding the frame up. Time to frame 300 goes 19.0 s to
**13.6 s**.

The census says why: a 901-frame explored run decodes **220,223 static blocks,
220,222 of which took the kept tables** (the one that did not is the first, which
built them). The same run before the change saw 23,279 static blocks, because
zlib emits a fixed block on its own where one is smaller.

**Checks.** The 901-frame explored run with the engine's own per-entry
checksum pass reports 0 failures and **frame hashes identical to the baseline**,
every frame, so nothing about what is drawn moved. Selftest 391 and 0 failures.
Page ok, saves 15 of 15, EDIT FILE 11 of 11, mods 17 of 17,
floors 21 of 21 over 16 floors. The cold boot, against round 72 on the same
machine with the same driver: uncapped, first frame 1,965 -> **1,648 ms** and
frame 300 21,280 -> **16,553 ms**; at 50 Mbit/s, frame 300 55,742 -> **54,589
ms**, so the 5.4 MB the archives gained is paid back inside the first visit even
on a capped link, and costs nothing on any visit after it. Windows 174 (172 MB)
-> 177 (175.9 MB).

### 21.90 Round 76: the mods menu is the game's, and the flag is the page's

**What was broken.** Round 74 put an IMPORT MOD row in the game's own mods list
and it worked. Turning a mod *off* did not. The engine greys the row and writes
a `disable.it` into the mod's folder, and at the next start it loads the mod
anyway.

It took the fs layer's own trace to see why, and two wrong theories on the way:

* the scan does hand the file back. `scan 'c:/isaac/mods/toggleprobe' -> 3
  entries: main.lua metadata.xml disable.it`, and the mod loaded regardless.
* the engine looks in two places. `GetFileAttributesA('//mods/')` finds the
  resource layer's mods root, and `FindFirstFileA('./Documents/My Games/Binding
  of Isaac Repentance+//mods')` **missed** -- that is the mod manager, looking
  somewhere the page had never seeded. Seeding both roots made the manager see
  the file. The mod still loaded.

Nothing else is written when a mod is toggled: the whole save store is identical
across the keypress. So `disable.it` is written and never read, and no
arrangement of files can make the engine honour it.

**So the page keeps the flag.** A `disable.it` write is read for what it means,
recorded in the mods index, and the file itself is not kept. A mod that is off is
simply not seeded, which the engine cannot argue with, and the write that turns
it off is still the engine's own menu doing the engine's own thing.

**And the menu is drawn like the game's.** `menu_overlay.mjs` grew a
`createPaperMenu`: the same prompt paper out of the save-select sheet, the same
Team Meat font, the same cursor and menu sounds the EDIT FILE menu has used since
round 52, with a list that scrolls, a note down the right-hand side, a search
line and a footer of hints. The half of that file that loads the art is now
`menuAssets` and both menus share it. The only DOM left in the mods menu is two
`<input type=file>` elements, because a file picker cannot be opened from a
canvas.

Round 76 also: a mod that is already installed is refused rather than merged
over, and the page stopped rewriting the address bar. `history.replaceState` had
been putting `?ISAAC_YIELD=1` into the URL on every visit; the default reaches
the pipeline as `hooks.params` now and a real query still wins.

**Checks.** `drive_mods.mjs` **20 of 20** through the engine: the row, the menu,
the import, the duplicate refused, the reload, the engine's own `LOADED MOD`
line, the toggle, a reload that does *not* load it, the removal, and a witness in
the save store checked byte for byte throughout.

### 21.91 Round 77: the payload stops announcing what it is

**The chunks.** A chunked build put 33 files on a CDN with a KAGE archive's magic
at the front of most of them. Each stream is XORed with a seekable keystream now
-- `key[pos & 255] ^ (pos >> 8)` -- so a chunk is noise. Seekable is the whole
requirement: a window is fetched as a byte range and has to be put back from
wherever it lands, which is why the position rides in the URL fragment beside the
range (`#r=a-b@pos`). This is obscurity and not secrecy: the key is in the page,
because the page has to read its own payload.

**The bug that cost an hour.** The reader Worker takes the key in a message, and
the first version called the field `key` -- which is what a job message already
calls the cache key of the window it wants. Every read was greeted as a new
keystream and answered with nothing, and the game stopped at its first frame. It
is `xorKey` now, and a test says so.

**The page.** The inlined modules are minified: 269.9 KB to 221.1 KB. The
minifier walks the source rather than pattern-matching it, because `//` inside a
string is not a comment, a `/` after a value is division and after an operator is
a regular expression, and a template literal may contain any of it. Nothing is
renamed: a mangler that does not parse JavaScript is a bug waiting for a template
literal.

**And it says where it is.** Three dozen files is a progress bar nobody can read,
so the provider counts the chunks it has and the status line reads `loading...
chunk 7 of 33`.

`--plain` turns both off.

### 21.92 Round 77b: a mod browser, on the same CDN

`scripts/recomp/assets/modpack.py` turns a folder of mods into a catalogue and
the parts that back it: `catalogue.json` beside `m/<id>.<n>.bin`, every part
under jsDelivr's 20 MB ceiling. Nothing is in the build. The page fetches the
catalogue when the browser is opened and a mod's parts only when it is asked for,
joins them, unzips the result and stores it exactly as an imported zip.

On a real folder of 33 mods: **32 mods, 89.8 MB in 34 parts, largest part
19.00 MB.** The 33rd is a 371 MB music pack, left out and reported, because the
page can only seed 96 MB into the guest arena and a mod it could never load has
no business on a CDN.

### 21.93 Rounds 78-79: the chunked build stops trusting the CDN

Everything here is a thing that only broke once the build was served from
jsDelivr rather than from a local static server, which is why none of it showed
up in the drivers.

**The menus opened onto nothing.** `ship.py` keeps `page-assets/` out of
`instance_index.json` on purpose -- the pipeline must not seed the page's own
files into the guest file system -- and `portable.py`'s `plan()` was built from
that index. So a chunked build shipped no `menu.json`, no font, no cursor:
`readAsset` returned null, `menuAssets.load()` threw, and IMPORT MOD did nothing
at all, silently. `plan()` now appends `instance/page-assets/*` itself.

**Byte ranges are not a thing a host can be assumed to honour.** The old probe
asked for two bytes and accepted a 206. jsDelivr answers 206 with a plausible
`Content-Range`, then returns bytes from the wrong offset -- four bytes early at
1 MiB, unrelated data at 5 MiB -- and claims a total 37 bytes over the file.
A prefix-length check passes that. The probe now reads 64 bytes and checks the
length *and* the `Content-Range` total against the length the page computes for
that chunk; on a failure `hooks.noReader` stays set, the reader Worker never
starts, and every window is a whole GET. In whole-chunk mode the window cache
stops evicting: dropping a 19 MB piece means fetching it again the moment a
window lands in it, which was the freeze. `--part-mib` sizes the pieces for a
host with a per-file limit; at 1 the chunk *is* the window, so no range is ever
needed at the price of a lot of files.

**The loading bar counts chunks.** The three byte stages are what a served dist
fetches; a chunked build fetches the same bytes out of three dozen files and
none of that showed anywhere but a line of text. There is a `chunks` row now,
hidden on a build with none, and the overall bar takes whichever of bytes and
chunks is further along -- early on the chunk count is the honest one, because a
byte total is not known until the piece holding it has arrived.

**Escape stays in fullscreen.** It is the game's own back key and the browser
takes it to leave fullscreen. `navigator.keyboard.lock(['Escape'])` is the
sanctioned way to ask for it back, taken on `fullscreenchange` and released on
exit. A *held* Escape still leaves, so the way out is still there. Chrome and
Edge have it; elsewhere nothing changes.

**And the mods menu no longer calls itself open before it has rows.** The art is
fetched, on a served page that takes long enough for a key to arrive in the gap,
and that keypress found an empty list and did nothing. `open()` sets
`st.open` after `load()` resolves, and `onKey` swallows keys until there is a
model rather than guessing.

Verified on the chunked build: saves 15/15 (unlocks, stats and the bestiary
round trip), mods 20/20, EDIT FILE 11/11.

### 21.94 Round 80: a rebuild that does not invalidate the upload

The keystream seed was `isaac-portable/<a_len>/<b_len>/<chunks>`. Round 78 added
half a megabyte of page assets to part A, which changed `a_len`, which changed
the key, which re-scrambled **part B as well**: 29 chunks and 559 MB of
identical plaintext, different bytes, all of it to upload again.

`chunks --key-b64` takes the key as an argument and `--key-of <index.html>`
reads it out of an earlier build's page. Rebuilt against the deployed page's
key, the 29 windowed chunks come out byte for byte what is already on the host
and only the four part-A chunks have to be sent. The key is obfuscation, not a
cipher -- it stops a chunk on a CDN from announcing what it is -- so reusing one
costs nothing.

### 21.95 Round 81: the row nobody could reach, and the byte that stopped the unlocks

**The mod browser was unreachable.** `createModsMenu` offers its MOD BROWSER row
only when it has a catalogue base, which it reads from `?catalogue=` or
`window.isaacModCatalogue`. Nothing ever set either on a built page, so round
77b's browser -- the catalogue, the parts, the search, the install -- shipped
twice and could not be opened. `portable.py --catalogue URL` writes the base
into the page (both shapes), and `--key-of` aside, that is the whole fix.

What let it ship was the driver: `drive_mods.mjs` only ever went through the
file picker. It serves a catalogue of its own now -- `page.route` answers
`catalogue.json` and `m/<id>.<n>.bin` for a two-part mod -- walks the cursor to
the row by name, opens it, types a search, and installs. `state()` grew `rows`,
`title`, `search` and `current` for that, as labels rather than rows: a driver
can see what the menu shows but has to press the key a player would.

**Achievements with mods on.** The gate, found rather than remembered:

    0x00929a20  TryUnlock:  cmp byte ptr [esi + 1], 0    ; PGD+1: readonly
                            jne <exit>
                            ...
                            mov byte ptr [edi + esi + 0x38], 1   ; the unlock

`PGD+1` is the whole thing. Past it, the next act is the store that records the
unlock; the checks after that (`0x009595e0`, `[esi+2]`) govern the Steam call and
the notification. One function writes that byte -- `SetReadOnly` at
`0x009299e0`, four call sites, logging `Setting PersistentGameData ReadOnly to
%s` -- and the game reaches it through its own flag at `Game+0x15` while mods
are loaded. The block patch at `0x009299e4` reads that function's argument as
false. Nothing else about the save changes and the engine still logs what it
did, which is the witness the mods driver watches: the line can only say False.

**And three things about the page.** The FPS readout is off at every load (it
was remembered in `localStorage`, so one press of N left it over the game for
good; N still flips it for the visit). The mods menu's key hints are gone. And
the menu reloads the page when it is closed with a mod that arrived during this
visit: the engine scans `mods/` once, before `main`, so another boot is the only
way into its own list.

### 21.96 Round 82: the row that cost the achievements, and two quiet failures

Round 81 took the engine's unlock gate out and the achievement indicator stayed
on. The reason was upstream of the gate: `mods/ import mod/` is a mod, and a mod
loaded is a modded run. The row existed only to give the player something to
press Enter on, and it was quietly making every run a modded one -- on a save
with nothing installed.

It is seeded only once the player has a mod of their own, by which point the run
is modded anyway. With none, the way in is the EDIT FILE menu: **MODS** between
DELETE FILE and BACK, on the save-select screen. That menu is the page's own and
costs no mod. Both drivers walk that menu by row name now (`rows()`/`current()`
on the menu, labels rather than rows) because counting presses walked into the
new entry -- drive_saves opened the mods menu instead of BACK and every key after
it went to the wrong place.

**EnableMods=0 was the quietest failure this port has had.** Round 76 made it the
default, options are written once and then kept, so a browser that visited since
carried it: the mod imports, the page seeds it, the engine lists it, and the mod
manager never runs it. Nothing errors, nothing logs, the mod simply does nothing.
Installing a mod now turns it on once (`enableModsInOptions`, through the menu's
`onInstalled`), because installing one is choosing to have mods on; the game's
own TAB still wins afterwards.

**A download says how far along it is.** `onProgress` fired once a part had
finished, so a mod that is one 19 MB part showed nothing until it arrived -- a
menu that looks hung. The parts are read as streams and the progress is in bytes
against the size the catalogue already carries, shown on the row itself as a
percentage.

**And the loading screen is the game's.** Black, one segmented bar in the menu's
bone white with square corners, one line in caps. The five named stages, their
byte counts and the machine string were instruments; they are under `?stats=1`
with the rest of them.

### 21.97 Round 83: one fetch failed and the run ended

    lazy pread FAILED for resources/packed/videos.a at 84934656+587470:
    the reader had no bytes

That window is the last 587,470 bytes of `b28.bin`, the final chunk, and the host
answers exactly that range correctly when asked again -- 206, the right length,
`bytes 1048576-1636045/1636046`. So one fetch failed transiently: a rate limit, a
dropped connection, a 5xx. The Worker's answer to any failure was to post no
buffer, `failRead` returns -1 to the engine, and -1 from a pread is a trap.

Three attempts with a short backoff, and then the same window taken from the
chunk fetched whole, which carries no Range and so cannot be refused for one. The
cost of a blip is a moment instead of the run.

Reading that path turned up a second, quieter one. The provider's `ranged()`
treated **any** answer that was not the window as if it were the whole chunk:
sliced it, and cached it under the chunk's key. For a host that ignores Range
(200, the chunk's length) that is right. For one that answers 206 with the wrong
bytes it returns nothing -- and leaves a short buffer in the cache, so every
later window in that chunk comes back empty too. It takes that route only on a
200 of exactly the chunk's length now, and otherwise drops the answer and
re-fetches the chunk.

And the loading screen, twice over. The grid of five named stages was being put
back by the chunk-counting hook (`stagesEl.hidden = false`), so the one build
that is not a development build was the one showing every instrument. The bar
itself was drawn in pips, which reads as a barcode rather than as a bar: it is a
2px hairline with a solid fill now, over black, with one line in caps under it.

### 21.98 Round 84: the host's ranges are wrong, and not always the same way

    lazy pread FAILED for resources/packed/afterbirthp.a at 227540992+1048576

Round 83 read that as a blip and gave the reader three tries and a whole-chunk
fallback. It was not a blip. That window is bytes 17825792..18874367 of
`b14.bin`; fetched **whole**, `b14.bin` on jsDelivr is byte for byte what was
uploaded, sha256 identical. Fetched as a **range**, the same file comes back with
different bytes from the very first one, and the host calls it 19,922,984 bytes
when it is 19,922,944.

Every chunk lies, by a different amount -- +37, +36, +40, +13, +5 -- and not
consistently: `b28.bin` answered with the right total an hour before it answered
with a wrong one. That is why round 78's probe let ranges through here. It asks
once, about one chunk, and a wrong answer is not guaranteed.

So the probe asks about four chunks spread across the stream and every one has to
be right, and each window's URL carries the chunk's own length in its fragment
(`#r=a-b@pos!len`) so the Worker and the provider can both check the
`Content-Range` total against something. A mismatch is refused and the window
comes from the chunk fetched whole, which is always correct on this host.

**Mods, three ways.** A browser that already had a mod when round 82 landed never
went through the install path, so its `EnableMods=0` was still there and the mod
it had was seeded, listed and never run; the page now turns mods on at the first
boot that finds a mod in the store, once per browser (`isaac-mods-enabled-once`),
so turning them off in the game afterwards still sticks.

The menu is one row for importing, not two: a file chooser cannot pick a folder
and a folder chooser cannot pick a file, so IMPORT MOD opens the file chooser and
a folder or an archive **dropped on the window** goes the same way
(`entriesFromDrop` walks a dropped directory). What is installed is the game's
own screen's business and is not listed here any more; REMOVE MOD is where the
list went.

And the sheet's right corner is torn further in than its left, so a note or a
counter right-aligned to `SIDE` sat on the tear -- the browser's `3/33` was drawn
outside the paper altogether. `RIGHT` is the margin that side keeps; the counter
is gone, because the line at the bottom already says how long the list is.

### 21.99 Round 85: two characters, and no mod had ever run

Every mod in this port was inert. Not a sprite, not a sound, not a line of Lua --
and it had been that way since mods were added in round 74. Rounds 82 and 84
each found something real on the way to it (the import row was itself a mod;
EnableMods was off) and neither was the reason.

The engine's own words, once it was asked to speak:

    [isaac][mods] enabled=1  EnableMods(Game+0x2a38d)=1
    [isaac][kage] asked for '//mods/cat-coin/main.lua'
    [isaac][kage] main.lua exists? 0

`sub_00a17180` is the resolver every mod file goes through -- metadata, main.lua,
every sprite and sound. It answers from an in-memory index of strings and touches
no filesystem at all, which is why the FS trace showed the mod's whole tree being
scanned and not one of its files ever opened. And this port builds a mod's path
off an empty base, so it asked for `//mods/<id>/...` while the index holds
`mods/<id>/...`. Two characters. The loader asked whether there was a main.lua,
was told no, and skipped every mod whole:

    while (ESI && MEMR8(ESI) == (uint8_t)0x2fu) ESI = (uint32_t)(ESI + 1u);

Past that, one thing remained. The engine ran the mod and Lua answered `cannot
open //mods/cat-coin/main.lua: No such file or directory`: Lua opens through its
own libc, which reads MEMFS, and only the game's own `resources/scripts/*` were
ever copied there. Every `.lua` a mod carries goes to MEMFS now, beside them.

Measured on a real run, cat coin installed through the menu:

    Running Lua Script: //mods/cat-coin/main.lua
    fopen('mods/cat-coin/resources/gfx/items/pick ups/pickup_002_coin.png') -> hit
    fopen('mods/cat-coin/resources/sfx/feedback/penny drop 1.wav')          -> hit
    19 files read out of the mod, against 0 before

Three things were tried and thrown away on the way, and are worth naming so they
are not tried again: a fallback that asked the FS layer whenever KAGE missed (it
worked, and is a host call on a hot path for a problem that was two characters
wide); seeding a mod's `resources/` over the instance's own namespace (the
archive index is consulted first, so it never won, and it would leave a removed
mod's art behind); and mounting each mod directory into KAGE (`0x00a179c0` is a
plain cdecl `mount(path, 0, 0)`, so it is callable -- and unnecessary, because
the paths resolve once they are spelled the way the index holds them).

### 21.100 Round 86: the two characters the template ate

Two people reported the same line and I checked it twice and found nothing:

    Uncaught SyntaxError: Unexpected token 'if'
    reader Worker failed (...); synchronous reads from here

The reader Worker's whole source is a template literal in `boot_web.mjs`, so
what the Worker receives is the **cooked** value, and cooking eats backslashes:
`\/` becomes `/`, `\d` becomes `d`, `\s` becomes `s`. Round 84's Content-Range
check was written `/\/(\d+)\s*$/` and arrives at the Worker as

    const m = //(d+)s*$/.exec(r.headers.get('content-range') || '');
    if (m && Number(m[1]) !== chunkBytes) { ... }

-- a line comment that swallows its own assignment. The parser reaches the next
line, finds `if` where the initialiser should be, and the Worker never starts.

Both times I checked it I read the template's **source text**, where the
backslashes are still there, and it parsed, so I concluded the report could not
be reproduced. It reproduces the moment the template is cooked first:

    raw 5222 -> cooked 5219
    COOKED FAILS: Unexpected token 'if'

The cost was two rounds of every read going the synchronous way -- and round
83's retries live inside that Worker, so the fix for the `lazy pread FAILED`
traps had never run either. The check now reads the total by hand
(`lastIndexOf('/')`, `slice`), because a regex here needs backslashes.

The template already carried a comment saying no backticks may appear inside it.
A backtick at least fails the build. A backslash fails nothing: it is a Worker
that does not parse, on a path that degrades quietly to a slower one. The
invariant is now a test that cooks the template and parses the result as the
classic script a Worker is handed, and asserts the template holds no backslash
at all -- the class, not the instance.

### 21.101 Round 86b: the functions only a mod ever calls

A mod installed through the menu ran its `main.lua` and the module stopped:

    [isaac][TRAP] indirect call to 0x0086fc60 from 0x00898e8b resolves to
                  neither a host shim nor a lifted function. It is inside the
                  image, so the function was not lifted.
    [isaac] reason: unresolved indirect call
    TRAP in main @ 0x00931050: Program terminated with exit(1)

0x0086fc60 is two instructions -- `mov eax, dword ptr [0xc71678]; ret` -- an
inline getter MSVC emitted out of line only because somebody took its address.
**Nothing calls it.** Its only two references are immediates:
`push 0x86fc60` at 0x0086dd24, and `mov dword ptr [eax], 0x86fc60` at
0x00895ce6, which stores it into the Lua userdata that the binding at
0x00898e70 later calls through (`call [0xb183b0]; mov eax,[eax]; call eax`).
With no call to find it, Ghidra never made a function of it, so it was in none
of the inventories the lifter reads, so it was never lifted. The game itself
never needs it. A mod does, and that is why 85 rounds went by without it.

The class matters more than the instance, so the census is by shape rather than
by address. `scripts/recomp/lift/orphan_starts.py` asks the PE index for every
address escape (`kind = 'addr'`) that lands in .text -- 5,029 distinct targets
-- and makes each earn its place: an instruction the index decoded, 16-byte
aligned, preceded by the int3 padding that separates functions here, and inside
no function the lift already knows.

That last test is load-bearing rather than tidy. `func_starts` feeds
`discover_body`: a jump to a known start is lifted as a tail call instead of
being absorbed, so a start invented INSIDE an existing function would change
how that function is lifted. It is *strictly* inside, because a function that
merely BEGINS at the candidate is evidence for it, not against -- the first
attempt got that backwards and reported zero candidates, including the one
address already known to be real.

    address escapes     : 5029 distinct targets in .text
      already a start   : 2931
      not 16-aligned    : 1544
      not an instruction: 14
      no int3 before it : 26
      inside a function : 397
    orphan functions    : 117

All 117 are one-line accessors -- `mov eax,[ecx+disp]; ret`,
`lea eax,[ecx+disp]; ret`, `fld [ecx+disp]; ret`, `inc/dec [ecx+disp]; ret`,
two `jmp` thunks -- and all 117 are functions the index recovered bounds for on
its own. The lift goes from 26,241 starts to 26,358, and 23,238 lifted
functions to 23,353; the dispatcher's index from 23,245 entries to 23,362.

One thing broke on the way and is worth recording, because it will happen
again to anyone who adds starts: the new entries repartitioned the TUs, and
0xa2b5c7 gained an `L_00a2b5c7: ;` label between `RECOMP_VA(0xa2b5c7u);` and
the body -- so round 24e's block patch, which anchored on that RECOMP_VA line,
stopped matching and the build refused to continue. Anchoring a block patch on
a RECOMP_VA line is anchoring on the one line a label can appear in front of.
It anchors on the sbb sequence itself now.

Verified with the mod that found it (The Specialist for Good Items, 59 files,
installed through the page's own import): `Running Lua Script:
//mods/specialistforgooditems/main.lua`, then the intro cutscene, then
`Menu Bestiary Init` -- the title menu, where before it exited at the Lua line.
Family 4105 pass / 0 fail, mods 37/37, saves 15/15, EDIT FILE 11/11.

### 21.102 Round 86c: all thirty-two of them, and the store that could not be rebuilt

Rounds 85 and 86b each found a reason mods did not work, and each was signed
off on a single mod. A sample of one is what let 86b ship after 85: no mod path
had ever resolved, and then one mod reached a function nothing had ever lifted
-- neither bug would have been caught by the other's mod. So the question stops
being "does this mod work" and becomes "do they all".

`scripts/recomp/web/drive_modpack.mjs` walks the whole catalogue. Each mod gets
its own browser context, is installed through the page's own file input, and
then: reload, boot, Enter until the engine's own log says a run started, walk
and fire, sampling the host's frame counter. What counts as working is what the
ENGINE says, never the page:

  * its directory in the engine's own `LOADED MOD //mods/<dir>/` line,
  * its `main.lua` in the engine's own `Running Lua Script` line, when it ships
    one -- the zip's central directory says whether it does,
  * at least one of the mod's OWN files opened, under `ISAAC_FS_TRACE=1`,
  * no `[odsa] [ERROR]` naming it, no trap, no page error, and a run started,
  * a frame rate that does not fall away from a no-mod baseline.

Some mods only redraw one thing, and that thing's art is only read when it is on
the screen, so a starting room proves nothing about them. The driver puts the
thing there through the game's own debug console. Two details were load-bearing
and both cost a run to find. The console is off unless `options.ini` says
`EnableDebugConsole=1`, and that file has to be seeded on a page that is NOT the
game -- on the game page an engine is already booting and persists its own
options over the seeded one. And a key pressed for less than a frame is a key
the engine never sees: it samples input once a tick, so down-and-up inside one
tick is nothing at all. `hold()` and a 60 ms-per-character typist, as
drive_floors.mjs already had.

The entity numbers have to be right for the same reason. `spawn 5.60` for a
haunted chest spawns something else and the mod's file is never asked for --
which reads exactly like a mod that does not work. They come out of the mod's
own file names: `slot_004_beggar.png` is SLOT variant 4, the haunted chest is
pickup 58, the hell game is slot 15.

The result, over the 32 mods in the catalogue:

    engine loaded    32 / 32
    main.lua ran     17 / 17 that ship one
    own file read    28 / 28 that ship a resource   (the other four are Lua only)
    traps, errors     0,  0
    fps              baseline 60.0, mods 59.7 - 60.3

60 fps is the cap, so equal-at-the-cap proves nothing about cost. Under a 4x CPU
throttle, where the cap is gone: baseline **52.9**, the seven heaviest mods
**51.2 - 53.9** (median 52.5). Nothing measurable.

**The store that could not be rebuilt.** The first version of this driver polled
IndexedDB to see whether a mod had landed, with `indexedDB.open('isaac-mods')`
-- no version. That CREATES the database, empty, at version 1. The page's own
`open(name, 1)` then sees a current version, never fires `onupgradeneeded`,
never makes its stores, and every import from then on fails with

    [mods] import failed: Failed to execute 'transaction' on 'IDBDatabase':
           One of the specified object stores was not found.

for the life of the origin, with nothing to do about it but clear site data. An
interrupted upgrade leaves the same wreckage, and the save database has the same
shape -- there the symptom is worse, because saves simply stop persisting and
nothing says so. All three openers now check what they actually got and reopen
one version up to build what is missing. The first open names no version on
purpose: asking for 1 fails outright on a database that has already been
repaired to 2. `drive_modpack.mjs --breakdb=1` poisons the origin exactly the
way the driver did, before any page script runs; the import has to succeed
anyway, and it does.
