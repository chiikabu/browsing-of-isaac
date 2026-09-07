// play.mjs -- the shipping page (round 34). The pipeline is boot_web.mjs,
// unchanged: this script draws the loading screen, the Play button, the
// canvas chrome, the saves menu and the error panel around it, and hands the
// pipeline a few hooks through window.isaacPageHooks before importing it:
//   url(u)            every synchronous fetch the RAM-FS makes (the windowed
//                     archive reads during play) is rewritten: the page's own
//                     directory as the root, ?v=<sha256 prefix> from dist.json
//                     so the server may answer `immutable`
//   fetchBytes(u)     the boot stages (memory image, index, the six eagerly
//                     seeded archives, the Lua) fetched asynchronously with a
//                     byte-level progress bar
//   instantiateWasm   the module streamed through a counting ReadableStream
//   onLog(line)       the stage markers and the error triggers
//   beforeMain(m)     awaited right before main: the Play click (a user gesture,
//                     so the AudioContext the AL shim creates starts running)
// Defaults: ISAAC_YIELD=1 (live page, JSPI) and no frame budget, handed to the
// pipeline as hooks.params rather than written into the URL. ?frames=N ends the run after N
// frames (the drivers), ?autoplay=1 skips the Play button (headless runs),
// ?persist=0 turns the save store off, ISAAC_*=... goes into the module's ENV.
const $ = (id) => document.getElementById(id);
import { createEditFileMenu, createPaperMenu } from './menu_overlay.mjs';
import { zipStore, unzip } from './zip.mjs';
import { createModsMenu, openModDb, listMods, MODS_DB } from './mods.mjs';
const ROOT = new URL('.', location.href).pathname.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
// The pipeline's defaults: ISAAC_YIELD=1 selects the live page and, with no
// frames=, an unlimited budget. Applied through hooks.params (round 76) rather
// than by rewriting the address bar, which used to leave ?ISAAC_YIELD=1 in a
// URL nobody asked for.
const pageDefaults = {};
if (!params.has('ISAAC_YIELD')) { params.set('ISAAC_YIELD', '1'); pageDefaults.ISAAC_YIELD = '1'; }
const AUTOPLAY = params.get('autoplay') !== '0';   // the page starts on its own; autoplay=0 keeps the Play button (a gesture before any audio)
const PERSIST = params.get('persist') !== '0';

// the six archives boot_web.mjs seeds eagerly (its `seed packed archives`
// stage); the rest of resources/packed is registered lazily and read as
// slices once the game runs. Pinned against boot_web.mjs by tests/recomp-ship.test.js.
const EAGER_ARCHIVES = ['graphics.a', 'config.a', 'fonts.a', 'animations.a', 'rooms.a', 'sfx.a'];
const SAVE_DB = 'isaac-saves', SAVE_STORE = 'files';      // the pipeline's IndexedDB store (boot_web.mjs), same pin

const canvas = $('canvas'), overlay = $('overlay'), playBtn = $('play'), statusEl = $('status'), streamingEl = $('streaming');
// opt-in chrome (round 51): ?stats=1 shows the live status line, ?saves=1 the
// saves button; the page is otherwise the game alone, and a click anywhere
// gives the canvas the keyboard
// Round 82: the loading screen is black, one bar and one short line. The named
// stages, their byte counts and the machine string are instruments, and they
// live where the rest of the page's instruments do.
const STATS = params.get('stats') === '1';
if (STATS) { $('fps').hidden = false; $('stages').hidden = false; }
if (params.get('saves') === '1') $('saves-btn').hidden = false;
document.addEventListener('pointerdown', () => { if (!$('saves').open) canvas.focus(); });
// F toggles fullscreen on the stage (the keydown is the gesture requestFullscreen
// needs); the key still reaches the game, which does not bind F by default
const toggleFullscreen = () => {
  const stage = $('stage');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (stage.requestFullscreen) stage.requestFullscreen().then(() => canvas.focus()).catch(() => {});
};
// Escape is the game's own back key, and the browser takes it to leave
// fullscreen. Keyboard Lock is the sanctioned way to ask for it back: while
// fullscreen, the key reaches the page, and a HELD Escape still leaves, so the
// way out is still there. Chrome and Edge have it; elsewhere nothing changes.
document.addEventListener('fullscreenchange', () => {
  const kb = navigator.keyboard;
  if (!kb || !kb.lock) return;
  if (document.fullscreenElement) kb.lock(['Escape']).catch(() => {});
  else try { kb.unlock(); } catch { /* not held */ }
});
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'KeyF' && !ev.repeat && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !$('saves').open && !(window.isaacEditFileMenu && window.isaacEditFileMenu.isOpen())) toggleFullscreen();
  // N flips the FPS readout (round 52c-e; unbound in the game's default keys); the key still reaches the game
  if (ev.code === 'KeyN' && !ev.repeat && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !$('saves').open && window.isaacEditFileMenu && !window.isaacEditFileMenu.isOpen()) window.isaacEditFileMenu.toggleFps();
});
const mb = (n) => (n / 1048576).toFixed(1);
const fmtBytes = (n) => n >= 1048576 ? `${mb(n)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;

// ---- the loading screen -------------------------------------------------------
const stages = {
  module: { total: 0, received: 0, done: false },
  image: { total: 0, received: 0, done: false },
  archives: { total: 0, received: 0, done: false },
  // round 78: a chunked build fetches the same bytes out of three dozen files.
  // Counted here, and the row stays hidden on a build with no chunks.
  chunks: { total: 0, received: 0, done: false, unit: 'count' },
  boot: { total: 1, received: 0, done: false },
};
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    for (const [name, s] of Object.entries(stages)) {
      const p = $(`p-${name}`), b = $(`b-${name}`), n = $(`n-${name}`);
      if (!p || !b || !n) continue;
      if (s.unit === 'count' && !s.total) { p.hidden = n.hidden = b.hidden = true; continue; }
      if (s.unit === 'count') p.hidden = n.hidden = b.hidden = false;
      if (s.total) { p.max = s.total; p.value = s.done ? s.total : Math.min(s.received, s.total); }
      else if (s.done) { p.max = 1; p.value = 1; } else p.removeAttribute('value');
      b.textContent = name === 'boot' ? (s.done ? 'done' : s.received ? 'running' : '')
        : s.unit === 'count' ? `${s.received} / ${s.total}`
        : s.total ? `${mb(s.done ? s.total : s.received)} / ${mb(s.total)} MB` : (s.received ? `${mb(s.received)} MB` : '');
      n.className = 'name' + (s.done ? ' done' : s.received ? ' active' : '');
    }
    // the one bar: the bytes of the three fetch stages, the boot as the last per
    // cent. On a chunked build the chunk count is the better measure early on,
    // because a byte total is not known until the piece holding it has arrived,
    // so the bar takes whichever of the two is further along.
    let tot = 0, got = 0;
    for (const name of ['module', 'image', 'archives']) { const s = stages[name]; if (s.total) { tot += s.total; got += s.done ? s.total : Math.min(s.received, s.total); } }
    const byBytes = tot ? 100 * got / tot : 0;
    const c = stages.chunks;
    const byChunks = c.total ? 100 * Math.min(c.received, c.total) / c.total : 0;
    const pct = stages.boot.done ? 100 : Math.min(99, Math.max(byBytes, byChunks));
    $('bar-fill').style.width = `${pct.toFixed(1)}%`;
  });
}
// The line under the bar. `text` is what the page has to say; the detail -- an
// engine stage name, a path, an error -- goes in the tooltip and, under ?stats=1,
// on the line itself. A loading screen is not the place for internals.
function setStatus(text, detail) {
  statusEl.textContent = STATS && detail ? detail : text;
  statusEl.title = detail || text;
}

// ---- the portable provider (round 70) ----------------------------------------
// A build with no server sets window.isaacPortable before this module runs: it
// carries the manifest and the index, and answers a window either with a URL (the
// chunked build, so the reader Worker still fetches in parallel) or with bytes (the
// single-file build, which has them inline). Absent, everything below is unchanged.
const portable = (typeof window !== 'undefined' && window.isaacPortable) || null;

// ---- manifest + index: the totals, the versions ------------------------------
let manifest = null;
if (portable) manifest = portable.manifest || null;
else try { manifest = await (await fetch(`${ROOT}/dist.json`, { cache: 'no-cache' })).json(); } catch { manifest = null; }
const fileInfo = new Map((manifest && manifest.files || []).map((f) => [f.path, f]));
const sizeOf = (rel) => { const f = fileInfo.get(rel); return f ? f.size : 0; };
const versionOf = (rel) => { const f = fileInfo.get(rel); return f && f.sha256 ? f.sha256.slice(0, 16) : null; };
// a pipeline URL ('/instance/x?off=1&len=2') -> the served URL under this page's directory, versioned
function rewrite(url) {
  const [path, query] = url.split('?');
  const rel = path.replace(/^\//, '');
  const v = versionOf(rel);
  const q = (query ? query + '&' : '') + (v && !/(^|&)v=/.test(query || '') ? `v=${v}` : '');
  return `${ROOT}/${rel}${q ? '?' + q.replace(/&$/, '') : ''}`;
}
let indexBytes = null, index = [];
if (portable) {
  index = portable.index || [];
  indexBytes = new TextEncoder().encode(JSON.stringify(index));
} else try {
  indexBytes = new Uint8Array(await (await fetch(rewrite('/instance_index.json'), { cache: 'no-cache' })).arrayBuffer());
  index = JSON.parse(new TextDecoder().decode(indexBytes));
} catch (e) { setStatus('loading', `instance_index.json: ${e.message}`); }
const indexSize = new Map(index.map((e) => [e.p, e.s]));
stages.module.total = sizeOf('boot.wasm');
stages.image.total = sizeOf('isaac.segs.bin');
stages.archives.total = EAGER_ARCHIVES.reduce((s, n) => s + (indexSize.get(`resources/packed/${n}`) || 0), 0)
  + index.filter((e) => e.p.startsWith('resources/scripts/')).reduce((s, e) => s + e.s, 0);
const stageFor = (rel) => rel === 'isaac.segs.bin' ? stages.image
  : rel.startsWith('instance/resources/packed/') || rel.startsWith('instance/resources/scripts/') ? stages.archives : null;
render();
if (portable) setStatus(portable.status || 'loading');
else if (location.protocol === 'file:') setStatus('needs a server', 'this page needs a server (node scripts/recomp/web/serve_dist.mjs <dist>): the game reads its archives as byte slices');
else setStatus('loading', manifest ? null : 'no dist.json: sizes unknown');

// ---- the hooks -----------------------------------------------------------------
let streamed = 0, streamedRequests = 0;
const hooks = {};
hooks.params = pageDefaults;
// a single-file build answers with bytes, not URLs: the reader Worker would have
// nothing to fetch, so it is not started
hooks.noReader = !!(portable && !portable.urlFor);
// round 77: a chunked build says which chunk it is on. Hook this before ready:
// when ranges cannot be trusted, ready waits until every chunk is fetched, and
// the status line is the only progress that exists for that wait.
if (portable && portable.chunks) {
  stages.chunks.total = portable.chunks;
  // round 82: the grid is an instrument. It used to be shown here, which put all
  // five rows and their byte counts back on the loading screen of every chunked
  // build -- the one build that is not a development one.
  render();
  window.__isaacPortableData.onChunk = (got, total) => {
    stages.chunks.received = got;
    stages.chunks.total = total || stages.chunks.total;
    stages.chunks.done = got >= stages.chunks.total;
    setStatus(`loading ${got} / ${stages.chunks.total}`);
    render();
  };
}
// a chunked build asks its host whether it does byte ranges before the first read:
// without them a 1 MiB window would drag a whole chunk behind it
if (portable && portable.ready) {
  try { await portable.ready; } catch (e) { throw new Error(`portable chunks: ${e && e.message || e}`); }
  // round 78: a host whose byte ranges cannot be trusted (jsDelivr answers 206
  // with the wrong bytes) must not be asked for a range. The Worker is the
  // thing that sends Range, so it stays off and every window is a whole GET.
  if (portable.ranges && !portable.ranges()) {
    hooks.noReader = true;
    const why = portable.rangesWhy && portable.rangesWhy();
    if (why) console.warn(`[isaac] byte ranges are off: ${why}. Whole chunks instead.`);
  }
}
// the reads once the engine runs, when there is no Worker to make them
hooks.preadBytes = portable ? (rel, off, len) => portable.bytesFor(rel, off, len) : null;
hooks.trail = (portable && portable.trail) || null;
hooks.chunkKey = (portable && portable.key) || null;
const partsOf = (url) => {
  const [path, query] = url.split('?');
  const q = new URLSearchParams(query || '');
  const off = q.has('off') ? Number(q.get('off')) : 0;
  const rel = path.replace(/^\//, '');
  const inInstance = rel.startsWith('instance/');
  return { rel: inInstance ? rel.slice('instance/'.length) : rel, inInstance,
           off, len: q.has('len') ? Number(q.get('len')) : 0 };
};
hooks.url = (url) => {
  // the windowed reads once the game runs: count what the engine streams
  const m = /[?&]len=(\d+)/.exec(url);
  if (m) streamed += Number(m[1]); else { const rel = url.split('?')[0].replace(/^\/instance\//, ''); streamed += indexSize.get(rel) || 0; }
  streamedRequests += 1;
  if (portable) {
    // a portable build has no server behind it: for a window the provider either
    // gives a URL or says null, and the caller reads the bytes instead. Anything
    // else (there is only the shipped trail, which a portable build carries inline)
    // keeps the served spelling so nothing downstream sees a surprise.
    const { rel, off, len } = partsOf(url);
    if (len) return (portable.urlFor && portable.urlFor(rel, off, len)) || null;
  }
  return rewrite(url);
};
hooks.fetchBytes = async (url) => {
  const rel = url.split('?')[0].replace(/^\//, '');
  if (rel === 'instance_index.json' && indexBytes) return indexBytes;
  if (portable) {
    const q = partsOf(url);
    const bytes = await portable.bytesFor(q.rel, q.off, q.len);
    if (bytes) {
      const st0 = stageFor(rel);
      if (st0) { st0.received += bytes.length; render(); }
      return bytes;
    }
  }
  const st = stageFor(rel);
  const res = await fetch(rewrite(url));
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const expected = rel.startsWith('instance/') ? (indexSize.get(rel.slice('instance/'.length)) || 0) : sizeOf(rel);
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (st) { st.received += value.length; render(); }
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (expected && got !== expected) console.warn(`${rel}: ${got} bytes, the index says ${expected}`);
  return out;
};
hooks.instantiateWasm = (info, receive) => {
  (async () => {
    const st = stages.module;
    st.received = 0; render();
    if (portable) {
      // no server to stream from: the bytes are inline or in a chunk, so the
      // module is compiled from them directly (no instantiateStreaming, and so
      // none of round 40's code-cache benefit -- a portable build pays that)
      const bytes = await portable.bytesFor('boot.wasm', 0, 0);
      st.received = bytes.length; st.done = true; render();
      const { instance, module } = await WebAssembly.instantiate(bytes, info);
      setStatus('loading');
      receive(instance, module);
      return;
    }
    const res = await fetch(rewrite('/boot.wasm'));
    if (!res.ok) throw new Error(`boot.wasm: HTTP ${res.status}`);
    // Round 40: the fetch's own Response goes to instantiateStreaming. V8 keeps
    // the optimised machine code of a module in the HTTP cache entry of the
    // response it was compiled from (a cacheable URL, >= 128 KB, streaming);
    // a synthetic `new Response(stream)` has no cache entry, so every visit
    // compiled 50 MB with the baseline tier and ran slower for minutes while
    // the optimiser caught up. The progress bar reads a clone of the body.
    const counted = res.clone().body.getReader();
    (async () => {
      for (;;) {
        const { done, value } = await counted.read();
        if (done) return;
        st.received += value.length; render();
      }
    })().catch(() => {});
    const { instance, module } = await WebAssembly.instantiateStreaming(res, info);
    st.done = true; render();
    setStatus('loading');
    receive(instance, module);
  })().catch((e) => showError('The module failed to load', e.message));
  return {};
};
let moduleRef = null;
hooks.beforeMain = (m) => new Promise((resolve) => {
  moduleRef = m;
  stages.boot.done = true; render();
  const start = () => {
    unlockAudio(m);
    playBtn.hidden = true;
    $('stages').hidden = true;
    setStatus('starting');
    resolve();
    // Round 46: a frame-rate readout in the status line once the engine runs --
    // the host's frame counter sampled each second, the median of the last
    // ten -- so a test on the target machine reports numbers without tooling.
    let last = window.isaacFrame || 0, lastT = performance.now(), first = true;
    let lastNoRaf = 0;   // round 49: frames the yield ticked on its timer (no animation frames)
    const recent = [];
    // the machine, once: cores, memory (Chrome rounds it), the GPU renderer --
    // what a report from the target has to say alongside the frame rate
    let machine = '';
    try {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'gpu?';
      machine = ` -- ${navigator.hardwareConcurrency || '?'} cores, ${navigator.deviceMemory || '?'} GB, ${renderer}`;
    } catch (e) { machine = ''; }
    setInterval(() => {
      const f = window.isaacFrame || 0, t = performance.now();
      if (f <= 0) return;
      const nr = window.isaacYieldNoRaf || 0, nrDelta = nr - lastNoRaf; lastNoRaf = nr;
      const fps = (f - last) * 1000 / Math.max(1, t - lastT);
      last = f; lastT = t;
      recent.push(fps); if (recent.length > 10) recent.shift();
      const med = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
      if (first) { first = false; render(); }
      const note = document.hidden ? ' -- paused while hidden' : (nrDelta > 0 ? ` -- no animation frames (${nrDelta} timer tick(s) this second: occluded?)` : '');
      const line = `${fps.toFixed(0)} fps (median of the last ${recent.length} s: ${med.toFixed(0)}) -- frame ${f}${note}`;
      setStatus('running', line + machine);            // the overlay is gone by now; ?stats=1 still shows it
      const fpsEl = $('fps'); fpsEl.textContent = line; fpsEl.title = line + machine;   // the header's, live during play
      editMenu.setFps(fps);                                                          // the in-game FPS VIEWER, when on
    }, 1000);
  };
  if (AUTOPLAY) { start(); return; }
  setStatus('press play');
  playBtn.hidden = false;
  playBtn.focus();
  playBtn.addEventListener('click', start, { once: true });
});
hooks.onLog = (line) => {
  if (line.startsWith('=== ')) {
    const name = line.slice(4, -4);
    if (name === 'layout') { stages.image.done = true; }
    else if (name === 'host boot (IAT + TEB + TLS + _initterm)') { stages.archives.done = true; stages.boot.received = 1; }
    else if (name.startsWith('main @')) { stages.boot.done = true; }
    // the engine's own stage names are the detail, not the line
    setStatus('loading', name);
    render();
    return;
  }
  if (/^\s*isaac_boot_init -> /.test(line)) { stages.boot.done = true; render(); }
  if (/^\s*TRAP in |^RESULT: aborted|module instantiation failed|lazy (read|pread) FAILED/.test(line)) showError('The module stopped', line.trim());
};
window.isaacPageHooks = hooks;

// The click is the user gesture: an AudioContext created inside it starts
// running, so the AL shim's lazily created context (host_audio_web.c) is
// created here first, and resumed if the browser still has it suspended.
function unlockAudio(m) {
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    if (!m.isaacAudio) m.isaacAudio = { ctx: null, buffers: new Map(), sources: new Map() };
    if (!m.isaacAudio.ctx) m.isaacAudio.ctx = new C();
    if (m.isaacAudio.ctx.state === 'suspended') m.isaacAudio.ctx.resume();
  } catch (e) { /* audio never blocks the game */ }
  canvas.focus();
}

// ---- the error / ended panel ----------------------------------------------------
let errorShown = false;
function showError(title, text, ended = false) {
  if (errorShown && !ended) return;
  errorShown = true;
  const panel = $('error');
  panel.className = ended ? 'ended' : '';
  $('error-title').textContent = title;
  $('error-text').textContent = text || '';
  $('errlog').textContent = (window.isaacLog || []).slice(-24).join('\n');
  panel.hidden = false;
}
$('reload-btn').addEventListener('click', () => location.reload());
$('dismiss-btn').addEventListener('click', () => { $('error').hidden = true; });
window.addEventListener('error', (ev) => showError('A script error', ev.message));
window.addEventListener('unhandledrejection', (ev) => showError('The pipeline failed', String(ev.reason && ev.reason.message || ev.reason)));

// ---- the EDIT FILE menu (round 52) -----------------------------------------------------
// The save-select screen's DELETE FILE strip reads EDIT FILE (page_assets.py
// patched the sheet in the bundle's afterbirthp.a); confirming on a file in
// that mode asks the host gate, which calls window.isaacEditFile(slot): the
// menu opens over the game with the game's own art, font and sounds
// (menu_overlay.mjs). Export and import work the saves store for that file's
// persistentgamedata / gamestate; Delete hands the flow back to the engine.
const slotPattern = (slot) => new RegExp(`(^|/)(rep_)?(persistentgamedata|gamestate)${slot + 1}\\.dat$`, 'i');
const renumber = (name, slot) => name.replace(/(persistentgamedata|gamestate)\d(\.dat)$/i, (m, a, b) => `${a}${slot + 1}${b}`);
async function exportSlot(slot) {
  const db = await openStore();
  if (!db) throw new Error('NO SAVE STORE HERE');
  const items = (await readAllSaves(db)).filter((it) => slotPattern(slot).test(entryName(it.key, it.src)));
  if (!items.length) throw new Error('NO SAVE IN THIS FILE');
  const meta = { format: 'isaac-recomp-saves/1', exported: new Date().toISOString(), slot: slot + 1,
    files: items.map((it) => ({ key: it.key, src: it.src, name: entryName(it.key, it.src) })) };
  const entries = items.map((it) => ({ name: entryName(it.key, it.src), bytes: it.bytes }));
  entries.push({ name: 'isaac-saves.json', bytes: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
  download(zipStore(entries), `isaac-file${slot + 1}-${stamp()}.zip`);
  return `EXPORTED ${items.length} FILE${items.length === 1 ? '' : 'S'}`;
}
async function importSlot(slot) {
  const input = $('import-file');
  const file = await new Promise((resolve) => {
    const onChange = () => { input.removeEventListener('change', onChange); resolve(input.files && input.files[0]); input.value = ''; };
    input.addEventListener('change', onChange);
    input.click();
    console.log('[menu] the file chooser was asked for');
  });
  if (!file) throw new Error('NO FILE CHOSEN');
  const db = await openStore();
  if (!db) throw new Error('NO SAVE STORE HERE');
  const existing = (await readAllSaves(db)).filter((it) => slotPattern(slot).test(entryName(it.key, it.src)));
  const buf = new Uint8Array(await file.arrayBuffer());
  const items = [];
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const entries = await unzip(buf.buffer);
    const metaEntry = entries.find((e) => e.name === 'isaac-saves.json');
    const meta = metaEntry ? JSON.parse(new TextDecoder().decode(metaEntry.bytes)) : null;
    const byName = new Map(((meta && meta.files) || []).map((f) => [f.name, f]));
    for (const e of entries) {
      if (e.name === 'isaac-saves.json' || !/(persistentgamedata|gamestate)\d\.dat$/i.test(e.name)) continue;
      const f = byName.get(e.name);
      // whatever file number the export carried, it lands in THIS file's slot
      items.push({ key: renumber(f && f.key ? f.key : e.name, slot), src: renumber(f && f.src ? f.src : e.name, slot), bytes: e.bytes });
    }
  } else {
    // a bare .dat: this file's persistentgamedata (or gamestate, by its name)
    const kind = /gamestate/i.test(file.name) ? 'gamestate' : 'persistentgamedata';
    const hit = existing.find((it) => new RegExp(`${kind}${slot + 1}\\.dat$`, 'i').test(entryName(it.key, it.src)));
    items.push({ key: hit ? hit.key : `c:/isaac/documents/my games/binding of isaac repentance+/${kind}${slot + 1}.dat`, src: hit ? hit.src : '', bytes: buf });
  }
  if (!items.length) throw new Error('NOTHING TO IMPORT');
  await writeSaves(db, items, false);
  setTimeout(() => location.reload(), 1500);               // the engine holds the old data: a reload applies the import
  return 'IMPORTED. RELOADING...';
}
const editMenu = createEditFileMenu({
  stage: $('stage'), canvas, assetsUrl: `${ROOT}/instance/page-assets`,
  // round 70: with no server the overlay reads its own files out of the payload
  readAsset: portable ? (name) => portable.bytesFor(`page-assets/${name}`, 0, 0) : null,
  audioContext: () => (moduleRef && moduleRef.isaacAudio && moduleRef.isaacAudio.ctx) || null,
  injectKey: (name, down) => { if (typeof window.isaacInjectKey === 'function') window.isaacInjectKey(name, down); },
  log: (line) => console.log(line),
  // MODS: the way into the mods menu when the game's own list has no IMPORT MOD
  // row to press Enter on, which is any save with no mods of its own. modsMenu is
  // built further down; this runs when the row is chosen, long after.
  actions: { export: exportSlot, import: importSlot, mods: () => modsMenu.open() },
});
window.isaacEditFile = (slot) => { editMenu.open(slot); };
window.isaacEditFileDelete = -1;
window.isaacKeyCapture = (ev, down) => (modsMenu.isOpen() ? modsMenu.onKey(ev, down) : editMenu.onKey(ev, down));
window.isaacEditFileMenu = editMenu;                      // the drivers look at it

// ---- mods (round 74) ---------------------------------------------------------------
// The game's own mods list carries a row named IMPORT MOD, which is a mod seeded
// by the pipeline with nothing in it but a name. Enter on that row makes the game
// write a disable.it into its folder; the pipeline claims that write instead of
// storing it and calls this. So the button is the game's, and the menu is ours.
// Drawn on the game's own paper, in the game's own font, with the game's own
// cursor and menu sounds (menu_overlay.mjs) -- the browser's chrome has no place
// on top of the game. The catalogue the browser reads is a URL the build carries
// or the query names; without one the MOD BROWSER row is not offered.
const modsPaper = createPaperMenu({
  stage: $('stage'), assetsUrl: `${ROOT}/instance/page-assets`,
  readAsset: portable ? (name) => portable.bytesFor(`page-assets/${name}`, 0, 0) : null,
  audioContext: () => (moduleRef && moduleRef.isaacAudio && moduleRef.isaacAudio.ctx) || null,
  log: (line) => console.log(line),
});
const modsMenu = createModsMenu({
  paper: modsPaper,
  log: (line) => console.log(line),
  catalogueBase: params.get('catalogue') || (typeof window !== 'undefined' ? window.isaacModCatalogue : null) || null,
  onInstalled: enableModsInOptions,
});
hooks.onModImport = () => { modsMenu.open(); };
window.isaacModsMenu = modsMenu;                          // the drivers look at it too

// ---- chrome: fullscreen, fps, the live status --------------------------------------
let lastFrame = 0, lastT = performance.now(), firstFrameSeen = false, finished = false;
setInterval(() => {
  const f = window.isaacFrame || 0;
  const now = performance.now();
  if (f > 0 && !firstFrameSeen) { firstFrameSeen = true; overlay.hidden = true; canvas.focus(); }
  if (firstFrameSeen) {
    const fps = (f - lastFrame) / ((now - lastT) / 1000);
    // (#fps is written by the status interval above: fps, median, frame, the hidden / no-animation-frames notes; the machine in its tooltip)
    lastFrame = f; lastT = now;
  } else if (!streamingEl.hidden) {
    streamingEl.textContent = `streamed ${mb(streamed)} MB of archives in ${streamedRequests} reads`;
  }
  const done = window.isaacDone;
  if (done && !finished) {
    finished = true;
    $('fps').textContent = '';
    if (done.error || done.mainRc !== 0) showError('The run ended with an error', done.error || `main returned ${done.mainRc}`);
    else showError('The run ended', `main returned 0 after ${done.presented} frames (the frames= budget). Reload to play again.`, true);
  }
}, 500);

// ---- the options the game opens with -------------------------------------------------
// Round 73: the public-beta notice and the data-collection disclaimer are both
// options.ini flags, so a first visit gets a file with them already accepted rather
// than two confirm screens. Written only when the store has none: a returning
// player's settings, and every save beside them, are left exactly as they are.
const OPTIONS_KEY = 'c:/isaac/documents/my games/binding of isaac repentance+/options.ini';
const DEFAULT_OPTIONS = ['[Options]', 'Language=0', 'MusicVolume=0.7000', 'MusicEnabled=1',
  'SFXVolume=0.7000', 'MapOpacity=0.3000', 'Fullscreen=0', 'Filter=0', 'Exposure=1.0000',
  'Gamma=1.0000', 'ControllerHotplug=1', 'PopUps=1', 'CameraStyle=1', 'ShowRecentItems=0',
    // EnableMods: off in round 76 because a modded run earned no achievements
  // until Mom was beaten, and that is not a trade to make on someone's behalf.
  // Round 81 took the gate out of the engine (lift_patches 0x009299e4: the
  // readonly byte TryUnlock tests is never set), so the reason is gone and mods
  // are on. TAB on the mods screen still flips it either way.
  'HudOffset=1.0000', 'TryImportSave=0', 'FoundHUD=0', 'EnableMods=1', 'RumbleEnabled=1',
  'ChargeBars=0', 'BulletVisibility=0', 'TouchMode=1', 'AimLock=1', 'JacobEsauControls=0',
  'AscentVoiceOver=1', 'OnlineHud=0', 'StreamerMode=0', 'OnlinePlayerVolume=6',
  'OnlinePlayerOpacity=10', 'OnlineChatEnabled=1', 'OnlineChatFilterEnabled=1',
  'MultiplayerColorSet=0', 'OnlineInputDelay=3', 'ItemInfoDisplayEnabled=0',
  'AcceptedPublicBeta_v1.9.7.17=1',        // the beta notice
  'AcceptedDataCollectionDisclaimer=1',    // the data-collection prompt; nothing here collects any
  'EnableDebugConsole=0', 'MaxScale=99', 'MaxRenderScale=2', 'VSync=0', 'PauseOnFocusLost=1',
  'SteamCloud=0', 'MouseControl=0', 'BossHpOnBottom=1', 'AnnouncerVoiceMode=0', 'ConsoleFont=0',
  'FadedConsoleDisplay=0', 'SaveCommandHistory=1', 'WindowWidth=960', 'WindowHeight=540',
  'WindowPosX=8', 'WindowPosY=32', 'UseExclusiveFullscreen=0', 'EnableEpicOverlay=0',
  'EosCrossplay=0', ''].join('\r\n');
async function seedDefaultOptions() {
  let db = null;
  try { db = await openStore(); } catch { return 'no store'; }
  if (!db) return 'no store';
  const have = await new Promise((resolve) => {
    try {
      const req = db.transaction(SAVE_STORE, 'readonly').objectStore(SAVE_STORE).getKey(OPTIONS_KEY);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => resolve(true);          // unsure: leave it alone
    } catch { resolve(true); }
  });
  if (have) return 'kept';
  const bytes = new TextEncoder().encode(DEFAULT_OPTIONS);
  try { await writeSaves(db, [{ key: OPTIONS_KEY, src: null, bytes }], false); } catch { return 'write failed'; }
  return 'written';
}

// Round 82: installing a mod turns EnableMods on, once. A page that visited
// before round 81 wrote EnableMods=0 into its options and kept it: the mod is
// seeded, the engine lists it and nothing happens, which is the least obvious
// failure there is. Choosing to install one is choosing to have mods on. The
// game's own TAB on the mods screen still wins afterwards -- this only ever
// fires on an install.
// Is there a mod in the store at all? Read-only, and it does not open the mods
// database if the browser has none.
async function anyModInstalled() {
  if (typeof indexedDB === 'undefined') return false;
  const dbs = (indexedDB.databases ? await indexedDB.databases().catch(() => null) : null);
  if (dbs && !dbs.some((d) => d.name === MODS_DB)) return false;
  let db = null;
  try { db = await openModDb(); } catch { return false; }
  if (!db) return false;
  try { return (await listMods(db)).length > 0; } finally { try { db.close(); } catch { /* gone */ } }
}

// The one-time flip, remembered in localStorage: turning mods off in the game's
// own options afterwards has to stick, so this fires once per browser and not at
// every boot.
async function enableModsOnce() {
  try { if (localStorage.getItem('isaac-mods-enabled-once') === '1') return 'done before'; } catch { /* no storage */ }
  const r = await enableModsInOptions();
  try { localStorage.setItem('isaac-mods-enabled-once', '1'); } catch { /* no storage */ }
  return r;
}

async function enableModsInOptions() {
  let db = null;
  try { db = await openStore(); } catch { return 'no store'; }
  if (!db) return 'no store';
  const cur = await new Promise((resolve) => {
    try {
      const req = db.transaction(SAVE_STORE, 'readonly').objectStore(SAVE_STORE).get(OPTIONS_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  if (!cur || !cur.bytes) return 'no options yet';       // seedDefaultOptions writes EnableMods=1
  const text = new TextDecoder().decode(cur.bytes);
  if (!/^EnableMods=0\s*$/m.test(text)) return 'already on';
  const next = text.replace(/^EnableMods=0[ \t]*$/m, 'EnableMods=1');
  try { await writeSaves(db, [{ key: OPTIONS_KEY, src: null, bytes: new TextEncoder().encode(next) }], false); }
  catch { return 'write failed'; }
  console.log('[mods] EnableMods was off in this browser\'s options; a mod was installed, so it is on now');
  return 'turned on';
}

// ---- the saves menu ------------------------------------------------------------------
// Round 86c: same self-heal as boot_web's openSaveDb -- a database that exists
// at this version without its store never gets one from `open(name, 1)`.
function openStore() {
  // versionless first: whatever is there, at whatever version it is at
  const open = (version) => new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(SAVE_DB, version) : indexedDB.open(SAVE_DB);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE_STORE)) db.createObjectStore(SAVE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    open(0).then((db) => {
      if (db.objectStoreNames.contains(SAVE_STORE)) { resolve(db); return; }
      const next = db.version + 1;
      db.close();
      open(next).then(resolve, reject);
    }, reject);
  });
}
function readAllSaves(db) {
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(SAVE_STORE, 'readonly').objectStore(SAVE_STORE).openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) { resolve(out); return; } out.push({ key: String(c.key), src: c.value.src || '', bytes: c.value.bytes }); c.continue(); };
    req.onerror = () => reject(req.error);
  });
}
function writeSaves(db, items, clear) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SAVE_STORE, 'readwrite'), st = tx.objectStore(SAVE_STORE);
    if (clear) st.clear();
    for (const it of items) st.put({ src: it.src, bytes: it.bytes }, it.key);
    tx.oncomplete = () => resolve(items.length);
    tx.onerror = () => reject(tx.error);
  });
}
// the name a save travels under: its seed path, else its FS key without the
// fake cwd root the host answers USERPROFILE with (the node driver's rule)
const entryName = (key, src) => (src || key.replace(/^c:\/isaac\//i, '')).replace(/^\/+/, '');
const b64enc = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s); };
const b64dec = (s) => { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const savesDialog = $('saves');
async function refreshSaves() {
  const list = $('saves-list');
  list.innerHTML = '';
  try {
    const db = await openStore();
    const items = db ? await readAllSaves(db) : [];
    if (!items.length) list.innerHTML = '<tr><td class="note">nothing saved yet</td></tr>';
    for (const it of items) {
      const tr = document.createElement('tr');
      const a = document.createElement('td'), b = document.createElement('td');
      a.textContent = entryName(it.key, it.src); b.textContent = fmtBytes(it.bytes.length); b.className = 'n';
      tr.append(a, b); list.appendChild(tr);
    }
    return items;
  } catch (e) { list.innerHTML = `<tr><td class="note">save store unavailable: ${e.message}</td></tr>`; return []; }
}
$('saves-btn').addEventListener('click', async () => { $('saves-status').textContent = PERSIST ? '' : 'persist=0: the store is off for this load'; await refreshSaves(); savesDialog.showModal(); });
$('saves-close').addEventListener('click', () => savesDialog.close());
$('saves-reload').addEventListener('click', () => location.reload());
$('export-zip').addEventListener('click', async () => {
  const items = await refreshSaves();
  const meta = { format: 'isaac-recomp-saves/1', exported: new Date().toISOString(), files: items.map((it) => ({ key: it.key, src: it.src, name: entryName(it.key, it.src), size: it.bytes.length })) };
  const entries = items.map((it) => ({ name: entryName(it.key, it.src), bytes: it.bytes }));
  entries.push({ name: 'isaac-saves.json', bytes: new TextEncoder().encode(JSON.stringify(meta, null, 1)) });
  download(zipStore(entries), `isaac-saves-${stamp()}.zip`);
  $('saves-status').textContent = `${items.length} file(s) exported`;
});
$('export-json').addEventListener('click', async () => {
  const items = await refreshSaves();
  const doc = { format: 'isaac-recomp-saves/1', exported: new Date().toISOString(), files: items.map((it) => ({ key: it.key, src: it.src, name: entryName(it.key, it.src), size: it.bytes.length, base64: b64enc(it.bytes) })) };
  download(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), `isaac-saves-${stamp()}.json`);
  $('saves-status').textContent = `${items.length} file(s) exported`;
});
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    let items = [];
    if (/\.json$/i.test(file.name)) {
      const doc = JSON.parse(await file.text());
      if (!doc || !Array.isArray(doc.files)) throw new Error('not a saves export');
      items = doc.files.map((f) => ({ key: f.key || f.name, src: f.src || (f.key ? '' : f.name), bytes: b64dec(f.base64) }));
    } else {
      const entries = await unzip(await file.arrayBuffer());
      const metaEntry = entries.find((e) => e.name === 'isaac-saves.json');
      const meta = metaEntry ? JSON.parse(new TextDecoder().decode(metaEntry.bytes)) : null;
      const byName = new Map(((meta && meta.files) || []).map((f) => [f.name, f]));
      for (const e of entries) {
        if (e.name === 'isaac-saves.json') continue;
        const f = byName.get(e.name);
        // an entry the export did not describe (a file added by hand) is seeded under its own name
        items.push(f ? { key: f.key, src: f.src, bytes: e.bytes } : { key: e.name, src: e.name, bytes: e.bytes });
      }
    }
    const db = await openStore();
    if (!db) throw new Error('no IndexedDB here');
    await writeSaves(db, items, false);
    await refreshSaves();
    $('saves-status').textContent = `${items.length} file(s) imported; they are seeded before main at the next boot`;
    $('saves-reload').hidden = false;
  } catch (e) {
    $('saves-status').textContent = `import failed: ${e.message}`;
  }
  ev.target.value = '';
});
$('reset-saves').addEventListener('click', async () => {
  if (!window.confirm('Delete every saved file this browser keeps for the game?')) return;
  try {
    const db = await openStore();
    if (db) await writeSaves(db, [], true);
    await refreshSaves();
    $('saves-status').textContent = 'the store is empty; the game starts fresh at the next boot';
    $('saves-reload').hidden = false;
  } catch (e) { $('saves-status').textContent = `reset failed: ${e.message}`; }
});

// ---- a first visit starts at the title, not at two confirm screens (round 73).
// Before the pipeline, which restores the store into the engine's file system.
try {
  const seeded = await seedDefaultOptions();
  if (seeded === 'written') console.log('[isaac] options.ini written with the opening prompts accepted');
} catch (e) { console.warn('[isaac] default options not written:', e.message); }

// Round 84: a browser that already had a mod when round 82 landed never hit the
// install path, so its EnableMods=0 -- round 76's default, kept because options
// are written once -- was still there and the mod it had was listed and never
// run. Once, at the first boot that finds a mod in the store.
try {
  if (await anyModInstalled()) {
    const done = await enableModsOnce();
    if (done === 'turned on') console.log('[isaac] a mod is installed and this browser had mods off; turned on');
  }
} catch (e) { console.warn('[isaac] could not check the mods:', e.message); }

// ---- go: the pipeline runs to the end of main; this import resolves when it does
setStatus('loading');
stages.module.received = 0;
import('./boot_web.mjs').catch((e) => showError('The pipeline failed', e.message));
