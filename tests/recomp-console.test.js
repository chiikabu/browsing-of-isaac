// Round 30: the debug console through the node driver (scripts/recomp/lift/
// explore.mjs: KEYS, planTyping, consoleSeedFiles, makeConsole, censusFromLog).
//
// The console (Console::Update 0x0068b260) opens on the grave key, takes its
// text from a GLFW char callback the host never feeds (no WM_CHAR), runs the
// line on Enter and recalls cmd_history.txt with UP. These tests drive the
// sequencer against a fake guest heap that behaves like that console, check
// the key table every command needs, the seeding of the two files (merged
// with an existing options.ini on a temp dir), the typing plan, and the
// census parser over the engine's own log lines.
//
// Round 32 (console_typing.mjs): the host's TranslateMessage synthesises
// WM_CHAR, so the console is typed into. The tests below pin the key-event
// plan for a command, the vk-to-character table against the C source, and
// the typed driver against a fake console that inserts what the host would
// post (and against one that does not, the round-30 host).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYS, keyEvent, planTyping, consoleSeedFiles, makeConsole, censusFromLog, GAME_PTR, CONSOLE, SAVE_DIR } from '../scripts/recomp/lift/explore.mjs';
import { planTyping as planTypedEvents, typingFrames, makeTypedConsole, VK_CHARS, vkToChar, consoleAccepts, NOCH } from '../scripts/recomp/lift/console_typing.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const NAME = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [v[0], k]));

test('KEYS: every letter, digit, space, grave and the punctuation the commands need, as [vk, scancode, extended]', () => {
  const need = ['space', 'grave', 'period', 'minus', 'enter', 'escape', 'backspace', 'up', 'down', 'left', 'right', 'shift'];
  for (let c = 97; c <= 122; c++) need.push(String.fromCharCode(c));
  for (let d = 0; d <= 9; d++) need.push(String(d));
  for (const k of need) {
    assert.ok(KEYS[k], `key ${k} missing`);
    const [vk, sc, ext] = KEYS[k];
    assert.ok(vk >= 1 && vk <= 0xFE, `${k}: vk ${vk}`);
    assert.ok(sc >= 1 && sc <= 0x7F, `${k}: scancode ${sc}`);
    assert.ok(ext === 0 || ext === 1, `${k}: extended ${ext}`);
  }
  // pinned: the console key is VK_OEM_3 with the US scancode 0x29 (GLFW_KEY_GRAVE_ACCENT); arrows are extended
  assert.deepEqual(KEYS.grave, [0xC0, 0x29, 0]);
  assert.deepEqual(KEYS.up, [0x26, 0x48, 1]);
  assert.deepEqual(KEYS.s, [0x53, 0x1F, 0]);
  assert.deepEqual(KEYS['2'], [0x32, 0x03, 0]);
  // scancodes are unique per (scancode, extended); vks are unique
  const seen = new Set(), vks = new Set();
  for (const [k, [vk, sc, ext]] of Object.entries(KEYS)) {
    const key = `${sc}:${ext}`;
    assert.ok(!seen.has(key), `${k}: scancode ${sc}/${ext} reused`); seen.add(key);
    assert.ok(!vks.has(vk), `${k}: vk ${vk} reused`); vks.add(vk);
  }
  assert.deepEqual(keyEvent('up', true), [1, 0x26, 0x48 | 0x100, 1]);
  assert.deepEqual(keyEvent('grave', false), [1, 0xC0, 0x29, 0]);
});

test('planTyping: a command becomes one key per character, Shift around the characters that need it', () => {
  assert.deepEqual(planTyping('stage 2').map((k) => (k.shift ? 'S+' : '') + k.key), ['s', 't', 'a', 'g', 'e', 'space', '2']);
  assert.deepEqual(planTyping('goto s.boss.1010').map((k) => k.key), ['g', 'o', 't', 'o', 'space', 's', 'period', 'b', 'o', 's', 's', 'period', '1', '0', '1', '0']);
  assert.deepEqual(planTyping('Debug 3').map((k) => [k.key, k.shift]), [['d', true], ['e', false], ['b', false], ['u', false], ['g', false], ['space', false], ['3', false]]);
  assert.deepEqual(planTyping('~:').map((k) => [k.key, k.shift]), [['grave', true], ['semicolon', true]]);
  assert.throws(() => planTyping('é'), /no key/);
});

test('consoleSeedFiles: a fresh options.ini enables the console and the history; an existing one is merged, keys intact', () => {
  const fresh = consoleSeedFiles(['stage 2', 'goto s.boss.1010']);
  assert.equal(fresh[0].path, `${SAVE_DIR}/options.ini`);
  assert.equal(fresh[0].text, '[Options]\r\nEnableDebugConsole=1\r\nSaveCommandHistory=1\r\nVSync=0\r\n', 'VSync=0: SetVSync(1) asks for a monitor the headless host has not got');
  assert.equal(fresh[0].merged, false);
  assert.equal(fresh[1].path, `${SAVE_DIR}/cmd_history.txt`);
  assert.equal(fresh[1].text, 'stage 2\r\ngoto s.boss.1010\r\n', 'one command per line, the first line is what the first UP recalls');
  // on a temp dir: an instance whose options.ini already exists (the engine's own key order)
  const dir = mkdtempSync(join(tmpdir(), 'isaac-console-'));
  const optDir = join(dir, ...SAVE_DIR.split('/'));
  const before = '[Options]\r\nLanguage=0\r\nMusicVolume=0.4000\r\nEnableMods=1\r\nEnableDebugConsole=0\r\nMaxScale=99\r\nVSync=1\r\nSaveCommandHistory=0\r\nWindowWidth=960\r\n';
  const optPath = join(optDir, 'options.ini');
  mkdirSync(optDir, { recursive: true });
  writeFileSync(optPath, before);
  const merged = consoleSeedFiles(['debug 3'], readFileSync(optPath, 'latin1'));
  assert.equal(merged[0].merged, true);
  assert.equal(merged[0].text, '[Options]\r\nLanguage=0\r\nMusicVolume=0.4000\r\nEnableMods=1\r\nEnableDebugConsole=1\r\nMaxScale=99\r\nVSync=0\r\nSaveCommandHistory=1\r\nWindowWidth=960\r\n');
  assert.equal((merged[0].text.match(/EnableDebugConsole=/g) || []).length, 1, 'the key is replaced, not duplicated');
  assert.equal(readFileSync(optPath, 'latin1'), before, 'the file on disk is untouched: the merge is for the RAM-FS');
  assert.ok(!existsSync(join(optDir, 'cmd_history.txt')), 'no history file is written to disk');
  // a file without the section gets one; a command with a newline is refused
  assert.equal(consoleSeedFiles(['x'], 'Language=0\r\n')[0].text, '[Options]\r\nLanguage=0\r\nEnableDebugConsole=1\r\nSaveCommandHistory=1\r\nVSync=0\r\n');
  assert.throws(() => consoleSeedFiles(['stage 2\ndebug 3']), /bad command/);
});

// A fake console inside a fake heap: state at Game+0x68d78, the input line
// as an MSVC std::string at Game+0x68d94 (SSO buffer, size +0x10, cap
// +0x14), the history ring at Console+0x58.. loaded from `history` (line 1
// at the head). Keys behave as Console::Update does: grave opens (state 1
// for two frames, then 2), UP recalls the next older entry into the line,
// DOWN at the head clears it, Enter runs a non-empty line (recorded, line
// cleared, the command push_fronted -- moved to the front when it is already
// in the history, which is what the engine's ring does (the live run recalled
// three seeded commands with 1, 2 and 3 UPs, §21.45); `dedup: false` models
// a duplicating ring, which the driver's text check absorbs too) and closes
// on an empty line (state 4, then 0 two frames later).
function fakeConsole(history, { dedup = true } = {}) {
  const u = new Map(), bytes = new Map();
  const game = 0x01000000, ring = 0x01100000, strings = 0x01200000;
  u.set(GAME_PTR, game);
  const mem = {
    ok: (va) => va >= 0x00400000 && va < 0x34000000,
    u32: (va) => u.get(va) || 0,
    f32: () => 0,
    u8: (va) => bytes.get(va) || 0,
  };
  const setStr = (va, s) => {
    u.set(va + 0x10, s.length); u.set(va + 0x14, Math.max(15, s.length));
    const base = s.length > 15 ? (u.set(va, 0x01300000 + (va & 0xffff) * 0x100), 0x01300000 + (va & 0xffff) * 0x100) : va;
    for (let i = 0; i < 64; i++) bytes.set(base + i, i < s.length ? s.charCodeAt(i) : 0);
  };
  const line = game + CONSOLE.line;
  setStr(line, '');
  const hist = [...history];        // index 0 = head
  const cap = 64;
  const layout = () => {
    u.set(game + CONSOLE.histBuf, ring); u.set(game + CONSOLE.histCap, cap); u.set(game + CONSOLE.histHead, 0); u.set(game + CONSOLE.histCount, hist.length);
    hist.forEach((s, i) => { const sva = strings + i * 0x40; u.set(ring + 4 * i, sva); setStr(sva, s); });
  };
  layout();
  const w = { state: 0, opening: 0, closing: 0, cursor: 0, text: '', executed: [], keysDown: new Set(), frame: 0 };
  u.set(game + CONSOLE.state, 0);
  // one engine frame: apply the key edges seen this frame, then the animations
  const step = (edges) => {
    for (const k of edges) {
      if (w.state === 0 && k === 'grave') { w.state = 1; w.opening = 2; }
      else if (w.state === 2) {
        if (k === 'up' && w.cursor < hist.length) { w.text = hist[w.cursor]; w.cursor++; }
        else if (k === 'down') { if (w.cursor <= 1) { w.cursor = 0; w.text = ''; } else { w.cursor--; w.text = hist[w.cursor - 1]; } }
        else if (k === 'enter') {
          if (w.text.length) {
            w.executed.push(w.text);
            if (dedup) { const i = hist.indexOf(w.text); if (i >= 0) hist.splice(i, 1); }
            hist.unshift(w.text); w.text = ''; w.cursor = 0; layout();
          }
          else { w.state = 4; w.closing = 2; }
        } else if (k === 'escape') { w.state = 4; w.closing = 2; }
      }
    }
    if (w.state === 1 && --w.opening <= 0) w.state = 2;
    if (w.state === 4 && --w.closing <= 0) w.state = 0;
    u.set(game + CONSOLE.state, w.state);
    setStr(line, w.text);
  };
  return { mem, w, step };
}

// Run the driver frame by frame: each frame drains its events, turns the
// downs into key edges (a key must be down in the previous frame's sample
// and up before it counts again -- the engine samples per frame), then
// steps the fake console.
function run(drv, fake, frames, heap32 = new Int32Array(64)) {
  const down = new Set();
  const trace = [];
  for (let f = 0; f < frames; f++) {
    const edges = [];
    while (drv.poll(f, 64, heap32)) {
      const [, vk, , isDown] = heap32.subarray(16, 20);
      const name = NAME[vk];
      if (isDown) { if (!down.has(name)) { down.add(name); edges.push(name); } } else down.delete(name);
    }
    if (edges.length) trace.push([f, ...edges]);
    fake.step(edges);
    if (drv.done()) return { f, trace };
  }
  return { f: frames, trace };
}

test('makeConsole: open with the grave key, recall each command with UP, Enter runs it, Enter on the empty line closes', () => {
  const cmds = ['stage 2', 'debug 3', 'goto s.boss.1010'];
  const fake = fakeConsole(cmds);
  const log = [];
  const drv = makeConsole(fake.mem, { commands: cmds, ready: (f) => f >= 5, log: (s) => log.push(s) });
  assert.equal(drv.active(), false);
  const { f, trace } = run(drv, fake, 600);
  assert.equal(drv.done(), true, log.join('\n'));
  assert.deepEqual(fake.w.executed, cmds, 'every command ran, in order');
  assert.equal(fake.w.state, 0, 'closed again');
  const r = drv.report();
  assert.deepEqual(r.executed.map((e) => e.cmd), cmds);
  assert.deepEqual(r.failed, []);
  assert.ok(r.openedAt >= 5 && r.closedAt > r.openedAt && f === r.closedAt, JSON.stringify(r));
  assert.deepEqual(r.history, cmds, 'the history read back from the ring matches the seed');
  // UP presses: 1 for the first command; after it is push_fronted the second sits two back, the third three back
  assert.equal(r.ups, 1 + 2 + 3);
  const keys = trace.flatMap(([, ...ks]) => ks);
  assert.deepEqual(keys, ['grave', 'up', 'enter', 'up', 'up', 'enter', 'up', 'up', 'up', 'enter', 'enter'], trace.map((t) => t.join(':')).join(' '));
  assert.ok(log.some((s) => /console open \(state 2\)/.test(s)) && log.some((s) => /"stage 2" executed/.test(s)) && log.some((s) => /console closed/.test(s)), log.join('\n'));
});

test('makeConsole: a history that keeps duplicates (no move-to-front) still recalls every command', () => {
  const cmds = ['stage 2', 'debug 3', 'goto s.boss.1010'];
  const fake = fakeConsole(cmds, { dedup: false });
  const drv = makeConsole(fake.mem, { commands: cmds });
  run(drv, fake, 900);
  assert.deepEqual(fake.w.executed, cmds);
  assert.deepEqual(drv.report().failed, []);
  assert.equal(drv.report().ups, 1 + 3 + 5, 'the duplicates cost extra UPs, the text check absorbs them');
});

test('makeConsole: a command missing from the history is reported and skipped; the rest still run; every key is held >= 2 frames', () => {
  const fake = fakeConsole(['debug 3']);
  const log = [];
  const drv = makeConsole(fake.mem, { commands: ['stage 2', 'debug 3'], log: (s) => log.push(s) });
  const heap32 = new Int32Array(64);
  // measure the hold of every press
  const downAt = new Map(), holds = [];
  const orig = drv.poll;
  drv.poll = (f, out, h) => { const r = orig(f, out, h); if (r) { const [, vk, , d] = h.subarray(16, 20); if (d) downAt.set(vk, f); else holds.push(f - downAt.get(vk)); } return r; };
  run(drv, fake, 800, heap32);
  assert.deepEqual(fake.w.executed, ['debug 3']);
  const r = drv.report();
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /not recalled/);
  assert.deepEqual(r.executed.map((e) => e.cmd), ['debug 3']);
  assert.ok(holds.length > 0 && holds.every((h) => h >= 2), `holds ${holds.join(',')}`);
  assert.ok(log.some((s) => /"stage 2" never appeared/.test(s)), log.join('\n'));
});

test('makeConsole: the console that never opens is given up on after openTimeout, with retries every retryEvery frames', () => {
  const fake = fakeConsole(['stage 2']);
  fake.step = () => {};                                    // a console that ignores every key
  const drv = makeConsole(fake.mem, { commands: ['stage 2'], openTimeout: 100, retryEvery: 30 });
  const { trace } = run(drv, fake, 400);
  assert.equal(drv.report().openFailed, true);
  assert.deepEqual(trace.map((t) => t[0]), [1, 31, 61, 91], 'grave tapped the tick after idle -> open, then retried every 30 frames until the timeout');
  assert.ok(trace.every((t) => t[1] === 'grave'));
});

test('makeConsole type mode: the typed keys are pressed, the line stays empty, the driver says so and recalls instead', () => {
  const fake = fakeConsole(['stage 2']);
  const log = [];
  const drv = makeConsole(fake.mem, { commands: ['stage 2'], mode: 'type', log: (s) => log.push(s) });
  const { trace } = run(drv, fake, 600);
  assert.deepEqual(fake.w.executed, ['stage 2']);
  const keys = trace.flatMap(([, ...ks]) => ks);
  assert.deepEqual(keys.slice(0, 8), ['grave', 's', 't', 'a', 'g', 'e', 'space', '2']);
  assert.deepEqual(keys.slice(8), ['up', 'enter', 'enter']);
  assert.equal(drv.report().typedMismatches, 1);
  assert.ok(log.some((s) => /typed 7 key\(s\).*no WM_CHAR/.test(s)), log.join('\n'));
});

test('censusFromLog: the engine lines for a floor change, rooms, a boss room, boss deaths and asserts', () => {
  const sample = [
    '[isaac][frame] 600 frames presented (57 ms since the previous)',
    '[odsa] [INFO] - Level::Init m_Stage 1, m_StageType 0 Seed 2055252973',
    '[odsa] [INFO] - [RoomConfig] load stage 1: Basement (mode 0)',
    '[odsa] [INFO] - Room 1.2(Start Room)',
    '[  41249.9] [  41312.0] [odsa] [INFO] - Room 1.743(New Room (copy))',
    '[console] frame 900: "stage 2" executed (line cleared after 1 frame(s), state 2)',
    '[odsa] [INFO] - Level::Init m_Stage 2, m_StageType 0 Seed 17',
    '[odsa] [INFO] - [RoomConfig] load stage 2: Basement (mode 0)',
    '[odsa] [INFO] - Room 1.5(Start Room)',
    '[odsa] [INFO] - Room 5.1010(Monstro)',
    '[odsa] [INFO] - TriggerBossDeath: 0 bosses remaining.',
    '[odsa] [ASSERT] - Invalid entity position detected: 35742.77, 18535.83 (1000.33.0)',
    '[odsa] [ASSERT] - CellSpace::insert: x1 > x2',
    '  explorer: {"transitions":3,"rooms":[5,-3]}',
    '  console: {"executed":[{"cmd":"stage 2"}],"failed":[]}',
  ].join('\n');
  const c = censusFromLog(sample);
  assert.deepEqual(c.levelInits, [{ stage: 1, type: 0, seed: '2055252973' }, { stage: 2, type: 0, seed: '17' }]);
  assert.deepEqual(c.stages.map((s) => `${s.stage}:${s.name}`), ['1:Basement', '2:Basement']);
  assert.deepEqual(c.rooms, [{ type: 1, variant: 2, name: 'Start Room' }, { type: 1, variant: 743, name: 'New Room (copy)' }, { type: 1, variant: 5, name: 'Start Room' }, { type: 5, variant: 1010, name: 'Monstro' }]);
  assert.equal(c.bossRooms, 1);
  assert.deepEqual(c.bossDeaths, [0]);
  assert.equal(c.asserts, 2);
  assert.equal(c.invalidPositions, 1);
  assert.deepEqual(c.explorer, { transitions: 3, rooms: [5, -3] });
  assert.deepEqual(c.console.executed, [{ cmd: 'stage 2' }]);
});

// ---- round 32: typed console text ------------------------------------------

test('planTyping (console_typing): "goto s.boss.1010" as key events -- one down/up per character, held >= 2 frames, no Shift; Shift around the characters that need it', () => {
  const plan = planTypedEvents('goto s.boss.1010');
  const want = ['g', 'o', 't', 'o', 'space', 's', 'period', 'b', 'o', 's', 's', 'period', '1', '0', '1', '0'];
  assert.deepEqual(plan.filter((e) => e.down).map((e) => e.key), want);
  assert.equal(plan.length, 2 * want.length, 'a down and an up per character, nothing else');
  assert.ok(!plan.some((e) => e.key === 'shift'), 'the command needs no Shift');
  assert.equal(plan.filter((e) => e.down).map((e) => e.char).join(''), 'goto s.boss.1010', 'the key-downs spell the command');
  // the event shape the node driver hands the host, from the same KEYS table
  for (const e of plan) {
    const [vk, sc, ext] = KEYS[e.key];
    assert.deepEqual(e.ev, [1, vk, sc | (ext << 8), e.down ? 1 : 0], `${e.key} ${e.down ? 'down' : 'up'}`);
  }
  assert.deepEqual(plan[0].ev, [1, 0x47, 0x22, 1]);                       // g down
  assert.deepEqual(plan[13].ev, [1, 0xBE, 0x34, 0]);                      // the first period's up
  // frames: down at t, up at t + hold (3), the next character at t + 4; the 's' of "ss" is released before it is pressed again
  const downs = plan.filter((e) => e.down), ups = plan.filter((e) => !e.down);
  downs.forEach((d, i) => { assert.equal(ups[i].at - d.at, 3, `${d.key} held 3 frames`); assert.ok(ups[i].at - d.at >= 2); });
  assert.deepEqual(downs.map((d) => d.at), downs.map((_, i) => i * 4));
  assert.equal(typingFrames('goto s.boss.1010'), 16 * 4);
  assert.equal(typingFrames('stage 2', { hold: 2, gap: 0 }), 6 * 2 + 2 + 1, 'the last release is on frame 14: 15 frames');
  assert.equal(planTypedEvents('stage 2', { start: 100 })[0].at, 100);
  // Shift: down with the key, up with it, in that order
  const cap = planTypedEvents('Debug ~3');
  assert.deepEqual(cap.map((e) => `${e.key}${e.down ? '+' : '-'}@${e.at}`),
    ['shift+@0', 'd+@0', 'd-@3', 'shift-@3', 'e+@4', 'e-@7', 'b+@8', 'b-@11', 'u+@12', 'u-@15', 'g+@16', 'g-@19', 'space+@20', 'space-@23',
      'shift+@24', 'grave+@24', 'grave-@27', 'shift-@27', '3+@28', '3-@31']);
  assert.deepEqual(cap.filter((e) => e.down && e.key !== 'shift').map((e) => e.char), ['D', 'e', 'b', 'u', 'g', ' ', '~', '3']);
  assert.throws(() => planTypedEvents('stage 2', { hold: 1 }), /held >= 2/);
  assert.throws(() => planTypedEvents('é'), /no key/);
});

// The C table, one row per line: { 0xVK, base, Shift, Ctrl } with C char
// literals, hex or NOCH.
function cTable() {
  const src = readFileSync(join(REPO, 'scripts', 'recomp', 'host', 'src', 'host_shims_win.c'), 'utf8');
  const start = src.indexOf('static const vk_char g_vk_chars[] = {');
  assert.ok(start > 0, 'g_vk_chars is in host_shims_win.c');
  const body = src.slice(start, src.indexOf('};', start));
  const cell = (s) => {
    if (s === 'NOCH') return NOCH;
    if (/^0x[0-9A-Fa-f]+$/.test(s)) return String.fromCharCode(parseInt(s, 16));
    const m = /^'(.*)'$/.exec(s);
    assert.ok(m, `C cell ${s}`);
    const esc = { '\\\\': '\\', "\\'": "'", '\\"': '"', '\\r': '\r', '\\n': '\n', '\\b': '\b', '\\t': '\t' };
    if (m[1].length === 1) return m[1];
    assert.ok(esc[m[1]] !== undefined, `C escape ${s}`);
    return esc[m[1]];
  };
  const rows = {};
  for (const line of body.split('\n')) {
    const m = /^\s*\{\s*0x([0-9A-Fa-f]{2}),\s*('(?:\\.|[^'])*'|0x[0-9A-Fa-f]+|NOCH),\s*('(?:\\.|[^'])*'|0x[0-9A-Fa-f]+|NOCH),\s*('(?:\\.|[^'])*'|0x[0-9A-Fa-f]+|NOCH)\s*\}/.exec(line);
    if (m) rows[parseInt(m[1], 16)] = [cell(m[2]), cell(m[3]), cell(m[4])];
  }
  return rows;
}

test('VK_CHARS mirrors host_shims_win.c g_vk_chars row for row; vkToChar follows the host rules for letters, CapsLock, Ctrl and AltGr', () => {
  const rows = cTable();
  assert.ok(Object.keys(rows).length >= 40, `parsed ${Object.keys(rows).length} rows`);
  assert.deepEqual(Object.keys(VK_CHARS).map(Number).sort((a, b) => a - b), Object.keys(rows).map(Number).sort((a, b) => a - b), 'the same virtual keys');
  for (const vk of Object.keys(rows)) assert.deepEqual(VK_CHARS[vk], rows[vk], `vk 0x${Number(vk).toString(16)}`);
  // every key the commands can use posts its character; digits and punctuation ignore CapsLock
  assert.equal(vkToChar(0xC0), '`'); assert.equal(vkToChar(0xC0, { shift: true }), '~');
  assert.equal(vkToChar(0x32), '2'); assert.equal(vkToChar(0x32, { shift: true }), '@'); assert.equal(vkToChar(0x32, { caps: true }), '2');
  assert.equal(vkToChar(0x0D), '\r'); assert.equal(vkToChar(0x08), '\b'); assert.equal(vkToChar(0x09), '\t'); assert.equal(vkToChar(0x1B), '\x1b'); assert.equal(vkToChar(0x20), ' ');
  assert.equal(vkToChar(0xBE), '.'); assert.equal(vkToChar(0xBD, { shift: true }), '_'); assert.equal(vkToChar(0xDE), "'"); assert.equal(vkToChar(0xDC), '\\');
  // letters: Shift and CapsLock swap the case, both together swap it back; Ctrl makes the control character, Shift or not
  assert.equal(vkToChar(0x41), 'a'); assert.equal(vkToChar(0x41, { shift: true }), 'A'); assert.equal(vkToChar(0x41, { caps: true }), 'A');
  assert.equal(vkToChar(0x41, { shift: true, caps: true }), 'a');
  assert.equal(vkToChar(0x41, { ctrl: true }), '\x01'); assert.equal(vkToChar(0x5A, { ctrl: true, shift: true }), '\x1a');
  assert.equal(vkToChar(0x41, { ctrl: true, alt: true }), NOCH, 'AltGr: nothing on the US layout');
  assert.equal(vkToChar(0x32, { ctrl: true }), '\0', 'Ctrl+2 is NUL'); assert.equal(vkToChar(0x32, { ctrl: true, shift: true }), NOCH, 'no Shift+Ctrl column');
  assert.equal(vkToChar(0x0D, { ctrl: true }), '\n'); assert.equal(vkToChar(0xDB, { ctrl: true }), '\x1b');
  assert.equal(vkToChar(0x70), NOCH); assert.equal(vkToChar(0x26), NOCH); assert.equal(vkToChar(0x10), NOCH);
  // what the console's line can take: GLFW drops < 0x20, the callback stops at 0x7f
  assert.equal(consoleAccepts(' '), true); assert.equal(consoleAccepts('~'), true); assert.equal(consoleAccepts('\r'), false);
  assert.equal(consoleAccepts('\x7f'), false); assert.equal(consoleAccepts(NOCH), false);
  // the KEYS table and the C table agree on every key planTyping can emit
  for (const [name, [vk]] of Object.entries(KEYS)) {
    if (name.length === 1 && /[a-z]/.test(name)) { assert.equal(vkToChar(vk), name); assert.equal(vkToChar(vk, { shift: true }), name.toUpperCase()); }
    else if (/^[0-9]$/.test(name)) assert.equal(vkToChar(vk), name);
  }
});

// A fake console with the host's WM_CHAR (round 32): every key-down that
// TranslateMessage would turn into a printable character inserts it -- but
// only while the console is open (state 2), as the callback 0x00686730
// checks, and only if GLFW lets it through (consoleAccepts). The rest is the
// round-30 fake: grave opens, Enter runs a non-empty line or closes on an
// empty one, DOWN at the head clears the line, Backspace deletes one
// character. `chars: false` is the round-30 host (no WM_CHAR);
// `downClears: false` a DOWN that leaves the line alone.
function fakeTypedConsole({ chars = true, downClears = true, text = '' } = {}) {
  const u = new Map(), bytes = new Map();
  const game = 0x01000000;
  u.set(GAME_PTR, game);
  const mem = { ok: (va) => va >= 0x00400000 && va < 0x34000000, u32: (va) => u.get(va) || 0, f32: () => 0, u8: (va) => bytes.get(va) || 0 };
  const setStr = (va, s) => {
    u.set(va + 0x10, s.length); u.set(va + 0x14, Math.max(15, s.length));
    const base = s.length > 15 ? (u.set(va, 0x01300000 + (va & 0xffff) * 0x100), 0x01300000 + (va & 0xffff) * 0x100) : va;
    for (let i = 0; i < 64; i++) bytes.set(base + i, i < s.length ? s.charCodeAt(i) : 0);
  };
  const line = game + CONSOLE.line;
  const w = { state: 0, opening: 0, closing: 0, text, executed: [], inserted: [], dropped: [] };
  u.set(game + CONSOLE.state, 0);
  setStr(line, w.text);
  const mods = new Set(), downKeys = new Set();
  // one engine frame: the pump first (every message in delivery order; a
  // key-down's WM_CHAR follows it at once and lands only in state 2), then
  // the update's key edges
  const step = (events) => {
    const edges = [];
    for (const { name, down } of events) {
      if (name === 'shift' || name === 'ctrl' || name === 'alt') { if (down) mods.add(name); else mods.delete(name); }
      if (down) {
        const ch = chars ? vkToChar(KEYS[name][0], { shift: mods.has('shift'), ctrl: mods.has('ctrl'), alt: mods.has('alt') }) : NOCH;
        if (consoleAccepts(ch)) { if (w.state === 2) { w.text += ch; w.inserted.push(ch); } else w.dropped.push(ch); }
        if (!downKeys.has(name)) { downKeys.add(name); edges.push(name); }
      } else downKeys.delete(name);
    }
    for (const k of edges) {
      if (w.state === 0 && k === 'grave') { w.state = 1; w.opening = 2; }
      else if (w.state === 2) {
        if (k === 'enter') { if (w.text.length) { w.executed.push(w.text); w.text = ''; } else { w.state = 4; w.closing = 2; } }
        else if (k === 'down') { if (downClears) w.text = ''; }
        else if (k === 'backspace') w.text = w.text.slice(0, -1);
        else if (k === 'escape') { w.state = 4; w.closing = 2; }
      }
    }
    if (w.state === 1 && --w.opening <= 0) w.state = 2;
    if (w.state === 4 && --w.closing <= 0) w.state = 0;
    u.set(game + CONSOLE.state, w.state);
    setStr(line, w.text);
  };
  return { mem, w, step };
}

// Frame by frame: drain the driver's events (in order), hand them to the
// fake, note the key-downs and the hold of every key.
function runTyped(drv, fake, frames) {
  const heap32 = new Int32Array(64);
  const trace = [], downAt = new Map(), holds = [];
  for (let f = 0; f < frames; f++) {
    const events = [];
    while (drv.poll(f, 64, heap32)) {
      const [, vk, , isDown] = heap32.subarray(16, 20);
      const name = NAME[vk];
      events.push({ name, down: !!isDown });
      if (isDown) { downAt.set(name, f); trace.push([f, name]); } else holds.push(f - downAt.get(name));
    }
    fake.step(events);
    if (drv.done()) return { f, trace, holds };
  }
  return { f: frames, trace, holds };
}

test('makeTypedConsole: grave opens, each command is typed and read back from the line, Enter runs it, Enter on the empty line closes; no history, no UP', () => {
  const cmds = ['stage 2', 'goto s.boss.1010'];
  const fake = fakeTypedConsole();
  const log = [];
  const drv = makeTypedConsole(cmds, { mem: fake.mem, ready: (f) => f >= 5, log: (s) => log.push(s) });
  assert.equal(drv.active(), false);
  const { f, trace, holds } = runTyped(drv, fake, 1500);
  assert.equal(drv.done(), true, log.join('\n'));
  assert.deepEqual(fake.w.executed, cmds, 'both commands ran, in order, from typed text');
  assert.equal(fake.w.state, 0, 'closed again');
  const r = drv.report();
  assert.equal(r.mode, 'typed');
  assert.deepEqual(r.executed.map((e) => e.cmd), cmds);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.retypes, 0);
  assert.equal(r.typedKeys, 7 + 16);
  assert.equal(r.typedChars, 7 + 16);
  assert.ok(r.openedAt >= 5 && r.closedAt > r.openedAt && f === r.closedAt, JSON.stringify(r));
  const keys = trace.map(([, k]) => k);
  assert.deepEqual(keys, ['grave', 's', 't', 'a', 'g', 'e', 'space', '2', 'enter',
    'g', 'o', 't', 'o', 'space', 's', 'period', 'b', 'o', 's', 's', 'period', '1', '0', '1', '0', 'enter', 'enter'],
  trace.map((t) => t.join(':')).join(' '));
  assert.ok(!keys.includes('up') && !keys.includes('down'), 'nothing recalled, nothing cleared');
  assert.ok(holds.length === keys.length && holds.every((h) => h >= 2), `holds ${holds.join(',')}`);
  assert.deepEqual(fake.w.inserted.join(''), 'stage 2goto s.boss.1010', 'exactly the commands reached the line');
  assert.deepEqual(fake.w.dropped, ['`'], "the opening grave key's own WM_CHAR arrives with the console still closed and is dropped");
  assert.ok(log.some((s) => /console open \(state 2\)/.test(s)) && log.some((s) => /typing "stage 2": 7 key\(s\)/.test(s))
    && log.some((s) => /line reads "goto s.boss.1010" \d+ frames after the first key \(typed\); Enter/.test(s))
    && log.some((s) => /"goto s.boss.1010" executed/.test(s)) && log.some((s) => /console closed after \d+ frames; 2\/2 command\(s\) typed and executed/.test(s)), log.join('\n'));
  assert.throws(() => makeTypedConsole(cmds, {}), /opts.mem/);
});

test('makeTypedConsole on a host without WM_CHAR (round 30): the line stays empty, the driver retypes twice, reports it and closes', () => {
  const fake = fakeTypedConsole({ chars: false });
  const log = [];
  const drv = makeTypedConsole(['stage 2', 'debug 3'], { mem: fake.mem, log: (s) => log.push(s) });
  const { trace } = runTyped(drv, fake, 2000);
  assert.equal(drv.done(), true, log.join('\n'));
  assert.deepEqual(fake.w.executed, []);
  const r = drv.report();
  assert.deepEqual(r.executed, []);
  assert.equal(r.failed.length, 2);
  assert.match(r.failed[0].reason, /typed characters did not reach the console/);
  assert.equal(r.retypes, 4, 'maxRetypes (2) per command');
  assert.equal(r.mismatches.length, 6, 'three attempts per command, each read back');
  assert.equal(r.typedKeys, 3 * 7 + 3 * 7);
  assert.equal(fake.w.state, 0, 'closed at the end');
  const keys = trace.map(([, k]) => k);
  assert.equal(keys.filter((k) => k === 'up').length, 0, 'no history recall in typed mode');
  assert.equal(keys.filter((k) => k === 's').length, 3, 'stage 2 typed three times');
  assert.ok(log.some((s) => /line reads "" after typing "stage 2"; clearing and typing again \(1\/2\)/.test(s)), log.join('\n'));
});

test('makeTypedConsole: a leftover line is cleared with DOWN first; when DOWN leaves it, one Backspace per character', () => {
  const fake = fakeTypedConsole({ downClears: false, text: 'xy' });
  const log = [];
  const drv = makeTypedConsole(['stage 2'], { mem: fake.mem, log: (s) => log.push(s) });
  const { trace } = runTyped(drv, fake, 1500);
  assert.equal(drv.done(), true, log.join('\n'));
  assert.deepEqual(fake.w.executed, ['stage 2']);
  const r = drv.report();
  assert.deepEqual(r.failed, []);
  assert.equal(r.clears, 1);
  const keys = trace.map(([, k]) => k);
  assert.deepEqual(keys.slice(0, 4), ['grave', 'down', 'backspace', 'backspace']);
  assert.deepEqual(keys.slice(4), ['s', 't', 'a', 'g', 'e', 'space', '2', 'enter', 'enter']);
  assert.ok(log.some((s) => /line reads "xy" before typing; DOWN to clear it/.test(s)) && log.some((s) => /line still "xy" after DOWN; 2 Backspace\(s\)/.test(s)) && log.some((s) => /line cleared/.test(s)), log.join('\n'));
  // and a DOWN that does clear it costs no Backspace
  const fake2 = fakeTypedConsole({ text: 'x' });
  const drv2 = makeTypedConsole(['debug 3'], { mem: fake2.mem });
  const t2 = runTyped(drv2, fake2, 1500);
  assert.deepEqual(fake2.w.executed, ['debug 3']);
  assert.deepEqual(t2.trace.map(([, k]) => k).slice(0, 3), ['grave', 'down', 'd']);
});
