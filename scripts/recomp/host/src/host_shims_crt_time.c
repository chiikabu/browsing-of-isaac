/* host_shims_crt_time.c -- api-ms-win-crt-time-l1-1-0.dll shims.
 *
 * Rows: _time64 (5 sites), _gmtime64 (9), _mkgmtime64 (5), _localtime64 (1),
 * strftime (1) -- all PROVIDED verdicts with weak stubs; a real call traps
 * (measured run 23: _time64 from the rep+ version banner path).
 *
 * The guest's int64_t is 64-bit: returns come back in EDX:EAX and the
 * optional out-pointer is an 8-byte guest write.  gmtime/localtime use the
 * CRT's static struct tm; the host's own static buffer sits above the guest
 * limit (host static data), so each gets a fixed guest-scratch buffer in the
 * 0x0e00dxxx band instead (DI8/steam fakes already live there).  struct tm is
 * 9 ints -- same layout on the x86 guest and the musl host.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CRT_TM_LOCAL_VA  (ISAAC_TEB_VA + 0xd800u)
#define CRT_TM_GM_VA     (ISAAC_TEB_VA + 0xd840u)

/* struct tm layout: 9 x int32, end to end.  Host musl's struct tm matches. */
#define TM_FIELDS 9

static void tm_to_guest(uint32_t dst, const struct tm *tm) {
    const int v[TM_FIELDS] = {
        tm->tm_sec, tm->tm_min, tm->tm_hour, tm->tm_mday, tm->tm_mon,
        tm->tm_year, tm->tm_wday, tm->tm_yday, tm->tm_isdst,
    };
    for (unsigned i = 0; i < TM_FIELDS; ++i)
        isaac_w32(dst + 4u * i, (uint32_t)v[i]);
}

static void tm_from_guest(const uint32_t src, struct tm *tm) {
    int v[TM_FIELDS];
    for (unsigned i = 0; i < TM_FIELDS; ++i)
        v[i] = (int)isaac_r32(src + 4u * i);
    memset(tm, 0, sizeof *tm);
    tm->tm_sec = v[0];  tm->tm_min = v[1];  tm->tm_hour = v[2];
    tm->tm_mday = v[3]; tm->tm_mon = v[4];  tm->tm_year = v[5];
    tm->tm_wday = v[6]; tm->tm_yday = v[7]; tm->tm_isdst = v[8];
}

/* ISAAC_EPOCH=<unix seconds>: a fixed wall clock for reproducible runs. The
 * engine seeds its run RNG from the time of day, so without it every run is
 * a different floor and a floor-dependent defect (round 24: the start-room
 * ping-pong) cannot be replayed. -1 = not set. */
int64_t isaac_epoch_override(void) {
    static int64_t v = -2;
    if (v == -2) {
        const char *e = getenv("ISAAC_EPOCH");
        v = (e && *e) ? (int64_t)strtoll(e, NULL, 10) : -1;
        if (v >= 0) isaac_log("[isaac][crt] ISAAC_EPOCH=%lld: the wall clock is pinned", (long long)v);
    }
    return v;
}

/* int64_t _time64(int64_t *t) -- return in EDX:EAX, optional out. */
void imp_api_ms_win_crt_time___time64(CpuState *restrict cpu) {
    int64_t ov = isaac_epoch_override();
    int64_t now = ov >= 0 ? ov : (int64_t)time(NULL);
    uint32_t out = isaac_arg(cpu, 0);
    if (out && isaac_is_guest_va(out) &&
        isaac_is_guest_va(out + 7)) {
        isaac_w32(out, (uint32_t)now);
        isaac_w32(out + 4, (uint32_t)((uint64_t)now >> 32));
    }
    cpu->EAX = (uint32_t)now;
    cpu->EDX = (uint32_t)((uint64_t)now >> 32);
}

static void localtime64_impl(CpuState *restrict cpu, uint32_t out_va,
                             int use_utc) {
    /* arg0 = const int64_t* */
    uint32_t p = isaac_arg(cpu, 0);
    int64_t t = 0;
    if (p && isaac_is_guest_va(p) && isaac_is_guest_va(p + 7)) {
        t = (int64_t)isaac_r32(p) |
            ((int64_t)isaac_r32(p + 4) << 32);
    }
    struct tm tm;
    memset(&tm, 0, sizeof tm);
    if (use_utc)
        gmtime_r((const time_t *)&t, &tm);
    else
        localtime_r((const time_t *)&t, &tm);
    tm_to_guest(out_va, &tm);
    cpu->EAX = out_va;
}

/* struct tm *_localtime64(const int64_t *t) */
void imp_api_ms_win_crt_time___localtime64(CpuState *restrict cpu) {
    localtime64_impl(cpu, CRT_TM_LOCAL_VA, 0);
}

/* struct tm *_gmtime64(const int64_t *t) */
void imp_api_ms_win_crt_time___gmtime64(CpuState *restrict cpu) {
    localtime64_impl(cpu, CRT_TM_GM_VA, 1);
}

/* int64_t _mkgmtime64(struct tm *tm) -- EDX:EAX. */
void imp_api_ms_win_crt_time___mkgmtime64(CpuState *restrict cpu) {
    uint32_t p = isaac_arg(cpu, 0);
    struct tm tm;
    memset(&tm, 0, sizeof tm);
    if (p && isaac_is_guest_va(p)) tm_from_guest(p, &tm);
    int64_t out = (int64_t)timegm(&tm);   /* UTC, like _mkgmtime */
    cpu->EAX = (uint32_t)out;
    cpu->EDX = (uint32_t)((uint64_t)out >> 32);
}

/* size_t strftime(char *buf, size_t max, const char *fmt, const struct tm*) */
void imp_api_ms_win_crt_time__strftime(CpuState *restrict cpu) {
    uint32_t buf = isaac_arg(cpu, 0);
    size_t max = (size_t)isaac_arg(cpu, 1);
    char fmt[256];
    isaac_guest_cstr(isaac_arg(cpu, 2), fmt, sizeof fmt, "strftime fmt");
    uint32_t tmv = isaac_arg(cpu, 3);
    struct tm tm;
    memset(&tm, 0, sizeof tm);
    if (tmv && isaac_is_guest_va(tmv)) tm_from_guest(tmv, &tm);
    if (!buf || !isaac_is_guest_va(buf) ||
        !isaac_is_guest_va(buf + (uint32_t)max - 1)) {
        isaac_log("[isaac][time] strftime: output 0x%08x+%u crosses the guest "
                  "limit -- refusing", buf, (unsigned)max);
        cpu->EAX = 0;
        return;
    }
    char tmp[512];
    size_t n = strftime(tmp, sizeof tmp, fmt[0] ? fmt : "%c", &tm);
    if (n + 1 > max) n = 0;
    else if (n) memcpy(isaac_g(buf), tmp, n + 1);
    cpu->EAX = (uint32_t)n;
}
