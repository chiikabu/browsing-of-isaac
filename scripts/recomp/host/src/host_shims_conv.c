/* host_shims_conv.c -- guest wide-character conversions.
 *
 * The guest is a Windows 32-bit build: "wide" means UTF-16LE. Emscripten's
 * host wchar_t is 32-bit, so everything here is a hand-rolled UTF-8 <-> UTF-16
 * codec with explicit guest writes. ASCII is the overwhelming common case and
 * falls through fast paths; invalid sequences are replaced with U+FFFD.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <string.h>

/* ---- UTF-8 decode: returns codepoint, advances *p over 1-4 bytes --------- */
static uint32_t utf8_get(const uint8_t *s, size_t n, size_t *i) {
    uint8_t c = s[*i];
    if (c < 0x80) { ++*i; return c; }
    uint32_t cp = 0xFFFDu;                    /* replacement char default */
    size_t need = 0;
    if ((c & 0xE0) == 0xC0)      { cp = c & 0x1Fu; need = 1; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0Fu; need = 2; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07u; need = 3; }
    else { ++*i; return 0xFFFDu; }
    if (*i + need >= n) { ++*i; return 0xFFFDu; }
    for (size_t k = 1; k <= need; ++k) {
        uint8_t t = s[*i + k];
        if ((t & 0xC0) != 0x80) { ++*i; return 0xFFFDu; }
        cp = (cp << 6) | (t & 0x3Fu);
    }
    *i += need + 1;
    return cp;
}

/* UTF-8 -> UTF-16 into guest memory; returns count of u16 units (excluding
 * the terminator), or (size_t)-1 on a capacity error. Writes the terminator
 * when dst != 0. */
static size_t guest_utf8_to_utf16(uint32_t dst, size_t dst_cap,
                                  const uint8_t *src, size_t src_n,
                                  int terminate) {
    size_t i = 0, out = 0;
    while (i < src_n && src[i]) {
        uint32_t cp = utf8_get(src, src_n, &i);
        if (cp >= 0x10000) {
            if (dst && out + 2 >= dst_cap) return (size_t)-1;
            cp -= 0x10000;
            if (dst) {
                isaac_w16(dst + out * 2, 0xD800u + (cp >> 10));
                isaac_w16(dst + out * 2 + 2, 0xDC00u + (cp & 0x3FFu));
            }
            out += 2;
        } else {
            if (dst && out + 1 >= dst_cap) return (size_t)-1;
            if (dst) isaac_w16(dst + out * 2, (uint16_t)cp);
            ++out;
        }
    }
    if (dst && terminate) {
        if (out + 1 > dst_cap) return (size_t)-1;
        isaac_w16(dst + out * 2, 0);
    }
    return out;
}

/* UTF-16 -> UTF-8 into guest memory; returns bytes written (excluding
 * terminator) or (size_t)-1. */
static size_t guest_utf16_to_utf8(const uint16_t *src, size_t src_n,
                                  uint32_t dst, size_t dst_cap) {
    size_t i = 0, out = 0;
    while (i < src_n && src[i]) {
        uint32_t cp = src[i++];
        if (cp >= 0xD800 && cp <= 0xDBFF && i < src_n &&
            src[i] >= 0xDC00 && src[i] <= 0xDFFF) {
            cp = 0x10000u + ((cp - 0xD800u) << 10) + (src[i++] - 0xDC00u);
        }
        uint8_t b[4]; size_t nb;
        if (cp < 0x80)            { b[0] = (uint8_t)cp; nb = 1; }
        else if (cp < 0x800)      { b[0] = 0xC0u | (cp >> 6);  b[1] = 0x80u | (cp & 0x3F); nb = 2; }
        else if (cp < 0x10000)    { b[0] = 0xE0u | (cp >> 12); b[1] = 0x80u | ((cp >> 6) & 0x3F); b[2] = 0x80u | (cp & 0x3F); nb = 3; }
        else                      { b[0] = 0xF0u | (cp >> 18); b[1] = 0x80u | ((cp >> 12) & 0x3F); b[2] = 0x80u | ((cp >> 6) & 0x3F); b[3] = 0x80u | (cp & 0x3F); nb = 4; }
        if (dst && out + nb + 1 > dst_cap) return (size_t)-1;
        if (dst) memcpy(isaac_g(dst + out), b, nb);
        out += nb;
    }
    if (dst && out + 1 > dst_cap) return (size_t)-1;
    if (dst) *(uint8_t *)isaac_g(dst + out) = 0;
    return out;
}

/* ---------- api-ms-win-crt-convert: mbstowcs_s -------------------------- */
/* errno_t mbstowcs_s(size_t *pReturnValue, wchar_t *dst, size_t dstCap,
 *                    const char *src, size_t len)                        */
void imp_api_ms_win_crt_convert__mbstowcs_s(CpuState *restrict cpu) {
    uint32_t pret = isaac_arg(cpu, 0), dst = isaac_arg(cpu, 1);
    uint32_t dstcap = isaac_arg(cpu, 2), src = isaac_arg(cpu, 3);
    uint32_t len = isaac_arg(cpu, 4);
    if (!src) { if (pret) isaac_w32(pret, 0); cpu->EAX = 22; return; } /* EINVAL */
    uint8_t buf[512];
    size_t read_n = 0;
    while (read_n + 1 < sizeof buf && read_n < len &&
           isaac_is_guest_va(src + (uint32_t)read_n)) {
        uint8_t c = isaac_r8(src + (uint32_t)read_n);
        buf[read_n] = c;
        ++read_n;
        if (!c) break;
    }
    buf[read_n < sizeof buf ? read_n : sizeof buf - 1] = 0;
    size_t units = guest_utf8_to_utf16(dst, dstcap, buf, read_n + 1, 1);
    if (units == (size_t)-1) { cpu->EAX = 34; return; }   /* ERANGE */
    if (pret) isaac_w32(pret, (uint32_t)(units + 1));
    cpu->EAX = 0;
}

/* ---------- api-ms-win-crt-convert: wcstombs_s -------------------------- */
/* errno_t wcstombs_s(size_t *pReturnValue, char *dst, size_t dstCapBytes,
 *                    const wchar_t *src, size_t count)
 * The inverse of mbstowcs_s. KAGE's readdir (0x00a172e0) brings every
 * FindFirstFileW/FindNextFileW cFileName back through it and stores
 * *pReturnValue - 1 as the entry's name length, so pReturnValue counts the
 * terminator (MS semantics). The call-site census listed this import as
 * never called: the scan that uses it never ran while FindFirstFileW was a
 * stub. count == _TRUNCATE (-1) is the common form. */
void imp_api_ms_win_crt_convert__wcstombs_s(CpuState *restrict cpu) {
    uint32_t pret = isaac_arg(cpu, 0), dst = isaac_arg(cpu, 1);
    uint32_t dstcap = isaac_arg(cpu, 2), src = isaac_arg(cpu, 3);
    uint32_t count = isaac_arg(cpu, 4);
    if (!src) { if (pret) isaac_w32(pret, 0); cpu->EAX = 22; return; } /* EINVAL */
    uint16_t wbuf[512];
    size_t n = 0;
    while (n + 1 < sizeof wbuf / sizeof wbuf[0] && n < count &&
           isaac_is_guest_va(src + (uint32_t)n * 2 + 1)) {
        wbuf[n] = (uint16_t)isaac_r16(src + (uint32_t)n * 2);
        if (!wbuf[n]) break;
        ++n;
    }
    wbuf[n] = 0;
    size_t bytes = guest_utf16_to_utf8(wbuf, n, dst, dstcap);
    if (bytes == (size_t)-1) {                              /* ERANGE */
        if (dst && dstcap) *(uint8_t *)isaac_g(dst) = 0;
        if (pret) isaac_w32(pret, 0);
        cpu->EAX = 34;
        return;
    }
    if (pret) isaac_w32(pret, (uint32_t)(bytes + 1));
    cpu->EAX = 0;
}

/* ---------- kernel32 wide conversions ---------------------------------- */
/* int MultiByteToWideChar(UINT cp, DWORD flags, LPCSTR mb, int mbLen,
 *                         LPWSTR wc, int wcCap)                          */
void imp_kernel32__MultiByteToWideChar(CpuState *restrict cpu) {
    uint32_t cp = isaac_arg(cpu, 0);
    (void)cp;                                   /* treat every cp as UTF-8 */
    uint32_t mb = isaac_arg(cpu, 2), mbLen = isaac_arg(cpu, 3);
    uint32_t wc = isaac_arg(cpu, 4), wcCap = isaac_arg(cpu, 5);
    uint8_t buf[512];
    size_t read_n = 0;
    size_t limit = ((int32_t)mbLen < 0 || mbLen > 512) ? 512 : (size_t)mbLen;
    if (mbLen == 0xFFFFFFFFu) {                  /* -1: read to terminator */
        while (read_n + 1 < sizeof buf && isaac_is_guest_va(mb + (uint32_t)read_n)) {
            uint8_t c = isaac_r8(mb + (uint32_t)read_n);
            buf[read_n] = c;
            ++read_n;
            if (!c) break;
        }
    } else {
        while (read_n < limit && isaac_is_guest_va(mb + (uint32_t)read_n)) {
            buf[read_n] = isaac_r8(mb + (uint32_t)read_n);
            ++read_n;
        }
    }
    size_t units = guest_utf8_to_utf16(wc, (size_t)((int32_t)wcCap < 0 ? 0 : wcCap),
                                       buf, read_n, 1);
    if (units == (size_t)-1) { cpu->EAX = 0; return; }
    cpu->EAX = (uint32_t)(units + (mbLen == 0xFFFFFFFFu ? 1 : 0));
}

/* int WideCharToMultiByte(UINT cp, DWORD flags, LPCWCH wc, int wcLen,
 *                         LPSTR mb, int mbCap, LPCSTR def, LPBOOL used)  */
void imp_kernel32__WideCharToMultiByte(CpuState *restrict cpu) {
    uint32_t wc = isaac_arg(cpu, 2), wcLen = isaac_arg(cpu, 3);
    uint32_t mb = isaac_arg(cpu, 4), mbCap = isaac_arg(cpu, 5);
    uint16_t wbuf[256];
    size_t n = 0;
    size_t limit = ((int32_t)wcLen < 0 || wcLen > 256) ? 256 : (size_t)wcLen;
    if (wcLen == 0xFFFFFFFFu) {
        while (n + 1 < 256 && isaac_is_guest_va(wc + n * 2)) {
            wbuf[n] = (uint16_t)isaac_r16(wc + n * 2);
            ++n;
            if (!wbuf[n - 1]) break;
        }
    } else {
        while (n < limit && isaac_is_guest_va(wc + n * 2)) {
            wbuf[n] = (uint16_t)isaac_r16(wc + n * 2);
            ++n;
        }
    }
    size_t bytes = guest_utf16_to_utf8(wbuf, n, mb,
                                       (size_t)((int32_t)mbCap < 0 ? 0 : mbCap));
    if (bytes == (size_t)-1) { cpu->EAX = 0; return; }
    cpu->EAX = (uint32_t)(bytes + (wcLen == 0xFFFFFFFFu ? 1 : 0));
}

/* DWORD GetFullPathNameW(LPCWSTR name, DWORD nBufferLength, LPWSTR buffer,
 *                        LPWSTR *lpFilePart) -- stdcall 16.               */
void imp_kernel32__GetFullPathNameW(CpuState *restrict cpu) {
    uint32_t name = isaac_arg(cpu, 0), nbuf = isaac_arg(cpu, 1);
    uint32_t buf = isaac_arg(cpu, 2), part = isaac_arg(cpu, 3);
    uint16_t wbuf[512];
    size_t n = 0;
    while (n + 1 < 512 && isaac_is_guest_va(name + (uint32_t)n * 2)) {
        wbuf[n] = (uint16_t)isaac_r16(name + (uint32_t)n * 2);
        if (!wbuf[n]) break;
        ++n;
    }
    wbuf[n] = 0;
    /* utf16 -> host utf8 */
    char host[1024];
    size_t hn = 0;
    for (size_t i = 0; i < n && hn + 4 < sizeof host; ++i) {
        uint32_t cp = wbuf[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n &&
            wbuf[i + 1] >= 0xDC00 && wbuf[i + 1] <= 0xDFFF) {
            cp = 0x10000u + ((cp - 0xD800u) << 10) + (wbuf[++i] - 0xDC00u);
        }
        if (cp < 0x80) host[hn++] = (char)cp;
        else if (cp < 0x800) {
            host[hn++] = (char)(0xC0u | (cp >> 6));
            host[hn++] = (char)(0x80u | (cp & 0x3Fu));
        } else if (cp < 0x10000) {
            host[hn++] = (char)(0xE0u | (cp >> 12));
            host[hn++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
            host[hn++] = (char)(0x80u | (cp & 0x3Fu));
        } else {
            host[hn++] = (char)(0xF0u | (cp >> 18));
            host[hn++] = (char)(0x80u | ((cp >> 12) & 0x3Fu));
            host[hn++] = (char)(0x80u | ((cp >> 6) & 0x3Fu));
            host[hn++] = (char)(0x80u | (cp & 0x3Fu));
        }
    }
    host[hn] = 0;
    /* resolve against the virtual cwd when relative */
    char out[1024];
    size_t on = 0;
    int absolute = (hn >= 2 && host[1] == ':') || (hn && host[0] == '/');
    if (!absolute) {
        static const char cwd[] = "c:/isaac/";
        memcpy(out, cwd, sizeof cwd - 1);
        on = sizeof cwd - 1;
    }
    if (hn < sizeof out - on) { memcpy(out + on, host, hn); on += hn; }
    out[on] = 0;
    size_t want = 0;
    {
        /* count u16 units */
        const char *p = out; uint32_t cp;
        while (*p) {
            uint8_t c = (uint8_t)*p;
            if (c < 0x80) { cp = c; ++p; }
            else if ((c & 0xE0) == 0xC0) { cp = ((uint32_t)(c & 0x1F) << 6) | (p[1] & 0x3F); p += 2; }
            else if ((c & 0xF0) == 0xE0) { cp = ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)(p[1] & 0x3F) << 6) | (p[2] & 0x3F); p += 3; }
            else { cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(p[1] & 0x3F) << 12) | ((uint32_t)(p[2] & 0x3F) << 6) | (p[3] & 0x3F); p += 4; }
            want += (cp >= 0x10000) ? 2 : 1;
        }
    }
    /* Size query / too-small buffer: Win32 returns the REQUIRED size in
     * WCHARs INCLUDING the terminator and writes nothing. KAGE's opendir
     * (0x00a16f50) relies on exactly this two-call protocol --
     * GetFullPathNameW(name, 0, NULL, NULL) -> malloc(n*2+0x10) ->
     * GetFullPathNameW(name, n, buf, NULL) -> append "\*" -> FindFirstFileW.
     * Returning 0 here (the old behaviour) made the second call see n == 0,
     * fail with errno 2, and the mount-root scan never reached FindFirstFileW
     * at all (boot round 10). */
    if (!buf || nbuf < want + 1) { cpu->EAX = (uint32_t)(want + 1); return; }
    uint32_t filepart_off = 0;
    for (size_t k = 0; k < on; ++k) if (out[k] == '/') filepart_off = (uint32_t)k + 1;
    guest_utf8_to_utf16(buf, nbuf, (const uint8_t *)out, on + 1, 1);
    if (part) isaac_w32(part, buf + (want ? filepart_off * 2 : 0));
    cpu->EAX = (uint32_t)want;
}

/* DWORD FormatMessageW(DWORD flags, LPCVOID src, DWORD msgId, DWORD langId,
 *                      LPWSTR buf, DWORD size, va_list *args) -- stdcall 28.
 * Used by the Steam layer to decorate its init failure. When
 * FORMAT_MESSAGE_ALLOCATE_BUFFER is set, *buf receives a guest allocation
 * the caller frees with LocalFree. */
void imp_kernel32__FormatMessageW(CpuState *restrict cpu) {
    uint32_t flags = isaac_arg(cpu, 0), msgid = isaac_arg(cpu, 2);
    uint32_t buf = isaac_arg(cpu, 4), size = isaac_arg(cpu, 5);
    uint32_t args = isaac_arg(cpu, 6);
    (void)msgid; (void)size; (void)args;
    static const char msg[] = "Operation failed.";
    size_t n = sizeof msg - 1;
    if (flags & 0x00000200u) {                  /* ALLOCATE_BUFFER */
        uint32_t nb = isaac_guest_alloc((uint32_t)((n + 1) * 2));
        if (!nb) { cpu->EAX = 0; return; }
        guest_utf8_to_utf16(nb, (uint32_t)(n + 1), (const uint8_t *)msg, n, 1);
        isaac_w32(buf, nb);
        cpu->EAX = (uint32_t)n;
        return;
    }
    if (!buf) { cpu->EAX = 0; return; }
    if (size < 2) { cpu->EAX = 0; return; }
    guest_utf8_to_utf16(buf, size, (const uint8_t *)msg, n, 1);
    cpu->EAX = (uint32_t)n;
}
