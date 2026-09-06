/* host_shims_cxx.c -- MSVC C++ ABI: __RTDynamicCast.
 *
 * 817 real calls from lifted code, on the steady-state path. This is what
 * `dynamic_cast<T*>` lowers to, and a C++ engine uses it constantly. It is the
 * top C++ item precisely because it is NOT the exception machinery: the frame
 * handler is entered only on a throw (0 real calls, 1,834 __ehhandler$
 * trampolines), whereas this runs during ordinary gameplay.
 *
 * Returning NULL instead of implementing it would be the same class of failure
 * as the cdecl-for-stdcall purge: a silently wrong answer. Every successful
 * downcast would become a failed one, and the game would take the "wrong type"
 * branch everywhere without a single diagnostic.
 *
 *   void *__RTDynamicCast(void *inptr, LONG VfDelta,
 *                         void *SrcType, void *TargetType, BOOL isReference)
 *
 * All of the RTTI it needs is already in the memory image: MSVC emits the
 * descriptors into .rdata, and identity addressing makes them plain reads.
 *
 * Layout (32-bit MSVC; all pointers are absolute VAs on x86, not image-relative
 * as they are on x64 -- that difference is the classic way to get this wrong):
 *
 *   vftable[-1]                      -> RTTICompleteObjectLocator
 *   RTTICompleteObjectLocator  { signature, offset, cdOffset,
 *                                pTypeDescriptor, pClassDescriptor }
 *   RTTIClassHierarchyDescriptor { signature, attributes, numBaseClasses,
 *                                  pBaseClassArray }
 *   RTTIBaseClassDescriptor    { pTypeDescriptor, numContainedBases,
 *                                PMD{mdisp,pdisp,vdisp}, attributes }
 *   TypeDescriptor             { pVFTable, spare, char name[] }
 */

#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <string.h>

/* RTTICompleteObjectLocator */
#define COL_SIGNATURE   0x00
#define COL_OFFSET      0x04
#define COL_CDOFFSET    0x08
#define COL_TYPEDESC    0x0C
#define COL_CLASSDESC   0x10

/* RTTIClassHierarchyDescriptor */
#define CHD_SIGNATURE   0x00
#define CHD_ATTRIBUTES  0x04
#define CHD_NUMBASES    0x08
#define CHD_BASEARRAY   0x0C

/* RTTIBaseClassDescriptor */
#define BCD_TYPEDESC    0x00
#define BCD_NUMCONTAIN  0x04
#define BCD_PMD_MDISP   0x08
#define BCD_PMD_PDISP   0x0C
#define BCD_PMD_VDISP   0x10
#define BCD_ATTRIBUTES  0x14
#define BCD_SIZE        0x18

/* TypeDescriptor */
#define TD_NAME         0x08

static unsigned g_casts, g_hits, g_misses, g_bad;

static int td_name_equal(uint32_t a, uint32_t b) {
    if (a == b) return 1;
    if (!a || !b) return 0;
    if (!isaac_in_image(a) || !isaac_in_image(b)) return 0;
    const char *x = (const char *)isaac_g(a + TD_NAME);
    const char *y = (const char *)isaac_g(b + TD_NAME);
    return strncmp(x, y, 512) == 0;
}

/* Resolve a PMD to a byte offset from the complete object. */
static int32_t pmd_offset(uint32_t complete, int32_t mdisp, int32_t pdisp,
                          int32_t vdisp) {
    if (pdisp < 0)
        return mdisp;                       /* non-virtual base: direct */
    /* Virtual base: read the vbtable pointer at complete+pdisp, then the
     * displacement at vbtable+vdisp. */
    uint32_t vbptr_at = complete + (uint32_t)pdisp;
    if (!isaac_is_guest_va(vbptr_at)) return mdisp;
    uint32_t vbtable = isaac_r32(vbptr_at);
    if (!isaac_is_guest_va(vbtable + (uint32_t)vdisp)) return mdisp;
    int32_t vd = (int32_t)isaac_r32(vbtable + (uint32_t)vdisp);
    return pdisp + vd + mdisp;
}

void imp_vcruntime140____RTDynamicCast(CpuState *restrict cpu) {
    uint32_t inptr   = isaac_arg(cpu, 0);
    int32_t  vfdelta = (int32_t)isaac_arg(cpu, 1);
    uint32_t srctype = isaac_arg(cpu, 2);
    uint32_t target  = isaac_arg(cpu, 3);
    uint32_t is_ref  = isaac_arg(cpu, 4);
    (void)srctype;
    ++g_casts;

    if (!inptr) {                       /* dynamic_cast<T*>(nullptr) == nullptr */
        cpu->EAX = 0;
        return;
    }
    if (!isaac_is_guest_va(inptr) || !isaac_is_guest_va(target)) {
        isaac_log("[isaac][c++] __RTDynamicCast: object 0x%08x or target type "
                  "0x%08x is outside the guest range (caller 0x%08x)",
                  inptr, target, isaac_retaddr(cpu));
        ++g_bad;
        cpu->EAX = 0;
        return;
    }

    /* The vfptr sits at inptr + VfDelta. */
    uint32_t vfptr_at = inptr + (uint32_t)vfdelta;
    uint32_t vftable = isaac_r32(vfptr_at);
    if (!isaac_in_image(vftable)) {
        isaac_log("[isaac][c++] __RTDynamicCast: vftable 0x%08x from object "
                  "0x%08x is not in the image (caller 0x%08x)",
                  vftable, inptr, isaac_retaddr(cpu));
        ++g_bad;
        cpu->EAX = 0;
        return;
    }

    uint32_t col = isaac_r32(vftable - 4);
    if (!isaac_in_image(col)) {
        isaac_log("[isaac][c++] __RTDynamicCast: no RTTI locator at "
                  "vftable[-1] (0x%08x); the class is not polymorphic or the "
                  "object is corrupt (caller 0x%08x)", col, isaac_retaddr(cpu));
        ++g_bad;
        cpu->EAX = 0;
        return;
    }

    /* Complete object = this subobject minus its offset within the whole. */
    uint32_t col_off = isaac_r32(col + COL_OFFSET);
    uint32_t complete = vfptr_at - col_off;

    /* Fast path: the target IS the complete object's type. */
    uint32_t col_td = isaac_r32(col + COL_TYPEDESC);
    if (td_name_equal(col_td, target)) {
        ++g_hits;
        cpu->EAX = complete;
        return;
    }

    uint32_t chd = isaac_r32(col + COL_CLASSDESC);
    if (!isaac_in_image(chd)) {
        ++g_bad;
        cpu->EAX = 0;
        return;
    }
    uint32_t n = isaac_r32(chd + CHD_NUMBASES);
    uint32_t arr = isaac_r32(chd + CHD_BASEARRAY);
    if (!isaac_in_image(arr) || n > 4096) {
        ++g_bad;
        cpu->EAX = 0;
        return;
    }

    for (uint32_t i = 0; i < n; ++i) {
        uint32_t bcd = isaac_r32(arr + 4 * i);
        if (!isaac_in_image(bcd))
            continue;
        uint32_t td = isaac_r32(bcd + BCD_TYPEDESC);
        if (!td_name_equal(td, target))
            continue;
        int32_t off = pmd_offset(complete,
                                 (int32_t)isaac_r32(bcd + BCD_PMD_MDISP),
                                 (int32_t)isaac_r32(bcd + BCD_PMD_PDISP),
                                 (int32_t)isaac_r32(bcd + BCD_PMD_VDISP));
        ++g_hits;
        cpu->EAX = complete + (uint32_t)off;
        return;
    }

    /* A genuine failed cast. This is a NORMAL result -- dynamic_cast returns
     * null when the object is not of the target type -- so it is not logged
     * per call, only counted. */
    ++g_misses;
    if (is_ref) {
        /* dynamic_cast<T&> on a failed cast must throw std::bad_cast. Throwing
         * is not implemented, so this stops rather than returning a null
         * reference, which would fault somewhere unrelated. */
        isaac_log("[isaac][c++] __RTDynamicCast: failed REFERENCE cast at "
                  "caller 0x%08x must throw std::bad_cast, which is not "
                  "implemented.", isaac_retaddr(cpu));
        isaac_stub_report();
        cpu->EAX = 0;
        return;
    }
    cpu->EAX = 0;
}

void isaac_cxx_report(void) {
    isaac_log("[isaac][c++] __RTDynamicCast: %u calls, %u succeeded, "
              "%u legitimately null, %u malformed",
              g_casts, g_hits, g_misses, g_bad);
}

uint32_t isaac_cxx_cast_count(void) { return g_casts; }
uint32_t isaac_cxx_cast_hits(void) { return g_hits; }
