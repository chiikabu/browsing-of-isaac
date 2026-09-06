/* missing_fns.c -- STRONG implementations of lifted callees the lifter could
 * not decode (missing.txt).  Each one is transcribed instruction-by-instruction
 * from the PE and carries the evidence in its comment.  Weak placeholders for
 * these live in gu/stubs.c (they abort); these definitions win at link time.
 *
 * Contract: guest-callee ABI.  On entry [ESP] is the return address and
 * arguments are wherever the original function expected them (registers or
 * stack).  Registers that are not part of the contract must be preserved,
 * and the body MUST emulate the original's `ret`: pop the return address
 * into EIP and add 4 (+N for a `ret N`) to ESP -- exactly what a lifted
 * callee's epilogue does (`EIP = MEMR32(ESP); ESP += 4`).  Boot round 11:
 * every body below returned WITHOUT popping, so each call left its return
 * address on the guest stack; the caller's `mov esp, ebp` hid the drift
 * until its callee-saved pops read the leftover return addresses
 * (0x0098d560 handed esi/edi = 0x0098d7bc/0x0098d7cd back to the ambush
 * loader, whose vector<vector<T>> member then had `this` = 0x009b3d95).
 */


#include "isaac_host.h"
#include "shim_decls.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* The original's `ret`: consume the return address. */
void recomp_jump_indirect(CpuState *restrict s, uint32_t target);   /* host_trap.c */
static inline void rc_ret(CpuState *restrict s) {
    s->EIP = isaac_r32(s->ESP);
    s->ESP += 4u;
}

/* ---------------------------------------------------------------------- *
 * 0x00aa9350 -- const char *platform_name(void).  Six bytes:
 *
 *     mov eax, 0xb6d10c   ; -> "Windows" (.rdata)
 *     ret
 *
 * The controller-DB parser (sub_00a25770) reaches it INDIRECTLY as
 * `call dword ptr [0xc736e0]` at 0x00a25b36 -- the allocator slot written
 * by the win32-init copy loop at 0x00a812de.  Function recovery never
 * produced it (no direct caller, only a data/pointer reference), so the
 * dispatch table had no entry and the indirect call trapped.  Returns the
 * platform string; writes no flags; its `ret` pops the return address. */
void sub_00aa9350(CpuState *restrict s) {
    s->EAX = 0x00b6d10cu;
    rc_ret(s);
}

/* ---------------------------------------------------------------------- *
 * 0x00ae4820 -- libtheora's oc_restore_fpu for its MMX build: `emms; ret`
 * (3 bytes, then int3 padding). Reached only through the decoder's
 * cpu-dispatch table (`call eax` at 0x00add7af with eax = the table slot),
 * so function recovery never defined it and the first video (round 26,
 * ISAAC_CUTSCENE=300:3 -> 001_Epilogue.ogv) trapped on it 16 frames in.
 * There is no MMX state to clear here; the `ret` pops the return address. */
void sub_00ae4820(CpuState *restrict s) {
    rc_ret(s);
}

/* ---------------------------------------------------------------------- *
 * 0x00aefe80 -- int64 in {edx:ecx} -> double in xmm0.
 *
 *     cmp  dword ptr [0xc7162c], 6        ; SSE4.1 feature gate (BSS, 0)
 *     jl   0xaefe9a                       ; -> x87-style fallback
 *     vmovd xmm0, ecx
 *     vpinsrd xmm0, xmm0, edx, 1
 *     vcvtqq2pd xmm0, xmm0                ; (double)(int64){edx:ecx}
 *     ret
 *   fallback:
 *     xorps xmm1, xmm1
 *     cvtsi2sd xmm1, edx                  ; (double)(int32)hi
 *     xorps xmm0, xmm0
 *     cvtsi2sd xmm0, ecx                  ; (double)(int32)lo
 *     shr   ecx, 0x1f                     ; sign bit of lo
 *     mulsd xmm1, [0xb1a4e0]              ; * 2^32
 *     addsd xmm0, [ecx*8 + 0xb1a4d8]      ; + (lo<0 ? 2^32 : 0)
 *     addsd xmm0, xmm1
 *     ret
 *
 * The two paths are mathematically identical; the gate cell 0xc7162c sits
 * past .data's raw end (zero at load) and has no writer, so the fallback is
 * what runs unless the runtime sets it.  Both are implemented exactly.
 *
 * Returned in xmm0 = CpuState.ZMM0[0..7] (SSE regs map to ZMM0-7, low 16
 * bytes used).  No flags are written by the original. */
void sub_00aefe80(CpuState *restrict s) {
    uint32_t lo = s->ECX, hi = s->EDX;
    double d;
    if ((int32_t)isaac_r32(0x00c7162cu) >= 6) {
        int64_t v = ((int64_t)(uint64_t)(uint32_t)hi << 32) | (uint64_t)lo;
        d = (double)v;
    } else {
        double dlo = (double)(int32_t)lo
                   + ((lo & 0x80000000u) ? 4294967296.0 : 0.0);
        double dhi = (double)(int32_t)hi * 4294967296.0;
        d = dlo + dhi;
    }
    memcpy(&s->ZMM0[0], &d, 8);
    memset(&s->ZMM0[8], 0, 8);
    rc_ret(s);
}

/* ---------------------------------------------------------------------- *
 * The CRT conversion family (all gated on the same zero-at-load BSS cell
 * 0xc7162c: 2 reads / 0 writers by linear census -- the fallback paths
 * below are what actually runs in this build).  Every result is bit-exact
 * to the original's fallback arithmetic (and to the SSE4.1 path, which
 * computes the same value).  No C float->int casts are used: wasm i32/i64
 * trunc instructions TRAP out of range, so all integer results are built
 * from the bit fields directly.
 */

static uint32_t rc_feature_gate(void) {
    return (uint32_t)((int32_t)isaac_r32(0x00c7162cu) >= 6);
}

/* 0x00aefca0 -- float (xmm0 low 4) -> uint32 EAX.
 *     feature: vcvttss2usi eax, xmm0
 *     fallback: bit-exact via the FP bit fields (see PE transcription):
 *        neg & |v|>=1   -> 0xFFFFFFFF;   neg & |v|<1 -> 0
 *        0 <= v < 2^31  -> trunc(v)      (cvttss2si)
 *        2^31 <= v<2^32 -> 0x80000000 | mant<<8
 *        v >= 2^32, NaN, inf -> 0xFFFFFFFF */
void sub_00aefca0(CpuState *restrict s) {
    uint32_t bits;
    memcpy(&bits, &s->ZMM0[0], 4);
    uint32_t exp = (bits >> 23) & 0xffu, mant = bits & 0x7fffffu;
    uint32_t eax;
    if (bits & 0x80000000u) {
        eax = (exp < 0x7fu) ? 0u : 0xFFFFFFFFu;
    } else if (exp < 0x9eu) {
        if (exp < 0x7fu) eax = 0;
        else {
            int32_t sh = (int32_t)(23u - (exp - 0x7fu));
            eax = (sh >= 0) ? ((0x800000u | mant) >> sh)
                            : ((0x800000u | mant) << -sh);
        }
    } else if (exp == 0x9eu) {
        eax = 0x80000000u | (mant << 8);
    } else {
        eax = 0xFFFFFFFFu;
    }
    (void)rc_feature_gate();   /* both paths agree; fallback is exact */
    s->EAX = eax;
    rc_ret(s);
}

/* 0x00aefcf0 -- double (xmm0 low 8) -> uint32 EAX.
 *     fallback mirrors 0x00aefca0 with 52-bit mantissa and the 0x41e/0x41f
 *     exponent thresholds. */
void sub_00aefcf0(CpuState *restrict s) {
    uint64_t bits;
    memcpy(&bits, &s->ZMM0[0], 8);
    uint32_t exp = (uint32_t)((bits >> 52) & 0x7ffu);
    uint64_t mant = bits & 0xfffffffffffffull;
    uint32_t eax;
    if (bits & (1ull << 63)) {
        eax = (exp < 0x3ffu) ? 0u : 0xFFFFFFFFu;
    } else if (exp < 0x41eu) {
        if (exp < 0x3ffu) eax = 0;
        else {
            int32_t sh = (int32_t)(52u - (exp - 0x3ffu));
            uint64_t one = 0x10000000000000ull;
            eax = (sh >= 0) ? (uint32_t)((one | mant) >> sh)
                            : (uint32_t)((one | mant) << -sh);
        }
    } else if (exp == 0x41eu) {
        eax = 0x80000000u | (uint32_t)(mant >> 21);
    } else {
        eax = 0xFFFFFFFFu;
    }
    s->EAX = eax;
    rc_ret(s);
}

/* 0x00aefd70 -- double (xmm0 low 8) -> uint64 {edx:eax}.
 *     fallback: v < 2^31 -> cvttsd2si zero-extended;
 *       2^31..2^64-1 via the 0x433 shift trick over the 53-bit integer
 *       mantissa (right shift by 0x433-exp, left by exp-0x433 below 12);
 *       negative |v|<1 -> 0; negative larger, NaN, inf, overflow -> -1. */
void sub_00aefd70(CpuState *restrict s) {
    uint64_t bits;
    memcpy(&bits, &s->ZMM0[0], 8);
    uint32_t exp = (uint32_t)((bits >> 52) & 0x7ffu);
    uint64_t mant = bits & 0xfffffffffffffull;
    uint64_t r;
    if (bits & (1ull << 63)) {
        r = (exp < 0x3ffu) ? 0ull : 0xFFFFFFFFFFFFFFFFull;
    } else if (exp < 0x41eu) {
        if (exp < 0x3ffu) r = 0;
        else {
            int32_t sh = (int32_t)(52u - (exp - 0x3ffu));
            uint64_t one = 0x10000000000000ull;
            r = (sh >= 0) ? ((one | mant) >> sh) : ((one | mant) << -sh);
        }
    } else if (exp <= 0x433u) {
        r = (0x10000000000000ull | mant) >> (0x433u - exp);
    } else if (exp - 0x433u < 12u) {
        r = (0x10000000000000ull | mant) << (exp - 0x433u);
    } else {
        r = 0xFFFFFFFFFFFFFFFFull;
    }
    s->EAX = (uint32_t)r;
    s->EDX = (uint32_t)(r >> 32);
    rc_ret(s);
}

/* 0x00aefe20 -- uint64 {ecx:edx} -> double xmm0 (unsigned twin of 0x00aefe80).
 *     vcvtuqq2pd; fallback: (double)(int32)lo + sgn(lo)*2^32
 *                   + ((double)(int32)hi + sgn(hi)*2^32) * 2^32 */
void sub_00aefe20(CpuState *restrict s) {
    uint32_t lo = s->ECX, hi = s->EDX;
    double d = (double)(int32_t)lo + ((int32_t)lo < 0 ? 4294967296.0 : 0.0);
    if (hi) {
        double dhi = (double)(int32_t)hi + ((int32_t)hi < 0 ? 4294967296.0 : 0.0);
        d += dhi * 4294967296.0;
    }
    memcpy(&s->ZMM0[0], &d, 8);
    memset(&s->ZMM0[8], 0, 8);
    rc_ret(s);
}

/* ---------------------------------------------------------------------- *
 * 0x0069d1f0 -- an adjustor thunk (8 bytes):
 *
 *     add ecx, 4
 *     jmp 0x40d040            ; the destructor proper
 *
 * Registered with atexit (`push 0x69d1f0` at 0x006f11c9 / 0x008296be /
 * 0x00afb4c4) and reached from unwind funclets; never in the lifter's
 * function set (the function-start scan absorbed it), so the first clean
 * shutdown (boot round 12, WM_QUIT after ISAAC_MAX_FRAMES) trapped on it as
 * "neither a host shim nor a lifted function". It TAIL-JUMPS: no ret of its
 * own -- the destructor's ret pops the caller's return address. */
void sub_0069d1f0(CpuState *restrict s) {
    s->ECX += 4u;
    recomp_jump_indirect(s, 0x0040d040u);
}

/* ---------------------------------------------------------------------- *
 * Lifter-runtime symbols the STANDALONE host selftest link lacks.
 *
 * In the real boot module these live in scripts/recomp/lift/recomp_rt.c,
 * which the lifted-object link pulls in. The host-layer selftest
 * (scripts/recomp/host/build_selftest.py) links only the host src/ tree,
 * so without these two the link fails on undefined symbols — which had
 * gone dark since the crtstartup/trap files began referencing them. The
 * selftest never triggers a guest longjmp or a live fault dump, so inert
 * definitions are correct for it and are overridden by recomp_rt.c's
 * strong versions in the real boot build. */

/* Set by the shim dispatcher (host_trap.c) for the fault register dump.
 * Weak so recomp_rt.c's strong definition wins in the boot link. */
__attribute__((weak)) struct CpuState *recomp_last_cpu;

/* ---------------------------------------------------------------------- *
 * 0x00a67fd0 -- a six-byte element destructor (boot round 12d):
 *     c7 01 ac 04 ba 00   mov dword ptr [ecx], 0x00ba04ac
 *     c3                  ret
 * Not a Ghidra function: it is only reached through the CRT's array
 * destructor iterator __ehvec_dtor (0x00aef638), which gets it as the
 * `dtor` argument at 0x00a68193 (`push 0xa67fd0; push [esi-4]; push 0x14;
 * push esi; call 0xaef638`) for the 0x14-byte objects built by __ehvec_ctor
 * at 0x00a68048 (ctor 0x00a67fa0, dtor 0x00a67fd0). It restores the base
 * vptr and returns; the first shutdown that got past ~Thread reached it as
 * an unlifted indirect target from 0x00aef679. __thiscall, no arguments:
 * plain ret. */
void sub_00a67fd0(CpuState *restrict s) {
    isaac_w32(s->ECX, 0x00ba04acu);
    rc_ret(s);
}

/* The lifted code's executed-VA ring (RECOMP_VA markers), read by
 * isaac_dump_trap_context (host_trap.c). Inert in the standalone selftest;
 * recomp_rt.c's strong definitions win in the boot link. */
__attribute__((weak)) volatile uint32_t recomp_va_trace[512];
__attribute__((weak)) volatile uint32_t recomp_va_trace_idx;
__attribute__((weak)) double recomp_last_log_ms;
__attribute__((weak)) void recomp_profile_report(void) {}
__attribute__((weak)) void isaac_dispatch_report(void) {}   /* dispatch_tbl.c in the boot link */
__attribute__((weak)) uint32_t isaac_dispatch_calls(void) { return 0u; }
__attribute__((weak)) void isaac_guest_jmp_save(void *dst) { (void)dst; }        /* dispatch_tbl.c */
__attribute__((weak)) void isaac_guest_jmp_restore(const void *src) { (void)src; }
__attribute__((weak)) uint32_t g_reentry_eip;  /* ditto; the no-progress guard in recomp_run_pending reads it */
__attribute__((weak)) const uint32_t g_dva[1] = {0};
__attribute__((weak)) const uint32_t g_ndispatch = 0;

/* Guest longjmp unwind to isaac_guest_call. The standalone selftest has no
 * guest call frame to unwind to; reaching here in that build is a defect,
 * so fail loudly rather than silently returning. Weak so dispatch_tbl.c's
 * setjmp-backed definition wins in the boot link. */
__attribute__((weak)) void isaac_guest_longjmp(CpuState *restrict cpu) {
    (void)cpu;
    fprintf(stderr,
            "[selftest] isaac_guest_longjmp reached in the host-only build\n");
    abort();
}
