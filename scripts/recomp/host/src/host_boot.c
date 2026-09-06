/* host_boot.c -- the ordered boot procedure.
 *
 * A raw snapshot of .text/.rdata/.data is a correct STARTING image but not a
 * runnable one. Three things the PE loader and the CRT would have done are
 * missing, and lifted code that runs without them reads garbage globals:
 *
 *   (1) 650 IAT slots hold unbound name RVAs on disk.
 *   (2) 1 TLS callback has never run.
 *   (3) 4 C and 117 C++ static initialisers have never run.
 *
 * The ordering below is not arbitrary. It is what Windows does, and each step
 * depends on the previous one:
 *
 *   1. place sections            image bytes at their VAs, BSS tail zeroed
 *   2. relocations               SKIPPED -- see note, this image must not move
 *   3. bind IAT                  650 slots <- shim tokens
 *   4. install fake TEB/GDT      fs:[0] must read as an SEH chain head
 *   5. run TLS callback          DLL_PROCESS_ATTACH, before the entry point
 *   6. run _initterm tables      XI (4 C inits) THEN XC (117 C++ inits)
 *   7. call main                 0x00931050
 *
 * Step 5 before step 6 matters: on Windows the loader runs TLS callbacks
 * before the entry point is entered at all, so a callback that touches a
 * global sees PRE-constructor state. Running it after _initterm would give it
 * post-constructor state and could change behaviour.
 *
 * Step 6's internal order is the subtle one. In memory the C++ table sits BELOW
 * the C table (0x00b18a2c < 0x00b18c10) because .CRT section names sort
 * alphabetically and XC < XI. But __scrt_common_main_seh calls
 * _initterm_e(__xi_a, __xi_z) FIRST and _initterm(__xc_a, __xc_z) second, so
 * the C table runs first despite living at the higher address. Sorting the two
 * tables by address and running them in that order would silently invert
 * initialisation.
 */

#include "isaac_host.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <emscripten.h>

/* Supplied by the memory-image loader (JS or the wasm data module). */
extern int  isaac_image_is_loaded(void);
extern void isaac_gl_reset_state(void);

static int g_booted;
static isaac_boot_opts g_opts;

/* ------------------------------------------------------------------ 1 ----- */
/* Section placement is done by the memory-image loader before any of this
 * runs -- see memimage.py. All this does is verify the result, because every
 * later step assumes it. */

static int verify_image(void) {
    /* 'MZ' at the image base proves the headers were placed. __scrt_is_managed_app
     * dereferences __ImageBase and walks the optional header, so the headers are
     * load-bearing rather than decorative. */
    if (isaac_r16(ISAAC_IMAGE_BASE) != 0x5A4D) {
        isaac_log("[isaac][boot] FATAL: no 'MZ' at image base 0x%08x -- the "
                  "memory image was not placed.", ISAAC_IMAGE_BASE);
        return 0;
    }
    /* Host static data must live ABOVE the guard, not merely outside the image.
     * The lifter has already seen one wild guest write corrupt the dispatch
     * table and cascade into 1,429 bogus downstream failures, so this is the
     * single most valuable assertion in the boot path: if it fires, the
     * runtime and the guest are sharing a blast radius. */
    static const char probe = 0;
    uint32_t host_va = isaac_va(&probe);
    if (host_va < ISAAC_HOST_BASE_VA) {
        isaac_log("[isaac][boot] FATAL: host static data at 0x%08x is below the "
                  "host base 0x%08x -- it is inside the guest's writable range "
                  "and a wild guest pointer can corrupt the runtime. Rebuild "
                  "with -sGLOBAL_BASE=%u.",
                  host_va, ISAAC_HOST_BASE_VA, ISAAC_HOST_BASE_VA);
        return 0;
    }
    if (g_opts.verbose)
        isaac_log("[isaac][boot] host static data at 0x%08x, %u MiB above the "
                  "guest limit 0x%08x", host_va,
                  (host_va - ISAAC_GUEST_LIMIT_VA) >> 20, ISAAC_GUEST_LIMIT_VA);

    /* Every fixed guest-side region must actually be on the guest side. */
    struct { const char *name; uint32_t lo, hi; } gr[] = {
        {"image",       ISAAC_IMAGE_BASE, ISAAC_IMAGE_END},
        {"guest heap",  ISAAC_HEAP_VA,    ISAAC_HEAP_VA + ISAAC_HEAP_SIZE},
        {"guest stack", ISAAC_STACK_TOP_VA - ISAAC_STACK_SIZE, ISAAC_STACK_TOP_VA},
        {"TEB/PEB/TLS", ISAAC_TEB_VA,     ISAAC_TLS_ARRAY_VA + 0x1000},
        {"shim tokens", ISAAC_SHIM_BASE,
                        ISAAC_SHIM_BASE + isaac_import_count * ISAAC_SHIM_STRIDE},
    };
    for (unsigned i = 0; i < sizeof gr / sizeof gr[0]; ++i) {
        if (!isaac_is_guest_va(gr[i].lo) || gr[i].hi > ISAAC_GUEST_LIMIT_VA) {
            isaac_log("[isaac][boot] FATAL: region '%s' 0x%08x..0x%08x crosses "
                      "the guest limit 0x%08x", gr[i].name, gr[i].lo, gr[i].hi,
                      ISAAC_GUEST_LIMIT_VA);
            return 0;
        }
        for (unsigned j = i + 1; j < sizeof gr / sizeof gr[0]; ++j) {
            if (gr[i].lo < gr[j].hi && gr[j].lo < gr[i].hi) {
                isaac_log("[isaac][boot] FATAL: regions '%s' and '%s' overlap",
                          gr[i].name, gr[j].name);
                return 0;
            }
        }
    }
    /* .text must be non-empty at its first byte and the entry point readable. */
    if (!isaac_in_image(ISAAC_ENTRY_VA) || !isaac_in_image(ISAAC_MAIN_VA)) {
        isaac_log("[isaac][boot] FATAL: entry/main outside the image.");
        return 0;
    }
    return 1;
}

/* ------------------------------------------------------------------ 2 ----- */
/* Relocations: deliberately NOT applied.
 *
 * The image requests ASLR (DllCharacteristics 0x8140 has DYNAMIC_BASE) and
 * carries a full fixup table -- 181,854 entries, 180,939 HIGHLOW. Mapping at
 * the preferred base 0x00400000 makes every one of them a no-op, which is the
 * correct choice here for a reason beyond convenience:
 *
 * THIS BINARY HAS THREE RELOCATION ENTRIES THAT WOULD CORRUPT CODE IF APPLIED.
 * At RVAs 0x00531148, 0x00680633 and 0x00680d3a the fixup targets land in the
 * middle of instructions. They are self-inflicted: earlier phases of this
 * project hand-patched the binary (21 byte-runs vs the pristine snapshot) and
 * the patches overwrote instructions whose operands the .reloc table still
 * points at. The pristine tools/isaac-ng.unpacked.exe.pre-coinit has 0 invalid
 * HIGHLOW entries; this one has 3.
 *
 * So: identity mapping is not just simplest, it is the only variant that is
 * correct for the binary actually being lifted. */

static int apply_relocations_unsupported(void) {
    isaac_log("[isaac][boot] relocations requested, but this image must be "
              "mapped at its preferred base 0x%08x: 3 HIGHLOW fixups "
              "(rva 0x531148, 0x680633, 0x680d3a) point into the middle of "
              "instructions and would corrupt .text.", ISAAC_IMAGE_BASE);
    return 0;
}

/* ------------------------------------------------------------------ 3 ----- */

int isaac_boot_bind_iat(void) {
    unsigned bound = 0, outside = 0;
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        isaac_import *imp = &isaac_imports[i];
        /* Dynamic rows (version.dll!VerifyVersionInfoA) have no IAT slot;
         * they are resolved via LoadLibraryA+GetProcAddress at runtime. */
        if (!imp->iat_slot_va)
            continue;
        if (!isaac_in_image(imp->iat_slot_va)) {
            isaac_log("[isaac][boot] IAT slot 0x%08x for %s!%s is outside the "
                      "image", imp->iat_slot_va, imp->dll, imp->symbol);
            ++outside;
            continue;
        }
        /* On disk the slot holds the RVA of an IMAGE_IMPORT_BY_NAME. We
         * overwrite it with the shim token; isaac_indirect_call() recognises
         * anything in [ISAAC_SHIM_BASE, +count*stride). */
        isaac_w32(imp->iat_slot_va, imp->shim_va);
        ++bound;
    }
    if (g_opts.verbose)
        isaac_log("[isaac][boot] IAT: bound %u/%u slots (%u outside image)",
                  bound, isaac_import_count, outside);
    return outside == 0;
}

/* ------------------------------------------------------------------ 4 ----- */
/* The fake TEB.
 *
 * 1,833 call sites reach __CxxFrameHandler3 and the binary uses fs:[0]-based
 * SEH frames. The mitigating discovery from the lifter is that SLEIGH models
 * fs:[0] as plain FS_OFFSET+0, so `mov eax, fs:[0]` lifts to an ordinary load
 * from cpu->FS_OFFSET. That means the registration chain needs no special
 * handling at all -- it just needs somewhere real to point.
 *
 * Layout mirrors the parts of the real 32-bit TEB that MSVC-generated code and
 * the CRT actually touch:
 *    +0x00  ExceptionList        head of the SEH chain (0xFFFFFFFF = end)
 *    +0x04  StackBase
 *    +0x08  StackLimit
 *    +0x18  Self                 TEB linear address (fs:[0x18] idiom)
 *    +0x24  ThreadId
 *    +0x2C  ThreadLocalStoragePointer
 *    +0x30  ProcessEnvironmentBlock
 *    +0x34  LastErrorValue
 */

#define TEB_EXCEPTION_LIST 0x00
#define TEB_STACK_BASE     0x04
#define TEB_STACK_LIMIT    0x08
#define TEB_SELF           0x18
#define TEB_TID            0x24
#define TEB_TLS_POINTER    0x2C
/* .tls raw-data template: 17 bytes at 0x00bb3318 (zero-fill, see boot log). */
#define ISAAC_TLS_TEMPLATE_VA  0x00bb3318u
#define ISAAC_TLS_TEMPLATE_SIZE 17u
#define TEB_PEB            0x30
#define TEB_LAST_ERROR     0x34

void isaac_boot_install_teb(void) {
    memset(isaac_g(ISAAC_TEB_VA), 0, 0x1000);
    memset(isaac_g(ISAAC_PEB_VA), 0, 0x1000);
    memset(isaac_g(ISAAC_TLS_ARRAY_VA), 0, 0x1000);

    isaac_w32(ISAAC_TEB_VA + TEB_EXCEPTION_LIST, 0xFFFFFFFFu);  /* empty chain */
    isaac_w32(ISAAC_TEB_VA + TEB_STACK_BASE, ISAAC_STACK_TOP_VA);
    isaac_w32(ISAAC_TEB_VA + TEB_STACK_LIMIT, ISAAC_STACK_TOP_VA - ISAAC_STACK_SIZE);
    isaac_w32(ISAAC_TEB_VA + TEB_SELF, ISAAC_TEB_VA);
    isaac_w32(ISAAC_TEB_VA + TEB_TID, 1);
    isaac_w32(ISAAC_TEB_VA + TEB_TLS_POINTER, ISAAC_TLS_ARRAY_VA);
    /* One TLS block for the single module (index 0): a copy of the .tls
     * raw-data template, zero-filled beyond 17 bytes, planted at slot 0 so
     * CRT TLS-expansion accesses ([fs:0x2c][tls_index]) land in writable
     * guest memory instead of dereferencing 0. */
    memset(isaac_g(ISAAC_TLS_BLOCK_VA), 0, ISAAC_TLS_BLOCK_SIZE);
    memcpy(isaac_g(ISAAC_TLS_BLOCK_VA), isaac_g(ISAAC_TLS_TEMPLATE_VA),
           ISAAC_TLS_TEMPLATE_SIZE);
    isaac_w32(ISAAC_TLS_ARRAY_VA, ISAAC_TLS_BLOCK_VA);
    isaac_w32(ISAAC_TEB_VA + TEB_PEB, ISAAC_PEB_VA);
    isaac_w32(ISAAC_TEB_VA + TEB_LAST_ERROR, 0);

    /* PEB fields the CRT and GLFW read: ImageBaseAddress at +0x08, and
     * BeingDebugged at +0x02 (kept 0 so anti-debug paths stay quiet). */
    isaac_w32(ISAAC_PEB_VA + 0x08, ISAAC_IMAGE_BASE);

    /* The TLS slot index the image allocates: the TLS directory names
     * 0x00c71628 as the _tls_index cell. Single-threaded build -> index 0. */
    if (isaac_in_image(ISAAC_TLS_INDEX_VA))
        isaac_w32(ISAAC_TLS_INDEX_VA, 0);

    if (g_opts.verbose)
        isaac_log("[isaac][boot] TEB at 0x%08x (fs base), PEB 0x%08x, "
                  "SEH chain head = 0xFFFFFFFF",
                  ISAAC_TEB_VA, ISAAC_PEB_VA);
}

/* ------------------------------------------------------------------ 5 ----- */

int isaac_boot_run_tls(void) {
    uint32_t array = ISAAC_TLS_CB_VA;
    unsigned n = 0;
    CpuState cpu;

    /* The TLS raw-data template is 17 bytes at 0x00bb3318..0x00bb3329 with
     * zero-fill 0. A single-threaded build has exactly one TLS block, and it is
     * already present in the image, so nothing needs copying. */
    for (;;) {
        uint32_t cb = isaac_r32(array + 4u * n);
        if (!cb)
            break;
        if (!isaac_in_image(cb)) {
            isaac_log("[isaac][boot] TLS callback %u -> 0x%08x is outside the "
                      "image; refusing to call it.", n, cb);
            return 0;
        }
        memset(&cpu, 0, sizeof cpu);
        cpu.FS_OFFSET = ISAAC_TEB_VA;
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x1000;
        /* PIMAGE_TLS_CALLBACK(PVOID DllHandle, DWORD Reason, PVOID Reserved),
         * stdcall. Reason = DLL_PROCESS_ATTACH (1). */
        cpu.ESP -= 4; isaac_w32(cpu.ESP, 0);                  /* Reserved   */
        cpu.ESP -= 4; isaac_w32(cpu.ESP, 1);                  /* ATTACH     */
        cpu.ESP -= 4; isaac_w32(cpu.ESP, ISAAC_IMAGE_BASE);   /* DllHandle  */
        cpu.ESP -= 4; isaac_w32(cpu.ESP, 0);                  /* ret addr   */
        if (g_opts.verbose)
            isaac_log("[isaac][boot] TLS callback %u -> 0x%08x "
                      "(DLL_PROCESS_ATTACH)", n, cb);
        isaac_guest_call(cb, &cpu);
        ++n;
    }
    if (g_opts.verbose)
        isaac_log("[isaac][boot] ran %u TLS callback(s)", n);
    return 1;
}

/* ------------------------------------------------------------------ 6 ----- */

static int run_initterm(uint32_t start_va, uint32_t end_va, const char *label,
                        int stop_on_nonzero) {
    unsigned ran = 0, skipped = 0;
    CpuState cpu;
    for (uint32_t p = start_va; p < end_va; p += 4) {
        uint32_t fn = isaac_r32(p);
        if (!fn) {                 /* null slots are normal padding */
            ++skipped;
            continue;
        }
        if (!isaac_in_image(fn)) {
            isaac_log("[isaac][boot] %s: initialiser at 0x%08x -> 0x%08x is "
                      "outside the image; aborting.", label, p, fn);
            return 0;
        }
        memset(&cpu, 0, sizeof cpu);
        cpu.FS_OFFSET = ISAAC_TEB_VA;
        cpu.ESP = ISAAC_STACK_TOP_VA - 0x2000;
        cpu.ESP -= 4; isaac_w32(cpu.ESP, 0);     /* return address */
        isaac_log("[isaac][boot] %s entry %u: initialiser 0x%08x",
                  label, ran + 1, fn);
        isaac_guest_call(fn, &cpu);
        if (g_opts.verbose)
            isaac_log("[isaac][boot] %s entry %u: 0x%08x returned %u",
                      label, ran + 1, fn, cpu.EAX);
        ++ran;
        /* _initterm_e stops at the first non-zero return; _initterm ignores
         * return values entirely. */
        if (stop_on_nonzero && cpu.EAX != 0) {
            isaac_log("[isaac][boot] %s: initialiser 0x%08x returned %u -- "
                      "CRT would abort startup here.", label, fn, cpu.EAX);
            return 0;
        }
    }
    if (g_opts.verbose)
        isaac_log("[isaac][boot] %s: ran %u initialisers (%u null slots)",
                  label, ran, skipped);
    return 1;
}

int isaac_boot_run_initterms(void) {
    /* ORDER IS LOAD-BEARING. XI first (it is what __scrt_common_main_seh calls
     * first) even though XC lives at a lower address. */
    if (!run_initterm(ISAAC_XI_START_VA, ISAAC_XI_END_VA,
                      ".CRT$XI (C initialisers, 4 non-null)", 1))
        return 0;
    if (!run_initterm(ISAAC_XC_START_VA, ISAAC_XC_END_VA,
                      ".CRT$XC (C++ dynamic initialisers, 117 non-null)", 0))
        return 0;
    return 1;
}

/* ------------------------------------------------------------------ 7 ----- */

int isaac_boot_call_main(int argc, char **argv) {
    CpuState cpu;
    uint32_t argv_va = 0;   /* the game reads argc/argv but ignores them beyond
                             * a --luadebug style scan; a null argv is safe and
                             * the shim for __p___argv reports if it is read. */
    (void)argv;
    memset(&cpu, 0, sizeof cpu);
    cpu.FS_OFFSET = ISAAC_TEB_VA;
    cpu.ESP = ISAAC_STACK_TOP_VA - 0x4000;
    cpu.ESP -= 4; isaac_w32(cpu.ESP, 0);          /* envp  */
    cpu.ESP -= 4; isaac_w32(cpu.ESP, argv_va);    /* argv  */
    cpu.ESP -= 4; isaac_w32(cpu.ESP, (uint32_t)argc);
    cpu.ESP -= 4; isaac_w32(cpu.ESP, 0);          /* return address */
    {
        const char *b = getenv("ISAAC_BENCH_DISPATCH");
        if (b && *b) {
            /* the engine Mutex: Init (vtbl +4), Lock(timeout) (+0xc), Unlock (+0x10) */
            extern void sub_00a15770(CpuState *restrict s);
            extern void sub_00a157f0(CpuState *restrict s);
            extern void sub_00a159a0(CpuState *restrict s);
            extern void recomp_call_indirect(CpuState *restrict s, uint32_t target);
            uint32_t n = (uint32_t)atoi(b), obj = isaac_guest_alloc(256);
            memset(isaac_g(obj), 0, 256);
            isaac_w32(obj, 0x00b81c0cu);              /* the engine Mutex vtable */
            CpuState b1 = cpu; b1.ECX = obj;
            b1.ESP -= 4; isaac_w32(b1.ESP, 0); sub_00a15770(&b1);          /* Mutex::Init(this) */
            double t0 = emscripten_get_now();
            for (uint32_t i = 0; i < n; ++i) {
                b1.ECX = obj; b1.ESP -= 4; isaac_w32(b1.ESP, 0xFFFFFFFFu); b1.ESP -= 4; isaac_w32(b1.ESP, 0);
                recomp_call_indirect(&b1, 0x00a157f0u);                      /* Lock(-1) */
                b1.ECX = obj; b1.ESP -= 4; isaac_w32(b1.ESP, 0);
                recomp_call_indirect(&b1, 0x00a159a0u);                      /* Unlock */
            }
            double t1 = emscripten_get_now();
            for (uint32_t i = 0; i < n; ++i) {
                b1.ECX = obj; b1.ESP -= 4; isaac_w32(b1.ESP, 0xFFFFFFFFu); b1.ESP -= 4; isaac_w32(b1.ESP, 0);
                sub_00a157f0(&b1);
                b1.ECX = obj; b1.ESP -= 4; isaac_w32(b1.ESP, 0);
                sub_00a159a0(&b1);
            }
            double t2 = emscripten_get_now();
            isaac_log("[isaac][bench] %u Lock(-1)+Unlock pairs: via the dispatcher %.3f us/pair, direct %.3f us/pair",
                      n, (t1 - t0) * 1000.0 / n, (t2 - t1) * 1000.0 / n);
        }
    }
    isaac_log("[isaac][boot] entering main() at 0x%08x", ISAAC_MAIN_VA);
    isaac_guest_call(ISAAC_MAIN_VA, &cpu);
    isaac_log("[isaac][boot] main() returned %d", (int)cpu.EAX);
    return (int)cpu.EAX;
}

/* ------------------------------------------------------------------------- */

int isaac_boot_init(const isaac_boot_opts *opts) {
    static const isaac_boot_opts defaults = {
        .apply_relocations = 0,
        .run_tls_callbacks = 1,
        .run_initterms = 1,
        .verbose = 1,
    };
    g_opts = opts ? *opts : defaults;

    if (g_booted) {
        isaac_log("[isaac][boot] already booted");
        return 1;
    }

    isaac_log("[isaac][boot] step 1/7  verify placed image");
    if (!verify_image())
        return 0;

    isaac_log("[isaac][boot] step 2/7  relocations: skipped (preferred base)");
    if (g_opts.apply_relocations && !apply_relocations_unsupported())
        return 0;

    isaac_log("[isaac][boot] step 3/7  bind %u IAT slots", isaac_import_count);
    if (!isaac_boot_bind_iat())
        return 0;

    isaac_log("[isaac][boot] step 4/7  install fake TEB/PEB");
    isaac_boot_install_teb();

    if (g_opts.run_tls_callbacks) {
        isaac_log("[isaac][boot] step 5/7  run TLS callbacks");
        if (!isaac_boot_run_tls())
            return 0;
    }

    if (g_opts.run_initterms) {
        isaac_log("[isaac][boot] step 6/7  run _initterm tables (XI then XC)");
        if (!isaac_boot_run_initterms())
            return 0;
    }

    g_booted = 1;
    isaac_log("[isaac][boot] ready; main() at 0x%08x has NOT been called yet",
              ISAAC_MAIN_VA);
    return 1;
}
