// throttle_boot.mjs -- a first visit over a slow link: when does the title come
// up, and how many chunk GETs did it take? A chunk fetched twice was evicted
// before the boot was done with it.
//   node scripts/recomp/web/throttle_boot.mjs <url> [mbps=25] [latencyMs=60] [maxS=900]
// Round 90f. Point it at a chunked page with ?noranges=1 (the CDN's whole-chunk
// path); a loader change measured against a plain local server looks free,
// because there a re-fetch costs nothing.
// Counts at the network layer (CDP), including GETs the HTTP cache answered.
import { chromium } from 'playwright';

const [url, mbpsArg, latArg, maxArg] = process.argv.slice(2);
const mbps = Number(mbpsArg || 25), lat = Number(latArg || 60), maxS = Number(maxArg || 900);
const browser = await chromium.launch({ args: ['--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 640 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
if (mbps > 0) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: lat, downloadThroughput: mbps * 125000, uploadThroughput: mbps * 31250 });
const reqs = new Map();                       // requestId -> chunk name
const gets = new Map();                       // chunk -> { n, cached, bytes, at[] }
cdp.on('Network.requestWillBeSent', (e) => {
  const m = /\/c\/([ab]\d+)\.bin/.exec(e.request.url);
  if (!m) return;
  reqs.set(e.requestId, m[1]);
  const g = gets.get(m[1]) || { n: 0, cached: 0, bytes: 0, at: [] };
  g.n += 1; g.at.push(((Date.now() - t0) / 1000).toFixed(0));
  gets.set(m[1], g);
});
cdp.on('Network.requestServedFromCache', (e) => { const k = reqs.get(e.requestId); if (k) gets.get(k).cached += 1; });
cdp.on('Network.loadingFinished', (e) => { const k = reqs.get(e.requestId); if (k) gets.get(k).bytes += e.encodedDataLength; });

const t0 = Date.now();
const sec = () => Number(((Date.now() - t0) / 1000).toFixed(1));
await page.goto(url);
const logMatch = (re) => page.evaluate((src) => {
  const r = new RegExp(src); const l = window.isaacLog || [];
  for (let i = l.length - 1; i >= 0; i--) if (r.test(l[i])) return true;
  return false;
}, re.source).catch(() => false);
// the JS heap (the chunk cache lives there) and, on a page that has it, the
// cache's own count -- sampled at the first frame, the title, and after the boot
const mem = () => page.evaluate(() => {
  const I = window.isaacPortable;
  return {
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    cache: I && I.cache ? I.cache() : null,
    frame: window.isaacFrame || 0,
  };
}).catch(() => null);
const heap = {};
let first = null, title = null;
for (const end = t0 + maxS * 1000; Date.now() < end;) {
  const f = await page.evaluate(() => window.isaacFrame || 0).catch(() => 0);
  if (first === null && f > 0) { first = sec(); heap.firstFrame = await mem(); }
  if (await logMatch(/Menu Title Init|Menu Save Init/)) { title = sec(); heap.title = await mem(); break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (title !== null) { await new Promise((r) => setTimeout(r, 20000)); heap.titlePlus20s = await mem(); }
const frame = await page.evaluate(() => window.isaacFrame || 0).catch(() => 0);
// "title" includes the intro, which plays for ~8,000 frames whatever the link
// does (no key is pressed here). What the loader decides is the rest: wall time
// between the first frame and the title that was NOT spent presenting frames.
const stallS = title !== null && heap.firstFrame && heap.title
  ? Number(((title - first) - (heap.title.frame - heap.firstFrame.frame) / 60).toFixed(1)) : null;
const all = [...gets.values()];
console.log(JSON.stringify({
  url, mbps, lat, firstFrameS: first, titleS: title, stallS, frame, heap,
  chunkGets: all.reduce((a, g) => a + g.n, 0), distinct: gets.size,
  fromCache: all.reduce((a, g) => a + g.cached, 0),
  netMB: Math.round(all.reduce((a, g) => a + g.bytes, 0) / 1048576),
  fetchedTwice: [...gets].filter(([, g]) => g.n > 1).map(([k, g]) => `${k} x${g.n} @${g.at.join('/')}s${g.cached ? ` (${g.cached} cached)` : ''}`),
}, null, 1));
await browser.close();
