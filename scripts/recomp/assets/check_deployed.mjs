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
import { readFileSync } from 'node:fs';

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const local = (p) => { const b = readFileSync(p); return { sha: sha(b), len: b.length }; };

const CDN = process.argv[2] || 'https://cdn.jsdelivr.net/gh/chiikabu/boi-portable@main';
const PAGES = process.argv[3] || 'https://chiikabu.github.io/the-browsing-of-isaac/';
const BUILT = process.argv[4] || '.scratch/portable-chunks';

// index.html plus part A: the module is in the a* chunks, so a stale one of
// those is a stale engine no matter how current the page is
const targets = [['index.html', `${BUILT}/index.html`, `${CDN}/index.html`]];
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
