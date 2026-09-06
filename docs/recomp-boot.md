# Boot path and host shim layer

Target `tools/isaac-ng.unpacked.exe`, 9,176,064 bytes, PE32, image base
`0x00400000`, entry `0x00aefc46`. Static analysis only; the binary was never
executed natively.

Reproduce every number here:

```
python scripts/recomp/host/boot_tables.py      # boot tables, ~3 s
python scripts/recomp/host/memimage.py         # memory image, ~3 min (brotli -11)
python scripts/recomp/host/verify_memimage.py  # 26 checks against the PE, ~2 s
python scripts/recomp/host/gen_shims.py        # shim table, ~90 s
python scripts/recomp/host/gl_census2.py       # GL entry points, ~60 s
python scripts/recomp/host/gl_legacy_audit.py  # legacy-GL audit, ~90 s
python scripts/recomp/host/lua_abi.py          # Lua ABI verdict, ~2 s
python scripts/recomp/host/eh_audit.py         # C++ EH reachability, ~90 s
python scripts/recomp/host/build_selftest.py   # compile + link + RUN, ~30 s
node --test tests/recomp-host.test.js
```

Confidence labels: **[M]** measured from bytes in the file, **[D]** derived from
measured data by a stated rule, **[J]** engineering judgment.

---

## 0. Four findings that change the plan

These lead because they alter what has to be built.

1. **The renderer uses client-side vertex arrays.** WebGL2 removed them. This is
   the single largest porting problem in the binary and it is on the hot path of
   every draw call. §5.
2. **The target binary is hand-patched, and three of its relocations would
   corrupt code if applied.** Not a defect in the original — self-inflicted by
   earlier phases of this project. It makes "map at the preferred base" the only
   correct option rather than merely the convenient one. §1.2.
3. **Host state must move above a guard, and that contests the lifter's
   `GLOBAL_BASE`.** With the settled `0x00d00000`, host state begins 8,192 bytes
   above the image end — exactly where a `.data` overrun lands, and where the
   14.2 MB dispatch table would sit. §2.3.
4. **The census's 70-entry called-GL list was incomplete.** It was produced by a
   4-byte scan of `.text`, which both invents entry points and misses real ones.
   Re-derived by disassembly: **78** entry points, a strict superset. §5.1.

---

## 1. The ordered boot procedure

A raw snapshot of `.text`/`.rdata`/`.data` is a correct *starting* image but not
a runnable one. Seven steps, in this order. Implemented in
`scripts/recomp/host/src/host_boot.c`.

| # | step | what it does | measured input |
|---|---|---|---|
| 1 | place sections | headers + `.text` + `.rdata` + `.data` at their VAs, BSS tail zeroed | §2 |
| 2 | relocations | **skipped** — map at preferred base | 181,854 entries, 3 unusable |
| 3 | bind IAT | rewrite 650 slots to shim tokens | 650 slots = 622 symbols + 28 terminators |
| 4 | install fake TEB/PEB | give `fs:[0]` a real SEH chain head | 1,833 `__CxxFrameHandler3` sites |
| 5 | run TLS callback | `DLL_PROCESS_ATTACH` | 1 callback at `0x00aefec1` |
| 6 | run `_initterm` tables | **XI (4 C) then XC (117 C++)** | both tables recovered |
| 7 | call `main` | `0x00931050` | |

### 1.1 Why the order is load-bearing

**Step 5 before step 6.** Windows runs TLS callbacks *before* the entry point is
entered at all, so the callback observes pre-constructor global state. Running
it after `_initterm` would show it post-constructor state.

**Inside step 6, XI before XC.** This is the subtle one and it is easy to get
backwards. In memory the C++ table sits *below* the C table:

```
.CRT$XC*  0x00b18a2c .. 0x00b18c04   118 slots, 117 non-null   C++ dynamic init
.CRT$XI*  0x00b18c10 .. 0x00b18c24     5 slots,   4 non-null   C   init
.CRT$XL*  0x00b18c2c                   TLS callback array
```

…because `.CRT$` section names sort alphabetically and `XC < XI < XL`. But
`__scrt_common_main_seh` at `0x00aefac4` calls `_initterm_e(__xi_a, __xi_z)`
**first** and `_initterm(__xc_a, __xc_z)` second. Sorting the two tables by
address and running them in that order silently inverts initialisation. **[M]**

Four independent checks confirm the labelling, all emitted by `boot_tables.py`:
the lower table has more entries (117 vs 4); the TLS callback array sits 8 bytes
above the XI table's end, consistent with `XL` following `XI`; the disassembly
encounters the XI bounds pair first; and the two `_initterm` callees are
distinct thunks (`0x00af065d` = `_initterm_e`, `0x00af0657` = `_initterm`). **[M]**

`_initterm_e` stops at the first initialiser that returns non-zero; `_initterm`
ignores return values. `host_boot.c` reproduces both behaviours.

### 1.2 Relocations: do not apply them

`DllCharacteristics` is `0x8140`, so ASLR is requested, and the fixup table is
complete: **181,854 entries in 1,936 blocks — 180,939 `HIGHLOW`, 915 padding.**
Mapping at the preferred base makes every one a no-op.

That is not just convenient here. **Three `HIGHLOW` entries point into the
middle of instructions and would corrupt `.text` if applied:**

| reloc RVA | dword now | what the patch replaced |
|---|---|---|
| `0x00531148` | `0x90c03304` | `call dword ptr [0x00b189f4]` → `add esp,4; xor eax,eax; nop` |
| `0x00680633` | `0x909090c0` | `mov [0x00c75ab4],eax; call ebx` → `xor eax,eax` + 5 `nop` |
| `0x00680d3a` | `0xc3c03300` | function prologue → `xor eax,eax; ret` |

These are **self-inflicted**. `tools/isaac-ng.unpacked.exe` differs from the
earliest snapshot `…exe.pre-coinit` by **170 bytes in 21 runs**, all hand-patches
from earlier phases (a killed `CoInitialize`, forced-null function pointers,
stubbed-out functions). Running the same validity check on the pristine snapshot
yields **0** invalid HIGHLOW entries; on the shipped target, **3**. In every case
the original dword at the site was a valid in-image VA. **[M]**

Consequence: the memory image built here carries those 21 patch runs. If the
recompilation is ever re-based on a pristine binary, this list must be
re-measured — `boot_tables.py` reports it on every run.

### 1.3 Binding the IAT

650 slots at RVA `0x718000`, 2,600 bytes, exactly matching the `IAT` data
directory. 28 import descriptors, **0 bound**, **0 ordinal-only**, and all
**622/622** symbol slots still hold their `IMAGE_IMPORT_BY_NAME` RVA on disk —
i.e. genuinely unbound. **[M]**

Each slot is rewritten to a *shim token*: a unique address in
`[0x0F000000, 0x0F000000 + 622*16)`. Tokens sit outside the image so they can
never collide with guest code, and the lifted indirect-call dispatcher
recognises the range:

```c
int isaac_indirect_call(uint32_t target, isaac_cpu *cpu);  /* host_trap.c */
```

It runs the shim, then emulates the callee's own `ret [N]` by popping the return
address plus `arg_bytes` (0 for cdecl, since there the *caller* cleans). §4.2
covers how `arg_bytes` is obtained.

### 1.4 The fake TEB

SLEIGH models `fs:[0]` as plain `FS_OFFSET + 0`, so the SEH registration chain
lifts as ordinary memory operations — it needs no special handling, only
somewhere real to point. `isaac_boot_install_teb()` builds the fields
MSVC-generated code and the CRT actually read:

```
+0x00 ExceptionList  = 0xFFFFFFFF   (empty chain)
+0x04 StackBase      = 0x0dff0000
+0x08 StackLimit     = 0x0def0000   (PE StackReserve = 1,048,576) [M]
+0x18 Self           = TEB VA
+0x24 ThreadId       = 1
+0x2C TlsPointer
+0x30 PEB            → ImageBaseAddress = 0x00400000
+0x34 LastError
```

The image's `_tls_index` cell at `0x00c71628` is set to 0 (single-threaded).
TLS raw data is 17 bytes at `0x00bb3318..0x00bb3329` with zero-fill 0, already
present in the image, so nothing needs copying. **[M]**

---

## 2. The memory image

Identity addressing: **guest VA == wasm linear-memory byte offset**. The image
occupies `[0x00400000, 0x00cfe000)`, so the wasm memory needs **208 pages
(13,631,488 bytes)** minimum. Host static data must be linked *below*
`0x00400000` (`-sGLOBAL_BASE`); `verify_image()` asserts this at boot rather
than letting host data silently overwrite guest `.text`.

Placement, as the Windows loader would do it: **[M]**

| region | RVA | copied | zero tail |
|---|---|---:|---:|
| PE headers | `0x000000` | 1,024 | 0 |
| `.text` | `0x001000` | 7,430,656 | 0 |
| `.rdata` | `0x718000` | 915,968 | 0 |
| `.data` | `0x7f8000` | 433,664 | **240,804** |
| `.rsrc` | `0x89d000` | 15,360 | 0 |
| `.reloc` | `0x8a1000` | **dropped** | 379,392 |

PE headers are **not** decoration: `__scrt_is_managed_app()` dereferences
`__ImageBase` and reads the COM descriptor out of the optional header.

### 2.1 Size, and what actually helps

Three shippable forms, each compressed. What ships is the compressed bytes: **[M]**

| variant | raw | gzip -9 | brotli -11 |
|---|---:|---:|---:|
| **flat** (recommended) | 9,046,813 | 3,781,676 | **2,971,935** |
| segmented (50 segments, zero runs ≥256 elided) | 8,646,165 | 3,780,166 | 2,971,811 |
| wasm passive-data module | 8,646,211 | 3,780,361 | 2,971,956 |
| flat *with* `.reloc` | 9,428,992 | 4,044,636 | 3,185,271 |

**Two conclusions, both measured:**

- **Dropping `.reloc` is worth 213,336 brotli bytes (6.7%).** Nothing reads it
  once the image is mapped at its preferred base.
- **Segmentation is not worth it.** Eliding zero runs saves 400,648 raw bytes
  but only **124 brotli bytes** — brotli already models those runs. The flat
  form is simpler, is one `memcpy`, and costs nothing extra. Ship flat.

**2.83 MiB brotli** is the number that matters for load time. Of the raw image,
7,396,227 bytes are non-zero (81.8%).

The wasm passive-data variant exists for a different reason than size: it places
every byte at its guest VA via `WebAssembly.instantiate` against the runtime's
imported memory, with no JS-side copy loop. It costs 21 bytes more than the
segmented blob. Choose it for instantiation ergonomics, not for bytes.

**Consumer contract.** `isaac.mem` is a *zero-trimmed prefix* of the image:
9,046,813 bytes covering `SizeOfImage` 9,428,992, with the trailing 382,179
zero bytes omitted. Place it at `0x00400000` in zero-filled linear memory —
wasm memory is zero-initialised, so the omitted tail is already correct. A
consumer that treats the blob length as `SizeOfImage` will size the memory
382 KB short.

### 2.2 Verified against the PE

`verify_memimage.py` checks the built image rather than trusting the builder —
**26 checks, 0 failures**: **[M]**

- every section's raw bytes appear at its VA (`.text` 7,430,656, `.rdata`
  915,968, `.data` 433,664, `.rsrc` 15,360), byte for byte
- `.data`'s 240,804-byte BSS tail is zero; `.reloc` is absent
- `MZ` present at the image base
- **all 12 addresses hard-coded in `isaac_host.h` agree with the PE** — image
  base, size, entry, `main`, both `_initterm` table bounds, TLS callback array,
  `_tls_index`, IAT base, stack reserve. A drift here would make the boot path
  read garbage, so it is asserted rather than assumed.
- the XI/XC tables and the 2,600-byte IAT are readable *in the image*
- **121 initialiser targets read out of the image, 0 outside `.text`**
- the TLS callback reads back as `0x00aefec1`

This caught a real bug: the first version of the verifier failed on `.rsrc`
because the flat image is trailing-zero-trimmed and `.rsrc`'s raw padding had
been cut. The image was right; the contract was undocumented. It is now above.

---

### 2.3 Address-space map: keeping a wild guest write out of the runtime

The lifter hit this during oracle replay: one lifted function performed a wild
write that corrupted the dispatch table mid-run, and 1,429 downstream "function
not in module" results turned out to be pure cascade damage — they went to zero
when each function was replayed alone. With ~7 MB of mechanically lifted code,
the first wild pointer takes down the *runtime*, not just the guest. A guest
crash is debuggable; a corrupted dispatch table produces nonsense a hundred
calls later.

**The invariant:** everything the guest can write is below
`ISAAC_GUEST_LIMIT_VA`; everything the host owns is above `ISAAC_HOST_BASE_VA`;
a 1 MiB guard sits between them and is never touched.

```
0x00000000  null guard, never mapped          catches null+offset derefs
0x00400000  PE image (identity addressed)     .text .rdata .data .rsrc
0x00cfe000
0x00d00000  guest heap (VirtualAlloc)         192 MiB
0x0def0000  guest stack, 1 MiB, grows down    = PE StackReserve, measured
0x0e000000  fake TEB / PEB / TLS array        guest-visible, host-written
0x0f000000  shim tokens, 622 x 16 bytes       guest-visible, host-written
0x0ff00000  ===== GUARD, 1 MiB, untouched =====   <- ISAAC_GUEST_LIMIT_VA
0x10000000  ===== HOST ONLY ==================   <- ISAAC_HOST_BASE_VA
            emscripten statics, 14.2 MB VA->fn dispatch table,
            CpuState, host stack, host malloc
```

Build flag: **`-sGLOBAL_BASE=268435456`** (`0x10000000`),
`-sINITIAL_MEMORY=402653184` (384 MiB), `-sALLOW_MEMORY_GROWTH=1`.

### The conflict with the lifter's settled layout — reported, not silently adopted

The lifter settled on **`-sGLOBAL_BASE=13631488`** (`0x00d00000`), which puts
emscripten's data *immediately above the image*. That preserves identity
addressing, which is the property that matters most and is not in dispute. But
measured against the invariant above it fails three ways: **[M]**

| # | problem |
|---|---|
| 1 | Host state begins **8,192 bytes** above the image end (`0x00cfe000`). A buffer overrun off the end of `.data` — the single most likely *structured* wild write — walks straight into the runtime on its first step. |
| 2 | The host malloc heap then grows **upward without bound** from ~`0x01a8acc0` (after the 14.2 MB dispatch table) and reaches guest-side fixed regions after ~196 MB of host allocation. |
| 3 | Guest-owned regions end up **interleaved** with host regions, so there is no single boundary a guard can protect. |

Which side the host goes on is decided by that first row: an overrun off `.data`
travels upward, so whatever sits immediately above the image absorbs it. Putting
*guest* heap there means the overrun corrupts the guest and produces a
guest-shaped crash; putting *host* state there means it corrupts the runtime.

**Resolution used here:** host above the guard at `0x10000000`, guest heap moved
down to `0x00d00000` where the lifter had put host statics. Identity addressing
is untouched — the image still occupies `0x00400000`–`0x00cfe000` as real linear
memory, which was the point of the lifter's choice. **This needs arbitration:
two different `GLOBAL_BASE` values cannot both ship.** The cost of the value
used here is a larger `INITIAL_MEMORY` (384 MiB vs whatever the lifter assumed);
the benefit is that the 14.2 MB dispatch table is not reachable by a guest
pointer.

### Verified at runtime, not asserted on paper

`build_selftest.py` links with the flags above and checks the layout in the
running module: **[M]**

```
host static 0x10004364 | guest limit 0x0ff00000 | host base 0x10000000
host malloc 0x1010d3e8
```

Both land above the host base. `isaac_boot_init()` re-checks this at boot and
refuses to continue if host statics fall below `ISAAC_HOST_BASE_VA`, and it
also verifies that the five fixed guest regions are inside the guest range and
do not overlap each other. If that assertion ever fires, the runtime and the
guest are sharing a blast radius.

**Shim tokens (`0x0f000000`) and the TEB (`0x0e000000`) are deliberately on the
GUEST side.** The guest holds pointers to both — `fs:[0]` and the IAT — so they
must be addressable by it. They are host-written but guest-readable, and
corrupting them breaks the guest, not the runtime. They sit below the guest
limit, which the test suite asserts.

## 3. Shim layer

622 imports, all classified, all reachable at runtime.
`scripts/recomp/host/gen_shims.py` emits `shim_table.c`, `shim_decls.h` and
`shim_weak.c` from the census plus its own measurements.

### 3.1 By verdict **[M]** counts, **[J]** bucket assignment

| verdict | symbols | call sites |
|---|---:|---:|
| PROVIDED (musl / libc++ / emscripten GLFW / OpenAL / Lua) | 289 | 17,307 |
| REAL (hand-written) | 139 | 4,709 |
| STUB (inert but loud) | 148 | 497 |
| NEVER_CALLED (0 measured sites; traps if reached) | 46 | 0 |
| **total** | **622** | **22,513** |

Call sites reconcile exactly with the census total of 22,513.

### 3.2 By subsystem, ordered by call sites **[M]**

| subsystem | REAL | PROVIDED | STUB | never | sites |
|---|---:|---:|---:|---:|---:|
| lua | – | 59 | – | 8 | 14,011 |
| cxx-runtime (`vcruntime140`+`msvcp140`) | 57 | 6 | – | 11 | 4,006 |
| crt-runtime | 27 | – | – | – | 1,599 |
| crt-math | – | 22 | – | – | 612 |
| crt-heap | – | 5 | – | – | 458 |
| crt-convert | – | 6 | – | 1 | 423 |
| kernel32 | 52 | 17 | 20 | 5 | 327 |
| win-window/input (`user32`) | 1 | 94 | – | 9 | 262 |
| epic-eos | – | – | 78 | 4 | 215 |
| crt-string | – | 15 | – | 2 | 150 |
| steam | – | – | 10 | – | 128 |
| crt-stdio | – | 25 | – | – | 122 |
| audio (OpenAL) | – | 26 | – | 2 | 95 |
| crt-time | – | 5 | – | – | 21 |
| gdi | – | – | 12 | 1 | 20 |
| win-misc (`advapi32`/`winmm`/`shell32`/`ole32`) | – | – | 13 | 2 | 17 |
| crt-utility | – | 3 | – | – | 15 |
| net (`libcurl`) | – | – | 10 | 1 | 12 |
| crt-filesystem | – | 4 | – | – | 11 |
| debug (`dbghelp`) | – | – | 5 | – | 5 |
| crt-environment / crt-locale | – | 2 | – | – | 2 |
| crypto (`bcrypt`) | 1 | – | – | – | 1 |
| gl (`opengl32`) | 1 | – | – | – | 1 |

The three symbols that dominate the hand-written half are unchanged from the
census: `__CxxFrameHandler3` (1,833), `_invalid_parameter_noinfo_noreturn`
(1,458), `__RTDynamicCast` (822).

### 3.3 No silent stubs

Every import gets a weak default implementation, so the module links before any
subsystem is written and nothing can quietly return 0:

- **STUB / NEVER_CALLED** → `isaac_stub_hit()`: logs symbol, DLL, **guest return
  address**, verdict and measured call-site count on first call, then counts
  silently. A `NEVER_CALLED` hit prints an extra warning, because reaching it
  means the census or the lift is wrong.
- **REAL / PROVIDED not yet written** → `isaac_trap()`: logs, dumps the full
  stub report, and aborts. Faking a return from `EOS_Platform_Create` produces a
  null-deref forty frames later with no clue why; stopping at the call site is
  strictly more useful.
- `isaac_stub_report()` dumps every stub reached, sorted by hit count.

Reporting the **call site**, not just the symbol, is the point — it turns
"`EOS_Lobby_JoinLobby` was called" into "…from `0x0089f1a2`".

### 3.4 Hand-written so far

`src/host_shims_crt.c` implements 13 shims as strong symbols that override the
generated weak fallbacks at link time. Chosen by call-site count:

| symbol | sites | what it does |
|---|---:|---|
| `_invalid_parameter_noinfo_noreturn` | 1,458 | logs the guest call site and aborts — it is `noreturn` on Windows, and 1,458 sites is one function reached from everywhere, not 1,458 pieces of work |
| `__acrt_iob_func` | 49 | returns one of three guest-visible pseudo-`FILE` blocks; must not be a host `FILE*` because the guest reads fields out of it (`_fileno` reads offset 0x10) |
| `_wassert` | 92 | decodes the UTF-16 `__FILE__`/expression MSVC baked in and prints them — the same strings the census used to identify vendored libraries |
| `_errno` / `_set_errno` | 14 | one guest-visible cell; the guest dereferences the returned pointer |
| `abort` / `terminate` / `exit` / `_exit` | 15 | teardown, each dumping the stub report first |
| `_initterm` / `_initterm_e` | 2 | same semantics as boot step 6, for the case where the guest's own `__scrt_common_main_seh` runs instead |
| `__CxxFrameHandler3` | 1,833 | **traps.** Returning `ExceptionContinueSearch` would look correct until the first throw |
| `_CxxThrowException` | 72 | **traps**, logging the thrown object and type-info pointers |

A test asserts every hand-written identifier matches a generated declaration
exactly — a typo there would silently fail to override and leave the weak trap
in place.

---

### 3.5 The indirect-call contract, negotiated with the lifter

This was flagged as the one interface that could be wrong by assumption. It
was. Reading `scripts/recomp/lift/` found two real conflicts, both now
resolved in favour of the lifter.

**Conflict 1 — naming.** The lifter resolves `call dword ptr [IAT slot]` at
*lift* time into a direct call to `imp_<stem>__<symbol>(CpuState*)`
(`emit.py:load_imports`). This layer was generating `shim_<stem>__<symbol>`,
which not only diverged but truncated `lua5.3.3r.dll` to `lua5` (it split on
`.`), losing the version. `gen_shims.py:c_ident()` is now a copy of the
lifter's algorithm. Cross-check: of the 587 `imp_*` symbols the lifter has
actually emitted across its output modules, **587/587 are present in this
layer's 622-entry table; 0 disagree.** Asserted by the test suite so it cannot
silently drift again. **[M]**

**Conflict 2 — the register struct.** This layer had its own `isaac_cpu` with
lowercase fields (`eax`, `esp`, `fs_base`). The lifter generates `CpuState`
from the SLEIGH x86:LE:32 register set with uppercase names and `FS_OFFSET`.
Two parallel structs over the same memory is precisely the "two mechanisms
that happen to agree today" failure mode, so `isaac_host.h` now includes the
lifter's `recomp_state.h` when present and falls back to a field-identical
definition only for standalone builds. `isaac_cpu` is a typedef alias.

**Why both binding mechanisms are still needed.** The lift-time direct call
covers the common case, but code also takes the *address* of an import and
calls it later — measured at `0x00a24ce2`:

```
mov eax, dword ptr [0x00c10ed4]    ; load epoxy_glVertexAttribPointer
...
call eax
```

That load reads whatever `isaac_boot_bind_iat()` wrote into the slot, and the
value arrives at `recomp_call_indirect()` as an ordinary 32-bit VA. So the IAT
binding is not redundant with the lifter's direct binding — it is what makes
address-taken imports work. Both must name the *same* function, which is why
the naming had to be reconciled rather than merely coexist.

**The resulting contract**, implemented in `host_trap.c` as strong definitions
that replace the lifter's `__attribute__((weak))` aborting versions:

```c
void recomp_call_indirect(CpuState *s, uint32_t target) {
    if (isaac_indirect_call(target, s)) return;   /* 1. host shim token */
    if (isaac_lifted_dispatch(target, s)) return; /* 2. VA -> wasm function */
    /* 3. loud abort, saying which of the two it failed */
}
void recomp_jump_indirect(CpuState *s, uint32_t t) { recomp_call_indirect(s, t); }
```

Shims are tried **first**: tokens live at `0x0F000000`, deliberately outside
the image, where the lifter's VA table has no entry and would report
"unresolved indirect call".

**Dispatch strategy: no conflict.** The lifter measured five VA -> wasm-function
strategies over the real 21,375-entry set and settled on a direct-mapped
`uint16` table over `.text` at **3.98 ns/lookup** (binary search is 81.33 ns and
disqualified; the table must stay byte-granular because 13.0% of entries are not
even 2-byte aligned). This layer does not implement that lookup and does not
need to: `recomp_call_indirect()` tries the shim-token range first and then
delegates to `isaac_lifted_dispatch()`, which is exactly where the direct-mapped
table plugs in. The one consequence for this layer is a memory-layout one, and
it is handled in §2.3: **the table is 14.2 MB of linear memory and must live
above the guard**, or it becomes the largest and most attractive target for a
wild guest write in the whole address space.

**One residual disagreement, flagged not silently adopted.** The lifter's
placeholder stubs (`mkstubs.py`) emit
`{ s->EIP = MEMR32(s->ESP); s->ESP += 4; }` — pop the return address only,
i.e. cdecl for *every* import. That is correct for the 263 cdecl imports and
wrong for the 315 stdcall ones, which must also pop `arg_bytes`. This layer's
dispatcher does the stdcall purge (§4). The lifter's version is explicitly a
placeholder, so this is not yet a bug — but if lifted modules are ever linked
without this layer's `recomp_call_indirect`, every stdcall import will
desynchronise the guest stack. **Arbitration needed: the purge belongs in one
place, and this layer is the one that knows the sizes.**

### 3.6 The 16 imports between a linked module and `main`

The lifter's survey build established the exact ordered set the boot path
demands. All sixteen are CRT startup; fifteen have single-digit call-site
counts; none is a graphics, audio, Steam or Lua entry point. All sixteen are
now implemented in `src/host_shims_crtstartup.c`. **[M]**

| # | import | conv | purge | what it actually does here |
|---|---|---|---:|---|
| 1 | `_set_app_type` | cdecl | 0 | records the app type; the CRT uses it only to pick an abort/assert reporting style |
| 2 | `_set_fmode` | cdecl | 0 | validates `_O_TEXT`/`_O_BINARY`, stores it, `EINVAL` otherwise |
| 3 | `__p__commode` | cdecl | 0 | returns a **guest-visible cell**; the guest writes through the returned pointer, so a faked EAX would not do |
| 4 | `_crt_atexit` | cdecl | 0 | real LIFO registration list, driven by `isaac_run_atexit()`. The list lives in **host** memory — the guest only passes pointers in and never inspects it |
| 5 | `_configure_narrow_argv` | cdecl | 0 | 0; argc/argv are supplied by `isaac_boot_call_main` |
| 6 | `InitializeSListHead` | stdcall | 4 | zeroes the 16-byte header — complete and correct single-threaded |
| 7 | `_controlfp_s` | cdecl | 0 | **partially implementable**, see below |
| 8 | `_configthreadlocale` | cdecl | 0 | reports per-thread locale permanently disabled; logs if asked to enable |
| 9 | `_initialize_narrow_environment` | cdecl | 0 | 0; there is no environment block to build |
| 10 | `InitializeCriticalSectionAndSpinCount` | stdcall | 8 | zeroes the 24-byte CS, returns TRUE |
| 11 | `GetModuleHandleW` | stdcall | 4 | NULL → image base; a **named** request decodes the UTF-16 name into the log and returns NULL, because which DLL was probed is diagnostic |
| 12 | `IsProcessorFeaturePresent` | stdcall | **4** | SSE/SSE2 yes, `PF_FASTFAIL_AVAILABLE` **no** — see below |
| 13 | `memset` | cdecl | 0 | musl forward **with a guard check**; 444 sites, and the busiest place a wild pointer can do damage |
| 14 | `IsDebuggerPresent` | stdcall | 0 | 0 |
| 15 | `SetUnhandledExceptionFilter` | stdcall | 4 | real store-and-return-previous; the CRT installs its own filter and later restores it, so returning garbage would install garbage |
| 16 | `UnhandledExceptionFilter` | stdcall | 4 | **traps**, after decoding the `EXCEPTION_RECORD` — see below |

**A purge bug caught on the way in.** `IsProcessorFeaturePresent` was carrying
`argBytes = 8` from the push-count sweep. Its signature takes one `DWORD`, so
the correct purge is 4 — the same failure mode as `MessageBoxA` (arguments set
up with `mov [esp+N]` rather than `push`). A purge of 8 would have popped a
caller local on every one of its 4 call sites. It is now a curated entry, and
the test suite asserts the curated value.

**Three where a fully correct implementation is not available, stated rather
than approximated:**

- **`_controlfp_s`** — wasm has no x87 control word: rounding is fixed at
  round-to-nearest-even and exceptions are always masked. The control word can
  be *reported* but not *changed*. That is sound here for a measured reason —
  the lifter found this binary never executes `fldcw`, so it never depends on a
  change taking effect — and a caller asking for a different mode is logged
  rather than silently ignored.
- **`IsProcessorFeaturePresent(PF_FASTFAIL_AVAILABLE)` answers no.** Answering
  yes routes CRT failures into `__fastfail` (an `int 29h`), which reaches the
  lifter's `swi` intrinsic and aborts with no diagnosis. Answering no keeps
  those failures on the reportable path. This is a deliberate divergence from
  the host CPU's real capability, made to preserve diagnosability.
- **`UnhandledExceptionFilter`** — there is no honest return value.
  `EXCEPTION_EXECUTE_HANDLER` claims we handled something we did not;
  `EXCEPTION_CONTINUE_SEARCH` sends the CRT to its terminate path, which ends
  in a deliberate breakpoint and surfaces as an opaque `swi` abort. So it
  decodes the exception record into the log and stops.

### 3.7 Trap messages name the call site, not the return address

The value on the guest stack is the **return** address the `call` pushed. For
`_set_app_type` that is `0x00aefa07`, while the instruction is at
`0x00aefa02` — reporting the former sends whoever is debugging to the wrong
instruction. `isaac_call_site_from_return()` recovers the call by checking, at
each plausible length, whether the bytes there decode as a call of exactly that
length (`E8 rel32`, `FF 15 disp32`, `FF /2` register and memory forms). It
reports `0x00aefa02 (returns to 0x00aefa07)`, and falls back to naming only the
return address rather than inventing a call site when nothing decodes.

Verified against the real image in the selftest: `ret 0x00aefa07 -> 0x00aefa02`.

### 3.8 The duplicate weak-symbol hazard

Both this layer and the lifter emitted `__attribute__((weak))` definitions for
the same 591 imports. **Two weak symbols do not collide** — the linker silently
picks one — and picking the lifter's would have replaced this layer's
informative trap with a bare return. The bug existed only in the *pair*, so
neither layer's own tests could have caught it.

The lifter has added `mkstubs.py --no-import-stubs`, which closes it at source.
This layer additionally asserts the outcome at runtime: the selftest exercises a
stubbed import and requires `isaac_stub_record_count() > 0`. The other layer's
stub returns without recording anything, so a non-zero count is only possible
if these definitions are the ones that survived.

### 3.9 Module handles and symbol lookup: one story

The initialiser walk puts `GetProcAddress` at depth 1 (12 sites) and
`LoadLibraryA` at depth 2 (9 sites), so this is a subsystem answering questions
from several places, not a one-off. Answering per call produces a layer that
disagrees with itself later. `src/host_shims_module.c` therefore owns all of it.

**A module handle is a token.** The EXE's is the honest `ISAAC_IMAGE_BASE` —
what Windows returns and what `__ImageBase`-derived code expects. Every other
module gets a distinct token in `[0x0e010000, …)`, guest-side so the guest may
hold it, in a range nothing else uses so a stray handle is recognisable.

**Which names resolve:** exactly the modules this port has — the 28 import-table
DLLs plus the EXE, 29 total. Nothing else.

This makes the boot blocker fall out rather than be special-cased. `FUN_00aef191`
treats a NULL `kernel32.dll` handle as fatal (`je` at `0x00aef1c3` →
`STATUS_FATAL_APP_EXIT`) but handles a NULL api-set handle by design:

| query | answer | why |
|---|---|---|
| `GetModuleHandleW(NULL)` | `0x00400000` | the running image |
| `GetModuleHandleW(L"kernel32.dll")` | `0x0e01c000` | it is in the import table, so we really do have it |
| `GetModuleHandleW(L"api-ms-win-core-synch-l1-2-0.dll")` | **NULL** | not an import; the CRT falls back to `CreateEventW`, which is the intended path |

**What `GetProcAddress` returns: the shim token.** The same `0x0f000000`-range
value the boot path writes into that symbol's IAT slot. This is the load-bearing
unification — a function pointer obtained dynamically and one obtained from the
IAT become the same value, dispatched through the same `isaac_indirect_call`
with the same measured purge. Verified in the selftest:
`GetProcAddress(kernel32, "CreateEventW")` → `0x0f001ac0`, **bit-identical to
the bound IAT slot**.

**What it returns for a symbol we lack: NULL, recorded.** Callers probe for
optional APIs deliberately — the CRT asks for `SleepConditionVariableCS`
precisely so it can fall back when absent — so shouting on every one would be
noise. Each NULL is recorded once and printed by `isaac_module_report()`, which
turns "what did this build fail to provide" into a list.

**Kernel objects.** `CreateEventW` must be non-NULL or the same fatal branch
fires one step later. Events are real: manual/auto reset, set, reset, and waits.
A wait on an unsignalled event with `INFINITE` in a single-threaded build is a
*guaranteed* deadlock — nothing can ever signal it — so it stops with that
explanation instead of hanging the tab.

### 3.10 Orderly shutdown

`abort()` inside wasm tears the module down under node and emits
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76`
— a libuv teardown artefact that lands *after* the real diagnosis and becomes
the last thing on screen. `isaac_shutdown(reason)` replaces it: it prints the
module, heap and stub reports, then exits, so the actual failure is what the
reader sees. It is re-entry guarded, because a report must never re-trigger it.

### 3.11 A verdict is not an implementation

`QueryPerformanceCounter` was marked **PROVIDED** — "emscripten and musl give us
this" — and nothing forwarded it, so the first run to reach it trapped exactly
like an unimplemented import. The classification was right; the handoff was
missing.

That is a class, not an incident. The generated weak fallback calls
`isaac_trap()` for anything whose verdict is REAL or PROVIDED, so **every**
PROVIDED symbol without a strong definition is a latent trap wearing a green
label. `coverage.py` sweeps all 622 and reports it: **[M]**

| | before this round | after | after Lua linked |
|---|---:|---:|---:|
| strong definitions | 67 | **120** | **179** |
| latent traps (green verdict, nothing wired) | 371 symbols / 16,510 sites | **320 / 14,768** | **261 / 757** |

The third column was measured after `lua_build.py --build` + a selftest rebuild:
the 59 Lua symbols became strong definitions in `host_lua.c`, and **Lua
disappears from the residual entirely** — 14,011 call sites wired in one step.
The remaining 261 symbols / 757 sites are all forwarding work (GLFW, libc++,
CRT, OpenAL), none of it a missing implementation class.

The sweep reads the **symbol table of the built objects**, not the source.
A regex over `^void imp_...(` under-reports, because several shims are defined
through macros (`FWD_D_D(imp_..._floor, floor)`) — that made `floor` look
unwired when it was not. `llvm-nm` reports `T` for a strong definition and `W`
for the generated weak fallback, so this measures **override, not intent**.

The headline number is misleading on its own, so the residual is attributed by
*cause* — these are different problems with different owners: **[M]**

| cause | symbols | sites |
|---|---:|---:|
| user32 — needs emscripten GLFW wired | 95 | 262 |
| `msvcp140` `std::` — needs libc++ forwarding | 46 | 169 |
| CRT not yet forwarded | 54 | 163 |
| OpenAL — needs emscripten OpenAL wired | 26 | 95 |
| residual kernel32 | 38 | 66 |
| bcrypt / opengl32 | 2 | 2 |

**Lua is gone from this table**: its 59 symbols / 14,011 sites — 62% of all
IAT traffic, previously *the* dominant row — were the one non-forwarding item
(the upstream wasm module), and they are now linked and executing (§6.6). The
entire residual is forwarding work.

`src/host_shims_forward.c` closed the mechanically-forwardable part: everything
whose shim is "read N arguments off the guest stack, call the host libc,
publish the result". Pointer arguments are guard-checked on the way in, since
with identity addressing an unchecked guest pointer handed to `memcpy` is a
direct write into the runtime. Three ABI facts are encoded in the macros so
they cannot be got wrong per symbol: a `double` argument occupies **two** stack
slots; a `double` return goes in **st(0)** — and the lifter models x87 as a
double in the low 8 bytes (`native_float80_t` = `double`), so no 80-bit
conversion is involved; a 64-bit integer return is **EDX:EAX**.

### 3.12 Timing: a deterministic counter, by choice

`QueryPerformanceCounter` advances by a fixed tick per query rather than reading
`performance.now()`. Three reasons, in order of weight:

1. **This project's verification rests on reproducibility.** The oracle compares
   register and memory deltas across runs; a wall clock makes every trace differ
   from every other, turning "did this change behaviour" into an expensive
   question. A deterministic counter makes the whole port replayable.
2. **The first consumer is a seed generator.** `FUN_00aea110` runs a `lowbias32`
   avalanche (`imul 0x7feb352d`, `imul 0x846ca68b`) over the counter, so it
   needs monotonicity and nothing else — not precision, not epoch.
3. Browser clocks are deliberately coarsened and jittered against timing
   attacks, so `performance.now()` is not the high-resolution source the API
   name promises anyway.

`QPF` is 10 MHz and the deterministic tick is 1, so the pair is self-consistent:
each query is 100 ns of notional time and `counter / frequency` is a sane number
of seconds. Monotonicity is enforced in **both** modes — the wall-clock path
clamps forward so a coarsened clock cannot appear to go backwards.

**The cost, stated:** anything that measures elapsed time to pace itself — frame
limiters, animation timing — will see time advance per *call*, not per second.
Those consumers want a real clock, so the mode is switchable at runtime via
`isaac_time_set_mode()`, and the frame loop should select WALL once it exists.
Defaulting to DETERMINISTIC keeps every run up to that point reproducible.
`Sleep` advances the deterministic clock by the requested interval rather than
blocking, which a browser cannot do anyway.

## 4. Calling conventions and stack purge

This is the part most likely to fail silently, so it got the most scrutiny.

### 4.1 A measurement that was wrong

The first pass derived the convention from the call sites alone: if the
instruction after `call [slot]` is `add esp, N` the callee is cdecl, otherwise
stdcall. Checked against 28 known signatures it got **7 wrong** — `memset`,
`memcpy`, `floor`, `lua_absindex` and `lua_pushstring` all came out "stdcall".

The heuristic is unsound because MSVC frequently defers or coalesces cdecl
cleanup (one `add esp, 48` covering several calls, or `pop ecx`). Absence of an
immediate `add esp` proves nothing.

### 4.2 What replaced it

Convention is taken **a priori from the library ABI**, which is exact:

- `api-ms-win-crt-*`, `vcruntime140`, `lua5.3.3r`, `openal32`, `libcurl`,
  `steam_api` → **cdecl** (263 symbols)
- `kernel32`, `user32`, `gdi32`, `advapi32`, `shell32`, `ole32`, `winmm`,
  `opengl32`, `dbghelp`, `bcrypt`, EOS → **stdcall** (315)
- `msvcp140` → decided by MSVC name mangling: `@@QAE`/`@@UAE`/`@@IAE`/`@@MAE`
  are `__thiscall`, `@@YA` is `__cdecl` (44 thiscall)

Only the stdcall **purge size** needs deriving, from three sources in priority
order:

| source | symbols | note |
|---|---:|---|
| curated signature | 67 | documented Win32/SDK parameter count |
| name decoration (`_EOS_Foo@16`) | 82 | exact, encoded in the symbol |
| measured push count | 195 | pushes immediately preceding the call |
| cdecl (caller cleans) | 263 | purge is 0 by definition |
| **UNKNOWN** | 15 | all with **0** call sites |

For cdecl the shim pops nothing; the measured `add esp, N` is retained as
documentation only.

### 4.3 The measurement as a second opinion

Curated values override measured ones, and **every disagreement is reported**
rather than smoothed over. Seven clashes, each resolved in favour of the
documented signature: **[M]**

| symbol | curated | measured | why measurement lost |
|---|---:|---:|---|
| `MessageBoxA` | 16 | 4 | args set with `mov [esp+N]`, not `push` |
| `SetPixelFormat` | 12 | 8 | |
| `SymInitialize` | 12 | 4 | |
| `SymGetSymFromAddr64` | 16 | 4 | |
| `SymGetLineFromAddr64` | 16 | 4 | |
| `ChoosePixelFormat` | 8 | 12 | measurement over-counted |
| `InitializeCriticalSectionAndSpinCount` | 8 | 16 | measurement over-counted |

**All 128 returning stdcall stubs now have a high-confidence purge**, asserted by
`tests/recomp-host.test.js`. Symbols with an unknown purge trap rather than
return, so they cannot desynchronise the guest stack. Resolving the 133 ILT
thunks was necessary to get here — without it the sweep saw almost nothing and
512 symbols came back "unknown".

---

## 5. GL: what WebGL2 cannot satisfy

### 5.1 The called set, re-derived

The census's 70-entry list came from a 4-byte scan of `.text`. That scan is
unsound in both directions: the encoding `e8 17 c1 00 00` (`call rel32`)
contains the byte sequence `e8 17 c1 00`, which equals the dispatch-slot VA
`0x00c117e8` — inventing a call to `glGetCombinerInputParameterivNV`.

Re-derived from decoded instructions with known boundaries
(`gl_census2.py`, 1.9 M instructions), classifying each reference as CALL /
LOAD / STORE and excluding libepoxy's own dispatch code (a STORE to a slot is
the resolver writing back, never a call):

**78 entry points, 226 caller CALL sites + 151 LOAD sites.** A strict superset:
0 of the census's 70 are lost, and 8 are recovered that it missed — including
`glCreateShader`, `glGetUniformLocation`, `glGetAttribLocation`,
`glVertexAttribPointer`, `glGenFramebuffers`, `glBlendFuncSeparate`,
`glBlendEquation` and `glCheckFramebufferStatus`. **[M]**

That the census's list contained no way to create a shader or look up a uniform
was the clue worth chasing.

### 5.2 Client-side vertex arrays — the real porting problem

**Finding.** The renderer submits geometry with client-side vertex and index
arrays. WebGL2 removed them entirely.

**Proof (exhaustive, not sampled).** Across all 7,430,656 bytes of `.text`,
2,088,711 decoded instructions, checking every one of the 3,221 libepoxy
dispatch slots under every vendor alias: **[M]**

| family | exports checked | used by caller code |
|---|---:|---:|
| buffer objects (`glGenBuffers`/`glBindBuffer`/`glBufferData`/`glBufferSubData`/`glMapBuffer` + ARB/EXT/OES) | 25 | **0** |
| vertex array objects (+ ARB/OES/APPLE) | 12 | **0** |

Because `glBindBuffer` is never called, `ARRAY_BUFFER` and
`ELEMENT_ARRAY_BUFFER` are provably always 0 — so both pointer arguments are
client memory. The call sites confirm it directly:

```
0x00a24d37   glVertexAttribPointer(index, size, GL_FLOAT, GL_FALSE, stride, ebx)
             ; ebx = caller-supplied pointer
0x00a189f0   glDrawElements(GL_TRIANGLES, [ebx+0x18], GL_UNSIGNED_SHORT, [ebx+0x14])
             ; [ebx+0x14] = caller-supplied pointer
```

**Why WebGL2 cannot do this.** `vertexAttribPointer`'s last argument is a
`GLintptr` byte offset into the bound `ARRAY_BUFFER`; `drawElements`' last
argument is a byte offset into the bound `ELEMENT_ARRAY_BUFFER`. A heap pointer
yields `INVALID_OPERATION`, not a draw.

**The shim.** `scripts/recomp/host/src/host_gl_clientarrays.c` intercepts the
attribute calls, records the client pointers, and at draw time stages the
referenced memory into a streaming VBO/IBO pool, rewrites the attribute pointers
to buffer offsets, and re-issues the draw. Identity addressing makes staging
cheap: the upload source is `isaac_g(ptr)` — the guest pointer *is* the linear
memory offset, so there is no translation and no bounce buffer.

Interleaved attributes (same stride, adjacent pointers — the common case) are
detected and uploaded once rather than once per attribute.

**What is derivable and what is not** — stated plainly, because this is where
such emulations quietly go wrong:

| quantity | derivable? | how |
|---|---|---|
| index byte range | **yes, exact** | `count * sizeof(type)` from `indices` |
| vertex range for `glDrawArrays` | **yes, exact** | `[first, first+count)` |
| vertex range for `glDrawElements` | **only by scanning** | GL places no bound on index values; the exact answer is `max(index)+1`, requiring an O(count) scan of the index array every draw |
| true extent of the client array | **no** | if the app's array is shorter than `max_index+1` vertices, real GL reads out of bounds and so do we; this is undetectable from the API |

`glDrawRangeElements` exists precisely to supply that bound — and this binary
never calls it (0 references, verified).

**Per-frame cost.** Per `glDrawElements`:

- index scan: `count` reads (2 bytes each — the type is `GL_UNSIGNED_SHORT`)
- index upload: `count * 2` bytes
- vertex upload: `stride * (max_index+1)` bytes, once if interleaved

There are only **2 draw-call sites** in the whole binary, so per-call overhead is
negligible; the term that scales is total geometry volume per frame. The index
scan is the part to profile first — it is pure added work that native GL never
did. `isaac_gl_report()` reports draws, indices scanned, and bytes staged, so
this is measured in the browser rather than estimated.

### 5.3 Legacy-GL audit: everything else is clean

Exhaustive sweep over all 3,221 slots. Every one of these is **ABSENT**: **[M]**

| family | exports checked | used |
|---|---:|---:|
| immediate mode (`glBegin`/`glEnd`/`glVertex*`/`glColor*`/`glTexCoord*`) | 190 | 0 |
| fixed-function matrix (`glMatrixMode`/`glLoadMatrix*`/`glOrtho`/…) | 35 | 0 |
| fixed-function state (`glTexEnv*`/`glLight*`/`glAlphaFunc`/`glFog*`) | 64 | 0 |
| client-state arrays (`glVertexPointer`/`glEnableClientState`/…) | 31 | 0 |
| display lists | 8 | 0 |
| `glPolygonMode` | 2 | 0 |

No `GL_QUADS`: the only draw mode passed is `GL_TRIANGLES` (`push 4`). No alpha
test. This is a GL 2/3-era shader pipeline, not a fixed-function one — the
client-array style is its only legacy trait.

### 5.4 The remaining WebGL2 gaps, named now

| # | item | sites | severity | resolution |
|---|---|---:|---|---|
| 1 | **client-side vertex/index arrays** | all draws | **structural** | emulate; §5.2 |
| 2 | `glClampColorARB` | 1 | no WebGL2 equivalent | no-op + loud log; WebGL2 clamping follows the framebuffer format |
| 3 | `glEnable(GL_FRAMEBUFFER_SRGB)` | 1 (`0x00a182d1`) | no WebGL2 equivalent | WebGL2 has no sRGB *enable*; encoding is a property of the attachment format (`SRGB8_ALPHA8`). Must be handled at framebuffer creation, not by an enable |
| 4 | `glEnable(GL_TEXTURE_2D)` | 1 (`0x00a62c90`) | `INVALID_ENUM` in core/WebGL2 | drop the call; it is a fixed-function leftover, immediately followed by `glBindTexture(GL_TEXTURE_2D, …)` which is the call that matters |
| 5 | `glGetString(GL_EXTENSIONS)` | 1 (`0x00a6269b`) | returns NULL in core | synthesize an extension string; `glGetStringi` is also called (1 site) |
| 6 | `wglGetProcAddress` (35), `wglGetCurrentDC` (31) | 66 | no WGL in a browser | satisfied by the libepoxy replacement, which resolves names from the 78-entry table |

Items 2–5 are one-liners each. Item 1 is the work. Item 6 disappears with
libepoxy.

The other 20 `glGetString` sites all request `GL_VERSION` — libepoxy's version
probe. The reported version string must parse as a desktop GL version libepoxy
accepts, or its dispatch never resolves.

---

## 6. Lua — ABI verdict

**Verdict: stock upstream Lua 5.3.3 with default numeric configuration. An
upstream 5.3.3 wasm build is a safe drop-in for all 67 symbols.** **[M]**

This is the single biggest lever in the binary — 59 used symbols, **14,011 call
sites, 62.2% of all IAT traffic** — so it was checked by disassembly rather than
assumed.

### 6.1 What "r" means: nothing

`.scratch/game-instance/Lua5.3.3r.dll` and `Lua5.3.3f.dll` are **byte-identical**
— same SHA-256, both 207,360 bytes, both PE32 (`0x014c`), both image base
`0x10000000`, both exporting the same 146 names. The `r`/`f` suffix carries no
ABI meaning; they are two copies of one DLL. **[M]**

### 6.2 Numeric configuration, proven by disassembly

`lua_pushinteger` at `0x10002160` settles `LUA_INT_TYPE`:

```
mov  edx, [ebp+8]          ; lua_State *L
mov  eax, [ebp+0xC]        ; n, LOW dword
mov  ecx, [edx+0xc]        ; L->top
mov  [ecx], eax
mov  eax, [ebp+0x10]       ; n, HIGH dword  <-- the argument is 64-bit
mov  [ecx+4], eax
mov  dword [ecx+8], 0x13   ; tt_ = LUA_TNUMINT = 3 | (1<<4)
add  dword [edx+0xc], 0x10 ; L->top += 16   <-- sizeof(TValue) == 16
ret
```

`lua_pushnumber` at `0x10002140` settles `LUA_FLOAT_TYPE`:

```
movsd xmm0, qword [ebp+0xC]   ; the argument is 8 bytes
movsd qword [eax], xmm0
mov   dword [eax+8], 3        ; tt_ = LUA_TNUMFLT
```

`lua_gettop` at `0x10001220` independently confirms the TValue size:
`sub eax, 0x10` then `sar eax, 4` — divide by 16.

| property | value | evidence |
|---|---|---|
| `LUA_INT_TYPE` | **`LUA_INT_LONGLONG`** (64-bit `lua_Integer`) | two-dword argument read |
| `LUA_FLOAT_TYPE` | **`LUA_FLOAT_DOUBLE`** (`double`) | `movsd`, 8-byte argument |
| `sizeof(TValue)` | **16** (`tt_` at +8) | `add [edx+0xc], 0x10`; `sar eax, 4` |
| `LUA_TNUMFLT` / `LUA_TNUMINT` | 3 / `0x13` | stored tag immediates |
| calling convention | **cdecl** | every sampled export ends in plain `ret` |

All of these are the stock 5.3 defaults for a 32-bit build. A wasm32 build
reproduces the same layout: the `Value` union is 8 bytes (dominated by
`long long`/`double`), plus `int tt_`, padded to 16 by 8-byte alignment.

### 6.3 No modifications

- **146 exports, every one matching `lua_*` / `luaL_*` / `luaopen_*`.** Zero
  non-stock symbols — no patched allocator hooks, no custom API. **[M]**
- **All 67 imported symbols are present** in the export table. Zero missing. **[M]**
- The DLL imports only `KERNEL32` + `VCRUNTIME140` + 11 UCRT apisets — an
  ordinary `/MD` build with the standard allocator. **[M]**
- All 67 are **cdecl**, so the binding needs no stack-purge data at all. 8 of
  the 67 are never called. **[M]**

### 6.4 The `lua_Number`-in-`st(0)` path is safe

`lua_pushnumber` takes its argument as a `movsd` qword and `lua_tonumberx`
returns a `double` in `st(0)` under x86 cdecl, so the Lua boundary rides on x87
in both directions. The lifter measured the x87 surface: **4,670 x87
instructions across 655 functions, of which 4,205 (90.0%) are `fld`/`fstp`
pure load/store, with zero `fld m80`/`fstp m80` anywhere in the binary and no
`fldcw` ever executed.** `fld m64 -> fstp m64` is therefore bit-exact, which is
precisely the shape of the Lua number path. Precision loss is confined to the
~400 chained arithmetic ops, none of which are on this boundary. The ABI
concern raised here is closed.

### 6.5 Build requirements

Build upstream 5.3.3 with the defaults and do **not** set `LUA_32BITS` — that
would switch `lua_Integer` to `int` and `lua_Number` to `float`, silently
halving both and corrupting every value crossing the boundary. That is the one
flag that would turn this from a drop-in into a disaster.

### 6.6 Build status: done, linked, and executed

The upstream tarball is fetched (operator-approved), checksum-verified against
the lua.org index (`SHA-256 5113c0…aca2`, 294,290 bytes), and lives under
`tools/lua-5.3.3/` — the gitignored private input root that also holds the
game binary; nothing Lua is tracked. `lua_build.py --build` produces
`output/recomp/host/lua/liblua.a` (33 objects, 278,858 bytes). `build_selftest.py`
now **auto-detects** the header and links the library — the previous
`EMCC_CFLAGS=…` handoff was documented but never read by the script, so the
binding had never actually compiled; wiring it exposed two latent defects that
a stub-layer build cannot see: **[M]**

1. **`TRAMP(n)` pasted `isaac_lua_tramp_##n` with the expression `b+0`.** `##`
   with a multi-token operand is undefined; clang emits `isaac_lua_tramp_0+0 +0`
   and every one of the 512 trampoline definitions fails to parse. Replaced
   with single-token enumeration.
2. **`LUAI_EXTRASPACE` is not an upstream macro.** 5.3.3 spells it
   `LUA_EXTRASPACE`. The static ABI gate asserted an undeclared identifier and
   would have failed the first real compile.

The linked selftest (wasm 174,998 → **442,953 bytes**, 55 → **71 checks, 0
failures**) now executes the real module through the shims:

- `luaL_newstate` returns a **guest-addressable** state (`0x00d00414`, below
  the guard) and the VM allocates 15 KB after `openlibs` — the guest-arena
  allocator is live, not the host malloc.
- `lua_pushnumber`/`lua_pushinteger` round-trip a `double` and a 64-bit
  `lua_Integer` (`0x123456789ABCDEF0` — truncation would corrupt this) without
  narrowing.
- `luaL_loadbufferx` + `lua_pcallk` compile and run `return 2+3` → **5**
  inside the module: the real VM executes.
- Guest `lua_CFunction` pointers ride the 512-slot trampoline pool: distinct
  VAs get distinct host addresses, re-registration deduplicates, and calling
  through one comes back `LUA_OK`.
- `luaL_checknumber` returns in `st(0)`; `luaL_checkinteger` in `EDX:EAX`.

Coverage after the rebuild: **320 latent traps / 14,768 sites → 261 / 757**;
59/59 Lua symbols are strong definitions (see §3.11). The binding is real code
now, but it has still **never been driven by lifted guest code** — the
trampoline re-entry path ends at the inert `isaac_guest_call` until a lifted
module is linked.

---

## 7. C++ exceptions: 1,833 is the wrong number

`__CxxFrameHandler3` at 1,833 sites reads like 1,833 things that must work
before anything runs. Measured by disassembly (`eh_audit.py`, following the ILT
thunk rather than the IAT slot, since MSVC routes all of these through one
`jmp dword ptr [__imp_X]` at `0x00af05c7`): **[M]**

| symbol | real `call`s from lifted code | `__ehhandler$` trampolines | on the steady-state path? |
|---|---:|---:|---|
| `__CxxFrameHandler3` | **0** | 1,834 | **no** — only on a throw |
| `__RTDynamicCast` | **817** | 1 | **yes** |
| `_CxxThrowException` | 72 | 1 | only on a throw |
| `__current_exception` | 2 | 1 | only inside a catch |
| `__current_exception_context` | 2 | 1 | only inside a catch |
| `_setjmp3` / `longjmp` | 7 / 6 | 1 / 0 | yes |
| `_except_handler4_common` | 1 | 1 | on `__try` |

Every one of the 1,834 references to `__CxxFrameHandler3` is the `jmp` tail of
a per-function trampoline:

```
__ehhandler$f:  mov eax, offset __ehfuncinfo$f
                jmp __CxxFrameHandler3
```

and the `fs:[0]` registration record points at `__ehhandler$f`, not at the
handler. **Lifted code never calls it.** It is entered only when something
walks the `fs:[0]` chain — i.e. only during a throw.

**How many of the 1,833 lie on paths normal execution takes? Zero.** Not "few" —
zero, by construction rather than by sampling: a `jmp`-tail trampoline is only
entered by a chain walk, and lifted code performs no chain walk. The independent
corroboration from the lifter points the same way: **2,065 of its 2,108
unresolved code-pointer targets are C++ EH funclets in `__ehfuncinfo` unwind
maps**, reachable only through `__CxxFrameHandler3`. So the exception machinery
is a genuinely separable subsystem — if it traps, those 2,065 targets are simply
never entered and nothing else is affected. That makes "trap loudly on first
throw" a defensible shipping position for a first playable.

**Minimum viable implementation, and why it is honest.**
`isaac_boot_install_teb()` sets `ExceptionList` to `0xFFFFFFFF`, a genuinely
empty chain. `__CxxFrameHandler3` returning `ExceptionContinueSearch` (1) says
"this frame has no handler for that exception", which is *true* of an empty
chain — a correct answer, not a fabricated one. It still logs on first entry,
because arriving there means a throw happened. It is now implemented that way
rather than trapping.

**The actual blocker is `__RTDynamicCast`, not the frame handler.** 817 real
calls, on the steady-state path — it is what `dynamic_cast` lowers to and the
engine uses it constantly. It must walk the `RTTICompleteObjectLocator` and
class-hierarchy descriptors, all of which live in `.rdata` and are present in
the memory image, so it is straightforwardly implementable. Until then it
traps: returning NULL would silently turn every successful downcast into a
failed one. **This is the item to do next on the C++ side.**

`_CxxThrowException` (72 sites) traps. A throw is a real event that cannot yet
be serviced, and the 72 sites are dominated by `msvcp140`'s error paths
(`_Xlength_error` 38, `_Xout_of_range` 10, `_Xinvalid_argument` 6,
`_Xbad_alloc` 2), which steady-state gameplay should not reach.

## 8. Build verification

`python scripts/recomp/host/build_selftest.py` compiles every translation unit,
links them, and runs the result under node. **[M]**

| stage | result |
|---|---|
| compile (13 TUs, `-O1 -Wall -Wextra`) | **0 errors, 0 warnings** |
| link | exit 0, **0 duplicate-symbol**, **0 undefined-symbol** |
| artifact | ~150,000-byte wasm |
| run | **55 checks, 0 failures** |

emcc 6.0.5 at `C:\Users\Luca\emsdk\upstream\emscripten\emcc.exe`. It is not
on `PATH`; `build_selftest.py` probes the extension explicitly, because
`Path("...\emcc").exists()` is False on Windows while a POSIX shell resolves
the same bare name to `emcc.exe` — which is what caused this layer to be
reported "compile-unverified" in the previous round.

**Errors fixed to get there: 23.** 20 were one generator bug (`cpu->eax` for
`cpu->EAX`, emitted 622 times, surfacing as 20 distinct diagnostics before the
compiler gave up), fixed in `gen_shims.py` rather than in its output. 3 were a
missing `#include "shim_decls.h"` in the selftest. Nothing structural.

What the 19 runtime checks prove that compiling cannot:

- **the strong shims actually override the weak ones.** A typo in an identifier
  would compile and link happily and leave the trap in place. The check calls
  `imp_..._errno` and requires a non-zero return; the weak fallback for a REAL
  verdict calls `isaac_trap()`, which aborts, so *reaching the next line* is
  itself the assertion.
- 622/622 IAT slots receive their token and every token round-trips through
  `isaac_resolve_shim`; an ordinary guest VA and a misaligned token both
  correctly resolve to NULL.
- a STUB (`SteamInternal_ContextInit`, 67 sites) returns 0, logs its call site
  once, pops return address + purge, and lands back at the caller VA.
- host static data sits at `0x000044c4`, below the image base — the condition
  identity addressing depends on.

## 9. What exists

Code (`scripts/recomp/host/`):

| file | purpose |
|---|---|
| `pe.py` | self-contained PE32 reader; VA↔offset always via the section table |
| `boot_tables.py` | IAT / TLS / `_initterm` extraction → `boot-tables.json`, CSVs |
| `memimage.py` | linear-memory image in 3 forms, gzip + brotli measured |
| `verify_memimage.py` | byte-for-byte check of the built image against the PE |
| `gen_shims.py` | 622-entry shim table, conventions, purge measurement |
| `gl_census.py` | first-pass GL scan (superseded; kept for the export walker) |
| `gl_census2.py` | disassembly-based GL entry-point census |
| `gl_legacy_audit.py` | exhaustive legacy-GL / WebGL2 compatibility sweep |
| `lua_abi.py` | Lua numeric config + export audit, by disassembly |
| `heap_bound.py` | guest heap floor/ceiling from the asset corpus |
| `rtti_probe.py` | real RTTI chains, emitted as selftest cases |
| `coverage.py` | sweeps for verdicts with no implementation behind them |
| `eh_audit.py` | how the C++ EH boundary is actually reached |
| `build_selftest.py` + `selftest.c` | compile, link and run the layer |
| `include/isaac_host.h` | host ABI: layout constants, guest accessors, shim contract |
| `src/host_boot.c` | the 7-step boot procedure |
| `src/host_trap.c` | loud-stub engine + indirect-call dispatcher |
| `src/host_shims_crt.c` | high-traffic CRT shims |
| `src/host_shims_crtstartup.c` | the 16 imports on the path to `main` |
| `src/host_shims_heap.c` | guest allocator + heap high-water meter |
| `src/host_shims_cxx.c` | `__RTDynamicCast` over real MSVC RTTI |
| `src/host_shims_module.c` | module handles, `GetProcAddress`, kernel objects |
| `src/host_shims_misc.c` | depth-0/1 queue: strings, Fls/Tls, Steam, stdio, libm |
| `src/host_shims_forward.c` | musl/libc forwards + deterministic timing |
| `src/host_lua.c` | the 59-symbol Lua binding, trampolines, ABI gate |
| `lua_build.py` | Lua 5.3.3 wasm build with the measured flags |
| `src/host_gl_clientarrays.c` | client-side vertex array emulation |
| `generated/` | `shim_table.c`, `shim_decls.h`, `shim_weak.c` |

Artifacts (`output/recomp/host/`, gitignored): `boot-tables.json`,
`iat-slots.csv`, `initializers.csv`, `memimage.json`, `isaac.mem`,
`isaac.mem.br`, `isaac.segs.bin`, `isaac.data.wasm`, `shim-table.json`,
`memimage-verify.json`, `gl-census.json`, `gl-census2.json`,
`gl-legacy-audit.json`, `lua-abi.json`, `eh-audit.json`,
`build-selftest.json`, `selftest/`.

Tests: `tests/recomp-host.test.js`, 32 tests, all passing.

## 10. Open items, honestly

- **BOOT LOADS EVERY ASSET; NEXT WALL IS THE C++ IOSTREAM RUNTIME
  (2026-09-01, round 10).** The round-9 blocker had three parts, none of them
  in the archive code: (1) KAGE builds the mount-root index by a directory
  scan (`0x00a687f0` → readdir `0x00a172e0` → opendir `0x00a16f50`) that runs
  `mbstowcs_s → GetFullPathNameW → "\*" → FindFirstFileW / FindNextFileW →
  wcstombs_s`, and four of those shims were wrong or stubbed
  (`GetFullPathNameW` returned 0 for the size query, `FindFirstFileW` was a
  stub, `FindNextFileW`/`wcstombs_s` were weak defaults with an unknown
  stdcall purge — the call-site census could not see the register-held
  import); (2) the install is not only archives — 476 loose files under
  `resources/` (`.anm2`, shaders, Lua, xml) had never been seeded, and the
  RAM-FS capacity (512 slots, 128 per scan) could not hold them; (3) the
  function that creates the `resources/` mount root, `0x009ab970`, is one of
  this project's own emulator-era hand patches (`push ebp; mov ebp,esp` →
  `xor eax,eax; ret`), now undone by a re-applicable lift patch
  (`scripts/recomp/lift/lift_patches.py`). Result: 2 mount roots, 6 archives
  loaded, **0 `Could not open`**, all shaders initialise, renderbuffers
  allocate, OpenAL/theora initialise, `enums.lua`/`main.lua` run; the boot
  stops at `msvcp140.dll!basic_ios<char>::basic_ios()` from `0x00684d24`
  (a `std::stringstream` constructor, caller `0x0067f420`, right after
  `buttonpromptwidget.anm2` loads). Host selftest **82 → 103 checks, 0
  failures**, each new shim mutation-checked through `mutate.mjs`;
  `tests/recomp-host.test.js` 34/34. Also: `build_boot.py` links at `-O0`
  by default (474 s → 8 s; relink 520 s → 133 s; `--opt-link` for shipping),
  the boot must run with cwd = the instance dir (the host Lua module's libc
  is `-sNODERAWFS`), and `ISAAC_FS_TRACE=1` now logs the W probes. Full
  analysis: recomp-architecture.md §19. **Next unit:** the msvcp140 iostream
  subset (54 imports, 5 stream constructors; reference
  `C:\Windows\SysWOW64\msvcp140.dll`), or game-level overrides of the five
  consumers.
- **ROUND 11c / 12 (2026-09-02): the boot runs the frame loop.** The import
  census counts register-held IAT loads (`gen_shims.py` `regHeldLoads`): 27
  imports reachable only that way (LoadImageA, SendMessageA, GetDeviceCaps,
  GetRawInputDeviceList, TranslateMessage, PeekMessageA, curl_easy_setopt,
  lua_getstack, four EOS …) now have verdicts and purges; NEVER_CALLED shrank
  32 → 11, all genuinely dead. Every menu initialises and the main loop
  starts; its render-target validation reads back `GL_RENDERBUFFER_WIDTH/
  HEIGHT`, so the GL shim now stores renderbuffer sizes per name instead of
  answering 0 (which re-created a 1024² target every frame). `ISAAC_MAX_FRAMES`
  bounds a run (WM_QUIT through GLFW's own pump after N `SwapBuffers`).
  Selftest 136/0, `tests/recomp-host.test.js` 36/36. Details:
  recomp-architecture.md §21.8–§21.10.
- **ROUND 11 (2026-09-02): the boot reaches the viewport.** Four fixes,
  three of them corrections of round-10/10b conclusions (full analysis:
  recomp-architecture.md §20.3, §21):
  1. The "callee-saved register leak" was round 10b's own purge curation:
     msvcp140's `??0basic_iostream` / `??0basic_ostream` constructors pop a
     hidden `most_derived` int (vbase ctors), so the purges are 8 / 12 as
     the push-count sweep measured, not the decorated-name 4 / 8. The lifted
     `std::stringstream` ctor `0x00684ce0` under-popped and restored
     ebx/esi/edi one slot low (`edi` = `cookie ^ ebp` was the tell).
     `gen_shims.py` corrected, `PURGE_PATCHES` repairs the lifted tree,
     `tests/recomp-host.test.js` cross-checks both against the shim table.
  2. The instance is a ResourceExtractor dump (10,725 loose files at the
     install root), not a Steam layout; KAGE tries the archive index before
     a root's loose files, so round 10's restored `resources/` root made the
     stale small archives (config.a = Afterbirth+ `players.xml`) shadow the
     Repentance+ content. The `0x009ab970` lift patch is removed (canonical
     stub), the whole extracted tree is seeded (11,197 files, 243 MB),
     RAM-FS 16,384 slots.
  3. The six hand-written callees in `missing_fns.c` (CRT float/int
     conversions, `platform_name`) returned without emulating `ret`; each
     call left its return address on the guest stack. `rc_ret(s)` added,
     test-pinned.
  4. The fake Steam context is now an allow-list: only the two init-dance
     accessor slots (`0x00bf93c8`, `0x00c5c510`) get it, every other
     `SteamXxx()` reads NULL (the game's own no-Steam arm). Mods-init walked
     `ISteamUGC` +0x128 into a NULL vtable slot; the DLC check `0x009ef5c0`
     called `ISteamApps::BIsDlcInstalled` (+0x1c, pops 4) on a fake slot that
     pops 8 and came back with `edi = esi` — the "dead Sprite string" in Menu
     Save Init was `MenuManager + 0x1dc + 0x2f4`.
  New tool: the CRT noreturn shim dumps the last 512 VAs, live registers and
  the guest stack from ESP (`isaac_dump_trap_context`). Boot log now shows
  `players.xml` parsed from the loose copy (1,331 tokenizer stringstreams),
  every UI anm2, `Viewport: 960x540`, framebuffer/window metrics. Host
  selftest 130/0, `tests/recomp-host.test.js` 35/35. Tools added: runtime
  guest-memory watch (`ISAAC_WATCH`), `ISAAC_LOG_TIME` stamps, stack walks
  in both fault dumps (recomp-architecture.md §21.6); the 11-minute boot is
  567 s of PNG decoding in lifted code (§21.7).
- **(superseded, round 10) BOOT REACHES THE ARCHIVE MOUNT (2026-08-31, round 9).** The round-8
  lifter gap is closed (`sub_00ab2d80` and 46 other wide-varnode bodies now
  lift; recomp-architecture.md §17), the module relinks clean, and a seeded
  boot runs through **Steam + EOS init, GL 4.6.0, two `SwapBuffers`,
  libtheora/libvorbis, 31,423 guest heap allocations (peak 53.5 MiB — the
  heap is live for the first time), and the version banner
  `Repentance+ v1.9.7.17.J460`**, guard intact after `main`. It then fails to
  open every packed archive, 33 `AnmCache` loads fail behind that, and the
  HUD dereferences the null ANM2 at `0x009a26c2`
  (`guest read of 4 bytes at 0x30`).

  **Correction to the round-8 entry:** that entry called this a *re-open*
  failure. It is not. `ISAAC_FS_TRACE=1` shows the archives are **never
  `fopen`ed at all** — there is no earlier successful open. The complete FS
  probe list for a whole boot is 16 lines (save-dir setup,
  `savedatapath.txt`, `log.txt`, `kage_mount_points.dat` twice, two Lua
  scripts, `options.ini`); `resources/packed/animations.a` is never asked
  for.

  **Located exactly.** The failure is decided inside the guest before any
  I/O: `0x00a179c0` → `0x00a17180` → `0x00a16c60`, which resolves relative
  paths *only* through a per-mount-root `std::map` keyed by a path hash
  (`0x00a159d0`). Read back from the trapped run with `ISAAC_DUMP32`:
  the mount-root vector `[0x00c379e8]..[0x00c379ec]` holds **exactly one
  root** (`0x00d09ca4..0x00d09ca8`); that root's map at `0x00d09c30` has
  **`_Mysize == 0`**; the loaded-archive count `[0x00c37b14]` is **0**. The
  root is mounted unconditionally by `0x009abbd0` from the empty string at
  `0x00b1a4ec`, and mounting scans nothing (`0x00a16e00` is 54 instructions,
  no FS API). Nothing has ever populated the index.

  **Next unit — two threads, both in the guest:** (1) what fills a mount
  root's map; (2) the archive list `0x009aa040` walks at `[0x00bfae60]`,
  which has no writer in `.text`. `0x00a17180` also has an absolute
  drive-letter branch that bypasses the VFS entirely — a lever if the
  archive names can be made absolute. Full analysis:
  recomp-architecture.md §18. Logs: `output/recomp/lift/boot/run-fix1.log`
  (traced), `run-gu2.log` (untraced).

  **Tools added this round:** `ISAAC_FS_TRACE=1` logs every FS probe and its
  answer; `ISAAC_DUMP32=0xva:n,...` prints guest dwords after `main` traps,
  so an engine static can be read without a ~7-minute relink.

  **Also fixed:** `fs_key` never collapsed a `.` path segment, so the game's
  own `GetFileAttributesA("./")` cwd probe normalised to `c:/isaac/.` and
  missed. Fixed, mutation-checked, host selftest **77 → 82 checks, 0
  failures**. It is not the archive blocker and is recorded as its own fix.

  Rebuild: the lift invocation is recorded in
  `output/recomp/lift/gu/summary.json` (`argv`) and in
  recomp-architecture.md §17.6 — `--trace-va` and `--hand-written` are both
  load-bearing. A host-only change needs no re-lift: `build_boot.py` reuses
  the lifted objects (~16 s host compile + ~355 s link).

- **(superseded, round 8) BOOT REACHES THE ARCHIVE OPEN.** The round-8 entry described this as a re-open failure; §18 corrects that.

- **(superseded 2026-08-31) BOOT RUNS DEEP INTO ENGINE INIT.** After the two
  shim fixes below, a seeded boot passes win32 init, `ntdll!RtlVerifyVersionInfo`,
  all 117 CRT initialisers, Steam context (faked), the GL version parse
  ("4.6.0"), the CreateThread/CriticalSection stubs, and the game's own asset
  loader creating real textures from the seeded archives — then traps on an
  **undecoded lifted function `sub_00ab2d80`** (1 caller `0x00a96fb7`).
  Root cause is a lifter gap, not a shim: `output/recomp/lift/gu/failures.txt`
  says `wide op INT_SRIGHT size 4 unsupported`. 36 functions total are unlifted
  in the `gu` set (4 INT_SRIGHT, 6 INT_NEGATE, assorted wide ops). **Next
  unit:** add wide `INT_SRIGHT` (signed right shift) support to
  `scripts/recomp/lift/lift.py` and re-lift the 4 affected TUs (general fix),
  or hand-transcribe `sub_00ab2d80` (314 insns, a 5-way `edx` switch via jump
  table `0xab3108`) into `missing_fns.c`; then `build_boot.py` + re-run.
  Two shim fixes that got the boot this far:
  1. `gen_shims.py` never emitted its `DYNAMIC_EXPORTS` into `shim_table.c`, so
     `GetProcAddress("RtlVerifyVersionInfo")` returned 0 and the version gate
     called a NULL slot. Now 622 IAT + 101 dynamic = 723 imports emitted.
  2. `glGetIntegerv` returned 0 for `GL_MAX_TEXTURE_SIZE`, so the asset
     loader's image-size gate (`0x00a12d50`) rejected every texture. Now
     reports 16384 for the size caps.
- **BOOT BUILDS + SEEDS (2026-08-31).** `scripts/recomp/lift/build_boot.py` scripts the boot link for the first time (was the ad-hoc `link_prof.sh`): dispatch gen, host+entry+runtime+dispatch compile, reuse the `gu` lifted objects, link to an ES6 `boot.mjs` with `_isaac_fs_seed` exported (link exit 0, 271 MB). Two link fixes: `recomp_rt.h`'s `RECOMP_MEM_CHECK=0` branch was missing the `RECOMP_WATCH` no-op stub (broke any non-check TU); the selftest's `recomp_last_cpu`/`isaac_guest_longjmp` stubs are now `weak` so `recomp_rt.c` wins in the boot link. A seeded boot run (`node boot_integration.mjs main`) places 5 archives (graphics.a 17.5 MB, config/fonts/animations/rooms), keeps the guard intact through boot, and reaches a NEW trap in GLFW's win32 init (`0x00a80530`): the version gate calls `[0xc75adc]` = `ntdll.dll!RtlVerifyVersionInfo` unconditionally, but `GetProcAddress` returns 0 for it (no shim — `ntdll.dll` is registered as a handle, but this symbol has no implementation), so the slot is NULL and the call traps at `0x00a8102c`. The sibling DPI/xinput/dwmapi/shcore symbols in the same init ARE null-checked by GLFW and are fine to leave 0. **Next unit:** make `GetProcAddress("RtlVerifyVersionInfo")` resolve to a shim that returns the version-compare result for an emulated modern Windows, then `build_boot.py` (~442 s) and re-run to the next trap.
- **RAM-FS asset seeding — hook LANDED (2026-08-31), used at boot.**
  The empty shim FS made `Manager::LoadImage("gfx/ui/coop menu.png")` return
  NULL and the lifted HUD path fault at `0x009a26c2`. `isaac_fs_seed(path,
  data, len)` in `host_shims_fs.c` now places the packed archives as real
  files the game's own `fopen`/`fread` read back (KAGE parses them itself —
  it is NOT a fake LoadImage), with parent dirs materialised; proven by the
  selftest (§8: seed → GetFileAttributesA dir → fopen → fread byte-for-byte,
  5 checks). `boot_integration.mjs` seeds `graphics.a`/`config.a`/`fonts.a`/
  `animations.a`/`rooms.a` from the local instance before `main` **when the
  module exports `_isaac_fs_seed`**. The Aug-10 `boot.wasm` predates that
  export, so the next step is a **boot relink** that (a) compiles the current
  host `src/` tree, (b) adds `_isaac_fs_seed` to the boot link's
  `EXPORTED_FUNCTIONS`, (c) re-links against the lifted objects under
  `output/recomp/lift/full/`. That link recipe is not yet scripted (only the
  lifter build in `build_wasm.py` is); reconstructing it as
  `scripts/recomp/lift/build_boot.*` is the gating task before the boot can
  advance past the coop-menu trap to the next named one.
- **139 REAL shims are declared, not written.** They currently trap loudly,
  which is the correct failure mode but not a running game.
- **`arg_bytes` unknown for 15 symbols** — all with 0 measured call sites, so
  they trap rather than guess.
- **The shim ABI assumes the lifted code routes indirect calls through
  `isaac_indirect_call()`.** That contract has not been negotiated with the
  lifter agent and is the one interface here that could be wrong by assumption.
- **The boot path has not run against real lifted code.** The host layer
  compiles, links and runs (§8), but every step that transfers control to the
  guest — the TLS callback, the 121 initialisers, `main` — is exercised against
  an inert `isaac_guest_call`. Nothing has executed a lifted instruction. This
  includes the **Lua trampoline re-entry path**: the 59 bindings execute a real
  Lua module (§6.6), but a guest `lua_CFunction` firing still ends at the inert
  `isaac_guest_call`.
- **`GLOBAL_BASE` is contested** (§2.3): this layer uses `0x10000000`, the
  lifter uses `0x00d00000`. Both cannot ship. Needs arbitration.
- **The stdcall purge lives in one place only** (§3.5): if a lifted module is
  linked without this layer's `recomp_call_indirect`, all 315 stdcall imports
  desynchronise the guest stack.
