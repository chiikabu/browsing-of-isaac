// drive_saves.mjs -- the EDIT FILE menu's export and import, round-tripped on
// the shipping page (round 59):
//   node scripts/recomp/web/drive_saves.mjs http://127.0.0.1:8200/play.html <out-dir> options=<options.ini> [gl=hw]
// A persistentgamedata1.dat is seeded into the save store before the load
// (with options.ini, whose AcceptedPublicBeta keeps the beta notice off the
// way in). Then, the player's way: Enter, Enter, Down onto EDIT FILE, Enter
// (file-choosing mode), Enter on file 1 -> the page's menu; EXPORT FILE
// hands the browser a zip, read back here: the file under its travel name,
// the bytes the store holds, the manifest naming slot 1. BACK; Right onto
// file 2; Enter -> the menu; IMPORT FILE opens the file chooser, which gets
// that zip: the store then holds the same bytes as persistentgamedata2.dat
// and the page reloads itself. After the reload, a bare .dat goes into file
// 3 the same way. Screenshots and the zip land in <out-dir>.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) { console.log('usage: node drive_saves.mjs <url> <out-dir> options=<options.ini> [gl=hw]'); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const glArgs = (opt.gl || 'hw') === 'hw' ? ['--use-angle=default', '--ignore-gpu-blocklist'] : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({ headless: true, args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
const page = await context.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(m.text()));
page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e));
const checks = [];
const choosers = []; let chooserWaiter = null;
page.on('filechooser', (fc) => { consoleLines.push('[drive] file chooser opened'); if (chooserWaiter) { const w = chooserWaiter; chooserWaiter = null; w(fc); } else choosers.push(fc); });
const nextChooser = (ms) => new Promise((resolve, reject) => {
  if (choosers.length) { resolve(choosers.shift()); return; }
  const t = setTimeout(() => { chooserWaiter = null; reject(new Error(`no file chooser within ${ms} ms`)); }, ms);
  chooserWaiter = (fc) => { clearTimeout(t); resolve(fc); };
});
const check = (ok, what, detail) => { checks.push(!!ok); console.log(`[saves] ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`); };
const t0 = Date.now();
const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, open: !!(window.isaacEditFileMenu && window.isaacEditFileMenu.isOpen()) }));
const hold = async (key, ms = 90) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(120); } };
const SAVE_DIR = 'c:/isaac/documents/my games/binding of isaac repentance+/';
const origin = new globalThis.URL(URL).origin;
// the store, read and written from a page of the origin
const storeAll = () => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('isaac-saves', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
  req.onerror = () => resolve({ error: String(req.error) });
  req.onsuccess = () => {
    const db = req.result, out = [];
    const c = db.transaction('files', 'readonly').objectStore('files').openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) { db.close(); resolve(out); return; } out.push({ key: String(cur.key), src: cur.value.src || '', bytes: Array.from(cur.value.bytes) }); cur.continue(); };
    c.onerror = () => resolve({ error: String(c.error) });
  };
}));
const storePut = (items) => page.evaluate((list) => new Promise((resolve) => {
  const req = indexedDB.open('isaac-saves', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
  req.onerror = () => resolve('open failed: ' + req.error);
  req.onsuccess = () => {
    const db = req.result, tx = db.transaction('files', 'readwrite'), st = tx.objectStore('files');
    for (const it of list) st.put({ src: it.src, bytes: new Uint8Array(it.bytes) }, it.key);
    tx.oncomplete = () => { db.close(); resolve('ok'); };
    tx.onerror = () => resolve('tx failed: ' + tx.error);
  };
}), items);
// a store-only zip, read entry by entry
function unzipStore(buf) {
  const out = []; let p = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p + 30 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true), csize = dv.getUint32(p + 18, true), nlen = dv.getUint16(p + 26, true), xlen = dv.getUint16(p + 28, true);
    const name = Buffer.from(buf.subarray(p + 30, p + 30 + nlen)).toString('utf8');
    const start = p + 30 + nlen + xlen;
    out.push({ name, method, bytes: buf.subarray(start, start + csize) });
    p = start + csize;
  }
  return out;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const keyOf = (n) => SAVE_DIR + `persistentgamedata${n}.dat`;
const lookalikes = (all, n) => all.filter((it) => new RegExp(`persistentgamedata${n}\\.dat$`, 'i').test(it.key)).map((it) => `${it.key} (${it.bytes.length} B)`).join('; ');
const diff = (a, b) => { if (a.length !== b.length) return `lengths ${a.length} vs ${b.length}`; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `first difference at ${i}: ${a[i]} vs ${b[i]}`; return 'same'; };
// a row of that menu by name: its entries are not always the same four (round 82
// put MODS between DELETE FILE and BACK), and counting presses walked into it
const toRow = async (label) => {
  for (let i = 0; i < 8; i++) {
    const at = await page.evaluate(() => (window.isaacEditFileMenu ? window.isaacEditFileMenu.current() : null)).catch(() => null);
    if (at === label) return true;
    await hold('ArrowDown'); await sleep(160);
  }
  return false;
};
// the way in to the EDIT FILE menu for the file the cursor is on
const openMenuOnFile = async (rightPresses, what) => {
  for (let i = 0; i < rightPresses; i++) { await hold('ArrowRight'); await sleep(400); }
  await hold('Enter');
  const st = await until(async () => { const s = await state(); return s.open ? s : null; }, 5000, `the EDIT FILE menu for ${what}`).catch(() => null);
  check(st && st.open, `the EDIT FILE menu opens for ${what}`, st ? `at frame ${st.f}` : 'not open');
  await sleep(400);
  return !!(st && st.open);
};
const wayIn = async () => {
  await until(async () => (await state()).f > 0, 600000, 'first frame');
  await until(async () => (await state()).f > 120, 60000, 'the engine running');
  await hold('Enter'); await sleep(1500);
  await hold('Enter'); await sleep(2500);
  await hold('ArrowDown'); await sleep(600);
  await hold('Enter'); await sleep(900);                    // file-choosing mode
};

try {
  const seeded = new Uint8Array(1024);
  for (let i = 0; i < seeded.length; i++) seeded[i] = (i * 7 + 3) & 0xff;
  const optBytes = opt.options ? [...readFileSync(opt.options)] : null;
  await page.goto(origin + '/instance_index.json').catch(() => {});
  const items = [{ key: SAVE_DIR + 'persistentgamedata1.dat', src: '', bytes: Array.from(seeded) }];
  if (optBytes) items.push({ key: SAVE_DIR + 'options.ini', src: null, bytes: optBytes });
  const put = await storePut(items);
  check(put === 'ok', 'a persistentgamedata1.dat (1,024 bytes) and options.ini seeded into the save store', put);
  await page.goto(URL);
  await wayIn();
  check(true, 'the file select screen', `${Date.now() - t0} ms`);
  // --- EXPORT file 1
  if (!(await openMenuOnFile(0, 'file 1'))) throw new Error('no menu');
  const all0 = await storeAll();
  const before = all0.filter((it) => it.key === keyOf(1));
  check(before.length === 1, 'one persistentgamedata1.dat in the store at export time', lookalikes(all0, 1));
  const dlPromise = page.waitForEvent('download', { timeout: 15000 });
  await hold('Enter');                                       // EXPORT FILE is the first entry
  const dl = await dlPromise;
  const dlPath = await dl.path();
  const zipOut = join(OUT, dl.suggestedFilename());
  copyFileSync(dlPath, zipOut);
  const zipBytes = readFileSync(zipOut);
  const entries = unzipStore(zipBytes);
  const dat = entries.find((e) => /persistentgamedata1\.dat$/i.test(e.name));
  const meta = entries.find((e) => e.name === 'isaac-saves.json');
  const metaDoc = meta ? JSON.parse(Buffer.from(meta.bytes).toString('utf8')) : null;
  check(/^isaac-file1-.*\.zip$/.test(dl.suggestedFilename()) && entries.length === 2, 'EXPORT FILE hands the browser a zip named for file 1 with the save and a manifest', `${dl.suggestedFilename()}: ${entries.map((e) => e.name).join(', ')}`);
  check(dat && before.length === 1 && same(Array.from(dat.bytes), before[0].bytes) && dat.method === 0 && dat.name === 'documents/my games/binding of isaac repentance+/persistentgamedata1.dat',
    'the zip carries the store\'s bytes under the save\'s travel name, stored', dat ? `${dat.name}, ${dat.bytes.length} bytes, method ${dat.method}` : 'no .dat in the zip');
  check(metaDoc && metaDoc.format === 'isaac-recomp-saves/1' && metaDoc.slot === 1 && Array.isArray(metaDoc.files) && metaDoc.files.length === 1, 'the manifest names slot 1 and its file', metaDoc ? JSON.stringify(metaDoc.files) : 'no manifest');
  await sleep(600);
  await page.screenshot({ path: join(OUT, 'exported.png') });
  // BACK, walked to by name: round 82 put MODS between DELETE FILE and it, and
  // three Downs landed on that instead -- which opened the mods menu over the top
  // and ate every key after it
  await toRow('BACK');
  await hold('Enter'); await sleep(500);
  check(!(await state()).open, 'BACK closes the menu');
  // --- IMPORT the zip into file 2
  if (!(await openMenuOnFile(1, 'file 2'))) throw new Error('no menu on file 2');
  await toRow('IMPORT FILE');
  const reloadPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 });
  await hold('Enter');
  const chooser = await nextChooser(15000);
  await chooser.setFiles(zipOut);
  check(true, 'IMPORT FILE opens the file chooser and takes the zip');
  await sleep(700);                                          // the page writes the store, then reloads itself 1.5 s on
  const all1 = await storeAll();
  const imported = all1.filter((it) => it.key === keyOf(2));
  check(imported.length === 1 && same(imported[0].bytes, before[0].bytes) && /persistentgamedata2\.dat$/i.test(imported[0].src),
    'the store holds file 1\'s bytes as persistentgamedata2.dat right after the import (key and travel name renumbered)',
    imported.length ? `src ${imported[0].src}, ${imported[0].bytes.length} bytes, ${diff(imported[0].bytes, before[0].bytes)}; entries: ${lookalikes(all1, 2)}` : `no file 2; entries: ${lookalikes(all1, 2)}`);
  await page.screenshot({ path: join(OUT, 'importing.png') }).catch(() => {});
  await reloadPromise;
  await until(async () => (await state()).f > 0, 600000, 'first frame after the reload');
  await sleep(1500);
  const after = await storeAll();
  const slot2 = after.filter((it) => it.key === keyOf(2));
  const slot1 = after.filter((it) => it.key === keyOf(1));
  check(slot2.length === 1 && slot1.length === 1, 'after the reload files 1 and 2 are both in the store',
    `file 2 ${slot2.length ? diff(slot2[0].bytes, before[0].bytes) : 'absent'} against the export; file 1 ${slot1.length ? diff(slot1[0].bytes, before[0].bytes) : 'absent'} against the export; the seed ${diff(before[0].bytes, Array.from(seeded))} against what was seeded; entries: ${lookalikes(after, 1)} | ${lookalikes(after, 2)}`);
  // --- IMPORT a bare .dat into file 3
  const bare = join(OUT, 'persistentgamedata1.dat');
  writeFileSync(bare, Buffer.from(dat.bytes));
  await wayIn();
  if (!(await openMenuOnFile(2, 'file 3'))) throw new Error('no menu on file 3');
  await hold('ArrowDown'); await sleep(200);
  const reload2 = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 });
  await hold('Enter');
  await (await nextChooser(15000)).setFiles(bare);
  await reload2;
  await until(async () => (await state()).f > 0, 600000, 'first frame after the second reload');
  const after2 = await storeAll();
  const slot3 = after2.filter((it) => it.key === keyOf(3));
  check(slot3.length === 1 && same(slot3[0].bytes, before[0].bytes),
    'a bare .dat imports into file 3 under this file\'s key', slot3.length ? `${slot3[0].bytes.length} bytes, ${diff(slot3[0].bytes, before[0].bytes)}; entries: ${lookalikes(after2, 3)}` : `no file 3; entries: ${lookalikes(after2, 3)}`);
  await page.screenshot({ path: join(OUT, 'after.png') });
  const err = consoleLines.find((l) => /PAGEERROR|abort\(|RuntimeError/.test(l));
  check(!err, 'no page error', err || '');
  const menuLog = consoleLines.filter((l) => l.startsWith('[menu]'));
  console.log(`[saves] menu log: ${menuLog.slice(0, 8).join(' | ')}`);
} catch (e) {
  check(false, 'the drive', String(e && e.message || e));
  console.log(`[saves] menu log: ${consoleLines.filter((l) => l.startsWith('[menu]') || l.startsWith('[drive]')).slice(-10).join(' | ')}`);
  try { await page.screenshot({ path: join(OUT, 'failure.png') }); } catch (e2) { /* page gone */ }
}
const ok = checks.every(Boolean);
console.log(`[saves] ${ok ? 'PASS' : 'FAIL'}: ${checks.filter(Boolean).length}/${checks.length} checks`);
await browser.close();
process.exit(ok ? 0 : 1);
