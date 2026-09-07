// recomp-mods.test.js -- mods imported from the device (round 74).
//
// The parts that are quiet when they break: a path out of an archive that lands
// somewhere it should not, a mod that goes into the save store, a zip with the
// mod folder inside it that seeds one level too deep and simply never loads.
// drive_mods.mjs runs the whole thing through the engine; these pin the pieces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRel, modId, stripRoots, readMetadata, planMod, seedMods, disableTarget,
         GUEST_ROOT, USER_ROOT, GUEST_ROOTS, IMPORT_DIR, IMPORT_MARK, MODS_DB, IMPORT_METADATA } from '../scripts/recomp/web/mods.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, 'scripts', 'recomp', 'web', f), 'utf8');
const bytes = (s) => new TextEncoder().encode(s);
const named = (...names) => names.map((n) => ({ name: n, bytes: bytes(n) }));

test('a path out of an archive that is not a plain relative path is dropped', () => {
  // this is the one that matters: mods/ and the saves are neighbours in the same
  // key space, and `..` twice over reaches Documents/My Games
  assert.equal(safeRel('../../documents/my games/x.dat'), null);
  assert.equal(safeRel('a/../b'), null);
  // an absolute path is made relative rather than refused, the way every unzip
  // tool does it; the seed puts mods/<id>/ in front of whatever comes back, so
  // it lands inside the mod either way
  assert.equal(safeRel('/etc/passwd'), 'etc/passwd');
  assert.equal(safeRel('C:/windows/system32'), null);
  assert.equal(safeRel('a//b'), null, 'an empty segment is a path we did not write');
  assert.equal(safeRel('a/b\u0000c'), null);
  assert.equal(safeRel(''), null);
  assert.equal(safeRel(null), null);
  assert.equal(safeRel('x'.repeat(300)), null);
  // and what is fine stays exactly as it was, backslashes turned round
  assert.equal(safeRel('content/entities2.xml'), 'content/entities2.xml');
  assert.equal(safeRel('resources\\gfx\\a.png'), 'resources/gfx/a.png');
  assert.equal(safeRel('main.lua'), 'main.lua');
});

test('a mod id is a folder name, and nothing else', () => {
  assert.equal(modId('Fiend Folio!'), 'fiend-folio');
  assert.equal(modId('../x'), 'x');
  assert.equal(modId('  '), null);
  assert.equal(modId(null), null);
  assert.equal(modId('A'.repeat(200)).length, 64);
});

test('the mod folder inside the archive is peeled off', () => {
  // a download is `ModName/metadata.xml`, not `metadata.xml`, and seeding it as
  // it comes gives mods/<id>/ModName/metadata.xml, which the game does not load
  const one = stripRoots(named('Fiend Folio/metadata.xml', 'Fiend Folio/main.lua', 'Fiend Folio/content/a.xml'));
  assert.equal(one.root, 'Fiend Folio');
  assert.deepEqual(one.entries.map((e) => e.name), ['metadata.xml', 'main.lua', 'content/a.xml']);
  // two of them, as a zip of a zip's worth of folders sometimes is
  const two = stripRoots(named('a/b/metadata.xml', 'a/b/main.lua'));
  assert.deepEqual(two.entries.map((e) => e.name), ['metadata.xml', 'main.lua']);
  // already at the top: left alone
  const flat = named('metadata.xml', 'main.lua');
  assert.deepEqual(stripRoots(flat).entries.map((e) => e.name), ['metadata.xml', 'main.lua']);
  // two mods in one archive is not a single root and is not peeled
  const many = stripRoots(named('one/main.lua', 'two/main.lua'));
  assert.equal(many.root, null);
  assert.deepEqual(many.entries.map((e) => e.name), ['one/main.lua', 'two/main.lua']);
});

test('metadata is read without a DOM, and a broken file costs a name, not the import', () => {
  assert.deepEqual(readMetadata(bytes('<metadata><name>Fiend Folio</name><directory>fiendfolio</directory></metadata>')),
    { name: 'Fiend Folio', directory: 'fiendfolio' });
  assert.deepEqual(readMetadata(bytes('<metadata>\n  <name>\n   Spaced Out\n  </name>\n</metadata>')),
    { name: 'Spaced Out', directory: null });
  assert.deepEqual(readMetadata(bytes('<name><![CDATA[Cdata Mod]]></name>')), { name: 'Cdata Mod', directory: null });
  // the shapes DOMParser would have thrown on
  assert.deepEqual(readMetadata(bytes('<metadata><name>Tom & Jerry</name>')), { name: 'Tom & Jerry', directory: null });
  assert.deepEqual(readMetadata(bytes('not xml at all')), { name: null, directory: null });
  assert.deepEqual(readMetadata(new Uint8Array([0xff, 0xfe, 0x00])), { name: null, directory: null });
});

test('a plan names the mod, keeps its tree and drops what it should not carry', () => {
  const p = planMod(named('Fiend Folio/main.lua', 'Fiend Folio/content/a.xml').concat([
    { name: 'Fiend Folio/metadata.xml', bytes: bytes('<metadata><name>Fiend Folio</name><directory>fiendfolio</directory></metadata>') },
    { name: 'Fiend Folio/../../documents/my games/binding of isaac repentance+/persistentgamedata1.dat', bytes: bytes('x') },
  ]), 'download');
  assert.equal(p.mod.id, 'fiendfolio', 'the directory in the metadata wins');
  assert.equal(p.mod.name, 'Fiend Folio');
  assert.equal(p.dropped.length, 1, 'the path that climbed out was dropped, not repaired');
  assert.deepEqual(p.files.map((f) => f.name).sort(), ['content/a.xml', 'main.lua', 'metadata.xml']);
  assert.equal(p.madeMetadata, false);
});

test('a mod with no metadata.xml gets one, because the game skips a folder without it', () => {
  const p = planMod(named('Some Mod/main.lua', 'Some Mod/content/a.xml'), 'some-mod.zip');
  assert.equal(p.madeMetadata, true);
  assert.equal(p.mod.id, 'some-mod');
  assert.equal(p.mod.name, 'Some Mod');
  const meta = p.files.find((f) => f.name === 'metadata.xml');
  assert.ok(meta, 'one was written');
  assert.deepEqual(readMetadata(meta.bytes), { name: 'Some Mod', directory: 'some-mod' });
});

test('a mod may not call itself the import row', () => {
  assert.throws(() => planMod([{ name: 'import-mod/main.lua', bytes: bytes('x') },
                               { name: 'import-mod/metadata.xml', bytes: bytes('<metadata/>') }], null), /import row/);
  assert.throws(() => planMod([{ name: '../x', bytes: bytes('x') }], null), /nothing in it/);
});

test('seeding builds every path itself, under mods/ and nowhere else', async () => {
  const seen = [];
  const seed = (path, b) => { seen.push([path, b.length]); return true; };
  // a store that answers with a mod, a file for a mod that is not installed, and
  // a state key for each -- only the installed one may be seeded
  const db = {};
  const store = {
    mods: [{ key: 'fiendfolio', value: { id: 'fiendfolio', name: 'Fiend Folio', files: 2, bytes: 4, added: 1 } }],
    files: [
      { key: 'fiendfolio/main.lua', value: { bytes: bytes('ab') } },
      { key: 'fiendfolio/content/a.xml', value: { bytes: bytes('cd') } },
      { key: 'ghost/main.lua', value: { bytes: bytes('ef') } },
      { key: 'fiendfolio/../../x.dat', value: { bytes: bytes('gh') } },
    ],
    state: [
      { key: `${GUEST_ROOT}fiendfolio/disable.it`, value: { bytes: new Uint8Array(0) } },
      { key: `${GUEST_ROOT}ghost/disable.it`, value: { bytes: new Uint8Array(0) } },
      { key: 'c:/isaac/documents/my games/x.dat', value: { bytes: bytes('no') } },
      { key: IMPORT_MARK, value: { bytes: new Uint8Array(0) } },
    ],
  };
  // the module reads through its own cursor helpers; a stub database is enough
  const fake = {
    transaction: (name) => ({ objectStore: () => ({ openCursor: () => {
      const rows = store[name].slice();
      const req = {};
      queueMicrotask(function step() {
        if (!rows.length) { req.result = null; req.onsuccess(); return; }
        const r = rows.shift();
        req.result = { key: r.key, value: r.value, continue: () => queueMicrotask(step) };
        req.onsuccess();
      });
      return req;
    } }) }),
  };
  void db;
  const r = await seedMods(fake, seed, null);
  const paths = seen.map((s) => s[0]);
  assert.ok(paths.every((p) => GUEST_ROOTS.some((root) => p.startsWith(root))), 'nothing was seeded outside a mods root');
  // both roots, because the resource layer mounts one and the mod manager scans
  // the other (round 76)
  for (const root of GUEST_ROOTS) {
    assert.ok(paths.includes(`${root}${IMPORT_DIR}/metadata.xml`), `the import row is seeded under ${root}`);
    assert.ok(paths.includes(`${root}fiendfolio/main.lua`) && paths.includes(`${root}fiendfolio/content/a.xml`), `the mod is seeded under ${root}`);
  }
  assert.ok(!paths.some((p) => p.includes('ghost')), 'a file with no mod row behind it is not seeded');
  assert.ok(!paths.some((p) => p.includes('..')), 'nor a key that climbed out of its own mod');
  // a disable.it is never seeded back: the flag it stands for lives in the index,
  // and a mod that is off is left out entirely
  assert.ok(!paths.some((p) => /disable\.it$/.test(p)), 'no disable.it is seeded');
  assert.equal(r.mods, 1);
  assert.equal(r.off, 0);
});

test('the import row is a mod, and the toggle on it is the button', () => {
  // the game prints the folder name in its list, so the folder is the label; the
  // leading space is what keeps it at the top of a sorted list
  assert.equal(IMPORT_DIR, ' import mod');
  assert.equal(IMPORT_MARK, 'c:/isaac/mods/ import mod/disable.it');
  assert.equal(USER_ROOT, 'c:/isaac/documents/my games/binding of isaac repentance+/mods/');
  // a disable.it under either root names the mod it belongs to, and the sentinel's
  // is not one of them
  assert.equal(disableTarget(`${GUEST_ROOT}fiendfolio/disable.it`), 'fiendfolio');
  assert.equal(disableTarget(`${USER_ROOT}fiendfolio/disable.it`), 'fiendfolio');
  assert.equal(disableTarget(IMPORT_MARK), null);
  assert.equal(disableTarget(`${GUEST_ROOT}fiendfolio/main.lua`), null);
  assert.equal(disableTarget('c:/isaac/documents/my games/binding of isaac repentance+/options.ini'), null);
  assert.match(IMPORT_METADATA, /<name>IMPORT MOD<\/name>/);
  const b = src('boot_web.mjs');
  assert.ok(b.includes('if (isImportMark(key)) {'), 'the pipeline claims that write');
  assert.ok(b.includes('if (hooks.onModImport) hooks.onModImport();'), 'and asks the page for its menu');
  assert.ok(b.includes("await stageOk('seed mods', async () => {"), 'mods are seeded as a stage of their own');
  assert.ok(b.includes("if (!modsOn) { log('  mods=0: no mods, and no import row'); return 0; }"), '?mods=0 leaves it all out');
  const p = src('play.mjs');
  assert.ok(p.includes('hooks.onModImport = () => { modsMenu.open(); };'));
  // round 84: the page also asks the store whether there is a mod at all, to
  // decide whether this browser needs EnableMods turned on once
  assert.ok(p.includes("import { createModsMenu, openModDb, listMods, MODS_DB } from './mods.mjs';"));
});

test('importing over a mod replaces it rather than merging into it', () => {
  // a version that dropped a file would otherwise leave the old one for the seed
  // to find, and the mod would load carrying a file its author removed
  const m = src('mods.mjs');
  assert.ok(m.includes("fs.delete(IDBKeyRange.bound(`${mod.id}/`, `${mod.id}/\\uffff`));"),
    "the mod's own files go first, in the same transaction as the new ones");
  assert.ok(m.indexOf('fs.delete(IDBKeyRange.bound') < m.indexOf('for (const f of files) fs.put('), 'and before them');
});

test('a mod too big to be seeded is refused at the import, not at the next boot', () => {
  // seedMods stops at SEED_BUDGET, and a mod past it is skipped with a line in a
  // log nobody reads: the import would say it worked and the game would not change
  const m = src('mods.mjs');
  assert.ok(m.includes('if (mod.bytes > SEED_BUDGET) {'), 'checked where the person is looking');
  assert.ok(m.includes('the game is given ${mib(SEED_BUDGET)} for mods'), 'and said in those terms');
  assert.ok(m.includes("if (mods.reduce((n, x) => n + x.bytes, 0) > SEED_BUDGET) notes.push("), 'a total that has gone past it is said too');
});

test('mods and saves are separate databases, and a write under mods/ never reaches the saves', () => {
  assert.equal(MODS_DB, 'isaac-mods');
  const b = src('boot_web.mjs');
  assert.ok(b.includes("const SAVE_DB = 'isaac-saves', SAVE_STORE = 'files';"), 'the save store is untouched');
  assert.ok(b.includes('function modKeyTaken(key, take) {') && b.includes('if (!modsOn || !underMods(key)) return false;'),
    'anything under either mods root is claimed before the save path sees it');
  // round 76: a disable.it is a flag, not a file to keep
  assert.ok(b.includes('const off = disableTarget(key);') && b.includes('if (modDb) setModEnabled(modDb, off, !take)'),
    "the engine's own toggle flips the flag the page keeps");
  assert.ok(b.includes('cfg.isaacPersist = (key, src, ptr, len) => {\n  if (modKeyTaken(key, () => m.HEAPU8.slice(ptr, ptr + len))) return 1;'),
    'on the write');
  assert.ok(b.includes('cfg.isaacUnlink = (key, src) => {\n  if (modKeyTaken(key, null)) return 1;'), 'and on the delete');
});

test('the zip reader is one reader, imported by both menus', () => {
  const z = src('zip.mjs');
  assert.match(z, /export async function unzip\(buf\)/);
  assert.match(z, /export function zipStore\(entries\)/);
  assert.match(z, /export function archiveKind\(bytes\)/);
  const p = src('play.mjs');
  assert.ok(p.includes("import { zipStore, unzip } from './zip.mjs';"));
  assert.ok(!p.includes('function unzip(buf)'), 'and no longer carries a copy of it');
  const m = src('mods.mjs');
  assert.ok(m.includes("import { unzip, archiveKind } from './zip.mjs';"));
  // a RAR or a 7z is named rather than failing at the central directory
  assert.ok(m.includes("throw new Error(`this is a .${kind}, and nothing in a browser can open one. `"));
});

test('the page ships the new modules, and a portable build inlines them in order', () => {
  const ship = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'ship.py'), 'utf8');
  assert.match(ship, /PAGE_FILES = \("play\.html", "play\.mjs", "boot_web\.mjs", "menu_overlay\.mjs", "zip\.mjs", "mods\.mjs"\)/);
  const portable = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'portable.py'), 'utf8');
  assert.match(portable, /MODULES = \("boot\.mjs", "boot_web\.mjs", "menu_overlay\.mjs", "zip\.mjs", "mods\.mjs", "play\.mjs"\)/);
  // a blob's imports resolve against the map, so a module must be built after
  // everything it imports
  assert.match(portable, /var order = \['boot\.mjs', 'menu_overlay\.mjs', 'zip\.mjs', 'mods\.mjs', 'boot_web\.mjs', 'play\.mjs'\];/);
});

test('round 78: the menu is not open until it has rows', () => {
  // st.open was set before the art was fetched, so isOpen() said yes while the
  // model was still null. On a served page that gap is long enough for a key to
  // land, find an empty list and do nothing -- the removal that would not happen.
  const m = readFileSync(join(root, 'scripts', 'recomp', 'web', 'menu_overlay.mjs'), 'utf8');
  const open = m.slice(m.indexOf('const open = async (get, o) => {'));
  const body = open.slice(0, open.indexOf('};'));
  assert.ok(body.indexOf('await load()') < body.indexOf('st.open = true'), 'the art is loaded before it calls itself open');
  assert.ok(m.includes('if (!st.model) return true;'), 'and a key before the first draw is swallowed, not guessed at');
});

test('round 81: the MOD BROWSER row needs a catalogue the build carries', () => {
  // The row is offered only when there is a base to fetch from, and a built page
  // had no way to carry one: portable.py wrote no window.isaacModCatalogue and
  // nothing put ?catalogue= in the URL. So the browser existed, worked, and was
  // unreachable on every build for a round and a half.
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.match(mods, /if \(o\.catalogueBase\) rows\.push\(\{ label: 'MOD BROWSER'/);
  assert.match(play, /catalogueBase: params\.get\('catalogue'\) \|\| \(typeof window !== 'undefined' \? window\.isaacModCatalogue : null\) \|\| null,/);
  const portable = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'portable.py'), 'utf8');
  assert.match(portable, /def catalogue_script\(args\) -> str:/);
  assert.match(portable, /window\.isaacModCatalogue = %s;/, 'the build writes the base into the page');
  assert.match(portable, /p\.add_argument\("--catalogue"/);
  // both shapes, because the single-file build has the same row
  assert.equal((portable.match(/catalogue_script\(args\)/g) || []).length, 3,
    'the definition and both call sites: the chunked page and the offline page');
});

test('round 81: the driver presses the keys a player would to reach the browser', () => {
  // what was missing was not the code but a check that ever opened it
  const drv = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_mods.mjs'), 'utf8');
  assert.match(drv, /const toRow = async \(label\) => \{/, 'the cursor is walked, not the action called');
  assert.match(drv, /st2\.rows\.includes\('MOD BROWSER'\)/);
  assert.match(drv, /page\.route\('\*\*\/catalogue\.invalid\/\*\*'/, 'the catalogue is served by the driver');
  assert.match(drv, /'the two parts were joined back into the zip they came from'/);
  // and the menu tells a driver what it is showing without handing over an action
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  assert.match(mods, /rows: m\.rows\.map\(\(r\) => r\.label\)/);
});

test('round 81: unlocks are not gated on mods being off', () => {
  // PersistentGameData::TryUnlock (0x00929a20) opens with `cmp byte [esi+1], 0 ;
  // jne <exit>` and, once past it, its next act is the store that records the
  // unlock -- so PGD+1, the readonly byte, IS the gate. The only thing that sets
  // it is SetReadOnly (0x009299e0), which the game calls while mods are loaded.
  // The patch reads that function's argument as false.
  const patches = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  assert.match(patches, /"0x009299e4",/, 'the block patch is registered');
  assert.match(patches, /ub900_1 = \(\(uint8_t\)0x0u\);/, 'the argument is read as false');
  assert.match(patches, /LIFT-PATCH 0x009299e4 \(round 81\)/, 'and carries its marker, which is what makes it idempotent');
  // the old text has to be what the lifter actually emits, or the patch is a no-op
  assert.match(patches, /ub900_1 = MEMR8\(u3300_4\);/, 'the text it replaces');
});

test('round 82: the import row is not seeded until the player has a mod', () => {
  // It is a mod, and a mod loaded is a modded run -- which the game will not
  // give achievements for. So a row that existed only to offer an import was
  // costing the unlocks of a player who had installed nothing.
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  assert.match(mods, /if \(o\.sentinel !== false && on\.length\) \{/);
  // and `on` has to be known before that test, not after it
  const seed = mods.slice(mods.indexOf('export async function seedMods'));
  assert.ok(seed.indexOf('const on = index.filter') < seed.indexOf('o.sentinel !== false && on.length'),
    'the installed mods are counted before the sentinel is decided');
  // the way in with no mods: the page's own file menu
  const ov = readFileSync(join(root, 'scripts', 'recomp', 'web', 'menu_overlay.mjs'), 'utf8');
  assert.match(ov, /actions\.mods \? \['EXPORT FILE', 'IMPORT FILE', 'DELETE FILE', 'MODS', 'BACK'\]/);
  assert.match(ov, /if \(rows\[i\] === 'MODS'\) \{ play\('select'\); close\(null\); actions\.mods\(\); return; \}/);
  assert.match(ov, /if \(rows\[i\] === 'BACK'\) \{ close\('back'\); return; \}/, 'BACK is found by name, not by index');
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.match(play, /mods: \(\) => modsMenu\.open\(\)/);
  // the paper grows with the entries rather than clipping the fifth
  assert.match(ov, /const sh = sh0 \+ 24 \+ \(items\(\)\.length - 4\) \* 17/);
});

test('round 82: a mod being downloaded reports bytes, not parts', () => {
  // onProgress fired once a part had finished, so a mod that is one 19 MB part
  // showed nothing at all until it arrived: a menu that looks hung
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  assert.match(mods, /const reader = r\.body\.getReader\(\), piece = \[\];/);
  assert.match(mods, /piece\.push\(value\); got \+= value\.length;/);
  assert.match(mods, /if \(onProgress\) onProgress\(got, want\);/);
  assert.match(mods, /const want = entry\.bytes \|\| 0;/, 'the total is the size the catalogue carries');
  assert.match(mods, /if \(!r\.body \|\| !r\.body\.getReader\)/, 'and a browser without streams still gets one report');
  // shown on the row it belongs to
  assert.match(mods, /note: busyId === m\.id && progress != null \? `\$\{progress\}%`/);
});

test('round 82: the loading screen is the bar and one line', () => {
  const html = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.html'), 'utf8');
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  // the stages, the byte counts and the machine string are instruments now
  assert.match(play, /const STATS = params\.get\('stats'\) === '1';/);
  assert.match(play, /if \(STATS\) \{ \$\('fps'\)\.hidden = false; \$\('stages'\)\.hidden = false; \}/);
  assert.match(play, /statusEl\.textContent = STATS && detail \? detail : text;/);
  assert.match(play, /setStatus\('loading', name\);/, "the engine's stage names are the detail, not the line");
  // and the look: square corners, the menu's bone white, pips rather than a fill
  assert.match(html, /--load: #d7c9a7; --load-dim: #7d7263;/);
  // round 83: the pips read as a barcode. A hairline and a solid fill.
  assert.match(html, /#bar \{ width: min\(200px, 44%\); height: 2px; background: #2a241e; \}/);
  assert.match(html, /#bar-fill \{ width: 0; height: 100%; background: var\(--load\);/);
  assert.doesNotMatch(html, /repeating-linear-gradient/);
  // and the grid is not put back on a chunked build's loading screen
  assert.doesNotMatch(play, /if \(stagesEl\) stagesEl\.hidden = false;/);
  assert.ok(!/#bar \{[^}]*border-radius/.test(html), 'nothing in this game is rounded');
});

test('round 82: installing a mod turns mods on in the stored options', () => {
  // Round 76 made EnableMods=0 the default and options are written once and then
  // kept, so a browser that visited since has carried it: the mod imports, the
  // page seeds it, the engine lists it, and the mod manager never runs it.
  // Nothing errors anywhere, which is what made it hard to see.
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.match(play, /async function enableModsInOptions\(\)/);
  assert.match(play, /if \(!\/\^EnableMods=0\\s\*\$\/m\.test\(text\)\) return 'already on';/,
    'a browser that already has them on is left alone');
  assert.match(play, /text\.replace\(\/\^EnableMods=0\[ \\t\]\*\$\/m, 'EnableMods=1'\)/);
  assert.match(play, /onInstalled: enableModsInOptions,/);
  // and it fires on an install, not on every boot: the game's own TAB has to win
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  const install = mods.slice(mods.indexOf('async function install('), mods.indexOf('async function install(') + 1400);
  assert.match(install, /if \(o\.onInstalled\) \{ try \{ await o\.onInstalled\(\); \}/);
  assert.equal((mods.match(/o\.onInstalled/g) || []).length, 2, 'only the install path calls it');
});

test('round 84: the page menu is what the game screen cannot do', () => {
  // The game's own mods screen lists what is installed, greys it and toggles it.
  // This menu duplicated all of that; it keeps only bringing a mod in and taking
  // one out, and the list of installed mods lives behind REMOVE A MOD.
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  assert.match(mods, /if \(view === 'remove'\) \{/);
  assert.match(mods, /return \{ title: 'REMOVE MOD', rows,/);
  assert.match(mods, /if \(mods\.length\) rows\.push\(\{ label: 'REMOVE MOD'/);
  // the actions view builds its rows from nothing, not from the installed mods
  assert.match(mods, /const rows = \[\];\s*\n\s*rows\.push\(\{ label: 'IMPORT MOD'/);
  assert.match(mods, /if \(code === 'KeyX' && view === 'remove'\)/, 'X removes where the mods are listed');
  // one row, and it takes either: a file chooser cannot pick a folder and a
  // folder chooser cannot pick a file, so a drop is the way in that takes both
  assert.match(mods, /export async function entriesFromDrop\(dt\)/);
  assert.match(mods, /window\.addEventListener\('drop', \(ev\) => \{/);
  assert.match(mods, /if \(!paper\.isOpen\(\)\) return;/, 'and only while the menu is up');
  assert.match(mods, /message: message \|\| 'OR DROP A FOLDER OR \.ZIP HERE'/);
  assert.doesNotMatch(mods, /label: 'IMPORT A FOLDER'/);
});

test('round 84: the right margin is the torn one', () => {
  // The sheet's right corner is torn further in than its left, so a note or a
  // counter right-aligned to SIDE sat on the tear -- the browser's "3/33" was
  // drawn outside the paper altogether.
  const ov = readFileSync(join(root, 'scripts', 'recomp', 'web', 'menu_overlay.mjs'), 'utf8');
  assert.match(ov, /const PANEL_W = 392, PAD = 16, SIDE = 26, RIGHT = 46, TAIL = 30, MAX_ROWS = 7;/);
  assert.match(ov, /if \(row\.note\) drawText\(g, row\.note, px \+ PANEL_W - RIGHT - noteW, y, A\.atlasLight\);/);
  assert.doesNotMatch(ov, /\$\{st\.cursor \+ 1\}\/\$\{n\}/, 'and the counter is gone with it');
});

test('round 84: a browser that already had a mod gets mods turned on too', () => {
  // Round 82 only turned EnableMods on when a mod was installed, so a browser
  // that had one BEFORE that shipped kept round 76's EnableMods=0: the mod was
  // seeded, listed by the engine, and never run.
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.match(play, /async function anyModInstalled\(\)/);
  assert.match(play, /async function enableModsOnce\(\)/);
  assert.match(play, /if \(await anyModInstalled\(\)\) \{/);
  // once per browser, so turning them off in the game afterwards sticks
  assert.match(play, /localStorage\.getItem\('isaac-mods-enabled-once'\) === '1'/);
  assert.match(play, /localStorage\.setItem\('isaac-mods-enabled-once', '1'\)/);
  assert.match(play, /import \{ createModsMenu, openModDb, listMods, MODS_DB \} from '\.\/mods\.mjs';/);
});

test('round 85: a mod path reaches KAGE without its leading slashes', () => {
  // This is what made mods work. Every mod file the engine wants -- metadata,
  // main.lua, every sprite and sound -- goes through sub_00a17180, which answers
  // from an index of strings and never touches a filesystem. This port builds a
  // mod's path off an empty base, so it asked for `//mods/<id>/...` while the
  // index holds `mods/<id>/...`: two characters, and nothing of any mod was ever
  // found. The loader saw no main.lua and skipped every mod whole, which is why
  // no mod had ever run in this port.
  const patches = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  assert.match(patches, /"0x00a171a5",/, 'the patch is registered');
  assert.match(patches, /while \(ESI && MEMR8\(ESI\) == \(uint8_t\)0x2fu\) ESI = \(uint32_t\)\(ESI \+ 1u\);/,
    'the leading slashes are stepped over');
  assert.match(patches, /LIFT-PATCH 0x00a171a5 \(round 85\)/, 'and it carries its marker, which is what makes it idempotent');
  // the text it replaces has to be what the lifter emits, or the patch is a no-op
  assert.match(patches, /  uba00_4 = MEMR32\(u3300_4\);\\n  ESI = uba00_4;/);
});

test('round 85: a mod\'s Lua is put where the host Lua reads', () => {
  // The engine ran the mod and Lua answered `cannot open //mods/<id>/main.lua:
  // No such file or directory`: Lua opens through its own libc, which reads
  // MEMFS, and only the game's own scripts were ever copied there.
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.match(b, /const memfs = \(key, bytes\) => \{/);
  assert.match(b, /if \(!\/\\\.lua\$\/i\.test\(key\)\) return;/, 'only the Lua: the rest is the FS shim\'s business');
  assert.match(b, /replace\(\/\^c:\\\/isaac\\\/\/i, '\/'\)/, 'the guest key becomes a MEMFS path');
  assert.match(b, /if \(ok\) memfs\(path, bytes\);/, 'written for a file that seeded');
  assert.match(b, /lua into MEMFS/, 'and the stage says how many');
});

test('round 86b: the lifter is given the functions only a code pointer reaches', () => {
  // A mod called Isaac.GetCostumeIdByPath and the port stopped with
  //   indirect call to 0x0086fc60 from 0x00898e8b resolves to neither a host
  //   shim nor a lifted function. It is inside the image, so it was not lifted.
  // 0x0086fc60 is `mov eax,[0xc71678]; ret` -- an inline getter MSVC emitted
  // out of line only because its address was taken. Nothing calls it, so
  // Ghidra never made a function of it and no inventory the lifter reads had
  // it. The game never needs it; a mod does.
  const p = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'orphan_starts.py'), 'utf8');
  assert.match(p, /kind = 'addr'/, 'the census reads the index address escapes');
  assert.match(p, /dst % 16/, '16-byte aligned, as MSVC aligns entries here');
  assert.match(p, /mnem\.get\(prev\) == "int3"/, 'preceded by the padding that separates functions');
  // strictly-inside is the load-bearing one: func_starts feeds discover_body,
  // so a start invented INSIDE an existing function would change how that
  // function is lifted. A function that BEGINS at the candidate is evidence for.
  assert.match(p, /extents\[i\]\[0\] < va < extents\[i\]\[1\]/,
    'the coverage test is strictly inside, so a function that starts there still counts');
  assert.match(p, /0x0086fc60/, 'and it records the address that found the class');
});

test('round 86b: the sound-manager block patch does not anchor on a line that can gain a label', () => {
  // Adding those functions repartitioned the TUs and 0xa2b5c7 gained an
  // `L_00a2b5c7: ;` label, which sat between `RECOMP_VA(0xa2b5c7u);` and the
  // body the patch matched -- so the match failed and the build stopped. The
  // anchor is the sbb sequence now, which carries no label of its own.
  const patches = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  const at = patches.indexOf('("0x00a2b5c8"');
  assert.ok(at > 0, 'the patch is registered');
  const old = patches.slice(at, at + 400);
  const firstLine = old.split('\n').find((l, i) => i > 0 && l.trim());
  assert.ok(!/RECOMP_VA\(0xa2b5c7u\)/.test(firstLine),
    'the old text does not start at the line a label can precede');
  assert.match(firstLine, /u3400_4 = \(uint32_t\)\(EBX \+ \(\(uint32_t\)0xc985104du\)\);/,
    'it starts at the sbb sequence instead');
});

test('round 86c: a database without its stores is repaired, not surrendered to', () => {
  // Found by breaking it. `indexedDB.open(name)` with NO version creates an
  // empty database at version 1; after that `open(name, 1)` sees a current
  // version, never fires onupgradeneeded, and the stores are never made -- so
  // every import fails for the life of the origin with "One of the specified
  // object stores was not found", and every save quietly goes nowhere. An
  // interrupted upgrade leaves the same wreckage. Both openers check what they
  // actually got and reopen one version up to build what is missing.
  const mods = readFileSync(join(root, 'scripts', 'recomp', 'web', 'mods.mjs'), 'utf8');
  assert.match(mods, /STORES\.every\(\(s\) => db\.objectStoreNames\.contains\(s\)\)/,
    'the mods store checks all three stores are really there');
  assert.match(mods, /const next = db\.version \+ 1;/, 'and reopens one version up when they are not');

  for (const f of ['boot_web.mjs', 'play.mjs']) {
    const src = readFileSync(join(root, 'scripts', 'recomp', 'web', f), 'utf8');
    assert.match(src, /db\.objectStoreNames\.contains\(SAVE_STORE\)/, `${f} checks the save store exists`);
    assert.match(src, /const next = db\.version \+ 1;/, `${f} reopens one version up to make it`);
    // an unconditional createObjectStore throws on a database that has it
    assert.ok(!/onupgradeneeded = \(\) => \{ req\.result\.createObjectStore\(SAVE_STORE\); \}/.test(src),
      `${f} does not create the store unconditionally`);
  }

  // A versionless open is only safe when whoever does it then builds what is
  // missing. drive_mods.mjs only reads, so it must name a version; the pack
  // driver seeds options.ini, so it opens versionless and repairs like the page.
  const readOnly = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_mods.mjs'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(readOnly.match(/indexedDB\.open\(\s*(?:name|'isaac-[a-z]+')\s*\)/g), null,
    'drive_mods.mjs, which only reads, names a version');
  const pack = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_modpack.mjs'), 'utf8');
  assert.match(pack, /objectStoreNames\.contains\('files'\)/, 'the pack driver checks before it writes');
  assert.match(pack, /db\.version \+ 1/, 'and repairs the same way the page does');
});

test('round 86c: every mod in the catalogue is driven, not one of them', () => {
  // Rounds 85 and 86b each found a different reason mods did not work, and each
  // was signed off on a single mod. Neither bug would have been caught by the
  // other's mod: 85 was every path, 86b was one unlifted function only some
  // mods reach. The driver walks the whole catalogue and asks the ENGINE.
  const d = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_modpack.mjs'), 'utf8');
  assert.match(d, /LOADED MOD \\\/\*mods\\\//, 'the engine naming the directory it loaded is the witness');
  assert.match(d, /Running Lua Script: /, 'and the engine running its main.lua');
  assert.match(d, /unresolved indirect call\|TRAP in main/, 'a trap fails the mod');
  assert.match(d, /baseline/, 'and there is a no-mod baseline to compare the frame rate against');
  assert.match(d, /medianFps < floorFps/, 'a mod that loads and costs the frame rate has not worked');
});
