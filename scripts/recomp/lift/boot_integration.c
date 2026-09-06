/* Integration entry: lifted module + host layer, driven from JS.
 *
 * The memory image is placed by JS straight into linear memory at the
 * guest VAs (identity addressing), then the host boot path runs steps
 * 3-6 and finally main.  Everything here is thin: the point is to find
 * out where real game code stops, not to add behaviour.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "isaac_host.h"
#include "dispatch_tbl.h"

/* ---- memory image ------------------------------------------------ */

static int g_image_loaded;
int isaac_image_is_loaded(void) { return g_image_loaded; }

/* JS hands us the whole isaac.segs.bin; we place the segments. */
int isaac_place_image(const uint8_t *blob, uint32_t len) {
  if (len < 16 || memcmp(blob, "ISMG", 4) != 0) return -1;
  uint32_t ver, count, base;
  memcpy(&ver, blob + 4, 4);
  memcpy(&count, blob + 8, 4);
  memcpy(&base, blob + 12, 4);
  if (ver != 1) return -2;
  const uint8_t *idx = blob + 16;
  const uint8_t *body = idx + (size_t)count * 8;
  uint64_t placed = 0;
  for (uint32_t i = 0; i < count; ++i) {
    uint32_t va, n;
    memcpy(&va, idx + 8 * i, 4);
    memcpy(&n, idx + 8 * i + 4, 4);
    if (va < ISAAC_IMAGE_BASE || (uint64_t)va + n > ISAAC_IMAGE_END) return -3;
    if (body + n > blob + len) return -4;
    memcpy((void *)(uintptr_t)va, body, n);
    body += n;
    placed += n;
  }
  g_image_loaded = 1;
  return (int)count;
}

/* ---- guard region ------------------------------------------------- */
/* The 1 MiB below ISAAC_HOST_BASE_VA is never legitimately touched.  A
 * guest wild write that reaches it is the early warning for the failure
 * that cost a whole debugging session on the oracle harness: guest code
 * scribbling over host state and producing symptoms that point nowhere. */

#define GUARD_PAT 0xA5C3D200u

void isaac_guard_arm(void) {
  uint32_t *p = (uint32_t *)(uintptr_t)ISAAC_GUARD_VA;
  uint32_t n = ISAAC_GUARD_SIZE / 4;
  for (uint32_t i = 0; i < n; ++i) p[i] = GUARD_PAT ^ i;
}

/* Returns the number of corrupted words, 0 if intact. */
uint32_t isaac_guard_check(void) {
  const uint32_t *p = (const uint32_t *)(uintptr_t)ISAAC_GUARD_VA;
  uint32_t n = ISAAC_GUARD_SIZE / 4, bad = 0, first = 0;
  for (uint32_t i = 0; i < n; ++i) {
    if (p[i] != (GUARD_PAT ^ i)) {
      if (!bad) first = i;
      ++bad;
    }
  }
  if (bad)
    fprintf(stderr, "[isaac][GUARD] %u words corrupted, first at 0x%08x\n",
            bad, (unsigned)(ISAAC_GUARD_VA + first * 4));
  return bad;
}

/* ---- layout self-check -------------------------------------------- */
/* Confirms the lifter's and the host's address maps actually agree,
 * rather than each being individually plausible. */
int isaac_layout_check(void) {
  int bad = 0;
  uint32_t host_probe = (uint32_t)(uintptr_t)&g_image_loaded;
  uint32_t heap_probe = (uint32_t)(uintptr_t)malloc(64);
  printf("layout:\n");
  printf("  image           0x%08x .. 0x%08x\n", ISAAC_IMAGE_BASE, ISAAC_IMAGE_END);
  printf("  guest heap      0x%08x .. 0x%08x\n", ISAAC_HEAP_VA,
         ISAAC_HEAP_VA + ISAAC_HEAP_SIZE);
  printf("  guest stack top 0x%08x\n", ISAAC_STACK_TOP_VA);
  printf("  fake TEB        0x%08x\n", ISAAC_TEB_VA);
  printf("  shim tokens     0x%08x .. 0x%08x\n", ISAAC_SHIM_BASE,
         ISAAC_SHIM_BASE + ISAAC_SHIM_STRIDE * isaac_import_count);
  printf("  guard           0x%08x .. 0x%08x\n", ISAAC_GUARD_VA,
         ISAAC_GUARD_VA + ISAAC_GUARD_SIZE);
  printf("  host static     0x%08x   (GLOBAL_BASE must be 0x%08x)\n",
         host_probe, ISAAC_HOST_BASE_VA);
  printf("  host malloc     0x%08x\n", heap_probe);
  printf("  dispatch entries %u\n", G_NDISPATCH);
  if (host_probe < ISAAC_HOST_BASE_VA) {
    printf("  FAIL host static data is below 0x%08x -- a guest pointer can "
           "reach it\n", ISAAC_HOST_BASE_VA);
    ++bad;
  }
  if (heap_probe < ISAAC_HOST_BASE_VA) {
    printf("  FAIL host heap is below 0x%08x\n", ISAAC_HOST_BASE_VA);
    ++bad;
  }
  if (ISAAC_SHIM_BASE + ISAAC_SHIM_STRIDE * isaac_import_count
      > ISAAC_GUARD_VA) {
    printf("  FAIL shim tokens overrun the guard\n");
    ++bad;
  }
  printf("  %s\n", bad ? "LAYOUT FAIL" : "layout OK");
  return bad;
}

/* ---- boot --------------------------------------------------------- */

int isaac_run_boot(int verbose) {
  isaac_boot_opts o;
  memset(&o, 0, sizeof(o));
  o.apply_relocations = 0;
  o.run_tls_callbacks = 1;
  o.run_initterms = 1;
  o.verbose = verbose;
  return isaac_boot_init(&o);
}

int isaac_run_main(void) { return isaac_boot_call_main(0, 0); }
