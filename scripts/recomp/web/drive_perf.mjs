// drive_perf.mjs -- frame rate of the live page under a Chromebook-like budget.
//
// Chromium with the machine's real GPU (ANGLE over D3D11 here; SwiftShader
// with gl=swiftshader) and the CDP CPU throttle (Emulation.setCPUThrottlingRate)
// standing in for a slow CPU. Drives the interactive page like
// drive_interactive.mjs: Enter until the game logs a run, then samples the
// host's frame counter once a second for `seconds` while walking and firing.
//
//   node scripts/recomp/web/drive_perf.mjs <url> <out-dir> [cpu=4] [gl=hw|swiftshader] [seconds=30]
//
// Writes summary.json (fps samples in the menus and in play, medians, the
// page's own present timings if it exposes them) and console.log. Exit 0
// when the run started and play fps was sampled.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-perf');
const opt = Object.fromEntries(process.argv.slice(4).map((a) => a.split('=')));
const CPU = Number(opt.cpu || '4');
const GL = opt.gl || 'hw';
const SECONDS = Number(opt.seconds || '30');
if (!URL) { console.log('usage: node drive_perf.mjs <url> <out-dir> [cpu=4] [gl=hw|swiftshader] [seconds=30]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = GL === 'swiftshader'
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
// profile_dir=<dir> (round 40): a persistent browser profile, so a second run
// finds the module's optimised code in the HTTP cache (V8's wasm code cache)
// and the archives in the browser cache -- the warm start a returning player
// gets. Without it every run is a cold start with a fresh profile.
const PROFILE_DIR = opt.profile_dir || '';
const launchArgs = [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'];
// js_flags=<v8 flags> (round 40): e.g. --wasm-num-compilation-tasks=2 to stand in
// for a four-core machine's background compiler (the CPU throttle does not).
if (opt.js_flags) launchArgs.push(`--js-flags=${opt.js_flags}`);
const context = PROFILE_DIR
  ? await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, args: launchArgs, viewport: { width: 960, height: 540 } })
  : await (await chromium.launch({ headless: true, args: launchArgs })).newContext({ viewport: { width: 960, height: 540 } });
const browser = context.browser();
const page = await context.newPage();
// fresh_saves=1 (round 40): drop the page's IndexedDB save store before the
// load, so a warm browser profile (the code cache, the HTTP cache) still
// starts a new run instead of continuing the previous driver's -- a
// measurement compares like with like only from the same game state.
const FRESH_SAVES = opt.fresh_saves === '1';
// trace_wasm=1 (round 40): record Chrome's v8.wasm trace events across the
// load and report them -- `v8.wasm.moduleCacheHit` is the proof that the
// optimised code came from the cache, `v8.wasm.cachedModule` that it was
// stored, `v8.wasm.compiledModule` a compile from bytes.
const TRACE_WASM = opt.trace_wasm === '1';
// netlog=1 (round 45): how the module and the image were served -- from the
// network, the disk cache, or a 304 -- with their transfer sizes; the wasm
// code cache can only be reused when the module comes back from the cache.
const NETLOG = opt.netlog === '1';
const netRows = [];
const wasmEvents = new Map();
async function prepare(cdp, url) {
  if (NETLOG) {
    await cdp.send('Network.enable');
    cdp.on('Network.responseReceived', (e) => {
      const r = e.response;
      if (/boot\.wasm|boot\.mjs|isaac\.segs\.bin|play\.html|boot_web\.html/.test(r.url))
        netRows.push({ url: r.url.replace(/^.*\//, ''), status: r.status, fromDiskCache: !!r.fromDiskCache, fromServiceWorker: !!r.fromServiceWorker,
          encoded: r.encodedDataLength, cc: (r.headers['cache-control'] || r.headers['Cache-Control'] || ''), etag: (r.headers.etag || r.headers.ETag || '') });
    });
  }
  if (FRESH_SAVES) {
    const origin = new globalThis.URL(url).origin;       // `URL` here is the argv constant
    await page.goto(origin + '/instance_index.json').catch(() => {});
    await page.evaluate(() => new Promise((r) => { try { const q = indexedDB.deleteDatabase('isaac-saves'); q.onsuccess = q.onerror = q.onblocked = () => r(); } catch (e) { r(); } }));
  }
  if (TRACE_WASM) {
    cdp.on('Tracing.dataCollected', (e) => { for (const ev of e.value || []) if (/wasm/i.test(ev.name || '')) wasmEvents.set(ev.name, (wasmEvents.get(ev.name) || 0) + 1); });
    try {
      await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['v8', 'v8.wasm', 'disabled-by-default-v8.wasm.detailed', 'blink', 'devtools.timeline', 'loading', 'wasm'] }, transferMode: 'ReportEvents' });
    } catch (e) { console.log(`[wasm-trace] Tracing.start failed: ${e.message}`); }
  }
}
async function traceReport(cdp) {
  if (!TRACE_WASM) return null;
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  try { await cdp.send('Tracing.end'); await done; } catch (e) { console.log(`[wasm-trace] Tracing.end failed: ${e.message}`); }
  const list = [...wasmEvents].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`);
  console.log(`[wasm-trace] ${list.join(', ') || 'no v8.wasm events'}`);
  return Object.fromEntries(wasmEvents);
}
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
const cdp = await context.newCDPSession(page);
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
const t0 = Date.now();
const now = () => Date.now() - t0;
const summary = { url: URL, cpu: CPU, gl: GL, seconds: SECONDS, renderer: null, runStartedFrame: null, runStartedMs: null,
                  fpsMenu: [], fpsPlay: [], medianMenu: null, medianPlay: null, memoryTimeline: [], error: null };
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, done: window.isaacDone, n: (window.isaacLog || []).length }));
const logMatch = (re) => page.evaluate((src) => {
  const r = new RegExp(src);
  const log = window.isaacLog || [];
  for (let i = log.length - 1; i >= 0; i--) if (r.test(log[i])) return log[i];
  return null;
}, re.source);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
// memory census (round 37; a timeline since round 40): the page's JS heap and
// the browser's processes' private bytes and working sets, sampled every 5 s
// of play and at the end -- the target is a 4 GB Chromebook, so the renderer
// (wasm memory lives there) and the GPU process are what count.
// memdump=1 (round 42): Chrome's memory-infra dump at chosen moments -- the
// renderer's allocators (v8, partition_alloc, blink_gc, malloc, gpu shared
// memory, ...) by effective size, so a transient can be named, not guessed.
const MEMDUMP = opt.memdump === '1';
const takeMemoryDump = async (label) => {
  if (!MEMDUMP) return;
  const events = [];
  const onData = (e) => { for (const ev of e.value || []) if (ev.ph === 'v') events.push(ev); };
  cdp.on('Tracing.dataCollected', onData);
  try {
    await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } }, transferMode: 'ReportEvents' });
    await cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' });
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end'); await done;
  } catch (e) { console.log(`[memdump] ${label}: ${e.message}`); cdp.off('Tracing.dataCollected', onData); return; }
  cdp.off('Tracing.dataCollected', onData);
  const hex = (x) => (x && x.value ? parseInt(x.value, 16) : 0);
  const mb = (v) => (v / 1048576).toFixed(0);
  try { writeFileSync(join(OUT, `memdump-${label.replace(/[^a-z0-9]+/gi, '_')}.json`), JSON.stringify(events)); } catch (e) { /* diagnostics only */ }
  const perPid = [];
  for (const ev of events) {
    const d = ev.args && ev.args.dumps; if (!d || !d.allocators) continue;
    const tot = d.process_totals || {};
    const rows = [];
    let total = 0, top = 0;
    for (const [name, a] of Object.entries(d.allocators)) {
      const depth = name.split('/').length;
      const v = hex(a.attrs && (a.attrs.effective_size || a.attrs.size));
      if (depth === 1) top += v;
      if (depth <= 2 && v >= 8 * 1048576) rows.push([name, v]);
      total += v;
    }
    rows.sort((x, y) => y[1] - x[1]);
    perPid.push({ pid: ev.pid, top, hasV8: Object.keys(d.allocators).some((n) => n.startsWith('v8')), rss: hex({ value: tot.resident_set_bytes }), pf: hex({ value: tot.private_footprint_bytes }), rows });
  }
  perPid.sort((x, y) => (y.hasV8 - x.hasV8) || (y.top - x.top));      // the renderer: the process with v8 allocators, the biggest of them
  const big = perPid[0];
  if (!big) { console.log(`[memdump] ${label}: no dump events`); return; }
  console.log(`[memdump] ${label}: ${perPid.length} processes; renderer pid ${big.pid}: allocators total ${mb(big.top)} MB, private footprint ${mb(big.pf)} MB, rss ${mb(big.rss)} MB; ${big.rows.slice(0, 16).map(([n, v]) => `${n} ${mb(v)}`).join(', ')}`);
  summary.memDumps = summary.memDumps || []; summary.memDumps.push({ label, pid: big.pid, privateFootprintMB: +mb(big.pf), rows: big.rows.slice(0, 40).map(([n, v]) => [n, +mb(v)]) });
};
const memSnapshot = async () => {
  const m = await page.evaluate(() => {
    const mm = performance.memory;
    return mm ? { jsHeapUsedMB: +(mm.usedJSHeapSize / 1048576).toFixed(1), jsHeapTotalMB: +(mm.totalJSHeapSize / 1048576).toFixed(1) } : {};
  });
  try {
    const { execFileSync } = await import('node:child_process');
    const bcdp = await browser.newBrowserCDPSession();
    const info = await bcdp.send('SystemInfo.getProcessInfo');     // every process of this browser: OS pid + type
    await bcdp.detach();
    if (process.platform === 'win32') {
      const ids = info.processInfo.map((q) => q.id).join(',');
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.WorkingSet64)|$($_.PrivateMemorySize64)" }`],
        { encoding: 'utf8' });
      const typeOf = new Map(info.processInfo.map((q) => [q.id, q.type]));
      m.processes = [];
      for (const line of out.split(/\r?\n/)) {
        const [id, ws, priv] = line.split('|');
        if (!id) continue;
        const type = (typeOf.get(Number(id)) || 'child').toLowerCase().replace(/ /g, '-');
        m.processes.push({ pid: Number(id), type, workingSetMB: +(Number(ws) / 1048576).toFixed(1), privateMB: +(Number(priv) / 1048576).toFixed(1) });
      }
      m.totalPrivateMB = +m.processes.reduce((a, q) => a + q.privateMB, 0).toFixed(1);
      m.rendererMaxWorkingSetMB = Math.max(0, ...m.processes.filter((q) => q.type === 'renderer').map((q) => q.workingSetMB));
      m.gpuWorkingSetMB = Math.max(0, ...m.processes.filter((q) => q.type === 'gpu').map((q) => q.workingSetMB));
    }
  } catch (e) { m.error = e.message; }
  return m;
};
try {
  for (let attempt = 1; ; attempt++) {
    try { if (attempt === 1) await prepare(cdp, URL); await page.goto(URL); break; } catch (e) { if (attempt === 1) console.log(`[prepare] ${e.message}`); if (attempt >= 30) throw e; await sleep(1000); }
  }
  summary.renderer = await page.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? 'webgl (renderer masked)' : 'no webgl');
    } catch (e) { return 'error: ' + e.message; }
  });
  console.log(`[perf] renderer: ${summary.renderer}; cpu throttle x${CPU}`);
  let nextMem = 5000;
  const memTick = async () => { if (now() >= nextMem) { nextMem = now() + 5000; summary.memoryTimeline.push({ t: now(), ...(await memSnapshot()) }); } };
  for (;;) {                                   // first frame
    const s = await state();
    if (s.f > 0) break;
    if (s.done) throw new Error('module ended before the first frame');
    if (now() > 600000) throw new Error('timeout before the first frame');
    await memTick();
    await sleep(250);
  }
  // menu fps for 5 s, then Enter until the run starts
  let last = (await state()).f, lastT = now();
  for (let i = 0; i < 5; i++) { await sleep(1000); const s = await state(); summary.fpsMenu.push((s.f - last) * 1000 / (now() - lastT)); last = s.f; lastT = now(); await memTick(); }
  await takeMemoryDump('menu');
  const startRe = /Room 1\.2\(Start Room\)|Starting room transition/;
  let enters = 0;
  for (;;) {
    if (await logMatch(startRe)) { const s = await state(); summary.runStartedFrame = s.f; summary.runStartedMs = now(); break; }
    if (enters >= 40 || now() > 600000) throw new Error(`no run after ${enters} Enter(s)`);
    await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter');
    enters += 1; await sleep(1500); await memTick();
  }
  console.log(`[perf] run started at frame ${summary.runStartedFrame} (${summary.runStartedMs} ms) after ${enters} Enter(s)`);
  await takeMemoryDump('run start');
  // play: walk in a square and fire, sampling fps each second
  const walk = ['KeyD', 'KeyS', 'KeyA', 'KeyW'], fire = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  last = (await state()).f; lastT = now();
  for (let i = 0; i < SECONDS; i++) {
    const k = walk[i % 4], f = fire[i % 4];
    await page.keyboard.down(k); await page.keyboard.down(f);
    await sleep(1000);
    await page.keyboard.up(k); await page.keyboard.up(f);
    const s = await state();
    summary.fpsPlay.push(Number(((s.f - last) * 1000 / (now() - lastT)).toFixed(1)));
    last = s.f; lastT = now();
    if (s.done) break;
    if (i % 5 === 4) { summary.memoryTimeline.push({ t: now(), ...(await memSnapshot()) }); nextMem = now() + 5000; last = (await state()).f; lastT = now(); }
    if (i === 2 || i === 6 || i === 24) { await takeMemoryDump(`play +${i + 1} s`); last = (await state()).f; lastT = now(); }
  }
  summary.medianMenu = median(summary.fpsMenu); summary.medianPlay = median(summary.fpsPlay);
  summary.wasmTrace = await traceReport(cdp);
  console.log(`[perf] fps menu median ${summary.medianMenu && summary.medianMenu.toFixed(1)}; play median ${summary.medianPlay} over ${summary.fpsPlay.length} s: ${summary.fpsPlay.join(' ')}`);
  summary.lazy = await page.evaluate(() => (typeof window.isaacLazyStats === 'function' ? window.isaacLazyStats() : null));
  if (summary.lazy) console.log(`[perf] lazy reads: ${summary.lazy.reads} whole files, ${(summary.lazy.bytes / 1048576).toFixed(1)} MB; ${summary.lazy.windows} windows (${summary.lazy.distinctWindows} distinct), ${(summary.lazy.windowBytes / 1048576).toFixed(1)} MB; top: ${summary.lazy.top.join(', ')}; trail: ${(summary.lazy.trail || []).join(' ')}`);
  for (const st of (summary.lazy && summary.lazy.stacks) || []) console.log(`[perf] window fetch stack: ${st}`);
  if (NETLOG) { summary.net = netRows; for (const r of netRows) console.log(`[net] ${r.url} ${r.status} ${r.fromDiskCache ? 'disk-cache' : 'network'} encoded ${r.encoded} cc="${r.cc}" etag=${r.etag}`); }
  summary.memory = await memSnapshot();
  {
    const big = (summary.memory.processes || []).filter((q) => q.type === 'renderer' || q.type === 'gpu')
      .map((q) => `${q.type} ${q.privateMB} MB private / ${q.workingSetMB} MB working set`);
    console.log(`[perf] memory: JS heap ${summary.memory.jsHeapUsedMB} MB; ${big.join('; ')}; all children ${summary.memory.totalPrivateMB} MB private`);
    if (summary.memoryTimeline.length)
      console.log(`[perf] memory timeline (renderer working set MB at ${summary.memoryTimeline.map((q) => (q.t / 1000).toFixed(0) + ' s').join(', ')}): ${summary.memoryTimeline.map((q) => q.rendererMaxWorkingSetMB).join(' ')}`);
  }
} catch (e) {
  summary.error = e.message;
  console.log(`[perf] ERROR ${e.message}`);
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n'));
await context.close();
process.exit(summary.error || !summary.fpsPlay.length ? 1 : 0);
