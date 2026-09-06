// drive_boot.mjs -- the cold and the warm start, measured (round 55): the same
// page opened in a persistent browser profile twice in a row. The first
// visit has no boot trail (cold: every archive window is a synchronous
// fetch as the engine asks for it); the second has the trail the first one
// recorded (warm: the windows the boot will read are fetched ahead, in
// parallel, while the module compiles, and the engine's reads hit the
// cache). Reported per visit: the first frame's time, the time to frame 300
// and 600, the archive windows read, prefetched and hit.
//   node scripts/recomp/web/drive_boot.mjs <url> <out-dir> [gl=hw] [cpu=4] [visits=2] [fresh=1] [net=<Mbit/s>] [hide_at=<frame> hide_s=<s>]
// cpu= throttles the CPU (4 = a Chromebook-class core); fresh=1 starts from an
// empty profile (the default), so visit 1 is cold.
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_boot.mjs <url> <out-dir> [gl=hw] [cpu=4] [visits=2]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
mkdirSync(OUT, { recursive: true });
const PROFILE = join(OUT, 'profile');
if (opt.fresh !== '0') rmSync(PROFILE, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const cpu = Number(opt.cpu || '4');
// net=<Mbit/s> (round 59): a download cap through CDP, 20 ms of latency -- the
// trail's prefetch overlaps the engine's loading only when the network is the
// slower party, which localhost never is
const netMbps = Number(opt.net || '0');
// hide_at=<frame> hide_s=<seconds> (round 62): the tab reads as hidden from that
// frame for that long -- in the middle of the loading, while the reader Worker
// has windows in flight and the engine sits suspended in reads -- and the boot
// must still reach frames 300 and 600 once it is visible again
const hideAt = Number(opt.hide_at || '0'), hideS = Number(opt.hide_s || '10');
const visits = Number(opt.visits || '2');
const results = [];
for (let v = 1; v <= visits; v++) {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1280, height: 720 },
    args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (netMbps > 0) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: netMbps * 125000, uploadThroughput: netMbps * 125000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(URL);
  const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, lazy: typeof window.isaacLazyStats === 'function' ? window.isaacLazyStats() : null }));
  const waitFrame = async (n, limit) => { for (;;) { const s = await state(); if (s.f >= n) return Date.now() - t0; if (Date.now() - t0 > limit) return null; await sleep(50); } };
  const first = await waitFrame(1, 600000);
  let hidden = null;
  if (hideAt > 0) {
    await waitFrame(hideAt, 600000);
    const fBefore = (await state()).f;
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(hideS * 1000);
    const fHidden = (await state()).f;
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    hidden = { at: fBefore, framesWhileHidden: fHidden - fBefore, seconds: hideS };
    console.log(`[boot]   hidden from frame ${fBefore} for ${hideS} s: ${hidden.framesWhileHidden} frames ticked meanwhile (the 250 ms path)`);
  }
  const f300 = await waitFrame(300, 120000);
  const f600 = await waitFrame(600, 120000);
  await sleep(1500);                                        // let the trail be written
  const s = await state();
  const lazy = s.lazy || {};
  const stored = await page.evaluate(() => { try { const t = localStorage.getItem('isaac-boot-trail'); return t ? JSON.parse(t).length : 0; } catch (e) { return -1; } });
  // round 59: the trail this visit left, for ship.py --trail (the dist then ships it to first visits)
  const trailJson = await page.evaluate(() => { try { return localStorage.getItem('isaac-boot-trail') || ''; } catch (e) { return ''; } });
  if (trailJson) writeFileSync(join(OUT, 'boot-trail.json'), trailJson);
  const r = { visit: v, firstFrameMs: first, frame300Ms: f300, frame600Ms: f600, hidden, windows: lazy.windows, windowMB: lazy.windowBytes != null ? +(lazy.windowBytes / 1048576).toFixed(1) : null,
    prefetched: lazy.prefetched, prefetchHits: lazy.prefetchHits, prefetchMisses: lazy.prefetchMisses, aheadFetched: lazy.aheadFetched, readerWaits: lazy.readerWaits, readerWaitMs: lazy.readerWaitMs, reader: lazy.reader, trailKept: lazy.trailKept, trailShipped: lazy.trailShipped, trailWritten: lazy.trailWritten, trailLen: lazy.trailLen, storedTrail: stored, errors: errors.length };
  results.push(r);
  if (Array.isArray(lazy.trail)) console.log(`[boot]   the first windows: ${lazy.trail.slice(0, 40).join(' ')}`);
  console.log(`[boot] visit ${v} (${v === 1 ? 'cold' : 'warm'}): first frame ${first} ms, frame 300 at ${f300} ms, frame 600 at ${f600} ms; windows ${r.windows} (${r.windowMB} MB), prefetched ${r.prefetched}, hits ${r.prefetchHits}, misses ${r.prefetchMisses}, ahead ${r.aheadFetched}, waits ${r.readerWaits} (${r.readerWaitMs} ms), reader ${r.reader}, trail kept ${r.trailKept}${r.trailShipped ? ' (shipped)' : ''}, written ${r.trailWritten} (${r.trailLen} entries, ${stored} stored)${errors.length ? '; ERRORS ' + errors[0].slice(0, 80) : ''}`);
  await ctx.close();
}
writeFileSync(join(OUT, 'boot.json'), JSON.stringify({ url: URL, cpu, results }, null, 1));
if (results.length >= 2 && results[0].firstFrameMs && results[1].firstFrameMs)
  console.log(`[boot] warm vs cold: first frame ${results[1].firstFrameMs} vs ${results[0].firstFrameMs} ms, frame 300 ${results[1].frame300Ms} vs ${results[0].frame300Ms} ms, frame 600 ${results[1].frame600Ms} vs ${results[0].frame600Ms} ms`);
