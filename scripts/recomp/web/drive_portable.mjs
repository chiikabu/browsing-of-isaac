// drive_portable.mjs -- open a single-file portable build straight off the disk and
// say whether the game runs from it.
//
//   node scripts/recomp/web/drive_portable.mjs <isaac.html> <out-dir> [frames=400] [seconds=180]
//
// The offline build is one document with the whole payload inline as base64, which
// is a size no page is meant to be: this reports what the browser actually does with
// it -- how long the document takes to parse, whether a frame arrives, what the
// renderer's memory looks like -- rather than assuming either way. Exit 0 when a
// frame is presented and no page error is showing.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const FILE = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-portable');
const opt = Object.fromEntries(process.argv.slice(4).map((a) => a.split('=')));
const FRAMES = Number(opt.frames || '400');
const SECONDS = Number(opt.seconds || '180');

if (!FILE) { console.log('usage: node drive_portable.mjs <isaac.html> <out-dir> [frames=400] [seconds=180]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const size = statSync(FILE).size;
console.log(`[portable] ${FILE} (${(size / 1048576).toFixed(1)} MB)`);

const browser = await chromium.launch({
  args: ['--allow-file-access-from-files', '--js-flags=--max-old-space-size=6144',
         '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const t0 = Date.now();
let opened = null, failed = null;
try {
  await page.goto(pathToFileURL(resolve(FILE)).href, { waitUntil: 'commit', timeout: SECONDS * 1000 });
  opened = Date.now() - t0;
  console.log(`[portable] document committed at ${opened} ms`);
  await page.waitForFunction(() => typeof window.isaacPortable === 'object' && window.isaacPortable, null,
    { timeout: SECONDS * 1000 });
  console.log(`[portable] the payload parsed at ${Date.now() - t0} ms`);
} catch (e) {
  failed = e.message;
}

let frame = 0, first = null;
if (!failed) {
  const deadline = Date.now() + SECONDS * 1000;
  while (Date.now() < deadline) {
    frame = await page.evaluate(() => window.isaacFrame || 0).catch(() => 0);
    if (frame > 0 && first === null) { first = Date.now() - t0; console.log(`[portable] first frame at ${first} ms`); }
    if (frame >= FRAMES) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const state = await page.evaluate(() => ({
  frame: window.isaacFrame || 0,
  error: !!(document.getElementById('error') && !document.getElementById('error').hidden),
  status: (document.getElementById('status') || {}).textContent || '',
})).catch(() => ({ frame: 0, error: true, status: 'evaluate failed' }));
await page.screenshot({ path: join(OUT, 'portable.png') }).catch(() => {});
const report = { file: FILE, bytes: size, opened, first, frames: state.frame, error: state.error,
                 status: state.status, failed, errors: errors.slice(0, 10) };
writeFileSync(join(OUT, 'portable.json'), JSON.stringify(report, null, 2));
await browser.close();

const ok = !failed && state.frame > 0 && !state.error;
console.log(`[portable] ${ok ? 'ok' : 'FAIL'} frames ${state.frame}, first ${first} ms, document ${opened} ms`
  + (failed ? `, ${failed}` : '') + (state.error ? ', error panel SHOWN' : ''));
if (errors.length) console.log(`[portable] ${errors.length} error(s): ${errors.slice(0, 3).join(' | ').slice(0, 300)}`);
process.exit(ok ? 0 : 1);
