// The tail-jump trampoline (recomp round 14d). A guest `jmp` that leaves the
// current lifted function used to be emitted as `sub_T(s); return;`, a nested
// C call; a guest loop whose back-edge is such a jump (the room's entity spawn
// loop, sub_0093805f) nested one native frame per iteration until V8 threw
// "Maximum call stack size exceeded" with nothing on the guest stack. Now the
// jump parks its target in two globals (recomp_jmp_target/recomp_jmp_pending;
// not CpuState fields -- the host struct is only a prefix of the generated
// one) and returns, and every call site runs pending targets from its own
// frame. These pins keep the parts of that contract together: the emitter
// (no nested tail calls; direct calls run pending), the runtime (park + run),
// the header the lifted TUs see, and the generated dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lift = join(root, 'scripts', 'recomp', 'lift');
const host = join(root, 'scripts', 'recomp', 'host');

test('emitter: tail jumps park a target; direct calls run pending targets', () => {
  const src = readFileSync(join(lift, 'lift.py'), 'utf8');
  // no emitted nested tail call is left (the IAT tail-jump path calls a shim, not sub_)
  const nested = [...src.matchAll(/"[^"\n]*sub_%08x\(s\); return;[^"\n]*"/g)].map((m) => m[0]);
  assert.deepEqual(nested, [], `nested tail calls still emitted: ${nested.join(' | ')}`);
  assert.equal((src.match(/recomp_jmp_target = %#xu; recomp_jmp_pending = 1u; return;/g) || []).length, 2,
    'both tail-jump sites (branch_to and the dispatch-loop case) park the target');
  assert.ok(src.includes('sub_%08x(s); if (recomp_jmp_pending) recomp_run_pending(s);'), 'direct calls run pending targets');
  assert.ok(src.includes('recomp_call_indirect(s, %s); if (recomp_jmp_pending) recomp_run_pending(s);'), '`call reg` sites run pending targets');
  const nestedInd = [...src.matchAll(/recomp_call_indirect\(s, [^"]*\); return;/g)].map((m) => m[0]);
  assert.deepEqual(nestedInd, [], `computed tail jumps still nest: ${nestedInd.join(' | ')}`);
  // every computed tail-jump form parks through recomp_jump_indirect: the dispatch-loop default,
  // jmp [slot] (unknown purge token), jmp [slot] expr, jmp reg, the unresolved kind, and the dispatch-loop trampoline line
  assert.equal((src.match(/self\.emit\("recomp_jump_indirect\(s, /g) || []).length, 5, 'five emitted computed tail-jump forms park');
  assert.equal((src.match(/out\.append\("    recomp_jump_indirect\(s, /g) || []).length, 1, 'the dispatch-loop default parks');
});

test('runtime: recomp_jump_indirect parks, recomp_run_pending loops, the dispatcher runs pending', () => {
  const trap = readFileSync(join(host, 'src', 'host_trap.c'), 'utf8');
  assert.ok(trap.includes('uint32_t recomp_jmp_pending, recomp_jmp_target;'), 'the two globals are defined once, in host_trap.c');
  assert.ok(/void recomp_jump_indirect\(CpuState \*restrict s, uint32_t target\) \{[\s\S]{0,200}recomp_jmp_target = target;\s*recomp_jmp_pending = 1u;\s*\}/.test(trap),
    'recomp_jump_indirect parks the target instead of calling');
  // the loop body also carries round 15c's no-progress guard, so allow for it
  assert.ok(/void recomp_run_pending\(CpuState \*restrict s\) \{[\s\S]{0,400}while \(recomp_jmp_pending\) \{[\s\S]{0,1200}recomp_call_indirect\(s, t\);/.test(trap),
    'recomp_run_pending loops until nothing is pending');
  const mk = readFileSync(join(lift, 'mkdispatch.py'), 'utf8');
  // the dispatch path must NOT loop (the loop would nest again through recomp_run_pending -> call_indirect -> dispatch)
  const dispatchBody = mk.slice(mk.indexOf('static int dispatch_block('), mk.indexOf('int isaac_dispatch_return('));
  assert.ok(!dispatchBody.includes('recomp_run_pending'), 'no pending loop inside the dispatch path');
  assert.ok(mk.includes('if (isaac_lifted_dispatch(va, cpu)) { recomp_run_pending(cpu); return; }'), 'the host entry runs pending targets');
  assert.ok(mk.includes('if (recomp_jmp_pending) recomp_run_pending(cpu);\n    if (!isaac_dispatch_return(cpu->EIP, cpu))'), 'the longjmp replay loop runs pending targets');
  const rt = readFileSync(join(lift, 'recomp_rt.h'), 'utf8');
  assert.ok(rt.includes('extern uint32_t recomp_jmp_pending, recomp_jmp_target;') && rt.includes('void recomp_run_pending(struct CpuState *s);'),
    'recomp_rt.h declares the globals and recomp_run_pending for the lifted TUs');
  const h = readFileSync(join(host, 'include', 'isaac_host.h'), 'utf8');
  assert.ok(!/JMP_PENDING|JMP_TARGET/.test(h), 'no trampoline fields in CpuState (its layout is a prefix of the generated struct)');
});

test('shim audit: every PROVIDED/REAL import has a strong body (when the host objects are built)', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('python', ['scripts/recomp/host/audit_shims.py', '--json'], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, `audit_shims.py failed:\n${r.stdout}\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  if (j.status === 'not built') return;
  assert.deepEqual(j.gaps, [], 'imports promised by the shim table but left to the weak trap body');
});

// Round 15c: the room-entry crawl. A lifted function with an unresolved
// intra-function computed jump gets `pc_ = <entry>; for(;;) switch (pc_)`,
// and the `case` labels came from block_starts(), which marks branch targets
// and the LOWEST address in the body -- so a function whose body absorbed a
// lower address range had no case for its own entry, fell to `default:`,
// parked a jump to itself and was dispatched again forever, executing no
// guest instruction (3.8 billion dispatches of sub_0093805f at 20 M/s). Six
// functions in the tree had it. Three things keep it from returning: the
// entry is always a block, the invariant is checked before the tree is built,
// and a no-progress park cycle aborts loudly instead of spinning.
test('the dispatch loop always has a case for the function entry', () => {
  const src = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift.py'), 'utf8');
  assert.ok(src.includes('self.blocks = (block_starts(body) | {start}) if opts.get("dispatch") else set()'),
    'the entry VA is a block, so `switch (pc_)` has a case for it');
  assert.ok(src.includes('out.append("  uint32_t %s = %#xu;" % (PCVAR, self.start))'),
    'the loop is still initialised to the entry');
});

test('check_lifted.py enforces the entry-case invariant and the build runs it', () => {
  const chk = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'check_lifted.py'), 'utf8');
  assert.ok(chk.includes('if pc.group(1) not in cases:'), 'a dispatch loop without its own entry case is a failure');
  assert.ok(chk.includes('return 1 if bad else 0'), 'the checker fails the process');
  assert.ok(/note\[0\] \+= 1/.test(chk), 'an entry-only loop (a `jmp reg` tail call) is counted, not failed');
  const build = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'build_boot.py'), 'utf8');
  assert.ok(build.includes('str(HERE / "check_lifted.py"), "--dir", str(lift_dir)'), 'build_boot.py runs the checker');
  assert.ok(build.includes('check_lifted.py found a lifted-tree defect; not building it'), 'and refuses to build a bad tree');
});

test('a parked jump that makes no progress stops loudly', () => {
  const src = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_trap.c'), 'utf8');
  assert.ok(src.includes('#define RECOMP_STUCK_LIMIT 4096u'), 'the repeat limit is named');
  assert.ok(src.includes('if (t == last && isaac_dispatch_calls() - calls_at_last <= 1u) {'),
    'no progress means the same target and no dispatch beyond this loop own');
  assert.ok(src.includes('uint32_t isaac_dispatch_calls(void);'), 'the progress counter is declared');
  assert.ok(src.includes('This is a lifter '), 'the message says what kind of defect it is');
  assert.ok(/abort\(\);/.test(src.slice(src.indexOf('RECOMP_STUCK_LIMIT'))), 'it aborts rather than spinning');
});

test('ISAAC_HEARTBEAT reports dispatch and host-boundary progress', () => {
  const disp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'mkdispatch.py'), 'utf8');
  assert.ok(disp.includes('getenv("ISAAC_HEARTBEAT")'), 'the dispatcher reads the interval');
  assert.ok(disp.includes('[isaac][hb] %u dispatches, %.1f s, now sub_%08x'), 'it prints count, wall clock and target');
  const trap = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_trap.c'), 'utf8');
  assert.ok(trap.includes('host-boundary calls, %.1f s, now %s!%s'), 'the host boundary has the same heartbeat');
});
