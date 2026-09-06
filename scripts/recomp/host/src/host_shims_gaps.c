/* host_shims_gaps.c -- imports the shim table marks PROVIDED or REAL that had
 * only the generated weak trap body (round 14f).
 *
 * Found by a link-level census rather than by tripping over them one per
 * play run: llvm-nm over the host objects lists the strong imp_* symbols,
 * and 40 table rows with a PROVIDED/REAL verdict were not among them
 * (_CIfmod was the first to fire, at the first entity spawn). The plausible
 * ones on the play path get real bodies here; the C++ exception machinery
 * (__current_exception*, _except_handler4_common, _seh_filter_exe) and the
 * codecvt facets stay weak on purpose: nothing here can unwind a guest
 * throw, so a loud trap is the honest answer there.
 *
 * Conventions: stack arguments through isaac_arg(cpu, i); stdcall purges
 * come from the table (the dispatcher applies them); thiscall `this` is
 * ECX. Strings and buffers are guest memory (isaac_g). */

#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

void isaac_dump_trap_context(const CpuState *cpu, const char *tag);   /* host_trap.c */

/* ---------------------------------------------------------- CRT: qsort --- */
/* void qsort(void *base, size_t num, size_t width, int (*cmp)(const void*, const void*))
 * The comparator is a guest function (cdecl, two pointer arguments, result in
 * EAX); every comparison is a guest sub-call on a scratch frame below the
 * caller's ESP -- the same shape host_shims_crt.c uses for _initterm. An
 * insertion/merge on the host with the guest comparing is exact: the order
 * is whatever the comparator says. Merge sort keeps it O(n log n) and stable
 * (MSVC's qsort is not stable, but stability only ever narrows the set of
 * orders the game could see, it never invents one). */
static CpuState *g_qs_cpu;
static uint32_t g_qs_cmp;
static uint32_t g_qs_calls;
static int qs_compare(uint32_t a, uint32_t b) {
    CpuState sub = *g_qs_cpu;
    sub.ESP = (g_qs_cpu->ESP - 0x800u) & ~0xFu;
    sub.ESP -= 4; isaac_w32(sub.ESP, b);
    sub.ESP -= 4; isaac_w32(sub.ESP, a);
    sub.ESP -= 4; isaac_w32(sub.ESP, 0);        /* return address */
    isaac_guest_call(g_qs_cmp, &sub);
    ++g_qs_calls;
    return (int)sub.EAX;
}
static void qs_merge(uint32_t base, uint32_t width, uint32_t lo, uint32_t mid, uint32_t hi, uint8_t *tmp) {
    uint32_t i = lo, j = mid, k = 0;
    while (i < mid && j < hi) {
        if (qs_compare(base + j * width, base + i * width) < 0) {
            memcpy(tmp + k * width, isaac_g(base + j * width), width); ++j;
        } else {
            memcpy(tmp + k * width, isaac_g(base + i * width), width); ++i;
        }
        ++k;
    }
    while (i < mid) { memcpy(tmp + k * width, isaac_g(base + i * width), width); ++i; ++k; }
    while (j < hi)  { memcpy(tmp + k * width, isaac_g(base + j * width), width); ++j; ++k; }
    memcpy(isaac_g(base + lo * width), tmp, (size_t)(hi - lo) * width);
}
static void qs_sort(uint32_t base, uint32_t width, uint32_t lo, uint32_t hi, uint8_t *tmp) {
    if (hi - lo < 2) return;
    uint32_t mid = lo + (hi - lo) / 2;
    qs_sort(base, width, lo, mid, tmp);
    qs_sort(base, width, mid, hi, tmp);
    qs_merge(base, width, lo, mid, hi, tmp);
}
void imp_api_ms_win_crt_utility__qsort(CpuState *restrict cpu) {
    uint32_t base = isaac_arg(cpu, 0), num = isaac_arg(cpu, 1),
             width = isaac_arg(cpu, 2), cmp = isaac_arg(cpu, 3);
    cpu->EAX = 0;
    if (num < 2 || !width || !cmp) return;
    if (!isaac_is_guest_va(base) || !isaac_is_guest_va(base + num * width - 1u)) {
        isaac_log("[isaac][crt] qsort(0x%08x, %u, %u): array outside guest memory; ignored", base, num, width);
        return;
    }
    uint8_t *tmp = (uint8_t *)malloc((size_t)num * width);
    if (!tmp) return;
    CpuState *saved_cpu = g_qs_cpu; uint32_t saved_cmp = g_qs_cmp;
    g_qs_cpu = cpu; g_qs_cmp = cmp;
    qs_sort(base, width, 0, num, tmp);
    g_qs_cpu = saved_cpu; g_qs_cmp = saved_cmp;
    free(tmp);
}
uint32_t isaac_qsort_compare_calls(void) { return g_qs_calls; }

/* ------------------------------------------------------- CRT: strings ---- */
/* Guest-visible scratch for strings the CRT hands back by pointer. The
 * fake-TEB block owns 0x0e000000..0x0e005080 and the GL version string
 * sits at 0x0e006000; this page follows it. */
#define GAPS_SCRATCH_VA (ISAAC_TEB_VA + 0x7000u)
static uint32_t scratch_cstr(const char *s) {
    size_t n = strlen(s);
    if (n > 250) n = 250;
    memcpy(isaac_g(GAPS_SCRATCH_VA), s, n);
    *(uint8_t *)isaac_g(GAPS_SCRATCH_VA + n) = 0;
    return GAPS_SCRATCH_VA;
}
void imp_api_ms_win_crt_runtime__strerror(CpuState *restrict cpu) {
    int e = (int)isaac_arg(cpu, 0);
    cpu->EAX = scratch_cstr(strerror(e));
}
void imp_api_ms_win_crt_runtime__perror(CpuState *restrict cpu) {
    char msg[256];
    uint32_t p = isaac_arg(cpu, 0);
    isaac_guest_cstr(p, msg, sizeof msg, "perror");
    isaac_log("[isaac][guest-log] perror: %s: (errno %d)", msg, (int)isaac_r32((ISAAC_TEB_VA + 0x4000u)));
    cpu->EAX = 0;
}
/* __stdio_common_vsnprintf_s(opt64, buf, n, count, fmt, locale, ap): like
 * vsprintf_s with the extra `count` argument (args: opt=0,1 buf=2 n=3
 * count=4 fmt=5 locale=6 ap=7). */
int guest_vsnprintf(uint32_t buf, uint32_t n, uint32_t fmt, uint32_t ap, uint32_t caller);
void imp_api_ms_win_crt_stdio____stdio_common_vsnprintf_s(CpuState *restrict cpu) {
    uint32_t buf = isaac_arg(cpu, 2), n = isaac_arg(cpu, 3), count = isaac_arg(cpu, 4);
    uint32_t fmt = isaac_arg(cpu, 5), ap = isaac_arg(cpu, 7);
    uint32_t lim = (count == 0xFFFFFFFFu || count + 1u > n) ? n : count + 1u;
    cpu->EAX = (uint32_t)guest_vsnprintf(buf, lim, fmt, ap, isaac_retaddr(cpu));
}

/* -------------------------------------------------------- CRT: files ----- */
/* int _access(const char *path, int mode): 0 if the RAM-FS has it. */
void imp_api_ms_win_crt_filesystem___access(CpuState *restrict cpu) {
    uint32_t p = isaac_arg(cpu, 0);
    extern int isaac_fs_exists_guest_path(uint32_t path_va);
    cpu->EAX = isaac_fs_exists_guest_path(p) ? 0u : 0xFFFFFFFFu;
}
/* FILE *std::_Fiopen(const char *name, int mode, int prot): the fstream
 * open. mode bits (ios_base::openmode): in=1 out=2 ate=4 app=8 trunc=0x10
 * binary=0x20. Build the fopen mode string and go through the fopen shim
 * with a synthesized argument frame. */
void imp_msvcp140____Fiopen_std__YAPAU_iobuf__PBDHH_Z(CpuState *restrict cpu) {
    uint32_t name = isaac_arg(cpu, 0), mode = isaac_arg(cpu, 1);
    const char *m;
    int in = mode & 1, out = mode & 2, app = mode & 8, trunc = mode & 0x10, bin = mode & 0x20;
    if (app)                 m = in ? (bin ? "a+b" : "a+") : (bin ? "ab" : "a");
    else if (out && trunc)   m = in ? (bin ? "w+b" : "w+") : (bin ? "wb" : "w");
    else if (out && !in)     m = bin ? "wb" : "w";
    else if (out && in)      m = bin ? "r+b" : "r+";
    else                     m = bin ? "rb" : "r";
    uint32_t mva = GAPS_SCRATCH_VA + 0x100;
    memcpy(isaac_g(mva), m, strlen(m) + 1);
    CpuState sub = *cpu;
    sub.ESP = (cpu->ESP - 0x100u) & ~0xFu;
    isaac_w32(sub.ESP + 4, name);
    isaac_w32(sub.ESP + 8, mva);
    imp_api_ms_win_crt_stdio__fopen(&sub);
    cpu->EAX = sub.EAX;
}
/* _get_stream_buffer_pointers(FILE*, char ***base, char ***ptr, int **cnt):
 * the inline fast paths of the CRT read these; a stream with no buffer
 * makes every getc/putc take the slow (shimmed) path, which is what the
 * RAM-FS wants. */
void imp_api_ms_win_crt_stdio___get_stream_buffer_pointers(CpuState *restrict cpu) {
    uint32_t base = isaac_arg(cpu, 1), ptr = isaac_arg(cpu, 2), cnt = isaac_arg(cpu, 3);
    uint32_t cell = GAPS_SCRATCH_VA + 0x200;      /* three zero cells */
    isaac_w32(cell, 0); isaac_w32(cell + 4, 0); isaac_w32(cell + 8, 0);
    if (isaac_is_guest_va(base)) isaac_w32(base, cell);
    if (isaac_is_guest_va(ptr))  isaac_w32(ptr, cell + 4);
    if (isaac_is_guest_va(cnt))  isaac_w32(cnt, cell + 8);
    cpu->EAX = 0;
}

/* ---------------------------------------------------- CRT: process bits -- */
static uint32_t g_argv_va;
static void ensure_argv(void) {
    if (g_argv_va) return;
    uint32_t str = isaac_guest_alloc(32);
    uint32_t arr = isaac_guest_alloc(16);
    if (!str || !arr) return;
    memcpy(isaac_g(str), "isaac-ng.exe", 13);
    isaac_w32(arr, str); isaac_w32(arr + 4, 0);
    isaac_w32(arr + 8, 1);              /* argc cell */
    isaac_w32(arr + 12, arr);           /* argv cell (points at the array) */
    g_argv_va = arr;
}
void imp_api_ms_win_crt_runtime____p___argc(CpuState *restrict cpu) { ensure_argv(); cpu->EAX = g_argv_va ? g_argv_va + 8 : 0; }
void imp_api_ms_win_crt_runtime____p___argv(CpuState *restrict cpu) { ensure_argv(); cpu->EAX = g_argv_va ? g_argv_va + 12 : 0; }
void imp_api_ms_win_crt_runtime___get_initial_narrow_environment(CpuState *restrict cpu) {
    uint32_t env = GAPS_SCRATCH_VA + 0x300;       /* one NULL entry */
    isaac_w32(env, 0);
    cpu->EAX = env;
}
void imp_api_ms_win_crt_runtime___cexit(CpuState *restrict cpu) { cpu->EAX = 0; }
void imp_api_ms_win_crt_runtime___c_exit(CpuState *restrict cpu) { cpu->EAX = 0; }
/* onexit tables: the atexit shim family keeps one list; these register into
 * it (the table argument is the CRT's own bookkeeping, unused here). */
void isaac_atexit_register(uint32_t fn);
void imp_api_ms_win_crt_runtime___initialize_onexit_table(CpuState *restrict cpu) { cpu->EAX = 0; }
void imp_api_ms_win_crt_runtime___register_onexit_function(CpuState *restrict cpu) {
    isaac_atexit_register(isaac_arg(cpu, 1));
    cpu->EAX = 0;
}
static uint32_t g_tls_exe_atexit_cb;
uint32_t isaac_tls_exe_atexit_cb(void) { return g_tls_exe_atexit_cb; }
void imp_api_ms_win_crt_runtime___register_thread_local_exe_atexit_callback(CpuState *restrict cpu) {
    g_tls_exe_atexit_cb = isaac_arg(cpu, 0);
    cpu->EAX = 0;
}

/* ------------------------------------------------- vcruntime: exceptions -- */
/* struct __std_exception_data { const char *what; bool doFree; } */
void imp_vcruntime140____std_exception_copy(CpuState *restrict cpu) {
    uint32_t from = isaac_arg(cpu, 0), to = isaac_arg(cpu, 1);
    if (!isaac_is_guest_va(from + 7u) || !isaac_is_guest_va(to + 7u)) return;
    uint32_t what = isaac_r32(from);
    uint32_t copy = 0;
    if (what && isaac_is_guest_va(what)) {
        const char *s = (const char *)isaac_g(what);
        size_t n = strnlen(s, 4096);
        copy = isaac_guest_alloc((uint32_t)n + 1u);
        if (copy) memcpy(isaac_g(copy), s, n + 1);
    }
    isaac_w32(to, copy);
    *(uint8_t *)isaac_g(to + 4u) = copy ? 1u : 0u;
    cpu->EAX = 0;
}
void imp_vcruntime140____std_exception_destroy(CpuState *restrict cpu) {
    uint32_t d = isaac_arg(cpu, 0);
    if (!isaac_is_guest_va(d + 7u)) return;
    if (*(uint8_t *)isaac_g(d + 4u) && isaac_r32(d)) isaac_guest_free(isaac_r32(d));
    isaac_w32(d, 0);
    *(uint8_t *)isaac_g(d + 4u) = 0;
    cpu->EAX = 0;
}
/* const char *__std_type_info_name(__std_type_info_data *data, __type_info_node *root):
 * { const char *undecorated; char decorated[]; }. The undecorated name is
 * computed lazily by the real CRT; the decorated one (".?AVfoo@@") minus its
 * leading dot is what these callers print. */
void imp_vcruntime140____std_type_info_name(CpuState *restrict cpu) {
    uint32_t data = isaac_arg(cpu, 0);
    cpu->EAX = 0;
    if (!isaac_is_guest_va(data + 5u)) return;
    uint32_t und = isaac_r32(data);
    if (und && isaac_is_guest_va(und)) { cpu->EAX = und; return; }
    cpu->EAX = data + 4u + (*(const uint8_t *)isaac_g(data + 4u) == '.' ? 1u : 0u);
}
/* RaiseException(code, flags, nargs, args): every C++ throw lands here
 * (_CxxThrowException -> RaiseException(0xE06D7363, ...)). Nothing in this
 * runtime can unwind a guest throw, so the honest answer is a loud stop
 * that names the exception -- the same policy as an unimplemented import. */
void imp_kernel32__RaiseException(CpuState *restrict cpu) {
    uint32_t code = isaac_arg(cpu, 0), nargs = isaac_arg(cpu, 2), args = isaac_arg(cpu, 3);
    uint32_t obj = 0, throwinfo = 0;
    /* 0x406D1388 is MS_VC_EXCEPTION, the "SetThreadName" convention: the
     * raiser wraps it in __try/__except(EXCEPTION_EXECUTE_HANDLER) so a
     * debugger can read {0x1000, name, tid, 0} out of the args, and with no
     * debugger the handler swallows it. Returning normally is that path
     * (round 24d: the theora worker 0x00aab120 names itself first thing). */
    if (code == 0x406D1388u) {
        /* logged once per raise site: a sliced thread job re-enters from
         * the top every frame and names itself again each time */
        static uint32_t seen[8]; static unsigned nseen;
        uint32_t ra = isaac_retaddr(cpu), name;
        unsigned k;
        for (k = 0; k < nseen; ++k) if (seen[k] == ra) return;
        if (nseen < 8u) seen[nseen++] = ra;
        name = (nargs >= 2u && isaac_is_guest_va(args + 7u)) ? isaac_r32(args + 4u) : 0u;
        isaac_log("[isaac][thr] SetThreadName(\"%s\") from 0x%08x: swallowed (further raises from here silent)",
                  name && isaac_is_guest_va(name) ? (const char *)isaac_g(name) : "?", ra);
        return;
    }
    if (code == 0xE06D7363u && nargs >= 3u && isaac_is_guest_va(args + 11u)) {
        obj = isaac_r32(args + 4u); throwinfo = isaac_r32(args + 8u);
    }
    isaac_log("[isaac][TRAP] RaiseException(0x%08x) from 0x%08x%s object 0x%08x throwinfo 0x%08x: "
              "a guest C++ throw; this runtime cannot unwind it.",
              code, isaac_retaddr(cpu), code == 0xE06D7363u ? " (MSVC C++ exception)" : "",
              obj, throwinfo);
    isaac_dump_trap_context(cpu, "RaiseException");
    isaac_shutdown("guest exception thrown");
}

/* ------------------------------------------------------- kernel32 misc --- */
void imp_kernel32__FormatMessageA(CpuState *restrict cpu) {
    uint32_t msgid = isaac_arg(cpu, 2), buf = isaac_arg(cpu, 4), size = isaac_arg(cpu, 5);
    char text[128];
    snprintf(text, sizeof text, "error %u", msgid);
    uint32_t n = (uint32_t)strlen(text);
    if (!buf || !size || !isaac_is_guest_va(buf)) { cpu->EAX = 0; return; }
    if (n + 1u > size) n = size - 1u;
    memcpy(isaac_g(buf), text, n);
    *(uint8_t *)isaac_g(buf + n) = 0;
    cpu->EAX = n;
}
void imp_kernel32__GetProcessTimes(CpuState *restrict cpu) {
    /* creation, exit, kernel, user: FILETIMEs (8 bytes each); zero all four */
    for (unsigned i = 1; i <= 4; ++i) {
        uint32_t ft = isaac_arg(cpu, i);
        if (isaac_is_guest_va(ft + 7u)) { isaac_w32(ft, 0); isaac_w32(ft + 4, 0); }
    }
    cpu->EAX = 1;
}
void imp_kernel32__K32GetProcessMemoryInfo(CpuState *restrict cpu) {
    uint32_t pmc = isaac_arg(cpu, 1), cb = isaac_arg(cpu, 2);
    if (isaac_is_guest_va(pmc) && cb >= 40u) {
        for (uint32_t i = 0; i < cb && i < 44u; i += 4) isaac_w32(pmc + i, 0);
        isaac_w32(pmc, cb);
        extern uint64_t isaac_heap_peak(void);
        isaac_w32(pmc + 8u, (uint32_t)isaac_heap_peak());     /* PeakWorkingSetSize */
        isaac_w32(pmc + 12u, (uint32_t)isaac_heap_peak());    /* WorkingSetSize */
    }
    cpu->EAX = 1;
}
void imp_kernel32__WaitForSingleObjectEx(CpuState *restrict cpu) {
    imp_kernel32__WaitForSingleObject(cpu);       /* same first two arguments */
}
void imp_kernel32__TerminateProcess(CpuState *restrict cpu) {
    isaac_log("[isaac][k32] TerminateProcess(exit code %u) from 0x%08x", isaac_arg(cpu, 1), isaac_retaddr(cpu));
    isaac_shutdown("TerminateProcess");
    cpu->EAX = 1;
}
void imp_kernel32__OpenProcess(CpuState *restrict cpu) {
    cpu->EAX = (ISAAC_MODULE_BASE + 0x40u);                       /* the current process, as a token */
}
void imp_kernel32__GetStartupInfoW(CpuState *restrict cpu) {
    uint32_t si = isaac_arg(cpu, 0);
    if (isaac_is_guest_va(si + 67u)) {
        for (uint32_t i = 0; i < 68u; i += 4) isaac_w32(si + i, 0);
        isaac_w32(si, 68u);                       /* cb */
    }
    cpu->EAX = 0;
}
void imp_kernel32__K32GetProcessImageFileNameA(CpuState *restrict cpu) {
    uint32_t buf = isaac_arg(cpu, 1), size = isaac_arg(cpu, 2);
    static const char name[] = "\\Device\\HarddiskVolume1\\isaac\\isaac-ng.exe";
    uint32_t n = (uint32_t)sizeof name - 1u;
    if (!isaac_is_guest_va(buf) || size <= n) { cpu->EAX = 0; return; }
    memcpy(isaac_g(buf), name, n + 1u);
    cpu->EAX = n;
}
void imp_kernel32__K32GetModuleInformation(CpuState *restrict cpu) {
    uint32_t mi = isaac_arg(cpu, 2), cb = isaac_arg(cpu, 3);
    if (isaac_is_guest_va(mi + 11u) && cb >= 12u) {
        isaac_w32(mi, 0x00400000u);               /* lpBaseOfDll */
        isaac_w32(mi + 4u, 0x00c80000u);          /* SizeOfImage (the placed image span) */
        isaac_w32(mi + 8u, 0x00931050u);          /* EntryPoint */
    }
    cpu->EAX = 1;
}
/* NTSTATUS BCryptGenRandom(hAlg, buf, cb, flags): host-random bytes. */
void imp_bcrypt__BCryptGenRandom(CpuState *restrict cpu) {
    uint32_t buf = isaac_arg(cpu, 1), cb = isaac_arg(cpu, 2);
    if (!isaac_is_guest_va(buf) || (cb && !isaac_is_guest_va(buf + cb - 1u))) { cpu->EAX = 0xC0000008u; return; }
    static uint32_t seed;
    if (!seed) seed = (uint32_t)time(NULL) ^ 0x9E3779B9u;
    for (uint32_t i = 0; i < cb; ++i) {
        seed = seed * 1664525u + 1013904223u;
        *(uint8_t *)isaac_g(buf + i) = (uint8_t)(seed >> 24);
    }
    cpu->EAX = 0;
}

/* ------------------------------------------------------- msvcp facets ----- */
/* bool codecvt_base::always_noconv() const: the char<->char facet never
 * converts. thiscall, no arguments. */
void imp_msvcp140___always_noconv_codecvt_base_std__QBE_NXZ(CpuState *restrict cpu) {
    cpu->EAX = 1;
}
