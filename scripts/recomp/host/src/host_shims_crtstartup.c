/* host_shims_crtstartup.c -- the 16 imports between a linked module and main().
 *
 * The lifter's survey build established the exact ordered set the boot path
 * demands. All sixteen are CRT startup; fifteen have single-digit call-site
 * counts. None is a graphics, audio, Steam or Lua entry point.
 *
 * Discipline is unchanged: nothing here returns a plausible value silently.
 * Where a correct implementation is impossible in a browser, the failure is
 * loud rather than approximated.
 *
 * CRT globals the guest holds pointers to live in guest-visible memory, because
 * the guest dereferences what __p__commode() returns. They sit in the TEB page,
 * which is on the guest side of the guard by design.
 */

#include "isaac_host.h"
#include "shim_decls.h"

/* isaac_guest_call's longjmp guard (dispatch_tbl.c) */
void isaac_guest_longjmp(CpuState *restrict cpu);

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* CRT global cells, guest-visible. The TEB page already hosts errno (+0x800)
 * and the three pseudo-FILE blocks (+0x900..+0x9c0). */
#define CRT_COMMODE_VA   (ISAAC_TEB_VA + 0xA00)
#define CRT_FMODE_VA     (ISAAC_TEB_VA + 0xA04)
#define CRT_APPTYPE_VA   (ISAAC_TEB_VA + 0xA08)
#define CRT_UEF_VA       (ISAAC_TEB_VA + 0xA0C)  /* unhandled exception filter */

/* _O_TEXT. MSVC's default _fmode; the CRT reads it for stdio translation. */
#define O_TEXT   0x4000
#define O_BINARY 0x8000

/* MSVC's _CW_DEFAULT: round-to-nearest, 53-bit precision, all exceptions
 * masked. The lifter measured that this binary never executes `fldcw`, so the
 * x87 control word is fixed for the whole run and this value is simply what
 * the CRT expects to read back. */
#define CW_DEFAULT 0x0008001Fu

/* ------------------------------------------------------------ #1 ---------- */
/* void _set_app_type(int at)   _crt_unknown_app=0, _crt_console_app=1,
 *                              _crt_gui_app=2
 * Purely informational to the CRT: it selects the abort()/assert() reporting
 * style. Recording it is the whole implementation. */
void imp_api_ms_win_crt_runtime___set_app_type(CpuState *restrict cpu) {
    isaac_w32(CRT_APPTYPE_VA, isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #2 ---------- */
/* errno_t _set_fmode(int mode)  -- sets the global default file translation
 * mode used by fopen when the mode string says neither "t" nor "b". */
void imp_api_ms_win_crt_stdio___set_fmode(CpuState *restrict cpu) {
    uint32_t mode = isaac_arg(cpu, 0);
    if (mode != O_TEXT && mode != O_BINARY) {
        isaac_log("[isaac][crt] _set_fmode(0x%x): not _O_TEXT or _O_BINARY; "
                  "EINVAL (caller 0x%08x)", mode, isaac_retaddr(cpu));
        cpu->EAX = 22;                       /* EINVAL */
        return;
    }
    isaac_w32(CRT_FMODE_VA, mode);
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #3 ---------- */
/* int *__p__commode(void)  -- returns a POINTER to the CRT's _commode global.
 * The guest dereferences and often writes through it, so the cell has to be
 * real guest memory, not a value faked into EAX. */
void imp_api_ms_win_crt_stdio____p__commode(CpuState *restrict cpu) {
    cpu->EAX = CRT_COMMODE_VA;
}

/* ------------------------------------------------------------ #4 ---------- */
/* int _crt_atexit(_PVFV func)  -- registration, 0 on success.
 * The list lives in HOST memory: the guest passes function pointers in and
 * never inspects the list, so there is no reason to expose it to a wild write.
 * These run at exit; isaac_run_atexit() drives them. */
/* Boot round 12: the engine registers well over 64 static destructors
 * (the log showed the table full at 64 with 0x00b16750 etc. dropped), and
 * a dropped entry silently changes shutdown. */
#define ATEXIT_MAX 1024
static uint32_t g_atexit[ATEXIT_MAX];
static unsigned g_atexit_n;
/* Round 14f: _register_onexit_function registers into the same list. */
void isaac_atexit_register(uint32_t fn) {
    if (fn && g_atexit_n < ATEXIT_MAX) g_atexit[g_atexit_n++] = fn;
}

void imp_api_ms_win_crt_runtime___crt_atexit(CpuState *restrict cpu) {
    uint32_t fn = isaac_arg(cpu, 0);
    if (!fn) { cpu->EAX = 0; return; }
    if (g_atexit_n >= ATEXIT_MAX) {
        isaac_log("[isaac][crt] _crt_atexit: table full (%d); 0x%08x will not "
                  "run at exit.", ATEXIT_MAX, fn);
        cpu->EAX = -1;
        return;
    }
    g_atexit[g_atexit_n++] = fn;
    cpu->EAX = 0;
}

void isaac_run_atexit(void) {
    CpuState sub;
    while (g_atexit_n) {                     /* LIFO, as the standard requires */
        uint32_t fn = g_atexit[--g_atexit_n];
        if (!isaac_in_image(fn)) continue;
        memset(&sub, 0, sizeof sub);
        sub.FS_OFFSET = ISAAC_TEB_VA;
        sub.ESP = ISAAC_STACK_TOP_VA - 0x3000;
        sub.ESP -= 4;
        isaac_w32(sub.ESP, 0);
        isaac_guest_call(fn, &sub);
    }
}

/* ------------------------------------------------------------ #5 ---------- */
/* int _configure_narrow_argv(int mode)  -- 0 on success. We supply argc/argv
 * ourselves in isaac_boot_call_main(), so there is nothing to configure. */
void imp_api_ms_win_crt_runtime___configure_narrow_argv(CpuState *restrict cpu) {
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #6 ---------- */
/* void InitializeSListHead(PSLIST_HEADER)  -- stdcall, 4 bytes.
 * A 16-byte, 16-byte-aligned interlocked list header. Single-threaded here, so
 * zeroing it is the complete and correct implementation. */
void imp_kernel32__InitializeSListHead(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0);
    if (h && isaac_is_guest_va(h)) memset(isaac_g(h), 0, 16);
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #7 ---------- */
/* errno_t _controlfp_s(unsigned *cur, unsigned newval, unsigned mask)
 *
 * PARTIALLY IMPLEMENTABLE, and the limit is worth stating. wasm has no
 * x87 control word: rounding mode is fixed at round-to-nearest-even and
 * exceptions are always masked. So the control word can be reported but not
 * changed. That is sound here for a measured reason -- the lifter found this
 * binary never executes `fldcw`, so it never depends on a change taking
 * effect. If a caller ever asks for a DIFFERENT mode, that assumption has
 * broken and it is logged rather than silently ignored. */
void imp_api_ms_win_crt_runtime___controlfp_s(CpuState *restrict cpu) {
    uint32_t cur = isaac_arg(cpu, 0);
    uint32_t newval = isaac_arg(cpu, 1);
    uint32_t mask = isaac_arg(cpu, 2);
    if (mask && (newval & mask) != (CW_DEFAULT & mask)) {
        isaac_log("[isaac][crt] _controlfp_s(new=0x%x, mask=0x%x) asks to "
                  "change the FP control word to something other than the "
                  "default 0x%x. wasm has no x87 control word, so this cannot "
                  "take effect (caller 0x%08x).",
                  newval, mask, CW_DEFAULT, isaac_retaddr(cpu));
    }
    if (cur && isaac_is_guest_va(cur)) isaac_w32(cur, CW_DEFAULT);
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #8 ---------- */
/* int _configthreadlocale(int flag)  -- 0 queries, 1 disables per-thread
 * locale, 2 enables. Returns the PREVIOUS setting, or -1 on error.
 * Single-threaded: per-thread locale is permanently disabled. */
void imp_api_ms_win_crt_locale___configthreadlocale(CpuState *restrict cpu) {
    uint32_t flag = isaac_arg(cpu, 0);
    if (flag == 2) {
        isaac_log("[isaac][crt] _configthreadlocale(_ENABLE_PER_THREAD_LOCALE) "
                  "in a single-threaded build (caller 0x%08x); reporting it "
                  "stayed disabled.", isaac_retaddr(cpu));
    }
    cpu->EAX = 1;                            /* _DISABLE_PER_THREAD_LOCALE */
}

/* ------------------------------------------------------------ #9 ---------- */
/* int _initialize_narrow_environment(void)  -- 0 on success. getenv is a
 * separate shim; there is no environment block to build here. */
void imp_api_ms_win_crt_runtime___initialize_narrow_environment(
        CpuState *restrict cpu) {
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #10 --------- */
/* BOOL InitializeCriticalSectionAndSpinCount(LPCRITICAL_SECTION, DWORD)
 * stdcall, 8 bytes. Single-threaded: a zeroed CRITICAL_SECTION (24 bytes on
 * Win32) with a recursion count of 0 is correct, and every Enter/Leave is a
 * no-op. Returns TRUE. */
void imp_kernel32__InitializeCriticalSectionAndSpinCount(CpuState *restrict cpu) {
    uint32_t cs = isaac_arg(cpu, 0);
    if (cs && isaac_is_guest_va(cs)) memset(isaac_g(cs), 0, 24);
    cpu->EAX = 1;
}

/* #11 GetModuleHandleW now lives in host_shims_module.c, which owns the
 * whole module-handle story rather than answering per call. */

/* ------------------------------------------------------------ #12 --------- */
/* BOOL IsProcessorFeaturePresent(DWORD feature)  -- stdcall, 4 bytes.
 *
 * NOTE: the call-site push-count measurement reported 8 for this symbol, which
 * is wrong -- the signature takes one DWORD. Same failure mode as MessageBoxA
 * (arguments set up with `mov [esp+N]` rather than `push`), and it is now a
 * curated entry. A purge of 8 here would have popped a caller's local every
 * time and desynchronised the guest stack.
 *
 * The CRT queries these to pick memcpy/memset implementations. Reporting the
 * SSE2 baseline is honest: the lifted code runs the same instructions the
 * original chose, and wasm SIMD is not what these gate. */
#define PF_XMMI_INSTRUCTIONS_AVAILABLE    6   /* SSE  */
#define PF_XMMI64_INSTRUCTIONS_AVAILABLE 10   /* SSE2 */
#define PF_FASTFAIL_AVAILABLE            23

void imp_kernel32__IsProcessorFeaturePresent(CpuState *restrict cpu) {
    uint32_t f = isaac_arg(cpu, 0);
    switch (f) {
    case PF_XMMI_INSTRUCTIONS_AVAILABLE:
    case PF_XMMI64_INSTRUCTIONS_AVAILABLE:
        cpu->EAX = 1;
        break;
    case PF_FASTFAIL_AVAILABLE:
        /* Saying yes routes CRT failures into __fastfail (an `int 29h`), which
         * the lifter's swi intrinsic aborts on with no diagnosis. Saying no
         * keeps them on the reportable path. */
        cpu->EAX = 0;
        break;
    default:
        cpu->EAX = 0;
        break;
    }
}

/* ------------------------------------------------------------ #13 --------- */
/* void *memset(void *dst, int c, size_t n)  -- cdecl, 444 call sites, by far
 * the busiest of the sixteen. A musl forward, but the guest pointer must be
 * validated: memset is exactly where a wild pointer does the most damage, and
 * with identity addressing an unchecked dst would let the guest scribble over
 * the runtime. Returns dst. */
void imp_vcruntime140__memset(CpuState *restrict cpu) {
    uint32_t dst = isaac_arg(cpu, 0);
    uint32_t c   = isaac_arg(cpu, 1);
    uint32_t n   = isaac_arg(cpu, 2);
    if (n) {
        if (!isaac_is_guest_va(dst) || !isaac_is_guest_va(dst + n - 1)) {
            isaac_log("[isaac][crt] memset(0x%08x, %u, %u) crosses the guest "
                      "limit 0x%08x -- refusing, this would corrupt the "
                      "runtime (caller 0x%08x)",
                      dst, c, n, ISAAC_GUEST_LIMIT_VA, isaac_retaddr(cpu));
            cpu->EAX = dst;
            return;
        }
        memset(isaac_g(dst), (int)(c & 0xFF), (size_t)n);
    }
    cpu->EAX = dst;
}

/* ------------------------------------------------------------ #14 --------- */
/* BOOL IsDebuggerPresent(void)  -- stdcall, 0 bytes. There is no debugger. */
void imp_kernel32__IsDebuggerPresent(CpuState *restrict cpu) {
    cpu->EAX = 0;
}

/* ------------------------------------------------------------ #15 --------- */
/* LPTOP_LEVEL_EXCEPTION_FILTER SetUnhandledExceptionFilter(LPTOP_LEVEL...)
 * stdcall, 4 bytes. Store it and return the previous one. This is real: the
 * CRT installs its own filter during startup and restores it later, and
 * returning garbage would make the restore install garbage. */
void imp_kernel32__SetUnhandledExceptionFilter(CpuState *restrict cpu) {
    uint32_t prev = isaac_r32(CRT_UEF_VA);
    isaac_w32(CRT_UEF_VA, isaac_arg(cpu, 0));
    cpu->EAX = prev;
}

/* ------------------------------------------------------------ #16 --------- */
/* LONG UnhandledExceptionFilter(EXCEPTION_POINTERS *)  -- stdcall, 4 bytes.
 *
 * Reaching this means an exception escaped every handler. In the survey build
 * it was reached because faking the preceding imports walked the CRT into its
 * failure path; on a correct boot it should never be entered at all.
 *
 * There is no honest value to return. EXCEPTION_EXECUTE_HANDLER (1) claims we
 * handled something we did not; EXCEPTION_CONTINUE_SEARCH (0) sends the CRT to
 * its terminate path, which ends in a deliberate breakpoint that surfaces as
 * an opaque `swi` abort with no diagnosis. So it reports, in detail, and
 * stops. */
void imp_kernel32__UnhandledExceptionFilter(CpuState *restrict cpu) {
    static const isaac_import *self;
    uint32_t ep = isaac_arg(cpu, 0);
    if (!self) {
        for (unsigned i = 0; i < isaac_import_count; ++i)
            if (!strcmp(isaac_imports[i].symbol, "UnhandledExceptionFilter")) {
                self = &isaac_imports[i];
                break;
            }
    }
    isaac_log("[isaac][k32] UnhandledExceptionFilter(0x%08x) from 0x%08x -- an "
              "exception escaped every handler.", ep, isaac_retaddr(cpu));
    if (ep && isaac_is_guest_va(ep)) {
        uint32_t rec = isaac_r32(ep + 0);        /* EXCEPTION_RECORD*  */
        uint32_t ctx = isaac_r32(ep + 4);        /* CONTEXT*           */
        if (rec && isaac_is_guest_va(rec)) {
            isaac_log("[isaac][k32]   code 0x%08x flags 0x%08x at 0x%08x, "
                      "%u parameters",
                      isaac_r32(rec + 0), isaac_r32(rec + 4),
                      isaac_r32(rec + 12), isaac_r32(rec + 16));
        }
        isaac_log("[isaac][k32]   EXCEPTION_POINTERS: record 0x%08x context "
                  "0x%08x", rec, ctx);
    }
    if (self) isaac_trap(self, cpu);
    isaac_stub_report();
    abort();
}


/* ------------------------------------------------------------ setjmp3 ---- */
/* int __cdecl _setjmp3(_JUMP_BUFFER *env, int has_frame_info, ...)
 *
 * The guest uses setjmp/longjmp as its error-abort mechanism (theoraplay
 * decode paths, protected-call wrappers).  The lifter models the IAT slot
 * as a direct import call, and every guest entry into lifted code funnels
 * through isaac_guest_call, so a guest longjmp can be implemented as a HOST
 * longjmp out of the whole lifted call chain back to the guest-call guard,
 * which then replays the abandoned guest frames from the restored EIP.
 *
 * _JUMP_BUFFER (MSVC x86):
 *   +0x00 Ebp +0x04 Ebx +0x08 Edi +0x0C Esi +0x10 Esp +0x14 Eip
 *   +0x18 Registration +0x1C TryLevel +0x20 Cookie +0x24 UnwindFunc
 *   +0x28 UnwindData[6]            (total 0x40; guest mallocs >= 0x20c)
 * We model no SEH chain: Registration = 0, TryLevel = -1, and the
 * has_frame_info variadic records are ignored.  Eip/Esp are the
 * continuation (the pushed return address and the ESP after it pops).
 */
void imp_vcruntime140___setjmp3(CpuState *restrict cpu) {
    uint32_t env = isaac_arg(cpu, 0);
    uint32_t frame = isaac_arg(cpu, 1);
    (void)frame;
    uint32_t cont_eip = isaac_retaddr(cpu);
    isaac_w32(env + 0x00, cpu->EBP);
    isaac_w32(env + 0x04, cpu->EBX);
    isaac_w32(env + 0x08, cpu->EDI);
    isaac_w32(env + 0x0C, cpu->ESI);
    isaac_w32(env + 0x10, cpu->ESP + 4u);
    isaac_w32(env + 0x14, cont_eip);
    isaac_w32(env + 0x18, 0u);
    isaac_w32(env + 0x1C, 0xFFFFFFFFu);
    isaac_w32(env + 0x20, 0u);
    isaac_w32(env + 0x24, 0u);
    for (unsigned i = 0; i < 6; ++i)
        isaac_w32(env + 0x28 + 4u * i, 0u);
    cpu->EAX = 0;                          /* first return */
    /* The game arms a setjmp twice per presented frame (0x00a96859 and
     * 0x00a64bbb); logging every one was ~4,300 lines per minute of play
     * (round 24d). The first 8 from each site are enough to see the
     * pattern; the rest are counted into the stub report's silence. */
    {
        static uint32_t sites[8]; static unsigned n_per[8], nsites;
        unsigned k;
        for (k = 0; k < nsites; ++k) if (sites[k] == cont_eip) break;
        if (k == nsites && nsites < 8u) { sites[nsites] = cont_eip; n_per[nsites] = 0u; ++nsites; }
        if (k < 8u && ++n_per[k] <= 8u)
            isaac_log("[isaac][crt] _setjmp3(env=0x%08x frame=%u cont=0x%08x caller=0x%08x)%s",
                      env, frame, cont_eip, isaac_retaddr(cpu),
                      n_per[k] == 8u ? " (further calls from this site silent)" : "");
    }
}

/* ------------------------------------------------------------ longjmp ---- */
/* void __cdecl longjmp(_JUMP_BUFFER *env, int value)
 *
 * Restores the six context dwords, returns `value ? value : 1` in EAX
 * (ECX/EDX/flags are unspecified by the x86 contract), then unwinds the
 * host call chain to the isaac_guest_call guard, which replays the guest
 * frames starting at the restored EIP.  Never returns normally. */
void imp_vcruntime140__longjmp(CpuState *restrict cpu) {
    uint32_t env = isaac_arg(cpu, 0);
    uint32_t value = isaac_arg(cpu, 1);
    uint32_t ebp = isaac_r32(env + 0x00);
    uint32_t ebx = isaac_r32(env + 0x04);
    uint32_t edi = isaac_r32(env + 0x08);
    uint32_t esi = isaac_r32(env + 0x0C);
    uint32_t esp = isaac_r32(env + 0x10);
    uint32_t eip = isaac_r32(env + 0x14);
    cpu->EBP = ebp;
    cpu->EBX = ebx;
    cpu->EDI = edi;
    cpu->ESI = esi;
    cpu->EAX = value ? value : 1u;
    /* Forge the return slot so the direct-import epilogue would also pop the
     * right address; the host longjmp below never lets it run. */
    isaac_w32(esp - 4u, eip);
    cpu->ESP = esp - 4u;
    cpu->EIP = eip;
    isaac_log("[isaac][crt] longjmp(env=0x%08x value=%u) -> eip=0x%08x "
              "esp=0x%08x", env, value, eip, esp);
    isaac_guest_longjmp(cpu);              /* unwinds to isaac_guest_call */
}
