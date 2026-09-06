/* host_audio_web.c -- the WEB build's audio backend: WebAudio.
 *
 * host_audio.c owns the OpenAL object model and its timing; this file is the
 * part that makes it audible, and it compiles only with -DISAAC_WEB=1
 * (build_boot.py --web), exactly like host_gl_webgl.c. The node profile links
 * host_audio.c's weak no-op hooks instead and runs silent, which is what a
 * headless run wants.
 *
 * The mapping. An AL buffer becomes an AudioBuffer: the guest hands over
 * interleaved PCM (8- or 16-bit, mono or stereo) and it is de-interleaved into
 * the float channels WebAudio wants. An AL source becomes one GainNode that
 * lives as long as the source and feeds the master GainNode (-> destination;
 * the page taps the master for its level meter). What plays through that gain
 * depends on the source's kind:
 *
 *   static     one AudioBufferSourceNode per play (a BufferSource is
 *              single-use): loop, playbackRate, start(0, offset).
 *   streaming  the queue, as a CHAIN of AudioBufferSourceNodes each started at
 *              the exact AudioContext time the previous one ends. Round 36:
 *              the old backend made one node for the buffer current at
 *              alSourcePlay and nothing else, and the engine starts its music
 *              stream with an EMPTY queue (play first, then four 64 KB chunks,
 *              then one per processed chunk), so the music never had a node
 *              at all. Now every alSourceQueueBuffers appends an entry; a play
 *              schedules the entries from the head the model names; a chunk
 *              queued while the stream plays is scheduled at the chain's end;
 *              an unqueue drops bookkeeping only (the node plays out); a stop
 *              cancels the chain and a later play re-schedules from the head.
 *
 * Two browser realities this has to respect:
 *   - An AudioContext starts suspended until a user gesture. resume() is
 *     asked for on every play; while the context is not running, stream
 *     chunks are left pending (the model has already retired them on the
 *     wall clock, so the game unqueues them and moves on) and the
 *     statechange handler schedules whatever is still pending when the
 *     context resumes -- the music picks up at the game's CURRENT position
 *     instead of replaying a backlog. A chain that has drifted more than
 *     ISAAC_AUDIO_MAX_LEAD seconds ahead of the context clock is trimmed for
 *     the same reason.
 *   - Nothing here may throw into the guest. Every entry point swallows its
 *     own errors: silence is a bad outcome, a trap in the middle of a lifted
 *     call is a worse one.
 *
 * ISAAC_AUDIO_TRACE=1 (the same switch as the model's trace) logs the
 * context, every scheduled node with its start time and duration on the
 * AudioContext clock, every stop/trim, and the resume replays. The lines go
 * through err(), which is the page's printErr: they land in the PAGE log
 * (web-run.log's page section, drive_audio.mjs's page.log), while the
 * model's isaac_log lines are console.warn (the console section); the two
 * carry their own clocks (model ms, AudioContext seconds).
 *
 * The bodies below are plain JS inside EM_JS; tests/recomp-audio.test.js
 * extracts them from this file and runs them in node against a fake
 * AudioContext, so keep each body self-contained (helpers hang off the
 * Module.isaacAudio object built in isaac_audio_js_init).
 */

#ifdef ISAAC_WEB
#include "isaac_host.h"

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

int isaac_audio_trace_on(void);

/* The backend state and its helpers. Built once, before the first buffer. */
EM_JS(void, isaac_audio_js_init, (int trace, double max_lead), {
  try {
    var A = Module.isaacAudio;
    if (A && A.ensureContext) { A.trace = !!trace; return; }
    /* the shipping page (play.mjs) makes Module.isaacAudio = { ctx, buffers,
     * sources } inside its Play click, so the context is born in a user
     * gesture; adopt whatever is there and add the rest */
    if (!A) A = Module.isaacAudio = {};
    A.ctx = A.ctx || null;
    A.master = A.master || null;
    A.buffers = A.buffers || new Map();
    A.sources = A.sources || new Map();
    A.trace = !!trace;
    A.maxLead = max_lead > 0 ? max_lead : 3.0;
    A.played = 0; A.scheduled = 0; A.trimmed = 0; A.deferred = 0; A.resumed = 0;
    A.log = function (msg) { if (A.trace) err("[isaac][audio-web] t=" + (A.ctx ? A.ctx.currentTime.toFixed(3) : "-") + " " + msg); };
    A.ensureContext = function () {
      if (A.master) return true;
      if (!A.ctx) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (!C) return false;
        A.ctx = new C();
      }
      A.master = A.ctx.createGain();
      A.master.connect(A.ctx.destination);
      A.ctx.addEventListener("statechange", function () {
        A.log("context " + A.ctx.state);
        if (A.ctx.state === "running") A.resumeAll();
      });
      A.log("context ready: " + A.ctx.sampleRate + " Hz, " + A.ctx.state);
      if (typeof Module.isaacAudioReady === "function") { try { Module.isaacAudioReady(A); } catch (e) {} }
      return true;
    };
    A.resume = function () { try { if (A.ctx && A.ctx.state === "suspended") A.ctx.resume(); } catch (e) {} };
    /* the per-source record: its gain node, the static node, the queue */
    A.source = function (src) {
      var s = A.sources.get(src);
      if (!s) {
        s = { id: src, gain: A.ctx.createGain(), node: null, entries: [], next: 0, playing: false, rate: 1, kind: "static" };
        s.gain.connect(A.master);
        A.sources.set(src, s);
      }
      return s;
    };
    /* schedule one queue entry at the chain's end (or now, whichever is later) */
    A.schedule = function (s, e, offset) {
      if (!e.ab) { e.done = true; return; }
      if (A.ctx.state !== "running") { A.deferred++; return; }     /* pending until the context runs */
      var now = A.ctx.currentTime;
      var at = s.next > now ? s.next : now;
      if (at - now > A.maxLead) { A.trim(s, now); at = s.next > now ? s.next : now; }
      var node = A.ctx.createBufferSource();
      node.buffer = e.ab;
      node.playbackRate.value = s.rate;
      node.connect(s.gain);
      var off = offset > 0 && offset < e.ab.duration ? offset : 0;
      node.start(at, off);
      e.node = node; e.at = at; e.dur = (e.ab.duration - off) / s.rate;
      s.next = at + e.dur;
      A.scheduled++;
      A.log("src " + s.id + " buffer " + e.id + " scheduled at " + at.toFixed(3) + " for " + e.dur.toFixed(3) + " s (chain end " + s.next.toFixed(3) + ", " + s.entries.length + " entries)");
    };
    /* drop every scheduled node that has not started yet: the chain re-anchors
     * at the end of the chunk playing right now (or at `now` if none is) */
    A.trim = function (s, now) {
      var n = 0, end = now;
      for (var i = 0; i < s.entries.length; i++) {
        var e = s.entries[i];
        if (!e.node) continue;
        if (e.at > now) { try { e.node.stop(); } catch (x) {} e.node = null; e.done = true; n++; }
        else if (e.at + e.dur > end) end = e.at + e.dur;
      }
      s.next = end;
      A.trimmed += n;
      A.log("src " + s.id + " chain " + n + " node(s) ahead of the clock trimmed, re-anchored at " + end.toFixed(3));
    };
    /* silence a source: every live node, the chain's clock */
    A.silence = function (s) {
      var n = 0;
      if (s.node) { try { s.node.stop(); } catch (x) {} s.node = null; n++; }
      for (var i = 0; i < s.entries.length; i++) {
        var e = s.entries[i];
        if (e.node) { try { e.node.stop(); } catch (x) {} e.node = null; n++; }
      }
      s.playing = false;
      s.next = 0;
      return n;
    };
    /* the context came back: whatever a playing stream still has pending goes on now */
    A.resumeAll = function () {
      A.sources.forEach(function (s) {
        if (!s.playing) return;
        var n = 0;
        for (var i = 0; i < s.entries.length; i++) {
          var e = s.entries[i];
          if (!e.node && !e.done) { A.schedule(s, e, 0); n++; }
        }
        A.resumed += n;
        if (n) A.log("src " + s.id + " resumed: " + n + " pending chunk(s) scheduled");
      });
    };
  } catch (e) { /* audio must never trap into the guest */ }
});

EM_JS(void, isaac_audio_js_buffer, (uint32_t id, const uint8_t *pcm, uint32_t bytes,
                                    int channels, int bits, int freq), {
  try {
    var A = Module.isaacAudio;
    if (!A || !A.ensureContext()) return;
    var frame = channels * (bits >> 3);
    var frames = frame ? Math.floor(bytes / frame) : 0;
    if (!frames || !freq) return;
    var ab = A.ctx.createBuffer(channels, frames, freq);
    for (var c = 0; c < channels; c++) {
      var out = ab.getChannelData(c);
      if (bits === 16) {
        for (var i = 0; i < frames; i++) {
          var o = pcm + (i * channels + c) * 2;
          var v = HEAPU8[o] | (HEAPU8[o + 1] << 8);
          if (v & 0x8000) v -= 0x10000;
          out[i] = v / 32768;
        }
      } else {
        for (var j = 0; j < frames; j++) out[j] = (HEAPU8[pcm + j * channels + c] - 128) / 128;
      }
    }
    A.buffers.set(id, ab);
  } catch (e) { /* audio must never trap into the guest */ }
});

/* alSourceQueueBuffers, one buffer at a time, in queue order */
EM_JS(void, isaac_audio_js_queue, (uint32_t src, uint32_t buffer), {
  try {
    var A = Module.isaacAudio;
    if (!A || !A.ctx) return;
    var s = A.source(src);
    s.kind = "stream";
    var e = { id: buffer, ab: A.buffers.get(buffer) || null, node: null, at: 0, dur: 0, done: false };
    s.entries.push(e);
    if (s.playing) A.schedule(s, e, 0);
  } catch (e) {}
});

/* alSourceUnqueueBuffers: the n oldest entries left the queue. Bookkeeping
 * only -- a node still scheduled keeps playing its data. */
EM_JS(void, isaac_audio_js_unqueue, (uint32_t src, uint32_t n), {
  try {
    var A = Module.isaacAudio;
    var s = A && A.sources.get(src);
    if (!s) return;
    s.entries.splice(0, n);
  } catch (e) {}
});

/* alSourcePlay. static: `buffer` from offset_sec; stream: the queue from entry
 * `head`, the first one from offset_sec (both 0 on a restart). */
EM_JS(void, isaac_audio_js_play, (uint32_t src, uint32_t buffer, float gain, float pitch,
                                  int looping, int streaming, uint32_t head, float offset_sec), {
  try {
    var A = Module.isaacAudio;
    if (!A || !A.ctx) return;
    A.resume();
    var s = A.source(src);
    s.gain.gain.value = gain;
    s.rate = pitch > 0.01 ? pitch : 1;
    A.silence(s);
    if (streaming) {
      s.kind = "stream";
      s.playing = true;
      s.next = A.ctx.currentTime;
      var n = 0;
      for (var i = 0; i < s.entries.length; i++) {
        var e = s.entries[i];
        e.node = null;
        e.done = i < head;
        if (i >= head) { A.schedule(s, e, i === head ? offset_sec : 0); n++; }
      }
      A.played++;
      A.log("src " + src + " play stream from entry " + head + " of " + s.entries.length + " (" + n + " scheduled, gain " + gain.toFixed(3) + ", rate " + s.rate + ", " + A.ctx.state + ")");
      return;
    }
    s.kind = "static";
    var ab = A.buffers.get(buffer);
    if (!ab) return;
    var node = A.ctx.createBufferSource();
    node.buffer = ab;
    node.loop = !!looping;
    node.playbackRate.value = s.rate;
    node.connect(s.gain);
    node.start(0, offset_sec > 0 ? offset_sec : 0);
    s.node = node;
    A.played++;
    A.log("src " + src + " play static buffer " + buffer + " (" + ab.duration.toFixed(3) + " s, gain " + gain.toFixed(3) + (looping ? ", looping" : "") + ", " + A.ctx.state + ")");
  } catch (e) {}
});

EM_JS(void, isaac_audio_js_stop, (uint32_t src), {
  try {
    var A = Module.isaacAudio;
    var s = A && A.sources.get(src);
    if (!s) return;
    var n = A.silence(s);
    if (n) A.log("src " + src + " stop: " + n + " node(s) stopped");
  } catch (e) {}
});

/* AL_BUFFER 0 or the source deleted: nothing of its queue is coming back */
EM_JS(void, isaac_audio_js_clear, (uint32_t src), {
  try {
    var A = Module.isaacAudio;
    var s = A && A.sources.get(src);
    if (!s) return;
    var n = A.silence(s);
    s.entries = [];
    s.kind = "static";
    if (n) A.log("src " + src + " cleared: " + n + " node(s) stopped");
  } catch (e) {}
});

/* alDeleteSources: the engine deletes a stream source with its queue still
 * on it (Close -> alDeleteSources, alDeleteBuffers); silence it and free
 * its gain node. */
EM_JS(void, isaac_audio_js_delete, (uint32_t src), {
  try {
    var A = Module.isaacAudio;
    var s = A && A.sources.get(src);
    if (!s) return;
    var n = A.silence(s);
    s.entries = [];
    try { s.gain.disconnect(); } catch (e) {}
    A.sources.delete(src);
    if (n) A.log("src " + src + " deleted: " + n + " node(s) stopped");
  } catch (e) {}
});

EM_JS(void, isaac_audio_js_gain, (uint32_t src, float gain), {
  try {
    var A = Module.isaacAudio;
    if (!A || !A.ctx) return;
    A.source(src).gain.gain.value = gain;
  } catch (e) {}
});

/* A pitch change applies to the static node at once and to the chunks a
 * stream schedules from here on; already scheduled chunks keep their slot. */
EM_JS(void, isaac_audio_js_pitch, (uint32_t src, float pitch), {
  try {
    var A = Module.isaacAudio;
    if (!A || !A.ctx) return;
    var s = A.source(src);
    s.rate = pitch > 0.01 ? pitch : 1;
    if (s.node) s.node.playbackRate.value = s.rate;
  } catch (e) {}
});

EM_JS(void, isaac_audio_js_drop, (uint32_t id), {
  try { if (Module.isaacAudio) Module.isaacAudio.buffers.delete(id); } catch (e) {}
});

EM_JS(int, isaac_audio_js_state, (void), {
  try {
    var A = Module.isaacAudio;
    if (!A || !A.ctx) return 0;
    return (A.ctx.state === "running" ? 1 : 2);
  } catch (e) { return 0; }
});

EM_JS(int, isaac_audio_js_stat, (int which), {
  try {
    var A = Module.isaacAudio;
    if (!A) return 0;
    return which === 0 ? A.scheduled : which === 1 ? A.trimmed : which === 2 ? A.deferred : which === 3 ? A.resumed : A.played;
  } catch (e) { return 0; }
});

/* ---- the hooks host_audio.c calls (strong here, weak there) ------------- */

static int g_inited;
static void web_init(void) {
    if (g_inited) return;
    g_inited = 1;
    double lead = 3.0;
    const char *e = getenv("ISAAC_AUDIO_MAX_LEAD");
    if (e && *e) lead = atof(e);
    isaac_audio_js_init(isaac_audio_trace_on(), lead);
}

void isaac_audio_backend_buffer(uint32_t id, const void *pcm, uint32_t bytes,
                                int channels, int bits, int freq) {
    web_init();
    isaac_audio_js_buffer(id, (const uint8_t *)pcm, bytes, channels, bits, freq);
}

void isaac_audio_backend_play(uint32_t src, uint32_t buffer, float gain, float pitch,
                              int looping, int streaming, uint32_t head, float offset_sec) {
    web_init();
    isaac_audio_js_play(src, buffer, gain, pitch, looping, streaming, head, offset_sec);
}

void isaac_audio_backend_queue(uint32_t src, uint32_t buffer) { web_init(); isaac_audio_js_queue(src, buffer); }
void isaac_audio_backend_unqueue(uint32_t src, uint32_t n) { isaac_audio_js_unqueue(src, n); }
void isaac_audio_backend_clear(uint32_t src) { isaac_audio_js_clear(src); }
void isaac_audio_backend_delete(uint32_t src) { isaac_audio_js_delete(src); }
void isaac_audio_backend_stop(uint32_t src) { isaac_audio_js_stop(src); }
void isaac_audio_backend_pause(uint32_t src) { isaac_audio_js_stop(src); }
void isaac_audio_backend_gain(uint32_t src, float gain) { web_init(); isaac_audio_js_gain(src, gain); }
void isaac_audio_backend_pitch(uint32_t src, float pitch) { web_init(); isaac_audio_js_pitch(src, pitch); }
void isaac_audio_backend_drop_buffer(uint32_t id) { isaac_audio_js_drop(id); }

/* Reported with the stub report so a run says whether the page ever got an
 * AudioContext out of suspension -- silence with a suspended context is an
 * autoplay-policy problem, not a pipeline one -- and how the streams fared. */
void isaac_audio_web_report(void) {
    int st = isaac_audio_js_state();
    isaac_log("[isaac][audio] WebAudio context: %s",
              st == 1 ? "running" : st == 2 ? "suspended (autoplay policy)" : "never created");
    if (st)
        isaac_log("[isaac][audio] WebAudio backend: %d node(s) played, %d stream chunk(s) scheduled, "
                  "%d trimmed (chain ahead of the clock), %d deferred (context not running), %d scheduled on resume",
                  isaac_audio_js_stat(4), isaac_audio_js_stat(0), isaac_audio_js_stat(1),
                  isaac_audio_js_stat(2), isaac_audio_js_stat(3));
}
#endif /* ISAAC_WEB */
