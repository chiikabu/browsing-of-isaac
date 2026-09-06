// drive_memory.mjs -- where the renderer's memory goes, by allocator (round 60):
//   node scripts/recomp/web/drive_memory.mjs http://127.0.0.1:8200/play.html <out-dir> [gl=hw] [cpu=1] [frame=600] [options=<ini> stage=2]
// The page boots, plays to `frame` (and, with options= and stage=, into a floor by
// console as drive_floors does), then Chrome's memory-infra takes a detailed
// dump through CDP tracing: every allocator's effective size in the renderer
// (v8 heaps and code, wasm memory as array buffers, blink, partition_alloc,
// malloc, skia, the discardable and shared memory) and in the GPU process.
// The top allocators and the totals are printed and written to <out-dir>/memory.json.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_memory.mjs <url> <out-dir> [gl=hw] [cpu=1] [frame=600] [options=<ini> stage=2]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  const T = { calls: 0, bytes: 0, maxBytes: 0, maxWH: '', over4MB: 0, over16MB: 0, sizes: {} };
  window.__texUploads = T;
  const bpp = (fmt, type) => (type === 0x1401 ? (fmt === 0x1908 ? 4 : fmt === 0x1907 ? 3 : 1) : 4);
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    const orig = C.prototype.texImage2D;
    C.prototype.texImage2D = function (...a) {
      try {
        if (a.length >= 9 && typeof a[3] === 'number' && typeof a[4] === 'number') {
          const w = a[3], h = a[4], n = w * h * bpp(a[6], a[7]);
          T.calls++; T.bytes += n; if (n > T.maxBytes) { T.maxBytes = n; T.maxWH = `${w}x${h}`; }
          if (n >= 4194304) T.over4MB++; if (n >= 16777216) T.over16MB++;
          const k = `${w}x${h}`; T.sizes[k] = (T.sizes[k] || 0) + 1;
        }
      } catch (e) { /* never in the way */ }
      return orig.apply(this, a);
    };
  }
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const cdp = await page.context().newCDPSession(page);
const cpu = Number(opt.cpu || '1');
if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0 }));
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); } };
const hold = async (key, ms = 90) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const logMatch = (re, since = 0) => page.evaluate(([src, s]) => { const r = new RegExp(src); const log = window.isaacLog || []; for (let i = log.length - 1; i >= s; i--) if (r.test(log[i])) return log[i]; return null; }, [re.source, since]);
const t0 = Date.now();
const out = { url: URL, cpu, frame: Number(opt.frame || '600') };
// the OS's view of the processes (drive_floors' way): working set and private bytes of the renderer and the GPU process
const osMemory = async () => {
  const m = await page.evaluate(() => { const mm = performance.memory; return mm ? { jsHeapMB: +(mm.usedJSHeapSize / 1048576).toFixed(1) } : {}; });
  try {
    const { execFileSync } = await import('node:child_process');
    const bcdp = await browser.newBrowserCDPSession();
    const info = await bcdp.send('SystemInfo.getProcessInfo');
    await bcdp.detach();
    if (process.platform === 'win32') {
      const ids = info.processInfo.map((q) => q.id).join(',');
      const text = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.WorkingSet64)|$($_.PrivateMemorySize64)" }`], { encoding: 'utf8' });
      const typeOf = new Map(info.processInfo.map((q) => [q.id, q.type]));
      for (const line of text.split(/\r?\n/)) {
        const [id, ws, priv] = line.split('|');
        if (!id) continue;
        const type = String(typeOf.get(Number(id)) || '').toLowerCase();
        if (type === 'renderer' && Number(ws) / 1048576 > (m.rendererWorkingSetMB || 0)) { m.rendererWorkingSetMB = +(Number(ws) / 1048576).toFixed(0); m.rendererPrivateMB = +(Number(priv) / 1048576).toFixed(0); m.rendererPid = Number(id); }
        if (type === 'gpu') { m.gpuWorkingSetMB = +(Number(ws) / 1048576).toFixed(0); m.gpuPrivateMB = +(Number(priv) / 1048576).toFixed(0); }
      }
    }
  } catch (e) { m.error = e.message; }
  return m;
};
try {
  if (opt.options) {
    const origin = new globalThis.URL(URL).origin;
    const bytes = [...readFileSync(opt.options)];
    await page.goto(origin + '/instance_index.json').catch(() => {});
    await page.evaluate(async (arr) => new Promise((resolve) => {
      const req = indexedDB.open('isaac-saves', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
      req.onerror = () => resolve('open failed');
      req.onsuccess = () => { const db = req.result, tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ src: null, bytes: new Uint8Array(arr) }, 'c:/isaac/documents/my games/binding of isaac repentance+/options.ini'); tx.oncomplete = () => { db.close(); resolve('ok'); }; };
    }), bytes);
  }
  await page.goto(URL);
  await until(async () => (await state()).f >= out.frame, 600000, `frame ${out.frame}`);
  console.log(`[memory] frame ${out.frame} at ${Date.now() - t0} ms`);
  if (opt.stage) {
    // into a run the floors driver's way: Enter until the first level inits, then `stage N` in the console
    let enters = 0;
    for (;;) {
      if (await logMatch(/Level::Init m_Stage|RNG Start Seed/)) break;
      if (enters >= 10) throw new Error('no run after 10 Enters');
      await hold('Enter'); enters += 1; await sleep(1500);
    }
    await sleep(2500);
    const num = parseInt(opt.stage, 10);
    const before = await page.evaluate(() => (window.isaacLog || []).length);
    await hold('Backquote', 120); await sleep(600);
    await page.keyboard.type(`stage ${opt.stage}`, { delay: 70 }); await sleep(200);
    await hold('Enter', 120);
    await until(async () => logMatch(new RegExp(`Level::Init m_Stage ${num}, m_StageType (\\d+)`), before), 15000, `stage ${opt.stage}`);
    await sleep(2500);
    await hold('Backquote', 120); await sleep(400);
    await sleep(2000);
    console.log(`[memory] stage ${opt.stage} at ${Date.now() - t0} ms`);
  }
  await sleep(2000);
  out.osBeforeGc = await osMemory();
  console.log(`[memory] OS before GC: renderer working set ${out.osBeforeGc.rendererWorkingSetMB} MB (private ${out.osBeforeGc.rendererPrivateMB}), gpu ${out.osBeforeGc.gpuWorkingSetMB} MB, js heap ${out.osBeforeGc.jsHeapMB} MB`);
  // the garbage collected first: what a reading catches otherwise is the collector's timing
  for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); await sleep(700); }
  out.os = await osMemory();
  console.log(`[memory] OS after GC: renderer working set ${out.os.rendererWorkingSetMB} MB (private ${out.os.rendererPrivateMB} MB, pid ${out.os.rendererPid}), gpu ${out.os.gpuWorkingSetMB} MB (private ${out.os.gpuPrivateMB}), js heap ${out.os.jsHeapMB} MB`);
  out.tex = await page.evaluate(() => { const T = window.__texUploads; if (!T) return null; const top = Object.entries(T.sizes).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`); return { calls: T.calls, MB: +(T.bytes / 1048576).toFixed(1), maxMB: +(T.maxBytes / 1048576).toFixed(1), maxWH: T.maxWH, over4MB: T.over4MB, over16MB: T.over16MB, top }; });
  if (out.tex) console.log(`[memory] texImage2D: ${out.tex.calls} uploads, ${out.tex.MB} MB in all, the largest ${out.tex.maxMB} MB (${out.tex.maxWH}); ${out.tex.over4MB} of 4 MB or more, ${out.tex.over16MB} of 16 MB or more; most common ${out.tex.top.join(', ')}`);
  // a detailed memory-infra dump through tracing
  const dumps = [];
  cdp.on('Tracing.dataCollected', (e) => { for (const ev of e.value || []) if (ev.ph === 'v' && ev.args && ev.args.dumps) dumps.push(ev); });
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [{ mode: 'detailed', periodic_interval_ms: 1000 }] } } });
  await sleep(2600);
  await cdp.send('Tracing.end');
  await done;
  // the last dump per process; sizes from effective_size (else size)
  const byPid = new Map();
  for (const ev of dumps) byPid.set(ev.pid, ev);
  const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v || 0));
  const procs = [];
  for (const [pid, ev] of byPid) {
    const allocs = ev.args.dumps.allocators || {};
    const rows = [];
    for (const [name, a] of Object.entries(allocs)) {
      const attrs = a.attrs || {};
      const eff = attrs.effective_size ? hex(attrs.effective_size.value) : (attrs.size ? hex(attrs.size.value) : 0);
      const size = attrs.size ? hex(attrs.size.value) : 0;
      rows.push({ name, effective: eff, size });
    }
    const totals = ev.args.dumps.process_totals || {};
    const resident = totals.resident_set_bytes ? hex(totals.resident_set_bytes) : 0;
    const priv = totals.private_footprint_bytes ? hex(totals.private_footprint_bytes) : 0;
    // top-level allocators (no slash) carry the roll-ups
    const top = rows.filter((r) => !r.name.includes('/')).sort((a, b) => b.effective - a.effective);
    const leaves = rows.filter((r) => r.name.includes('/')).sort((a, b) => b.effective - a.effective).slice(0, 30);
    procs.push({ pid, resident, privateFootprint: priv, top, leaves, level: ev.args.dumps.level_of_detail });
  }
  procs.sort((a, b) => b.resident - a.resident);
  const mb = (n) => (n / 1048576).toFixed(1);
  for (const p of procs) {
    console.log(`[memory] pid ${p.pid}: resident ${mb(p.resident)} MB, private footprint ${mb(p.privateFootprint)} MB (${p.level})`);
    for (const r of p.top.slice(0, 12)) console.log(`[memory]   ${mb(r.effective).padStart(8)} MB  ${r.name}`);
    console.log('[memory]   -- the largest leaves:');
    for (const r of p.leaves.slice(0, 22)) console.log(`[memory]   ${mb(r.effective).padStart(8)} MB  ${r.name}`);
  }
  out.processes = procs;
  out.errors = errors;
  writeFileSync(join(OUT, 'memory.json'), JSON.stringify(out, null, 1));
  console.log(`[memory] ${dumps.length} dump event(s), ${procs.length} process(es); errors ${errors.length}`);
} catch (e) {
  console.log(`[memory] FAIL ${e.message}`);
  await browser.close();
  process.exit(1);
}
await browser.close();
