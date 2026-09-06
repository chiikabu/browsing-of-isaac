// Round 31: saves persist.
//
// The RAM-FS lived for one process: every persistentgamedata*.dat the game
// wrote on a game over was gone at the next boot. The FS shim now hands a
// written file to the host when it is closed (Module.isaacPersist) and
// announces a delete (Module.isaacUnlink); the node driver writes them
// under ISAAC_SAVE_DIR and seeds them back, the browser page keeps them in
// IndexedDB. These pins keep the three parts agreeing; the selftest holds
// the C contract (fclose hands the bytes and the key; DeleteFileA unlinks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (...p) => readFileSync(join(root, ...p), 'utf8');

test('the FS shim persists on fclose of a written file and unlinks on delete, through host hooks or Module callbacks', () => {
  const c = rd('scripts', 'recomp', 'host', 'src', 'host_shims_fs.c');
  assert.ok(c.includes('if (g_file_w[fi]) fs_persist(fs_file_entry(fi));'), 'fclose hands the written entry to the store');
  assert.ok(c.includes('Module.isaacPersist(k, s, data, len)'), 'the browser/node callback carries key, seed path, bytes');
  assert.ok(c.includes('Module.isaacUnlink(k, s)'), 'and deletes are announced');
  assert.equal((c.match(/fs_unpersist\(e\);/g) || []).length, 2, 'remove() and DeleteFileA both announce');
  assert.ok(c.includes('if (!e || e->is_dir || e->windowed) return;'), 'directories and windowed archives never persist');
  assert.ok(c.includes('void isaac_fs_set_persist_hooks(isaac_fs_persist_fn p, isaac_fs_unlink_fn u)'), 'the selftest hooks');
});

test('the selftest covers the contract', () => {
  const s = rd('scripts', 'recomp', 'host', 'selftest.c');
  for (const what of ['fclose hands the written bytes to the persist hook', 'with the file\'s key',
    'DeleteFileA reaches the unlink hook', 'nothing reaches the host before the close']) {
    assert.ok(s.includes(what), what);
  }
  const report = join(root, 'output', 'recomp', 'host', 'build-selftest.json');
  if (existsSync(report)) {
    const j = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(j.failures ?? j.run?.failures ?? 0, 0, 'the last selftest run had no failures');
  }
});

test('one display adapter, monitor and mode are enumerated, so GLFW has a primary monitor for a re-read options.ini', () => {
  // the second load of a persisted profile aborted in the game's VSync
  // setter (0x00925ce0): glfwGetPrimaryMonitor() was NULL because
  // EnumDisplayDevicesW enumerated nothing
  const w = rd('scripts', 'recomp', 'host', 'src', 'host_shims_win.c');
  assert.ok(w.includes('#define ISAAC_ADAPTER_NAME "\\\\\\\\.\\\\DISPLAY1"'), 'the adapter name GLFW keys its monitor by');
  assert.ok(w.includes("put_wstr(out + 4, adapter ? ISAAC_ADAPTER_NAME : ISAAC_MONITOR_NAME, 32);"), 'adapters then monitors, one each');
  assert.ok(w.includes('isaac_w32(dm + 184, 60);            /* dmDisplayFrequency */'), 'a 60 Hz mode');
  assert.ok(w.includes('if (!(mode == 0 || mode == 0xFFFFFFFFu || mode == 0xFFFFFFFEu)'), 'mode 0, ENUM_CURRENT_SETTINGS and ENUM_REGISTRY_SETTINGS answer; nothing else');
  const s = rd('scripts', 'recomp', 'host', 'selftest.c');
  for (const what of ['adapter 0 is a primary display device named \\\\\\\\.\\\\DISPLAY1', 'the adapter has one active monitor',
    'ENUM_CURRENT_SETTINGS is the 1280x720 32-bit 60 Hz mode', 'and mode 1 does not exist']) {
    assert.ok(s.includes(what), what);
  }
});

test('the node driver keeps saves under ISAAC_SAVE_DIR, without the fake cwd root, and seeds them back after the tree', () => {
  const d = rd('scripts', 'recomp', 'lift', 'boot_integration.mjs');
  assert.ok(d.includes("const SAVE_STORE = process.env.ISAAC_SAVE_DIR ?"), 'ISAAC_SAVE_DIR selects the store; unset writes nothing');
  assert.ok(d.includes("const storeRel = (key, src) => src || key.replace(/^c:\\/isaac\\//, '');"),
    'a game-created file drops the c:/isaac/ root the host answers USERPROFILE with; a seeded file keeps its seed path');
  assert.ok(d.includes('m.isaacPersist = (key, src, ptr, len) => {') && d.includes('writeFileSync(abs, m.HEAPU8.subarray(ptr, ptr + len));'),
    'the persist callback writes the guest bytes');
  assert.ok(d.includes('m.isaacUnlink = (key, src) => {'), 'the unlink callback');
  const seed = d.indexOf("stageOk('seed extracted instance tree'");
  const restore = d.indexOf("stageOk('restore saves'");
  const main = d.indexOf("stageOk('main @ 0x00931050'");
  assert.ok(seed > 0 && restore > seed && main > restore, 'restored after the instance tree, before main');
  assert.ok(d.includes("else if (seedFile(r, readFileSync(p))) { n += 1;"), 'restored files are seeded eagerly (they are small)');
});

test('the browser page keeps saves in IndexedDB and restores them before main', () => {
  const w = rd('scripts', 'recomp', 'web', 'boot_web.mjs');
  assert.ok(w.includes("const persistOn = params.get('persist') !== '0';"), 'persist=0 turns the store off');
  assert.ok(w.includes('cfg.isaacPersist = (key, src, ptr, len) => {'), 'the persist callback');
  assert.ok(w.includes('const bytes = m.HEAPU8.slice(ptr, ptr + len);'), 'copies the bytes out of the guest heap');
  assert.ok(w.includes('cfg.isaacUnlink = (key, src) => {'), 'the unlink callback');
  assert.ok(w.includes("st.put({ src: p.src, bytes: p.bytes }, p.key); else st.delete(p.key);"), 'keyed by the FS key');
  const seed = w.indexOf("await stageOk('register instance tree lazily'");
  const restore = w.indexOf("await stageOk('restore saves'");
  const main = w.indexOf('_isaac_run_main');
  assert.ok(seed > 0 && restore > seed && main > restore, 'restored after the instance tree, before main');
  assert.ok(w.includes('const rel = src || key;'), 'a save is seeded under its seed path, else its key');
});
