// drive_interactive.mjs -- drive the served interactive page (run_web.mjs
// interactive=1) with REAL keyboard events, state-driven rather than
// frame-keyed. In interactive mode the game paces on the wall clock, so the
// intro cutscene and the menus take real time and a frame-numbered timeline
// (the headless `input=` grammar) lands on whatever screen happens to be up.
// This driver presses Enter until the game's own log says a run started
// (`Room 1.2(Start Room)` / `Starting room transition`), then walks.
//
//   node scripts/recomp/web/drive_interactive.mjs <url> <out-dir> [budgetFrames=1500] [timeoutMs=600000]
//
// Writes to <out-dir>: shot_menu.png (before the first Enter), shot_a.png
// (run started), shot_b.png (after walking), shot_final.png, page.log,
// console.log and summary.json. Exit 0 only if the run started, the module
// finished (isaacDone.mainRc === 0) and shot_a differs from shot_b.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-interactive-drive');
const TIMEOUT_MS = Number(process.argv[5] || '600000');
if (!URL) { console.log('usage: node drive_interactive.mjs <url> <out-dir> [budgetFrames] [timeoutMs]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push(`PAGEERROR ${e.message}`));
page.on('crash', () => consoleLines.push('PAGE CRASHED (renderer died)'));

const t0 = Date.now();
const now = () => Date.now() - t0;
console.log(`[drive] goto ${URL}`);
for (let attempt = 1; ; attempt++) {
  try { await page.goto(URL); break; } catch (e) {
    if (attempt >= 30) throw e;
    await sleep(1000);
  }
}

// one round trip; while the page is inside wasm this waits for the next yield
const state = () => page.evaluate(() => ({
  f: window.isaacFrame || 0,
  done: window.isaacDone,
  n: (window.isaacLog || []).length,
}));
const logMatch = (re) => page.evaluate((src) => {
  const r = new RegExp(src);
  const log = window.isaacLog || [];
  for (let i = log.length - 1; i >= 0; i--) if (r.test(log[i])) return log[i];
  return null;
}, re.source);
const shot = async (name) => {
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 960, height: 540 } });
  writeFileSync(join(OUT, name), png);
  return png;
};

const summary = { url: URL, firstFrameMs: null, entersToStart: 0, runStartedFrame: null, runStartedMs: null,
                  fps: [], audio: [], ended: null, shotsDiffer: null, error: null };
try {
  // first frame
  for (;;) {
    const s = await state();
    if (s.f > 0) { summary.firstFrameMs = now(); console.log(`[drive] first frame at ${now()} ms`); break; }
    if (s.done) throw new Error('module ended before the first frame');
    if (now() > TIMEOUT_MS) throw new Error('timeout before the first frame');
    await sleep(50);
  }
  await sleep(1500);
  await shot('shot_menu.png');
  // Enter until the run starts
  const startRe = /Room 1\.2\(Start Room\)|Starting room transition/;
  for (;;) {
    const hit = await logMatch(startRe);
    if (hit) { const s = await state(); summary.runStartedFrame = s.f; summary.runStartedMs = now();
               console.log(`[drive] run started at frame ${s.f} (${now()} ms) after ${summary.entersToStart} Enter(s): ${hit}`); break; }
    if (summary.entersToStart >= 40 || now() > TIMEOUT_MS) throw new Error(`no run after ${summary.entersToStart} Enter(s)`);
    // held, not tapped: the game samples key state once per frame, and a
    // down+up inside one tick lands between two samples (round 26: forty
    // taps on the beta notice, none seen)
    await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter');
    summary.entersToStart += 1;
    await sleep(1500);
  }
  await sleep(1500);
  const a = await shot('shot_a.png');
  // walk right, then up
  for (const code of ['KeyD', 'KeyW']) {
    await page.keyboard.down(code); await sleep(1500); await page.keyboard.up(code);
    const s = await state(); console.log(`[drive] ${code} held 1.5 s, now frame ${s.f}`);
  }
  await sleep(500);
  const b = await shot('shot_b.png');
  summary.shotsDiffer = !a.equals(b);
  console.log(`[drive] shots after walking differ: ${summary.shotsDiffer}`);
  // fire left for 1.5 s; the screenshot in the middle of the hold shows the
  // tears (round 27: the node explorer found no room ever clearing)
  await page.keyboard.down('ArrowLeft'); await sleep(700);
  const fireShot = await shot('shot_fire.png');
  await sleep(800); await page.keyboard.up('ArrowLeft');
  summary.fireShotDiffers = !fireShot.equals(b);
  { const s = await state(); console.log(`[drive] ArrowLeft held 1.5 s, now frame ${s.f}; fire shot differs: ${summary.fireShotDiffers}`); }
  // fps until the module ends (the frame budget ends the run)
  let last = await state(), lastT = now();
  for (;;) {
    await sleep(1000);
    const s = await state();
    const dt = (now() - lastT) / 1000;
    summary.fps.push(Number(((s.f - last.f) / dt).toFixed(1)));
    last = s; lastT = now();
    if (s.done) { summary.ended = s.done; break; }
    if (now() > TIMEOUT_MS) throw new Error(`timeout waiting for isaacDone at frame ${s.f}`);
  }
} catch (e) {
  summary.error = e.message;
  console.log(`[drive] ERROR ${e.message}`);
}
try { await shot('shot_final.png'); } catch (e) { /* the page may be gone */ }
let pageLog = [];
try { pageLog = await Promise.race([page.evaluate(() => window.isaacLog || []), sleep(15000).then(() => null)]) || ['(page log unavailable)']; } catch (e) { pageLog = [`(page log unavailable: ${e.message})`]; }
summary.audio = consoleLines.filter((l) => /\[isaac\]\[(audio|al)\]/.test(l)).slice(-6);
summary.wallMs = now();
writeFileSync(join(OUT, 'page.log'), pageLog.join('\n') + '\n');
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n') + '\n');
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`[drive] fps: ${summary.fps.join(' ')}`);
for (const l of summary.audio) console.log(`[drive] ${l}`);
console.log(`[drive] ended: ${JSON.stringify(summary.ended)} wall ${summary.wallMs} ms`);
await browser.close();
const ok = !summary.error && summary.runStartedFrame !== null && summary.ended && summary.ended.mainRc === 0 && summary.shotsDiffer === true;
process.exit(ok ? 0 : 1);
