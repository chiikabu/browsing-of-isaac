// check_deployed.mjs -- what the hosts are actually serving, against what was
// built here:
//   node scripts/recomp/assets/check_deployed.mjs
//
// Round 86c. Twice a fix was verified locally, pushed, and reported as shipped
// while the CDN went on serving the old bytes. The second time the trap that
// came back was identical to the first down to the last dispatch count --
// because it WAS the same build: jsDelivr held the round-85 part-A chunks (the
// module lives in those) for nine hours after the round-86b push, so the
// browser got a new page and an old engine. A push is not a deploy.
//
// Run this after every push, and purge whatever it calls STALE:
//   curl -s https://purge.jsdelivr.net/gh/chiikabu/boi-portable@main/<path>
// then run it again. A purge that did not take looks exactly like one that did
// until the bytes are compared.
import { createHash } from 'node:crypto';
import { readFileSync, openSync, readSync, closeSync } from 'node:fs';

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const local = (p) => { const b = readFileSync(p); return { sha: sha(b), len: b.length }; };

const CDN = process.argv[2] || 'https://cdn.jsdelivr.net/gh/chiikabu/boi-portable@main';
const PAGES = process.argv[3] || 'https://chiikabu.github.io/the-browsing-of-isaac/';
const BUILT = process.argv[4] || '.scratch/portable-chunks';

// Round 89i: the page is NOT checked at the base the chunks come from. Since
// 89c that base is a commit, and a commit-pinned path is frozen on purpose --
// the page as it stood then is exactly what @<sha>/index.html should serve, so
// checking the current build against it reports a staleness that is not one.
// The page is served from a moving ref, and that is where it is asked for.
const PAGE_CDN = CDN.replace(/@[0-9a-f]{7,40}(?=\/|$)/, '@main');

// index.html plus part A: the module is in the a* chunks, so a stale one of
// those is a stale engine no matter how current the page is
const targets = [['index.html', `${BUILT}/index.html`, `${PAGE_CDN}/index.html`]];
for (const n of ['a0', 'a1', 'a2', 'a3']) targets.push([`c/${n}.bin`, `${BUILT}/c/${n}.bin`, `${CDN}/c/${n}.bin`]);

let stale = 0;
for (const [name, path, url] of targets) {
  const want = local(path);
  let got;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const b = Buffer.from(await r.arrayBuffer());
    got = { sha: sha(b), len: b.length, age: r.headers.get('age') };
  } catch (e) { got = { err: e.message }; }
  const same = got.sha === want.sha;
  if (!same) stale += 1;
  console.log(`${name.padEnd(12)} local ${want.sha} ${String(want.len).padStart(9)}  |  served `
    + `${got.sha || got.err} ${String(got.len ?? '').padStart(9)}  ${same ? 'same' : '*** STALE ***'}`
    + `${got.age ? `  age=${got.age}s` : ''}`);
}

// Every other chunk, by its first 64 KB. Hashing 543 MB to find out whether a
// push landed is not worth the bandwidth, and lengths cannot be used at all:
// jsDelivr serves these br-encoded, so content-length AND the total in a
// Content-Range are the ENCODED size, a few bytes off the real one in either
// direction. Ask for identity and read the front of the stream instead -- a
// rebuild recompresses every window, so the first window is already different.
const page = readFileSync(`${BUILT}/index.html`, 'utf8');
const at = page.indexOf('__isaacPortableData');
const open = page.indexOf('{', at);
let depth = 0, end = open;
for (; end < page.length; end++) { if (page[end] === '{') depth++; else if (page[end] === '}' && !--depth) { end++; break; } }
const P = JSON.parse(page.slice(open, end));
// round 90f: a stream may have its own base (part B is pinned to the commit
// that last changed it), so each chunk is asked for where the page will ask
const names = [], baseOf = {};
for (const s of P.streams) for (let i = 0; i < s.n; i++) { names.push(`${s.tag}${i}`); baseOf[`${s.tag}${i}`] = s.base || `${CDN}/c`; }
const rest = names.filter((n) => !/^a\d+$/.test(n));
const HEAD_BYTES = 65536;
const front = async (stream) => {
  const rd = stream.getReader();
  const out = []; let n = 0;
  while (n < HEAD_BYTES) {
    const { done, value } = await rd.read();
    if (done) break;
    out.push(Buffer.from(value)); n += value.length;
  }
  await rd.cancel().catch(() => {});
  return Buffer.concat(out).subarray(0, HEAD_BYTES);
};
let wrong = 0;
for (const n of rest) {
  const fd = openSync(`${BUILT}/c/${n}.bin`, 'r');
  const buf = Buffer.alloc(HEAD_BYTES);
  readSync(fd, buf, 0, HEAD_BYTES, 0);
  closeSync(fd);
  const want = sha(buf);
  let got;
  try {
    const r = await fetch(`${baseOf[n]}/${n}.bin`, { cache: 'no-store', headers: { 'accept-encoding': 'identity' } });
    got = r.ok ? sha(await front(r.body)) : `HTTP ${r.status}`;
  } catch (e) { got = e.message; }
  await new Promise((r) => setTimeout(r, 250));   // 403s come back if this runs flat out
  if (got !== want) {
    wrong += 1; stale += 1;
    console.log(`c/${n}.bin`.padEnd(12) + ` local ${want}  |  served ${got}  *** STALE ***`);
  }
}
console.log(`${rest.length} more chunk(s) checked by their first ${HEAD_BYTES >> 10} KB, ${wrong ? wrong + ' wrong' : 'all current'}`);

try {
  const r = await fetch(PAGES, { cache: 'no-store' });
  const b = Buffer.from(await r.arrayBuffer());
  const want = local(`${BUILT}/index.html`);
  const same = sha(b) === want.sha;
  if (!same) stale += 1;
  console.log(`pages index  local ${want.sha} ${String(want.len).padStart(9)}  |  served `
    + `${sha(b)} ${String(b.length).padStart(9)}  ${same ? 'same' : '*** STALE ***'}`);
} catch (e) { console.log('pages index  ERR ' + e.message); stale += 1; }

console.log(stale ? `\n${stale} stale artefact(s): purge them and run this again.` : '\neverything served is the build that was verified.');
process.exit(stale ? 1 : 0);
