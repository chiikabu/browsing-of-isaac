/* selftest.c -- link-and-run check for the host layer.
 *
 * Compiling every translation unit proves syntax. This proves the things that
 * only appear at link and run time:
 *
 *   1. All 622 weak stubs and the 13 strong hand-written shims link together
 *      with no duplicate-symbol error.
 *   2. The strong shims ACTUALLY OVERRIDE the weak ones. A typo in an
 *      identifier would compile and link happily, leaving the trap in place --
 *      the failure would only show up as a mysterious abort at runtime.
 *   3. The IAT binding writes a token into all 650 slots and every token
 *      round-trips back to its import through isaac_resolve_shim().
 *   4. A STUB returns 0 loudly rather than silently.
 *   5. Host static data really does live below the guest image base.
 *
 * Build + run:  python scripts/recomp/host/build_selftest.py
 */

#include "isaac_host.h"
#include "shim_decls.h"   /* the 622 imp_* declarations */
#include "rtti_cases.h"   /* real RTTI chains from the image */
uint32_t isaac_frames_presented(void);   /* host_shims_win.c frame counter */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* the client-array emulation's entry points (host_gl_clientarrays.c; GL types spelt out) -- round 53 */
void isaac_gl_reset_state(void);
void isaac_gl_enable_vertex_attrib_array(unsigned index);
void isaac_gl_disable_vertex_attrib_array(unsigned index);
void isaac_gl_vertex_attrib_pointer(unsigned index, int size, unsigned type, unsigned char normalized, int stride, uint32_t pointer_va);
void isaac_gl_draw_elements(unsigned mode, int count, unsigned type, uint32_t indices_va);

/* Upstream Lua 5.3.3 is linked into the selftest when present (see
 * build_selftest.py: it adds -I third_party/lua-5.3.3/src and liblua.a).
 * The runtime checks below then prove the 59-symbol binding actually
 * executes against the real VM; without the header the same section is
 * compiled out and the stub layer is what the selftest exercises. */
#if defined(__has_include)
#  if __has_include("lua.h")
#    define ISAAC_SELFTEST_HAVE_LUA 1
#    include "lua.h"
#  endif
#endif

/* Provided by the host layer TUs under test. */
void     isaac_heap_report(void);
uint64_t isaac_heap_peak(void);
void     isaac_cxx_report(void);
void     isaac_module_report(void);
unsigned isaac_stub_record_count(void);
uint32_t isaac_call_site_from_return(uint32_t ret);

/* Externs the host layer expects from the lifted module. Standalone build
 * supplies inert versions: nothing here transfers control to guest code. */
/* Section 17 (msvcp140) points fake streambuf vtable slots at these marker
 * VAs; a "virtual call" into the guest then answers like the base class:
 * EOF from underflow/uflow/overflow, 0 from sync. */
#define SELFTEST_VCALL_EOF  0xDEAD0001u
#define SELFTEST_VCALL_ZERO 0xDEAD0002u
static unsigned g_vcalls;
void isaac_guest_call(uint32_t va, CpuState *restrict cpu) {
    ++g_vcalls;
    if (!cpu) return;
    if (va == SELFTEST_VCALL_EOF) { cpu->EAX = 0xFFFFFFFFu; return; }
    cpu->EAX = 0;
}
static int g_image_loaded;
int isaac_image_is_loaded(void) { return g_image_loaded; }

/* Load the real memory image so the RTTI walk runs on real descriptors.
 * Built with -sNODERAWFS=1, so fopen reaches the actual filesystem. */
static void load_image(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { printf("      image: cannot open %s\n", path); return; }
    size_t n = fread(isaac_g(ISAAC_IMAGE_BASE), 1, ISAAC_IMAGE_SIZE, f);
    fclose(f);
    g_image_loaded = (n > 0x1000 && isaac_r16(ISAAC_IMAGE_BASE) == 0x5A4D);
    printf("      image: %zu bytes at 0x%08x, MZ=%s\n", n, ISAAC_IMAGE_BASE,
           g_image_loaded ? "yes" : "NO");
}

static int g_fail;
static void check(int cond, const char *what) {
    if (!cond) {
        printf("FAIL  %s\n", what);
        ++g_fail;
    } else {
        printf("ok    %s\n", what);
    }
}

/* Round 36: the OpenAL model (host_audio.c) advances on THIS clock in the
 * selftest -- its isaac_audio_clock_ms is weak -- so the retire rules are
 * checked at exact instants; and its backend hooks (weak no-ops in the node
 * profile, WebAudio in the web build) are counted here, which pins the
 * contract the web backend is written against. */
static double g_audio_ms;
double isaac_audio_clock_ms(void) { return g_audio_ms; }
static unsigned g_be_plays, g_be_queued, g_be_unqueued, g_be_stops, g_be_clears;
static int g_be_stream;
static uint32_t g_be_head;
static float g_be_offset;
void isaac_audio_backend_play(uint32_t src, uint32_t buffer, float gain, float pitch,
                              int looping, int streaming, uint32_t head, float offset_sec) {
    (void)src; (void)buffer; (void)gain; (void)pitch; (void)looping;
    ++g_be_plays; g_be_stream = streaming; g_be_head = head; g_be_offset = offset_sec;
}
void isaac_audio_backend_queue(uint32_t src, uint32_t buffer) { (void)src; (void)buffer; ++g_be_queued; }
void isaac_audio_backend_unqueue(uint32_t src, uint32_t n) { (void)src; g_be_unqueued += n; }
void isaac_audio_backend_stop(uint32_t src) { (void)src; ++g_be_stops; }
void isaac_audio_backend_clear(uint32_t src) { (void)src; ++g_be_clears; }

/* Round 12f lazy-FS reader for the selftest: records the path it was asked
 * for and fills the buffer with a fixed pattern. */
static unsigned g_lazy_calls;
static char g_lazy_src[128];
static int selftest_lazy_reader(const char *src, uint8_t *dst, uint32_t len) {
    ++g_lazy_calls;
    strncpy(g_lazy_src, src, sizeof g_lazy_src - 1);
    for (uint32_t i = 0; i < len; i++) dst[i] = (uint8_t)"LAZY!!"[i % 6];
    return 1;
}
/* Round 24e/26: a positional reader for a windowed lazy file. The bytes are a
 * function of the absolute offset, so a read served from the wrong window
 * or the wrong place in it is visible. */
#define WIN_FILE_SIZE 3000000u
static unsigned g_pread_calls;
static uint8_t win_byte(uint32_t off) { return (uint8_t)(off * 7u + 3u); }
/* Round 31: the persist/unlink hooks the FS shim calls for written and
 * deleted files (the node driver / the browser page stand here at run time). */
static int g_persist_calls, g_unlink_calls;
static uint32_t g_persist_len;
static char g_persist_key[256];
static uint8_t g_persist_data[64];
static int selftest_persist(const char *key, const char *src, const uint8_t *data, uint32_t len) {
    (void)src;
    ++g_persist_calls;
    g_persist_len = len;
    snprintf(g_persist_key, sizeof g_persist_key, "%s", key);
    memcpy(g_persist_data, data, len < sizeof g_persist_data ? len : sizeof g_persist_data);
    return 1;
}
static int selftest_unlink(const char *key, const char *src) { (void)key; (void)src; ++g_unlink_calls; return 1; }

static int selftest_preader(const char *src, uint8_t *dst, uint32_t off, uint32_t len) {
    (void)src;
    ++g_pread_calls;
    if (off >= WIN_FILE_SIZE) return 0;
    if (len > WIN_FILE_SIZE - off) len = WIN_FILE_SIZE - off;
    for (uint32_t i = 0; i < len; i++) dst[i] = win_byte(off + i);
    return (int)len;
}


int main(int argc, char **argv) {
    printf("--- isaac host layer selftest ---\n");
    if (argc > 1) load_image(argv[1]);

    /* 5. THE BLAST-RADIUS INVARIANT: host state must be unreachable by a
     * wild guest pointer. The lifter saw one wild write corrupt the
     * dispatch table and cascade into 1,429 bogus downstream failures. */
    static const char probe = 0;
    uint32_t hva = isaac_va(&probe);
    printf("      host static 0x%08x | guest limit 0x%08x | host base 0x%08x\n",
           hva, ISAAC_GUEST_LIMIT_VA, ISAAC_HOST_BASE_VA);
    check(hva >= ISAAC_HOST_BASE_VA,
          "host static data is above the host base");
    check(!isaac_is_guest_va(hva),
          "host static data is outside the guest-reachable range");
    void *hp = malloc(4096);
    printf("      host malloc 0x%08x\n", isaac_va(hp));
    check(isaac_va(hp) >= ISAAC_HOST_BASE_VA,
          "host malloc also lands above the host base");
    free(hp);
    check(isaac_is_guest_va(ISAAC_IMAGE_END - 1) &&
          isaac_is_guest_va(ISAAC_HEAP_VA + ISAAC_HEAP_SIZE - 1) &&
          isaac_is_guest_va(ISAAC_STACK_TOP_VA - 1) &&
          isaac_is_guest_va(ISAAC_SHIM_BASE + (isaac_import_count - 1) * ISAAC_SHIM_STRIDE),
          "image, heap, stack and shim tokens are all below the guest limit");
    check(ISAAC_HEAP_VA >= ISAAC_IMAGE_END,
          "guest heap is above the image, so a .data overrun hits guest memory");
    check(ISAAC_GUARD_VA + ISAAC_GUARD_SIZE == ISAAC_HOST_BASE_VA,
          "the guard region abuts the host base with no gap");

    /* 1. table shape: 622 static IAT imports + the dynamic (LoadLibrary/
     * GetProcAddress) exports the game resolves at runtime (RtlVerifyVersionInfo,
     * wgl*, gl*, xinput, steam ctx, ...). The exact total is a canary that
     * moves only when gen_shims.py's DYNAMIC_EXPORTS changes. */
    /* 106 since round 22 (the five ALC_SOFT_system_events / reopen / pause /
     * resume entry points the mixer asks alcGetProcAddress for). */
    check(isaac_import_count == 728, "622 IAT + 106 dynamic imports linked");

    /* 3. tokens are unique and round-trip */
    unsigned round = 0, uniq = 1;
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        isaac_import *imp = &isaac_imports[i];
        if (isaac_resolve_shim(imp->shim_va) == imp) ++round;
        if (i && isaac_imports[i].shim_va <= isaac_imports[i - 1].shim_va)
            uniq = 0;
    }
    check(round == isaac_import_count, "every shim token resolves to its import");
    check(uniq, "shim tokens are strictly increasing (hence unique)");
    check(isaac_resolve_shim(ISAAC_IMAGE_BASE) == NULL,
          "an ordinary guest VA does not resolve to a shim");
    check(isaac_resolve_shim(ISAAC_SHIM_BASE + 1) == NULL,
          "a misaligned token does not resolve");

    /* 3b. IAT binding: needs the .rdata IAT page to be addressable memory. */
    memset(isaac_g(ISAAC_IAT_VA), 0, ISAAC_IAT_SLOTS * 4);
    isaac_boot_bind_iat();
    unsigned bound = 0, slotted = 0;
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        /* Dynamic (LoadLibrary/GetProcAddress) exports have no IAT slot
         * (iat_slot_va == 0) and are bound at resolve time, not here. */
        if (!isaac_imports[i].iat_slot_va) continue;
        ++slotted;
        if (isaac_r32(isaac_imports[i].iat_slot_va) == isaac_imports[i].shim_va)
            ++bound;
    }
    printf("      %u/%u IAT slots hold their shim token (%u dynamic exports unslotted)\n",
           bound, slotted, isaac_import_count - slotted);
    check(bound == slotted, "IAT binding wrote every slotted import");

    /* 2. THE OVERRIDE CHECK.
     * imp_..._errno is hand-written and must return the errno cell VA. The weak
     * fallback for a REAL verdict calls isaac_trap(), which aborts -- so if the
     * override failed to take, this test does not merely fail, it terminates.
     * Reaching the line after the call is itself part of the assertion. */
    CpuState cpu;
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);          /* return address */
    imp_api_ms_win_crt_runtime___errno(&cpu);
    printf("      _errno returned 0x%08x\n", cpu.EAX);
    check(cpu.EAX != 0, "strong shim _errno overrode the weak trap");

    /* _set_errno / _errno agree */
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, 42);
    imp_api_ms_win_crt_runtime___set_errno(&cpu);
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    imp_api_ms_win_crt_runtime___errno(&cpu);
    check(isaac_r32(cpu.EAX) == 42, "_set_errno(42) then _errno reads back 42");

    /* __acrt_iob_func must hand out three distinct guest-visible blocks */
    uint32_t iob[3];
    for (unsigned i = 0; i < 3; ++i) {
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, i);
        imp_api_ms_win_crt_stdio____acrt_iob_func(&cpu);
        iob[i] = cpu.EAX;
    }
    check(iob[0] && iob[1] && iob[2] && iob[0] != iob[1] && iob[1] != iob[2],
          "__acrt_iob_func returns 3 distinct non-null streams");
    check(isaac_r32(iob[2] + 0x10) == 2, "stderr block carries fd 2 at +0x10");

    /* 4. a STUB is inert but loud, and returns 0 */
    isaac_import *stub = NULL;
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        if (isaac_imports[i].verdict == ISAAC_V_STUB &&
            isaac_imports[i].call_sites > 0) { stub = &isaac_imports[i]; break; }
    }
    check(stub != NULL, "found a STUB import to exercise");
    if (stub) {
        printf("      exercising stub %s!%s (purge %u)\n",
               stub->dll, stub->symbol, stub->arg_bytes);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0x00401234);
        uint32_t esp0 = cpu.ESP;
        int handled = isaac_indirect_call(stub->shim_va, &cpu);
        check(handled == 1, "isaac_indirect_call handled the shim token");
        check(cpu.EAX == 0, "stub returned 0");
        check(cpu.ESP == esp0 + 4u + stub->arg_bytes,
              "stub popped return address + its stdcall purge");
        check(cpu.EIP == 0x00401234, "stub returned to the caller VA");
        /* PROVES OUR weak definitions won the link. Both this layer and the
         * lifter emitted weak imp_* definitions for the same 591 imports; two
         * weak symbols do not collide, so the linker silently picks one. The
         * lifter's stub returns without recording anything, so a non-zero
         * record count is only possible if ours survived. Neither layer's own
         * tests could catch this, because the bug exists only in the pair. */
        check(isaac_stub_record_count() > 0,
              "this layer's weak stub definitions are the ones linked in");
    }

    /* 6. THE GUEST ALLOCATOR must hand out GUEST addresses.
     * Forwarding guest malloc to the host allocator would return pointers
     * above the guard -- write access to the runtime. This is the check that
     * catches that regression. */
    uint32_t ptrs[8];
    for (unsigned i = 0; i < 8; ++i) {
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 1024u << i);
        imp_api_ms_win_crt_heap__malloc(&cpu);
        ptrs[i] = cpu.EAX;
    }
    int all_guest = 1, all_distinct = 1;
    for (unsigned i = 0; i < 8; ++i) {
        if (!ptrs[i] || !isaac_is_guest_va(ptrs[i])) all_guest = 0;
        if (ptrs[i] < ISAAC_HEAP_VA ||
            ptrs[i] >= ISAAC_HEAP_VA + ISAAC_HEAP_SIZE) all_guest = 0;
        for (unsigned j = i + 1; j < 8; ++j)
            if (ptrs[i] == ptrs[j]) all_distinct = 0;
    }
    printf("      guest malloc[0] 0x%08x  peak %llu bytes\n",
           ptrs[0], (unsigned long long)isaac_heap_peak());
    check(all_guest, "guest malloc returns pointers inside the GUEST arena");
    check(all_distinct, "guest malloc returns distinct blocks");
    check(isaac_heap_peak() > 0, "heap high-water meter is recording");

    /* the blocks must be writable and not overlap */
    for (unsigned i = 0; i < 8; ++i)
        memset(isaac_g(ptrs[i]), (int)(i + 1), 1024u << i);
    int intact = 1;
    for (unsigned i = 0; i < 8; ++i) {
        const uint8_t *q = (const uint8_t *)isaac_g(ptrs[i]);
        for (uint32_t k = 0; k < (1024u << i); ++k)
            if (q[k] != (uint8_t)(i + 1)) { intact = 0; break; }
    }
    check(intact, "guest heap blocks do not overlap after writing all of them");

    /* free then reallocate: the arena must be reusable */
    uint64_t peak_before = isaac_heap_peak();
    for (unsigned i = 0; i < 8; ++i) {
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, ptrs[i]);
        imp_api_ms_win_crt_heap__free(&cpu);
    }
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, 4096);
    imp_api_ms_win_crt_heap__malloc(&cpu);
    check(cpu.EAX && isaac_is_guest_va(cpu.EAX),
          "arena is reusable after free (coalescing works)");
    check(isaac_heap_peak() == peak_before,
          "peak is a high-water mark, not the live figure");

    /* Round 12d allocator (segregated free lists, two-way coalescing): the
     * first-fit walk it replaced was 95% of a 470 s boot. */
    {
        extern uint32_t isaac_guest_alloc(uint32_t n);
        extern void     isaac_guest_free(uint32_t p);
        extern uint32_t isaac_guest_realloc(uint32_t p, uint32_t n);
        extern uint32_t isaac_heap_free_blocks(void);
        extern uint32_t isaac_heap_largest_free(void);
        /* coalescing: three neighbours freed middle-last must fold back into
         * one block (backward AND forward merge), leaving the largest free
         * block and the free-block count as they were */
        uint32_t before_largest = isaac_heap_largest_free();
        uint32_t before_blocks = isaac_heap_free_blocks();
        uint32_t a = isaac_guest_alloc(100), b = isaac_guest_alloc(200), c = isaac_guest_alloc(300);
        check(a && b && c && a < b && b < c, "three consecutive blocks come out ascending");
        isaac_guest_free(a);
        isaac_guest_free(c);
        isaac_guest_free(b);
        check(isaac_heap_largest_free() == before_largest && isaac_heap_free_blocks() == before_blocks,
              "freeing neighbours (ends first, middle last) coalesces both ways back to one block");
        /* churn: 4000 random-sized blocks written with their own pattern, freed
         * in a different order, must never overlap or lose their bytes */
        enum { NCH = 4000 };
        static uint32_t ptr[NCH]; static uint32_t len[NCH];
        uint32_t seed = 0x9e3779b9u;
        int churn_ok = 1;
        for (int i = 0; i < NCH; i++) {
            seed = seed * 1664525u + 1013904223u;
            len[i] = 1u + (seed >> 8) % 700u;
            ptr[i] = isaac_guest_alloc(len[i]);
            if (!ptr[i] || (ptr[i] & 7u)) { churn_ok = 0; break; }
            memset(isaac_g(ptr[i]), (int)(i & 0xff), len[i]);
            if (i % 3 == 2) {                 /* free an earlier one to fragment */
                int j = (int)((seed >> 4) % (uint32_t)i);
                if (ptr[j]) { isaac_guest_free(ptr[j]); ptr[j] = 0; }
            }
        }
        for (int i = 0; i < NCH && churn_ok; i++) {
            if (!ptr[i]) continue;
            const uint8_t *q = (const uint8_t *)isaac_g(ptr[i]);
            for (uint32_t k = 0; k < len[i]; k++)
                if (q[k] != (uint8_t)(i & 0xff)) { churn_ok = 0; break; }
        }
        check(churn_ok, "4000-block churn: every surviving block still holds its own pattern (no overlap)");
        /* realloc keeps the bytes */
        uint32_t r = isaac_guest_alloc(40);
        memset(isaac_g(r), 0x5a, 40);
        r = isaac_guest_realloc(r, 4000);
        check(r && ((const uint8_t *)isaac_g(r))[39] == 0x5a, "realloc to a larger block keeps the old bytes");
        isaac_guest_free(r);
        for (int i = 0; i < NCH; i++) if (ptr[i]) isaac_guest_free(ptr[i]);
        check(isaac_heap_largest_free() == before_largest && isaac_heap_free_blocks() == before_blocks,
              "after freeing everything the arena is one block again (no leaked fragments)");
        /* the guards: a double free and a foreign pointer are refused, not acted on */
        uint32_t d = isaac_guest_alloc(64);
        isaac_guest_free(d);
        isaac_guest_free(d);
        isaac_guest_free(ISAAC_STACK_TOP_VA - 0x100);
        uint32_t e = isaac_guest_alloc(64);
        check(e == d, "a double free is ignored and the block is reused exactly once");
        isaac_guest_free(e);
    }

    /* VirtualAlloc must also stay inside the guest range and zero its memory */
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, 0);        /* lpAddress  */
    isaac_w32(cpu.ESP + 8, 65536);    /* dwSize     */
    isaac_w32(cpu.ESP + 12, 0x1000);  /* MEM_COMMIT */
    isaac_w32(cpu.ESP + 16, 0x04);
    imp_kernel32__VirtualAlloc(&cpu);
    uint32_t va = cpu.EAX;
    int zeroed = 1;
    if (va) {
        const uint8_t *q = (const uint8_t *)isaac_g(va);
        for (uint32_t k = 0; k < 65536; ++k) if (q[k]) { zeroed = 0; break; }
    }
    check(va && isaac_is_guest_va(va), "VirtualAlloc returns a guest address");
    check(zeroed, "VirtualAlloc zeroes its memory (malloc does not)");

    /* the TEB must be installable and give fs:[0] an empty SEH chain */
    isaac_boot_install_teb();
    check(isaac_r32(ISAAC_TEB_VA + 0x00) == 0xFFFFFFFFu,
          "TEB ExceptionList is an empty SEH chain");
    check(isaac_r32(ISAAC_TEB_VA + 0x18) == ISAAC_TEB_VA, "TEB Self is correct");
    check(isaac_r32(ISAAC_PEB_VA + 0x08) == ISAAC_IMAGE_BASE,
          "PEB ImageBaseAddress is the image base");

    /* 7. __RTDynamicCast against REAL RTTI.
     * Validating a dynamic_cast implementation against a mock proves only that
     * the mock agrees with the implementation. These are genuine MSVC
     * descriptor chains read out of the shipped .rdata, so the shim is
     * exercised on the same bytes the game will hand it. Requires the memory
     * image; skipped if it could not be loaded. */
    if (g_image_loaded && G_NRTTI > 0) {
        unsigned ok_up = 0, ok_neg = 0;
        for (unsigned i = 0; i < G_NRTTI; ++i) {
            const RttiCase *rc = &g_rtti[i];
            /* Synthesise an object: first dword is the vfptr. Put it in the
             * guest heap so it is a realistic address. */
            uint32_t obj = ISAAC_HEAP_VA + 0x10000 + i * 64;
            isaac_w32(obj, rc->vftable);

            /* upcast to a real base in the hierarchy */
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, obj);
            isaac_w32(cpu.ESP + 8, 0);
            isaac_w32(cpu.ESP + 12, rc->typeDescriptor);
            isaac_w32(cpu.ESP + 16, rc->baseTypeDescriptor);
            isaac_w32(cpu.ESP + 20, 0);
            imp_vcruntime140____RTDynamicCast(&cpu);
            uint32_t got = cpu.EAX;
            uint32_t want = obj + (uint32_t)rc->mdisp;
            if (got == want) ++ok_up;
            else printf("      RTTI[%u] %s -> %s: got 0x%08x want 0x%08x\n",
                        i, rc->name, rc->baseName, got, want);

            /* negative: a type descriptor that is not in this hierarchy at all */
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, obj);
            isaac_w32(cpu.ESP + 8, 0);
            isaac_w32(cpu.ESP + 12, rc->typeDescriptor);
            isaac_w32(cpu.ESP + 16, ISAAC_IMAGE_BASE + 0x1000);  /* not a TD */
            isaac_w32(cpu.ESP + 20, 0);
            imp_vcruntime140____RTDynamicCast(&cpu);
            if (cpu.EAX == 0) ++ok_neg;
        }
        printf("      RTTI cases: %u/%u upcasts, %u/%u correct nulls\n",
               ok_up, G_NRTTI, ok_neg, G_NRTTI);
        check(ok_up == G_NRTTI,
              "__RTDynamicCast resolves real upcasts through real RTTI");
        check(ok_neg == G_NRTTI,
              "__RTDynamicCast returns null for a type not in the hierarchy");

        /* null in, null out -- and it must not walk anything */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0);
        imp_vcruntime140____RTDynamicCast(&cpu);
        check(cpu.EAX == 0, "__RTDynamicCast(nullptr) is nullptr");
        isaac_cxx_report();
    } else {
        printf("      (RTTI cases skipped: memory image not loaded)\n");
    }

    /* 8. The 16 imports on the critical path to main() must all be real. */
    {
        static const char *boot16[] = {
            "_set_app_type", "_set_fmode", "__p__commode", "_crt_atexit",
            "_configure_narrow_argv", "InitializeSListHead", "_controlfp_s",
            "_configthreadlocale", "_initialize_narrow_environment",
            "InitializeCriticalSectionAndSpinCount", "GetModuleHandleW",
            "IsProcessorFeaturePresent", "memset", "IsDebuggerPresent",
            "SetUnhandledExceptionFilter", "UnhandledExceptionFilter",
        };
        unsigned found = 0, real = 0;
        for (unsigned i = 0; i < sizeof boot16 / sizeof boot16[0]; ++i)
            for (unsigned j = 0; j < isaac_import_count; ++j)
                if (!strcmp(isaac_imports[j].symbol, boot16[i])) {
                    ++found;
                    if (isaac_imports[j].verdict == ISAAC_V_REAL ||
                        isaac_imports[j].verdict == ISAAC_V_PROVIDED) ++real;
                    break;
                }
        printf("      boot-critical: %u/16 present, %u REAL/PROVIDED\n",
               found, real);
        check(found == 16, "all 16 boot-critical imports are in the table");
        check(real == 16, "all 16 are REAL or PROVIDED, none left a stub");
    }

    /* They must EXECUTE, not trap. A weak fallback for a REAL verdict aborts,
     * so reaching the line after each call is part of the assertion. */
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    imp_kernel32__IsDebuggerPresent(&cpu);
    check(cpu.EAX == 0, "IsDebuggerPresent returns 0 without trapping");

    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    imp_api_ms_win_crt_stdio____p__commode(&cpu);
    check(cpu.EAX && isaac_is_guest_va(cpu.EAX),
          "__p__commode returns a guest-visible cell the CRT writes through");

    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, 10);          /* PF_XMMI64 (SSE2) */
    imp_kernel32__IsProcessorFeaturePresent(&cpu);
    check(cpu.EAX == 1, "IsProcessorFeaturePresent reports SSE2 available");

    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, 0);
    imp_kernel32__GetModuleHandleW(&cpu);
    check(cpu.EAX == ISAAC_IMAGE_BASE,
          "GetModuleHandleW(NULL) returns the image base");

    /* Unlifted thunk decoding (boot round 12): the static-destructor pass
     * calls adjustor thunks (`add ecx, imm8; jmp rel32`) and bare `jmp rel32`
     * thunks that no function-start scan recorded. The indirect-call fallback
     * decodes them from the image bytes instead of trapping. */
    {
        extern int isaac_decode_thunk(uint32_t va, int32_t *ecx_delta, uint32_t *dest);
        /* 0x0069d1f0: 83 C1 04 E9 48 FE D6 FF  -> add ecx,4; jmp 0x0040d040 */
        int32_t d = 0; uint32_t dest = 0;
        int ok = isaac_decode_thunk(0x0069d1f0u, &d, &dest);
        check(ok && d == 4 && dest == 0x0040d040u, "adjustor thunk 0x0069d1f0 decodes to add ecx,4; jmp 0x0040d040");
        /* 0x007df3e0: E9 5B B7 24 00 -> jmp 0x00a2ab40 */
        ok = isaac_decode_thunk(0x007df3e0u, &d, &dest);
        check(ok && d == 0 && dest == 0x00a2ab40u, "jump thunk 0x007df3e0 decodes to jmp 0x00a2ab40");
        /* a real function prologue is not a thunk */
        ok = isaac_decode_thunk(0x0040ccd0u, &d, &dest);
        check(!ok, "a push ebp prologue is not decoded as a thunk");
    }

    /* Host fastpath (boot round 12): exact re-implementations of the three
     * leaf functions that dominate the boot. Spec vectors here; the boot's
     * ISAAC_FASTPATH_VERIFY=1 mode compares against the lifted bodies on
     * real data. */
    {
        extern uint32_t isaac_fast_adler32(uint32_t, uint32_t, uint32_t);
        extern void isaac_fast_unfilter(uint32_t, uint32_t, uint32_t, uint32_t);
        extern void isaac_fast_premultiply(uint32_t, uint32_t, uint32_t);
        uint32_t buf = ISAAC_STACK_TOP_VA - 0x3000;
        const char *w = "Wikipedia";
        for (int i = 0; i < 9; i++) *(uint8_t *)isaac_g(buf + i) = (uint8_t)w[i];
        check(isaac_fast_adler32(1u, buf, 9u) == 0x11E60398u, "adler32(\"Wikipedia\") == 0x11E60398 (RFC 1950)");
        check(isaac_fast_adler32(1u, 0u, 9u) == 1u, "adler32 of a NULL buffer is 1, as zlib defines it");
        /* 6000 bytes: crosses the NMAX (5552) chunk boundary and drives both
         * sums past 65521, so the modulus and the chunking are both pinned
         * (expected value from Python's zlib.adler32 on the same bytes). */
        uint32_t big = ISAAC_STACK_TOP_VA - 0x20000;
        for (uint32_t i = 0; i < 6000u; i++) *(uint8_t *)isaac_g(big + i) = (uint8_t)(i * 7u + 3u);
        check(isaac_fast_adler32(1u, big, 6000u) == 0x26A8AC6Eu, "adler32 over 6000 bytes (past NMAX and the modulus) == 0x26A8AC6E");
        /* all 0xff: without the NMAX chunking s2 overflows 32 bits before the
         * modulus is applied, so this also pins the chunk size. */
        for (uint32_t i = 0; i < 6000u; i++) *(uint8_t *)isaac_g(big + i) = 0xffu;
        check(isaac_fast_adler32(1u, big, 6000u) == 0xA49759EAu, "adler32 over 6000 x 0xff (s2 would overflow unchunked) == 0xA49759EA");
        /* png_row_info: rowbytes 6, pixel_depth 24 (bpp 3) */
        uint32_t info = ISAAC_STACK_TOP_VA - 0x3100, row = ISAAC_STACK_TOP_VA - 0x3200,
                 prev = ISAAC_STACK_TOP_VA - 0x3300;
        isaac_w32(info + 0, 2); isaac_w32(info + 4, 6);
        *(uint8_t *)isaac_g(info + 0xb) = 24;
        const uint8_t prow[6] = {10, 20, 30, 40, 50, 60};
        for (int i = 0; i < 6; i++) *(uint8_t *)isaac_g(prev + i) = prow[i];
        const uint8_t sub[6] = {1, 2, 3, 4, 5, 6};
        for (int i = 0; i < 6; i++) *(uint8_t *)isaac_g(row + i) = sub[i];
        isaac_fast_unfilter(info, row, prev, 1);        /* Sub: row[i] += row[i-3] */
        check(*(uint8_t *)isaac_g(row + 3) == 5 && *(uint8_t *)isaac_g(row + 5) == 9, "PNG Sub filter");
        for (int i = 0; i < 6; i++) *(uint8_t *)isaac_g(row + i) = sub[i];
        isaac_fast_unfilter(info, row, prev, 2);        /* Up */
        check(*(uint8_t *)isaac_g(row + 0) == 11 && *(uint8_t *)isaac_g(row + 5) == 66, "PNG Up filter");
        for (int i = 0; i < 6; i++) *(uint8_t *)isaac_g(row + i) = sub[i];
        isaac_fast_unfilter(info, row, prev, 3);        /* Avg: [0]=1+10/2=6, [3]=4+(6+40)/2=27 */
        check(*(uint8_t *)isaac_g(row + 0) == 6 && *(uint8_t *)isaac_g(row + 3) == 27, "PNG Average filter");
        for (int i = 0; i < 6; i++) *(uint8_t *)isaac_g(row + i) = sub[i];
        isaac_fast_unfilter(info, row, prev, 4);        /* Paeth: [0]=1+10=11; [3]: a=11 b=40 c=10 p=41 pa=30 pb=1 pc=31 -> b -> 44 */
        check(*(uint8_t *)isaac_g(row + 0) == 11 && *(uint8_t *)isaac_g(row + 3) == 44, "PNG Paeth filter");
        /* Paeth tie-break: pb == pc must pick b (the spec's order a, b, c).
         * bpp 1, prev [4, 0], raw [2, 10]: [0] = 2+4 = 6; [1]: a=6 b=0 c=4
         * p=2 pa=4 pb=2 pc=2 -> b -> 10 (a "pb < pc" mutant picks c -> 14). */
        isaac_w32(info + 4, 2); *(uint8_t *)isaac_g(info + 0xb) = 8;
        *(uint8_t *)isaac_g(prev + 0) = 4; *(uint8_t *)isaac_g(prev + 1) = 0;
        *(uint8_t *)isaac_g(row + 0) = 2; *(uint8_t *)isaac_g(row + 1) = 10;
        isaac_fast_unfilter(info, row, prev, 4);
        check(*(uint8_t *)isaac_g(row + 0) == 6 && *(uint8_t *)isaac_g(row + 1) == 10, "PNG Paeth tie-break prefers b over c");
        isaac_w32(info + 4, 6); *(uint8_t *)isaac_g(info + 0xb) = 24;
        /* premultiply with an identity-free table: table[(a<<8)|v] = v/2 */
        uint32_t tbl = ISAAC_STACK_TOP_VA - 0x14000;   /* 64 KB in the guest stack scratch */
        for (uint32_t a = 0; a < 256; a++) for (uint32_t v = 0; v < 256; v++)
            *(uint8_t *)isaac_g(tbl + (a << 8) + v) = (uint8_t)(v / 2);
        uint32_t px = ISAAC_STACK_TOP_VA - 0x3400;
        const uint8_t pix[12] = {200, 100, 50, 0xff,  200, 100, 50, 0,  200, 100, 50, 0x80};
        for (int i = 0; i < 12; i++) *(uint8_t *)isaac_g(px + i) = pix[i];
        isaac_fast_premultiply(px, 3, tbl);
        check(*(uint8_t *)isaac_g(px + 0) == 200 && *(uint8_t *)isaac_g(px + 3) == 0xff,
              "premultiply leaves alpha 0xff pixels alone");
        check(isaac_r32(px + 4) == 0, "premultiply zeroes alpha 0 pixels");
        check(*(uint8_t *)isaac_g(px + 8) == 100 && *(uint8_t *)isaac_g(px + 10) == 25 && *(uint8_t *)isaac_g(px + 11) == 0x80,
              "premultiply maps R,G,B through the alpha table and keeps alpha");
    }

    /* Host fastpath, round 27 (recomp-architecture.md 21.42): the ISAAC
     * keystream core and its consumer, ArchivedFile::read's window
     * arithmetic and the engine Mutex predicates. The boot's
     * ISAAC_FASTPATH_VERIFY=1 compares each against its lifted body on the
     * game's own data; these pin the host code by itself. */
    {
        extern int isaac_fast_guest_range(uint32_t, uint32_t);
        extern int isaac_fast_isaac(uint32_t, uint32_t *);
        extern int isaac_fast_keystream_ok(uint32_t, uint32_t, uint32_t);
        extern void isaac_fast_keystream_xor(uint32_t, uint32_t, uint32_t);
        extern int isaac_fast_read_plan(uint32_t, uint32_t, uint32_t, uint32_t *);
        extern void isaac_fast_read_window(uint32_t, uint32_t, uint32_t);
        extern int isaac_fast_mutex_init(uint32_t), isaac_fast_mutex_free(uint32_t), isaac_fast_mutex_std(uint32_t);
        extern void isaac_fast_mutex_take(uint32_t), isaac_fast_mutex_drop(uint32_t);
        check(isaac_fast_guest_range(0x1000u, 0x10u) && !isaac_fast_guest_range(ISAAC_GUEST_LIMIT_VA - 8u, 0x10u)
              && !isaac_fast_guest_range(0xfffffff0u, 0x20u),
              "fast guest_range: inside the guest, straddling the limit, wrapping around");
        /* isaac(): Jenkins' own two-half-loop formulation (rand.c, RANDSIZL
         * 8) on a host copy of the context is the reference for the merged
         * single loop the engine compiled (mm[(i + 128) & 255] as the second
         * pointer). Same layout: r at +4, mm at +0x404, a/b/c at +0x804. */
        uint32_t ctx = ISAAC_STACK_TOP_VA - 0x40000u, ctx2 = ISAAC_STACK_TOP_VA - 0x3f000u;
        for (uint32_t i = 0; i < 256u; i++) {
            isaac_w32(ctx + 4u + 4u * i, 0u);
            isaac_w32(ctx + 0x404u + 4u * i, i * 0x9e3779b9u + 1u);
        }
        isaac_w32(ctx, 77u); isaac_w32(ctx + 0x804u, 0x12345678u);
        isaac_w32(ctx + 0x808u, 0x9abcdef0u); isaac_w32(ctx + 0x80cu, 3u);
        uint32_t ref[0x204], ax = 0u;
        memcpy(ref, isaac_g(ctx), 0x810u);
        {
            uint32_t *mm = ref + 0x101, *r = ref + 1, *m, *m2, *mend, x, y;
            uint32_t a = ref[0x201], b = ref[0x202] + (++ref[0x203]);
#define IND(mm, x) (*(uint32_t *)((uint8_t *)(mm) + ((x) & (255u << 2))))
#define RNGSTEP(mix) { x = *m; ax = a ^ (mix); a = ax + *(m2++); *(m++) = y = IND(mm, x) + a + b; *(r++) = b = IND(mm, y >> 8) + x; }
            for (m = mm, mend = m2 = mm + 128; m < mend; ) { RNGSTEP(a << 13) RNGSTEP(a >> 6) RNGSTEP(a << 2) RNGSTEP(a >> 16) }
            for (m2 = mm; m2 < mend; ) { RNGSTEP(a << 13) RNGSTEP(a >> 6) RNGSTEP(a << 2) RNGSTEP(a >> 16) }
#undef RNGSTEP
#undef IND
            ref[0x202] = b; ref[0x201] = a;
        }
        uint32_t edx = 0u;
        check(isaac_fast_isaac(ctx, &edx) == 1, "isaac(): a guest context is accepted");
        check(memcmp(ref, isaac_g(ctx), 0x810u) == 0, "isaac(): r[], mm[], a, b and c match Jenkins' two-half-loop reference");
        check(isaac_r32(ctx + 0x80cu) == 4u && isaac_r32(ctx) == 77u, "isaac(): c is incremented once; the consumer's index word is untouched");
        check(edx == ax, "isaac(): EDX is the last iteration's a after its xor step, as the lifted loop leaves it");
        check(isaac_fast_isaac(ISAAC_GUEST_LIMIT_VA - 0x100u, &edx) == 0, "isaac(): a context past the guest limit is refused untouched");
        /* the consumer: r[254], r[255], then the refill, then r[0] of the new block */
        uint32_t holder = ISAAC_STACK_TOP_VA - 0x3e000u, buf = ISAAC_STACK_TOP_VA - 0x3df00u;
        isaac_w32(holder, ctx);
        isaac_w32(ctx, 254u);
        memcpy(isaac_g(ctx2), isaac_g(ctx), 0x810u);
        uint32_t r254 = isaac_r32(ctx + 4u + 4u * 254u), r255 = isaac_r32(ctx + 4u + 4u * 255u);
        isaac_fast_isaac(ctx2, NULL);                        /* what the refill inside the XOR will produce */
        /* 40 bytes from r[254]: two words to the refill, then eight of the new block
         * (two sixteen-byte blocks where the build has SIMD, round 62) */
        for (uint32_t i = 0; i < 40u; i++) *(uint8_t *)isaac_g(buf + i) = (uint8_t)(0x40u + i);
        check(isaac_fast_keystream_ok(holder, buf, 40u), "keystream: a guest holder, context and buffer are accepted");
        isaac_fast_keystream_xor(holder, buf, 40u);
        int ks_ok = 1;
        for (uint32_t i = 0; i < 40u; i++) {
            uint32_t w = i < 4u ? r254 : i < 8u ? r255 : isaac_r32(ctx2 + 4u + 4u * ((i - 8u) / 4u));
            if (*(uint8_t *)isaac_g(buf + i) != (uint8_t)((0x40u + i) ^ (w >> (8u * (i & 3u))))) ks_ok = 0;
        }
        check(ks_ok, "keystream: each byte XORs r[idx], least significant byte first, across the refill");
        check(isaac_r32(ctx) == 8u, "keystream: taking r[255] refills at once and the index goes on from 0 (eight words of the new block taken)");
        check(memcmp(isaac_g(ctx + 4u), isaac_g(ctx2 + 4u), 0x80cu) == 0, "keystream: the refilled block is isaac() of the old one, c included");
        isaac_w32(ctx, 0x100u);
        check(!isaac_fast_keystream_ok(holder, buf, 12u), "keystream: an index past r[] is left to the lifted body");
        isaac_w32(ctx, 5u);
        isaac_fast_keystream_xor(holder, buf, 0u);
        check(isaac_r32(ctx) == 5u && isaac_fast_keystream_ok(holder, buf, 0u), "keystream: a zero-length XOR consumes nothing");
        /* Round 57: the archive stream's inflate_fast (0x00adb9c0) on a
         * hand-made table -- code 0 = 'a' (1 bit), 01 = length 3 (2 bits),
         * 11 = end of block; distances 0 = 1, 1 = 2 (1 bit each) -- and a
         * 1 KB ring window. Bits are taken least significant first. */
        {
            extern int isaac_fast_inflate_ring_ok(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
            extern int isaac_fast_inflate_ring(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
            uint32_t win = ISAAC_STACK_TOP_VA - 0x3d000u, ist = win + 0x400u, in = win + 0x500u, lc = win + 0x600u, dc = win + 0x700u, ib = win + 0x800u;
#define ENT(va, op, nb, val) do { *(uint8_t *)isaac_g(va) = (uint8_t)(op); *(uint8_t *)isaac_g((va) + 1u) = (uint8_t)(nb); isaac_w16((va) + 2u, 0u); isaac_w32((va) + 4u, (val)); } while (0)
#define INFLATE_RESET(byte0, avail) do { memset(isaac_g(win), 0, 0x400u); memset(isaac_g(ib), 0, 16u); *(uint8_t *)isaac_g(ib) = (uint8_t)(byte0); \
            isaac_w32(ist + 0x1cu, 0u); isaac_w32(ist + 0x20u, 0u); isaac_w32(ist + 0x28u, win); isaac_w32(ist + 0x2cu, win + 0x400u); \
            isaac_w32(ist + 0x30u, win); isaac_w32(ist + 0x34u, win); \
            isaac_w32(in, ib); isaac_w32(in + 4u, (avail)); isaac_w32(in + 8u, 100u); isaac_w32(in + 0x18u, 0u); } while (0)
            ENT(lc, 0, 1, 'a'); ENT(lc + 8u, 0x10, 2, 3u); ENT(lc + 16u, 0, 1, 'a'); ENT(lc + 24u, 0x60, 2, 0u);
            ENT(dc, 0x10, 1, 1u); ENT(dc + 8u, 0x10, 1, 2u);
            INFLATE_RESET(0x64u, 16u);                      /* 0, 0, 01, 0, 11: a a <3,1> eob */
            check(isaac_fast_inflate_ring_ok(2u, 1u, lc, dc, ist, in), "inflate: a guest window, tables and input are accepted");
            int r = isaac_fast_inflate_ring(2u, 1u, lc, dc, ist, in);
            check(r == 1 && memcmp(isaac_g(win), "aaaaa", 5) == 0 && isaac_r32(ist + 0x34u) == win + 5u,
                  "inflate: two literals, a length-3 distance-1 copy, end of block -> 1");
            check(isaac_r32(ist + 0x1cu) == 1u && isaac_r32(ist + 0x20u) == 0u && isaac_r32(in) == ib + 1u && isaac_r32(in + 4u) == 15u && isaac_r32(in + 8u) == 101u,
                  "inflate: the whole bytes left in the bit buffer go back to the input (bits 1, next +1, avail 15, total +1)");
            INFLATE_RESET(0x3au, 16u); *(uint8_t *)isaac_g(win + 0x3ffu) = 'z';   /* 0, 01, 1, 11: a <3,2> eob */
            r = isaac_fast_inflate_ring(2u, 1u, lc, dc, ist, in);
            check(r == 1 && memcmp(isaac_g(win), "azaz", 4) == 0 && isaac_r32(ist + 0x34u) == win + 4u && isaac_r32(ist + 0x1cu) == 2u,
                  "inflate: a distance past the window's start wraps to its end (one byte from the end, the rest from the start)");
            INFLATE_RESET(0x64u, 12u);
            r = isaac_fast_inflate_ring(2u, 1u, lc, dc, ist, in);
            check(r == 0 && isaac_r32(ist + 0x34u) == win + 1u && isaac_r32(ist + 0x1cu) == 7u && isaac_r32(ist + 0x20u) == 0x32u
                  && isaac_r32(in) == ib + 1u && isaac_r32(in + 4u) == 11u,
                  "inflate: fewer than 10 input bytes after a symbol -> 0, the position and the bit buffer kept");
            ENT(lc, 0x40, 1, 0u);
            INFLATE_RESET(0x00u, 16u);
            r = isaac_fast_inflate_ring(2u, 1u, lc, dc, ist, in);
            check(r == -3 && isaac_r32(in + 0x18u) == 0xba9ec0u && isaac_r32(in) == ib + 1u && isaac_r32(ist + 0x1cu) == 7u,
                  "inflate: an invalid literal/length code -> -3 with the engine's own message");
            ENT(lc, 0, 1, 'a');
            INFLATE_RESET(0x64u, 16u);
            check(!isaac_fast_inflate_ring_ok(16u, 1u, lc, dc, ist, in), "inflate: more than 15 index bits is left to the lifted body");
            isaac_w32(in + 4u, 9u);
            check(!isaac_fast_inflate_ring_ok(2u, 1u, lc, dc, ist, in), "inflate: fewer than 10 input bytes is left to the lifted body");
            isaac_w32(in + 4u, 16u); isaac_w32(ist + 0x30u, win + 100u);
            check(!isaac_fast_inflate_ring_ok(2u, 1u, lc, dc, ist, in), "inflate: under 258 bytes of room before the reader is left to the lifted body");
#undef INFLATE_RESET
#undef ENT
        }
        /* Round 58: miniz tinfl_decompress (0x00a85710) on raw deflate streams
         * zlib made: a stored block, a fixed-Huffman block, a dynamic one over
         * a 2880-byte text, decoded whole (flag 4: the buffer does not wrap), and
         * a 512-byte-window stream decoded through a 512-byte ring the way the
         * archive stream reader calls it (out_start == out_next, one window at
         * a time, HAS_MORE_OUTPUT until DONE). */
        {
            extern int isaac_fast_tinfl_ok(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
            extern int isaac_fast_tinfl(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
            static const uint8_t tf_stored[33] = { 0x01, 0x1c, 0x00, 0xe3, 0xff, 0x53, 0x74, 0x6f, 0x72, 0x65, 0x64, 0x20, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x2c, 0x20, 0x6b, 0x65, 0x70, 0x74, 0x20, 0x61, 0x73, 0x20, 0x69, 0x74, 0x20, 0x69, 0x73, 0x2e };
            static const uint8_t tf_fixed[6] = { 0x4b, 0x4c, 0x24, 0x0e, 0x00, 0x00 };
            static const uint8_t tf_dyn[63] = { 0xed, 0xca, 0xc1, 0x0d, 0xc0, 0x20, 0x0c, 0x03, 0xc0, 0x55, 0xbc, 0x5a, 0xa0, 0x06, 0x22, 0x55, 0x29, 0x0a, 0xe9, 0xfe, 0x1d, 0xa4, 0xbe, 0xf7, 0xd5, 0x22, 0x9a, 0xc7, 0xe5, 0x31, 0xf1, 0x0c, 0xf8, 0x31, 0xeb, 0xb0, 0x51, 0xcc, 0xe6, 0x59, 0x0b, 0xfb, 0x7e, 0x0f, 0x92, 0x9b, 0x51, 0x16, 0x9d, 0x28, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0x7d, 0xfd, 0x1f, 0xff, 0x0f };
            static const uint8_t tf_ring[60] = { 0xed, 0xcc, 0xab, 0x0d, 0x00, 0x20, 0x0c, 0x40, 0xc1, 0x55, 0x3a, 0x07, 0xdb, 0x00, 0xe5, 0x67, 0x4a, 0x42, 0x48, 0xca, 0xf8, 0xec, 0x80, 0x42, 0x3c, 0x75, 0xee, 0xd6, 0xb0, 0x26, 0x3e, 0x4c, 0xa7, 0xcb, 0x2e, 0x67, 0x07, 0x89, 0x29, 0x6b, 0xa9, 0xad, 0xbf, 0x2a, 0x8b, 0x92, 0x92, 0x92, 0x92, 0x92, 0x92, 0x92, 0x92, 0x92, 0x92, 0x92, 0xf2, 0xa7, 0xf2, 0x02 };
            static const char tf_text[] = "the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance the binding of isaac afterbirth plus repentance ";
            static const char tf_ring_text[] = "ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ring window text: abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh ";
            uint32_t tr = ISAAC_STACK_TOP_VA - 0x30000u, tin = tr + 0x3000u, tout = tr + 0x4000u, tsz = tr + 0x6000u;
            int st;
            /* the stored block */
            memset(isaac_g(tr), 0xee, 0x2af0u); isaac_w32(tr, 0u);
            memcpy(isaac_g(tin), tf_stored, sizeof(tf_stored)); isaac_w32(tsz, sizeof(tf_stored)); isaac_w32(tsz + 4u, 0x1000u);
            check(isaac_fast_tinfl_ok(tr, tin, tsz, tout, tout, tsz + 4u, 4u), "tinfl: a guest decompressor, input and output are accepted");
            st = isaac_fast_tinfl(tr, tin, tsz, tout, tout, tsz + 4u, 4u);
            check(st == 0 && isaac_r32(tsz + 4u) == 28u && memcmp(isaac_g(tout), "Stored block, kept as it is.", 28) == 0 && isaac_r32(tsz) == sizeof(tf_stored),
                  "tinfl: a stored block copies through (DONE, the input consumed whole)");
            /* the fixed block */
            isaac_w32(tr, 0u);
            memcpy(isaac_g(tin), tf_fixed, sizeof(tf_fixed)); isaac_w32(tsz, sizeof(tf_fixed)); isaac_w32(tsz + 4u, 0x1000u);
            st = isaac_fast_tinfl(tr, tin, tsz, tout, tout, tsz + 4u, 4u);
            check(st == 0 && isaac_r32(tsz + 4u) == 40u && memcmp(isaac_g(tout), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 40) == 0,
                  "tinfl: a fixed-Huffman block with a run decodes (DONE)");
            /* the dynamic block, whole */
            isaac_w32(tr, 0u);
            memcpy(isaac_g(tin), tf_dyn, sizeof(tf_dyn)); isaac_w32(tsz, sizeof(tf_dyn)); isaac_w32(tsz + 4u, 0x1000u);
            st = isaac_fast_tinfl(tr, tin, tsz, tout, tout, tsz + 4u, 4u);
            check(st == 0 && isaac_r32(tsz + 4u) == sizeof(tf_text) - 1u && memcmp(isaac_g(tout), tf_text, sizeof(tf_text) - 1u) == 0 && isaac_r32(tsz) == sizeof(tf_dyn),
                  "tinfl: a dynamic-Huffman block over a 2880-byte text decodes byte for byte (DONE)");
            check(isaac_r32(tr) == 34u && isaac_r32(tr + 0x14u) == 5u, "tinfl: the decompressor rests in state 34 with the final block's header");
            /* the same, one byte of input at a time: NEEDS_MORE_INPUT until the last */
            isaac_w32(tr, 0u);
            {
                uint32_t off = 0u, produced = 0u; int ok = 1;
                memset(isaac_g(tout), 0, 0x1000u);
                while (off < sizeof(tf_dyn)) {
                    isaac_w32(tsz, 1u); isaac_w32(tsz + 4u, 0x1000u - produced);
                    st = isaac_fast_tinfl(tr, tin + off, tsz, tout, tout + produced, tsz + 4u, 4u | 2u);
                    off += isaac_r32(tsz); produced += isaac_r32(tsz + 4u);
                    if (st < 0 || st == 2) { ok = 0; break; }
                    if (off < sizeof(tf_dyn) && st != 1) { ok = 0; break; }
                }
                check(ok && st == 0 && produced == sizeof(tf_text) - 1u && memcmp(isaac_g(tout), tf_text, sizeof(tf_text) - 1u) == 0,
                      "tinfl: the same stream a byte at a time resumes at every state and ends DONE");
            }
            /* the 512-byte ring, the archive reader's way */
            isaac_w32(tr, 0u);
            {
                uint32_t off = 0u, produced = 0u, in_left = sizeof(tf_ring); int ok = 1, rounds = 0;
                uint8_t *assembled = (uint8_t *)malloc(sizeof(tf_ring_text));
                memcpy(isaac_g(tin), tf_ring, sizeof(tf_ring));
                memset(isaac_g(tout), 0, 0x200u);
                for (;;) {
                    isaac_w32(tsz, in_left); isaac_w32(tsz + 4u, 0x200u);
                    st = isaac_fast_tinfl(tr, tin + off, tsz, tout, tout, tsz + 4u, 0u);
                    off += isaac_r32(tsz); in_left -= isaac_r32(tsz);
                    if (assembled && produced + isaac_r32(tsz + 4u) <= sizeof(tf_ring_text) - 1u) memcpy(assembled + produced, isaac_g(tout), isaac_r32(tsz + 4u));
                    else ok = 0;
                    produced += isaac_r32(tsz + 4u); rounds++;
                    if (st == 0) break;
                    if (st != 2 || rounds > 64) { ok = 0; break; }
                }
                check(ok && st == 0 && produced == sizeof(tf_ring_text) - 1u && assembled && memcmp(assembled, tf_ring_text, sizeof(tf_ring_text) - 1u) == 0,
                      "tinfl: a 512-byte-window stream through a 512-byte ring (out_start == out_next) reassembles byte for byte over HAS_MORE_OUTPUT rounds");
                free(assembled);
            }
            /* the gate */
            isaac_w32(tsz + 4u, 0x300u);
            check(!isaac_fast_tinfl_ok(tr, tin, tsz, tout, tout, tsz + 4u, 0u), "tinfl: a ring that is not a power of two is left to the lifted body");
            check(!isaac_fast_tinfl_ok(tr, tin, tsz, tout + 4u, tout, tsz + 4u, 4u), "tinfl: out_next before out_start is left to the lifted body");
            isaac_w32(tsz + 4u, 0x200u);
            check(isaac_fast_tinfl_ok(tr, tin, tsz, tout, tout, tsz + 4u, 0u), "tinfl: a power-of-two ring is accepted");
        }
        /* ArchivedFile::read: window at +0x81c, pos +0xc1c, fill +0xc20, eof +0xc28, stream position +0x18 */
        uint32_t af = ISAAC_STACK_TOP_VA - 0x3d000u, dst = ISAAC_STACK_TOP_VA - 0x3c000u, take = 0xdeadu;
        memset(isaac_g(af), 0, 0xc2cu);
        for (uint32_t i = 0; i < 0x400u; i++) *(uint8_t *)isaac_g(af + 0x81cu + i) = (uint8_t)(i * 3u);
        isaac_w32(af + 0x18u, 0x1000u); isaac_w32(af + 0xc1cu, 0x100u); isaac_w32(af + 0xc20u, 0x400u);
        check(isaac_fast_read_plan(af, dst, 0x10u, &take) && take == 0x10u, "read: a request inside the window is taken whole");
        isaac_fast_read_window(af, dst, take);
        check(memcmp(isaac_g(dst), isaac_g(af + 0x81cu + 0x100u), 0x10u) == 0 && isaac_r32(af + 0xc1cu) == 0x110u && isaac_r32(af + 0x18u) == 0x1010u,
              "read: the window bytes at pos are copied; pos and the stream position advance by the byte count");
        check(!isaac_fast_read_plan(af, dst, 0x2f1u, &take), "read: one byte past the fill with no eof is a refill, left to the lifted body");
        check(isaac_fast_read_plan(af, dst, 0x2f0u, &take) && take == 0x2f0u, "read: a request that exactly drains the window needs no refill");
        *(uint8_t *)isaac_g(af + 0xc28u) = 1u;
        check(isaac_fast_read_plan(af, dst, 0x400u, &take) && take == 0x2f0u, "read: at eof a larger request is cut to what the window holds");
        isaac_w32(af + 0xc1cu, 0x500u);                      /* pos past fill: nothing available */
        check(isaac_fast_read_plan(af, dst, 4u, &take) && take == 0u, "read: pos past fill at eof serves zero bytes");
        *(uint8_t *)isaac_g(af + 0xc28u) = 0u;
        check(!isaac_fast_read_plan(af, dst, 4u, &take), "read: pos past fill without eof is a refill");
        check(isaac_fast_read_plan(af, dst, 0u, &take) && take == 0u, "read: a zero-byte request is served without a refill");
        /* the engine Mutex: {vtable, flags, cs*}, the locked byte past the 24-byte section */
        uint32_t mtx = ISAAC_STACK_TOP_VA - 0x3bf00u, vt = ISAAC_STACK_TOP_VA - 0x3be00u, cs = ISAAC_STACK_TOP_VA - 0x3bd00u;
        memset(isaac_g(cs), 0, 0x1cu);
        isaac_w32(mtx, vt); *(uint8_t *)isaac_g(mtx + 4u) = 1u; isaac_w32(mtx + 8u, cs);
        isaac_w32(vt + 0xcu, 0x00a157f0u); isaac_w32(vt + 0x10u, 0x00a159a0u);
        check(isaac_fast_mutex_init(mtx) && isaac_fast_mutex_free(mtx) && isaac_fast_mutex_std(mtx),
              "mutex: initialised, free, and the engine's own Lock/Unlock in its vtable");
        isaac_fast_mutex_take(mtx);
        check(isaac_r8(cs + 0x18u) == 1u && !isaac_fast_mutex_free(mtx) && !isaac_fast_mutex_std(mtx) && isaac_fast_mutex_init(mtx),
              "mutex: take sets the locked byte past the CRITICAL_SECTION; a held mutex is not free");
        isaac_fast_mutex_drop(mtx);
        check(isaac_r8(cs + 0x18u) == 0u && isaac_fast_mutex_free(mtx), "mutex: drop clears the byte");
        isaac_w32(vt + 0x10u, 0x00a15730u);
        check(isaac_fast_mutex_free(mtx) && !isaac_fast_mutex_std(mtx), "mutex: another Unlock in the vtable is not the standard pair");
        isaac_w32(vt + 0x10u, 0x00a159a0u);
        *(uint8_t *)isaac_g(mtx + 4u) = 0u;
        check(!isaac_fast_mutex_init(mtx) && !isaac_fast_mutex_free(mtx) && !isaac_fast_mutex_std(mtx),
              "mutex: flag bit 0 clear (not initialised) is left to the lifted body");
        *(uint8_t *)isaac_g(mtx + 4u) = 1u; isaac_w32(mtx + 8u, 0u);
        check(!isaac_fast_mutex_init(mtx), "mutex: a NULL section pointer is refused");
    }

    /* Input (round 14a): scripted events become Win32 messages for GLFW's
     * pump, with the lParam layout its WndProc decodes. */
    {
        extern void isaac_input_key(uint32_t vk, uint32_t scancode, int extended, int down);
        extern void isaac_input_mouse_move(int32_t x, int32_t y);
        extern void isaac_input_mouse_button(int button, int down);
        extern uint32_t isaac_input_queued(void);
        uint32_t msgbuf = ISAAC_STACK_TOP_VA - 0x3800;
        #define PEEK() do { memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000; \
            isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf); \
            isaac_w32(cpu.ESP + 8, 0); isaac_w32(cpu.ESP + 12, 0); isaac_w32(cpu.ESP + 16, 0); \
            isaac_w32(cpu.ESP + 20, 1); imp_user32__PeekMessageW(&cpu); } while (0)
        PEEK();
        check(cpu.EAX == 0, "an empty queue peeks as no message");
        isaac_input_key(0x0D, 0x1C, 0, 1);           /* Enter down */
        isaac_input_key(0x28, 0x50, 1, 1);           /* Down arrow (extended) down */
        isaac_input_key(0x0D, 0x1C, 0, 0);           /* Enter up */
        check(isaac_input_queued() == 3, "three events queue three messages");
        PEEK();
        check(cpu.EAX == 1 && isaac_r32(msgbuf + 4) == 0x100 && isaac_r32(msgbuf + 8) == 0x0D &&
              isaac_r32(msgbuf + 12) == ((0x1Cu << 16) | 1u),
              "first message: WM_KEYDOWN Enter, lParam = scancode 0x1C << 16 | repeat 1");
        PEEK();
        check(cpu.EAX == 1 && isaac_r32(msgbuf + 4) == 0x100 && isaac_r32(msgbuf + 8) == 0x28 &&
              isaac_r32(msgbuf + 12) == ((0x50u << 16) | (1u << 24) | 1u),
              "second message: WM_KEYDOWN Down with the extended bit (24) set");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0x28);
        imp_user32__GetKeyState(&cpu);
        check((cpu.EAX & 0x8000u) != 0, "GetKeyState reports Down as held while its key-up is not yet queued");
        PEEK();
        check(cpu.EAX == 1 && isaac_r32(msgbuf + 4) == 0x101 &&
              (isaac_r32(msgbuf + 12) & ((1u << 30) | (1u << 31))) == ((1u << 30) | (1u << 31)),
              "third message: WM_KEYUP Enter with the previous-state and transition bits");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0x0D);
        imp_user32__GetKeyState(&cpu);
        check((cpu.EAX & 0x8000u) == 0, "GetKeyState reports Enter released after its key-up");
        PEEK();
        check(cpu.EAX == 0, "the queue is empty again (messages are delivered once, in order)");
        isaac_input_mouse_move(480, 270);
        isaac_input_mouse_button(0, 1);
        PEEK();
        check(cpu.EAX == 1 && isaac_r32(msgbuf + 4) == 0x200 && isaac_r32(msgbuf + 12) == ((270u << 16) | 480u),
              "mouse move: WM_MOUSEMOVE with y << 16 | x");
        PEEK();
        check(cpu.EAX == 1 && isaac_r32(msgbuf + 4) == 0x201 && isaac_r32(msgbuf + 8) == 1u,
              "left button: WM_LBUTTONDOWN with MK_LBUTTON");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf);
        imp_user32__GetCursorPos(&cpu);
        check(isaac_r32(msgbuf) == 480 && isaac_r32(msgbuf + 4) == 270, "GetCursorPos follows the last mouse move");
        isaac_input_mouse_button(0, 0);
        PEEK();
        #undef PEEK
        /* the queue targets GLFW's main window, never the helper or the
         * DirectInput "Message" window that is created last */
        {
            uint32_t wcx = msgbuf + 0x100, cname = msgbuf + 0x200;
            uint32_t hwnds[3] = {0, 0, 0};
            const char *classes[3] = {"GLFW3 Helper", "GLFW30", "Message"};
            for (int k = 0; k < 3; ++k) {
                for (unsigned i = 0; ; ++i) { isaac_w16(cname + 2 * i, (uint16_t)classes[k][i]); if (!classes[k][i]) break; }
                for (unsigned i = 0; i < 0x30; i += 4) isaac_w32(wcx + i, 0);
                isaac_w32(wcx + 0, 0x30);                 /* cbSize */
                isaac_w32(wcx + 8, 0x00500000u + k);      /* lpfnWndProc (fake) */
                isaac_w32(wcx + 0x28, cname);             /* lpszClassName */
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, wcx);
                imp_user32__RegisterClassExW(&cpu);
                uint32_t atom = cpu.EAX;
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, 0);                /* exstyle */
                isaac_w32(cpu.ESP + 8, atom);             /* class atom */
                isaac_w32(cpu.ESP + 12, cname);           /* title (reuse) */
                isaac_w32(cpu.ESP + 16, 0);               /* style */
                isaac_w32(cpu.ESP + 20, 0); isaac_w32(cpu.ESP + 24, 0);
                /* the Message window is the biggest (the real one is created with
                 * CW_USEDEFAULT and lands on the 1280x720 display size) */
                isaac_w32(cpu.ESP + 28, k == 1 ? 960 : k == 2 ? 1280 : 1); isaac_w32(cpu.ESP + 32, k == 1 ? 540 : k == 2 ? 720 : 1);
                imp_user32__CreateWindowExW(&cpu);
                hwnds[k] = cpu.EAX;
            }
            check(hwnds[0] && hwnds[1] && hwnds[2] && hwnds[2] > hwnds[1], "three windows created, the Message window last");
            isaac_input_key(0x1B, 0x01, 0, 1);
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf);
            isaac_w32(cpu.ESP + 8, 0); isaac_w32(cpu.ESP + 12, 0); isaac_w32(cpu.ESP + 16, 0); isaac_w32(cpu.ESP + 20, 1);
            imp_user32__PeekMessageW(&cpu);
            /* the first pump also queues the focus messages ahead of the key */
            uint32_t first_hwnd = isaac_r32(msgbuf), first_msg = isaac_r32(msgbuf + 4);
            check(cpu.EAX == 1 && first_hwnd == hwnds[1] && (first_msg == 0x1C || first_msg == 0x100),
                  "messages are addressed to the GLFW30 window, not the last-created Message window");
            for (int n = 0; n < 8 && cpu.EAX; ++n) {
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf);
                isaac_w32(cpu.ESP + 8, 0); isaac_w32(cpu.ESP + 12, 0); isaac_w32(cpu.ESP + 16, 0); isaac_w32(cpu.ESP + 20, 1);
                imp_user32__PeekMessageW(&cpu);
            }
            isaac_input_key(0x1B, 0x01, 0, 0);
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf);
            isaac_w32(cpu.ESP + 8, 0); isaac_w32(cpu.ESP + 12, 0); isaac_w32(cpu.ESP + 16, 0); isaac_w32(cpu.ESP + 20, 1);
            imp_user32__PeekMessageW(&cpu);
        }
        /* window properties: GLFW's WndProc finds its window via GetPropW */
        uint32_t wname = msgbuf + 0x40;
        const char *nm = "GLFW";
        for (unsigned i = 0; ; ++i) { isaac_w16(wname + 2 * i, (uint16_t)nm[i]); if (!nm[i]) break; }
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0x20007); isaac_w32(cpu.ESP + 8, wname);
        isaac_w32(cpu.ESP + 12, 0x0BADF00D);
        imp_user32__SetPropW(&cpu);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0x20007); isaac_w32(cpu.ESP + 8, wname);
        imp_user32__GetPropW(&cpu);
        check(cpu.EAX == 0x0BADF00D, "GetPropW returns what SetPropW stored for that window and name");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0x20008); isaac_w32(cpu.ESP + 8, wname);
        imp_user32__GetPropW(&cpu);
        check(cpu.EAX == 0, "a different window has no such property");
    }

    /* Round 32: TranslateMessage synthesises the WM_CHAR Windows would post
     * for the WM_KEYDOWN of a printable key -- ahead of everything queued,
     * to the key-down's window, wParam the character, lParam the key-down's
     * -- under the synchronous modifier state (the key messages removed so
     * far), on the US layout; a non-printable key adds nothing. */
    {
        extern void isaac_input_key(uint32_t vk, uint32_t scancode, int extended, int down);
        extern void isaac_input_mouse_move(int32_t x, int32_t y);
        extern uint32_t isaac_input_queued(void);
        extern uint32_t isaac_input_chars_posted(void);
        uint32_t msgbuf = ISAAC_STACK_TOP_VA - 0x3800;
        #define NOCH 0xFFFFu
        #define PEEK() do { memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000; \
            isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf); \
            isaac_w32(cpu.ESP + 8, 0); isaac_w32(cpu.ESP + 12, 0); isaac_w32(cpu.ESP + 16, 0); \
            isaac_w32(cpu.ESP + 20, 1); imp_user32__PeekMessageW(&cpu); } while (0)
        #define XLATE() do { memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000; \
            isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, msgbuf); imp_user32__TranslateMessage(&cpu); } while (0)
        #define KEYSTATE(v) do { memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000; \
            isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, (v)); imp_user32__GetKeyState(&cpu); } while (0)
        #define MSG_ID() isaac_r32(msgbuf + 4)
        #define MSG_W()  isaac_r32(msgbuf + 8)
        #define MSG_L()  isaac_r32(msgbuf + 12)
        for (int n = 0; n < 16; ++n) { PEEK(); if (!cpu.EAX) break; }      /* whatever the block above left */
        uint32_t chars0 = isaac_input_chars_posted();
        /* 'a': the WM_KEYDOWN, then the WM_CHAR ahead of the already queued key-up */
        isaac_input_key(0x41, 0x1E, 0, 1);
        isaac_input_key(0x41, 0x1E, 0, 0);
        PEEK();
        uint32_t kd_hwnd = isaac_r32(msgbuf), kd_lp = MSG_L();
        check(cpu.EAX == 1 && MSG_ID() == 0x100 && MSG_W() == 0x41 && kd_lp == ((0x1Eu << 16) | 1u),
              "WM_KEYDOWN A comes out first, lParam = scancode 0x1E << 16 | repeat 1");
        XLATE();
        check(cpu.EAX == 1 && isaac_input_queued() == 2 && isaac_input_chars_posted() == chars0 + 1,
              "TranslateMessage(WM_KEYDOWN A) returns nonzero and posts one message");
        PEEK();
        check(cpu.EAX == 1 && MSG_ID() == 0x102 && MSG_W() == 'a' && MSG_L() == kd_lp && isaac_r32(msgbuf) == kd_hwnd,
              "the next message is WM_CHAR 'a' with the key-down's lParam, to the key-down's window, ahead of the queued key-up");
        XLATE();
        check(cpu.EAX == 0 && isaac_input_queued() == 1, "TranslateMessage(WM_CHAR) returns 0 and posts nothing");
        PEEK();
        check(cpu.EAX == 1 && MSG_ID() == 0x101 && MSG_W() == 0x41, "then the WM_KEYUP");
        XLATE();
        check(cpu.EAX == 1 && isaac_input_queued() == 0, "TranslateMessage(WM_KEYUP) returns nonzero (a key message) and posts nothing");
        PEEK();
        check(cpu.EAX == 0, "the queue is empty after a");
        /* Shift+a queued as one batch: the physical Shift is already up when
         * the A key-down is translated; the synchronous state (Shift's
         * key-down removed, its key-up not yet) says Shift, so 'A' */
        isaac_input_key(0x10, 0x2A, 0, 1);
        isaac_input_key(0x41, 0x1E, 0, 1);
        isaac_input_key(0x41, 0x1E, 0, 0);
        isaac_input_key(0x10, 0x2A, 0, 0);
        KEYSTATE(0x10);
        check((cpu.EAX & 0x8000u) == 0, "GetKeyState(VK_SHIFT) is up while Shift's key-down is still queued (synchronous state)");
        PEEK(); XLATE();
        check(cpu.EAX == 1 && MSG_ID() == 0x100 && MSG_W() == 0x10 && isaac_input_queued() == 3, "Shift's key-down translates to nothing");
        KEYSTATE(0x10);
        check((cpu.EAX & 0x8000u) != 0, "GetKeyState(VK_SHIFT) is down once its key-down is removed");
        KEYSTATE(0xA0);
        check((cpu.EAX & 0x8000u) != 0, "GetKeyState(VK_LSHIFT) follows the VK_SHIFT message with the left scancode 0x2A");
        KEYSTATE(0xA1);
        check((cpu.EAX & 0x8000u) == 0, "GetKeyState(VK_RSHIFT) does not");
        PEEK(); XLATE(); PEEK();
        check(cpu.EAX == 1 && MSG_ID() == 0x102 && MSG_W() == 'A', "Shift + a posts WM_CHAR 'A'");
        PEEK(); XLATE(); PEEK(); XLATE(); PEEK();
        check(cpu.EAX == 0, "the batch drained: the key-up, Shift's key-up, then nothing");
        KEYSTATE(0xA0);
        check((cpu.EAX & 0x8000u) == 0, "VK_LSHIFT released by the VK_SHIFT key-up");
        /* CapsLock: a toggle, flipped by a fresh key-down, not by a repeat */
        isaac_input_key(0x14, 0x3A, 0, 1); isaac_input_key(0x14, 0x3A, 0, 0);
        PEEK(); XLATE(); PEEK(); XLATE(); PEEK();
        KEYSTATE(0x14);
        check((cpu.EAX & 1u) == 1u && isaac_input_chars_posted() == chars0 + 2, "CapsLock's key-down sets GetKeyState bit 0 and posts no character");
        isaac_input_key(0x42, 0x30, 0, 1); isaac_input_key(0x42, 0x30, 0, 0);
        PEEK(); XLATE(); PEEK();
        check(cpu.EAX == 1 && MSG_ID() == 0x102 && MSG_W() == 'B', "CapsLock: b posts 'B'");
        PEEK(); XLATE(); PEEK();
        isaac_input_key(0x10, 0x2A, 0, 1); isaac_input_key(0x42, 0x30, 0, 1); isaac_input_key(0x42, 0x30, 0, 0); isaac_input_key(0x10, 0x2A, 0, 0);
        PEEK(); XLATE(); PEEK(); XLATE(); PEEK();
        check(cpu.EAX == 1 && MSG_ID() == 0x102 && MSG_W() == 'b', "CapsLock + Shift: b posts 'b' (the case swaps back)");
        PEEK(); XLATE(); PEEK(); XLATE(); PEEK();
        isaac_input_key(0x32, 0x03, 0, 1); isaac_input_key(0x32, 0x03, 0, 0);
        PEEK(); XLATE(); PEEK();
        check(cpu.EAX == 1 && MSG_ID() == 0x102 && MSG_W() == '2', "CapsLock leaves '2' alone");
        PEEK(); XLATE(); PEEK();
        isaac_input_key(0x14, 0x3A, 0, 1); isaac_input_key(0x14, 0x3A, 0, 1); isaac_input_key(0x14, 0x3A, 0, 0);
        PEEK(); XLATE(); PEEK(); XLATE(); PEEK(); XLATE(); PEEK();
        KEYSTATE(0x14);
        check((cpu.EAX & 1u) == 0u, "the next fresh CapsLock key-down toggles it off; the repeat (bit 30) did not toggle it back");
        /* the rest of the map, one key at a time: modifiers down, the key
         * down and up, modifiers up; a WM_CHAR must follow its key-down at once */
        struct { uint32_t vk, sc, ext, shift, ctrl, want; const char *what; } cases[] = {
            { 0xC0, 0x29, 0, 0, 0, '`',  "grave posts '`'" },
            { 0xC0, 0x29, 0, 1, 0, '~',  "Shift+grave posts '~'" },
            { 0x0D, 0x1C, 0, 0, 0, '\r', "Enter posts CR" },
            { 0x08, 0x0E, 0, 0, 0, '\b', "Backspace posts BS" },
            { 0x09, 0x0F, 0, 0, 0, '\t', "Tab posts TAB" },
            { 0x1B, 0x01, 0, 0, 0, 0x1B, "Escape posts 0x1b" },
            { 0x20, 0x39, 0, 0, 0, ' ',  "space posts ' '" },
            { 0x39, 0x0A, 0, 0, 0, '9',  "9 posts '9'" },
            { 0x32, 0x03, 0, 1, 0, '@',  "Shift+2 posts '@'" },
            { 0x30, 0x0B, 0, 1, 0, ')',  "Shift+0 posts ')'" },
            { 0xBE, 0x34, 0, 0, 0, '.',  "period posts '.'" },
            { 0xBE, 0x34, 0, 1, 0, '>',  "Shift+period posts '>'" },
            { 0xBD, 0x0C, 0, 0, 0, '-',  "minus posts '-'" },
            { 0xBD, 0x0C, 0, 1, 0, '_',  "Shift+minus posts '_'" },
            { 0xBB, 0x0D, 0, 1, 0, '+',  "Shift+equals posts '+'" },
            { 0xDB, 0x1A, 0, 1, 0, '{',  "Shift+lbracket posts '{'" },
            { 0xDD, 0x1B, 0, 0, 0, ']',  "rbracket posts ']'" },
            { 0xDE, 0x28, 0, 0, 0, '\'', "quote posts the apostrophe" },
            { 0xDE, 0x28, 0, 1, 0, '"',  "Shift+quote posts the double quote" },
            { 0xBA, 0x27, 0, 1, 0, ':',  "Shift+semicolon posts ':'" },
            { 0xBC, 0x33, 0, 0, 0, ',',  "comma posts ','" },
            { 0xBF, 0x35, 0, 1, 0, '?',  "Shift+slash posts '?'" },
            { 0xDC, 0x2B, 0, 0, 0, '\\', "backslash posts the backslash" },
            { 0xDC, 0x2B, 0, 1, 0, '|',  "Shift+backslash posts '|'" },
            { 0x43, 0x2E, 0, 0, 1, 0x03, "Ctrl+c posts 0x03" },
            { 0x5A, 0x2C, 0, 1, 1, 0x1A, "Ctrl+Shift+z posts 0x1a too" },
            { 0x0D, 0x1C, 0, 0, 1, '\n', "Ctrl+Enter posts LF" },
            { 0xDB, 0x1A, 0, 0, 1, 0x1B, "Ctrl+lbracket posts 0x1b" },
            { 0x32, 0x03, 0, 1, 1, NOCH, "Ctrl+Shift+2 posts nothing (no Shift+Ctrl column)" },
            { 0x70, 0x3B, 0, 0, 0, NOCH, "F1 posts nothing" },
            { 0x26, 0x48, 1, 0, 0, NOCH, "Up posts nothing" },
            { 0x25, 0x4B, 1, 1, 0, NOCH, "Shift+Left posts nothing" },
            { 0x10, 0x2A, 0, 0, 0, NOCH, "Shift itself posts nothing" },
            { 0x2E, 0x53, 1, 0, 0, NOCH, "Delete posts nothing" },
        };
        for (size_t ci = 0; ci < sizeof cases / sizeof cases[0]; ++ci) {
            uint32_t got = NOCH, nchars = 0, prev_msg = 0, prev_w = 0, ordered = 1;
            if (cases[ci].shift) isaac_input_key(0x10, 0x2A, 0, 1);
            if (cases[ci].ctrl) isaac_input_key(0x11, 0x1D, 0, 1);
            isaac_input_key(cases[ci].vk, cases[ci].sc, (int)cases[ci].ext, 1);
            isaac_input_key(cases[ci].vk, cases[ci].sc, (int)cases[ci].ext, 0);
            if (cases[ci].ctrl) isaac_input_key(0x11, 0x1D, 0, 0);
            if (cases[ci].shift) isaac_input_key(0x10, 0x2A, 0, 0);
            for (int n = 0; n < 16; ++n) {
                PEEK();
                if (!cpu.EAX) break;
                if (MSG_ID() == 0x102u) {
                    ++nchars; got = MSG_W();
                    if (!(prev_msg == 0x100u && prev_w == cases[ci].vk)) ordered = 0;
                }
                prev_msg = MSG_ID(); prev_w = MSG_W();
                XLATE();
            }
            check(cases[ci].want == NOCH ? nchars == 0 : (nchars == 1 && got == cases[ci].want && ordered), cases[ci].what);
        }
        isaac_input_mouse_move(10, 10);
        PEEK(); XLATE();
        check(cpu.EAX == 0 && isaac_input_queued() == 0, "TranslateMessage(WM_MOUSEMOVE) returns 0 and posts nothing");
        #undef MSG_L
        #undef MSG_W
        #undef MSG_ID
        #undef KEYSTATE
        #undef XLATE
        #undef PEEK
        #undef NOCH
    }

    /* x87 register-convention CRT helpers (round 14e): first argument in
     * ST(1), second in ST(0), result in ST(0) with the stack popped once. */
    {
        memset(&cpu, 0, sizeof cpu);
        double x = 7.5, y = 2.0, deeper = 42.0;
        memcpy(cpu.ST1, &x, 8); memcpy(cpu.ST0, &y, 8); memcpy(cpu.ST2, &deeper, 8);
        imp_api_ms_win_crt_math___CIfmod(&cpu);
        double r0, r1;
        memcpy(&r0, cpu.ST0, 8); memcpy(&r1, cpu.ST1, 8);
        check(r0 == 1.5, "_CIfmod: fmod(ST1, ST0) = fmod(7.5, 2) = 1.5 in ST0");
        check(r1 == 42.0, "_CIfmod pops the x87 stack once (old ST2 becomes ST1)");
        memset(&cpu, 0, sizeof cpu);
        double yy = 1.0, xx = -1.0;
        memcpy(cpu.ST1, &yy, 8); memcpy(cpu.ST0, &xx, 8);
        imp_api_ms_win_crt_math___CIatan2(&cpu);
        memcpy(&r0, cpu.ST0, 8);
        check(r0 > 2.356 && r0 < 2.357, "_CIatan2: atan2(ST1, ST0) = atan2(1, -1) = 3pi/4");
    }

    /* Gap shims (round 14f): imports the table promised with only a weak
     * trap body, found by the link-level audit (audit_shims.py). */
    {
        uint32_t sb = ISAAC_STACK_TOP_VA - 0x3c00;
        /* strerror returns a guest-readable string */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 2);
        imp_api_ms_win_crt_runtime__strerror(&cpu);
        check(cpu.EAX && isaac_is_guest_va(cpu.EAX) && *(const char *)isaac_g(cpu.EAX) != 0,
              "strerror(2) hands back a non-empty guest string");
        /* __stdio_common_vsnprintf_s formats with the count limit */
        uint32_t fmt = sb, ap = sb + 0x40, out = sb + 0x80;
        const char *f = "%d-%s";
        for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(fmt + i) = (uint8_t)f[i]; if (!f[i]) break; }
        const char *arg = "abc";
        for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(sb + 0x60 + i) = (uint8_t)arg[i]; if (!arg[i]) break; }
        isaac_w32(ap, 42); isaac_w32(ap + 4, sb + 0x60);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0); isaac_w32(cpu.ESP + 8, 0);     /* options (int64) */
        isaac_w32(cpu.ESP + 12, out); isaac_w32(cpu.ESP + 16, 64); /* buf, n */
        isaac_w32(cpu.ESP + 20, 0xFFFFFFFFu);                      /* count = _TRUNCATE */
        isaac_w32(cpu.ESP + 24, fmt); isaac_w32(cpu.ESP + 28, 0); isaac_w32(cpu.ESP + 32, ap);
        imp_api_ms_win_crt_stdio____stdio_common_vsnprintf_s(&cpu);
        check(cpu.EAX == 6 && memcmp(isaac_g(out), "42-abc", 7) == 0, "__stdio_common_vsnprintf_s formats into the guest buffer");
        /* GetStartupInfoW fills cb and zeroes the rest */
        isaac_w32(sb + 0x100, 0x11111111u); isaac_w32(sb + 0x100 + 64, 0x22222222u);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sb + 0x100);
        imp_kernel32__GetStartupInfoW(&cpu);
        check(isaac_r32(sb + 0x100) == 68 && isaac_r32(sb + 0x100 + 64) == 0, "GetStartupInfoW writes cb=68 and zeroes the struct");
        /* _access on a seeded file and a missing one */
        extern int isaac_fs_seed(const char *path, const uint8_t *data, uint32_t len);
        static const uint8_t one[1] = {7};
        check(isaac_fs_seed("data/access_probe.txt", one, 1) == 1, "seed a file for _access");
        const char *ap1 = "data/access_probe.txt", *ap2 = "data/no_such_file.txt";
        for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(sb + 0x200 + i) = (uint8_t)ap1[i]; if (!ap1[i]) break; }
        for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(sb + 0x240 + i) = (uint8_t)ap2[i]; if (!ap2[i]) break; }
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sb + 0x200); isaac_w32(cpu.ESP + 8, 0);
        imp_api_ms_win_crt_filesystem___access(&cpu);
        int present = (cpu.EAX == 0);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sb + 0x240); isaac_w32(cpu.ESP + 8, 0);
        imp_api_ms_win_crt_filesystem___access(&cpu);
        check(present && cpu.EAX == 0xFFFFFFFFu, "_access: 0 for a RAM-FS file, -1 for a missing one");
        /* __std_exception_copy duplicates the message into guest memory; destroy frees it */
        const char *msg = "boom";
        for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(sb + 0x300 + i) = (uint8_t)msg[i]; if (!msg[i]) break; }
        isaac_w32(sb + 0x310, sb + 0x300); *(uint8_t *)isaac_g(sb + 0x314) = 0;   /* from: {what, doFree=0} */
        isaac_w32(sb + 0x320, 0); *(uint8_t *)isaac_g(sb + 0x324) = 0;             /* to */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sb + 0x310); isaac_w32(cpu.ESP + 8, sb + 0x320);
        imp_vcruntime140____std_exception_copy(&cpu);
        uint32_t copy = isaac_r32(sb + 0x320);
        check(copy && copy != sb + 0x300 && strcmp((const char *)isaac_g(copy), "boom") == 0 && *(uint8_t *)isaac_g(sb + 0x324) == 1,
              "__std_exception_copy duplicates the message into a fresh guest buffer with doFree set");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sb + 0x320);
        imp_vcruntime140____std_exception_destroy(&cpu);
        check(isaac_r32(sb + 0x320) == 0 && *(uint8_t *)isaac_g(sb + 0x324) == 0, "__std_exception_destroy clears the copy");
    }

    /* Adopted threads (boot round 12): _beginthreadex through the engine's
     * trampoline 0x00a7f130 must leave the thread struct's done flag set, or
     * ~Thread() calls std::terminate() at shutdown. Round 24 runs adopted
     * jobs as per-frame slices and sets the flag when the loop returns (or
     * at the join, isaac_threads_join); the at-adoption contract tested here
     * is the slices-off one, so slices are switched off for this process. */
    {
        uint32_t block = ISAAC_STACK_TOP_VA - 0x3600, tobj = ISAAC_STACK_TOP_VA - 0x3700;
        setenv("ISAAC_THREADS", "0", 1);
        isaac_w32(block + 0, 0x00a5a760u); isaac_w32(block + 4, 0); isaac_w32(block + 8, tobj);
        *(uint8_t *)isaac_g(tobj + 0x20) = 0;
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0); isaac_w32(cpu.ESP + 8, 0);
        isaac_w32(cpu.ESP + 12, 0x00a7f130u); isaac_w32(cpu.ESP + 16, block);
        isaac_w32(cpu.ESP + 20, 0); isaac_w32(cpu.ESP + 24, 0);
        imp_api_ms_win_crt_runtime___beginthreadex(&cpu);
        check(cpu.EAX != 0, "_beginthreadex hands out a handle");
        check(*(uint8_t *)isaac_g(tobj + 0x20) == 1,
              "an adopted (never-run) thread is marked done so ~Thread does not terminate()");
    }

    /* Frame cap (boot round 12): after ISAAC_MAX_FRAMES presented frames,
     * PeekMessageW hands GLFW's pump one WM_QUIT. The selftest runs with the
     * cap unset, so the pump must stay silent however many frames pass. */
    {
        uint32_t msgbuf = ISAAC_STACK_TOP_VA - 0x2300;
        for (int f = 0; f < 3; ++f) {
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, 0x10001);            /* HDC */
            imp_gdi32__SwapBuffers(&cpu);
        }
        check(isaac_frames_presented() == 3, "SwapBuffers counts presented frames");
        isaac_w32(msgbuf + 4, 0xFFFFFFFF);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, msgbuf); isaac_w32(cpu.ESP + 8, 0);
        isaac_w32(cpu.ESP + 12, 0); isaac_w32(cpu.ESP + 16, 0); isaac_w32(cpu.ESP + 20, 1);
        imp_user32__PeekMessageW(&cpu);
        check(cpu.EAX == 0 && isaac_r32(msgbuf + 4) == 0xFFFFFFFF,
              "PeekMessageW stays silent while no frame cap is set");
    }

    /* GL renderbuffer book-keeping (boot round 12): the game re-validates a
     * render target every frame by reading back GL_RENDERBUFFER_WIDTH/HEIGHT
     * of the bound renderbuffer; a 0 answer re-creates the target each frame. */
    {
        uint32_t ids = ISAAC_STACK_TOP_VA - 0x2100, out = ISAAC_STACK_TOP_VA - 0x2200;
        isaac_w32(ids, 0);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 1); isaac_w32(cpu.ESP + 8, ids);
        imp_opengl32__glGenRenderbuffers(&cpu);
        uint32_t rb = isaac_r32(ids);
        check(rb != 0, "glGenRenderbuffers hands out a name");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0x8D41); isaac_w32(cpu.ESP + 8, rb);
        imp_opengl32__glBindRenderbuffer(&cpu);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0x8D41); isaac_w32(cpu.ESP + 8, 0x8058 /* GL_RGBA8 */);
        isaac_w32(cpu.ESP + 12, 1024); isaac_w32(cpu.ESP + 16, 768);
        imp_opengl32__glRenderbufferStorage(&cpu);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0x8D41); isaac_w32(cpu.ESP + 8, 0x8D42 /* WIDTH */);
        isaac_w32(cpu.ESP + 12, out); isaac_w32(out, 0xFFFFFFFF);
        imp_opengl32__glGetRenderbufferParameteriv(&cpu);
        check(isaac_r32(out) == 1024, "GL_RENDERBUFFER_WIDTH reads back the stored width");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0x8D41); isaac_w32(cpu.ESP + 8, 0x8D43 /* HEIGHT */);
        isaac_w32(cpu.ESP + 12, out); isaac_w32(out, 0xFFFFFFFF);
        imp_opengl32__glGetRenderbufferParameteriv(&cpu);
        check(isaac_r32(out) == 768, "GL_RENDERBUFFER_HEIGHT reads back the stored height");
        /* delete forgets: the query on a dead name answers 0 */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 1); isaac_w32(cpu.ESP + 8, ids);
        imp_opengl32__glDeleteRenderbuffers(&cpu);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0x8D41); isaac_w32(cpu.ESP + 8, 0x8D42);
        isaac_w32(cpu.ESP + 12, out); isaac_w32(out, 0xFFFFFFFF);
        imp_opengl32__glGetRenderbufferParameteriv(&cpu);
        check(isaac_r32(out) == 0, "a deleted renderbuffer no longer reports a size");
    }

    /* The OpenAL model (host_audio.c, round 36): the streaming rules the music
     * path relies on, on the settable clock above, with the backend hooks
     * counted here so the contract the web backend is written against is
     * pinned: every queued buffer reaches the backend, a play says whether
     * the source streams and from which entry. 4000 bytes of stereo16 at
     * 1000 Hz is exactly one second per buffer. */
    {
        extern void isaac_audio_gen_sources(uint32_t n, uint32_t out_va);
        extern void isaac_audio_gen_buffers(uint32_t n, uint32_t out_va);
        extern void isaac_audio_buffer_data(uint32_t buf, uint32_t format, uint32_t data_va,
                                            uint32_t bytes, uint32_t freq);
        extern void isaac_audio_source_i(uint32_t src, uint32_t param, int32_t value);
        extern int32_t isaac_audio_get_source_i(uint32_t src, uint32_t param);
        extern void isaac_audio_play(uint32_t src);
        extern void isaac_audio_stop(uint32_t src);
        extern void isaac_audio_pause(uint32_t src);
        extern void isaac_audio_queue(uint32_t src, uint32_t n, uint32_t bufs_va);
        extern uint32_t isaac_audio_unqueue(uint32_t src, uint32_t n, uint32_t out_va);
        extern uint32_t isaac_guest_alloc(uint32_t n);
        enum { STATE = 0x1010, PLAYING = 0x1012, PAUSED = 0x1013, STOPPED = 0x1014,
               QUEUED = 0x1015, PROCESSED = 0x1016, BUFFER = 0x1009, LOOPING = 0x1007,
               SRC_TYPE = 0x1027, UNDETERMINED = 0x1030, STEREO16 = 0x1103 };
        uint32_t ids = isaac_guest_alloc(64), out = isaac_guest_alloc(64), pcm = isaac_guest_alloc(4000);
        uint32_t src, b[4];
        unsigned k;
        memset(isaac_g(pcm), 0x40, 4000);
        isaac_audio_gen_sources(1, ids); src = isaac_r32(ids);
        isaac_audio_gen_buffers(4, ids);
        for (k = 0; k < 4; ++k) b[k] = isaac_r32(ids + 4u * k);
        for (k = 0; k < 3; ++k) isaac_audio_buffer_data(b[k], STEREO16, pcm, 4000, 1000);
        g_audio_ms = 1000.0;
        isaac_audio_play(src);
        check(isaac_audio_get_source_i(src, STATE) == STOPPED && g_be_plays == 0,
              "audio: a play with nothing queued stops at once and never reaches the backend");
        for (k = 0; k < 3; ++k) isaac_w32(ids + 4u * k, b[k]);
        isaac_audio_queue(src, 3, ids);
        check(g_be_queued == 3 && isaac_audio_get_source_i(src, QUEUED) == 3 &&
              isaac_audio_get_source_i(src, STATE) == STOPPED,
              "audio: queueing hands each buffer to the backend and does not start the source");
        isaac_audio_play(src);
        check(isaac_audio_get_source_i(src, STATE) == PLAYING && g_be_plays == 1 && g_be_stream == 1 &&
              g_be_head == 0 && isaac_audio_get_source_i(src, PROCESSED) == 0,
              "audio: the play reaches the backend as a stream from entry 0");
        g_audio_ms = 2500.0;
        check(isaac_audio_get_source_i(src, PROCESSED) == 1 && isaac_audio_get_source_i(src, QUEUED) == 3,
              "audio: a chunk retires when its second has elapsed; AL_BUFFERS_QUEUED still counts the whole queue");
        check(isaac_audio_unqueue(src, 2, out) == 0 && isaac_audio_get_source_i(src, QUEUED) == 3 &&
              isaac_audio_get_source_i(src, PROCESSED) == 1 && g_be_unqueued == 0,
              "audio: an unqueue asking past the processed count takes nothing");
        check(isaac_audio_unqueue(src, 1, out) == 1 && isaac_r32(out) == b[0] &&
              isaac_audio_get_source_i(src, QUEUED) == 2 && isaac_audio_get_source_i(src, PROCESSED) == 0 &&
              g_be_unqueued == 1,
              "audio: the unqueue returns the oldest buffer and tells the backend");
        isaac_w32(ids, b[0]);
        isaac_audio_queue(src, 1, ids);                       /* the refill, as the game does it */
        g_audio_ms = 4100.0;
        check(isaac_audio_get_source_i(src, PROCESSED) == 2 && isaac_audio_get_source_i(src, STATE) == PLAYING,
              "audio: the re-queued chunk plays at the chain's end (two retired at 4.1 s, still playing)");
        g_audio_ms = 5100.0;
        check(isaac_audio_get_source_i(src, STATE) == STOPPED && isaac_audio_get_source_i(src, PROCESSED) == 3,
              "audio: a drained queue stops the source with everything processed");
        isaac_audio_play(src);
        check(isaac_audio_get_source_i(src, STATE) == PLAYING && isaac_audio_get_source_i(src, PROCESSED) == 0 &&
              g_be_head == 0 && g_be_stream == 1,
              "audio: a play from stopped restarts at the head of the queue");
        isaac_audio_stop(src);
        check(isaac_audio_get_source_i(src, STATE) == STOPPED && isaac_audio_get_source_i(src, PROCESSED) == 3 &&
              g_be_stops == 1,
              "audio: a stop marks every queued buffer processed");
        check(isaac_audio_unqueue(src, 3, out) == 3 && isaac_audio_get_source_i(src, QUEUED) == 0,
              "audio: so the game can unqueue the whole queue after a stop");
        isaac_w32(ids, b[0]);
        isaac_audio_queue(src, 1, ids);
        g_audio_ms = 6000.0;
        isaac_audio_play(src);
        isaac_audio_source_i(src, BUFFER, 0);
        check(isaac_audio_get_source_i(src, QUEUED) == 1 && isaac_audio_get_source_i(src, STATE) == PLAYING,
              "audio: AL_BUFFER 0 is refused on a playing source");
        isaac_audio_stop(src);
        isaac_audio_source_i(src, BUFFER, 0);
        check(isaac_audio_get_source_i(src, QUEUED) == 0 && isaac_audio_get_source_i(src, SRC_TYPE) == UNDETERMINED &&
              g_be_clears == 1,
              "audio: AL_BUFFER 0 on a stopped source drops the queue and clears the backend");
        isaac_w32(ids, b[0]); isaac_w32(ids + 4, b[1]);
        isaac_audio_queue(src, 2, ids);
        g_audio_ms = 7000.0;
        isaac_audio_play(src);
        g_audio_ms = 7400.0;
        isaac_audio_pause(src);
        check(isaac_audio_get_source_i(src, STATE) == PAUSED, "audio: pause");
        g_audio_ms = 9000.0;
        isaac_audio_play(src);
        check(isaac_audio_get_source_i(src, STATE) == PLAYING && g_be_head == 0 &&
              g_be_offset > 0.39f && g_be_offset < 0.41f,
              "audio: a play from paused resumes the current entry at its offset (0.4 s)");
        g_audio_ms = 9500.0;
        check(isaac_audio_get_source_i(src, PROCESSED) == 0, "audio: 0.5 s after the resume the chunk is still playing");
        g_audio_ms = 9700.0;
        check(isaac_audio_get_source_i(src, PROCESSED) == 1, "audio: it retires 0.6 s after the resume, when its second is up");
        isaac_audio_stop(src);
        isaac_audio_unqueue(src, 2, out);
        /* the static case: a bound buffer plays once, or loops */
        isaac_audio_source_i(src, BUFFER, (int32_t)b[2]);
        g_audio_ms = 10000.0;
        isaac_audio_play(src);
        check(isaac_audio_get_source_i(src, STATE) == PLAYING && g_be_stream == 0,
              "audio: a static source plays its bound buffer (the backend sees a static play)");
        g_audio_ms = 11100.0;
        check(isaac_audio_get_source_i(src, STATE) == STOPPED, "audio: and stops when the buffer has played out");
        isaac_audio_source_i(src, LOOPING, 1);
        isaac_audio_play(src);
        g_audio_ms = 13500.0;
        check(isaac_audio_get_source_i(src, STATE) == PLAYING, "audio: a looping static source keeps playing");
        isaac_audio_stop(src);
    }

    /* Steam accessor policy (boot round 11): SteamInternal_ContextInit is
     * every SteamXxx() accessor's inline body. Only the two init-dance slots
     * receive the fake CSteamAPIContext; any other slot must read NULL, the
     * game's own "Steam not running" arm -- a fake vtable answering a real
     * interface pops the wrong byte count (ISteamApps::BIsDlcInstalled at
     * +0x1c vs CSteamAPIContext_ReleaseInterface) and drifts the guest stack. */
    {
        uint32_t slot_unknown = ISAAC_STACK_TOP_VA - 0x2000;   /* a guest cell */
        isaac_w32(slot_unknown, 0xCAFEBABE);                   /* stale garbage */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, slot_unknown);
        imp_steam_api__SteamInternal_ContextInit(&cpu);
        check(cpu.EAX == slot_unknown,
              "SteamInternal_ContextInit returns the slot address");
        check(isaac_r32(slot_unknown) == 0,
              "a non-init-dance accessor slot reads NULL (no Steam)");

        uint32_t slot_init = 0x00c5c510u;                      /* verified init-dance slot */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, slot_init);
        imp_steam_api__SteamInternal_ContextInit(&cpu);
        check(isaac_r32(slot_init) != 0 && isaac_r32(isaac_r32(slot_init)) != 0,
              "the init-dance slot receives the fake context with a vtable");
    }

    /* memset must refuse a destination on the HOST side of the guard. */
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, ISAAC_HOST_BASE_VA);
    isaac_w32(cpu.ESP + 8, 0xAA);
    isaac_w32(cpu.ESP + 12, 64);
    uint32_t host_canary = *(volatile uint32_t *)isaac_g(ISAAC_HOST_BASE_VA);
    imp_vcruntime140__memset(&cpu);
    check(*(volatile uint32_t *)isaac_g(ISAAC_HOST_BASE_VA) == host_canary,
          "memset refuses a host-range destination and leaves it untouched");

    /* 9. The trap message must name the CALL SITE, not the return address.
     * The lifter observed _set_app_type demanded from return address
     * 0x00aefa07; the call is at 0x00aefa02. */
    if (g_image_loaded) {
        uint32_t site = isaac_call_site_from_return(0x00aefa07u);
        printf("      call-site decode: ret 0x00aefa07 -> 0x%08x\n", site);
        check(site == 0x00aefa02u,
              "call site recovered from the return address (off-by-one fixed)");
    }

    /* 10. THE MODULE-HANDLE STORY, and the specific decision that unblocks the
     * boot. FUN_00aef191 treats a NULL kernel32 handle as fatal (je at
     * 0x00aef1c3 -> STATUS_FATAL_APP_EXIT) while handling a NULL api-set
     * handle by design, so these two answers must differ. */
    {
        /* build UTF-16 names in guest memory */
        uint32_t nbuf = ISAAC_HEAP_VA + 0x40000;
        const char *k32 = "kernel32.dll";
        const char *apiset = "api-ms-win-core-synch-l1-2-0.dll";
        uint32_t n1 = nbuf, n2 = nbuf + 256;
        for (unsigned i = 0; ; ++i) { isaac_w32(n1 + 2u * i, k32[i]); if (!k32[i]) break; }
        for (unsigned i = 0; ; ++i) { isaac_w32(n2 + 2u * i, apiset[i]); if (!apiset[i]) break; }

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, n1);
        imp_kernel32__GetModuleHandleW(&cpu);
        uint32_t hk32 = cpu.EAX;
        printf("      GetModuleHandleW(kernel32.dll) -> 0x%08x\n", hk32);
        check(hk32 != 0,
              "GetModuleHandleW(kernel32.dll) is non-NULL (the boot blocker)");
        check(isaac_is_guest_va(hk32), "module handle is a guest-side token");

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, n2);
        imp_kernel32__GetModuleHandleW(&cpu);
        check(cpu.EAX == 0,
              "GetModuleHandleW(api-set) is NULL, which the caller handles");

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, 0);
        imp_kernel32__GetModuleHandleW(&cpu);
        check(cpu.EAX == ISAAC_IMAGE_BASE,
              "GetModuleHandleW(NULL) is the image base, as on Windows");

        /* GetProcAddress must return THE SHIM TOKEN -- the same value the IAT
         * holds -- so a dynamically resolved pointer and a statically bound
         * one are the same thing. */
        uint32_t sbuf = nbuf + 512;
        const char *sym = "CreateEventW";
        for (unsigned i = 0; ; ++i) {
            *(uint8_t *)isaac_g(sbuf + i) = (uint8_t)sym[i];
            if (!sym[i]) break;
        }
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, hk32);
        isaac_w32(cpu.ESP + 8, sbuf);
        imp_kernel32__GetProcAddress(&cpu);
        uint32_t proc = cpu.EAX;
        isaac_import *viaproc = isaac_resolve_shim(proc);
        printf("      GetProcAddress(kernel32, CreateEventW) -> 0x%08x\n", proc);
        check(proc != 0, "GetProcAddress resolves a symbol we implement");
        check(viaproc && !strcmp(viaproc->symbol, "CreateEventW"),
              "GetProcAddress returns the SAME shim token the IAT holds");
        check(viaproc && isaac_r32(viaproc->iat_slot_va) == proc,
              "that token is bit-identical to the bound IAT slot");

        /* A DYNAMIC export (not in the static IAT) must ALSO resolve: the game
         * probes ntdll!RtlVerifyVersionInfo via GetProcAddress and calls the
         * result unconditionally, so a NULL here is the boot fault at
         * 0x00a8102c. gen_shims.py emits these dynamic rows into the C table;
         * this proves GetProcAddress finds one. */
        uint32_t hntdll = 0;
        {
            const char *nt = "ntdll.dll";
            uint32_t nbuf16 = nbuf + 800;
            for (unsigned i = 0; ; ++i) { isaac_w32(nbuf16 + 2u * i, nt[i]); if (!nt[i]) break; }
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, nbuf16);
            imp_kernel32__GetModuleHandleW(&cpu);
            hntdll = cpu.EAX;
        }
        const char *rtl = "RtlVerifyVersionInfo";
        for (unsigned i = 0; ; ++i) {
            *(uint8_t *)isaac_g(sbuf + i) = (uint8_t)rtl[i];
            if (!rtl[i]) break;
        }
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, hntdll);
        isaac_w32(cpu.ESP + 8, sbuf);
        imp_kernel32__GetProcAddress(&cpu);
        isaac_import *rtlimp = isaac_resolve_shim(cpu.EAX);
        check(cpu.EAX != 0 && rtlimp && !strcmp(rtlimp->symbol, "RtlVerifyVersionInfo"),
              "GetProcAddress resolves the dynamic ntdll!RtlVerifyVersionInfo export");

        /* A symbol we do not have must be NULL -- callers probe deliberately. */
        const char *absent = "SleepConditionVariableCS";
        for (unsigned i = 0; ; ++i) {
            *(uint8_t *)isaac_g(sbuf + i) = (uint8_t)absent[i];
            if (!absent[i]) break;
        }
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, hk32);
        isaac_w32(cpu.ESP + 8, sbuf);
        imp_kernel32__GetProcAddress(&cpu);
        check(cpu.EAX == 0,
              "GetProcAddress returns NULL for a symbol we do not provide");
    }

    /* 11. CreateEventW must be non-NULL or the same fatal branch fires one
     * step later, and the event has to actually behave. */
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, 0);        /* attrs        */
    isaac_w32(cpu.ESP + 8, 1);        /* manual reset */
    isaac_w32(cpu.ESP + 12, 0);       /* initial      */
    isaac_w32(cpu.ESP + 16, 0);       /* name         */
    imp_kernel32__CreateEventW(&cpu);
    uint32_t ev = cpu.EAX;
    printf("      CreateEventW -> 0x%08x\n", ev);
    check(ev != 0, "CreateEventW is non-NULL (the intended CRT fallback)");

    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, ev);
    isaac_w32(cpu.ESP + 8, 0);        /* zero timeout */
    imp_kernel32__WaitForSingleObject(&cpu);
    check(cpu.EAX == 0x102u,
          "wait on an unsignalled event with 0 timeout returns WAIT_TIMEOUT");

    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, ev);
    imp_kernel32__SetEvent(&cpu);
    memset(&cpu, 0, sizeof cpu);
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
    isaac_w32(cpu.ESP, 0xDEADBEEF);
    isaac_w32(cpu.ESP + 4, ev);
    isaac_w32(cpu.ESP + 8, 0xFFFFFFFFu);
    imp_kernel32__WaitForSingleObject(&cpu);
    check(cpu.EAX == 0, "after SetEvent, an INFINITE wait returns WAIT_OBJECT_0");

#ifdef ISAAC_SELFTEST_HAVE_LUA
    /* 12. LUA -- the 59-symbol binding against a REAL upstream 5.3.3 module.
     * The compile-time ABI gates live in host_lua.c (LUAL_NUMSIZES == 136,
     * no LUA_COMPAT_5_2, no LUA_32BITS); these checks prove the linked module
     * executes and every marshalling convention round-trips THROUGH THE SHIMS:
     * doubles cross two stack slots, 64-bit integers cross EDX:EAX/st(0) on
     * the way out, Lua allocates inside the guest arena, and guest
     * lua_CFunction pointers ride pooled trampolines. */
    extern uint32_t isaac_guest_alloc(uint32_t n);
    extern void     isaac_guest_free(uint32_t p);
    extern unsigned isaac_lua_trampolines_used(void);
    extern void     isaac_lua_report(void);

    uint32_t scratch = isaac_guest_alloc(1024);
    CpuState lc;
    lua_State *L;
    int isnum = 0;
    double dbl;
    lua_Integer lint, lgot;
    size_t slen;
    const char *sret;
    unsigned tl;

#  define LFRAME() do { \
        memset(&lc, 0, sizeof lc); \
        lc.ESP = ISAAC_STACK_TOP_VA - 0x1000; \
        isaac_w32(lc.ESP, 0xDEADBEEF); \
    } while (0)
#  define LARG(n, v) isaac_w32(lc.ESP + 4u + 4u * (n), (uint32_t)(v))
#  define LARG64(n, v) do { \
        uint64_t _u; memcpy(&_u, &(v), 8); \
        isaac_w32(lc.ESP + 4u + 4u * (n), (uint32_t)_u); \
        isaac_w32(lc.ESP + 4u + 4u * (n) + 4u, (uint32_t)(_u >> 32)); \
    } while (0)

    /* luaL_newstate must return a guest-addressable state: the binding
     * supplies the guest-arena allocator, so L and every object it owns land
     * below the guard. */
    memcpy(isaac_g(scratch), "sync", 5);
    memcpy(isaac_g(scratch + 16), "return 2+3", 11);
    LFRAME();
    imp_lua5_3_3r__luaL_newstate(&lc);
    L = (lua_State *)isaac_g(lc.EAX);
    printf("      luaL_newstate -> 0x%08x\n", lc.EAX);
    check(lc.EAX != 0 && isaac_is_guest_va(lc.EAX),
          "luaL_newstate returns a guest-addressable lua_State");

    LFRAME();
    LARG(0, isaac_va(L));
    imp_lua5_3_3r__luaL_openlibs(&lc);
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, LUA_GCCOUNT);
    LARG(2, 0);
    imp_lua5_3_3r__lua_gc(&lc);
    printf("      lua_gc LUA_GCCOUNT -> %u KB\n", lc.EAX);
    check(lc.EAX > 0, "the Lua VM really allocated after openlibs");

    /* doubles: two stack slots in, round-trip out without narrowing. */
    dbl = 1.5;
    LFRAME();
    LARG(0, isaac_va(L));
    LARG64(1, dbl);
    imp_lua5_3_3r__lua_pushnumber(&lc);
    dbl = lua_tonumberx(L, -1, NULL);
    check(dbl == 1.5 && lua_type(L, -1) == LUA_TNUMBER,
          "lua_pushnumber shim round-trips a double");

    /* 64-bit integers: the high dword must not be dropped. A silent 32-bit
     * truncation would turn 0x123456789ABCDEF0 into 0x789ABCDEF0. */
    lint = (lua_Integer)0x123456789ABCDEF0ULL;
    LFRAME();
    LARG(0, isaac_va(L));
    LARG64(1, lint);
    imp_lua5_3_3r__lua_pushinteger(&lc);
    lgot = lua_tointegerx(L, -1, &isnum);
    check(isnum && memcmp(&lgot, &lint, 8) == 0,
          "lua_pushinteger shim round-trips a 64-bit lua_Integer");

    /* strings: the pointer argument is guest memory and must be read as-is. */
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, scratch);
    imp_lua5_3_3r__lua_pushstring(&lc);
    sret = lua_tolstring(L, -1, &slen);
    check(slen == 4 && sret && memcmp(sret, "sync", 4) == 0,
          "lua_pushstring shim round-trips a guest string");

    /* the actual VM: compile and run a chunk through the load/pcall shims. */
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, scratch + 16);
    LARG(2, 10);
    LARG(3, scratch + 16);
    LARG(4, 0);
    imp_lua5_3_3r__luaL_loadbufferx(&lc);
    check(lc.EAX == LUA_OK, "luaL_loadbufferx compiles a chunk (LUA_OK)");
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, 0);
    LARG(2, 1);
    LARG(3, 0);
    imp_lua5_3_3r__lua_pcallk(&lc);
    check(lc.EAX == LUA_OK, "lua_pcallk runs the chunk (LUA_OK)");
    lgot = lua_tointegerx(L, -1, &isnum);
    check(isnum && lgot == 5,
          "upstream Lua VM computes 2+3 inside the wasm module");

    /* guest lua_CFunction pointers must ride distinct pooled trampolines and
     * deduplicate; calling one fires the inert isaac_guest_call (nothing here
     * transfers control to guest code) and must still come back LUA_OK. */
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, 0x01234567u);
    LARG(2, 0);
    imp_lua5_3_3r__lua_pushcclosure(&lc);
    tl = isaac_lua_trampolines_used();
    check(tl == 1, "lua_pushcclosure registers the first trampoline");
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, 0x07654321u);
    LARG(2, 0);
    imp_lua5_3_3r__lua_pushcclosure(&lc);
    check(isaac_lua_trampolines_used() == 2,
          "distinct guest C functions get distinct trampolines");
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, 0x01234567u);
    LARG(2, 0);
    imp_lua5_3_3r__lua_pushcclosure(&lc);
    check(isaac_lua_trampolines_used() == 2,
          "re-registering the same guest C function reuses its trampoline");
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, (uint32_t)-1);
    imp_lua5_3_3r__lua_iscfunction(&lc);
    check(lc.EAX == 1, "the trampoline closure reads back as a C function");
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, 0);
    LARG(2, 1);
    LARG(3, 0);
    imp_lua5_3_3r__lua_pcallk(&lc);
    check(lc.EAX == LUA_OK,
          "calling the trampoline closure yields LUA_OK (inert guest call)");

    /* return-convention checks: luaL_checknumber returns in st(0),
     * luaL_checkinteger in EDX:EAX. */
    dbl = 7.25;
    LFRAME();
    LARG(0, isaac_va(L));
    LARG64(1, dbl);
    imp_lua5_3_3r__lua_pushnumber(&lc);
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, (uint32_t)-1);
    imp_lua5_3_3r__luaL_checknumber(&lc);
    memcpy(&dbl, lc.ST0, 8);
    check(dbl == 7.25, "luaL_checknumber returns the double in st(0)");
    lint = 42;
    LFRAME();
    LARG(0, isaac_va(L));
    LARG64(1, lint);
    imp_lua5_3_3r__lua_pushinteger(&lc);
    LFRAME();
    LARG(0, isaac_va(L));
    LARG(1, (uint32_t)-1);
    imp_lua5_3_3r__luaL_checkinteger(&lc);
    check(lc.EAX == 42 && lc.EDX == 0,
          "luaL_checkinteger returns in EDX:EAX");

    LFRAME();
    LARG(0, isaac_va(L));
    imp_lua5_3_3r__lua_close(&lc);
    check(isaac_lua_trampolines_used() == 2,
          "trampoline pool survives lua_close");
    isaac_guest_free(scratch);
    isaac_lua_report();
#  undef LFRAME
#  undef LARG
#  undef LARG64
#endif

    /* 13. BOOT ASSET SEEDING: isaac_fs_seed() must place a file the game's
     * own fopen/fread shims read back byte-for-byte, at the key those shims
     * compute from the same relative path — this is what lets the packed
     * archives be present so Manager::LoadImage stops returning NULL on the
     * HUD path (the guest fault at 0x009a26c2). Parent dirs must appear so a
     * directory scan sees the file. */
    {
        extern int isaac_fs_seed(const char *path, const uint8_t *data, uint32_t len);
        static const uint8_t payload[] = {
            'I','S','A','A','C','P','A','K', 0x01, 0x00, 0x00, 0x00,
            0xDE, 0xAD, 0xBE, 0xEF, 0x55, 0xAA, 0x00, 0xFF,
        };
        int seeded = isaac_fs_seed("resources/packed/graphics.a",
                                   payload, (uint32_t)sizeof payload);
        check(seeded == 1, "isaac_fs_seed placed the archive file");

        /* the parent directory the game FindFirstFile-scans must exist */
        uint32_t dbuf = ISAAC_HEAP_VA + 0x50000;
        const char *dpath = "resources/packed";
        for (unsigned i = 0; ; ++i) {
            *(uint8_t *)isaac_g(dbuf + i) = (uint8_t)dpath[i];
            if (!dpath[i]) break;
        }
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, dbuf);
        imp_kernel32__GetFileAttributesA(&cpu);
        check(cpu.EAX == 0x10u, "the seeded parent dir reads as a directory");

        /* open it through the SAME fopen shim the lifted game uses */
        uint32_t pbuf = dbuf + 256, mbuf = dbuf + 512, rbuf = dbuf + 640;
        const char *ppath = "resources/packed/graphics.a";
        for (unsigned i = 0; ; ++i) {
            *(uint8_t *)isaac_g(pbuf + i) = (uint8_t)ppath[i];
            if (!ppath[i]) break;
        }
        *(uint8_t *)isaac_g(mbuf) = 'r';
        *(uint8_t *)isaac_g(mbuf + 1) = 'b';
        *(uint8_t *)isaac_g(mbuf + 2) = 0;
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, pbuf);
        isaac_w32(cpu.ESP + 8, mbuf);
        imp_api_ms_win_crt_stdio__fopen(&cpu);
        uint32_t fh = cpu.EAX;
        check(fh != 0, "fopen finds the seeded archive by its normalized key");

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, rbuf);                 /* dst    */
        isaac_w32(cpu.ESP + 8, 1);                    /* size   */
        isaac_w32(cpu.ESP + 12, (uint32_t)sizeof payload); /* nmemb */
        isaac_w32(cpu.ESP + 16, fh);                  /* stream */
        imp_api_ms_win_crt_stdio__fread(&cpu);
        check(cpu.EAX == sizeof payload, "fread returns the full seeded length");
        int match = 1;
        for (unsigned i = 0; i < sizeof payload; ++i)
            if (*(uint8_t *)isaac_g(rbuf + i) != payload[i]) { match = 0; break; }
        check(match, "the bytes read back are byte-for-byte what was seeded");

        /* Round 12f: the key -> slot hash index and lazy bytes. */
        {
            extern int isaac_fs_seed_lazy(const char *path, uint32_t len);
            typedef int (*isaac_fs_lazy_reader)(const char *src, uint8_t *dst, uint32_t len);
            extern void isaac_fs_set_lazy_reader(isaac_fs_lazy_reader fn);
            extern uint32_t isaac_fs_lazy_loads(void);
            static const uint8_t one[1] = { 1 };
            check(isaac_fs_seed("data/idx_a.txt", one, 1) == 1 &&
                  isaac_fs_seed("data/idx_b.txt", one, 1) == 1 &&
                  isaac_fs_seed("data/idx_c.txt", one, 1) == 1, "three files seed beside each other");
            uint32_t nbuf = dbuf + 0x300;
            #define FS_ATTR(path) do { \
                const char *q_ = (path); \
                for (unsigned i_ = 0; ; ++i_) { *(uint8_t *)isaac_g(nbuf + i_) = (uint8_t)q_[i_]; if (!q_[i_]) break; } \
                memset(&cpu, 0, sizeof cpu); \
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000; \
                isaac_w32(cpu.ESP, 0xDEADBEEF); \
                isaac_w32(cpu.ESP + 4, nbuf); \
            } while (0)
            FS_ATTR("data/idx_b.txt"); imp_kernel32__GetFileAttributesA(&cpu);
            check(cpu.EAX != 0xFFFFFFFFu, "the index finds a seeded file");
            FS_ATTR("data/idx_b.txt"); imp_kernel32__DeleteFileA(&cpu);
            check(cpu.EAX == 1u, "DeleteFileA removes it");
            FS_ATTR("data/idx_b.txt"); imp_kernel32__GetFileAttributesA(&cpu);
            int gone = (cpu.EAX == 0xFFFFFFFFu);
            FS_ATTR("data/idx_a.txt"); imp_kernel32__GetFileAttributesA(&cpu);
            int a_ok = (cpu.EAX != 0xFFFFFFFFu);
            FS_ATTR("data/idx_c.txt"); imp_kernel32__GetFileAttributesA(&cpu);
            int c_ok = (cpu.EAX != 0xFFFFFFFFu);
            check(gone && a_ok && c_ok, "after a delete the index still finds the neighbours and not the deleted key");
            FS_ATTR("data/idx_b.txt");
            check(isaac_fs_seed("data/idx_b.txt", one, 1) == 1, "the deleted key can be seeded again");
            imp_kernel32__GetFileAttributesA(&cpu);
            check(cpu.EAX != 0xFFFFFFFFu, "and is found again");

            /* Round 31: one display adapter, one monitor, one mode -- what
             * GLFW's monitor poll needs so glfwGetPrimaryMonitor() is not NULL. */
            {
                extern void imp_user32__EnumDisplayDevicesW(CpuState *restrict cpu);
                extern void imp_user32__EnumDisplaySettingsW(CpuState *restrict cpu);
                uint32_t dd = dbuf + 0x800, dm = dbuf + 0x1000;
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0); isaac_w32(cpu.ESP + 8, 0);
                isaac_w32(cpu.ESP + 12, dd); isaac_w32(cpu.ESP + 16, 0);
                imp_user32__EnumDisplayDevicesW(&cpu);
                check(cpu.EAX == 1u && isaac_r32(dd) == 840u && isaac_r16(dd + 4) == '\\' && (isaac_r32(dd + 324) & 4u),
                      "adapter 0 is a primary display device named \\\\.\\DISPLAY1");
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0); isaac_w32(cpu.ESP + 8, 1);
                isaac_w32(cpu.ESP + 12, dd); isaac_w32(cpu.ESP + 16, 0);
                imp_user32__EnumDisplayDevicesW(&cpu);
                check(cpu.EAX == 0u, "there is no second adapter");
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, dd + 4); isaac_w32(cpu.ESP + 8, 0);
                isaac_w32(cpu.ESP + 12, dd); isaac_w32(cpu.ESP + 16, 0);
                imp_user32__EnumDisplayDevicesW(&cpu);
                check(cpu.EAX == 1u && (isaac_r32(dd + 324) & 1u), "the adapter has one active monitor");
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0); isaac_w32(cpu.ESP + 8, 0xFFFFFFFFu);
                isaac_w32(cpu.ESP + 12, dm);
                imp_user32__EnumDisplaySettingsW(&cpu);
                check(cpu.EAX == 1u && isaac_r16(dm + 68) == 220u && isaac_r32(dm + 172) == 1280u && isaac_r32(dm + 176) == 720u
                      && isaac_r32(dm + 184) == 60u && isaac_r32(dm + 168) == 32u,
                      "ENUM_CURRENT_SETTINGS is the 1280x720 32-bit 60 Hz mode");
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, 0); isaac_w32(cpu.ESP + 8, 1);
                isaac_w32(cpu.ESP + 12, dm);
                imp_user32__EnumDisplaySettingsW(&cpu);
                check(cpu.EAX == 0u, "and mode 1 does not exist");
            }

            /* Round 49: the imdct butterfly against the stb_vorbis formulation
             * (pointer walk from e0/e2 downwards), bit-exact on a pseudo-random
             * buffer, and the touched range as the verify mode computes it. */
            {
                uint32_t eb = ISAAC_HEAP_VA + 0x200000u, ab = ISAAC_HEAP_VA + 0x210000u;
                float *e = (float *)isaac_g(eb), *A = (float *)isaac_g(ab);
                float ref[128];
                uint32_t seed = 0x1234567u;
                for (unsigned i = 0; i < 128u; ++i) { seed = seed * 1664525u + 1013904223u; e[i] = (float)(int32_t)seed * 1e-9f; }
                for (unsigned i = 0; i < 64u; ++i) { seed = seed * 1664525u + 1013904223u; A[i] = (float)(int32_t)seed * 1e-9f; }
                memcpy(ref, e, sizeof ref);
                {   /* the source: lim 16 -> 4 iterations, e0 = e + 71, e2 = e0 + 48, A stride k1 = 2 */
                    float *e0 = ref + 71, *e2 = e0 + 48; const float *a = A; int i;
                    for (i = 16 >> 2; i > 0; --i) {
                        float k00_20, k01_21;
                        k00_20 = e0[-0] - e2[-0]; k01_21 = e0[-1] - e2[-1]; e0[-0] += e2[-0]; e0[-1] += e2[-1];
                        e2[-0] = k00_20 * a[0] - k01_21 * a[1]; e2[-1] = k01_21 * a[0] + k00_20 * a[1]; a += 2;
                        k00_20 = e0[-2] - e2[-2]; k01_21 = e0[-3] - e2[-3]; e0[-2] += e2[-2]; e0[-3] += e2[-3];
                        e2[-2] = k00_20 * a[0] - k01_21 * a[1]; e2[-3] = k01_21 * a[0] + k00_20 * a[1]; a += 2;
                        k00_20 = e0[-4] - e2[-4]; k01_21 = e0[-5] - e2[-5]; e0[-4] += e2[-4]; e0[-5] += e2[-5];
                        e2[-4] = k00_20 * a[0] - k01_21 * a[1]; e2[-5] = k01_21 * a[0] + k00_20 * a[1]; a += 2;
                        k00_20 = e0[-6] - e2[-6]; k01_21 = e0[-7] - e2[-7]; e0[-6] += e2[-6]; e0[-7] += e2[-7];
                        e2[-6] = k00_20 * a[0] - k01_21 * a[1]; e2[-7] = k01_21 * a[0] + k00_20 * a[1]; a += 2;
                        e0 -= 8; e2 -= 8;
                    }
                }
                isaac_fast_imdct_r_loop(16u, eb, 71u, 48u, ab, 2u);
                check(memcmp(e, ref, sizeof ref) == 0, "fastpath: the imdct butterfly is bit-exact against the stb_vorbis formulation");
                { uint32_t lo = 0, len = 0; isaac_fast_imdct_r_loop_range(16u, eb, 71u, 48u, &lo, &len);
                  check(lo == eb + (71u - 31u) * 4u && lo + len == eb + (71u + 48u + 1u) * 4u,
                        "fastpath: the verify range covers e0-31..e0 and e2-31..e2 (both runs of 32 floats)"); }
                { uint32_t lo = 0, len = 0;
                  check(isaac_fast_imdct_r_loop_ok(16u, eb, 71u, 48u, ab, 2u, &lo, &len) == 1 && len == 80u * 4u,
                        "fastpath: the imdct gate admits the in-heap runs and reports their extent");
                  check(isaac_fast_imdct_r_loop_ok(0u, eb, 71u, 48u, ab, 2u, &lo, &len) == 0,
                        "fastpath: the imdct gate declines an empty loop (lim < 4)");
                  check(isaac_fast_imdct_r_loop_ok(16u, 0xfffff000u, 71u, 48u, ab, 2u, &lo, &len) == 0,
                        "fastpath: the imdct gate declines a run outside guest memory"); }
            }

            /* Round 50: the whole inverse_mdct on the host -- the gate, and a
             * zero block through every step (the tables are zero too, so the
             * output is zero and nothing outside the buffer is touched) */
            {
                uint32_t fv = ISAAC_HEAP_VA + 0x220000u, bufv = ISAAC_HEAP_VA + 0x230000u, tab = ISAAC_HEAP_VA + 0x240000u;
                uint8_t *f = (uint8_t *)isaac_g(fv);
                float *buf = (float *)isaac_g(bufv);
                unsigned i;
                memset(f, 0, 0x480u);
                *(uint32_t *)(f + 0x43c) = tab;              /* A[0]: 1024 floats */
                *(uint32_t *)(f + 0x444) = tab + 0x1000u;    /* B[0] */
                *(uint32_t *)(f + 0x44c) = tab + 0x2000u;    /* C[0]: 512 floats */
                *(uint32_t *)(f + 0x45c) = tab + 0x2800u;    /* bit_reverse[0]: 256 uint16 */
                memset(isaac_g(tab), 0, 0x3000u);
                for (i = 0; i < 2048u + 8u; ++i) buf[i] = 1.0f;
                check(isaac_fast_inverse_mdct_ok(bufv, 2048u, fv, 0u) == 1, "fastpath: the inverse_mdct gate admits a 2048 block with its tables in the heap");
                check(isaac_fast_inverse_mdct_ok(bufv, 2048u, fv, 2u) == 0, "fastpath: the gate declines a blocktype past 1");
                check(isaac_fast_inverse_mdct_ok(bufv, 1000u, fv, 0u) == 0, "fastpath: the gate declines a block that is not a power of two");
                check(isaac_fast_inverse_mdct_ok(bufv, 32u, fv, 0u) == 0 && isaac_fast_inverse_mdct_ok(bufv, 16384u, fv, 0u) == 0,
                      "fastpath: the gate declines blocks outside 64..8192");
                *(uint32_t *)(f + 0x60) = tab + 0x4000u;      /* alloc_buffer */
                *(uint32_t *)(f + 0x68) = 0x100u;             /* setup_offset */
                *(uint32_t *)(f + 0x6c) = 0x1100u;            /* temp_offset: room for 0x1000 bytes of scratch */
                check(isaac_fast_inverse_mdct_ok(bufv, 2048u, fv, 0u) == 1, "fastpath: the engine's alloc_buffer (temp_alloc) path is admitted when the scratch fits");
                *(uint32_t *)(f + 0x6c) = 0x10ffu;
                check(isaac_fast_inverse_mdct_ok(bufv, 2048u, fv, 0u) == 0, "fastpath: a scratch that would reach below setup_offset (the original's NULL) is left to the lifted body");
                *(uint32_t *)(f + 0x6c) = 0x1100u;
                memset(isaac_g(tab + 0x4000u + 0x100u), 0x5a, 0x1000u);
                isaac_fast_inverse_mdct(bufv, 2048u, fv, 0u);
                for (i = 0; i < 2048u && buf[i] == 0.0f; ++i) ;
                check(i == 2048u, "fastpath: zero tables turn a block of ones into 2048 zeros");
                check(buf[2048] == 1.0f && buf[2048 + 7] == 1.0f, "fastpath: nothing past the block is written");
                check(*(uint32_t *)(f + 0x6c) == 0x1100u, "fastpath: temp_offset is left as it was (taken and given back)");
                check(*(uint8_t *)isaac_g(tab + 0x4000u + 0x100u) != 0x5au, "fastpath: the scratch went into the guest temp region, where the original puts it");
                *(uint32_t *)(f + 0x60) = 0u;
                isaac_fast_inverse_mdct(bufv, 2048u, fv, 0u);
                check(buf[0] == 0.0f && buf[2047] == 0.0f, "fastpath: without an alloc_buffer the host scratch serves");
            }

            /* Round 37: the host GL cache. Renderbuffer parameters come from
             * the storage call, a framebuffer's status is remembered until
             * something that can change its completeness happens, locations
             * live until the program is linked again; anything unknown falls
             * through to the real GL. */
            {
                uint32_t v = 0, st = 0; int32_t loc = 0;
                isaac_glc_reset();
                check(!isaac_glc_rb_param(0x8D42u, &v), "gl cache: no renderbuffer bound -> the real GL answers");
                isaac_glc_rb_bind(7);
                check(!isaac_glc_rb_param(0x8D42u, &v), "gl cache: a renderbuffer without storage -> the real GL answers");
                isaac_glc_rb_storage(0x8058u, 640, 480, 0);
                check(isaac_glc_rb_param(0x8D42u, &v) && v == 640u, "gl cache: GL_RENDERBUFFER_WIDTH from the storage call");
                check(isaac_glc_rb_param(0x8D43u, &v) && v == 480u, "gl cache: GL_RENDERBUFFER_HEIGHT too");
                check(isaac_glc_rb_param(0x8D44u, &v) && v == 0x8058u, "gl cache: and the internal format");
                check(isaac_glc_rb_param(0x8D50u, &v) && v == 8u, "gl cache: GL_RGBA8 has 8 red bits");
                check(isaac_glc_rb_param(0x8D54u, &v) && v == 0u, "gl cache: and no depth bits");
                check(!isaac_glc_rb_param(0x9999u, &v), "gl cache: an unknown pname falls through");
                isaac_glc_rb_bind(8); isaac_glc_rb_storage(0x88F0u, 64, 32, 0);
                check(isaac_glc_rb_param(0x8D54u, &v) && v == 24u && isaac_glc_rb_param(0x8D55u, &v) && v == 8u,
                      "gl cache: GL_DEPTH24_STENCIL8 is 24 depth bits and 8 stencil bits");
                isaac_glc_rb_bind(7);
                check(isaac_glc_rb_param(0x8D42u, &v) && v == 640u, "gl cache: rebinding recalls the first renderbuffer");
                isaac_glc_rb_delete(7);
                check(!isaac_glc_rb_param(0x8D42u, &v), "gl cache: a deleted renderbuffer is forgotten");
                check(isaac_glc_fbo_status(0x8D40u, &st) && st == 0x8CD5u, "gl cache: the default framebuffer is complete");
                isaac_glc_fbo_bind(0x8D40u, 3);
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: a fresh framebuffer asks GL");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                check(isaac_glc_fbo_status(0x8D40u, &st) && st == 0x8CD5u, "gl cache: GL's answer is remembered");
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 21, (0x0DE1u << 8));
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: an attachment call forgets it");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 21, (0x0DE1u << 8));
                check(isaac_glc_fbo_status(0x8D40u, &st) && st == 0x8CD5u, "gl cache: re-attaching the same image changes nothing (the engine does it every frame)");
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 21, (0x0DE1u << 8) ^ 1u);
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: another level of the same texture is a change");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD6u);
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 21, (0x0DE1u << 8));
                check(isaac_glc_fbo_status(0x8D40u, &st) && st == 0x8CD5u, "gl cache: a configuration seen before is remembered when it comes back (the engine swaps textures through one attachment point)");
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 21, (0x0DE1u << 8) ^ 1u);
                check(isaac_glc_fbo_status(0x8D40u, &st) && st == 0x8CD6u, "gl cache: each configuration keeps its own answer");
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 23, (0x0DE1u << 8));
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_tex_active(0x84C0u); isaac_glc_tex_bind(0x0DE1u, 21); isaac_glc_tex_image(0x0DE1u);
                isaac_glc_fbo_attach(0x8D40u, 0x8CE0u, 1, 21, (0x0DE1u << 8));
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: a new image for a texture a remembered configuration used (not the slot's) forgets it too");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_tex_active(0x84C1u); isaac_glc_tex_bind(0x0DE1u, 22); isaac_glc_tex_image(0x0DE1u);
                check(isaac_glc_fbo_status(0x8D40u, &st), "gl cache: a new image for another texture keeps it");
                isaac_glc_tex_bind(0x0DE1u, 21); isaac_glc_tex_image(0x0DE1u);
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: a new image for the attached texture forgets it");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_fbo_attach(0x8D40u, 0x8D00u, 0, 8, 0);
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_rb_bind(9); isaac_glc_rb_storage(0x8058u, 8, 8, 0);
                check(isaac_glc_fbo_status(0x8D40u, &st), "gl cache: storage for another renderbuffer keeps it");
                isaac_glc_rb_bind(8); isaac_glc_rb_storage(0x88F0u, 64, 32, 0);
                check(isaac_glc_fbo_status(0x8D40u, &st), "gl cache: the same storage again for the attached renderbuffer keeps it");
                isaac_glc_rb_bind(8); isaac_glc_rb_storage(0x8058u, 16, 16, 0);
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: storage for the attached renderbuffer forgets it");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_fbo_bind(0x8CA8u, 4);
                check(!isaac_glc_fbo_status(0x8CA8u, &st), "gl cache: the read binding is its own framebuffer");
                check(isaac_glc_fbo_status(0x8CA9u, &st) && st == 0x8CD5u, "gl cache: the draw binding still remembers");
                isaac_glc_tex_delete(21);
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: deleting an attached texture forgets it");
                isaac_glc_fbo_set_status(0x8D40u, 0x8CD5u);
                isaac_glc_fbo_delete(3);
                check(isaac_glc_fbo_status(0x8D40u, &st) && st == 0x8CD5u, "gl cache: deleting the bound framebuffer leaves the default bound");
                isaac_glc_fbo_bind(0x8D40u, 3);
                check(!isaac_glc_fbo_status(0x8D40u, &st), "gl cache: a deleted name comes back fresh");
                check(!isaac_glc_loc_get(5, 1, "Transform", &loc), "gl cache: an unknown uniform asks GL");
                isaac_glc_loc_put(5, 1, "Transform", 3);
                check(isaac_glc_loc_get(5, 1, "Transform", &loc) && loc == 3, "gl cache: the uniform location is remembered");
                check(!isaac_glc_loc_get(5, 0, "Transform", &loc), "gl cache: attribs and uniforms are separate");
                check(!isaac_glc_loc_get(6, 1, "Transform", &loc), "gl cache: programs are separate");
                isaac_glc_loc_put(5, 1, "Missing", -1);
                check(isaac_glc_loc_get(5, 1, "Missing", &loc) && loc == -1, "gl cache: -1 is an answer too");
                isaac_glc_loc_put(6, 0, "Position", 0);
                isaac_glc_loc_flush(5);
                check(!isaac_glc_loc_get(5, 1, "Transform", &loc), "gl cache: a link forgets the program's names");
                check(isaac_glc_loc_get(6, 0, "Position", &loc) && loc == 0, "gl cache: and keeps the other program's");
                { char longname[80]; memset(longname, 'a', 79); longname[79] = 0;
                  isaac_glc_loc_put(5, 1, longname, 1);
                  check(!isaac_glc_loc_get(5, 1, longname, &loc), "gl cache: a long name falls through"); }
                isaac_glc_reset();
            }

            /* Round 31: a file the guest writes reaches the persist hook on
             * fclose with its bytes and key; a delete reaches the unlink hook. */
            {
                typedef int (*persist_fn)(const char *, const char *, const uint8_t *, uint32_t);
                typedef int (*unlink_fn)(const char *, const char *);
                extern void isaac_fs_set_persist_hooks(persist_fn, unlink_fn);
                extern uint32_t isaac_fs_persisted(void);
                extern uint32_t isaac_fs_unlinked(void);
                isaac_fs_set_persist_hooks(selftest_persist, selftest_unlink);
                uint32_t p0 = isaac_fs_persisted(), u0 = isaac_fs_unlinked();
                g_persist_calls = 0; g_persist_len = 0; g_persist_key[0] = 0; g_unlink_calls = 0;
                uint32_t sbuf = dbuf + 0x500, sdata = dbuf + 0x600;
                const char *sp = "./Documents/My Games/Binding of Isaac Repentance+/persistentgamedata1.dat";
                for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(sbuf + i) = (uint8_t)sp[i]; if (!sp[i]) break; }
                *(uint8_t *)isaac_g(mbuf) = 'w'; *(uint8_t *)isaac_g(mbuf + 1) = 'b'; *(uint8_t *)isaac_g(mbuf + 2) = 0;
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sbuf); isaac_w32(cpu.ESP + 8, mbuf);
                imp_api_ms_win_crt_stdio__fopen(&cpu);
                uint32_t sfh = cpu.EAX;
                check(sfh != 0, "a save file opens for writing under Documents");
                for (unsigned i = 0; i < 5; ++i) *(uint8_t *)isaac_g(sdata + i) = (uint8_t)('A' + i);
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sdata); isaac_w32(cpu.ESP + 8, 1);
                isaac_w32(cpu.ESP + 12, 5); isaac_w32(cpu.ESP + 16, sfh);
                imp_api_ms_win_crt_stdio__fwrite(&cpu);
                check(cpu.EAX == 5u, "fwrite stores five bytes");
                check(g_persist_calls == 0, "nothing reaches the host before the close");
                memset(&cpu, 0, sizeof cpu); cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF); isaac_w32(cpu.ESP + 4, sfh);
                imp_api_ms_win_crt_stdio__fclose(&cpu);
                check(g_persist_calls == 1 && g_persist_len == 5 && memcmp(g_persist_data, "ABCDE", 5) == 0,
                      "fclose hands the written bytes to the persist hook");
                check(strstr(g_persist_key, "persistentgamedata1.dat") != NULL, "with the file's key");
                check(isaac_fs_persisted() == p0 + 1, "and the persisted count rises");
                FS_ATTR("./Documents/My Games/Binding of Isaac Repentance+/persistentgamedata1.dat"); imp_kernel32__DeleteFileA(&cpu);
                check(cpu.EAX == 1u && g_unlink_calls == 1 && isaac_fs_unlinked() == u0 + 1, "DeleteFileA reaches the unlink hook");
                isaac_fs_set_persist_hooks(NULL, NULL);
                *(uint8_t *)isaac_g(mbuf) = 'r'; *(uint8_t *)isaac_g(mbuf + 1) = 'b'; *(uint8_t *)isaac_g(mbuf + 2) = 0;   /* the tests below reopen with "rb" */
            }

            /* lazy: bytes come from the reader on first open, once */
            isaac_fs_set_lazy_reader(selftest_lazy_reader);
            g_lazy_calls = 0; g_lazy_src[0] = 0;
            check(isaac_fs_seed_lazy("data/Lazy.bin", 6) == 1, "a lazy entry registers with its size");
            check(g_lazy_calls == 0, "registering a lazy entry reads nothing");
            FS_ATTR("data/lazy.bin"); imp_kernel32__GetFileAttributesA(&cpu);
            check(cpu.EAX != 0xFFFFFFFFu, "the lazy entry is visible to stat before any read");
            uint32_t before_loads = isaac_fs_lazy_loads();
            for (int round = 0; round < 2; round++) {
                const char *lp = "data/lazy.bin";
                for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(pbuf + i) = (uint8_t)lp[i]; if (!lp[i]) break; }
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, pbuf);
                isaac_w32(cpu.ESP + 8, mbuf);
                imp_api_ms_win_crt_stdio__fopen(&cpu);
                uint32_t lh = cpu.EAX;
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, rbuf);
                isaac_w32(cpu.ESP + 8, 1);
                isaac_w32(cpu.ESP + 12, 6);
                isaac_w32(cpu.ESP + 16, lh);
                imp_api_ms_win_crt_stdio__fread(&cpu);
                if (round == 0)
                    check(lh && cpu.EAX == 6 && memcmp(isaac_g(rbuf), "LAZY!!", 6) == 0,
                          "fread of a lazy entry returns the reader's bytes");
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, lh);
                imp_api_ms_win_crt_stdio__fclose(&cpu);
            }
            check(g_lazy_calls == 1 && isaac_fs_lazy_loads() == before_loads + 1,
                  "the reader ran exactly once across two opens (bytes are kept)");
            check(strcmp(g_lazy_src, "data/Lazy.bin") == 0,
                  "the reader receives the seed path verbatim (case kept), not the normalised key");
            isaac_fs_set_lazy_reader(NULL);

            /* Round 24e/26: a windowed lazy file. 3 MB served through a C
             * positional reader in 1 MB windows: a read across the first
             * window edge and one across the file's short last window must be
             * byte-exact (the string table is the last entry of a 604 MB
             * archive), and the entry must never be loaded whole. */
            {
                extern void isaac_fs_set_lazy_preader(int (*fn)(const char *, uint8_t *, uint32_t, uint32_t));
                extern void isaac_fs_set_window_min(uint32_t bytes);
                extern uint32_t isaac_fs_lazy_windowed(void);
                uint32_t big = ISAAC_HEAP_VA + 0x100000u;      /* 300 KB of guest scratch */
                isaac_fs_set_lazy_preader(selftest_preader);
                isaac_fs_set_window_min(1u);
                check(isaac_fs_seed_lazy("data/Win.bin", WIN_FILE_SIZE) == 1, "a 3 MB lazy entry registers by size");
                uint32_t wbefore = isaac_fs_lazy_windowed(), pbefore = g_pread_calls;
                const char *wp = "data/Win.bin";
                for (unsigned i = 0; ; ++i) { *(uint8_t *)isaac_g(pbuf + i) = (uint8_t)wp[i]; if (!wp[i]) break; }
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, pbuf);
                isaac_w32(cpu.ESP + 8, mbuf);
                imp_api_ms_win_crt_stdio__fopen(&cpu);
                uint32_t wh = cpu.EAX;
                check(wh != 0 && g_pread_calls == pbefore, "opening it fetches nothing: bytes come on the first read");
                static const struct { uint32_t off, len; const char *what; } reads[] = {
                    { 1047000u, 4000u, "a read across the first 1 MB window edge is byte-exact" },
                    { WIN_FILE_SIZE - 300000u, 300000u, "a read across the short last window is byte-exact" },
                    { 5u, 3u, "a small read far back lands in a still-resident window, byte-exact" },
                };
                for (unsigned r = 0; r < sizeof reads / sizeof reads[0]; ++r) {
                    memset(&cpu, 0, sizeof cpu);
                    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                    isaac_w32(cpu.ESP, 0xDEADBEEF);
                    isaac_w32(cpu.ESP + 4, wh);
                    isaac_w32(cpu.ESP + 8, reads[r].off);
                    isaac_w32(cpu.ESP + 12, 0);                       /* SEEK_SET */
                    imp_api_ms_win_crt_stdio__fseek(&cpu);
                    memset(&cpu, 0, sizeof cpu);
                    cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                    isaac_w32(cpu.ESP, 0xDEADBEEF);
                    isaac_w32(cpu.ESP + 4, big);
                    isaac_w32(cpu.ESP + 8, 1);
                    isaac_w32(cpu.ESP + 12, reads[r].len);
                    isaac_w32(cpu.ESP + 16, wh);
                    imp_api_ms_win_crt_stdio__fread(&cpu);
                    int exact = (cpu.EAX == reads[r].len);
                    for (uint32_t i = 0; exact && i < reads[r].len; ++i)
                        if (*(uint8_t *)isaac_g(big + i) != win_byte(reads[r].off + i)) exact = 0;
                    check(exact, reads[r].what);
                }
                check(g_pread_calls - pbefore >= 3u && g_pread_calls - pbefore <= 6u,
                      "the three reads cost a handful of window refills, not one host read per fread");
                check(isaac_fs_lazy_windowed() == wbefore + 1, "the entry was served windowed, never loaded whole");
                { extern void isaac_fs_window_stats(uint32_t *, uint32_t *); uint32_t wf = 0, wh2 = 0; isaac_fs_window_stats(&wf, &wh2);
                  check(g_pread_calls - pbefore == 3u, "round 41: three windows touched, three host reads -- the far-back read found window 0 still resident (LRU slots, not two)");
                  check(wf >= 3u && wh2 >= 1u, "round 41: the window census counts the fills and the resident hits"); }
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, wh);
                imp_api_ms_win_crt_stdio__fclose(&cpu);
                isaac_fs_set_lazy_preader(NULL);
                isaac_fs_set_window_min(0u);
            }
            #undef FS_ATTR
        }

        /* "." segments must collapse. The game probes its own cwd as "./"
         * during the save-data setup; that was normalising to the key
         * "c:/isaac/." and missing, so the probe reported "no such
         * directory" for the directory everything else resolves against.
         * Found with ISAAC_FS_TRACE=1 on a boot run. */
        static const char *const dotforms[] = {
            "./resources/packed", "resources/./packed", "./resources/./packed/",
        };
        for (unsigned k = 0; k < sizeof dotforms / sizeof dotforms[0]; ++k) {
            for (unsigned i = 0; ; ++i) {
                *(uint8_t *)isaac_g(dbuf + i) = (uint8_t)dotforms[k][i];
                if (!dotforms[k][i]) break;
            }
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, dbuf);
            imp_kernel32__GetFileAttributesA(&cpu);
            check(cpu.EAX == 0x10u, "a '.' segment collapses to the same dir key");
        }
        /* the bare cwd, in both spellings, is the FS root and always exists */
        static const char *const cwdforms[] = { ".", "./" };
        for (unsigned k = 0; k < 2; ++k) {
            for (unsigned i = 0; ; ++i) {
                *(uint8_t *)isaac_g(dbuf + i) = (uint8_t)cwdforms[k][i];
                if (!cwdforms[k][i]) break;
            }
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, dbuf);
            imp_kernel32__GetFileAttributesA(&cpu);
            check(cpu.EAX == 0x10u, "the bare cwd reads as a directory");
        }
    }

    /* 14. THE WIDE DIRECTORY SCAN THAT BUILDS KAGE'S MOUNT INDEX.
     * The engine's readdir (0x00a172e0 / opendir 0x00a16f50) lists a directory
     * with mbstowcs_s -> GetFullPathNameW -> "\*" -> FindFirstFileW, walks it
     * with FindNextFileW through a register-held import, and brings each
     * cFileName back with wcstombs_s. KAGE init scans the root that way to
     * fill the std::map every relative path resolves through (0x00a16c60).
     * With FindFirstFileW a stub the map stayed empty and all 18 packed
     * archives "Failed to open" before any fopen (boot round 9). Each check
     * here is one link of that chain against the SAME RAM-FS the game sees. */
    {
        extern int isaac_fs_seed(const char *path, const uint8_t *data, uint32_t len);
        static const uint8_t payload2[] = { 'A','R','C','H', 2, 0, 0, 0, 0x11, 0x22 };
        check(isaac_fs_seed("resources/packed/animations.a", payload2,
                            (uint32_t)sizeof payload2) == 1,
              "a second archive seeds beside the first");

        uint32_t wpat = ISAAC_HEAP_VA + 0x54000, wfd = wpat + 0x400;
        uint32_t mb = wfd + 0x300, pret = mb + 0x120;
        /* the exact shape 0x00a16f50 produces: full path + backslash + star */
        static const char pat[] = "c:\\isaac\\resources\\packed\\*";
        unsigned i;
        for (i = 0; pat[i]; ++i) isaac_w16(wpat + 2 * i, (uint16_t)(uint8_t)pat[i]);
        isaac_w16(wpat + 2 * i, 0);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, wpat);
        isaac_w32(cpu.ESP + 8, wfd);
        imp_kernel32__FindFirstFileW(&cpu);
        uint32_t fh = cpu.EAX;
        check(fh != 0xFFFFFFFFu, "FindFirstFileW opens the seeded dir from a wide backslash-star pattern");
        check(isaac_r32(wfd) == 0x80u, "the first entry is a regular file (attr 0x80)");
        /* 20 = the section-13 graphics.a payload; the other is payload2 */
        check(isaac_r32(wfd + 0x20u) == 20u || isaac_r32(wfd + 0x20u) == sizeof payload2,
              "nFileSizeLow carries the seeded length");
        check(isaac_r16(wfd + 0x234u) == 0, "cAlternateFileName is empty");

        /* wcstombs_s(&ret, mb, 0x104, cFileName, 0x104) -- the readdir form */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, pret);
        isaac_w32(cpu.ESP + 8, mb);
        isaac_w32(cpu.ESP + 12, 0x104);
        isaac_w32(cpu.ESP + 16, wfd + 0x2cu);
        isaac_w32(cpu.ESP + 20, 0x104);
        imp_api_ms_win_crt_convert__wcstombs_s(&cpu);
        check(cpu.EAX == 0, "wcstombs_s converts cFileName without error");
        const char *name1 = (const char *)isaac_g(mb);
        int name1_ok = strcmp(name1, "graphics.a") == 0 || strcmp(name1, "animations.a") == 0;
        check(name1_ok, "cFileName round-trips as one of the seeded basenames");
        check(isaac_r32(pret) == (uint32_t)strlen(name1) + 1u,
              "wcstombs_s reports the length INCLUDING the terminator (readdir stores ret-1)");
        char first[64];
        strncpy(first, name1, sizeof first - 1); first[sizeof first - 1] = 0;

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, fh);
        isaac_w32(cpu.ESP + 8, wfd);
        imp_kernel32__FindNextFileW(&cpu);
        check(cpu.EAX == 1, "FindNextFileW yields the second seeded file");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, pret);
        isaac_w32(cpu.ESP + 8, mb);
        isaac_w32(cpu.ESP + 12, 0x104);
        isaac_w32(cpu.ESP + 16, wfd + 0x2cu);
        isaac_w32(cpu.ESP + 20, 0x104);
        imp_api_ms_win_crt_convert__wcstombs_s(&cpu);
        check(cpu.EAX == 0 && strcmp((const char *)isaac_g(mb), first) != 0 &&
              (strcmp((const char *)isaac_g(mb), "graphics.a") == 0 ||
               strcmp((const char *)isaac_g(mb), "animations.a") == 0),
              "the second entry is the OTHER seeded basename");

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, fh);
        isaac_w32(cpu.ESP + 8, wfd);
        imp_kernel32__FindNextFileW(&cpu);
        check(cpu.EAX == 0, "a third FindNextFileW is exhausted (ERROR_NO_MORE_FILES)");
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, fh);
        imp_kernel32__FindClose(&cpu);
        check(cpu.EAX == 1, "FindClose releases the wide handle");

        /* the KAGE root scan: mbstowcs("./") -> GetFullPathNameW -> "c:/isaac/./"
         * (already slash-terminated, so the game appends only "*"). It must land
         * on the FS root and enumerate "resources" as a directory. */
        static const char rootpat[] = "c:/isaac/./*";
        for (i = 0; rootpat[i]; ++i) isaac_w16(wpat + 2 * i, (uint16_t)(uint8_t)rootpat[i]);
        isaac_w16(wpat + 2 * i, 0);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, wpat);
        isaac_w32(cpu.ESP + 8, wfd);
        imp_kernel32__FindFirstFileW(&cpu);
        fh = cpu.EAX;
        check(fh != 0xFFFFFFFFu, "the root pattern 'c:/isaac/./*' opens the FS root");
        int saw_resources_dir = 0;
        for (unsigned guard = 0; fh != 0xFFFFFFFFu && guard < 200; ++guard) {
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, pret);
            isaac_w32(cpu.ESP + 8, mb);
            isaac_w32(cpu.ESP + 12, 0x104);
            isaac_w32(cpu.ESP + 16, wfd + 0x2cu);
            isaac_w32(cpu.ESP + 20, 0x104);
            imp_api_ms_win_crt_convert__wcstombs_s(&cpu);
            if (cpu.EAX == 0 && strcmp((const char *)isaac_g(mb), "resources") == 0 &&
                isaac_r32(wfd) == 0x10u)
                saw_resources_dir = 1;
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, fh);
            isaac_w32(cpu.ESP + 8, wfd);
            imp_kernel32__FindNextFileW(&cpu);
            if (cpu.EAX != 1) break;
        }
        check(saw_resources_dir, "the root scan lists 'resources' as a directory (attr 0x10)");

        /* 15. GetFullPathNameW's two-call size protocol, exactly as opendir
         * 0x00a16f50 drives it: a NULL/0 query must return the required
         * WCHAR count INCLUDING the terminator (the game mallocs n*2+0x10 and
         * calls again with n); the sized call returns the length WITHOUT the
         * terminator and writes it. Returning 0 on the query is what stopped
         * the whole mount-root scan before FindFirstFileW (boot round 10). */
        static const char rel[] = "./";
        for (i = 0; rel[i]; ++i) isaac_w16(wpat + 2 * i, (uint16_t)(uint8_t)rel[i]);
        isaac_w16(wpat + 2 * i, 0);
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, wpat);       /* name   */
        isaac_w32(cpu.ESP + 8, 0);          /* nBufferLength = 0 */
        isaac_w32(cpu.ESP + 12, 0);         /* buffer = NULL */
        isaac_w32(cpu.ESP + 16, 0);         /* lpFilePart = NULL */
        imp_kernel32__GetFullPathNameW(&cpu);
        uint32_t need = cpu.EAX;
        /* "c:/isaac/./" = 11 WCHARs + terminator */
        check(need == 12u, "GetFullPathNameW(name, 0, NULL) returns the required size INCLUDING the terminator");

        uint32_t wout = wfd;                /* reuse the find buffer as scratch */
        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, wpat);
        isaac_w32(cpu.ESP + 8, 4);          /* too small */
        isaac_w32(cpu.ESP + 12, wout);
        isaac_w32(cpu.ESP + 16, 0);
        imp_kernel32__GetFullPathNameW(&cpu);
        check(cpu.EAX == 12u, "a too-small buffer also returns the required size");

        memset(&cpu, 0, sizeof cpu);
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        isaac_w32(cpu.ESP, 0xDEADBEEF);
        isaac_w32(cpu.ESP + 4, wpat);
        isaac_w32(cpu.ESP + 8, need);       /* exactly what the query asked for */
        isaac_w32(cpu.ESP + 12, wout);
        isaac_w32(cpu.ESP + 16, 0);
        imp_kernel32__GetFullPathNameW(&cpu);
        check(cpu.EAX == 11u, "the sized call returns the length WITHOUT the terminator");
        static const char expect_full[] = "c:/isaac/./";
        int full_ok = 1;
        for (i = 0; i <= 11; ++i)
            if (isaac_r16(wout + 2 * i) != (uint16_t)(uint8_t)expect_full[i]) { full_ok = 0; break; }
        check(full_ok, "the sized call writes L\"c:/isaac/./\" NUL-terminated (the cwd-resolved form)");

        /* 16. CAPACITY. The install's loose resources/ tree is 476 files in 21
         * dirs (gfx/ui alone has 143 children) plus the archives and the save
         * dir the game creates; the old 512-slot table and 128-per-scan cap
         * overflowed silently (a seed returning 0, a scan listing 128 of 143).
         * Seed 700 small files into one directory and require every one of
         * them to be enumerable and openable. */
        {
            static const uint8_t tiny[] = { 'x' };
            int seeded_all = 1;
            char name[64];
            for (unsigned k = 0; k < 700; ++k) {
                snprintf(name, sizeof name, "resources/many/f%03u.txt", k);
                if (isaac_fs_seed(name, tiny, 1) != 1) { seeded_all = 0; break; }
            }
            check(seeded_all, "700 files seed into one directory (table capacity)");
            static const char manypat[] = "c:\\isaac\\resources\\many\\*";
            for (i = 0; manypat[i]; ++i) isaac_w16(wpat + 2 * i, (uint16_t)(uint8_t)manypat[i]);
            isaac_w16(wpat + 2 * i, 0);
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, wpat);
            isaac_w32(cpu.ESP + 8, wfd);
            imp_kernel32__FindFirstFileW(&cpu);
            uint32_t hh = cpu.EAX;
            unsigned listed = (hh != 0xFFFFFFFFu) ? 1u : 0u;
            while (hh != 0xFFFFFFFFu && listed < 5000) {
                memset(&cpu, 0, sizeof cpu);
                cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
                isaac_w32(cpu.ESP, 0xDEADBEEF);
                isaac_w32(cpu.ESP + 4, hh);
                isaac_w32(cpu.ESP + 8, wfd);
                imp_kernel32__FindNextFileW(&cpu);
                if (cpu.EAX != 1) break;
                ++listed;
            }
            check(listed == 700u, "a directory scan lists all 700 (per-scan cap)");
            /* and the last one opens by its narrow path through the same fopen */
            const char *lastp = "resources/many/f699.txt";
            for (i = 0; ; ++i) { *(uint8_t *)isaac_g(mb + i) = (uint8_t)lastp[i]; if (!lastp[i]) break; }
            const char *mode = "rb";
            for (i = 0; ; ++i) { *(uint8_t *)isaac_g(pret + i) = (uint8_t)mode[i]; if (!mode[i]) break; }
            memset(&cpu, 0, sizeof cpu);
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
            isaac_w32(cpu.ESP, 0xDEADBEEF);
            isaac_w32(cpu.ESP + 4, mb);
            isaac_w32(cpu.ESP + 8, pret);
            imp_api_ms_win_crt_stdio__fopen(&cpu);
            check(cpu.EAX != 0, "the 700th seeded file opens by path");
        }
    }

    /* 17. THE MSVC IOSTREAM LAYER (msvcp140) on the game's own object shape.
     * The game's std::stringstream (ctor 0x00684ce0) is 0x68 bytes: istream
     * vbptr @0 -> {0,0x68}, ostream vbptr @0x10 -> {0,0x58}, basic_stringbuf
     * @0x18 (basic_streambuf 0x38 + _Seekhigh/_Mystate), basic_ios @0x68. It
     * calls basic_ios(), basic_iostream(sb, most_derived=0), basic_streambuf()
     * in that order, then reads through _Ipfx/sgetc/sbumpc/snextc/setstate.
     * Every shim below must locate basic_ios as this + [[this]+4] and touch
     * the streambuf only through its indirection pointers (abi-notes.md). */
    {
#define MS(name) imp_msvcp140_##name
#define CALL_THIS(fn, self, ...) do {                                     \
            uint32_t _a[] = { 0, ##__VA_ARGS__ };                            \
            memset(&cpu, 0, sizeof cpu);                                     \
            cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;                           \
            isaac_w32(cpu.ESP, 0xDEADBEEF);                                  \
            for (unsigned _i = 1; _i < sizeof _a / sizeof _a[0]; ++_i)       \
                isaac_w32(cpu.ESP + 4u * _i, _a[_i]);                        \
            cpu.ECX = (self);                                                \
            fn(&cpu);                                                        \
        } while (0)
        const uint32_t ss = ISAAC_HEAP_VA + 0x60000, sb = ss + 0x18, B = ss + 0x68;
        const uint32_t vbt_is = ss + 0x100, vbt_os = ss + 0x108, vtbl = ss + 0x120;
        const uint32_t inbuf = ss + 0x200, outbuf = ss + 0x240, val = ss + 0x280;
        unsigned i;
        for (uint32_t k = 0; k < 0x300; k += 4) isaac_w32(ss + k, 0);
        isaac_w32(vbt_is, 0); isaac_w32(vbt_is + 4, 0x68);      /* game vbtables */
        isaac_w32(vbt_os, 0); isaac_w32(vbt_os + 4, 0x58);
        isaac_w32(ss, vbt_is); isaac_w32(ss + 0x10, vbt_os);
        /* Mirror the game's basic_stringbuf vtable at 0xb1b190: the class's own
         * overrides (dtor, overflow, pbackfail, underflow, seekoff, seekpos) are
         * real code -> marker VAs the stub answers with EOF; the base-class
         * virtuals (_Lock, _Unlock, showmanyc, uflow, xsgetn, xsputn, setbuf,
         * sync, imbue) are IAT jump thunks in 0x00aef065..0x00aef0a1, which the
         * shims recognise and answer in-line. */
        for (unsigned s = 0; s < 15; ++s) isaac_w32(vtbl + 4 * s, SELFTEST_VCALL_EOF);
        for (unsigned s = 0; s < 15; ++s)
            if (s == 1 || s == 2 || s == 5 || s == 7 || s == 8 || s == 9 || s == 12 || s == 13 || s == 14)
                isaac_w32(vtbl + 4 * s, 0x00aef06bu);

        CALL_THIS(MS(___0__basic_ios_DU__char_traits_D_std___std__IAE_XZ), B);
        check(cpu.EAX == B && isaac_r32(B) == 0x10002f84u && isaac_r32(B + 0x0c) == 0 &&
              isaac_r32(B + 0x38) == 0 && isaac_r32(B + 0x3c) == 0,
              "basic_ios() zeroes ios_base and its three fields, returns this");
        CALL_THIS(MS(___0__basic_iostream_DU__char_traits_D_std___std__QAE_PAV__basic_streambuf_DU__char_traits_D_std___1__Z), ss, sb, 0);
        check(cpu.EAX == ss && isaac_r32(ss + 8) == 0 && isaac_r32(ss + 0xc) == 0,
              "basic_iostream(sb,0) returns this and zeroes _Chcount");
        check(isaac_r32(B + 0x38) == sb && isaac_r32(B + 0x0c) == 0 && isaac_r32(B + 0x14) == 0x201 &&
              isaac_r32(B + 0x18) == 6 && isaac_r32(B + 0x30) != 0 && isaac_r8(B + 0x40) == ' ',
              "basic_ios::init via the vbptr: rdbuf, good, skipws|dec, prec 6, locale, fill ' '");
        check(isaac_r32(B) == 0x100053f4u && isaac_r32(B - 4) == 0x68 - 0x20,
              "iostream ctor leaves the iostream basic_ios vptr and vtordisp (d-0x20)");
        check(isaac_r32(ss) == vbt_is && isaac_r32(ss + 0x10) == vbt_os,
              "most_derived=0 leaves the game's vbtables alone");
        CALL_THIS(MS(___0__basic_streambuf_DU__char_traits_D_std___std__IAE_XZ), sb);
        check(cpu.EAX == sb && isaac_r32(sb) == 0x10002f9cu && isaac_r32(sb + 0x1c) == sb + 0x14 &&
              isaac_r32(sb + 0x2c) == sb + 0x24 && isaac_r32(sb + 0x20) == sb + 0x18 &&
              isaac_r32(sb + 0x30) == sb + 0x28 && isaac_r32(sb + 0x34) != 0,
              "basic_streambuf(): indirection pointers at the in-object slots, locale allocated");

        /* the game-side stringbuf: its own vtable + a get area "  12 abc" */
        isaac_w32(sb, vtbl);
        static const char text[] = "  12 abc";
        for (i = 0; text[i]; ++i) *(uint8_t *)isaac_g(inbuf + i) = (uint8_t)text[i];
        isaac_w32(isaac_r32(sb + 0x0c), inbuf);            /* *_IGfirst */
        isaac_w32(isaac_r32(sb + 0x1c), inbuf);            /* *_IGnext  */
        isaac_w32(isaac_r32(sb + 0x2c), (uint32_t)(sizeof text - 1));   /* *_IGcount */

        CALL_THIS(MS(___Ipfx___basic_istream_DU__char_traits_D_std___std__QAE_N_N_Z), ss, 0);
        check((cpu.EAX & 0xff) == 1 && isaac_r32(isaac_r32(sb + 0x1c)) == inbuf + 2,
              "_Ipfx skips leading whitespace through the indirection pointers");
        CALL_THIS(MS(__sgetc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ), sb);
        check(cpu.EAX == '1', "sgetc peeks without consuming");
        isaac_w32(val, 0xdeadbeefu); isaac_w32(val + 4, 0xdeadbeefu);
        CALL_THIS(MS(___5__basic_istream_DU__char_traits_D_std___std__QAEAAV01_AA_K_Z), ss, val);
        check(cpu.EAX == ss && isaac_r32(val) == 12 && isaac_r32(val + 4) == 0 && isaac_r32(B + 0x0c) == 0,
              "operator>>(unsigned __int64&) parses 12, stream stays good");
        CALL_THIS(MS(___Ipfx___basic_istream_DU__char_traits_D_std___std__QAE_N_N_Z), ss, 0);
        CALL_THIS(MS(__sbumpc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ), sb);
        check(cpu.EAX == 'a' && isaac_r32(isaac_r32(sb + 0x2c)) == 2, "sbumpc consumes 'a' and decrements the count");
        CALL_THIS(MS(__snextc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ), sb);
        check(cpu.EAX == 'c' && isaac_r32(isaac_r32(sb + 0x2c)) == 1, "snextc advances past 'b' and peeks 'c'");
        CALL_THIS(MS(__sbumpc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ), sb);
        check(cpu.EAX == 'c' && isaac_r32(isaac_r32(sb + 0x2c)) == 0, "sbumpc takes the last char");
        unsigned before = g_vcalls;
        CALL_THIS(MS(__sbumpc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ), sb);
        check(cpu.EAX == 0xFFFFFFFFu && g_vcalls == before + 1,
              "an empty get area dispatches uflow through the object's vtable (EOF)");
        CALL_THIS(MS(___5__basic_istream_DU__char_traits_D_std___std__QAEAAV01_AA_K_Z), ss, val);
        check((isaac_r32(B + 0x0c) & 3) == 3 && isaac_r32(val) == 12,
              "operator>> at end of input sets eof|fail and leaves the value untouched");
        isaac_w32(B + 0x0c, 0);
        CALL_THIS(MS(__setstate___basic_ios_DU__char_traits_D_std___std__QAEXH_N_Z), B, 2, 0);
        check(isaac_r32(B + 0x0c) == 2, "setstate(failbit) with a live rdbuf adds no badbit");
        isaac_w32(B + 0x0c, 0);

        /* digits running straight into EOF: the number parses, eofbit is set by
         * the digit loop itself (not by _Ipfx), and failbit is NOT set */
        *(uint8_t *)isaac_g(inbuf + 0x20) = '7'; *(uint8_t *)isaac_g(inbuf + 0x21) = '7';
        isaac_w32(isaac_r32(sb + 0x1c), inbuf + 0x20);
        isaac_w32(isaac_r32(sb + 0x2c), 2);
        isaac_w32(val, 0);
        CALL_THIS(MS(___5__basic_istream_DU__char_traits_D_std___std__QAEAAV01_AA_K_Z), ss, val);
        check(isaac_r32(val) == 77 && isaac_r32(B + 0x0c) == 1,
              "operator>> parsing up to EOF yields the value with eofbit only");
        isaac_w32(B + 0x0c, 0);

        /* output side: a 16-byte put area */
        isaac_w32(isaac_r32(sb + 0x10), outbuf);           /* *_IPfirst */
        isaac_w32(isaac_r32(sb + 0x20), outbuf);           /* *_IPnext  */
        isaac_w32(isaac_r32(sb + 0x30), 16);               /* *_IPcount */
        isaac_w32(B + 0x14, 0x201 | 0x800 | 0x008 | 0x004); /* hex|showbase|uppercase */
        isaac_w32(B + 0x14, (isaac_r32(B + 0x14) & ~0x200u));
        CALL_THIS(MS(___6__basic_ostream_DU__char_traits_D_std___std__QAEAAV01__K_Z), ss, 0xff, 0);
        check(cpu.EAX == ss && memcmp(isaac_g(outbuf), "0XFF", 4) == 0 &&
              isaac_r32(isaac_r32(sb + 0x20)) == outbuf + 4 && isaac_r32(isaac_r32(sb + 0x30)) == 12,
              "operator<<(unsigned __int64) formats hex|showbase|uppercase into the put area");
        isaac_w32(B + 0x14, 0x201);
        isaac_w32(B + 0x20, 6); *(uint8_t *)isaac_g(B + 0x40) = '.';
        CALL_THIS(MS(___6__basic_ostream_DU__char_traits_D_std___std__QAEAAV01__K_Z), ss, 42, 0);
        check(memcmp(isaac_g(outbuf + 4), "....42", 6) == 0 && isaac_r32(B + 0x20) == 0,
              "width 6 right-adjusts with the fill char and resets width to 0");
        for (i = 0; i < 2; ++i) *(uint8_t *)isaac_g(val + i) = "hi"[i];
        CALL_THIS(MS(__write___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_PBD_J_Z), ss, val, 2, 0);
        CALL_THIS(MS(__put___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_D_Z), ss, '!');
        check(memcmp(isaac_g(outbuf), "0XFF....42hi!", 13) == 0 && isaac_r32(B + 0x0c) == 0,
              "write/put append through sputn/sputc, stream good");
        isaac_w32(isaac_r32(sb + 0x30), 0);                /* put area full -> overflow virtual */
        before = g_vcalls;
        CALL_THIS(MS(__put___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_D_Z), ss, 'x');
        check(g_vcalls == before + 1 && (isaac_r32(B + 0x0c) & 4) == 4,
              "a full put area dispatches overflow; EOF from it sets badbit");
        isaac_w32(B + 0x0c, 0);
        CALL_THIS(MS(__flush___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_XZ), ss);
        check(cpu.EAX == ss && isaac_r32(B + 0x0c) == 0, "flush syncs through the vtable and stays good");

        /* destruction in the game's order: ~iostream (ecx=obj+0x20), ~ios, ~streambuf */
        CALL_THIS(MS(___1__basic_iostream_DU__char_traits_D_std___std__UAE_XZ), ss + 0x20);
        check(isaac_r32(B) == 0x10003060u && isaac_r32(B - 4) == 0x68 - 0x18,
              "~basic_iostream takes the vbase-adjusted this and rewinds vptr/vtordisp");
        CALL_THIS(MS(___1__basic_ios_DU__char_traits_D_std___std__UAE_XZ), B);
        check(isaac_r32(B + 0x30) == 0, "~basic_ios frees the ios_base locale");
        CALL_THIS(MS(___1__basic_streambuf_DU__char_traits_D_std___std__UAE_XZ), sb);
        check(isaac_r32(sb + 0x34) == 0, "~basic_streambuf frees the streambuf locale");
#undef CALL_THIS
#undef MS
    }

    isaac_module_report();

    isaac_heap_report();
    isaac_stub_report();
    printf("--- %s (%d failure%s) ---\n", g_fail ? "FAILED" : "PASSED",
           g_fail, g_fail == 1 ? "" : "s");
    return g_fail ? 1 : 0;
}
