// drive_editfile.mjs -- the save-select screen's EDIT FILE menu, driven the
// way a player reaches it, on the shipping page (round 52):
//   node scripts/recomp/web/drive_editfile.mjs http://127.0.0.1:8200/play.html <out-dir> [gl=hw|swiftshader]
// Title screen -> save select (Enter) -> the EDIT FILE strip (Down, Enter puts
// the menu in file-choosing mode) -> confirm on file 1: the page's menu opens
// instead of the engine's prompt. Then: BACK closes it; DELETE hands the flow
// back to the engine (the page names the slot and presses confirm; the gate
// consumes the name), and Backspace leaves the engine's own prompt; N flips
// the FPS readout, remembered by the browser and never by the saves store.
// Screenshots land in <out-dir>.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_editfile.mjs <url> <out-dir> [gl=hw]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e));
const checks = [];
const check = (ok, what, detail) => { checks.push(!!ok); console.log(`[edit] ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`); };
const t0 = Date.now();
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, open: !!(window.isaacEditFileMenu && window.isaacEditFileMenu.isOpen()), del: window.isaacEditFileDelete, n: (window.isaacLog || []).length }));
const logMatch = (re, since = 0) => page.evaluate(([src, s]) => { const r = new RegExp(src); const log = window.isaacLog || []; for (let i = log.length - 1; i >= s; i--) if (r.test(log[i])) return log[i]; return null; }, [re.source, since]);
const hold = async (key, ms = 90) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(120); } };

try {
  // options= seeds an options.ini into the save store before the module loads
  // (AcceptedPublicBeta_v1.9.7.17=1 keeps the beta notice off the way in)
  if (opt.options) {
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
    check(seeded === 'ok', 'options.ini seeded into the save store', `${bytes.length} bytes, ${seeded}`);
  }
  await page.goto(URL);
  await until(async () => (await state()).f > 0, 600000, 'first frame');
  check(true, 'first frame', `${Date.now() - t0} ms`);
  // every menu logs its Init at boot, so the log cannot say which screen is up;
  // the way in is the player's: once frames flow, Enter skips the intro, Enter
  // leaves the title screen, and the file select appears (its papers animate in)
  await until(async () => (await state()).f > 120, 60000, 'the engine running');
  await hold('Enter'); await sleep(1500);
  await hold('Enter'); await sleep(2500);
  const started = await logMatch(/RNG Start Seed|Level::Init m_Stage/);
  check(!started, 'the file select screen (no run started by the way in)', started ? started.slice(0, 80) : 'two Enters from the first frames');
  // Down: the cursor onto the EDIT FILE strip; Enter: file-choosing mode; Enter on file 1: the page's menu
  await hold('ArrowDown'); await sleep(600);
  await hold('Enter'); await sleep(900);
  const since = (await state()).n;
  await hold('Enter');
  let st = await until(async () => { const s = await state(); return s.open ? s : null; }, 5000, 'the EDIT FILE menu opening').catch(() => null);
  check(st && st.open, 'confirming on a file opens the EDIT FILE menu, not the engine prompt', st ? `open at frame ${st.f}` : 'not open');
  await sleep(600);
  await page.screenshot({ path: join(OUT, 'menu-open.png') });
  // BACK closes it -- walked to by name, because MODS joined the list in round 82
  const rows = await page.evaluate(() => window.isaacEditFileMenu.rows());
  check(rows.includes('MODS'), 'the file menu carries MODS, the way to the mods menu with no mod installed', rows.join(' / '));
  for (let i = 0; i < 8; i++) {
    const at = await page.evaluate(() => window.isaacEditFileMenu.current());
    if (at === 'BACK') break;
    await hold('ArrowDown'); await sleep(150);
  }
  await hold('Enter'); await sleep(400);
  st = await state();
  check(!st.open, 'BACK closes the menu', `open=${st.open}`);
  // N flips the FPS readout (no menu entry, no setting in the store). Round 81:
  // for this visit only -- it used to be remembered in localStorage, so one press
  // of a bare key left a readout over the game for good.
  await hold('KeyN'); await sleep(600);
  const fpsOn = await page.evaluate(() => ({ stored: localStorage.getItem('isaac-fps-viewer'), on: window.isaacEditFileMenu.fpsViewer() }));
  check(fpsOn.on && fpsOn.stored === null, 'N turns the FPS readout on, and nothing remembers it', JSON.stringify(fpsOn));
  const noStore = await page.evaluate(async () => new Promise((resolve) => {
    const req = indexedDB.open('isaac-saves', 1);
    req.onerror = () => resolve('open failed');
    req.onsuccess = () => { const db = req.result; const g = db.transaction('files', 'readonly').objectStore('files').get('page-settings.json'); g.onsuccess = () => { db.close(); resolve(g.result ? 'present' : 'absent'); }; g.onerror = () => resolve('error'); };
  }));
  check(noStore === 'absent', 'the readout is no save: nothing lands in the saves store', noStore);
  // open again: the game is still in file-choosing mode, so one confirm does it
  await hold('Enter');
  st = await until(async () => { const s = await state(); return s.open ? s : null; }, 5000, 'the menu opening again').catch(() => null);
  check(st && st.open, 'the menu opens again on the next confirm', st ? 'open' : 'not open');
  await sleep(300);
  await page.screenshot({ path: join(OUT, 'menu-fps.png') });
  // DELETE FILE: the menu closes and the engine's own prompt takes over (the gate consumes the named slot)
  for (let i = 0; i < 2; i++) { await hold('ArrowDown'); await sleep(150); }
  await hold('Enter'); await sleep(900);
  st = await state();
  check(!st.open && st.del === -1, 'DELETE hands the flow to the engine: menu closed, the named slot consumed by the gate', `open=${st.open} del=${st.del}`);
  await sleep(800);
  await page.screenshot({ path: join(OUT, 'engine-prompt.png') });
  const fpsVisible = await page.evaluate(() => { const e = document.getElementById('fps-viewer'); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; });
  check(fpsVisible, 'the FPS VIEWER shows while playing', `visible=${fpsVisible}`);
  // Backspace: the engine's prompt says no
  await hold('Backspace'); await sleep(800);
  await page.screenshot({ path: join(OUT, 'after-no.png') });
  const err = consoleLines.find((l) => /PAGEERROR|abort\(|RuntimeError/.test(l));
  check(!err, 'no page error', err || '');
  const menuLog = consoleLines.filter((l) => l.startsWith('[menu]'));
  console.log(`[edit] menu log: ${menuLog.slice(0, 6).join(' | ')}`);
} catch (e) {
  check(false, 'the drive', String(e && e.message || e));
  try { await page.screenshot({ path: join(OUT, 'failure.png') }); } catch (e2) { /* page gone */ }
}
const ok = checks.every(Boolean);
console.log(`[edit] ${ok ? 'PASS' : 'FAIL'}: ${checks.filter(Boolean).length}/${checks.length} checks`);
await browser.close();
process.exit(ok ? 0 : 1);
