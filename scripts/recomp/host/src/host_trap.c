/* host_trap.c -- the loud-stub engine.
 *
 * The rule this file enforces: an unimplemented import is OBSERVABLE.
 * There is no path through this code that returns a plausible value without
 * first saying so. Two behaviours, chosen per symbol:
 *
 *   isaac_stub_hit()  report once, keep counting, let the guest continue.
 *                     For calls whose result genuinely does not matter
 *                     (EnterCriticalSection in a single-threaded build).
 *   isaac_trap()      report and abort. For calls whose result cannot be
 *                     faked -- returning 0 from EOS_Platform_Create would
 *                     produce a null-deref 40 frames later with no clue why.
 *
 * Both print the guest return address, so a report names the CALL SITE, not
 * just the symbol. That is the difference between "EOS_Lobby_JoinLobby was
 * called" and "EOS_Lobby_JoinLobby was called from 0x0089f1a2".
 */

#include "isaac_host.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Register dump for the mem-fault handler (recomp_rt.c calls this when
 * recomp_last_cpu is set). Order: EAX ECX EDX EBX ESP EBP ESI EDI EIP. */
void isaac_dump_regs(const CpuState *s, const char *tag) {
    fprintf(stderr, "[recomp][MEM] ---- %s:\n", tag);
    fprintf(stderr, "[recomp][MEM]   EAX=0x%08x ECX=0x%08x EDX=0x%08x EBX=0x%08x\n",
            s->EAX, s->ECX, s->EDX, s->EBX);
    fprintf(stderr, "[recomp][MEM]   ESP=0x%08x EBP=0x%08x ESI=0x%08x EDI=0x%08x\n",
            s->ESP, s->EBP, s->ESI, s->EDI);
    fprintf(stderr, "[recomp][MEM]   EIP=0x%08x  (this state was captured at the last shim call;\n"
            "[recomp][MEM]    the dispatcher has since added 4+arg_bytes to ESP)\n",
            s->EIP);
}

/* Full trap context for a shim that stops the run (noreturn CRT entry points,
 * abort paths): the last 512 executed guest VAs, the LIVE registers at the
 * shim call, and the guest stack from ESP upward -- the return-address chain
 * in that window is the call stack, which the VA trace alone cannot show
 * once the fault is inside a shared helper (boot round 11: a
 * vector::_Tidy big-allocation check reached from 82 callers). */
/* For traps the host never sees (V8's "Maximum call stack size exceeded",
 * a raw wasm trap): the drivers call this from their catch path. Prints the
 * hottest addresses of the last 512 executed guest VAs (a recursion cycle
 * is a few addresses repeating) and the last 64 in order. */
void isaac_dump_va_ring(void) {
    extern volatile uint32_t recomp_va_trace[512];
    extern volatile uint32_t recomp_va_trace_idx;
    uint32_t vas[512]; unsigned cnt[512]; unsigned n = 0;
    for (unsigned i = 0; i < 512; i++) {
        uint32_t v = recomp_va_trace[i];
        unsigned k;
        for (k = 0; k < n; k++) if (vas[k] == v) { cnt[k]++; break; }
        if (k == n) { vas[n] = v; cnt[n] = 1; n++; }
    }
    fprintf(stderr, "[isaac][ring] ---- hottest guest VAs in the last 512 executed (count va):\n");
    for (unsigned round = 0; round < 16 && round < n; round++) {
        unsigned best = 0;
        for (unsigned k = 1; k < n; k++) if (cnt[k] > cnt[best]) best = k;
        if (!cnt[best]) break;
        fprintf(stderr, "[isaac][ring]   %3u 0x%08x\n", cnt[best], vas[best]);
        cnt[best] = 0;
    }
    uint32_t start = recomp_va_trace_idx & 511u;
    fprintf(stderr, "[isaac][ring] ---- last 64 executed guest VAs (oldest -> newest):\n");
    for (unsigned i = 448; i < 512; i++) {
        uint32_t v = recomp_va_trace[(start + i) & 511u];
        fprintf(stderr, "%s%08x%s", (i - 448) % 8 == 0 ? "[isaac][ring]   " : " ", v, (i - 448) % 8 == 7 ? "\n" : "");
    }
    fprintf(stderr, "[isaac][ring] %u distinct addresses in the ring\n", n);
    /* the guest stack: return addresses between the last spilled ESP and
     * the stack top, most recent first, plus a histogram of the callers */
    extern struct CpuState *recomp_last_cpu;
    if (!recomp_last_cpu) { fprintf(stderr, "[isaac][ring] no register image\n"); return; }
    uint32_t esp = ((const uint32_t *)recomp_last_cpu)[4];
    fprintf(stderr, "[isaac][ring] ---- guest stack walk from the spilled ESP 0x%08x (return addresses into .text):\n", esp);
    uint32_t seen_va[256]; unsigned seen_cnt[256]; unsigned nseen = 0; unsigned printed = 0, total = 0;
    for (uint32_t a = esp & ~3u; a + 4u <= ISAAC_STACK_TOP_VA && a >= ISAAC_STACK_TOP_VA - 0x110000u; a += 4u) {
        if (!isaac_is_guest_va(a)) break;
        uint32_t v = isaac_r32(a);
        if (v < 0x00401000u || v >= 0x00b10000u) continue;
        /* a return address: the dword before it must look like a call
         * (E8 rel32, or FF /2 forms); check the E8 case only */
        uint8_t op = isaac_is_guest_va(v - 5u) ? *(const uint8_t *)isaac_g(v - 5u) : 0;
        uint8_t op2 = isaac_is_guest_va(v - 2u) ? *(const uint8_t *)isaac_g(v - 2u) : 0;
        uint8_t op6 = isaac_is_guest_va(v - 6u) ? *(const uint8_t *)isaac_g(v - 6u) : 0;
        if (op != 0xE8 && op2 != 0xFF && op6 != 0xFF) continue;
        ++total;
        if (printed < 48) { fprintf(stderr, "%s%08x%s", printed % 8 == 0 ? "[isaac][ring]   " : " ", v, printed % 8 == 7 ? "\n" : ""); ++printed; }
        unsigned k;
        for (k = 0; k < nseen; k++) if (seen_va[k] == v) { seen_cnt[k]++; break; }
        if (k == nseen && nseen < 256) { seen_va[nseen] = v; seen_cnt[nseen] = 1; nseen++; }
    }
    if (printed % 8) fprintf(stderr, "\n");
    fprintf(stderr, "[isaac][ring] %u call-shaped return addresses on the guest stack; most repeated:\n", total);
    for (unsigned round = 0; round < 12 && round < nseen; round++) {
        unsigned best = 0;
        for (unsigned k = 1; k < nseen; k++) if (seen_cnt[k] > seen_cnt[best]) best = k;
        if (seen_cnt[best] < 2) break;
        fprintf(stderr, "[isaac][ring]   %4u x 0x%08x\n", seen_cnt[best], seen_va[best]);
        seen_cnt[best] = 0;
    }
}

void isaac_dump_trap_context(const CpuState *cpu, const char *tag) {
    extern volatile uint32_t recomp_va_trace_idx;
    extern volatile uint32_t recomp_va_trace[512];
    uint32_t n = recomp_va_trace_idx < 512u ? recomp_va_trace_idx : 512u;
    uint32_t start = (recomp_va_trace_idx - n) & 511u;
    fprintf(stderr, "[recomp][TRAP] %s\n", tag);
    fprintf(stderr, "[recomp][TRAP] ---- last %u executed guest VAs (oldest -> newest):\n", n);
    for (uint32_t i = 0; i < n; i++)
        fprintf(stderr, "[recomp][TRAP]   %08x\n", recomp_va_trace[(start + i) & 511u]);
    fprintf(stderr, "[recomp][TRAP] ---- live registers at the shim call:\n");
    fprintf(stderr, "[recomp][TRAP]   EAX=0x%08x ECX=0x%08x EDX=0x%08x EBX=0x%08x\n",
            cpu->EAX, cpu->ECX, cpu->EDX, cpu->EBX);
    fprintf(stderr, "[recomp][TRAP]   ESP=0x%08x EBP=0x%08x ESI=0x%08x EDI=0x%08x\n",
            cpu->ESP, cpu->EBP, cpu->ESI, cpu->EDI);
    fprintf(stderr, "[recomp][TRAP] ---- guest stack from ESP (return addresses mark the callers):\n");
    for (uint32_t i = 0; i < 96; i += 4) {
        uint32_t a = cpu->ESP + i * 4u;
        if (!isaac_is_guest_va(a + 15u)) break;
        fprintf(stderr, "[recomp][TRAP]   %08x: %08x %08x %08x %08x\n", a,
                isaac_r32(a), isaac_r32(a + 4u), isaac_r32(a + 8u), isaac_r32(a + 12u));
    }
}

/* Weak so the host layer links standalone; the real ones live in
 * host_shims_module.c and host_shims_heap.c. */
__attribute__((weak)) void isaac_module_report(void) {}
__attribute__((weak)) void isaac_heap_report(void) {}

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

#define ISAAC_MAX_TRACKED 1024

typedef struct {
    const isaac_import *imp;
    uint32_t hits;
    uint32_t first_caller;
} stub_record;

static stub_record g_records[ISAAC_MAX_TRACKED];
static unsigned g_record_count;
static unsigned g_total_stub_calls;

void isaac_log(const char *fmt, ...) {
    /* ISAAC_LOG_TIME=1: prefix the elapsed wall time in ms since the first
     * log line, so a long boot can be profiled from its log alone. */
    static int stamp = -1;
    static double t0;
    if (stamp < 0) {
        const char *e = getenv("ISAAC_LOG_TIME");
        stamp = (e && *e && *e != '0');
        t0 = emscripten_get_now();
    }
    if (stamp) fprintf(stderr, "[%9.1f] ", emscripten_get_now() - t0);
    { extern double recomp_last_log_ms; recomp_last_log_ms = emscripten_get_now(); }
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
#ifdef __EMSCRIPTEN__
    /* console.warn keeps these out of the ordinary stdout stream so they are
     * still visible when the game is spamming its own logging. */
    EM_ASM({ console.warn(UTF8ToString($0)); }, buf);
#else
    fputs(buf, stderr);
    fputc('\n', stderr);
#endif
}


/* The value on the guest stack is the RETURN address the `call` pushed, not
 * the call itself. Reporting it sends whoever is debugging to the instruction
 * AFTER the one they want -- for `_set_app_type` that is 0x00aefa07 when the
 * call is at 0x00aefa02. Recover the call site by checking, at each plausible
 * length, whether the bytes there decode as a call of exactly that length.
 * Returns 0 if nothing matches, and the caller then reports only the return
 * address rather than inventing one. */
uint32_t isaac_call_site_from_return(uint32_t ret) {
    if (!isaac_in_image(ret) || ret < ISAAC_TEXT_VA + 8)
        return 0;
    const uint8_t *p;
    /* E8 rel32                  -> 5 bytes */
    p = (const uint8_t *)isaac_g(ret - 5);
    if (p[0] == 0xE8) return ret - 5;
    /* FF 15 disp32  call [imm]  -> 6 bytes  (the IAT form) */
    p = (const uint8_t *)isaac_g(ret - 6);
    if (p[0] == 0xFF && p[1] == 0x15) return ret - 6;
    /* FF 95 disp32  call [ebp+d32] */
    if (p[0] == 0xFF && p[1] == 0x95) return ret - 6;
    /* FF 94 sib disp32 */
    p = (const uint8_t *)isaac_g(ret - 7);
    if (p[0] == 0xFF && p[1] == 0x94) return ret - 7;
    /* FF 55 disp8   call [ebp+d8] */
    p = (const uint8_t *)isaac_g(ret - 3);
    if (p[0] == 0xFF && (p[1] & 0xF8) == 0x50) return ret - 3;
    /* FF 54 sib disp8 */
    p = (const uint8_t *)isaac_g(ret - 4);
    if (p[0] == 0xFF && p[1] == 0x54) return ret - 4;
    /* FF D0..D7     call reg    -> 2 bytes */
    p = (const uint8_t *)isaac_g(ret - 2);
    if (p[0] == 0xFF && (p[1] & 0xF8) == 0xD0) return ret - 2;
    /* FF 10..17     call [reg]  -> 2 bytes */
    if (p[0] == 0xFF && (p[1] & 0xF8) == 0x10) return ret - 2;
    return 0;
}

/* Formats "0x... (returns to 0x...)" or just the return address. */
static const char *fmt_site(uint32_t ret, char *buf, size_t n) {
    uint32_t site = isaac_call_site_from_return(ret);
    if (site)
        snprintf(buf, n, "0x%08x (returns to 0x%08x)", site, ret);
    else
        snprintf(buf, n, "return-address 0x%08x (call site not decodable)", ret);
    return buf;
}

/* Import index -> record slot + 1, so a stub hit is a table read rather than a
 * scan of every record seen so far. A ten-minute play run makes 66.5 M stub
 * calls, 65.9 M of them the four critical-section symbols that are inert by
 * design; the scan was walking up to 16 records on each one (round 15e). */
static uint16_t *g_rec_of;

static stub_record *record_for(const isaac_import *imp) {
    size_t idx = (size_t)(imp - isaac_imports);
    int indexed = idx < isaac_import_count;
    if (indexed) {
        if (!g_rec_of) {
            g_rec_of = (uint16_t *)calloc(isaac_import_count, sizeof *g_rec_of);
            if (!g_rec_of) indexed = 0;
        }
        if (indexed && g_rec_of[idx])
            return &g_records[g_rec_of[idx] - 1u];
    }
    for (unsigned i = 0; i < g_record_count; ++i)
        if (g_records[i].imp == imp) {
            if (indexed) g_rec_of[idx] = (uint16_t)(i + 1u);
            return &g_records[i];
        }
    if (g_record_count >= ISAAC_MAX_TRACKED)
        return NULL;
    stub_record *r = &g_records[g_record_count++];
    r->imp = imp;
    r->hits = 0;
    r->first_caller = 0;
    if (indexed) g_rec_of[idx] = (uint16_t)g_record_count;
    return r;
}

static const char *verdict_name(unsigned v) {
    switch (v) {
    case ISAAC_V_REAL:          return "REAL";
    case ISAAC_V_PROVIDED:      return "PROVIDED";
    case ISAAC_V_STUB:          return "STUB";
    case ISAAC_V_UNIMPLEMENTED: return "UNIMPLEMENTED";
    case ISAAC_V_NEVER_CALLED:  return "NEVER-CALLED(census said 0 sites)";
    default:                    return "?";
    }
}

void isaac_stub_hit(const isaac_import *imp, const CpuState *restrict cpu) {
    { extern struct CpuState *recomp_last_cpu; recomp_last_cpu = (struct CpuState *)cpu; }
    stub_record *r = record_for(imp);
    ++g_total_stub_calls;
    if (!r) {
        isaac_log("[isaac][stub] %s!%s (record table full)", imp->dll, imp->symbol);
        return;
    }
    if (r->hits++ == 0) {
        /* the return address is a guest memory read: only the first hit needs it */
        uint32_t caller = cpu ? isaac_retaddr(cpu) : 0;
        r->first_caller = caller;
        char sb[96];
        isaac_log("[isaac][stub] FIRST CALL  %s!%s  <- called from %s   "
                  "verdict=%s sites=%u  (inert: returns 0)",
                  imp->dll, imp->symbol, fmt_site(caller, sb, sizeof sb),
                  verdict_name(imp->verdict), imp->call_sites);
        if (imp->verdict == ISAAC_V_NEVER_CALLED) {
            isaac_log("[isaac][stub] ^^ census measured 0 call sites for this "
                      "symbol. Reaching it means the census or the lift is "
                      "wrong. Investigate before trusting anything downstream.");
        }
    }
}

void isaac_trap(const isaac_import *imp, const CpuState *restrict cpu) {
    uint32_t caller = cpu ? isaac_retaddr(cpu) : 0;
    char sb[96];
    isaac_log("[isaac][TRAP] %s!%s is not implemented.\n"
              "              called from %s\n"
              "              verdict=%s, measured call sites=%u\n"
              "              Returning a fake value here would corrupt state "
              "silently, so execution stops instead.",
              imp->dll, imp->symbol, fmt_site(caller, sb, sizeof sb),
              verdict_name(imp->verdict), imp->call_sites);
    isaac_shutdown("unimplemented import reached");
    abort();   /* unreachable: isaac_shutdown does not return */
}

/* How many distinct stubbed imports have been reached. The selftest uses this
 * to prove that THIS layer's weak definitions are the ones the linker kept:
 * both this layer and the lifter emitted weak definitions for the same 591
 * imports, and two weak symbols do not collide -- the linker silently picks
 * one. If the lifter's had won, its stub returns without recording anything
 * and this counter would stay at zero. Neither layer's own tests could catch
 * that, because the bug exists only in the pair. */
unsigned isaac_stub_record_count(void) { return g_record_count; }


/* ---------------------------------------------------------- shutdown ----- */
/* abort() inside wasm tears the module down under node's feet and produces
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
 * which is a libuv teardown artefact, not a port bug -- but it lands AFTER the
 * real diagnosis and becomes the last thing on screen. An orderly stop prints
 * every report and then exits, so the actual failure is what the reader sees.
 *
 * exit() still runs atexit handlers and flushes; _Exit would not. Neither
 * unwinds guest state, which is correct: once we stop, guest state is not
 * meant to be resumed. */
void isaac_shutdown(const char *reason) {
    static int in_shutdown;
    if (in_shutdown) return;          /* a report must never re-enter this */
    in_shutdown = 1;
    isaac_log("[isaac] ================ STOPPING ================");
    isaac_log("[isaac] reason: %s", reason ? reason : "(unspecified)");
    isaac_module_report();
    isaac_heap_report();
    isaac_stub_report();
    isaac_log("[isaac] ==========================================");
    fflush(stdout);
    fflush(stderr);
    exit(1);
}

void isaac_stub_report(void) {
    if (!g_record_count) {
        isaac_log("[isaac] stub report: no stubbed import was ever reached.");
        return;
    }
    /* Sort by hit count, descending -- the loudest offender first. */
    for (unsigned i = 1; i < g_record_count; ++i) {
        stub_record k = g_records[i];
        unsigned j = i;
        while (j && g_records[j - 1].hits < k.hits) {
            g_records[j] = g_records[j - 1];
            --j;
        }
        g_records[j] = k;
    }
    { extern void recomp_profile_report(void); recomp_profile_report(); }
    { extern void isaac_gl_census_report(void); isaac_gl_census_report(); }
    { extern void isaac_dispatch_report(void); isaac_dispatch_report(); }
    { extern void isaac_fastpath_report(void); isaac_fastpath_report(); }
    { extern void isaac_audio_report(void); isaac_audio_report(); }
    { extern void isaac_threads_report(void); isaac_threads_report(); }
#ifdef ISAAC_WEB
    { extern void isaac_audio_web_report(void); isaac_audio_web_report(); }
#endif
    { extern uint32_t isaac_input_dispatched(void); extern uint32_t isaac_input_queued(void);
      extern uint32_t isaac_input_dropped(void);
      isaac_log("[isaac][input] %u messages dispatched to the WndProc, %u still queued, %u dropped (queue full)",
                isaac_input_dispatched(), isaac_input_queued(), isaac_input_dropped()); }
#ifdef ISAAC_WEB
    { extern void isaac_web_gl_report(void); isaac_web_gl_report();
      extern void isaac_gl_report(void); isaac_gl_report(); }
#endif
    isaac_log("[isaac] ---- stub report: %u distinct symbols, %u total calls ----",
              g_record_count, g_total_stub_calls);
    for (unsigned i = 0; i < g_record_count; ++i) {
        stub_record *r = &g_records[i];
        char sb[96];
        isaac_log("[isaac]   %8u x  %-30s %-24s first call %s  [%s]",
                  r->hits, r->imp->symbol, r->imp->dll,
                  fmt_site(r->first_caller, sb, sizeof sb),
                  verdict_name(r->imp->verdict));
    }
}

/* --------------------------------------------------------- dispatch ------ */

isaac_import *isaac_resolve_shim(uint32_t target) {
    if (target < ISAAC_SHIM_BASE)
        return NULL;
    uint32_t idx = (target - ISAAC_SHIM_BASE) / ISAAC_SHIM_STRIDE;
    if (idx >= isaac_import_count)
        return NULL;
    if (isaac_imports[idx].shim_va != target)
        return NULL;               /* misaligned token: not ours */
    return &isaac_imports[idx];
}

/* Kept as an alias: earlier revisions of this file exported this name. */
isaac_import *isaac_find_import_by_shim(uint32_t shim_va) {
    return isaac_resolve_shim(shim_va);
}

int isaac_indirect_call(uint32_t target, CpuState *restrict cpu) {
    isaac_import *imp = isaac_resolve_shim(target);
    if (!imp)
        return 0;

    /* ISAAC_HEARTBEAT=<n>: every n-th host-boundary call, with the wall clock
     * and the symbol. Companion to the dispatcher's heartbeat: during the
     * room-entry crawl no lifted instruction runs for minutes, so the loop is
     * either in the shim layer, in host C, or outside the module (round 15c).
     * These two counters say which. */
    {
        static long hb = -1;
        static unsigned long calls;
        ++calls;
        if (hb < 0) {
            const char *e = getenv("ISAAC_HEARTBEAT");
            hb = (e && *e) ? atol(e) : 0;
        }
        if (hb > 0 && (calls % (unsigned long)hb) == 0ul)
            fprintf(stderr, "[isaac][hb] %lu host-boundary calls, %.1f s, now %s!%s\n",
                    calls, emscripten_get_now() / 1000.0, imp->dll, imp->symbol);
    }

    /* a sliced thread job crossing the host boundary for anything but the
     * critical-section pair has made progress (round 24) */
    {
        extern int isaac_threads_slicing(void);
        extern void isaac_threads_progress(void);
        if (isaac_threads_slicing() && imp->symbol[0] != 'E' && imp->symbol[0] != 'L')
            isaac_threads_progress();
        else if (isaac_threads_slicing() &&
                 strcmp(imp->symbol, "EnterCriticalSection") && strcmp(imp->symbol, "LeaveCriticalSection"))
            isaac_threads_progress();
    }
    uint32_t ret = isaac_retaddr(cpu);
    /* The DirectInput-region ENTER/EXIT trace was unconditional; with the
     * device poller running as a per-frame slice (round 24) that is two
     * PeekMessageA lines per frame, thousands per run. ISAAC_DSP_TRACE=1. */
    static int dsp_on = -1;
    if (dsp_on < 0) { const char *e = getenv("ISAAC_DSP_TRACE"); dsp_on = (e && *e && *e != '0') ? 1 : 0; }
    int dbg = dsp_on && ((ret >= 0x00a6c000u && ret <= 0x00a6fac0u) ||
                         (imp->dll[0]=='d' && imp->symbol[0]=='D'));
    if (dbg) {
        fprintf(stderr, "[dsp] ENTER %s!%s eax=%08x ebx=%08x ecx=%08x edx=%08x "
                        "esi=%08x edi=%08x esp=%08x ret=%08x\n",
                imp->dll, imp->symbol, cpu->EAX, cpu->EBX, cpu->ECX, cpu->EDX,
                cpu->ESI, cpu->EDI, cpu->ESP, ret);
        imp->fn(cpu);
        fprintf(stderr, "[dsp] EXIT  %s!%s eax=%08x ebx=%08x ecx=%08x edx=%08x "
                        "esi=%08x edi=%08x esp=%08x (purge %u)\n",
                imp->dll, imp->symbol, cpu->EAX, cpu->EBX, cpu->ECX, cpu->EDX,
                cpu->ESI, cpu->EDI, cpu->ESP, (unsigned)imp->arg_bytes);
    } else {
        imp->fn(cpu);
    }

    /* Emulate the callee's own `ret [N]`: pop the return address, then the
     * arguments if the callee cleans them (stdcall/thiscall). arg_bytes is 0
     * for cdecl because the CALLER cleans there. */
    if (imp->arg_bytes == 0xFFFF) {
        isaac_log("[isaac][TRAP] %s!%s returned but its stack purge is unknown; "
                  "continuing would desynchronise the guest stack.",
                  imp->dll, imp->symbol);
        isaac_trap(imp, cpu);
    }
    cpu->ESP += 4u + imp->arg_bytes;
    cpu->EIP = ret;
    return 1;
}

/* ------------------------------------------------------------------------- *
 * THE SHARED CONTRACT WITH scripts/recomp/lift/
 *
 * The lifter emits `recomp_call_indirect(s, target)` for every dynamic
 * indirect call, and `recomp_jump_indirect(s, target)` for indirect tail
 * calls. Its own definitions in recomp_rt.c are __attribute__((weak)) and
 * abort(); these STRONG definitions replace them at link time.
 *
 * Order matters. A shim token (0x0F000000+) is deliberately outside the PE
 * image, so the lifter's VA -> wasm function table has no entry for it and
 * would report "unresolved indirect call". Shims are therefore tried FIRST,
 * and only ordinary guest VAs reach the function table.
 *
 * Why both mechanisms exist, given the lifter already resolves `call [IAT
 * slot]` to a direct imp_* call at lift time: because code also takes the
 * ADDRESS of an import and calls it later. Measured example at 0x00a24ce2:
 *     mov eax, dword ptr [0x00c10ed4]   ; load epoxy_glVertexAttribPointer
 *     ...
 *     call eax
 * That load reads whatever isaac_boot_bind_iat() wrote into the slot, and the
 * value arrives here. If the boot path wrote a token the lifter cannot
 * resolve, the call dies; if it wrote nothing, the on-disk name RVA is
 * interpreted as a code address. Both mechanisms are required and they must
 * name the SAME function -- which is why gen_shims.py:c_ident() is a copy of
 * the lifter's emit.py:load_imports() naming, asserted by the test suite.
 * ------------------------------------------------------------------------- */

/* Provided by the lifted module (dispatch_tbl.h). Weak so the host layer links
 * standalone for compile-checking with no lifted module present. */
__attribute__((weak)) int isaac_lifted_dispatch(uint32_t va, CpuState *restrict cpu) {
    (void)va; (void)cpu;
    return 0;
}
/* Round 38: the dispatcher's direct-mapped cache (dispatch_tbl.c). A hit is
 * always an image VA the index resolved once, never a shim token, so the
 * indirect call may try it before the shim check. */
__attribute__((weak)) int isaac_lifted_dispatch_cached(uint32_t va, CpuState *restrict cpu) {
    (void)va; (void)cpu;
    return 0;
}

/* Thunks the function-start scan never records (boot round 12: the static
 * destructor pass reached two of them through the atexit table): an
 * adjustor thunk `add ecx, imm8/imm32; jmp rel32` (83 C1 ib / 81 C1 id, then
 * E9 rel32) or a bare `jmp rel32`. Decoded from the guest image bytes at
 * the target; returns 1 with the ECX delta and the jump destination. */
int isaac_decode_thunk(uint32_t va, int32_t *ecx_delta, uint32_t *dest) {
    if (!isaac_in_image(va) || !isaac_is_guest_va(va + 10u)) return 0;
    const uint8_t *p = (const uint8_t *)isaac_g(va);
    int32_t delta = 0;
    uint32_t at = va;
    if (p[0] == 0x83 && p[1] == 0xC1) { delta = (int8_t)p[2]; at += 3; }
    else if (p[0] == 0x81 && p[1] == 0xC1) {
        delta = (int32_t)(p[2] | (p[3] << 8) | (p[4] << 16) | ((uint32_t)p[5] << 24)); at += 6;
    }
    const uint8_t *j = (const uint8_t *)isaac_g(at);
    if (j[0] != 0xE9) return 0;
    int32_t rel = (int32_t)(j[1] | (j[2] << 8) | (j[3] << 16) | ((uint32_t)j[4] << 24));
    *ecx_delta = delta;
    *dest = at + 5u + (uint32_t)rel;
    return isaac_in_image(*dest);
}

void recomp_call_indirect(CpuState *restrict s, uint32_t target) {
    if (isaac_lifted_dispatch_cached(target, s))
        return;
    if (isaac_indirect_call(target, s))
        return;
    if (isaac_lifted_dispatch(target, s))
        return;
    {
        /* an unlifted thunk: apply its ECX adjustment and follow the jump
         * (at most a few hops; the destination's own ret pops the return
         * address the caller pushed, exactly as the thunk would have) */
        int32_t delta; uint32_t dest, cur = target;
        for (int hop = 0; hop < 4 && isaac_decode_thunk(cur, &delta, &dest); ++hop) {
            s->ECX += (uint32_t)delta;
            static uint32_t seen[64]; static unsigned nseen;
            unsigned k; for (k = 0; k < nseen; ++k) if (seen[k] == target) break;
            if (k == nseen && nseen < 64) {
                seen[nseen++] = target;
                isaac_log("[isaac][thunk] 0x%08x is an unlifted thunk (ecx %+d, jmp 0x%08x); emulated",
                          target, (int)delta, dest);
            }
            if (isaac_indirect_call(dest, s)) return;
            if (isaac_lifted_dispatch(dest, s)) return;
            cur = dest;
        }
    }
    {
        extern volatile uint32_t recomp_va_trace_idx;
        extern volatile uint32_t recomp_va_trace[512];
        isaac_log("[isaac][TRAP] indirect call to 0x%08x from 0x%08x resolves to "
                  "neither a host shim nor a lifted function.%s",
                  target, s ? isaac_retaddr(s) : 0,
                  isaac_in_image(target)
                      ? " It is inside the image, so the function was not lifted."
                      : " It is outside the image -- a corrupt pointer, or an IAT "
                        "slot the boot path never bound.");
        if (s) {
            uint32_t idx = recomp_va_trace_idx;
            isaac_log("[isaac][TRAP] va trace (last 24):");
            for (int k = 24; k >= 1; --k) {
                isaac_log("[isaac][TRAP]   %08x",
                          recomp_va_trace[(idx - k) & 511u]);
            }
            isaac_log("[isaac][TRAP] eax=%08x ecx=%08x edx=%08x esi=%08x edi=%08x "
                      "esp=%08x ebp=%08x", s->EAX, s->ECX, s->EDX, s->ESI, s->EDI,
                      s->ESP, s->EBP);
        }
    }
    isaac_shutdown("unresolved indirect call");
    abort();
}

/* Round 14d: the tail-jump trampoline. A guest jmp that leaves the current
 * lifted function (a tail call, a computed jump to another entry) used to
 * be run as a nested call from here; a guest loop whose back-edge was such
 * a jump (sub_0093805f, the room's entity spawn loop) nested one native
 * frame per iteration until V8 threw "Maximum call stack size exceeded",
 * with nothing on the guest stack to show for it. Now the target is parked
 * and the current lifted function returns; whoever called it -- a lifted
 * call site, the dispatcher, the host entry -- runs the target from its own
 * frame with recomp_run_pending(). The callee's `ret` still consumes the
 * original caller's return address off the guest stack, exactly as on x86.
 * Globals rather than CpuState fields: the host struct is a prefix of the
 * generated one; execution is single-threaded and LIFO across the
 * host/guest boundary, so the innermost dispatcher consumes the flag. */
uint32_t recomp_jmp_pending, recomp_jmp_target;
void recomp_jump_indirect(CpuState *restrict s, uint32_t target) {
    (void)s;
    recomp_jmp_target = target;
    recomp_jmp_pending = 1u;
}
/* A parked jump that comes straight back with the same target and no guest
 * instruction executed in between is not a loop -- it is a lifter defect, and
 * before round 15c it spun at 20 M dispatches a second forever with nothing in
 * the log (the room-entry "crawl": a dispatch-loop function whose entry VA had
 * no `case` label fell to `default:` and re-parked its own entry). Detect no
 * progress and stop loudly instead. The counter is generous so a real guest
 * jump chain of any length still runs. */
#define RECOMP_STUCK_LIMIT 4096u
uint32_t isaac_dispatch_calls(void);   /* dispatch_tbl.c; weak fallback below */
void recomp_run_pending(CpuState *restrict s) {
    uint32_t last = 0u, same = 0u;
    /* progress = the dispatcher's call count, which counts in every build
     * profile (the RECOMP_VA trace index does not: --fast compiles it out,
     * and a guard that read it there would call a real guest jump chain a
     * defect). */
    uint32_t calls_at_last = 0u;
    while (recomp_jmp_pending) {
        uint32_t t = recomp_jmp_target;
        recomp_jmp_pending = 0u;
        /* one dispatch since the last parked jump is exactly this loop's own:
         * a real guest jump chain dispatches the callee's own work in between,
         * a self-park cycle does not. Comparing for equality instead would
         * never fire, because this loop's dispatch always advances it. */
        if (t == last && isaac_dispatch_calls() - calls_at_last <= 1u) {
            if (++same >= RECOMP_STUCK_LIMIT) {
                fprintf(stderr,
                        "recomp: parked jump to 0x%08x repeated %u times with no guest "
                        "instruction executed -- the target has no dispatch-loop case and "
                        "no block-table entry, so it re-parks itself. This is a lifter "
                        "defect, not a guest loop.\n", t, same);
                isaac_dump_trap_context(s, "stuck parked jump");
                fflush(stderr);
                abort();
            }
        } else {
            same = 0u;
            last = t;
        }
        calls_at_last = isaac_dispatch_calls();
        recomp_call_indirect(s, t);
    }
}
