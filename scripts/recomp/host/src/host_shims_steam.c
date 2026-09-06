/* host_shims_steam.c -- fake Steam API surface.
 *
 * The game imports SteamInternal_ContextInit directly (121 IAT refs to
 * 0xb18a1c).  Every callsite follows the same contract (verified at
 * 0x00a7136f, 0x00a9e317, 0x00a7db30, 0x00a8c5b0, ...):
 *
 *   push slot; call ContextInit; add esp,4
 *   cmp [eax], 0 ; je skip
 *   mov ecx, [eax]          ; context object O
 *   mov eax, [ecx]          ; vtable V
 *   call [V + off]          ; thiscall virtual, args on stack
 *
 * So the shim returns the slot address and installs a fake context:
 * [slot] = O, [O] = V, and V's slots are PROVIDED shim tokens (the DI8
 * fake-object pattern).  All interface lookups answer 0 or an 8-zero-byte
 * identity, so the GUID-match loops (0x00a9e35e, 0x00a9e4a1) and the
 * interface-release dance (0x00a9e3c1, 0xa62dc0 is NULL-safe) take their
 * no-steam arms.  The 0xa9e2d0 callers ignore the return value; the
 * V+0xc count<=0 path is a harmless early exit.  Measured arm choice:
 * the original boot (run 20/21) faulted at 0x00a71397 reading
 * [vtable+0x38] because [0xc5c510] held a garbage pointer.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <string.h>

/* Fake CSteamAPIContext: guest scratch below ISAAC_GUEST_LIMIT_VA, written
 * by the host only, like the DI8 object (0x0e00d100/0x0e00d200). */
#define STEAM_OBJ_VA    (ISAAC_TEB_VA + 0xd500u)
#define STEAM_VTBL_VA   (ISAAC_TEB_VA + 0xd600u)
#define STEAM_ZERO8_VA  (ISAAC_TEB_VA + 0xd700u)

static int steam_ready = 0;

static uint32_t steam_token(const char *sym) {
    for (unsigned i = 0; i < isaac_import_count; ++i) {
        const isaac_import *imp = &isaac_imports[i];
        if (imp->shim_va < ISAAC_SHIM_BASE) continue;
        if (strcmp(imp->dll, "steam_api.dll") != 0) continue;
        if (strcmp(imp->symbol, sym) == 0) return imp->shim_va;
    }
    return 0;
}

static void steam_build_context(void) {
    if (steam_ready) return;
    static const char *const slots[16] = {
        "CSteamAPIContext_Interface",             /* +0x00 */
        "CSteamAPIContext_SteamClient",           /* +0x04 */
        "CSteamAPIContext_SteamClient",           /* +0x08 */
        "CSteamAPIContext_CreateSteamPipe",       /* +0x0c */
        "CSteamAPIContext_GetSteamGenericInterface", /* +0x10 */
        "CSteamAPIContext_ConnectToGlobalUser",   /* +0x14 */
        "CSteamAPIContext_Zero",                  /* +0x18 */
        "CSteamAPIContext_ReleaseInterface",      /* +0x1c */
        "CSteamAPIContext_Zero",                  /* +0x20 */
        "CSteamAPIContext_Zero",                  /* +0x24 */
        "CSteamAPIContext_Zero",                  /* +0x28 */
        "CSteamAPIContext_Zero",                  /* +0x2c */
        "CSteamAPIContext_Zero",                  /* +0x30 */
        "CSteamAPIContext_Zero",                  /* +0x34 */
        "CSteamAPIContext_Init",                  /* +0x38 */
        "CSteamAPIContext_Zero",                  /* +0x3c */
    };
    for (unsigned j = 0; j < 16; ++j) {
        uint32_t tok = steam_token(slots[j]);
        if (!tok) isaac_log("[isaac][steam] missing vtable token for %s",
                            slots[j]);
        isaac_w32(STEAM_VTBL_VA + 4u * j, tok);
    }
    isaac_w32(STEAM_OBJ_VA, STEAM_VTBL_VA);
    for (unsigned j = 0; j < 2; ++j) isaac_w32(STEAM_ZERO8_VA + 4u * j, 0);
    steam_ready = 1;
}

/* void *SteamInternal_ContextInit(void *pContextInitData) -- cdecl.
 * Returns the slot address with the fake context installed:
 * [slot] = O, [O] = V. */
/* Which accessor slots get the fake context. SteamInternal_ContextInit is
 * the inline body of EVERY SteamXxx() accessor; each has its own static
 * CSteamAPIContext slot, and each caller tests `cmp [slot],0; je` before
 * touching the interface. The fake 16-slot vtable only answers the
 * CSteamAPIContext INIT dance (round 9: the four verified sites push
 * 0x00bf93c8 / 0x00c5c510). Any other interface reached through it calls
 * methods whose real purges differ from the fake slots' -- boot round 11
 * measured it twice: ISteamUGC at slot +0x128 (a NULL call) and
 * ISteamApps::BIsDlcInstalled at +0x1c (thiscall, 4 bytes) served by
 * CSteamAPIContext_ReleaseInterface (8 bytes): three calls drifted ESP by
 * 12 and 0x009ef5c0 returned with edi = esi, so Menu Save Init addressed
 * MenuManager + 0x1dc. Hence an ALLOW-list: these slots get the fake
 * context, every other slot reads NULL = "Steam not running", the game's
 * own arm. First sight of a slot is logged either way. */
static const struct { uint32_t slot; const char *what; } steam_fake_slots[] = {
    { 0x00bf93c8u, "CSteamAPIContext init dance (0x00a7db31, engine init 0x009aa040)" },
    { 0x00c5c510u, "CSteamAPIContext init dance (0x00a8c5ac; per-frame RunCallbacks path)" },
};

static int steam_slot_is_fake(uint32_t slot) {
    for (unsigned k = 0; k < sizeof steam_fake_slots / sizeof steam_fake_slots[0]; ++k)
        if (steam_fake_slots[k].slot == slot) return 1;
    return 0;
}

static void steam_log_slot_once(uint32_t slot, const char *how) {
    static uint32_t seen[32];
    static unsigned nseen;
    for (unsigned k = 0; k < nseen; ++k) if (seen[k] == slot) return;
    if (nseen < 32) seen[nseen++] = slot;
    isaac_log("[isaac][steam] SteamInternal_ContextInit(slot=0x%08x) -> %s", (unsigned)slot, how);
}

void imp_steam_api__SteamInternal_ContextInit(CpuState *restrict cpu) {
    uint32_t slot = isaac_arg(cpu, 0);
    steam_build_context();
    if (steam_slot_is_fake(slot)) {
        if (isaac_is_guest_va(slot)) isaac_w32(slot, STEAM_OBJ_VA);
        steam_log_slot_once(slot, "fake context (init dance; no steam)");
    } else {
        if (isaac_is_guest_va(slot)) isaac_w32(slot, 0);
        steam_log_slot_once(slot, "NULL interface (not the init dance; no steam)");
    }
    cpu->EAX = slot;
}

/* The fake CSteamAPIContext methods (thiscall; args on the stack, cleaned
 * by the dispatcher's arg_bytes).  All return the no-steam arm values. */
void imp_steam_api__CSteamAPIContext_Interface(CpuState *restrict cpu) {
    (void)cpu;
    cpu->EAX = 0;
}
void imp_steam_api__CSteamAPIContext_SteamClient(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = STEAM_ZERO8_VA;
}
void imp_steam_api__CSteamAPIContext_CreateSteamPipe(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_steam_api__CSteamAPIContext_GetSteamGenericInterface(
        CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = STEAM_ZERO8_VA;
}
void imp_steam_api__CSteamAPIContext_ConnectToGlobalUser(
        CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_steam_api__CSteamAPIContext_ReleaseInterface(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_steam_api__CSteamAPIContext_Init(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_steam_api__CSteamAPIContext_Zero(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
