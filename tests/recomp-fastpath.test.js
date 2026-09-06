// Host fastpath (recomp boot round 12d): the three deterministic leaf
// functions that dominated the boot (PNG unfilter, adler32, premultiply) are
// re-implemented on the host and installed by lift_patches.py WRAP_PATCHES as
// wrappers around the lifted bodies. A wrapper owns the callee's `ret`; one
// that forgets to pop the return address is the one-slot stack drift the
// project keeps meeting (AGENTS.md), so the contract is pinned here:
//   - every wrapper keeps the lifted body reachable (ISAAC_FASTPATH=0),
//   - consults isaac_fastpath_mode() (0 lifted / 1 host / 2 verify),
//   - ends the host path with the exact ret emulation,
//   - calls a host function that host_fastpath.c defines and recomp_rt.h
//     declares, and the verify path reports through isaac_fastpath_mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lift = join(root, 'scripts', 'recomp', 'lift');
const hostSrc = join(root, 'scripts', 'recomp', 'host', 'src');

function patchesIn(startMarker, endMarker) {
  const lp = readFileSync(join(lift, 'lift_patches.py'), 'utf8');
  const a = lp.indexOf(startMarker);
  const b = lp.indexOf(endMarker, a);
  assert.ok(a > 0 && b > a, `${startMarker} block found`);
  const block = lp.slice(a, b);
  const out = [];
  for (const m of block.matchAll(/^\s*(0x[0-9a-f]{8}): """([\s\S]*?)^""",/gm)) {
    out.push({ va: m[1], body: m[2] });
  }
  return out;
}
// the fastpath wrappers stop where the probe table starts: they are different
// categories with different contracts (round 23)
const wrapPatches = () => patchesIn('WRAP_PATCHES: dict', 'PROBE_PATCHES: dict');
const probePatches = () => patchesIn('PROBE_PATCHES: dict', 'def apply_wrap_patches');

test('WRAP_PATCHES: every wrapper keeps the lifted body, consults the mode, and owns the ret', () => {
  const patches = wrapPatches();
  assert.ok(patches.length >= 3, `expected the three round-12 wrap patches, parsed ${patches.length}`);
  const fast = readFileSync(join(hostSrc, 'host_fastpath.c'), 'utf8');
  const rt = readFileSync(join(lift, 'recomp_rt.h'), 'utf8');
  for (const { va, body } of patches) {
    const name = `sub_${va.slice(2)}`;
    assert.ok(body.startsWith(`void ${name}(CpuState *restrict s) {`), `${name}: wrapper signature`);
    assert.ok(body.includes(`RECOMP_VA(0x${va.slice(2).replace(/^0+/, '')}u);`), `${name}: stamps its VA`);
    assert.ok(body.includes(`${name}__lifted(s)`), `${name}: lifted body reachable (ISAAC_FASTPATH=0)`);
    assert.ok(body.includes('isaac_fastpath_mode()'), `${name}: consults the fastpath mode`);
    assert.ok(body.includes('isaac_fastpath_mismatch('), `${name}: verify path reports mismatches`);
    // the host path must end with the callee's ret: pop EIP, ESP += 4 (+ the
    // callee's own purge for a `ret N`, spelled `4u + Nu`)
    const ret = /s->EIP = MEMR32\(s->ESP\);\s*\n\s*s->ESP \+= 4u(?: \+ \d+u)?;\s*\n}\s*$/;
    assert.match(body, ret, `${name}: host path ends with the ret emulation (pop EIP, ESP += 4 [+ purge])`);
    // the lifted fallback returns without touching the stack (the lifted
    // body performs its own ret)
    for (const m of body.matchAll(/__lifted\(s\);\s*(return;)?/g)) {
      assert.ok(m[1] || /__lifted\(s\);\s*\n\s*if \(/.test(body.slice(m.index)),
        `${name}: after the lifted body the wrapper must return or compare, never ret again`);
    }
    // each host function called is defined in host_fastpath.c and declared in recomp_rt.h
    const calls = new Set([...body.matchAll(/\b(isaac_fast_[a-z0-9_]+)\(/g)].map((m) => m[1]));
    assert.ok(calls.size >= 1, `${name}: calls a host fastpath function`);
    for (const fn of calls) {
      assert.match(fast, new RegExp(`^[a-z0-9_ ]*\\b${fn}\\(`, 'm'), `${fn}: defined in host_fastpath.c`);
      assert.ok(rt.includes(`${fn}(`), `${fn}: declared in recomp_rt.h for the lifted TUs`);
    }
  }
});

test('WRAP_PATCHES target lifted functions (when the lift output is present)', () => {
  const tbl = join(root, 'output', 'recomp', 'lift', 'gu', 'dispatch_tbl.c');
  if (!existsSync(tbl)) return;   // binary-derived output is not in the tree
  const text = readFileSync(tbl, 'utf8');
  for (const { va } of wrapPatches()) {
    const name = `sub_${va.slice(2)}`;
    assert.ok(text.includes(name), `${name}: present in the dispatch table`);
  }
});

// the body of a host function: from its definition line (not a declaration or
// a call -- the round-27 functions call one another) to the closing brace
function hostBody(src, fn) {
  const m = src.match(new RegExp(`^[a-z0-9_ *]*\\b${fn}\\([^)]*\\) \\{`, 'm'));
  assert.ok(m, `${fn} defined in host_fastpath.c`);
  return src.slice(m.index, src.indexOf('\n}\n', m.index));
}

test('host_fastpath.c: bounds-checked guest access and the verify counter', () => {
  const fast = readFileSync(join(hostSrc, 'host_fastpath.c'), 'utf8');
  for (const fn of ['isaac_fast_unfilter', 'isaac_fast_adler32', 'isaac_fast_premultiply', 'isaac_fast_pathhash']) {
    assert.ok(hostBody(fast, fn).includes('isaac_is_guest_va('), `${fn}: checks its guest range before touching memory`);
  }
  // round 27: the deciding predicates check the ranges; the workers they gate
  // (keystream_xor, read_window, mutex_take/drop) run only behind them
  for (const fn of ['isaac_fast_guest_range', 'isaac_fast_isaac', 'isaac_fast_keystream_ok', 'isaac_fast_read_plan',
                    'isaac_fast_mutex_std']) {
    assert.match(hostBody(fast, fn), /isaac_is_guest_va\(|isaac_fast_guest_range\(/,
      `${fn}: checks its guest range before touching memory`);
  }
  assert.ok(hostBody(fast, 'isaac_fast_guest_range').includes('va + len >= va'),
    'guest_range: a range that wraps around the address space is rejected');
  assert.ok(fast.includes('uint32_t isaac_fastpath_mismatches(void)'), 'mismatch counter exported');
  assert.ok(/getenv\("ISAAC_FASTPATH"\)/.test(fast) && /getenv\("ISAAC_FASTPATH_VERIFY"\)/.test(fast),
    'mode switches documented in the env');
});

// Round 27: the leaves of the fast profile's dispatch census (recomp-
// architecture.md 21.42). Two rules on top of the round-12 contract: the host
// path's purge equals the callee's `ret N` (a wrong purge is the one-slot
// stack drift again), and a verify path runs the trampoline after the lifted
// body, because these bodies end in tail jumps -- the ISAAC core's jump-table
// cases, AddRef's jump into Unlock -- that are only parked when the body
// returns, so a compare without it would read the state mid-function.
const ROUND27 = {
  '0x00aa94a0': { purge: 0, host: 'isaac_fast_isaac' },            // ISAAC core: thiscall, no args
  '0x00a89d70': { purge: 8, host: 'isaac_fast_keystream_xor' },    // keystream XOR: thiscall (buf, len)
  '0x00a69510': { purge: 12, host: 'isaac_fast_read_window' },     // ArchivedFile::read: thiscall (buf, size, count)
  '0x00a157f0': { purge: 4, host: 'isaac_fast_mutex_take' },       // Mutex::Lock(timeout)
  '0x00a159a0': { purge: 0, host: 'isaac_fast_mutex_drop' },       // Mutex::Unlock
  '0x0040c690': { purge: 0, host: 'isaac_fast_mutex_take' },       // handle AddRef
  '0x0040c6b0': { purge: 0, host: 'isaac_fast_mutex_take' },       // handle TryAddRef
  '0x0040c630': { purge: 0, host: 'isaac_fast_mutex_take' },       // handle Release
  '0x00a12240': { purge: 0, host: 'isaac_fast_mutex_take' },       // owner check: cdecl(holder)
};

test('round 27 wrappers: present, purge = ret N, verify runs the trampoline, host work behind the decision', () => {
  const patches = new Map(wrapPatches().map((p) => [p.va, p.body]));
  for (const [va, { purge, host }] of Object.entries(ROUND27)) {
    const body = patches.get(va);
    assert.ok(body, `${va}: wrapped`);
    const tail = purge ? `s->ESP += 4u + ${purge}u;` : 's->ESP += 4u;';
    assert.ok(body.trimEnd().endsWith(`${tail}\n}`), `${va}: the host path pops the return address and ${purge} bytes of arguments`);
    assert.match(body, /__lifted\(s\);\s*\n\s*if \(recomp_jmp_pending\) recomp_run_pending\(s\);/,
      `${va}: the verify path runs the parked tail jump before comparing`);
    assert.equal((body.match(/isaac_fastpath_mode\(\)/g) || []).length, 1, `${va}: the mode is read once`);
    // the exit census (isaac_fastpath_report): every lifted fallback and every
    // completed verify compare is counted, so "0 mismatches" comes with the
    // number of calls that were actually compared
    const short = va.slice(2).replace(/^0+/, '');
    for (const m of body.matchAll(/__lifted\(s\); return; \}/g)) {
      const line = body.slice(body.lastIndexOf('\n', m.index), m.index);
      assert.ok(line.includes(`isaac_fastpath_count(0x${short}u, 1);`), `${va}: each lifted fallback is counted`);
    }
    assert.match(body, new RegExp(`recomp_run_pending\\(s\\);[^\\n]*\\n\\s*isaac_fastpath_count\\(0x${short}u, 2\\);`),
      `${va}: a completed verify compare is counted`);
    // the host worker runs only after the mode test: never before the wrapper
    // has decided against the lifted body
    const decide = body.indexOf('__lifted(s); return; }');
    const work = body.indexOf(`${host}(`);
    assert.ok(decide > 0 && work > decide, `${va}: ${host} runs only after the lifted-body decision`);
  }
});

test('round 27: the lock-based wrappers take a mutex only through the standard-pair predicate', () => {
  const patches = new Map(wrapPatches().map((p) => [p.va, p.body]));
  for (const va of ['0x0040c690', '0x0040c6b0', '0x0040c630', '0x00a12240']) {
    const body = patches.get(va);
    assert.ok(body.includes('isaac_fast_mutex_std('), `${va}: checks the embedded mutex's vtable is the engine's Lock/Unlock pair`);
    // every take is matched by a drop on the host path
    assert.equal((body.match(/isaac_fast_mutex_take\(/g) || []).length, (body.match(/isaac_fast_mutex_drop\(/g) || []).length,
      `${va}: lock and unlock in equal number`);
  }
  const lock = patches.get('0x00a157f0');
  assert.ok(lock.includes('timeout != 0xffffffffu') && lock.includes('isaac_fast_mutex_free('),
    'Lock: only the uncontended INFINITE wait is taken on the host');
});

// Round 23: observe-only probes. The dispatch watch can only see functions
// reached through the dispatcher, and the audio investigation kept needing the
// other question -- did this directly called function run, and with what?
// A probe answers it, and its contract is the opposite of a fastpath wrapper's:
// it must NOT emulate the ret, because the lifted body it always calls does
// that itself, and it must not depend on the fastpath mode.
test('PROBE_PATCHES: every probe delegates once and leaves the guest untouched', () => {
  for (const { va, body } of probePatches()) {
    const name = `sub_${va.slice(2)}`;
    assert.ok(body.startsWith(`void ${name}(CpuState *restrict s) {`), `${name}: wrapper signature`);
    assert.ok(body.includes(`RECOMP_VA(0x${va.slice(2).replace(/^0+/, '')}u);`), `${name}: stamps its VA`);
    assert.equal((body.match(new RegExp(`${name}__lifted\\(s\\)`, 'g')) || []).length, 1,
      `${name}: calls the lifted body exactly once`);
    assert.ok(!/s->EIP\s*=/.test(body), `${name}: a probe must not touch EIP -- the lifted body owns the ret`);
    assert.ok(!/s->ESP\s*(\+|-)?=/.test(body), `${name}: a probe must not touch ESP`);
    assert.ok(body.includes('isaac_probe_on()'), `${name}: logging is off unless ISAAC_PROBE=1`);
  }
});

test('the probe helpers exist where lifted code can reach them', () => {
  const fast = readFileSync(join(hostSrc, 'host_fastpath.c'), 'utf8');
  const rt = readFileSync(join(lift, 'recomp_rt.h'), 'utf8');
  for (const fn of ['isaac_probe_on', 'isaac_probe_hit', 'isaac_probe_str']) {
    assert.match(fast, new RegExp(`^[a-z0-9_ ]*\\b${fn}\\(`, 'm'), `${fn}: defined in host_fastpath.c`);
    assert.ok(rt.includes(`${fn}(`), `${fn}: declared in recomp_rt.h`);
  }
});

test('round 38: the dispatcher has a direct-mapped cache in front of its index, tried before the shim check, off under any dispatch mode', () => {
  const gen = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'mkdispatch.py'), 'utf8');
  assert.ok(gen.includes('int isaac_lifted_dispatch_cached(uint32_t va, CpuState *restrict cpu) {'), 'the cached entry exists');
  assert.ok(gen.includes('if (!g_dfast || !va) return 0;') && gen.includes('else return 0;'), 'a miss, a mode, or a null target falls through');
  assert.ok(gen.includes('  ++g_dcalls; ++g_dchits;\n  g_dcount[id]++;\n  g_dfn[id](cpu);\n  return 1;'), 'a hit still counts (the census stays exact)');
  assert.ok(gen.includes('typedef struct { uint32_t va[2]; uint16_t id[2]; uint8_t next; } dcache_set;'), 'two ways per set');
  assert.ok(gen.includes('cache %u hits / %u fills'), 'the census reports the hit rate');
  assert.ok(gen.includes('if (!g_dfast && g_hb_every == 0 && g_watch_n == 0 && g_dtime_on == 0 && g_dcount) g_dfast = 1;'),
    'the cache turns on only when heartbeat, watch and timing are all off');
  assert.ok(gen.includes("c->va[w] = va; c->id[w] = id; c->next = (uint8_t)(w ^ 1u);"), 'a resolved function entry fills the older way');
  const trap = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_trap.c'), 'utf8');
  assert.ok(/void recomp_call_indirect\(CpuState \*restrict s, uint32_t target\) \{\s*if \(isaac_lifted_dispatch_cached\(target, s\)\)\s*return;\s*if \(isaac_indirect_call\(target, s\)\)/.test(trap),
    'the indirect call tries the cache before the shim check');
  assert.ok(trap.includes('__attribute__((weak)) int isaac_lifted_dispatch_cached('), 'a weak fallback keeps the host linking without the lifted module');
});

test('round 49: the imdct butterfly has a host fastpath with the verify mode', () => {
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  assert.ok(lp.includes('LIFT-PATCH wrap 0x00aa3270: host imdct butterfly (host_fastpath.c)'), 'the wrapper for 0x00aa3270');
  assert.ok(lp.includes('isaac_fast_imdct_r_loop(lim, e, d0, koff, a, k1);'), 'the host loop runs by default');
  assert.ok(lp.includes('if (!isaac_fast_verify_equal(host, lo, len)) isaac_fastpath_mismatch("imdct_r_loop", lim, len);'), 'ISAAC_FASTPATH_VERIFY compares the touched range');
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  assert.ok(fp.includes('void isaac_fast_imdct_r_loop(uint32_t lim, uint32_t e_va, uint32_t d0, uint32_t k_off,'), 'the host implementation');
  assert.ok(fp.includes('e2[-7] = k00 * A3[1] + k01 * A3[0];'), 'four butterflies per iteration in the source order');
});

test('round 50: the whole inverse_mdct has a host fastpath with the verify mode', () => {
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  assert.ok(lp.includes('LIFT-PATCH wrap 0x00aa38a0: host inverse_mdct (host_fastpath.c)'), 'the wrapper for 0x00aa38a0');
  assert.ok(lp.includes('if (!isaac_fast_verify_equal(host, buf, len)) isaac_fastpath_mismatch("inverse_mdct", n, bt);'), 'the verify mode compares the n floats at buffer');
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  for (const fn of ['imdct_iter0_loop', 'imdct_s_loop', 'imdct_ld654_loop', 'imdct_ilog'])
    assert.ok(fp.includes(`static ${fn === 'imdct_ilog' ? 'int' : 'void'} ${fn}(`), `${fn}: the helper is on the host`);
  assert.ok(fp.includes('if (off < so) return 0;                                       /* the original would crash here */'), 'a scratch below setup_offset is left to the lifted body');
  assert.ok(fp.includes('buf2 = (float *)isaac_g(ab + (uint32_t)(to - (int32_t)((uint32_t)n2 * 4u)));'), 'the scratch is the guest temp region the original uses');
  assert.ok(fp.includes('imdct_ld654_loop(n >> 5, buffer, n2 - 1, A, n);'), 'the last stage');
});

test('round 57: the archive inflate_fast has a host fastpath with the verify mode, and the keystream XOR goes by words', () => {
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  const rt = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'recomp_rt.h'), 'utf8');
  const st = readFileSync(join(root, 'scripts', 'recomp', 'host', 'selftest.c'), 'utf8');
  assert.ok(lp.includes('LIFT-PATCH wrap 0x00adb9c0: host archive inflate_fast (host_fastpath.c)'), 'the wrapper for 0x00adb9c0');
  assert.ok(lp.includes('isaac_fastpath_mismatch("inflate_ring", (uint32_t)hr, s->EAX);') && lp.includes('memcpy(snap, RECOMP_PTR(base), wlen);'),
    'the verify mode compares the whole ring window, the state, the input struct and eax');
  assert.ok(lp.includes('  s->EAX = (uint32_t)isaac_fast_inflate_ring(lenbits, distbits, lcode, dcode, st, in);\n  s->EIP = MEMR32(s->ESP);\n  s->ESP += 4u;\n}'), 'the host path returns in eax with a plain ret');
  assert.ok(fp.includes('int isaac_fast_inflate_ring(uint32_t lenbits, uint32_t distbits, uint32_t lcode, uint32_t dcode, uint32_t st, uint32_t in) {'), 'the host inflate_fast');
  assert.ok(fp.includes('isaac_w32(in + 0x18u, 0xba9ec0u);') && fp.includes('isaac_w32(in + 0x18u, 0xba9edcu);'), "the engine's own error strings");
  assert.ok(fp.includes('if (left < 0x102u) return 0;') && fp.includes('if (avail < 10u || !isaac_fast_guest_range(next, avail)) return 0;'),
    'the gate asks of the first iteration what the loop asks of the rest');
  assert.ok(rt.includes('int  isaac_fast_inflate_ring_ok(') && rt.includes('int  isaac_fast_inflate_ring('), 'declared for the lifted TUs');
  assert.ok(st.includes("wraps to its end (one byte from the end, the rest from the start)"), 'the selftest exercises the ring');
  assert.ok(fp.includes('static inline uint32_t keystream_word(uint32_t ctx, uint32_t *c) {') && fp.includes('memcpy(&v, p + k, 4u);'), 'the keystream XOR takes a word at a time');
});

test('round 58: miniz tinfl_decompress has a host fastpath with the verify mode', () => {
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  const rt = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'recomp_rt.h'), 'utf8');
  const st = readFileSync(join(root, 'scripts', 'recomp', 'host', 'selftest.c'), 'utf8');
  assert.ok(lp.includes('LIFT-PATCH wrap 0x00a85710: host miniz tinfl_decompress (host_fastpath.c)'), 'the wrapper for 0x00a85710');
  assert.ok(lp.includes('isaac_fastpath_mismatch("tinfl", (uint32_t)hr, s->EAX);') && lp.includes('memcpy(snap, RECOMP_PTR(r), 0x2aedu);'), 'the verify mode compares the decompressor, the window, both sizes and eax');
  assert.ok(lp.includes('  s->EAX = (uint32_t)isaac_fast_tinfl(r, in_next, in_size, out_start, out_next, out_size, flags);\n  s->EIP = MEMR32(s->ESP);\n  s->ESP += 4u;\n}'), 'the host path returns in eax with a plain ret (the caller drops the arguments)');
  assert.ok(fp.includes('int isaac_fast_tinfl(uint32_t r_va, uint32_t in_next_va, uint32_t in_size_va, uint32_t out_start_va, uint32_t out_next_va, uint32_t out_size_va, uint32_t flags) {'), 'the host tinfl');
  for (const state of [1, 2, 3, 5, 6, 7, 9, 10, 11, 14, 16, 17, 18, 21, 23, 24, 25, 26, 27, 32, 34, 35, 36, 37, 38, 39, 40, 41, 42, 51, 52, 53])
    assert.ok(new RegExp(`TF_(CR_RETURN(_FOREVER)?|GET_BYTE|GET_BITS|SKIP_BITS|HUFF_DECODE)\\(${state},`).test(fp), `coroutine state ${state} is the source's`);
  assert.ok(!/TF_[A-Z_]+\(54,/.test(fp), 'no state 54: the guest is miniz 1.x');
  assert.ok(fp.includes('else { c = 0; break; }') && fp.includes('if ((dist > dist_from_out_buf_start) && (flags & 4u)) { TF_CR_RETURN_FOREVER(37, -1); }'), 'the 1.x details: a 0 byte past the input, the old distance test');
  assert.ok(fp.includes('if (span == 0u || (span & (span - 1u)) || !isaac_fast_guest_range(out_start, span)) return 0;'), 'a ring that is not a power of two is left to the lifted body');
  assert.ok(rt.includes('int  isaac_fast_tinfl_ok(') && rt.includes('int  isaac_fast_tinfl('), 'declared for the lifted TUs');
  assert.ok(st.includes('reassembles byte for byte over HAS_MORE_OUTPUT rounds') && st.includes('resumes at every state and ends DONE'), 'the selftest decodes zlib-made streams whole, a byte at a time, and through a ring');
});

test('round 62: the keystream XOR goes sixteen bytes at a time where the build has wasm SIMD', () => {
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  assert.ok(fp.includes('#ifdef __wasm_simd128__\n#include <wasm_simd128.h>\n#endif'), 'the intrinsics only where the build has them');
  assert.ok(fp.includes('wasm_v128_store(p + k, wasm_v128_xor(wasm_v128_load(p + k), wasm_v128_load(&c[idx + 1u])));'), 'one v128 XOR for four words');
  assert.ok(fp.includes('if (idx + 4u > 256u) {') && fp.includes('if (idx + 4u > 0xffu) { isaac_fast_isaac(ctx, NULL); c[0] = 0u; }'), 'a block touching r[255] goes word by word; a block ending there refills');
  const bs = readFileSync(join(root, 'scripts', 'recomp', 'host', 'build_selftest.py'), 'utf8');
  assert.ok(bs.includes('"-msimd128"'), 'the selftest build has SIMD too, so its checks run the v128 path');
  const st = readFileSync(join(root, 'scripts', 'recomp', 'host', 'selftest.c'), 'utf8');
  assert.ok(st.includes('isaac_fast_keystream_xor(holder, buf, 40u);') && st.includes('eight words of the new block taken'), 'forty bytes across the refill');
});

test('round 64: the archive inflater reports what it decoded', () => {
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  assert.ok(fp.includes('++g_tinfl_calls; g_tinfl_in += (uint64_t)(in_cur - in_next); g_tinfl_out += (uint64_t)(out_cur - out_next); if (status == 0) ++g_tinfl_done;'), 'counted at the exit');
  assert.ok(fp.includes('archive inflater: %llu calls, %.1f MB in, %.1f MB out, %llu streams finished'), 'reported with the census, in every mode');
});

test('round 75: a static block takes the tables the first one built', () => {
  // miniz fills the fixed code lengths and then runs the same table build a
  // dynamic block runs -- 3.2 KB of memset and 320 symbols, per 0x400 block.
  // zlib has had those tables precomputed since 1995. The archive is packed in
  // static blocks now (optimize.py huffman), so this is the cost that was left.
  const fp = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_fastpath.c'), 'utf8');
  assert.ok(fp.includes('static int16_t g_tf_fix_lookup[2][TF_LOOKUP_SIZE];') && fp.includes('static int16_t g_tf_fix_tree[2][576];'),
    'the tables are kept for both trees');
  assert.ok(fp.includes('if (g_tf_fix_ready) {'), 'and used when there are some');
  // m_type = -1 is what makes the build loop below run zero iterations: it is the
  // state that loop exits in anyway, so the decode continues exactly as it did
  assert.ok(fp.includes('TF_U32(0x18) = 0xffffffffu;'), 'the build loop is skipped by the state it would have ended in');
  assert.ok(fp.includes('for (; (int32_t)TF_U32(0x18) >= 0; TF_U32(0x18)--) {'), 'which is still the loop');
  // the first static block builds them the old way and they are kept from it, so
  // the tables in use are the ones the decoder itself produced
  assert.ok(fp.includes('g_tf_fix_pending = 1u;') && fp.includes('if (g_tf_fix_pending) {') && fp.includes('g_tf_fix_ready = 1u;'),
    'the first build is what is kept');
  assert.ok(fp.includes('static blocks: %llu, of which %llu took the kept tables'), 'and the census says how often it paid');
});

test('round 75: the packer can spend bytes to drop a Huffman table', () => {
  const arc = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'archive.py'), 'utf8');
  assert.match(arc, /def _best_piece\(block: bytes, final: bool, level: int, fixed_cost: int \| None\) -> bytes:/);
  assert.match(arc, /fix = _deflate_piece\(block, final, level, zlib\.Z_FIXED\)/);
  assert.match(arc, /if fix == dyn:/, 'incompressible blocks are stored either way and are left alone');
  assert.match(arc, /if len\(fix\) - len\(dyn\) <= fixed_cost and _piece_ok\(fix, final\):/);
  // the format's two limits are still the format's two limits
  assert.match(arc, /return len\(piece\) <= PIECE_MAX and \(final or len\(piece\) != BLOCK\)/);
  const opt = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'optimize.py'), 'utf8');
  assert.match(opt, /def cmd_huffman\(args\) -> int:/);
  assert.match(opt, /"fixed_cost": BUDGET_ALL if args\.cost is None else args\.cost/, 'the default is no budget at all');
  assert.match(opt, /if packed == 4 \* n \+ e\.size or e\.size == 0:/, 'a stored entry is passed through, not re-encoded');
});

test('round 51: the guest heap report names the touched span (the arena pages that stay resident)', () => {
  const heap = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_shims_heap.c'), 'utf8');
  assert.ok(heap.includes('if (b + need > g_heap_top) g_heap_top = b + need;'), 'the highest block end is tracked at every allocation');
  assert.ok(heap.includes('touched span   : %.1f MiB (highest block end 0x%08x)'), 'and reported with the high-water figures');
});

test('round 51: a retired wrapper leaves the lifted TU clean (the body back under its own name, no stale wrapper)', () => {
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  assert.ok(lp.includes('live = set(WRAP_PATCHES) | set(PROBE_PATCHES)'), 'the live set of wrappers');
  assert.ok(lp.includes('print("wrap-patch %s: retired, the lifted body is %s again in %s" % (name, name, tu.name))'), 'a retired wrapper is undone in the TU');
  assert.ok(lp.includes('text = text.replace("void %s__lifted(CpuState *restrict s);\\n" % name, "", 1)'), 'its forward declaration goes too');
});

test('round 52: the save-select delete confirmation is gated by the page (EDIT FILE), the engine flow untouched without a page', () => {
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  assert.ok(lp.includes('LIFT-PATCH 0x009d9d59 (round 52): the EDIT FILE menu.'), 'the block patch at 0x9d9d59');
  // the block text is a Python literal in lift_patches.py (its newlines are escapes there)
  assert.ok(lp.includes('if (!isaac_editfile_gate(EDI)) {') && lp.includes('goto L_009da447;'), 'the gate skips to the common exit');
  assert.ok(lp.includes('u44180_4 = ((uint32_t)0xb7fb20u);'), 'the block still pushes DeleteConfirmationAppear when the gate says go');
  const win = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_shims_win.c'), 'utf8');
  assert.ok(win.includes('if (typeof window === "undefined" || typeof window.isaacEditFile !== "function") return 1;'), 'no page menu: the engine prompt');
  assert.ok(win.includes('if (window.isaacEditFileDelete === slot) { window.isaacEditFileDelete = -1; return 1; }'), 'the menu chose Delete: the engine prompt now');
  assert.ok(win.includes('slot = (int)*(const uint32_t *)isaac_g(menu_va + 4u);'), 'the slot is this[1]');
  const rt = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'recomp_rt.h'), 'utf8');
  assert.ok(rt.includes('int  isaac_editfile_gate(uint32_t menu_va);'), 'declared for the lifted TUs');
});
