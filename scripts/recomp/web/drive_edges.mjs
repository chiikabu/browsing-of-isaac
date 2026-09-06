// drive_edges.mjs -- the browser's edge cases, driven for real (round 47).
//
//   node scripts/recomp/web/drive_edges.mjs <url> <out-dir> [cpu=1] [gl=hw|swiftshader] [options=<options.ini>] [headed=1] [hidden_s=8]
//
// Against the served interactive page (run_web.mjs serve=1 interactive=1, or
// the dist's play.html?autoplay=1):
//   1. the typed debug console: `stage 2` then `goto s.boss.1010` typed with
//      real key events (the page maps event.code, the host's TranslateMessage
//      makes the WM_CHARs) -- a floor change and a room transition into a boss
//      room, read back from the game's own log. The console needs
//      EnableDebugConsole=1 in options.ini, seeded into the page's IndexedDB
//      store before the load (options=<file>; the store restores it before main);
//   2. the hidden tab: document.hidden is made to read true for hidden_s
//      seconds (neither a headless page nor a tab behind another one reports
//      itself hidden under Playwright, so the page's own signal is forged --
//      the yield, the audio and the game react exactly as to a real hidden
//      tab); the game must slow to its hidden tick, keep its audio context,
//      and come back to full rate with no catch-up stall;
//   3. music across it: the master-output RMS before, during and after;
//   4. save and continue (round 49): after the console put the run on stage 2,
//      the page is reloaded in the same browser context (the IndexedDB save
//      store persists), the run is continued through the menu, and the
//      game's log must show the SAME run resuming: "RNG Start Seed: <seed>
//      [Continue, n]" with the seed the run had before the reload, not
//      "[New, n]" with a fresh one -- a continue logs no Level::Init (the
//      floor is loaded, not generated) and the room line names
//      type.variant, not the stage, so the seed is what the log offers
//      (skipped without options=, which also gates the console);
//   5. no animation frames (round 49): requestAnimationFrame is replaced by a
//      no-op while the page stays visible (an occluded embedded view does
//      this, document.hidden false and all); the game must tick on the
//      yield's fallback timer instead of stalling, then resume at full rate.
// Writes summary.json and prints one line per check; exit 0 when all pass.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-edges');
const opt = Object.fromEntries(process.argv.slice(4).map((a) => a.split('=')));
const CPU = Number(opt.cpu || '1');
const GL = opt.gl || 'hw';
if (!URL) { console.log('usage: node drive_edges.mjs <url> <out-dir> [cpu=1] [gl=hw|swiftshader] [options=<options.ini>]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = GL === 'swiftshader'
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
const HEADED = opt.headed === '1';
const browser = await chromium.launch({ headless: !HEADED, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await context.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push(`PAGEERROR ${e.message}`));
const cdp = await context.newCDPSession(page);
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
const t0 = Date.now(); const now = () => Date.now() - t0;
const checks = [];
const check = (ok, what, detail) => { checks.push({ ok: !!ok, what, detail }); console.log(`[edges] ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`); };
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, done: window.isaacDone, n: (window.isaacLog || []).length }));
const logMatch = (re, since = 0) => page.evaluate(([src, s]) => {
  const r = new RegExp(src); const log = window.isaacLog || [];
  for (let i = log.length - 1; i >= s; i--) if (r.test(log[i])) return log[i];
  return null;
}, [re.source, since]);
const audio = () => page.evaluate(() => (typeof window.isaacAudioLevel === 'function' ? window.isaacAudioLevel() : null));
const hold = async (code, ms) => { await page.keyboard.down(code); await sleep(ms); await page.keyboard.up(code); };
const typeSlow = async (text) => { for (const ch of text) { await page.keyboard.down(ch === ' ' ? 'Space' : ch); await sleep(60); await page.keyboard.up(ch === ' ' ? 'Space' : ch); await sleep(40); } };
const fpsOver = async (ms) => { const a = await state(); const ta = now(); await sleep(ms); const b = await state(); return (b.f - a.f) * 1000 / (now() - ta); };

try {
  const origin = new globalThis.URL(URL).origin;
  // seed options.ini into the save store before the module loads
  if (opt.options) {
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
  for (let attempt = 1; ; attempt++) { try { await page.goto(URL); break; } catch (e) { if (attempt >= 30) throw e; await sleep(1000); } }
  for (;;) { const s = await state(); if (s.f > 0) break; if (s.done) throw new Error('module ended before the first frame'); if (now() > 600000) throw new Error('no first frame'); await sleep(250); }
  check(true, 'first frame', `${now()} ms`);
  if (opt.options) {
    const restored = await logMatch(/restored .*options\.ini/);
    check(!!restored, 'the store restored options.ini before main', restored || 'no restore line');
  }
  // a run
  const startRe = /Room 1\.2\(Start Room\)|Starting room transition/;
  let enters = 0;
  for (;;) {
    if (await logMatch(startRe)) break;
    if (enters >= 40 || now() > 600000) throw new Error(`no run after ${enters} Enter(s)`);
    await hold('Enter', 120); enters += 1; await sleep(1500);
  }
  const runStart = await state();
  check(true, 'run started', `frame ${runStart.f} after ${enters} Enters`);
  await sleep(2000);

  // ---- 1. the typed console --------------------------------------------------
  if (opt.options) {
    const before = (await state()).n;
    await hold('Backquote', 120); await sleep(600);
    await typeSlow('stage 2'); await sleep(300);
    await hold('Enter', 120); await sleep(4000);
    const stage = await logMatch(/Level::Init m_Stage 2|Stage 2|stage 2/, before);
    check(!!stage, 'typed console: `stage 2` changed the floor', stage || 'no Level::Init line');
    const before2 = (await state()).n;
    await typeSlow('goto s.boss.1010'); await sleep(300);           // the console stays open after a command
    await hold('Enter', 120); await sleep(8000);
    const boss = await logMatch(/Room 5\.1010|Monstro|Starting room transition/, before2);
    check(!!boss, 'typed console: `goto s.boss.1010` made a room transition', boss || 'no transition line');
    await hold('Backquote', 120); await sleep(500);          // close the console
    const fps = await fpsOver(3000);
    check(fps > 20, 'the game keeps running after the console', `${fps.toFixed(1)} fps`);
  }

  // ---- 2 + 3. the hidden tab ----------------------------------------------------
  const a0 = await audio();
  const fpsVisible = await fpsOver(3000);
  check(fpsVisible > 20, 'visible: the game runs', `${fpsVisible.toFixed(1)} fps; audio rms ${a0 && a0.rms != null ? a0.rms.toFixed(4) : 'n/a'} (${a0 && a0.state})`);
  const HIDDEN_S = Number(opt.hidden_s || '8');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(1500);
  const hiddenNow = await page.evaluate(() => document.hidden);
  const fpsHidden = await fpsOver(HIDDEN_S * 1000);
  const aHidden = await audio();
  check(hiddenNow, 'hidden: the page reads itself as hidden', `document.hidden=${hiddenNow} for ${HIDDEN_S} s`);
  check(fpsHidden < 8, 'hidden: the game ticks slowly instead of running', `${fpsHidden.toFixed(1)} fps`);
  check(aHidden && aHidden.state !== 'closed', 'hidden: the audio context survives', aHidden && `${aHidden.state}, rms ${aHidden.rms != null ? aHidden.rms.toFixed(4) : 'n/a'}`);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(500);
  const visibleAgain = await page.evaluate(() => !document.hidden);
  // catch-up check: frames must advance steadily right after the return
  const samples = [];
  let last = (await state()).f, lastT = now();
  for (let i = 0; i < 12; i++) { await sleep(250); const s = await state(); samples.push(s.f - last); last = s.f; lastT = now(); }
  const fpsBack = await fpsOver(3000);
  const stalled = samples.slice(2).filter((d) => d === 0).length;
  await sleep(2000);
  const aBack = await audio();
  check(visibleAgain, 'back in front: the page is visible again', `document.hidden=${!visibleAgain}`);
  check(fpsBack > 20, 'back in front: full rate resumes', `${fpsBack.toFixed(1)} fps; 250 ms samples ${samples.join(' ')}`);
  check(stalled <= 1, 'back in front: no catch-up stall', `${stalled} empty 250 ms sample(s) after the first two`);
  check(aBack && aBack.state === 'running' && (aBack.rms == null || aBack.rms > 0.002 || (a0 && a0.rms <= 0.002)),
        'back in front: music is audible again', aBack && `${aBack.state}, rms ${aBack.rms != null ? aBack.rms.toFixed(4) : 'n/a'} (before ${a0 && a0.rms != null ? a0.rms.toFixed(4) : 'n/a'})`);
  // ---- 5. no animation frames while visible --------------------------------------
  const noRaf0 = await page.evaluate(() => { window.__isaacRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; return window.isaacYieldNoRaf || 0; });
  await sleep(1500);
  const fpsNoRaf = await fpsOver(3000);
  const noRaf1 = await page.evaluate(() => window.isaacYieldNoRaf || 0);
  check(fpsNoRaf > 2 && fpsNoRaf < 8 && noRaf1 > noRaf0, 'no animation frames: the game ticks on the fallback timer instead of stalling', `${fpsNoRaf.toFixed(1)} fps; ${noRaf1 - noRaf0} timer tick(s)`);
  await page.evaluate(() => { window.requestAnimationFrame = window.__isaacRaf; });
  await sleep(1500);
  const fpsRafBack = await fpsOver(2000);
  check(fpsRafBack > 45, 'animation frames again: full rate resumes', `${fpsRafBack.toFixed(1)} fps`);

  const err = consoleLines.find((l) => /PAGEERROR|abort\(|RuntimeError/.test(l));
  check(!err, 'no page error or abort', err || '');

  // ---- 4. save and continue -----------------------------------------------------
  if (opt.options) {
    const stageBefore = await logMatch(/Level::Init m_Stage (\d+)/);
    const seedBefore = await logMatch(/RNG Start Seed: .*\[(Continue|New), \d+\]/);
    const saves0 = await page.evaluate(() => (typeof window.isaacSaveStats === 'function' ? window.isaacSaveStats() : null));
    await sleep(2000);                                            // let the run's autosave land
    const saves1 = await page.evaluate(() => (typeof window.isaacSaveStats === 'function' ? window.isaacSaveStats() : null));
    check(saves1 && saves1.persisted > 0, 'the run persisted save files', saves1 && `${saves1.persisted} persisted, ${saves1.pending} pending (was ${saves0 && saves0.persisted})`);
    await page.reload();
    for (;;) { const st = await state(); if (st.f > 0) break; if (now() > 900000) throw new Error('no first frame after the reload'); await sleep(250); }
    const restored = await logMatch(/(\d+) saved file\(s\) restored from the store/);
    check(!!restored && !/^\s*0 saved/.test(restored), 'the reload restored the saves', restored || 'no restore line');
    let enters2 = 0;
    for (;;) {
      if (await logMatch(/Room \d+\.\d+\(|Starting room transition|Level::Init m_Stage/)) break;
      if (enters2 >= 40 || now() > 900000) throw new Error(`no run after ${enters2} Enter(s) following the reload`);
      await hold('Enter', 120); enters2 += 1; await sleep(1500);
    }
    await sleep(2000);
    const seedAfter = await logMatch(/RNG Start Seed: .*\[(Continue|New), \d+\]/);
    const sb = seedBefore && /RNG Start Seed: (.*?) \[/.exec(seedBefore), sa = seedAfter && /RNG Start Seed: (.*?) \[(Continue|New)/.exec(seedAfter);
    const mb = stageBefore && /m_Stage (\d+)/.exec(stageBefore);
    check(sb && sa && sa[2] === 'Continue' && sa[1] === sb[1], 'continue after the reload resumes the same run',
      `seed ${sb && sb[1]} on stage ${mb && mb[1]} before; after ${enters2} Enter(s): ${seedAfter ? seedAfter.replace(/^.*RNG Start Seed: /, '') : 'no RNG Start Seed line'}`);
    const fpsC = await fpsOver(2000);
    check(fpsC > 30, 'the continued run plays at full rate', `${fpsC.toFixed(1)} fps`);
  }
} catch (e) {
  check(false, 'driver', e.message);
}
const failed = checks.filter((c) => !c.ok).length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ url: URL, cpu: CPU, gl: GL, checks }, null, 2));
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n'));
try { writeFileSync(join(OUT, 'page.log'), (await page.evaluate(() => (window.isaacLog || []).join('\n'))) || ''); } catch (e) { /* page gone */ }
console.log(`[edges] ${checks.length - failed} / ${checks.length} checks pass`);
await browser.close();
process.exit(failed ? 1 : 0);
