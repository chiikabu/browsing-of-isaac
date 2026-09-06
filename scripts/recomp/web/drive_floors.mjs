// drive_floors.mjs -- a sweep through the game's floors by the debug console
// (round 54): every stage the console can reach, one after the other, with
// the frame rate, the browser's memory and the page's errors watched per
// floor. Floor generation and the level transition run for each; nothing
// else is scripted (the player stands in the start room).
//   node scripts/recomp/web/drive_floors.mjs <url> <out-dir> options=<options.ini> [gl=hw|swiftshader] [cpu=1]
//        [stages=2,3,4,5,6,7,8,9,10,11,12,13,1c,2c,3c,4c]
// options= must enable the console (EnableDebugConsole=1) and is seeded into
// the save store before the module loads (like drive_edges.mjs).
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_floors.mjs <url> <out-dir> options=<options.ini> [gl=hw] [cpu=1] [stages=...]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
if (!opt.options) { console.log('options=<options.ini> with EnableDebugConsole=1 is required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const STAGES = (opt.stages || '2,3,4,5,6,7,8,9,10,11,12,13,1c,2c,3c,4c').split(',').map((s) => s.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const cdp = await page.context().newCDPSession(page);
const cpu = Number(opt.cpu || '1');
if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e));
const checks = [];
const check = (ok, what, detail) => { checks.push(!!ok); console.log(`[floors] ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`); };
const t0 = Date.now();
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, done: window.isaacDone, n: (window.isaacLog || []).length }));
const logMatch = (re, since = 0) => page.evaluate(([src, s]) => { const r = new RegExp(src); const log = window.isaacLog || []; for (let i = log.length - 1; i >= s; i--) if (r.test(log[i])) return log[i]; return null; }, [re.source, since]);
const hold = async (key, ms = 100) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const typeSlow = async (text) => { for (const ch of text) { await page.keyboard.down(ch === ' ' ? 'Space' : ch); await sleep(60); await page.keyboard.up(ch === ' ' ? 'Space' : ch); await sleep(40); } };
const fpsOver = async (ms) => { const a = await state(); const ta = Date.now(); await sleep(ms); const b = await state(); return (b.f - a.f) * 1000 / (Date.now() - ta); };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); } };
const memory = async () => {
  const m = await page.evaluate(() => { const mm = performance.memory; return mm ? { jsHeapMB: +(mm.usedJSHeapSize / 1048576).toFixed(1) } : {}; });
  try {
    const { execFileSync } = await import('node:child_process');
    const bcdp = await browser.newBrowserCDPSession();
    const info = await bcdp.send('SystemInfo.getProcessInfo');
    await bcdp.detach();
    if (process.platform === 'win32') {
      const ids = info.processInfo.map((q) => q.id).join(',');
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.WorkingSet64)|$($_.PrivateMemorySize64)" }`], { encoding: 'utf8' });
      const typeOf = new Map(info.processInfo.map((q) => [q.id, q.type]));
      let renderer = 0, gpu = 0;
      for (const line of out.split(/\r?\n/)) {
        const [id, ws] = line.split('|');
        if (!id) continue;
        const type = String(typeOf.get(Number(id)) || '').toLowerCase();
        const mb = Number(ws) / 1048576;
        if (type === 'renderer') renderer = Math.max(renderer, mb);
        if (type === 'gpu') gpu = Math.max(gpu, mb);
      }
      m.rendererWorkingSetMB = +renderer.toFixed(0); m.gpuWorkingSetMB = +gpu.toFixed(0);
    }
  } catch (e) { m.error = e.message; }
  return m;
};

const floors = [];
try {
  const origin = new globalThis.URL(URL).origin;
  const bytes = [...readFileSync(opt.options)];
  await page.goto(origin + '/instance_index.json').catch(() => {});
  const seeded = await page.evaluate(async (arr) => new Promise((resolve) => {
    const req = indexedDB.open('isaac-saves', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
    req.onerror = () => resolve('open failed: ' + req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ src: null, bytes: new Uint8Array(arr) }, 'c:/isaac/documents/my games/binding of isaac repentance+/options.ini');
      tx.oncomplete = () => { db.close(); resolve('ok'); };
      tx.onerror = () => resolve('tx failed: ' + tx.error);
    };
  }), bytes);
  check(seeded === 'ok', 'options.ini seeded into the save store', seeded);
  await page.goto(URL);
  await until(async () => (await state()).f > 0, 600000, 'first frame');
  check(true, 'first frame', `${Date.now() - t0} ms`);
  // into a run: Enter until the first level inits (the intro, the title, the file, the menu, the character)
  let enters = 0;
  for (;;) {
    if (await logMatch(/Level::Init m_Stage|RNG Start Seed/)) break;
    if (enters >= 10) throw new Error('no run after 10 Enters');
    await hold('Enter'); enters += 1; await sleep(1500);
  }
  await sleep(2500);
  const first = await logMatch(/Level::Init m_Stage (\d+), m_StageType (\d+)/);
  check(!!first, 'a run started', first ? first.replace(/^.*Level::Init /, '') : 'no Level::Init');
  const base = await memory();
  floors.push({ stage: 'start', ...base, fps: +(await fpsOver(2000)).toFixed(1) });
  console.log(`[floors] start: ${JSON.stringify(floors[0])}`);
  await hold('Backquote', 120); await sleep(600);              // the console stays open through the sweep
  for (const st of STAGES) {
    const num = parseInt(st, 10), letter = st.replace(/^\d+/, '');
    const before = (await state()).n;
    await typeSlow(`stage ${st}`); await sleep(200);
    await hold('Enter', 120);
    const line = await until(async () => logMatch(new RegExp(`Level::Init m_Stage ${num}, m_StageType (\\d+)`), before), 12000, `stage ${st}`).catch(() => null);
    await sleep(2500);                                           // the transition, the room's first frames
    const fps = await fpsOver(2000);
    const mem = await memory();
    const err = consoleLines.find((l) => /PAGEERROR|abort\(|RuntimeError/.test(l));
    const entry = { stage: st, init: line ? line.replace(/^.*Level::Init /, '') : null, fps: +fps.toFixed(1), ...mem };
    floors.push(entry);
    check(!!line && fps > 20 && !err, `stage ${st}${letter ? '' : ''}`, `${entry.init || 'no Level::Init'}; ${entry.fps} fps; renderer ${entry.rendererWorkingSetMB} MB, gpu ${entry.gpuWorkingSetMB} MB${err ? '; ' + err.slice(0, 80) : ''}`);
    if (err) break;
  }
  await hold('Backquote', 120); await sleep(400);
  await page.screenshot({ path: join(OUT, 'last-floor.png') });
  const ws = floors.map((f) => f.rendererWorkingSetMB || 0);
  const grew = Math.max(...ws) - (ws[0] || 0);
  check(grew < 400, 'the renderer working set stays within 400 MB of the first floor across the sweep', `${ws[0]} -> ${Math.max(...ws)} MB (max), gpu max ${Math.max(...floors.map((f) => f.gpuWorkingSetMB || 0))} MB`);
  const err = consoleLines.find((l) => /PAGEERROR|abort\(|RuntimeError/.test(l));
  check(!err, 'no page error across the sweep', err || '');
} catch (e) {
  check(false, 'the drive', String(e && e.message || e));
  try { await page.screenshot({ path: join(OUT, 'failure.png') }); } catch (e2) { /* page gone */ }
}
writeFileSync(join(OUT, 'floors.json'), JSON.stringify({ url: URL, floors, checks }, null, 1));
try { writeFileSync(join(OUT, 'page.log'), (await page.evaluate(() => (window.isaacLog || []).join('\n'))) || ''); } catch (e) { /* page gone */ }
const ok = checks.every(Boolean);
console.log(`[floors] ${ok ? 'PASS' : 'FAIL'}: ${checks.filter(Boolean).length}/${checks.length} checks; ${floors.length - 1} floor(s)`);
await browser.close();
process.exit(ok ? 0 : 1);
