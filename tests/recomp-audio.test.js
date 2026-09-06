// Round 36: music. The OpenAL surface has two halves -- the object model in
// host_audio.c (states, queues, the clock that retires buffers) and the
// WebAudio backend in host_audio_web.c (what is audible in the browser). The
// music path streams: alSourcePlay on an EMPTY source, then four 64 KiB
// chunks queued one by one by the engine's OpenAL thread, then one chunk per
// processed chunk for as long as the track runs. Rounds 22-35 had the model
// answering "processed" off the wall clock while the backend was handed ONE
// buffer at alSourcePlay (the queue head, 0 for that first play) and never
// heard of a queued buffer at all: the title theme never had an
// AudioBufferSourceNode, the census said 300 chunks queued, and nothing was
// audible.
//
// Three layers of pins:
//   1. the model's OpenAL Soft rules and the backend contract run natively in
//      the host selftest (build-selftest.json: the `audio:` checks, a fake
//      clock, counted hooks);
//   2. the backend's JS bodies are extracted from the EM_JS blocks in
//      host_audio_web.c and run HERE against a fake AudioContext: a queue
//      becomes a chain of nodes started back to back on the context clock,
//      a queue while playing lands at the chain's end, an unqueue drops
//      bookkeeping only, a stop cancels, a play re-schedules from the head,
//      a suspended context defers and a resume replays, a chain far ahead of
//      the clock is trimmed;
//   3. the page's level meter and the driver that reads it, by source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostSrc = join(root, 'scripts', 'recomp', 'host', 'src');
const web = join(root, 'scripts', 'recomp', 'web');
const modelSrc = readFileSync(join(hostSrc, 'host_audio.c'), 'utf8');
const backendSrc = readFileSync(join(hostSrc, 'host_audio_web.c'), 'utf8');

// ---- EM_JS extraction -------------------------------------------------------
// EM_JS(ret, name, (c params), { body });  -- the body is plain JS. Braces are
// matched with string literals skipped, so a "{" inside a message is fine.
function extractEmJs(src) {
  const out = new Map();
  let at = 0;
  for (;;) {
    const i = src.indexOf('EM_JS(', at);
    if (i < 0) break;
    const head = src.slice(i + 6, src.indexOf('{', i));
    const parts = head.split(',');
    const name = parts[1].trim();
    const paramText = head.slice(head.indexOf('(') + 1, head.lastIndexOf(')'));
    const params = paramText.trim() === 'void' || !paramText.trim() ? []
      : paramText.split(',').map((p) => p.trim().split(/[\s*]+/).pop());
    let j = src.indexOf('{', i), depth = 0, inStr = null;
    const start = j;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (inStr) {
        if (ch === '\\') { j++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    out.set(name, { params, body: src.slice(start + 1, j) });
    at = j;
  }
  return out;
}

// ---- a fake WebAudio ----------------------------------------------------------
class FakeNode {
  constructor(ctx) { this.context = ctx; this.outputs = []; }
  connect(dst) { this.outputs.push(dst); return dst; }
  disconnect() { this.outputs = []; }
}
class FakeGain extends FakeNode {
  constructor(ctx) { super(ctx); this.gain = { value: 1 }; }
}
class FakeBufferSource extends FakeNode {
  constructor(ctx) { super(ctx); this.buffer = null; this.loop = false; this.playbackRate = { value: 1 }; this.started = null; this.stopped = false; }
  start(when = 0, offset = 0) { this.started = { when, offset }; this.context.nodes.push(this); }
  stop() { if (!this.started) throw new Error('InvalidStateError'); this.stopped = true; }
}
class FakeContext {
  constructor() {
    this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000;
    this.destination = new FakeNode(this); this.destination.isDestination = true;
    this.nodes = []; this.listeners = {}; this.resumes = 0;
  }
  createGain() { return new FakeGain(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createBuffer(channels, frames, rate) {
    const ch = Array.from({ length: channels }, () => new Float32Array(frames));
    return { numberOfChannels: channels, length: frames, sampleRate: rate, duration: frames / rate, getChannelData: (c) => ch[c] };
  }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  setState(s) { this.state = s; for (const fn of this.listeners.statechange || []) fn(); }
  resume() { this.resumes += 1; return Promise.resolve(); }
}

// Bind every EM_JS body to one Module/HEAPU8/window and return callables.
function backend({ heap, trace = 0, maxLead = 3 } = {}) {
  const fns = extractEmJs(backendSrc);
  const Module = {};
  const errs = [];
  const err = (s) => errs.push(String(s));
  const window = { AudioContext: FakeContext };
  const HEAPU8 = heap || new Uint8Array(65536);
  const api = {};
  for (const [name, { params, body }] of fns) {
    const f = new Function('Module', 'HEAPU8', 'err', 'window', ...params, body);
    api[name.replace(/^isaac_audio_js_/, '')] = (...args) => f(Module, HEAPU8, err, window, ...args);
  }
  api.init(trace, maxLead);
  api.Module = Module; api.errs = errs; api.HEAPU8 = HEAPU8;
  return api;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// 100 ms of stereo16 at 48 kHz: 4800 frames, 19200 bytes, written at `ptr`
function stereoChunk(api, id, ptr, frames = 4800, sample = 0x4000) {
  for (let i = 0; i < frames * 2; i++) { api.HEAPU8[ptr + i * 2] = sample & 0xff; api.HEAPU8[ptr + i * 2 + 1] = (sample >> 8) & 0xff; }
  api.buffer(id, ptr, frames * 4, 2, 16, 48000);
  return frames / 48000;
}

test('EM_JS extraction finds every backend entry point with its parameters', () => {
  const fns = extractEmJs(backendSrc);
  for (const n of ['isaac_audio_js_init', 'isaac_audio_js_buffer', 'isaac_audio_js_queue', 'isaac_audio_js_unqueue',
                   'isaac_audio_js_play', 'isaac_audio_js_stop', 'isaac_audio_js_clear', 'isaac_audio_js_gain',
                   'isaac_audio_js_pitch', 'isaac_audio_js_drop', 'isaac_audio_js_state', 'isaac_audio_js_stat'])
    assert.ok(fns.has(n), `${n} extracted`);
  assert.deepEqual(fns.get('isaac_audio_js_play').params, ['src', 'buffer', 'gain', 'pitch', 'looping', 'streaming', 'head', 'offset_sec']);
  assert.deepEqual(fns.get('isaac_audio_js_buffer').params, ['id', 'pcm', 'bytes', 'channels', 'bits', 'freq']);
  assert.deepEqual(fns.get('isaac_audio_js_state').params, []);
});

test('PCM upload: interleaved int16 is de-interleaved into float channels through a master node', () => {
  const api = backend();
  const dur = stereoChunk(api, 1, 1024);
  const A = api.Module.isaacAudio;
  assert.ok(A.ctx && A.master, 'the context and the master gain exist after the first upload');
  assert.deepEqual(A.master.outputs, [A.ctx.destination], 'master -> destination');
  const ab = A.buffers.get(1);
  assert.ok(near(ab.duration, dur), 'duration follows frames / rate');
  assert.ok(near(ab.getChannelData(0)[0], 0.5) && near(ab.getChannelData(1)[4799], 0.5), '0x4000 -> 0.5 on both channels');
  // a negative sample: 0x8000 -> -1
  api.HEAPU8[2048] = 0x00; api.HEAPU8[2049] = 0x80;
  api.buffer(2, 2048, 4, 1, 16, 48000);
  assert.ok(near(A.buffers.get(2).getChannelData(0)[0], -1), 'int16 -32768 -> -1.0');
  api.drop(2);
  assert.ok(!A.buffers.has(2), 'alDeleteBuffers drops the AudioBuffer');
});

test('a streaming queue becomes a chain of nodes started back to back on the context clock', () => {
  const api = backend();
  const d = stereoChunk(api, 1, 1024); stereoChunk(api, 2, 1024); stereoChunk(api, 3, 1024);
  const A = api.Module.isaacAudio, ctx = A.ctx;
  // the engine's order: play on the empty source is not forwarded by the model;
  // the first queued chunk, then play, then the rest queued while playing
  api.queue(10, 1);
  assert.equal(ctx.nodes.length, 0, 'a queued chunk does not play until the source plays');
  api.play(10, 1, 0.6, 1, 0, 1, 0, 0);
  api.queue(10, 2);
  api.queue(10, 3);
  const s = A.sources.get(10);
  assert.equal(s.kind, 'stream');
  assert.equal(ctx.nodes.length, 3, 'three nodes, one per chunk');
  assert.ok(near(ctx.nodes[0].started.when, 0) && near(ctx.nodes[1].started.when, d) && near(ctx.nodes[2].started.when, 2 * d),
    `starts at 0, ${d}, ${2 * d}`);
  assert.ok(near(s.next, 3 * d), 'the chain end is the sum of the durations');
  assert.ok(ctx.nodes.every((n) => n.outputs[0] === s.gain), 'every node feeds the source gain');
  assert.equal(s.gain.gain.value, 0.6, 'the play carried the gain');
  assert.deepEqual(s.gain.outputs, [A.master], 'the source gain feeds the master');
  assert.equal(api.stat(0), 3, 'scheduled census');
  // the wall clock moved on; the model retired the first chunk; the game unqueues it
  ctx.currentTime = 0.15;
  api.unqueue(10, 1);
  assert.equal(s.entries.length, 2, 'bookkeeping dropped');
  assert.ok(!ctx.nodes[0].stopped, 'the node itself was not stopped (it plays out)');
  // the refill lands at the chain end, not at "now"
  api.buffer(1, 1024, 19200, 2, 16, 48000);
  api.queue(10, 1);
  assert.equal(ctx.nodes.length, 4);
  assert.ok(near(ctx.nodes[3].started.when, 3 * d), 'the refilled chunk starts when the previous one ends');
  assert.equal(ctx.nodes[3].buffer, A.buffers.get(1), 'with the freshly uploaded AudioBuffer');
  // gain while playing
  api.gain(10, 0.25);
  assert.equal(s.gain.gain.value, 0.25);
  // stop cancels everything scheduled; a play from the head re-schedules from now
  api.stop(10);
  assert.ok(ctx.nodes.slice(1).every((n) => n.stopped), 'stop cancelled the live chain');
  assert.equal(s.playing, false);
  ctx.currentTime = 0.5;
  api.play(10, 2, 0.25, 1, 0, 1, 0, 0);
  const again = ctx.nodes.slice(4);
  assert.equal(again.length, 3, 'the three still-queued entries are rescheduled');
  assert.ok(near(again[0].started.when, 0.5) && near(again[1].started.when, 0.5 + d) && near(again[2].started.when, 0.5 + 2 * d),
    'from now, back to back');
  // a resume from paused: from entry 1 at an offset
  api.stop(10);
  ctx.currentTime = 1;
  api.play(10, 3, 0.25, 1, 0, 1, 1, 0.04);
  const resumed = ctx.nodes.slice(7);
  assert.equal(resumed.length, 2, 'entries from the head index only');
  assert.ok(near(resumed[0].started.when, 1) && near(resumed[0].started.offset, 0.04), 'the current entry from its offset');
  assert.ok(near(resumed[1].started.when, 1 + d - 0.04), 'the next one when the shortened one ends');
  assert.equal(s.entries[0].done, true, 'the entry before the head is done');
  api.clear(10);
  assert.equal(s.entries.length, 0, 'AL_BUFFER 0 / delete forgets the queue');
  assert.ok(resumed.every((n) => n.stopped), 'and silences it');
});

test('a suspended context defers chunks; the resume schedules what is still pending, from now', () => {
  const api = backend();
  const d = stereoChunk(api, 1, 1024); stereoChunk(api, 2, 1024);
  const A = api.Module.isaacAudio, ctx = A.ctx;
  ctx.setState('suspended');
  api.queue(20, 1);
  api.play(20, 1, 1, 1, 0, 1, 0, 0);
  api.queue(20, 2);
  assert.equal(ctx.nodes.length, 0, 'nothing scheduled while suspended');
  assert.equal(api.stat(2), 2, 'two deferred');
  assert.equal(ctx.resumes, 1, 'the play asked the context to resume');
  // the game moved on: the model retired chunk 1 and the game unqueued it
  api.unqueue(20, 1);
  ctx.currentTime = 7;
  ctx.setState('running');
  assert.equal(ctx.nodes.length, 1, 'only the still-queued chunk is scheduled on resume');
  assert.ok(near(ctx.nodes[0].started.when, 7), 'at the current time, not at a stale chain end');
  assert.equal(ctx.nodes[0].buffer, A.buffers.get(2));
  assert.equal(api.stat(3), 1, 'resumed census');
  assert.ok(near(A.sources.get(20).next, 7 + d));
});

test('a chain that runs too far ahead of the clock is trimmed and re-anchored after the playing chunk', () => {
  const api = backend({ maxLead: 0.25 });
  const d = stereoChunk(api, 1, 1024);
  const A = api.Module.isaacAudio, ctx = A.ctx;
  api.queue(30, 1);
  api.play(30, 1, 1, 1, 0, 1, 0, 0);
  for (let i = 0; i < 3; i++) api.queue(30, 1);      // 0.1, 0.2, then 0.3 > 0.25 ahead
  const s = A.sources.get(30);
  assert.equal(api.stat(1), 2, 'the two not-yet-started nodes were trimmed');
  assert.ok(ctx.nodes[1].stopped && ctx.nodes[2].stopped && !ctx.nodes[0].stopped, 'the playing one stays');
  assert.ok(near(ctx.nodes[3].started.when, d), 'the new chunk starts when the playing one ends, not on top of it');
  assert.ok(near(s.next, 2 * d));
  assert.equal(s.entries.filter((e) => e.done).length, 2, 'trimmed entries are done until a play rewinds them');
});

test('static sources: one node per play, loop, pitch, restart, stop', () => {
  const api = backend();
  stereoChunk(api, 1, 1024);
  const A = api.Module.isaacAudio, ctx = A.ctx;
  api.play(40, 1, 0.3, 1.5, 1, 0, 0, 0);
  const s = A.sources.get(40);
  assert.equal(s.kind, 'static');
  assert.equal(ctx.nodes.length, 1);
  assert.ok(ctx.nodes[0].loop === true && near(ctx.nodes[0].playbackRate.value, 1.5) && near(s.gain.gain.value, 0.3));
  assert.equal(ctx.nodes[0].outputs[0], s.gain);
  api.pitch(40, 2);
  assert.ok(near(ctx.nodes[0].playbackRate.value, 2), 'a pitch change reaches the live node');
  api.play(40, 1, 0.3, 1, 0, 0, 0, 0.02);
  assert.ok(ctx.nodes[0].stopped, 'a replay stops the previous node');
  assert.ok(near(ctx.nodes[1].started.offset, 0.02) && ctx.nodes[1].loop === false, 'the new node from its offset');
  api.stop(40);
  assert.ok(ctx.nodes[1].stopped);
  api.play(40, 99, 1, 1, 0, 0, 0, 0);
  assert.equal(ctx.nodes.length, 2, 'an unknown buffer plays nothing and throws nothing');
  assert.equal(api.stat(4), 2, 'played census counts the two real plays');
});

test('the backend never throws into the guest and reports the context state', () => {
  const api = backend();
  assert.equal(api.state(), 0, 'no context yet');
  assert.doesNotThrow(() => { api.queue(1, 1); api.play(1, 1, 1, 1, 0, 1, 0, 0); api.stop(1); api.unqueue(1, 3); api.gain(1, 1); });
  stereoChunk(api, 1, 1024);
  assert.equal(api.state(), 1, 'running');
  api.Module.isaacAudio.ctx.setState('suspended');
  assert.equal(api.state(), 2, 'suspended');
  const noAudio = (() => {
    const fns = extractEmJs(backendSrc);
    const { params, body } = fns.get('isaac_audio_js_init');
    const Module = {};
    new Function('Module', 'HEAPU8', 'err', 'window', ...params, body)(Module, new Uint8Array(16), () => {}, {}, 0, 3);
    const b = fns.get('isaac_audio_js_buffer');
    return () => new Function('Module', 'HEAPU8', 'err', 'window', ...b.params, b.body)(Module, new Uint8Array(16), () => {}, {}, 1, 0, 4, 1, 16, 48000);
  })();
  assert.doesNotThrow(noAudio, 'a page with no AudioContext at all stays silent, not broken');
});

test('trace: the JS side logs schedules under the same switch as the model', () => {
  const api = backend({ trace: 1 });
  stereoChunk(api, 1, 1024);
  api.queue(50, 1); api.play(50, 1, 1, 1, 0, 1, 0, 0);
  assert.ok(api.errs.some((l) => /\[isaac\]\[audio-web\] .*context ready: 48000 Hz, running/.test(l)), 'context line');
  assert.ok(api.errs.some((l) => /src 50 buffer 1 scheduled at 0\.000 for 0\.100 s/.test(l)), 'one line per scheduled chunk with time and duration');
  assert.ok(api.errs.some((l) => /src 50 play stream from entry 0 of 1/.test(l)), 'the play line');
  assert.ok(backendSrc.includes('isaac_audio_js_init(isaac_audio_trace_on(), lead)'), 'the C side passes ISAAC_AUDIO_TRACE through');
  assert.ok(modelSrc.includes('getenv("ISAAC_AUDIO_TRACE")') && modelSrc.includes('int isaac_audio_trace_on(void)'), 'the model owns the switch');
});

test('the model follows OpenAL Soft where the music path needs it (source pins + the native selftest)', () => {
  // the streaming contract between the model and its backends
  for (const hook of ['isaac_audio_backend_queue(uint32_t src, uint32_t buffer)', 'isaac_audio_backend_unqueue(uint32_t src, uint32_t n)',
                      'isaac_audio_backend_clear(uint32_t src)', 'isaac_audio_backend_pitch(uint32_t src, float pitch)',
                      'int looping, int streaming, uint32_t head, float offset_sec'])
    assert.ok(modelSrc.includes(hook), `weak hook: ${hook}`);
  assert.ok(modelSrc.includes('__attribute__((weak)) double isaac_audio_clock_ms(void)'), 'the clock is overridable (the selftest sets it)');
  // the rules, by their code
  assert.ok(/case AL_BUFFERS_QUEUED:\s+return \(int32_t\)s->qn;/.test(modelSrc), 'AL_BUFFERS_QUEUED is the whole queue');
  assert.ok(/void isaac_audio_stop[\s\S]*?s->processed = s->qn;/.test(modelSrc), 'a stop marks every queued buffer processed');
  assert.ok(/void isaac_audio_play[\s\S]*?s->processed = 0;[\s\S]*?s->state = AL_STOPPED;\s+\+\+g_stat_empty_plays;/.test(modelSrc),
    'a play restarts at the head, and stops at once with nothing to play');
  assert.ok(/uint32_t isaac_audio_unqueue[\s\S]*?if \(n > s->processed\) \{/.test(modelSrc), 'an unqueue past the processed count takes nothing');
  assert.ok(/case AL_BUFFER:[\s\S]*?if \(s->state == AL_PLAYING \|\| s->state == AL_PAUSED\) \{/.test(modelSrc), 'AL_BUFFER is refused on a playing/paused source');
  assert.ok(modelSrc.includes('isaac_audio_backend_queue(src, id);') && modelSrc.includes('isaac_audio_backend_unqueue(src, take);'),
    'every queue and unqueue reaches the backend');
  // the web backend is entirely under ISAAC_WEB and defines every strong hook
  assert.ok(backendSrc.includes('#ifdef ISAAC_WEB') && backendSrc.trimEnd().endsWith('#endif /* ISAAC_WEB */'));
  for (const h of ['isaac_audio_backend_queue', 'isaac_audio_backend_unqueue', 'isaac_audio_backend_clear', 'isaac_audio_backend_play',
                   'isaac_audio_backend_pitch', 'isaac_audio_backend_gain', 'isaac_audio_backend_stop'])
    assert.ok(new RegExp(`^void ${h}\\(`, 'm').test(backendSrc), `strong web hook ${h}`);
  // the native selftest ran the model on the fake clock
  const json = join(root, 'output', 'recomp', 'host', 'build-selftest.json');
  if (!existsSync(json)) return;
  const b = JSON.parse(readFileSync(json, 'utf8'));
  const audio = (b.run.output || []).filter((l) => /^(ok|FAIL) {2,}audio: /.test(l));
  assert.ok(audio.length >= 18, `the selftest ran the audio section (${audio.length} checks)`);
  assert.deepEqual(audio.filter((l) => l.startsWith('FAIL')), [], 'and every audio check passed');
  for (const want of ['a play with nothing queued stops at once', 'a stop marks every queued buffer processed',
                      'a play from stopped restarts at the head of the queue', 'AL_BUFFERS_QUEUED still counts the whole queue',
                      'resumes the current entry at its offset'])
    assert.ok(audio.some((l) => l.includes(want)), `selftest: ${want}`);
});

test('the page taps the master output and the driver reads it', () => {
  const page = readFileSync(join(web, 'boot_web.mjs'), 'utf8');
  assert.ok(page.includes('cfg.isaacAudioReady = (A) =>'), 'the backend announces its context to the page');
  assert.ok(/createAnalyser\(\)[\s\S]*?A\.master\.disconnect\(\);[\s\S]*?A\.master\.connect\(an\);[\s\S]*?an\.connect\(A\.ctx\.destination\)/.test(page),
    'the analyser sits between the master and the destination');
  assert.ok(page.includes('window.isaacAudioLevel = () =>') && page.includes('getFloatTimeDomainData'), 'window.isaacAudioLevel reads the analyser');
  assert.ok(backendSrc.includes('Module.isaacAudioReady(A)') && backendSrc.includes('A.master = A.ctx.createGain();'), 'the backend side of that handshake');
  const drive = readFileSync(join(web, 'drive_audio.mjs'), 'utf8');
  assert.ok(drive.includes('window.isaacAudioLevel()') && drive.includes('isaacAudioLevelFallback'), 'the driver prefers the page tap and falls back to its own');
  assert.ok(drive.includes("page.mouse.click(") && drive.includes("keyboard.down('Enter')"), 'a click to unlock audio, held Enters');
  assert.ok(/aboveThreshold >= 0\.8/.test(drive), 'the verdict is sustained energy, not a single blip');
});
