// Round 24f: the guest/host memory split.
//
// The game preloads its whole sound catalogue at boot -- 1,557 WAV samples,
// 269 MB of PCM once the DLC archives are mounted -- and the 192 MiB guest
// arena ran out at 201 MB live ("OUT OF MEMORY: malloc(10996) failed"). The
// arena is 768 MiB now and everything above it moved up; the host base is
// where wasm's own data starts (-sGLOBAL_BASE), so the same number lives in
// three places that must agree, plus the lifted code's own bound check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostInc = join(root, 'scripts', 'recomp', 'host', 'include', 'isaac_host.h');
const lift = join(root, 'scripts', 'recomp', 'lift');

const def = (src, name) => {
  const m = src.match(new RegExp(`#define ${name}\\s+(0x[0-9a-fA-F]+)u`));
  assert.ok(m, `${name} is defined`);
  return parseInt(m[1], 16);
};

test('the guest address space: heap, stack, TEB, shims, guard, host base are ordered and sized', () => {
  const h = readFileSync(hostInc, 'utf8');
  const heapVa = def(h, 'ISAAC_HEAP_VA'), heapSize = def(h, 'ISAAC_HEAP_SIZE');
  const stackTop = def(h, 'ISAAC_STACK_TOP_VA'), teb = def(h, 'ISAAC_TEB_VA');
  const shim = def(h, 'ISAAC_SHIM_BASE'), limit = def(h, 'ISAAC_GUEST_LIMIT_VA');
  const guard = def(h, 'ISAAC_GUARD_VA'), guardSize = def(h, 'ISAAC_GUARD_SIZE');
  const hostBase = def(h, 'ISAAC_HOST_BASE_VA');
  assert.equal(heapSize, 0x18000000, 'the guest heap is 384 MiB');
  // Round 66 took the arena to 512 MiB and round 69 to 384. It is committed the moment the
  // wasm memory is, so its size is
  // paid in resident bytes on every machine. The engine's own high-water report
  // (host_shims_heap.c, printed at exit) peaks at 250 MiB -- the sound catalogue is
  // nearly all of it and it is preloaded at boot, so a 6,000-frame explored run
  // peaks no higher than a 900-frame one. What is left is deliberate headroom.
  assert.ok(heapSize >= 314 * 1048576, 'the arena keeps headroom over the measured 250 MiB high-water mark');
  assert.ok(heapSize <= 500 * 1048576, 'the headroom is deliberate, not a forgotten ceiling');
  assert.ok(heapVa + heapSize <= stackTop - def(h, 'ISAAC_STACK_SIZE'), 'the heap ends below the guest stack');
  assert.ok(stackTop <= teb && teb < def(h, 'ISAAC_MODULE_BASE') && def(h, 'ISAAC_HANDLE_BASE') < shim,
    'stack, TEB, module tokens, handles, shims in that order');
  assert.ok(shim < limit && limit === guard && guard + guardSize === hostBase,
    'the guard abuts the host base with no gap');
});

test('a reserve-only VirtualAlloc above the cap fails instead of eating the arena', () => {
  // The engine reserves address space for its Lua arena with a ladder (1 GiB,
  // then 512 MB); the arena here is always committed and the guest's Lua
  // allocator is replaced by the host's, so the reservation is dead weight.
  // With 768 MiB the 512 MB step succeeded and the sound catalogue no longer
  // fit; 128 MiB is what the old 192 MiB arena allowed implicitly.
  const heap = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_shims_heap.c'), 'utf8');
  const fn = heap.slice(heap.indexOf('void imp_kernel32__VirtualAlloc(CpuState *restrict cpu) {'));
  assert.ok(fn.includes('if ((type & MEM_RESERVE) && !(type & MEM_COMMIT)) {'), 'reserve-only requests are the ones capped');
  assert.ok(fn.includes('ISAAC_RESERVE_MAX_MIB'), 'the cap is tunable');
  assert.ok(/: 128ul;/.test(fn), 'the default cap is 128 MiB');
  assert.ok(fn.indexOf('cpu->EAX = 0;\n            return;') < fn.indexOf('uint32_t p = guest_malloc(size);'),
    'a refused reserve returns NULL before touching the arena');
});

test('host-written guest scratch is addressed relative to the TEB, never by a raw address', () => {
  // The fake Steam context, the DI8 object, the GL/AL/env/vfprintf scratch
  // pages and the CRT tm buffers used to live at literal 0x0e00xxxx
  // addresses -- the old TEB neighbourhood. After the heap grew that range
  // is inside the guest arena, and the first browser boot after the move
  // died on a fake vtable the allocator had handed out (round 24f).
  const src = join(root, 'scripts', 'recomp', 'host', 'src');
  for (const f of readdirSync(src).filter((n) => n.endsWith('.c'))) {
    const code = readFileSync(join(src, f), 'utf8').split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));   // comments may still quote the old numbers
    for (const l of code) {
      assert.ok(!/0x0e0[0-9a-fA-F]{5}u/.test(l), `${f}: raw old-TEB-region address in code: ${l.trim()}`);
    }
  }
  const steam = readFileSync(join(src, 'host_shims_steam.c'), 'utf8');
  assert.ok(steam.includes('#define STEAM_VTBL_VA   (ISAAC_TEB_VA + 0xd600u)'), 'the fake Steam vtable follows the TEB');
});

test('the host base is the same number in every place it is spelled', () => {
  const h = readFileSync(hostInc, 'utf8');
  const hostBase = def(h, 'ISAAC_HOST_BASE_VA');
  const rt = readFileSync(join(lift, 'recomp_rt.h'), 'utf8');
  const lim = rt.match(/#define RECOMP_GUEST_LIMIT (0x[0-9a-fA-F]+)u/);
  assert.ok(lim && parseInt(lim[1], 16) === hostBase, 'RECOMP_GUEST_LIMIT (the lifted bound check) equals the host base');
  for (const f of [join(lift, 'build_boot.py'), join(root, 'scripts', 'recomp', 'host', 'build_selftest.py')]) {
    const src = readFileSync(f, 'utf8');
    const gb = src.match(/-sGLOBAL_BASE=(\d+)/);
    assert.ok(gb && Number(gb[1]) === hostBase, `${f}: -sGLOBAL_BASE equals the host base`);
    const im = src.match(/-sINITIAL_MEMORY=(\d+)/);
    assert.ok(im && Number(im[1]) > hostBase + 32 * 1048576, `${f}: INITIAL_MEMORY clears the host base with room for the host`);
    assert.ok(/-sMAXIMUM_MEMORY=4294967296/.test(src), `${f}: growth may pass 2 GiB`);
  }
});
