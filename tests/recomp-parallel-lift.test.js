// The parallel lift (recomp round 14i): lift_parallel.py runs emit.py on
// address buckets in worker processes and merges the per-part artifacts into
// the tree a sequential run writes, byte for byte. The contract pinned here:
//
//  - it refuses to run without the stable split (bucket-named TUs are what
//    make the parts independent);
//  - phase-1 workers see the WHOLE start set (--starts-file) so their
//    tail-call / absorb decisions match a single run, and skip the fragment
//    safety net (--no-rescue), which is a global decision;
//  - phase 2 rescues fragments once, against the union of every worker's
//    covered ranges (--rescue-only --covered-file) -- the first cut let each
//    worker rescue what its own bodies missed and lifted 102 functions the
//    sequential tree had absorbed elsewhere;
//  - the merge re-splits the functions by address in emit.py's TU format and
//    regenerates the declaration header sorted, with a CALLOTHER's arity the
//    maximum any part saw, and recomputes the ratios rather than summing them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_parallel.py'), 'utf8');
const emit = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'emit.py'), 'utf8');

test('lift_parallel.py: requires the stable split and the start list', () => {
  assert.ok(src.includes('if not (va_file and split_va and out):'), 'refuses without --va-file/--split-va/--out');
  assert.ok(src.includes('buckets.setdefault((va - text_lo) // split_va, []).append(va)'), 'groups starts by the same bucket rule as emit.py');
});

test('lift_parallel.py: two phases -- workers without rescue, one global rescue pass', () => {
  assert.ok(src.includes('"--starts-file", va_file'), 'workers get the whole start set');
  assert.ok(/"--no-rescue",\s*(#[^\n]*)?\n\s*"--va-file", vf, "--out", pdir, "--stats"/.test(src), 'each worker lifts its own start subset into its own directory without the safety net');
  assert.ok(src.includes('"--rescue-only", "--covered-file", cov_path'), 'phase 2 rescues against the union of the workers\' coverage');
  assert.ok(src.includes('"--va-file", va_file, "--out", rdir'), 'phase 2 walks the whole start list');
  assert.ok(src.includes('def merge_ranges(ranges):'), 'covered ranges from different workers are merged before use');
});

test('emit.py: the phase flags exist and the safety net honours --covered-file', () => {
  for (const flag of ['"--no-rescue"', '"--rescue-only"', '"--covered-file"']) {
    assert.ok(emit.includes('ap.add_argument(' + flag), flag + ' is an emit.py option');
  }
  assert.ok(emit.includes('pending = [] if args.rescue_only else list(want)'), '--rescue-only lifts no wanted function');
  assert.ok(emit.includes('if va in covered or pre_covered(va) or va in lifted or va in handwritten:'), 'a fragment inside a range lifted elsewhere is not rescued');
  assert.ok(/if args\.no_rescue:\s*\n\s*deferred = \[\]/.test(emit), '--no-rescue empties the deferred list');
  assert.ok(emit.includes('os.path.join(args.out, "covered.txt")'), 'every run writes its covered ranges');
});

test('lift_parallel.py: re-splits by address in emit.py\'s format and regenerates the header sorted', () => {
  assert.ok(src.includes('TU_HEADER = \'#include "lifted_decls.h"\\n\\n\''), 'the TU header is emit.py\'s');
  assert.ok(src.includes('RE_FN = re.compile(r"^void sub_([0-9a-f]{8})\\(CpuState \\*restrict s\\) \\{$", re.M)'), 'functions are cut at their definition line');
  assert.ok(src.includes('for va in sorted(funcs):'), 'functions are re-bucketed in address order');
  assert.ok(src.includes('for va in sorted(subs | missing):'), 'declarations are sorted like emit.py writes them');
  assert.ok(src.includes('others[name] = max(others.get(name, 0), line.count("uint32_t") - 1)'), 'a CALLOTHER keeps the widest arity seen');
  assert.ok(src.includes('missing -= set(funcs)'), 'a callee some other part lifted is not missing');
  assert.ok(src.includes('summary["c_bytes_per_x86_byte"] = round(c_bytes / summary["x86_bytes"], 2)'), 'ratios are recomputed, not summed');
  assert.ok(src.includes('parts=len(part_dirs)'), 'the summary records the part count');
  assert.ok(src.includes('shutil.rmtree(pdir, ignore_errors=True)'), 'part directories are removed after the merge');
});
