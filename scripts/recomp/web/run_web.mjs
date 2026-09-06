// run_web.mjs -- run the WEB build of the lifted module (build_boot.py --web ->
// output/recomp/lift/boot-web/) under headless Chromium through Playwright.
//
// Files are served from disk by a throwaway HTTP server on 127.0.0.1 (the
// boot module, the memory image, the instance tree, and a generated index of
// the instance files the page uses to register the RAM-FS lazily). Chromium renders WebGL2 through SwiftShader
// (software), so the run is deterministic and needs no GPU.
//
// The page script (boot_web.html + boot_web.mjs) runs the same stages as
// boot_integration.mjs. The host's SwapBuffers shim reads the framebuffer
// back on every presented frame (web build only) and hands it to
// Module.isaacPresent; the page keeps the last frames and this runner writes
// them out as PNGs next to the log.
//
//   node scripts/recomp/web/run_web.mjs [out-dir] [frames] [ISAAC_X=Y ...] [input=130:Enter,...] [keep=30] [serve=1 port=N] [interactive=1]
//
// Exit code: 0 when main returned 0, 1 otherwise. Reads nothing outside the
// repo and the instance dir; downloads nothing (Playwright's bundled Chromium
// must already be installed).
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
// fast=1 serves the speed-profile browser module (build_boot.py --web --fast),
// which is what a run of more than a few hundred frames wants.
const FAST = (process.argv.slice(4).find((a) => a.startsWith('fast=')) || 'fast=0').slice(5) !== '0';
// boot=<dir>: serve a module from another directory (an A/B against a kept
// build, e.g. output/recomp/lift/boot-web-fast-r24) instead of the profile's own.
const BOOT_OVERRIDE = (process.argv.slice(4).find((a) => a.startsWith('boot=')) || 'boot=').slice(5);
const BOOT = BOOT_OVERRIDE ? join(ROOT, BOOT_OVERRIDE) : join(ROOT, 'output', 'recomp', 'lift', FAST ? 'boot-web-fast' : 'boot-web');
const SEGS = join(ROOT, 'output', 'recomp', 'host', 'isaac.segs.bin');
// instance=<dir> (or ISAAC_INSTANCE_DIR): serve another instance tree -- round
// 28 proves the shipping bundle (.scratch/game-bundle) by running from it.
// Relative paths are taken from the repo root.
const INSTANCE_ARG = (process.argv.slice(4).find((a) => a.startsWith('instance=')) || 'instance=').slice(9)
  || process.env.ISAAC_INSTANCE_DIR || '';
const INSTANCE = INSTANCE_ARG ? (isAbsolute(INSTANCE_ARG) ? INSTANCE_ARG : join(ROOT, INSTANCE_ARG))
  : join(ROOT, '.scratch', 'game-instance');
const OUT = process.argv[2] || join(ROOT, 'output', 'recomp', 'web-run');
const FRAMES = process.argv[3] || '5';
// trailing K=V arguments: ISAAC_* go into the module's ENV; `input=` is the
// scripted input timeline and `keep=` the frame sampling interval (see
// boot_web.mjs); anything else is passed through as a query parameter.
// timeout=<ms>: how long to wait for main to return (the page's main thread is
// inside main for the whole run, so a stalled game can only be caught by time)
const TIMEOUT_MS = Number((process.argv.slice(4).find((a) => a.startsWith('timeout=')) || 'timeout=1200000').slice(8));
// eager=1: --js-flags=--no-wasm-lazy-compilation (V8 compiles every wasm function at
// instantiation instead of on first call; first-call compiles of the giant lifted
// functions are otherwise charged to whoever calls them, round 14h)
const EAGER = (process.argv.slice(4).find((a) => a.startsWith('eager=')) || 'eager=0').slice(6) !== '0';
// tierup=0: --js-flags=--no-wasm-tier-up (Liftoff only, no background TurboFan
// recompilation). On node this is the difference between a 4436-s and a 107-s
// room entry, because TurboFan's allocation churn drives the Windows NT heap
// free-list walk the main thread then waits on (round 15a, §21.28). Chromium
// allocates through PartitionAlloc, so measure before assuming it helps here.
const NO_TIERUP = (process.argv.slice(4).find((a) => a.startsWith('tierup=')) || 'tierup=1').slice(7) === '0';
// serve=1: keep the server up and print the URL instead of driving a headless
// browser, so the page can be opened by hand. The port can be pinned with
// port=<n> so the URL is stable across restarts.
// interactive=1 (round 25): ISAAC_YIELD=1 on the page -- the module yields to the
// event loop every frame (JSPI) and paces on the wall clock, so the canvas repaints
// as the game runs and keyboard/mouse events reach it. Implies serve=1.
const INTERACTIVE = (process.argv.slice(4).find((a) => a.startsWith('interactive=')) || 'interactive=0').slice(12) !== '0';
const SERVE = INTERACTIVE || (process.argv.slice(4).find((a) => a.startsWith('serve=')) || 'serve=0').slice(6) !== '0';
const PORT = Number((process.argv.slice(4).find((a) => a.startsWith('port=')) || 'port=0').slice(5));
const JS_FLAGS = [...(EAGER ? ['--no-wasm-lazy-compilation'] : []), ...(NO_TIERUP ? ['--no-wasm-tier-up'] : [])];
const EXTRA_ENV = process.argv.slice(4).filter((a) => a.includes('=') && !a.startsWith('timeout=') && !a.startsWith('eager=') && !a.startsWith('tierup=') && !a.startsWith('fast=')
  && !a.startsWith('serve=') && !a.startsWith('port=') && !a.startsWith('boot=') && !a.startsWith('instance=') && !a.startsWith('interactive=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=')+ 1)]);

for (const f of ['boot.mjs', 'boot.wasm']) {
  if (!existsSync(join(BOOT, f))) {
    console.log(`missing ${join(BOOT, f)} -- build it with: python scripts/recomp/lift/build_boot.py --web`);
    process.exit(2);
  }
}
mkdirSync(OUT, { recursive: true });

// ---- instance index: what the page registers lazily -----------------------
// Same policy as boot_integration.mjs: skip exe/dll/so/ogv, mods/, the
// duplicate top-level packed/ (the archives are seeded eagerly by name from
// resources/packed/), and dot files.
const SKIP_DIRS = new Set(['packed', 'mods']);
const SKIP_EXT = /\.(exe|dll|so|ogv)$/i;
const index = [];
(function walk(dir, rel) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (SKIP_DIRS.has(r)) continue; walk(p, r); }
    else if (e.isFile()) {
      if (SKIP_EXT.test(e.name) || e.name.startsWith('.')) continue;
      index.push({ p: r, s: statSync(p).size });
    }
  }
})(INSTANCE, '');

// ---- PNG writer (RGBA, bottom-up rows as glReadPixels returns them) --------
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngFromRgba(rgba, w, h, flipY) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const srcRow = flipY ? h - 1 - y : y;
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, srcRow * w * 4, srcRow * w * 4 + w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the browser -----------------------------------------------------------
const mime = (p) => p.endsWith('.mjs') || p.endsWith('.js') ? 'text/javascript'
  : p.endsWith('.wasm') ? 'application/wasm'
  : p.endsWith('.html') ? 'text/html'
  : p.endsWith('.json') ? 'application/json' : 'application/octet-stream';

const browser = SERVE ? null : await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-webgl', '--disable-web-security',
         ...(JS_FLAGS.length ? [`--js-flags=${JS_FLAGS.join(' ')}`] : [])],
});
const page = SERVE ? null : await browser.newPage({ viewport: { width: 960, height: 540 } });
const consoleLines = [];
page && page.on('console', (msg) => consoleLines.push(msg.text()));
page && page.on('pageerror', (e) => consoleLines.push(`PAGEERROR ${e.message}`));
page && page.on('crash', () => consoleLines.push('PAGE CRASHED (renderer died)'));
let served = 0, missing = 0;
// Round 28: the files-served index. Every 200 the server answers is recorded
// by path (requests and bytes before base64), and written next to the log as
// served_files.json -- the browser-side half of the bundle census: what a run
// actually pulls from the instance dir, whole files and window slices alike.
const servedFiles = new Map();
function recordServed(rel, bytes) {
  const r = servedFiles.get(rel) || { requests: 0, bytes: 0 };
  r.requests += 1; r.bytes += bytes;
  servedFiles.set(rel, r);
}
function writeServedIndex() {
  const files = [...servedFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, r]) => ({ path, requests: r.requests, bytes: r.bytes }));
  writeFileSync(join(OUT, 'served_files.json'), JSON.stringify({ instance: INSTANCE, files }, null, 1) + '\n');
  return files.length;
}
// A real local HTTP server rather than page.route: the 380 MB boot.wasm
// through route.fulfill crashed the renderer (the body crosses the CDP
// channel as base64), and streaming compilation wants a normal response.
function resolveFile(rel) {
  if (rel === '/' || rel === '/boot_web.html') return { file: join(HERE, 'boot_web.html') };
  if (rel === '/boot.mjs' || rel === '/boot.wasm') return { file: join(BOOT, rel.slice(1)) };
  // any page module beside this file: boot_web.mjs and whatever it imports
  // (round 74 added mods.mjs and zip.mjs). By shape, not by name -- a named list
  // fails silently, as a 404 on an ES import is a module graph that never
  // resolves and a run that waits out its timeout with nothing in the log.
  if (/^\/[A-Za-z0-9_.-]+\.mjs$/.test(rel)) return { file: join(HERE, rel.slice(1)) };
  if (rel === '/isaac.segs.bin') return { file: SEGS };
  if (rel === '/instance_index.json') return { body: Buffer.from(JSON.stringify(index)) };
  if (rel.startsWith('/instance/')) return { file: join(INSTANCE, rel.slice('/instance/'.length)) };
  return {};
}
const server = createServer((req, res) => {
  // the bare origin: send the browser to the page WITH the run's query
  // (frames budget, ISAAC_YIELD for the live page); without it the page runs
  // its 5-frame default and ends before the menus
  if (new URL(req.url, 'http://x').pathname === '/') {
    res.writeHead(302, { Location: `/boot_web.html?${qs}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const u = new URL(req.url, 'http://x');
  const rel = decodeURIComponent(u.pathname);
  // ?b64=1: the page's synchronous XHR can only read text, and Chromium
  // strips a leading UTF-8 BOM from any text response whatever the charset
  // label (three bytes gone from every BOM-prefixed .anm2/.fs/.xml). Base64
  // survives the decoder untouched.
  const b64 = u.searchParams.get('b64') === '1';
  const r = resolveFile(rel);
  if (!r.body && (!r.file || !existsSync(r.file))) {
    missing += 1;
    if (missing <= 10) consoleLines.push(`[http] 404 ${rel}`);
    res.writeHead(404); res.end('not found'); return;
  }
  served += 1;
  let body;
  if (r.file && u.searchParams.has('off')) {
    // Round 24e: ?off=&len= is a byte slice of the file -- the browser's
    // windowed archive reads (boot_web.mjs isaacLazyPread). Positional read,
    // never the whole 600 MB archive per 1 MB window.
    const off = Number(u.searchParams.get('off')), len = Number(u.searchParams.get('len'));
    const fd = openSync(r.file, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, off);
      body = buf.subarray(0, n);
    } finally { closeSync(fd); }
  } else {
    body = r.body || readFileSync(r.file);
  }
  recordServed(rel, body.length);
  if (b64) body = Buffer.from(body.toString('base64'), 'ascii');
  // Round 40: a whole file served from disk gets a validator (size + mtime)
  // and `no-cache`, so the browser revalidates it and may keep it -- V8
  // stores a module's optimised machine code in the HTTP cache entry of the
  // response it was compiled from, and `no-store` forbids that entry, which
  // made every load of the 50 MB module a baseline-tier compile. Slices,
  // base64 bodies and generated bodies stay `no-store`.
  const whole = r.file && !u.searchParams.has('off') && !b64;
  const headers = { 'Content-Type': b64 ? 'text/plain' : mime(r.file || rel), 'Content-Length': body.length,
                    'Cache-Control': whole ? 'no-cache' : 'no-store' };
  if (whole) {
    const st = statSync(r.file);
    const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
  }
  // the type follows the file served, not the request path: '/' is the page
  res.writeHead(200, headers);
  res.end(body);
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const qs = new URLSearchParams({ frames: FRAMES });
for (const [k, v] of EXTRA_ENV) qs.set(k, v);
if (INTERACTIVE) qs.set('ISAAC_YIELD', '1');

if (SERVE) {
  console.log(`\n  ${ORIGIN}/boot_web.html?${qs}\n`);
  console.log(`  module: ${BOOT}`);
  console.log('  The page loads ~300 MB of assets before the first frame, so give it a minute.');
  if (INTERACTIVE) {
    console.log('  interactive=1: the module yields to the event loop every frame (JSPI) and paces');
    console.log('  on the wall clock -- the canvas repaints live and the keyboard/mouse reach the');
    console.log('  game (click the canvas first). The scripted `input=` timeline still applies.');
  } else {
    console.log('  Input is the scripted `input=` timeline, not the keyboard: the guest frame');
    console.log('  loop runs inside main() and never returns to the event loop, so no browser');
    console.log('  event can reach it and the canvas may not repaint until the run ends.');
    console.log('  Add interactive=1 for a live, playable page.');
  }
  console.log('  Ctrl+C to stop the server.');
  await new Promise(() => {});
}
const t0 = Date.now();
await page.goto(`${ORIGIN}/boot_web.html?${qs}`);
let done;
try {
  await page.waitForFunction(() => window.isaacDone !== null && window.isaacDone !== undefined,
                             null, { timeout: TIMEOUT_MS });
  done = await page.evaluate(() => window.isaacDone);
} catch (e) {
  done = { error: `timeout or navigation failure: ${e.message}` };
}
const wall = Date.now() - t0;
// A timed-out page is still inside main (its main thread is busy in wasm), so
// page.evaluate would never return and browser.close would hang: skip the
// read-back and kill the browser process instead.
const timedOut = !!(done && done.error);
const killBrowser = () => { try { const p = browser.process(); if (p) p.kill('SIGKILL'); } catch (e) { /* gone */ } };
if (timedOut) {
  console.log(`web run: TIMED OUT after ${wall} ms (${served} files served, ${writeServedIndex()} distinct); the page never left main`);
  writeFileSync(join(OUT, 'web-run.log'), [...consoleLines, `---- timed out after ${wall} ms`].join('\n') + '\n');
  killBrowser();
  server.close();
  process.exit(1);
}
const result = await page.evaluate(() => ({
  log: window.isaacLog || [],
  frames: (window.isaacFrames || []).map((f) => {
    let s = '';
    for (let i = 0; i < f.rgba.length; i += 8192)
      s += String.fromCharCode.apply(null, f.rgba.subarray(i, i + 8192));
    return { n: f.n, w: f.w, h: f.h, b64: btoa(s) };
  }),
})).catch((e) => ({ log: [`evaluate failed: ${e.message}`], frames: [] }));
await browser.close();
server.close();

writeFileSync(join(OUT, 'web-run.log'), [...consoleLines, '---- page log ----', ...result.log].join('\n') + '\n');
for (const f of result.frames) {
  const rgba = Buffer.from(f.b64, 'base64');
  writeFileSync(join(OUT, `frame_${String(f.n).padStart(4, '0')}.png`), pngFromRgba(rgba, f.w, f.h, true));
}
console.log(`web run: ${wall} ms wall, ${served} files served (${missing} missing, ${writeServedIndex()} distinct -> served_files.json), ` +
            `${result.frames.length} frame(s) written to ${OUT}`);
console.log(`done: ${JSON.stringify(done)}`);
const tail = result.log.slice(-6);
for (const l of tail) console.log(`  ${l}`);
process.exit(done && done.mainRc === 0 ? 0 : 1);
