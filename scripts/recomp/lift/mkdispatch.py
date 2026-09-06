"""Generate the VA -> wasm function dispatch for a lifted module.

Emits a .h (extern declarations + the entry table) and a .c that provides
the two symbols the host layer expects (see isaac_host.h and
host_trap.c):

    int  isaac_lifted_dispatch(uint32_t va, CpuState *cpu);  -> 1 if handled
    void isaac_guest_call(uint32_t va, CpuState *cpu);        -> loud on miss

Lookup is a direct-mapped uint16 index over the .text VA range, built once
at first use.  Measured at 3.98 ns/lookup against 81.33 ns for a sorted
binary search over the same 21,375 entries (scripts/recomp/lift/
bench_dispatch.c), which is why the 14.2 MB of index is worth it.  The
index is malloc'd, so it lands in the host region above ISAAC_GUARD_VA
and a guest wild pointer cannot reach it.

Optionally also emits image_slices.h for tests that need PE bytes at their
real VAs without a full boot.
"""

import argparse
import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pe import PE32                                     # noqa: E402

TEXT_LO = 0x00401000
TEXT_HI = 0x00B17134


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--exe", default="tools/isaac-ng.unpacked.exe")
    ap.add_argument("--slice", action="append", default=[],
                    help="VA:LEN region of the image to embed (repeatable)")
    ap.add_argument("--section", action="append", default=[],
                    help="whole section to embed, e.g. .rdata")
    args = ap.parse_args()
    d = args.dir

    names = set()
    for f in sorted(glob.glob(os.path.join(d, "lifted*.c"))):
        with open(f, encoding="utf8") as fh:
            names.update(re.findall(r"^void (sub_([0-9a-f]{8}))\(CpuState",
                                    fh.read(), re.M))
    # Strong implementations of callees the lifter could not decode
    # (scripts/recomp/host/src/missing_fns.c) must also resolve through the
    # direct-mapped index: an indirect call into one of them otherwise traps
    # as "inside the image, function was not lifted".  Measured: 0x00aa9350
    # was reached as `call [0xc736e0]` from the controller-DB parser at
    # 0x00a25b36 and the boot stopped there.
    mf = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "..", "host", "src", "missing_fns.c")
    hand_written = set()
    if os.path.exists(mf):
        with open(mf, encoding="utf8") as fh:
            hand_written = set(re.findall(r"^void (sub_([0-9a-f]{8}))\(CpuState",
                                          fh.read(), re.M))
        names.update(hand_written)
    # Mid-function re-entry targets: every CALL continuation in the image
    # (computed by patch_reentry.py from the PE with capstone).  A return
    # address is always (call address + size), so this set is the exact
    # universe of legal longjmp / unwind resumption points.
    cont = set()
    cont_path = os.path.join(d, "call_cont.txt")
    if os.path.exists(cont_path):
        with open(cont_path) as fh:
            cont = set(int(l.strip(), 16) for l in fh if l.strip())
    RE_RV = re.compile(r"RECOMP_VA\(0x([0-9a-fA-F]{1,8})u\)")
    blocks = []          # (block_va, owning_function_name), first owner wins
    seen_b = set()
    for f in sorted(glob.glob(os.path.join(d, "lifted*.c"))):
        cur = None
        with open(f, encoding="utf8") as fh:
            for line in fh:
                mf = re.match(r"^void (sub_[0-9a-f]{8})\(", line)
                if mf:
                    cur = mf.group(1)
                    continue
                if cur is None:
                    continue
                mr = RE_RV.search(line)
                if not mr:
                    continue
                v = int(mr.group(1), 16)
                # A block a lift patch jumps INTO from another function is a
                # re-entry point too (lift_patches.py BLOCK_PATCHES marks the
                # RECOMP_VA line): round 24e restores a branch whose targets
                # Ghidra had split off into their own function.
                if (v in cont or "LIFT-PATCH REENTRY" in line) and v not in seen_b:
                    seen_b.add(v)
                    blocks.append((v, cur))
    blocks.sort()
    print("re-entry blocks: %d" % len(blocks))

    entries = sorted((int(h, 16), n) for n, h in names)
    lo = min((v for v, _ in entries), default=TEXT_LO)
    hi = max((v for v, _ in entries), default=TEXT_HI) + 1
    if lo < TEXT_LO or hi > TEXT_HI + 1:
        raise SystemExit("entry outside .text: %#x..%#x" % (lo, hi))

    with open(os.path.join(d, "dispatch_tbl.h"), "w") as fh:
        fh.write('#ifndef DISPATCH_TBL_H\n#define DISPATCH_TBL_H\n')
        fh.write('#include <stdint.h>\n#include "lifted_decls.h"\n')
        fh.write('typedef void (*recomp_fn)(CpuState *restrict);\n')
        fh.write('#define G_NDISPATCH %du\n' % len(entries))
        fh.write('#define G_TEXT_LO 0x%08xu\n' % TEXT_LO)
        fh.write('#define G_TEXT_HI 0x%08xu\n' % TEXT_HI)
        fh.write('extern const uint32_t g_dva[G_NDISPATCH];\n')
        fh.write('extern const recomp_fn g_dfn[G_NDISPATCH];\n')
        if blocks:
            fh.write('#define G_NBLOCK %du\n' % len(blocks))
            fh.write('extern const uint32_t g_bva[G_NBLOCK];\n')
            fh.write('extern const recomp_fn g_bfn[G_NBLOCK];\n')
        fh.write('int isaac_lifted_dispatch(uint32_t va, CpuState *restrict cpu);\n')
        fh.write('int isaac_lifted_dispatch_cached(uint32_t va, CpuState *restrict cpu);\n')
        fh.write('int isaac_dispatch_return(uint32_t va, CpuState *restrict cpu);\n')
        fh.write('void isaac_guest_call(uint32_t va, CpuState *restrict cpu);\n')
        fh.write('void isaac_guest_longjmp(CpuState *restrict cpu);\n')
        fh.write('extern uint32_t g_reentry_eip;\n')
        # Hand-written bodies added AFTER the lift (missing_fns.c) are not in
        # lifted_decls.h; declare them here so the table compiles (round 12:
        # the adjustor thunk 0x0069d1f0 was the first).
        for name, _va in sorted(hand_written):
            fh.write('void %s(CpuState *restrict s);\n' % name)
        fh.write('#endif\n')

    with open(os.path.join(d, "dispatch_tbl.c"), "w") as fh:
        fh.write('/* GENERATED by mkdispatch.py */\n')
        fh.write('#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n')
        fh.write('#ifdef __EMSCRIPTEN__\n#include <emscripten.h>\n#else\n'
                 'static double emscripten_get_now(void) { return 0.0; }\n#endif\n')
        fh.write('#include "dispatch_tbl.h"\n\n')
        fh.write('const uint32_t g_ndispatch = G_NDISPATCH;   /* linkable count for recomp_rt.c */\n')
        fh.write('const uint32_t g_dva[G_NDISPATCH] = {\n')
        for i in range(0, len(entries), 8):
            fh.write(','.join('0x%08xu' % v for v, _ in entries[i:i + 8]) + ',\n')
        fh.write('};\nconst recomp_fn g_dfn[G_NDISPATCH] = {\n')
        for i in range(0, len(entries), 4):
            fh.write(','.join(n for _, n in entries[i:i + 4]) + ',\n')
        fh.write('};\n\n')
        if blocks:
            fh.write('const uint32_t g_bva[G_NBLOCK] = {\n')
            for i in range(0, len(blocks), 8):
                fh.write(','.join('0x%08xu' % v for v, _ in blocks[i:i + 8]) + ',\n')
            fh.write('};\nconst recomp_fn g_bfn[G_NBLOCK] = {\n')
            for i in range(0, len(blocks), 4):
                fh.write(','.join(n for _, n in blocks[i:i + 4]) + ',\n')
            fh.write('};\n\n')
        fh.write('''/* Mid-function re-entry (guest setjmp/longjmp and the unwind after
 * longjmp): return addresses resume at CALL continuations, which are NOT
 * function entries.  The dispatcher sets this to the requested block VA
 * before calling a function; every lifted function's prologue consumes it
 * (see patch_reentry.py) and jumps to the matching L_ label. */
uint32_t g_reentry_eip = 0u;

static uint16_t *g_index;   /* direct-mapped VA -> dense function id */
static uint32_t *g_bindex;  /* direct-mapped VA -> dense block id */

static void build_index(void) {
  size_t n = (size_t)(G_TEXT_HI - G_TEXT_LO);
  g_index = (uint16_t *)malloc(n * sizeof(uint16_t));
  if (!g_index) {
    fprintf(stderr, "recomp: cannot allocate %zu-byte dispatch index\\n",
            n * sizeof(uint16_t));
    abort();
  }
  memset(g_index, 0xFF, n * sizeof(uint16_t));
  for (uint32_t i = 0; i < G_NDISPATCH; ++i)
    g_index[g_dva[i] - G_TEXT_LO] = (uint16_t)i;
}

static void build_bindex(void) {
  size_t n = (size_t)(G_TEXT_HI - G_TEXT_LO);
  g_bindex = (uint32_t *)malloc(n * sizeof(uint32_t));
  if (!g_bindex) {
    fprintf(stderr, "recomp: cannot allocate %zu-byte block index\\n",
            n * sizeof(uint32_t));
    abort();
  }
  for (size_t i = 0; i < n; ++i) g_bindex[i] = 0xFFFFFFFFu;
  for (uint32_t i = 0; i < G_NBLOCK; ++i)
    g_bindex[g_bva[i] - G_TEXT_LO] = i;
}

extern uint32_t recomp_jmp_pending;
void recomp_run_pending(CpuState *restrict cpu);
static int dispatch_block(uint32_t va, CpuState *restrict cpu) {
  if (!g_bindex) build_bindex();
  uint32_t off = va - G_TEXT_LO;
  if (off >= (uint32_t)(G_TEXT_HI - G_TEXT_LO)) return 0;
  uint32_t bid = g_bindex[off];
  if (bid == 0xFFFFFFFFu) return 0;
  g_reentry_eip = va;
  g_bfn[bid](cpu);
  return 1;
}

/* Dispatcher census (round 14h): how many times each lifted entry is
 * dispatched, plus block re-entries and misses. isaac_dispatch_report()
 * prints the hottest targets; the stub report calls it at exit. */
static uint32_t *g_dcount;
static uint32_t g_dcalls, g_dblocks, g_dmisses;
static int g_hb_every = -1;   /* ISAAC_HEARTBEAT */
static int g_watch_n = -1;    /* ISAAC_DISPATCH_WATCH */
static uint32_t g_watch_va[8], g_watch_hits[8];
/* ISAAC_DISPATCH_TIME=1 (round 14j): wall time INSIDE each dispatched entry,
 * inclusive of everything it calls (a nested dispatch is charged to both), and
 * the time spent in this function around the calls -- the dispatcher's own
 * cost, which a sampling profile cannot separate from the callees. */
static double *g_dtime;
static double g_dself, g_dtotal;
static int g_dtime_on = -1;
/* Round 38: a direct-mapped cache in front of the index. g_index is one
 * uint16 per text byte -- 18 MB -- so every dispatch of a call-site's usual
 * target was a cache miss into it (10.9% of a throttled browser frame,
 * 4,400 dispatches a frame). 4096 (va, id) pairs stay in L1/L2; a hit skips
 * the index, the range check and the mode checks, and still counts (the
 * census must stay exact). Off while any dispatch mode (ISAAC_HEARTBEAT,
 * ISAAC_DISPATCH_WATCH, ISAAC_DISPATCH_TIME) is on. */
#define DCACHE_BITS 14           /* 16384 sets x 2 ways x 8 bytes = 256 KB */
typedef struct { uint32_t va[2]; uint16_t id[2]; uint8_t next; } dcache_set;
static dcache_set g_dcache[1u << DCACHE_BITS];
static int g_dfast;      /* 1 once the modes are read and none is on */
static uint32_t g_dchits, g_dcmiss;
static inline uint32_t dcache_slot(uint32_t va) { return ((va >> 2) ^ (va >> 16)) & ((1u << DCACHE_BITS) - 1u); }
int isaac_lifted_dispatch_cached(uint32_t va, CpuState *restrict cpu) {
  dcache_set *c = &g_dcache[dcache_slot(va)];
  uint16_t id;
  if (!g_dfast || !va) return 0;
  if (c->va[0] == va) id = c->id[0];
  else if (c->va[1] == va) id = c->id[1];
  else return 0;
  ++g_dcalls; ++g_dchits;
  g_dcount[id]++;
  g_dfn[id](cpu);
  return 1;
}
int isaac_lifted_dispatch(uint32_t va, CpuState *restrict cpu) {
  if (!g_index) build_index();
  uint32_t off = va - G_TEXT_LO;
  ++g_dcalls;
  if (off >= (uint32_t)(G_TEXT_HI - G_TEXT_LO)) { ++g_dmisses; return 0; }
  uint16_t id = g_index[off];
  if (id == 0xFFFFu) { ++g_dblocks; return dispatch_block(va, cpu); }
  /* ISAAC_HEARTBEAT=<n>: print every n-th dispatch with the wall clock and the
   * target. The room-entry crawl (round 15c) executes NO lifted instruction
   * for minutes -- the RECOMP_VA tick never reaches its interval -- so the
   * question is whether the guest is stopped inside one call or grinding
   * through dispatches that the tick somehow misses. This answers it. */
  if (g_hb_every < 0) {
    const char *e = getenv("ISAAC_HEARTBEAT");
    g_hb_every = (e && *e) ? atoi(e) : 0;
    if (g_hb_every > 0)
      fprintf(stderr, "[isaac][hb] heartbeat every %d dispatches\\n", g_hb_every);
  }
  /* ISAAC_DISPATCH_WATCH=<hex va>[,<hex va>...]: say the first time each of
   * those functions is dispatched, and count them. Round 16 needed to know
   * whether the game's sound-play path (0x00a9fb80) is reached at all, which
   * neither the hottest-16 census nor the heartbeat can answer. */
  if (g_watch_n < 0) {
    g_watch_n = 0;
    const char *w = getenv("ISAAC_DISPATCH_WATCH");
    while (w && *w && g_watch_n < 8) {
      g_watch_va[g_watch_n++] = (uint32_t)strtoul(w, (char **)&w, 16);
      while (*w == ',' || *w == ' ') ++w;
    }
    if (g_watch_n) fprintf(stderr, "[isaac][watch] watching %d dispatch target(s)\\n", g_watch_n);
  }
  for (int wi = 0; wi < g_watch_n; ++wi)
    if (g_watch_va[wi] == va && !g_watch_hits[wi]++)
      fprintf(stderr, "[isaac][watch] sub_%08x dispatched for the first time (after %u dispatches)\\n",
              va, g_dcalls);
  if (g_hb_every > 0 && (g_dcalls % (uint32_t)g_hb_every) == 0u)
    fprintf(stderr, "[isaac][hb] %u dispatches, %.1f s, now sub_%08x\\n",
            g_dcalls, emscripten_get_now() / 1000.0, va);
  if (!g_dcount) g_dcount = (uint32_t *)calloc(G_NDISPATCH, sizeof(uint32_t));
  if (g_dcount) g_dcount[id]++;
  if (g_dtime_on < 0) {
    const char *e = getenv("ISAAC_DISPATCH_TIME");
    g_dtime_on = (e && *e && *e != '0') ? 1 : 0;
    if (g_dtime_on) g_dtime = (double *)calloc(G_NDISPATCH, sizeof(double));
  }
  if (!g_dfast && g_hb_every == 0 && g_watch_n == 0 && g_dtime_on == 0 && g_dcount) g_dfast = 1;
  if (g_dfast) {                            /* a miss: fill the set's older way */
    dcache_set *c = &g_dcache[dcache_slot(va)];
    unsigned w = c->next & 1u;
    c->va[w] = va; c->id[w] = id; c->next = (uint8_t)(w ^ 1u);
    ++g_dcmiss;
  }
  if (g_dtime_on && g_dtime) {
    double t0 = emscripten_get_now();
    g_dfn[id](cpu);
    double t1 = emscripten_get_now();
    g_dtime[id] += t1 - t0;
    g_dtotal += t1 - t0;
    g_dself += emscripten_get_now() - t1;   /* the bookkeeping after the call */
    return 1;
  }
  g_dfn[id](cpu);
  return 1;
}
/* Monotonic progress signal for recomp_run_pending: unlike the RECOMP_VA
 * trace index this counts in every profile, including --fast, where the
 * trace is compiled out. */
uint32_t isaac_dispatch_calls(void) { return g_dcalls; }
void isaac_dispatch_report(void) {
  fprintf(stderr, "[isaac][dispatch] %u dispatches (%u block re-entries, %u misses; cache %u hits / %u fills); hottest entries:\\n",
          g_dcalls, g_dblocks, g_dmisses, g_dchits, g_dcmiss);
  if (!g_dcount) return;
  for (int round = 0; round < 16; ++round) {
    uint32_t best = 0;
    for (uint32_t i = 1; i < G_NDISPATCH; ++i) if (g_dcount[i] > g_dcount[best]) best = i;
    if (!g_dcount[best]) break;
    fprintf(stderr, "[isaac][dispatch]   %10u x sub_%08x\\n", g_dcount[best], g_dva[best]);
    g_dcount[best] = 0;
  }
  for (int wi = 0; wi < g_watch_n; ++wi)
    fprintf(stderr, "[isaac][watch] sub_%08x dispatched %u time(s)\\n", g_watch_va[wi], g_watch_hits[wi]);
  if (!g_dtime) return;
  fprintf(stderr, "[isaac][dispatch] time inside dispatched entries %.1f ms (inclusive; nested dispatches "
                  "count twice), dispatcher bookkeeping %.1f ms; slowest entries:\\n", g_dtotal, g_dself);
  for (int round = 0; round < 24; ++round) {
    uint32_t best = 0;
    for (uint32_t i = 1; i < G_NDISPATCH; ++i) if (g_dtime[i] > g_dtime[best]) best = i;
    if (g_dtime[best] <= 0.0) break;
    fprintf(stderr, "[isaac][dispatch]   %10.1f ms  sub_%08x\\n", g_dtime[best], g_dva[best]);
    g_dtime[best] = 0.0;
  }
}

/* Return addresses resume mid-function, so the longjmp replay loop
 * prefers the block table; a VA that is simultaneously a function entry
 * and a call continuation must resume as a continuation. */
int isaac_dispatch_return(uint32_t va, CpuState *restrict cpu) {
  if (dispatch_block(va, cpu)) return 1;
  return isaac_lifted_dispatch(va, cpu);
}

#include <setjmp.h>
static jmp_buf g_guest_jmp;

/* Called by imp_vcruntime140__longjmp after restoring the guest registers
 * into cpu: abandon the host call chain and resume in isaac_guest_call,
 * which replays the guest unwind frame by frame. */
void isaac_guest_longjmp(CpuState *restrict cpu) {
  (void)cpu;
  longjmp(g_guest_jmp, 1);
}

/* Round 14d: the tail-jump trampoline. The dispatch path above only calls;
 * a parked jump is run here, in the host entry's frame, so a chain of guest
 * jumps of any length costs a bounded number of native frames. Lifted call
 * sites carry the same check after every call. */
static void isaac_guest_call_inner(uint32_t va, CpuState *restrict cpu) {
  if (setjmp(g_guest_jmp) == 0) {
    if (isaac_lifted_dispatch(va, cpu)) { recomp_run_pending(cpu); return; }
    fprintf(stderr, "recomp: guest call to 0x%08x has no lifted function "
                    "(%u entries cover the lifted set)\\n", va, G_NDISPATCH);
    abort();
  }
  /* Resumed after a guest longjmp: cpu->EIP/ESP already restored.  Replay
   * the abandoned guest frames until the guest stack unwinds out of the
   * lifted image (drivers push a fake return address of 0). */
  for (unsigned guard = 0; guard < (1u << 20); ++guard) {
    if (recomp_jmp_pending) recomp_run_pending(cpu);
    if (!isaac_dispatch_return(cpu->EIP, cpu)) {
      if (cpu->EIP >= G_TEXT_LO && cpu->EIP < G_TEXT_HI)
        fprintf(stderr, "recomp: longjmp replay stopped inside .text at "
                        "0x%08x (no lifted block)\\n", cpu->EIP);
      return;
    }
  }
  fprintf(stderr, "recomp: longjmp replay did not unwind in 2^20 frames "
                  "(EIP 0x%08x)\\n", cpu->EIP);
  abort();
}

/* Nesting (round 24): a frame pump or a thread slice calls the guest from
 * inside main's own guest call, and the one static jmp_buf was overwritten by
 * the inner setjmp -- a guest longjmp on the outer level would then have
 * landed in a dead frame. Save it around every call. A slice that yields
 * skips this restore, so the slice runner saves and restores it itself
 * through the two accessors. */
void isaac_guest_jmp_save(void *dst) { memcpy(dst, g_guest_jmp, sizeof(jmp_buf)); }
void isaac_guest_jmp_restore(const void *src) { memcpy(g_guest_jmp, src, sizeof(jmp_buf)); }
unsigned isaac_guest_jmp_size(void) { return (unsigned)sizeof(jmp_buf); }
void isaac_guest_call(uint32_t va, CpuState *restrict cpu) {
  jmp_buf saved;
  memcpy(saved, g_guest_jmp, sizeof(jmp_buf));
  isaac_guest_call_inner(va, cpu);
  memcpy(g_guest_jmp, saved, sizeof(jmp_buf));
}
''')

    n_slices = 0
    if args.slice or args.section:
        pe = PE32(args.exe)
        slices = []
        for spec in args.slice:
            va, ln = spec.split(":")
            slices.append((int(va, 0), pe.read(int(va, 0), int(ln, 0))))
        for sname in args.section:
            for s in pe.sections:
                if s.name == sname:
                    n = min(s.raw_size, s.vsize)
                    slices.append((s.vaddr, pe.read(s.vaddr, n)))
        n_slices = len(slices)
        with open(os.path.join(d, "image_slices.h"), "w") as fh:
            fh.write('#ifndef IMAGE_SLICES_H\n#define IMAGE_SLICES_H\n')
            fh.write('#include <stdint.h>\n')
            fh.write('typedef struct { uint32_t va; uint32_t len; '
                     'const unsigned char *data; } ImageSlice;\n')
            for i, (va, data) in enumerate(slices):
                fh.write('static const unsigned char s%d_[%d] = {' % (i, len(data)))
                fh.write(','.join(str(b) for b in data))
                fh.write('};\n')
            fh.write('#define G_NSLICES %du\n' % len(slices))
            fh.write('static const ImageSlice g_slices[%d] = {\n'
                     % max(1, len(slices)))
            for i, (va, data) in enumerate(slices):
                fh.write('  {0x%08xu, %du, s%d_},\n' % (va, len(data), i))
            if not slices:
                fh.write('  {0,0,0},\n')
            fh.write('};\n#endif\n')

    print("dispatch entries: %d  (%#x..%#x)  image slices: %d"
          % (len(entries), lo, hi, n_slices))


if __name__ == "__main__":
    main()
