// Round 27: the door-aware explorer (scripts/recomp/lift/explore.mjs).
//
// It reads Game / room / doors / players out of guest memory and emits Win32
// key events through the node driver's Module.isaacInputPoll. These tests run
// the brain against a fake guest heap: menus get Enters, an open door gets a
// line-up then a walk-through, a transition is counted once and hands are
// off while it runs, a door that never opens times out and the next one is
// tried, and the report is an exact census.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeExplorer, GAME_PTR, OFF, VT_NPC, VT_PICKUP, VT_TRAPDOOR, GRID, ENT, PLAYER } from '../scripts/recomp/lift/explore.mjs';

const VK = { enter: 0x0D, a: 0x41, d: 0x44, s: 0x53, w: 0x57, left: 0x25, up: 0x26, right: 0x27, down: 0x28 };
const NAME = Object.fromEntries(Object.entries(VK).map(([k, v]) => [v, k]));

function fakeHeap() {
  const u = new Map(), f = new Map();
  const mem = {
    ok: (va) => va >= 0x00400000 && va < 0x34000000,
    u32: (va) => u.get(va) || 0,
    f32: (va) => f.get(va) || 0,
  };
  return { mem, u, f };
}

// A game with one player in a 13x7 room whose east door (slot 2) is open and
// leads to room 85; the player stands at (320, 380).
function world({ doorOpen = true } = {}) {
  const h = fakeHeap();
  const game = 0x01000000, room = 0x01100000, player = 0x01200000, door = 0x01300000, pvec = 0x01400000;
  h.u.set(GAME_PTR, game);
  h.u.set(game + OFF.room, room);
  h.u.set(game + OFF.roomIdx, 84);
  h.u.set(game + OFF.rt, 0);
  h.u.set(game + OFF.playersBegin, pvec);
  h.u.set(game + OFF.playersEnd, pvec + 4);
  h.u.set(pvec, player);
  h.u.set(room + OFF.roomW, 13);
  h.u.set(room + OFF.roomH, 7);
  h.u.set(room + OFF.doors + 4 * 2, door);
  h.u.set(door + OFF.doorState, doorOpen ? 2 : 1);
  h.u.set(door + OFF.doorGrid, 3 * 13 + 12);        // grid row 3, last column -> centre (520, 240) +18 -> (538+? see below)
  h.u.set(door + OFF.doorTarget, 85);
  h.f.set(player + OFF.posX, 320);
  h.f.set(player + OFF.posY, 380);
  return { ...h, game, room, player, door };
}

function drain(ex, frame, heap32, out = 64) {
  const evs = [];
  while (ex.poll(frame, out, heap32)) evs.push([...heap32.subarray(out >> 2, (out >> 2) + 4)]);
  return evs.map((e) => ({ key: NAME[e[1]], down: e[3] === 1 }));
}

test('menus: an Enter tap every menuEvery frames while no run exists', () => {
  const h = fakeHeap();                       // no game pointer at all
  const ex = makeExplorer(h.mem, { menuEvery: 40, menuHold: 12 });
  const heap32 = new Int32Array(64);
  const presses = [];
  for (let f = 0; f < 130; f++) for (const e of drain(ex, f, heap32)) presses.push([f, e.key, e.down]);
  assert.deepEqual(presses, [[0, 'enter', true], [12, 'enter', false], [40, 'enter', true], [52, 'enter', false],
    [80, 'enter', true], [92, 'enter', false], [120, 'enter', true]]);
  assert.equal(ex.report().menuFrames, 130);
  assert.equal(ex.report().firstRunFrame, -1);
});

test('play: line up with the east door (W/S on y), then hold D; arrows fire toward it', () => {
  const w = world();
  const ex = makeExplorer(w.mem, { settle: 0 });
  const heap32 = new Int32Array(64);
  // door grid index 3*13+12 -> tx = 12*40+40+18 = 538, ty = 3*40+120 = 240
  const ev0 = drain(ex, 100, heap32);
  assert.deepEqual(ev0.filter((e) => e.key === 'w' || e.key === 's').map((e) => [e.key, e.down]), [['w', true]], 'player at y=380 must move up toward y=240');
  assert.ok(ev0.some((e) => e.key === 'right' && e.down), 'fires toward the east door');
  // the player reaches the door row: W released, D pressed
  w.f.set(w.player + OFF.posY, 242);
  const ev1 = drain(ex, 101, heap32);
  assert.deepEqual(ev1.filter((e) => e.key === 'w' || e.key === 'd').map((e) => [e.key, e.down]), [['w', false], ['d', true]]);
  const r = ex.report();
  assert.equal(r.firstRunFrame, 100);
  assert.equal(r.doorAttempts, 1);
  assert.deepEqual(r.rooms, [84]);
});

test('a transition releases every key, is counted once, and the new room is a fresh visit', () => {
  const w = world();
  const ex = makeExplorer(w.mem, { settle: 0 });
  const heap32 = new Int32Array(64);
  drain(ex, 10, heap32);
  w.f.set(w.player + OFF.posY, 240);
  drain(ex, 11, heap32);                                   // now holding D
  w.u.set(w.game + OFF.rt, 1);                             // transition starts
  const ev = drain(ex, 12, heap32);
  assert.ok(ev.some((e) => e.key === 'd' && !e.down), 'D released when the transition starts');
  assert.deepEqual(drain(ex, 13, heap32), [], 'hands off while it runs');
  assert.equal(ex.report().transitions, 1);
  // the transition ends in room 85 (a different room object, west door open back to 84)
  w.u.set(w.game + OFF.rt, 0);
  w.u.set(w.game + OFF.roomIdx, 85);
  const room2 = 0x01500000, door2 = 0x01600000;
  w.u.set(w.game + OFF.room, room2);
  w.u.set(room2 + OFF.roomW, 13); w.u.set(room2 + OFF.roomH, 7);
  w.u.set(room2 + OFF.doors + 0, door2);
  w.u.set(door2 + OFF.doorState, 2); w.u.set(door2 + OFF.doorGrid, 3 * 13); w.u.set(door2 + OFF.doorTarget, 84);
  drain(ex, 14, heap32);
  const r = ex.report();
  assert.equal(r.transitions, 1);
  assert.equal(r.roomsVisited, 2);
  assert.deepEqual(r.rooms, [84, 85]);
});

test('a closed door is not attempted: the explorer patrols (a new direction every 45 frames) and fires', () => {
  const w = world({ doorOpen: false });
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, doorTimeout: 50, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  const walkPresses = [], fires = [];
  for (let f = 0; f < 120; f++) for (const e of drain(ex, f, heap32)) {
    if (['a', 'w', 'd', 's'].includes(e.key) && e.down) walkPresses.push([f, e.key]);
    if (['left', 'up', 'right', 'down'].includes(e.key) && e.down) fires.push(f);
  }
  assert.deepEqual(walkPresses, [[0, 'a'], [45, 'w'], [90, 'd']], 'patrol: west, north, east, ... every 45 frames');
  assert.equal(fires.length, 12, 'an arrow tap every 10 frames');
  assert.equal(ex.report().doorAttempts, 0);
  assert.equal(log.filter((s) => /no untried open door/.test(s)).length, 1, 'the idle notice is printed once per idle spell');
});

test('an open door the player cannot reach is given up after doorTimeout and marked tried', () => {
  const w = world();
  const ex = makeExplorer(w.mem, { settle: 0, doorTimeout: 30, stuckFrames: 1000 });
  const heap32 = new Int32Array(64);
  const log = [];
  const ex2 = makeExplorer(w.mem, { settle: 0, doorTimeout: 30, stuckFrames: 1000, log: (s) => log.push(s) });
  for (let f = 0; f < 40; f++) { drain(ex, f, heap32); drain(ex2, f, heap32); w.f.set(w.player + OFF.posY, 380 - f); }
  const r = ex2.report();
  assert.equal(r.doorTimeouts, 1);
  assert.equal(r.doorAttempts, 1, 'the only open door was tried once; nothing else to try');
  assert.ok(log.some((s) => /giving up on door 2/.test(s)), log.join('\n'));
});

test('hunt: with the doors closed, chase the nearest live NPC and fire along its dominant axis; the dead flag excludes corpses', () => {
  const w = world({ doorOpen: false });
  // two NPC objects found by vtable: a live one east of the player and a
  // dead one much closer (dead flag +0x173 set); the pool scan is faked
  const live = 0x02000000, corpse = 0x02100000;
  for (const [e, x, y, dead] of [[live, 520, 380, 0], [corpse, 330, 380, 1]]) {
    w.u.set(e, VT_NPC); w.u.set(e + ENT.type, 244); w.u.set(e + ENT.variant, 0);
    w.f.set(e + ENT.posX, x); w.f.set(e + ENT.posY, y);
    w.u.set(e + (ENT.dead & ~3), dead << ((ENT.dead & 3) * 8));
  }
  w.mem.findAll = (value) => (value === VT_NPC ? [live, corpse] : []);
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  const walks = [], fires = [];
  for (let f = 0; f < 30; f++) for (const e of drain(ex, f, heap32)) {
    if (['a', 'w', 'd', 's'].includes(e.key) && e.down) walks.push(e.key);
    if (['left', 'up', 'right', 'down'].includes(e.key) && e.down) fires.push(e.key);
  }
  assert.deepEqual([...new Set(fires)], ['right'], 'fires east, at the live enemy, not at the nearer corpse');
  assert.deepEqual([...new Set(walks)], ['d'], 'lined up on y already: walks east toward it');
  assert.ok(ex.report().huntFrames > 0);
  assert.ok(log.some((s) => /enemies 1 nearest t244 at \(520,380\)/.test(s)), log.join('\n'));
});

test('an obstacle on the way to a door: after 30 still frames the walk steps aside, alternating, and resumes', () => {
  const w = world();
  const ex = makeExplorer(w.mem, { settle: 0, sidestepAfter: 30, sidestepFor: 25, stuckFrames: 1000, doorTimeout: 1000 });
  const heap32 = new Int32Array(64);
  const presses = [];
  for (let f = 0; f < 120; f++) for (const e of drain(ex, f, heap32)) if (['a', 'w', 'd', 's'].includes(e.key) && e.down) presses.push([f, e.key]);
  // heading north to the door row (W) and never moving: W, then A for 25, then D for 25, then A...
  assert.deepEqual(presses.slice(0, 4), [[0, 'w'], [30, 'a'], [55, 'd'], [80, 'a']]);
  assert.equal(ex.report().sidesteps, 4);
});

test('pickups: with the doors open, walk into the nearest live pickup first; its vanishing counts as collected', () => {
  const w = world();
  const coin = 0x02200000, dead = 0x02300000;
  for (const [e, x, y, deadFlag] of [[coin, 320, 300, 0], [dead, 330, 380, 1]]) {
    w.u.set(e, VT_PICKUP); w.u.set(e + ENT.type, 5); w.u.set(e + ENT.variant, 20); w.u.set(e + ENT.subtype, 1);
    w.f.set(e + ENT.posX, x); w.f.set(e + ENT.posY, y);
    w.u.set(e + (ENT.dead & ~3), deadFlag << ((ENT.dead & 3) * 8));
  }
  w.u.set(w.player + PLAYER.coins, 0);
  w.mem.findAll = (value) => (value === VT_PICKUP ? [coin, dead] : []);
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  const ev0 = drain(ex, 5, heap32);
  assert.deepEqual(ev0.filter((e) => ['a', 'w', 'd', 's'].includes(e.key)).map((e) => [e.key, e.down]), [['w', true]], 'the coin is north of the player: W');
  assert.equal(ex.report().pickupAttempts, 1);
  assert.equal(ex.report().doorAttempts, 0, 'no door chosen while a pickup is live');
  // the coin is collected: its type resets and the counter rises
  w.u.set(coin + ENT.type, 0); w.u.set(w.player + PLAYER.coins, 1);
  const ev1 = drain(ex, 6, heap32);
  assert.ok(ev1.some((e) => e.key === 'w' && !e.down), 'W released once it is gone');
  const r = ex.report();
  assert.equal(r.pickupsCollected, 1);
  assert.equal(r.counters.coins, 1);
  assert.ok(log.some((s) => /picked up variant 20\.1 in room 84; coins 1 bombs 0 keys 0/.test(s)), log.join('\n'));
  assert.equal(ex.report().doorAttempts, 1, 'then a door is chosen');
});

test('an abandoned pickup gives way to the next pickup (a boss room: the heart, then the pedestal), not to the door', () => {
  const w = world();
  const heart = 0x02200000, pedestal = 0x02400000;
  for (const [e, v, s, x, y] of [[heart, 10, 2, 320, 300], [pedestal, 100, 659, 320, 200]]) {
    w.u.set(e, VT_PICKUP); w.u.set(e + ENT.type, 5); w.u.set(e + ENT.variant, v); w.u.set(e + ENT.subtype, s);
    w.f.set(e + ENT.posX, x); w.f.set(e + ENT.posY, y);
  }
  w.mem.findAll = (value) => (value === VT_PICKUP ? [heart, pedestal] : []);
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, pickupTimeout: 20, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  for (let f = 0; f < 30; f++) drain(ex, f, heap32);          // the heart (nearer) is never collected: abandoned at 21, the pedestal chosen at 22
  let r = ex.report();
  assert.equal(r.pickupAttempts, 2, 'the pedestal is tried next');
  assert.equal(r.doorAttempts, 0, 'no door while a pickup is still worth trying');
  assert.ok(log.some((s) => /-> pickup variant 100\.659 at \(320, 200\) of 1/.test(s)), log.join('\n'));
  for (let f = 30; f < 60; f++) drain(ex, f, heap32);         // the pedestal times out too (frame 43): then the door
  r = ex.report();
  assert.equal(r.pickupAttempts, 2);
  assert.equal(r.doorAttempts, 1, 'nothing left to pick up: a door');
});

test('door choice spreads out: an unvisited target first, then the door used least from this room', () => {
  const w = world();
  // a second open door (south, slot 3) leading to room 97; the east door (slot 2) leads to 85
  const door3 = 0x01700000;
  w.u.set(w.room + OFF.doors + 4 * 3, door3);
  w.u.set(door3 + OFF.doorState, 2); w.u.set(door3 + OFF.doorGrid, 6 * 13 + 6); w.u.set(door3 + OFF.doorTarget, 97);
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  drain(ex, 1, heap32);
  assert.match(log.at(-1), /door slot 2 .* target 85/, 'both unvisited: the lowest slot');
  // come back to room 84 twice (via transitions) with 85 visited: slot 3 (target 97, unvisited) wins;
  // with both visited: slot 3 again, because slot 2 has been used once more
  const bounce = (f, viaRoom) => {
    w.u.set(w.game + OFF.rt, 1); drain(ex, f, heap32);
    w.u.set(w.game + OFF.rt, 0); w.u.set(w.game + OFF.roomIdx, viaRoom); drain(ex, f + 1, heap32);
    w.u.set(w.game + OFF.rt, 1); drain(ex, f + 2, heap32);
    w.u.set(w.game + OFF.rt, 0); w.u.set(w.game + OFF.roomIdx, 84); drain(ex, f + 3, heap32);
  };
  bounce(10, 85);
  assert.match(log.at(-1), /door slot 3 .* target 97/, '97 is unvisited');
  bounce(20, 97);
  assert.match(log.at(-1), /door slot 2 .* target 85 \(seen\)/, 'both seen, both used once: the tie goes to the lowest slot');
  bounce(30, 85);
  assert.match(log.at(-1), /door slot 3 .* target 97 \(seen\)/, 'slot 2 used twice, slot 3 once: the least-used door');
  bounce(40, 97);
  assert.match(log.at(-1), /door slot 2 .* target 85 \(seen\)/, 'and back: the doors alternate instead of one winning forever');
});

test('death: keys released, Enter through the game-over screen, the next run is counted', () => {
  const w = world();
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, menuEvery: 40, menuHold: 12, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  drain(ex, 10, heap32);                                   // alive: heading for the door (W held)
  w.u.set(w.player + (ENT.dead & ~3), 1 << ((ENT.dead & 3) * 8));   // +0x173 = 1
  const ev = drain(ex, 11, heap32);
  assert.ok(ev.some((e) => e.key === 'w' && !e.down), 'the held key is released on death');
  assert.ok(ev.some((e) => e.key === 'enter' && e.down), 'Enter taps start at once');
  let r = ex.report();
  assert.equal(r.deaths, 1); assert.equal(r.runs, 1);
  assert.ok(log.some((s) => /the player died in room 84 \(run 1\)/.test(s)), log.join('\n'));
  for (let f = 12; f < 100; f++) drain(ex, f, heap32);   // game over: only Enters
  // a new run: alive again in a new room; its first floor is a fresh census, not a floor change
  w.u.set(w.player + (ENT.dead & ~3), 0);
  w.u.set(w.game + OFF.roomIdx, 90);
  drain(ex, 100, heap32);
  r = ex.report();
  assert.equal(r.runs, 2);
  assert.deepEqual(r.rooms, [90]);
  assert.deepEqual(r.floors, { 'run1/0.0': [84], 'run2/0.0': [90] });
  assert.equal(r.floorChanges, 0);
  assert.ok(log.some((s) => /run 2 started \(floor 0\.0, room 90/.test(s)), log.join('\n'));
});

// ---- round 30: floors, the trapdoor, bosses, suspend/resume ----------------

test('a floor change (Game+0 / +4: stage, type) resets the room list; the old floor keeps its census', () => {
  const w = world();
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  drain(ex, 1, heap32);
  assert.equal(ex.report().floor, '0.0');
  // the console's `stage 2`: the stage number changes and the room is a new object
  w.u.set(w.game + OFF.stage, 2);
  w.u.set(w.game + OFF.roomIdx, 90);
  const room2 = 0x01500000, door2 = 0x01600000;
  w.u.set(w.game + OFF.room, room2);
  w.u.set(room2 + OFF.roomW, 13); w.u.set(room2 + OFF.roomH, 7);
  w.u.set(room2 + OFF.doors + 0, door2);
  w.u.set(door2 + OFF.doorState, 2); w.u.set(door2 + OFF.doorGrid, 3 * 13); w.u.set(door2 + OFF.doorTarget, 84);
  drain(ex, 2, heap32);
  const r = ex.report();
  assert.equal(r.floor, '2.0');
  assert.equal(r.floorChanges, 1);
  assert.equal(r.descents, 1, 'stage 0 -> 2 is a descent');
  assert.deepEqual(r.rooms, [90], 'the room list starts over on the new floor');
  assert.deepEqual(r.floors, { 'run1/0.0': [84], 'run1/2.0': [90] });
  assert.ok(log.some((s) => /floor 0\.0 -> 2\.0 \(stage 2 type 0\); room list reset \(1 room\(s\) on the old floor\)/.test(s)), log.join('\n'));
  // room 84 on the new floor is unvisited again: the west door (target 84) is taken
  assert.match(log.at(-1), /door slot 0 .* target 84$/);
});

test('a trapdoor in a cleared room (grid slot by vtable) is walked onto before any door; it is censused with its cell', () => {
  const w = world();
  const hole = 0x01800000, slot = 3 * 13 + 6;             // row 3, col 6 -> cell centre (280, 240)
  w.u.set(w.room + OFF.grid + 4 * slot, hole);
  w.u.set(hole, VT_TRAPDOOR); w.u.set(hole + GRID.index, slot); w.u.set(hole + GRID.state, 1);
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  const ev = drain(ex, 1, heap32);
  assert.deepEqual(ev.filter((e) => ['a', 'w', 'd', 's'].includes(e.key)).map((e) => [e.key, e.down]), [['w', true]], 'the trapdoor is north of the player (380 -> 240): W');
  const r = ex.report();
  assert.equal(r.trapdoorAttempts, 1);
  assert.equal(r.doorAttempts, 0, 'no door while a trapdoor is there');
  assert.ok(log.some((s) => /room 84 -> trapdoor at grid 45 \(280, 240\) state 1$/.test(s)), log.join('\n'));
  // lined up on x, it keeps walking north until the game takes over (a floor change)
  w.f.set(w.player + OFF.posX, 280); w.f.set(w.player + OFF.posY, 300);
  const ev2 = drain(ex, 2, heap32);
  assert.ok(!ev2.some((e) => e.key === 'w' && !e.down), 'W stays down');
  // a trapdoor the player cannot reach is abandoned after trapdoorTimeout and a door is chosen
  const ex2 = makeExplorer(w.mem, { settle: 0, trapdoorTimeout: 20, log: () => {} });
  for (let f = 0; f < 30; f++) drain(ex2, f, heap32);
  assert.equal(ex2.report().doorAttempts, 1);
});

test('bosses: room+0x7224 counts the live bosses; entering a boss room and each kill are censused, the room type/variant come from the config', () => {
  const w = world({ doorOpen: false });
  const desc = 0x01900000, cfg = 0x01a00000;
  w.u.set(w.room + OFF.roomDesc, desc); w.u.set(desc + OFF.descData, cfg);
  w.u.set(cfg + OFF.cfgType, 5); w.u.set(cfg + OFF.cfgVariant, 1010);
  w.u.set(w.room + OFF.bosses, 1);
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  drain(ex, 1, heap32);
  assert.ok(log.some((s) => /run started at frame 1 \(floor 0\.0, room 84, 13x7, type 5 variant 1010, bosses 1\)/.test(s)), log.join('\n'));
  assert.equal(ex.report().bossRoomsEntered, 1);
  w.u.set(w.room + OFF.bosses, 0);
  drain(ex, 2, heap32);
  assert.equal(ex.report().bossKills, 1);
  assert.ok(log.some((s) => /boss down in room 84 \(1 -> 0 alive\)/.test(s)), log.join('\n'));
});

test('suspend releases every held key and stops the brain; resume re-reads the room and carries on', () => {
  const w = world();
  const log = [];
  const ex = makeExplorer(w.mem, { settle: 0, log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  drain(ex, 1, heap32);                                    // W held toward the door row
  ex.suspend(2);
  const ev = drain(ex, 2, heap32);
  assert.ok(ev.some((e) => e.key === 'w' && !e.down), 'W released on suspend');
  assert.equal(ex.suspended(), true);
  for (let f = 3; f < 60; f++) assert.deepEqual(drain(ex, f, heap32), [], 'silent while suspended');
  assert.equal(ex.report().suspensions, 1);
  w.u.set(w.game + OFF.roomIdx, 91);                       // the console moved us
  ex.resume(60);
  const ev2 = drain(ex, 61, heap32);
  assert.ok(ev2.some((e) => e.key === 'w' && e.down), 'walking again');
  assert.ok(log.some((s) => /resumed in room 91/.test(s)), log.join('\n'));
  assert.deepEqual(ex.report().rooms, [84, 91]);
});
