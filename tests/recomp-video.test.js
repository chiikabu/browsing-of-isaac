// Round 26: a scripted way into the Theora video path.
//
// Nothing in the input timeline reaches the endings (cutscenes.xml
// <videopart>, decoded by the theoraplayer worker that runs as a per-frame
// slice since round 24). ISAAC_CUTSCENE=<frame>:<id> makes the frame
// present call Manager::ShowCutscene(id, 1, 0) at that presented frame, on
// a scratch frame, with the Manager in ECX -- the same call the game makes
// when a run ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'scripts', 'recomp', 'host', 'src');

test('ISAAC_CUTSCENE calls Manager::ShowCutscene at the requested presented frame', () => {
  const win = readFileSync(join(host, 'host_shims_win.c'), 'utf8');
  const swap = win.slice(win.indexOf('void imp_gdi32__SwapBuffers(CpuState *restrict cpu) {'));
  assert.ok(swap.includes('getenv("ISAAC_CUTSCENE")'), 'the hook reads ISAAC_CUTSCENE');
  assert.ok(swap.includes('sscanf(e, "%u:%u", &f, &i) == 2'), 'frame:id');
  assert.ok(swap.includes('if (parsed == 1 && g_frames_presented == at_frame) {'), 'fires once, at that presented frame');
  assert.ok(swap.includes('sub.ECX = isaac_r32(0x00c7169cu);'), 'thiscall: the Manager instance in ECX');
  const args = ['isaac_w32(sub.ESP, 0u);     /* third argument */', 'isaac_w32(sub.ESP, 1u);     /* shouldCleanup */',
                'isaac_w32(sub.ESP, id);     /* cutsceneID */', 'isaac_w32(sub.ESP, 0u);     /* return address */'];
  let at = 0;
  for (const a of args) { const i = swap.indexOf(a, at); assert.ok(i > 0, `pushes in order: ${a}`); at = i; }
  assert.ok(swap.includes('isaac_guest_call(0x00958e60u, &sub);'), 'Manager::ShowCutscene is 0x00958e60');
  assert.ok(swap.indexOf('isaac_threads_slice(cpu);') < swap.indexOf('getenv("ISAAC_CUTSCENE")'),
    'the thread slices (the theora worker among them) run before the hook each frame');
});

test("libtheora's FPU-restore (0x00ae4820, `emms; ret`) is a hand-written guest callee", () => {
  // reached only through the decoder's cpu-dispatch table, so function
  // recovery never defined it; the first video trapped on it 16 frames in
  const mf = readFileSync(join(host, 'missing_fns.c'), 'utf8');
  const body = mf.slice(mf.indexOf('void sub_00ae4820(CpuState *restrict s) {'));
  assert.ok(body.length > 0, 'the body exists');
  assert.ok(/void sub_00ae4820\(CpuState \*restrict s\) \{\s*rc_ret\(s\);\s*\}/.test(body), 'it only pops its return address');
});
