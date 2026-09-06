/* Differential harness: mechanically lifted x86 vs. the existing
 * hand-verified translations in native/decomp, run under wasm in Node.
 *
 * Guest addresses are identity-mapped onto wasm linear memory, which is
 * the model both sides already use, so one malloc'd block is shared.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "recomp_state.h"
#include "recomp_rt.h"
#include "lifted_decls.h"

/* hand-verified references (native/decomp) */
#include "exit_pure_helpers.h"
#include "frame_opaque_pure_helpers.h"

/* ------------------------------------------------------------------ */
/* boundary: the CRT free() the lifted string-tidy tail-calls.         */

static int g_free_called;
static uint32_t g_free_ptr, g_free_bytes;

void sub_00aef15c(CpuState *restrict s) {
  /* __cdecl free_base(void *p, size_t n): args at [esp+4], [esp+8]. */
  g_free_called = 1;
  g_free_ptr = MEMR32(s->ESP + 4);
  g_free_bytes = MEMR32(s->ESP + 8);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4;              /* cdecl: caller cleans the args */
  s->EAX = 0;
}

/* ------------------------------------------------------------------ */
/* guest stack + call setup                                            */

#define GSTACK_BYTES 0x10000
static uint8_t *g_stack;
#define FAKE_RET 0x00deadbeu

static void cpu_reset(CpuState *s) {
  memset(s, 0, sizeof(*s));
  s->ESP = (uint32_t)(uintptr_t)(g_stack + GSTACK_BYTES - 0x100);
  s->EBP = s->ESP;
  s->DF = 0;
}

static void gpush(CpuState *s, uint32_t v) {
  s->ESP -= 4;
  MEMW32(s->ESP, v);
}

/* ------------------------------------------------------------------ */
/* deterministic RNG so both sides see identical inputs                */

static uint32_t rs = 0x1234567u;
static uint32_t rnd(void) {
  rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5;
  return rs;
}

/* ------------------------------------------------------------------ */
/* MSVC basic_string / _Tree layout                                    */

#define STR_SIZE_OFF 0x10
#define STR_CAP_OFF  0x14
#define STR_BYTES    0x18
#define NODE_LEFT    0x00
#define NODE_PARENT  0x04
#define NODE_RIGHT   0x08
#define NODE_ISNIL   0x0d
#define NODE_KEY     0x10
#define NODE_BYTES   0x40

static void put32(uint32_t a, uint32_t v) { MEMW32(a, v); }
static uint32_t get32(uint32_t a) { return MEMR32(a); }

/* Write an SSO or heap-backed MSVC string at `at`. */
static void make_string(uint32_t at, const char *txt, int force_heap,
                        uint8_t **heap_cursor) {
  size_t n = strlen(txt);
  memset((void *)(uintptr_t)at, 0, STR_BYTES);
  if (!force_heap && n < 0x10) {
    memcpy((void *)(uintptr_t)at, txt, n);
    put32(at + STR_SIZE_OFF, (uint32_t)n);
    put32(at + STR_CAP_OFF, 0xf);
  } else {
    uint8_t *p = *heap_cursor;
    memcpy(p, txt, n + 1);
    *heap_cursor = p + ((n + 0x10) & ~(size_t)0xf);
    put32(at, (uint32_t)(uintptr_t)p);
    put32(at + STR_SIZE_OFF, (uint32_t)n);
    put32(at + STR_CAP_OFF, (uint32_t)(n < 0x10 ? 0x1f : n + 0x10));
  }
}

/* ------------------------------------------------------------------ */
/* TEST 1: 0x0040d040  MSVC basic_string tidy / deallocate             */

static int test_tidy(int iters, int verbose) {
  CpuState st;
  int fails = 0;
  uint8_t *arena = (uint8_t *)malloc(0x20000);
  for (int i = 0; i < iters; ++i) {
    memset(arena, 0xAA, 0x20000);
    uint32_t obj = (uint32_t)(uintptr_t)(arena + 0x100);
    uint32_t payload = (uint32_t)(uintptr_t)(arena + 0x1000);
    uint32_t header = payload - 8 - (rnd() % 0x30);   /* may be invalid */
    uint32_t cap;
    switch (i % 4) {
      case 0: cap = rnd() % 0x10; break;                 /* SSO */
      case 1: cap = 0x10 + rnd() % 0x100; break;         /* small heap */
      case 2: cap = 0xfff; break;                        /* boundary */
      default: cap = 0x1000 + rnd() % 0x1000; break;     /* aligned heap */
    }
    if (i % 4 >= 2) header = payload - 4 - (rnd() % 0x20);  /* valid delta */

    memset((void *)(uintptr_t)obj, 0x5A, STR_BYTES);
    put32(obj, payload);
    put32(obj + STR_SIZE_OFF, 0x1234);
    put32(obj + STR_CAP_OFF, cap);
    put32(payload - 4, header);

    /* ---- reference model ---- */
    IsaacFrameOpaque40d040Plan plan;
    memset(&plan, 0, sizeof(plan));
    isaac_frame_opaque_40d040_tidy_plan(&plan, cap, payload, header);
    if (plan.invalid) continue;   /* noreturn path; not modelled here */

    /* ---- lifted ---- */
    g_free_called = 0; g_free_ptr = 0; g_free_bytes = 0;
    cpu_reset(&st);
    st.ECX = obj;
    gpush(&st, FAKE_RET);
    sub_0040d040(&st);

    int bad = 0;
    if (g_free_called != plan.host_free) bad = 1;
    if (plan.host_free) {
      if (g_free_ptr != plan.free_ptr) bad = 2;
      if (g_free_bytes != plan.free_bytes) bad = 3;
    }
    if (get32(obj + STR_SIZE_OFF) != (uint32_t)plan.reset_size) bad = 4;
    if (get32(obj + STR_CAP_OFF) != plan.reset_capacity) bad = 5;
    if (*(uint8_t *)(uintptr_t)obj != 0) bad = 6;
    if (bad) {
      ++fails;
      if (verbose && fails < 6)
        printf("  tidy MISMATCH i=%d code=%d cap=%#x free(%d,%#x,%#x) "
               "plan(%d,%#x,%#x)\n", i, bad, cap, g_free_called, g_free_ptr,
               g_free_bytes, plan.host_free, plan.free_ptr, plan.free_bytes);
    }
  }
  free(arena);
  return fails;
}

/* ------------------------------------------------------------------ */
/* TEST 2: 0x00685bc0  std::map<string,...>::lower_bound               */

#define MAXN 64

typedef struct {
  uint32_t map_obj, sentinel, nodes[MAXN];
  int n;
} Tree;

static uint32_t build_subtree(Tree *t, int lo, int hi, uint32_t parent,
                              uint32_t nil) {
  if (lo > hi) return nil;
  int mid = (lo + hi) / 2;
  uint32_t nd = t->nodes[mid];
  put32(nd + NODE_PARENT, parent);
  put32(nd + NODE_LEFT, build_subtree(t, lo, mid - 1, nd, nil));
  put32(nd + NODE_RIGHT, build_subtree(t, mid + 1, hi, nd, nil));
  return nd;
}

static void tree_build(Tree *t, uint8_t *arena, int n, int force_heap,
                       char keys[][32]) {
  uint8_t *cursor = arena;
  t->map_obj = (uint32_t)(uintptr_t)cursor;   cursor += 0x20;
  t->sentinel = (uint32_t)(uintptr_t)cursor;  cursor += NODE_BYTES;
  t->n = n;
  for (int i = 0; i < n; ++i) {
    t->nodes[i] = (uint32_t)(uintptr_t)cursor;
    cursor += NODE_BYTES;
  }
  uint8_t *heap = cursor;
  memset((void *)(uintptr_t)t->sentinel, 0, NODE_BYTES);
  *(uint8_t *)(uintptr_t)(t->sentinel + NODE_ISNIL) = 1;
  for (int i = 0; i < n; ++i) {
    memset((void *)(uintptr_t)t->nodes[i], 0, NODE_BYTES);
    *(uint8_t *)(uintptr_t)(t->nodes[i] + NODE_ISNIL) = 0;
    make_string(t->nodes[i] + NODE_KEY, keys[i], force_heap, &heap);
  }
  uint32_t root = build_subtree(t, 0, n - 1, t->sentinel, t->sentinel);
  put32(t->sentinel + NODE_PARENT, root);
  put32(t->sentinel + NODE_LEFT, n ? t->nodes[0] : t->sentinel);
  put32(t->sentinel + NODE_RIGHT, n ? t->nodes[n - 1] : t->sentinel);
  put32(t->map_obj, t->sentinel);
}

static int keycmp(const void *a, const void *b) {
  return strcmp((const char *)a, (const char *)b);
}

static int test_lower_bound(int iters, int verbose) {
  CpuState st;
  int fails = 0;
  uint8_t *arena = (uint8_t *)malloc(0x40000);
  static char keys[MAXN][32];
  for (int it = 0; it < iters; ++it) {
    int n = (int)(rnd() % MAXN);
    int force_heap = (int)(rnd() & 1);
    for (int i = 0; i < n; ++i) {
      int len = 1 + (int)(rnd() % (force_heap ? 24 : 12));
      for (int j = 0; j < len; ++j) keys[i][j] = 'a' + (char)(rnd() % 4);
      keys[i][len] = 0;
    }
    qsort(keys, (size_t)n, 32, keycmp);
    /* de-dup so the tree is a valid strict-weak-ordered map */
    int m = 0;
    for (int i = 0; i < n; ++i)
      if (i == 0 || strcmp(keys[i], keys[m - 1]) != 0)
        memmove(keys[m++], keys[i], 32);
    n = m;

    memset(arena, 0xCD, 0x40000);
    Tree t;
    tree_build(&t, arena, n, force_heap, keys);

    /* probe key */
    uint32_t probe = (uint32_t)(uintptr_t)(arena + 0x30000);
    char pk[32];
    int plen = 1 + (int)(rnd() % 20);
    for (int j = 0; j < plen; ++j) pk[j] = 'a' + (char)(rnd() % 4);
    pk[plen] = 0;
    uint8_t *pheap = arena + 0x30100;
    make_string(probe, pk, (int)(rnd() & 1), &pheap);

    uint32_t out_ref = (uint32_t)(uintptr_t)(arena + 0x38000);
    uint32_t out_lift = (uint32_t)(uintptr_t)(arena + 0x38100);
    memset((void *)(uintptr_t)out_ref, 0xEE, 16);
    memset((void *)(uintptr_t)out_lift, 0xEE, 16);

    /* ---- reference ---- */
    uint32_t r_ref = isaac_exit_map_lower_bound(t.map_obj, out_ref, probe);

    /* ---- lifted: thiscall, ret 8, args (out, key) ---- */
    cpu_reset(&st);
    st.ECX = t.map_obj;
    gpush(&st, probe);        /* [ebp+0xc] */
    gpush(&st, out_lift);     /* [ebp+8]   */
    gpush(&st, FAKE_RET);
    sub_00685bc0(&st);
    uint32_t r_lift = st.EAX;

    int bad = 0;
    if (r_ref != out_ref || r_lift != out_lift) bad = 1;
    for (int k = 0; k < 3; ++k)
      if (get32(out_ref + 4 * k) != get32(out_lift + 4 * k)) bad = 2 + k;
    if (bad) {
      ++fails;
      if (verbose && fails < 6)
        printf("  lb MISMATCH it=%d n=%d code=%d ref[%#x %#x %#x] "
               "lift[%#x %#x %#x]\n", it, n, bad,
               get32(out_ref), get32(out_ref + 4), get32(out_ref + 8),
               get32(out_lift), get32(out_lift + 4), get32(out_lift + 8));
    }
  }
  free(arena);
  return fails;
}

/* ------------------------------------------------------------------ */
/* TEST 3: 0x00423480  MSVC traits::compare
 * ABI recovered from the call site at 0x00685c09: ecx = s1, edx = len1,
 * [esp+4] = s2, [esp+8] = len2.  Reference semantics per the hand-verified
 * note in exit_pure_helpers.cpp: min-length memcmp, then length order.
 */

static int ref_compare(const char *a, uint32_t la, const char *b, uint32_t lb) {
  uint32_t n = la < lb ? la : lb;
  for (uint32_t i = 0; i < n; ++i) {
    unsigned char x = (unsigned char)a[i], y = (unsigned char)b[i];
    if (x != y) return x < y ? -1 : 1;
  }
  if (lb > la) return -1;
  if (la > lb) return 1;
  return 0;
}

static int test_strcmp(int iters, int verbose) {
  CpuState st;
  int fails = 0;
  uint8_t *arena = (uint8_t *)malloc(0x1000);
  for (int i = 0; i < iters; ++i) {
    char a[40], b[40];
    int la = (int)(rnd() % 20), lb = (int)(rnd() % 20);
    for (int j = 0; j < la; ++j) a[j] = 'a' + (char)(rnd() % 3);
    for (int j = 0; j < lb; ++j) b[j] = 'a' + (char)(rnd() % 3);
    a[la] = 0; b[lb] = 0;
    memset(arena, 0x7E, 0x1000);
    memcpy(arena, a, (size_t)la);
    memcpy(arena + 0x40, b, (size_t)lb);
    uint32_t pa = (uint32_t)(uintptr_t)arena;
    uint32_t pb = (uint32_t)(uintptr_t)(arena + 0x40);
    cpu_reset(&st);
    st.ECX = pa;                 /* s1  */
    st.EDX = (uint32_t)la;       /* len1 */
    gpush(&st, (uint32_t)lb);    /* [ebp+0xc] len2 */
    gpush(&st, pb);              /* [ebp+8]   s2   */
    gpush(&st, FAKE_RET);
    sub_00423480(&st);
    int32_t got = (int32_t)st.EAX;
    int want = ref_compare(a, (uint32_t)la, b, (uint32_t)lb);
    int sg = (got > 0) - (got < 0), sw = (want > 0) - (want < 0);
    if (sg != sw) {
      ++fails;
      if (verbose && fails < 6)
        printf("  compare MISMATCH '%s'(%d) vs '%s'(%d): lifted=%d ref=%d\n",
               a, la, b, lb, got, want);
    }
  }
  free(arena);
  return fails;
}

/* ------------------------------------------------------------------ */

int main(int argc, char **argv) {
  int iters = argc > 1 ? atoi(argv[1]) : 2000;
  g_stack = (uint8_t *)malloc(GSTACK_BYTES);
  printf("lifted-vs-handwritten differential test (%d iterations each)\n",
         iters);
  printf("  sizeof(CpuState) = %u bytes\n", (unsigned)sizeof(CpuState));

  int f1 = test_strcmp(iters, 1);
  printf("  0x00423480 string compare : %s (%d/%d mismatches)\n",
         f1 ? "FAIL" : "PASS", f1, iters);
  int f2 = test_tidy(iters, 1);
  printf("  0x0040d040 string tidy    : %s (%d mismatches)\n",
         f2 ? "FAIL" : "PASS", f2);
  int f3 = test_lower_bound(iters / 4 + 1, 1);
  printf("  0x00685bc0 map lower_bound: %s (%d mismatches)\n",
         f3 ? "FAIL" : "PASS", f3);

  int bad = f1 + f2 + f3;
  printf("%s\n", bad ? "RESULT: FAIL" : "RESULT: ALL PASS");
  return bad ? 1 : 0;
}
