// check_page.mjs -- open the shipping page the way a player does (no query
// string, no gesture) and report what is on screen once the engine runs:
// the loader gone, no chrome, the first frame's time, a screenshot.
//   node scripts/recomp/web/check_page.mjs http://127.0.0.1:8200/play.html <out-dir> [gl=hw|swiftshader] [seconds=8]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node check_page.mjs <url> <out-dir> [gl=hw] [seconds=8]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
await page.goto(URL);
let first = 0;
for (;;) {
  const f = await page.evaluate(() => window.isaacFrame || 0);
  if (f > 0) { first = Date.now() - t0; break; }
  if (Date.now() - t0 > 600000) { console.log('[page] FAIL no first frame in 600 s'); await browser.close(); process.exit(1); }
  await sleep(250);
}
await sleep(Number(opt.seconds || '8') * 1000);
const state = await page.evaluate(() => {
  const g = (id) => document.getElementById(id);
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  return {
    frame: window.isaacFrame || 0,
    overlayVisible: vis(g('overlay')), stagesVisible: vis(g('stages')), playVisible: vis(g('play')),
    header: !!document.querySelector('header'), footer: !!document.querySelector('footer'), fullscreenBtn: !!g('fullscreen-btn'),
    fpsVisible: vis(g('fps')), savesVisible: vis(g('saves-btn')), errorVisible: vis(g('error')),
    status: g('status') ? g('status').textContent : null, bar: g('bar-fill') ? g('bar-fill').style.width : null,
    canvas: (() => { const r = g('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    body: { w: innerWidth, h: innerHeight },
    audio: typeof window.isaacAudioLevel === 'function' ? window.isaacAudioLevel() : null,
    hidden: document.hidden, visibility: document.visibilityState, noRaf: window.isaacYieldNoRaf || 0,
    logTail: (window.isaacLog || []).filter((l) => l && !/^\[\s*\d+\.\d\]\s*$/.test(l)).slice(-6),
  };
});
// a second sample two seconds later says whether the frame counter moves at all
await sleep(2000);
state.frameLater = await page.evaluate(() => window.isaacFrame || 0);
const shot = join(OUT, 'page.png');
await page.screenshot({ path: shot });
const ok = state.frame > 0 && !state.overlayVisible && !state.header && !state.footer && !state.fullscreenBtn && !state.fpsVisible && !state.savesVisible && !state.errorVisible;
console.log(`[page] ${ok ? 'ok  ' : 'FAIL'} first frame at ${first} ms; frame ${state.frame}; overlay ${state.overlayVisible ? 'VISIBLE' : 'gone'}; chrome ${state.header || state.footer || state.fullscreenBtn ? 'PRESENT' : 'none'}; fps line ${state.fpsVisible ? 'shown' : 'hidden'}; saves ${state.savesVisible ? 'shown' : 'hidden'}; error panel ${state.errorVisible ? 'SHOWN' : 'hidden'}`);
console.log(`[page] canvas ${state.canvas.w}x${state.canvas.h} at ${state.canvas.x},${state.canvas.y} in ${state.body.w}x${state.body.h}; bar ${state.bar}; status "${state.status}"; audio ${state.audio ? state.audio.state : 'n/a'}`);
console.log(`[page] frames ${state.frame} -> ${state.frameLater} over 2 s; document.hidden ${state.hidden} (${state.visibility}); ${state.noRaf} timer tick(s); log tail: ${state.logTail.join(' | ').slice(0, 400)}`);
if (errors.length) console.log(`[page] ${errors.length} console/page error(s): ${errors.slice(0, 3).join(' | ').slice(0, 300)}`);
console.log(`[page] screenshot ${shot}`);
writeFileSync(join(OUT, 'page.json'), JSON.stringify({ first, state, errors }, null, 2));
await browser.close();
process.exit(ok ? 0 : 1);
