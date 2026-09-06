// Boot the lifted module: place the memory image, run the host boot path,
// then call main. Every stage is reported separately so a failure names
// the stage it happened in.
import { readFileSync, readdirSync, statSync, openSync, readSync, existsSync } from 'node:fs';
// Round 30: the key table, the explorer and the console driver share one
// module; the debug profile runs COPIES of both files from the boot dir.
import { KEYS, makeExplorer, makeConsole, consoleSeedFiles, SAVE_DIR } from './explore.mjs';
import { makeTypedConsole } from './console_typing.mjs';

// ISAAC_V8_FLAGS: V8 flags for this run, re-exec'd onto the command line
// because node refuses them in NODE_OPTIONS ("--no-wasm-tier-up is not
// allowed in NODE_OPTIONS") and v8.setFlagsFromString is read too late for
// the wasm compiler. Round 15a: `ISAAC_V8_FLAGS=--no-wasm-tier-up` cuts the
// room-entry crawl from 4436 s to 107 s (recomp-architecture.md §21.28).
if (process.env.ISAAC_V8_FLAGS && !process.env.ISAAC_V8_FLAGS_APPLIED) {
  const { spawnSync } = await import('node:child_process');
  const flags = process.env.ISAAC_V8_FLAGS.trim().split(/\s+/).filter(Boolean);
  const r = spawnSync(process.execPath, [...flags, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, ISAAC_V8_FLAGS_APPLIED: '1' },
  });
  process.exit(r.status === null ? 1 : r.status);
}

const Module = (await import('./boot.mjs')).default;

const segsPath = process.argv[2] || 'output/recomp/host/isaac.segs.bin';
const stage = process.argv[3] || 'main';   // layout | boot | main

Error.stackTraceLimit = 400;   // a V8 RangeError's trace names the wasm frames: a recursion cycle is in there
const m = await Module();

function stageOk(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    const r = fn();
    return r;
  } catch (e) {
    console.log(`  TRAP in ${name}: ${e.message}`);
    try { if (typeof m._isaac_dump_va_ring === 'function') m._isaac_dump_va_ring(); } catch (e2) { /* best effort */ }
    const lines = String(e.stack || '').split('\n').slice(1);
    if (e instanceof RangeError || /call stack/i.test(String(e.message))) {
      // the whole trace, runs of the same frame collapsed: a cycle reads as a pattern
      let last = null, run = 0;
      const out = [];
      for (const l of lines) {
        const fr = l.trim().replace(/\s+\(.*$/, '');
        if (fr === last) { run += 1; continue; }
        if (last !== null) out.push(run > 1 ? `${last} x${run}` : last);
        last = fr; run = 1;
      }
      if (last !== null) out.push(run > 1 ? `${last} x${run}` : last);
      console.log(`  stack (${lines.length} frames, runs collapsed):`);
      for (const l of out.slice(0, 120)) console.log(`    ${l}`);
    } else {
      const st = lines.slice(0, 3).join('\n');
      if (st) console.log(st);
    }
    return null;
  }
}

// --- place the memory image -------------------------------------------
const blob = readFileSync(segsPath);
const p = m._malloc(blob.length);
m.HEAPU8.set(blob, p);
const nseg = stageOk('place memory image', () => m._isaac_place_image(p, blob.length));
console.log(`  isaac.segs.bin ${blob.length} bytes -> ${nseg} segments`);
if (nseg === null || nseg < 0) { console.log('RESULT: image placement failed'); process.exit(2); }
m._free(p);

// --- layout agreement --------------------------------------------------
const layoutBad = stageOk('layout', () => m._isaac_layout_check());
m._isaac_guard_arm();
console.log('  guard armed');
if (stage === 'layout') { console.log(`\nRESULT: layout ${layoutBad ? 'FAIL' : 'OK'}`); process.exit(layoutBad ? 1 : 0); }

// --- seed the RAM-FS with the packed archives --------------------------
// The lifted HUD load (Manager::LoadImage "gfx/ui/coop menu.png") reads
// resources/packed/graphics.a through the game's own fopen/fread; an empty
// FS returns NULL and the guest faults at 0x009a26c2. Seed the archives the
// game opens from the locally-owned instance BEFORE main so the KAGE loader
// finds them. Requires the boot module to export _isaac_fs_seed (add it to
// the boot link's EXPORTED_FUNCTIONS). music.a/videos.a are seeded LAZILY
// (LAZY_ARCHIVES below): they are not on the boot path, but the game does open
// them once it is playing.
//
// Boot round 10: the archives are NOT the whole install. This instance's
// animations.a holds a single 4 MB compressed bundle (TOC count 1), and the
// .anm2 files the AnmCache asks for by path ("gfx/ui/ui_streak.anm2"), the
// GLSL shaders ("resources/shaders/*.vs") and the Lua scripts
// ("resources/scripts/main.lua") are LOOSE files under resources/ (476 files,
// 38 MB) that KAGE's mount-root scan indexes and resolves by path. Seed that
// tree too, everything except packed/ (handled above by name).
// ISAAC_INSTANCE_DIR=<dir> boots from another instance tree (round 28: the
// shipping bundle, .scratch/game-bundle, is proven by booting from it). The
// cwd rule below still applies: run from that same directory.
const INSTANCE_DIR = (process.env.ISAAC_INSTANCE_DIR || 'C:/Users/Luca/Desktop/isaac/.scratch/game-instance')
  .replace(/\\/g, '/').replace(/\/+$/, '');
const PACKED_DIR = `${INSTANCE_DIR}/resources/packed`;
const BOOT_ARCHIVES = ['graphics.a', 'config.a', 'fonts.a', 'animations.a', 'rooms.a', 'sfx.a'];
// Opened only once the game is playing (music, cutscenes): registered by size
// and read on first open, so they cost nothing on a run that never asks.
// Round 24e: the DLC archive set. The instance only ever carried the eight
// base-game archives; the Repentance sounds and music (the title theme is
// resources/music/Repentance/Genesis Retake Light Loop.ogg) live in
// repentance.a, most of the 1,557 catalogued sound effects in afterbirth.a
// and afterbirthp.a. The engine mounts every one it finds and reads it front
// to back (per-entry checksum), so they are lazy AND windowed (see
// isaacLazyPread): registered by size, read from disk 1 MB at a time.
// The language packs (afterbirth_jp/kr, afterbirthp_jp/kr, repentance_de/es/
// fr/jp/kr/ru/zh) stay unlisted on purpose: the mount loop overwrites an
// equal-hash entry, so a mounted pack would shadow English assets with its
// own. The engine asks for them and logs "Failed to open archive file",
// which is what an install without them does too.
// repentance.a is NOT here: this exe never names it (whole-.text census,
// round 26) and none of its keys is shared with anything the game opens --
// the Repentance content is in afterbirthp.a for this build. 385 MB of
// dead weight, left on disk and unregistered.
const LAZY_ARCHIVES = ['music.a', 'videos.a', 'afterbirth.a', 'afterbirthp.a'];
function seedFile(relPath, bytes) {
  const pathBytes = Buffer.from(relPath + '\0', 'utf8');
  const pp = m._malloc(pathBytes.length);
  const dp = m._malloc(bytes.length || 1);
  m.HEAPU8.set(pathBytes, pp);
  if (bytes.length) m.HEAPU8.set(bytes, dp);
  const ok = m._isaac_fs_seed(pp, dp, bytes.length);
  m._free(pp); m._free(dp);
  return ok;
}
// Round 12f: the extracted tree is seeded LAZILY. Each file's size is
// registered (directory scans, stat and GetFileSize see it); the bytes are
// read from disk on the game's first open through Module.isaacLazyRead,
// which the RAM-FS calls with the seed path verbatim. Eager seeding cost
// ~3 s and 208 MB of host heap per boot for files most runs never open.
let lazyReads = 0, lazyBytes = 0;
// Round 31: saves persist. ISAAC_SAVE_DIR=<dir> keeps every file the game
// writes (the FS shim hands a written file to Module.isaacPersist when it is
// closed, a deleted one to Module.isaacUnlink -- the persistentgamedata*.dat
// under Documents/My Games/... on each game over) as a real file under that
// directory, and seeds them back over the instance tree at the next boot.
// Unset, nothing persists (the instance dir is never written to).
const SAVE_STORE = process.env.ISAAC_SAVE_DIR ? process.env.ISAAC_SAVE_DIR.replace(/\\/g, '/').replace(/\/+$/, '') : null;
let persisted = 0, unlinked = 0;
if (SAVE_STORE) {
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { dirname: dirOf, join: joinPath } = await import('node:path');
  // the FS key of a file the game created carries the fake cwd root the
  // host answers USERPROFILE with ("c:/isaac/"); a seeded file's src is the
  // instance-relative seed path already
  const storeRel = (key, src) => src || key.replace(/^c:\/isaac\//, '');
  m.isaacPersist = (key, src, ptr, len) => {
    try {
      const rel = storeRel(key, src);
      const abs = joinPath(SAVE_STORE, rel);
      mkdirSync(dirOf(abs), { recursive: true });
      writeFileSync(abs, m.HEAPU8.subarray(ptr, ptr + len));
      persisted += 1;
      return 1;
    } catch (e) { console.log(`  save store write FAILED for ${key}: ${e.message}`); return 0; }
  };
  m.isaacUnlink = (key, src) => {
    try { rmSync(joinPath(SAVE_STORE, storeRel(key, src)), { force: true }); unlinked += 1; return 1; }
    catch (e) { console.log(`  save store unlink FAILED for ${key}: ${e.message}`); return 0; }
  };
  console.log(`  ISAAC_SAVE_DIR=${SAVE_STORE}: written files persist there and seed back at boot`);
}
m.isaacLazyRead = (src, dst, len) => {
  try {
    const bytes = readFileSync(`${INSTANCE_DIR}/${src}`);
    if (bytes.length < len) { console.log(`  lazy read of ${src}: ${bytes.length} bytes on disk, ${len} registered`); return 0; }
    m.HEAPU8.set(bytes.subarray(0, len), dst);
    lazyReads += 1; lazyBytes += len;
    return 1;
  } catch (e) {
    console.log(`  lazy read FAILED for ${src}: ${e.message}`);
    return 0;
  }
};
function seedLazy(relPath, size) {
  if (typeof m._isaac_fs_seed_lazy !== 'function') {
    return seedFile(relPath, readFileSync(`${INSTANCE_DIR}/${relPath}`));
  }
  const pathBytes = Buffer.from(relPath + '\0', 'utf8');
  const pp = m._malloc(pathBytes.length);
  m.HEAPU8.set(pathBytes, pp);
  const ok = m._isaac_fs_seed_lazy(pp, size);
  m._free(pp);
  return ok;
}
// Round 24e: windowed reads. A lazy file at or above ISAAC_FS_WINDOW_MIN MiB
// (default 32) is never loaded whole -- the RAM-FS keeps a 1 MB window per
// file and refills it through this positional read. That is what makes the
// DLC archives (1.2 GB between afterbirth.a, afterbirthp.a and repentance.a)
// mountable at all inside a wasm32 heap.
const lazyFds = new Map();
let preads = 0, preadBytes = 0;
m.isaacLazyPread = (src, dst, off, len) => {
  try {
    let fd = lazyFds.get(src);
    if (fd === undefined) { fd = openSync(`${INSTANCE_DIR}/${src}`, 'r'); lazyFds.set(src, fd); }
    const view = new Uint8Array(m.HEAPU8.buffer, dst, len);
    const n = readSync(fd, view, 0, len, off);
    preads += 1; preadBytes += n;
    return n;
  } catch (e) {
    console.log(`  lazy pread FAILED for ${src} at ${off}+${len}: ${e.message}`);
    return -1;
  }
};
export function isaacLazyStats() { return { lazyReads, lazyBytes, preads, preadBytes }; }

// Round 14a: scripted input for the node profile too. ISAAC_INPUT holds the
// same timeline syntax as the web runner's input= (frame:Key, frame:mouse:x:y,
// frame:click): the host's PeekMessageW polls m.isaacInputPoll(frame, out)
// and turns each event into a Win32 message for GLFW's pump, so a headless
// node run can navigate the menus and start a run without rendering. The key
// table (KEYS: name -> [vk, scancode, extended], every letter, digit and the
// US punctuation since round 30) lives in explore.mjs.
const inputTimeline = [];
for (const item of (process.env.ISAAC_INPUT || '').split(',').map((t) => t.trim()).filter(Boolean)) {
  const [fr, what, ...rest] = item.split(':');
  const frame = Number(fr), w = (what || '').toLowerCase();
  if (w === 'mouse') inputTimeline.push({ frame, ev: [2, Number(rest[0] || 0), Number(rest[1] || 0), 0] });
  else if (w === 'click' || w === 'rclick') {
    const btn = w === 'click' ? 0 : 1;
    inputTimeline.push({ frame, ev: [3, btn, 1, 0] });
    inputTimeline.push({ frame: frame + 2, ev: [3, btn, 0, 0] });
  } else if (KEYS[w]) {
    const [vk, sc, ext] = KEYS[w];
    const hold = Math.max(1, Number(rest[0] || 2));      // frame:key[:hold] -- held for `hold` frames
    inputTimeline.push({ frame, ev: [1, vk, sc | (ext << 8), 1] });
    inputTimeline.push({ frame: frame + hold, ev: [1, vk, sc | (ext << 8), 0] });
  } else console.log(`  ISAAC_INPUT: unknown key '${what}' in '${item}'`);
}
inputTimeline.sort((a, b) => a.frame - b.frame);
let inputsDelivered = 0;
// Round 27: ISAAC_DRIVE=explore replaces the blind timeline with the
// door-aware explorer (explore.mjs): it reads the game's room/door/player
// state out of the identity-mapped guest heap each frame and walks door to
// door, firing. Prints its census after main returns.
// The guest arena is identity-mapped into the wasm heap: a guest VA indexes
// HEAP32/HEAPU8 directly. The module exports those two views only; a Float32
// view is kept over the same buffer and renewed if the heap grows (growth
// swaps the buffer). Shared by the explorer and the console driver.
const GUEST_LO = 0x00400000, GUEST_HI = 0x1c000000;
const HEAP_LO = 0x00d00000, HEAP_HI = 0x00d00000 + 768 * 1048576;   // the guest arena (isaac_host.h)
let f32 = new Float32Array(m.HEAPU8.buffer);
const mem = {
  ok: (va) => va >= GUEST_LO && va + 4 <= GUEST_HI && va + 4 <= m.HEAPU8.length,
  u32: (va) => m.HEAP32[va >> 2] >>> 0,
  u8: (va) => m.HEAPU8[va],
  f32: (va) => { if (f32.buffer !== m.HEAPU8.buffer) f32 = new Float32Array(m.HEAPU8.buffer); return f32[va >> 2]; },
  // every 4-aligned guest address in the arena holding `value` (a vtable
  // pointer finds every object of that class); one linear pass, ~0.3 s
  findAll: (value, max = 4096) => {
    const h = m.HEAP32, v = value | 0, out = [];
    const lo = HEAP_LO >> 2, hi = Math.min(HEAP_HI, m.HEAPU8.length) >> 2;
    for (let i = lo; i < hi; i++) if (h[i] === v) { out.push(i << 2); if (out.length >= max) break; }
    return out;
  },
};
let explorer = null;
if (process.env.ISAAC_DRIVE === 'explore') {
  explorer = makeExplorer(mem, { log: (s) => console.log(s), scanEntityList: !!process.env.ISAAC_EXPLORE_SCAN, census: !!process.env.ISAAC_EXPLORE_CENSUS });
  m.isaacInputPoll = (frame, out) => {
    const r = explorer.poll(frame, out, m.HEAP32);
    if (r) inputsDelivered += 1;
    return r;
  };
  console.log('  ISAAC_DRIVE=explore: door-aware explorer driving the input');
} else if (inputTimeline.length) {
  // ISAAC_INPUT_WATCH=1: every 30 frames, print the engine's own key-state
  // bytes (GLFW-key-indexed tables at 0x00c78c10 down / 0x00c78ab0 pressed /
  // 0x00c78950 released; 0x15d entries) for the keys the timeline uses.
  const watchKeys = { D: 0x44, W: 0x57, A: 0x41, S: 0x53, ENTER: 0x101, RIGHT: 0x106, LEFT: 0x107, DOWN: 0x108, UP: 0x109 };
  const inputWatch = !!process.env.ISAAC_INPUT_WATCH;
  let lastWatch = -1;
  const origPoll = (frame, out) => {
    if (!inputTimeline.length || inputTimeline[0].frame > frame) return 0;
    const { ev } = inputTimeline.shift();
    m.HEAP32.set(ev, out >> 2);
    inputsDelivered += 1;
    return 1;
  };
  m.isaacInputPoll = (frame, out) => {
    if (inputWatch && frame !== lastWatch && frame % 30 === 0) {
      lastWatch = frame;
      const down = Object.entries(watchKeys).filter(([, k]) => m.HEAPU8[0x00c78c10 + k]).map(([n]) => n);
      const pressed = Object.entries(watchKeys).filter(([, k]) => m.HEAPU8[0x00c78ab0 + k]).map(([n]) => n);
      console.log(`  [input-watch] frame ${frame}: down [${down.join(' ')}] pressed [${pressed.join(' ')}]`);
    }
    return origPoll(frame, out);
  };
  if (inputWatch) console.log('  ISAAC_INPUT_WATCH: printing the engine key tables every 30 frames');
  console.log(`  ISAAC_INPUT: ${inputTimeline.length} scripted events`);
}
// Round 30: ISAAC_CONSOLE="cmd1;cmd2" runs commands through the game's own
// debug console (recomp-architecture.md §21.45). The console is enabled by
// options.ini (EnableDebugConsole=1) and the commands are recalled from
// cmd_history.txt with UP, both seeded into the RAM-FS below -- nothing is
// written to the instance on disk. In explore mode the sequence starts
// ISAAC_CONSOLE_DELAY frames (default 150) after the explorer's run starts and
// the explorer is suspended while it runs; in timeline mode it starts at
// ISAAC_CONSOLE_AT (a presented-frame number) and the timeline waits.
// ISAAC_CONSOLE_MODE (round 32, §21.47) selects how the text gets in:
// `typed` -- the characters' keys, turned into WM_CHAR by the host's
// TranslateMessage (console_typing.mjs; no history is seeded, so the only way
// a command can reach the line is the typing); `recall` -- round 30's history
// recall; `type` -- round 30's probe (typed first, recall as the fallback).
const CONSOLE_MODES = ['recall', 'type', 'typed'];
const DEFAULT_CONSOLE_MODE = 'typed';   // proven on the fast profile: `stage 2` and `goto s.boss.1010` typed and executed (§21.47)
const consoleMode = CONSOLE_MODES.includes(process.env.ISAAC_CONSOLE_MODE || '') ? process.env.ISAAC_CONSOLE_MODE : DEFAULT_CONSOLE_MODE;
const consoleCommands = (process.env.ISAAC_CONSOLE || '').split(';').map((s) => s.trim()).filter(Boolean);
let consoleDrv = null;
if (consoleCommands.length) {
  const consoleDelay = Number(process.env.ISAAC_CONSOLE_DELAY || 150);
  const consoleAt = Number(process.env.ISAAC_CONSOLE_AT || 0);
  const ready = explorer
    ? (frame) => { const r = explorer.report(); return r.firstRunFrame >= 0 && frame - r.firstRunFrame >= consoleDelay; }
    : (frame) => frame >= consoleAt;
  consoleDrv = consoleMode === 'typed'
    ? makeTypedConsole(consoleCommands, { mem, ready, log: (s) => console.log(s) })
    : makeConsole(mem, { commands: consoleCommands, mode: consoleMode, ready, log: (s) => console.log(s) });
  const basePoll = m.isaacInputPoll || (() => 0);
  m.isaacInputPoll = (frame, out) => {
    // the console driver ticks first (idle -> open once `ready`); while it is
    // active the explorer is suspended (its key releases drain first) and the
    // timeline waits; when it is done the explorer resumes in whatever room
    // and floor the commands left it
    const ev = consoleDrv.poll(frame, out, m.HEAP32);
    const active = consoleDrv.active();
    if (explorer) {
      if (active && !explorer.suspended()) explorer.suspend(frame);
      else if (!active && explorer.suspended()) explorer.resume(frame);
    }
    if (ev) { inputsDelivered += 1; return 1; }
    if (active) {
      if (explorer && explorer.poll(frame, out, m.HEAP32)) { inputsDelivered += 1; return 1; }
      return 0;
    }
    return basePoll(frame, out);
  };
  const consoleHow = consoleMode === 'typed' ? 'typed (WM_CHAR from TranslateMessage)' : consoleMode === 'type' ? 'typed first, history recall as the fallback' : 'by history recall';
  console.log(`  ISAAC_CONSOLE: ${consoleCommands.length} command(s) through the debug console, ${explorer ? `${consoleDelay} frames after the run starts` : `at frame ${consoleAt}`}, ${consoleHow}`);
}
if (typeof m._isaac_fs_seed === 'function') {
  stageOk('seed packed archives', () => {
    let seeded = 0;
    for (const name of BOOT_ARCHIVES) {
      let bytes;
      try { bytes = readFileSync(`${PACKED_DIR}/${name}`); }
      catch { console.log(`  (skip ${name}: not present locally)`); continue; }
      const relPath = `resources/packed/${name}`;
      const ok = seedFile(relPath, bytes);
      console.log(`  seed ${relPath} ${bytes.length} bytes -> ${ok ? 'ok' : 'FAIL'}`);
      if (ok) seeded += 1;
    }
    // music.a (182 MB) and videos.a (93 MB) are not on the boot path, so they
    // were skipped entirely to keep the seed small -- and the game logged
    // "Failed to open archive file" for both once it reached gameplay
    // (round 15d). They go in lazily instead: registered by size now, read
    // from disk only if the game actually opens them.
    for (const name of LAZY_ARCHIVES) {
      const relPath = `resources/packed/${name}`;
      let size;
      try { size = statSync(`${PACKED_DIR}/${name}`).size; }
      catch { console.log(`  (skip ${name}: not present locally)`); continue; }
      const ok = seedLazy(relPath, size);
      console.log(`  seed ${relPath} ${size} bytes (lazy) -> ${ok ? 'ok' : 'FAIL'}`);
      if (ok) seeded += 1;
    }
    return seeded;
  });
  // Boot round 11: the instance is a ResourceExtractor DUMP, not a Steam
  // layout. The real install keeps everything in resources/packed/*.a
  // (afterbirth.a, afterbirthp.a, repentance.a: 1.1 GB the instance does not
  // carry) and resources/ holds only packed/ + scripts/. The emulator-era
  // instance instead has the archives' contents extracted to the install
  // ROOT (gfx/, font/, data/, *.xml: 10,725 files, 208 MB) and relies on the
  // canonical exe's hand patch at 0x009ab970 (no "resources/" mount root), so
  // every relative key ("players.xml", "gfx/ui/x.anm2") misses the archive
  // index (keyed "resources/...") and resolves through the "" root's scan of
  // that extracted tree. The small archives left in resources/packed/ are
  // STALE (config.a's players.xml is the Afterbirth+ one); with a
  // "resources/" root they shadow the extracted Repentance+ files, because
  // KAGE tries the archive index before a root's loose map. Seed the whole
  // tree the game would see on disk. Skipped: exe/dll/so (not assets), .ogv
  // (63 MB of cutscenes; videos.a is skipped for the same reason), mods/,
  // and the duplicate top-level packed/ (the game opens archives by the
  // resources/packed/ name above).
  stageOk('seed extracted instance tree', () => {
    let files = 0, bytes = 0, failed = 0, skipped = 0;
    const SKIP_DIRS = new Set(['resources/packed', 'packed', 'mods']);
    const SKIP_EXT = /\.(exe|dll|so|ogv)$/i;
    const walk = (dir, rel) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = `${dir}/${e.name}`, r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(r)) continue;
          walk(p, r);
        } else if (e.isFile()) {
          if (SKIP_EXT.test(e.name) || e.name.startsWith('.')) { skipped += 1; continue; }
          const size = statSync(p).size;
          if (seedLazy(r, size)) { files += 1; bytes += size; }
          else { failed += 1; if (failed <= 5) console.log(`  FAIL seeding ${r}`); }
        }
      }
    };
    walk(INSTANCE_DIR, '');
    console.log(`  registered ${files} loose files lazily (${(bytes / 1048576).toFixed(1)} MB on disk, read on first open) from the instance root, ${skipped} skipped by type${failed ? `, ${failed} FAILED` : ''}`);
    // The host Lua module (upstream 5.3.3 in wasm) opens scripts through its
    // OWN libc, which this link maps to the real Node filesystem
    // (-sNODERAWFS=1) relative to process.cwd() -- not through the RAM-FS.
    // So luaL_loadfilex("resources/scripts/main.lua") only resolves when the
    // boot runs with cwd = the instance dir. Say so instead of guessing.
    if (process.cwd().replace(/\\/g, '/').toLowerCase() !== INSTANCE_DIR.toLowerCase()) {
      console.log(`  NOTE: cwd is not the instance dir; the host Lua loader (NODERAWFS) will not find resources/scripts/*.lua.`);
      console.log(`        run:  cd ${INSTANCE_DIR} && node <boot dir>/boot_integration.mjs <segs> main`);
    }
    return files;
  });
  // round 31: the saves of earlier boots, over the instance tree (a saved
  // file wins over a seeded one; eager, they are small)
  if (SAVE_STORE) stageOk('restore saves', () => {
    if (!existsSync(SAVE_STORE)) { console.log('  (no save store yet)'); return 0; }
    let n = 0;
    const walkSaves = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`, r = rel ? `${rel}/${name}` : name;
        const st = statSync(p);
        if (st.isDirectory()) walkSaves(p, r);
        else if (seedFile(r, readFileSync(p))) { n += 1; console.log(`  restored ${r} (${st.size} bytes)`); }
      }
    };
    walkSaves(SAVE_STORE, '');
    console.log(`  ${n} saved file(s) restored from ${SAVE_STORE}`);
    return n;
  });
  // Round 30: the console's two files, seeded into the RAM-FS only (an eager
  // seed replaces the lazy registration of a disk file with the same key, so
  // an options.ini the instance already has is merged, not overwritten, and
  // the disk is never touched). The engine opens
  // ./Documents/My Games/Binding of Isaac Repentance+/options.ini relative
  // to the cwd (ISAAC_FS_TRACE, round 30) and the console loads
  // cmd_history.txt from the same directory (0x00686220).
  if (consoleCommands.length) {
    stageOk('seed console files (RAM-FS only)', () => {
      const optPath = `${INSTANCE_DIR}/${SAVE_DIR}/options.ini`;
      const existing = existsSync(optPath) ? readFileSync(optPath, 'latin1') : null;
      let n = 0;
      for (const f of consoleSeedFiles(consoleCommands, existing)) {
        // typed mode seeds no history: a command in the line can only have been typed
        if (consoleMode === 'typed' && f.path.endsWith('cmd_history.txt')) { console.log(`  (skip ${f.path}: typed mode)`); continue; }
        const ok = seedFile(f.path, Buffer.from(f.text, 'latin1'));
        console.log(`  seed ${f.path} ${f.text.length} bytes${f.merged ? ' (merged with the instance\'s own options.ini)' : ''} -> ${ok ? 'ok' : 'FAIL'}`);
        if (ok) n += 1;
      }
      return n;
    });
  }
} else {
  console.log('  (seed skipped: boot module has no _isaac_fs_seed export — rebuild the boot link)');
}

// --- host boot: IAT, TEB, TLS, _initterm -------------------------------
const bootRc = stageOk('host boot (IAT + TEB + TLS + _initterm)',
                       () => m._isaac_run_boot(1));
console.log(`  isaac_boot_init -> ${bootRc}`);
let g = m._isaac_guard_check();
console.log(`  guard after boot: ${g ? g + ' words CORRUPTED' : 'intact'}`);
if (bootRc === null) { console.log('\nRESULT: boot trapped'); process.exit(1); }
if (stage === 'boot') { console.log(`\nRESULT: boot rc=${bootRc}`); process.exit(bootRc ? 1 : 0); }

// --- main --------------------------------------------------------------
const mainRc = stageOk('main @ 0x00931050', () => m._isaac_run_main());
console.log(`  isaac_boot_call_main -> ${mainRc}`);
console.log(`  lazy file reads: ${lazyReads} files, ${(lazyBytes / 1048576).toFixed(1)} MB fetched on first open; ` +
            `windowed reads: ${preads} host reads, ${(preadBytes / 1048576).toFixed(1)} MB`);
if (inputTimeline.length || inputsDelivered) console.log(`  scripted input: ${inputsDelivered} events delivered, ${inputTimeline.length} pending`);
if (explorer) console.log(`  explorer: ${JSON.stringify(explorer.report())}`);
if (SAVE_STORE) console.log(`  save store: ${persisted} file(s) persisted, ${unlinked} unlinked`);
if (consoleDrv) console.log(`  console: ${JSON.stringify(consoleDrv.report())}`);
g = m._isaac_guard_check();
console.log(`  guard after main: ${g ? g + ' words CORRUPTED' : 'intact'}`);
try { m._isaac_stub_report(); } catch (e) { /* best effort */ }
try { m._isaac_heap_report(); } catch (e) { /* absent in older host builds */ }
try { m._isaac_module_report(); } catch (e) { /* absent in older host builds */ }

// --- optional guest-memory dump ---------------------------------------
// ISAAC_DUMP32=0xc379e8:4,0xc37a10:8 prints guest dwords after main. The
// guest address space is identity-mapped into the wasm heap, so a static the
// engine keeps (a vector's begin/end, a manager's this) can be read back
// without rebuilding the 272 MB module just to add a printf.
if (process.env.ISAAC_DUMP32) {
  console.log('\n=== guest dwords (ISAAC_DUMP32) ===');
  for (const spec of process.env.ISAAC_DUMP32.split(',')) {
    const [aStr, nStr] = spec.split(':');
    const va = Number(aStr.trim());
    const n = Number(nStr ?? 1) || 1;
    if (!Number.isFinite(va) || va <= 0) { console.log(`  bad spec '${spec}'`); continue; }
    // HEAPU8 is the only view this link exports; assemble dwords by hand.
    const rd32 = (a) => (m.HEAPU8[a] | (m.HEAPU8[a + 1] << 8) |
                         (m.HEAPU8[a + 2] << 16) | (m.HEAPU8[a + 3] << 24)) >>> 0;
    for (let i = 0; i < n; i += 4) {
      const row = [];
      for (let k = 0; k < 4 && i + k < n; k++)
        row.push(rd32(va + 4 * (i + k)).toString(16).padStart(8, '0'));
      console.log(`  ${(va + 4 * i).toString(16).padStart(8, '0')}: ${row.join(' ')}`);
    }
  }
}

console.log(`\nRESULT: ${mainRc === null ? 'main trapped' : 'main returned ' + mainRc}`);
