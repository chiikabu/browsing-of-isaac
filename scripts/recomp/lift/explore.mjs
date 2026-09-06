// explore.mjs -- a door-aware explorer for the node profile (round 27).
//
// The scripted ISAAC_INPUT timeline is blind: a held D walks the player into
// the east wall at whatever row it started on and never touches a door. This
// brain reads the game's own state out of guest memory every frame (the
// guest arena is identity-mapped into the wasm heap, so a guest VA is a heap
// index) and decides the keys: Enter through the menus until a run exists,
// then, room by room, line up with an open door and walk into it, firing
// while it goes, preferring doors whose target room has not been visited.
// Everything it reads is what the door-touch probe in host_shims_gl.c reads
// (round 26): Game at [0x00c71678]; the current room at Game+0x18300 (width
// +0xc, height +0x10, room index Game+0x18304); RoomTransition at
// Game+0x1b83c (state +0, idle == 0); the player vector at Game+0x1baa8..
// +0x1baac (Entity_Player*, position +0x33c/+0x340); eight door slots at
// room+0x724 (state +0xc, open == 2; grid index +0x24; target room +0x394);
// a door's trigger point is its grid cell centre plus 18 px outward, and the
// check fires within 25 px. Slot & 3 is the wall: 0 west, 1 north, 2 east,
// 3 south.
//
// Round 30 adds the floor: Level is Game's first member (Level::Init
// 0x00744940 logs `*this` and `this[1]` as m_Stage / m_StageType, and
// Level::DEBUG_goto_room 0x0073fa20 reaches Game+0x1830c through the same
// this), the room's grid-entity array at room+0x24 (448 slots, ending exactly
// at the door array; Room::GetGridEntity 0x00436060), the trapdoor class by
// its vtable (CreateGridEntity 0x0070b2e0 case 17 -> 0x00b6946c; the entity
// keeps its grid index at +0x24, GridEntity_TrapDoor::Update 0x0071fef0), the
// live-boss counter at room+0x7224 (Room::TriggerBossDeath 0x007fec00 logs
// `this+0x7224 - 1`), the room's config through room+4 -> desc+0x10 ->
// RoomConfig_Room (type +8, variant +0xc: the "Room %d.%d(%s)" log line's
// arguments, 0x007f2800), and the debug console (makeConsole below).
//
// Nothing here writes guest memory; the only outputs are the Win32 key
// events the host's PeekMessageW polls through Module.isaacInputPoll.

export const GAME_PTR = 0x00c71678;
export const OFF = {
  stage: 0x0, stageType: 0x4,
  frame: 0x264f8, room: 0x18300, roomIdx: 0x18304, rt: 0x1b83c,
  playersBegin: 0x1baa8, playersEnd: 0x1baac,
  roomW: 0xc, roomH: 0x10, doors: 0x724, grid: 0x24, gridSlots: 0x1c0, roomDesc: 0x4, bosses: 0x7224,
  descData: 0x10, cfgStage: 0x0, cfgType: 0x8, cfgVariant: 0xc,
  doorState: 0xc, doorGrid: 0x24, doorTarget: 0x394,
  posX: 0x33c, posY: 0x340,
  debugFlags: 0x26544,                         // Game::GetDebugFlag 0x00431760: bit n of the dword at +0x26544 + (n>>5)*4
};
const OFFX = [-18, 0, 18, 0], OFFY = [0, -18, 0, 18];
// Class vtables (the first dword of every object; from the constructors
// 0x006b8590 and 0x00665cf0): the pooled NPC and tear objects are found in
// the heap by these. Entity fields: type +0x28 (NPC types are 10..0x3ed,
// player 1, tear 2), variant +0x2c, position +0x33c/+0x340.
export const VT_NPC = 0x00b67468, VT_TEAR = 0x00b64eac, VT_PICKUP = 0x00b67f24;   // Entity_Pickup ctor 0x006e0010
export const VT_TRAPDOOR = 0x00b6946c;       // GridEntity_TrapDoor (CreateGridEntity 0x0070b2e0, case 0x11)
export const GRID = { variant: 0x8, state: 0xc, index: 0x24 };   // GridEntity: desc variant +8 (Room::SpawnGridEntity), state +0xc, grid index +0x24 (0x0071fef0)
export const ENT = { type: 0x28, variant: 0x2c, subtype: 0x30, posX: 0x33c, posY: 0x340, dead: 0x173 };
// Entity_Player counters, from the Add* methods that also refresh the HUD
// counter (FUN_007597e0(n)); a bomb pickup moved +0x1364 1 -> 2 in-engine.
export const PLAYER = { coins: 0x1368, bombs: 0x1364, keys: 0x135c, hearts: 0x1340 };   // AddCoins 0x00759400 (HUD counter 1), AddBombs 0x00759500 (counter 4, clamped 0..99), AddKeys 0x007595b0 (counter 2); +0x1340 reads 6 at run start (three red hearts)
// The debug console lives inside Game (its char callback 0x00686730 reads
// Game+0x68d78 as the state and Game+0x68d94 as the input line; Console+0x1c
// is the line in Console::Update 0x0068b260, +0x108 the cursor). State: 0
// closed, 1 opening, 2 open, 4 closing. The history ring (std::string* slots)
// is Console+0x58 buffer / +0x5c capacity / +0x60 head / +0x64 count: the
// loader 0x00686220 push_backs cmd_history.txt line by line, the executor's
// 0x006864a0 push_fronts, UP recalls slot head first.
export const CONSOLE = {
  state: 0x68d78, line: 0x68d94, cursor: 0x68e80,
  histBuf: 0x68dd0, histCap: 0x68dd4, histHead: 0x68dd8, histCount: 0x68ddc,
};
// key -> [vk, scancode, extended]; the same table the node driver uses for
// ISAAC_INPUT. Scancodes are the US set-1 codes GLFW's WndProc decodes from
// lParam (HIWORD & 0x1ff) into its GLFW-key tables; the engine's key state
// is GLFW-key-indexed (0x00c78c10, 0x15d entries), so the scancode is what
// the game sees: 0x29 is GLFW_KEY_GRAVE_ACCENT (96), the console key.
export const KEYS = {
  enter: [0x0D, 0x1C, 0], escape: [0x1B, 0x01, 0], space: [0x20, 0x39, 0], tab: [0x09, 0x0F, 0],
  backspace: [0x08, 0x0E, 0], delete: [0x2E, 0x53, 1], insert: [0x2D, 0x52, 1],
  home: [0x24, 0x47, 1], end: [0x23, 0x4F, 1], pageup: [0x21, 0x49, 1], pagedown: [0x22, 0x51, 1],
  up: [0x26, 0x48, 1], down: [0x28, 0x50, 1], left: [0x25, 0x4B, 1], right: [0x27, 0x4D, 1],
  shift: [0x10, 0x2A, 0], ctrl: [0x11, 0x1D, 0], alt: [0x12, 0x38, 0],
  a: [0x41, 0x1E, 0], b: [0x42, 0x30, 0], c: [0x43, 0x2E, 0], d: [0x44, 0x20, 0], e: [0x45, 0x12, 0],
  f: [0x46, 0x21, 0], g: [0x47, 0x22, 0], h: [0x48, 0x23, 0], i: [0x49, 0x17, 0], j: [0x4A, 0x24, 0],
  k: [0x4B, 0x25, 0], l: [0x4C, 0x26, 0], m: [0x4D, 0x32, 0], n: [0x4E, 0x31, 0], o: [0x4F, 0x18, 0],
  p: [0x50, 0x19, 0], q: [0x51, 0x10, 0], r: [0x52, 0x13, 0], s: [0x53, 0x1F, 0], t: [0x54, 0x14, 0],
  u: [0x55, 0x16, 0], v: [0x56, 0x2F, 0], w: [0x57, 0x11, 0], x: [0x58, 0x2D, 0], y: [0x59, 0x15, 0],
  z: [0x5A, 0x2C, 0],
  '0': [0x30, 0x0B, 0], '1': [0x31, 0x02, 0], '2': [0x32, 0x03, 0], '3': [0x33, 0x04, 0], '4': [0x34, 0x05, 0],
  '5': [0x35, 0x06, 0], '6': [0x36, 0x07, 0], '7': [0x37, 0x08, 0], '8': [0x38, 0x09, 0], '9': [0x39, 0x0A, 0],
  grave: [0xC0, 0x29, 0], minus: [0xBD, 0x0C, 0], equals: [0xBB, 0x0D, 0], lbracket: [0xDB, 0x1A, 0],
  rbracket: [0xDD, 0x1B, 0], backslash: [0xDC, 0x2B, 0], semicolon: [0xBA, 0x27, 0], quote: [0xDE, 0x28, 0],
  comma: [0xBC, 0x33, 0], period: [0xBE, 0x34, 0], slash: [0xBF, 0x35, 0],
  f1: [0x70, 0x3B, 0], f2: [0x71, 0x3C, 0], f3: [0x72, 0x3D, 0], f4: [0x73, 0x3E, 0], f5: [0x74, 0x3F, 0],
  f6: [0x75, 0x40, 0], f7: [0x76, 0x41, 0], f8: [0x77, 0x42, 0], f9: [0x78, 0x43, 0], f10: [0x79, 0x44, 0],
  f11: [0x7A, 0x57, 0], f12: [0x7B, 0x58, 0],
};
const WALK = ['a', 'w', 'd', 's'];          // by wall: west, north, east, south
const FIRE = ['left', 'up', 'right', 'down'];

export function keyEvent(name, down) {
  const [vk, sc, ext] = KEYS[name];
  return [1, vk, sc | (ext << 8), down ? 1 : 0];
}

// A console command as key taps: the key for each character, with Shift held
// around the characters that need it. This is the plan a host with WM_CHAR
// would need; the current host builds WM_KEYDOWN/WM_KEYUP only and its
// TranslateMessage is a stub, so typed characters never reach the console's
// GLFW char callback (see recomp-architecture.md §21.45). Kept as the
// `type` mode of makeConsole, which verifies the line before Enter.
const SHIFTED = { '~': 'grave', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: 'minus', '+': 'equals', '{': 'lbracket', '}': 'rbracket', '|': 'backslash', ':': 'semicolon', '"': 'quote', '<': 'comma', '>': 'period', '?': 'slash' };
const PLAIN = { ' ': 'space', '`': 'grave', '-': 'minus', '=': 'equals', '[': 'lbracket', ']': 'rbracket', '\\': 'backslash', ';': 'semicolon', "'": 'quote', ',': 'comma', '.': 'period', '/': 'slash' };
export function planTyping(text) {
  const out = [];
  for (const ch of text) {
    let key, shift = false;
    if (/[a-z0-9]/.test(ch)) key = ch;
    else if (/[A-Z]/.test(ch)) { key = ch.toLowerCase(); shift = true; }
    else if (PLAIN[ch]) key = PLAIN[ch];
    else if (SHIFTED[ch]) { key = SHIFTED[ch]; shift = true; }
    else throw new Error(`planTyping: no key for ${JSON.stringify(ch)}`);
    out.push({ key, shift });
  }
  return out;
}

// The two files the console needs under the save path (the engine resolves
// it to ./Documents/My Games/Binding of Isaac Repentance+/ relative to the
// instance dir, host_shims_fs.c): options.ini with EnableDebugConsole=1
// (OptionsConfig loader 0x00924440 -> Options+0x5c -> Manager+0x2a398, the
// console's gate) and SaveCommandHistory=1 (the history loader 0x00686220
// deletes cmd_history.txt otherwise), and cmd_history.txt with one command
// per line, the first line being what the first UP recalls. An existing
// options.ini is merged, not replaced: only those keys change. VSync=0 is
// forced too: with a file present the loader applies every value, and
// OptionsConfig::SetVSync(1) (0x00925ce0) asks glfwGetPrimaryMonitor, which
// the headless host answers with NULL -- GLFW's `monitor != NULL` assert
// aborted the first console run (round 30); without a file the loader
// skips the block and SetVSync is never called.
export const SAVE_DIR = 'Documents/My Games/Binding of Isaac Repentance+';
export function consoleSeedFiles(commands, existingOptions = null) {
  const set = { EnableDebugConsole: '1', SaveCommandHistory: '1', VSync: '0' };
  let lines = existingOptions ? existingOptions.split(/\r?\n/) : ['[Options]'];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.some((l) => /^\[Options\]/.test(l))) lines.unshift('[Options]');
  const seen = new Set();
  lines = lines.map((l) => {
    const m = /^([A-Za-z_]+)=/.exec(l);
    if (m && set[m[1]] !== undefined) { seen.add(m[1]); return `${m[1]}=${set[m[1]]}`; }
    return l;
  });
  for (const k of Object.keys(set)) if (!seen.has(k)) lines.push(`${k}=${set[k]}`);
  const bad = commands.find((c) => /[\r\n]/.test(c) || !c.trim());
  if (bad !== undefined) throw new Error(`consoleSeedFiles: bad command ${JSON.stringify(bad)}`);
  return [
    { path: `${SAVE_DIR}/options.ini`, text: lines.join('\r\n') + '\r\n', merged: !!existingOptions },
    { path: `${SAVE_DIR}/cmd_history.txt`, text: commands.map((c) => c.trim()).join('\r\n') + '\r\n' },
  ];
}

// The engine's own log lines in a run's output (host_shims_misc.c forwards
// the game's vfprintf as `[odsa] [INFO] - ...`, asserts as `[odsa] [ASSERT] -`):
// the floor (Level::Init 0x00744940, RoomConfig's stage load), every room
// entered ("Room %d.%d(%s)": type.variant(name), 0x007f2800), boss deaths
// (Room::TriggerBossDeath 0x007fec00) and the explorer's own census line.
export function censusFromLog(text) {
  const c = { levelInits: [], stages: [], rooms: [], bossRooms: 0, bossDeaths: [], asserts: 0, invalidPositions: 0, explorer: null, console: null };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^(\[\s*[\d.]+\]\s*)+/, '');
    let m;
    if ((m = /\[odsa\] \[INFO\] - Level::Init m_Stage (\d+), m_StageType (\d+) Seed (\d+)/.exec(line))) c.levelInits.push({ stage: +m[1], type: +m[2], seed: m[3] });
    else if ((m = /\[odsa\] \[INFO\] - \[RoomConfig\] load stage (\d+): (.*?) \(mode (\d+)\)/.exec(line))) c.stages.push({ stage: +m[1], name: m[2], mode: +m[3] });
    else if ((m = /\[odsa\] \[INFO\] - Room (\d+)\.(\d+)\((.*)\)\s*$/.exec(line))) { c.rooms.push({ type: +m[1], variant: +m[2], name: m[3] }); if (+m[1] === 5) c.bossRooms++; }
    else if ((m = /\[odsa\] \[INFO\] - TriggerBossDeath: (-?\d+) bosses remaining/.exec(line))) c.bossDeaths.push(+m[1]);
    else if (/\[odsa\] \[ASSERT\]/.test(line)) { c.asserts++; if (/Invalid entity position/.test(line)) c.invalidPositions++; }
    else if ((m = /^\s*explorer: (\{.*\})\s*$/.exec(line))) { try { c.explorer = JSON.parse(m[1]); } catch { /* keep null */ } }
    else if ((m = /^\s*console: (\{.*\})\s*$/.exec(line))) { try { c.console = JSON.parse(m[1]); } catch { /* keep null */ } }
  }
  return c;
}

// mem: { u32(va) -> number, f32(va) -> number, ok(va) -> boolean, u8?(va) }
function readers(mem) {
  const rd = (va) => (mem.ok(va) ? mem.u32(va) : 0);
  const rf = (va) => (mem.ok(va) ? mem.f32(va) : 0);
  const rb = (va) => (mem.ok(va) ? (mem.u8 ? mem.u8(va) : mem.u32(va & ~3) >>> ((va & 3) * 8) & 0xff) : 0);
  // an MSVC x86 std::string: 16-byte SSO buffer or pointer at +0, size +0x10, capacity +0x14
  const rs = (va, max = 512) => {
    const size = rd(va + 0x10), cap = rd(va + 0x14);
    if (size > max || cap > 0x10000000) return '';
    const base = cap > 15 ? rd(va) : va;
    if (!mem.ok(base)) return '';
    let s = '';
    for (let i = 0; i < size; i++) s += String.fromCharCode(rb(base + i));
    return s;
  };
  return { rd, rf, rb, rs };
}

export function makeExplorer(mem, opts = {}) {
  const log = opts.log || (() => {});
  const menuEvery = opts.menuEvery ?? 40;       // frames between Enters in the menus
  const menuHold = opts.menuHold ?? 12;          // frames an Enter stays down
  const doorTimeout = opts.doorTimeout ?? 600;   // frames on one door before giving up on it
  const stuckFrames = opts.stuckFrames ?? 150;   // no movement while walking -> give up on the door
  const settle = opts.settle ?? 20;              // frames to wait after a transition
  const align = opts.align ?? 6;                 // px tolerance when lining up with a door
  const sidestepAfter = opts.sidestepAfter ?? 30; // frames without movement before stepping aside
  const sidestepFor = opts.sidestepFor ?? 25;     // frames of each sidestep
  const pickupTimeout = opts.pickupTimeout ?? 300; // frames spent on one pickup before abandoning it
  const trapdoorTimeout = opts.trapdoorTimeout ?? 600; // frames spent walking to a trapdoor before abandoning it

  const queue = [];
  const held = new Set();
  let lastFrame = -1;
  let lastEnter = -1e9;
  const visited = new Set();     // room indices on the current floor
  const floors = {};             // "run<n>/<stage>.<type>" -> room indices visited there, in order
  let curFloor = null, floorKey = null;
  const stats = { menuFrames: 0, playFrames: 0, huntFrames: 0, transitions: 0, doorAttempts: 0, doorTimeouts: 0, stuck: 0, firstRunFrame: -1, runs: 0, deaths: 0, sidesteps: 0, pickupAttempts: 0, pickupsCollected: 0,
    floorChanges: 0, descents: 0, trapdoorAttempts: 0, bossRoomsEntered: 0, bossKills: 0, suspensions: 0 };
  let dead = false;
  let cur = null;         // { roomIdx, roomPtr, tried:Set<slot>, door:{slot, tx, ty, target} | null, since, lastPos, lastMove, fireAt }
  let transitionSeen = false;
  let settleUntil = -1;
  let suspended = false, announce = false;

  const { rd, rf, rb } = readers(mem);
  // The NPC pool: found once by vtable, re-found when a room turns up none.
  let npcPool = null;
  function liveEnemies(st) {
    if (!mem.findAll) return [];
    if (!npcPool) { npcPool = mem.findAll(VT_NPC, 4096); log(`[explore] NPC pool: ${npcPool.length} object(s) by vtable`); }
    const out = [];
    for (const e of npcPool) {
      const t = rd(e + ENT.type);
      if (t < 10 || t > 1100) continue;
      const x = rf(e + ENT.posX), y = rf(e + ENT.posY);
      if (!(x > 0 && x < 40 + st.w * 40 + 40 && y > 0 && y < 120 + st.h * 40 + 80)) continue;
      if (rb(e + ENT.dead)) continue;
      out.push({ e, t, v: rd(e + ENT.variant), x, y, d: Math.abs(x - st.px) + Math.abs(y - st.py) });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
  // The pickup pool, the same way. A live pickup has type 5, a position in
  // the room and the dead byte clear; coins/keys/bombs/hearts are collected
  // by touch, collectibles (variant 100) by touching the pedestal.
  let pickupPool = null;
  function livePickups(st) {
    if (!mem.findAll) return [];
    if (!pickupPool) { pickupPool = mem.findAll(VT_PICKUP, 4096); log(`[explore] pickup pool: ${pickupPool.length} object(s) by vtable`); }
    const out = [];
    for (const e of pickupPool) {
      if (rd(e + ENT.type) !== 5) continue;
      const x = rf(e + ENT.posX), y = rf(e + ENT.posY);
      if (!(x > 0 && x < 40 + st.w * 40 + 40 && y > 0 && y < 120 + st.h * 40 + 80)) continue;
      if (rb(e + ENT.dead)) continue;
      out.push({ e, v: rd(e + ENT.variant), s: rd(e + ENT.subtype), x, y, d: Math.abs(x - st.px) + Math.abs(y - st.py) });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
  // The room's grid entities (room+0x24, one pointer per cell, 448 cells):
  // every trapdoor by its vtable, with the cell centre the engine uses
  // ((i % w) * 40 + 40, (i / w) * 40 + 120; 0x00431be0 and 0x0071fef0).
  function trapdoors(st) {
    const out = [];
    for (let i = 0; i < OFF.gridSlots; i++) {
      const g = rd(st.roomPtr + OFF.grid + 4 * i);
      if (!g || !mem.ok(g) || rd(g) !== VT_TRAPDOOR) continue;
      const x = (i % st.w) * 40 + 40, y = Math.floor(i / st.w) * 40 + 120;
      out.push({ e: g, slot: i, idx: rd(g + GRID.index) | 0, state: rd(g + GRID.state) | 0, x, y, d: Math.abs(x - st.px) + Math.abs(y - st.py) });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }
  function counters(st) {
    const p = st.player;
    return { coins: rd(p + PLAYER.coins) | 0, bombs: rd(p + PLAYER.bombs) | 0, keys: rd(p + PLAYER.keys) | 0 };
  }

  function npcCensus(st, frame) {
    if (!npcPool) return;
    const rows = [];
    for (const e of npcPool) {
      const t = rd(e + ENT.type);
      if (t < 10 || t > 1100) continue;
      rows.push(`${e.toString(16)}:t${t}.${rd(e + ENT.variant)} (${rf(e + ENT.posX).toFixed(0)},${rf(e + ENT.posY).toFixed(0)}) dead=${rb(e + ENT.dead)} f170=${rd(e + 0x170).toString(16)} f10=${rd(e + 0x10).toString(16)}`);
      if (rows.length >= 24) break;
    }
    log(`[explore] frame ${frame}: NPC census in room ${st.roomIdx} (${rows.length} typed of ${npcPool.length}): ${rows.join(' | ')}`);
  }

  function press(name) { if (!held.has(name)) { held.add(name); queue.push(keyEvent(name, true)); } }
  function release(name) { if (held.has(name)) { held.delete(name); queue.push(keyEvent(name, false)); } }
  function releaseAll() { for (const k of [...held]) release(k); }
  function tap(name, frame, hold) { press(name); pending.push({ frame: frame + hold, name }); }
  const pending = [];     // timed releases

  function readState() {
    const game = rd(GAME_PTR);
    if (!game) return null;
    const room = rd(game + OFF.room);
    const pb = rd(game + OFF.playersBegin), pe = rd(game + OFF.playersEnd);
    const player = (pb && pe > pb) ? rd(pb) : 0;
    if (!room || !player) return { game, inGame: false };
    const w = rd(room + OFF.roomW), h = rd(room + OFF.roomH);
    const doors = [];
    for (let slot = 0; slot < 8; slot++) {
      const d = rd(room + OFF.doors + 4 * slot);
      if (!d) continue;
      const gi = rd(d + OFF.doorGrid);
      doors.push({
        slot, state: rd(d + OFF.doorState), target: rd(d + OFF.doorTarget) | 0,
        tx: (gi % w) * 40 + 40 + OFFX[slot & 3], ty: Math.floor(gi / w) * 40 + 120 + OFFY[slot & 3],
      });
    }
    const desc = rd(room + OFF.roomDesc), cfg = desc ? rd(desc + OFF.descData) : 0;
    const stage = rd(game + OFF.stage) | 0, stageType = rd(game + OFF.stageType) | 0;
    return {
      game, player, inGame: w > 0 && w < 64 && h > 0 && h < 64,
      roomIdx: rd(game + OFF.roomIdx) | 0, roomPtr: room, w, h, doors,
      rtState: rd(game + OFF.rt), px: rf(player + OFF.posX), py: rf(player + OFF.posY),
      playerDead: rb(player + ENT.dead),
      stage, stageType, floor: `${stage}.${stageType}`,
      roomType: cfg ? rd(cfg + OFF.cfgType) | 0 : -1, roomVariant: cfg ? rd(cfg + OFF.cfgVariant) | 0 : -1,
      bosses: rd(room + OFF.bosses) | 0,
    };
  }

  // Debug aid (opts.scanEntityList): look for the room's entity list inside
  // the Game object -- an (array, capacity, count) triple at +0x24/+0x28/+0x2c
  // of some base whose elements carry an entity type at +0x28 and a
  // position at +0x33c/+0x340 -- and print every candidate with a census of
  // the element types. Read-only.
  function scanEntityList(game) {
    const el = game + 0x1baa8;   // the ESI EntityList::Reset is called with (sub_0090d3f0)
    const fields = [];
    for (let off = 0; off <= 0xa0; off += 4) fields.push(`+${off.toString(16)}=${rd(el + off).toString(16)}`);
    log(`[explore] EntityList at Game+0x1baa8: ${fields.join(' ')}`);
    for (const off of [0x24, 0x34, 0x44, 0x54, 0x64, 0x74, 0x84, 0x94]) {
      const arr = rd(el + off), cnt = rd(el + off + 8);
      if (!mem.ok(arr) || cnt > 4096) continue;
      const types = {};
      for (let i = 0; i < Math.min(cnt, 512); i++) {
        const e = rd(arr + 4 * i);
        const t = mem.ok(e) && mem.ok(e + 0x400) ? rd(e + 0x28) : -1;
        types[t] = (types[t] || 0) + 1;
      }
      log(`[explore]   list +0x${off.toString(16)}: array 0x${arr.toString(16)} cap ${rd(el + off + 4)} count ${cnt} types ${JSON.stringify(types)}`);
    }
    for (let base = game; base < game + 0x27000; base += 4) {
      const arr = rd(base + 0x24), cap = rd(base + 0x28), cnt = rd(base + 0x2c);
      if (!mem.ok(arr) || cap < 8 || cap > 8192 || cnt > cap || cnt < 1) continue;
      const types = {};
      let good = 0;
      const n = Math.min(cnt, 64);
      for (let i = 0; i < n; i++) {
        const e = rd(arr + 4 * i);
        if (!mem.ok(e) || !mem.ok(e + 0x400)) continue;
        const t = rd(e + 0x28), x = rf(e + 0x33c), y = rf(e + 0x340);
        if (t < 1 || t > 1100 || !(x > -100 && x < 3000 && y > -100 && y < 3000)) continue;
        types[t] = (types[t] || 0) + 1; good++;
      }
      if (good * 2 >= n && good >= 1) log(`[explore] entity-list candidate: Game+0x${(base - game).toString(16)} array 0x${arr.toString(16)} cap ${cap} count ${cnt} valid ${good}/${n} types ${JSON.stringify(types)}`);
    }
  }

  // Door choice: an open door not given up on in this visit; a target never
  // visited first; then the door used least from this room (the second seed
  // bounced 172 times between a room and its treasure room when "the lowest
  // open slot" was the rule); then the lowest slot.
  const doorUse = new Map();   // "room:slot" -> times walked through
  function chooseDoor(st) {
    const open = st.doors.filter((d) => d.state === 2 && !cur.tried.has(d.slot));
    if (!open.length) return null;
    const key = (d) => `${st.roomIdx}:${d.slot}`;
    open.sort((a, b) => (visited.has(a.target) - visited.has(b.target))
      || ((doorUse.get(key(a)) || 0) - (doorUse.get(key(b)) || 0)) || (a.slot - b.slot));
    const pick = open[0];
    doorUse.set(key(pick), (doorUse.get(key(pick)) || 0) + 1);
    stats.doorAttempts++;
    return pick;
  }

  // Walk toward a point (a pickup, a trapdoor): the dominant axis first;
  // after sidestepAfter still frames, step aside, alternating sides.
  function walkTo(st, x, y, frame) {
    const moved = Math.abs(st.px - cur.lastPos[0]) + Math.abs(st.py - cur.lastPos[1]) > 0.5;
    if (moved) { cur.lastMove = frame; cur.lastPos = [st.px, st.py]; }
    const dx = x - st.px, dy = y - st.py;
    let want = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w');
    const stalled = frame - cur.lastMove;
    if (stalled >= sidestepAfter) {
      const n = Math.floor((stalled - sidestepAfter) / sidestepFor);
      const perp = (want === 'a' || want === 'd') ? ['w', 's'] : ['a', 'd'];
      want = perp[n & 1];
    }
    for (const k of WALK) if (k !== want) release(k);
    press(want);
  }

  function describeRoom(st) {
    return `${st.w}x${st.h}, type ${st.roomType} variant ${st.roomVariant}, bosses ${st.bosses}`;
  }

  function tick(frame, st) {
    // timed releases (menu taps)
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].frame <= frame) { release(pending[i].name); pending.splice(i, 1); }
    }
    if (!st || !st.inGame || st.playerDead) {
      // menus, or the game-over screen after a death: Enter through it; the
      // next run starts a fresh room census
      if (st && st.inGame && st.playerDead && !dead) {
        dead = true; stats.deaths++; releaseAll();
        log(`[explore] frame ${frame}: the player died in room ${st.roomIdx} (run ${stats.runs}); pressing on`);
      }
      stats.menuFrames++;
      if (frame - lastEnter >= menuEvery) { tap('enter', frame, menuHold); lastEnter = frame; }
      return;
    }
    if (dead) { dead = false; cur = null; curFloor = null; stats.runs++; log(`[explore] frame ${frame}: run ${stats.runs} started (floor ${st.floor}, room ${st.roomIdx}, ${describeRoom(st)})`); }
    if (stats.firstRunFrame < 0) {
      stats.firstRunFrame = frame; stats.runs = 1;
      const c = counters(st);
      log(`[explore] run started at frame ${frame} (floor ${st.floor}, room ${st.roomIdx}, ${describeRoom(st)}); coins ${c.coins} bombs ${c.bombs} keys ${c.keys}`);
      if (opts.scanEntityList) {
        const words = [];
        for (let off = 0x1330; off < 0x1380; off += 4) words.push(`+${off.toString(16)}=${rd(st.player + off)}`);
        log(`[explore] player counters region: ${words.join(' ')}`);
      }
      if (opts.scanEntityList) scanEntityList(st.game);
    }
    stats.playFrames++;
    // a new floor within a run (a trapdoor, the console's `stage`): the room
    // list starts over; a new run's first floor is not a change
    if (st.floor !== curFloor) {
      if (curFloor !== null) {
        stats.floorChanges++;
        if (st.stage > Number(curFloor.split('.')[0])) stats.descents++;
        log(`[explore] frame ${frame}: floor ${curFloor} -> ${st.floor} (stage ${st.stage} type ${st.stageType}); room list reset (${visited.size} room(s) on the old floor)`);
      }
      curFloor = st.floor; floorKey = `run${stats.runs}/${st.floor}`;
      visited.clear(); floors[floorKey] = floors[floorKey] || [];
      cur = null; releaseAll();
    }
    if (st.rtState !== 0) {                 // a transition is running: hands off
      if (!transitionSeen) { transitionSeen = true; stats.transitions++; releaseAll(); }
      return;
    }
    if (transitionSeen) { transitionSeen = false; settleUntil = frame + settle; }
    if (!cur || cur.roomPtr !== st.roomPtr || cur.roomIdx !== st.roomIdx) {
      if (cur) log(`[explore] frame ${frame}: room ${cur.roomIdx} -> ${st.roomIdx} (${describeRoom(st)}), doors open ${st.doors.filter((d) => d.state === 2).length}/${st.doors.length}`);
      else if (announce) { announce = false; log(`[explore] frame ${frame}: resumed in room ${st.roomIdx} (${describeRoom(st)}), doors open ${st.doors.filter((d) => d.state === 2).length}/${st.doors.length}`); }
      if (!visited.has(st.roomIdx)) floors[floorKey].push(st.roomIdx);
      visited.add(st.roomIdx);
      if (st.bosses > 0) stats.bossRoomsEntered++;
      cur = { roomIdx: st.roomIdx, roomPtr: st.roomPtr, tried: new Set(), door: null, since: frame, idleSince: -1, lastPos: [st.px, st.py], lastMove: frame, fireAt: frame, aim: -1, pickup: null, trapdoor: null, abandoned: new Set(), bosses: st.bosses };
      releaseAll();
    }
    if (st.bosses < cur.bosses) {
      stats.bossKills += cur.bosses - st.bosses;
      log(`[explore] frame ${frame}: boss down in room ${st.roomIdx} (${cur.bosses} -> ${st.bosses} alive), doors open ${st.doors.filter((d) => d.state === 2).length}/${st.doors.length}`);
      cur.bosses = st.bosses;
    } else if (st.bosses > cur.bosses) cur.bosses = st.bosses;
    if (frame < settleUntil) return;
    // Something to pick up in this room (and no door chosen yet, and the
    // doors are open -- a pickup in a fight is a distraction): walk into it.
    // A pickup that vanishes while targeted counts as collected; one that
    // stays for pickupTimeout frames is abandoned.
    if (!cur.door && st.doors.some((d) => d.state === 2)) {
      const items = livePickups(st).filter((p) => !cur.abandoned.has(p.e));
      if (cur.pickup && !items.some((p) => p.e === cur.pickup.e)) {
        stats.pickupsCollected++;
        const c = counters(st);
        log(`[explore] frame ${frame}: picked up variant ${cur.pickup.v}.${cur.pickup.s} in room ${st.roomIdx}; coins ${c.coins} bombs ${c.bombs} keys ${c.keys} hearts ${rd(st.player + PLAYER.hearts)} (raw +1354..+1368: ${[0x1354, 0x1358, 0x135c, 0x1360, 0x1364, 0x1368].map((o) => rd(st.player + o)).join(',')})`);
        cur.pickup = null; releaseAll();
      }
      if (!cur.pickup && items.length) {
        cur.pickup = { ...items[0], since: frame };
        cur.lastMove = frame; cur.lastPos = [st.px, st.py];
        stats.pickupAttempts++;
        log(`[explore] frame ${frame}: room ${st.roomIdx} -> pickup variant ${cur.pickup.v}.${cur.pickup.s} at (${cur.pickup.x.toFixed(0)}, ${cur.pickup.y.toFixed(0)}) of ${items.length}`);
      }
      if (cur.pickup) {
        const p = cur.pickup;
        if (frame - p.since > pickupTimeout) {
          // the next candidate (another pickup, the trapdoor, then a door) is
          // chosen on the next tick, not the door in this one (round 30: a
          // boss room's pedestal was walked past for the exit)
          log(`[explore] frame ${frame}: giving up on the pickup at (${p.x.toFixed(0)}, ${p.y.toFixed(0)})`);
          cur.abandoned.add(p.e); cur.pickup = null; releaseAll();
          return;
        } else {
          walkTo(st, p.x, p.y, frame);
          return;
        }
      }
      // A trapdoor in a cleared room: the way down. Walk onto it; the stage
      // transition that follows is seen as a floor change above.
      const holes = trapdoors(st).filter((t) => !cur.abandoned.has(t.e));
      if (!cur.trapdoor && holes.length) {
        cur.trapdoor = { ...holes[0], since: frame };
        cur.lastMove = frame; cur.lastPos = [st.px, st.py];
        stats.trapdoorAttempts++;
        log(`[explore] frame ${frame}: room ${st.roomIdx} -> trapdoor at grid ${cur.trapdoor.slot} (${cur.trapdoor.x}, ${cur.trapdoor.y}) state ${cur.trapdoor.state}${cur.trapdoor.idx !== cur.trapdoor.slot ? ' (index field ' + cur.trapdoor.idx + ')' : ''}`);
      }
      if (cur.trapdoor) {
        const t = cur.trapdoor;
        if (!holes.some((h) => h.e === t.e)) { log(`[explore] frame ${frame}: the trapdoor at grid ${t.slot} is gone`); cur.trapdoor = null; releaseAll(); }
        else if (frame - t.since > trapdoorTimeout) {
          log(`[explore] frame ${frame}: giving up on the trapdoor at (${t.x}, ${t.y}); player at (${st.px.toFixed(0)}, ${st.py.toFixed(0)})`);
          cur.abandoned.add(t.e); cur.trapdoor = null; releaseAll();
          return;
        } else {
          walkTo(st, t.x, t.y, frame);
          return;
        }
      }
    }
    if (!cur.door) {
      cur.door = chooseDoor(st);
      if (cur.door) {
        cur.since = frame; cur.lastMove = frame; cur.lastPos = [st.px, st.py]; cur.idleSince = -1;
        log(`[explore] frame ${frame}: room ${st.roomIdx} -> door slot ${cur.door.slot} at (${cur.door.tx}, ${cur.door.ty}) target ${cur.door.target}${visited.has(cur.door.target) ? ' (seen)' : ''}`);
      } else {
        if (cur.idleSince < 0) {
          cur.idleSince = frame;
          log(`[explore] frame ${frame}: room ${st.roomIdx} has no untried open door (${st.doors.map((d) => d.slot + ':' + d.state).join(' ')}); patrolling and firing`);
        }
      }
    }
    // hunting (doors closed): the nearest live NPC sets the aim before the
    // fire tap below and the chase after it
    const enemies = cur.door ? [] : liveEnemies(st);
    if (enemies.length) {
      const n = enemies[0], dx = n.x - st.px, dy = n.y - st.py;
      cur.aim = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 2 : 0) : (dy > 0 ? 3 : 1);
    } else cur.aim = -1;
    // fire: an arrow tap every 10 frames; toward the door while walking, at
    // the hunted enemy when there is one, rotating otherwise
    if (frame >= cur.fireAt) {
      const dir = cur.door ? (cur.door.slot & 3) : (cur.aim >= 0 ? cur.aim : (Math.floor(frame / 10) & 3));
      tap(FIRE[dir], frame, 4);
      cur.fireAt = frame + 10;
    }
    if (!cur.door) {
      // Closed doors mean enemies. Hunt: chase the nearest live NPC and fire
      // along the axis it is farther on; when none is known, patrol (a new
      // walk direction every 45 frames) so the tears reach something. Doors
      // that reopen are picked up on the next frame; tried doors are
      // forgotten periodically.
      const idle = frame - cur.idleSince;
      if (idle === 1 || (idle > 0 && idle % 600 === 0)) {
        log(`[explore] frame ${frame}: room ${st.roomIdx} idle ${idle} frames, player at (${st.px.toFixed(0)}, ${st.py.toFixed(0)}) dead=${st.playerDead}, doors ${st.doors.map((d) => d.slot + ':' + d.state).join(' ')}, bosses ${st.bosses}, enemies ${enemies.length}${enemies.length ? ' nearest t' + enemies[0].t + ' at (' + enemies[0].x.toFixed(0) + ',' + enemies[0].y.toFixed(0) + ')' : ''}`);
        if (opts.census) npcCensus(st, frame);
      }
      let want;
      if (enemies.length) {
        const n = enemies[0], dx = n.x - st.px, dy = n.y - st.py;
        const horiz = Math.abs(dx) >= Math.abs(dy);
        // walk along the other axis to line up, alternating when the lined-up
        // axis is blocked (rocks): every 60 frames swap the roles
        const swap = Math.floor(idle / 60) & 1;
        const lineUp = horiz !== !!swap;
        if (lineUp) want = Math.abs(dy) > 12 ? (dy > 0 ? 's' : 'w') : (dx > 0 ? 'd' : 'a');
        else want = Math.abs(dx) > 12 ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w');
        stats.huntFrames++;
      } else {
        want = WALK[Math.floor(idle / 45) & 3];
      }
      for (const k of WALK) if (k !== want) release(k);
      press(want);
      if (idle > 0 && idle % doorTimeout === 0) cur.tried.clear();
      return;
    }
    const d = cur.door, side = d.slot & 3;
    const moved = Math.abs(st.px - cur.lastPos[0]) + Math.abs(st.py - cur.lastPos[1]) > 0.5;
    if (moved) { cur.lastMove = frame; cur.lastPos = [st.px, st.py]; }
    const giveUp = (frame - cur.since > doorTimeout) || (frame - cur.lastMove > stuckFrames);
    if (giveUp) {
      if (frame - cur.since > doorTimeout) stats.doorTimeouts++; else stats.stuck++;
      log(`[explore] frame ${frame}: giving up on door ${d.slot} (${frame - cur.since} frames, player at ${st.px.toFixed(0)},${st.py.toFixed(0)})`);
      cur.tried.add(d.slot); cur.door = null; releaseAll();
      return;
    }
    // line up on the axis along the wall, then walk through
    let want;
    if (side === 0 || side === 2) {          // west / east door: match y, then walk x
      if (st.py > d.ty + align) want = 'w'; else if (st.py < d.ty - align) want = 's'; else want = WALK[side];
    } else {                                 // north / south door: match x, then walk y
      if (st.px > d.tx + align) want = 'a'; else if (st.px < d.tx - align) want = 'd'; else want = WALK[side];
    }
    // an obstacle (a rock) in the way: after `sidestepAfter` frames without
    // movement, step sideways for `sidestepFor` frames, alternating sides
    const stalled = frame - cur.lastMove;
    if (stalled >= sidestepAfter) {
      const n = Math.floor((stalled - sidestepAfter) / sidestepFor);
      if ((stalled - sidestepAfter) % sidestepFor < sidestepFor) {
        const perp = (want === 'a' || want === 'd') ? ['w', 's'] : ['a', 'd'];
        want = perp[n & 1];
        if ((stalled - sidestepAfter) % sidestepFor === 0) stats.sidesteps++;
      }
    }
    for (const k of WALK) if (k !== want) release(k);
    press(want);
  }

  return {
    // Module.isaacInputPoll contract: fill out[0..3] with one event, return 1; or 0.
    poll(frame, out, heap32) {
      if (!suspended && frame !== lastFrame) { lastFrame = frame; tick(frame, readState()); }
      if (!queue.length) return 0;
      heap32.set(queue.shift(), out >> 2);
      return 1;
    },
    // Another driver (the console) takes the keys: release everything now and
    // stop ticking; resume() re-reads the room, which may be on another floor.
    suspend(frame) {
      if (suspended) return;
      suspended = true; stats.suspensions++;
      for (const p of pending) release(p.name);
      pending.length = 0; releaseAll();
      log(`[explore] frame ${frame}: suspended, ${queue.length} release(s) queued`);
    },
    resume(frame) {
      if (!suspended) return;
      suspended = false; cur = null; announce = true; settleUntil = frame + settle; lastFrame = -1;
      log(`[explore] frame ${frame}: resumed`);
    },
    suspended: () => suspended,
    state: readState,
    report() {
      const st = readState();
      const game = rd(GAME_PTR);
      return { ...stats, roomsVisited: visited.size, rooms: [...visited], floor: curFloor, floors,
        counters: st && st.inGame ? counters(st) : null,
        debugFlags: game ? '0x' + rd(game + OFF.debugFlags).toString(16) : null };
    },
  };
}

// The debug console, driven through the game's own history recall: open it
// with the grave key, UP until the input line reads the wanted command
// (cmd_history.txt is seeded with the commands, consoleSeedFiles above),
// Enter runs it and clears the line, Enter on the empty line closes the
// console (Console::Update 0x0068b260: 0x60 opens; 0x109/0x108 walk the
// history; 0x101/0x14f submit -- FUN_00686b70 -- or, empty, close through
// FUN_00686950). Every step is verified against the console's own state, so
// a key that did not land is retried and a command that never appears in
// the line is reported, not assumed. `type` mode presses the characters'
// keys first (planTyping) and falls back to recall when the line stays
// empty, which is what happens without WM_CHAR.
export function makeConsole(mem, opts = {}) {
  const log = opts.log || (() => {});
  const commands = [...(opts.commands || [])].map((c) => c.trim()).filter(Boolean);
  const mode = opts.mode === 'type' ? 'type' : 'recall';
  const ready = opts.ready || (() => true);
  const hold = opts.hold ?? 3;                       // frames a key stays down (the engine samples per frame; >= 2)
  const settle = opts.settle ?? 4;                   // frames after a release before the state is read
  const retryEvery = opts.retryEvery ?? 45;          // frames between open/close retries
  const openTimeout = opts.openTimeout ?? 300;
  const closeTimeout = opts.closeTimeout ?? 300;
  const submitTimeout = opts.submitTimeout ?? 120;
  const maxUps = opts.maxUps ?? 80;
  const { rd, rs } = readers(mem);

  const queue = [], held = new Set(), pending = [];
  let phase = commands.length ? 'idle' : 'done';
  let idx = 0, ups = 0, sameCount = 0, lastLine = null, phaseSince = -1, lastTap = -1e9, lastFrame = -1, closeTaps = 0, typing = null, typePos = 0;
  const stats = { mode, commands, executed: [], failed: [], openedAt: -1, closedAt: -1, ups: 0, openFailed: false, closeFailed: false, typedMismatches: 0, history: null, lastState: null };

  function press(name) { if (!held.has(name)) { held.add(name); queue.push(keyEvent(name, true)); } }
  function release(name) { if (held.has(name)) { held.delete(name); queue.push(keyEvent(name, false)); } }
  function tap(name, frame) { press(name); pending.push({ frame: frame + hold, name }); lastTap = frame; }
  function readGame() {
    const game = rd(GAME_PTR);
    if (!game) return null;
    return { game, state: rd(game + CONSOLE.state) | 0, line: rs(game + CONSOLE.line) };
  }
  function history(game) {
    const buf = rd(game + CONSOLE.histBuf), cap = rd(game + CONSOLE.histCap), head = rd(game + CONSOLE.histHead), count = rd(game + CONSOLE.histCount);
    if (!buf || !cap || cap > 4096 || count > cap) return [];
    const out = [];
    for (let i = 0; i < Math.min(count, 64); i++) {
      const s = rd(buf + 4 * ((head + i) & (cap - 1)));
      out.push(s ? rs(s) : '');
    }
    return out;
  }
  function next(frame) {
    idx++; ups = 0; sameCount = 0; lastLine = null; typing = null;
    phase = idx < commands.length ? 'recall' : 'close';
    phaseSince = frame;
  }
  function tick(frame) {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].frame <= frame) { release(pending[i].name); pending.splice(i, 1); }
    const busy = pending.length > 0 || frame - lastTap < hold + settle;
    const g = readGame();
    if (g) stats.lastState = g.state;
    switch (phase) {
      case 'idle':
        if (g && ready(frame)) { phase = 'open'; phaseSince = frame; log(`[console] frame ${frame}: opening the console for ${commands.length} command(s): ${commands.map((c) => JSON.stringify(c)).join(' ')}`); }
        break;
      case 'open':
        if (g && g.state === 2) {
          stats.openedAt = frame; stats.history = history(g.game);
          log(`[console] frame ${frame}: console open (state 2) after ${frame - phaseSince} frames; history holds ${stats.history.length} line(s): ${stats.history.map((s) => JSON.stringify(s)).join(' ')}`);
          phase = 'recall'; phaseSince = frame;
          break;
        }
        if (frame - phaseSince > openTimeout) {
          stats.openFailed = true; phase = 'done';
          log(`[console] frame ${frame}: the console did not open in ${openTimeout} frames (state ${g ? g.state : 'no game'}); giving up`);
          break;
        }
        if (!busy && frame - lastTap >= retryEvery) { tap('grave', frame); log(`[console] frame ${frame}: grave tapped (state ${g ? g.state : 'no game'})`); }
        break;
      case 'recall': {
        if (busy || !g) break;
        if (g.state !== 2) { log(`[console] frame ${frame}: the console closed under us (state ${g.state}); reopening`); phase = 'open'; phaseSince = frame; break; }
        const want = commands[idx];
        if (g.line === want) {
          log(`[console] frame ${frame}: line reads ${JSON.stringify(want)} after ${ups} UP(s)${typing ? ' (typed)' : ''}; Enter`);
          phase = 'submit'; phaseSince = frame; tap('enter', frame);
          break;
        }
        if (mode === 'type' && typing === null) { typing = planTyping(want); typePos = 0; }
        if (typing && typePos < typing.length) {
          const k = typing[typePos++];
          if (k.shift) { press('shift'); pending.push({ frame: frame + hold + 1, name: 'shift' }); }
          tap(k.key, frame);
          break;
        }
        if (typing && typePos >= typing.length && !typing.checked) {
          typing.checked = true;
          stats.typedMismatches++;
          log(`[console] frame ${frame}: typed ${typing.length} key(s) for ${JSON.stringify(want)}, the line reads ${JSON.stringify(g.line)}: typed characters do not reach the console (no WM_CHAR); falling back to history recall`);
          if (g.line.length) { tap('down', frame); break; }     // DOWN at the head clears the line (Console::Update)
        }
        if (g.line === lastLine) sameCount++; else sameCount = 0;
        lastLine = g.line;
        if (ups >= maxUps || sameCount >= 3) {
          stats.failed.push({ cmd: want, reason: `not recalled after ${ups} UP(s); line ${JSON.stringify(g.line)}` });
          log(`[console] frame ${frame}: ${JSON.stringify(want)} never appeared in the line after ${ups} UP(s) (line ${JSON.stringify(g.line)}); skipping it`);
          next(frame);
          break;
        }
        tap('up', frame); ups++; stats.ups++;
        break;
      }
      case 'submit':
        if (!g) break;
        if (g.line.length === 0) {
          stats.executed.push({ cmd: commands[idx], frame, clearedAfter: frame - phaseSince });
          log(`[console] frame ${frame}: ${JSON.stringify(commands[idx])} executed (line cleared after ${frame - phaseSince} frame(s), state ${g.state})`);
          next(frame);
        } else if (frame - phaseSince > submitTimeout) {
          stats.failed.push({ cmd: commands[idx], reason: `line not cleared ${submitTimeout} frames after Enter; line ${JSON.stringify(g.line)}` });
          log(`[console] frame ${frame}: ${JSON.stringify(commands[idx])} was not executed (line still ${JSON.stringify(g.line)} after ${submitTimeout} frames)`);
          next(frame);
        } else if (!busy && frame - lastTap >= retryEvery) tap('enter', frame);
        break;
      case 'close':
        if (busy || !g) break;
        if (g.state === 0) {
          stats.closedAt = frame; phase = 'done';
          log(`[console] frame ${frame}: console closed after ${frame - phaseSince} frames; ${stats.executed.length}/${commands.length} command(s) executed`);
          break;
        }
        if (frame - phaseSince > closeTimeout) {
          stats.closeFailed = true; phase = 'done';
          log(`[console] frame ${frame}: the console did not close in ${closeTimeout} frames (state ${g.state}); giving up`);
          break;
        }
        if (frame - lastTap >= retryEvery) {
          // a leftover line would be executed by Enter: clear it first; then
          // Enter on the empty line (FUN_00686950), Escape as the fallback
          const key = g.line.length ? 'down' : (closeTaps++ < 2 ? 'enter' : 'escape');
          tap(key, frame);
          log(`[console] frame ${frame}: closing: ${key} tapped (state ${g.state}, line ${JSON.stringify(g.line)})`);
        }
        break;
      default: break;
    }
  }

  return {
    poll(frame, out, heap32) {
      if (frame !== lastFrame) { lastFrame = frame; tick(frame); }
      if (!queue.length) return 0;
      heap32.set(queue.shift(), out >> 2);
      return 1;
    },
    active: () => phase !== 'idle' && phase !== 'done',
    done: () => phase === 'done',
    phase: () => phase,
    report: () => ({ ...stats, phase }),
  };
}
