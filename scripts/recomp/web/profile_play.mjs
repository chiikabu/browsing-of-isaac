// profile_play.mjs -- where the browser's frame time goes in play.
//
// Drives the live page like drive_perf.mjs (real GPU or SwiftShader, CDP CPU
// throttle), then records a V8 CPU profile (Profiler.start/stop) for
// `seconds` of play while walking and firing, and summarises it: self time
// per function grouped as lifted guest code (sub_XXXXXXXX), host C
// (everything else in the wasm), JS glue (boot.mjs), page script, and the
// top 40 functions by self time. The raw .cpuprofile is kept for DevTools.
//
//   node scripts/recomp/web/profile_play.mjs <url> <out-dir> [cpu=4] [gl=hw|swiftshader] [seconds=10]
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-profile');
const opt = Object.fromEntries(process.argv.slice(4).map((a) => a.split('=')));
const CPU = Number(opt.cpu || '4');
const GL = opt.gl || 'hw';
const SECONDS = Number(opt.seconds || '10');
// phase=boot (round 45): profile from the navigation to the first presented
// frame instead of the play window -- where the cold start's seconds go.
const PHASE = opt.phase || 'play';
// phase=start (round 57): from the first presented frame to frame `until`
// (default 300, the title screen up and its resources loaded) -- where the
// cold start's seconds go once the archive reads are the Worker's.
const UNTIL = Number(opt.until || '300');
if (!URL) { console.log('usage: node profile_play.mjs <url> <out-dir> [cpu=4] [gl=hw|swiftshader] [seconds=10] [phase=play|boot|start] [until=300]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = GL === 'swiftshader'
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
// profile_dir=<dir> (round 40): a persistent browser profile, so a second run
// finds the module's optimised code in the HTTP cache (V8's wasm code cache)
// and the archives in the browser cache -- the warm start a returning player
// gets. Without it every run is a cold start with a fresh profile.
const PROFILE_DIR = opt.profile_dir || '';
const launchArgs = [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'];
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
const wasmEvents = new Map();
async function prepare(cdp, url) {
  if (FRESH_SAVES) {
    const origin = new globalThis.URL(url).origin;       // `URL` here is the argv constant
    await page.goto(origin + '/instance_index.json').catch(() => {});
    await page.evaluate(() => new Promise((r) => { try { const q = indexedDB.deleteDatabase('isaac-saves'); q.onsuccess = q.onerror = q.onblocked = () => r(); } catch (e) { r(); } }));
  }
  if (TRACE_WASM) {
    cdp.on('Tracing.dataCollected', (e) => { for (const ev of e.value || []) if (/wasm/i.test(ev.name || '')) wasmEvents.set(ev.name, (wasmEvents.get(ev.name) || 0) + 1); });
    try {
      await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['v8.wasm', 'disabled-by-default-v8.wasm.detailed'] }, transferMode: 'ReportEvents' });
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
const cdp = await context.newCDPSession(page);
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, done: window.isaacDone }));
const logMatch = (re) => page.evaluate((src) => {
  const r = new RegExp(src); const log = window.isaacLog || [];
  for (let i = log.length - 1; i >= 0; i--) if (r.test(log[i])) return log[i];
  return null;
}, re.source);
const t0 = Date.now(); const now = () => Date.now() - t0;
let profile = null, framesInProfile = 0, error = null;
try {
  for (let attempt = 1; ; attempt++) { try { if (attempt === 1) await prepare(cdp, URL); await page.goto(URL); break; } catch (e) { if (attempt === 1) console.log(`[prepare] ${e.message}`); if (attempt >= 30) throw e; await sleep(1000); } }
  if (PHASE === 'boot') {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  for (;;) { const s = await state(); if (s.f > 0) break; if (s.done || now() > 600000) throw new Error('no first frame'); await sleep(250); }
  if (PHASE === 'boot') {
    const r = await cdp.send('Profiler.stop');
    profile = r.profile; framesInProfile = 1;
    console.log(`[profile] boot: first frame at ${now()} ms`);
    throw new Error('__boot_done__');
  }
  if (PHASE === 'start') {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    const f0 = (await state()).f;
    await cdp.send('Profiler.start');
    for (;;) { const s = await state(); if (s.f >= UNTIL) break; if (s.done || now() > 600000) throw new Error(`no frame ${UNTIL}`); await sleep(100); }
    const r = await cdp.send('Profiler.stop');
    profile = r.profile; framesInProfile = (await state()).f - f0;
    console.log(`[profile] start: first frame at frame ${f0}, frame ${UNTIL} at ${now()} ms, ${framesInProfile} frames in the profile`);
    throw new Error('__boot_done__');
  }
  await traceReport(cdp);
  const startRe = /Room 1\.2\(Start Room\)|Starting room transition/;
  for (let enters = 0; ; enters++) {
    if (await logMatch(startRe)) break;
    if (enters >= 40 || now() > 600000) throw new Error('no run');
    await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter'); await sleep(1500);
  }
  await sleep(3000);                                   // let tier-up settle a little
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  const f0 = (await state()).f;
  await cdp.send('Profiler.start');
  const walk = ['KeyD', 'KeyS', 'KeyA', 'KeyW'], fire = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  for (let i = 0; i < SECONDS; i++) {
    await page.keyboard.down(walk[i % 4]); await page.keyboard.down(fire[i % 4]);
    await sleep(1000);
    await page.keyboard.up(walk[i % 4]); await page.keyboard.up(fire[i % 4]);
  }
  const r = await cdp.send('Profiler.stop');
  profile = r.profile;
  framesInProfile = (await state()).f - f0;
} catch (e) { if (e.message !== '__boot_done__') { error = e.message; console.log(`[profile] ERROR ${e.message}`); } }
await context.close();
if (!profile) { process.exit(1); }
writeFileSync(join(OUT, 'play.cpuprofile'), JSON.stringify(profile));
// summarise: self time per node = samples * interval (timeDeltas)
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] || 0; total += dt;
  const id = profile.samples[i];
  self.set(id, (self.get(id) || 0) + dt);
}
const nameOf = (n) => n.callFrame.functionName || '(anonymous)';
const urlOf = (n) => (n.callFrame.url || '').replace(/^.*\//, '');
const group = (n) => {
  const f = nameOf(n), u = urlOf(n);
  if (/^sub_[0-9a-f]{8}/.test(f)) return 'lifted guest code';
  if (u.endsWith('.wasm') || /^(imp_|isaac_|recomp_|dispatch|rc_)/.test(f)) return 'host C (wasm)';
  if (/\(garbage collector\)|\(program\)|\(idle\)|\(root\)/.test(f)) return f;
  if (u.includes('boot.mjs')) return 'JS glue (boot.mjs)';
  if (u.includes('boot_web') || u.includes('play.mjs')) return 'page script';
  return 'other (' + (u || 'native') + ')';
};
const groups = new Map(), fns = new Map();
for (const [id, t] of self) {
  const n = byId.get(id); if (!n) continue;
  const g = group(n); groups.set(g, (groups.get(g) || 0) + t);
  const key = nameOf(n) + ' @' + urlOf(n); fns.set(key, (fns.get(key) || 0) + t);
}
const pct = (t) => (100 * t / total).toFixed(1) + '%';
const lines = [];
lines.push(PHASE === 'boot' ? `profile: boot, ${(total / 1000).toFixed(0)} ms sampled to the first frame; cpu x${CPU}, gl ${GL}` : `profile: ${(total / 1000).toFixed(0)} ms sampled, ${framesInProfile} frames -> ${(total / 1000 / Math.max(1, framesInProfile)).toFixed(1)} ms/frame; cpu x${CPU}, gl ${GL}`);
lines.push('by group:');
for (const [g, t] of [...groups].sort((a, b) => b[1] - a[1])) lines.push(`  ${pct(t).padStart(6)}  ${g}`);
lines.push('top 40 by self time:');
for (const [k, t] of [...fns].sort((a, b) => b[1] - a[1]).slice(0, 40)) lines.push(`  ${pct(t).padStart(6)}  ${k}`);
writeFileSync(join(OUT, 'summary.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(0);
