/* isaac_host.h -- host boundary for the static x86 -> wasm recompilation.
 *
 * ADDRESSING MODEL: IDENTITY.
 * Guest VA == wasm linear-memory byte offset. The PE image occupies
 * [0x00400000, 0x00cfe000). A guest pointer is therefore directly
 * dereferenceable from C once the module's linear memory starts at 0, so no
 * marshalling layer exists anywhere in this file -- that is deliberate, and it
 * is the single most important property to preserve when editing.
 *
 * REQUIRED LINK FLAG: the host's own static data must live BELOW the image.
 *   emcc ... -sGLOBAL_BASE=0x1000 -sSTACK_SIZE=... -sINITIAL_MEMORY=<>=13631488>
 * with all host allocations confined to [0x1000, 0x400000). If host data is
 * allowed to land at/above 0x400000 it will silently overwrite guest .text and
 * the failure will look like a lifter bug. There is a runtime assertion for
 * this in isaac_boot_init().
 *
 * NO SILENT STUBS. Every imported symbol resolves to *something* at boot; an
 * unimplemented one resolves to a trap that logs its name and call site the
 * first time it is reached. A shim that returns 0 without saying so is how the
 * predecessors of this project shipped green lies.
 */

#ifndef ISAAC_HOST_H
#define ISAAC_HOST_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------------------------------------------------------------- layout -- */

#define ISAAC_IMAGE_BASE   0x00400000u
#define ISAAC_IMAGE_SIZE   0x008fe000u          /* SizeOfImage, measured      */
#define ISAAC_IMAGE_END    (ISAAC_IMAGE_BASE + ISAAC_IMAGE_SIZE)

#define ISAAC_TEXT_VA      0x00401000u
#define ISAAC_RDATA_VA     0x00b18000u
#define ISAAC_DATA_VA      0x00bf8000u
#define ISAAC_IAT_VA       0x00b18000u          /* 650 slots, 2600 bytes      */
#define ISAAC_IAT_SLOTS    650u

#define ISAAC_ENTRY_VA     0x00aefc46u
#define ISAAC_SCRT_MAIN_VA 0x00aefac4u
#define ISAAC_MAIN_VA      0x00931050u

/* Static-initialiser tables, recovered from __scrt_common_main_seh.
 * Section-name ordering inside .CRT puts XC below XI in memory, but XI runs
 * FIRST -- see isaac_boot_run_initterms(). */
#define ISAAC_XI_START_VA  0x00b18c10u          /* .CRT$XI*  C   inits, 4     */
#define ISAAC_XI_END_VA    0x00b18c24u
#define ISAAC_XC_START_VA  0x00b18a2cu          /* .CRT$XC*  C++ inits, 117   */
#define ISAAC_XC_END_VA    0x00b18c04u
#define ISAAC_TLS_CB_VA    0x00b18c2cu          /* .CRT$XL*  callback array   */
#define ISAAC_TLS_INDEX_VA 0x00c71628u

/* ------------------------------------------------------- ADDRESS-SPACE MAP --
 *
 * THE RULE: everything the guest can write is BELOW ISAAC_GUEST_LIMIT_VA;
 * everything the host owns is ABOVE ISAAC_HOST_BASE_VA; a 1 MiB guard sits
 * between them and is never touched by either.
 *
 * This is not tidiness. There is ~7 MB of mechanically lifted code, and the
 * lifter has already seen a single wild guest write corrupt the dispatch table
 * mid-run and produce 1,429 downstream failures that were pure cascade damage.
 * A guest crash is debuggable; a corrupted dispatch table produces nonsense a
 * hundred calls later. So host state has to be somewhere a plausible wild guest
 * pointer does not reach.
 *
 * Which side the host goes on is decided by the most likely structured
 * failure: a buffer overrun off the end of .data walks UPWARD from 0x00cfe000.
 * Host state must therefore not sit immediately above the image -- an overrun
 * would land in it on the first step. Guest-owned memory goes there instead,
 * where an overrun corrupts the guest and produces a guest-shaped crash.
 *
 *   0x00000000  +-------------------------------+
 *               | null guard - never mapped     |  catches null+offset derefs
 *   0x00400000  +-------------------------------+
 *               | PE image (identity addressed) |  .text .rdata .data .rsrc
 *   0x00cfe000  +-------------------------------+
 *   0x00d00000  | guest heap (VirtualAlloc)     |  192 MiB
 *   0x0cd00000  +-------------------------------+
 *               | (spare)                       |
 *   0x0def0000  | guest stack (1 MiB, grows dn) |  = PE StackReserve, measured
 *   0x0dff0000  +-------------------------------+
 *   0x0e000000  | fake TEB / PEB / TLS array    |  guest-visible, host-written
 *   0x0f000000  | shim tokens, 622 x 16 bytes   |  guest-visible, host-written
 *   0x0ff00000  +===============================+  <- ISAAC_GUEST_LIMIT_VA
 *               | GUARD - 1 MiB, never touched  |
 *   0x10000000  +===============================+  <- ISAAC_HOST_BASE_VA
 *               | HOST ONLY: emscripten statics |  -sGLOBAL_BASE=268435456
 *               | 14.2 MB VA->fn dispatch table |
 *               | CpuState, host stack, malloc  |
 *               +-------------------------------+
 *
 * The TEB and the shim tokens are deliberately on the GUEST side: the guest
 * holds pointers to both (fs:[0] and the IAT), so they must be addressable by
 * it. They are host-written but guest-readable, and corrupting them breaks the
 * guest, not the runtime.
 */
/* Round 24f grew the guest heap from 192 MiB to 768 MiB: the game preloads its
 * whole sound catalogue -- 1,557 WAV samples, 269 MB of PCM once the DLC
 * archives are mounted -- and the old arena ran out at 201 MB live.
 *
 * Round 66 took it to 512 MiB and round 69 to 384 on the engine's own evidence. The arena is
 * committed with the wasm memory, so its size is resident bytes on every
 * machine that opens the page, and the high-water report in host_shims_heap.c
 * peaks at 350.1 MiB -- the same figure after 900, 4,000 and 6,000 frames,
 * because the catalogue is nearly all of it and it is preloaded at boot. 512
 * leaves 162 MiB of deliberate headroom and takes INITIAL_MEMORY from 1088 MiB
 * to 832. The host base (-sGLOBAL_BASE) is 0x24000000; build_boot.py /
 * build_selftest.py carry the same number, recomp_rt.h's RECOMP_GUEST_LIMIT
 * matches it, and INITIAL_MEMORY clears it. */
#define ISAAC_SHIM_BASE       0x1b000000u       /* one 16-byte slot per import */
#define ISAAC_SHIM_STRIDE     16u
#define ISAAC_TEB_VA          0x1a000000u       /* fake TEB                    */
#define ISAAC_PEB_VA          0x1a001000u
#define ISAAC_TLS_ARRAY_VA    0x1a002000u       /* TEB+0x2c expansion slots */
#define ISAAC_TLS_BLOCK_VA    0x1a003000u       /* TLS block copy, index 0   */
#define ISAAC_TLS_BLOCK_SIZE  0x400u
#define ISAAC_HEAP_VA         0x00d00000u       /* VirtualAlloc arena          */
#define ISAAC_HEAP_SIZE       0x18000000u       /* 384 MiB                     */
#define ISAAC_STACK_TOP_VA    0x19ff0000u       /* guest stack grows down      */
#define ISAAC_STACK_SIZE      0x00100000u       /* PE StackReserve, measured   */

/* Module handles and kernel-object handles. Guest-side, because the guest holds
 * them, but in ranges nothing else uses so a stray handle is recognisable. */
#define ISAAC_MODULE_BASE     0x1a010000u       /* HMODULE tokens, stride 0x1000 */
#define ISAAC_MODULE_STRIDE   0x1000u
#define ISAAC_HANDLE_BASE     0x1a030000u       /* kernel objects, stride 16     */
#define ISAAC_HANDLE_STRIDE   16u

#define ISAAC_GUEST_LIMIT_VA  0x1bf00000u       /* nothing guest above this    */
#define ISAAC_GUARD_VA        0x1bf00000u
#define ISAAC_GUARD_SIZE      0x00100000u
#define ISAAC_HOST_BASE_VA    0x1c000000u       /* -sGLOBAL_BASE=469762048     */

/* True if `va` is somewhere the guest is allowed to touch. Host code uses this
 * to reject a guest-supplied pointer before dereferencing it. */
static inline int isaac_is_guest_va(uint32_t va) {
    return va < ISAAC_GUEST_LIMIT_VA;
}

/* ------------------------------------------------------- guest accessors -- */
/* Identity addressing makes these casts, not conversions. They exist so that
 * intent is greppable and so a future non-identity mode has one place to change. */

static inline void *isaac_g(uint32_t va) { return (void *)(uintptr_t)va; }
static inline uint32_t isaac_va(const void *p) { return (uint32_t)(uintptr_t)p; }

static inline uint32_t isaac_r32(uint32_t va) { return *(const uint32_t *)isaac_g(va); }
static inline void isaac_w32(uint32_t va, uint32_t v) { *(uint32_t *)isaac_g(va) = v; }
static inline uint16_t isaac_r16(uint32_t va) { return *(const uint16_t *)isaac_g(va); }
static inline void isaac_w16(uint32_t va, uint16_t v) { *(uint16_t *)isaac_g(va) = v; }
static inline uint8_t isaac_r8(uint32_t va) { return *(const uint8_t *)isaac_g(va); }

static inline int isaac_in_image(uint32_t va) {
    return va >= ISAAC_IMAGE_BASE && va < ISAAC_IMAGE_END;
}

/* --------------------------------------------------------------- CPU/ABI -- */
/* THE CPU STATE IS THE LIFTER'S, NOT OURS.
 *
 * scripts/recomp/lift/ generates recomp_state.h from the SLEIGH x86:LE:32
 * register set and every lifted function has the signature
 *     void sub_XXXXXXXX(CpuState *restrict s);
 * Defining a second, parallel register struct here would be two mechanisms
 * that happen to agree today, so this file uses the lifter's struct directly.
 * `isaac_cpu` is an alias kept only so the shim sources read consistently.
 *
 * The fallback definition below is used only when building the host layer
 * standalone (unit tests, compile checks) with no lifted module present. It
 * mirrors the generated field names exactly -- EAX/ESP/EIP/FS_OFFSET, not
 * eax/esp/eip/fs_base -- so a standalone build cannot drift from the real one.
 */
#if defined(__has_include)
#  if __has_include("recomp_state.h")
#    include "recomp_state.h"
#    define ISAAC_HAVE_LIFTER_STATE 1
#  endif
#endif

#ifndef ISAAC_HAVE_LIFTER_STATE
typedef struct CpuState {
    uint32_t EAX, ECX, EDX, EBX, ESP, EBP, ESI, EDI;
    uint16_t ES, CS, SS, DS, FS, GS;
    uint32_t FS_OFFSET, GS_OFFSET;
    uint8_t  CF, F1, PF, F3, AF, F5, ZF, SF, TF, IF, DF, OF;
    uint8_t  IOPL, NT, F15, RF, VM, AC, VIF, VIP, ID;
    uint32_t eflags;
    uint32_t EIP;
    /* Field names and sizes mirror the generated struct exactly. The SIMD and
     * x87 registers matter here because some CRT helpers use a REGISTER
     * calling convention: the _libm_sse2_*_precise family passes its argument
     * in XMM0, which is the low 8 bytes of ZMM0. */
    uint8_t  ST0[10], ST1[10], ST2[10], ST3[10];
    uint8_t  ST4[10], ST5[10], ST6[10], ST7[10];
    uint8_t  ZMM0[64], ZMM1[64], ZMM2[64], ZMM3[64];
} CpuState;
#endif

typedef CpuState isaac_cpu;

/* Argument N of a stdcall/cdecl call, counting from 0. At shim entry the guest
 * stack is [ESP]=return address, [ESP+4]=arg0, ... */
static inline uint32_t isaac_arg(const isaac_cpu *c, unsigned n) {
    return isaac_r32(c->ESP + 4u + 4u * n);
}
static inline uint32_t isaac_retaddr(const isaac_cpu *c) { return isaac_r32(c->ESP); }
static inline double isaac_arg_f64(const isaac_cpu *c, unsigned n) {
    double d;
    uint32_t lo = isaac_arg(c, n), hi = isaac_arg(c, n + 1);
    uint64_t u = ((uint64_t)hi << 32) | lo;
    __builtin_memcpy(&d, &u, 8);
    return d;
}
static inline void isaac_ret64(isaac_cpu *c, uint64_t v) {
    c->EAX = (uint32_t)v;
    c->EDX = (uint32_t)(v >> 32);
}

typedef void (*isaac_shim_fn)(isaac_cpu *restrict cpu);

typedef enum isaac_verdict {
    ISAAC_V_REAL = 0,      /* hand-written host implementation              */
    ISAAC_V_PROVIDED,      /* forwarded to musl/libc++/WebGL/OpenAL/Lua     */
    ISAAC_V_STUB,          /* deliberately inert, but LOUD on first call    */
    ISAAC_V_UNIMPLEMENTED, /* not written yet -- traps                      */
    ISAAC_V_NEVER_CALLED   /* 0 call sites measured; traps if ever reached  */
} isaac_verdict;

typedef struct isaac_import {
    const char    *dll;
    const char    *symbol;
    uint32_t       iat_slot_va;   /* where the boot path writes shim_va      */
    uint32_t       shim_va;       /* the token installed into the IAT slot   */
    uint16_t       arg_bytes;     /* stdcall purge; 0 for cdecl              */
    uint8_t        is_stdcall;
    uint8_t        verdict;       /* isaac_verdict                           */
    uint32_t       call_sites;    /* measured, for triage ordering           */
    isaac_shim_fn  fn;
} isaac_import;

extern isaac_import isaac_imports[];
extern const unsigned isaac_import_count;

/* ------------------------------------------------------- loud stub engine -- */

void isaac_log(const char *fmt, ...);
/* Report + continue. Fires once per symbol, then counts silently. */
void isaac_stub_hit(const isaac_import *imp, const isaac_cpu *cpu);
/* Report + abort. For imports whose result cannot be faked. */
void isaac_trap(const isaac_import *imp, const isaac_cpu *cpu) __attribute__((noreturn));
/* Dump every stub that was reached, with counts. Call at exit / from JS. */
void isaac_stub_report(void);
/* Everything that resolved to NULL: module names not present, and symbols
 * GetProcAddress could not supply. Printed at exit and on demand. */
void isaac_module_report(void);
/* Orderly teardown: runs atexit callbacks, prints every report, and returns.
 * Used instead of abort() so the real failure is the last thing on screen. */
void isaac_shutdown(const char *reason);

#define ISAAC_STUB_ONCE(imp, cpu)  isaac_stub_hit((imp), (cpu))

/* ------------------------------------------------------------------ boot -- */

typedef struct isaac_boot_opts {
    int   apply_relocations;   /* 0 = map at preferred base (correct here)   */
    int   run_tls_callbacks;
    int   run_initterms;
    int   verbose;
} isaac_boot_opts;

int  isaac_boot_init(const isaac_boot_opts *opts);   /* steps 1-6, stops before main */
int  isaac_boot_bind_iat(void);                      /* step 3                       */
void isaac_boot_install_teb(void);                   /* step 4                       */
int  isaac_boot_run_tls(void);                       /* step 5                       */
int  isaac_boot_run_initterms(void);                 /* step 6                       */
int  isaac_boot_call_main(int argc, char **argv);    /* step 7                       */

/* Transfers control to a guest VA. Implemented over the lifter's VA -> wasm
 * function dispatch table (dispatch_tbl.h: g_dva/g_dfn). */
static inline const char *isaac_guest_cstr(uint32_t va, char *buf,
                                            size_t cap, const char *what) {
    /* Bounded guest->host string copy. Returns NULL when the pointer is not a
     * readable guest address (or runs past the limit). */
    if (cap < 2) return NULL;
    size_t n = 0;
    if (!va || !isaac_is_guest_va(va)) {
        isaac_log("[isaac][crt] %s: name pointer 0x%08x outside guest space",
                  what, va);
        return NULL;
    }
    while (n + 1 < cap) {
        uint8_t c = isaac_r8(va + (uint32_t)n);
        buf[n++] = (char)c;
        if (!c) return buf;
        if (!isaac_is_guest_va(va + (uint32_t)n)) {
            isaac_log("[isaac][crt] %s: string at 0x%08x runs past the guest "
                      "limit", what, va);
            return NULL;
        }
    }
    buf[cap - 1] = 0;
    return buf;
}

extern uint32_t isaac_guest_alloc(uint32_t n);
extern void     isaac_guest_free(uint32_t p);
extern uint32_t isaac_guest_realloc(uint32_t p, uint32_t n);
extern void isaac_guest_call(uint32_t va, isaac_cpu *cpu);

/* THE INDIRECT-CALL CONTRACT (shared with scripts/recomp/lift/).
 *
 * The lifter resolves `call dword ptr [IAT slot]` at LIFT time into a direct
 * call to imp_<dll>__<symbol>(CpuState*), so the common case never reads the
 * IAT at runtime. But code also takes the address of an import
 * (`mov eax, [__imp_X]; call eax` -- measured, e.g. at 0x00a24ce2), and those
 * values flow into recomp_call_indirect() as ordinary 32-bit VAs. So the bytes
 * the boot path writes into the 650 IAT slots must be resolvable there too.
 *
 * isaac_resolve_shim() is that hook. recomp_call_indirect() must try it BEFORE
 * the VA -> wasm function table, because shim tokens live at 0x0F000000 and are
 * deliberately outside the image, where the function table has no entry.
 *
 * Returns the shim for a token, or NULL if `target` is an ordinary guest VA. */
isaac_import *isaac_resolve_shim(uint32_t target);

/* Runs the shim and performs the callee's own `ret [N]`. Returns 1 if handled. */
int isaac_indirect_call(uint32_t target, isaac_cpu *cpu);

/* The host-side GL cache (host_gl_cache.c, round 37): renderbuffer
 * parameters, framebuffer completeness and program locations answered from
 * what the game set, so the web build skips the synchronous GL queries. */
void isaac_glc_rb_bind(uint32_t name);
void isaac_glc_rb_storage(uint32_t fmt, uint32_t w, uint32_t h, uint32_t samples);
void isaac_glc_rb_delete(uint32_t name);
int  isaac_glc_rb_param(uint32_t pname, uint32_t *out);
void isaac_glc_tex_active(uint32_t unit);
void isaac_glc_tex_bind(uint32_t target, uint32_t name);
void isaac_glc_tex_image(uint32_t target);
void isaac_glc_tex_delete(uint32_t name);
void isaac_glc_fbo_bind(uint32_t target, uint32_t name);
void isaac_glc_fbo_attach(uint32_t target, uint32_t attachment, uint8_t kind, uint32_t name, uint32_t extra);
void isaac_glc_fbo_delete(uint32_t name);
int  isaac_glc_fbo_status(uint32_t target, uint32_t *status);
void isaac_glc_fbo_set_status(uint32_t target, uint32_t status);
int  isaac_glc_loc_get(uint32_t prog, uint8_t kind, const char *name, int32_t *loc);
void isaac_glc_loc_put(uint32_t prog, uint8_t kind, const char *name, int32_t loc);
void isaac_glc_loc_flush(uint32_t prog);
void isaac_glc_count_readpixels(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t fmt, uint32_t bpp);
void isaac_glc_report(void);
void isaac_glc_reset(void);
/* Round 49: stb_vorbis's imdct butterfly, bit-exact on guest memory (host_fastpath.c) */
void isaac_fast_imdct_r_loop(uint32_t lim, uint32_t e_va, uint32_t d0, uint32_t k_off, uint32_t a_va, uint32_t k1);
void isaac_fast_imdct_r_loop_range(uint32_t lim, uint32_t e_va, uint32_t d0, uint32_t k_off, uint32_t *lo, uint32_t *len);
int  isaac_fast_imdct_r_loop_ok(uint32_t lim, uint32_t e_va, uint32_t d0, uint32_t k_off, uint32_t a_va, uint32_t k1, uint32_t *lo, uint32_t *len);
void isaac_fast_inverse_mdct(uint32_t buf_va, uint32_t n, uint32_t f_va, uint32_t bt);   /* round 50 */
int  isaac_fast_inverse_mdct_ok(uint32_t buf_va, uint32_t n, uint32_t f_va, uint32_t bt);
int  isaac_editfile_gate(uint32_t menu_va);   /* round 52 */
void isaac_gl_quad_census(uint32_t *quad_draws, uint32_t *other_blocks, uint32_t *pattern);   /* round 53 */

#ifdef __cplusplus
}
#endif
#endif /* ISAAC_HOST_H */
