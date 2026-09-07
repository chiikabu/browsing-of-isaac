// boot_web.mjs -- page-side driver for the WEB build of the lifted module.
// Mirrors boot_integration.mjs stage for stage: place the memory image, check
// the layout, arm the guard, seed the packed archives, register the instance
// tree lazily, run the host boot, run main. Files arrive from the runner's
// local HTTP server (run_web.mjs, 127.0.0.1 only).
//
// Everything the runner reads back lives on window: isaacLog (every line the
// module printed), isaacFrames (the last frames the host's SwapBuffers shim
// read back from the WebGL framebuffer), isaacDone ({mainRc, bootRc, ...}).
import Module from './boot.mjs';
import { openModDb, seedMods, putModState, setModEnabled, underMods, isImportMark, disableTarget } from './mods.mjs';

const logEl = document.getElementById('log');
// Round 34: the shipping page (play.mjs) sets window.isaacPageHooks before importing this module:
// url(u) rewrites every synchronous fetch (root path, cache-busting ?v=), fetchBytes(u) fetches the
// boot stages asynchronously with a progress bar, instantiateWasm streams the module, onLog sees
// every line, beforeMain(m) is awaited before main (the Play click). All optional; boot_web.html sets none.
const hooks = (typeof window !== 'undefined' && window.isaacPageHooks) || {};
window.isaacLog = [];
window.isaacFrames = [];
window.isaacDone = null;
window.isaacFrame = 0;     // the host's frame counter, live (round 25: a driver paces key events on it)
const KEEP_FRAMES = 6;
function log(line) {
  window.isaacLog.push(String(line));
  if (hooks.onLog) hooks.onLog(String(line));
  if (window.isaacLog.length % 50 === 0 || /RESULT|TRAP|frame\]/.test(line)) {
    logEl.textContent = window.isaacLog.slice(-12).join('\n');
  }
}

// Synchronous binary fetch: the RAM-FS asks for lazy bytes from inside a
// blocking call into wasm, so the answer cannot be awaited. A synchronous
// XHR in the window context may only read text, and Chromium strips a
// leading UTF-8 BOM from text responses whatever the charset label (the
// x-user-defined trick lost three bytes of every BOM-prefixed .anm2/.fs),
// so the runner serves ?b64=1 as base64 and the bytes are decoded here.
// Round 55 tried 8-bit text instead (charset x-user-defined behind one pad
// byte, charCodeAt & 0xff): 442 windows to frame 300 took 70-75 s at a 4x
// throttle against 50 s with base64 -- the x-user-defined string is two-byte
// and the decode loop loses more than atob costs. Base64 stays.
// Round 55: the browser's own base64 decoder where it has one (Chrome 140+,
// Firefox 133+, Safari 18.2+): one 1 MiB archive window decodes in 3 ms at a
// 4x CPU throttle against 17 ms for atob and a charCodeAt loop, and leaves no
// 1 MB binary string behind for the collector. The loop stays for the rest.
const decodeBase64 = (typeof Uint8Array.fromBase64 === 'function')
  ? (txt) => Uint8Array.fromBase64(txt)
  : (txt) => { const bin = atob(txt), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
function fetchSync(url) {
  if (hooks.url) url = hooks.url(url);
  const sep = url.includes('?') ? '&' : '?';
  const x = new XMLHttpRequest();
  x.open('GET', url + sep + 'b64=1', false);
  x.send(null);
  if (x.status !== 200) throw new Error(`${url}: HTTP ${x.status}`);
  return decodeBase64(x.responseText);
}
// The boot stages (memory image, index, the eagerly seeded archives, the Lua) go through
// fetchBytes: the synchronous fetch by default, an asynchronous one with byte-level progress
// under the shipping page (round 34). The reads the RAM-FS makes during main stay synchronous.
const fetchBytes = hooks.fetchBytes || (async (url) => fetchSync(url));

const params = new URLSearchParams(location.search);
// Round 76: defaults the page wants applied, without them appearing in the URL.
// A query the player never typed does not belong in a link they might copy, and
// a real query still wins over a default.
for (const [k, v] of Object.entries((hooks && hooks.params) || {})) {
  if (!params.has(k)) params.set(k, String(v));
}
const cfg = {
  canvas: document.getElementById('canvas'),
  print: log,
  printErr: log,
  instantiateWasm: hooks.instantiateWasm,     // round 34: the shipping page streams the module with a progress bar
  preRun: [() => {
    // a live page (ISAAC_YIELD=1) with no budget plays until it is closed
    cfg.ENV.ISAAC_MAX_FRAMES = params.get('frames') || (params.get('ISAAC_YIELD') === '1' ? '100000000' : '5');
    cfg.ENV.ISAAC_LOG_TIME = '1';
    for (const [k, v] of params) if (k.startsWith('ISAAC_')) cfg.ENV[k] = v;
  }],
};
let lazyReads = 0, lazyBytes = 0;
const lazyByFile = new Map();                              // src -> bytes (round 40: what the run start reads)
const preadTrail = [];                                    // the first window offsets, in order (scan or thrash?)
const preadStacks = [];                                   // three wasm stacks under a window fetch: who reads the archive?
window.isaacLazyStats = () => ({ reads: lazyReads, bytes: lazyBytes, windows: preads, windowBytes: preadBytes, distinctWindows: windowsSeen.size, trail: preadTrail.slice(0, 60), stacks: preadStacks,
  prefetched, prefetchHits, prefetchMisses, aheadFetched, readerWaits, readerWaitMs: Math.round(readerWaitMs), reader: !!reader, trailKept, trailShipped, trailLen: trail.length, trailWritten,
  top: [...lazyByFile].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.replace(/^.*\//, '')} ${(v / 1048576).toFixed(1)} MB`) });
cfg.isaacLazyRead = (src, dst, len) => {
  try {
    const bytes = fetchSync(`/instance/${src}`);
    if (bytes.length < len) { log(`  lazy read of ${src}: ${bytes.length} bytes served, ${len} registered`); return 0; }
    m.HEAPU8.set(bytes.subarray(0, len), dst);
    lazyReads += 1; lazyBytes += len; lazyByFile.set(src, (lazyByFile.get(src) || 0) + len);
    dropBody(bytes);
    return 1;
  } catch (e) {
    log(`  lazy read FAILED for ${src}: ${e.message}`);
    return 0;
  }
};
// Round 24e: positional reads. A lazy file of ISAAC_FS_WINDOW_MIN MiB or
// more (default 32) is never fetched whole: the RAM-FS keeps two 1 MB
// windows per file and refills them through this call, which the runner
// serves as a byte slice (?off=&len=, base64 like every sync fetch here).
// That is what lets the DLC archives (afterbirth.a 145 MB, afterbirthp.a
// 604 MB, repentance.a 385 MB) mount inside a wasm32 heap.
// Round 31: saves persist. The FS shim hands every file the game wrote to
// Module.isaacPersist when it is closed (the persistentgamedata*.dat under
// Documents/My Games/... on each game over) and announces deletes through
// Module.isaacUnlink; they go into an IndexedDB store keyed by the FS key
// and are seeded back before main at the next boot. `persist=0` on the URL
// turns the store off (a fresh profile every load).
const persistOn = params.get('persist') !== '0';
// Round 74: mods keep their own database. A file the game writes under mods/ is
// mod state, not a save, and routing it here is what lets the mods menu reset or
// remove anything it likes without a save file being in reach. `mods=0` leaves
// the whole feature out (the drivers that measure a bare boot).
const modsOn = params.get('mods') !== '0';
let modDb = null;
const SAVE_DB = 'isaac-saves', SAVE_STORE = 'files';
// Round 86c: a database can exist at this version without the store in it --
// `indexedDB.open(name)` with no version makes an empty one, and an interrupted
// upgrade can leave one behind. After that `open(name, 1)` never fires
// onupgradeneeded, the store is never made, and every save quietly goes
// nowhere. Check, and reopen one version up to create it.
function openSaveDb() {
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
let saveDb = null, persisted = 0, unlinked = 0;
const persistPending = [];
cfg.isaacPersist = (key, src, ptr, len) => {
  if (modKeyTaken(key, () => m.HEAPU8.slice(ptr, ptr + len))) return 1;
  if (!persistOn) return 0;
  const bytes = m.HEAPU8.slice(ptr, ptr + len);      // a copy: the guest buffer is freed after the call
  persistPending.push({ key, src, bytes });
  persisted += 1;
  flushSaves();
  return 1;
};
cfg.isaacUnlink = (key, src) => {
  if (modKeyTaken(key, null)) return 1;
  if (!persistOn) return 0;
  persistPending.push({ key, src, bytes: null });
  unlinked += 1;
  flushSaves();
  return 1;
};
// Anything the game writes under mods/ belongs to the mods store. The one file
// that is not stored at all is the sentinel's: the mods menu writes a disable.it
// into mods/importmod/ when Enter selects that row, and that write IS the button.
function modKeyTaken(key, take) {
  if (!modsOn || !underMods(key)) return false;
  if (isImportMark(key)) {
    log('  IMPORT MOD chosen in the game');
    try { if (hooks.onModImport) hooks.onModImport(); } catch (e) { log(`  the import menu failed to open: ${e.message}`); }
    return true;
  }
  // A disable.it is the engine saying "turn this mod off". It will not read the
  // file back at the next start, so the meaning is kept and the file is not: a
  // mod that is off is left unseeded, which the engine cannot argue with.
  const off = disableTarget(key);
  if (off) {
    log(`  ${off} turned ${take ? 'off' : 'on'} in the game's list`);
    if (modDb) setModEnabled(modDb, off, !take).catch((e) => log(`  mod flag FAILED: ${e.message}`));
    return true;
  }
  const bytes = take ? take() : null;
  if (modDb) putModState(modDb, key, bytes).catch((e) => log(`  mod state write FAILED: ${e.message}`));
  return true;
}
function flushSaves() {
  if (!saveDb || !persistPending.length) return;
  const tx = saveDb.transaction(SAVE_STORE, 'readwrite'), st = tx.objectStore(SAVE_STORE);
  for (const p of persistPending.splice(0)) {
    if (p.bytes) st.put({ src: p.src, bytes: p.bytes }, p.key); else st.delete(p.key);
  }
  tx.onerror = () => log(`  save store write FAILED: ${tx.error}`);
}
function readSaves() {
  return new Promise((resolve) => {
    if (!saveDb) { resolve([]); return; }
    const out = [];
    const req = saveDb.transaction(SAVE_STORE, 'readonly').objectStore(SAVE_STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(out); return; }
      out.push({ key: c.key, src: c.value.src, bytes: c.value.bytes });
      c.continue();
    };
    req.onerror = () => resolve(out);
  });
}
window.isaacSaveStats = () => ({ persisted, unlinked, pending: persistPending.length });
let preads = 0, preadBytes = 0;
// Round 41: a fetched body is copied into the wasm heap and then DETACHED
// (ArrayBuffer.prototype.transfer(0) frees the backing store at once). A run
// start reads some 460 MB of archive windows in a few seconds; left to the
// GC, those 1 MB bodies piled up to a 2.8 GB renderer peak before it caught
// up -- on a 4 GB machine, the difference between playing and a dead tab.
const dropBody = (bytes) => { try { const b = bytes.buffer; if (b && typeof b.transfer === 'function' && !b.detached) b.transfer(0); } catch (e) { /* older browser: the GC frees it */ } };
const windowsSeen = new Set();
// ---- round 55: the boot trail; round 56: the reader Worker -----------------------
// Round 55: the page keeps the trail of the windows the boot read up to its
// 300th frame (localStorage, this origin) and the next visit fetches them
// ahead. Round 56: a Worker reads every window (below).
const TRAIL_KEY = 'isaac-boot-trail', TRAIL_MAX = 512, READER_PARALLEL = 6, READER_BUDGET = 128 << 20, READ_AHEAD = 4;
const TRAIL_SHIPPED = 'boot-trail.json';                  // round 59: the dist's own trail (ship.py --trail), for a first visit
const READER_PLAY_BUDGET = 8 << 20, READER_CLEAR_FRAME = 600;   // round 60: after the boot the Worker keeps only a little read-ahead
const FS_WINDOW = 1 << 20;                                // the host's window (FS_WIN in host_shims_fs.c)
const trail = [];                                         // [src, off, len] in read order, until written
let prefetched = 0, prefetchHits = 0, prefetchMisses = 0, trailKept = 0, trailWritten = false;
let aheadFetched = 0, readerWaits = 0, readerWaitMs = 0;  // windows read ahead along a file; reads fetched on demand, and the time the engine sat suspended for them
let trailShipped = false;                                 // the trail came with the dist, not from this browser
// Round 56: the windows are read by a Worker. isaac_fs_lazy_pread_js is a
// JSPI import (build_boot.py), so the promise the hook below returns parks
// the wasm stack mid-read while this thread's loop runs, and the Worker --
// its own loop free, no base64, no synchronous XHR -- answers with the raw
// bytes, transferred. It fetches ahead: along the file when the reads are
// sequential (the mount pass reads each archive front to back), and along
// the trail the last visit left (round 55), READER_BUDGET bytes at most held
// or in flight. Round 55's pump delivered 138 of the boot's 442 windows
// because a delivery needs this thread to yield; a suspended read is one.
// ?reader=0 keeps the synchronous reads (the A/B, and the fallback where
// there is no Worker).
// The reader Worker's whole source is the template literal below, so two
// characters are forbidden inside it and neither one is a build error:
//
//   a backtick ends the template, and
//   a backslash is eaten as an escape -- the source the Worker receives is the
//   *cooked* value, three characters shorter than what is written here.
//
// Round 84 wrote a Content-Range check here as /\/(\d+)\s*$/. Cooked, that is
// //(d+)s*$/ -- a line comment. The `const m =` before it dangled, the parser
// reached the next line and said `Unexpected token 'if'`, and from that round on
// the Worker never started for anyone: every read went the synchronous way and
// round 83's retries went with it. Write no backslash in here. If a regex is
// wanted, do it by hand with indexOf/slice, as that check now does.
const READER_WORKER = `
const cache = new Map(), inflight = new Map(), done = new Set();
let jobs = [], ji = 0, budget = 0, held = 0, inflightBytes = 0, parallel = 4, prefetched = 0, ahead = 0;
// Round 77: the chunked build's keystream. Named xorKey rather than key, because
// a job message already carries a field of that name -- the cache key of the
// window it wants -- and a handler that greeted every one of those as a new
// keystream answered no reads at all. Nothing in here may contain a backtick or
// a backslash -- see the note above the template, which is where the reason can
// be written down with the characters it is about.
let xorKey = null;
function unscramble(buf, pos) {
  if (!xorKey || pos < 0) return buf;
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) { const at = pos + i; b[i] ^= xorKey[at & 255] ^ ((at >> 8) & 255); }
  return b.buffer;
}
function start(key, url, len, why, want) {
  inflight.set(key, want | 0); held += len; inflightBytes += len;
  // round 70: a portable build points several windows at one large chunk and puts
  // the byte range in the fragment, which no server ever sees. A host that ignores
  // Range sends the whole chunk, so the body is cut to size here.
  let init, want0 = -1, want1 = -1, at = -1, chunkBytes = -1;
  const h = url.indexOf('#r=');
  if (h >= 0) {
    let frag = url.slice(h + 3);
    // round 84: the tail after ! is the chunk's own length, and a Content-Range
    // total that is not it means the host is answering with somebody else's bytes
    const bang = frag.indexOf('!');
    if (bang >= 0) { chunkBytes = +frag.slice(bang + 1); frag = frag.slice(0, bang); }
    const cut = frag.indexOf('@');
    const r = (cut < 0 ? frag : frag.slice(0, cut)).split('-');
    want0 = +r[0]; want1 = +r[1];
    if (cut >= 0) at = +frag.slice(cut + 1);        // where these bytes start in the stream
    url = url.slice(0, h);
    init = { headers: { Range: 'bytes=' + want0 + '-' + want1 } };
  }
  // Round 83: one fetch that fails must not end the run. A read that comes back
  // empty returns -1 to the engine, which traps -- and the window that did this
  // was answered correctly the moment it was asked again, so it was a blip: a
  // rate limit, a dropped connection, a 5xx. Three tries with a short backoff,
  // and then the whole chunk, which needs no Range and so cannot be refused for
  // one.
  const tries = async () => {
    let last = null;
    for (let a = 0; a < 3; a++) {
      if (a) await new Promise((res) => setTimeout(res, 120 * a * a));
      try {
        const r = await fetch(url, init);
        if (r.ok) {
          // the host's own answer says which file it thinks it is serving. The
          // total is read by hand: a regex would need backslashes, and see above.
          if (r.status === 206 && chunkBytes > 0) {
            const cr = r.headers.get('content-range') || '', sl = cr.lastIndexOf('/');
            const total = sl < 0 ? NaN : Number(cr.slice(sl + 1).trim());
            if (Number.isFinite(total) && total !== chunkBytes) { last = 'the host calls that chunk ' + total + ' bytes, not ' + chunkBytes; break; }
          }
          return await r.arrayBuffer();
        }
        last = 'HTTP ' + r.status;
      } catch (e) { last = (e && e.message) || 'fetch failed'; }
    }
    if (want0 < 0) throw new Error(last || 'fetch failed');
    // no range this time: the whole chunk, cut here
    const r = await fetch(url);
    if (!r.ok) throw new Error('whole chunk: HTTP ' + r.status);
    return await r.arrayBuffer();
  };
  tries().then((buf) => {
    // a host that ignored the Range sent the whole chunk: put it back from the
    // chunk's own start, then cut out the window
    if (buf && want0 >= 0 && buf.byteLength > want1 - want0 + 1) buf = unscramble(buf, at >= 0 ? at - want0 : -1).slice(want0, want1 + 1);
    else if (buf && at >= 0) buf = unscramble(buf, at);
    const w = inflight.get(key); inflight.delete(key); held -= len; inflightBytes -= len;
    if (w) { done.add(key); postMessage({ want: w, buf, hit: why !== 'want', pf: prefetched, ah: ahead }, buf ? [buf] : []); }
    else if (buf && !done.has(key)) { cache.set(key, buf); held += buf.byteLength; if (why === 'trail') prefetched += 1; else ahead += 1; }
  }).catch(() => {
    const w = inflight.get(key); inflight.delete(key); held -= len; inflightBytes -= len;
    if (w) postMessage({ want: w, buf: null, hit: false, pf: prefetched, ah: ahead });
  }).finally(pump);
}
function pump() {
  while (inflight.size < parallel && ji < jobs.length && held < budget) {
    const [key, url, len] = jobs[ji++];
    if (!cache.has(key) && !inflight.has(key) && !done.has(key)) start(key, url, len, 'trail', 0);
  }
}
onmessage = (e) => {
  const d = e.data;
  if (d.xorKey) { xorKey = new Uint8Array(d.xorKey); return; }
  if (d.jobs) { jobs = d.jobs; budget = d.budget; parallel = d.parallel; pump(); return; }
  if (d.clear) { cache.clear(); held = inflightBytes; budget = d.budget; jobs = []; ji = 0; return; }
  if (!d.want) return;
  const buf = cache.get(d.key);
  if (buf) { cache.delete(d.key); held -= buf.byteLength; done.add(d.key); postMessage({ want: d.want, buf, hit: true, pf: prefetched, ah: ahead }, [buf]); }
  else if (inflight.has(d.key)) inflight.set(d.key, d.want);
  else start(d.key, d.url, d.len, 'want', d.want);
  for (const [k, u, l] of d.ahead || []) if (held < budget && !cache.has(k) && !inflight.has(k) && !done.has(k)) start(k, u, l, 'ahead', 0);
  pump();
};
`;
let reader = null, wantId = 0;
// Round 59: the trail's prefetch starts at the first presented frame, not at
// load. On a capped link (200 Mbit/s, the A/B) it competed with the boot's own
// downloads and pushed the first frame from 6.5 s to 12-13 s; the windows it
// serves are the title's, read after that frame anyway.
let trailJobs = null, trailArmed = false;
const armTrail = (jobs) => {
  trailJobs = jobs;
  if (trailArmed && reader && trailJobs && trailJobs.length) { reader.postMessage({ jobs: trailJobs, budget: READER_BUDGET, parallel: READER_PARALLEL }); trailJobs = null; }
};
const pendingReads = new Map();                           // id -> { src, off, len, dst, resolve, t0 }
const lazySizes = new Map();                              // src -> bytes (the instance index): read-ahead stops at a file's end
const lastRead = new Map();                               // src -> the last window offset: read-ahead follows a sequential file
const windowUrl = (src, off, len) => {
  let url = `/instance/${src}?off=${off}&len=${len}`;
  if (hooks.url) url = hooks.url(url);
  // round 70: a portable build answers null when it has no URL for a window -- the
  // caller reads the bytes instead of asking a server that is not there
  return url === null ? null : new URL(url, location.href).href;
};
function finishRead(src, off, dst, bytes) {
  m.HEAPU8.set(bytes, dst);
  windowsSeen.add(`${src}@${off}`);
  preads += 1; preadBytes += bytes.length; lazyByFile.set(src, (lazyByFile.get(src) || 0) + bytes.length);
  const n = bytes.length;
  dropBody(bytes);
  return n;
}
function failRead(src, off, len, why) { log(`  lazy pread FAILED for ${src} at ${off}+${len}: ${why}`); return -1; }
function startReader() {
  // round 70: a portable build with the payload inline hands out no URLs, so the
  // Worker has nothing to fetch -- the page says so and the reads stay on the thread
  if (hooks.noReader) return;
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || params.get('reader') === '0') return;
  let list = null;
  try { list = JSON.parse(localStorage.getItem(TRAIL_KEY) || 'null'); } catch (e) { list = null; }
  if (!Array.isArray(list)) list = [];
  const jobs = list.map(([src, off, len]) => [`${src}@${off}@${len}`, windowUrl(src, off, len), len]);
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([READER_WORKER], { type: 'text/javascript' }))); } catch (e) { return; }
  // round 77: a chunked build's payload is scrambled, and a window is a range the
  // Worker fetches, so the Worker is where it has to be put back
  if (hooks.chunkKey) w.postMessage({ xorKey: hooks.chunkKey });
  trailKept = list.length;
  reader = w;
  w.onmessage = (e) => {
    const d = e.data;
    if (!d.want) return;
    const p = pendingReads.get(d.want);
    if (!p) return;
    pendingReads.delete(d.want);
    prefetched = d.pf; aheadFetched = d.ah;
    if (d.hit) prefetchHits += 1; else { prefetchMisses += 1; readerWaits += 1; readerWaitMs += performance.now() - p.t0; }
    p.resolve(d.buf ? finishRead(p.src, p.off, p.dst, new Uint8Array(d.buf)) : failRead(p.src, p.off, p.len, 'the reader had no bytes'));
  };
  w.onerror = (e) => {
    // the Worker is gone: the read that waits, and every read after it, goes the synchronous way
    reader = null;
    log(`  reader Worker failed (${(e && e.message) || e}); synchronous reads from here`);
    for (const [id, p] of pendingReads) {
      pendingReads.delete(id);
      try { p.resolve(finishRead(p.src, p.off, p.dst, fetchSync(`/instance/${p.src}?off=${p.off}&len=${p.len}`))); } catch (err) { p.resolve(failRead(p.src, p.off, p.len, err.message)); }
    }
    try { w.terminate(); } catch (e2) { /* gone */ }
  };
  w.postMessage({ jobs: [], budget: READER_BUDGET, parallel: READER_PARALLEL });
  if (jobs.length) armTrail(jobs);
  if (!list.length && params.get('trail') !== '0') {
    // a first visit: the dist may ship the trail its own boot leaves (drive_boot.mjs
    // records it, ship.py --trail places it); it arrives while the module compiles
    // (?trail=0 declines it: the A/B)
    let url = TRAIL_SHIPPED;
    if (hooks.url) url = hooks.url(url);
    // round 70: a portable build carries the trail in the page, so there is
    // nothing to fetch for it
    if (hooks.trail) {
      const jobs = hooks.trail
        .map(([src, off, len]) => [`${src}@${off}@${len}`, windowUrl(src, off, len), len])
        .filter(([, u]) => u);
      trailKept = jobs.length; trailShipped = true;
      armTrail(jobs);
      return;
    }
    fetch(new URL(url, location.href).href).then((r) => (r.ok ? r.json() : null)).then((shipped) => {
      if (!Array.isArray(shipped) || !shipped.length || reader !== w) return;
      trailKept = shipped.length; trailShipped = true;
      armTrail(shipped.map(([src, off, len]) => [`${src}@${off}@${len}`, windowUrl(src, off, len), len]));
    }).catch(() => { /* no shipped trail: the visit is cold */ });
  }
}
function writeTrail() {
  if (trailWritten) return;
  trailWritten = true;
  try { localStorage.setItem(TRAIL_KEY, JSON.stringify(trail)); } catch (e) { /* no storage: the next visit is cold too */ }
}
startReader();
window.addEventListener('pagehide', () => { writeTrail(); if (reader) reader.terminate(); });   // a short visit still leaves its trail
cfg.isaacLazyPread = (src, dst, off, len) => {
  try {
    if (!trailWritten && trail.length < TRAIL_MAX) trail.push([src, off, len]);
    if (!trailWritten && (window.isaacFrame | 0) >= 300) writeTrail();
    if (preadTrail.length < 60) preadTrail.push(`${src.replace(/^.*\//, '')}@${(off / 1048576).toFixed(0)}`);
    if (preadStacks.length < 3 && preads > 6) preadStacks.push((new Error().stack || '').split('\n').slice(1, 16).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*$/, '')).join(' < '));
    const wantUrl = reader ? windowUrl(src, off, len) : null;
    if (reader && wantUrl) {
      const key = `${src}@${off}@${len}`, ahead = [];
      // forward through the file, by up to READ_AHEAD windows (the mount pass
      // reads each entry's start in offset order; an entry of a few MB skips
      // windows): the next READ_AHEAD windows are asked for ahead of the engine
      const last = lastRead.has(src) ? lastRead.get(src) : -FS_WINDOW;
      const forward = off > last && off - last <= READ_AHEAD * FS_WINDOW;
      lastRead.set(src, off);
      if (forward && len === FS_WINDOW) {
        const size = lazySizes.get(src) || 0;
        for (let k = 1; k <= READ_AHEAD; k++) {
          const o = off + k * FS_WINDOW;
          if (o >= size) break;
          const l = Math.min(FS_WINDOW, size - o);
          const au = windowUrl(src, o, l);
          if (au) ahead.push([`${src}@${o}@${l}`, au, l]);
        }
      }
      return new Promise((resolve) => {
        const id = ++wantId;
        pendingReads.set(id, { src, off, len, dst, resolve, t0: performance.now() });
        reader.postMessage({ want: id, key, url: wantUrl, len, ahead });
      });
    }
    // round 70: a build with the payload inline has no server to read from
    if (hooks.preadBytes) {
      const got = hooks.preadBytes(src, off, len);
      if (got && typeof got.then === 'function') return got.then((b) => (b ? finishRead(src, off, dst, b) : failRead(src, off, len, 'no bytes')));
      if (got) return finishRead(src, off, dst, got);
    }
    return finishRead(src, off, dst, fetchSync(`/instance/${src}?off=${off}&len=${len}`));
  } catch (e) {
    return failRead(src, off, len, e.message);
  }
};
let presented = 0;
const keepEvery = Number(params.get('keep') || '0');      // also keep every Nth frame
const frameBudget = Number(params.get('frames') || (params.get('ISAAC_YIELD') === '1' ? '100000000' : '5'));
// Which frames are worth reading back off the GPU. The host asks before it
// spends a 2 MB glReadPixels on a frame nobody keeps (round 17): the sampled
// ones, and the tail that ends up in isaacFrames anyway.
let wantedFrame = 0;                                      // the host's frame number for the next present
// An interactive page (ISAAC_YIELD=1, round 25) reads back only explicitly
// sampled frames: the 2 MB glReadPixels per present exists for the headless
// runner's PNGs, and nothing collects the tail from a served page.
const interactive = params.get('ISAAC_YIELD') === '1';
cfg.isaacWantsFrame = (n) => {
  window.isaacFrame = n;
  if (n >= 300 && !trailWritten) writeTrail();            // round 55: the boot's windows, kept for the next visit
  if (!trailArmed) { trailArmed = true; if (trailJobs) armTrail(trailJobs); }   // round 59: the prefetch starts here
  // round 60: the boot is over by frame 600 (the title up, its resources read): the
  // Worker drops the windows it fetched ahead and never handed over (up to the
  // 128 MB budget -- ~80 MB of the renderer's working set) and keeps 8 MB of
  // read-ahead for play; the trail's leftovers go with them
  if (n === READER_CLEAR_FRAME && reader) { reader.postMessage({ clear: true, budget: READER_PLAY_BUDGET }); trailJobs = null; }
  const want = interactive ? (keepEvery ? n % keepEvery === 0 : false)
    : (keepEvery ? (n % keepEvery === 0) : true) || n + KEEP_FRAMES >= frameBudget;
  if (want) wantedFrame = n;
  return want;
};
cfg.isaacPresent = (ptr, w, h) => {
  presented += 1;
  // number the frame by the HOST's counter, not by how many were captured:
  // the readback is skipped for frames nobody keeps (round 17), so the two
  // no longer march together and the sampling below depends on the real one.
  const frame = { n: wantedFrame || presented, w, h, rgba: m.HEAPU8.slice(ptr, ptr + w * h * 4) };
  window.isaacFrames.push(frame);
  // the last KEEP_FRAMES always survive; sampled frames are pinned
  const pinned = window.isaacFrames.filter((f) => keepEvery && f.n % keepEvery === 0);
  const tail = window.isaacFrames.filter((f) => !(keepEvery && f.n % keepEvery === 0)).slice(-KEEP_FRAMES);
  window.isaacFrames = [...pinned, ...tail].sort((a, b) => a.n - b.n);
};

// ---- scripted input ---------------------------------------------------------
// Without ISAAC_YIELD=1 the page's main thread is inside main() for the whole
// run, so no browser event can reach the game; input is then a timeline keyed
// by presented frame (with ISAAC_YIELD=1 the live queue below is served first):
//   ?input=130:Enter,160:Enter,200:Down,230:Enter,300:mouse:480:270,301:click,400:w:30
// A key entry presses at its frame and releases `hold` frames later (default 2). The host's
// PeekMessageW asks Module.isaacInputPoll(frame, out) for the events due at
// or before `frame`, one per call, packed as four int32s at `out`:
//   [1, vk, scancode | (extended << 8), down]   key
//   [2, x, y, 0]                                 mouse move (client coords)
//   [3, button, down, 0]                         mouse button (0 left, 1 right)
const KEYS = {
  enter: [0x0D, 0x1C, 0], escape: [0x1B, 0x01, 0], space: [0x20, 0x39, 0], tab: [0x09, 0x0F, 0],
  backspace: [0x08, 0x0E, 0], up: [0x26, 0x48, 1], down: [0x28, 0x50, 1], left: [0x25, 0x4B, 1],
  right: [0x27, 0x4D, 1], shift: [0x10, 0x2A, 0], ctrl: [0x11, 0x1D, 0], alt: [0x12, 0x38, 0],
  a: [0x41, 0x1E, 0], b: [0x42, 0x30, 0], c: [0x43, 0x2E, 0], d: [0x44, 0x20, 0], e: [0x45, 0x12, 0],
  f: [0x46, 0x21, 0], g: [0x47, 0x22, 0], h: [0x48, 0x23, 0], i: [0x49, 0x17, 0], j: [0x4A, 0x24, 0],
  k: [0x4B, 0x25, 0], l: [0x4C, 0x26, 0], m: [0x4D, 0x32, 0], n: [0x4E, 0x31, 0], o: [0x4F, 0x18, 0],
  p: [0x50, 0x19, 0], q: [0x51, 0x10, 0], r: [0x52, 0x13, 0], s: [0x53, 0x1F, 0], t: [0x54, 0x14, 0],
  u: [0x55, 0x16, 0], v: [0x56, 0x2F, 0], w: [0x57, 0x11, 0], x: [0x58, 0x2D, 0], y: [0x59, 0x15, 0],
  z: [0x5A, 0x2C, 0], '0': [0x30, 0x0B, 0], '1': [0x31, 0x02, 0], '2': [0x32, 0x03, 0], '3': [0x33, 0x04, 0],
  '4': [0x34, 0x05, 0], '5': [0x35, 0x06, 0], '6': [0x36, 0x07, 0], '7': [0x37, 0x08, 0], '8': [0x38, 0x09, 0],
  '9': [0x39, 0x0A, 0], f1: [0x70, 0x3B, 0], f2: [0x71, 0x3C, 0], f3: [0x72, 0x3D, 0], f4: [0x73, 0x3E, 0],
  grave: [0xC0, 0x29, 0],      // the debug console key (GLFW_KEY_GRAVE_ACCENT; the same row as explore.mjs)
  // Round 47: the punctuation row, the same names and codes as explore.mjs -- a
  // typed console command has dots (`goto s.boss.1010` lost its dots: the live
  // keyboard path dropped every key the table did not name)
  minus: [0xBD, 0x0C, 0], equals: [0xBB, 0x0D, 0], lbracket: [0xDB, 0x1A, 0],
  rbracket: [0xDD, 0x1B, 0], backslash: [0xDC, 0x2B, 0], semicolon: [0xBA, 0x27, 0], quote: [0xDE, 0x28, 0],
  comma: [0xBC, 0x33, 0], period: [0xBE, 0x34, 0], slash: [0xBF, 0x35, 0],
};
const timeline = [];
for (const item of (params.get('input') || '').split(',').map((t) => t.trim()).filter(Boolean)) {
  const [fr, what, ...rest] = item.split(':');
  const frame = Number(fr);
  const w = (what || '').toLowerCase();
  if (w === 'mouse') timeline.push({ frame, ev: [2, Number(rest[0] || 0), Number(rest[1] || 0), 0] });
  else if (w === 'click' || w === 'rclick') {
    const btn = w === 'click' ? 0 : 1;
    timeline.push({ frame, ev: [3, btn, 1, 0] });
    timeline.push({ frame: frame + 2, ev: [3, btn, 0, 0] });
  } else if (KEYS[w]) {
    const [vk, sc, ext] = KEYS[w];
    const hold = Math.max(1, Number(rest[0] || 2));      // frame:key[:hold] -- held for `hold` frames
    timeline.push({ frame, ev: [1, vk, sc | (ext << 8), 1] });
    timeline.push({ frame: frame + hold, ev: [1, vk, sc | (ext << 8), 0] });
  } else log(`  input: unknown key '${what}' in '${item}'`);
}
timeline.sort((a, b) => a.frame - b.frame);
let inputsDelivered = 0;
// Round 25: live input. With ISAAC_YIELD=1 the module yields to the event loop
// every frame, so DOM events reach the page while the game runs; they queue
// here and are delivered ahead of the scripted timeline. Keys map through the
// same table by event.code (KeyA -> a, ArrowUp -> up, Enter, Space, ...).
const live = [];
// round 52: the page presses a key for the player (the EDIT FILE menu's Delete
// hands the flow back to the engine with a confirm), by the key table's name
window.isaacInjectKey = (name, down) => { const k = KEYS[String(name).toLowerCase()]; if (k) live.push([1, k[0], k[1] | (k[2] << 8), down ? 1 : 0]); };
const CODE_TO_KEY = { Enter: 'enter', Escape: 'escape', Space: 'space', Tab: 'tab', Backspace: 'backspace',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ShiftLeft: 'shift', ShiftRight: 'shift',
  ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt', Backquote: 'grave',
  Minus: 'minus', Equal: 'equals', BracketLeft: 'lbracket', BracketRight: 'rbracket', Backslash: 'backslash',
  Semicolon: 'semicolon', Quote: 'quote', Comma: 'comma', Period: 'period', Slash: 'slash' };
function keyName(ev) {
  const c = ev.code || '';
  if (CODE_TO_KEY[c]) return CODE_TO_KEY[c];
  if (/^Key[A-Z]$/.test(c)) return c[3].toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c[5];
  if (/^F([1-4])$/.test(c)) return c.toLowerCase();
  return null;
}
const canvasEl = document.getElementById('canvas');
function onKey(ev, down) {
  // round 52: a page menu that is up takes the keys (the engine sees none of them)
  if (typeof window.isaacKeyCapture === 'function' && window.isaacKeyCapture(ev, down)) { ev.preventDefault(); return; }
  const k = keyName(ev);
  if (!k || !KEYS[k]) return;
  if (ev.repeat) { ev.preventDefault(); return; }
  const [vk, sc, ext] = KEYS[k];
  live.push([1, vk, sc | (ext << 8), down ? 1 : 0]);
  ev.preventDefault();
}
// Autoplay policy: an AudioContext created before the first user gesture
// starts suspended, and resume() is honoured once the page has a user
// activation. The first key press (or click) is that activation; resume
// right there so the title music is not waiting for the next play call.
const resumeAudio = () => {
  try { const A = m.isaacAudio; if (A && A.ctx && A.ctx.state === 'suspended') A.ctx.resume(); } catch (e) { /* audio never traps the page */ }
};
// Round 36: a level meter on the master output. The proof that music plays
// is energy, not log lines: the WebAudio backend (host_audio_web.c) routes
// every source through Module.isaacAudio.master and calls
// Module.isaacAudioReady(A) once the AudioContext exists; the page puts an
// AnalyserNode between the master and the destination and keeps the RMS of
// the last second (100 ms blocks, while the page's timers run -- the JSPI
// page yields every frame). window.isaacAudioLevel() answers a driver:
//   { rms, rmsNow, peak, blocks, ctxTime, state, sampleRate, scheduled, played, streams }
// rms is the last second, rmsNow the freshest block (always current, timers
// or not), peak the last second's peak sample.
let audioTap = null;
cfg.isaacAudioReady = (A) => {
  try {
    const an = A.ctx.createAnalyser();
    an.fftSize = 8192;                                   // 171 ms per read at 48 kHz
    A.master.disconnect();
    A.master.connect(an);
    an.connect(A.ctx.destination);
    const buf = new Float32Array(an.fftSize);
    const blocks = [];
    const sample = () => {
      an.getFloatTimeDomainData(buf);
      let ss = 0, pk = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; ss += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      const b = { t: performance.now(), ms: ss / buf.length, peak: pk };
      blocks.push(b);
      while (blocks.length && blocks[0].t < b.t - 1000) blocks.shift();
      return b;
    };
    audioTap = { A, sample, blocks, timer: setInterval(sample, 100) };
    log(`  audio tap: analyser on the master output (${A.ctx.sampleRate} Hz, ${A.ctx.state})`);
  } catch (e) { log(`  audio tap failed: ${e.message}`); }
};
window.isaacAudioLevel = () => {
  if (!audioTap) return null;
  const b = audioTap.sample();
  const bl = audioTap.blocks;
  let ms = 0, peak = 0;
  for (const x of bl) { ms += x.ms; if (x.peak > peak) peak = x.peak; }
  const A = audioTap.A;
  let streams = 0;
  A.sources.forEach((s) => { if (s.playing) streams += 1; });
  return { rms: Math.sqrt(ms / bl.length), rmsNow: Math.sqrt(b.ms), peak, blocks: bl.length,
           ctxTime: A.ctx.currentTime, state: A.ctx.state, sampleRate: A.ctx.sampleRate,
           scheduled: A.scheduled || 0, played: A.played || 0, streams };
};
window.addEventListener('keydown', (ev) => { resumeAudio(); onKey(ev, true); });
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('keyup', (ev) => onKey(ev, false));
canvasEl.addEventListener('mousemove', (ev) => {
  const r = canvasEl.getBoundingClientRect();
  const x = Math.round((ev.clientX - r.left) * canvasEl.width / r.width);
  const y = Math.round((ev.clientY - r.top) * canvasEl.height / r.height);
  // coalesce: the newest position replaces a still-queued move
  if (live.length && live[live.length - 1][0] === 2) live[live.length - 1] = [2, x, y, 0];
  else live.push([2, x, y, 0]);
});
canvasEl.addEventListener('mousedown', (ev) => { live.push([3, ev.button === 2 ? 1 : 0, 1, 0]); ev.preventDefault(); });
canvasEl.addEventListener('mouseup', (ev) => { live.push([3, ev.button === 2 ? 1 : 0, 0, 0]); ev.preventDefault(); });
canvasEl.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvasEl.tabIndex = 0;
canvasEl.focus();
cfg.isaacInputPoll = (frame, out) => {
  if (live.length) {
    m.HEAP32.set(live.shift(), out >> 2);
    inputsDelivered += 1;
    return 1;
  }
  if (!timeline.length || timeline[0].frame > frame) return 0;
  const { ev } = timeline.shift();
  m.HEAP32.set(ev, out >> 2);
  inputsDelivered += 1;
  return 1;
};

let m;
try {
  m = await Module(cfg);
} catch (e) {
  log(`module instantiation failed: ${e.message}`);
  window.isaacDone = { error: `instantiate: ${e.message}` };
  throw e;
}

async function stageOk(name, fn) {
  log(`=== ${name} ===`);
  try {
    return await fn();
  } catch (e) {
    log(`  TRAP in ${name}: ${e.message}`);
    try { if (typeof m._isaac_dump_va_ring === 'function') m._isaac_dump_va_ring(); } catch (e2) { /* best effort */ }
    log(String(e.stack || '').split('\n').slice(1, 4).join('\n'));
    return null;
  }
}
function cstr(s) {
  const bytes = new TextEncoder().encode(s + '\0');
  const p = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, p);
  return p;
}

const done = { mainRc: null, bootRc: null, presented: 0, lazyReads: 0, lazyBytes: 0 };
try {
  // --- memory image
  const blob = await fetchBytes('/isaac.segs.bin');
  const p = m._malloc(blob.length);
  m.HEAPU8.set(blob, p);
  const nseg = await stageOk('place memory image', () => m._isaac_place_image(p, blob.length));
  log(`  isaac.segs.bin ${blob.length} bytes -> ${nseg} segments`);
  m._free(p);
  dropBody(blob);                                           // round 60: this frame lives as long as main() does
  if (nseg === null || nseg < 0) throw new Error('image placement failed');

  // --- layout + guard
  const layoutBad = await stageOk('layout', () => m._isaac_layout_check());
  m._isaac_guard_arm();
  log(`  guard armed (layout ${layoutBad ? 'FAIL' : 'OK'})`);

  // --- seed the packed archives eagerly, the tree lazily
  // music/videos since round 15d; the DLC set since round 24e (windowed --
  // see cfg.isaacLazyPread). The language packs are deliberately absent: a
  // mounted pack would shadow English assets (the mount loop overwrites an
  // equal-hash entry).
  // (repentance.a is not listed: this exe never names it -- round 26)
  const LAZY_ARCHIVES = new Set(['resources/packed/music.a', 'resources/packed/videos.a',
    'resources/packed/afterbirth.a', 'resources/packed/afterbirthp.a']);
  const index = JSON.parse(new TextDecoder().decode(await fetchBytes('/instance_index.json')));
  await stageOk('seed packed archives', async () => {
    let n = 0;
    for (const name of ['graphics.a', 'config.a', 'fonts.a', 'animations.a', 'rooms.a', 'sfx.a']) {
      const rel = `resources/packed/${name}`;
      let bytes;
      try { bytes = await fetchBytes(`/instance/${rel}`); } catch { log(`  (skip ${name}: not served)`); continue; }
      const pp = cstr(rel), dp = m._malloc(bytes.length || 1);
      m.HEAPU8.set(bytes, dp);
      const ok = m._isaac_fs_seed(pp, dp, bytes.length);
      m._free(pp); m._free(dp);
      log(`  seed ${rel} ${bytes.length} bytes -> ${ok ? 'ok' : 'FAIL'}`);
      n += ok ? 1 : 0;
    }
    return n;
  });
  await stageOk('register instance tree lazily', () => {
    let files = 0, bytes = 0;
    for (const { p: rel, s: size } of index) {
      lazySizes.set(rel, size);                           // round 56: the reader's read-ahead stops at the end of a file
      // packed/ is seeded eagerly above -- except the two archives the game
      // opens only once it is playing (music 182 MB, videos 93 MB), which get
      // the same lazy treatment as the tree so they cost nothing until asked
      // for. Node does the same (round 15d).
      if (rel.startsWith('resources/packed/') && !LAZY_ARCHIVES.has(rel)) continue;
      const pp = cstr(rel);
      if (m._isaac_fs_seed_lazy(pp, size)) { files += 1; bytes += size; }
      m._free(pp);
    }
    log(`  registered ${files} files lazily (${(bytes / 1048576).toFixed(1)} MB)`);
    return files;
  });
  // --- round 31: the saves of earlier loads come back from IndexedDB (after
  // the instance tree, so a saved file wins over a seeded one)
  await stageOk('restore saves', async () => {
    if (!persistOn) { log('  persist=0: the save store is off'); return 0; }
    try { saveDb = await openSaveDb(); } catch (e) { log(`  save store unavailable: ${e.message}`); return 0; }
    if (!saveDb) { log('  no IndexedDB here: saves live for this load only'); return 0; }
    const saved = await readSaves();
    let n = 0;
    for (const { key, src, bytes } of saved) {
      const rel = src || key;
      const pp = cstr(rel), dp = m._malloc(bytes.length || 1);
      m.HEAPU8.set(bytes, dp);
      const ok = m._isaac_fs_seed(pp, dp, bytes.length);
      m._free(pp); m._free(dp);
      if (ok) n += 1;
      log(`  restored ${rel} (${bytes.length} bytes) -> ${ok ? 'ok' : 'FAIL'}`);
    }
    log(`  ${n} saved file(s) restored from the store`);
    return n;
  });
  // --- round 74: mods from this browser, seeded where the engine scans for them.
  // After the saves, and into a directory tree of its own: every path is built
  // from an id and a relative name the store already checked, so no mod decides
  // where its bytes land.
  await stageOk('seed mods', async () => {
    if (!modsOn) { log('  mods=0: no mods, and no import row'); return 0; }
    try { modDb = await openModDb(); } catch (e) { log(`  mod store unavailable: ${e.message}`); modDb = null; }
    // Round 85: a mod's Lua is opened by the host Lua's own libc, which reads
    // through MEMFS -- the same reason the game's own scripts are copied there
    // in the next stage. Seeding into the FS shim is not enough: the engine ran
    // the mod and Lua answered `cannot open //mods/<id>/main.lua: No such file
    // or directory`. So every .lua a mod carries goes to MEMFS as well, under
    // the path the engine asks for (`/mods/<id>/...`, which is what `//mods/...`
    // normalises to).
    let luaFiles = 0;
    const memfs = (key, bytes) => {
      if (!/\.lua$/i.test(key)) return;
      const at = String(key).replace(/^c:\/isaac\//i, '/').replace(/\/{2,}/g, '/');
      if (at[0] !== '/') return;
      try {
        m.FS.mkdirTree(at.slice(0, at.lastIndexOf('/')));
        m.FS.writeFile(at, bytes);
        luaFiles += 1;
      } catch (e) { log(`  ${at}: ${e.message}`); }
    };
    const seed = (path, bytes) => {
      const pp = cstr(path), dp = m._malloc(bytes.length || 1);
      m.HEAPU8.set(bytes, dp);
      const ok = m._isaac_fs_seed(pp, dp, bytes.length);
      m._free(pp); m._free(dp);
      if (ok) memfs(path, bytes);
      return !!ok;
    };
    const r = await seedMods(modDb, seed, log);
    log(`  ${r.mods} mod(s), ${r.files} file(s), ${(r.bytes / 1048576).toFixed(2)} MB`
      + (r.off ? `, ${r.off} off` : '') + (r.state ? `, ${r.state} state file(s)` : '')
      + (r.skipped ? `, ${r.skipped} skipped` : '')
      + (luaFiles ? `, ${luaFiles} lua into MEMFS` : ''));
    return r.files;
  });
  // --- the host Lua's libc reads scripts through MEMFS: put them there
  await stageOk('lua scripts into MEMFS', async () => {
    let n = 0;
    for (const { p: rel } of index) {
      if (!rel.startsWith('resources/scripts/')) continue;
      const dir = rel.slice(0, rel.lastIndexOf('/'));
      m.FS.mkdirTree('/' + dir);
      m.FS.writeFile('/' + rel, await fetchBytes(`/instance/${rel}`));
      n += 1;
    }
    log(`  ${n} lua scripts written`);
    return n;
  });

  // --- boot + main
  done.bootRc = await stageOk('host boot (IAT + TEB + TLS + _initterm)', () => m._isaac_run_boot(1));
  log(`  isaac_boot_init -> ${done.bootRc}`);
  if (done.bootRc === null) throw new Error('boot trapped');
  // Round 34: the shipping page waits for its Play button here (a user gesture for WebAudio).
  if (hooks.beforeMain) await hooks.beforeMain(m);
  // Under JSPI (round 25) _isaac_run_main returns a promise that settles when
  // main returns; without it the call is synchronous. Both are awaited here.
  done.mainRc = await stageOk('main @ 0x00931050', () => {
    const r = m._isaac_run_main();
    log(`  _isaac_run_main returned a ${r && typeof r.then === 'function' ? 'promise (JSPI)' : 'value (synchronous)'}`);
    return r;
  });
  log(`  isaac_boot_call_main -> ${done.mainRc}`);
  try { m._isaac_stub_report(); } catch (e) { log(`  stub report failed: ${e.message}`); }
  try { m._isaac_heap_report(); } catch (e) { /* best effort */ }
  log(`RESULT: ${done.mainRc === null ? 'main trapped' : 'main returned ' + done.mainRc}`);
} catch (e) {
  log(`RESULT: aborted: ${e.message}`);
  done.error = e.message;
}
done.presented = presented;
done.lazyReads = lazyReads;
done.lazyBytes = lazyBytes;
log(`  frames presented: ${presented}; lazy reads: ${lazyReads} files, ${(lazyBytes / 1048576).toFixed(1)} MB; scripted inputs delivered: ${inputsDelivered}, pending: ${timeline.length}`);
logEl.textContent = window.isaacLog.slice(-12).join('\n');
window.isaacDone = done;
