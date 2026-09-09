// check_strings.mjs -- every item name and description key in the game's data,
// checked against the string table it resolves from:
//   node scripts/recomp/assets/check_strings.mjs [instance-dir]
//
// A reported "item descriptions display buggy" could not be reproduced from
// screenshots, so this settles the data side exhaustively instead of by
// sampling: an item whose #KEY is missing renders the raw key, and this finds
// every one of them at once.
//
// Round 90c result: 2,063 of 2,067 keys resolve. The four that do not are
// #PILLS_HERE_* (item 43) and #TAROT_CARD_* (item 61) -- removed items whose
// strings are absent from the ORIGINAL extraction too (same file, same size),
// and which the game refuses to spawn: asking for 5.100.61 hands back Glass
// Cannon. So every obtainable item resolves, and this exits 0 on that basis.
import { readFileSync } from 'node:fs';

const inst = process.argv[2] || '.scratch/game-instance';
const table = readFileSync(`${inst}/stringtable.sta`);
// the table is a binary container with XML-ish runs; keys appear as KEY"
const text = table.toString('latin1');
const has = (key) => text.includes(key + '"');

let checked = 0, missing = [];
for (const file of ['resources/items.xml', 'resources/pocketitems.xml', 'resources/items_metadata.xml']) {
  let xml;
  try { xml = readFileSync(`${inst}/${file}`, 'utf8'); } catch (e) { console.log(`${file}: not present`); continue; }
  let n = 0;
  for (const m of xml.matchAll(/(name|description)="#([A-Z0-9_]+)"/g)) {
    const key = m[2];
    checked += 1; n += 1;
    if (!has(key)) missing.push(`${file}  ${m[1]}="#${key}"`);
  }
  console.log(`${file}: ${n} key reference(s)`);
}
console.log(`\n${checked} key(s) checked, ${missing.length} missing from the string table`);
for (const m of missing.slice(0, 40)) console.log('  MISSING ' + m);
// the two removed items are expected: they are absent upstream as well
const KNOWN = /PILLS_HERE|TAROT_CARD/;
const real = missing.filter((m) => !KNOWN.test(m));
if (missing.length && !real.length) console.log('(all of them are the known removed items -- not a fault)');
process.exit(real.length ? 1 : 0);
