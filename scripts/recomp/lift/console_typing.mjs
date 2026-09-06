// Round 32: typed console text (recomp-architecture.md §21.47).
//
// The host's TranslateMessage (host_shims_win.c) synthesises the WM_CHAR
// Windows would post for the WM_KEYDOWN of a printable key, so the game's
// debug console (Console::Update 0x0068b260; its GLFW char callback
// 0x00686730 inserts codepoints 0x20..0x7f at the cursor while the console
// is open, state 2) can be TYPED into instead of recalled from a seeded
// cmd_history.txt (round 30, explore.mjs makeConsole).
//
// planTyping turns a string into the key events the node driver's poll hands
// the host ([1, vk, scancode | extended << 8, down], explore.mjs KEYS and its
// per-character key/Shift plan), Shift held around the characters that need
// it, every key held `hold` frames (>= 2: the engine samples key state per
// frame). makeTypedConsole opens the console with the grave key, types each
// command, reads the input line back (Console+0x1c, an MSVC std::string in
// guest memory) and only then taps Enter, waits for the engine to run it
// (the line clears), and closes with Enter on the empty line. Every step is
// verified against the console's own state; a line that reads wrong is
// cleared and typed again, and reported when it still does not match.
//
// VK_CHARS mirrors the host's US-layout table (g_vk_chars, row for row) and
// vkToChar its rules, so the driver knows which character a key will post
// and tests/recomp-console.test.js can pin both against the C source.
import { KEYS, keyEvent, planTyping as planKeys, GAME_PTR, CONSOLE } from './explore.mjs';

export const NOCH = null;
// vk -> [base, Shift, Ctrl] (host_shims_win.c g_vk_chars; NOCH = no character)
export const VK_CHARS = {
  0x30: ['0', ')', NOCH], 0x31: ['1', '!', NOCH], 0x32: ['2', '@', '\0'], 0x33: ['3', '#', NOCH], 0x34: ['4', '$', NOCH],
  0x35: ['5', '%', NOCH], 0x36: ['6', '^', '\x1e'], 0x37: ['7', '&', NOCH], 0x38: ['8', '*', NOCH], 0x39: ['9', '(', NOCH],
  0x20: [' ', ' ', ' '], 0x0D: ['\r', '\r', '\n'], 0x08: ['\b', '\b', '\x7f'], 0x09: ['\t', '\t', NOCH], 0x1B: ['\x1b', '\x1b', '\x1b'],
  0xBA: [';', ':', NOCH], 0xBB: ['=', '+', NOCH], 0xBC: [',', '<', NOCH], 0xBD: ['-', '_', '\x1f'], 0xBE: ['.', '>', NOCH],
  0xBF: ['/', '?', NOCH], 0xC0: ['`', '~', NOCH], 0xDB: ['[', '{', '\x1b'], 0xDC: ['\\', '|', '\x1c'], 0xDD: [']', '}', '\x1d'],
  0xDE: ["'", '"', NOCH], 0xE2: ['\\', '|', '\x1c'],
  0x60: ['0', NOCH, NOCH], 0x61: ['1', NOCH, NOCH], 0x62: ['2', NOCH, NOCH], 0x63: ['3', NOCH, NOCH], 0x64: ['4', NOCH, NOCH],
  0x65: ['5', NOCH, NOCH], 0x66: ['6', NOCH, NOCH], 0x67: ['7', NOCH, NOCH], 0x68: ['8', NOCH, NOCH], 0x69: ['9', NOCH, NOCH],
  0x6A: ['*', '*', NOCH], 0x6B: ['+', '+', NOCH], 0x6D: ['-', '-', NOCH], 0x6E: ['.', NOCH, NOCH], 0x6F: ['/', '/', NOCH],
};

// The character TranslateMessage posts for a virtual key under the
// modifiers (host_shims_win.c vk_to_char): letters are computed -- CapsLock
// swaps the case Shift gives, Ctrl (Shift or not) makes 0x01..0x1a --,
// Shift+Ctrl has no column, Ctrl+Alt (AltGr) has none on the US layout.
export function vkToChar(vk, mods = {}) {
  const { shift = false, ctrl = false, alt = false, caps = false } = mods;
  if (ctrl && alt) return NOCH;
  if (vk >= 0x41 && vk <= 0x5A) {
    if (ctrl) return String.fromCharCode(vk & 0x1f);
    return String.fromCharCode(shift !== caps ? vk : vk + 0x20);
  }
  const row = VK_CHARS[vk];
  if (!row) return NOCH;
  if (ctrl) return shift ? NOCH : row[2];
  return shift ? row[1] : row[0];
}

// What reaches the console's line: GLFW's _glfwInputChar (0x00a25d60) drops
// codepoints below 0x20 (and 0x7f..0x9f), the callback (0x00686730) takes
// 0x20..0x7f; together: the printable ASCII range.
export function consoleAccepts(ch) {
  if (ch === NOCH || ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c >= 0x20 && c <= 0x7e;
}

// The key events for `text`, as [{ at, key, down, ev, char }] in delivery
// order: per character, Shift down (when needed) and the key down at frame
// t, the key up and Shift up at t + hold, the next character at t + hold +
// gap. `char` on the key-down is what the host will post for it, and it
// must be the character wanted (the two tables agree or this throws).
export function planTyping(text, opts = {}) {
  const hold = opts.hold ?? 3, gap = opts.gap ?? 1, start = opts.start ?? 0;
  if (!(hold >= 2)) throw new Error('planTyping: a key must be held >= 2 frames');
  const chars = [...text];
  const keys = planKeys(text);                       // one { key, shift } per character
  const out = [];
  let t = start;
  for (let i = 0; i < keys.length; i++) {
    const { key, shift } = keys[i];
    const ch = vkToChar(KEYS[key][0], { shift });
    if (ch !== chars[i]) throw new Error(`planTyping: key ${key}${shift ? ' + Shift' : ''} posts ${JSON.stringify(ch)}, not ${JSON.stringify(chars[i])}`);
    if (shift) out.push({ at: t, key: 'shift', down: true, ev: keyEvent('shift', true) });
    out.push({ at: t, key, down: true, ev: keyEvent(key, true), char: ch });
    out.push({ at: t + hold, key, down: false, ev: keyEvent(key, false) });
    if (shift) out.push({ at: t + hold, key: 'shift', down: false, ev: keyEvent('shift', false) });
    t += hold + gap;
  }
  return out;
}

// Frames a plan occupies (the last event's frame + 1).
export function typingFrames(text, opts = {}) {
  const plan = planTyping(text, opts);
  return plan.length ? plan[plan.length - 1].at + 1 - (opts.start ?? 0) : 0;
}

// The typed driver. Same contract as explore.mjs makeConsole: poll(frame,
// out, heap32) hands one event per call (ticking once per new frame),
// active()/done()/phase()/report().
export function makeTypedConsole(commands, opts = {}) {
  const mem = opts.mem;
  if (!mem) throw new Error('makeTypedConsole: opts.mem (the guest memory readers ok/u32/u8) is required');
  const log = opts.log || (() => {});
  const cmds = [...(commands || [])].map((c) => c.trim()).filter(Boolean);
  const ready = opts.ready || (() => true);
  const hold = opts.hold ?? 3;                       // frames a key stays down (>= 2)
  const gap = opts.gap ?? 1;                         // frames between one key's release and the next key's press
  const settle = opts.settle ?? 4;                   // frames after the last key before the line is read
  const retryEvery = opts.retryEvery ?? 45;          // frames between open/submit/close retries
  const openTimeout = opts.openTimeout ?? 300;
  const closeTimeout = opts.closeTimeout ?? 300;
  const submitTimeout = opts.submitTimeout ?? 120;
  const maxRetypes = opts.maxRetypes ?? 2;           // times a wrong line is cleared and typed again
  const rd = (va) => (mem.ok(va) ? mem.u32(va) : 0);
  const rb = (va) => (mem.ok(va) ? (mem.u8 ? mem.u8(va) : (mem.u32(va & ~3) >>> ((va & 3) * 8)) & 0xff) : 0);
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

  const queue = [];                                  // events ready to hand out
  const scheduled = [];                              // planned events, by frame
  const held = new Set(), pending = [];              // keys down; releases due
  let phase = cmds.length ? 'idle' : 'done';
  let idx = 0, phaseSince = -1, lastTap = -1e9, lastFrame = -1, quietUntil = -1, retypes = 0, closeTaps = 0;
  let typed = null;                                  // the current command's plan once sent: { frame, keys }
  let clearing = null;                               // a wrong line being cleared: { step }
  const stats = { mode: 'typed', commands: cmds, executed: [], failed: [], openedAt: -1, closedAt: -1,
    typedKeys: 0, typedChars: 0, mismatches: [], retypes: 0, clears: 0, openFailed: false, closeFailed: false, lastState: null };

  function emit(ev) { queue.push(ev); }
  function press(name) { if (!held.has(name)) { held.add(name); emit(keyEvent(name, true)); } }
  function release(name) { if (held.has(name)) { held.delete(name); emit(keyEvent(name, false)); } }
  function tap(name, frame) { press(name); pending.push({ frame: frame + hold, name }); lastTap = frame; quietUntil = Math.max(quietUntil, frame + hold + settle); }
  function schedule(plan) {
    for (const e of plan) scheduled.push(e);
    const last = plan.length ? plan[plan.length - 1].at : -1;
    if (last >= 0) { quietUntil = Math.max(quietUntil, last + settle); lastTap = last; }
    return plan;
  }
  function planTaps(names, frame) {                  // plain taps back to back, no Shift
    const plan = [];
    let t = frame + 1;
    for (const key of names) {
      plan.push({ at: t, key, down: true, ev: keyEvent(key, true) });
      plan.push({ at: t + hold, key, down: false, ev: keyEvent(key, false) });
      t += hold + gap;
    }
    return plan;
  }
  function readGame() {
    const game = rd(GAME_PTR);
    if (!game) return null;
    return { game, state: rd(game + CONSOLE.state) | 0, line: rs(game + CONSOLE.line) };
  }
  function next(frame) {
    idx++; retypes = 0; typed = null; clearing = null;
    phase = idx < cmds.length ? 'type' : 'close';
    phaseSince = frame;
  }
  function fail(cmd, reason, frame) {
    stats.failed.push({ cmd, reason });
    log(`[console] frame ${frame}: ${JSON.stringify(cmd)} ${reason}; skipping it`);
    next(frame);
  }
  function tick(frame) {
    // the planned events whose frame has come, in plan order, then the releases due
    while (scheduled.length && scheduled[0].at <= frame) {
      const e = scheduled.shift();
      if (e.down) held.add(e.key); else held.delete(e.key);
      emit(e.ev);
    }
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].frame <= frame) { release(pending[i].name); pending.splice(i, 1); }
    const busy = scheduled.length > 0 || pending.length > 0 || frame < quietUntil;
    const g = readGame();
    if (g) stats.lastState = g.state;
    switch (phase) {
      case 'idle':
        if (g && ready(frame)) {
          phase = 'open'; phaseSince = frame;
          log(`[console] frame ${frame}: opening the console to type ${cmds.length} command(s): ${cmds.map((c) => JSON.stringify(c)).join(' ')}`);
        }
        break;
      case 'open':
        if (g && g.state === 2) {
          stats.openedAt = frame;
          log(`[console] frame ${frame}: console open (state 2) after ${frame - phaseSince} frames; line ${JSON.stringify(g.line)}`);
          phase = 'type'; phaseSince = frame;
          break;
        }
        if (frame - phaseSince > openTimeout) {
          stats.openFailed = true; phase = 'done';
          log(`[console] frame ${frame}: the console did not open in ${openTimeout} frames (state ${g ? g.state : 'no game'}); giving up`);
          break;
        }
        if (!busy && frame - lastTap >= retryEvery) { tap('grave', frame); log(`[console] frame ${frame}: grave tapped (state ${g ? g.state : 'no game'})`); }
        break;
      case 'type': {
        if (busy || !g) break;
        if (g.state !== 2) { log(`[console] frame ${frame}: the console closed under us (state ${g.state}); reopening`); phase = 'open'; phaseSince = frame; typed = null; clearing = null; break; }
        const want = cmds[idx];
        if (clearing) {
          if (g.line.length === 0) { clearing = null; log(`[console] frame ${frame}: line cleared`); }
          else if (clearing.step === 'down') {
            // DOWN at the head did not clear it: one Backspace per character (the cursor sits at the end after typing)
            clearing.step = 'backspace';
            schedule(planTaps(new Array(g.line.length).fill('backspace'), frame));
            log(`[console] frame ${frame}: line still ${JSON.stringify(g.line)} after DOWN; ${g.line.length} Backspace(s)`);
            break;
          } else { fail(want, `line ${JSON.stringify(g.line)} could not be cleared`, frame); break; }
        }
        if (typed === null) {
          if (g.line.length) {
            // a leftover line (a previous attempt, a stray character): clear it first
            clearing = { step: 'down' }; stats.clears++;
            tap('down', frame);
            log(`[console] frame ${frame}: line reads ${JSON.stringify(g.line)} before typing; DOWN to clear it`);
            break;
          }
          const plan = schedule(planTyping(want, { hold, gap, start: frame + 1 }));
          const keys = plan.filter((e) => e.down && e.key !== 'shift').length;
          typed = { frame, keys };
          stats.typedKeys += keys;
          log(`[console] frame ${frame}: typing ${JSON.stringify(want)}: ${keys} key(s) over ${plan[plan.length - 1].at - frame} frames${retypes ? ` (retype ${retypes})` : ''}`);
          break;
        }
        if (g.line === want) {
          stats.typedChars += want.length;
          log(`[console] frame ${frame}: line reads ${JSON.stringify(want)} ${frame - typed.frame} frames after the first key (typed); Enter`);
          phase = 'submit'; phaseSince = frame; tap('enter', frame);
          break;
        }
        stats.mismatches.push({ cmd: want, line: g.line, frame });
        if (retypes < maxRetypes) {
          retypes++; stats.retypes++;
          log(`[console] frame ${frame}: line reads ${JSON.stringify(g.line)} after typing ${JSON.stringify(want)}; clearing and typing again (${retypes}/${maxRetypes})`);
          typed = null;
          if (g.line.length) { clearing = { step: 'down' }; stats.clears++; tap('down', frame); }
          break;
        }
        fail(want, `never appeared in the line (reads ${JSON.stringify(g.line)} after ${retypes} retype(s)): typed characters did not reach the console`, frame);
        break;
      }
      case 'submit':
        if (!g) break;
        if (g.line.length === 0) {
          stats.executed.push({ cmd: cmds[idx], frame, clearedAfter: frame - phaseSince, typed: true });
          log(`[console] frame ${frame}: ${JSON.stringify(cmds[idx])} executed (line cleared after ${frame - phaseSince} frame(s), state ${g.state})`);
          next(frame);
        } else if (frame - phaseSince > submitTimeout) {
          fail(cmds[idx], `was not executed (line still ${JSON.stringify(g.line)} ${submitTimeout} frames after Enter)`, frame);
        } else if (!busy && frame - lastTap >= retryEvery) tap('enter', frame);
        break;
      case 'close':
        if (busy || !g) break;
        if (g.state === 0) {
          stats.closedAt = frame; phase = 'done';
          log(`[console] frame ${frame}: console closed after ${frame - phaseSince} frames; ${stats.executed.length}/${cmds.length} command(s) typed and executed`);
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
