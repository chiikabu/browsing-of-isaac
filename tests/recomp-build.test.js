// Incremental lifted rebuilds (recomp round 14g). A lifter change used to cost
// a full recompile of every lifted TU (~17 min) because the tree was split by
// cumulative emitted bytes and one longer function moved every later
// boundary. Two parts keep that from happening again: the emitter's
// --split-va puts a function in a TU named by its ADDRESS bucket, and
// build_boot.py recompiles a TU only when the sha256 of its patched text
// differs from the one recorded beside its object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lift = join(root, 'scripts', 'recomp', 'lift');

test('emit.py: --split-va names a TU by its address bucket', () => {
  const src = readFileSync(join(lift, 'emit.py'), 'utf8');
  assert.ok(src.includes('"--split-va"'), 'the option exists');
  assert.ok(/buckets\.setdefault\(\(va - text_lo\) \/\/ args\.split_va, \[\]\)\.append\(va\)/.test(src),
    'bucket = (va - text_lo) // N');
  assert.ok(/chunk_names\.append\("%s_%03d\.c" % \(args\.module, b\)\)/.test(src),
    'the file name carries the bucket index, not the running chunk index');
});

test('build_boot.py: a lifted TU recompiles only when its text hash changed', () => {
  const src = readFileSync(join(lift, 'build_boot.py'), 'utf8');
  // the fingerprint the hash also folds in is round 15b's, pinned below
  assert.ok(src.includes('hashlib.sha256(path.read_bytes() + dep_fp.encode()).hexdigest()'), 'sha256 of the patched TU text');
  assert.ok(/sha_file = lift_dir \/ \(src\.stem \+ lift_obj_suffix \+ "\.sha"\)/.test(src), 'the hash lives beside the object, per profile suffix');
  assert.ok(/elif sha_file\.exists\(\) and sha_file\.read_text\(\)\.strip\(\) == sha:\s*\n\s*lifted_objs\.append\(obj\)/.test(src),
    'an unchanged TU keeps its object');
  assert.ok(/lifted_objs\.append\(Path\(info\["obj"\]\)\)\s*\n\s*sha, sha_file = lifted_sha\[Path\(info\["src"\]\)\]\s*\n\s*sha_file\.write_text\(sha\)/.test(src),
    'a successful compile records the hash');
  assert.ok(src.includes('if args.recompile_lifted or not obj.exists():'), '--recompile-lifted still forces everything');
});

test('the documented boot lift uses the stable split', () => {
  const doc = readFileSync(join(root, 'docs', 'recomp-architecture.md'), 'utf8');
  const m = doc.match(/python scripts\/recomp\/lift\/emit\.py --exe tools\/isaac-ng\.unpacked\.exe[^\n]*--va-file[^\n]*/);
  assert.ok(m, 'the lift command is documented');
  assert.ok(m[0].includes('--split-va'), 'the documented argv carries --split-va');
  assert.ok(!m[0].includes('--split-bytes'), 'the byte split is no longer the documented default');
});

// Round 15b: two ways an incremental rebuild could lie, both pinned here.
// (1) The TU hash covered only the TU's own text, so editing a header the
// lifted code includes -- recomp_rt.h, where the RECOMP_VA tick interval
// lives -- rebuilt nothing and produced a module still carrying the old
// value, with no sign in the log. (2) The tick interval itself was 2^20
// lifted instructions, which inside the room-entry crawl is minutes, so no
// wall-clock deadline (ISAAC_EXIT_AFTER, the stall watchdog, ISAAC_PROFILE)
// could fire in the one phase they were needed, and a run there could only be
// ended by a kill -- which is how round 15a's withdrawn 41x was produced.
test('build_boot.py: the TU hash covers the headers and the compile flags', () => {
  const src = readFileSync(join(lift, 'build_boot.py'), 'utf8');
  assert.ok(src.includes('dep_fp.update(h.read_bytes())'), 'every dependency header goes into the fingerprint');
  assert.ok(src.includes('dep_fp.update(repr(LIFT_CFLAGS + inc_lift).encode())'), 'the flag list goes into the fingerprint');
  assert.ok(src.includes('hashlib.sha256(path.read_bytes() + dep_fp.encode())'), 'the per-TU hash folds the fingerprint in');
  assert.ok(/lift_dir\.glob\("\*\.h"\)/.test(src), 'the generated headers beside the TUs are dependencies');
});

test('the RECOMP_VA tick interval is a named constant the profiler math follows', () => {
  const h = readFileSync(join(lift, 'recomp_rt.h'), 'utf8');
  const c = readFileSync(join(lift, 'recomp_rt.c'), 'utf8');
  assert.ok(h.includes('#define RECOMP_TICK_MASK 0xFFFFu'), 'the interval is 2^16 by default');
  assert.ok(h.includes('if ((recomp_va_trace_idx & RECOMP_TICK_MASK) == 0u) recomp_stall_tick();'),
    'RECOMP_VA ticks on the named mask, not a literal');
  assert.ok(!/recomp_va_trace_idx & 0xFFFFFu/.test(h), 'the old 2^20 literal is gone');
  assert.ok(c.includes('(double)RECOMP_TICK_MASK + 1.0'), 'instructions per sample derive from the mask');
  assert.ok(!c.includes('1.048576'), 'no hardcoded 2^20 samples-to-instructions factor');
});

test('the node driver can carry V8 flags, which NODE_OPTIONS refuses', () => {
  const src = readFileSync(join(lift, 'boot_integration.mjs'), 'utf8');
  assert.ok(src.includes('process.env.ISAAC_V8_FLAGS && !process.env.ISAAC_V8_FLAGS_APPLIED'),
    'the re-exec happens once, guarded');
  assert.ok(/spawnSync\(process\.execPath, \[\.\.\.flags, \.\.\.process\.execArgv, \.\.\.process\.argv\.slice\(1\)\]/.test(src),
    'the flags land before the script on the child command line');
  assert.ok(src.includes("stdio: 'inherit'"), 'the child keeps the parent stdio so logs are unchanged');
});

// The --fast profile compiles the lifted TUs with RECOMP_MEM_CHECK=0, which
// drops the VA trace, the bounds checks and the stall tick. Anything the rest
// of the runtime needs unconditionally therefore cannot live inside that
// guard: RECOMP_TICK_MASK did, and recomp_rt.c's profiler reads it outside,
// so `build_boot.py --fast` stopped compiling until it was hoisted.
test('recomp_rt.h keeps the unconditional pieces outside the MEM_CHECK guard', () => {
  const h = readFileSync(join(lift, 'recomp_rt.h'), 'utf8');
  const guard = h.indexOf('#if RECOMP_MEM_CHECK');
  assert.ok(guard > 0, 'the guard exists');
  assert.ok(h.indexOf('#define RECOMP_TICK_MASK') < guard,
    'the tick interval is defined before the guard: the profiler reads it in every profile');
  assert.ok(h.indexOf('extern uint32_t g_reentry_eip;') < guard,
    're-entry is unconditional too (--fast still re-enters)');
  assert.ok(h.indexOf('int  isaac_fastpath_mode(void);') < guard,
    'the host fastpath declarations are outside: the WRAP_PATCHES wrappers call them in every profile');
});
