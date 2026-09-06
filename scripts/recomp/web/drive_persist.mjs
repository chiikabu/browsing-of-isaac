// drive_persist.mjs -- prove that saves persist across page loads (round 31).
//
// One browser, two loads of the served page (run_web.mjs serve=1 ...). The
// first load plays the headless timeline to its frame budget: the game
// writes its persistentgamedata*.dat files, the FS shim hands each to
// Module.isaacPersist, the page puts them into IndexedDB. The second load is
// a reload of the same page in the same browser profile: the "restore saves"
// stage must seed at least one file back before main, and the game's own
// log must show it read a save from disk.
//
//   node scripts/recomp/web/drive_persist.mjs <url> <out-dir> [timeoutMs=600000]
//
// <url> is the served page with its query (frames=..., input=..., fast
// module served by run_web.mjs serve=1). Writes page1.log, page2.log and
// summary.json to <out-dir>. Exit 0 only if load 1 persisted at least one
// file and load 2 restored at least one.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-persist');
const TIMEOUT_MS = Number(process.argv[4] || '600000');
if (!URL) { console.log('usage: node drive_persist.mjs <url> <out-dir> [timeoutMs]'); process.exit(2); }
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
const t0 = Date.now();
const now = () => Date.now() - t0;
const summary = { url: URL, load1: null, load2: null, error: null };

async function waitDone(label) {
  // main() blocks the page's main thread until the frame budget; evaluate
  // returns once it yields (interactive) or finishes (headless)
  for (;;) {
    let s = null;
    try { s = await Promise.race([page.evaluate(() => ({ done: window.isaacDone, f: window.isaacFrame || 0 })), sleep(5000).then(() => null)]); } catch { s = null; }
    if (s && s.done) return s;
    if (now() > TIMEOUT_MS) throw new Error(`${label}: timeout waiting for isaacDone`);
    await sleep(1000);
  }
}
const pageLog = () => page.evaluate(() => window.isaacLog || []);

try {
  console.log(`[persist] load 1: ${URL}`);
  for (let attempt = 1; ; attempt++) {
    try { await page.goto(URL); break; } catch (e) { if (attempt >= 30) throw e; await sleep(1000); }
  }
  const d1 = await waitDone('load 1');
  const stats1 = await page.evaluate(() => (window.isaacSaveStats ? window.isaacSaveStats() : null));
  const log1 = await pageLog();
  writeFileSync(join(OUT, 'page1.log'), log1.join('\n'));
  summary.load1 = { done: d1.done, frames: d1.f, saves: stats1, wallMs: now() };
  console.log(`[persist] load 1 done at frame ${d1.f}: mainRc ${d1.done && d1.done.mainRc}, saves ${JSON.stringify(stats1)}`);
  await sleep(1500);   // let the IndexedDB transactions commit

  console.log('[persist] load 2: reload');
  const t1 = now();
  await page.reload();
  const d2 = await waitDone('load 2');
  const log2 = await pageLog();
  writeFileSync(join(OUT, 'page2.log'), log2.join('\n'));
  const restoredLine = log2.find((l) => /saved file\(s\) restored from the store/.test(l)) || '';
  const restored = Number((restoredLine.match(/(\d+) saved file/) || [0, 0])[1]);
  const restoredFiles = log2.filter((l) => /^\s*restored .* -> ok$/.test(l));
  const loadedFromDisk = log2.filter((l) => /Loading .*PersistentGameData from disk/.test(l)).length;
  summary.load2 = { done: d2.done, frames: d2.f, restored, restoredFiles, loadedFromDisk, wallMs: now() - t1 };
  console.log(`[persist] load 2 done at frame ${d2.f}: restored ${restored} file(s) ${restoredFiles.map((l) => l.trim()).join(' | ')}`);
} catch (e) {
  summary.error = e.message;
  console.log(`[persist] ERROR ${e.message}`);
}
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n'));
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
await browser.close();
const ok = !summary.error && summary.load1 && summary.load1.saves && summary.load1.saves.persisted > 0
  && summary.load2 && summary.load2.restored > 0 && summary.load2.done && summary.load2.done.mainRc === 0;
console.log(`[persist] ${ok ? 'OK' : 'FAIL'}: ${JSON.stringify({ persisted: summary.load1 && summary.load1.saves, restored: summary.load2 && summary.load2.restored })}`);
process.exit(ok ? 0 : 1);
