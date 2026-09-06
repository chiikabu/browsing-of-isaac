/* host_shims_crt.c -- hand-written CRT shims, highest call-site count first.
 *
 * These are STRONG definitions that override the generated weak fallbacks in
 * generated/shim_weak.c simply by existing at link time. The identifiers come
 * from gen_shims.py's c_ident(): shim_<dll-stem>__<symbol>.
 *
 * Ordered by measured call sites, because that is the order in which getting
 * one wrong costs the most:
 *
 *   _invalid_parameter_noinfo_noreturn  1,458   one function, trivial, noreturn
 *   _wassert                               92   assertion failure reporting
 *   _errno / _set_errno                    14   thread-local errno cell
 *   _initterm / _initterm_e                 2   also driven directly by boot
 *   abort / terminate / exit / _exit       15   process teardown
 *   __acrt_iob_func                        49   stdin/stdout/stderr FILE*
 *
 * Everything here is cdecl (api-ms-win-crt-* is cdecl by definition), so no
 * shim in this file pops arguments -- the caller cleans. isaac_indirect_call()
 * handles the return-address pop.
 */

#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Index of each import in isaac_imports[], resolved lazily by slot VA so this
 * file never has to track generated ordering. */
static const isaac_import *self_by_symbol(const char *dll, const char *sym) {
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        const isaac_import *r = &isaac_imports[i];
        const char *a = r->dll, *b = dll;
        while (*a && *a == *b) { ++a; ++b; }
        if (*a || *b) continue;
        a = r->symbol; b = sym;
        while (*a && *a == *b) { ++a; ++b; }
        if (!*a && !*b) return r;
    }
    return NULL;
}

#define CRT_RUNTIME "api-ms-win-crt-runtime-l1-1-0.dll"
#define CRT_STDIO   "api-ms-win-crt-stdio-l1-1-0.dll"

/* ---------------------------------------------------------------- 1,458 --- */
/* _invalid_parameter_noinfo_noreturn()
 *
 * The CRT calls this from every bounds-checked function (strncpy_s, sprintf_s,
 * ...) when a parameter is invalid. It is __declspec(noreturn): on Windows it
 * terminates the process. 1,458 call sites is not 1,458 pieces of work -- it is
 * one function reached from everywhere, and it is exactly the kind of thing a
 * silent stub would turn into an unexplainable hang.
 *
 * Reaching this means the guest passed a bad parameter to a secure-CRT
 * function, which is a real bug worth stopping for. */
void imp_api_ms_win_crt_runtime___invalid_parameter_noinfo_noreturn(
        CpuState *restrict cpu) {
    isaac_log("[isaac][crt] _invalid_parameter_noinfo_noreturn from 0x%08x -- "
              "the guest passed an invalid parameter to a secure-CRT function. "
              "This is noreturn on Windows, so execution stops here.",
              isaac_retaddr(cpu));
    {
        extern void isaac_dump_trap_context(const CpuState *cpu, const char *tag);
        isaac_dump_trap_context(cpu, "_invalid_parameter_noinfo_noreturn");
    }
    isaac_stub_report();
    abort();
}

/* ------------------------------------------------------------------- 92 --- */
/* void _wassert(const wchar_t *msg, const wchar_t *file, unsigned line)
 *
 * MSVC bakes __FILE__ into these as UTF-16, which is how the census recovered
 * the vendored-library source paths. Printing them is genuinely useful: an
 * assertion here names the engine source file and line. */
static void log_utf16(const char *label, uint32_t va) {
    char buf[256];
    unsigned n = 0;
    if (!va) { isaac_log("      %s: (null)", label); return; }
    while (n < sizeof buf - 1) {
        uint16_t c = isaac_r16(va + 2u * n);
        if (!c) break;
        buf[n++] = (c < 0x80) ? (char)c : '?';
    }
    buf[n] = 0;
    isaac_log("      %s: %s", label, buf);
}

void imp_api_ms_win_crt_runtime___wassert(CpuState *restrict cpu) {
    uint32_t msg = isaac_arg(cpu, 0);
    uint32_t file = isaac_arg(cpu, 1);
    uint32_t line = isaac_arg(cpu, 2);
    isaac_log("[isaac][crt] ASSERTION FAILED (called from 0x%08x, line %u)",
              isaac_retaddr(cpu), line);
    log_utf16("expr", msg);
    log_utf16("file", file);
    isaac_stub_report();
    abort();
}

/* -------------------------------------------------------------- errno ----- */
/* The guest CRT's errno is a per-thread int*. Single-threaded build, so one
 * cell. It must live at a guest-visible address because the guest dereferences
 * the returned pointer; the shim arena above the image is the right home. */
#define ERRNO_CELL_VA (ISAAC_TEB_VA + 0x800)

void imp_api_ms_win_crt_runtime___errno(CpuState *restrict cpu) {
    cpu->EAX = ERRNO_CELL_VA;
}

void imp_api_ms_win_crt_runtime___set_errno(CpuState *restrict cpu) {
    isaac_w32(ERRNO_CELL_VA, isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

/* --------------------------------------------------------- _initterm ------ */
/* void  _initterm  (PVFV  *first, PVFV  *last)     ignores return values
 * int   _initterm_e(PVFI  *first, PVFI  *last)     stops at first non-zero
 *
 * The boot path normally drives the two tables itself (host_boot.c step 6), so
 * these exist for the case where the guest's own __scrt_common_main_seh is
 * entered instead. Same semantics, so both paths agree. */
static uint32_t run_table(CpuState *restrict cpu, uint32_t first, uint32_t last,
                          int stop_on_nonzero) {
    CpuState sub;
    for (uint32_t p = first; p < last; p += 4) {
        uint32_t fn = isaac_r32(p);
        if (!fn) continue;
        if (!isaac_in_image(fn)) {
            isaac_log("[isaac][crt] _initterm: entry at 0x%08x -> 0x%08x is "
                      "outside the image", p, fn);
            return 1;
        }
        sub = *cpu;
        sub.ESP = cpu->ESP - 0x400;
        sub.ESP -= 4;
        isaac_w32(sub.ESP, 0);
        isaac_guest_call(fn, &sub);
        if (stop_on_nonzero && sub.EAX != 0)
            return sub.EAX;
    }
    return 0;
}

void imp_api_ms_win_crt_runtime___initterm(CpuState *restrict cpu) {
    run_table(cpu, isaac_arg(cpu, 0), isaac_arg(cpu, 1), 0);
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_runtime___initterm_e(CpuState *restrict cpu) {
    cpu->EAX = run_table(cpu, isaac_arg(cpu, 0), isaac_arg(cpu, 1), 1);
}

/* ------------------------------------------------------------ teardown ---- */

void imp_api_ms_win_crt_runtime__abort(CpuState *restrict cpu) {
    isaac_log("[isaac][crt] abort() from 0x%08x", isaac_retaddr(cpu));
    isaac_stub_report();
    abort();
}

void imp_api_ms_win_crt_runtime__terminate(CpuState *restrict cpu) {
    isaac_log("[isaac][crt] std::terminate() from 0x%08x -- an exception "
              "escaped, or a noexcept function threw.", isaac_retaddr(cpu));
    isaac_stub_report();
    abort();
}

void imp_api_ms_win_crt_runtime__exit(CpuState *restrict cpu) {
    int code = (int)isaac_arg(cpu, 0);
    isaac_log("[isaac][crt] exit(%d) from 0x%08x", code, isaac_retaddr(cpu));
    isaac_stub_report();
    exit(code);
}

void imp_api_ms_win_crt_runtime___exit(CpuState *restrict cpu) {
    int code = (int)isaac_arg(cpu, 0);
    isaac_log("[isaac][crt] _exit(%d) from 0x%08x", code, isaac_retaddr(cpu));
    isaac_stub_report();
    _Exit(code);
}

/* ------------------------------------------------------------------- 49 --- */
/* FILE *__acrt_iob_func(unsigned index)   0=stdin 1=stdout 2=stderr
 *
 * The guest holds the returned pointer and passes it back to fwrite/fprintf,
 * which are themselves shims. So the value only has to be a stable token the
 * stdio shims can recognise -- it must NOT be a host FILE*, because the guest
 * may also read bytes from it (e.g. _fileno peeking at the struct).
 *
 * Three 64-byte pseudo-FILE blocks in the shim arena. _fileno reads the fd from
 * offset 0x10, matching what the stdio shims write there. */
#define IOB_BASE_VA (ISAAC_TEB_VA + 0x900)
#define IOB_STRIDE  64

void imp_api_ms_win_crt_stdio____acrt_iob_func(CpuState *restrict cpu) {
    uint32_t idx = isaac_arg(cpu, 0);
    if (idx > 2) {
        isaac_log("[isaac][crt] __acrt_iob_func(%u): only 0..2 exist", idx);
        cpu->EAX = 0;
        return;
    }
    static int initialised;
    if (!initialised) {
        for (unsigned i = 0; i < 3; ++i) {
            uint32_t base = IOB_BASE_VA + i * IOB_STRIDE;
            for (unsigned o = 0; o < IOB_STRIDE; o += 4)
                isaac_w32(base + o, 0);
            isaac_w32(base + 0x10, (uint32_t)i);   /* fd, read by _fileno */
        }
        initialised = 1;
    }
    cpu->EAX = IOB_BASE_VA + idx * IOB_STRIDE;
}

/* ---------------------------------------------------------- C++ ABI ------- */
/* __CxxFrameHandler3 -- the minimum viable implementation, and why it is
 * honest rather than a lie.
 *
 * The census reports 1,833 "call sites", which reads like 1,833 things that
 * must work before anything runs. Measured by disassembly (eh_audit.py), the
 * breakdown is:
 *
 *     real `call`s from lifted code ................ 0
 *     `jmp` tails of __ehhandler$ trampolines ... 1,834
 *
 * Every reference is the tail of a per-function SEH handler:
 *     __ehhandler$f:  mov eax, offset __ehfuncinfo$f
 *                     jmp  __CxxFrameHandler3
 * and the fs:[0] registration record points at __ehhandler$f, not here. So
 * this function is entered ONLY when something walks the fs:[0] chain -- i.e.
 * only during a throw. It is not on the steady-state path at all.
 *
 * isaac_boot_install_teb() sets ExceptionList to 0xFFFFFFFF, a genuinely empty
 * chain. Returning ExceptionContinueSearch (1) says "this frame has no handler
 * for that exception", which is TRUE of an empty chain -- so it is a correct
 * answer, not a fabricated one. It is still logged on first entry, because
 * reaching it at all means a throw happened, and the throw is the thing that
 * cannot yet be handled (see _CxxThrowException below).
 *
 * ExceptionContinueSearch = 1 in the EXCEPTION_DISPOSITION enum. */
#define ExceptionContinueSearch 1u

void imp_vcruntime140____CxxFrameHandler3(CpuState *restrict cpu) {
    static const isaac_import *self;
    static unsigned entered;
    if (!self) self = self_by_symbol("vcruntime140.dll", "__CxxFrameHandler3");
    if (entered++ == 0) {
        isaac_log("[isaac][c++] __CxxFrameHandler3 entered from 0x%08x. The "
                  "fs:[0] chain is empty (0xFFFFFFFF), so the honest answer is "
                  "ExceptionContinueSearch -- this frame has no handler. Note "
                  "that reaching here at all means a throw occurred; "
                  "_CxxThrowException is what cannot yet be serviced.",
                  isaac_retaddr(cpu));
        if (self) isaac_stub_hit(self, cpu);
    }
    cpu->EAX = ExceptionContinueSearch;
}

/* __RTDynamicCast now lives in host_shims_cxx.c -- it grew a real
 * implementation and no longer belongs beside the CRT one-liners. */

/* -------------------------------------------------------------------- */
/* __stdio_common_vsscanf -- the UCRT sscanf engine. The game's sscanf
 * front-end (0x00837090 -> 0x00837060) calls it DIRECTLY with
 * (options.qw, buffer, (size_t)-1, format, argptr): the 64-bit options are
 * pushed as two dwords, argptr is a guest pointer to the first vararg slot
 * on the guest stack. Every scanf vararg is a POINTER (guest VA = wasm
 * offset by the identity model), so the host sscanf can write through them
 * unchanged. The callsite count is 1 (0x00837079, the GL version parse
 * "%d.%d.%d"), but the dispatch below is general for 0..8 conversions. */
void imp_api_ms_win_crt_stdio____stdio_common_vsscanf(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);        /* options qw, low  -- legacy flags */
    (void)isaac_arg(cpu, 1);        /* options qw, high */
    uint32_t buffer = isaac_arg(cpu, 2);
    (void)isaac_arg(cpu, 3);        /* buffer_count ((size_t)-1 here) */
    uint32_t format = isaac_arg(cpu, 4);
    (void)isaac_arg(cpu, 5);        /* _Locale (NULL from the sscanf wrapper) */
    uint32_t argptr = isaac_arg(cpu, 6);   /* va_list: first vararg slot */

    char hbuf[4096], hfmt[512];
    size_t nb = 0, nf = 0;
    if (isaac_is_guest_va(buffer)) {
        const char *q = (const char *)isaac_g(buffer);
        while (nb + 1 < sizeof hbuf && q[nb]) { hbuf[nb] = q[nb]; ++nb; }
    }
    hbuf[nb] = 0;
    if (isaac_is_guest_va(format)) {
        const char *q = (const char *)isaac_g(format);
        while (nf + 1 < sizeof hfmt && q[nf]) { hfmt[nf] = q[nf]; ++nf; }
    }
    hfmt[nf] = 0;

    fprintf(stderr, "[vsscanf] buf=%08x fmt=%08x argptr=%08x | \"%s\" | \"%s\" | a0=%08x a1=%08x a2=%08x\n",
            buffer, format, argptr, hbuf, hfmt,
            isaac_is_guest_va(argptr) ? (unsigned)*(uint32_t *)isaac_g(argptr) : 0xffffffffu,
            isaac_is_guest_va(argptr) ? (unsigned)*(uint32_t *)isaac_g(argptr + 4) : 0xffffffffu,
            isaac_is_guest_va(argptr) ? (unsigned)*(uint32_t *)isaac_g(argptr + 8) : 0xffffffffu);

    /* Vararg count from the format: every assignment conversion consumes
     * one pointer-sized vararg; "%%" and '*' (suppressed assignment) consume
     * none. Widths/precision/length modifiers are skipped. */
    unsigned n = 0;
    for (const char *p = hfmt; *p; ++p) {
        if (*p != '%')
            continue;
        ++p;
        if (*p == '%')
            continue;
        if (*p == '*')
            continue;
        while (*p && strchr("0123456789.hlLjzt", *p))
            ++p;
        if (*p)
            ++n;
    }

#define ARG(i) (*(uint32_t *)isaac_g(argptr + 4 * (i)))
    /* hfmt is the guest's own format string by contract — this shim IS the
     * sscanf reimplementation, so a non-literal format is intentional. */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-security"
    switch (n) {
        case 0:  cpu->EAX = sscanf(hbuf, hfmt); break;
        case 1:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0)); break;
        case 2:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1)); break;
        case 3:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1),
                                   (void *)ARG(2)); break;
        case 4:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1),
                                   (void *)ARG(2), (void *)ARG(3)); break;
        case 5:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1),
                                   (void *)ARG(2), (void *)ARG(3),
                                   (void *)ARG(4)); break;
        case 6:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1),
                                   (void *)ARG(2), (void *)ARG(3),
                                   (void *)ARG(4), (void *)ARG(5)); break;
        case 7:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1),
                                   (void *)ARG(2), (void *)ARG(3),
                                   (void *)ARG(4), (void *)ARG(5),
                                   (void *)ARG(6)); break;
        case 8:  cpu->EAX = sscanf(hbuf, hfmt, (void *)ARG(0), (void *)ARG(1),
                                   (void *)ARG(2), (void *)ARG(3),
                                   (void *)ARG(4), (void *)ARG(5),
                                   (void *)ARG(6), (void *)ARG(7)); break;
        default:
            isaac_log("[isaac][crt] __stdio_common_vsscanf: format with %u "
                      "conversions exceeds the 8-arg dispatch "
                      "(fmt=\"%.80s\" buf=\"%.80s\") from 0x%08x",
                      n, hfmt, hbuf, isaac_retaddr(cpu));
            cpu->EAX = 0;
            break;
    }
#pragma GCC diagnostic pop
#undef ARG
}

void imp_vcruntime140___CxxThrowException(CpuState *restrict cpu) {
    static const isaac_import *self;
    if (!self) self = self_by_symbol("vcruntime140.dll", "_CxxThrowException");
    /* THROW AND UNWIND ARE SEPARATE MECHANISMS, and the earlier finding about
     * __CxxFrameHandler3 does not cover this side. That result was: lifted
     * code never CALLS the frame handler, so unwinding is never entered on a
     * normal path. This is the other half -- lifted code calls
     * _CxxThrowException directly, 72 times, and the initialiser walk puts it
     * at depth 4. So a throw during initialisation is plausible even though an
     * unwind is not, and it would arrive here rather than at the handler. */
    isaac_log("[isaac][c++] _CxxThrowException(obj=0x%08x, info=0x%08x) from "
              "0x%08x -- a C++ throw. Note this is the THROW side: the earlier "
              "result that __CxxFrameHandler3 is never on a normal path covers "
              "unwinding only, and does not imply throws are unreachable.",
              isaac_arg(cpu, 0), isaac_arg(cpu, 1), isaac_retaddr(cpu));
    if (self) isaac_trap(self, cpu);
    abort();
}
