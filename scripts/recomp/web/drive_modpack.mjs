// drive_modpack.mjs -- every mod in the catalogue, installed the way a player
// installs one, then played:
//   node scripts/recomp/web/drive_modpack.mjs http://127.0.0.1:8200/play.html <out-dir>
//        [catalogue=.scratch/mod-catalogue] [seconds=8] [only=id,id] [gl=hw]
//
// Round 86c. Rounds 85 and 86b each found a reason mods did not work, and each
// was verified with ONE mod. One mod is a sample of one: 85 found that no mod
// path ever resolved, 86b that a mod reached a function nothing had ever
// lifted, and neither would have been caught by testing the other mod. So this
// walks the whole catalogue.
//
// Per mod, in its own browser context so nothing carries over:
//   install through the page's own file input -> reload -> boot -> press Enter
//   until the engine's log says a run started -> walk and fire for `seconds`,
//   sampling the host's frame counter every second.
//
// A mod passes only if the ENGINE says so, not the page: its content directory
// appears in the engine's own LOADED MOD line, its main.lua (when it ships one)
// appears in the engine's own Running Lua Script line, no [odsa] [ERROR] names
// it, nothing trapped, and the run started. A baseline run with no mod at all
// gives the frame rate the mods are compared against -- a mod that loads and
// halves the frame rate has not "worked".
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [URL, OUT, ...rest] = process.argv.slice(2);
if (!URL || !OUT) {
  console.log('usage: node drive_modpack.mjs <url> <out-dir> [catalogue=DIR] [seconds=8] [only=a,b] [gl=hw]');
  process.exit(2);
}
const opt = Object.fromEntries(rest.map((a) => a.split('=')));
const CAT = opt.catalogue || '.scratch/mod-catalogue';
const SECONDS = Number(opt.seconds || 8);
const ONLY = opt.only ? new Set(opt.only.split(',')) : null;
// trace=1 boots with ISAAC_FS_TRACE=1 so the FS shim names every path it is
// asked for. That is the evidence that a mod's own FILES are being read --
// loading a mod and reading nothing out of it are not the same thing -- but it
// costs boot time and floods the console, so the frame rate is not measured on
// a traced run. Two passes, each answering the question it can answer.
const TRACE = opt.trace === '1';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ---- the catalogue, as modpack.py wrote it: a zip split into <id>.<n>.bin
const cat = JSON.parse(readFileSync(join(CAT, 'catalogue.json'), 'utf8'));
const mods = (cat.mods || cat).filter((m) => !ONLY || ONLY.has(m.id));
const zipOf = (m) => {
  const parts = [];
  for (let i = 0; i < (m.parts || 1); i++) parts.push(readFileSync(join(CAT, 'm', `${m.id}.${i}.bin`)));
  return Buffer.concat(parts);
};
// the central directory is the only honest list of what a zip holds
const zipNames = (buf) => {
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const n = buf.readUInt16LE(i + 28);
    names.push(buf.toString('utf8', i + 46, i + 46 + n));
    i += 45;
  }
  return names;
};

// Some mods replace the art of one thing, and that art is only ever read when
// that thing is on screen -- so a starting room proves nothing about them. The
// engine's own debug console can put the thing there. These are the entities
// each of those mods draws over, taken from the file names in the mod itself.
// The variant numbers are the ones in the mod's own file names -- slot_004 is
// SLOT variant 4, and so on -- not guesses: a wrong one spawns something else
// and the mod's file is never asked for, which reads exactly like a mod that
// does not work.
const SUMMON = {
  'pleading-beggars':     ['spawn 6.4', 'spawn 6.5'],            // slot_004_beggar, slot_005_devil_beggar
  accuratedevilbeggars:   ['spawn 6.5', 'spawn 6.15'],           // devil beggar, hell game (slot 15)
  'neko-stoney':          ['spawn 302'],                         // monster_302_stoney
  'neko-hush':            ['spawn 407'],                         // boss_hush
  'very-haunted-chests':  ['spawn 5.58'],                        // haunted chest is pickup variant 58
};

const glArgs = (opt.gl || 'hw') === 'hw'
  ? ['--use-angle=default', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader'];
const browser = await chromium.launch({
  headless: true,
  args: [...glArgs, '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync'],
});

// ---- one run: install `mod` (or nothing, for the baseline) and play
async function run(mod) {
  const id = mod ? mod.id : '(no mods)';
  const r = { id, name: mod ? mod.name : 'baseline', ok: false, why: [], fps: [], medianFps: null, modDir: null,
              loaded: null, lua: null, hasLua: false, errors: [], startedAfter: null, ms: 0,
              filesAsked: null, filesRead: null, filesReadSample: [] };
  const t0 = Date.now();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // breakdb=1 poisons the origin the way this driver's first version did, before
  // any page script runs: a versionless open creates isaac-mods EMPTY at version
  // 1, so the page's own open(name, 1) never fires onupgradeneeded and its
  // stores are never made. Before round 86c that was permanent -- every import
  // failed with "One of the specified object stores was not found" for the life
  // of the origin. With the self-heal, the import below has to succeed anyway.
  if (opt.breakdb === '1') {
    await context.addInitScript(() => {
      try { indexedDB.open('isaac-mods'); indexedDB.open('isaac-saves'); } catch (e) { /* nothing to do */ }
    });
  }
  const page = await context.newPage();
  // cpu=N throttles the CPU N-fold (the same lever drive_perf.mjs pulls). At
  // full speed the game sits on its 60 fps cap with headroom to spare, so a mod
  // can cost real time and change nothing measurable; under a throttle the cap
  // is gone and the cost shows up.
  if (Number(opt.cpu || 1) > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(opt.cpu) });
  }
  const console_ = [];
  page.on('console', (m) => console_.push(m.text()));
  page.on('pageerror', (e) => { console_.push('PAGEERROR ' + e); r.errors.push('page error: ' + String(e).slice(0, 160)); });

  const state = () => page.evaluate(() => ({ f: window.isaacFrame || 0, done: window.isaacDone }))
    .catch(() => ({ f: 0, done: null }));
  const logMatch = (re) => page.evaluate((src) => {
    const rx = new RegExp(src), log = window.isaacLog || [];
    for (let i = log.length - 1; i >= 0; i--) {
      const s = String(log[i]);
      const m = rx.exec(s);
      if (m) return m[0].slice(0, 200);
    }
    return null;
  }, re.source).catch(() => null);

  try {
    const url = TRACE ? URL + (URL.includes('?') ? '&' : '?') + 'ISAAC_FS_TRACE=1' : URL;
    // options=<ini> goes into the save store before the engine reads it. A
    // fresh origin has no options.ini, so the engine writes defaults -- and the
    // debug console is off in those, which is why the summons below need this.
    // It has to be seeded on a page that is NOT the game: on the game page an
    // engine is already booting, and it persists its own options over this one.
    if (opt.options) {
      const arr = [...readFileSync(opt.options)];
      await page.goto(new globalThis.URL(URL).origin + '/instance_index.json', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const seeded = await page.evaluate((bytes) => new Promise((res) => {
        const open = (v) => { const q = v ? indexedDB.open('isaac-saves', v) : indexedDB.open('isaac-saves'); q.onupgradeneeded = () => { const d = q.result; if (!d.objectStoreNames.contains('files')) d.createObjectStore('files'); }; return q; };
        const q = open(0);
        q.onsuccess = () => {
          const db = q.result;
          const put = (d) => {
            const tx = d.transaction('files', 'readwrite');
            tx.objectStore('files').put({ src: null, bytes: new Uint8Array(bytes) },
              'c:/isaac/documents/my games/binding of isaac repentance+/options.ini');
            tx.oncomplete = () => res('ok');
            tx.onerror = () => res(String(tx.error));
          };
          if (db.objectStoreNames.contains('files')) return put(db);
          const n = db.version + 1; db.close();
          const q2 = open(n); q2.onsuccess = () => put(q2.result); q2.onerror = () => res(String(q2.error));
        };
        q.onerror = () => res(String(q.error));
      }), arr).catch((e) => e.message);
      if (seeded !== 'ok') r.errors.push('options.ini: ' + seeded);
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (mod) {
      // the page's own import path -- the same input the picker fills. It is
      // wired when mods.mjs loads, long before the engine boots, so this costs
      // no extra boot.
      await page.waitForSelector('#mods-file', { state: 'attached', timeout: 120000 });
      const buf = zipOf(mod);
      r.hasLua = zipNames(buf).some((n) => /(^|\/)main\.lua$/i.test(n));
      await page.setInputFiles('#mods-file', { name: `${mod.id}.zip`, mimeType: 'application/zip', buffer: buf });
      // The page's own report is the witness, not the database. Reading
      // IndexedDB from here is not free: `indexedDB.open(name)` with no version
      // CREATES an empty database if none exists, and the page's own open then
      // never fires onupgradeneeded, so its stores never get made and every
      // import after that fails with "One of the specified object stores was
      // not found". The first version of this driver did exactly that and broke
      // the thing it was measuring.
      const said = await (async () => {
        const deadline = Date.now() + 180000;
        for (;;) {
          const line = console_.find((l) => /^\[mods\] .*: \d+ file\(s\)$/.test(l) || /^\[mods\] import failed:/.test(l));
          if (line) return line;
          if (Date.now() > deadline) return null;
          await sleep(300);
        }
      })();
      if (!said) throw new Error('the page never finished the import');
      if (/import failed/.test(said)) throw new Error(said.replace('[mods] ', ''));
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    // boot
    for (;;) {
      const s = await state();
      if (s.f > 0) break;
      if (s.done && s.done.error) throw new Error('module: ' + s.done.error);
      if (Date.now() - t0 > 600000) throw new Error('timeout before the first frame');
      await sleep(300);
    }
    // Enter until the engine's own log says a run started
    const startRe = /Room 1\.2\(Start Room\)|Starting room transition/;
    let enters = 0;
    for (;;) {
      if (await logMatch(startRe)) { r.startedAfter = enters; break; }
      if (enters >= 40 || Date.now() - t0 > 600000) throw new Error(`no run after ${enters} Enter(s)`);
      await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter');
      enters += 1; await sleep(1500);
    }
    // put the thing this mod redraws on the screen, through the game's own
    // console -- opened the way a player opens it
    // A key held for less than a frame is a key the engine never sees: it polls
    // input once per tick, so down-then-up in the same tick is nothing at all.
    const hold = async (k, ms = 120) => { await page.keyboard.down(k); await sleep(ms); await page.keyboard.up(k); };
    const typeSlow = async (text) => {
      for (const ch of text) {
        const k = ch === ' ' ? 'Space' : ch;
        await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); await sleep(40);
      }
    };
    const summon = (mod && SUMMON[mod.id]) || [];
    if (summon.length) {
      await hold('Backquote'); await sleep(900);          // the console stays open for all of them
      for (const cmd of summon) {
        await typeSlow(cmd); await sleep(250);
        await hold('Enter'); await sleep(1800);
        r.summoned = (r.summoned || []).concat(cmd);
      }
      await hold('Backquote'); await sleep(2500);
    }
    // play: walk in a square and fire, one fps sample a second
    const walk = ['KeyD', 'KeyS', 'KeyA', 'KeyW'], fire = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
    let last = (await state()).f, lastT = Date.now();
    for (let i = 0; i < SECONDS; i++) {
      await page.keyboard.down(walk[i % 4]); await page.keyboard.down(fire[i % 4]);
      await sleep(1000);
      await page.keyboard.up(walk[i % 4]); await page.keyboard.up(fire[i % 4]);
      const s = await state();
      r.fps.push(Number(((s.f - last) * 1000 / (Date.now() - lastT)).toFixed(1)));
      last = s.f; lastT = Date.now();
      if (s.done) { r.errors.push('the module ended during play'); break; }
    }
    r.medianFps = median(r.fps);

    // ---- what the ENGINE says, which is the only witness that counts
    if (mod) {
      // The engine names the directory it loaded, and that name is the mod's
      // own (out of its metadata), not the catalogue's file name. " import mod"
      // is the row the pipeline seeds, so it is not the one under test.
      const dirs = await page.evaluate(() => {
        const out = new Set();
        for (const l of window.isaacLog || []) {
          const re = /LOADED MOD \/*mods\/([^/,\n]+)\//g;
          let m;
          while ((m = re.exec(String(l)))) out.add(m[1]);
        }
        return [...out];
      }).catch(() => []);
      r.modDir = dirs.find((d) => !/^\s*import mod\s*$/i.test(d)) || null;
      r.loaded = r.modDir ? `LOADED MOD //mods/${r.modDir}/` : null;
      if (r.modDir) r.lua = await logMatch(new RegExp(`Running Lua Script: [^,\\n]*${r.modDir}[^,\\n]*`));
      if (!r.loaded) r.why.push('the engine never listed it');
      if (r.hasLua && !r.lua) r.why.push('it ships a main.lua the engine never ran');
      if (TRACE && r.modDir) {
        // every path the FS shim was asked for that belongs to this mod, and
        // the ones it actually answered with bytes
        const asked = new Set(), hit = new Set();
        // up to the closing quote, not to the first space: this game has real
        // paths like `resources-dlc3/gfx/items/pick ups/haunted_chest.png`
        const re = new RegExp(`mods/${r.modDir.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/([^'"]+)`);
        for (const l of console_) {
          if (!/\[isaac\]\[fs\]/.test(l)) continue;
          const m = re.exec(l);
          if (!m) continue;
          asked.add(m[1]);
          if (/->\s*hit|\bhit\b/.test(l)) hit.add(m[1]);
        }
        r.filesAsked = asked.size;
        r.filesRead = hit.size;
        r.filesReadSample = [...hit].slice(0, 5);
        if (!hit.size) r.why.push('the engine read none of its files');
      }
    }
    const trap = await logMatch(/unresolved indirect call|TRAP in main|is not implemented|Program terminated with exit/);
    if (trap) r.why.push('trapped: ' + trap);
    const luaErr = await logMatch(new RegExp(`ERROR[^,\\n]*(${r.modDir || 'mods/'}|\\.lua)[^,\\n]*`));
    if (luaErr) r.errors.push(luaErr);
    if (r.startedAfter === null) r.why.push('no run started');
    if (!r.fps.length) r.why.push('no frames sampled');
    r.ok = !r.why.length;
  } catch (e) {
    r.why.push(e.message);
  }
  r.ms = Date.now() - t0;
  writeFileSync(join(OUT, `${mod ? mod.id : 'baseline'}.console.log`), console_.join('\n'));
  await context.close();
  return r;
}

const results = [];
const base = await run(null);
results.push(base);
console.log(`[pack] baseline: run after ${base.startedAfter} Enter(s), fps median ${base.medianFps} (${base.fps.join(' ')})`);
if (!base.ok) console.log(`[pack] BASELINE FAILED: ${base.why.join('; ')}`);

// a mod that loads and halves the frame rate has not worked
const floorFps = base.medianFps ? base.medianFps * 0.7 : 0;
for (let i = 0; i < mods.length; i++) {
  const m = mods[i];
  const r = await run(m);
  if (r.ok && r.medianFps !== null && r.medianFps < floorFps) {
    r.ok = false;
    r.why.push(`frame rate ${r.medianFps} against a ${base.medianFps} baseline`);
  }
  results.push(r);
  const tag = r.ok ? 'ok  ' : 'FAIL';
  console.log(`[pack] ${tag} ${String(i + 1).padStart(2)}/${mods.length} ${r.id.padEnd(30)} `
    + `fps ${String(r.medianFps).padStart(5)}  ${r.lua ? 'lua' : (r.hasLua ? 'NO LUA' : '---')}  `
    + `${r.loaded ? 'loaded' : 'NOT LOADED'}`
    + `${r.filesRead === null ? '' : `  ${String(r.filesRead).padStart(3)} file(s) read`}  ${(r.ms / 1000).toFixed(0)}s`
    + (r.why.length ? `  <- ${r.why.join('; ')}` : '')
    + (r.errors.length ? `  [${r.errors.length} error line(s)]` : ''));
}

const pass = results.filter((r) => r.ok).length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
  url: URL, seconds: SECONDS, baselineFps: base.medianFps, floorFps, results,
}, null, 2));
console.log(`[pack] ${pass}/${results.length} passed (baseline + ${mods.length} mods), `
  + `fps baseline ${base.medianFps}, mods ${median(results.slice(1).map((r) => r.medianFps).filter((v) => v !== null))}`);
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`[pack] FAILED ${r.id}: ${r.why.join('; ')}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
