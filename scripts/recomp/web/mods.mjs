// mods.mjs -- mods imported from this device, kept in the browser (round 74),
// with the enabled state owned by the page (round 76).
//
// The game looks for mods in `mods/` beside its executable and scans that
// directory itself (FindFirstFileA/W over the shim's own table,
// host_shims_fs.c). Nothing in that scan cares where the bytes came from, so a
// mod seeded before main is a mod on disk as far as the engine is concerned --
// which is the whole trick here. No patching, no menu surgery.
//
// Four pieces:
//
//   the store    a database of its own, `isaac-mods`. The saves live in
//                `isaac-saves` and the two never touch: importing, removing or
//                resetting mods cannot reach a save file, and a corrupt or
//                half-written mod cannot make the save store unreadable.
//
//   the import   a .zip or a folder. Both are read in the browser: zips through
//                DecompressionStream, folders through the directory picker. The
//                bytes are copied into the store, so deleting the file afterwards
//                changes nothing -- the mod is in the browser now, not on disk.
//                RAR and 7z are named and refused rather than half-read.
//
//   the browser  a catalogue on a CDN, searched and installed from the menu.
//                Nothing is bundled: the page fetches the catalogue when it is
//                opened, and a mod only when it is asked for.
//                scripts/recomp/assets/modpack.py builds both from a folder.
//
//   the button   a mod of our own, `mods/ import mod/`, listed as IMPORT MOD.
//                It shows up in the game's own mods list like any other, and the
//                menu's Enter toggles it -- which writes a `disable.it` into its
//                folder. That write comes back to the page through the FS shim's
//                persist hook, and the page opens this menu instead.
//
//                Round 82: it is seeded only once the player has a mod of their
//                own. A mod loaded is a modded run, and a modded run is one the
//                game will not give achievements for -- so a row that existed to
//                offer an import was quietly costing the unlocks of a player who
//                had installed nothing. With no mods the way in is the EDIT FILE
//                menu's MODS row, which is the page's own and costs nothing.
//
// On enabled and disabled: the engine writes `disable.it` when a mod is toggled
// off in its own list and greys the row, but it does not read that file back at
// the next start -- measured, with the fs layer tracing, under both of the mods
// roots it scans: the listing hands back `main.lua metadata.xml disable.it` and
// the mod loads anyway. So the page keeps the flag itself. A disable.it write
// flips it, an unlink flips it back, and a mod that is off is simply not seeded,
// which the engine cannot argue with.

import { unzip, archiveKind } from './zip.mjs';

export const MODS_DB = 'isaac-mods', F_STORE = 'files', M_STORE = 'mods', S_STORE = 'state';
// The two places the engine looks. `c:/isaac/mods/` is what the resource layer
// mounts and lists; the Documents one is where the mod manager scans.
export const GUEST_ROOT = 'c:/isaac/mods/';       // fs_key() normalises to this
export const USER_ROOT = 'c:/isaac/documents/my games/binding of isaac repentance+/mods/';
export const GUEST_ROOTS = [GUEST_ROOT, USER_ROOT];
export const underMods = (key) => GUEST_ROOTS.find((r) => String(key).startsWith(r)) || null;
// The game's mods list prints the folder name, not the <name> in the metadata,
// so the folder is what has to read right -- and the list is sorted by it, which
// is why the name starts with a space: the import row stays at the top however
// many mods are installed.
export const IMPORT_DIR = ' import mod';
export const IMPORT_MARKS = GUEST_ROOTS.map((r) => `${r}${IMPORT_DIR}/disable.it`);
export const IMPORT_MARK = IMPORT_MARKS[0];
export const isImportMark = (key) => IMPORT_MARKS.includes(String(key));
export const SEED_BUDGET = 96 << 20;              // what the guest arena can spare for mods

// A disable.it under a mods root names the mod it belongs to, or null.
export function disableTarget(key) {
  const root = underMods(key);
  if (!root || isImportMark(key)) return null;
  const rel = String(key).slice(root.length);
  const cut = rel.lastIndexOf('/');
  if (cut < 0 || rel.slice(cut + 1).toLowerCase() !== 'disable.it') return null;
  const id = rel.slice(0, cut);
  return id.includes('/') ? null : id;
}

// The sentinel is a mod with nothing in it but a name. The game lists it, the
// menu selects it, and Enter on it is the import.
export const IMPORT_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <name>IMPORT MOD</name>
  <directory>${IMPORT_DIR}</directory>
  <description>Add a mod from this device, or from the browser.</description>
  <version>1</version>
</metadata>
`;

// ---- the store ---------------------------------------------------------------

// Round 86c: a database can exist at this version WITHOUT the stores in it.
// `indexedDB.open(name)` with no version creates an empty database at version
// 1, and an upgrade that is interrupted can leave one behind too; after that
// `open(name, 1)` sees a current version and never fires onupgradeneeded, so
// the stores are never made and every import fails for the life of the origin
// with "One of the specified object stores was not found" -- with no way out
// but clearing site data. So the stores are checked after opening, and a
// database missing any of them is reopened one version up to create them.
const STORES = [F_STORE, M_STORE, S_STORE];
const makeStores = (db) => {
  for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
};
export function openModDb() {
  // The first open names no version on purpose: it opens whatever is there at
  // whatever version it is at (asking for 1 fails outright on a database that
  // has been repaired to 2), and creates it at version 1 if it is absent. The
  // store check below is what makes that safe.
  const open = (version) => new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(MODS_DB, version) : indexedDB.open(MODS_DB);
    req.onupgradeneeded = () => makeStores(req.result);   // '<id>/<rel>' -> {bytes}, '<id>' -> {...}, fs key -> {bytes}
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    open(0).then((db) => {
      if (STORES.every((s) => db.objectStoreNames.contains(s))) { resolve(db); return; }
      const next = db.version + 1;
      db.close();
      open(next).then(resolve, reject);
    }, reject);
  });
}

const all = (db, store) => new Promise((resolve, reject) => {
  const out = [];
  const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
  req.onsuccess = () => {
    const c = req.result;
    if (!c) { resolve(out); return; }
    out.push({ key: c.key, value: c.value });
    c.continue();
  };
  req.onerror = () => reject(req.error);
});

// a mod written before round 76 has no `enabled`, and an absent flag means on
const withDefaults = (m) => Object.assign({}, m, { enabled: m.enabled !== false });
export const listMods = (db) => all(db, M_STORE).then((r) => r.map((x) => withDefaults(x.value)).sort((a, b) => a.name.localeCompare(b.name)));
export const listModFiles = (db) => all(db, F_STORE);
export const listModState = (db) => all(db, S_STORE);

export const getMod = (db, id) => new Promise((resolve) => {
  try {
    const req = db.transaction(M_STORE, 'readonly').objectStore(M_STORE).get(id);
    req.onsuccess = () => resolve(req.result ? withDefaults(req.result) : null);
    req.onerror = () => resolve(null);
  } catch { resolve(null); }
});

// Importing over a mod that is already there replaces it. The old files go
// first, in the same transaction: a version that dropped a file would otherwise
// leave it behind for the seed to find.
export function putMod(db, mod, files) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([F_STORE, M_STORE], 'readwrite');
    const fs = tx.objectStore(F_STORE), ms = tx.objectStore(M_STORE);
    fs.delete(IDBKeyRange.bound(`${mod.id}/`, `${mod.id}/\uffff`));
    for (const f of files) fs.put({ bytes: f.bytes }, `${mod.id}/${f.name}`);
    ms.put(mod, mod.id);
    tx.oncomplete = () => resolve(mod);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('the mod store refused the write (out of space?)'));
  });
}

// Removing a mod takes its files, its index row and any state the game wrote for
// it. Everything is keyed by the id, so nothing outside it can be caught up.
export function deleteMod(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([F_STORE, M_STORE, S_STORE], 'readwrite');
    tx.objectStore(F_STORE).delete(IDBKeyRange.bound(`${id}/`, `${id}/\uffff`));
    tx.objectStore(M_STORE).delete(id);
    for (const r of GUEST_ROOTS) tx.objectStore(S_STORE).delete(IDBKeyRange.bound(`${r}${id}/`, `${r}${id}/\uffff`));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export function putModState(db, key, bytes) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(S_STORE, 'readwrite');
    if (bytes) tx.objectStore(S_STORE).put({ bytes }, key); else tx.objectStore(S_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// The flag the engine will not keep for us.
export function setModEnabled(db, id, enabled) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(M_STORE, 'readwrite'), st = tx.objectStore(M_STORE);
    const req = st.get(id);
    req.onsuccess = () => {
      const m = req.result;
      if (!m) return;
      m.enabled = !!enabled;
      st.put(m, id);
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ---- what a mod may be called ------------------------------------------------

// A path out of an archive is not to be trusted: `..`, a drive letter or a
// leading slash would all seed outside mods/, and one of those lands on a save.
export function safeRel(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s || s.length > 240) return null;
  if (/^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f:*?"<>|]/.test(seg)) return null;
  }
  return parts.join('/');
}

// The import row's folder, and the id an import would have to produce to collide
// with it. modId() turns a space into a dash, so the second is the one that can
// actually happen; both are refused.
const RESERVED = new Set([IMPORT_DIR, IMPORT_DIR.trim().replace(/\s+/g, '-')]);

export function modId(name) {
  const s = String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s.slice(0, 64) || null;
}

// Archives are packed with the mod folder inside them as often as not, and a mod
// whose metadata.xml sits one level down does not load. Peel single roots off
// until the metadata is at the top, or until there is nothing single about it.
export function stripRoots(entries) {
  let e = entries, peeled = null;
  for (let i = 0; i < 4; i++) {
    if (e.some((x) => x.name.toLowerCase() === 'metadata.xml')) break;
    const roots = new Set(e.map((x) => x.name.split('/')[0] + (x.name.includes('/') ? '' : '\u0000')));
    if (roots.size !== 1) break;
    const root = e[0].name.split('/')[0];
    if (!e.every((x) => x.name.startsWith(root + '/'))) break;
    peeled = root;
    e = e.map((x) => ({ name: x.name.slice(root.length + 1), bytes: x.bytes }));
  }
  return { entries: e, root: peeled };
}

const textOf = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

export function readMetadata(bytes) {
  const text = textOf(bytes);
  const pick = (tag) => {
    const m = new RegExp(`<${tag}\\s*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(text);
    const t = m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    return t && t.length <= 120 ? t : null;
  };
  return { name: pick('name'), directory: pick('directory') };
}

// Entries in, a mod out: the id it will live under, the name the menu shows, and
// the files as they will be seeded. A mod with no metadata.xml gets one, because
// the game skips a folder without it and "nothing happened" is a bad answer.
export function planMod(rawEntries, fallback) {
  const dropped = [];
  const cleaned = [];
  for (const e of rawEntries) {
    const rel = safeRel(e.name);
    if (!rel) { dropped.push(e.name); continue; }
    cleaned.push({ name: rel, bytes: e.bytes });
  }
  if (!cleaned.length) throw new Error('nothing in it that could be a mod file');
  const { entries, root } = stripRoots(cleaned);
  const meta = entries.find((x) => x.name.toLowerCase() === 'metadata.xml');
  const m = meta ? readMetadata(meta.bytes) : { name: null, directory: null };
  const name = m.name || root || fallback || 'mod';
  const id = modId(m.directory) || modId(root) || modId(fallback) || modId(name);
  if (!id) throw new Error('no usable name for this mod');
  if (RESERVED.has(id)) throw new Error(`"${id}" is the name of the import row itself`);
  const files = entries.slice();
  let added = false;
  if (!meta) {
    files.push({ name: 'metadata.xml', bytes: new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <name>${name.replace(/[<>&]/g, '')}</name>\n`
      + `  <directory>${id}</directory>\n  <description>imported</description>\n  <version>1</version>\n</metadata>\n`) });
    added = true;
  }
  const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
  return { mod: { id, name, files: files.length, bytes, added: Date.now(), enabled: true }, files, dropped, madeMetadata: added };
}

// ---- reading what the picker handed over -------------------------------------

// One archive, or a directory's worth of files. A File carries
// webkitRelativePath when it came from the directory picker, which is the only
// way the browser tells us the shape of what was chosen.
// A drop carries either: `webkitGetAsEntry` walks a folder, and a lone file
// comes back as one entry with no slash in its name, which is how the caller
// tells the two apart. A browser without the API answers null and the caller
// falls back to the plain file list.
export async function entriesFromDrop(dt) {
  const items = dt && dt.items ? Array.from(dt.items) : [];
  const roots = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!roots.length) return null;
  const readDir = (dir) => new Promise((res, rej) => {
    const r = dir.createReader(), acc = [];
    const step = () => r.readEntries((batch) => { if (!batch.length) { res(acc); return; } acc.push(...batch); step(); }, rej);
    step();
  });
  const asFile = (e) => new Promise((res, rej) => e.file(res, rej));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await asFile(entry);
      out.push({ name: prefix + entry.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      return;
    }
    for (const child of await readDir(entry)) await walk(child, `${prefix}${entry.name}/`);
  };
  for (const r of roots) await walk(r, '');
  return out;
}

export async function importFrom(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) throw new Error('nothing chosen');
  const dir = files.find((f) => f.webkitRelativePath);
  if (dir || files.length > 1) {
    const entries = [];
    for (const f of files) {
      const rel = f.webkitRelativePath || f.name;
      entries.push({ name: rel, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    const top = (dir && dir.webkitRelativePath.split('/')[0]) || null;
    return { entries, fallback: top };
  }
  const f = files[0];
  return archiveEntries(new Uint8Array(await f.arrayBuffer()), f.name);
}

// One archive, whatever it arrived as.
export async function archiveEntries(bytes, name) {
  const kind = archiveKind(bytes.subarray(0, Math.min(16, bytes.length)));
  if (kind === 'rar' || kind === '7z') {
    throw new Error(`this is a .${kind}, and nothing in a browser can open one. `
      + 'Extract it and drop the folder instead.');
  }
  if (kind !== 'zip') throw new Error('not a zip archive, and not a folder');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { entries: await unzip(buf), fallback: String(name).replace(/\.[^.]+$/, '') };
}

// ---- the browser: a catalogue on a CDN ---------------------------------------

// modpack.py writes `catalogue.json` and the parts beside it. Nothing is in the
// build: the catalogue is fetched when the browser is opened, and a mod's parts
// only when it is asked for.
export async function fetchCatalogue(base) {
  if (!base) throw new Error('no catalogue is configured for this build');
  const r = await fetch(`${String(base).replace(/\/$/, '')}/catalogue.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`the catalogue answered ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.mods)) throw new Error('that is not a catalogue');
  return j;
}

// The parts of one mod, joined back into the zip they were cut from. Each part
// is under jsDelivr's 20 MB ceiling, which is why there is more than one.
export async function fetchMod(base, entry, onProgress) {
  const root = String(base).replace(/\/$/, '');
  const parts = [];
  // Round 82: in bytes, not in parts. A mod that is one 19 MB part reported
  // nothing until it had arrived, which is a menu that looks hung. The body is
  // read as a stream and every chunk moves the number; the total is the size the
  // catalogue already carries, so it is known before the first byte.
  let got = 0;
  const want = entry.bytes || 0;
  for (let i = 0; i < entry.parts; i++) {
    const r = await fetch(`${root}/m/${entry.id}.${i}.bin`);
    if (!r.ok) throw new Error(`part ${i + 1} of ${entry.parts} answered ${r.status}`);
    if (!r.body || !r.body.getReader) {                 // no streams: one lump, one report
      const b = new Uint8Array(await r.arrayBuffer());
      parts.push(b); got += b.length;
      if (onProgress) onProgress(got, want);
      continue;
    }
    const reader = r.body.getReader(), piece = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      piece.push(value); got += value.length;
      if (onProgress) onProgress(got, want);
    }
    const n = piece.reduce((a, p) => a + p.length, 0), one = new Uint8Array(n);
    let at0 = 0;
    for (const p of piece) { one.set(p, at0); at0 += p.length; }
    parts.push(one);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---- seeding, before the game looks ------------------------------------------

// `seed(path, bytes)` is the pipeline's isaac_fs_seed. Every path is built here,
// under a mods root, from an id and a relative name that have both already been
// through safeRel/modId -- so nothing a mod carries can decide where it lands.
// A mod that is off is not seeded at all: the engine will not keep that flag for
// us, so the page keeps it by leaving the mod out.
export async function seedMods(db, seed, log, opts) {
  const o = opts || {};
  const out = { mods: 0, files: 0, bytes: 0, skipped: 0, state: 0, off: 0 };
  const index = db ? await listMods(db) : [];
  const on = index.filter((m) => m.enabled !== false);
  // Round 82: the import row is a mod, and a mod loaded is a modded run -- which
  // turned the achievement indicator on for a player who had installed nothing.
  // It is seeded only once there is a mod of the player's own, by which point the
  // run is modded anyway. With none, the way in is the EDIT FILE menu.
  if (o.sentinel !== false && on.length) {
    const meta = new TextEncoder().encode(IMPORT_METADATA);
    for (const root of GUEST_ROOTS) if (seed(`${root}${IMPORT_DIR}/metadata.xml`, meta)) out.files += 1;
  }
  if (!db) return out;
  const known = new Set(on.map((x) => x.id));
  out.off = index.length - on.length;
  const byId = new Map();
  for (const { key, value } of await listModFiles(db)) {
    const cut = String(key).indexOf('/');
    if (cut <= 0) continue;
    const id = key.slice(0, cut), rel = safeRel(key.slice(cut + 1));
    if (!rel || !known.has(id) || RESERVED.has(id)) { out.skipped += 1; continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ rel, bytes: value.bytes });
  }
  const budget = o.budget == null ? SEED_BUDGET : o.budget;
  for (const mod of on) {
    const files = byId.get(mod.id) || [];
    if (!files.length) continue;
    const size = files.reduce((n, f) => n + f.bytes.length, 0);
    if (out.bytes + size > budget) {
      log && log(`  ${mod.name}: skipped, ${(size / 1048576).toFixed(1)} MB over the ${(budget / 1048576) | 0} MB budget`);
      out.skipped += files.length;
      continue;
    }
    let n = 0;
    for (const f of files) for (const root of GUEST_ROOTS) if (seed(`${root}${mod.id}/${f.rel}`, f.bytes)) n += 1;
    out.mods += 1; out.files += n; out.bytes += size;
    log && log(`  ${mod.name} (${mod.id}): ${n} file(s), ${(size / 1048576).toFixed(2)} MB`);
  }
  // whatever the game wrote under mods/ last time, for a mod that is installed
  // and on. A disable.it is never seeded back: the flag it stands for lives in
  // the index, and a mod that is off is absent rather than marked.
  for (const { key, value } of await listModState(db)) {
    const k = String(key), root = underMods(k);
    if (!root || isImportMark(k) || disableTarget(k)) continue;
    const rel = k.slice(root.length);
    if (!known.has(rel.split('/')[0])) continue;
    for (const r of GUEST_ROOTS) if (seed(r + rel, value.bytes)) out.state += 1;
  }
  return out;
}

// ---- the menu, drawn like the game's own -------------------------------------

const mib = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// opts: { paper, log, catalogueBase, onInstalled() }
// `paper` is createPaperMenu(...) from menu_overlay.mjs: the game's own paper,
// font, cursor and sounds. The two file inputs are the only DOM here, because a
// file picker cannot be opened from a canvas.
export function createModsMenu(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const paper = o.paper;
  let db = null, mods = [], catalogue = null, message = null, dirty = false, busy = false;
  let progress = null, busyId = null;        // per cent of the mod being downloaded, and which
  let view = 'installed';                      // or 'browse'
  let search = '';

  const hiddenInput = (id, setup) => {
    const el = document.createElement('input');
    el.type = 'file'; el.id = id; el.hidden = true;
    setup(el);
    document.body.appendChild(el);
    return el;
  };
  const fileInput = hiddenInput('mods-file', (el) => { el.accept = '.zip,application/zip'; });
  const dirInput = hiddenInput('mods-folder', (el) => {
    el.setAttribute('webkitdirectory', ''); el.setAttribute('directory', ''); el.multiple = true;
  });

  const say = (text, changed) => {
    message = text ? String(text).toUpperCase().slice(0, 64) : null;
    if (changed) dirty = true;
    log(`[mods] ${text}`);
    paper.redraw();
  };

  async function refresh() {
    try { db = db || await openModDb(); mods = db ? await listMods(db) : []; }
    catch (e) { mods = []; say(`the mod store is unavailable: ${e.message}`); }
  }

  async function install(entries, fallback) {
    const { mod, files, dropped, madeMetadata } = planMod(entries, fallback);
    if (mod.bytes > SEED_BUDGET) {
      throw new Error(`${mod.name} is ${mib(mod.bytes)}; the game is given ${mib(SEED_BUDGET)} for mods`);
    }
    db = db || await openModDb();
    if (!db) throw new Error('this browser keeps no database, so a mod could not be kept');
    const already = await getMod(db, mod.id);
    if (already) throw new Error(`${already.name} is already installed`);
    await putMod(db, mod, files);
    const notes = [];
    if (madeMetadata) notes.push('metadata written');
    if (dropped.length) notes.push(`${dropped.length} path(s) dropped`);
    await refresh();
    if (mods.reduce((n, x) => n + x.bytes, 0) > SEED_BUDGET) notes.push(`over the ${mib(SEED_BUDGET)} budget`);
    // Round 82: installing a mod is choosing to have mods on. A page that ran
    // before round 81 wrote EnableMods=0 and kept it, so the mod was seeded, the
    // engine listed it, and nothing happened -- the quietest failure there is.
    if (o.onInstalled) { try { await o.onInstalled(); } catch (e) { log(`[mods] the options: ${e.message}`); } }
    say(`${mod.name}: ${files.length} file(s)${notes.length ? ', ' + notes.join(', ') : ''}`, true);
  }

  async function take(input) {
    if (busy) return;
    busy = true;
    try {
      say('reading...');
      const { entries, fallback } = await importFrom(input.files);
      await install(entries, fallback);
    } catch (e) { say(`import failed: ${e.message}`); }
    input.value = '';
    busy = false;
  }

  // A folder or an archive dropped on the window, which is the one way in that
  // takes either -- the two pickers cannot.
  async function drop(dt) {
    if (busy) return;
    busy = true;
    try {
      say('reading...');
      let entries = await entriesFromDrop(dt);
      if (!entries) { const r = await importFrom(dt.files); entries = r.entries; await install(entries, r.fallback); return; }
      if (!entries.length) throw new Error('nothing in what was dropped');
      if (entries.length === 1 && !entries[0].name.includes('/')) {
        const one = entries[0];
        const r = await archiveEntries(one.bytes, one.name);
        await install(r.entries, r.fallback);
        return;
      }
      const top = entries[0].name.split('/')[0];
      await install(entries, entries.every((e) => e.name.startsWith(`${top}/`)) ? top : null);
    } catch (e) { say(`import failed: ${e.message}`); }
    busy = false;
  }

  async function toggle(mod) {
    if (busy) return;
    busy = true;
    try {
      await setModEnabled(db, mod.id, !mod.enabled);
      await refresh();
      say(`${mod.name} ${mod.enabled ? 'off' : 'on'}`, true);
    } catch (e) { say(`could not change ${mod.name}: ${e.message}`); }
    busy = false;
  }

  async function remove(mod) {
    if (busy) return;
    busy = true;
    try { await deleteMod(db, mod.id); await refresh(); say(`${mod.name} removed`, true); }
    catch (e) { say(`could not remove ${mod.name}: ${e.message}`); }
    busy = false;
  }

  async function openBrowse() {
    view = 'browse'; search = ''; message = null;
    paper.redraw();
    if (catalogue) return;
    try {
      say('fetching the catalogue...');
      catalogue = await fetchCatalogue(o.catalogueBase);
      say(`${catalogue.mods.length} mod(s) to choose from`);
    } catch (e) { say(`catalogue: ${e.message}`); }
  }

  async function add(entry) {
    if (busy) return;
    busy = true;
    try {
      db = db || await openModDb();
      if (db && await getMod(db, entry.id)) throw new Error('already installed');
      // the row carries the percentage while it downloads, the line says what for
      busyId = entry.id;
      progress = 0;
      message = 'DOWNLOADING...';
      paper.redraw();
      const zip = await fetchMod(o.catalogueBase, entry, (n, total) => {
        const pct = total ? Math.min(100, Math.round(100 * n / total)) : 0;
        if (pct === progress) return;                    // a redraw a frame is plenty
        progress = pct;
        paper.redraw();
      });
      progress = null;
      busyId = null;
      message = 'UNPACKING...';
      paper.redraw();
      await install(await unzip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)), entry.name);
    } catch (e) { say(`${entry.name}: ${e.message}`); }
    busy = false;
  }

  // ---- what the paper shows
  function model() {
    if (view === 'browse') {
      const have = new Set(mods.map((m) => m.id));
      const q = search.trim().toLowerCase();
      const list = ((catalogue && catalogue.mods) || []).filter((m) =>
        !q || m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
      const rows = list.map((m) => ({
        label: m.name,
        note: busyId === m.id && progress != null ? `${progress}%`
          : have.has(m.id) ? 'INSTALLED' : (m.bytes > SEED_BUDGET ? 'TOO BIG' : mib(m.bytes)),
        dim: have.has(m.id) || m.bytes > SEED_BUDGET,
        action: () => (have.has(m.id) ? say(`${m.name} is already installed`) : add(m)),
      }));
      rows.push({ label: 'BACK', action: () => { view = 'installed'; search = ''; message = null; paper.redraw(); } });
      return { title: 'MOD BROWSER', rows, search, searchHint: 'TYPE TO SEARCH', message };
    }
    // Round 84: what is installed belongs on the game's own mods screen, which
    // lists it, greys it and toggles it already. This menu is what that screen
    // cannot do: bring a mod in, and take one out again.
    if (view === 'remove') {
      const rows = mods.map((m) => ({
        label: m.name,
        note: mib(m.bytes),
        action: () => remove(m),
        remove: () => remove(m),
      }));
      rows.push({ label: 'BACK', action: () => { view = 'installed'; message = null; paper.redraw(); } });
      return { title: 'REMOVE MOD', rows, message: message || (mods.length ? null : 'NO MODS') };
    }
    const rows = [];
    rows.push({ label: 'IMPORT MOD', action: () => fileInput.click() });
    if (o.catalogueBase) rows.push({ label: 'MOD BROWSER', action: () => openBrowse() });
    if (mods.length) rows.push({ label: 'REMOVE MOD', action: () => { view = 'remove'; message = null; paper.redraw(); } });
    rows.push({ label: 'BACK', action: () => paper.close('back') });
    return { title: 'MODS', rows, message: message || 'OR DROP A FOLDER OR .ZIP HERE' };
  }

  fileInput.addEventListener('change', () => take(fileInput));
  dirInput.addEventListener('change', () => take(dirInput));
  // the window takes a drop while the menu is up, and only then: the game has the
  // page to itself otherwise
  const overDrop = (ev) => { if (paper.isOpen()) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } };
  window.addEventListener('dragover', overDrop);
  window.addEventListener('drop', (ev) => {
    if (!paper.isOpen()) return;
    ev.preventDefault();
    drop(ev.dataTransfer);
  });

  // The engine scans mods/ once, before main. So a mod that arrived during this
  // visit is in the page's store and not in the game's list, and the only way
  // into that list is another boot: closing the menu after an import reloads.
  // R still does it early, for anyone who wants it before closing.
  const reloadIfNew = () => { if (dirty) location.reload(); };

  const open = async () => {
    view = 'installed'; search = ''; message = null;
    await refresh();
    await paper.open(model, {
      onClose: reloadIfNew,
      onKey: (code, key) => {
        if (code === 'KeyR' && dirty) { location.reload(); return true; }
        if (view === 'browse') {
          if (code === 'Backspace') { search = search.slice(0, -1); paper.redraw(); return true; }
          if (key && key.length === 1 && /[ -~]/.test(key)) { search += key; paper.redraw(); return true; }
        }
        // X and not Delete: the page is handed the keys the input shim forwards,
        // and Delete is not one of them, so a row bound to it never went
        if (code === 'KeyX' && view === 'remove') {
          const row = paper.currentRow();
          if (row && row.remove) { row.remove(); return true; }
        }
        return false;
      },
    });
  };
  return {
    open, close: () => paper.close('back'), isOpen: () => paper.isOpen(), refresh,
    onKey: (ev, down) => paper.onKey(ev, down), element: () => paper.element(),
    // What a driver can see: the same model the paper draws, flattened. Rows are
    // labels rather than the rows themselves, so nothing outside can call an
    // action -- a driver has to press the key a player would.
    state: () => {
      const m = model();
      return { view, dirty, message, search, title: m.title, rows: m.rows.map((r) => r.label),
               current: (paper.currentRow() || {}).label || null,
               mods: mods.map((x) => ({ id: x.id, name: x.name, enabled: x.enabled })) };
    },
  };
}
