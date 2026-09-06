/* host_shims_forward.c -- the PROVIDED symbols, actually wired.
 *
 * A verdict is a classification, not an implementation. `QueryPerformanceCounter`
 * was marked PROVIDED -- "emscripten and musl give us this" -- and nothing
 * forwarded it, so the first run to reach it trapped exactly like an
 * unimplemented import.
 *
 * coverage.py swept the whole set and found that was one instance of 371
 * symbols / 16,510 call sites carrying a green verdict with nothing behind it.
 * This file closes the mechanically-forwardable part of that: everything whose
 * shim is "read N arguments off the guest stack, call the host libc, publish
 * the result". Pointer arguments are guard-checked on the way in, because with
 * identity addressing an unchecked guest pointer handed to memcpy is a direct
 * write into the runtime.
 *
 * ABI notes that the macros encode so they cannot be got wrong per-symbol:
 *   - cdecl: the caller cleans, so no shim here adjusts ESP.
 *   - a `double` argument occupies TWO stack slots.
 *   - a `double` RETURN goes in st(0). The lifter models x87 as a double in
 *     the low 8 bytes of the ST register (`native_float80_t` = double, the
 *     remill tradeoff), so writing 8 bytes to cpu->ST0 is the whole story --
 *     no 80-bit extended conversion is involved.
 *   - a 64-bit integer return is EDX:EAX.
 */

#include "isaac_host.h"
#include "shim_decls.h"

#include <ctype.h>
#include <wctype.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- argument / result plumbing ---------------------------------------- */

static int gp_ok(uint32_t p, uint32_t n) {
    if (!p) return 0;
    if (!isaac_is_guest_va(p)) return 0;
    if (n && !isaac_is_guest_va(p + n - 1)) return 0;
    return 1;
}

/* A guest pointer that must be readable/writable for n bytes, else the shim
 * reports and does nothing rather than corrupting the runtime. */
#define GPTR(name, idx, nbytes)                                               \
    uint32_t name = isaac_arg(cpu, idx);                                      \
    if ((nbytes) && !gp_ok(name, (nbytes))) {                                 \
        isaac_log("[isaac][fwd] %s: guest pointer 0x%08x (+%u) is out of "    \
                  "range (caller 0x%08x)", __func__, name,                    \
                  (unsigned)(nbytes), isaac_retaddr(cpu));                    \
        cpu->EAX = 0;                                                         \
        return;                                                               \
    }

static const char *gstr(uint32_t va) {
    /* Identity addressing: a guest char* IS a char*. Only the range needs
     * checking; the bytes are already where C expects them. */
    return isaac_is_guest_va(va) ? (const char *)isaac_g(va) : "";
}

static double arg_d(const CpuState *cpu, unsigned slot) {
    uint64_t lo = isaac_arg(cpu, slot), hi = isaac_arg(cpu, slot + 1);
    uint64_t b = lo | (hi << 32);
    double d;
    memcpy(&d, &b, 8);
    return d;
}

static float arg_f(const CpuState *cpu, unsigned slot) {
    uint32_t b = isaac_arg(cpu, slot);
    float f;
    memcpy(&f, &b, 4);
    return f;
}

/* st(0) return. See the ABI note above: 8 bytes, not 10. */
static void ret_d(CpuState *cpu, double v) { memcpy(cpu->ST0, &v, 8); }
static void ret_f(CpuState *cpu, float v) { ret_d(cpu, (double)v); }
static void ret_i64(CpuState *cpu, uint64_t v) {
    cpu->EAX = (uint32_t)v;
    cpu->EDX = (uint32_t)(v >> 32);
}

/* ---- macros for the repetitive shapes ---------------------------------- */

#define FWD_D_D(cident, fn)                                                   \
    void cident(CpuState *restrict cpu) { ret_d(cpu, fn(arg_d(cpu, 0))); }

#define FWD_F_F(cident, fn)                                                   \
    void cident(CpuState *restrict cpu) { ret_f(cpu, fn(arg_f(cpu, 0))); }

#define FWD_I_I(cident, fn)                                                   \
    void cident(CpuState *restrict cpu) {                                     \
        cpu->EAX = (uint32_t)fn((int)isaac_arg(cpu, 0));                      \
    }

/* ---- memory ------------------------------------------------------------ */

void imp_vcruntime140__memcpy(CpuState *restrict cpu) {
    uint32_t n = isaac_arg(cpu, 2);
    GPTR(dst, 0, n) GPTR(src, 1, n)
    if (n) memcpy(isaac_g(dst), isaac_g(src), n);
    cpu->EAX = dst;
}

void imp_vcruntime140__memmove(CpuState *restrict cpu) {
    uint32_t n = isaac_arg(cpu, 2);
    GPTR(dst, 0, n) GPTR(src, 1, n)
    if (n) memmove(isaac_g(dst), isaac_g(src), n);
    cpu->EAX = dst;
}

void imp_vcruntime140__memchr(CpuState *restrict cpu) {
    uint32_t n = isaac_arg(cpu, 2);
    GPTR(p, 0, n)
    void *r = n ? memchr(isaac_g(p), (int)(isaac_arg(cpu, 1) & 0xFF), n) : NULL;
    cpu->EAX = r ? isaac_va(r) : 0;
}

void imp_vcruntime140__strstr(CpuState *restrict cpu) {
    const char *h = gstr(isaac_arg(cpu, 0)), *nd = gstr(isaac_arg(cpu, 1));
    const char *r = strstr(h, nd);
    cpu->EAX = r ? isaac_va(r) : 0;
}

void imp_vcruntime140__strchr(CpuState *restrict cpu) {
    const char *s = gstr(isaac_arg(cpu, 0));
    const char *r = strchr(s, (int)(isaac_arg(cpu, 1) & 0xFF));
    cpu->EAX = r ? isaac_va(r) : 0;
}

/* ---- strings ----------------------------------------------------------- */

void imp_api_ms_win_crt_string__strncmp(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)strncmp(gstr(isaac_arg(cpu, 0)),
                                 gstr(isaac_arg(cpu, 1)), isaac_arg(cpu, 2));
}
void imp_api_ms_win_crt_string___stricmp(CpuState *restrict cpu) {
    const char *a = gstr(isaac_arg(cpu, 0)), *b = gstr(isaac_arg(cpu, 1));
    int r = 0;
    for (size_t i = 0; ; ++i) {
        int x = tolower((unsigned char)a[i]), y = tolower((unsigned char)b[i]);
        if (x != y) { r = x - y; break; }
        if (!x) break;
    }
    cpu->EAX = (uint32_t)r;
}
void imp_api_ms_win_crt_string___strnicmp(CpuState *restrict cpu) {
    const char *a = gstr(isaac_arg(cpu, 0)), *b = gstr(isaac_arg(cpu, 1));
    uint32_t n = isaac_arg(cpu, 2);
    int r = 0;
    for (uint32_t i = 0; i < n; ++i) {
        int x = tolower((unsigned char)a[i]), y = tolower((unsigned char)b[i]);
        if (x != y) { r = x - y; break; }
        if (!x) break;
    }
    cpu->EAX = (uint32_t)r;
}
void imp_api_ms_win_crt_string__strpbrk(CpuState *restrict cpu) {
    const char *r = strpbrk(gstr(isaac_arg(cpu, 0)), gstr(isaac_arg(cpu, 1)));
    cpu->EAX = r ? isaac_va(r) : 0;
}

/* strspn/strcspn -- the controller-DB parser (sub_00a25770, SDL
 * GameControllerDB line split) reaches both through REGISTER-HELD calls
 * (`mov esi,[0xb18950]; call esi` at 0x00a2592e and `mov edx,[0xb1894c];
 * mov [ebp-0xd0],edx; ...; call [ebp-0xd0]` at 0x00a259ce), so the push-count
 * census measured 0 call sites and classified both NEVER_CALLED. The stub
 * returned 0 for every token split, the parse failed for every one of the
 * 365 database lines, and the game reported GLFW_INVALID_VALUE per line
 * before bailing with exit(1). Measured at 0x00a6a5a2 (one call per line). */
void imp_api_ms_win_crt_string__strspn(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)strspn(gstr(isaac_arg(cpu, 0)), gstr(isaac_arg(cpu, 1)));
}
void imp_api_ms_win_crt_string__strcspn(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)strcspn(gstr(isaac_arg(cpu, 0)), gstr(isaac_arg(cpu, 1)));
}

/* The _s variants return errno_t and truncate rather than overflow. */
void imp_api_ms_win_crt_string__strcpy_s(CpuState *restrict cpu) {
    uint32_t n = isaac_arg(cpu, 1);
    GPTR(dst, 0, n)
    const char *src = gstr(isaac_arg(cpu, 2));
    size_t l = strlen(src);
    if (l + 1 > n) { *(char *)isaac_g(dst) = 0; cpu->EAX = 34; return; } /* ERANGE */
    memcpy(isaac_g(dst), src, l + 1);
    cpu->EAX = 0;
}
void imp_api_ms_win_crt_string__strncpy_s(CpuState *restrict cpu) {
    uint32_t n = isaac_arg(cpu, 1), cnt = isaac_arg(cpu, 3);
    GPTR(dst, 0, n)
    const char *src = gstr(isaac_arg(cpu, 2));
    size_t l = strnlen(src, cnt);
    if (l + 1 > n) { *(char *)isaac_g(dst) = 0; cpu->EAX = 34; return; }
    memcpy(isaac_g(dst), src, l);
    ((char *)isaac_g(dst))[l] = 0;
    cpu->EAX = 0;
}
void imp_api_ms_win_crt_string__strcat_s(CpuState *restrict cpu) {
    uint32_t n = isaac_arg(cpu, 1);
    GPTR(dst, 0, n)
    const char *src = gstr(isaac_arg(cpu, 2));
    char *d = (char *)isaac_g(dst);
    size_t dl = strnlen(d, n), sl = strlen(src);
    if (dl + sl + 1 > n) { cpu->EAX = 34; return; }
    memcpy(d + dl, src, sl + 1);
    cpu->EAX = 0;
}

/* _strdup allocates, and it MUST allocate in the guest arena -- a host pointer
 * handed back here would be above the guard. */
extern uint32_t isaac_guest_alloc(uint32_t n);
void imp_api_ms_win_crt_string___strdup(CpuState *restrict cpu) {
    const char *s = gstr(isaac_arg(cpu, 0));
    size_t l = strlen(s) + 1;
    uint32_t p = isaac_guest_alloc((uint32_t)l);
    if (p) memcpy(isaac_g(p), s, l);
    cpu->EAX = p;
}

FWD_I_I(imp_api_ms_win_crt_string__tolower, tolower)
FWD_I_I(imp_api_ms_win_crt_string__toupper, toupper)
FWD_I_I(imp_api_ms_win_crt_string__isdigit, isdigit)
FWD_I_I(imp_api_ms_win_crt_string__isspace, isspace)
FWD_I_I(imp_api_ms_win_crt_string__ispunct, ispunct)
FWD_I_I(imp_api_ms_win_crt_string__iswspace, iswspace)

/* ---- conversion -------------------------------------------------------- */

void imp_api_ms_win_crt_convert__atoi(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)atoi(gstr(isaac_arg(cpu, 0)));
}
void imp_api_ms_win_crt_convert__atof(CpuState *restrict cpu) {
    ret_d(cpu, atof(gstr(isaac_arg(cpu, 0))));
}
void imp_api_ms_win_crt_convert__strtol(CpuState *restrict cpu) {
    uint32_t endp = isaac_arg(cpu, 1);
    const char *s = gstr(isaac_arg(cpu, 0));
    char *e = NULL;
    long v = strtol(s, &e, (int)isaac_arg(cpu, 2));
    if (endp && isaac_is_guest_va(endp)) isaac_w32(endp, e ? isaac_va(e) : 0);
    cpu->EAX = (uint32_t)v;
}
void imp_api_ms_win_crt_convert__strtoul(CpuState *restrict cpu) {
    uint32_t endp = isaac_arg(cpu, 1);
    const char *s = gstr(isaac_arg(cpu, 0));
    char *e = NULL;
    unsigned long v = strtoul(s, &e, (int)isaac_arg(cpu, 2));
    if (endp && isaac_is_guest_va(endp)) isaac_w32(endp, e ? isaac_va(e) : 0);
    cpu->EAX = (uint32_t)v;
}
void imp_api_ms_win_crt_convert__strtoull(CpuState *restrict cpu) {
    uint32_t endp = isaac_arg(cpu, 1);
    const char *s = gstr(isaac_arg(cpu, 0));
    char *e = NULL;
    unsigned long long v = strtoull(s, &e, (int)isaac_arg(cpu, 2));
    if (endp && isaac_is_guest_va(endp)) isaac_w32(endp, e ? isaac_va(e) : 0);
    ret_i64(cpu, v);          /* 64-bit return is EDX:EAX */
}

/* ---- math -------------------------------------------------------------- */

FWD_D_D(imp_api_ms_win_crt_math__floor, floor)
FWD_D_D(imp_api_ms_win_crt_math__ceil,  ceil)
FWD_F_F(imp_api_ms_win_crt_math__roundf, roundf)

void imp_api_ms_win_crt_math__ldexp(CpuState *restrict cpu) {
    ret_d(cpu, ldexp(arg_d(cpu, 0), (int)isaac_arg(cpu, 2)));
}
void imp_api_ms_win_crt_math__modf(CpuState *restrict cpu) {
    uint32_t ip = isaac_arg(cpu, 2);
    double intpart = 0.0;
    double frac = modf(arg_d(cpu, 0), &intpart);
    if (ip && isaac_is_guest_va(ip))
        memcpy(isaac_g(ip), &intpart, 8);
    ret_d(cpu, frac);
}
void imp_api_ms_win_crt_math__copysignf(CpuState *restrict cpu) {
    ret_f(cpu, copysignf(arg_f(cpu, 0), arg_f(cpu, 1)));
}
void imp_api_ms_win_crt_math__fminf(CpuState *restrict cpu) {
    ret_f(cpu, fminf(arg_f(cpu, 0), arg_f(cpu, 1)));
}
void imp_api_ms_win_crt_math__nextafterf(CpuState *restrict cpu) {
    ret_f(cpu, nextafterf(arg_f(cpu, 0), arg_f(cpu, 1)));
}
/* ---- x87 register-convention helpers (round 14e) ----------------------
 * `_CIfmod` / `_CIatan2` take their two arguments on the x87 stack -- MSVC
 * emits `fld x; fld y; call _CIfmod`, so the FIRST C argument is ST(1) and
 * the second ST(0) -- and return the result in ST(0) with the stack popped
 * once (two inputs replaced by one result). The lifter models the x87
 * stack as ST0..ST7 shifted by 10-byte copies on fld/fstp, values stored as
 * doubles in the low 8 bytes (see ret_d above), so the pop is a shift of
 * ST2..ST7 down by one. Reached through the CRT's own `jmp [__imp__CI*]`
 * thunks (sub_00af08c3 / sub_00af08c9), which the lifter turns into the
 * shim call plus the thunk's own ret. The room's first entity spawn is the
 * first caller of _CIfmod (an angle wrap). */
static double st_d(const CpuState *cpu, int i) {
    const uint8_t *st = i == 0 ? cpu->ST0 : i == 1 ? cpu->ST1 : cpu->ST2;
    double v;
    memcpy(&v, st, 8);
    return v;
}
static void st_pop_result(CpuState *cpu, double r) {
    memcpy(cpu->ST1, cpu->ST2, 10);
    memcpy(cpu->ST2, cpu->ST3, 10);
    memcpy(cpu->ST3, cpu->ST4, 10);
    memcpy(cpu->ST4, cpu->ST5, 10);
    memcpy(cpu->ST5, cpu->ST6, 10);
    memcpy(cpu->ST6, cpu->ST7, 10);
    memset(cpu->ST7, 0, 10);
    memcpy(cpu->ST0, &r, 8);
    memset(cpu->ST0 + 8, 0, 2);
}
void imp_api_ms_win_crt_math___CIfmod(CpuState *restrict cpu) {
    double x = st_d(cpu, 1), y = st_d(cpu, 0);
    st_pop_result(cpu, fmod(x, y));
}
void imp_api_ms_win_crt_math___CIatan2(CpuState *restrict cpu) {
    double y = st_d(cpu, 1), x = st_d(cpu, 0);
    st_pop_result(cpu, atan2(y, x));
}

void imp_api_ms_win_crt_math___fdclass(CpuState *restrict cpu) {
    float f = arg_f(cpu, 0);
    int c = fpclassify(f);
    /* MSVC _FPCLASS-ish: 0 finite, 1 inf, 2 nan, 4 subnormal, 8 zero. */
    cpu->EAX = (c == FP_NAN) ? 2u : (c == FP_INFINITE) ? 1u :
               (c == FP_ZERO) ? 8u : (c == FP_SUBNORMAL) ? 4u : 0u;
}

/* ---- utility ----------------------------------------------------------- */

void imp_api_ms_win_crt_utility__rand(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)(rand() & 0x7FFF);   /* MSVC RAND_MAX is 0x7FFF */
}
void imp_api_ms_win_crt_utility__srand(CpuState *restrict cpu) {
    srand(isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

/* ======================================================================== *
 *  Timing: QueryPerformanceCounter / QueryPerformanceFrequency
 *
 *  DESIGN DECISION: the counter is DETERMINISTIC, not wall-clock.
 *
 *  It advances by a fixed tick on every query rather than reading
 *  performance.now(). Three reasons, in order of weight:
 *
 *  1. This project's verification rests on reproducibility. The oracle
 *     compares register and memory deltas across runs; a wall clock makes
 *     every trace differ from every other trace, and turns "did this change
 *     behaviour" into a question nobody can answer cheaply. A deterministic
 *     counter makes the whole port replayable.
 *  2. The first consumer is a SEED GENERATOR. FUN_00aea110 runs a lowbias32
 *     avalanche (imul 0x7feb352d, imul 0x846ca68b) over the counter value, so
 *     it needs monotonicity and nothing else -- not precision, not epoch.
 *  3. Browser clocks are deliberately coarsened and jittered against timing
 *     attacks, so `performance.now()` is not the high-resolution source the
 *     API name promises anyway.
 *
 *  The cost is real and worth stating: any code that measures elapsed time to
 *  pace itself -- frame limiters, animation timing -- will see time advance
 *  per *call*, not per second. Those consumers want a real clock. So this is
 *  switchable at runtime via isaac_time_set_mode(), and the frame loop should
 *  select WALL once it exists. Defaulting to DETERMINISTIC keeps every run up
 *  to that point reproducible.
 *
 *  QPF and QPC are chosen together so the pair is self-consistent: frequency
 *  is 10 MHz, and the deterministic tick is 1 -> each query advances 100 ns of
 *  notional time, and (counter / frequency) is a sane number of seconds.
 * ======================================================================== */

#define ISAAC_QPF_HZ 10000000ull       /* 10 MHz: 100 ns per tick */

typedef enum { ISAAC_TIME_DETERMINISTIC = 0, ISAAC_TIME_WALL = 1 } isaac_time_mode;
static isaac_time_mode g_time_mode = ISAAC_TIME_DETERMINISTIC;
static uint64_t g_qpc_ticks;
static uint64_t g_qpc_queries;

void isaac_time_set_mode(int mode) {
    g_time_mode = mode ? ISAAC_TIME_WALL : ISAAC_TIME_DETERMINISTIC;
    isaac_log("[isaac][time] QueryPerformanceCounter mode = %s",
              g_time_mode ? "WALL (performance.now)" : "DETERMINISTIC");
}
uint64_t isaac_time_queries(void) { return g_qpc_queries; }

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
static uint64_t wall_ticks(void) {
    double ms = emscripten_get_now();
    return (uint64_t)(ms * (double)(ISAAC_QPF_HZ / 1000ull));
}
#else
#include <time.h>
static uint64_t wall_ticks(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * ISAAC_QPF_HZ +
           (uint64_t)ts.tv_nsec / (1000000000ull / ISAAC_QPF_HZ);
}
#endif

/* BOOL QueryPerformanceCounter(LARGE_INTEGER *out) -- stdcall, 4 bytes.
 * Writes a 64-bit counter; returns TRUE. Monotonic by construction in both
 * modes: the deterministic one only ever increments, and the wall mode is
 * clamped so a coarsened browser clock can never appear to go backwards. */
void imp_kernel32__QueryPerformanceCounter(CpuState *restrict cpu) {
    uint32_t out = isaac_arg(cpu, 0);
    ++g_qpc_queries;
    uint64_t t;
    if (g_time_mode == ISAAC_TIME_WALL) {
        t = wall_ticks();
        if (t <= g_qpc_ticks) t = g_qpc_ticks + 1;   /* never go backwards */
        g_qpc_ticks = t;
    } else {
        t = ++g_qpc_ticks;
    }
    if (out && gp_ok(out, 8)) {
        isaac_w32(out, (uint32_t)t);
        isaac_w32(out + 4, (uint32_t)(t >> 32));
        cpu->EAX = 1;
    } else {
        cpu->EAX = 0;
    }
}

void imp_kernel32__QueryPerformanceFrequency(CpuState *restrict cpu) {
    uint32_t out = isaac_arg(cpu, 0);
    if (out && gp_ok(out, 8)) {
        isaac_w32(out, (uint32_t)ISAAC_QPF_HZ);
        isaac_w32(out + 4, (uint32_t)(ISAAC_QPF_HZ >> 32));
        cpu->EAX = 1;
    } else {
        cpu->EAX = 0;
    }
}

#ifdef ISAAC_WEB
/* Interactive mode (round 25): the game's pacing Sleep becomes a real
 * wall-clock wait -- a JSPI suspension, so the run proceeds in real time and
 * the page's event loop runs meanwhile. Never from a thread slice: a sliced
 * job's Sleep would park the whole frame loop for the job's delay, three
 * times per frame (the slice yields instead, in the shim below). Capped at
 * 50 ms so a long guest sleep cannot freeze the page. */
static void sleep_yield_web(uint32_t ms) {
    extern int isaac_web_yield_enabled(void), isaac_threads_slicing(void);
    if (ms && isaac_web_yield_enabled() && !isaac_threads_slicing())
        emscripten_sleep(ms > 50u ? 50u : ms);
}
#else
#define sleep_yield_web(ms) ((void)(ms))
#endif
/* Sleep in a browser cannot block. The one honest thing is to advance the
 * deterministic clock by the requested amount and return. */
void isaac_threads_run_pending(CpuState *restrict cpu);   /* host_shims_module.c */
void imp_kernel32__Sleep(CpuState *restrict cpu) {
    uint32_t ms = isaac_arg(cpu, 0);
    isaac_threads_run_pending(cpu);          /* a yield point (ISAAC_RUN_THREADS) */
    if (g_time_mode == ISAAC_TIME_DETERMINISTIC)
        g_qpc_ticks += (uint64_t)ms * (ISAAC_QPF_HZ / 1000ull);
    cpu->EAX = 0;
    sleep_yield_web(ms);                     /* interactive pacing (round 25) */
    /* a sliced thread job sleeping is a thread job done for this frame (round 24) */
    { extern void isaac_threads_yield(void); isaac_threads_yield(); }
}

void imp_kernel32__GetCurrentThreadId(CpuState *restrict cpu) { cpu->EAX = 1; }
void imp_kernel32__GetCurrentProcessId(CpuState *restrict cpu) { cpu->EAX = 1; }
void imp_kernel32__GetCurrentProcess(CpuState *restrict cpu) {
    cpu->EAX = 0xFFFFFFFFu;                  /* the real pseudo-handle */
}
void imp_kernel32__GetLastError(CpuState *restrict cpu) {
    cpu->EAX = isaac_r32(ISAAC_TEB_VA + 0x34);
}
void imp_kernel32__SetLastError(CpuState *restrict cpu) {
    isaac_w32(ISAAC_TEB_VA + 0x34, isaac_arg(cpu, 0));
    cpu->EAX = 0;
}
