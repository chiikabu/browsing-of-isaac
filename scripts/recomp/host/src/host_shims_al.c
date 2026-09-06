/* host_shims_al.c -- strong implementations for the OpenAL surface.
 *
 * Reachability: the game's audio engine (0x00a7d2a0 init / 0x00a7d5f8+ dtor /
 * 0x00a7d960 slot poller / 0x00a7dac0+ vtable family) calls the 26-name
 * surface through the static IAT (0x00b18504..0x00b18570). All rows are
 * cdecl (the guest cleans its own pushes), so these bodies never purge.
 *
 * Round 16: the AL object calls are no longer benign constants. Buffers,
 * sources, their state and their queues live in host_audio.c, which times
 * playback on the wall clock so a source stops when its sound would have
 * finished and a streaming source reports buffers as processed -- without
 * that the music path had nothing to unqueue and the slot poller reused one
 * slot forever. The ALC half below is unchanged: device and context are still
 * tokens, because there is nothing per-device to model.
 *
 * Policy for the ALC half (headless native port): benign answers chosen so
 * init succeeds:
 *   alcOpenDevice(NULL)          -> fake device token (init stores it at
 *                                   [eng+0x38], NULL would be the error path)
 *   alcCreateContext(dev, attr)  -> fake context token ([eng+0x34])
 *   alcMakeContextCurrent(ctx)   -> 1  (init gates on `test al,al`)
 *   alcProcessContext(ctx)       -> no-op
 *   alcGetString(dev, 0x1006)    -> "" (ALC_EXTENSIONS; logged with %s)
 *   alcIsExtensionPresent        -> 0  (feature probes fall back)
 *   alGetError()                 -> 0  (the engine logs errors; stay clean)
 *   alGetString(0xB001/2/3)      -> vendor/renderer/version scratch strings
 *   alGenSources/alGenBuffers    -> fake object tokens written into guest
 *   alGetSourcei(...,0x1010,out) -> *out = AL_INITIAL (slot poller reuses
 *                                   the first slot instead of treating
 *                                   everything as playing)
 *   everything else              -> no-op
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <string.h>
#include <stdio.h>

/* Guest-visible scratch for the AL string answers. 0x0e006000 holds the GL
 * version string; module tokens start at 0x0e010000. 0x0e006100..0x0e006180
 * sits between, below ISAAC_GUEST_LIMIT_VA, written by the host only. */
#define AL_SCRATCH_VA (ISAAC_TEB_VA + 0x6100u)
static uint32_t g_alc_device;

/* A float argument arrives as its raw IEEE bits in a stack slot. */
static float al_bits2f(uint32_t b) { float f; memcpy(&f, &b, 4); return f; }
static uint32_t al_f2bits(float f) { uint32_t b; memcpy(&b, &f, 4); return b; }

/* host_audio.c: the object model, its timing and the backend hooks. */
void isaac_audio_gen_sources(uint32_t n, uint32_t out_va);
void isaac_audio_gen_buffers(uint32_t n, uint32_t out_va);
void isaac_audio_delete_sources(uint32_t n, uint32_t va);
void isaac_audio_delete_buffers(uint32_t n, uint32_t va);
void isaac_audio_buffer_data(uint32_t buf, uint32_t format, uint32_t data_va,
                             uint32_t bytes, uint32_t freq);
void isaac_audio_source_i(uint32_t src, uint32_t param, int32_t value);
void isaac_audio_source_f(uint32_t src, uint32_t param, float value);
int32_t isaac_audio_get_source_i(uint32_t src, uint32_t param);
float isaac_audio_get_source_f(uint32_t src, uint32_t param);
void isaac_audio_play(uint32_t src);
void isaac_audio_stop(uint32_t src);
void isaac_audio_pause(uint32_t src);
void isaac_audio_queue(uint32_t src, uint32_t n, uint32_t bufs_va);
uint32_t isaac_audio_unqueue(uint32_t src, uint32_t n, uint32_t out_va);

static void al_log_once(const char *name, const char *args) {
    static const char *seen[128];
    static unsigned nseen = 0;
    for (unsigned i = 0; i < nseen; ++i)
        if (seen[i] == name) return;
    if (nseen < 128) seen[nseen++] = name;
    fprintf(stderr, "[al] %s(%s)\n", name, args);
}

/* Per-name call census. The one-shot log below says which names were reached
 * first; this says how many times each was called, which is what tells a
 * silent run apart from one whose audio path stops after context creation
 * (round 16: the game logged "Preload sound 0." and never generated a
 * source). Printed by isaac_audio_report(). */
static const char *g_al_names[40];
static uint32_t g_al_hits[40];
static unsigned g_al_n;
static void al_hit(const char *name) {
    for (unsigned i = 0; i < g_al_n; ++i)
        if (g_al_names[i] == name) { ++g_al_hits[i]; return; }
    if (g_al_n < 40) { g_al_names[g_al_n] = name; g_al_hits[g_al_n++] = 1u; }
}
void isaac_al_census(void) {
    if (!g_al_n) { isaac_log("[isaac][al] no openal32 entry point was ever called."); return; }
    isaac_log("[isaac][al] ---- openal32 calls (%u distinct names) ----", g_al_n);
    for (unsigned i = 0; i < g_al_n; ++i)
        isaac_log("[isaac][al]   %9u x %s", g_al_hits[i], g_al_names[i]);
}

static uint32_t al_next_token(void) {
    static uint32_t n = 0x7788c000u;
    return n += 0x10u;
}

/* ALCdevice *alcOpenDevice(const ALCchar *devicename) */
void imp_openal32__alcOpenDevice(CpuState *restrict cpu) {
    al_hit("alcOpenDevice");
    uint32_t name = isaac_arg(cpu, 0);
    if (isaac_is_guest_va(name)) {
        char buf[64];
        size_t n = 0;
        const char *q = (const char *)isaac_g(name);
        while (n + 1 < sizeof buf && q[n]) { buf[n] = q[n]; ++n; }
        buf[n] = 0;
        al_log_once("alcOpenDevice", buf);
    } else {
        al_log_once("alcOpenDevice", "NULL");
    }
    cpu->EAX = al_next_token();
    g_alc_device = cpu->EAX;
}

/* ALCcontext *alcCreateContext(ALCdevice *device, const ALCint *attrlist) */
void imp_openal32__alcCreateContext(CpuState *restrict cpu) {
    al_hit("alcCreateContext");
    al_log_once("alcCreateContext", "dev, attrlist");
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = al_next_token();
}

/* ALCboolean alcMakeContextCurrent(ALCcontext *ctx) */
void imp_openal32__alcMakeContextCurrent(CpuState *restrict cpu) {
    al_hit("alcMakeContextCurrent");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}

/* void alcProcessContext(ALCcontext *ctx) */
void imp_openal32__alcProcessContext(CpuState *restrict cpu) {
    al_hit("alcProcessContext");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}

/* void alcDestroyContext(ALCcontext *ctx) */
void imp_openal32__alcDestroyContext(CpuState *restrict cpu) {
    al_hit("alcDestroyContext");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}

/* ALCboolean alcCloseDevice(ALCdevice *device) */
void imp_openal32__alcCloseDevice(CpuState *restrict cpu) {
    al_hit("alcCloseDevice");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;
}

/* const ALCchar *alcGetString(ALCdevice *device, ALCenum param) */
void imp_openal32__alcGetString(CpuState *restrict cpu) {
    al_hit("alcGetString");
    uint32_t param = isaac_arg(cpu, 1);
    if (param == 0x1006u) {            /* ALC_EXTENSIONS: empty string */
        memcpy(isaac_g(AL_SCRATCH_VA), "", 1);
        cpu->EAX = AL_SCRATCH_VA;
        return;
    }
    cpu->EAX = 0;
}

/* ALCboolean alcIsExtensionPresent(ALCdevice *device, const ALCchar *ext) */
void imp_openal32__alcIsExtensionPresent(CpuState *restrict cpu) {
    al_hit("alcIsExtensionPresent");
    uint32_t ext = isaac_arg(cpu, 1);
    if (isaac_is_guest_va(ext)) {
        char buf[64];
        size_t n = 0;
        const char *q = (const char *)isaac_g(ext);
        while (n + 1 < sizeof buf && q[n]) { buf[n] = q[n]; ++n; }
        buf[n] = 0;
        al_log_once("alcIsExtensionPresent", buf);
    }
    /* ALC_SOFT_system_events is provided (round 22): its event callback is
     * what sets the engine's audio-manager drain flag. Everything else still
     * falls back. */
    if (isaac_is_guest_va(ext)) {
        const char *q = (const char *)isaac_g(ext);
        if (!strncmp(q, "ALC_SOFT_system_events", 23)) { cpu->EAX = 1; return; }
    }
    cpu->EAX = 0;                     /* no other extensions: engine falls back */
}

/* void *alcGetProcAddress(const ALCchar *funcname) -- never statically
 * called by the game (census: 0 sites); defined for completeness. */
void imp_openal32__alcGetProcAddress(CpuState *restrict cpu) {
    al_hit("alcGetProcAddress");
    /* Round 22: which extension entry points the game wants. The queued
     * sounds are drained by a handler gated on a byte that only the
     * ALC_SOFT_system_events callback sets, and this is where the game would
     * fetch the functions to register it. */
    uint32_t name = isaac_arg(cpu, 1);
    uint32_t addr = 0;
    if (isaac_is_guest_va(name)) {
        char buf[64];
        size_t n = 0;
        const char *q = (const char *)isaac_g(name);
        while (n + 1 < sizeof buf && q[n]) { buf[n] = q[n]; ++n; }
        buf[n] = 0;
        /* the same resolver the module layer uses for wglGetProcAddress: a
         * shim token the guest can call through recomp_call_indirect */
        /* the shim token for that name: the same value GetProcAddress
         * hands back for a dynamically resolved export */
        for (unsigned i = 0; i < isaac_import_count; ++i)
            if (!strcmp(isaac_imports[i].symbol, buf)) { addr = isaac_imports[i].shim_va; break; }
        isaac_log("[isaac][al] alcGetProcAddress(\"%s\") -> 0x%08x", buf, addr);
    }
    cpu->EAX = addr;
}

/* ALenum alGetError(void) */
void imp_openal32__alGetError(CpuState *restrict cpu) {
    al_hit("alGetError");
    cpu->EAX = 0;                     /* AL_NO_ERROR */
}

/* const ALchar *alGetString(ALenum param) */
void imp_openal32__alGetString(CpuState *restrict cpu) {
    al_hit("alGetString");
    uint32_t param = isaac_arg(cpu, 0);
    static const char vendor[] = "Isaac Native Headless";
    static const char renderer[] = "wasm headless";
    static const char version[] = "1.1";
    uint32_t va = 0;
    switch (param) {
    case 0xB001u:                     /* AL_VENDOR */
        memcpy(isaac_g(AL_SCRATCH_VA), vendor, sizeof vendor);
        va = AL_SCRATCH_VA; break;
    case 0xB002u:                     /* AL_RENDERER */
        memcpy(isaac_g(AL_SCRATCH_VA), renderer, sizeof renderer);
        va = AL_SCRATCH_VA; break;
    case 0xB003u:                     /* AL_VERSION */
        memcpy(isaac_g(AL_SCRATCH_VA), version, sizeof version);
        va = AL_SCRATCH_VA; break;
    default:
        break;
    }
    cpu->EAX = va;
}

/* void alGenSources(ALsizei n, ALuint *sources) */
void imp_openal32__alGenSources(CpuState *restrict cpu) {
    al_hit("alGenSources");
    isaac_audio_gen_sources(isaac_arg(cpu, 0), isaac_arg(cpu, 1));
    cpu->EAX = 0;
}

/* void alDeleteSources(ALsizei n, const ALuint *sources) */
void imp_openal32__alDeleteSources(CpuState *restrict cpu) {
    al_hit("alDeleteSources");
    isaac_audio_delete_sources(isaac_arg(cpu, 0), isaac_arg(cpu, 1));
    cpu->EAX = 0;
}

/* void alGenBuffers(ALsizei n, ALuint *buffers) */
void imp_openal32__alGenBuffers(CpuState *restrict cpu) {
    al_hit("alGenBuffers");
    isaac_audio_gen_buffers(isaac_arg(cpu, 0), isaac_arg(cpu, 1));
    cpu->EAX = 0;
}

/* void alDeleteBuffers(ALsizei n, const ALuint *buffers) */
void imp_openal32__alDeleteBuffers(CpuState *restrict cpu) {
    al_hit("alDeleteBuffers");
    isaac_audio_delete_buffers(isaac_arg(cpu, 0), isaac_arg(cpu, 1));
    cpu->EAX = 0;
}

/* void alSourcei(ALuint src, ALenum param, ALint value) */
void imp_openal32__alSourcei(CpuState *restrict cpu) {
    al_hit("alSourcei");
    isaac_audio_source_i(isaac_arg(cpu, 0), isaac_arg(cpu, 1), (int32_t)isaac_arg(cpu, 2));
    cpu->EAX = 0;
}

/* void alSourcef(ALuint src, ALenum param, ALfloat value) */
void imp_openal32__alSourcef(CpuState *restrict cpu) {
    al_hit("alSourcef");
    isaac_audio_source_f(isaac_arg(cpu, 0), isaac_arg(cpu, 1), al_bits2f(isaac_arg(cpu, 2)));
    cpu->EAX = 0;
}

/* void alSource3f(ALuint src, ALenum param, ALfloat v1, v2, v3) */
void imp_openal32__alSource3f(CpuState *restrict cpu) {
    al_hit("alSource3f");
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3); (void)isaac_arg(cpu, 4);
    cpu->EAX = 0;
}

/* void alSourcePlay(ALuint src) */
void imp_openal32__alSourcePlay(CpuState *restrict cpu) {
    al_hit("alSourcePlay");
    isaac_audio_play(isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

/* void alSourceStop(ALuint src) */
void imp_openal32__alSourceStop(CpuState *restrict cpu) {
    al_hit("alSourceStop");
    isaac_audio_stop(isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

/* void alSourcePause(ALuint src) */
void imp_openal32__alSourcePause(CpuState *restrict cpu) {
    al_hit("alSourcePause");
    isaac_audio_pause(isaac_arg(cpu, 0));
    cpu->EAX = 0;
}

/* void alSourceQueueBuffers(ALuint src, ALsizei n, const ALuint *bufs) */
void imp_openal32__alSourceQueueBuffers(CpuState *restrict cpu) {
    al_hit("alSourceQueueBuffers");
    isaac_audio_queue(isaac_arg(cpu, 0), isaac_arg(cpu, 1), isaac_arg(cpu, 2));
    cpu->EAX = 0;
}

/* void alSourceUnqueueBuffers(ALuint src, ALsizei n, ALuint *bufs) */
void imp_openal32__alSourceUnqueueBuffers(CpuState *restrict cpu) {
    al_hit("alSourceUnqueueBuffers");
    isaac_audio_unqueue(isaac_arg(cpu, 0), isaac_arg(cpu, 1), isaac_arg(cpu, 2));
    cpu->EAX = 0;
}

/* void alGetSourcei(ALuint src, ALenum param, ALint *out) */
void imp_openal32__alGetSourcei(CpuState *restrict cpu) {
    al_hit("alGetSourcei");
    uint32_t out = isaac_arg(cpu, 2);
    int32_t v = isaac_audio_get_source_i(isaac_arg(cpu, 0), isaac_arg(cpu, 1));
    if (isaac_is_guest_va(out)) isaac_w32(out, (uint32_t)v);
    cpu->EAX = 0;
}

/* void alGetSourcef(ALuint src, ALenum param, ALfloat *out) */
void imp_openal32__alGetSourcef(CpuState *restrict cpu) {
    al_hit("alGetSourcef");
    uint32_t out = isaac_arg(cpu, 2);
    float v = isaac_audio_get_source_f(isaac_arg(cpu, 0), isaac_arg(cpu, 1));
    if (isaac_is_guest_va(out)) isaac_w32(out, al_f2bits(v));
    cpu->EAX = 0;
}

/* void alBufferData(ALuint buf, ALenum format, const ALvoid *data,
 *                   ALsizei size, ALsizei freq) */
void imp_openal32__alBufferData(CpuState *restrict cpu) {
    al_hit("alBufferData");
    isaac_audio_buffer_data(isaac_arg(cpu, 0), isaac_arg(cpu, 1), isaac_arg(cpu, 2),
                            isaac_arg(cpu, 3), isaac_arg(cpu, 4));
    cpu->EAX = 0;
}

/* void alListener3f(ALenum param, ALfloat v1, v2, v3) */
void imp_openal32__alListener3f(CpuState *restrict cpu) {
    al_hit("alListener3f");
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    (void)isaac_arg(cpu, 2); (void)isaac_arg(cpu, 3);
    cpu->EAX = 0;
}

/* void alListenerfv(ALenum param, const ALfloat *vals) */
void imp_openal32__alListenerfv(CpuState *restrict cpu) {
    al_hit("alListenerfv");
    (void)isaac_arg(cpu, 0); (void)isaac_arg(cpu, 1);
    cpu->EAX = 0;
}

/* ---------------------------------------------------------- ALC_SOFT ---- */
/* The engine resolves five OpenAL-SOFT entry points through alcGetProcAddress
 * and, given them, registers an event handler whose only job here is to set
 * its audio manager's drain flag (FUN_00a9e890: eventType 0x19d6, deviceType
 * 0x19d4, then [userParam + 0x60] = 1). Answering null for all five, as this
 * port used to, leaves that flag clear and every queued sound unplayed.
 *
 * cdecl, so nothing purges. The callback is remembered and delivered once,
 * from the frame pump, after the game has registered it. */
static uint32_t g_alc_event_cb, g_alc_event_user;
static int g_alc_event_sent;

void imp_openal32__alcEventCallbackSOFT(CpuState *restrict cpu) {
    al_hit("alcEventCallbackSOFT");
    g_alc_event_cb = isaac_arg(cpu, 0);
    g_alc_event_user = isaac_arg(cpu, 1);
    isaac_log("[isaac][al] alcEventCallbackSOFT(callback=0x%08x, user=0x%08x)",
              g_alc_event_cb, g_alc_event_user);
    cpu->EAX = 0;
}

void imp_openal32__alcEventControlSOFT(CpuState *restrict cpu) {
    al_hit("alcEventControlSOFT");
    isaac_log("[isaac][al] alcEventControlSOFT(count=%u, events=0x%08x, enable=%u)",
              isaac_arg(cpu, 0), isaac_arg(cpu, 1), isaac_arg(cpu, 2));
    cpu->EAX = 1;                      /* ALC_TRUE */
}

void imp_openal32__alcDevicePauseSOFT(CpuState *restrict cpu) {
    al_hit("alcDevicePauseSOFT");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}

void imp_openal32__alcDeviceResumeSOFT(CpuState *restrict cpu) {
    al_hit("alcDeviceResumeSOFT");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 0;
}

void imp_openal32__alcReopenDeviceSOFT(CpuState *restrict cpu) {
    al_hit("alcReopenDeviceSOFT");
    (void)isaac_arg(cpu, 0);
    cpu->EAX = 1;                      /* ALC_TRUE: the device is unchanged */
}

/* Deliver the one event the engine is waiting for:
 *   void (ALCenum eventType, ALCenum deviceType, ALCdevice *device,
 *         ALCsizei length, const ALCchar *message, void *userParam)
 * cdecl, so the arguments are pushed right to left and this cleans up. */
int isaac_al_send_device_event(CpuState *restrict cpu) {
    if (!g_alc_event_cb || g_alc_event_sent || !cpu) return 0;
    g_alc_event_sent = 1;
    CpuState sub = *cpu;
    sub.ESP = (cpu->ESP - 0x4000u) & ~0xFu;
    uint32_t args[6] = { 0x19d6u, 0x19d4u, g_alc_device, 0u, 0u, g_alc_event_user };
    for (int i = 5; i >= 0; --i) { sub.ESP -= 4u; isaac_w32(sub.ESP, args[i]); }
    sub.ESP -= 4u;
    isaac_w32(sub.ESP, 0u);            /* return address */
    isaac_log("[isaac][al] delivering ALC_EVENT_TYPE_DEFAULT_DEVICE_CHANGED to 0x%08x(user 0x%08x)",
              g_alc_event_cb, g_alc_event_user);
    isaac_guest_call(g_alc_event_cb, &sub);
    return 1;
}
