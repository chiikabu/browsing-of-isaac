// Round 24: a pinned wall clock (ISAAC_EPOCH) so a run can be replayed.
//
// The engine seeds its run RNG from the time of day (_time64 /
// GetSystemTimeAsFileTime), so every run is a different floor and a
// floor-dependent defect -- the start-room ping-pong seen in some runs --
// cannot be replayed. With ISAAC_EPOCH=<unix seconds> both shims answer
// that instant; the deterministic frame clock (QPC) is a separate thing
// and keeps pacing the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'scripts', 'recomp', 'host', 'src');

test('ISAAC_EPOCH pins _time64 and GetSystemTimeAsFileTime to the same instant', () => {
  const crt = readFileSync(join(host, 'host_shims_crt_time.c'), 'utf8');
  assert.ok(crt.includes('int64_t isaac_epoch_override(void) {'), 'the override exists');
  assert.ok(crt.includes('getenv("ISAAC_EPOCH")'), 'it reads ISAAC_EPOCH');
  assert.ok(/int64_t ov = isaac_epoch_override\(\);\s*int64_t now = ov >= 0 \? ov : \(int64_t\)time\(NULL\);/.test(crt),
    '_time64 answers the pinned instant when set, the wall clock otherwise');
  const misc = readFileSync(join(host, 'host_shims_misc.c'), 'utf8');
  const ft = misc.slice(misc.indexOf('void imp_kernel32__GetSystemTimeAsFileTime(CpuState *restrict cpu) {'));
  assert.ok(ft.indexOf('isaac_epoch_override()') > 0 && ft.indexOf('isaac_epoch_override()') < ft.indexOf('clock_gettime(CLOCK_REALTIME'),
    'GetSystemTimeAsFileTime consults the override before the real clock');
  assert.ok(ft.includes('ts.tv_sec = (time_t)ov; ts.tv_nsec = 0;'), 'the pinned instant has no sub-second part');
});
