/* host_shims_dyn.c -- runtime-resolved (LoadLibraryA + GetProcAddress)
 * imports curated into the shim token space by gen_shims.py DYNAMIC_EXPORTS,
 * plus the support imports the game reaches only from register-held cells.
 *
 * version.dll!VerifyVersionInfoA: the game writes the resolved address into
 * 0x00c75adc and calls through it directly. The evaluator answers as a
 * Windows 10 19045 box (platform VER_PLATFORM_WIN32_NT); every condition the
 * game asks about (major >= 10, minor >= 0, build >= 19045) is then true.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <stdint.h>

/* VER_* type bits (dwTypeMask) */
#define VER_BUILDNUMBER        0x00000001u
#define VER_MAJORVERSION       0x00000002u
#define VER_MINORVERSION       0x00000004u
#define VER_SERVICEPACKMAJOR   0x00000020u
#define VER_SERVICEPACKMINOR   0x00000040u
#define VER_PLATFORMID         0x00000080u
/* condition operators stored in 8-bit fields of the 64-bit mask */
#define VER_EQUALS 1
#define VER_GREATER 2
#define VER_GREATER_EQUAL 3
#define VER_LESS 4
#define VER_LESS_EQUAL 5
#define VER_AND 6
#define VER_OR 7

/* ULONGLONG VerSetConditionMask(ULONGLONG mask, DWORD type, BYTE cond) */
void imp_kernel32__VerSetConditionMask(CpuState *restrict cpu) {
    uint32_t lo = isaac_arg(cpu, 0), hi = isaac_arg(cpu, 1);
    uint32_t type = isaac_arg(cpu, 2), cond = isaac_arg(cpu, 3);
    uint64_t m = ((uint64_t)hi << 32) | lo;
    unsigned shift = (type & 0x3f) * 8;
    m &= ~((uint64_t)0xff << shift);
    m |= ((uint64_t)(cond == VER_AND ? VER_AND : cond) & 0xff) << shift;
    cpu->EAX = (uint32_t)m;
    cpu->EDX = (uint32_t)(m >> 32);
}

/* BOOL VerifyVersionInfoA(OSVERSIONINFOEXA*, DWORD typeMask, ULONGLONG mask)
 * BOOL RtlVerifyVersionInfo(OSVERSIONINFOEXA*, DWORD, ULONGLONG)
 * (ntdll variant: identical shape; the game calls it through 0x00c75adc.) */
static void verify_os_version(CpuState *restrict cpu) {
    uint32_t info = isaac_arg(cpu, 0);
    uint32_t type_mask = isaac_arg(cpu, 1);
    uint64_t cond = (uint64_t)isaac_arg(cpu, 3) << 32 | isaac_arg(cpu, 2);

    /* This build answers "Windows 10, build 19045, NT, no service pack". */
    int real_platform = 2, real_major = 10, real_minor = 0;
    int real_build = 19045, real_sp_major = 0, real_sp_minor = 0;

    /* Per-field requested values from the guest OSVERSIONINFOEXA (only the
     * size header is guaranteed present; fields we cannot read are 0). */
    int req_platform = 0, req_major = 0, req_minor = 0;
    int req_build = 0, req_sp_major = 0, req_sp_minor = 0;
    if (isaac_is_guest_va(info)) {
        req_major = isaac_r32(info + 4);
        req_minor = isaac_r32(info + 8);
        req_build = isaac_r32(info + 12);
        req_platform = isaac_r32(info + 16);
        req_sp_major = isaac_r16(info + 0x94);
        req_sp_minor = isaac_r16(info + 0x96);
    }

    int any = 0, ok = 1;   /* AND-combined unless a type carries the OR flag */
    for (unsigned t = 0; t < 32; ++t) {
        uint32_t bit = 1u << t;
        if (!(type_mask & bit)) continue;
        /* The condition mask stores each type's operator at (type BIT VALUE
         * * 8), not (bit index * 8): VER_MAJORVERSION=2 -> shift 16, etc. */
        unsigned shift = bit * 8;
        unsigned op = (unsigned)(cond >> shift) & 0x7;
        int or_flag = (int)((cond >> (shift + 3)) & 1);
        if (!op) continue;         /* no condition recorded for this type */
        int real, req;
        switch (bit) {
            case 0x01: real = real_build;    req = req_build;    break;
            case 0x02: real = real_major;    req = req_major;    break;
            case 0x04: real = real_minor;    req = req_minor;    break;
            case 0x20: real = real_sp_major; req = req_sp_major; break;
            case 0x40: real = real_sp_minor; req = req_sp_minor; break;
            case 0x80: real = real_platform; req = req_platform; break;
            default: continue;
        }
        int r;
        switch (op) {
            case VER_EQUALS:      r = real == req; break;
            case VER_GREATER:     r = real >  req; break;
            case VER_GREATER_EQUAL: r = real >= req; break;
            case VER_LESS:        r = real <  req; break;
            case VER_LESS_EQUAL:  r = real <= req; break;
            default:              r = 0; break;
        }
        if (!any) { ok = r; any = 1; }
        else if (or_flag) ok = ok || r;
        else ok = ok && r;
    }
    cpu->EAX = (any && ok) ? 1u : 0u;
}

void imp_version__VerifyVersionInfoA(CpuState *restrict cpu) {
    verify_os_version(cpu);
}
void imp_ntdll__RtlVerifyVersionInfo(CpuState *restrict cpu) {
    verify_os_version(cpu);
}
/* ---- shcore.dll ------------------------------------------------------- */

void imp_shcore__SetProcessDpiAwareness(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;                       /* S_OK */
}
void imp_shcore__GetDpiForMonitor(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    uint32_t typ = isaac_arg(cpu, 1), px = isaac_arg(cpu, 2), py = isaac_arg(cpu, 3);
    (void)typ;
    if (isaac_is_guest_va(px)) isaac_w32(px, 96);
    if (isaac_is_guest_va(py)) isaac_w32(py, 96);
    cpu->EAX = 0;                       /* S_OK */
}

