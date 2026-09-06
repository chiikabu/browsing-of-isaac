/* Out-of-line runtime pieces for the lifter prototype (hand-written). */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
/* The single-instruction oracle (scripts/recomp/oracle/wideops.py) builds
 * this file with a native compiler; the wall clock and the forced exit
 * exist there only so it links (round 26). */
#include <time.h>
static double emscripten_get_now(void) { return (double)clock() * 1000.0 / (double)CLOCKS_PER_SEC; }
static void emscripten_force_exit(int status) { exit(status); }
#endif
#include "recomp_state.h"
#include "recomp_rt.h"

/* RECOMP_VA(va) writes the guest VA of the instruction currently executing.
 * Emitted by TUs built with -DRECOMP_MEM_CHECK=1 so a bad-pointer report can
 * name the instruction that computed it. Declared in recomp_rt.h; the
 * definition belongs here, not in a generated TU. */
uint32_t recomp_cur_va;
volatile uint32_t recomp_va_trace[512];
volatile uint32_t recomp_va_trace_idx;

/* Guest-memory watch window (recomp_rt.h RECOMP_WATCH_R/W). Off unless
 * ISAAC_WATCH=0xLO:0xHI[:w] is set; parsed once before main runs. The
 * pre-round-11 build hard-wired 0xc73680..0xc73740 (epoxy/allocator slots)
 * and printed ~1,000 lines per boot; that window is now opt-in like any
 * other. */
uint32_t recomp_watch_lo = 0, recomp_watch_hi = 0;
int recomp_watch_wonly = 0;
__attribute__((constructor)) static void recomp_watch_init(void) {
  const char *e = getenv("ISAAC_WATCH");
  if (!e || !*e) return;
  unsigned long lo = 0, hi = 0;
  char mode = 0;
  if (sscanf(e, "%lx:%lx:%c", &lo, &hi, &mode) < 2) {
    fprintf(stderr, "[recomp][PW] ISAAC_WATCH='%s' is not 0xLO:0xHI[:w]; watch off\n", e);
    return;
  }
  recomp_watch_lo = (uint32_t)lo;
  recomp_watch_hi = (uint32_t)hi;
  recomp_watch_wonly = (mode == 'w' || mode == 'W');
  fprintf(stderr, "[recomp][PW] watching guest %#x..%#x (%s)\n", recomp_watch_lo,
          recomp_watch_hi, recomp_watch_wonly ? "writes" : "reads+writes");
}
struct CpuState *recomp_last_cpu; /* captured by shim dispatch (host_trap.c) */

void recomp_trace_glob(uint32_t va, uint32_t val) {
  fprintf(stderr, "[recomp][GLOB] va=%#x val=%u\n", va, val);
}
void recomp_trace_ebx_va(uint32_t va, uint32_t ebx, uint32_t esp, uint32_t ebp) {
  fprintf(stderr, "[recomp][EBX] va=0x%08x EBX=0x%08x ESP=0x%08x EBP=0x%08x\n",
          va, ebx, esp, ebp);
}


uint64_t recomp_fsqrt_f64(uint64_t a) { return recomp_f642bits(sqrt(recomp_bits2f64(a))); }
uint32_t recomp_fsqrt_f32(uint32_t a) { return recomp_f322bits(sqrtf(recomp_bits2f32(a))); }
uint32_t recomp_fceil_f32(uint32_t a) { return recomp_f322bits(ceilf(recomp_bits2f32(a))); }
uint64_t recomp_fceil_f64(uint64_t a) { return recomp_f642bits(ceil(recomp_bits2f64(a))); }
uint32_t recomp_ffloor_f32(uint32_t a) { return recomp_f322bits(floorf(recomp_bits2f32(a))); }
uint64_t recomp_ffloor_f64(uint64_t a) { return recomp_f642bits(floor(recomp_bits2f64(a))); }
uint32_t recomp_fround_f32(uint32_t a) { return recomp_f322bits(nearbyintf(recomp_bits2f32(a))); }
uint64_t recomp_fround_f64(uint64_t a) { return recomp_f642bits(nearbyint(recomp_bits2f64(a))); }

/* ---- boundary --------------------------------------------------- */

void recomp_unreachable(CpuState *s, uint32_t va) {
  (void)s;
  fprintf(stderr, "recomp: fell off the end at %#x\n", va);
  abort();
}

/* Indirect dispatch. A real port replaces this with a sorted VA ->
 * function-pointer table built from the function inventory. */
__attribute__((weak)) void recomp_call_indirect(CpuState *s, uint32_t t) {
  (void)s;
  fprintf(stderr, "recomp: unresolved indirect call to %#x\n", t);
  abort();
}

__attribute__((weak)) void recomp_jump_indirect(CpuState *s, uint32_t t) {
  (void)s;
  fprintf(stderr, "recomp: unresolved indirect jump to %#x\n", t);
  abort();
}

/* ------------------------------------------------------------------ */
/* SLEIGH CALLOTHER intrinsics (recomp_other_*).                       */
/*                                                                     */
/* Implemented against the 32-bit signatures emitted by the current    */
/* lift.  Two known limitations, both tracked:                         */
/*  1. MMX ops here take the pypcode-truncated 32-bit halves.  The     */
/*     real instructions are 64-bit (4 x 16-bit lanes); lane N of the  */
/*     low 32 bits is correct, lanes above are lost.  Sites that use   */
/*     these (UCRT _libm_sse2_* polynomial kernels) are platform       */
/*     primitives, but an exact port must re-lift with size-aware      */
/*     CALLOTHER signatures (uint64_t) and real 4-lane bodies.  The    */
/*     2-lane bodies below are the exact low-half semantics.           */
/*  2. in/out return 0 / drop the write.  The boot path performs no    */
/*     device I/O; any real port I/O must be modelled deliberately.    */
/* ------------------------------------------------------------------ */

uint32_t recomp_other_LOCK(CpuState *s) {
  (void)s;                  /* single-threaded port: LOCK is a barrier */
  return 0;
}

uint32_t recomp_other_UNLOCK(CpuState *s) {
  (void)s;
  return 0;
}

uint32_t recomp_other_in(CpuState *s, uint32_t port) {
  (void)s; (void)port;
  return 0;                 /* no device I/O on the boot path */
}

uint32_t recomp_other_out(CpuState *s, uint32_t port,
                                                uint32_t value) {
  (void)s; (void)port; (void)value;
  return 0;
}

/* Execute cpuid(leaf).  The lift models the instruction as a CALLOTHER
 * returning a pointer to a 16-byte record laid out {eax, ebx, edx, ecx}
 * (the lifted join reads EAX=[p], EBX=[p+4], EDX=[p+8], ECX=[p+0xc]).
 * The record lives in the host-owned guest-visible scratch arena at
 * 0x0e004000 (below ISAAC_GUEST_LIMIT_VA so lifted MEMR32 can read it,
 * above every structure host_boot.c currently plants).  Feature set:
 * a fixed "Haswell-class, no AVX" baseline -- SSE2 is what every lifted
 * code path here relies on, and reporting AVX/OSXSAVE off keeps the
 * CRT on the plain SSE2 paths.  Not derived from the original machine
 * (unknown); documented as a chosen baseline. */
#define ISAAC_CPUID_SCRATCH_VA 0x0e004000u

static uint32_t *recomp_cpuid_record(uint32_t leaf) {
  uint32_t *rec = (uint32_t *)(uintptr_t)ISAAC_CPUID_SCRATCH_VA;
  uint32_t eax = 0, ebx = 0, ecx = 0, edx = 0;
  switch (leaf) {
    case 0x00000000u:
      eax = 0x0du;                              /* max standard leaf */
      ebx = 0x756e6547u;                        /* "Genu" */
      edx = 0x49656e69u;                        /* "ineI" */
      ecx = 0x6c65746eu;                        /* "ntel" */
      break;
    case 0x00000001u:
      eax = 0x000306c3u;                        /* Haswell, no AVX bits used */
      ebx = 0x02100800u;                        /* clflush 8, 8 logical cpus */
      ecx = (1u << 0)  | (1u << 9)  | (1u << 19)
          | (1u << 20) | (1u << 23);            /* SSE3 SSSE3 SSE4.1 SSE4.2 POPCNT */
      edx = (1u << 15) | (1u << 23) | (1u << 24)
          | (1u << 25) | (1u << 26);            /* CMOV MMX FXSR SSE SSE2 */
      break;
    case 0x80000000u:
      eax = 0x80000008u;                        /* max extended leaf */
      break;
    case 0x80000001u:
      edx = (1u << 15) | (1u << 25) | (1u << 26); /* CMOV SSE SSE2 */
      break;
    default:
      break;                                    /* unknown leaves: zeros */
  }
  rec[0] = eax;
  rec[1] = ebx;
  rec[2] = edx;   /* NB: record order matches the lifted join's reads */
  rec[3] = ecx;
  return rec;
}

#define DEF_CPUID(NAME)                                                  \
  uint32_t recomp_other_##NAME(CpuState *s,          \
                                                     uint32_t leaf) {      \
    (void)s;                                                              \
    return (uint32_t)(uintptr_t)recomp_cpuid_record(leaf);                \
  }

DEF_CPUID(cpuid)
DEF_CPUID(cpuid_basic_info)
DEF_CPUID(cpuid_Version_info)
DEF_CPUID(cpuid_cache_tlb_info)
DEF_CPUID(cpuid_serial_info)
DEF_CPUID(cpuid_Deterministic_Cache_Parameters_info)
DEF_CPUID(cpuid_MONITOR_MWAIT_Features_info)
DEF_CPUID(cpuid_Thermal_Power_Management_info)
DEF_CPUID(cpuid_Extended_Feature_Enumeration_info)
DEF_CPUID(cpuid_Extended_Topology_info)
DEF_CPUID(cpuid_Processor_Extended_States_info)
DEF_CPUID(cpuid_Quality_of_Service_info)
DEF_CPUID(cpuid_Direct_Cache_Access_info)
DEF_CPUID(cpuid_Architectural_Performance_Monitoring_info)
DEF_CPUID(cpuid_brand_part1_info)
DEF_CPUID(cpuid_brand_part2_info)
DEF_CPUID(cpuid_brand_part3_info)

/* seg:[off] memory operand.  Flat segmentation: DS/SS/ES/CS base 0;
 * FS/GS use the segment bases planted by host_boot.c. */
uint32_t recomp_other_segment(CpuState *s,
                                                    uint32_t seg,
                                                    uint32_t off) {
  if ((uint16_t)seg == s->FS) return s->FS_OFFSET + off;   /* FS -> TEB */
  if ((uint16_t)seg == s->GS) return s->GS_OFFSET + off;   /* GS */
  return off;                                              /* flat */
}

/* sldt: no LDT is installed in this flat model. */
uint32_t recomp_other_LocalDescriptorTableRegister(
    CpuState *s) {
  (void)s;
  return 0;
}

/* ---- MMX lane helpers (truncated 32-bit view; see file header) ---- */

static __inline int16_t rc_sat16(int32_t v) {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return (int16_t)v;
}
static __inline uint8_t rc_satu8(int32_t v) {
  if (v > 255) return 255;
  if (v < 0) return 0;
  return (uint8_t)v;
}
static __inline uint16_t rc_satu16(int32_t v) {
  if (v > 65535) return 65535;
  if (v < 0) return 0;
  return (uint16_t)v;
}

uint32_t recomp_other_pmulhw(CpuState *s, uint32_t a,
                                                   uint32_t b) {
  (void)s;
  int16_t la = (int16_t)(a & 0xffffu), ha = (int16_t)(a >> 16);
  int16_t lb = (int16_t)(b & 0xffffu), hb = (int16_t)(b >> 16);
  uint32_t lo = (uint32_t)(uint16_t)((int32_t)la * lb >> 16);
  uint32_t hi = (uint32_t)(uint16_t)((int32_t)ha * hb >> 16);
  return lo | (hi << 16);
}

uint32_t recomp_other_psraw(CpuState *s, uint32_t a,
                                                  uint32_t b) {
  (void)s;
  unsigned c = b & 0x3fu;
  if (c >= 16) c = 15;
  int16_t la = (int16_t)(a & 0xffffu) >> c;
  int16_t ha = (int16_t)(a >> 16) >> c;
  return (uint32_t)(uint16_t)la | ((uint32_t)(uint16_t)ha << 16);
}

uint32_t recomp_other_psllw(CpuState *s, uint32_t a,
                                                  uint32_t b) {
  (void)s;
  unsigned c = b & 0x3fu;
  uint16_t lo = (c >= 16) ? 0u : (uint16_t)((a & 0xffffu) << c);
  uint16_t hi = (c >= 16) ? 0u : (uint16_t)((a >> 16) << c);
  return (uint32_t)lo | ((uint32_t)hi << 16);
}

uint32_t recomp_other_paddsw(CpuState *s, uint32_t a,
                                                   uint32_t b) {
  (void)s;
  int16_t la = (int16_t)(a & 0xffffu), ha = (int16_t)(a >> 16);
  int16_t lb = (int16_t)(b & 0xffffu), hb = (int16_t)(b >> 16);
  uint32_t lo = (uint16_t)rc_sat16((int32_t)la + lb);
  uint32_t hi = (uint16_t)rc_sat16((int32_t)ha + hb);
  return lo | (hi << 16);
}

uint32_t recomp_other_paddusb(CpuState *s, uint32_t a,
                                                    uint32_t b) {
  (void)s;
  uint32_t r = 0;
  for (int k = 0; k < 4; k++)
    r |= (uint32_t)rc_satu8(((a >> (8 * k)) & 0xff) + ((b >> (8 * k)) & 0xff))
         << (8 * k);
  return r;
}

uint32_t recomp_other_psubusb(CpuState *s, uint32_t a,
                                                    uint32_t b) {
  (void)s;
  uint32_t r = 0;
  for (int k = 0; k < 4; k++)
    r |= (uint32_t)rc_satu8(((a >> (8 * k)) & 0xff) - ((b >> (8 * k)) & 0xff))
         << (8 * k);
  return r;
}

uint32_t recomp_other_psubusw(CpuState *s, uint32_t a,
                                                    uint32_t b) {
  (void)s;
  uint32_t lo = rc_satu16((a & 0xffffu) - (b & 0xffffu));
  uint32_t hi = rc_satu16((a >> 16) - (b >> 16));
  return lo | (hi << 16);
}

uint32_t recomp_other_packsswb(CpuState *s, uint32_t a,
                                                     uint32_t b) {
  (void)s;
  /* low-half-of-a lanes first, then low-half-of-b -- the truncated
   * pcode view; see file header for the relift note */
  int16_t lanes[4] = { (int16_t)(a & 0xffffu), (int16_t)(a >> 16),
                       (int16_t)(b & 0xffffu), (int16_t)(b >> 16) };
  uint8_t bytes[4];
  for (int k = 0; k < 4; k++) {
    int32_t v = (int32_t)lanes[k];
    bytes[k] = (uint8_t)(v > 127 ? 127 : (v < -128 ? (uint8_t)0x80 : (uint8_t)v));
  }
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8)
       | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

/* ------------------------------------------------------------------ */
/* Wide CALLOTHER intrinsics (recomp_otherw_*).                        */
/*                                                                     */
/* SSE/AVX pcodeops whose operands do not fit the uint32_t by-value    */
/* convention above.  Every operand arrives as (bytes, size) and the   */
/* result is written through `out`; `outsz` is the p-code output size. */
/*                                                                     */
/* SLEIGH passes the *old destination* as the first operand for the    */
/* two-operand x86 forms (`XmmReg1 = op(XmmReg1, XmmReg2_m128)`), so   */
/* a0 is the old dest and a1 the source for anything whose result does */
/* not read the destination.  Callees must be alias-safe: a site like  */
/* `XMM0 = pshuflw(XMM0, XMM0, imm)` passes one pointer three times,   */
/* so read the inputs into locals before touching `out`.               */
/*                                                                     */
/* Only the intrinsics the port actually executes are implemented; the */
/* rest stay weak aborting stubs from mkstubs.py that name themselves. */
/* ------------------------------------------------------------------ */

/* `out` is a live XMM register slot, so a width the body does not model
 * would silently scribble past it.  SLEIGH names the ymm/zmm shuffles
 * separately (vpshuflw_avx2 and friends), so 16 is the only legal width
 * here and anything else is a lifter change that must be noticed. */
static void rc_widecheck(const char *who, unsigned sz, unsigned want) {
  if (sz == want) return;
  fprintf(stderr, "recomp: %s got a %u-byte operand, models %u\n",
          who, sz, want);
  abort();
}

void recomp_otherw_pshuflw(CpuState *s, uint8_t *out, unsigned outsz,
                           const uint8_t *a0, unsigned a0sz,
                           const uint8_t *a1, unsigned a1sz,
                           const uint8_t *a2, unsigned a2sz) {
  (void)s; (void)a0; (void)a0sz; (void)a2sz;
  uint8_t src[16];
  unsigned imm = a2[0];                 /* imm8, widened by SLEIGH */
  rc_widecheck("pshuflw", outsz, 16u);
  rc_widecheck("pshuflw", a1sz, 16u);
  memcpy(src, a1, 16);                  /* alias-safe: out may be a1 */
  for (int i = 0; i < 4; ++i)           /* low qword: 4 shuffled words */
    memcpy(out + 2 * i, src + 2 * ((imm >> (2 * i)) & 3u), 2);
  memcpy(out + 8, src + 8, 8);          /* high qword copied through */
}

void recomp_otherw_pshufhw(CpuState *s, uint8_t *out, unsigned outsz,
                           const uint8_t *a0, unsigned a0sz,
                           const uint8_t *a1, unsigned a1sz,
                           const uint8_t *a2, unsigned a2sz) {
  (void)s; (void)a0; (void)a0sz; (void)a2sz;
  uint8_t src[16];
  unsigned imm = a2[0];
  rc_widecheck("pshufhw", outsz, 16u);
  rc_widecheck("pshufhw", a1sz, 16u);
  memcpy(src, a1, 16);
  memcpy(out, src, 8);                  /* low qword copied through */
  for (int i = 0; i < 4; ++i)           /* high qword: 4 shuffled words */
    memcpy(out + 8 + 2 * i, src + 8 + 2 * ((imm >> (2 * i)) & 3u), 2);
}

/* Round 26: the twelve SSE wide intrinsics the tree declares and the port
 * had left as aborting stubs. The first video (theora, SSSE3 paths) died
 * on pmaddubsw. Two-operand forms: a0 = old destination, a1 = source; the
 * one-source ops (pabsd, pmovsxwd, pmovzxwd) still receive a0 and ignore
 * it. All alias-safe: inputs are copied out before `out` is written.
 * Each one is in the wideops oracle (scripts/recomp/oracle/wideops.py). */
static int16_t rc_sat16w(int32_t v) { return (int16_t)(v > 32767 ? 32767 : (v < -32768 ? -32768 : v)); }
#define RC_WIDE2(name)                                                      \
  void recomp_otherw_##name(CpuState *s, uint8_t *out, unsigned outsz,        \
                            const uint8_t *a0, unsigned a0sz,                 \
                            const uint8_t *a1, unsigned a1sz) {               \
    uint8_t x[16], y[16]; (void)s;                                            \
    rc_widecheck(#name, outsz, 16u); rc_widecheck(#name, a0sz, 16u);          \
    /* the source may be narrower (pmovsx/zx m64, a psraw imm8): zero-fill */ \
    if (a1sz != 16u && a1sz != 8u && a1sz != 4u && a1sz != 1u)                \
      rc_widecheck(#name, a1sz, 16u);                                         \
    memcpy(x, a0, 16); memset(y, 0, 16); memcpy(y, a1, a1sz);                 \
    rc_body_##name(out, x, y);                                                \
  }
static void rc_body_pmaddubsw(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 8; ++i) {
    int32_t v = (int32_t)x[2 * i] * (int8_t)y[2 * i] + (int32_t)x[2 * i + 1] * (int8_t)y[2 * i + 1];
    int16_t r = rc_sat16w(v); memcpy(out + 2 * i, &r, 2);
  }
}
static void rc_body_pshufb(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 16; ++i) out[i] = (y[i] & 0x80u) ? 0u : x[y[i] & 0x0fu];
}
static void rc_body_paddsw(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 8; ++i) {
    int16_t a, b; memcpy(&a, x + 2 * i, 2); memcpy(&b, y + 2 * i, 2);
    int16_t r = rc_sat16w((int32_t)a + (int32_t)b); memcpy(out + 2 * i, &r, 2);
  }
}
static void rc_body_pmulhuw(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 8; ++i) {
    uint16_t a, b; memcpy(&a, x + 2 * i, 2); memcpy(&b, y + 2 * i, 2);
    uint16_t r = (uint16_t)(((uint32_t)a * (uint32_t)b) >> 16); memcpy(out + 2 * i, &r, 2);
  }
}
static void rc_body_pmulld(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 4; ++i) {
    uint32_t a, b; memcpy(&a, x + 4 * i, 4); memcpy(&b, y + 4 * i, 4);
    uint32_t r = a * b; memcpy(out + 4 * i, &r, 4);
  }
}
static void rc_body_pabsd(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  (void)x;
  for (int i = 0; i < 4; ++i) {
    int32_t a; memcpy(&a, y + 4 * i, 4);
    uint32_t r = a < 0 ? (uint32_t)0u - (uint32_t)a : (uint32_t)a;   /* INT_MIN stays 0x80000000 */
    memcpy(out + 4 * i, &r, 4);
  }
}
static void rc_body_pmovsxwd(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  (void)x;
  for (int i = 0; i < 4; ++i) {
    int16_t a; memcpy(&a, y + 2 * i, 2);
    int32_t r = (int32_t)a; memcpy(out + 4 * i, &r, 4);
  }
}
static void rc_body_pmovzxwd(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  (void)x;
  for (int i = 0; i < 4; ++i) {
    uint16_t a; memcpy(&a, y + 2 * i, 2);
    uint32_t r = (uint32_t)a; memcpy(out + 4 * i, &r, 4);
  }
}
static void rc_body_psraw(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  uint64_t cnt; memcpy(&cnt, y, 8);         /* the count is the source's low qword */
  unsigned sh = cnt > 15u ? 15u : (unsigned)cnt;
  for (int i = 0; i < 8; ++i) {
    int16_t a; memcpy(&a, x + 2 * i, 2);
    int16_t r = (int16_t)(a >> sh); memcpy(out + 2 * i, &r, 2);
  }
}
static void rc_body_divps(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 4; ++i) {
    float a, b; memcpy(&a, x + 4 * i, 4); memcpy(&b, y + 4 * i, 4);
    float r = a / b; memcpy(out + 4 * i, &r, 4);
  }
}
static void rc_body_maxps(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 4; ++i) {              /* SSE: the second operand wins on NaN and on equal (incl. -0/+0) */
    float a, b; memcpy(&a, x + 4 * i, 4); memcpy(&b, y + 4 * i, 4);
    float r = (a > b) ? a : b; memcpy(out + 4 * i, &r, 4);
  }
}
static void rc_body_minps(uint8_t *out, const uint8_t *x, const uint8_t *y) {
  for (int i = 0; i < 4; ++i) {
    float a, b; memcpy(&a, x + 4 * i, 4); memcpy(&b, y + 4 * i, 4);
    float r = (a < b) ? a : b; memcpy(out + 4 * i, &r, 4);
  }
}
RC_WIDE2(pmaddubsw)
RC_WIDE2(pshufb)
RC_WIDE2(paddsw)
RC_WIDE2(pmulhuw)
RC_WIDE2(pmulld)
RC_WIDE2(pabsd)
RC_WIDE2(pmovsxwd)
RC_WIDE2(pmovzxwd)
RC_WIDE2(psraw)
RC_WIDE2(divps)
RC_WIDE2(maxps)
RC_WIDE2(minps)
#undef RC_WIDE2

uint32_t recomp_other_swi(CpuState *s, uint32_t n) {
  (void)s;
  fprintf(stderr, "recomp: software interrupt %u\n", (unsigned)n);
  abort();
  return 0;
}

/* ---- stall watchdog ----------------------------------------------------
 * The boot has silent phases (a 4096x4096 PNG decode is ~150 s of lifted
 * code) and, once it reaches the game's main loop, silent spins that never
 * end (round 12: a loop after "Menu Online Awards Init" that presents no
 * frame). ISAAC_STALL_DUMP=<seconds>: when no isaac_log line has appeared
 * for that long, print the last 512 executed VAs (with a histogram of the
 * hottest addresses, which is the loop), the register image from the last
 * spill, and the guest stack from that ESP; then re-arm for the next
 * interval. recomp_last_log_ms is stamped by isaac_log (host_trap.c). */
double recomp_last_log_ms;
static double stall_ms = -1.0;
double recomp_now_ms(void) {
  return emscripten_get_now();
}
/* ---- sampling profiler ---------------------------------------------------
 * ISAAC_PROFILE=1: on every tick (RECOMP_TICK_MASK+1 instructions, recomp_rt.h)
 * attribute recomp_cur_va to its containing lifted function (binary search
 * over the dispatch table's sorted entry VAs g_dva[]) and count it.
 * recomp_profile_report() (run with the stub report at exit) prints the
 * hottest functions, and -- the number that matters for a stall -- the
 * effective MIPS: lifted code executing at a normal rate means the phase IS
 * guest work, while a near-zero rate means the wall time is being spent
 * outside the module (round 15b). */
extern const uint32_t g_dva[];
extern const uint32_t g_ndispatch;
static uint32_t *prof_counts;
static uint32_t prof_samples, prof_unknown;
static double prof_t0;
static int prof_on = -1;
static uint32_t prof_lookup(uint32_t va) {
  uint32_t lo = 0, hi = g_ndispatch;
  while (lo + 1 < hi) {
    uint32_t mid = (lo + hi) / 2;
    if (g_dva[mid] <= va) lo = mid; else hi = mid;
  }
  return lo;
}
static void prof_sample(void) {
  if (prof_on < 0) {
    const char *e = getenv("ISAAC_PROFILE");
    prof_on = (e && *e && *e != '0') ? 1 : 0;
    if (prof_on) {
      prof_counts = (uint32_t *)calloc(g_ndispatch, sizeof(uint32_t));
      prof_t0 = emscripten_get_now();
      fprintf(stderr, "[recomp][PROF] sampling every %u lifted instructions over %u functions\n",
              (unsigned)RECOMP_TICK_MASK + 1u, g_ndispatch);
    }
  }
  if (!prof_on || !prof_counts) return;
  uint32_t va = recomp_cur_va;
  prof_samples++;
  if (g_ndispatch && va >= g_dva[0]) prof_counts[prof_lookup(va)]++;
  else prof_unknown++;
}
void recomp_profile_report(void) {
  if (!prof_on || !prof_counts || !prof_samples) return;
  double secs = (emscripten_get_now() - prof_t0) / 1000.0;
  {
    /* one sample per tick: instructions = samples * (mask + 1) */
    double insns = (double)prof_samples * ((double)RECOMP_TICK_MASK + 1.0);
    fprintf(stderr, "[recomp][PROF] %u samples = %.1f Mi lifted instructions in %.1f s (%.1f MIPS); %u outside the table\n",
            prof_samples, insns / 1048576.0, secs,
            secs > 0 ? insns / 1e6 / secs : 0.0, prof_unknown);
  }
  fprintf(stderr, "[recomp][PROF] ---- hottest lifted functions (samples, share, entry VA):\n");
  for (unsigned rank = 0; rank < 40; rank++) {
    uint32_t best = 0;
    for (uint32_t i = 1; i < g_ndispatch; i++) if (prof_counts[i] > prof_counts[best]) best = i;
    if (!prof_counts[best]) break;
    fprintf(stderr, "[recomp][PROF]   %7u  %5.1f%%  0x%08x\n", prof_counts[best],
            100.0 * prof_counts[best] / prof_samples, g_dva[best]);
    prof_counts[best] = 0;
  }
}

/* ISAAC_EXIT_AFTER=<seconds> (round 14j): leave with the reports after that
 * much wall time, whatever the log is doing. The silence watchdog never
 * fires inside a texture load: the reads stamp the log clock without
 * printing a line. */
static double exit_after_ms = -1.0, exit_t0;
static void exit_after_tick(void) {
  if (exit_after_ms < 0.0) {
    const char *e = getenv("ISAAC_EXIT_AFTER");
    exit_after_ms = (e && *e) ? atof(e) * 1000.0 : 0.0;
    exit_t0 = emscripten_get_now();
    if (exit_after_ms > 0.0)
      fprintf(stderr, "[recomp][EXIT] leaving with the reports after %.0f ms\n", exit_after_ms);
  }
  if (exit_after_ms <= 0.0 || emscripten_get_now() - exit_t0 < exit_after_ms) return;
  fprintf(stderr, "[recomp][EXIT] ISAAC_EXIT_AFTER reached at VA 0x%08x: exiting now (status 3)\n", recomp_cur_va);
  { extern void isaac_stub_report(void); isaac_stub_report(); }
  emscripten_force_exit(3);
}

/* guest range check for the dump above: below the host base, above the
 * first page */
static int isaac_is_guest_addr(uint32_t a) { return a >= 0x1000u && a < 0x0ff00000u; }

void recomp_stall_tick(void) {
  prof_sample();
  exit_after_tick();
  if (stall_ms < 0.0) {
    const char *e = getenv("ISAAC_STALL_DUMP");
    stall_ms = (e && *e) ? atof(e) * 1000.0 : 0.0;
    if (stall_ms > 0.0)
      fprintf(stderr, "[recomp][STALL] watchdog armed: dump after %.0f ms of log silence\n", stall_ms);
  }
  if (stall_ms <= 0.0) return;
  double now = recomp_now_ms();
  if (recomp_last_log_ms <= 0.0) { recomp_last_log_ms = now; return; }
  if (now - recomp_last_log_ms < stall_ms) return;
  recomp_last_log_ms = now;
  fprintf(stderr, "[recomp][STALL] no log line for %.0f ms; current VA 0x%08x\n",
          stall_ms, recomp_cur_va);
  /* histogram of the ring: the loop body is whatever dominates */
  uint32_t vas[512]; unsigned cnt[512]; unsigned n = 0;
  for (unsigned i = 0; i < 512; i++) {
    uint32_t v = recomp_va_trace[i];
    unsigned k;
    for (k = 0; k < n; k++) if (vas[k] == v) { cnt[k]++; break; }
    if (k == n) { vas[n] = v; cnt[n] = 1; n++; }
  }
  fprintf(stderr, "[recomp][STALL] ---- hottest VAs in the last 512 (count va):\n");
  for (unsigned round = 0; round < 24 && round < n; round++) {
    unsigned best = 0;
    for (unsigned k = 1; k < n; k++) if (cnt[k] > cnt[best]) best = k;
    if (!cnt[best]) break;
    fprintf(stderr, "[recomp][STALL]   %3u 0x%08x\n", cnt[best], vas[best]);
    cnt[best] = 0;
  }
  uint32_t start = recomp_va_trace_idx & 511u;
  fprintf(stderr, "[recomp][STALL] ---- last 64 executed VAs (oldest -> newest):\n");
  for (unsigned i = 448; i < 512; i++)
    fprintf(stderr, "[recomp][STALL]   %08x\n", recomp_va_trace[(start + i) & 511u]);
  {
    extern void isaac_dump_regs(const struct CpuState *s, const char *tag);
    if (recomp_last_cpu) {
      isaac_dump_regs(recomp_last_cpu, "register image (from the last spill; stale inside a call-free loop)");
      /* A hang is almost always a loop over an object, and the object is
       * whatever a pointer register holds. Print the first 16 dwords at each
       * of them: the round-15f hang was a ring-buffer fill whose count and
       * capacity live at [esi+0x50..0x5c], and reading those needed a rebuild
       * with a bespoke probe. CpuState's leading dwords are
       * EAX ECX EDX EBX ESP EBP ESI EDI. */
      {
        static const char *rn[] = {"EAX","ECX","EDX","EBX","ESP","EBP","ESI","EDI"};
        const uint32_t *r = (const uint32_t *)recomp_last_cpu;
        for (unsigned k = 0; k < 8; ++k) {
          uint32_t p = r[k];
          if (k == 4u || p < 0x1000u || p >= 0x0ff00000u) continue;   /* ESP is walked below */
          fprintf(stderr, "[recomp][STALL] ---- dwords around %s = 0x%08x:\n", rn[k], p);
          /* below the pointer as well as above it: a loop's bounds live in
           * stack locals at negative offsets from EBP */
          for (int32_t off = -32; off < 48; off += 4) {
            uint32_t a = (uint32_t)((int32_t)p + off * 4);
            if (!isaac_is_guest_addr(a) || !isaac_is_guest_addr(a + 12u)) continue;
            fprintf(stderr, "[recomp][STALL]   %c0x%02x: %08x %08x %08x %08x\n",
                    off < 0 ? '-' : '+', (unsigned)(off < 0 ? -off : off) * 4u,
                    MEMR32(a), MEMR32(a + 4u), MEMR32(a + 8u), MEMR32(a + 12u));
          }
        }
      }
      uint32_t esp = ((const uint32_t *)recomp_last_cpu)[4];
      fprintf(stderr, "[recomp][STALL] ---- guest stack from the spilled ESP 0x%08x:\n", esp);
      for (uint32_t i = 0; i < 64; i += 4) {
        uint32_t a = esp + i * 4u;
        if (a + 16u > 0x0dff0000u || a < 0x0dee0000u) break;
        fprintf(stderr, "[recomp][STALL]   %08x: %08x %08x %08x %08x\n", a,
                ((uint32_t *)RECOMP_PTR(a))[0], ((uint32_t *)RECOMP_PTR(a))[1],
                ((uint32_t *)RECOMP_PTR(a))[2], ((uint32_t *)RECOMP_PTR(a))[3]);
      }
    }
  }
  /* ISAAC_STALL_EXIT=1: leave through process.exit after the first dump so a
   * `node --cpu-prof` run writes its profile (a kill loses it). */
  {
    const char *x = getenv("ISAAC_STALL_EXIT");
    if (x && *x && *x != '0') {
      fprintf(stderr, "[recomp][STALL] ISAAC_STALL_EXIT: exiting now (status 3)\n");
      { extern void isaac_stub_report(void); isaac_stub_report(); }
      emscripten_force_exit(3);
    }
  }
}

/* Only referenced by TUs built with -DRECOMP_MEM_CHECK=1. */
void recomp_mem_fault(uint32_t addr, unsigned bytes, int write) {
  fprintf(stderr,
          "[recomp][MEM] guest %s of %u byte(s) at 0x%08x is outside the "
          "guest address space -- the lifted code computed a bad pointer.\n"
          "                 last lifted instruction: 0x%08x\n",
          write ? "write" : "read", bytes, addr, recomp_cur_va);
  /* instruction trace: last 512 executed guest VAs */
  uint32_t n = recomp_va_trace_idx < 512u ? recomp_va_trace_idx : 512u;
  uint32_t start = (recomp_va_trace_idx - n) & 511u;
  fprintf(stderr, "[recomp][MEM] ---- last %u executed guest VAs (oldest -> newest):\n", n);
  for (uint32_t i = 0; i < n; i++)
    fprintf(stderr, "[recomp][MEM]   %08x\n", recomp_va_trace[(start + i) & 511u]);
  /* register image from the last shim dispatch (captured in host_trap.c) */
  {
    extern void isaac_dump_regs(const struct CpuState *s, const char *tag);
    if (recomp_last_cpu)
      isaac_dump_regs(recomp_last_cpu, "register image (from last shim dispatch)");
    else
      fprintf(stderr, "[recomp][MEM]   (no shim dispatch has run - recomp_last_cpu is null)\n");
  }
  /* guest stack from the last spilled ESP: the return addresses in this
   * window are the call chain, which the 512-VA ring cannot show once the
   * fault is inside a hot helper (boot round 11: a string assign reached
   * from a logger loop that filled the whole ring). ESP is as of the last
   * register spill (a call boundary), i.e. at most one frame stale. */
  if (recomp_last_cpu) {
    uint32_t esp = ((const uint32_t *)recomp_last_cpu)[4]; /* CpuState: EAX ECX EDX EBX ESP ... */
    fprintf(stderr, "[recomp][MEM] ---- guest stack from the spilled ESP 0x%08x (return addresses mark the callers):\n", esp);
    for (uint32_t i = 0; i < 128; i += 4) {
      uint32_t a = esp + i * 4u;
      if (a + 16u > 0x0dff0000u || a < 0x0dee0000u) break;
      fprintf(stderr, "[recomp][MEM]   %08x: %08x %08x %08x %08x\n", a,
              ((uint32_t *)RECOMP_PTR(a))[0], ((uint32_t *)RECOMP_PTR(a))[1],
              ((uint32_t *)RECOMP_PTR(a))[2], ((uint32_t *)RECOMP_PTR(a))[3]);
    }
  }
  abort();
}
