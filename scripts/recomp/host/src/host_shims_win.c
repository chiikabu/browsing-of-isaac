/* host_shims_win.c -- user32 window-class / window handlers for the boot.
 *
 * The game reaches these while creating its main window (RegisterClassExW at
 * 0x00a813a5, then CreateWindowExW etc.). There is no real HWND in the wasm
 * harness; window handles and class atoms are stable magic tokens that the
 * game only compares and passes back, so identity is preserved without a
 * window. The eventual render work unit replaces these with real GLFW-style
 * handles; nothing here is part of the shipped frame path.
 *
 * Window size answers a fixed 1280x720 "display"; CreateWindowEx stores the
 * requested size and GetClientRect/GetWindowRect return it, so resolution
 * detection sees a plausible window.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <emscripten.h>

#define WIN_CLASS_MAX 32
#define WIN_HWND_MAX  32
#define WIN_ATOM_BASE 0xC000u
#define WIN_HWND_BASE 0x00020000u
#define DISPLAY_W 1280
#define DISPLAY_H 720

static struct {
    char     name[64];
    uint32_t atom;
    uint32_t wndproc, hinst;
} g_wc[WIN_CLASS_MAX];
static int g_wc_n;

static struct {
    uint32_t hwnd;
    uint32_t style, ex_style;
    uint32_t x, y, w, h;
    int      cls;                 /* index into g_wc, -1 if unknown */
} g_win[WIN_HWND_MAX];
static int g_win_n;

static int win_find_hwnd(uint32_t hwnd) {
    for (int i = 0; i < g_win_n; ++i)
        if (g_win[i].hwnd == hwnd) return i;
    return -1;
}

/* Resolve a WNDCLASS/WNDCLASSEX class-name argument: a MAKEINTRESOURCE atom
 * (high word 0) or a guest pointer to a (wide or ansi) string. */
static const char *win_class_of(uint32_t name_va, int wide, char *buf,
                                size_t cap) {
    if ((name_va & 0xFFFF0000u) == 0) {
        uint32_t atom = name_va & 0xFFFFu;
        for (int i = 0; i < g_wc_n; ++i)
            if (g_wc[i].atom == atom) return g_wc[i].name;
        return NULL;
    }
    if (wide) {
        size_t n = 0;
        while (n + 1 < cap && isaac_is_guest_va(name_va + 2 * n) &&
               isaac_r16(name_va + 2 * n)) {
            uint16_t c = isaac_r16(name_va + 2 * n);
            buf[n++] = c < 0x80 ? (char)c : '?';
        }
        buf[n] = 0;
    } else {
        isaac_guest_cstr(name_va, buf, cap, "window class");
    }
    return buf;
}

static uint32_t win_register_class(uint32_t pwcx, int wide, CpuState *cpu) {
    if (!isaac_is_guest_va(pwcx)) return 0;
    char name[64];
    uint32_t name_va = isaac_r32(pwcx + 0x28);
    uint32_t wndproc = isaac_r32(pwcx + 0x08);
    uint32_t hinst = isaac_r32(pwcx + 0x14);
    const char *cls = win_class_of(name_va, wide, name, sizeof name);
    if (!cls || !cls[0]) return 0;
    for (int i = 0; i < g_wc_n; ++i)
        if (!strcmp(g_wc[i].name, cls)) return 0;   /* already exists */
    if (g_wc_n >= WIN_CLASS_MAX) return 0;
    snprintf(g_wc[g_wc_n].name, sizeof g_wc[g_wc_n].name, "%s", cls);
    g_wc[g_wc_n].atom = WIN_ATOM_BASE + (uint32_t)g_wc_n;
    g_wc[g_wc_n].wndproc = wndproc;
    g_wc[g_wc_n].hinst = hinst;
    ++g_wc_n;
    isaac_log("[isaac][ui] RegisterClassEx%c(\"%s\") -> atom 0x%04x wndproc 0x%08x",
              wide ? 'W' : 'A', cls, WIN_ATOM_BASE + g_wc_n - 1, wndproc);
    return WIN_ATOM_BASE + (uint32_t)(g_wc_n - 1);
}

static uint32_t win_create(uint32_t ex_style, uint32_t cls_va, int wide,
                           uint32_t name_va, uint32_t style,
                           uint32_t x, uint32_t y, uint32_t w, uint32_t h,
                           CpuState *cpu) {
    char cls[64], title[128];
    const char *c = win_class_of(cls_va, wide, cls, sizeof cls);
    char tbuf[128];
    isaac_guest_cstr(name_va, tbuf, sizeof tbuf, "window title");
    snprintf(title, sizeof title, "%s", tbuf);
    if (!c) return 0;
    if (g_win_n >= WIN_HWND_MAX) return 0;
    uint32_t hwnd = WIN_HWND_BASE + (uint32_t)g_win_n;
    g_win[g_win_n].hwnd = hwnd;
    g_win[g_win_n].style = style;
    g_win[g_win_n].ex_style = ex_style;
    g_win[g_win_n].x = x;
    g_win[g_win_n].y = y;
    g_win[g_win_n].w = (w == 0 || w == 0x80000000u) ? DISPLAY_W : w;
    g_win[g_win_n].h = (h == 0 || h == 0x80000000u) ? DISPLAY_H : h;
    g_win[g_win_n].cls = -1;
    for (int i = 0; i < g_wc_n; ++i)
        if (strcmp(g_wc[i].name, c) == 0) { g_win[g_win_n].cls = i; break; }
    ++g_win_n;
    isaac_log("[isaac][ui] CreateWindowEx%c class=\"%s\" title=\"%s\" "
              "style=0x%08x %ux%u -> hwnd 0x%08x",
              wide ? 'W' : 'A', c, title[0] ? title : "(untitled)", style,
              g_win[g_win_n - 1].w, g_win[g_win_n - 1].h, hwnd);
    return hwnd;
}

/* ------------------------------------------------------- icons --------- */

/* HICON LoadIconA(HINSTANCE, LPCSTR) -- token 0x10001. */
void imp_user32__LoadIconA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0x10001u;
}

/* HANDLE LoadImageA(HINSTANCE, LPCSTR name, UINT type, int cx, int cy, UINT fuLoad)
 * -- 6 stdcall args (purge 24). Reached REGISTER-HELD (`call ebx` at
 * 0x00949b03: hInstance, MAKEINTRESOURCE(101), IMAGE_ICON, ...) for the
 * window icon, so the call-site census saw 0 sites and the purge was
 * UNKNOWN; boot round 11b stopped on that trap. No icon: return NULL, which
 * the caller tolerates (it only hands the result to SetClassLongA). */
void imp_user32__LoadImageA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    (void)isaac_arg(cpu, 3); (void)isaac_arg(cpu, 4); (void)isaac_arg(cpu, 5);
    cpu->EAX = 0;
}

/* int GetDeviceCaps(HDC, int index) -- gdi32, 8 bytes. Reached register-held
 * from GLFW's monitor/DPI code (0x00a5cd20, 0x00a5dc90, 0x00a816f0); an
 * inert 0 would put 0 dpi / 0 Hz into ratios. Answer a 96-dpi 60 Hz 32-bpp
 * display of the emulated size. */
void imp_gdi32__GetDeviceCaps(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    uint32_t index = isaac_arg(cpu, 1);
    switch (index) {
        case 8:   cpu->EAX = DISPLAY_W; break;   /* HORZRES */
        case 10:  cpu->EAX = DISPLAY_H; break;   /* VERTRES */
        case 12:  cpu->EAX = 32; break;          /* BITSPIXEL */
        case 14:  cpu->EAX = 1; break;           /* PLANES */
        case 88:  cpu->EAX = 96; break;          /* LOGPIXELSX */
        case 90:  cpu->EAX = 96; break;          /* LOGPIXELSY */
        case 116: cpu->EAX = 60; break;          /* VREFRESH */
        case 118: cpu->EAX = DISPLAY_W; break;   /* DESKTOPHORZRES */
        case 117: cpu->EAX = DISPLAY_H; break;   /* DESKTOPVERTRES */
        default:  cpu->EAX = 0; break;
    }
}

/* UINT GetRawInputDeviceList(PRAWINPUTDEVICELIST list, PUINT count, UINT size)
 * -- user32, 12 bytes. Reached register-held (0x00a6d5ea, 0x00aa80ac: raw
 * input / gamepad enumeration). The two-call protocol (NULL list: report
 * the count; then fill) must write *count, or the caller sizes its buffer
 * from stack garbage. No raw input devices: *count = 0, return 0. */
void imp_user32__GetRawInputDeviceList(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 2);
    uint32_t pcount = isaac_arg(cpu, 1);
    if (pcount && isaac_is_guest_va(pcount)) isaac_w32(pcount, 0);
    cpu->EAX = 0;
}

/* LONG SetClassLongA(HWND, int, LONG) -- no class storage; old value 0. */
void imp_user32__SetClassLongA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 0;
}

/* ------------------------------------------------------- class atoms ---- */

void imp_user32__RegisterClassExW(CpuState *restrict cpu) {
    cpu->EAX = win_register_class(isaac_arg(cpu, 0), 1, cpu);
}
void imp_user32__RegisterClassExA(CpuState *restrict cpu) {
    cpu->EAX = win_register_class(isaac_arg(cpu, 0), 0, cpu);
}
void imp_user32__UnregisterClassA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}

/* ------------------------------------------------------- windows -------- */

void imp_user32__CreateWindowExW(CpuState *restrict cpu) {
    cpu->EAX = win_create(isaac_arg(cpu, 0), isaac_arg(cpu, 1), 1,
                          isaac_arg(cpu, 2), isaac_arg(cpu, 3),
                          isaac_arg(cpu, 4), isaac_arg(cpu, 5),
                          isaac_arg(cpu, 6), isaac_arg(cpu, 7), cpu);
}
void imp_user32__CreateWindowExA(CpuState *restrict cpu) {
    cpu->EAX = win_create(isaac_arg(cpu, 0), isaac_arg(cpu, 1), 0,
                          isaac_arg(cpu, 2), isaac_arg(cpu, 3),
                          isaac_arg(cpu, 4), isaac_arg(cpu, 5),
                          isaac_arg(cpu, 6), isaac_arg(cpu, 7), cpu);
}
void imp_user32__DestroyWindow(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0);
    int i = win_find_hwnd(h);
    if (i >= 0) {
        g_win[i] = g_win[--g_win_n];
    }
    cpu->EAX = 1;
}
void imp_user32__ShowWindow(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;                       /* previously visible */
}
void imp_user32__IsWindow(CpuState *restrict cpu) {
    cpu->EAX = win_find_hwnd(isaac_arg(cpu, 0)) >= 0 ? 1u : 0u;
}
void imp_user32__IsWindowVisible(CpuState *restrict cpu) {
    cpu->EAX = win_find_hwnd(isaac_arg(cpu, 0)) >= 0 ? 1u : 0u;
}
void imp_user32__IsIconic(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_user32__IsZoomed(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_user32__GetAncestor(CpuState *restrict cpu) {
    cpu->EAX = isaac_arg(cpu, 0);
}
void imp_user32__GetLastActivePopup(CpuState *restrict cpu) {
    cpu->EAX = isaac_arg(cpu, 0);
}
void imp_user32__GetWindowThreadProcessId(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;                       /* our single fake thread id */
}
void imp_user32__BringWindowToTop(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__SetForegroundWindow(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__SetFocus(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;                       /* previous focus: none */
}
void imp_user32__SetCapture(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_user32__ReleaseCapture(CpuState *restrict cpu) {
    cpu->EAX = 1;
}
void imp_user32__WindowFromPoint(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0;
}
void imp_user32__DefWindowProcW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;
}
void imp_user32__GetWindowRect(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0), r = isaac_arg(cpu, 1);
    int i = win_find_hwnd(h);
    if (i < 0) { cpu->EAX = 0; return; }
    if (isaac_is_guest_va(r)) {
        isaac_w32(r + 0,  g_win[i].x);
        isaac_w32(r + 4,  g_win[i].y);
        isaac_w32(r + 8,  g_win[i].x + g_win[i].w);
        isaac_w32(r + 12, g_win[i].y + g_win[i].h);
    }
    cpu->EAX = 1;
}
void imp_user32__GetClientRect(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0), r = isaac_arg(cpu, 1);
    int i = win_find_hwnd(h);
    if (i < 0) { cpu->EAX = 0; return; }
    if (isaac_is_guest_va(r)) {
        isaac_w32(r + 0, 0);
        isaac_w32(r + 4, 0);
        isaac_w32(r + 8,  g_win[i].w);
        isaac_w32(r + 12, g_win[i].h);
    }
    cpu->EAX = 1;
}
void imp_user32__ClientToScreen(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;                       /* identity: window at 0,0 */
}
void imp_user32__ScreenToClient(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
void imp_user32__GetWindowPlacement(CpuState *restrict cpu) {
    uint32_t p = isaac_arg(cpu, 1);
    if (isaac_is_guest_va(p)) {
        isaac_w32(p + 0, 44);           /* length */
        isaac_w32(p + 4, 0);            /* flags */
        isaac_w32(p + 8, 1);            /* showCmd SW_SHOWNORMAL */
        /* ptMinPosition, ptMaxPosition */
        isaac_w32(p + 12, 0); isaac_w32(p + 16, 0);
        isaac_w32(p + 20, 0); isaac_w32(p + 24, 0);
        isaac_w32(p + 28, 0); isaac_w32(p + 32, 0);
        isaac_w32(p + 36, DISPLAY_W); isaac_w32(p + 40, DISPLAY_H);
    }
    cpu->EAX = 1;
}
void imp_user32__SetWindowPlacement(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
void imp_user32__MoveWindow(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0);
    int i = win_find_hwnd(h);
    if (i >= 0) {
        g_win[i].x = isaac_arg(cpu, 1);
        g_win[i].y = isaac_arg(cpu, 2);
        g_win[i].w = isaac_arg(cpu, 3);
        g_win[i].h = isaac_arg(cpu, 4);
    }
    cpu->EAX = 1;
}
void imp_user32__SetWindowTextW(CpuState *restrict cpu) {
    char t[128];
    isaac_guest_cstr(isaac_arg(cpu, 1), t, sizeof t, "window title");
    isaac_log("[isaac][ui] SetWindowTextW: \"%s\"", t);
    cpu->EAX = 1;
}
void imp_user32__FlashWindow(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
void imp_user32__GetTitleBarInfo(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
void imp_user32__SetWindowPos(CpuState *restrict cpu) {
    (void)cpu;
    cpu->EAX = 1;
}
void imp_user32__GetWindowLongA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0;
}
void imp_user32__SetWindowLongA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 0;
}
void imp_user32__GetWindowLongW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0;
}
void imp_user32__SetWindowLongW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 0;
}
void imp_user32__AdjustWindowRectEx(CpuState *restrict cpu) {
    uint32_t r = isaac_arg(cpu, 0), style = isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2);
    if (isaac_is_guest_va(r)) {
        int32_t l = (int32_t)isaac_r32(r + 0), t = (int32_t)isaac_r32(r + 4);
        int32_t rr = (int32_t)isaac_r32(r + 8), b = (int32_t)isaac_r32(r + 12);
        if (style & 0x00CF0000u) {      /* WS_CAPTION | WS_THICKFRAME ... */
            l -= 8; t -= 30; rr += 8; b += 8;
        }
        isaac_w32(r + 0, (uint32_t)l); isaac_w32(r + 4, (uint32_t)t);
        isaac_w32(r + 8, (uint32_t)rr); isaac_w32(r + 12, (uint32_t)b);
    }
    cpu->EAX = 1;
}

/* ------------------------------------------------------- drawing ------- */

void imp_user32__GetDC(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;                       /* opaque HDC token */
}
void imp_user32__ReleaseDC(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
void imp_user32__GetSystemMetrics(CpuState *restrict cpu) {
    uint32_t i = isaac_arg(cpu, 0);
    switch (i) {
        case 0:  cpu->EAX = DISPLAY_W; break;   /* SM_CXSCREEN */
        case 1:  cpu->EAX = DISPLAY_H; break;   /* SM_CYSCREEN */
        case 11: cpu->EAX = DISPLAY_W; break;   /* SM_CXMONITOR */
        case 12: cpu->EAX = DISPLAY_H; break;   /* SM_CYMONITOR */
        case 13: cpu->EAX = 32; break;          /* SM_CXCURSOR */
        case 14: cpu->EAX = 32; break;          /* SM_CYCURSOR */
        case 34: cpu->EAX = DISPLAY_W; break;   /* SM_CXMINTRACK */
        case 35: cpu->EAX = DISPLAY_H; break;   /* SM_CYMINTRACK */
        case 49: cpu->EAX = 16; break;          /* SM_CXSMICON */
        case 50: cpu->EAX = 16; break;          /* SM_CYSMICON */
        case 76: cpu->EAX = 0; break;           /* SM_XVIRTUALSCREEN */
        case 77: cpu->EAX = 0; break;           /* SM_YVIRTUALSCREEN */
        case 78: cpu->EAX = DISPLAY_W; break;   /* SM_CXVIRTUALSCREEN */
        case 79: cpu->EAX = DISPLAY_H; break;   /* SM_CYVIRTUALSCREEN */
        case 80: cpu->EAX = 1; break;           /* SM_CMONITORS */
        default: cpu->EAX = 0; break;
    }
}
void imp_user32__GetMonitorInfoW(CpuState *restrict cpu) {
    uint32_t mi = isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 0);
    if (isaac_is_guest_va(mi)) {
        isaac_w32(mi + 0, 40);          /* cbSize */
        isaac_w32(mi + 4, 0);  isaac_w32(mi + 8, 0);
        isaac_w32(mi + 12, DISPLAY_W); isaac_w32(mi + 16, DISPLAY_H);
        isaac_w32(mi + 20, 0); isaac_w32(mi + 24, 0);
        isaac_w32(mi + 28, DISPLAY_W); isaac_w32(mi + 32, DISPLAY_H);
        isaac_w32(mi + 36, 1);          /* MONITORINFOF_PRIMARY */
    }
    cpu->EAX = 1;
}
void imp_user32__MonitorFromWindow(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;                       /* the single fake monitor */
}
void imp_user32__EnumDisplayMonitors(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 1;                       /* nothing enumerated */
}
/* Round 31: one display adapter with one monitor and one mode. GLFW's
 * _glfwPollMonitorsWin32 builds its monitor list from EnumDisplayDevicesW
 * (adapters, then the monitors of each) and reads the current mode with
 * EnumDisplaySettingsW(adapter, ENUM_CURRENT_SETTINGS); with nothing
 * enumerated glfwGetPrimaryMonitor() is NULL and the game's VSync setter
 * (0x00925ce0, reached when a written options.ini is read back) asserts
 * `monitor != NULL` -- the second load of a persisted profile aborted on it.
 * DISPLAY_DEVICEW is 840 bytes: cb, DeviceName[32], DeviceString[128],
 * StateFlags, DeviceID[128], DeviceKey[128] (wide strings). DEVMODEW is 220
 * bytes: dmDeviceName[32] at 0, dmSize at 68, dmFields at 72, dmBitsPerPel
 * at 168, dmPelsWidth 172, dmPelsHeight 176, dmDisplayFrequency 184. */
static void put_wstr(uint32_t va, const char *s, uint32_t max_chars) {
    uint32_t i = 0;
    for (; s[i] && i + 1 < max_chars; ++i) isaac_w16(va + 2u * i, (uint16_t)(uint8_t)s[i]);
    isaac_w16(va + 2u * i, 0);
}
static int wstr_is(uint32_t va, const char *s) {
    if (!isaac_is_guest_va(va)) return 0;
    for (uint32_t i = 0; ; ++i) {
        uint16_t c = isaac_r16(va + 2u * i);
        if (c != (uint16_t)(uint8_t)s[i]) return 0;
        if (!s[i]) return 1;
    }
}
#define ISAAC_ADAPTER_NAME "\\\\.\\DISPLAY1"
#define ISAAC_MONITOR_NAME "\\\\.\\DISPLAY1\\Monitor0"
void imp_user32__EnumDisplayDevicesW(CpuState *restrict cpu) {
    uint32_t dev = isaac_arg(cpu, 0), idx = isaac_arg(cpu, 1), out = isaac_arg(cpu, 2);
    (void)isaac_arg(cpu, 3);
    if (idx != 0 || !isaac_is_guest_va(out) || !isaac_is_guest_va(out + 839u)) { cpu->EAX = 0; return; }
    int adapter = (dev == 0);
    if (!adapter && !wstr_is(dev, ISAAC_ADAPTER_NAME)) { cpu->EAX = 0; return; }
    for (uint32_t i = 4; i < 840u; i += 4) isaac_w32(out + i, 0);
    isaac_w32(out + 0, 840);
    put_wstr(out + 4, adapter ? ISAAC_ADAPTER_NAME : ISAAC_MONITOR_NAME, 32);
    put_wstr(out + 68, adapter ? "Isaac Display Adapter" : "Isaac Monitor", 128);
    /* adapter: ATTACHED_TO_DESKTOP | PRIMARY_DEVICE; monitor: ACTIVE | ATTACHED */
    isaac_w32(out + 324, adapter ? (0x1u | 0x4u) : (0x1u | 0x2u));
    put_wstr(out + 328, adapter ? "PCI\\VEN_1AF4&DEV_1050" : "MONITOR\\ISAAC01", 128);
    put_wstr(out + 584, "", 128);
    cpu->EAX = 1;
}
static void fill_devmode(uint32_t dm) {
    for (uint32_t i = 0; i < 220u; i += 4) isaac_w32(dm + i, 0);
    put_wstr(dm, ISAAC_ADAPTER_NAME, 32);
    isaac_w16(dm + 64, 0x0401);         /* dmSpecVersion */
    isaac_w16(dm + 66, 0x0401);         /* dmDriverVersion */
    isaac_w16(dm + 68, 220);            /* dmSize */
    isaac_w32(dm + 72, 0x40000u | 0x80000u | 0x100000u | 0x400000u | 0x20u); /* BITSPERPEL|PELSWIDTH|PELSHEIGHT|DISPLAYFREQUENCY|POSITION */
    isaac_w32(dm + 168, 32);            /* dmBitsPerPel */
    isaac_w32(dm + 172, DISPLAY_W);
    isaac_w32(dm + 176, DISPLAY_H);
    isaac_w32(dm + 184, 60);            /* dmDisplayFrequency */
}
void imp_user32__EnumDisplaySettingsW(CpuState *restrict cpu) {
    uint32_t dev = isaac_arg(cpu, 0), mode = isaac_arg(cpu, 1), dm = isaac_arg(cpu, 2);
    /* the one mode: index 0, ENUM_CURRENT_SETTINGS (-1) and ENUM_REGISTRY_SETTINGS (-2) */
    if (!(mode == 0 || mode == 0xFFFFFFFFu || mode == 0xFFFFFFFEu) || !isaac_is_guest_va(dm) || !isaac_is_guest_va(dm + 219u)
        || (dev && !wstr_is(dev, ISAAC_ADAPTER_NAME))) { cpu->EAX = 0; return; }
    fill_devmode(dm);
    cpu->EAX = 1;
}
void imp_user32__EnumDisplaySettingsExW(CpuState *restrict cpu) {
    uint32_t dev = isaac_arg(cpu, 0), mode = isaac_arg(cpu, 1), dm = isaac_arg(cpu, 2);
    (void)isaac_arg(cpu, 3);
    if (!(mode == 0 || mode == 0xFFFFFFFFu || mode == 0xFFFFFFFEu) || !isaac_is_guest_va(dm) || !isaac_is_guest_va(dm + 219u)
        || (dev && !wstr_is(dev, ISAAC_ADAPTER_NAME))) { cpu->EAX = 0; return; }
    fill_devmode(dm);
    cpu->EAX = 1;
}
void imp_user32__ChangeDisplaySettingsExW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3); (void)isaac_arg(cpu, 4);
    cpu->EAX = 0;                       /* DISP_CHANGE_SUCCESSFUL */
}
void imp_user32__SetLayeredWindowAttributes(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 1;
}
void imp_user32__GetLayeredWindowAttributes(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;
}
void imp_user32__SetCursorPos(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;
}
/* ---- input state (round 14a) -------------------------------------------- */
/* Screen coordinates == client coordinates here: ScreenToClient and
 * ClientToScreen are identity shims and the window sits at the origin. */
static int32_t g_cur_x, g_cur_y;
static uint8_t g_keydown[256];          /* physical: set as the events are queued (isaac_input_key) */
/* Round 32: Windows keeps two keyboard states. The physical one above is
 * what GetAsyncKeyState would read; the SYNCHRONOUS one changes only as key
 * messages are removed from the queue ("the key status ... changes as a
 * thread reads key messages from its message queue") -- GetKeyState reads
 * it, and it is the modifier state TranslateMessage translates under, so a
 * batch queued in one frame (Shift down, S down, S up, Shift up) translates
 * in message order rather than in whatever state the batch left. A generic
 * VK_SHIFT / VK_CONTROL / VK_MENU message sets its left/right vk too, from
 * the scancode / extended bit, as the kernel does. The toggle byte carries
 * CapsLock / NumLock / ScrollLock (GetKeyState bit 0), flipped when the
 * lock key's non-repeat key-down is removed. */
static uint8_t g_keysync[256], g_keytoggle[256];
static uint32_t g_mouse_mk;             /* MK_LBUTTON 1 | MK_RBUTTON 2 */
void imp_user32__GetCursorPos(CpuState *restrict cpu) {
    uint32_t p = isaac_arg(cpu, 0);
    if (isaac_is_guest_va(p)) { isaac_w32(p, (uint32_t)g_cur_x); isaac_w32(p + 4, (uint32_t)g_cur_y); }
    cpu->EAX = 1;
}
void imp_user32__ClipCursor(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__SetCursor(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;                       /* previous cursor: none */
}
void imp_user32__GetKeyState(CpuState *restrict cpu) {
    uint32_t vk = isaac_arg(cpu, 0) & 0xFFu;
    /* SHORT: bit 15 = down (sign-extended as the real API does), bit 0 =
     * toggled; the synchronous state, i.e. the key messages removed so far */
    int down = g_keysync[vk] ||
        (vk == 0x10u && (g_keysync[0xA0] || g_keysync[0xA1])) ||   /* VK_SHIFT   */
        (vk == 0x11u && (g_keysync[0xA2] || g_keysync[0xA3])) ||   /* VK_CONTROL */
        (vk == 0x12u && (g_keysync[0xA4] || g_keysync[0xA5]));     /* VK_MENU    */
    cpu->EAX = (down ? 0xFFFF8000u : 0u) | (g_keytoggle[vk] & 1u);
}
void imp_user32__SendInput(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 0;                       /* nothing injected */
}
void imp_user32__MapVirtualKeyW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0;
}
void imp_user32__ToUnicode(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    (void)isaac_arg(cpu, 4); (void)isaac_arg(cpu, 5);
    cpu->EAX = 0;
}

/* ------------------------------------------------------- input --------- */

void imp_user32__RegisterRawInputDevices(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 1;
}
void imp_user32__GetRawInputData(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3); (void)isaac_arg(cpu, 4);
    cpu->EAX = 0;
}
void imp_user32__GetRawInputDeviceInfoA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;
}

/* ------------------------------------------------------- messages ------ */

/* Frame cap. The game's main loop ends only when GLFW's window reports
 * shouldClose, so a boot that reaches the loop never returns. With
 * ISAAC_MAX_FRAMES=N the SwapBuffers shim counts presented frames (and
 * stamps every 60th with the elapsed wall time: the only per-frame timing
 * the log has) and, once N are presented, PeekMessageW hands GLFW's own
 * pump a single WM_QUIT; glfwPollEvents turns that into shouldClose and
 * main returns normally -- the same path a real Alt+F4 takes. */
static uint32_t g_frames_presented;
static int g_max_frames = -1;         /* -1 = env not read yet, 0 = unlimited */
static int g_quit_sent;
static int frame_cap(void) {
    if (g_max_frames < 0) {
        const char *e = getenv("ISAAC_MAX_FRAMES");
        g_max_frames = (e && *e) ? atoi(e) : 0;
    }
    return g_max_frames;
}
uint32_t isaac_frames_presented(void) { return g_frames_presented; }
#ifdef ISAAC_WEB
/* Round 37: the per-frame yield is not a timer. emscripten_sleep(0) is
 * setTimeout(0), which Chrome clamps to 4 ms once timers nest five deep --
 * and every frame resumes inside the previous timer's task, so the clamp
 * was permanent: the profile at a 4x CPU throttle showed 11% of the frame
 * idle. A MessageChannel message is a plain task with no clamp, queued
 * behind whatever else is waiting (input, fetch completions, IndexedDB,
 * the DevTools protocol), so the page stays responsive between frames.
 * Not scheduler.yield(): its continuation outranks those tasks, and when
 * the game is CPU-bound (a 4x throttle) nothing else ever ran -- the perf
 * driver's evaluate calls hung for minutes.
 *
 * Pacing: the engine has no frame limiter of its own here (unclamped, the
 * 4x-throttled page ran 122 fps), and frames the compositor never shows are
 * wasted work. So a frame that took less than a display period (< 15 ms of
 * work) waits for requestAnimationFrame -- one game frame per refresh, and
 * a hidden tab pauses -- while a slower frame takes the message, so a 20 ms
 * frame gives 50 fps rather than the 30 that vsync quantisation would.
 * A hidden document gets no requestAnimationFrame at all, so a frame there
 * waits on a 250 ms timer instead (the browser stretches it to about a
 * second): the game ticks along slowly like the desktop game does
 * unfocused, the engine's wall-clock delta stays small, and a tab brought
 * back after an hour does not replay the hour. */
/* Round 52: the save-select screen's EDIT FILE menu. The engine's
 * Menu_Save::Update (0x009d9c60) is about to show its "ARE YOU SURE?" prompt
 * for the file the cursor is on (state 1 -> 2 at 0x9d9d59); the page's menu
 * opens instead -- export, import, delete, the fps viewer -- and the engine's
 * own prompt runs only when that menu chose Delete: the page then sets
 * window.isaacEditFileDelete to the slot and presses confirm again, and the
 * gate lets the transition through. Without a page (node, a page without
 * the menu) the engine's flow is untouched. */
EM_JS(int, isaac_editfile_js, (int slot), {
    if (typeof window === "undefined" || typeof window.isaacEditFile !== "function") return 1;
    if (window.isaacEditFileDelete === slot) { window.isaacEditFileDelete = -1; return 1; }
    try { window.isaacEditFile(slot); } catch (e) { return 1; }
    return 0;
});
int isaac_editfile_gate(uint32_t menu_va) {
    int slot;
    if (!isaac_is_guest_va(menu_va) || !isaac_is_guest_va(menu_va + 7u)) return 1;
    slot = (int)*(const uint32_t *)isaac_g(menu_va + 4u);      /* this[1]: the file the cursor is on, 0..2 */
    if (slot < 0 || slot > 2) return 1;
    return isaac_editfile_js(slot);
}

EM_ASYNC_JS(void, isaac_yield_js, (void), {
    var now = performance.now();
    var work = Module.isaacYieldResumed ? now - Module.isaacYieldResumed : 1e9;
    if (typeof document !== "undefined" && document.hidden) {
        await new Promise(function (resolve) { setTimeout(resolve, 250); });
    } else if (work < 15 && typeof requestAnimationFrame === "function") {
        /* round 49: a page can read as visible and still get no animation
         * frames (an occluded embedded view; a tab throttled without
         * document.hidden flipping) -- the frame then ticks on a 250 ms
         * timer, like the hidden path, instead of never resuming */
        await new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return; done = true;
                Module.isaacYieldNoRaf = (Module.isaacYieldNoRaf | 0) + 1;
                if (typeof window !== "undefined") window.isaacYieldNoRaf = Module.isaacYieldNoRaf;
                resolve();
            }, 250);
            requestAnimationFrame(function () { if (done) return; done = true; clearTimeout(timer); resolve(); });
        });
    } else {
        if (!Module.isaacYieldChannel) {
            Module.isaacYieldChannel = new MessageChannel();
            Module.isaacYieldChannel.port1.onmessage = function () {
                var r = Module.isaacYieldResolve; Module.isaacYieldResolve = null; if (r) r();
            };
        }
        await new Promise(function (resolve) {
            Module.isaacYieldResolve = resolve;
            Module.isaacYieldChannel.port2.postMessage(0);
        });
    }
    Module.isaacYieldResumed = performance.now();
});
/* ISAAC_YIELD=1: the web build yields to the event loop per frame and paces
 * itself on the wall clock -- interactive mode (round 25). */
int isaac_web_yield_enabled(void) {
    static int v = -1;
    if (v < 0) {
        const char *e = getenv("ISAAC_YIELD");
        v = (e && *e && *e != '0') ? 1 : 0;
        if (v) {
            extern void isaac_time_set_mode(int mode);
            isaac_time_set_mode(1);
            isaac_log("[isaac][web] interactive: yielding to the event loop every frame, wall-clock time");
        }
    }
    return v;
}
#endif
#ifndef ISAAC_WEB
/* No page to hand the menu to (the node profile, the selftest): the engine's
 * own DELETE FILE prompt, as in the binary. The lifted block patch at
 * 0x009d9d59 calls this in every profile. */
int isaac_editfile_gate(uint32_t menu_va) { (void)menu_va; return 1; }
#endif
/* BOOL SwapBuffers(HDC) -- gdi32, 4 bytes. One call per presented frame. */
void imp_gdi32__SwapBuffers(CpuState *restrict cpu) {
#ifdef ISAAC_WEB
    { extern void isaac_web_present(void); isaac_web_present(); }
#endif
    (void)isaac_arg(cpu, 0);
    static double last_ms;
    double now = emscripten_get_now();
    ++g_frames_presented;
    /* The engine mixes on a thread this port does not have; one iteration
     * of it per presented frame is what feeds OpenAL (round 16b). */
    { extern void isaac_audio_pump(const CpuState *cpu); isaac_audio_pump(cpu); }
    /* every adopted thread job gets one slice per frame (round 24) */
    { extern void isaac_threads_slice(CpuState *restrict cpu); isaac_threads_slice(cpu); }
    /* ISAAC_CUTSCENE=<frame>:<id> (round 26): at that presented frame, call
     * Manager::ShowCutscene(id, cleanup=1, 0) (0x00958e60, thiscall on the
     * Manager at [0x00c7169c]) on a scratch frame. Nothing in the scripted
     * input reaches the Theora video path (the endings, cutscenes.xml
     * <videopart>), so this is how a run exercises it. */
    {
        static int parsed = -1;
        static uint32_t at_frame, id;
        if (parsed < 0) {
            const char *e = getenv("ISAAC_CUTSCENE");
            unsigned f = 0, i = 0;
            parsed = (e && *e && sscanf(e, "%u:%u", &f, &i) == 2) ? 1 : 0;
            at_frame = f; id = i;
        }
        if (parsed == 1 && g_frames_presented == at_frame) {
            CpuState sub = *cpu;
            sub.ECX = isaac_r32(0x00c7169cu);
            sub.ESP = (cpu->ESP - 0x1000u) & ~0xFu;
            sub.ESP -= 4; isaac_w32(sub.ESP, 0u);     /* third argument */
            sub.ESP -= 4; isaac_w32(sub.ESP, 1u);     /* shouldCleanup */
            sub.ESP -= 4; isaac_w32(sub.ESP, id);     /* cutsceneID */
            sub.ESP -= 4; isaac_w32(sub.ESP, 0u);     /* return address */
            isaac_log("[isaac][video] ISAAC_CUTSCENE: Manager::ShowCutscene(%u) at presented frame %u", id, at_frame);
            isaac_guest_call(0x00958e60u, &sub);
        }
    }
    /* every frame for the first 10 (with the frame's wall time), then every
     * 60th: the per-frame cost of the lifted code is a number the log must
     * carry (boot round 12: the loop ran at well under 0.1 fps, invisible
     * behind a 60-frame cadence). */
    if (g_frames_presented <= 10u || g_frames_presented % 60u == 0)
        isaac_log("[isaac][frame] %u frames presented (%.0f ms since the previous)",
                  g_frames_presented, last_ms > 0.0 ? now - last_ms : 0.0);
    last_ms = now;
    cpu->EAX = 1;
#ifdef ISAAC_WEB
    /* Round 25: hand the frame to the browser. emscripten_sleep(0) is a JSPI
     * suspension -- the whole wasm stack is parked, the page's event loop
     * runs (input events are delivered, the canvas is composited), and the
     * stack resumes on the next macrotask. Off unless ISAAC_YIELD=1, so the
     * headless runner keeps its as-fast-as-possible behaviour. */
    if (isaac_web_yield_enabled()) isaac_yield_js();
#endif
}
/* ---- message queue (round 14a) ------------------------------------------ */
/* Events arrive from the page (Module.isaacInputPoll(frame, out): four int32s
 * [type, a, b, c] per call, 0 when none is due) or from C (the selftest, the
 * node driver) and become Win32 messages for GLFW's pump:
 *   [1, vk, scancode | (extended << 8), down] -> WM_KEYDOWN / WM_KEYUP with
 *       lParam = repeat 1 | scancode << 16 | extended << 24 | (up: bits 30,31),
 *       which is exactly what GLFW's windowProc decodes (HIWORD & 0x1ff)
 *   [2, x, y, 0]      -> WM_MOUSEMOVE, lParam = x | y << 16
 *   [3, button, down] -> WM_LBUTTONDOWN/UP (0x201/0x202) or WM_RBUTTONDOWN/UP
 * and, round 32, TranslateMessage (below) turns a WM_KEYDOWN of a printable
 * key into the WM_CHAR (0x102) Windows would post, queued at the FRONT.
 * The queue is drained by PeekMessageW one message per call; the frame cap's
 * WM_QUIT (below) goes out only once the queue is empty, so scripted input
 * before the cap is always delivered. */
#define MSGQ_MAX 256u
typedef struct { uint32_t hwnd, message, wParam, lParam, time, x, y; } win_msg;
static win_msg g_msgq[MSGQ_MAX];
static unsigned g_msgq_head, g_msgq_count;
static uint32_t g_input_events, g_input_dropped, g_input_dispatched, g_chars_posted;
static uint32_t main_hwnd(void) {
    /* The game's real window is GLFW's "GLFW30" class (0x00a5b7b0's proc);
     * "GLFW3 Helper" is GLFW's hidden helper and "Message" the DirectInput
     * hotplug window created LAST -- keys sent to that one reach 0x00a6cef0
     * and never the game (round 14a's first run). */
    for (int i = g_win_n - 1; i >= 0; --i) {
        int c = g_win[i].cls;
        if (c >= 0 && strncmp(g_wc[c].name, "GLFW3", 5) == 0 && !strstr(g_wc[c].name, "Helper"))
            return g_win[i].hwnd;
    }
    /* fallback: the biggest window, then the last one */
    int best = -1;
    for (int i = 0; i < g_win_n; ++i)
        if (best < 0 || (uint64_t)g_win[i].w * g_win[i].h > (uint64_t)g_win[best].w * g_win[best].h) best = i;
    return best >= 0 ? g_win[best].hwnd : 0u;
}
static void msgq_push(uint32_t message, uint32_t wParam, uint32_t lParam) {
    if (g_msgq_count >= MSGQ_MAX) { ++g_input_dropped; return; }
    win_msg *m = &g_msgq[(g_msgq_head + g_msgq_count) % MSGQ_MAX];
    m->hwnd = main_hwnd(); m->message = message; m->wParam = wParam; m->lParam = lParam;
    m->time = (uint32_t)emscripten_get_now();
    m->x = (uint32_t)g_cur_x; m->y = (uint32_t)g_cur_y;
    ++g_msgq_count;
}
/* A message that must be retrieved next (the WM_CHAR TranslateMessage
 * posts: Windows serves posted messages before the remaining hardware
 * input, so the character follows its key-down at once). */
static void msgq_push_front(const win_msg *m) {
    if (g_msgq_count >= MSGQ_MAX) { ++g_input_dropped; return; }
    g_msgq_head = (g_msgq_head + MSGQ_MAX - 1u) % MSGQ_MAX;
    g_msgq[g_msgq_head] = *m;
    ++g_msgq_count;
}
/* The left/right vk a generic modifier message also sets (Windows posts
 * VK_SHIFT in wParam and lets the scancode say which one; GLFW's
 * pollEvents reads GetKeyState(VK_LSHIFT) to decide whether a Shift it
 * holds pressed was released). */
static uint32_t vk_specific(uint32_t vk, uint32_t lParam) {
    uint32_t sc = (lParam >> 16) & 0xFFu, ext = (lParam >> 24) & 1u;
    if (vk == 0x10u) return sc == 0x36u ? 0xA1u : 0xA0u;      /* VK_RSHIFT : VK_LSHIFT     */
    if (vk == 0x11u) return ext ? 0xA3u : 0xA2u;              /* VK_RCONTROL : VK_LCONTROL */
    if (vk == 0x12u) return ext ? 0xA5u : 0xA4u;              /* VK_RMENU : VK_LMENU       */
    return 0u;
}
/* The synchronous keyboard state follows the key messages as they are
 * removed from the queue. */
static void keysync_apply(uint32_t message, uint32_t vk, uint32_t lParam) {
    vk &= 0xFFu;
    uint32_t side = vk_specific(vk, lParam);
    if (message == 0x100u || message == 0x104u) {             /* WM_KEYDOWN / WM_SYSKEYDOWN */
        /* CapsLock, NumLock, ScrollLock: a fresh press (bit 30 clear) toggles */
        if ((vk == 0x14u || vk == 0x90u || vk == 0x91u) && !(lParam & (1u << 30))) g_keytoggle[vk] ^= 1u;
        g_keysync[vk] = 1u;
        if (side) g_keysync[side] = 1u;
    } else if (message == 0x101u || message == 0x105u) {      /* WM_KEYUP / WM_SYSKEYUP */
        g_keysync[vk] = 0u;
        if (side) g_keysync[side] = 0u;
    }
}
void isaac_input_key(uint32_t vk, uint32_t scancode, int extended, int down) {
    vk &= 0xFFu;
    uint32_t lp = 1u | ((scancode & 0xFFu) << 16) | (extended ? (1u << 24) : 0u);
    if (down) { if (g_keydown[vk]) lp |= 1u << 30; }
    else lp |= (1u << 30) | (1u << 31);
    g_keydown[vk] = down ? 1u : 0u;
    msgq_push(down ? 0x100u : 0x101u, vk, lp);
    ++g_input_events;
}
void isaac_input_mouse_move(int32_t x, int32_t y) {
    g_cur_x = x; g_cur_y = y;
    msgq_push(0x200u, g_mouse_mk, ((uint32_t)y << 16) | ((uint32_t)x & 0xFFFFu));
    ++g_input_events;
}
void isaac_input_mouse_button(int button, int down) {
    uint32_t bit = button ? 2u : 1u;
    if (down) g_mouse_mk |= bit; else g_mouse_mk &= ~bit;
    uint32_t message = button ? (down ? 0x204u : 0x205u) : (down ? 0x201u : 0x202u);
    msgq_push(message, g_mouse_mk, ((uint32_t)g_cur_y << 16) | ((uint32_t)g_cur_x & 0xFFFFu));
    ++g_input_events;
}
uint32_t isaac_input_queued(void) { return g_msgq_count; }
uint32_t isaac_input_dropped(void) { return g_input_dropped; }
EM_JS(int, isaac_input_poll_js, (int frame, int32_t *out), {
    if (typeof Module.isaacInputPoll !== "function") return 0;
    return Module.isaacInputPoll(frame, out) ? 1 : 0;
});
static void input_poll_page(void) {
    int32_t ev[4];
    for (unsigned n = 0; n < 64; ++n) {
        if (!isaac_input_poll_js((int)g_frames_presented, ev)) break;
        if (g_input_events < 12)
            isaac_log("[isaac][input] frame %u: scripted event [%d, %d, %d, %d]",
                      g_frames_presented, ev[0], ev[1], ev[2], ev[3]);
        switch (ev[0]) {
        case 1: isaac_input_key((uint32_t)ev[1], (uint32_t)ev[2] & 0xFFu, (ev[2] >> 8) & 1, ev[3] != 0); break;
        case 2: isaac_input_mouse_move(ev[1], ev[2]); break;
        case 3: isaac_input_mouse_button(ev[1], ev[2] != 0); break;
        default: break;
        }
    }
}
static int msgq_pop_into(uint32_t msg) {
    if (!g_msgq_count || !msg || !isaac_is_guest_va(msg + 27u)) return 0;
    win_msg *m = &g_msgq[g_msgq_head];
    g_msgq_head = (g_msgq_head + 1u) % MSGQ_MAX;
    --g_msgq_count;
    isaac_w32(msg + 0u, m->hwnd);
    isaac_w32(msg + 4u, m->message);
    isaac_w32(msg + 8u, m->wParam);
    isaac_w32(msg + 12u, m->lParam);
    isaac_w32(msg + 16u, m->time);
    isaac_w32(msg + 20u, m->x);
    isaac_w32(msg + 24u, m->y);
    keysync_apply(m->message, m->wParam, m->lParam);
    return 1;
}
/* Focus. A real window receives WM_ACTIVATEAPP, WM_ACTIVATE and WM_SETFOCUS
 * before any key; GLFW turns them into its focused state and games gate
 * input on it. Sent once, at the first pump after the window exists. */
static int g_focus_sent;
static void focus_main_window(void) {
    if (g_focus_sent || !g_win_n) return;
    g_focus_sent = 1;
    msgq_push(0x1Cu, 1u, 0u);                     /* WM_ACTIVATEAPP, activating */
    msgq_push(0x06u, 1u, 0u);                     /* WM_ACTIVATE, WA_ACTIVE     */
    msgq_push(0x07u, 0u, 0u);                     /* WM_SETFOCUS                */
}
uint32_t isaac_input_focused_hwnd(void) { return g_win_n ? main_hwnd() : 0u; }
void imp_user32__PeekMessageW(CpuState *restrict cpu) {
    uint32_t msg = isaac_arg(cpu, 0);
    (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    (void)isaac_arg(cpu, 3); (void)isaac_arg(cpu, 4);
    focus_main_window();
    input_poll_page();
    if (msgq_pop_into(msg)) { cpu->EAX = 1; return; }
    int cap = frame_cap();
    if (cap > 0 && (int)g_frames_presented >= cap && !g_quit_sent && msg &&
        isaac_is_guest_va(msg + 27u)) {
        /* MSG { HWND hwnd; UINT message; WPARAM wParam; LPARAM lParam;
         *       DWORD time; POINT pt; } -- WM_QUIT (0x12) */
        isaac_w32(msg + 0u, 0);
        isaac_w32(msg + 4u, 0x12u);
        isaac_w32(msg + 8u, 0);
        isaac_w32(msg + 12u, 0);
        isaac_w32(msg + 16u, 0);
        isaac_w32(msg + 20u, 0);
        isaac_w32(msg + 24u, 0);
        g_quit_sent = 1;
        isaac_log("[isaac][frame] ISAAC_MAX_FRAMES=%d reached after %u presented frames: "
                  "posting WM_QUIT", cap, g_frames_presented);
        cpu->EAX = 1;
        return;
    }
    cpu->EAX = 0;                       /* no messages */
}
void imp_user32__GetMessageA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;                       /* WM_QUIT: ends the pump */
}
void imp_user32__GetMessageW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;
}
void imp_user32__DispatchMessageA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
/* LRESULT DispatchMessageW(const MSG*): call the window class's WndProc as a
 * guest sub-call (stdcall: lParam, wParam, message, hwnd pushed right to
 * left, then a 0 return address; the callee's `ret 0x10` pops its arguments
 * and the dispatcher returns when EIP reaches 0). This is the same shape
 * host_shims_crt.c uses for _initterm entries. */
void imp_user32__DispatchMessageW(CpuState *restrict cpu) {
    uint32_t msg = isaac_arg(cpu, 0);
    cpu->EAX = 0;
    if (!msg || !isaac_is_guest_va(msg + 15u)) return;
    uint32_t hwnd = isaac_r32(msg), message = isaac_r32(msg + 4u),
             wParam = isaac_r32(msg + 8u), lParam = isaac_r32(msg + 12u);
    int wi = win_find_hwnd(hwnd);
    if (wi < 0 || g_win[wi].cls < 0 || !g_wc[g_win[wi].cls].wndproc) return;
    uint32_t proc = g_wc[g_win[wi].cls].wndproc;
    CpuState sub = *cpu;
    sub.ESP = (cpu->ESP - 0x400u) & ~0xFu;
    sub.ESP -= 4; isaac_w32(sub.ESP, lParam);
    sub.ESP -= 4; isaac_w32(sub.ESP, wParam);
    sub.ESP -= 4; isaac_w32(sub.ESP, message);
    sub.ESP -= 4; isaac_w32(sub.ESP, hwnd);
    sub.ESP -= 4; isaac_w32(sub.ESP, 0);
    ++g_input_dispatched;
    if (g_input_dispatched <= 8)
        isaac_log("[isaac][input] DispatchMessageW -> WndProc 0x%08x(hwnd 0x%08x, msg 0x%x, w 0x%x, l 0x%08x)",
                  proc, hwnd, message, wParam, lParam);
    isaac_guest_call(proc, &sub);
    cpu->EAX = sub.EAX;
}
uint32_t isaac_input_dispatched(void) { return g_input_dispatched; }
/* ---- TranslateMessage (round 32) ---------------------------------------- */
/* Windows turns the WM_KEYDOWN of a printable key into a WM_CHAR: the
 * character the keyboard layout gives that virtual key under the
 * synchronous modifier state, posted to the thread's queue -- and a posted
 * message is retrieved before the remaining hardware input, so the pump's
 * next PeekMessage/GetMessage is the character: the same window, wParam =
 * the character, lParam = the key-down's lParam (repeat count, scancode,
 * extended bit, previous state). GLFW's WndProc (0x00a5b7b0) hands WM_CHAR
 * and WM_SYSCHAR to _glfwInputChar (0x00a25d60), which drops codepoints
 * below 0x20 (so '\r', '\b', 0x1b and the Ctrl characters reach no callback,
 * as on Windows) and calls the char callback at window+0x2a8; the debug
 * console's (0x00686730) inserts 0x20..0x7f at its cursor while the console
 * is open (state 2). Round 30 had to recall its commands from
 * cmd_history.txt because this was a stub (§21.45).
 *
 * The map is the US layout (kbdus.c): a base, a Shift and a Ctrl column per
 * key. Letters are computed: CapsLock swaps the case Shift gives, and Ctrl
 * (Shift or not) makes 0x01..0x1a. Shift+Ctrl has no column; Ctrl+Alt
 * (AltGr) yields nothing on this layout. NumLock needs no state: a numpad
 * key arrives as VK_NUMPADn only while NumLock is on (otherwise it is
 * VK_HOME and friends), so those rows are unconditional. NOCH: no
 * character. One row per line: tests/recomp-console.test.js parses them. */
#define NOCH 0xFFFFu
typedef struct { uint16_t vk, base, shift, ctrl; } vk_char;
static const vk_char g_vk_chars[] = {
    { 0x30, '0', ')', NOCH },       /* the digit row and its shifted symbols */
    { 0x31, '1', '!', NOCH },
    { 0x32, '2', '@', 0x00 },       /* Ctrl+2 is NUL (Ctrl+@) */
    { 0x33, '3', '#', NOCH },
    { 0x34, '4', '$', NOCH },
    { 0x35, '5', '%', NOCH },
    { 0x36, '6', '^', 0x1E },       /* Ctrl+6 is RS (Ctrl+^) */
    { 0x37, '7', '&', NOCH },
    { 0x38, '8', '*', NOCH },
    { 0x39, '9', '(', NOCH },
    { 0x20, ' ', ' ', ' ' },        /* VK_SPACE */
    { 0x0D, '\r', '\r', '\n' },     /* VK_RETURN */
    { 0x08, '\b', '\b', 0x7F },     /* VK_BACK */
    { 0x09, '\t', '\t', NOCH },     /* VK_TAB */
    { 0x1B, 0x1B, 0x1B, 0x1B },     /* VK_ESCAPE */
    { 0xBA, ';', ':', NOCH },       /* VK_OEM_1 */
    { 0xBB, '=', '+', NOCH },       /* VK_OEM_PLUS */
    { 0xBC, ',', '<', NOCH },       /* VK_OEM_COMMA */
    { 0xBD, '-', '_', 0x1F },       /* VK_OEM_MINUS; Ctrl+- is US (Ctrl+_) */
    { 0xBE, '.', '>', NOCH },       /* VK_OEM_PERIOD */
    { 0xBF, '/', '?', NOCH },       /* VK_OEM_2 */
    { 0xC0, '`', '~', NOCH },       /* VK_OEM_3: the console key */
    { 0xDB, '[', '{', 0x1B },       /* VK_OEM_4 */
    { 0xDC, '\\', '|', 0x1C },      /* VK_OEM_5 */
    { 0xDD, ']', '}', 0x1D },       /* VK_OEM_6 */
    { 0xDE, '\'', '"', NOCH },      /* VK_OEM_7 */
    { 0xE2, '\\', '|', 0x1C },      /* VK_OEM_102 */
    { 0x60, '0', NOCH, NOCH },      /* VK_NUMPAD0..9 */
    { 0x61, '1', NOCH, NOCH },
    { 0x62, '2', NOCH, NOCH },
    { 0x63, '3', NOCH, NOCH },
    { 0x64, '4', NOCH, NOCH },
    { 0x65, '5', NOCH, NOCH },
    { 0x66, '6', NOCH, NOCH },
    { 0x67, '7', NOCH, NOCH },
    { 0x68, '8', NOCH, NOCH },
    { 0x69, '9', NOCH, NOCH },
    { 0x6A, '*', '*', NOCH },       /* VK_MULTIPLY */
    { 0x6B, '+', '+', NOCH },       /* VK_ADD */
    { 0x6D, '-', '-', NOCH },       /* VK_SUBTRACT */
    { 0x6E, '.', NOCH, NOCH },      /* VK_DECIMAL */
    { 0x6F, '/', '/', NOCH },       /* VK_DIVIDE */
};
static uint32_t vk_to_char(uint32_t vk) {
    int shift = g_keysync[0x10] || g_keysync[0xA0] || g_keysync[0xA1];
    int ctrl  = g_keysync[0x11] || g_keysync[0xA2] || g_keysync[0xA3];
    int alt   = g_keysync[0x12] || g_keysync[0xA4] || g_keysync[0xA5];
    if (ctrl && alt) return NOCH;                         /* AltGr: nothing on the US layout */
    if (vk >= 0x41u && vk <= 0x5Au) {                     /* A..Z */
        if (ctrl) return vk & 0x1Fu;                      /* 0x01..0x1a, Shift or not */
        int upper = shift ^ (g_keytoggle[0x14] & 1u);     /* CapsLock swaps the case */
        return upper ? vk : vk + 0x20u;
    }
    for (size_t i = 0; i < sizeof g_vk_chars / sizeof g_vk_chars[0]; ++i) {
        if (g_vk_chars[i].vk != vk) continue;
        if (ctrl) return shift ? NOCH : g_vk_chars[i].ctrl;
        return shift ? g_vk_chars[i].shift : g_vk_chars[i].base;
    }
    return NOCH;
}
/* BOOL TranslateMessage(const MSG*): nonzero for any key message whether or
 * not a character was posted, 0 for anything else (MSDN); a WM_KEYDOWN /
 * WM_SYSKEYDOWN with a character posts WM_CHAR / WM_SYSCHAR ahead of the
 * queue. The caller's MSG is read, never written. */
void imp_user32__TranslateMessage(CpuState *restrict cpu) {
    uint32_t msg = isaac_arg(cpu, 0);
    cpu->EAX = 0;
    if (!msg || !isaac_is_guest_va(msg + 27u)) return;
    uint32_t message = isaac_r32(msg + 4u);
    if (message != 0x100u && message != 0x101u && message != 0x104u && message != 0x105u) return;
    cpu->EAX = 1;
    if (message == 0x101u || message == 0x105u) return;
    uint32_t vk = isaac_r32(msg + 8u) & 0xFFu, lParam = isaac_r32(msg + 12u);
    uint32_t ch = vk_to_char(vk);
    if (ch == NOCH) return;
    win_msg m;
    m.hwnd = isaac_r32(msg);
    m.message = message == 0x104u ? 0x106u : 0x102u;
    m.wParam = ch; m.lParam = lParam;
    m.time = isaac_r32(msg + 16u); m.x = isaac_r32(msg + 20u); m.y = isaac_r32(msg + 24u);
    msgq_push_front(&m);
    ++g_chars_posted;
    if (g_chars_posted <= 48u)
        isaac_log("[isaac][input] frame %u: TranslateMessage vk 0x%02x -> %s 0x%02x%s",
                  g_frames_presented, vk, m.message == 0x106u ? "WM_SYSCHAR" : "WM_CHAR", ch,
                  (ch >= 0x20u && ch < 0x7Fu) ? "" : " (control)");
}
uint32_t isaac_input_chars_posted(void) { return g_chars_posted; }
void imp_user32__WaitMessage(CpuState *restrict cpu) {
    cpu->EAX = 0;
}
void imp_user32__GetMessageTime(CpuState *restrict cpu) {
    cpu->EAX = 0;
}
void imp_user32__PostMessageW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 1;
}
void imp_user32__SendMessageTimeoutA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    (void)isaac_arg(cpu, 4); (void)isaac_arg(cpu, 5); (void)isaac_arg(cpu, 6);
    cpu->EAX = 0;
}
void imp_user32__MsgWaitForMultipleObjects(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0x102u;                  /* WAIT_TIMEOUT */
}
void imp_user32__ChangeWindowMessageFilterEx(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 1;
}
void imp_user32__EnumWindows(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 1;                       /* nothing enumerated */
}

/* ------------------------------------------------------- misc ---------- */

void imp_user32__OpenClipboard(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__CloseClipboard(CpuState *restrict cpu) {
    cpu->EAX = 1;
}
void imp_user32__EmptyClipboard(CpuState *restrict cpu) {
    cpu->EAX = 1;
}
void imp_user32__GetClipboardData(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}
void imp_user32__SetClipboardData(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0;
}
/* Window properties: GLFW stores its window object with SetPropW(hWnd,
 * L"GLFW", window) and its WndProc reads it back with GetPropW; a 0 answer
 * makes every message fall through to DefWindowProc. Keyed by hwnd and the
 * FNV-1a hash of the wide name (an atom argument hashes its value). */
#define WIN_PROPS 64
static struct { uint32_t hwnd, key, value; int live; } g_props[WIN_PROPS];
static uint32_t prop_key(uint32_t name_va) {
    if ((name_va & 0xFFFF0000u) == 0) return name_va;          /* atom */
    uint32_t h = 2166136261u;
    for (unsigned i = 0; i < 128 && isaac_is_guest_va(name_va + 2u * i); ++i) {
        uint16_t c = isaac_r16(name_va + 2u * i);
        if (!c) break;
        h ^= c; h *= 16777619u;
    }
    return h;
}
void imp_user32__SetPropW(CpuState *restrict cpu) {
    uint32_t hwnd = isaac_arg(cpu, 0), key = prop_key(isaac_arg(cpu, 1)), value = isaac_arg(cpu, 2);
    int free_slot = -1;
    for (int i = 0; i < WIN_PROPS; ++i) {
        if (g_props[i].live && g_props[i].hwnd == hwnd && g_props[i].key == key) { g_props[i].value = value; cpu->EAX = 1; return; }
        if (!g_props[i].live && free_slot < 0) free_slot = i;
    }
    if (free_slot < 0) { cpu->EAX = 0; return; }
    g_props[free_slot].hwnd = hwnd; g_props[free_slot].key = key;
    g_props[free_slot].value = value; g_props[free_slot].live = 1;
    cpu->EAX = 1;
}
void imp_user32__GetPropW(CpuState *restrict cpu) {
    uint32_t hwnd = isaac_arg(cpu, 0), key = prop_key(isaac_arg(cpu, 1));
    cpu->EAX = 0;
    for (int i = 0; i < WIN_PROPS; ++i)
        if (g_props[i].live && g_props[i].hwnd == hwnd && g_props[i].key == key) { cpu->EAX = g_props[i].value; return; }
}
void imp_user32__RemovePropW(CpuState *restrict cpu) {
    uint32_t hwnd = isaac_arg(cpu, 0), key = prop_key(isaac_arg(cpu, 1));
    cpu->EAX = 0;
    for (int i = 0; i < WIN_PROPS; ++i)
        if (g_props[i].live && g_props[i].hwnd == hwnd && g_props[i].key == key) {
            cpu->EAX = g_props[i].value; g_props[i].live = 0; return;
        }
}
void imp_user32__TrackMouseEvent(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__SystemParametersInfoW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;
}
void imp_user32__RegisterDeviceNotificationA(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 1;
}
void imp_user32__RegisterDeviceNotificationW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1); (void)isaac_arg(cpu, 2);
    cpu->EAX = 1;
}
void imp_user32__UnregisterDeviceNotification(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__LoadImageW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    (void)isaac_arg(cpu, 4); (void)isaac_arg(cpu, 5);
    cpu->EAX = 0x10001u;                /* image token */
}
void imp_user32__CreateIconIndirect(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0x10001u;
}
void imp_user32__DestroyIcon(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}
void imp_user32__LoadCursorW(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0x10001u;                /* cursor token */
}
void imp_user32__SetRect(CpuState *restrict cpu) {
    uint32_t r = isaac_arg(cpu, 0);
    if (isaac_is_guest_va(r)) {
        isaac_w32(r + 0, isaac_arg(cpu, 1));
        isaac_w32(r + 4, isaac_arg(cpu, 2));
        isaac_w32(r + 8, isaac_arg(cpu, 3));
        isaac_w32(r + 12, isaac_arg(cpu, 4));
    }
    cpu->EAX = 1;
}
void imp_user32__OffsetRect(CpuState *restrict cpu) {
    uint32_t r = isaac_arg(cpu, 0);
    int32_t dx = (int32_t)isaac_arg(cpu, 1), dy = (int32_t)isaac_arg(cpu, 2);
    if (isaac_is_guest_va(r)) {
        isaac_w32(r + 0, isaac_r32(r + 0) + (uint32_t)dx);
        isaac_w32(r + 4, isaac_r32(r + 4) + (uint32_t)dy);
        isaac_w32(r + 8, isaac_r32(r + 8) + (uint32_t)dx);
        isaac_w32(r + 12, isaac_r32(r + 12) + (uint32_t)dy);
    }
    cpu->EAX = 1;
}
void imp_user32__PtInRect(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2);
    cpu->EAX = 0;
}
