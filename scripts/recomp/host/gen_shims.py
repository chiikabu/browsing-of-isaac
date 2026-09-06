"""Generate the import/shim table for all 622 imports.

Two things this does that a hand-written table cannot:

1. MEASURES the stack discipline of every import instead of assuming it.
   For each `call dword ptr [iat_slot]` the sweep records how many `push`
   instructions immediately precede it and whether the very next instruction is
   `add esp, N`. A cdecl callee leaves cleanup to the caller (`add esp, N`
   present); a stdcall callee pops its own arguments (no `add esp`). Getting
   this wrong corrupts the guest stack in a way that surfaces thousands of
   instructions later, so it is measured, and disagreement across call sites is
   reported rather than averaged away.

2. Emits an entry for ALL 622 imports, including the 46 with zero measured call
   sites. Anything not hand-implemented becomes a LOUD trap, so an import can
   never silently return 0.

Run:  python scripts/recomp/host/gen_shims.py
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, CENSUS_DIR, hexva  # noqa: E402

from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_MEM, X86_OP_IMM, X86_REG_INVALID, X86_REG_ESP

GEN_DIR = Path(__file__).resolve().parent / "generated"

# ---------------------------------------------------------------------------
# Verdict rules. DLL-level default, then per-symbol override. Every rule is
# stated here rather than buried in the emitter so the classification is
# auditable in one screen.
# ---------------------------------------------------------------------------
DLL_DEFAULT = {
    "lua5.3.3r.dll":                        "PROVIDED",   # upstream Lua 5.3.3 wasm
    "api-ms-win-crt-math-l1-1-0.dll":       "PROVIDED",   # musl libm
    "api-ms-win-crt-string-l1-1-0.dll":     "PROVIDED",
    "api-ms-win-crt-convert-l1-1-0.dll":    "PROVIDED",
    # NOT musl: the guest allocator must return pointers inside the GUEST
    # arena. Forwarding to the host allocator would hand the guest addresses
    # above the guard (measured 0x1010d3e8), i.e. write access to the runtime.
    "api-ms-win-crt-heap-l1-1-0.dll":       "REAL",
    "api-ms-win-crt-stdio-l1-1-0.dll":      "PROVIDED",   # emscripten FS
    "api-ms-win-crt-utility-l1-1-0.dll":    "PROVIDED",
    "api-ms-win-crt-time-l1-1-0.dll":       "PROVIDED",
    "api-ms-win-crt-filesystem-l1-1-0.dll": "PROVIDED",
    "api-ms-win-crt-environment-l1-1-0.dll": "PROVIDED",
    "api-ms-win-crt-locale-l1-1-0.dll":     "PROVIDED",
    "api-ms-win-crt-runtime-l1-1-0.dll":    "REAL",       # CRT startup surface
    "vcruntime140.dll":                     "REAL",       # MSVC C++ ABI
    "msvcp140.dll":                         "REAL",       # forward onto libc++
    "kernel32.dll":                         "REAL",
    "user32.dll":                           "PROVIDED",   # emscripten GLFW3
    "gdi32.dll":                            "STUB",
    "openal32.dll":                         "PROVIDED",   # emscripten OpenAL
    "opengl32.dll":                         "REAL",
    "eossdk-win32-shipping.dll":            "STUB",
    "steam_api.dll":                        "STUB",
    "libcurl.dll":                          "STUB",
    "dbghelp.dll":                          "STUB",
    "advapi32.dll":                         "STUB",
    "winmm.dll":                            "STUB",
    "shell32.dll":                          "STUB",
    "ole32.dll":                            "STUB",
    "bcrypt.dll":                           "REAL",       # crypto RNG: must be real
}

SYMBOL_OVERRIDE = {
    # Reachable through a register-held address (`mov edi,[IAT]; call edi` at
    # 0x009a9753), which the call-site census cannot see -- the 0-sites verdict
    # is a known campaign gap, NOT a real absence. Strong handler exists.
    "GetFileAttributesA@kernel32.dll": "PROVIDED",
    # Same register-held blind spot: reached at 0x00a8100f as
    # `mov esi,[0xb18204]; call esi`. Strong handler in host_shims_dyn.c.
    "VerSetConditionMask@kernel32.dll": "PROVIDED",
    # Same register-held blind spot, both at once: the controller-DB parser
    # sub_00a25770 reaches strspn as `mov edx,[0xb1894c]; mov [ebp-0xd0],edx;
    # ...; call [ebp-0xd0]` (0x00a259ce) and strcspn as `mov esi,[0xb18950];
    # call esi` (0x00a2592e). Both measured 0 sites, both stubbed, and the
    # 365-line GameControllerDB parse failed per line (GLFW_INVALID_VALUE x365
    # then exit(1)). Strong handlers in host_shims_forward.c.
    "strspn@api-ms-win-crt-string-l1-1-0.dll": "PROVIDED",
    "strcspn@api-ms-win-crt-string-l1-1-0.dll": "PROVIDED",
    "strncmp@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "_stricmp@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "_strnicmp@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "strpbrk@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "strcpy_s@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "strncpy_s@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "strcat_s@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "_strdup@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "tolower@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "toupper@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "isdigit@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "isspace@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "ispunct@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "iswspace@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "atoi@api-ms-win-crt-convert-l1-1-0.dll": "REAL",
    "atof@api-ms-win-crt-convert-l1-1-0.dll": "REAL",
    "strtol@api-ms-win-crt-convert-l1-1-0.dll": "REAL",
    "strtoul@api-ms-win-crt-convert-l1-1-0.dll": "REAL",
    "strtoull@api-ms-win-crt-convert-l1-1-0.dll": "REAL",
    "floor@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "ceil@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "roundf@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "ldexp@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "modf@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "copysignf@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "fminf@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "nextafterf@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_fdclass@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "rand@api-ms-win-crt-utility-l1-1-0.dll": "REAL",
    "srand@api-ms-win-crt-utility-l1-1-0.dll": "REAL",
    "GetCurrentThreadId@kernel32.dll": "REAL",
    "GetCurrentProcessId@kernel32.dll": "REAL",
    "GetCurrentProcess@kernel32.dll": "REAL",
    "SetLastError@kernel32.dll": "REAL",
    "GetModuleHandleExW@kernel32.dll": "REAL",
    "CreateEventW@kernel32.dll": "REAL",
    "SetEvent@kernel32.dll": "REAL",
    "ResetEvent@kernel32.dll": "REAL",
    "WaitForSingleObject@kernel32.dll": "REAL",
    "GetStdHandle@kernel32.dll": "REAL",
    "WriteConsoleA@kernel32.dll": "REAL",
    "FlsAlloc@kernel32.dll": "REAL",
    "FlsSetValue@kernel32.dll": "REAL",
    "FlsGetValue@kernel32.dll": "REAL",
    "FlsFree@kernel32.dll": "REAL",
    "strncpy@api-ms-win-crt-string-l1-1-0.dll": "REAL",
    "__stdio_common_vsprintf@api-ms-win-crt-stdio-l1-1-0.dll": "REAL",
    "__stdio_common_vsprintf_s@api-ms-win-crt-stdio-l1-1-0.dll": "REAL",
    "__setusermatherr@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_set_new_mode@api-ms-win-crt-heap-l1-1-0.dll": "REAL",
    "SteamAPI_RegisterCallback@steam_api.dll": "REAL",
    "SteamAPI_UnregisterCallback@steam_api.dll": "REAL",
    "SteamInternal_ContextInit@steam_api.dll": "REAL",
    "SteamAPI_RunCallbacks@steam_api.dll": "REAL",
    "_libm_sse2_sin_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_cos_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_tan_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_asin_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_acos_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_atan_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_exp_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_log_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_log10_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_sqrt_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    "_libm_sse2_pow_precise@api-ms-win-crt-math-l1-1-0.dll": "REAL",
    # vcruntime: the mem*/str* half is plain musl, the ABI half is real work.
    "memset@vcruntime140.dll": "REAL",
    "memcpy@vcruntime140.dll": "REAL",
    "memmove@vcruntime140.dll": "REAL",
    "memchr@vcruntime140.dll": "REAL",
    "strstr@vcruntime140.dll": "REAL",
    "strchr@vcruntime140.dll": "REAL",
    # kernel32 pieces emscripten/musl already answers
    "VirtualAlloc@kernel32.dll": "REAL",
    "VirtualFree@kernel32.dll": "REAL",
    "VirtualQuery@kernel32.dll": "REAL",
    "QueryPerformanceCounter@kernel32.dll": "REAL",
    "QueryPerformanceFrequency@kernel32.dll": "REAL",
    "GetSystemTimeAsFileTime@kernel32.dll": "PROVIDED",
    "GetLocalTime@kernel32.dll": "PROVIDED",
    "Sleep@kernel32.dll": "REAL",
    "MultiByteToWideChar@kernel32.dll": "PROVIDED",
    "WideCharToMultiByte@kernel32.dll": "PROVIDED",
    "CreateFileA@kernel32.dll": "PROVIDED",
    "CloseHandle@kernel32.dll": "REAL",
    "CreateDirectoryA@kernel32.dll": "PROVIDED",
    "RemoveDirectoryA@kernel32.dll": "PROVIDED",
    "DeleteFileA@kernel32.dll": "PROVIDED",
    "FindFirstFileA@kernel32.dll": "PROVIDED",
    "FindFirstFileW@kernel32.dll": "PROVIDED",
    "FindNextFileA@kernel32.dll": "PROVIDED",
    # FindNextFileW has ZERO direct call sites: KAGE's readdir (0x00a172e0)
    # loads the import into a register (`mov edx,[0xb1825c]` @0x00a17369)
    # and calls through it, so the census cannot see the site. It IS on the
    # boot path -- the mount-root scan that fills the VFS index -- and it is
    # implemented in host_shims_fs.c beside FindFirstFileW (boot round 10).
    "FindNextFileW@kernel32.dll": "PROVIDED",
    # wcstombs_s likewise measured 0 sites only because the scan that uses
    # it (cFileName -> narrow) never ran while FindFirstFileW was a stub.
    "wcstombs_s@api-ms-win-crt-convert-l1-1-0.dll": "PROVIDED",
    # msvcp140 basic_streambuf BASE virtuals: zero direct call sites because the
    # game's basic_stringbuf vtable at 0xb1b190 reaches them through the IAT
    # jump thunks 0xaef06b..0xaef095 (slots 1,2,5,7,8,9,12,13,14 = _Lock,
    # _Unlock, showmanyc, uflow, xsgetn, xsputn, setbuf, sync, imbue). sgetc /
    # sbumpc inside the DLL call uflow/underflow through that vtable, so these
    # are on the stringstream path and are implemented in host_shims_msvcp.c.
    "?uflow@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAEHXZ@msvcp140.dll": "PROVIDED",
    "?showmanyc@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAE_JXZ@msvcp140.dll": "PROVIDED",
    "?sync@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAEHXZ@msvcp140.dll": "PROVIDED",
    "?setbuf@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAEPAV12@PAD_J@Z@msvcp140.dll": "PROVIDED",
    "?imbue@?$basic_streambuf@DU?$char_traits@D@std@@@std@@MAEXABVlocale@2@@Z@msvcp140.dll": "PROVIDED",
    "?_Lock@?$basic_streambuf@DU?$char_traits@D@std@@@std@@UAEXXZ@msvcp140.dll": "PROVIDED",
    "?_Unlock@?$basic_streambuf@DU?$char_traits@D@std@@@std@@UAEXXZ@msvcp140.dll": "PROVIDED",
    "FindClose@kernel32.dll": "PROVIDED",
    "MoveFileExA@kernel32.dll": "PROVIDED",
    # kernel32 pieces that are genuinely inert in a single-threaded wasm build
    "InitializeCriticalSection@kernel32.dll": "REAL",
    "InitializeCriticalSectionAndSpinCount@kernel32.dll": "REAL",
    # Window icon via a register-held call (0x00949b03): census 0 sites, so
    # the verdict would stay NEVER_CALLED although host_shims_win.c provides it.
    "LoadImageA@user32.dll": "PROVIDED",
    # Round 11b: every import whose IAT slot is loaded into a register
    # somewhere (the census now counts them: regHeldLoads) gets a verdict and
    # a purge, so none can trap as "not implemented / unknown purge" when its
    # path is reached. Inert 0 is the right answer for these:
    "SendMessageA@user32.dll": "STUB",        # WM_SETICON after LoadImageA (0x00949b30): previous icon = 0
    "SendMessageW@user32.dll": "STUB",        # 0x00a5d651 (GLFW win32 window)
    # Round 32: host_shims_win.c synthesises WM_CHAR from a WM_KEYDOWN (the
    # US layout under the synchronous modifier state), queued ahead of the
    # rest -- typed text reaches the debug console's GLFW char callback.
    "TranslateMessage@user32.dll": "PROVIDED",  # message pumps 0x00a5e690/0x00a6db02/0x00a81498
    "PeekMessageA@user32.dll": "STUB",        # 0x00a6daeb: no message
    "GetClassLongW@user32.dll": "STUB",       # 0x00a5d631: no class storage
    "UnregisterClassW@user32.dll": "STUB",    # 0x00a81527 (GLFW terminate)
    "GetNumaNodeProcessorMask@kernel32.dll": "STUB",  # CRT topology probe: FALSE
    "CoInitialize@ole32.dll": "STUB",         # S_OK
    "curl_easy_setopt@libcurl.dll": "STUB",   # CURLE_OK; crash uploader / news fetch are offline anyway
    "_EOS_EpicAccountId_ToString@12@eossdk-win32-shipping.dll": "STUB",
    "_EOS_Friends_GetBlockedUserAtIndex@8@eossdk-win32-shipping.dll": "STUB",
    "_EOS_P2P_GetNextReceivedPacketSize@12@eossdk-win32-shipping.dll": "STUB",
    "_EOS_Platform_GetFriendsInterface@4@eossdk-win32-shipping.dll": "STUB",
    # ... and these need a real answer (host_shims_win.c / host_lua.c):
    "GetDeviceCaps@gdi32.dll": "PROVIDED",        # LOGPIXELS/VREFRESH/BITSPIXEL, not 0
    "SwapBuffers@gdi32.dll": "PROVIDED",          # counts presented frames (ISAAC_MAX_FRAMES cap, per-60 stamps)
    "GetRawInputDeviceList@user32.dll": "PROVIDED",   # must write *count = 0
    "lua_getstack@lua5.3.3r.dll": "PROVIDED",     # real Lua 5.3.3 binding
    "EnterCriticalSection@kernel32.dll": "REAL",
    "LeaveCriticalSection@kernel32.dll": "REAL",
    "DeleteCriticalSection@kernel32.dll": "REAL",
    "TryEnterCriticalSection@kernel32.dll": "REAL",
    "SetThreadExecutionState@kernel32.dll": "STUB",
    "SetThreadPriority@kernel32.dll": "STUB",
    "OutputDebugStringA@kernel32.dll": "STUB",
    "IsDebuggerPresent@kernel32.dll": "REAL",
    "SetUnhandledExceptionFilter@kernel32.dll": "REAL",
    "InitializeSListHead@kernel32.dll": "REAL",
    "VirtualUnlock@kernel32.dll": "STUB",
    "GetNumaHighestNodeNumber@kernel32.dll": "STUB",
    "GetNumaProcessorNode@kernel32.dll": "STUB",
    "GetLargePageMinimum@kernel32.dll": "STUB",
    "LockFileEx@kernel32.dll": "STUB",
    "UnlockFileEx@kernel32.dll": "STUB",
    # the one real thread in the binary: theoraplayer's video worker
    "CreateThread@kernel32.dll": "REAL",       # round 24c: the theoraplayer worker, sliced per frame
    "TerminateThread@kernel32.dll": "STUB",
    # user32 bits GLFW does not own and emscripten cannot answer
    "MessageBoxA@user32.dll": "REAL",
    # timing
    "timeBeginPeriod@winmm.dll": "STUB",
    "timeEndPeriod@winmm.dll": "STUB",
    "timeGetDevCaps@winmm.dll": "STUB",
}

VERDICT_ENUM = {
    "REAL": "ISAAC_V_REAL",
    "PROVIDED": "ISAAC_V_PROVIDED",
    "STUB": "ISAAC_V_STUB",
    "UNIMPLEMENTED": "ISAAC_V_UNIMPLEMENTED",
    "NEVER_CALLED": "ISAAC_V_NEVER_CALLED",
}

# ---------------------------------------------------------------------------
# Calling convention is known A PRIORI from which library a symbol comes from.
# This is the source of truth; the call-site sweep is a CROSS-CHECK, not the
# authority.
#
# Why: a first attempt derived the convention purely from "is the next
# instruction `add esp, N`?" and got 7 of 28 known signatures wrong -- memset,
# memcpy, floor, lua_absindex and lua_pushstring all came out 'stdcall'. MSVC
# frequently defers or coalesces cdecl stack cleanup (one `add esp, 48` after
# several calls, or `pop ecx`), so the absence of an immediate `add esp` proves
# nothing. Convention by library is exact; only the stdcall PURGE SIZE needs
# measuring.
# ---------------------------------------------------------------------------
CDECL_DLLS = {
    "lua5.3.3r.dll", "vcruntime140.dll", "openal32.dll", "libcurl.dll",
    "steam_api.dll",
}
STDCALL_DLLS = {
    "kernel32.dll", "user32.dll", "gdi32.dll", "advapi32.dll", "shell32.dll",
    "ole32.dll", "winmm.dll", "opengl32.dll", "dbghelp.dll", "bcrypt.dll",
    "eossdk-win32-shipping.dll",
}


# Curated stdcall purge sizes, from the documented Win32/SDK signature.
# These OVERRIDE the call-site measurement, and every disagreement between the
# two is printed -- the measurement is a genuine second opinion, so a clash is
# a signal that one of them is wrong rather than something to paper over.
# Populated for stdcall symbols whose shim RETURNS (a trapping shim never needs
# a purge). 4 bytes per 32-bit parameter.
CURATED_PURGE = {
    "CoInitializeEx@ole32.dll": 8,   # HRESULT CoInitializeEx(LPVOID, DWORD) -- reached
                                     # reg-indirect at 0x00a6d160, so the call-site census
                                     # saw 0 sites and the auto-purge was UNKNOWN.
    # BOOL FindNextFileW(HANDLE, LPWIN32_FIND_DATAW) = 2 DWORDs = 8. Reached
    # ONLY through a register-held import (`mov edx,[0xb1825c]` @0x00a17369 in
    # KAGE's readdir 0x00a172e0), so the census saw 0 sites and the purge was
    # UNKNOWN -- with the shim now implemented, isaac_indirect_call would trap
    # on its return ("stack purge is unknown") at the first directory scan.
    "FindNextFileW@kernel32.dll": 8,
    # HANDLE LoadImageA(HINSTANCE, LPCSTR, UINT, int, int, UINT) = 6 DWORDs = 24.
    # Reached ONLY register-held (`call ebx` at 0x00949b03, the window icon) so
    # the census saw 0 sites; boot round 11b stopped on the unknown-purge trap.
    "LoadImageA@user32.dll": 24,
    # Round 11b: the other register-held-only imports (regHeldLoads > 0,
    # callSites == 0), purges from the Win32 signatures, 4 bytes per arg.
    "SendMessageA@user32.dll": 16,            # (HWND, UINT, WPARAM, LPARAM)
    "SendMessageW@user32.dll": 16,
    "TranslateMessage@user32.dll": 4,         # (const MSG*)
    "PeekMessageA@user32.dll": 20,            # (LPMSG, HWND, UINT, UINT, UINT)
    "GetClassLongW@user32.dll": 8,            # (HWND, int)
    "UnregisterClassW@user32.dll": 8,         # (LPCWSTR, HINSTANCE)
    "GetDeviceCaps@gdi32.dll": 8,             # (HDC, int)
    "GetRawInputDeviceList@user32.dll": 12,   # (PRAWINPUTDEVICELIST, PUINT, UINT)
    "GetNumaNodeProcessorMask@kernel32.dll": 8,   # (UCHAR promoted, PULONGLONG)
    "CoInitialize@ole32.dll": 4,              # (LPVOID)
    # msvcp140 C++ methods are __thiscall (this in ECX, callee pops the stack
    # args). The push-count sweep counts the CALLER's unrelated pushes at the
    # inlined construction sites, so three of them measured wrong; the purge is
    # the sum of the stack argument sizes in the decorated name (4 per
    # pointer/int/bool/char, 8 per _J/_K 64-bit, 4 for a class returned by
    # value = hidden pointer) PLUS, for a constructor of a class with a virtual
    # base, the hidden trailing `int most_derived` that MSVC x86 passes and the
    # callee pops (msvcp140 `??0basic_iostream` is `ret 8`, `??0basic_ostream`
    # is `ret 0xc`: output/decomp/_scratch/msvcp140/abi-notes.md §1.5). Boot
    # round 10b curated those two as the decorated-name sum (4 / 8) and the
    # lifted stringstream ctor 0x00684ce0 then under-popped by 4, so its
    # epilogue restored ebx/esi/edi one slot low and the tokenizer 0x0067f420
    # faulted on the leaked esi (round 11). The measurement was right.
    "??0?$basic_ios@DU?$char_traits@D@std@@@std@@IAE@XZ@msvcp140.dll": 0,        # measured 32 (no vbase: no hidden flag)
    "??0?$basic_iostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@@Z@msvcp140.dll": 8,  # sb + most_derived; measured 8
    "??0?$basic_ostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@_N@Z@msvcp140.dll": 12,  # sb, isstd + most_derived; measured 12
    "??0_Lockit@std@@QAE@H@Z@msvcp140.dll": 4,                                    # measured 36
    "?widen@?$basic_ios@DU?$char_traits@D@std@@@std@@QBEDD@Z@msvcp140.dll": 4,   # measured 12
    # kernel32
    "EnterCriticalSection@kernel32.dll": 4,
    "LeaveCriticalSection@kernel32.dll": 4,
    "DeleteCriticalSection@kernel32.dll": 4,
    "InitializeCriticalSection@kernel32.dll": 4,
    "InitializeCriticalSectionAndSpinCount@kernel32.dll": 8,   # measured 16, wrong
    "TryEnterCriticalSection@kernel32.dll": 4,
    "SetUnhandledExceptionFilter@kernel32.dll": 4,
    "UnhandledExceptionFilter@kernel32.dll": 4,
    "InitializeSListHead@kernel32.dll": 4,
    "IsDebuggerPresent@kernel32.dll": 0,
    # Signature takes ONE DWORD. The push-count sweep measured 8 (args set up
    # with `mov [esp+N]`, as with MessageBoxA); a purge of 8 would pop a
    # caller local on every one of the 4 call sites.
    "IsProcessorFeaturePresent@kernel32.dll": 4,
    "OutputDebugStringA@kernel32.dll": 4,
    "GetLargePageMinimum@kernel32.dll": 0,
    # GetFileAttributesA takes ONE DWORD and is stdcall. The census reports
    # 0 call sites for it BECAUSE the game reaches it through a register-held
    # address (`mov edi,[IAT]; ... call edi` at 0x009a9753) -- the known
    # enumerate-the-channel gap, not a real absence.
    "GetFileAttributesA@kernel32.dll": 4,
    "GetNumaProcessorNode@kernel32.dll": 8,
    "GetNumaHighestNodeNumber@kernel32.dll": 4,
    "SetThreadPriority@kernel32.dll": 8,
    "SetThreadExecutionState@kernel32.dll": 4,
    "TerminateThread@kernel32.dll": 8,
    "CreateThread@kernel32.dll": 24,
    "VirtualUnlock@kernel32.dll": 8,
    "VirtualAlloc@kernel32.dll": 16,
    "VirtualFree@kernel32.dll": 12,
    "VirtualQuery@kernel32.dll": 12,
    "LockFileEx@kernel32.dll": 24,
    "UnlockFileEx@kernel32.dll": 20,
    "GetLastError@kernel32.dll": 0,
    # FormatMessageW takes SEVEN DWORDs (28). The push-count sweep saw only
    # the last three pushes (the first four sit between two earlier calls) and
    # reported 12; purging 12 would leak 16 bytes at both call sites.
    "FormatMessageW@kernel32.dll": 28,
    "GetProcAddress@kernel32.dll": 8,
    "LoadLibraryA@kernel32.dll": 4,
    "FreeLibrary@kernel32.dll": 4,
    "GetModuleHandleA@kernel32.dll": 4,
    "GetModuleHandleW@kernel32.dll": 4,
    "TlsAlloc@kernel32.dll": 0,
    "TlsFree@kernel32.dll": 4,
    "TlsGetValue@kernel32.dll": 4,
    "TlsSetValue@kernel32.dll": 8,
    # gdi32
    "SetPixelFormat@gdi32.dll": 12,          # measured 8, wrong
    "ChoosePixelFormat@gdi32.dll": 8,
    "DescribePixelFormat@gdi32.dll": 16,
    "CreateDCW@gdi32.dll": 16,
    "DeleteDC@gdi32.dll": 4,
    "DeleteObject@gdi32.dll": 4,
    "CreateBitmap@gdi32.dll": 20,
    "CreateDIBSection@gdi32.dll": 24,
    "CreateRectRgn@gdi32.dll": 16,
    "GetDeviceGammaRamp@gdi32.dll": 8,
    "SetDeviceGammaRamp@gdi32.dll": 8,
    "SwapBuffers@gdi32.dll": 4,
    # dbghelp -- 4 of 5 were under-measured
    "SymInitialize@dbghelp.dll": 12,         # measured 4, wrong
    "SymSetOptions@dbghelp.dll": 4,
    "SymGetSymFromAddr64@dbghelp.dll": 16,   # measured 4, wrong
    "SymGetLineFromAddr64@dbghelp.dll": 16,  # measured 4, wrong
    "UnDecorateSymbolName@dbghelp.dll": 16,
    # advapi32
    "OpenProcessToken@advapi32.dll": 12,
    "AdjustTokenPrivileges@advapi32.dll": 24,
    "LookupPrivilegeValueA@advapi32.dll": 12,
    # shell32
    "DragAcceptFiles@shell32.dll": 8,
    "DragFinish@shell32.dll": 4,
    "DragQueryPoint@shell32.dll": 8,
    "DragQueryFileW@shell32.dll": 16,
    "ShellExecuteA@shell32.dll": 24,
    "SHFileOperationA@shell32.dll": 4,
    # winmm
    "timeBeginPeriod@winmm.dll": 4,
    "timeEndPeriod@winmm.dll": 4,
    "timeGetDevCaps@winmm.dll": 8,
    # user32 -- MessageBoxA sets its args with `mov [esp+N]`, so the push-count
    # sweep saw 1 push and reported 4. The signature says 4 params.
    "MessageBoxA@user32.dll": 16,
    # GetActiveWindow takes NO arguments. The push-count sweep saw the caller's
    # 3 pending MessageBoxA pushes and reported 12; purging 12 would pop the
    # next call's arguments and desynchronise the frame at all 4 sites.
    "GetActiveWindow@user32.dll": 0,
    # GetWindowLongA takes TWO DWORDs; SetWindowLongA THREE. The sweep saw the
    # interleaved pushes (the game passes the second arg as a leftover from an
    # internal helper call, so only the last push is adjacent) and reported 4
    # for both. Purges of 4 would leak 4/8 bytes at 0x00a19fe3/0x00a19ff9.
    "GetWindowLongA@user32.dll": 8,
    "SetWindowLongA@user32.dll": 12,
    # VerSetConditionMask(ULONGLONG, DWORD, BYTE): 4 pushed DWORDs = 16 bytes.
    # Reached at 0x00a8100f via a register-held call (`mov esi,[0xb18204]`),
    # so the call-site census measured 0 sites and the auto-purge is unknown.
    "VerSetConditionMask@kernel32.dll": 16,
    # Real signatures (the sweep again counted interleaved/leftover pushes):
    #   GetPropW(hwnd, name) = 8 (sweep 20)   FlashWindow(hwnd, invert) = 8 (12)
    #   IsIconic(hwnd) = 4 (8)                IsZoomed(hwnd) = 4 (8)
    #   GetCursorPos(pt) = 4 (12)
    # The dispatcher pops 4 + arg_bytes, so arg_bytes must be what the REAL
    # callee pops -- the game's own post-call cleanup handles any leftovers.
    "GetPropW@user32.dll": 8,
    "FlashWindow@user32.dll": 8,
    "IsIconic@user32.dll": 4,
    "IsZoomed@user32.dll": 4,
    "GetCursorPos@user32.dll": 4,
    # MultiByteToWideChar(UINT,DWORD,LPCCH,int,LPWSTR,int) = SIX DWORDs = 24.
    # The sweep counted NINE pushes at 0x00a80af3 (three of them are the
    # callee's OWN saved-register pushes: push ebx/esi/edi precede the six
    # args with no intervening control transfer) and purged 36; purging 36
    # over-pops by 12, the epilogue pops restore the caller's EBX from a
    # stale slot, and sub_00a5cd20's frame base becomes 0 -> the window-
    # creation crash at 0x00a5d322 (mov eax,[ebx+8]). Measured fix: EBX
    # stays 0x0dfeb474 through the whole function and the window opens.
    # Same saved-register-push trap at the 0x00a80b6c site (6 pushes -> 24).
    "MultiByteToWideChar@kernel32.dll": 24,
    # WideCharToMultiByte(UINT,DWORD,LPCWCH,int,LPSTR,int,LPCCH,LPBOOL) = 8.
    # Sweep measured 8 pushes; the real signature is the authority.
    "WideCharToMultiByte@kernel32.dll": 32,
    # RegisterRawInputDevices(PCRAWINPUTDEVICE,UINT,UINT) = 12. Sweep saw 4
    # pushes (16) at one site.
    "RegisterRawInputDevices@user32.dll": 12,
    # K32GetProcessMemoryInfo(HANDLE,PPROCESS_MEMORY_COUNTERS,DWORD) = 12.
    # Sweep saw 1 push (4); purging 4 leaks 8 bytes at its call site.
    "K32GetProcessMemoryInfo@kernel32.dll": 12,
    # shcore (dynamic module, same pattern as version/ntdll): the game probes
    # GetDpiForMonitor once the version check reports Windows 8+.
    "SetProcessDpiAwareness@shcore.dll": 4,
    "GetDpiForMonitor@shcore.dll": 16,
    # ole32 / bcrypt / opengl32
    "CoUninitialize@ole32.dll": 0,
    "BCryptGenRandom@bcrypt.dll": 16,
    "wglGetProcAddress@opengl32.dll": 4,
    "glGetIntegerv@opengl32.dll": 8,
    "glGetString@opengl32.dll": 4,
    "glGetStringi@opengl32.dll": 8,
    "glClear@opengl32.dll": 4,
}


def convention_for(dll, sym):
    """Returns (conv, source). conv in {'cdecl','stdcall','thiscall'}."""
    if dll.startswith("api-ms-win-crt-"):
        return "cdecl", "crt-apiset(cdecl by definition)"
    if dll in CDECL_DLLS:
        return "cdecl", "library-abi"
    if dll in STDCALL_DLLS:
        return "stdcall", "win32-abi"
    if dll == "msvcp140.dll":
        # MSVC name mangling encodes it: @@QAE/@@UAE/@@IAE/@@MAE/@@AAE are
        # __thiscall member functions; @@YA is a free __cdecl function.
        if re.search(r"@@[QUIMAB]{1,2}[AB]?E", sym):
            return "thiscall", "msvc-mangling"
        if "@@YA" in sym or "@@_" in sym:
            return "cdecl", "msvc-mangling"
        return "cdecl", "msvc-mangling(default)"
    return "cdecl", "unknown-dll(assumed cdecl)"


def c_ident(dll, sym):
    """The shim's C name.

    THIS MUST MATCH scripts/recomp/lift/emit.py:load_imports() EXACTLY.

    The lifter turns `call dword ptr [IAT slot]` into a direct call to this
    symbol at lift time, so if the two generators disagree on a name the module
    fails to link -- or worse, links against a second, parallel definition. An
    earlier version of this file used `shim_<dll.split('.')[0]>__<sym>`, which
    both diverged from the lifter and silently truncated `lua5.3.3r.dll` to
    `lua5`, losing the version.

    Algorithm, copied from the lifter:
        stem = dll.lower(), then remove ".dll", "-l1-1-0", ".drv"
        stem = non-alphanumeric -> "_"
        name = characters other than [A-Za-z0-9_] -> "_"
        ident = "imp_" + stem + "__" + name
    """
    stem = dll.lower()
    for suf in (".dll", "-l1-1-0", ".drv"):
        stem = stem.replace(suf, "")
    stem = "".join(c if c.isalnum() else "_" for c in stem)
    name = "".join(c if (c.isalnum() or c == "_") else "_" for c in sym)
    return "imp_%s__%s" % (stem, name)


def _text_ranges(pe):
    """Cover all of .text as (lo, hi) chunks anchored on known function starts.

    A single linear sweep from the section base desyncs on the first data blob
    and then silently misses call sites -- that is what produced 512 'unknown'
    entries on the first attempt. Anchoring on Ghidra's function starts and
    sweeping the gaps between them keeps the decoder in phase.
    """
    export_dir = OUT_DIR.parent / "export"
    text = pe.section(".text")
    lo0, hi0 = pe.image_base + text.rva, pe.image_base + text.rva + text.raw_size
    fns = []
    p = export_dir / "functions.jsonl"
    if p.exists():
        with p.open("r", encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                if r.get("recovered") or not r.get("inText"):
                    continue
                fns.append((int(r["va"], 16), int(r["endVa"], 16)))
    else:
        d = json.loads((CENSUS_DIR / "functions.json").read_text(encoding="utf-8"))
        fns = [(int(f["va"], 16), int(f["va"], 16) + f["size"]) for f in d["functions"]]
    fns.sort()
    out, cur = [], lo0
    for a, b in fns:
        a, b = max(a, lo0), min(b, hi0)
        if b <= a:
            continue
        if a > cur:
            out.append((cur, a))
        out.append((a, b))
        cur = max(cur, b)
    if cur < hi0:
        out.append((cur, hi0))
    return out


def find_thunks(pe, slot_vas, ranges, reg_loads=None):
    """ILT thunks: a 6-byte `jmp dword ptr [slot]`. MSVC routes most calls
    through these, so `call <thunk>` must be credited to the underlying import
    or the stack measurement sees almost nothing.

    The same decode pass also counts REGISTER-HELD loads of a slot
    (`mov r32, dword ptr [slot]`, later `call r32`) into `reg_loads`
    {slot: count}. Those calls are invisible to the call-site census, and
    every one of them that reached the boot (FindNextFileW, LoadImageA,
    SendMessageA, ...) surfaced as a NEVER_CALLED import with an unknown
    purge trapping mid-boot. With the count, the verdict below can no longer
    call a reachable import NEVER_CALLED."""
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    text = pe.section(".text")
    base_off, base_va = text.raw_offset, pe.image_base + text.rva
    thunks = {}
    for lo, hi in ranges:
        off = base_off + (lo - base_va)
        for ins in md.disasm(pe.data[off:off + (hi - lo)], lo):
            if ins.mnemonic == "jmp" and ins.size == 6:
                for op in ins.operands:
                    if (op.type == X86_OP_MEM and op.mem.base == X86_REG_INVALID
                            and op.mem.index == X86_REG_INVALID):
                        d = op.mem.disp & 0xFFFFFFFF
                        if d in slot_vas:
                            thunks[ins.address] = d
                    break
            elif (reg_loads is not None and ins.mnemonic == "mov"
                    and len(ins.operands) == 2 and ins.operands[1].type == X86_OP_MEM
                    and ins.operands[1].mem.base == X86_REG_INVALID
                    and ins.operands[1].mem.index == X86_REG_INVALID
                    and ins.operands[1].size == 4):
                d = ins.operands[1].mem.disp & 0xFFFFFFFF
                if d in slot_vas:
                    reg_loads[d] = reg_loads.get(d, 0) + 1
    return thunks


def measure_stack_discipline(pe, slot_vas, ranges, thunks):
    """For every call that reaches an import -- directly through its IAT slot or
    via an ILT thunk -- count the pushes immediately preceding it and record
    whether the next instruction is `add esp, N`.

      `add esp, N` present  -> caller cleans  -> CDECL,   purge 0, args N bytes
      no `add esp`          -> callee cleans  -> STDCALL, purge = 4 * pushes
    """
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    text = pe.section(".text")
    base_off, base_va = text.raw_offset, pe.image_base + text.rva

    stats = defaultdict(lambda: {"pushes": Counter(), "addesp": Counter(), "n": 0})
    for lo, hi in ranges:
        off = base_off + (lo - base_va)
        pending, pushes = None, 0
        for ins in md.disasm(pe.data[off:off + (hi - lo)], lo):
            if pending is not None:
                if (ins.mnemonic == "add" and len(ins.operands) == 2
                        and ins.operands[0].type != X86_OP_MEM
                        and ins.operands[0].reg == X86_REG_ESP
                        and ins.operands[1].type == X86_OP_IMM):
                    stats[pending]["addesp"][ins.operands[1].imm] += 1
                else:
                    stats[pending]["addesp"][0] += 1
                pending = None

            if ins.mnemonic == "push":
                pushes += 1
                continue

            hit = None
            if ins.mnemonic in ("call", "jmp"):
                for op in ins.operands:
                    if (op.type == X86_OP_MEM and op.mem.base == X86_REG_INVALID
                            and op.mem.index == X86_REG_INVALID):
                        d = op.mem.disp & 0xFFFFFFFF
                        if d in slot_vas:
                            hit = d
                    elif op.type == X86_OP_IMM:
                        t = op.imm & 0xFFFFFFFF
                        if t in thunks:
                            hit = thunks[t]
                    break
            if hit is not None:
                stats[hit]["pushes"][pushes] += 1
                stats[hit]["n"] += 1
                if ins.mnemonic == "call":
                    pending = hit
            # any control transfer ends the current argument-push run
            if ins.mnemonic in ("call", "jmp", "ret", "retn") or \
                    ins.mnemonic.startswith("j"):
                pushes = 0
    return stats


def _shim_base() -> int:
    """ISAAC_SHIM_BASE from isaac_host.h: the tokens baked into the generated
    table must be the arena the host layer resolves (round 24f moved it from
    0x0f000000 to 0x33000000 when the guest heap grew to 768 MiB)."""
    hdr = (Path(__file__).resolve().parent / "include" / "isaac_host.h").read_text(encoding="utf-8")
    m = re.search(r"#define ISAAC_SHIM_BASE\s+(0x[0-9a-fA-F]+)u", hdr)
    if not m:
        raise SystemExit("gen_shims: ISAAC_SHIM_BASE not found in isaac_host.h")
    return int(m.group(1), 16)


SHIM_BASE = _shim_base()


def main():
    pe = PE()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    GEN_DIR.mkdir(parents=True, exist_ok=True)

    imports = json.loads((CENSUS_DIR / "imports.json").read_text(encoding="utf-8"))
    syms = imports["symbols"]
    slot_vas = {int(s["iatVa"], 16) for s in syms}
    ranges = _text_ranges(pe)
    reg_loads = {}
    thunks = find_thunks(pe, slot_vas, ranges, reg_loads)
    stats = measure_stack_discipline(pe, slot_vas, ranges, thunks)

    rows = []
    for i, s in enumerate(sorted(syms, key=lambda x: (-x["callSites"], x["dll"], x["symbol"]))):
        dll, sym = s["dll"], s["symbol"]
        key = "%s@%s" % (sym, dll)
        verdict = SYMBOL_OVERRIDE.get(key, DLL_DEFAULT.get(dll, "UNIMPLEMENTED"))
        # NEVER_CALLED means genuinely unreachable: no `call [slot]` / thunk
        # site AND no `mov r32, [slot]` load anywhere in .text (round 11b:
        # the register-held form is how LoadImageA, SendMessageA, ... are
        # reached). An explicit override still wins.
        slot = int(s["iatVa"], 16)
        reg_held = reg_loads.get(slot, 0)
        if s["callSites"] == 0 and reg_held == 0 and key not in SYMBOL_OVERRIDE:
            verdict = "NEVER_CALLED"

        st = stats.get(slot)
        pushes = addesp = None
        agree = None
        if st and st["n"]:
            pushes = st["pushes"].most_common(1)[0][0]
            addesp = st["addesp"].most_common(1)[0][0] if st["addesp"] else None
            agree = (len(st["pushes"]) == 1, len(st["addesp"]) <= 1)

        conv, conv_src = convention_for(dll, sym)
        callee_pops = conv in ("stdcall", "thiscall")

        # Decorated stdcall exports carry the purge in the name (`_EOS_Foo@16`).
        m = re.search(r"@(\d+)$", sym)
        decorated = int(m.group(1)) if m else None

        curated = CURATED_PURGE.get(key)
        measured_purge = pushes * 4 if pushes is not None else None
        if not callee_pops:
            # cdecl: the CALLER cleans, so the shim must pop nothing. The
            # measured `add esp, N` is recorded as the observed argument size
            # for documentation only -- it is never used as a purge.
            arg_bytes, src = 0, "cdecl(caller cleans)"
        elif curated is not None:
            arg_bytes, src = curated, "curated-signature"
        elif decorated is not None:
            arg_bytes, src = decorated, "name-decoration"
        elif measured_purge is not None:
            arg_bytes, src = measured_purge, "measured-push-count"
        else:
            arg_bytes, src = 0xFFFF, "UNKNOWN-PURGE"   # never guess silently
        purge_clash = (curated is not None and measured_purge is not None
                       and curated != measured_purge)

        # Cross-check: does the sweep's naive heuristic agree with the ABI rule?
        heur = "stdcall" if (addesp == 0 and pushes) else (
            "cdecl" if (addesp or 0) > 0 else None)
        rows.append({
            "index": i, "dll": dll, "symbol": sym,
            "iatSlotVa": slot, "callSites": s["callSites"],
            "regHeldLoads": reg_held,
            "verdict": verdict,
            "convention": conv, "conventionSource": conv_src,
            "argBytes": arg_bytes, "isStdcall": 1 if callee_pops else 0,
            "argBytesSource": src,
            "observedArgBytesCdecl": addesp if not callee_pops else None,
            "measuredPushes": pushes, "measuredAddEsp": addesp,
            "heuristicConvention": heur,
            "heuristicAgrees": (heur == conv) if heur else None,
            "purgeClash": purge_clash,
            "purgeConfidence": (
                "high" if src in ("curated-signature", "name-decoration") else
                "none" if src == "UNKNOWN-PURGE" else
                "low" if (agree and not agree[0]) or (st and st["n"] < 2) else
                "medium"),
            "pushCountConsistent": agree[0] if agree else None,
            "cleanupConsistent": agree[1] if agree else None,
            "shimVa": SHIM_BASE + i * 16,
            "cident": c_ident(dll, sym),
        })

    # ---- dynamic exports (not in the IAT, resolved via LoadLibraryA +
    # GetProcAddress at runtime; tokens continue the stride after the IAT
    # rows so isaac_resolve_shim's index math still holds) ----
    # version.dll: the game probes it during startup version checks; the
    # resolved address is stored at 0x00c75adc and called directly, so a
    # missing row would leave that cell NULL and crash main().
    DYNAMIC_EXPORTS = [
        # OpenAL-SOFT extensions the engine resolves through
        # alcGetProcAddress (round 22). ALC_APIENTRY is cdecl, so the
        # caller cleans and these purge 0. Without alcEventCallbackSOFT
        # the engine never registers the handler that sets its audio
        # manager's drain flag, and every queued sound sits forever.
        ("openal32.dll", "alcEventCallbackSOFT", 8, 0),   # (callback, userptr)
        ("openal32.dll", "alcEventControlSOFT", 12, 0),   # (count, events, enable)
        ("openal32.dll", "alcDevicePauseSOFT", 4, 0),     # (device)
        ("openal32.dll", "alcDeviceResumeSOFT", 4, 0),    # (device)
        ("openal32.dll", "alcReopenDeviceSOFT", 16, 0),   # (device, name, attribs)
        ("version.dll", "VerifyVersionInfoA", 16),  # (ptr, DWORD, ULONGLONG)
        # The game probes ntdll.dll!RtlVerifyVersionInfo at 0x00a8074e and
        # stores the result at 0x00c75adc, then calls through that cell
        # unconditionally at 0x00a80f86 / 0x00a8102c. ntdll is always loaded
        # on Windows, so the probe cannot fail there; our port must answer it.
        ("ntdll.dll", "RtlVerifyVersionInfo", 16),
        # GLFW's WGL bootstrap (0x00a7fce0) LoadLibraryA("opengl32.dll") and
        # resolves the seven wgl entry points via GetProcAddress into
        # 0x00c75d44..0x00c75d5c, then calls them (wglCreateContext,
        # wglDeleteContext, wglGetProcAddress, wglMakeCurrent). opengl32 is not
        # statically imported, so only these rows plus module registration
        # make the probe succeed; without them boot dies at 0x00a19fb9 (NULL
        # window object -> mov ecx,[esi+0x2b4] with ESI=0).
        # wglGetProcAddress is intentionally absent: the PE already imports it
        # statically (IAT 0x00b184fc), so the resolver finds that row.
        ("opengl32.dll", "wglCreateContext", 4),        # (HDC)
        ("opengl32.dll", "wglDeleteContext", 4),        # (HGLRC)
        ("opengl32.dll", "wglGetCurrentDC", 0),         # ()
        ("opengl32.dll", "wglGetCurrentContext", 0),    # ()
        ("opengl32.dll", "wglMakeCurrent", 8),          # (HDC, HGLRC)
        ("opengl32.dll", "wglShareLists", 8),           # (HGLRC, HGLRC)
        # The game's GL context-capability refresh (0x00a6b570, GLFW's
        # _glfwRefreshContextAttribs) resolves these four names through
        # wglGetProcAddress (0x00a7fc80) and calls the results WITHOUT
        # caller cleanup -- measured at 0x00a6b6e0 (glGetString:
        # push 0x1f02; call eax; mov edx,eax -- no add esp), 0x00a6bd0c
        # (glGetIntegerv: push out; push pname; call eax; xor esi,esi --
        # no add esp) and 0x00a6b9e1 (glClear: push 0x4000; call eax --
        # no add esp). That is the Win32 GL ABI (opengl32 exports are
        # __stdcall), so these MUST be stdcall rows (is_stdcall=1): the
        # runtime dispatcher's ESP += 4 + arg_bytes is the callee's purge.
        # A cdecl row leaks the args onto the guest stack and every later
        # push/pop in the caller runs 8 bytes low (measured at 0x00a6b570:
        # the ext-check's saved EBX/ESI/EDI came back as the GL args, and
        # 0x00a6b8e2's mov eax,[ebx] read address 0). See host_shims_gl.c
        # for the bodies:
        #   glGetIntegerv(pname, out)        -> *out = 0 (avoids the
        #     GL_NUM_EXTENSIONS/robustness/behaviour query branches, which
        #     would otherwise call glGetStringi/extension checkers)
        #   glGetString(GL_VERSION=0x1f02)  -> "4.6.0" in guest scratch
        #     (the game sscanf-parses "%d.%d.%d" -> major=4, and major>=3
        #     takes the benign glGetStringi resolution branch)
        #   glGetStringi(name, index)        -> NULL (never called: only
        #     stored into [node+0x220]; the extension checker needs
        #     count>0 from glGetIntegerv(GL_NUM_EXTENSIONS), which stays 0)
        #   glClear(0x4000)                  -> no-op (result discarded)
        ("opengl32.dll", "glGetIntegerv", 8, 1),
        ("opengl32.dll", "glGetString", 4, 1),
        ("opengl32.dll", "glGetStringi", 8, 1),
        ("opengl32.dll", "glClear", 4, 1),
        # The libepoxy surface: the game's odsa layer resolves every gl* name
        # it calls through wglGetProcAddress (epoxy_wglGetProcAddress slot
        # 0x00c13410) and stores the result into the .data slot, then calls
        # it with NO caller cleanup (Win32 GL ABI, __stdcall).  gl_census.py
        # measured these 75 names as called by caller code; a missing row
        # leaves the slot NULL and the odsa lazy binder tail-jumps to 0
        # (measured at 0x00a38680 for glGenFramebuffers).  Signatures are the
        # GL API arg counts; bodies in host_shims_gl.c are benign headless
        # answers (fake object tokens, zeros, no-ops, framebuffer-complete).
        ("opengl32.dll", "glActiveTexture", 4, 1),
        ("opengl32.dll", "glAttachShader", 8, 1),
        ("opengl32.dll", "glBindFramebuffer", 8, 1),
        ("opengl32.dll", "glBindRenderbuffer", 8, 1),
        ("opengl32.dll", "glBindTexture", 8, 1),
        ("opengl32.dll", "glBlendEquation", 4, 1),
        ("opengl32.dll", "glBlendFuncSeparate", 16, 1),
        ("opengl32.dll", "glCheckFramebufferStatus", 4, 1),
        ("opengl32.dll", "glClampColorARB", 8, 1),
        ("opengl32.dll", "glClearColor", 16, 1),
        ("opengl32.dll", "glClearDepth", 8, 1),
        ("opengl32.dll", "glCompileShader", 4, 1),
        ("opengl32.dll", "glCreateProgram", 0, 1),
        ("opengl32.dll", "glCreateShader", 4, 1),
        ("opengl32.dll", "glCullFace", 4, 1),
        ("opengl32.dll", "glDeleteFramebuffers", 8, 1),
        ("opengl32.dll", "glDeleteProgram", 4, 1),
        ("opengl32.dll", "glDeleteRenderbuffers", 8, 1),
        ("opengl32.dll", "glDeleteShader", 4, 1),
        ("opengl32.dll", "glDeleteTextures", 8, 1),
        ("opengl32.dll", "glDepthFunc", 4, 1),
        ("opengl32.dll", "glDisable", 4, 1),
        ("opengl32.dll", "glDisableVertexAttribArray", 4, 1),
        ("opengl32.dll", "glDrawArraysInstancedEXT", 16, 1),
        ("opengl32.dll", "glDrawElements", 16, 1),
        ("opengl32.dll", "glEnable", 4, 1),
        ("opengl32.dll", "glEnableVertexAttribArray", 4, 1),
        ("opengl32.dll", "glFramebufferRenderbuffer", 16, 1),
        ("opengl32.dll", "glFramebufferTexture2D", 20, 1),
        ("opengl32.dll", "glGenFramebuffers", 8, 1),
        ("opengl32.dll", "glGenRenderbuffers", 8, 1),
        ("opengl32.dll", "glGenTextures", 8, 1),
        ("opengl32.dll", "glGetAttribLocation", 8, 1),
        ("opengl32.dll", "glGetCombinerInputParameterivNV", 20, 1),
        ("opengl32.dll", "glGetProgramInfoLog", 16, 1),
        ("opengl32.dll", "glGetProgramiv", 12, 1),
        ("opengl32.dll", "glGetRenderbufferParameteriv", 12, 1),
        ("opengl32.dll", "glGetShaderInfoLog", 16, 1),
        ("opengl32.dll", "glGetShaderiv", 12, 1),
        ("opengl32.dll", "glGetUniformLocation", 8, 1),
        ("opengl32.dll", "glLinkProgram", 4, 1),
        ("opengl32.dll", "glMultiDrawArraysIndirectEXT", 16, 1),
        ("opengl32.dll", "glProgramUniform1ivEXT", 16, 1),
        ("opengl32.dll", "glReadPixels", 28, 1),
        ("opengl32.dll", "glRenderbufferStorage", 16, 1),
        ("opengl32.dll", "glShaderSource", 16, 1),
        ("opengl32.dll", "glTexImage2D", 36, 1),
        ("opengl32.dll", "glTexParameteri", 12, 1),
        ("opengl32.dll", "glTexSubImage2D", 36, 1),
        ("opengl32.dll", "glUniform1fv", 12, 1),
        ("opengl32.dll", "glUniform1i", 8, 1),
        ("opengl32.dll", "glUniform1iv", 12, 1),
        ("opengl32.dll", "glUniform1uiv", 12, 1),
        ("opengl32.dll", "glUniform2fv", 12, 1),
        ("opengl32.dll", "glUniform2iv", 12, 1),
        ("opengl32.dll", "glUniform2uiv", 12, 1),
        ("opengl32.dll", "glUniform3fv", 12, 1),
        ("opengl32.dll", "glUniform3iv", 12, 1),
        ("opengl32.dll", "glUniform3uiv", 12, 1),
        ("opengl32.dll", "glUniform4fv", 12, 1),
        ("opengl32.dll", "glUniform4iv", 12, 1),
        ("opengl32.dll", "glUniform4uiv", 12, 1),
        ("opengl32.dll", "glUniformMatrix2fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix2x3fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix2x4fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix3fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix3x2fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix3x4fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix4fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix4x2fv", 16, 1),
        ("opengl32.dll", "glUniformMatrix4x3fv", 16, 1),
        ("opengl32.dll", "glUseProgram", 4, 1),
        ("opengl32.dll", "glVertexAttribPointer", 24, 1),
        ("opengl32.dll", "glVertexStream2fATI", 12, 1),
        ("opengl32.dll", "glViewport", 16, 1),
        # DInput8: the game's Gamepad_init (0x00a6cf80) probes
        # "XInput1_4.dll"/"bin\XInput1_4.dll"/"XInput1_3.dll"/"bin\
        # XInput1_3.dll" first and degrades to DInput only when they are
        # absent (log 0x00ba19b0, "proceeding with DInput only"), but the
        # DINPUT8.dll probe is FATAL when it fails (0x00a6d022 -> log
        # 0x00ba17e4 -> abort via 0xb18880), so the module must load and
        # DirectInput8Create must succeed.
        # Call flow (0x00a6d0f0): GetProcAddress(hDInput8, "DirectInput8Create"),
        # then DirectInput8Create(hinst, 0x800, IID_IDirectInput8A @ 0xba1e80,
        # &0xc7e2fc, NULL); DI_OK (0) + a fake object with a host-token vtable
        # keep the joystick enumeration (0x00a6db57: [obj]->vtable slot 4 =
        # EnumDevices(DI8DEVCLASS_GAMECTRL=4, cb=0xa6d560, ctx, flags)) on the
        # zero-device arm: no controller is enumerated, so the game runs with
        # an empty gamepad set. The per-frame poller (0x00a6dab0) then only
        # pumps the (nonexistent) hidden notification window.
        # DirectInput8Create is __stdcall (WINAPI): 5 params -> purge 20.
        ("dinput8.dll", "DirectInput8Create", 20),
        # The four IUnknown + two DI8 methods the game can reach through the
        # fake vtable. Token-callable rows (stdcall purges): QI(3 params=12),
        # AddRef/Release(1=4), GetDeviceCount(1=4).
        # EnumDevices purge MUST be 20, not 16: the callsite (0x00a6db57)
        # pushes FIVE stack dwords (this + 4 args) and never cleans them
        # (0x00a6db6e continues with no add esp). With purge 16 the dispatcher
        # leaves 4 bytes on the stack; the pump epilogue's pop edi then reads
        # the leftover arg (0) instead of the saved edi (0x0f0006e0) and the
        # caller dies at call edi @ 0x00a6d17b (measured run 18/19).
        ("dinput8.dll", "IDirectInput8A_QueryInterface", 12),
        ("dinput8.dll", "IDirectInput8A_AddRef", 4),
        ("dinput8.dll", "IDirectInput8A_Release", 4),
        ("dinput8.dll", "IDirectInput8A_GetDeviceCount", 4),
        ("dinput8.dll", "IDirectInput8A_EnumDevices", 20),
        # Steam API: the game imports SteamInternal_ContextInit directly
        # (121 IAT refs to slot 0xb18a1c).  Caller contract, verified at
        # 0x00a7136f / 0x00a9e317 / 0x00a7db30:
        #   eax = ContextInit(&slot); if ([eax]) { ecx=[eax]; eax=[ecx];
        #   call [eax+off] }   -- so the shim returns the slot address with a
        # fake context installed: [slot]=O, [O]=V, and V's slots are these
        # token-callable PROVIDED rows (the DI8 fake-object pattern).
        # The fake CSteamAPIContext answers every interface lookup with 0 or
        # an 8-zero-byte identity so the game's GUID-match loops (0x00a9e35e,
        # 0x00a9e4a1) take their safe no-steam arms: 0xa62dc0 is NULL-safe,
        # the V+0xc count<=0 path is an early exit, and the 0xa9e2d0 callers
        # ignore the return value entirely.
        # Purges are the CALLER's pushed arg bytes (thiscall slots clean
        # their own args; cdecl ContextInit row keeps argBytes=0 and the
        # caller's add esp handles it).  V+0x14/V+0x1c callers push one dword
        # and overwrite the 4 bytes above it (push ecx + mov [esp]/[esp+4]):
        # the callee's ret 8 pops 8, so the purge is 8 there.
        ("steam_api.dll", "CSteamAPIContext_Interface", 0),
        ("steam_api.dll", "CSteamAPIContext_SteamClient", 4),
        ("steam_api.dll", "CSteamAPIContext_CreateSteamPipe", 4),
        ("steam_api.dll", "CSteamAPIContext_GetSteamGenericInterface", 12),
        ("steam_api.dll", "CSteamAPIContext_ConnectToGlobalUser", 8),
        ("steam_api.dll", "CSteamAPIContext_ReleaseInterface", 8),
        ("steam_api.dll", "CSteamAPIContext_Init", 4),
        ("steam_api.dll", "CSteamAPIContext_Zero", 4),
    ]
    dynamic_rows = []  # runtime-resolved (wglGetProcAddress/steam ctx): NOT IAT symbols
    # Tokens/indices continue the stride AFTER the last IAT row so
    # isaac_resolve_shim's (token-base)/stride index math still lands on the
    # right isaac_imports[] slot. These rows are emitted into the C table
    # (GetProcAddress must resolve them by name) but are NOT in the IAT, so
    # isaac_boot_bind_iat skips them (it guards iat_slot_va == 0) and the JSON
    # report keeps them under a separate "dynamicImports" key so the 622-IAT
    # invariants the tests assert stay exactly 622.
    for k, (dll, sym, arg_bytes, *conv) in enumerate(DYNAMIC_EXPORTS):
        is_std = conv[0] if conv else 1
        # argBytes is the runtime PURGE (isaac_indirect_call does ESP +=
        # 4 + arg_bytes): cdecl callers clean their own pushes, so cdecl
        # rows must purge 0 here. The signature size stays in the comment.
        purge = arg_bytes if is_std else 0
        idx = len(rows) + k
        dynamic_rows.append({
            "index": idx, "dll": dll, "symbol": sym,
            "iatSlotVa": 0, "shimVa": SHIM_BASE + idx * 16,
            "argBytes": purge, "isStdcall": is_std,
            "argBytesSource": "curated-signature",
            "callSites": 0, "verdict": "PROVIDED",
            "convention": "stdcall" if is_std else "cdecl",
            "conventionSource": "curated-signature",
            "observedArgBytesCdecl": None, "measuredPushes": 4,
            "measuredAddEsp": None, "heuristicConvention": "stdcall",
            "heuristicAgrees": True, "purgeClash": None,
            "purgeConfidence": "high",
            "pushCountConsistent": True, "cleanupConsistent": True,
            "cident": c_ident(dll, sym),
        })

    # ---- report ----
    by_verdict = Counter(r["verdict"] for r in rows)
    sites_by_verdict = Counter()
    for r in rows:
        sites_by_verdict[r["verdict"]] += r["callSites"]
    by_src = Counter(r["argBytesSource"] for r in rows)
    by_conv = Counter(r["convention"] for r in rows)
    by_conf = Counter(r["purgeConfidence"] for r in rows)
    disagree = [r for r in rows if r["heuristicAgrees"] is False]
    unknown_purge = [r for r in rows if r["argBytesSource"] == "UNKNOWN-PURGE"]
    inconsistent = [r for r in rows
                    if r["callSites"] > 1 and r["pushCountConsistent"] is False]

    summary = {
        "totalImports": len(rows),
        "byVerdict": {k: {"symbols": v, "callSites": sites_by_verdict[k]}
                      for k, v in by_verdict.items()},
        "argBytesSource": dict(by_src),
        "byConvention": dict(by_conv),
        "purgeConfidence": dict(by_conf),
        "heuristicDisagreements": len(disagree),
        "unknownPurgeStdcall": [
            {"symbol": r["symbol"], "dll": r["dll"], "callSites": r["callSites"]}
            for r in unknown_purge],
        "inconsistentPushCounts": len(inconsistent),
        "inconsistentSample": [
            {"symbol": r["symbol"], "dll": r["dll"], "callSites": r["callSites"]}
            for r in inconsistent[:15]],
        "imports": rows,
        "dynamicImports": dynamic_rows,
    }
    (OUT_DIR / "shim-table.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")

    # ---- emit C ----
    # The C table includes the dynamic (non-IAT) exports so GetProcAddress can
    # resolve them; the JSON summary above keeps them separate so the IAT
    # invariants stay 622. isaac_import_count therefore == 622 + dynamic.
    emit_rows = rows + dynamic_rows
    decls, table = [], []
    for r in emit_rows:
        decls.append("void %s(CpuState *restrict cpu);" % r["cident"])
        table.append(
            '  { "%s", "%s", 0x%08xu, 0x%08xu, %d, %d, %s, %d, %s },' % (
                r["dll"], r["symbol"].replace("\\", "\\\\").replace('"', '\\"'),
                r["iatSlotVa"], r["shimVa"], r["argBytes"], r["isStdcall"],
                VERDICT_ENUM[r["verdict"]], r["callSites"], r["cident"]))

    hdr = ["/* GENERATED by scripts/recomp/host/gen_shims.py -- do not edit. */",
           "#ifndef ISAAC_SHIM_DECLS_H", "#define ISAAC_SHIM_DECLS_H",
           '#include "isaac_host.h"', ""] + decls + ["", "#endif"]
    (GEN_DIR / "shim_decls.h").write_text("\n".join(hdr) + "\n", encoding="utf-8")

    src = ["/* GENERATED by scripts/recomp/host/gen_shims.py -- do not edit.",
           " *",
           " * %d imports. arg_bytes/is_stdcall are MEASURED from call sites:" % len(rows),
           " *   %s" % json.dumps(dict(by_src)),
           " */",
           '#include "isaac_host.h"', '#include "shim_decls.h"', "",
           "/* %d IAT imports + %d dynamic (LoadLibrary/GetProcAddress) exports */"
           % (len(rows), len(dynamic_rows)),
           "isaac_import isaac_imports[] = {"] + table + [
           "};",
           "const unsigned isaac_import_count = "
           "sizeof(isaac_imports)/sizeof(isaac_imports[0]);", ""]
    (GEN_DIR / "shim_table.c").write_text("\n".join(src) + "\n", encoding="utf-8")

    # Default weak implementations: every import gets one, so the module links
    # even before a subsystem is written, and every unimplemented call is loud.
    weak = ["/* GENERATED by scripts/recomp/host/gen_shims.py -- do not edit.",
            " * Weak fallbacks. A hand-written shim in src/ overrides its entry",
            " * simply by defining the same symbol strongly. Nothing here can",
            " * silently succeed: each either logs-once or aborts.",
            " */",
            '#include "isaac_host.h"', '#include "shim_decls.h"', "",
            "extern isaac_import *isaac_find_import_by_shim(uint32_t shim_va);", ""]
    for r in emit_rows:
        weak.append("__attribute__((weak)) void %s(CpuState *restrict cpu) {"
                    % r["cident"])
        weak.append("    static const isaac_import *self;")
        weak.append("    if (!self) self = &isaac_imports[%d];" % r["index"])
        if r["verdict"] in ("STUB", "NEVER_CALLED"):
            weak.append("    isaac_stub_hit(self, cpu); cpu->EAX = 0;")
        else:
            weak.append("    isaac_trap(self, cpu);")
        weak.append("}")
    (GEN_DIR / "shim_weak.c").write_text("\n".join(weak) + "\n", encoding="utf-8")

    print("imports: %d   ILT thunks resolved: %d" % (len(rows), len(thunks)))
    print("\nby verdict:")
    for k, v in sorted(by_verdict.items(), key=lambda kv: -sites_by_verdict[kv[0]]):
        print("  %-14s %4d symbols  %6d call sites" % (k, v, sites_by_verdict[k]))
    print("\nstack discipline source:")
    for k, v in by_src.most_common():
        print("  %-32s %d" % (k, v))
    print("\ncall sites with inconsistent push counts: %d" % len(inconsistent))
    for r in inconsistent[:10]:
        print("    %-40s %s (%d sites)" % (r["symbol"][:40], r["dll"], r["callSites"]))
    print("\nwrote %s" % (OUT_DIR / "shim-table.json"))
    print("wrote %s" % (GEN_DIR / "shim_table.c"))
    print("wrote %s" % (GEN_DIR / "shim_decls.h"))
    print("wrote %s" % (GEN_DIR / "shim_weak.c"))


if __name__ == "__main__":
    main()
