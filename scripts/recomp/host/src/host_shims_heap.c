/* host_shims_heap.c -- the guest allocator, and the heap high-water meter.
 *
 * WHY THIS CANNOT BE `PROVIDED` BY musl.
 *
 * The obvious move is to forward the guest's malloc/free onto the host's, and
 * before the address-space split that is what the shim table said. It is now
 * wrong, and wrong in the most dangerous direction: emscripten's malloc returns
 * pointers ABOVE the guard (measured: 0x1010d3e8), because host static data and
 * the host heap live at 0x10000000+. Handing one of those to the guest invites
 * it to write, with full rights, directly into the runtime's own memory --
 * the dispatch table, CpuState, everything the guard exists to protect.
 *
 * So the guest gets its own arena inside the guest range, and the host's
 * allocator is never exposed to it. That is a consequence of the layout, not a
 * preference.
 *
 * THE METER.
 *
 * The guard currently reserves 192 MiB of guest heap. The static analysis in
 * heap_bound.py brackets the real requirement between a measured floor of
 * 64 MiB (the largest single texture decode, which must be contiguous) and a
 * measured ceiling of 262 MiB (every PNG resident as a client RGBA copy), and
 * says honestly that where the peak sits in that band is not decidable from the
 * image. This file closes that gap: it records the high-water mark, so the
 * first integration run that reaches gameplay produces the number for free and
 * the guard can be moved once, on evidence.
 *
 * Allocator shape: boundary tags with segregated explicit free lists and
 * immediate two-way coalescing (see the block layout below). Round 12d
 * replaced the original first-fit walk after V8's profiler put 95% of a
 * 470 s boot inside it: 527 k mallocs, each walking every block from the
 * arena start. The meter stayed; its answer (peak 91 MiB of 192) is what
 * sized this one.
 */

#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HDR_BYTES   8u          /* {size, flags} */
#define FTR_BYTES   4u          /* size | used, the block's last dword */
#define ALIGN       8u
#define FLAG_USED   1u
#define MIN_BLOCK   24u         /* header + two free-list links + footer */
#define NBINS       84u

/* Block layout at block VA b (size is a multiple of 8, >= MIN_BLOCK):
 *   [b+0]       total block size including header and footer
 *   [b+4]       flags (bit 0 = in use)
 *   [b+8]       payload (used block) | free-list prev link (free block)
 *   [b+12]                          | free-list next link (free block)
 *   [b+size-4]  footer: size | (bit 0 = in use), so the block BEFORE a
 *               freed one is found in O(1) for backward coalescing.
 * Payload starts at b + HDR_BYTES, 8-byte aligned.
 *
 * Free blocks live on doubly-linked lists segregated by size class
 * (g_bin): exact 8-byte classes below 512 bytes, then one class per power
 * of two. malloc looks in the class of the request (first fit within it,
 * since a power-of-two class holds smaller blocks too) and otherwise takes
 * the head of the first non-empty larger class, where every block fits.
 * free coalesces both ways immediately, so no two free blocks are ever
 * adjacent. Nothing touches a used block, which is what round 12d needed:
 * the first-fit walk from the arena start cost 95% of a 470 s boot
 * (527 k mallocs, each walking every block before the first fit). */

static uint32_t g_arena_lo, g_arena_hi;
static uint32_t g_heap_top;   /* round 51: the highest block end ever handed out -- the arena pages the game has touched */
static int g_inited;
static uint32_t g_bin[NBINS];

static struct {
    uint64_t live, peak, total_alloced;
    uint32_t largest_single, allocs, frees, reallocs, failures;
    uint32_t peak_at_alloc;      /* which allocation number hit the peak */
    uint32_t corrupt;            /* frees refused because the header was bad */
} g_stat;

static uint32_t blk_size(uint32_t b) { return isaac_r32(b) & ~(ALIGN - 1u); }
static int      blk_used(uint32_t b) { return isaac_r32(b + 4) & FLAG_USED; }
static void     blk_set(uint32_t b, uint32_t size, int used) {
    isaac_w32(b, size);
    isaac_w32(b + 4, used ? FLAG_USED : 0u);
    isaac_w32(b + size - FTR_BYTES, size | (used ? FLAG_USED : 0u));
}

static unsigned bin_index(uint32_t size) {
    if (size < 512u) return (size - MIN_BLOCK) / ALIGN;         /* 24..504 -> 0..60 */
    unsigned k = 31u - (unsigned)__builtin_clz(size);          /* 512 -> 9 */
    unsigned i = 61u + (k - 9u);
    return i < NBINS ? i : NBINS - 1u;
}

static void bin_insert(uint32_t b, uint32_t size) {
    unsigned i = bin_index(size);
    uint32_t head = g_bin[i];
    isaac_w32(b + 8, 0);
    isaac_w32(b + 12, head);
    if (head) isaac_w32(head + 8, b);
    g_bin[i] = b;
}

static void bin_unlink(uint32_t b, uint32_t size) {
    uint32_t prev = isaac_r32(b + 8), next = isaac_r32(b + 12);
    if (prev) isaac_w32(prev + 12, next);
    else      g_bin[bin_index(size)] = next;
    if (next) isaac_w32(next + 8, prev);
}

static void heap_init(void) {
    if (g_inited) return;
    g_arena_lo = ISAAC_HEAP_VA;
    g_arena_hi = ISAAC_HEAP_VA + ISAAC_HEAP_SIZE;
    memset(g_bin, 0, sizeof g_bin);
    /* One free block spanning the arena. */
    blk_set(g_arena_lo, ISAAC_HEAP_SIZE, 0);
    bin_insert(g_arena_lo, ISAAC_HEAP_SIZE);
    g_inited = 1;
    isaac_log("[isaac][heap] guest arena 0x%08x..0x%08x (%u MiB), separate from "
              "the host allocator by design",
              g_arena_lo, g_arena_hi, ISAAC_HEAP_SIZE >> 20);
}

static uint32_t guest_malloc(uint32_t n) {
    heap_init();
    if (!n) n = 1;
    uint64_t need64 = (uint64_t)n + HDR_BYTES + FTR_BYTES;
    need64 = (need64 + (ALIGN - 1)) & ~(uint64_t)(ALIGN - 1);
    if (need64 < MIN_BLOCK) need64 = MIN_BLOCK;
    if (need64 > ISAAC_HEAP_SIZE) {
        ++g_stat.failures;
        isaac_log("[isaac][heap] malloc(%u) exceeds the whole arena (%u MiB)",
                  n, ISAAC_HEAP_SIZE >> 20);
        return 0;
    }
    uint32_t need = (uint32_t)need64;

    /* the request's own class may hold smaller blocks: first fit inside it */
    unsigned i0 = bin_index(need);
    uint32_t b = 0;
    for (uint32_t c = g_bin[i0]; c; c = isaac_r32(c + 12))
        if (blk_size(c) >= need) { b = c; break; }
    /* every block of a larger class fits: take the first non-empty one */
    for (unsigned i = i0 + 1; !b && i < NBINS; ++i) b = g_bin[i];
    if (!b) {
        ++g_stat.failures;
        isaac_log("[isaac][heap] OUT OF MEMORY: malloc(%u) failed with %llu bytes "
                  "live and a %u MiB arena. Peak was %llu. Raise ISAAC_HEAP_SIZE "
                  "or move the guard.",
                  n, (unsigned long long)g_stat.live, ISAAC_HEAP_SIZE >> 20,
                  (unsigned long long)g_stat.peak);
        return 0;
    }
    uint32_t sz = blk_size(b);
    bin_unlink(b, sz);
    if (sz - need >= MIN_BLOCK) {                 /* split: the tail stays free */
        blk_set(b + need, sz - need, 0);
        bin_insert(b + need, sz - need);
        blk_set(b, need, 1);
    } else {
        blk_set(b, sz, 1);
        need = sz;
    }
    g_stat.live += need;
    g_stat.total_alloced += need;
    ++g_stat.allocs;
    if (b + need > g_heap_top) g_heap_top = b + need;
    if (n > g_stat.largest_single) g_stat.largest_single = n;
    if (g_stat.live > g_stat.peak) {
        g_stat.peak = g_stat.live;
        g_stat.peak_at_alloc = g_stat.allocs;
    }
    return b + HDR_BYTES;
}

static void guest_free(uint32_t p) {
    if (!p) return;
    if (p < g_arena_lo + HDR_BYTES || p >= g_arena_hi) {
        isaac_log("[isaac][heap] free(0x%08x): pointer is outside the guest "
                  "arena 0x%08x..0x%08x -- ignoring rather than corrupting.",
                  p, g_arena_lo, g_arena_hi);
        return;
    }
    uint32_t b = p - HDR_BYTES;
    if (!blk_used(b)) {
        isaac_log("[isaac][heap] double free at 0x%08x", p);
        return;
    }
    uint32_t sz = blk_size(b);
    if (sz < MIN_BLOCK || b + sz > g_arena_hi ||
        (isaac_r32(b + sz - FTR_BYTES) & ~(ALIGN - 1u)) != sz) {
        ++g_stat.corrupt;
        isaac_log("[isaac][heap] free(0x%08x): header/footer disagree (size %u) "
                  "-- a guest overrun; ignoring the free.", p, sz);
        return;
    }
    g_stat.live -= sz;
    ++g_stat.frees;

    /* Coalesce forward, then backward (the footer names the block before). */
    uint32_t nxt = b + sz;
    if (nxt < g_arena_hi && !blk_used(nxt)) {
        uint32_t ns = blk_size(nxt);
        bin_unlink(nxt, ns);
        sz += ns;
    }
    if (b > g_arena_lo && !(isaac_r32(b - FTR_BYTES) & FLAG_USED)) {
        uint32_t ps = isaac_r32(b - FTR_BYTES) & ~(ALIGN - 1u);
        if (ps >= MIN_BLOCK && b - ps >= g_arena_lo) {
            bin_unlink(b - ps, ps);
            b -= ps;
            sz += ps;
        }
    }
    blk_set(b, sz, 0);
    bin_insert(b, sz);
}

static uint32_t guest_size(uint32_t p) {
    if (!p || p < g_arena_lo + HDR_BYTES || p >= g_arena_hi) return 0;
    uint32_t s = blk_size(p - HDR_BYTES);
    return s > HDR_BYTES + FTR_BYTES ? s - HDR_BYTES - FTR_BYTES : 0;
}

/* Free-list census for the report: blocks and the largest one. */
static void heap_free_census(uint32_t *blocks, uint32_t *largest, uint64_t *bytes) {
    *blocks = 0; *largest = 0; *bytes = 0;
    for (unsigned i = 0; i < NBINS; ++i)
        for (uint32_t c = g_bin[i]; c; c = isaac_r32(c + 12)) {
            uint32_t sz = blk_size(c);
            ++*blocks; *bytes += sz;
            if (sz > *largest) *largest = sz;
        }
}
uint32_t isaac_heap_free_blocks(void) {
    uint32_t fb, fl; uint64_t fbytes;
    heap_free_census(&fb, &fl, &fbytes);
    return fb;
}
uint32_t isaac_heap_largest_free(void) {
    uint32_t fb, fl; uint64_t fbytes;
    heap_free_census(&fb, &fl, &fbytes);
    return fl;
}

/* Exposed so other shims that must allocate (e.g. _strdup) get GUEST memory.
 * A host-allocated pointer handed to the guest would be above the guard. */
uint32_t isaac_guest_alloc(uint32_t n) { return guest_malloc(n); }
void     isaac_guest_free(uint32_t p)  { guest_free(p); }
uint32_t isaac_guest_realloc(uint32_t p, uint32_t n) {
    if (!p) return guest_malloc(n);
    if (!n) { guest_free(p); return 0; }
    uint32_t old = guest_size(p);
    uint32_t q = guest_malloc(n);
    if (q) { memcpy(isaac_g(q), isaac_g(p), old < n ? old : n); guest_free(p); }
    return q;
}

/* ISAAC_HEAP_TRACE=1: one line per guest heap call -- op, argument, result
 * and the guest return address (the dword at ESP inside a shim), capped by
 * ISAAC_HEAP_TRACE_MAX (default 300000). Observe-only; the tool that found
 * the string-table buffer landing on a live stream object (round 26). */
static void heap_trace(const char *op, uint32_t a, uint32_t r, const CpuState *cpu) {
    static int on = -1;
    static unsigned long left;
    if (on < 0) {
        const char *e = getenv("ISAAC_HEAP_TRACE");
        on = (e && *e && *e != '0') ? 1 : 0;
        e = getenv("ISAAC_HEAP_TRACE_MAX");
        left = (e && *e) ? strtoul(e, NULL, 10) : 300000ul;
    }
    if (!on || !left) return;
    if (!--left) isaac_log("[isaac][heap-trace] cap reached (ISAAC_HEAP_TRACE_MAX)");
    isaac_log("[isaac][heap-trace] %s(0x%x) -> 0x%08x ret 0x%08x", op, a, r,
              cpu ? isaac_r32(cpu->ESP) : 0u);
}

/* ------------------------------------------------------------- CRT heap -- */
/* cdecl: the caller cleans, so none of these adjust ESP beyond the return. */

void imp_api_ms_win_crt_heap__malloc(CpuState *restrict cpu) {
    cpu->EAX = guest_malloc(isaac_arg(cpu, 0));
    heap_trace("malloc", isaac_arg(cpu, 0), cpu->EAX, cpu);
}

void imp_api_ms_win_crt_heap__free(CpuState *restrict cpu) {
    heap_trace("free", isaac_arg(cpu, 0), 0, cpu);
    guest_free(isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_heap__calloc(CpuState *restrict cpu) {
    uint64_t n = (uint64_t)isaac_arg(cpu, 0) * isaac_arg(cpu, 1);
    if (n > 0xFFFFFFFFull) { cpu->EAX = 0; ++g_stat.failures; return; }
    uint32_t p = guest_malloc((uint32_t)n);
    if (p) memset(isaac_g(p), 0, (size_t)n);
    cpu->EAX = p;
    heap_trace("calloc", (uint32_t)n, p, cpu);
}

void imp_api_ms_win_crt_heap__realloc(CpuState *restrict cpu) {
    uint32_t p = isaac_arg(cpu, 0), n = isaac_arg(cpu, 1);
    ++g_stat.reallocs;
    if (!p) { cpu->EAX = guest_malloc(n); return; }
    if (!n) { guest_free(p); cpu->EAX = 0; return; }
    uint32_t old = guest_size(p);
    uint32_t q = guest_malloc(n);
    if (q) {
        memcpy(isaac_g(q), isaac_g(p), old < n ? old : n);
        guest_free(p);
    }
    cpu->EAX = q;
    heap_trace("realloc", n, q, cpu);
}

/* -------------------------------------------------------- Virtual* ------- */
/* stdcall; the dispatcher applies the purge from the shim table. The engine
 * uses these 8 times total, so a page-granular wrapper over the same arena is
 * enough -- but MEM_RELEASE semantics differ from free(), so it is explicit. */

#define MEM_COMMIT   0x1000u
#define MEM_RESERVE  0x2000u
#define MEM_RELEASE  0x8000u

void imp_kernel32__VirtualAlloc(CpuState *restrict cpu) {
    uint32_t addr = isaac_arg(cpu, 0), size = isaac_arg(cpu, 1);
    uint32_t type = isaac_arg(cpu, 2);
    if (addr && !isaac_is_guest_va(addr)) {
        isaac_log("[isaac][heap] VirtualAlloc at 0x%08x is outside the guest "
                  "range; refusing.", addr);
        cpu->EAX = 0;
        return;
    }
    if (addr) {
        /* MEM_COMMIT on an already-reserved range: the arena is always
         * committed, so this is a no-op that must still succeed. */
        cpu->EAX = (type & MEM_COMMIT) ? addr : 0;
        return;
    }
    /* Round 24f: a reserve-only request above ISAAC_RESERVE_MAX_MIB (default
     * 128) fails. The engine reserves address space for its Lua arena with a
     * ladder (1 GiB, then 512 MB, ...); on Windows that costs nothing until
     * committed, here the arena is always committed, so the reservation is
     * real memory -- and its guest lua_Alloc is replaced by the host
     * allocator anyway (host_lua.c), so the range is never used. With the
     * 768 MiB arena the 512 MB step succeeded and left too little for the
     * sound catalogue (269 MB of PCM, preloaded at boot). The 192 MiB arena
     * had refused both steps implicitly; 128 MiB is that behaviour, stated. */
    if ((type & MEM_RESERVE) && !(type & MEM_COMMIT)) {
        static uint32_t cap;
        if (!cap) {
            const char *e = getenv("ISAAC_RESERVE_MAX_MIB");
            unsigned long mib = (e && *e) ? strtoul(e, NULL, 10) : 128ul;
            cap = mib ? (uint32_t)(mib << 20) : 0xFFFFFFFFu;
        }
        if (size > cap) {
            isaac_log("[isaac][heap] VirtualAlloc(MEM_RESERVE %u MiB) refused: above ISAAC_RESERVE_MAX_MIB "
                      "(%u MiB); the arena is always committed and the guest's Lua allocator is not used",
                      size >> 20, cap >> 20);
            cpu->EAX = 0;
            return;
        }
    }
    uint32_t p = guest_malloc(size);
    if (p) memset(isaac_g(p), 0, size);   /* VirtualAlloc zeroes; malloc does not */
    cpu->EAX = p;
    heap_trace("VirtualAlloc", size, p, cpu);
}

void imp_kernel32__VirtualFree(CpuState *restrict cpu) {
    uint32_t addr = isaac_arg(cpu, 0), type = isaac_arg(cpu, 2);
    if (type & MEM_RELEASE) { heap_trace("VirtualFree", addr, 0, cpu); guest_free(addr); }
    cpu->EAX = 1;
}

void imp_kernel32__VirtualQuery(CpuState *restrict cpu) {
    uint32_t addr = isaac_arg(cpu, 0), buf = isaac_arg(cpu, 1);
    uint32_t len = isaac_arg(cpu, 2);
    if (!buf || len < 28) { cpu->EAX = 0; return; }
    /* MEMORY_BASIC_INFORMATION, 28 bytes on Win32. Report the whole arena as
     * one committed, readable/writable region. */
    isaac_w32(buf + 0, g_arena_lo);          /* BaseAddress       */
    isaac_w32(buf + 4, g_arena_lo);          /* AllocationBase    */
    isaac_w32(buf + 8, 0x04);                /* AllocationProtect = PAGE_READWRITE */
    isaac_w32(buf + 12, ISAAC_HEAP_SIZE);    /* RegionSize        */
    isaac_w32(buf + 16, MEM_COMMIT);         /* State             */
    isaac_w32(buf + 20, 0x04);               /* Protect           */
    isaac_w32(buf + 24, 0x20000);            /* Type = MEM_PRIVATE */
    (void)addr;
    cpu->EAX = 28;
}

/* ------------------------------------------------------------ the meter -- */

void isaac_heap_report(void) {
    isaac_log("[isaac][heap] ---- guest heap high-water report ----");
    isaac_log("[isaac][heap]   arena          : %u MiB at 0x%08x",
              ISAAC_HEAP_SIZE >> 20, ISAAC_HEAP_VA);
    isaac_log("[isaac][heap]   PEAK live      : %llu bytes (%.1f MiB) at alloc #%u",
              (unsigned long long)g_stat.peak, g_stat.peak / 1048576.0,
              g_stat.peak_at_alloc);
    isaac_log("[isaac][heap]   live now       : %llu bytes",
              (unsigned long long)g_stat.live);
    isaac_log("[isaac][heap]   largest single : %u bytes (%.1f MiB)",
              g_stat.largest_single, g_stat.largest_single / 1048576.0);
    isaac_log("[isaac][heap]   touched span   : %.1f MiB (highest block end 0x%08x) -- the arena pages that stay resident",
              g_heap_top > g_arena_lo ? (g_heap_top - g_arena_lo) / 1048576.0 : 0.0, g_heap_top);
    isaac_log("[isaac][heap]   allocs/frees   : %u / %u  (reallocs %u, failures %u)",
              g_stat.allocs, g_stat.frees, g_stat.reallocs, g_stat.failures);
    isaac_log("[isaac][heap]   total churn    : %llu bytes",
              (unsigned long long)g_stat.total_alloced);
    {
        uint32_t fb, fl; uint64_t fbytes;
        heap_free_census(&fb, &fl, &fbytes);
        isaac_log("[isaac][heap]   free now       : %u blocks, %llu bytes, largest %u (corrupt frees refused: %u)",
                  fb, (unsigned long long)fbytes, fl, g_stat.corrupt);
    }
    isaac_log("[isaac][heap] Move ISAAC_GUEST_LIMIT_VA / ISAAC_HEAP_SIZE to "
              "PEAK plus deliberate headroom, then GLOBAL_BASE and "
              "INITIAL_MEMORY follow from it.");
}

uint64_t isaac_heap_peak(void) { return g_stat.peak; }
uint32_t isaac_heap_arena_size(void) { return ISAAC_HEAP_SIZE; }
