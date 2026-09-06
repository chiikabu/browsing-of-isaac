// Round 43: split_giants.py turns a giant lifted function into trampolined parts.
// The fixture is a small goto-shaped function with a re-entry guard inside its
// declarations (as patch_reentry leaves it), an entry-first goto, 64-bit
// temporaries after the guard, and jumps in both directions across the cut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'recomp', 'lift', 'split_giants.py');

const fixture = [
  'void sub_00400100(CpuState *restrict s) {',
  '  uint32_t EAX = s->EAX;',
  '  uint32_t ESP = s->ESP;',
  '  uint8_t ZF = s->ZF;',
  '  uint32_t u100_4 = 0;',
  '  if (g_reentry_eip != 0u) {',
  '    uint32_t _rva = g_reentry_eip;',
  '    g_reentry_eip = 0u;',
  '    EAX = s->EAX;',
  '    switch (_rva) {',
  '    case 0x00400130u: goto L_00400130;',
  '    default: break;',
  '    }',
  '  }',
  '  uint64_t u200_8 = 0;',
  '  (void)0;',
  '  goto L_00400100;   /* the entry block is not the lowest address */',
  'L_00400080: ;',
  '  u100_4 = EAX + 1u;',
  '  if (ZF) goto L_00400130;',
  '  goto L_00400100;',
  'L_00400100: ;',
  '  EAX = u100_4;',
  '  RECOMP_VA(0x00400104u);',
  '  goto L_00400080;',
  'L_00400130: ;',
  '  u200_8 = (uint64_t)EAX;',
  '  s->EAX = EAX; s->ESP = ESP;',
  '  return;',
  '}',
  'void sub_00400200(CpuState *restrict s) {',
  '  uint32_t EAX = s->EAX;',
  '  (void)0;',
  '  return;',
  '}',
].join('\r\n') + '\r\n';

function run(dir, args) {
  return execFileSync('python', [script, '--dir', dir, ...args], { encoding: 'utf8' });
}

test('a giant becomes parts and a trampoline; gotos across the cut spill, set the target and return; the small function is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isaac-split-'));
  writeFileSync(join(dir, 'lifted_000.c'), fixture);
  const report = run(dir, ['--min', '20', '--part', '8']);
  assert.match(report, /split : sub_00400100 in lifted_000\.c -> 2 parts/);
  const out = readFileSync(join(dir, 'lifted_000.c'), 'utf8');
  assert.ok(out.includes('static uint32_t sub_00400100__pend, sub_00400100__next;'), 'the per-function pending/next pair');
  assert.ok(out.includes('static void __attribute__((noinline)) sub_00400100__p0(CpuState *restrict s, uint32_t nb) {'), 'part 0, never inlined back');
  assert.ok(out.includes('static void __attribute__((noinline)) sub_00400100__p1(CpuState *restrict s, uint32_t nb) {'), 'part 1');
  // part 0 holds L_00400080 and L_00400100; part 1 holds L_00400130
  const p0 = out.slice(out.indexOf('sub_00400100__p0('), out.indexOf('sub_00400100__p1('));
  const p1 = out.slice(out.indexOf('sub_00400100__p1('), out.indexOf('void sub_00400100(CpuState'));
  assert.ok(p0.includes('  case 0x00400080u: goto L_00400080;') && p0.includes('  case 0x00400100u: goto L_00400100;'), 'part 0 enters through its own labels');
  assert.ok(p1.includes('  case 0x00400130u: goto L_00400130;'), 'part 1 enters through its label');
  assert.ok(p0.includes('  if (ZF) { s->EAX = EAX; s->ESP = ESP; s->ZF = ZF; sub_00400100__next = 0x00400130u; sub_00400100__pend = 1u; return; }'),
    'a conditional goto across the cut spills every root, sets the target, flags pending and returns');
  assert.ok(p0.includes('  goto L_00400100;') && p0.includes('  goto L_00400080;'), 'gotos inside a part stay gotos');
  assert.ok(p0.includes('  uint32_t u100_4 = 0;') && !p0.includes('uint64_t u200_8'), 'a part declares only the temporaries it uses');
  assert.ok(p1.includes('  uint64_t u200_8 = 0;') && !p1.includes('u100_4 = 0'), 'the 64-bit temporary after the guard reaches the part that uses it');
  assert.ok(!out.includes('if (g_reentry_eip != 0u) {\r\n    uint32_t _rva'), 'the re-entry guard is gone');
  assert.ok(!out.includes('the entry block is not the lowest address'), 'the entry-first goto is gone');
  const tr = out.slice(out.indexOf('void sub_00400100(CpuState'), out.indexOf('void sub_00400200('));
  assert.ok(tr.includes('/* LIFT-SPLIT v2 sub_00400100: 2 parts'), 'the trampoline is marked with the version');
  assert.ok(p0.includes('  { s->EAX = EAX; s->ESP = ESP; s->ZF = ZF; sub_00400100__next = 0x00400130u; sub_00400100__pend = 1u; return; }   /* fall-through across the cut */'),
    'a part ends with a jump to the next part: a block that falls through into the next one must not fall off the part');
  assert.ok(!p1.includes('fall-through across the cut'), 'the last part has no tail');
  assert.ok(tr.includes('  uint32_t nb = 0x00400100u;') && tr.includes('  if (g_reentry_eip != 0u) { nb = g_reentry_eip; g_reentry_eip = 0u; }'),
    'the trampoline starts at the entry, or at the re-entry block');
  assert.ok(tr.includes('    case 0x00400080u: case 0x00400100u:') && tr.includes('      sub_00400100__p0(s, nb); break;'), 'part 0 routing');
  assert.ok(tr.includes('    case 0x00400130u:') && tr.includes('      sub_00400100__p1(s, nb); break;'), 'part 1 routing');
  assert.ok(tr.includes('    if (!sub_00400100__pend) return;') && tr.includes('    nb = sub_00400100__next;'), 'a real return ends it; a cross-part jump loops');
  assert.ok(out.includes('void sub_00400200(CpuState *restrict s) {\r\n  uint32_t EAX = s->EAX;\r\n  (void)0;\r\n  return;\r\n}'), 'the small function is byte-identical');
  // idempotent: a second run changes nothing
  const again = run(dir, ['--min', '20', '--part', '8']);
  assert.match(again, /split : 0 file\(s\) changed/);
  assert.equal(readFileSync(join(dir, 'lifted_000.c'), 'utf8'), out);
});

test('--check reports and writes nothing; a function that fits one part is left whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isaac-split-'));
  writeFileSync(join(dir, 'lifted_000.c'), fixture);
  const report = run(dir, ['--check', '--min', '20', '--part', '8']);
  assert.match(report, /would change/);
  assert.equal(readFileSync(join(dir, 'lifted_000.c'), 'utf8'), fixture);
  const whole = run(dir, ['--min', '20', '--part', '100']);
  assert.match(whole, /left whole \(fits one part\)/);
  assert.equal(readFileSync(join(dir, 'lifted_000.c'), 'utf8'), fixture);
});

test('an earlier version of a split is unsplit and redone; the current version is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'isaac-split-'));
  writeFileSync(join(dir, 'lifted_000.c'), fixture);
  run(dir, ['--min', '20', '--part', '8']);
  const v2 = readFileSync(join(dir, 'lifted_000.c'), 'utf8');
  // forge an older version: drop the tails and the noinline, change the marker
  const v1 = v2.replace(/  \{ [^\n]*fall-through across the cut \*\/\r\n/g, '').replace(/__attribute__\(\(noinline\)\) /g, '').replace('LIFT-SPLIT v2 ', 'LIFT-SPLIT ');
  assert.notEqual(v1, v2);
  writeFileSync(join(dir, 'lifted_000.c'), v1);
  const report = run(dir, ['--min', '20', '--part', '8']);
  assert.match(report, /split : sub_00400100 in lifted_000\.c -> 2 parts/);
  assert.equal(readFileSync(join(dir, 'lifted_000.c'), 'utf8'), v2, 'the redo reproduces the current split exactly');
  const again = run(dir, ['--min', '20', '--part', '8']);
  assert.match(again, /split : 0 file\(s\) changed/);
});
