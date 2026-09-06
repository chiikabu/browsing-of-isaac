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
// second time, the page reloads and the engine's own log says it loaded the mod,
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

// A witness in the save store rather than a real persistentgamedata1.dat: the
// engine validates those at the file-select screen and would stop on a made-up
// one. What is being tested is the store, and any key in it proves the point.
const SAVE_KEY = 'c:/isaac/documents/my games/binding of isaac repentance+/drive-mods-witness.dat';
const SAVE_TEXT = 'a save written before any mod existed';
const readStores = () => page.evaluate(async ([saveKey]) => {
  const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
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
  const found = await logMatch(/LOADED MOD .*import mod/i);
  check(!!found, 'the engine found the IMPORT MOD row on its own scan', found || '');
  check(!/[?&]ISAAC_YIELD=/.test(page.url()), 'the page did not write its defaults into the address bar', page.url());

  await toModsList();
  await page.screenshot({ path: join(OUT, '1-mods-list.png') });
  await hold('Enter');
  await until(menuOpen, 8000, 'the paper menu opening');
  check(true, 'Enter on the IMPORT MOD row opened the menu');
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
  const loaded = await logMatch(/LOADED MOD .*drivertestmod/i);
  check(!!loaded, 'the engine loaded it from mods/ by its own scan', loaded || '');

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
  await toModsList();
  await page.screenshot({ path: join(OUT, '5-list-without-it.png') });

  // remove it from the page's menu, and the save is still there
  await hold('Enter');
  await until(menuOpen, 8000, 'the menu opening again');
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
