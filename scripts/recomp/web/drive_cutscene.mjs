// drive_cutscene.mjs -- the endings, one at a time, through the game's own
// console. Reported: a trap during Womb/Eden cutscene 4, "memory access out of
// bounds". A cutscene is the one thing in the game that plays a Theora stream
// and then hands control back, so it touches the video archive, the ending
// sprite sheets and the credits text in one go -- and any of those can be the
// read that goes out of bounds.
//
//   node scripts/recomp/web/drive_cutscene.mjs <url> <out-dir> options=<options.ini>
//        [ids=1,2,3,4,5] [gl=hw|swiftshader] [cpu=1] [wait=20000]
//
// options= must enable the console (EnableDebugConsole=1); it is seeded into
// the save store before the module loads, as drive_floors.mjs does.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_cutscene.mjs <url> <out-dir> options=<options.ini> [ids=1,2,3,4,5]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
if (!opt.options) { console.log('options=<options.ini> with EnableDebugConsole=1 is required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const IDS = (opt.ids || '4').split(',').map((s) => s.trim()).filter(Boolean);
const WAIT = Number(opt.wait || 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
if (opt.cpu && opt.cpu !== '1') { const c = await page.context().newCDPSession(page); await c.send('Emulation.setCPUThrottlingRate', { rate: Number(opt.cpu) }); }
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e));

const checks = [];
const check = (ok, what, detail) => { checks.push(!!ok); console.log(`[cutscene] ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`); };
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, n: (window.isaacLog || []).length }));
const logSince = (s) => page.evaluate((from) => (window.isaacLog || []).slice(from), s);
const logMatch = (re, since = 0) => page.evaluate(([src, s]) => { const r = new RegExp(src); const log = window.isaacLog || []; for (let i = log.length - 1; i >= s; i--) if (r.test(log[i])) return log[i]; return null; }, [re.source, since]);
const hold = async (key, ms = 100) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const typeSlow = async (text) => { for (const ch of text) { await page.keyboard.down(ch === ' ' ? 'Space' : ch); await sleep(60); await page.keyboard.up(ch === ' ' ? 'Space' : ch); await sleep(40); } };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); } };

const runs = [];
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
  await until(async () => (await state()).f > 0, 900000, 'first frame');
  // patient enough for a real host: the first frame arrives long before the
  // menus are responsive when the payload is still streaming in
  let enters = 0;
  for (;;) {
    if (await logMatch(/Level::Init m_Stage|RNG Start Seed/)) break;
    if (enters >= 40) throw new Error('no run after 40 Enters');
    await hold('Enter'); await sleep(500); await hold('Space'); enters += 1; await sleep(2000);
  }
  await sleep(2500);
  check(!!(await logMatch(/Level::Init m_Stage/)), 'a run started');
  await hold('Backquote', 120); await sleep(600);

  for (const id of IDS) {
    const before = (await state()).n;
    const f0 = (await state()).f;
    await typeSlow(`cutscene ${id}`); await sleep(200);
    await hold('Enter', 120);
    await sleep(WAIT);
    const s = await state().catch(() => null);
    const lines = await logSince(before).catch(() => []);
    const trap = lines.find((l) => /TRAP|out of bounds|RuntimeError|abort\(/.test(l))
      || consoleLines.find((l) => /TRAP|out of bounds|RuntimeError|abort\(/.test(l));
    const advanced = s ? s.f - f0 : -1;
    runs.push({ id, frames: advanced, trap: trap || null, tail: lines.slice(-14) });
    check(!trap && advanced > 0, `cutscene ${id}`, trap ? trap.slice(0, 200) : `${advanced} frame(s)`);
    await page.screenshot({ path: join(OUT, `cutscene-${id}.png`) }).catch(() => {});
    if (trap) break;
    // back to a state where the next command can be typed
    await hold('Enter', 120); await sleep(1200);
  }
} catch (e) {
  check(false, 'the drive', String(e && e.message || e));
  try { await page.screenshot({ path: join(OUT, 'failure.png') }); } catch (e2) { /* page gone */ }
}
writeFileSync(join(OUT, 'cutscenes.json'), JSON.stringify({ url: URL, runs, checks }, null, 1));
try { writeFileSync(join(OUT, 'page.log'), (await page.evaluate(() => (window.isaacLog || []).join('\n'))) || ''); } catch (e) { /* page gone */ }
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n'));
const ok = checks.every(Boolean);
console.log(`[cutscene] ${ok ? 'PASS' : 'FAIL'}: ${checks.filter(Boolean).length}/${checks.length} checks`);
await browser.close();
process.exit(ok ? 0 : 1);
