/* host_shims_dinput8.c -- strong implementations for the DInput8 surface.
 *
 * Reachability: Gamepad_init (0x00a6cf80) probes XInput1_4.dll /
 * bin\XInput1_4.dll / XInput1_3.dll / bin\XInput1_3.dll (NOT registered,
 * so the game degrades with "proceeding with DInput only"), then
 * LoadLibraryA("DINPUT8.dll") -- a NULL module here is FATAL (log
 * 0x00ba17e4 -> abort via 0xb18880), so dinput8.dll is registered in
 * host_shims_module.c:dynamic_dlls and DirectInput8Create is a curated
 * DYNAMIC_EXPORTS row.
 *
 * Call flow (0x00a6d0f0..):
 *   GetProcAddress(hDInput8, "DirectInput8Create")   -> token (row lookup)
 *   DirectInput8Create(hinst, 0x800, IID_IDirectInput8A @ 0xba1e80,
 *                      &0xc7e2fc, NULL)  __stdcall purge 20 -> DI_OK (0)
 *     and [0xc7e2fc] = fake object whose vtable slot 4 is
 *     EnumDevices(DI8DEVCLASS_GAMECTRL=4, cb=0xa6d560, ctx, flags)
 *     -> DI_OK + ZERO callback invocations: the game records "no
 *     controllers" and never creates/polls any joystick device.
 *   GetDeviceCount/AddRef/Release/QueryInterface: never reached in the
 *     observed flow, but present so the vtable is fully token-backed.
 *
 * The per-frame poller (0x00a6dab0) with zero devices only pumps the
 * (nonexistent) hidden notification window: PeekMessageA on the fake
 * hwnd returns 0 immediately and the XInput joystick loop is skipped via
 * [0xc7e301]==0. DI_OK == 0 everywhere.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <string.h>
#include <stdio.h>

/* Fake IDirectInput8A object: guest scratch below ISAAC_GUEST_LIMIT_VA,
 * written by the host only. The game reads [obj] for the vtable pointer and
 * dispatches slots 0..4 through isaac_indirect_call (token VAs). */
#define DI8_VTABLE_VA  (ISAAC_TEB_VA + 0xd100u)
#define DI8_OBJECT_VA  (ISAAC_TEB_VA + 0xd200u)

static int di8_ready = 0;

/* Token lookup, same pattern as host_shims_gl.c:wglGetProcAddress. */
static uint32_t di8_token(const char *sym) {
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        const isaac_import *imp = &isaac_imports[i];
        if (imp->shim_va < ISAAC_SHIM_BASE) continue;
        if (strcmp(imp->dll, "dinput8.dll") != 0) continue;
        if (strcmp(imp->symbol, sym) == 0) return imp->shim_va;
    }
    return 0;
}

static void di8_build_object(void) {
    if (di8_ready) return;
    static const char *const slots[] = {
        "IDirectInput8A_QueryInterface", "IDirectInput8A_AddRef",
        "IDirectInput8A_Release", "IDirectInput8A_GetDeviceCount",
        "IDirectInput8A_EnumDevices",
    };
    for (unsigned j = 0; j < sizeof slots / sizeof slots[0]; ++j)
        isaac_w32(DI8_VTABLE_VA + 4u * j, di8_token(slots[j]));
    isaac_w32(DI8_OBJECT_VA, DI8_VTABLE_VA);
    di8_ready = 1;
}

/* HRESULT DirectInput8Create(HINSTANCE hinst, DWORD dwVersion, REFIID
 * riidltf, LPDIRECTINPUT8A *ppvOut, LPUNKNOWN punkOuter) -- stdcall.
 *
 * The observed call sites push the five args in the canonical order; the
 * out-pointer lands in one of the .data args. Writing the fake object into
 * EVERY arg that is a writable guest data/scratch VA makes the shim robust
 * against the game's stack-reuse call pattern (the cell at 0xb182d0 is
 * self-patched and one call goes out with shifted args). .rdata args
 * (the IID at 0xba1e80) are never written. */
void imp_dinput8__DirectInput8Create(CpuState *restrict cpu) {
    di8_build_object();
    /* The game's out-pointer is the fixed global cell 0xc7e2fc (arg3).  Write
     * the fake object there directly; the pointer then survives for the later
     * EnumDevices vtable dispatch (0xa6db57 uses [0xc7e2fc]). */
    isaac_w32(0xc7e2fcu, DI8_OBJECT_VA);
    fprintf(stderr, "[dinput] DirectInput8Create(args %08x %08x %08x %08x "
                    "%08x esp=%08x) -> wrote objs; [0xc7e2fc]=%08x "
                    "ptr=%p; DI_OK, fake IDirectInput8A at 0x%08x "
                    "(zero devices)\n",
            (unsigned)isaac_arg(cpu, 0), (unsigned)isaac_arg(cpu, 1),
            (unsigned)isaac_arg(cpu, 2), (unsigned)isaac_arg(cpu, 3),
            (unsigned)isaac_arg(cpu, 4), (unsigned)cpu->ESP,
            (unsigned)isaac_r32(0xc7e2fcu), isaac_g(0xc7e2fcu),
            (unsigned)DI8_OBJECT_VA);
    cpu->EAX = 0;      /* DI_OK */
}

/* HRESULT QueryInterface(REFIID, void **ppvObject) -- never called in the
 * observed flow; honest IUnknown answer. */
void imp_dinput8__IDirectInput8A_QueryInterface(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0x80004001u;    /* E_NOTIMPL */
}

/* ULONG AddRef(void) */
void imp_dinput8__IDirectInput8A_AddRef(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 2;
}

/* ULONG Release(void) */
void imp_dinput8__IDirectInput8A_Release(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}

/* HRESULT GetDeviceCount(LPDWORD lpwNumDevices) */
void imp_dinput8__IDirectInput8A_GetDeviceCount(CpuState *restrict cpu) {
    uint32_t out = isaac_arg(cpu, 0);
    if (out && isaac_is_guest_va(out)) isaac_w32(out, 0);
    cpu->EAX = 0;      /* DI_OK */
}

/* HRESULT EnumDevices(DWORD dwDevType, LPDIENUMDEVICESCALLBACKA lpCallback,
 *                     LPVOID pvRef, DWORD dwFlags)
 * Zero devices: never invoke the callback (the game's 0xa6d560 handler would
 * build a joystick record per invocation). */
void imp_dinput8__IDirectInput8A_EnumDevices(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;      /* DI_OK */
}
