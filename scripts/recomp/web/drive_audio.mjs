// drive_audio.mjs -- measure what the served interactive page (run_web.mjs
// interactive=1) actually puts on its audio output, second by second. Round
// 36: the music path LOGGED fine for rounds (buffers uploaded, queued,
// unqueued, "WebAudio context: running") and nothing was audible, so the
// proof that music plays is energy on the master output, not log lines.
//
//   node scripts/recomp/web/drive_audio.mjs <url> <out-dir> [seconds=20] [timeoutMs=600000]
//
// Flow: open the page, wait for the first frame, click the canvas (the user
// activation the autoplay policy wants), then sample window.isaacAudioLevel()
// once a second through two windows: the boot screen as it comes up (the
// title theme starts before the first frame; nothing else plays), then, after
// two held Enters (the beta notice, the title), the screen that follows.
// Sound effects are key-driven, so a window with no keys in it carries music
// only: sustained RMS there is the music, a blip on an Enter is a menu sound.
//
// window.isaacAudioLevel is the page's tap on the backend's master node
// (boot_web.mjs, round 36). A module built before round 36 has no master
// node -- its sources connect straight to the destination -- so this driver
// also installs its own tap before the page loads: every connect() to the
// destination is routed through an AnalyserNode. That is what makes a
// before/after measurement on one page possible.
//
// Writes to <out-dir>: timeline.json (every sample), summary.json, page.log,
// console.log. Exit 0 when the second window shows sustained energy (at least
// 80 % of its samples above 0.005 RMS), 1 otherwise.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', '..', 'package.json'));
const { chromium } = require('playwright');

const URL = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', '..', '..', 'output', 'recomp', 'web-audio-drive');
const SECONDS = Number(process.argv[4] || '20');
const TIMEOUT_MS = Number(process.argv[5] || '600000');
const RMS_MUSIC = 0.005;
if (!URL) { console.log('usage: node drive_audio.mjs <url> <out-dir> [seconds] [timeoutMs]'); process.exit(2); }
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

// The fallback tap (see the header): installed before any page script runs.
await page.addInitScript(() => {
  const taps = new Map();
  const tapFor = (ctx) => {
    let t = taps.get(ctx);
    if (t) return t;
    const an = ctx.createAnalyser();
    an.fftSize = 8192;
    origConnect.call(an, ctx.destination);
    const buf = new Float32Array(an.fftSize);
    const blocks = [];
    const sample = () => {
      an.getFloatTimeDomainData(buf);
      let ss = 0, pk = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; ss += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
      const b = { t: performance.now(), ms: ss / buf.length, peak: pk };
      blocks.push(b);
      while (blocks.length && blocks[0].t < b.t - 1000) blocks.shift();
      return b;
    };
    t = { ctx, an, sample, blocks };
    setInterval(sample, 100);
    taps.set(ctx, t);
    return t;
  };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dst, ...rest) {
    if (dst instanceof AudioDestinationNode) dst = tapFor(this.context).an;
    return origConnect.call(this, dst, ...rest);
  };
  window.isaacAudioLevelFallback = () => {
    const t = [...taps.values()][0];
    if (!t) return null;
    const b = t.sample();
    let ms = 0, peak = 0;
    for (const x of t.blocks) { ms += x.ms; if (x.peak > peak) peak = x.peak; }
    return { rms: Math.sqrt(ms / t.blocks.length), rmsNow: Math.sqrt(b.ms), peak, blocks: t.blocks.length,
             ctxTime: t.ctx.currentTime, state: t.ctx.state, sampleRate: t.ctx.sampleRate, tap: 'fallback' };
  };
});

const t0 = Date.now();
const now = () => Date.now() - t0;
console.log(`[audio] goto ${URL}`);
for (let attempt = 1; ; attempt++) {
  try { await page.goto(URL); break; } catch (e) {
    if (attempt >= 30) throw e;
    await sleep(1000);
  }
}
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, done: window.isaacDone }));
const level = () => page.evaluate(() => {
  const own = window.isaacAudioLevel && window.isaacAudioLevel();
  if (own) return { ...own, tap: 'master' };
  return window.isaacAudioLevelFallback ? window.isaacAudioLevelFallback() : null;
});
const timeline = [];
async function sampleWindow(name, seconds) {
  const rows = [];
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    const s = await state();
    const l = await level();
    const row = { window: name, t: now(), frame: s.f, ...(l || { rms: null, rmsNow: null, peak: null, state: 'no tap' }) };
    rows.push(row); timeline.push(row);
    console.log(`[audio] ${name} +${i + 1}s frame ${s.f} rms ${l ? l.rms.toFixed(4) : '-'} now ${l ? l.rmsNow.toFixed(4) : '-'} ` +
                `peak ${l ? l.peak.toFixed(3) : '-'} ctx ${l ? l.state : '-'}${l && l.streams !== undefined ? ` streams ${l.streams} chunks ${l.scheduled}` : ''}`);
    if (s.done) break;
  }
  try { writeFileSync(join(OUT, `shot_${name}.png`), await page.screenshot({ clip: { x: 0, y: 0, width: 960, height: 540 } })); } catch (e) { /* the page may be gone */ }
  return rows;
}
const stats = (rows) => {
  const v = rows.map((r) => r.rms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null, aboveThreshold: 0 };
  return { n: v.length, median: v[v.length >> 1], min: v[0], max: v[v.length - 1],
           aboveThreshold: v.filter((x) => x > RMS_MUSIC).length / v.length };
};
const pressEnter = async () => { await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter'); };

const summary = { url: URL, firstFrameMs: null, windows: {}, tap: null, error: null, musicHeard: false };
try {
  for (;;) {
    const s = await state();
    if (s.f > 0) { summary.firstFrameMs = now(); console.log(`[audio] first frame at ${now()} ms`); break; }
    if (s.done) throw new Error('module ended before the first frame');
    if (now() > TIMEOUT_MS) throw new Error('timeout before the first frame');
    await sleep(50);
  }
  // the user activation: a click on the canvas (the page resumes the context on pointerdown)
  await page.mouse.click(480, 270);
  await sleep(500);
  const first = await level();
  summary.tap = first ? first.tap : 'none';
  console.log(`[audio] tap: ${summary.tap}${first ? ` (${first.sampleRate} Hz, ${first.state})` : ''}`);
  summary.windows.boot = stats(await sampleWindow('boot', SECONDS));
  // two held Enters: past the beta notice, past the title; a menu sound may blip
  await pressEnter(); await sleep(1500);
  await pressEnter(); await sleep(1500);
  summary.windows.title = stats(await sampleWindow('title', SECONDS));
  summary.musicHeard = summary.windows.title.n > 0 && summary.windows.title.aboveThreshold >= 0.8;
} catch (e) {
  summary.error = e.message;
  console.log(`[audio] ERROR ${e.message}`);
}
let pageLog = [];
try { pageLog = await Promise.race([page.evaluate(() => window.isaacLog || []), sleep(15000).then(() => null)]) || ['(page log unavailable)']; } catch (e) { pageLog = [`(page log unavailable: ${e.message})`]; }
// the model's trace is console.warn (console.log here), the backend's JS trace goes through the page's printErr (page.log)
summary.audioLines = consoleLines.filter((l) => /\[isaac\]\[(audio|al)\]/.test(l)).length;
summary.audioWebLines = pageLog.filter((l) => /\[isaac\]\[audio-web\]/.test(l)).length;
summary.wallMs = now();
writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
writeFileSync(join(OUT, 'page.log'), pageLog.join('\n') + '\n');
writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n') + '\n');
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
for (const [name, w] of Object.entries(summary.windows))
  console.log(`[audio] ${name}: ${w.n} samples, rms median ${w.median === null ? '-' : w.median.toFixed(4)} ` +
              `min ${w.min === null ? '-' : w.min.toFixed(4)} max ${w.max === null ? '-' : w.max.toFixed(4)}, ` +
              `${Math.round(w.aboveThreshold * 100)} % above ${RMS_MUSIC}`);
console.log(`[audio] music heard on the title window: ${summary.musicHeard} (tap ${summary.tap}, ${summary.wallMs} ms)`);
await browser.close();
process.exit(summary.musicHeard && !summary.error ? 0 : 1);
