/* host_shims_misc.c -- the rest of the depth-0/1 initialiser queue.
 *
 * From the lifter's static walk of the 121 _initterm entries:
 *   depth 0: strncpy (73), FlsSetValue, SteamAPI_RegisterCallback, FlsAlloc
 *   depth 1: __stdio_common_vsprintf (10), __setusermatherr, _set_new_mode,
 *            _libm_sse2_sin_precise (26) and the rest of the libm family
 *
 * The walk over-approximates -- untaken branches count -- so some of these may
 * never actually run. That is fine: implementing them is cheap, and each one
 * that is never reached costs nothing, while each one that IS reached and
 * missing costs another STATUS_FATAL_APP_EXIT round trip.
 */

#include "isaac_host.h"
#include "shim_decls.h"

#include <math.h>
#include <time.h>
#include <emscripten/threading.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>   /* getcwd */


/* ---------------------------------------------------------- strings ------ */
/* char *strncpy(char *dst, const char *src, size_t n) -- 73 sites, depth 0.
 * Guarded, like memset: with identity addressing an unchecked destination is
 * a direct route into the runtime. */
void imp_api_ms_win_crt_string__strncpy(CpuState *restrict cpu) {
    uint32_t dst = isaac_arg(cpu, 0), src = isaac_arg(cpu, 1),
             n = isaac_arg(cpu, 2);
    cpu->EAX = dst;
    if (!n) return;
    if (!isaac_is_guest_va(dst) || !isaac_is_guest_va(dst + n - 1)) {
        isaac_log("[isaac][crt] strncpy(dst=0x%08x, n=%u) crosses the guest "
                  "limit -- refusing (caller 0x%08x)",
                  dst, n, isaac_retaddr(cpu));
        return;
    }
    uint32_t i = 0;
    for (; i < n; ++i) {
        uint8_t c = isaac_is_guest_va(src + i) ? isaac_r8(src + i) : 0;
        *(uint8_t *)isaac_g(dst + i) = c;
        if (!c) break;
    }
    for (; i < n; ++i) *(uint8_t *)isaac_g(dst + i) = 0;   /* pad, per spec */
}

/* ------------------------------------------------- fiber-local storage --- */
/* Fls* is the fiber-aware TLS API. Single-threaded, single-fiber: a flat
 * array is the complete and correct implementation. */
#define FLS_SLOTS 128
#define FLS_OUT_OF_INDEXES 0xFFFFFFFFu

static uint32_t g_fls[FLS_SLOTS];
static uint32_t g_fls_cb[FLS_SLOTS];
static uint8_t  g_fls_used[FLS_SLOTS];

void imp_kernel32__FlsAlloc(CpuState *restrict cpu) {
    uint32_t cb = isaac_arg(cpu, 0);
    for (unsigned i = 1; i < FLS_SLOTS; ++i) {       /* index 0 reserved */
        if (g_fls_used[i]) continue;
        g_fls_used[i] = 1;
        g_fls[i] = 0;
        g_fls_cb[i] = cb;
        cpu->EAX = i;
        return;
    }
    isaac_log("[isaac][k32] FlsAlloc: all %d slots in use", FLS_SLOTS);
    cpu->EAX = FLS_OUT_OF_INDEXES;
}

void imp_kernel32__FlsSetValue(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    if (i >= FLS_SLOTS || !g_fls_used[i]) { cpu->EAX = 0; return; }
    g_fls[i] = isaac_arg(cpu, 1);
    cpu->EAX = 1;
}

void imp_kernel32__FlsGetValue(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    cpu->EAX = (i < FLS_SLOTS && g_fls_used[i]) ? g_fls[i] : 0;
}

void imp_kernel32__FlsFree(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    if (i < FLS_SLOTS) { g_fls_used[i] = 0; g_fls[i] = 0; g_fls_cb[i] = 0; }
    cpu->EAX = 1;
}

/* Tls* is the same thing without the callback. GLFW owns all 20 sites. */
static uint32_t g_tls[FLS_SLOTS];
static uint8_t  g_tls_used[FLS_SLOTS];

void imp_kernel32__TlsAlloc(CpuState *restrict cpu) {
    for (unsigned i = 1; i < FLS_SLOTS; ++i)
        if (!g_tls_used[i]) { g_tls_used[i] = 1; g_tls[i] = 0; cpu->EAX = i; return; }
    cpu->EAX = FLS_OUT_OF_INDEXES;
}
void imp_kernel32__TlsGetValue(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    cpu->EAX = (i < FLS_SLOTS && g_tls_used[i]) ? g_tls[i] : 0;
}
void imp_kernel32__TlsSetValue(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    if (i >= FLS_SLOTS) { cpu->EAX = 0; return; }
    g_tls_used[i] = 1;
    g_tls[i] = isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
void imp_kernel32__TlsFree(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    if (i < FLS_SLOTS) g_tls_used[i] = 0;
    cpu->EAX = 1;
}












/* OpenProcessToken: answer access-denied so the caller skips its privilege
 * block -- the same shape as a normal non-elevated run. */
void imp_advapi32__OpenProcessToken(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    isaac_w32(ISAAC_TEB_VA + 0x34, 5u);        /* ERROR_ACCESS_DENIED */
    cpu->EAX = 0;
}

/* MessageBoxA: log and answer IDOK so fatal-dialog callers continue. */
void imp_user32__MessageBoxA(CpuState *restrict cpu) {
    char text[512], cap[128];
    isaac_guest_cstr(isaac_arg(cpu, 1), text, sizeof text, "MessageBoxA text");
    isaac_guest_cstr(isaac_arg(cpu, 2), cap, sizeof cap, "MessageBoxA caption");
    isaac_log("[isaac][ui] MessageBoxA(%s): %s",
              cap[0] ? cap : "(no caption)", text[0] ? text : "(no text)");
    cpu->EAX = 1;                              /* IDOK */
}
/* The main window is the active one once it exists (round 14a: the focus
 * messages go out at the first pump, and GLFW's focused query is
 * GetActiveWindow() == its handle). */
void imp_user32__GetActiveWindow(CpuState *restrict cpu) {
    extern uint32_t isaac_input_focused_hwnd(void);
    (void)cpu;
    cpu->EAX = isaac_input_focused_hwnd();
}

/* ------------------------------------------------------------ system ---- */
/* SYSTEM_INFO (36 bytes on x86-32).  Honest host facts: page size,
 * allocation granularity and address bounds are the wasm runtime's;
 * processor count is the host's logical cores (the game sizes its worker
 * pools from it).  Deterministic baseline: on a node driver run this is
 * os.cpus().length, whatever that machine has. */
void imp_kernel32__GetSystemInfo(CpuState *restrict cpu) {
    uint32_t out = isaac_arg(cpu, 0);
    if (!isaac_is_guest_va(out) || !isaac_is_guest_va(out + 35)) {
        isaac_log("[isaac][k32] GetSystemInfo: output 0x%08x crosses the "
                  "guest limit -- refusing", out);
        cpu->EAX = 0;
        return;
    }
    uint8_t *p = isaac_g(out);
    memset(p, 0, 36);
    *(uint16_t *)isaac_g(out + 0) = 0;     /* wProcessorArchitecture: INTEL */
    isaac_w32(out + 4, 0x1000);            /* dwPageSize (wasm 64KiB pages:
                                              guest heap granularity 4096) */
    isaac_w32(out + 8, 0x00010000);        /* lpMinimumApplicationAddress */
    isaac_w32(out + 12, 0x7ffeffff);       /* lpMaximumApplicationAddress */
    isaac_w32(out + 16, 1u);               /* dwActiveProcessorMask */
    isaac_w32(out + 20, (uint32_t)emscripten_num_logical_cores());
    isaac_w32(out + 24, 586);              /* dwProcessorType */
    isaac_w32(out + 28, 0x10000);          /* dwAllocationGranularity */
    *(uint16_t *)isaac_g(out + 32) = 6;    /* wProcessorLevel (family 6) */
    *(uint16_t *)isaac_g(out + 34) = 0x3c03; /* wProcessorRevision */
}

void imp_kernel32__GetSystemTimeAsFileTime(CpuState *restrict cpu) {
    uint32_t out = isaac_arg(cpu, 0);
    if (!isaac_is_guest_va(out) || !isaac_is_guest_va(out + 7)) {
        cpu->EAX = 0;
        return;
    }
    extern int64_t isaac_epoch_override(void);        /* host_shims_crt_time.c: ISAAC_EPOCH */
    struct timespec ts;
    int64_t ov = isaac_epoch_override();
    if (ov >= 0) { ts.tv_sec = (time_t)ov; ts.tv_nsec = 0; }
    else clock_gettime(CLOCK_REALTIME, &ts);
    uint64_t ft = ((uint64_t)ts.tv_sec + 11644473600ull) * 10000000ull
                + (uint64_t)ts.tv_nsec / 100;
    isaac_w32(out, (uint32_t)ft);
    isaac_w32(out + 4, (uint32_t)(ft >> 32));
}

void imp_kernel32__GetLocalTime(CpuState *restrict cpu) {
    uint32_t out = isaac_arg(cpu, 0);
    if (!isaac_is_guest_va(out) || !isaac_is_guest_va(out + 15)) {
        cpu->EAX = 0;
        return;
    }
    struct timespec ts;
    struct tm tm;
    clock_gettime(CLOCK_REALTIME, &ts);
    localtime_r(&ts.tv_sec, &tm);
    *(uint16_t *)isaac_g(out + 0) = (uint16_t)(tm.tm_year + 1900);
    *(uint16_t *)isaac_g(out + 2) = (uint16_t)(tm.tm_mon + 1);
    *(uint16_t *)isaac_g(out + 4) = (uint16_t)tm.tm_wday;
    *(uint16_t *)isaac_g(out + 6) = (uint16_t)tm.tm_mday;
    *(uint16_t *)isaac_g(out + 8) = (uint16_t)tm.tm_hour;
    *(uint16_t *)isaac_g(out + 10) = (uint16_t)tm.tm_min;
    *(uint16_t *)isaac_g(out + 12) = (uint16_t)tm.tm_sec;
    *(uint16_t *)isaac_g(out + 14) = 0;    /* wMilliseconds */
}

void imp_kernel32__GetCurrentProcessorNumber(CpuState *restrict cpu) {
    cpu->EAX = 0;
}

/* GetModuleFileNameA/W(module, buffer, size).  The only module whose path can
 * be answered honestly is the EXE itself (handle == base address): the wasm
 * build has no on-disk DLLs.  Answer with <cwd>\isaac.exe -- a synthetic but
 * stable path; file ops that use it will fail loud, never silently. */
static uint32_t module_file_name(CpuState *cpu, int wide) {
    uint32_t hModule = isaac_arg(cpu, 0), lpBuffer = isaac_arg(cpu, 1),
             nSize = isaac_arg(cpu, 2);
    if (hModule != 0 && hModule != ISAAC_IMAGE_BASE) {
        isaac_log("[isaac][k32] GetModuleFileName%c: module 0x%08x is not "
                  "addressable (only the EXE image exists here)",
                  wide ? 'W' : 'A', hModule);
        cpu->EAX = 0;
        return 0;
    }
    char cwd[1024], path[2048];
    if (!getcwd(cwd, sizeof cwd)) { cpu->EAX = 0; return 0; }
    snprintf(path, sizeof path, "%s\\isaac.exe", cwd);
    if (!isaac_is_guest_va(lpBuffer) || !isaac_is_guest_va(lpBuffer + nSize - 1)) {
        cpu->EAX = 0;
        return 0;
    }
    if (wide) {
        size_t need = (strlen(path) + 1) * 2;
        if (need > (size_t)nSize) { cpu->EAX = (uint32_t)(need / 2); return 0; }
        uint8_t *p = isaac_g(lpBuffer);
        for (size_t i = 0; i <= strlen(path); ++i) {
            p[2 * i] = (uint8_t)path[i];
            p[2 * i + 1] = 0;
        }
        cpu->EAX = (uint32_t)strlen(path);
    } else {
        size_t need = strlen(path) + 1;
        if (need > (size_t)nSize) { cpu->EAX = (uint32_t)need; return 0; }
        memcpy(isaac_g(lpBuffer), path, need);
        cpu->EAX = (uint32_t)(need - 1);
    }
    return 1;
}

void imp_kernel32__GetModuleFileNameA(CpuState *restrict cpu) { module_file_name(cpu, 0); }
void imp_kernel32__GetModuleFileNameW(CpuState *restrict cpu) { module_file_name(cpu, 1); }

void imp_kernel32__GetTempPathA(CpuState *restrict cpu) {
    uint32_t nSize = isaac_arg(cpu, 0), lpBuffer = isaac_arg(cpu, 1);
    const char *tmp = getenv("TMP");
    if (!tmp || !*tmp) tmp = ".";
    size_t need = strlen(tmp) + 1;
    if (need > nSize || !isaac_is_guest_va(lpBuffer) ||
        !isaac_is_guest_va(lpBuffer + need - 1)) {
        cpu->EAX = 0;
        return;
    }
    memcpy(isaac_g(lpBuffer), tmp, need);
    cpu->EAX = (uint32_t)(need - 1);
}

/* GlobalAlloc/Free/Lock/Unlock: the handle is the pointer (single,
 * non-moveable allocation made with the host allocator).  Raw allocation is
 * a platform primitive per the port policy; zeroing honours GMEM_ZEROINIT. */
void imp_kernel32__GlobalAlloc(CpuState *restrict cpu) {
    uint32_t flags = isaac_arg(cpu, 0), size = isaac_arg(cpu, 1);
    void *p = malloc(size ? size : 1);
    if (p && (flags & 0x40u))                /* GMEM_ZEROINIT */
        memset(p, 0, size);
    cpu->EAX = (uint32_t)(uintptr_t)p;
}
void imp_kernel32__GlobalFree(CpuState *restrict cpu) {
    void *p = (void *)(uintptr_t)isaac_arg(cpu, 0);
    free(p);
    cpu->EAX = 0;
}
void imp_kernel32__GlobalLock(CpuState *restrict cpu) {
    cpu->EAX = isaac_arg(cpu, 0);            /* handle == pointer already */
}
void imp_kernel32__GlobalUnlock(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;                            /* no lock count held */
}

/* ---------------------------------------------------------- env/dirs ---- */
/* kernel32 environment + current-directory queries.  The CRT probes these
 * during initterm (env expansion, TEMP, working dir).  We forward them to
 * the host process env / cwd, which is the only honest answer: returning
 * not-found for a variable the user actually set would silently change the
 * game's behaviour (e.g. renderer overrides, mod paths). */

/* Bounded copy of a guest NUL-terminated string into a host buffer. */

#define ENV_NAME_CAP 512u

#define ENV_SCRATCH_VA    (ISAAC_TEB_VA + 0x4080u)
#define ENV_SCRATCH_CAP   4096u


/* char *getenv(const char *name) -- host env passthrough into a static
 * guest-visible scratch string. The node runtime has no Windows-style
 * USERPROFILE; the port answers it with "." so the game's save-directory
 * bootstrap resolves to the (virtual) current directory. */
void imp_api_ms_win_crt_environment__getenv(CpuState *restrict cpu) {
    char name[512];
    if (!isaac_guest_cstr(isaac_arg(cpu, 0), name, sizeof name, "getenv")) {
        cpu->EAX = 0;
        return;
    }
    const char *val = NULL;
    if (strcmp(name, "USERPROFILE") == 0) {
        val = ".";
    } else {
        val = getenv(name);
    }
    if (!val) {
        cpu->EAX = 0;
        return;
    }
    size_t need = strlen(val) + 1;
    if (need > ENV_SCRATCH_CAP) need = ENV_SCRATCH_CAP;
    memcpy(isaac_g(ENV_SCRATCH_VA), val, need - 1);
    *(uint8_t *)isaac_g(ENV_SCRATCH_VA + need - 1) = 0;
    cpu->EAX = ENV_SCRATCH_VA;
}
void imp_kernel32__GetEnvironmentVariableA(CpuState *restrict cpu) {
    uint32_t lpName = isaac_arg(cpu, 0), lpBuffer = isaac_arg(cpu, 1),
             nSize = isaac_arg(cpu, 2);
    char name[ENV_NAME_CAP];
    if (!isaac_guest_cstr(lpName, name, sizeof name, "GetEnvironmentVariableA")) {
        cpu->EAX = 0;
        isaac_w32(ISAAC_TEB_VA + 0x34, 203u);      /* ERROR_ENVVAR_NOT_FOUND */
        return;
    }
    const char *val = getenv(name);
    if (!val) {
        cpu->EAX = 0;
        isaac_w32(ISAAC_TEB_VA + 0x34, 203u);
        return;
    }
    size_t need = strlen(val) + 1;
    if (!nSize) {                                   /* query size only */
        cpu->EAX = (uint32_t)need;
        return;
    }
    if (need > nSize) {                             /* buffer too small */
        cpu->EAX = (uint32_t)need;
        isaac_w32(ISAAC_TEB_VA + 0x34, 122u);       /* ERROR_INSUFFICIENT_BUFFER */
        return;
    }
    if (!isaac_is_guest_va(lpBuffer) || !isaac_is_guest_va(lpBuffer + need - 1)) {
        isaac_log("[isaac][k32] GetEnvironmentVariableA: buffer 0x%08x(+%u) "
                  "crosses the guest limit -- refusing", lpBuffer, (unsigned)need);
        cpu->EAX = 0;
        isaac_w32(ISAAC_TEB_VA + 0x34, 87u);        /* ERROR_INVALID_PARAMETER */
        return;
    }
    memcpy(isaac_g(lpBuffer), val, need);           /* incl. NUL */
    cpu->EAX = (uint32_t)(need - 1);                /* length, no NUL */
}

void imp_kernel32__GetCurrentDirectoryA(CpuState *restrict cpu) {
    uint32_t nSize = isaac_arg(cpu, 0), lpBuffer = isaac_arg(cpu, 1);
    char cwd[1024];
    if (!getcwd(cwd, sizeof cwd)) {
        cpu->EAX = 0;
        isaac_w32(ISAAC_TEB_VA + 0x34, 3u);         /* ERROR_PATH_NOT_FOUND */
        return;
    }
    size_t need = strlen(cwd) + 1;
    if (need > nSize) {
        cpu->EAX = (uint32_t)need;
        isaac_w32(ISAAC_TEB_VA + 0x34, 122u);
        return;
    }
    if (!isaac_is_guest_va(lpBuffer) || !isaac_is_guest_va(lpBuffer + need - 1)) {
        cpu->EAX = 0;
        isaac_w32(ISAAC_TEB_VA + 0x34, 87u);
        return;
    }
    memcpy(isaac_g(lpBuffer), cwd, need);
    cpu->EAX = (uint32_t)(need - 1);
}

/* -------------------------------------------------------------- Steam ---- */
/* SteamAPI_RegisterCallback is a DEPTH-0 static initialiser: a global
 * constructor registers a callback before main() runs. Steam therefore cannot
 * be deferred behind the renderer the way the census's "stubbable" verdict
 * might suggest -- the stub has to exist and behave sanely at initialisation
 * time. It does: registration is recorded, nothing is ever dispatched, and
 * SteamAPI_RunCallbacks does nothing. An offline single-player build never
 * needs a callback to fire; if one ever must, this is where it hooks in. */
#define MAX_STEAM_CB 64
static struct { uint32_t obj, id; } g_steam_cb[MAX_STEAM_CB];
static unsigned g_steam_cb_n;

void imp_steam_api__SteamAPI_RegisterCallback(CpuState *restrict cpu) {
    uint32_t obj = isaac_arg(cpu, 0), id = isaac_arg(cpu, 1);
    if (g_steam_cb_n < MAX_STEAM_CB) {
        g_steam_cb[g_steam_cb_n].obj = obj;
        g_steam_cb[g_steam_cb_n].id = id;
        ++g_steam_cb_n;
    }
    cpu->EAX = 0;
}

void imp_steam_api__SteamAPI_UnregisterCallback(CpuState *restrict cpu) {
    uint32_t obj = isaac_arg(cpu, 0);
    for (unsigned i = 0; i < g_steam_cb_n; ++i)
        if (g_steam_cb[i].obj == obj) {
            g_steam_cb[i] = g_steam_cb[--g_steam_cb_n];
            break;
        }
    cpu->EAX = 0;
}

/* SteamInternal_ContextInit(void *ctx) -- 67 sites, the busiest Steam symbol.
 * It returns a pointer to a per-interface context the caller then uses. The
 * caller dereferences it, so NULL is not survivable; hand back the pointer it
 * passed in, which is a real, writable, guest-side cell. */
/* SteamInternal_ContextInit: strong implementation moved to
 * host_shims_steam.c (fake CSteamAPIContext object + token vtable). */

void imp_steam_api__SteamAPI_RunCallbacks(CpuState *restrict cpu) {
    cpu->EAX = 0;      /* offline: nothing to dispatch */
}

unsigned isaac_steam_callback_count(void) { return g_steam_cb_n; }

/* --------------------------------------------------------------- stdio --- */
/* int __stdio_common_vsprintf(unsigned __int64 options, char *buf, size_t n,
 *                             const char *fmt, _locale_t, va_list)
 *
 * The 64-bit `options` occupies TWO stack slots, so every later argument is
 * one slot further along than it looks. Getting that wrong silently formats
 * from the wrong pointer.
 *
 * Formatting is delegated to the host vsnprintf, but the va_list is GUEST
 * memory: on x86 cdecl a va_list is simply a pointer to the next stack
 * argument, so arguments are pulled from guest memory one slot at a time. Only
 * the conversions this binary is observed to use are handled; anything else is
 * reported rather than mis-formatted. */
int guest_vsnprintf(uint32_t buf, uint32_t n, uint32_t fmt_va,
                           uint32_t ap, uint32_t caller) {
    char fmt[512];
    unsigned fi = 0;
    for (; fi + 1 < sizeof fmt; ++fi) {
        uint8_t c = isaac_is_guest_va(fmt_va + fi) ? isaac_r8(fmt_va + fi) : 0;
        if (!c) break;
        fmt[fi] = (char)c;
    }
    fmt[fi] = 0;

    char out[1024];
    unsigned o = 0;
    uint32_t arg = ap;
    for (unsigned i = 0; fmt[i] && o + 1 < sizeof out; ) {
        if (fmt[i] != '%') { out[o++] = fmt[i++]; continue; }
        /* copy the whole conversion spec */
        char spec[32];
        unsigned s = 0;
        spec[s++] = fmt[i++];
        while (fmt[i] && s + 1 < sizeof spec &&
               !strchr("diouxXeEfgGcspn%", fmt[i]))
            spec[s++] = fmt[i++];
        char conv = fmt[i] ? fmt[i] : '%';
        spec[s++] = conv;
        spec[s] = 0;
        if (fmt[i]) ++i;

        char piece[256];
        piece[0] = 0;
        switch (conv) {
        case '%': piece[0] = '%'; piece[1] = 0; break;
        case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': case 'c': {
            uint32_t v = isaac_is_guest_va(arg) ? isaac_r32(arg) : 0;
            arg += 4;
            snprintf(piece, sizeof piece, spec, v);
            break;
        }
        case 'e': case 'E': case 'f': case 'g': case 'G': {
            uint64_t lo = isaac_is_guest_va(arg) ? isaac_r32(arg) : 0;
            uint64_t hi = isaac_is_guest_va(arg + 4) ? isaac_r32(arg + 4) : 0;
            arg += 8;                       /* doubles are promoted, 8 bytes */
            uint64_t bits = lo | (hi << 32);
            double d;
            memcpy(&d, &bits, 8);
            snprintf(piece, sizeof piece, spec, d);
            break;
        }
        case 's': {
            uint32_t p = isaac_is_guest_va(arg) ? isaac_r32(arg) : 0;
            arg += 4;
            char tmp[256];
            unsigned k = 0;
            for (; k + 1 < sizeof tmp; ++k) {
                uint8_t c = (p && isaac_is_guest_va(p + k)) ? isaac_r8(p + k) : 0;
                if (!c) break;
                tmp[k] = (char)c;
            }
            tmp[k] = 0;
            snprintf(piece, sizeof piece, spec, tmp);
            break;
        }
        case 'p': {
            uint32_t v = isaac_is_guest_va(arg) ? isaac_r32(arg) : 0;
            arg += 4;
            snprintf(piece, sizeof piece, "0x%08x", v);
            break;
        }
        default:
            isaac_log("[isaac][crt] vsprintf: unsupported conversion '%%%c' in "
                      "\"%s\" (caller 0x%08x) -- emitted literally rather than "
                      "guessed", conv, fmt, caller);
            snprintf(piece, sizeof piece, "%s", spec);
            break;
        }
        for (unsigned k = 0; piece[k] && o + 1 < sizeof out; ++k)
            out[o++] = piece[k];
    }
    out[o] = 0;

    if (!buf || !isaac_is_guest_va(buf)) return (int)o;
    uint32_t lim = n ? (o + 1 < n ? o + 1 : n) : 0;
    for (uint32_t k = 0; k < lim; ++k)
        *(uint8_t *)isaac_g(buf + k) = (uint8_t)out[k];
    if (lim) *(uint8_t *)isaac_g(buf + lim - 1) = 0;
    return (int)o;
}

void imp_api_ms_win_crt_stdio____stdio_common_vsprintf(CpuState *restrict cpu) {
    /* options is __int64: args 0 and 1. buf=2, n=3, fmt=4, locale=5, ap=6. */
    uint32_t buf = isaac_arg(cpu, 2), n = isaac_arg(cpu, 3);
    uint32_t fmt = isaac_arg(cpu, 4), ap = isaac_arg(cpu, 6);
    cpu->EAX = (uint32_t)guest_vsnprintf(buf, n, fmt, ap, isaac_retaddr(cpu));
}


#define VFPRINTF_SCRATCH_VA (ISAAC_TEB_VA + 0x4200u)
void imp_api_ms_win_crt_stdio____stdio_common_vfprintf(CpuState *restrict cpu) {
    /* int __stdio_common_vfprintf(__int64 opt, FILE *s, const char *fmt,
     * _locale_t loc, va_list ap) -- the game logs through this; forward the
     * formatted text to the host console (no guest file target). */
    uint32_t fmt = isaac_arg(cpu, 2), ap = isaac_arg(cpu, 4);
    int n = (int)guest_vsnprintf(VFPRINTF_SCRATCH_VA, 4095u, fmt, ap,
                                 isaac_retaddr(cpu));
    if (n > 0) isaac_log("[isaac][guest-log] %s",
                         (const char *)isaac_g(VFPRINTF_SCRATCH_VA));
    cpu->EAX = (uint32_t)(n < 0 ? -1 : n);
}

void imp_api_ms_win_crt_stdio____stdio_common_vsprintf_s(CpuState *restrict cpu) {
    uint32_t buf = isaac_arg(cpu, 2), n = isaac_arg(cpu, 3);
    uint32_t fmt = isaac_arg(cpu, 4), ap = isaac_arg(cpu, 6);
    cpu->EAX = (uint32_t)guest_vsnprintf(buf, n, fmt, ap, isaac_retaddr(cpu));
}

/* ---------------------------------------------------------------- CRT ---- */
/* void __setusermatherr(void (*)(struct _exception *)) -- the CRT lets an app
 * install a math error handler. Recording it is the implementation; libm here
 * never calls back into it. */
static uint32_t g_matherr;
uint32_t isaac_crt_matherr(void) { return g_matherr; }
void imp_api_ms_win_crt_math____setusermatherr(CpuState *restrict cpu) {
    g_matherr = isaac_arg(cpu, 0);
    cpu->EAX = 0;
}

/* int _set_new_mode(int newhandlermode) -- returns the previous mode. */
static uint32_t g_new_mode;
void imp_api_ms_win_crt_heap___set_new_mode(CpuState *restrict cpu) {
    uint32_t prev = g_new_mode;
    g_new_mode = isaac_arg(cpu, 0);
    cpu->EAX = prev;
}

/* ---------------------------------------------------------------- libm --- */
/* The _libm_sse2_*_precise family takes its argument in XMM0 and returns in
 * XMM0 -- that register convention is the whole reason these variants exist.
 * In the lifter's CpuState, XMM0 is the low 16 bytes of ZMM0.
 *
 * VERIFIED (round 19) by tracing the calls the game actually makes:
 * ISAAC_LIBM_TRACE=1 on a play run prints sane radians and correct results --
 * sin(-3.14057) = -0.00102265, cos(-4.26358986) = -0.433883893 -- from the
 * entity rotation path (0x0041d520/0x0041d540 wrap these for float), so XMM0
 * in and XMM0 out is right. It was previously asserted from the symbol
 * family's documented behaviour and flagged UNVERIFIED. */
static double xmm0_get(CpuState *restrict cpu) {
    double d;
    memcpy(&d, cpu->ZMM0, 8);
    return d;
}
static void xmm0_set(CpuState *restrict cpu, double v) {
    memcpy(cpu->ZMM0, &v, 8);
}

/* ISAAC_LIBM_TRACE=1 prints the first calls of each: the convention above is
 * asserted, not measured, and it feeds the entity rotation extents that
 * decide how many cells CellSpace::insert walks (round 19). */
static int libm_trace(void) {
    static int v = -1;
    if (v < 0) { const char *e = getenv("ISAAC_LIBM_TRACE"); v = (e && *e && *e != '0') ? 1 : 0; }
    return v;
}
#define LIBM1(name, fn) \
    void imp_api_ms_win_crt_math___libm_sse2_##name##_precise( \
            CpuState *restrict cpu) { \
        double a_ = xmm0_get(cpu), r_ = fn(a_); \
        xmm0_set(cpu, r_); \
        if (libm_trace()) { \
            static unsigned n_; \
            if (n_++ < 6u) isaac_log("[isaac][libm] " #name "(%.9g) = %.9g", a_, r_); \
        } \
    }

LIBM1(sin,   sin)
LIBM1(cos,   cos)
LIBM1(tan,   tan)
LIBM1(asin,  asin)
LIBM1(acos,  acos)
LIBM1(atan,  atan)
LIBM1(exp,   exp)
LIBM1(log,   log)
LIBM1(log10, log10)
LIBM1(sqrt,  sqrt)

/* pow takes two: XMM0 and XMM1 (= ZMM1). */
void imp_api_ms_win_crt_math___libm_sse2_pow_precise(CpuState *restrict cpu) {
    double a, b;
    memcpy(&a, cpu->ZMM0, 8);
    memcpy(&b, cpu->ZMM1, 8);
    xmm0_set(cpu, pow(a, b));
}

/* -------------------------------------------------- backtrace ---------- */
/* USHORT RtlCaptureStackBackTrace(ULONG FramesToSkip, ULONG FramesToCapture,
 *                                 PVOID *BackTrace, PULONG BackTraceHash)
 * The x86 stack does not exist in this port, so there are no frames to
 * capture. Returning 0 (and clearing the hash) is the correct "no frames"
 * answer; callers treat 0 as "no backtrace available" (crash reports). */
void imp_kernel32__RtlCaptureStackBackTrace(CpuState *restrict cpu) {
    uint32_t hash = isaac_arg(cpu, 3);
    if (hash && isaac_is_guest_va(hash))
        isaac_w32(hash, 0);
    cpu->EAX = 0;
}
