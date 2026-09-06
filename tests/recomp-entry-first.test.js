// Round 26: a lifted function must start executing at its ENTRY block.
//
// Ghidra gives some functions a body that absorbs a block BELOW the entry --
// a shared epilogue, or the target of a jump into another function's tail.
// The lifter emits blocks in address order, so a goto-shaped C function fell
// into that lower block first. The string-table loader's second half
// (sub_00a27038, reached by a tail jump from the loader) ran the loader's
// epilogue at 0x00a2701b and returned 0 for every '#KEY': the HUD showed
// "#BASEMENT_NAME". 819 functions in the lifted tree had the shape (778 of
// them thunks in the CRT region). Two fixes, both pinned here: lift.py emits
// `goto L_<entry>;` first, and lift_patches.py's entry-first pass gives the
// already-lifted tree the same goto at build time, without a re-lift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lift = join(root, 'scripts', 'recomp', 'lift');

// A CRLF tree with one function whose lowest block (0xa2701b) precedes its
// entry (0xa27038), one hand-written body, one dispatch-loop function and
// one ordinary function.
function synthetic() {
  return [
    '#include "recomp_decls.h"',
    '',
    'void sub_00a27038(CpuState *restrict s) {',
    '  uint32_t EAX = s->EAX;',
    '  if (g_reentry_eip != 0u) {',
    '    uint32_t _rva = g_reentry_eip;',
    '    g_reentry_eip = 0u;',
    '    switch (_rva) {',
    '    case 0x00a2706fu: goto L_00a2706f;',
    '    default: break;',
    '    }',
    '  }',
    '  (void)0;',
    '  RECOMP_VA(0xa2701bu);',
    '  s->EAX = EAX;',
    '  return;',
    '  RECOMP_VA(0xa27038u);',
    '  EAX = 1u;',
    '  RECOMP_VA(0xa2706fu);',
    'L_00a2706f: ;',
    '  goto L_00a2701b;',
    'L_00a2701b: ;',
    '  return;',
    '}',
    'void sub_00ae4820(CpuState *restrict s) { rc_ret(s); }',
    'void sub_00937fab(CpuState *restrict s) {',
    '  uint32_t pc_ = 0x937fabu;',
    '  for (;;) { switch (pc_) {',
    '  case 0x937d63u: ;',
    '  RECOMP_VA(0x937d63u);',
    '  return;',
    '  } }',
    '}',
    'void sub_00a2b000(CpuState *restrict s) {',
    '  (void)0;',
    '  RECOMP_VA(0xa2b000u);',
    '  return;',
    '}',
    '',
  ].join('\r\n');
}

function runPass(dir, extra = []) {
  return spawnSync('python', [join(lift, 'lift_patches.py'), '--dir', dir, '--entry-first', ...extra],
    { encoding: 'utf8' });
}

test('entry-first pass: the goto and the label land, once, only where the entry is not lowest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isaac-entry-first-'));
  const tu = join(dir, 'lifted_000.c');
  writeFileSync(tu, synthetic());
  let r = runPass(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 goto-shaped function\(s\) start below their entry, 1 fixed now/);
  const t = readFileSync(tu, 'utf8');
  // the goto is the first statement after the re-entry guard
  assert.match(t, /\}\r?\n  \(void\)0;\r?\n  goto L_00a27038;   \/\* LIFT-PATCH entry-first: the entry block is not the lowest address \*\/\r?\n  RECOMP_VA\(0xa2701bu\);/);
  // the label follows the entry's trace line, in the lifter's own order
  assert.match(t, /RECOMP_VA\(0xa27038u\);\r?\nL_00a27038: ;\r?\n  EAX = 1u;/);
  // the existing label, the dispatch-loop function and the ordinary one are untouched
  assert.equal((t.match(/L_00a2706f: ;/g) || []).length, 1);
  assert.ok(!/goto L_00937fab/.test(t), 'dispatch-loop functions are immune');
  assert.ok(!/goto L_00a2b000/.test(t), 'a function whose entry is the lowest block is untouched');
  assert.ok(/rc_ret\(s\); \}/.test(t), 'hand-written bodies are untouched');
  // idempotent, and --check is quiet once applied
  r = runPass(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(tu, 'utf8'), t, 'a second run changes nothing');
  assert.match(r.stdout, /1 goto-shaped function\(s\) start below their entry, 0 fixed now/);
  r = runPass(dir, ['--check']);
  assert.equal(r.status, 0, 'nothing pending: ' + r.stdout);
});

test('entry-first pass --check reports a pending fix without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isaac-entry-check-'));
  const tu = join(dir, 'lifted_000.c');
  writeFileSync(tu, synthetic());
  const r = runPass(dir, ['--check']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /NOT fixed in lifted_000.c/);
  assert.equal(readFileSync(tu, 'utf8'), synthetic(), '--check does not write');
});

test('the emitter itself jumps to the entry block first (lift.py)', () => {
  const s = readFileSync(join(lift, 'lift.py'), 'utf8');
  assert.ok(s.includes('self.entry_goto = bool(addrs) and addrs[0] != self.start and not self.opts.get("dispatch")'),
    'the goto shape detects a lowest block that is not the entry');
  assert.ok(s.includes('self.need_labels.add(self.start)'), 'and asks for the entry label');
  assert.ok(s.includes('out.append("  goto L_%08x;   /* the entry block is not the lowest address */" % self.start)'),
    'and emits the goto right after (void)0;');
  assert.ok(s.includes('apply_entry_first') === false, 'lift.py does not depend on the build-time pass');
  const b = readFileSync(join(lift, 'build_boot.py'), 'utf8');
  assert.ok(b.includes('set(apply_entry_first(lift_dir))'), 'build_boot runs the pass with the other lift patches');
});

test('lifted tree (when present): every goto-shaped function starts at its entry', () => {
  const gu = join(root, 'output', 'recomp', 'lift', 'gu');
  if (!existsSync(gu)) { return; }
  const fnRe = /^void sub_([0-9a-f]{8})(?:__lifted)?\(CpuState \*restrict s\) \{\r?$/;
  const rvRe = /RECOMP_VA\(0x([0-9a-f]+)u\);/;
  let scanned = 0, below = 0, unfixed = [];
  for (const f of readdirSync(gu).filter((n) => /^lifted_\d+\.c$/.test(n)).sort()) {
    const lines = readFileSync(join(gu, f), 'utf8').split('\n');
    let entry = -1, seenAnchor = false, gotoOk = false, dispatch = false;
    for (const line of lines) {
      const m = fnRe.exec(line);
      if (m) { entry = parseInt(m[1], 16); seenAnchor = false; gotoOk = false; dispatch = false; scanned++; continue; }
      if (entry < 0) continue;
      if (line.startsWith('  uint32_t pc_ = ')) { dispatch = true; continue; }
      if (!seenAnchor) { if (line.startsWith('  (void)0;')) seenAnchor = true; continue; }
      if (!gotoOk && line.startsWith('  goto L_') && line.includes('LIFT-PATCH entry-first')) { gotoOk = true; continue; }
      const r = rvRe.exec(line);
      if (r) {
        if (!dispatch && parseInt(r[1], 16) !== entry) { below++; if (!gotoOk) unfixed.push('sub_' + m0(entry) + ' in ' + f); }
        entry = -1;
      }
    }
  }
  assert.ok(scanned > 20000, 'scanned ' + scanned + ' lifted functions');
  assert.ok(below > 0, 'the tree has functions with a block below the entry (' + below + ')');
  assert.deepEqual(unfixed.slice(0, 10), [], unfixed.length + ' function(s) still start below their entry (run the build, which applies the pass)');
});

function m0(va) { return va.toString(16).padStart(8, '0'); }
