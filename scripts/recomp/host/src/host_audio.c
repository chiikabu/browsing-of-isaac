/* host_audio.c -- the audio engine behind the OpenAL surface.
 *
 * host_shims_al.c used to answer the whole 26-name openal32 surface with
 * benign constants: buffers and sources were tokens nobody remembered, every
 * play was a no-op, and `alGetSourcei(AL_SOURCE_STATE)` always said
 * AL_INITIAL so the engine's slot poller reused the first slot forever. The
 * game ran silent and, more importantly, could not stream: a source that is
 * never "playing" never reports a processed buffer, so the music path had
 * nothing to unqueue.
 *
 * This file is the object model that surface needs, and it is deliberately
 * independent of whether anything can actually be heard:
 *
 *   buffers   remember their PCM (format, channels, bit depth, rate) and the
 *             duration that implies
 *   sources   have a state, a gain, a pitch, an optional static buffer and a
 *             queue; they advance on the wall clock, so a source stops when
 *             its sound would have finished and a streaming source reports
 *             buffers as processed when their audio would have played out
 *
 * That much makes the guest's audio logic behave correctly with no output
 * device at all, which is what the node profile has. A backend can then be
 * plugged underneath to make it audible; the web build's is WebAudio, in
 * host_audio_web.c. The backend hooks are weak, so a profile that provides
 * none links and runs silent.
 *
 * Round 36 (music): the backend used to be told about ONE buffer, at
 * alSourcePlay -- the queue head -- and nothing else. The engine starts its
 * music stream with an empty queue (alSourcePlay first, four 64 KB chunks
 * queued afterwards, then one chunk per processed chunk for as long as the
 * track runs), so the web backend was handed buffer 0 and played nothing,
 * ever, while this model kept answering "processed" off the wall clock and
 * the game kept refilling into silence. The backend now sees the queue:
 * every queue/unqueue/clear, and a play that says whether the source streams,
 * from which entry, at what offset. The model also follows OpenAL Soft where
 * it used to diverge: AL_BUFFERS_QUEUED is the whole queue (processed
 * entries included), a play with nothing to play stops at once, a stop marks
 * every queued buffer processed, a play from stopped restarts at the head of
 * the queue, an unqueue asking for more than is processed takes nothing, and
 * AL_BUFFER cannot be changed on a playing or paused source.
 *
 * ISAAC_AUDIO_TRACE=1 logs every state change (per source: static/stream,
 * play/stop/pause, queue/unqueue with ids and counts, gain, pitch, the
 * buffers the clock retires); isaac_audio_report() prints the census with
 * the stub report.
 */

#include "isaac_host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
static double emscripten_get_now(void) { return 0.0; }
#endif

/* ---- AL constants (the subset the game uses) ---------------------------- */
#define AL_NONE               0x0000u
#define AL_PITCH              0x1003u
#define AL_POSITION           0x1004u
#define AL_LOOPING            0x1007u
#define AL_BUFFER             0x1009u
#define AL_GAIN               0x100Au
#define AL_SOURCE_STATE       0x1010u
#define AL_INITIAL            0x1011u
#define AL_PLAYING            0x1012u
#define AL_PAUSED             0x1013u
#define AL_STOPPED            0x1014u
#define AL_BUFFERS_QUEUED     0x1015u
#define AL_BUFFERS_PROCESSED  0x1016u
#define AL_SEC_OFFSET         0x1024u
#define AL_SAMPLE_OFFSET      0x1025u
#define AL_BYTE_OFFSET        0x1026u
#define AL_SOURCE_TYPE        0x1027u
#define AL_STATIC             0x1028u
#define AL_STREAMING          0x1029u
#define AL_UNDETERMINED       0x1030u

#define AL_FORMAT_MONO8       0x1100u
#define AL_FORMAT_MONO16      0x1101u
#define AL_FORMAT_STEREO8     0x1102u
#define AL_FORMAT_STEREO16    0x1103u

/* ---- backend hooks (weak: a profile with no output still links) ---------
 * The contract, in the order a streaming source goes through it:
 *   buffer(id, pcm...)          PCM arrived for a buffer id (re-uploads replace)
 *   queue(src, id)              one buffer appended to the source's queue
 *   play(src, buffer, gain, pitch, looping, streaming, head, offset_sec)
 *                               static: play `buffer` (from offset_sec on a
 *                               resume); streaming: play the queue from entry
 *                               `head` (0 = a restart from the queue head,
 *                               the processed count on a resume), the first
 *                               entry from offset_sec
 *   unqueue(src, n)             the n oldest queue entries left the queue
 *   stop/pause(src)             the source stopped (a later play restarts it)
 *   clear(src)                  AL_BUFFER 0: forget the queue
 *   delete(src)                 alDeleteSources: the source is gone, queue and all
 *   gain/pitch(src, v)          a parameter changed, playing or not
 *   drop_buffer(id)             the buffer was deleted */
__attribute__((weak)) void isaac_audio_backend_buffer(uint32_t id, const void *pcm, uint32_t bytes,
                                                      int channels, int bits, int freq) {
    (void)id; (void)pcm; (void)bytes; (void)channels; (void)bits; (void)freq;
}
__attribute__((weak)) void isaac_audio_backend_play(uint32_t src, uint32_t buffer, float gain, float pitch,
                                                    int looping, int streaming, uint32_t head, float offset_sec) {
    (void)src; (void)buffer; (void)gain; (void)pitch; (void)looping; (void)streaming; (void)head; (void)offset_sec;
}
__attribute__((weak)) void isaac_audio_backend_queue(uint32_t src, uint32_t buffer) { (void)src; (void)buffer; }
__attribute__((weak)) void isaac_audio_backend_unqueue(uint32_t src, uint32_t n) { (void)src; (void)n; }
__attribute__((weak)) void isaac_audio_backend_clear(uint32_t src) { (void)src; }
__attribute__((weak)) void isaac_audio_backend_delete(uint32_t src) { (void)src; }
__attribute__((weak)) void isaac_audio_backend_stop(uint32_t src) { (void)src; }
__attribute__((weak)) void isaac_audio_backend_pause(uint32_t src) { (void)src; }
__attribute__((weak)) void isaac_audio_backend_gain(uint32_t src, float gain) { (void)src; (void)gain; }
__attribute__((weak)) void isaac_audio_backend_pitch(uint32_t src, float pitch) { (void)src; (void)pitch; }
__attribute__((weak)) void isaac_audio_backend_drop_buffer(uint32_t id) { (void)id; }

/* The clock the model advances on: the wall clock, unless a test overrides
 * it (the selftest links a settable one so the retire logic is checked at
 * exact instants rather than by sleeping). */
__attribute__((weak)) double isaac_audio_clock_ms(void) { return emscripten_get_now(); }

/* ---- objects ------------------------------------------------------------ */
#define AL_MAX_QUEUE 64

typedef struct {
    uint32_t id;
    uint8_t *pcm;
    uint32_t bytes;
    int channels, bits, freq;
    double seconds;
} al_buffer;

typedef struct {
    uint32_t id;
    uint32_t state;
    uint32_t buffer;                 /* AL_BUFFER, static play */
    float gain, pitch;
    int looping;
    double start_ms;                 /* when the CURRENT buffer began */
    double pause_ms;                 /* offset held while paused */
    uint32_t queue[AL_MAX_QUEUE];    /* streaming: not-yet-unqueued buffers */
    unsigned qn;                     /* entries in queue[] */
    unsigned processed;              /* how many of them have played out */
    uint32_t type;                   /* AL_STATIC / AL_STREAMING / AL_UNDETERMINED */
} al_source;

static al_buffer *g_buf;
static unsigned g_nbuf, g_cbuf;
static al_source *g_src;
static unsigned g_nsrc, g_csrc;
static uint32_t g_next_token = 0x7788c000u;
static int g_trace = -1;

/* census, printed with the stub report */
static unsigned g_stat_buffers, g_stat_plays, g_stat_queued, g_stat_unqueued;
static unsigned g_stat_stream_plays, g_stat_empty_plays, g_stat_unqueue_refused, g_stat_bind_refused;
static unsigned long long g_stat_pcm_bytes;
static double g_stat_seconds;

static int trace_on(void) {
    if (g_trace < 0) {
        const char *e = getenv("ISAAC_AUDIO_TRACE");
        g_trace = (e && *e && *e != '0') ? 1 : 0;
    }
    return g_trace;
}
int isaac_audio_trace_on(void) { return trace_on(); }

static double now_ms(void) { return isaac_audio_clock_ms(); }

/* trace lines carry the model's clock, relative to the first trace line, so
 * a queue/retire/schedule sequence can be read against the web backend's
 * AudioContext times */
static double g_trace_t0 = -1.0;
static double trace_t(void) {
    double t = now_ms();
    if (g_trace_t0 < 0.0) g_trace_t0 = t;
    return t - g_trace_t0;
}
#define ATRACE(...) do { if (trace_on()) isaac_log(__VA_ARGS__); } while (0)

static const char *state_name(uint32_t st) {
    switch (st) {
    case AL_INITIAL: return "INITIAL";
    case AL_PLAYING: return "PLAYING";
    case AL_PAUSED:  return "PAUSED";
    case AL_STOPPED: return "STOPPED";
    default:         return "?";
    }
}

static al_buffer *buf_find(uint32_t id) {
    for (unsigned i = 0; i < g_nbuf; ++i) if (g_buf[i].id == id) return &g_buf[i];
    return NULL;
}
static al_source *src_find(uint32_t id) {
    for (unsigned i = 0; i < g_nsrc; ++i) if (g_src[i].id == id) return &g_src[i];
    return NULL;
}

static al_buffer *buf_new(void) {
    if (g_nbuf == g_cbuf) {
        unsigned c = g_cbuf ? g_cbuf * 2u : 64u;
        al_buffer *p = (al_buffer *)realloc(g_buf, c * sizeof *p);
        if (!p) return NULL;
        g_buf = p; g_cbuf = c;
    }
    al_buffer *b = &g_buf[g_nbuf++];
    memset(b, 0, sizeof *b);
    b->id = (g_next_token += 0x10u);
    return b;
}
static al_source *src_new(void) {
    if (g_nsrc == g_csrc) {
        unsigned c = g_csrc ? g_csrc * 2u : 64u;
        al_source *p = (al_source *)realloc(g_src, c * sizeof *p);
        if (!p) return NULL;
        g_src = p; g_csrc = c;
    }
    al_source *s = &g_src[g_nsrc++];
    memset(s, 0, sizeof *s);
    s->id = (g_next_token += 0x10u);
    s->state = AL_INITIAL;
    s->gain = 1.0f;
    s->pitch = 1.0f;
    s->type = AL_UNDETERMINED;
    return s;
}

static double buf_seconds(const al_buffer *b) { return b ? b->seconds : 0.0; }

/* The head of a streaming source is the first queue entry not yet processed;
 * a static source plays s->buffer. */
static uint32_t src_current_buffer(const al_source *s) {
    if (s->qn > s->processed) return s->queue[s->processed];
    return s->buffer;
}
static int src_is_stream(const al_source *s) { return s->qn != 0 || s->type == AL_STREAMING; }

/* Advance a playing source over the clock: retire whole buffers whose audio
 * would have finished, and stop (or loop) when nothing is left. */
static void src_advance(al_source *s) {
    if (s->state != AL_PLAYING) return;
    double pitch = s->pitch > 0.01f ? (double)s->pitch : 1.0;
    for (;;) {
        uint32_t cur = src_current_buffer(s);
        al_buffer *b = buf_find(cur);
        double dur = buf_seconds(b) * 1000.0 / pitch;
        if (dur <= 0.0) {
            /* nothing playable: an empty queue entry is retired at once, a
             * source with no buffer at all is not playing */
            if (s->qn > s->processed) { ++s->processed; continue; }
            s->state = AL_STOPPED;
            ATRACE("[isaac][audio] t=%.1f source %u has nothing to play: STOPPED (%u queued, %u processed)",
                   trace_t(), s->id, s->qn, s->processed);
            return;
        }
        double t = now_ms();
        if (t - s->start_ms < dur) return;             /* still inside it */
        s->start_ms += dur;
        if (s->qn > s->processed) {
            ++s->processed;                            /* streaming: retire it */
            ATRACE("[isaac][audio] t=%.1f source %u retired buffer %u (%u/%u processed, seen %.0f ms after its end)",
                   trace_t(), s->id, cur, s->processed, s->qn, t - s->start_ms);
            if (s->qn > s->processed) continue;        /* next queued buffer */
            s->state = AL_STOPPED;                     /* queue ran dry */
            ATRACE("[isaac][audio] t=%.1f source %u ran dry: STOPPED with %u processed", trace_t(), s->id, s->processed);
            return;
        }
        if (s->looping) continue;                      /* static loop: keep going */
        s->state = AL_STOPPED;
        ATRACE("[isaac][audio] t=%.1f source %u finished buffer %u: STOPPED", trace_t(), s->id, cur);
        return;
    }
}

/* ---- the surface host_shims_al.c calls --------------------------------- */

void isaac_audio_gen_buffers(uint32_t n, uint32_t out_va) {
    for (uint32_t i = 0; i < n; ++i) {
        al_buffer *b = buf_new();
        if (isaac_is_guest_va(out_va + 4u * i))
            isaac_w32(out_va + 4u * i, b ? b->id : 0u);
    }
}

void isaac_audio_gen_sources(uint32_t n, uint32_t out_va) {
    for (uint32_t i = 0; i < n; ++i) {
        al_source *s = src_new();
        if (isaac_is_guest_va(out_va + 4u * i))
            isaac_w32(out_va + 4u * i, s ? s->id : 0u);
    }
}

void isaac_audio_delete_buffers(uint32_t n, uint32_t va) {
    for (uint32_t i = 0; i < n; ++i) {
        if (!isaac_is_guest_va(va + 4u * i)) continue;
        uint32_t id = isaac_r32(va + 4u * i);
        al_buffer *b = buf_find(id);
        if (!b) continue;
        isaac_audio_backend_drop_buffer(id);
        free(b->pcm);
        *b = g_buf[--g_nbuf];
    }
}

void isaac_audio_delete_sources(uint32_t n, uint32_t va) {
    for (uint32_t i = 0; i < n; ++i) {
        if (!isaac_is_guest_va(va + 4u * i)) continue;
        uint32_t id = isaac_r32(va + 4u * i);
        al_source *s = src_find(id);
        if (!s) continue;
        isaac_audio_backend_delete(id);
        ATRACE("[isaac][audio] t=%.1f delete source %u (%s, %u queued)", trace_t(), id,
               src_is_stream(s) ? "stream" : "static", s->qn);
        *s = g_src[--g_nsrc];
    }
}

void isaac_audio_buffer_data(uint32_t buf, uint32_t format, uint32_t data_va,
                             uint32_t bytes, uint32_t freq) {
    al_buffer *b = buf_find(buf);
    if (!b) return;
    int channels = (format == AL_FORMAT_STEREO8 || format == AL_FORMAT_STEREO16) ? 2 : 1;
    int bits = (format == AL_FORMAT_MONO16 || format == AL_FORMAT_STEREO16) ? 16 : 8;
    uint32_t frame = (uint32_t)channels * (uint32_t)(bits / 8);
    free(b->pcm);
    b->pcm = NULL;
    b->bytes = 0;
    b->channels = channels;
    b->bits = bits;
    b->freq = (int)freq;
    b->seconds = (freq && frame) ? (double)bytes / (double)(frame * freq) : 0.0;
    if (bytes && isaac_is_guest_va(data_va) && isaac_is_guest_va(data_va + bytes - 1u)) {
        b->pcm = (uint8_t *)malloc(bytes);
        if (b->pcm) {
            memcpy(b->pcm, isaac_g(data_va), bytes);
            b->bytes = bytes;
        }
    }
    ++g_stat_buffers;
    g_stat_pcm_bytes += bytes;
    g_stat_seconds += b->seconds;
    if (b->pcm) isaac_audio_backend_buffer(b->id, b->pcm, b->bytes, channels, bits, (int)freq);
    ATRACE("[isaac][audio] t=%.1f buffer %u: %u bytes, %d ch, %d bit, %u Hz, %.3f s (format 0x%x)",
           trace_t(), buf, bytes, channels, bits, freq, b->seconds, format);
}

void isaac_audio_source_i(uint32_t src, uint32_t param, int32_t value) {
    al_source *s = src_find(src);
    if (!s) return;
    switch (param) {
    case AL_BUFFER:
        /* OpenAL: AL_INVALID_OPERATION on a playing or paused source; the
         * binding (or the detach, value 0) only takes on a stopped/initial one */
        src_advance(s);
        if (s->state == AL_PLAYING || s->state == AL_PAUSED) {
            ++g_stat_bind_refused;
            ATRACE("[isaac][audio] t=%.1f AL_BUFFER %d refused on source %u: it is %s",
                   trace_t(), value, src, state_name(s->state));
            break;
        }
        ATRACE("[isaac][audio] t=%.1f source %u %s (queue of %u dropped)", trace_t(), src,
               value ? "bound to a static buffer" : "detached: AL_BUFFER 0", s->qn);
        s->buffer = (uint32_t)value;
        s->type = value ? AL_STATIC : AL_UNDETERMINED;
        s->qn = s->processed = 0;
        isaac_audio_backend_clear(src);
        break;
    case AL_LOOPING:
        s->looping = value != 0;
        ATRACE("[isaac][audio] t=%.1f source %u looping = %d", trace_t(), src, s->looping);
        break;
    default: break;
    }
}

void isaac_audio_source_f(uint32_t src, uint32_t param, float value) {
    al_source *s = src_find(src);
    if (!s) return;
    switch (param) {
    case AL_GAIN:
        if (trace_on() && s->gain != value)
            isaac_log("[isaac][audio] t=%.1f source %u gain %.3f -> %.3f (%s, %s)", trace_t(), src,
                      (double)s->gain, (double)value, src_is_stream(s) ? "stream" : "static", state_name(s->state));
        s->gain = value;
        isaac_audio_backend_gain(src, value);
        break;
    case AL_PITCH:
        if (trace_on() && s->pitch != value)
            isaac_log("[isaac][audio] t=%.1f source %u pitch %.3f -> %.3f", trace_t(), src,
                      (double)s->pitch, (double)value);
        s->pitch = value;
        isaac_audio_backend_pitch(src, value);
        break;
    default: break;
    }
}

int32_t isaac_audio_get_source_i(uint32_t src, uint32_t param) {
    al_source *s = src_find(src);
    if (!s) return 0;
    src_advance(s);
    switch (param) {
    case AL_SOURCE_STATE:      return (int32_t)s->state;
    case AL_BUFFERS_QUEUED:    return (int32_t)s->qn;          /* the whole queue, processed included */
    case AL_BUFFERS_PROCESSED: return (int32_t)s->processed;
    case AL_BUFFER:            return (int32_t)src_current_buffer(s);
    case AL_LOOPING:           return s->looping;
    case AL_SOURCE_TYPE:       return (int32_t)s->type;
    case AL_SAMPLE_OFFSET:
    case AL_BYTE_OFFSET: {
        al_buffer *b = buf_find(src_current_buffer(s));
        if (!b || s->state != AL_PLAYING) return 0;
        double sec = (now_ms() - s->start_ms) / 1000.0;
        if (sec < 0.0) sec = 0.0;
        double samples = sec * (double)b->freq;
        if (param == AL_SAMPLE_OFFSET) return (int32_t)samples;
        return (int32_t)(samples * (double)b->channels * (double)(b->bits / 8));
    }
    default: return 0;
    }
}

float isaac_audio_get_source_f(uint32_t src, uint32_t param) {
    al_source *s = src_find(src);
    if (!s) return 0.0f;
    src_advance(s);
    switch (param) {
    case AL_GAIN:  return s->gain;
    case AL_PITCH: return s->pitch;
    case AL_SEC_OFFSET:
        if (s->state != AL_PLAYING) return 0.0f;
        return (float)((now_ms() - s->start_ms) / 1000.0);
    default: return 0.0f;
    }
}

void isaac_audio_play(uint32_t src) {
    al_source *s = src_find(src);
    if (!s) return;
    src_advance(s);
    uint32_t before = s->state;
    int stream = src_is_stream(s);
    uint32_t head = 0;
    float offset = 0.0f;
    if (s->state == AL_PAUSED) {
        s->start_ms = now_ms() - s->pause_ms;     /* resume where it stopped */
        head = s->processed;
        offset = (float)(s->pause_ms / 1000.0);
    } else {
        /* OpenAL: a play from initial, stopped OR playing restarts the source:
         * a static buffer from its start, a queue from its head */
        s->start_ms = now_ms();
        s->processed = 0;
    }
    s->pause_ms = 0.0;
    uint32_t cur = src_current_buffer(s);
    al_buffer *b = buf_find(cur);
    if (!b || b->seconds <= 0.0) {
        /* OpenAL Soft: nothing to play goes straight to stopped, no voice */
        s->state = AL_STOPPED;
        ++g_stat_empty_plays;
        ATRACE("[isaac][audio] t=%.1f play source %u from %s: nothing to play (%s, %u queued) -> STOPPED",
               trace_t(), src, state_name(before), stream ? "stream" : "static", s->qn);
        return;
    }
    s->state = AL_PLAYING;
    ++g_stat_plays;
    if (stream) ++g_stat_stream_plays;
    isaac_audio_backend_play(src, cur, s->gain, s->pitch, s->looping, stream, head, offset);
    if (trace_on()) {
        if (stream)
            isaac_log("[isaac][audio] t=%.1f play source %u from %s: stream, entry %u of %u (buffer %u, %.3f s), offset %.3f s, gain %.3f pitch %.2f",
                      trace_t(), src, state_name(before), head, s->qn, cur, b->seconds, (double)offset,
                      (double)s->gain, (double)s->pitch);
        else
            isaac_log("[isaac][audio] t=%.1f play source %u from %s: static buffer %u (%.3f s), offset %.3f s, gain %.3f pitch %.2f%s",
                      trace_t(), src, state_name(before), cur, b->seconds, (double)offset,
                      (double)s->gain, (double)s->pitch, s->looping ? " looping" : "");
    }
}

void isaac_audio_stop(uint32_t src) {
    al_source *s = src_find(src);
    if (!s) return;
    src_advance(s);
    uint32_t before = s->state;
    s->state = AL_STOPPED;
    s->pause_ms = 0.0;
    /* OpenAL: on a stopped source every queued buffer counts as processed */
    s->processed = s->qn;
    isaac_audio_backend_stop(src);
    ATRACE("[isaac][audio] t=%.1f stop source %u from %s (%s, %u queued now all processed)",
           trace_t(), src, state_name(before), src_is_stream(s) ? "stream" : "static", s->qn);
}

void isaac_audio_pause(uint32_t src) {
    al_source *s = src_find(src);
    if (!s) return;
    src_advance(s);
    if (s->state != AL_PLAYING) return;          /* OpenAL: pause only affects a playing source */
    s->pause_ms = now_ms() - s->start_ms;
    s->state = AL_PAUSED;
    isaac_audio_backend_pause(src);
    ATRACE("[isaac][audio] t=%.1f pause source %u at +%.0f ms into entry %u", trace_t(), src, s->pause_ms, s->processed);
}

void isaac_audio_queue(uint32_t src, uint32_t n, uint32_t bufs_va) {
    al_source *s = src_find(src);
    if (!s) return;
    src_advance(s);
    s->type = AL_STREAMING;
    uint32_t first = 0, taken = 0;
    for (uint32_t i = 0; i < n; ++i) {
        if (!isaac_is_guest_va(bufs_va + 4u * i)) break;
        if (s->qn >= AL_MAX_QUEUE) {
            /* compact: drop the already-processed head entries */
            if (s->processed) {
                isaac_audio_backend_unqueue(src, s->processed);
                memmove(s->queue, s->queue + s->processed,
                        (s->qn - s->processed) * sizeof s->queue[0]);
                s->qn -= s->processed;
                s->processed = 0;
            }
            if (s->qn >= AL_MAX_QUEUE) break;
        }
        uint32_t id = isaac_r32(bufs_va + 4u * i);
        if (!taken) first = id;
        s->queue[s->qn++] = id;
        isaac_audio_backend_queue(src, id);
        ++taken;
        ++g_stat_queued;
    }
    ATRACE("[isaac][audio] t=%.1f queue %u buffer(s) on source %u (first %u): %u queued, %u processed, %s",
           trace_t(), taken, src, first, s->qn, s->processed, state_name(s->state));
}

uint32_t isaac_audio_unqueue(uint32_t src, uint32_t n, uint32_t out_va) {
    al_source *s = src_find(src);
    if (!s) return 0;
    src_advance(s);
    /* OpenAL: AL_INVALID_VALUE and nothing removed when more is asked for
     * than has been processed (a partial take would hand the game ids it
     * never got back, which it then refills and re-queues as dead entries) */
    if (n > s->processed) {
        ++g_stat_unqueue_refused;
        ATRACE("[isaac][audio] t=%.1f unqueue %u from source %u refused: only %u of %u processed (%s)",
               trace_t(), n, src, s->processed, s->qn, state_name(s->state));
        return 0;
    }
    uint32_t take = n;
    uint32_t first = take ? s->queue[0] : 0;
    for (uint32_t i = 0; i < take; ++i)
        if (isaac_is_guest_va(out_va + 4u * i))
            isaac_w32(out_va + 4u * i, s->queue[i]);
    if (take) {
        memmove(s->queue, s->queue + take, (s->qn - take) * sizeof s->queue[0]);
        s->qn -= take;
        s->processed -= take;
        g_stat_unqueued += take;
        isaac_audio_backend_unqueue(src, take);
    }
    ATRACE("[isaac][audio] t=%.1f unqueue %u from source %u (first %u): %u left, %u processed, %s",
           trace_t(), take, src, first, s->qn, s->processed, state_name(s->state));
    return take;
}

/* Round 16d probe, kept for re-use: it answered why the game submits no
 * PCM and is not wired in by default, because a permanent WRAP_PATCHES entry
 * would have to follow the fastpath-wrapper contract (mode check, owns the
 * ret) that tests/recomp-fastpath.test.js pins, and this only observes. To
 * re-enable, add a wrapper for 0x00a9fb80 that calls this and then
 * sub_00a9fb80__lifted(s).
 *
 * Why the game never submits PCM. sub_00a9fb80 binds a free AL
 * source to a sound and uploads its buffer, but only when
 *
 *     vt[0x38](this) == 0 && this[10] != 0 && this[0xb] != 0
 *
 * where this[10] and this[0xb] are the sample's PCM pointer and length. The
 * wrapper in lift_patches.py calls this first, so a run says which of the
 * three is the one that fails. */
void isaac_audio_probe_bind(uint32_t self) {
    static unsigned n;
    if (n >= 12u || !isaac_is_guest_va(self + 0x40u)) return;
    ++n;
    uint32_t vt = isaac_r32(self);
    isaac_log("[isaac][audio] bind probe #%u: this=0x%08x vtable=0x%08x pcm=0x%08x bytes=%u "
              "format=0x%x rate=%u source=%u",
              n, self, vt, isaac_r32(self + 40u), isaac_r32(self + 44u),
              isaac_r32(self + 48u), isaac_r32(self + 36u), isaac_r32(self + 52u));
    /* this[0x44] is the sample descriptor {ptr, len} that vt+0x08 hands to
     * vt+0x04 (FUN_00a9fb00), which is what fills this[10]/this[0xb]. If it
     * is null or empty, nothing ever loaded the sample. */
    uint32_t desc = isaac_r32(self + 0x44u);
    isaac_log("[isaac][audio]   sample descriptor this[0x44]=0x%08x -> ptr=0x%08x len=%u, loaded flag this[8]=%u",
              desc,
              (desc && isaac_is_guest_va(desc + 8u)) ? isaac_r32(desc) : 0u,
              (desc && isaac_is_guest_va(desc + 8u)) ? isaac_r32(desc + 4u) : 0u,
              *(const uint8_t *)isaac_g(self + 8u));
    if (n == 1u && isaac_is_guest_va(vt + 0x50u)) {
        /* the class's methods, read from the live image: the loader that
         * should have filled the PCM fields is one of these */
        for (uint32_t i = 0; i < 0x50u; i += 0x10u)
            isaac_log("[isaac][audio]   vt+0x%02x: %08x %08x %08x %08x", i,
                      isaac_r32(vt + i), isaac_r32(vt + i + 4u),
                      isaac_r32(vt + i + 8u), isaac_r32(vt + i + 12u));
    }
}

/* ---- driving the game's audio thread ------------------------------------
 * The engine runs its mixer on a thread (FUN_00a7da80) whose body is
 *
 *     while ((self[1] & 4) == 0) {
 *         if (!vt[0x20](self)) vt[0x3c](self);
 *         Sleep(5);
 *     }
 *
 * and which therefore never returns. The port has no threads, and running
 * that job inline hangs the boot. Since one iteration is a pair of virtual
 * calls, the host can be the thread instead: host_shims_module.c hands the
 * `this` pointer over when the job is spawned, and the frame present pumps
 * one iteration. That is the whole reason the game submits no audio without
 * it: every alBufferData and alSourcePlay is downstream of this loop. */
static uint32_t g_pump_this;
static unsigned g_pump_iters, g_pump_idle;

void isaac_audio_pump_register(uint32_t this_va) {
    g_pump_this = this_va;
    isaac_log("[isaac][audio] mixer object 0x%08x adopted: the frame present now "
              "pumps one iteration of the engine's audio thread per frame", this_va);
}

/* One call of a guest thiscall method: `this` in ECX, a fake return address,
 * and a stack well below the caller's frame (the same shape the cooperative
 * thread runner and _initterm use). */
static void pump_call(const CpuState *cpu, uint32_t fn, uint32_t self, uint32_t *eax_out) __attribute__((unused));
static void pump_call(const CpuState *cpu, uint32_t fn, uint32_t self, uint32_t *eax_out) {
    CpuState sub = *cpu;
    sub.ECX = self;
    sub.ESP = (cpu->ESP - 0x4000u) & ~0xFu;
    sub.ESP -= 4u;
    isaac_w32(sub.ESP, 0u);
    isaac_guest_call(fn, &sub);
    if (eax_out) *eax_out = sub.EAX;
}

void isaac_audio_pump(const CpuState *cpu) {
    if (!g_pump_this || !cpu) return;
    if (!isaac_is_guest_va(g_pump_this + 8u)) return;
    if (*(const uint8_t *)isaac_g(g_pump_this + 4u) & 4u) return;   /* stopping */
    uint32_t vt = isaac_r32(g_pump_this);
    if (!isaac_is_guest_va(vt + 0x40u)) return;
    uint32_t step = isaac_r32(vt + 0x20u), idle = isaac_r32(vt + 0x3cu);
    if (!step) return;
    if (g_pump_iters == 0u)
        isaac_log("[isaac][audio] mixer vtable 0x%08x: step=vt[0x20]=0x%08x idle=vt[0x3c]=0x%08x, "
                  "flags byte 0x%02x, drain gate [this+0x60]=%u, pending list 0x%08x..0x%08x",
                  vt, step, idle, *(const uint8_t *)isaac_g(g_pump_this + 4u),
                  isaac_is_guest_va(g_pump_this + 0x60u) ? *(const uint8_t *)isaac_g(g_pump_this + 0x60u) : 0xFFu,
                  isaac_is_guest_va(g_pump_this + 0x20u) ? isaac_r32(g_pump_this + 0x1cu) : 0u,
                  isaac_is_guest_va(g_pump_this + 0x24u) ? isaac_r32(g_pump_this + 0x20u) : 0u);
    if (g_pump_iters && (g_pump_iters % 600u) == 0u) {
        uint32_t lo = isaac_r32(g_pump_this + 0x1cu), hi = isaac_r32(g_pump_this + 0x20u), p;
        isaac_log("[isaac][audio] pump %u: gate=%u active=%u sounds",
                  g_pump_iters,
                  isaac_is_guest_va(g_pump_this + 0x60u) ? *(const uint8_t *)isaac_g(g_pump_this + 0x60u) : 0xFFu,
                  (hi - lo) / 4u);
        /* the active list (round 24d): each entry's class, bound source id
         * [+0x34] and the sample-loaded state the load path would set */
        for (p = lo; p < hi && p < lo + 16u && isaac_is_guest_va(p + 3u); p += 4u) {
            uint32_t s = isaac_r32(p);
            if (!isaac_is_guest_va(s + 0x3bu)) continue;
            isaac_log("[isaac][audio]   active 0x%08x: vtable 0x%08x source=%u [+0x8]=0x%08x [+0xc]=0x%08x [+0x10]=0x%08x",
                      s, isaac_r32(s), isaac_r32(s + 0x34u), isaac_r32(s + 8u), isaac_r32(s + 0xcu), isaac_r32(s + 0x10u));
        }
    }
    /* ISAAC_AUDIO_DEVICE_EVENT=1: set the byte the OpenAL-SOFT
     * device-changed callback would set. The engine's audio thread handler
     * (FUN_00a9e720) does all of its work inside `if (this[0x60])`, and the
     * only thing that ever sets that byte is the ALC_SOFT_system_events
     * callback (FUN_00a9e890, "OpenAL-SOFT device has changed") -- which this
     * port never delivers, because alcIsExtensionPresent says no and
     * alcGetProcAddress returns null. This is the probe for whether that is
     * what keeps the queued sounds from being bound to a source. */
    {
        static int forced = -1;
        if (forced < 0) {
            const char *e = getenv("ISAAC_AUDIO_DEVICE_EVENT");
            forced = (e && *e && *e != '0') ? 1 : 0;
        }
        if (forced == 1 && isaac_is_guest_va(g_pump_this + 0x60u)) {
            /* only once the manager has something queued: the callback this
             * stands in for would have arrived with the game already running */
            uint32_t lo = isaac_r32(g_pump_this + 0x1cu), hi = isaac_r32(g_pump_this + 0x20u);
            if (hi > lo) {
                *(uint8_t *)isaac_g(g_pump_this + 0x60u) = 1u;
                forced = 2;
                isaac_log("[isaac][audio] device-changed flag set with %u sound(s) queued",
                          (hi - lo) / 4u);
            }
        }
    }
    /* Once the engine has registered its ALC_SOFT event handler, give it the
     * device-changed event it is waiting for. Its handler sets the audio
     * manager's drain flag, which is the gate on everything downstream
     * (round 22). */
    { extern int isaac_al_send_device_event(CpuState *restrict cpu);
      isaac_al_send_device_event((CpuState *)cpu); }
    /* The watcher's own loop now runs as a per-frame slice (round 24), so
     * this no longer calls its step/idle pair; what stays here is the
     * device-event delivery above and the census. */
    (void)step; (void)idle;
    ++g_pump_iters;
}

void isaac_audio_report(void) {
    { extern void isaac_al_census(void); isaac_al_census(); }
    if (!g_stat_buffers && !g_stat_plays) {
        isaac_log("[isaac][audio] no audio data was ever submitted (mixer pumped %u iteration(s)).", g_pump_iters);
        return;
    }
    unsigned playing = 0, streams = 0;
    for (unsigned i = 0; i < g_nsrc; ++i) {
        src_advance(&g_src[i]);
        if (g_src[i].state == AL_PLAYING) ++playing;
        if (src_is_stream(&g_src[i])) ++streams;
    }
    isaac_log("[isaac][audio] mixer pumped %u iteration(s), %u of them idle",
              g_pump_iters, g_pump_idle);
    isaac_log("[isaac][audio] %u buffer uploads (%.1f MB of PCM, %.1f s of audio), "
              "%u plays (%u of streams, %u with nothing to play), %u queued / %u unqueued, "
              "%u source(s) live (%u playing, %u streaming), %u buffer(s) live",
              g_stat_buffers, (double)g_stat_pcm_bytes / 1048576.0, g_stat_seconds,
              g_stat_plays, g_stat_stream_plays, g_stat_empty_plays, g_stat_queued, g_stat_unqueued,
              g_nsrc, playing, streams, g_nbuf);
    if (g_stat_unqueue_refused || g_stat_bind_refused)
        isaac_log("[isaac][audio] OpenAL rules refused %u unqueue(s) asking past the processed count and "
                  "%u AL_BUFFER change(s) on a playing/paused source",
                  g_stat_unqueue_refused, g_stat_bind_refused);
}
