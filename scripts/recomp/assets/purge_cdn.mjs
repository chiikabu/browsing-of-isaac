// purge_cdn.mjs -- ask jsDelivr to drop what it is holding for this build:
//   node scripts/recomp/assets/purge_cdn.mjs [built-dir] [gh/user/repo@ref]
//
// A push is not a deploy (see check_deployed.mjs). jsDelivr serves chunks with
// max-age=604800, so until every path here is purged a browser can get a new
// page and an old payload, which fails in ways that look like code bugs.
import { readFileSync } from 'node:fs';

const BUILT = process.argv[2] || '.scratch/chunks-final';
const REPO = process.argv[3] || 'gh/chiikabu/boi-portable@main';

const page = readFileSync(`${BUILT}/index.html`, 'utf8');
const at = page.indexOf('__isaacPortableData');
const open = page.indexOf('{', at);
let depth = 0, end = open;
for (; end < page.length; end++) { if (page[end] === '{') depth++; else if (page[end] === '}' && !--depth) { end++; break; } }
const P = JSON.parse(page.slice(open, end));

const paths = ['index.html'];
for (const s of P.streams) for (let i = 0; i < s.n; i++) paths.push(`c/${s.tag}${i}.bin`);

let bad = 0;
for (const p of paths) {
  const url = `https://purge.jsdelivr.net/${REPO}/${p}`;
  let line;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    // the API answers {status:"finished"} when it has done the work; anything
    // else (a rate limit, a 5xx) leaves the old bytes in place
    const ok = r.ok && j && (j.status === 'finished' || j.status === 'pending');
    if (!ok) bad += 1;
    line = `${ok ? 'ok  ' : 'FAIL'} ${p.padEnd(14)} ${r.status} ${j ? j.status || JSON.stringify(j).slice(0, 60) : ''}`;
  } catch (e) { bad += 1; line = `FAIL ${p.padEnd(14)} ${e.message}`; }
  console.log(line);
  await new Promise((r) => setTimeout(r, 400));
}
console.log(bad ? `\n${bad} of ${paths.length} purge(s) did not take -- run it again for those.`
                : `\nall ${paths.length} paths purged; check_deployed.mjs says whether it took.`);
process.exit(bad ? 1 : 0);
