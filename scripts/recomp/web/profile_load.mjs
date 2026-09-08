// profile_load.mjs -- the frame time under the load a real run actually
// reaches, not an empty starting room: a deep floor, a pile of items and a
// room full of enemies, driven while walking and firing.
//
// The complaint this exists for is "fps dies with more items and floors,
// especially heavy bullet spam". An idle Basement profile says nothing about
// that -- it is 19% idle and dominated by GL calls. This one sets the state up
// through the game's own console first.
//
//   node scripts/recomp/web/profile_load.mjs <url> <out-dir> options=<options.ini>
//        [stage=8] [items=20] [spawn=20] [cpu=4] [gl=hw] [seconds=20] [warm=6]
//
// Reported: self time AND total (subtree) time per function. A query helper
// that is cheap per call but called from everywhere shows up in the second and
// not the first, which is exactly the shape of an enemy-list scan.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node profile_load.mjs <url> <out-dir> options=<options.ini> [stage=8] [items=20] [spawn=20]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
if (!opt.options) { console.log('options=<options.ini> with EnableDebugConsole=1 is required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const STAGE = opt.stage || '8';
const ITEMS = Number(opt.items || 20);
const SPAWN = Number(opt.spawn || 20);
const SECONDS = Number(opt.seconds || 20);
const WARM = Number(opt.warm || 6);
const CPU = Number(opt.cpu || 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const cdp = await page.context().newCDPSession(page);
if (CPU !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e));

const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, n: (window.isaacLog || []).length }));
const logMatch = (re, since = 0) => page.evaluate(([src, s]) => { const r = new RegExp(src); const log = window.isaacLog || []; for (let i = log.length - 1; i >= s; i--) if (r.test(log[i])) return log[i]; return null; }, [re.source, since]);
const hold = async (key, ms = 100) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const typeSlow = async (text) => { for (const ch of text) { await page.keyboard.down(ch === ' ' ? 'Space' : ch); await sleep(55); await page.keyboard.up(ch === ' ' ? 'Space' : ch); await sleep(35); } };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); } };
const cmd = async (text) => { await typeSlow(text); await sleep(150); await hold('Enter', 110); await sleep(500); };

let profile = null, framesInProfile = 0, setup = [];
try {
  const origin = new globalThis.URL(URL).origin;
  const bytes = [...readFileSync(opt.options)];
  await page.goto(origin + '/instance_index.json').catch(() => {});
  await page.evaluate(async (arr) => new Promise((resolve) => {
    const req = indexedDB.open('isaac-saves', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
    req.onerror = () => resolve('open failed');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ src: null, bytes: new Uint8Array(arr) }, 'c:/isaac/documents/my games/binding of isaac repentance+/options.ini');
      tx.oncomplete = () => { db.close(); resolve('ok'); };
      tx.onerror = () => resolve('tx failed');
    };
  }), bytes);
  await page.goto(URL);
  await until(async () => (await state()).f > 0, 900000, 'first frame');
  let enters = 0;
  for (;;) {
    if (await logMatch(/Level::Init m_Stage|RNG Start Seed/)) break;
    if (enters >= 10) throw new Error('no run after 10 Enters');
    await hold('Enter'); enters += 1; await sleep(1500);
  }
  await sleep(2500);

  await hold('Backquote', 120); await sleep(600);
  await cmd('debug 3');                      // infinite hp: the load must not end in a death
  const beforeStage = (await state()).n;
  await cmd(`stage ${STAGE}`);
  // the setup has to be CHECKED. The first run of this profiled an empty
  // Basement with the console open on top: `stage 8` had not taken and the
  // console's own Update was 34% of the samples.
  const init = await until(async () => logMatch(new RegExp(`Level::Init m_Stage ${STAGE},`), beforeStage), 20000, `stage ${STAGE}`)
    .catch(() => null);
  if (!init) throw new Error(`stage ${STAGE} did not take -- profiling the wrong floor`);
  await sleep(3000);
  setup.push(`stage ${STAGE}`);
  // a pile of items: tears up, damage up, and the ones that multiply tears --
  // this is what "more items" means for the per-shot cost
  const MULTI = [69, 68, 52, 20, 15, 118, 168, 395, 118];   // c69 mutant spider etc
  for (let i = 0; i < ITEMS; i++) await cmd(`giveitem c${MULTI[i % MULTI.length]}`);
  setup.push(`${ITEMS} items`);
  for (let i = 0; i < SPAWN; i++) await cmd('spawn 27.0');   // host-type gaper-ish shooter
  setup.push(`${SPAWN} enemies`);
  // Close it, and prove it closed. The console draws its backlog every frame
  // and prints through the guest's vsnprintf, so leaving it up measures the
  // console. Enter on the empty line first, then the toggle (console_typing).
  // Enter on the EMPTY line is what closes it (console_typing.mjs). Tapping
  // the grave key after that reopens it -- which is what the first two runs of
  // this driver did, and why Console::Update was a third of their samples.
  await hold('Enter', 110); await sleep(900);
  // whether it really closed is checked against the profile itself below:
  // Console::Update (0x0068b260) must not be a meaningful share of the samples

  const f0 = (await state()).f;
  // warm the room up before sampling so tier-up is not what gets measured
  for (let i = 0; i < WARM; i++) { await page.keyboard.down('ArrowRight'); await sleep(500); await page.keyboard.up('ArrowRight'); await sleep(200); }
  const fA = (await state()).f;
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const walk = ['KeyD', 'KeyS', 'KeyA', 'KeyW'], fire = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  for (let i = 0; i * 500 < SECONDS * 1000; i++) {
    await page.keyboard.down(walk[i % 4]); await page.keyboard.down(fire[i % 4]);
    await sleep(400);
    await page.keyboard.up(walk[i % 4]); await page.keyboard.up(fire[i % 4]);
    await sleep(100);
  }
  const r = await cdp.send('Profiler.stop');
  profile = r.profile;
  framesInProfile = (await state()).f - fA;
  console.log(`[load] set up: ${setup.join(', ')}; ${fA - f0} frames to warm, ${framesInProfile} frames sampled`);
  await page.screenshot({ path: join(OUT, 'loaded.png') }).catch(() => {});
} catch (e) {
  console.log('[load] FAILED: ' + (e && e.message || e));
  try { await page.screenshot({ path: join(OUT, 'failure.png') }); } catch (e2) { /* gone */ }
}
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n'));
try { writeFileSync(join(OUT, 'page.log'), (await page.evaluate(() => (window.isaacLog || []).join('\n'))) || ''); } catch (e) { /* gone */ }
await browser.close();
if (!profile) process.exit(1);

writeFileSync(join(OUT, 'load.cpuprofile'), JSON.stringify(profile));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] || 0; total += dt;
  self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + dt);
}
const nameOf = (n) => n.callFrame.functionName || '(anonymous)';
// total (subtree) time: walk each sample's ancestors, counting a function once
// per sample even when it recurses, so a self-recursive scan is not multiplied
const totalTime = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] || 0;
  const seen = new Set();
  for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) {
    const n = byId.get(id); if (!n) break;
    const k = nameOf(n);
    if (!seen.has(k)) { seen.add(k); totalTime.set(k, (totalTime.get(k) || 0) + dt); }
  }
}
const fns = new Map();
for (const [id, t] of self) { const n = byId.get(id); if (!n) continue; const k = nameOf(n); fns.set(k, (fns.get(k) || 0) + t); }
const pct = (t) => (100 * t / total).toFixed(1) + '%';
const ms = (t) => (t / 1000).toFixed(0) + ' ms';
const lines = [];
lines.push(`profile: ${(total / 1000).toFixed(0)} ms sampled, ${framesInProfile} frames -> ${(total / 1000 / Math.max(1, framesInProfile)).toFixed(1)} ms/frame; cpu x${CPU}; ${setup.join(', ')}`);
lines.push('top 30 by SELF time:');
for (const [k, t] of [...fns].sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`  ${pct(t).padStart(6)} ${ms(t).padStart(9)}  ${k}`);
lines.push('top 30 by TOTAL (subtree) time -- guest functions only:');
for (const [k, t] of [...totalTime].sort((a, b) => b[1] - a[1]).filter(([k]) => /^sub_[0-9a-f]{8}$/.test(k)).slice(0, 30)) lines.push(`  ${pct(t).padStart(6)} ${ms(t).padStart(9)}  ${k}`);
// The console, if it was still up, is the loudest thing in the room: it redraws
// its backlog every frame through the guest's vsnprintf. Refuse to report a
// profile it contaminated rather than let it read as the game's own cost.
const CONSOLE_UPDATE = 'sub_0068b260';
const consoleShare = (totalTime.get(CONSOLE_UPDATE) || 0) / Math.max(1, total);
if (consoleShare > 0.05) {
  lines.push('');
  lines.push(`INVALID: ${CONSOLE_UPDATE} (Console::Update) is ${(100 * consoleShare).toFixed(1)}% of the samples --`);
  lines.push('the debug console was still open; this profile measures the console, not the game.');
}
writeFileSync(join(OUT, 'summary.txt'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(consoleShare > 0.05 ? 2 : 0);
