// drive_mods.mjs -- mods, driven the way a player reaches them, on the shipping
// page (rounds 74 and 76):
//   node scripts/recomp/web/drive_mods.mjs http://127.0.0.1:8200/play.html <out-dir> [gl=hw] [options=<ini>]
//
// Title -> file select -> file 1 -> Tab for the game's mods list -> Enter on the
// IMPORT MOD row. That row is a mod the pipeline seeds, so the engine lists it
// like any other, and Enter on it makes the engine write a disable.it; the page
// claims that write and opens its own menu, drawn on the game's own paper.
//
// Then: a zip built here goes through the picker, the same zip is refused a
// second time, a second mod is installed out of a catalogue this driver serves
// (the MOD BROWSER row, which a built page offers only when it carries a
// catalogue URL -- portable.py --catalogue), the page reloads and the engine's own log says it loaded the mod,
// the mod is turned off from the game's own list and stays off across a reload
// (the engine does not read disable.it back, so the page keeps the flag), and
// finally it is removed. A witness in the save store is checked byte for byte
// throughout: mods and saves are separate databases and this is the test that
// says so.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_mods.mjs <url> <out-dir> [gl=hw] [options=<ini>]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e));
const checks = [];
const check = (ok, what, detail) => { checks.push(!!ok); console.log(`[mods] ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`); };
const hold = async (key, ms = 90) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(150); } };
const frame = () => page.evaluate(() => window.isaacFrame | 0).catch(() => 0);
const menu = () => page.evaluate(() => (window.isaacModsMenu ? window.isaacModsMenu.state() : null)).catch(() => null);
const menuOpen = () => page.evaluate(() => !!(window.isaacModsMenu && window.isaacModsMenu.isOpen())).catch(() => false);
const message = async () => ((await menu()) || {}).message || '';
// walk the cursor to a row by name, the way a player finds it
const toRow = async (label) => {
  for (let i = 0; i < 24; i++) {
    const st = await menu();
    if (st && st.current === label) return true;
    await hold('ArrowDown'); await sleep(160);
  }
  return false;
};
const logMatch = (re) => page.evaluate((src) => {
  const r = new RegExp(src), log = window.isaacLog || [];
  for (let i = log.length - 1; i >= 0; i--) if (r.test(String(log[i]))) return String(log[i]).slice(0, 200);
  return null;
}, re.source);
// title -> file select -> file 1 -> the game's own mods list
const toModsList = async () => {
  await hold('Enter'); await sleep(1800);
  await hold('Enter'); await sleep(2600);
  await hold('Enter'); await sleep(2200);
  await hold('Tab'); await sleep(2000);
};
// Round 82: with no mod installed there is no IMPORT MOD row, because the row is
// itself a mod and a mod loaded makes the run a modded one. The way in is the
// page's own EDIT FILE menu: title -> file select -> the EDIT FILE strip -> file
// 1 -> MODS.
const editMenu = () => page.evaluate(() => (window.isaacEditFileMenu
  ? { open: window.isaacEditFileMenu.isOpen(), current: window.isaacEditFileMenu.current(),
      rows: window.isaacEditFileMenu.rows() }
  : null)).catch(() => null);
const toModsViaFileMenu = async () => {
  await hold('Enter'); await sleep(1800);
  await hold('Enter'); await sleep(2600);
  await hold('ArrowDown'); await sleep(700);   // onto the EDIT FILE strip
  await hold('Enter'); await sleep(1000);      // file-choosing mode
  await hold('Enter');                         // file 1: the page's menu
  await until(async () => { const s = await editMenu(); return s && s.open ? s : null; }, 8000, 'the EDIT FILE menu');
  for (let i = 0; i < 8; i++) {
    const s = await editMenu();
    if (s && s.current === 'MODS') break;
    await hold('ArrowDown'); await sleep(180);
  }
  await hold('Enter');
};
const boot = async () => {
  await until(async () => (await frame()) > 0, 600000, 'first frame');
  await until(async () => (await frame()) > 150, 120000, 'the engine running');
};

// ---- a mod, zipped here: deflated entries and a folder above them, which is how
// a mod comes off a download page and the shape the importer has to see through
const MOD_DIR = 'Driver Test Mod';
const MOD_FILES = [
  [`${MOD_DIR}/metadata.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <name>Driver Test Mod</name>\n'
    + '  <directory>drivertestmod</directory>\n  <description>written by drive_mods.mjs</description>\n  <version>1</version>\n</metadata>\n'],
  [`${MOD_DIR}/main.lua`, 'local mod = RegisterMod("Driver Test Mod", 1)\nreturn mod\n'],
  [`${MOD_DIR}/content/isaac.xml`, '<!-- a file deep enough to prove the tree survives -->\n'],
];
function zipOf(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  let offset = 0;
  for (const [name, text] of files) {
    const raw = enc.encode(text), comp = deflateRawSync(raw), n = enc.encode(name), crc = crc32(raw);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 8, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true);
    lh.setUint16(26, n.length, true);
    parts.push(Buffer.from(lh.buffer), Buffer.from(n), comp);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, comp.length, true); cd.setUint32(24, raw.length, true);
    cd.setUint16(28, n.length, true); cd.setUint32(42, offset, true);
    central.push(Buffer.from(cd.buffer), Buffer.from(n));
    offset += 30 + n.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdBuf.length, true); eocd.setUint32(16, offset, true);
  return Buffer.concat([...parts, cdBuf, Buffer.from(eocd.buffer)]);
}
const zip = zipOf(MOD_FILES);
writeFileSync(join(OUT, 'driver-test-mod.zip'), zip);

// ---- a catalogue, served by this driver ------------------------------------
// modpack.py's layout: catalogue.json, and each mod's zip cut into parts under
// jsDelivr's 20 MB ceiling. The base resolves to nothing; every request to it is
// answered here, so what is checked is the page and not a network.
const CAT_BASE = 'https://catalogue.invalid/mods';
const CAT_DIR = 'Catalogue Test Mod';
const CAT_ZIP = zipOf([
  [`${CAT_DIR}/metadata.xml`, '<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <name>Catalogue Test Mod</name>\n'
    + '  <directory>cataloguetestmod</directory>\n  <description>served by drive_mods.mjs</description>\n  <version>1</version>\n</metadata>\n'],
  [`${CAT_DIR}/main.lua`, 'local mod = RegisterMod("Catalogue Test Mod", 1)\nreturn mod\n'],
]);
// cut in two, so joining the parts back up is part of what is checked
const CAT_PARTS = [CAT_ZIP.subarray(0, CAT_ZIP.length >> 1), CAT_ZIP.subarray(CAT_ZIP.length >> 1)];
const CATALOGUE = { base: CAT_BASE, mods: [
  { id: 'cataloguetestmod', name: 'Catalogue Test Mod', description: 'served by drive_mods.mjs',
    bytes: CAT_ZIP.length, parts: CAT_PARTS.length },
  // a second row, so a search has something to narrow down
  { id: 'notthisone', name: 'Some Other Mod', description: 'never installed here', bytes: 1024, parts: 1 },
] };
const CORS = { 'access-control-allow-origin': '*' };
await page.route('**/catalogue.invalid/**', async (route) => {
  const url = route.request().url();
  if (url.endsWith('/catalogue.json')) {
    await route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(CATALOGUE) });
    return;
  }
  const m = url.match(/\/m\/([a-z0-9_-]+)\.(\d+)\.bin$/);
  if (m && m[1] === 'cataloguetestmod' && CAT_PARTS[+m[2]]) {
    await route.fulfill({ status: 200, headers: CORS, contentType: 'application/octet-stream',
                          body: Buffer.from(CAT_PARTS[+m[2]]) });
    return;
  }
  await route.fulfill({ status: 404, headers: CORS, body: 'no' });
});
// what portable.py --catalogue writes into a built page
await page.addInitScript((base) => { window.isaacModCatalogue = base; }, CAT_BASE);
// A witness in the save store rather than a real persistentgamedata1.dat: the
// engine validates those at the file-select screen and would stop on a made-up
// one. What is being tested is the store, and any key in it proves the point.
const SAVE_KEY = 'c:/isaac/documents/my games/binding of isaac repentance+/drive-mods-witness.dat';
const SAVE_TEXT = 'a save written before any mod existed';
const readStores = () => page.evaluate(async ([saveKey]) => {
  // the version is not optional: a versionless open CREATES the database empty
  // if it is not there yet, and the page's own open then never upgrades it, so
  // its stores are never made and every import fails from then on (round 86c)
  const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = (db, store) => new Promise((res) => {
    if (!db.objectStoreNames.contains(store)) { res([]); return; }
    const out = []; const r = db.transaction(store, 'readonly').objectStore(store).openCursor();
    r.onsuccess = () => { const c = r.result; if (!c) { res(out); return; } out.push([String(c.key), c.value]); c.continue(); };
    r.onerror = () => res(out);
  });
  const md = await open('isaac-mods'), sd = await open('isaac-saves');
  const files = await all(md, 'files'), index = await all(md, 'mods'), saves = await all(sd, 'files');
  const save = saves.find(([k]) => k === saveKey);
  md.close(); sd.close();
  return {
    modFiles: files.map(([k]) => k).sort(),
    index: index.map(([, v]) => ({ id: v.id, name: v.name, enabled: v.enabled !== false })),
    saveText: save ? new TextDecoder().decode(save[1].bytes) : null,
    saveKeysUnderMods: saves.map(([k]) => k).filter((k) => k.includes('/mods/')),
  };
}, [SAVE_KEY]);

try {
  const origin = new globalThis.URL(URL).origin;
  // Chrome's JSON viewer takes the context over a beat after the navigation and
  // then denies IndexedDB, so navigate and seed together, and try again if it won
  const seed = () => page.evaluate(async ([ini, save, saveKey, optKey]) => new Promise((resolve) => {
    const req = indexedDB.open('isaac-saves', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
    req.onerror = () => resolve('open failed: ' + req.error);
    req.onsuccess = () => {
      const db = req.result, tx = db.transaction('files', 'readwrite'), st = tx.objectStore('files');
      if (ini) st.put({ src: null, bytes: new Uint8Array(ini) }, optKey);
      st.put({ src: null, bytes: new TextEncoder().encode(save) }, saveKey);
      tx.oncomplete = () => { db.close(); resolve('ok'); };
      tx.onerror = () => resolve('tx failed: ' + tx.error);
    };
  }), [opt.options ? [...readFileSync(opt.options)] : null, SAVE_TEXT, SAVE_KEY,
       'c:/isaac/documents/my games/binding of isaac repentance+/options.ini']);
  let seeded = null;
  for (let i = 0; i < 4 && seeded !== 'ok'; i++) {
    await page.goto(origin + '/instance_index.json').catch(() => {});
    seeded = await seed().catch((e) => 'threw: ' + e.message.split('\n')[0]);
  }
  check(seeded === 'ok', 'a save and the options are in the save store before the run', String(seeded));

  await page.goto(URL);
  await boot();
  check(!!(await logMatch(/=== seed mods ===/)), 'the pipeline seeded mods');
  // Round 82: nothing is seeded on a save with no mods, so the run is not a
  // modded one and the achievement indicator stays off. This is the check that
  // the import row is not costing a fresh player their unlocks.
  const early = await logMatch(/LOADED MOD .*import mod/i);
  check(!early, 'with no mods installed the engine loads no mod at all', early || 'nothing loaded');
  check(!/[?&]ISAAC_YIELD=/.test(page.url()), 'the page did not write its defaults into the address bar', page.url());

  await toModsViaFileMenu();
  await until(menuOpen, 8000, 'the paper menu opening');
  check(true, 'MODS on the EDIT FILE menu opened it, with no mod to press Enter on');
  await page.screenshot({ path: join(OUT, '1-mods-list.png') });
  await sleep(400);
  await page.screenshot({ path: join(OUT, '2-menu.png') });

  // the zip through the picker, exactly as a chosen file arrives
  await page.setInputFiles('#mods-file', { name: 'driver-test-mod.zip', mimeType: 'application/zip', buffer: zip });
  const msg = await until(async () => { const m = await message(); return m && !/^READING/.test(m) ? m : null; }, 15000, 'the import finishing');
  check(/DRIVER TEST MOD: 3 FILE\(S\)/.test(msg), 'the zip imported, folder above it and all', msg);
  let st = await menu();
  check(st && st.mods.length === 1 && st.mods[0].id === 'drivertestmod' && st.mods[0].enabled,
    'the menu lists it, and it is on', JSON.stringify(st && st.mods));

  // the same zip again is refused: one mod, one entry
  await page.setInputFiles('#mods-file', { name: 'driver-test-mod.zip', mimeType: 'application/zip', buffer: zip });
  const dup = await until(async () => { const m = await message(); return /ALREADY INSTALLED/.test(m) ? m : null; }, 15000, 'the duplicate being refused');
  check(/ALREADY INSTALLED/.test(dup), 'importing it a second time is refused', dup);
  st = await menu();
  check(st && st.mods.length === 1, 'and there is still one of it', JSON.stringify(st && st.mods));
  await page.screenshot({ path: join(OUT, '3-imported.png') });

  // ---- the browser: the row is there, it searches, and it installs
  let st2 = await menu();
  check(st2 && st2.rows.includes('MOD BROWSER'),
    'the menu offers MOD BROWSER when the build carries a catalogue',
    st2 ? st2.rows.join(' / ') : 'no menu');
  check(await toRow('MOD BROWSER'), 'the cursor reaches it');
  await hold('Enter');
  const listed = await until(async () => {
    const st = await menu();
    return st && st.title === 'MOD BROWSER' && st.rows.length > 2 ? st : null;
  }, 20000, 'the catalogue arriving').catch(() => null);
  check(!!listed, 'Enter on it fetches the catalogue', listed ? `${listed.rows.length} row(s)` : 'nothing');
  await page.screenshot({ path: join(OUT, '7-browser.png') });

  // typing narrows it: two mods in the catalogue, one of them matches
  for (const ch of 'catalogue') { await page.keyboard.press(`Key${ch.toUpperCase()}`); await sleep(70); }
  await sleep(500);
  const searched = await menu();
  check(searched && searched.search === 'catalogue'
    && searched.rows.filter((r) => r !== 'BACK').length === 1,
    'typing searches it', searched ? `"${searched.search}" -> ${searched.rows.join(' / ')}` : '');
  await page.screenshot({ path: join(OUT, '8-searched.png') });

  // Enter on the row that is left: two parts fetched, joined, unzipped, stored
  check(await toRow('Catalogue Test Mod'), 'the cursor is on the mod');
  await hold('Enter');
  const added = await until(async () => {
    const s = await readStores();
    return s.index.find((x) => x.id === 'cataloguetestmod') || null;
  }, 25000, 'the catalogue mod installing').catch(() => null);
  check(!!added, 'Enter on a catalogue row installs it', added ? added.name : 'not installed');
  const catFiles = (await readStores()).modFiles.filter((f) => f.startsWith('cataloguetestmod/'));
  check(catFiles.join('|') === 'cataloguetestmod/main.lua|cataloguetestmod/metadata.xml',
    'the two parts were joined back into the zip they came from', catFiles.join(' '));

  // back to the menu -- through the BACK row, not Escape: Escape closes the whole
  // menu, and a menu closed with a new mod in it reloads the page (that is how an
  // import reaches the engine's own list).
  check(await toRow('BACK'), 'the browser has a way back');
  await hold('Enter'); await sleep(600);
  // Round 84: what is installed is the game's own screen's business. This menu
  // keeps only what that screen cannot do -- bring a mod in, and take one out.
  let acts = ((await menu()) || {}).rows || [];
  check(!acts.includes('Catalogue Test Mod') && !acts.includes('Driver Test Mod'),
    'the menu does not list what is installed', acts.join(' / '));
  check(acts.includes('REMOVE MOD'), 'it offers REMOVE MOD instead', acts.join(' / '));
  check(await toRow('REMOVE MOD'), 'the cursor reaches it');
  await hold('Enter'); await sleep(600);
  const rem = await menu();
  check(rem && rem.title === 'REMOVE MOD' && rem.rows.includes('Catalogue Test Mod'),
    'and that list is the installed mods', rem ? rem.rows.join(' / ') : 'no menu');
  check(await toRow('Catalogue Test Mod'), 'the cursor is on the one just installed');
  await hold('KeyX');
  await until(async () => ((await readStores()).index.find((x) => x.id === 'cataloguetestmod') ? null : true),
    10000, 'the catalogue mod being removed again');

  const stores = await readStores();
  check(stores.modFiles.join('|') === 'drivertestmod/content/isaac.xml|drivertestmod/main.lua|drivertestmod/metadata.xml',
    'the tree survived the zip, root folder peeled off', stores.modFiles.join(' '));
  check(stores.saveText === SAVE_TEXT, 'the save is byte for byte what it was', String(stores.saveText).slice(0, 40));
  check(stores.saveKeysUnderMods.length === 0, 'nothing under mods/ leaked into the save store', JSON.stringify(stores.saveKeysUnderMods));

  // the reload: the engine's own scan is the only witness that counts
  await page.reload();
  await boot();
  const seedLine = await logMatch(/Driver Test Mod \(drivertestmod\)/);
  check(!!seedLine, 'the pipeline seeded it at the next boot', seedLine || '');
  // and now that there is a mod of the player's own, the in-game row is back
  const row = await logMatch(/LOADED MOD .*import mod/i);
  check(!!row, 'the IMPORT MOD row comes back once a mod is installed', row || 'not loaded');
  const loaded = await logMatch(/LOADED MOD .*drivertestmod/i);
  check(!!loaded, 'the engine loaded it from mods/ by its own scan', loaded || '');
  // Round 81: with a mod loaded the engine would mark its save data read-only,
  // which is the whole achievement gate. It logs every time it sets that flag,
  // so the log is the witness: the line may never appear in a run this short,
  // but if it does it can only say False.
  const ro = await logMatch(/Setting PersistentGameData ReadOnly to (True|False)/);
  check(!/ReadOnly to True/.test(ro || ''), 'the engine never marks the save read-only for a modded run',
    ro || 'it did not set the flag during this run');

  // turn it off from the game's own list: the import row sorts first, so one Down
  await toModsList();
  await hold('ArrowDown'); await sleep(700);
  await hold('Enter'); await sleep(1500);
  await page.screenshot({ path: join(OUT, '4-turned-off.png') });
  const off = await until(async () => {
    const s = await readStores();
    const m = s.index.find((x) => x.id === 'drivertestmod');
    return m && m.enabled === false ? m : null;
  }, 8000, 'the flag going off').catch(() => null);
  check(!!off, 'turning it off in the game\'s list is kept by the page (the engine will not keep it)');

  // and the next boot honours it, which is the whole point
  await page.reload();
  await boot();
  check(!(await logMatch(/LOADED MOD .*drivertestmod/i)), 'after a reload the engine does not load it',
    (await logMatch(/LOADED MOD .*drivertestmod/i)) || 'not loaded');
  check(!!(await logMatch(/1 off/)), 'and the seed stage says why', (await logMatch(/mod\(s\).*off/)) || '');
  // Its only mod is off, so nothing is seeded -- not even the import row, which
  // is the point: no mod loaded, no modded run. The file menu is the way back.
  await toModsViaFileMenu();
  await until(menuOpen, 8000, 'the menu opening again');
  await sleep(400);
  await page.screenshot({ path: join(OUT, '5-list-without-it.png') });

  // remove it from the page's menu, and the save is still there
  check(await toRow('REMOVE MOD'), 'REMOVE MOD is there with a mod installed');
  await hold('Enter'); await sleep(600);
  check(await toRow('Driver Test Mod'), 'the mod is in that list');
  await hold('KeyX'); await sleep(1200);
  const gone = await until(async () => { const m = await message(); return /REMOVED/.test(m) ? m : null; }, 8000, 'the removal').catch(() => '');
  check(/REMOVED/.test(gone), 'removing it says so', gone);
  const after = await readStores();
  check(after.modFiles.length === 0 && after.index.length === 0, 'its files and its row went with it',
    `${after.modFiles.length} file(s), ${after.index.length} row(s)`);
  check(after.saveText === SAVE_TEXT, 'the save survived the removal too');
  await page.screenshot({ path: join(OUT, '6-removed.png') });
} catch (e) {
  check(false, 'the run finished', e.message);
} finally {
  writeFileSync(join(OUT, 'console.log'), consoleLines.join('\n'));
  await browser.close();
  const bad = checks.filter((c) => !c).length;
  console.log(`[mods] ${bad ? 'FAIL' : 'PASS'}: ${checks.length - bad}/${checks.length} checks`);
  process.exit(bad ? 1 : 0);
}
