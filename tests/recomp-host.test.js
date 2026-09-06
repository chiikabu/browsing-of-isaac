/**
 * Host/boot layer tests.
 *
 * These assert the BOOT CONTRACT rather than re-deriving it: every number here
 * is cross-checked against the PE by scripts/recomp/host/boot_tables.py, so a
 * failure means either the extraction drifted or the target binary changed.
 *
 * Artifacts live under output/recomp/host/ (gitignored). If they are absent the
 * suite skips rather than fails, so a fresh clone still runs green:
 *     python scripts/recomp/host/boot_tables.py
 *     python scripts/recomp/host/memimage.py
 *     python scripts/recomp/host/gen_shims.py
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'output', 'recomp', 'host');
const src = join(root, 'scripts', 'recomp', 'host');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const has = (f) => existsSync(join(host, f));

test('host layer sources exist', () => {
  for (const f of [
    'pe.py', 'boot_tables.py', 'memimage.py', 'gen_shims.py',
    'gl_census2.py', 'gl_legacy_audit.py',
    'include/isaac_host.h',
    'src/host_boot.c', 'src/host_trap.c', 'src/host_gl_clientarrays.c',
  ]) {
    assert.ok(existsSync(join(src, f)), `missing ${f}`);
  }
});

test('boot tables: the three gaps are fully enumerated', (t) => {
  if (!has('boot-tables.json')) return t.skip('run boot_tables.py');
  const b = readJson(join(host, 'boot-tables.json'));

  // Gap 1: 650 IAT slots = 622 symbols + 28 null terminators.
  assert.equal(b.iat.slotsWalked, 650);
  assert.equal(b.iat.symbolSlots, 622);
  assert.equal(b.iat.terminatorSlots, 28);
  assert.equal(b.iat.descriptorCount, 28);
  // The IAT data directory must cover exactly the slots we walked, or the
  // rewrite would miss some.
  assert.equal(b.iat.iatSpanBytes, b.iat.iatDirSize);
  // Unbound on disk: every slot still holds its name-table RVA.
  assert.equal(b.iat.slotsWhoseDiskValueIsNameRva, 622);
  assert.equal(b.iat.boundDescriptors, 0);
  assert.equal(b.iat.ordinalOnlySlots, 0);

  // Gap 2: exactly one TLS callback.
  assert.equal(b.tls.present, true);
  assert.equal(b.tls.callbacks.length, 1);
  assert.equal(b.tls.callbacks[0], 0x00aefec1);

  // Gap 3: two _initterm tables, 4 C + 117 C++ initialisers.
  assert.equal(b.startup.initTermTables.length, 2);
  const byRun = [...b.startup.initTermTables].sort((a, c) => a.runOrder - c.runOrder);
  assert.equal(byRun[0].nonNull, 4, 'XI table: 4 C initialisers');
  assert.equal(byRun[1].nonNull, 117, 'XC table: 117 C++ initialisers');
  for (const tbl of byRun) assert.equal(tbl.allTargetsInText, true);
});

test('initterm run order is XI first even though XC has the lower address', (t) => {
  if (!has('boot-tables.json')) return t.skip('run boot_tables.py');
  const b = readJson(join(host, 'boot-tables.json'));
  const byRun = [...b.startup.initTermTables].sort((a, c) => a.runOrder - c.runOrder);
  const [first, second] = byRun;
  // This is the trap: sorting by address would invert initialisation order.
  assert.ok(second.startVa < first.startVa,
    'C++ table must live BELOW the C table in memory');
  assert.match(first.crtSection, /XI/);
  assert.match(second.crtSection, /XC/);
  assert.equal(b.startup.mainVa, 0x00931050);
});

test('relocations: 3 HIGHLOW entries would corrupt code, so none are applied', (t) => {
  if (!has('boot-tables.json')) return t.skip('run boot_tables.py');
  const b = readJson(join(host, 'boot-tables.json'));
  assert.equal(b.relocations.entries, 181854);
  assert.equal(b.relocations.byType['3'], 180939);
  // Self-inflicted by this project's own binary patches; the pristine
  // pre-coinit snapshot has zero. Mapping at the preferred base is therefore
  // the only correct option for THIS image.
  assert.deepEqual(b.relocations.suspectHighlowTargetRvas.sort(),
    ['0x00531148', '0x00680633', '0x00680d3a']);
  // And the boot code must actually refuse to relocate.
  const boot = readFileSync(join(src, 'src', 'host_boot.c'), 'utf8');
  assert.match(boot, /apply_relocations_unsupported/);
});

test('memory image: identity addressing, measured size', (t) => {
  if (!has('memimage.json')) return t.skip('run memimage.py');
  const m = readJson(join(host, 'memimage.json'));
  assert.equal(m.imageBase, 0x00400000);
  assert.equal(m.sizeOfImage, 9428992);
  assert.match(m.addressingModel, /identity/i);
  // .reloc is dead weight once mapped at the preferred base.
  assert.ok(m.droppedSections.includes('.reloc'));
  // The wasm memory must be able to hold the whole image.
  assert.ok(m.minimumWasmMemoryBytes >= m.imageBase + m.sizeOfImage);
  // Shipping form must actually be smaller than the raw image.
  const flat = m.variants.flat;
  assert.ok(flat.brotli < flat.raw * 0.5, 'brotli should halve the image at least');
  if (has('isaac.mem')) {
    assert.equal(statSync(join(host, 'isaac.mem')).size, flat.raw);
  }
});

test('memory image verifies byte-for-byte against the PE', (t) => {
  if (!has('memimage-verify.json')) return t.skip('run verify_memimage.py');
  const v = readJson(join(host, 'memimage-verify.json'));
  assert.deepEqual(v.failures, []);
  assert.equal(v.pass, true);
  // Every hard-coded constant in isaac_host.h is cross-checked against the PE;
  // a drift there makes the boot path read garbage.
  const consts = v.checks.filter((c) => c.check === 'header constant');
  assert.ok(consts.length >= 12);
  for (const c of consts) assert.equal(c.ok, true, `${c.name} drifted`);
  // 4 C + 117 C++ initialisers, all landing in .text, read out of the IMAGE
  // rather than out of the PE -- this is what the boot path will actually see.
  const init = v.checks.find((c) => c.check === 'initialiser count');
  assert.equal(init.actual, 121);
  const targets = v.checks.find((c) => c.check === 'initialiser targets in .text');
  assert.equal(targets.outside, 0);
  // The flat blob is a zero-trimmed prefix; consumers must zero-fill.
  assert.ok(v.trailingZeroBytesTrimmed >= 0);
  assert.equal(v.imageBytes + v.trailingZeroBytesTrimmed, v.sizeOfImage);
  assert.match(v.consumerContract, /zero-filled/);
});

test('shim table: every import is accounted for and nothing is silent', (t) => {
  if (!has('shim-table.json')) return t.skip('run gen_shims.py');
  const s = readJson(join(host, 'shim-table.json'));
  assert.equal(s.totalImports, 622);
  const total = Object.values(s.byVerdict).reduce((a, v) => a + v.symbols, 0);
  assert.equal(total, 622);
  const sites = Object.values(s.byVerdict).reduce((a, v) => a + v.callSites, 0);
  assert.equal(sites, 22513, 'call sites must reconcile with the census');

  // Every import must carry a shim token, and tokens must be unique.
  const tokens = new Set(s.imports.map((r) => r.shimVa));
  assert.equal(tokens.size, 622);

  // No import may be left without a verdict.
  for (const r of s.imports) {
    assert.ok(r.verdict && r.verdict.length, `${r.symbol} has no verdict`);
    assert.ok(r.convention, `${r.symbol} has no calling convention`);
  }
});

test('stack purge is never guessed for a stub that returns', (t) => {
  if (!has('shim-table.json')) return t.skip('run gen_shims.py');
  const s = readJson(join(host, 'shim-table.json'));
  // A trapping shim never returns, so its purge is irrelevant. A STUB does
  // return, so a wrong purge desynchronises the guest stack.
  // A slot loaded into a register (`mov r32,[slot]; call r32`) is reachable
  // exactly like a call site; the census counts them since round 11b.
  const reachable = (r) => r.callSites > 0 || (r.regHeldLoads || 0) > 0;
  const returning = s.imports.filter(
    (r) => r.verdict === 'STUB' && r.isStdcall && reachable(r));
  assert.ok(returning.length > 0);
  for (const r of returning) {
    assert.equal(r.purgeConfidence, 'high',
      `${r.symbol}@${r.dll} returns with a low-confidence purge`);
    assert.notEqual(r.argBytes, 0xffff);
  }
  // cdecl callees must never pop: the caller cleans.
  for (const r of s.imports) {
    if (r.convention === 'cdecl') assert.equal(r.argBytes, 0);
  }
});

test('no reachable import is NEVER_CALLED or has an unknown purge', (t) => {
  if (!has('shim-table.json')) return t.skip('run gen_shims.py');
  const s = readJson(join(host, 'shim-table.json'));
  // Round 11b: LoadImageA, SendMessageA, GetDeviceCaps, ... are reached only
  // through register-held loads of their IAT slot. The census now records
  // those (regHeldLoads); an import with any is reachable, so it needs a
  // verdict that runs and a purge the dispatcher can apply.
  assert.ok(s.imports.some((r) => (r.regHeldLoads || 0) > 0 && r.callSites === 0),
    'the register-held census found at least one slot no call site reaches');
  for (const r of s.imports) {
    if (r.callSites === 0 && (r.regHeldLoads || 0) === 0) continue;
    assert.notEqual(r.verdict, 'NEVER_CALLED', `${r.symbol}@${r.dll} is reachable but NEVER_CALLED`);
    if (r.isStdcall) assert.notEqual(r.argBytes, 0xffff, `${r.symbol}@${r.dll} is reachable with an unknown purge`);
  }
});

test('GL: buffer objects and VAOs are provably never used', (t) => {
  if (!has('gl-legacy-audit.json')) return t.skip('run gl_legacy_audit.py');
  const g = readJson(join(host, 'gl-legacy-audit.json'));
  // The whole client-side-array conclusion rests on these two being zero
  // across every vendor alias.
  assert.equal(g.families['buffer-objects'].usedByCallerCode, 0);
  assert.ok(g.families['buffer-objects'].exportedMembers >= 25);
  assert.equal(g.families['vertex-array-objects'].usedByCallerCode, 0);
  // Legacy pipeline must be absent too, or the port is a different problem.
  for (const fam of ['immediate-mode', 'fixed-function-matrix',
    'fixed-function-state', 'client-state-arrays', 'display-lists',
    'polygon-mode']) {
    assert.equal(g.families[fam].usedByCallerCode, 0, `${fam} is used`);
  }
  // Coverage: the audit must have swept all of .text, not just known functions.
  assert.equal(g.textBytes, 7430656);
  assert.ok(g.instructionsDecoded > 2_000_000);
});

test('GL: the called entry-point set is a superset of the census 70', (t) => {
  if (!has('gl-census2.json')) return t.skip('run gl_census2.py');
  const g = readJson(join(host, 'gl-census2.json'));
  assert.equal(g.inCensusNotMine.length, 0,
    'must not lose any entry point the census found');
  assert.ok(g.entryPointsCalledByCallerCode >= 78);
  // The shader/uniform calls the census's byte scan missed.
  const names = new Set(g.entryPoints.map((e) => e.name));
  for (const n of ['epoxy_glCreateShader', 'epoxy_glGetUniformLocation',
    'epoxy_glGetAttribLocation', 'epoxy_glVertexAttribPointer',
    'epoxy_glGenFramebuffers', 'epoxy_glBlendFuncSeparate']) {
    assert.ok(names.has(n), `${n} must be in the called set`);
  }
});

test('generated C is structurally consistent with the shim table', (t) => {
  const gen = join(src, 'generated');
  if (!existsSync(join(gen, 'shim_table.c'))) return t.skip('run gen_shims.py');
  const table = readFileSync(join(gen, 'shim_table.c'), 'utf8');
  const decls = readFileSync(join(gen, 'shim_decls.h'), 'utf8');
  const weak = readFileSync(join(gen, 'shim_weak.c'), 'utf8');

  /* The C table = the 622 static IAT imports + the dynamic (LoadLibrary/
     GetProcAddress) exports gen_shims emits so GetProcAddress can resolve
     them. The dynamic rows share the sentinel IAT slot 0 (they have no IAT
     slot); every ident and shim token is still unique across the whole set. */
  const st = readJson(join(host, 'shim-table.json'));
  const nIat = st.totalImports;                 // 622
  const nDyn = st.dynamicImports.length;        // dynamic exports
  const nAll = nIat + nDyn;
  const rows = [...table.matchAll(/^\s*\{ "(.+?)", "(.*?)", (0x[0-9a-f]+)u, (0x[0-9a-f]+)u, (\d+), (\d+), (\w+), (\d+), (\w+) \},$/gm)];
  assert.equal(rows.length, nAll, 'table must hold every IAT + dynamic import');

  const declNames = new Set([...decls.matchAll(/^void (\w+)\(CpuState \*restrict cpu\);$/gm)].map((m) => m[1]));
  const weakNames = new Set([...weak.matchAll(/void (\w+)\(CpuState \*restrict cpu\) \{/g)].map((m) => m[1]));
  const idents = new Set();
  const iatSlots = new Set();
  const tokens = new Set();
  for (const r of rows) {
    const [, , , slot, token, argBytes, isStdcall, , , ident] = r;
    assert.ok(declNames.has(ident), `${ident} declared`);
    assert.ok(weakNames.has(ident), `${ident} has a weak fallback`);
    assert.match(ident, /^[A-Za-z_][A-Za-z0-9_]*$/, `${ident} is a valid C identifier`);
    idents.add(ident);
    if (slot !== '0x00000000') iatSlots.add(slot);  // dynamic rows share slot 0
    tokens.add(token);
    // cdecl callees must not pop.
    if (isStdcall === '0') assert.equal(argBytes, '0');
  }
  assert.equal(idents.size, nAll, 'shim identifiers must be unique');
  assert.equal(iatSlots.size, nIat, 'the 622 IAT slot VAs must be unique');
  assert.equal(tokens.size, nAll, 'shim tokens must be unique across IAT + dynamic');
  assert.equal(declNames.size, nAll);

  // Every weak fallback must either trap or log; none may just return.
  const bodies = weak.split(/void \w+\(CpuState \*restrict cpu\) \{/).slice(1);
  assert.equal(bodies.length, nAll);
  for (const b of bodies) {
    const body = b.split('\n}')[0];
    assert.ok(/isaac_trap|isaac_stub_hit/.test(body),
      'a weak fallback returned without reporting');
  }
});

test('hand-written shims match the generated declarations exactly', (t) => {
  const gen = join(src, 'generated');
  if (!existsSync(join(gen, 'shim_decls.h'))) return t.skip('run gen_shims.py');
  const decls = readFileSync(join(gen, 'shim_decls.h'), 'utf8');
  const crt = readFileSync(join(src, 'src', 'host_shims_crt.c'), 'utf8');
  // Multi-line signatures are allowed, so match on the identifier + open paren.
  const defined = [...crt.matchAll(/^void (imp_\w+)\(/gm)].map((m) => m[1]);
  const multiline = [...crt.matchAll(/^void (imp_\w+)\($/gm)].map((m) => m[1]);
  const all = new Set([...defined, ...multiline]);
  assert.ok(all.size >= 13, 'expected the high-traffic CRT shims');
  for (const name of all) {
    assert.ok(decls.includes(`void ${name}(CpuState *restrict cpu);`),
      `${name} does not match any generated declaration -- it would not override`);
  }
  // The 1,458-site symbol must be one of them.
  assert.ok([...all].some((n) => n.endsWith('_invalid_parameter_noinfo_noreturn')));
  // No GCC statement-expression extension (emcc-only syntax creeping in).
  assert.ok(!/=\s*\(\{/.test(crt), 'statement expressions are not portable');
});

test('Lua is stock 5.3.3 with the default numeric config', (t) => {
  if (!has('lua-abi.json')) return t.skip('run lua_abi.py');
  const l = readJson(join(host, 'lua-abi.json'));
  // 62.2% of all IAT traffic rides on this being true.
  assert.equal(l.isStock, true);
  assert.deepEqual(l.missingFromDll, [], 'every imported symbol must exist');
  assert.equal(l.importedSymbols, 67);
  assert.deepEqual(l.nonStockExports, [], 'no non-Lua exports');
  // The r/f suffix carries no ABI meaning: they are the same file.
  assert.equal(l.rAndFAreByteIdentical, true);
  // The two config values that would corrupt every boundary-crossing value.
  assert.match(l.numericConfig.LUA_INT_TYPE, /LONGLONG/);
  assert.match(l.numericConfig.LUA_FLOAT_TYPE, /DOUBLE/);
  assert.equal(l.numericConfig['sizeof(TValue)'], 16);
  assert.match(l.buildWarning, /LUA_32BITS/);
});

test('the host layer compiles, links and runs', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  assert.equal(b.compile.errors, 0, 'compile errors');
  assert.equal(b.compile.warnings, 0, 'compile warnings (-Wall -Wextra)');
  assert.equal(b.link.exit, 0);
  // 622 weak stubs + 13 strong overrides must not collide.
  assert.equal(b.link.duplicateSymbolErrors, 0);
  assert.equal(b.link.undefinedSymbolErrors, 0);
  assert.equal(b.run.failures, 0);
  assert.ok(b.run.checks >= 19, 'runtime checks executed');
  assert.equal(b.ok, true);
});

test('host state is unreachable by a wild guest pointer', () => {
  const h = readFileSync(join(src, 'include', 'isaac_host.h'), 'utf8');
  const val = (name) => {
    const m = h.match(new RegExp(`#define ${name}\\s+(0x[0-9a-f]+)u`, 'i'));
    assert.ok(m, `${name} not defined`);
    return parseInt(m[1], 16);
  };
  const imageEnd = val('ISAAC_IMAGE_BASE') + val('ISAAC_IMAGE_SIZE');
  const limit = val('ISAAC_GUEST_LIMIT_VA');
  const guard = val('ISAAC_GUARD_VA');
  const guardSz = val('ISAAC_GUARD_SIZE');
  const hostBase = val('ISAAC_HOST_BASE_VA');

  // Guard sits between the two worlds, with no gap on the host side.
  assert.equal(guard, limit);
  assert.equal(guard + guardSz, hostBase);
  assert.ok(hostBase > limit);

  // Every fixed guest-side region must be below the limit...
  const heapEnd = val('ISAAC_HEAP_VA') + val('ISAAC_HEAP_SIZE');
  const shimEnd = val('ISAAC_SHIM_BASE') + 622 * 16;
  for (const [name, end] of [['image', imageEnd], ['heap', heapEnd],
    ['stack', val('ISAAC_STACK_TOP_VA')], ['shims', shimEnd],
    ['teb', val('ISAAC_TLS_ARRAY_VA') + 0x1000]]) {
    assert.ok(end <= limit, `${name} (ends 0x${end.toString(16)}) crosses the guest limit`);
  }
  // ...and the guest heap must sit ABOVE the image, so that the most likely
  // structured overrun (off the end of .data) lands in guest memory rather
  // than in the runtime.
  assert.ok(val('ISAAC_HEAP_VA') >= imageEnd);
});

test('selftest proves the layout at runtime, not just on paper', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  const out = b.run.output.join('\n');
  assert.match(out, /host static data is above the host base/);
  assert.match(out, /host malloc also lands above the host base/);
  assert.match(out, /image, heap, stack and shim tokens are all below the guest limit/);
  assert.equal(b.run.failures, 0);
  assert.ok(b.run.checks >= 24);
});

test('selftest executes the Lua binding when it is linked', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  const out = b.run.output.join('\n');

  // A standalone build without the tarball is still a valid host-layer
  // build, but it must SAY the Lua shims are inert -- a silent stub layer
  // behind 14,011 call sites is exactly the green-label trap this suite
  // exists to catch.
  if (!b.lua || !b.lua.linked) {
    assert.match(out, /NOT LINKED/);
    return;
  }
  // The real module must be exercised THROUGH the shims, not merely linked:
  // guest-arena state, 64-bit integers that would corrupt on truncation,
  // the actual VM computing, st(0)/EDX:EAX returns, pooled trampolines.
  assert.match(out, /luaL_newstate returns a guest-addressable lua_State/);
  assert.match(out, /lua_pushnumber shim round-trips a double/);
  assert.match(out, /lua_pushinteger shim round-trips a 64-bit lua_Integer/);
  assert.match(out, /upstream Lua VM computes 2\+3 inside the wasm module/);
  assert.match(out, /distinct guest C functions get distinct trampolines/);
  assert.match(out, /re-registering the same guest C function reuses its trampoline/);
  assert.match(out, /luaL_checknumber returns the double in st\(0\)/);
  assert.match(out, /luaL_checkinteger returns in EDX:EAX/);
  // ...and the harness count must agree with what actually executed.
  assert.equal(out.match(/ok    /g).length, b.run.checks);
});

test('the indirect-call contract matches the lifter, name for name', (t) => {
  const gen = join(src, 'generated');
  if (!existsSync(join(gen, 'shim_decls.h'))) return t.skip('run gen_shims.py');
  const mine = new Set([...readFileSync(join(gen, 'shim_decls.h'), 'utf8')
    .matchAll(/^void (imp_\w+)\(/gm)].map((m) => m[1]));
  // 622 static IAT imports + the dynamic (LoadLibrary/GetProcAddress) exports.
  const st = readJson(join(host, 'shim-table.json'));
  assert.equal(mine.size, st.totalImports + st.dynamicImports.length);
  // The lifter turns `call [IAT slot]` into a direct call to these exact
  // symbols at lift time. If the two generators disagree on a name, the module
  // either fails to link or links against a second parallel definition. The
  // lifter only references the 622 IAT imports; the dynamic exports are host-
  // only, so this stays a subset check (every lifted imp_ exists in the host).
  const lifted = join(root, 'output', 'recomp', 'lift');
  if (!existsSync(lifted)) return t.skip('no lifted output to compare against');
  let seen = 0;
  for (const d of readdirSync(lifted)) {
    const h = join(lifted, d, 'lifted_decls.h');
    if (!existsSync(h)) continue;
    for (const m of readFileSync(h, 'utf8').matchAll(/^void (imp_\w+)\(CpuState/gm)) {
      seen++;
      assert.ok(mine.has(m[1]),
        `lifter emits ${m[1]} but the host table has no such shim`);
    }
  }
  assert.ok(seen > 0, 'compared against at least one lifted module');
});

test('C++ EH: 1,833 sites are unwinder-only, RTTI is not', (t) => {
  if (!has('eh-audit.json')) return t.skip('run eh_audit.py');
  const e = readJson(join(host, 'eh-audit.json'));
  const fh = e.summary.__CxxFrameHandler3;
  // Zero real calls: every reference is an __ehhandler$ trampoline tail.
  assert.equal(fh.realCalls, 0);
  assert.ok(fh.ehhandlerTrampolines >= 1833);
  assert.equal(fh.reachedOnlyByUnwinder, true);
  // dynamic_cast, by contrast, is steady-state and must be real.
  assert.ok(e.summary.__RTDynamicCast.realCalls > 800);
  assert.equal(e.summary.__RTDynamicCast.reachedOnlyByUnwinder, false);
  assert.equal(e.summary._CxxThrowException.realCalls, 72);
  // The shim must return ExceptionContinueSearch, not trap, and must say why.
  const c = readFileSync(join(src, 'src', 'host_shims_crt.c'), 'utf8');
  assert.match(c, /ExceptionContinueSearch/);
  assert.match(c, /__RTDynamicCast/);
});

test('the 16 imports on the critical path to main are all implemented', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  const out = b.run.output.join('\n');
  assert.match(out, /boot-critical: 16\/16 present, 16 REAL\/PROVIDED/);
  assert.match(out, /all 16 are REAL or PROVIDED, none left a stub/);
  // Each must execute rather than trap; a weak REAL fallback aborts.
  for (const re of [/IsDebuggerPresent returns 0 without trapping/,
    /__p__commode returns a guest-visible cell/,
    /IsProcessorFeaturePresent reports SSE2 available/,
    /GetModuleHandleW\(NULL\) returns the image base/]) {
    assert.match(out, re);
  }
  // The table must carry the CORRECTED purge: the signature takes one DWORD,
  // but the push-count sweep measured 8 -- same failure mode as MessageBoxA.
  const st = readJson(join(host, 'shim-table.json'));
  const ipfp = st.imports.find((r) => r.symbol === 'IsProcessorFeaturePresent');
  assert.equal(ipfp.argBytes, 4);
  assert.equal(ipfp.argBytesSource, 'curated-signature');
});

test('vbase constructors purge the hidden most_derived flag; lift purge patches agree with the table', (t) => {
  if (!has('shim-table.json')) return t.skip('run gen_shims.py');
  const st = readJson(join(host, 'shim-table.json'));
  const bySym = new Map(st.imports.map((r) => [r.symbol, r]));
  // MSVC x86 passes a hidden trailing `int most_derived` to constructors of
  // classes with a virtual base, and a __thiscall callee pops it: msvcp140
  // ??0basic_iostream is `ret 8`, ??0basic_ostream `ret 0xc`. Round 10b
  // curated these from the decorated name alone (4 / 8); the lifted
  // stringstream ctor 0x00684ce0 then restored ebx/esi/edi one slot low.
  const vbase = [
    ['??0?$basic_iostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@@Z', 8],
    ['??0?$basic_ostream@DU?$char_traits@D@std@@@std@@QAE@PAV?$basic_streambuf@DU?$char_traits@D@std@@@1@_N@Z', 12],
  ];
  for (const [sym, purge] of vbase) {
    const r = bySym.get(sym);
    assert.ok(r, `${sym} in the table`);
    assert.equal(r.convention, 'thiscall');
    assert.equal(r.argBytes, purge, `${sym} pops declared args + most_derived`);
    assert.equal(r.argBytesSource, 'curated-signature');
    // The push-count sweep measured this correctly; the curation must agree.
    assert.equal(r.measuredPushes * 4, purge, `${sym}: curated purge contradicts the measured pushes`);
    assert.equal(r.purgeClash, false);
  }
  // basic_ios has no virtual base: no hidden flag, purge 0.
  const bios = bySym.get('??0?$basic_ios@DU?$char_traits@D@std@@@std@@IAE@XZ');
  assert.ok(bios);
  assert.equal(bios.argBytes, 0);
  // Every PURGE_PATCHES right-hand value (the constant baked into the lifted
  // callers) must equal the current table's purge for that import, or the
  // lifted tree and the runtime dispatcher disagree on ESP after the call.
  const lp = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'lift_patches.py'), 'utf8');
  const block = lp.slice(lp.indexOf('PURGE_PATCHES: dict'), lp.indexOf('def apply_purge_patches'));
  const byIdent = new Map(st.imports.map((r) => [r.cident, r]));
  const entries = [...block.matchAll(/"(imp_[A-Za-z0-9_]+)":\s*\((\d+),\s*(\d+)\)/g)];
  assert.ok(entries.length >= 5, 'PURGE_PATCHES entries parsed');
  for (const [, ident, wrong, right] of entries) {
    const r = byIdent.get(ident);
    assert.ok(r, `${ident} is a table import`);
    assert.equal(Number(right), r.argBytes, `${ident}: PURGE_PATCHES right-hand value != table purge`);
    assert.notEqual(Number(wrong), Number(right));
  }
});

test('every hand-written missing-callee body emulates its ret', () => {
  // scripts/recomp/host/src/missing_fns.c holds STRONG bodies for callees
  // the lifter could not decode. The lifted caller pushes the return
  // address and reloads ESP from CpuState afterwards, so a body that does
  // not pop it desynchronises the guest stack by 4 per call (boot round 11:
  // 0x0098d560 handed its own return addresses back as esi/edi).
  const src = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'missing_fns.c'), 'utf8');
  const bodies = [...src.matchAll(/^void (sub_[0-9a-f]{8})\(CpuState \*restrict s\) \{([\s\S]*?)^\}/gm)];
  assert.ok(bodies.length >= 6, `found ${bodies.length} hand-written bodies`);
  for (const [, name, body] of bodies) {
    assert.match(body, /rc_ret\(s\);|recomp_jump_indirect\(s,/, `${name} must pop its return address (rc_ret) or tail-jump into lifted code`);
  }
});

test('trap messages name the call site, not the return address', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  const out = b.run.output.join('\n');
  // Verified against the real image: the lifter saw _set_app_type demanded
  // from return address 0x00aefa07; the call itself is at 0x00aefa02.
  assert.match(out, /call-site decode: ret 0x00aefa07 -> 0x00aefa02/);
  assert.match(out, /call site recovered from the return address/);
  const c = readFileSync(join(src, 'src', 'host_trap.c'), 'utf8');
  assert.match(c, /isaac_call_site_from_return/);
  assert.match(c, /returns to 0x%08x/);
});

test('our weak stub definitions win the link, not the other layer', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  // Both layers emitted weak imp_* definitions for the same 591 imports. Two
  // weak symbols do not collide, so the linker silently picks one; theirs
  // returns without recording, ours records. The bug existed only in the pair,
  // so neither layer's own tests could have caught it.
  assert.match(b.run.output.join('\n'),
    /this layer's weak stub definitions are the ones linked in/);
});

test('guest allocator and RTTI are verified against the real image', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  const out = b.run.output.join('\n');
  // The guest allocator must never hand out host-range pointers, and memset
  // must refuse a destination across the guard.
  assert.match(out, /guest malloc returns pointers inside the GUEST arena/);
  assert.match(out, /memset refuses a host-range destination/);
  // __RTDynamicCast walked genuine MSVC descriptor chains out of real .rdata.
  assert.match(out, /image: \d+ bytes at 0x00400000, MZ=yes/);
  assert.match(out, /__RTDynamicCast resolves real upcasts through real RTTI/);
  assert.match(out, /__RTDynamicCast returns null for a type not in the hierarchy/);
  assert.ok(b.run.checks >= 44);
});

test('module handles: one story, and the boot blocker is fixed', (t) => {
  if (!has('build-selftest.json')) return t.skip('run build_selftest.py');
  const b = readJson(join(host, 'build-selftest.json'));
  const out = b.run.output.join('\n');
  // FUN_00aef191 treats a NULL kernel32 handle as fatal (je at 0x00aef1c3 ->
  // STATUS_FATAL_APP_EXIT) but handles a NULL api-set handle by design, so
  // these two answers MUST differ.
  assert.match(out, /GetModuleHandleW\(kernel32\.dll\) is non-NULL \(the boot blocker\)/);
  assert.match(out, /GetModuleHandleW\(api-set\) is NULL, which the caller handles/);
  assert.match(out, /GetModuleHandleW\(NULL\) is the image base/);
  // The unification: a dynamically resolved pointer and a statically bound one
  // must be the same value, or they diverge the moment one is wrong.
  assert.match(out, /GetProcAddress returns the SAME shim token the IAT holds/);
  assert.match(out, /that token is bit-identical to the bound IAT slot/);
  assert.match(out, /GetProcAddress returns NULL for a symbol we do not provide/);
  // CreateEventW is the intended fallback; NULL hits the same fatal branch.
  assert.match(out, /CreateEventW is non-NULL \(the intended CRT fallback\)/);
  assert.match(out, /after SetEvent, an INFINITE wait returns WAIT_OBJECT_0/);
  assert.ok(b.run.checks >= 55);
});

test('depth-0/1 initialiser queue is implemented', (t) => {
  if (!has('shim-table.json')) return t.skip('run gen_shims.py');
  const s2 = readJson(join(host, 'shim-table.json'));
  const by = new Map(s2.imports.map((r) => [r.symbol, r]));
  // SteamAPI_RegisterCallback is a DEPTH-0 static initializer: a global
  // constructor registers a callback before main. It cannot be deferred.
  for (const sym of ['strncpy', 'FlsSetValue', 'FlsAlloc',
    'SteamAPI_RegisterCallback', 'SteamInternal_ContextInit',
    'GetProcAddress', '__stdio_common_vsprintf', 'CreateEventW',
    '__setusermatherr', '_set_new_mode', 'GetStdHandle', 'WriteConsoleA',
    '_libm_sse2_sin_precise', 'LoadLibraryA']) {
    const r = by.get(sym);
    assert.ok(r, `${sym} missing from the table`);
    assert.equal(r.verdict, 'REAL', `${sym} should be hand-written`);
  }
});

test('shutdown is orderly, not abort()', () => {
  const c = readFileSync(join(src, 'src', 'host_trap.c'), 'utf8');
  // abort() inside wasm produces a libuv teardown assertion that lands AFTER
  // the real diagnosis and becomes the last thing on screen.
  assert.match(c, /isaac_shutdown/);
  assert.match(c, /UV_HANDLE_CLOSING/);
  assert.match(c, /in_shutdown/);      // must not re-enter
  const m = readFileSync(join(src, 'src', 'host_shims_module.c'), 'utf8');
  // A wait that can never be satisfied must stop, not hang the tab.
  assert.match(m, /isaac_shutdown\("blocking wait that can never be satisfied"\)/);
});

test('throw and unwind are tracked as separate mechanisms', () => {
  const c = readFileSync(join(src, 'src', 'host_shims_crt.c'), 'utf8');
  // The __CxxFrameHandler3 result covers UNWIND only. _CxxThrowException is
  // called directly by lifted code 72 times and sits at depth 4 in the
  // initialiser walk, so a throw during init is plausible even though an
  // unwind is not.
  assert.match(c, /THROW AND UNWIND ARE SEPARATE MECHANISMS/);
  assert.match(c, /does not imply throws are unreachable/);
});

test('no import carries a green verdict with nothing wired behind it', (t) => {
  if (!has('coverage.json')) return t.skip('run coverage.py');
  const c = readJson(join(host, 'coverage.json'));
  // The class this guards: a verdict is a CLASSIFICATION, not an
  // implementation. QueryPerformanceCounter was PROVIDED and unwired, so it
  // trapped exactly like an unimplemented import. It was 1 of 371.
  const latent = new Set(c.latentTraps.symbols.map((r) => r.symbol));
  // Everything reachable on the boot path must be wired, whatever its verdict.
  for (const sym of ['QueryPerformanceCounter', 'QueryPerformanceFrequency',
    'memcpy', 'memmove', 'memset', 'strncpy', 'strncmp', 'atoi', 'atof',
    'floor', 'ceil', 'Sleep', 'GetLastError', 'GetProcAddress',
    'CreateEventW', 'FlsAlloc', 'SteamAPI_RegisterCallback']) {
    assert.ok(!latent.has(sym), `${sym} is classified but not wired`);
  }
  // The residual must be attributed, not just counted.
  assert.ok(c.residualByCause, 'residual must be broken out by cause');
  // Lua was 59 symbols / 14,011 sites — the largest residual cause of all —
  // until the upstream wasm module was built and linked (lua_build.py +
  // build_selftest.py auto-detection). It must now be GONE from the residual
  // and counted under implementedBy instead: a residual row would mean the
  // binding regressed to the stub layer while the selftest still passed.
  const lua = Object.entries(c.residualByCause)
    .find(([k]) => k.startsWith('lua'));
  assert.ok(!lua, 'Lua must not be a residual cause any more (binding wired)');
  assert.equal(c.implementedBy['host_lua.c'], 59, 'all 59 Lua symbols implemented');
  assert.equal(c.strongDefinitions, 179, 'strong definitions: 120 + 59 Lua');
});

test('timing is deterministic by default, and says why', () => {
  const f = readFileSync(join(src, 'src', 'host_shims_forward.c'), 'utf8');
  // Reproducibility is what this project's verification rests on; a wall clock
  // makes every trace differ from every other trace.
  assert.match(f, /DESIGN DECISION: the counter is DETERMINISTIC/);
  assert.match(f, /ISAAC_TIME_DETERMINISTIC = 0/);
  assert.match(f, /isaac_time_set_mode/);
  // QPC and QPF must be chosen together or the pair is inconsistent.
  assert.match(f, /ISAAC_QPF_HZ 10000000ull/);
  // Monotonicity must hold in BOTH modes: browser clocks are coarsened.
  assert.match(f, /never go backwards/);
});

test('Lua binding covers all 59 used symbols and guards the ABI', () => {
  const l = readFileSync(join(src, 'src', 'host_lua.c'), 'utf8');
  const defined = new Set([...l.matchAll(/LUA_SHIM\((\w+)\)/g)].map((m) => m[1]));
  assert.ok(defined.size >= 59, `only ${defined.size} Lua shims defined`);
  // The three conventions that would silently corrupt values.
  assert.match(l, /returns in st\(0\)/);
  assert.match(l, /returns in EDX:EAX/);
  assert.match(l, /two stack slots/);
  // ABI gate: a mismatch must be a compile error, not runtime corruption.
  assert.match(l, /LUAL_NUMSIZES == 136/);
  assert.match(l, /LUA_COMPAT_5_2 must NOT be defined/);
  assert.match(l, /sizeof\(lua_Integer\) == 8/);
  // Guest C functions must be trampolined, not handed to Lua as host pointers.
  assert.match(l, /trampoline_for/);
  // Pool sized for the RegisterClasses closure surface (383 accessors +
  // ~447 installer closures are live simultaneously on the materialize path),
  // which exceeds the original 512; 2048 keeps exhaustion loud but unreached.
  assert.match(l, /LUA_TRAMPOLINES 2048/);
  // Lua must allocate in the guest arena or every object lands above the guard.
  assert.match(l, /isaac_guest_realloc/);
});

test('Lua build script encodes the flags, and does not download', () => {
  const b = readFileSync(join(src, 'lua_build.py'), 'utf8');
  // Upstream's own Makefile ships LUA_COMPAT_5_2; the DLL was built without it.
  assert.match(b, /LUA_COMPAT_5_2/);
  assert.match(b, /LUA_32BITS/);
  assert.match(b, /LUA_C89_NUMBERS/);
  assert.match(b, /does not download/);
});

test('client-array emulation documents what it cannot derive', () => {
  const c = readFileSync(join(src, 'src', 'host_gl_clientarrays.c'), 'utf8');
  // The max-index scan is the unavoidable cost; it must be present and named.
  assert.match(c, /max_index/);
  assert.match(c, /NOT derivable/);
  assert.match(c, /isaac_gl_draw_elements/);
  assert.match(c, /isaac_gl_draw_arrays/);
});

test('loud-stub engine has no silent success path', () => {
  const t = readFileSync(join(src, 'src', 'host_trap.c'), 'utf8');
  assert.match(t, /isaac_stub_hit/);
  assert.match(t, /isaac_trap/);
  assert.match(t, /isaac_stub_report/);
  // A trap must not be able to fall through into a return.
  assert.match(t, /abort\(\)/);
  // Unknown purge must stop execution rather than desynchronise the stack.
  assert.match(t, /0xFFFF/);
});

test('round 39: the client-array staging buffers are rings -- appends, orphan on wrap, offsets carried into the pointers and the draw', () => {
  const c = readFileSync(join(src, 'src', 'host_gl_clientarrays.c'), 'utf8');
  assert.match(c, /static uint32_t ring_put\(GLenum target, gl_ring \*r, uint32_t initial,/, 'one append primitive for both rings');
  assert.ok(c.includes('} else if (r->head + need > r->cap) {      /* wrap: orphan, never overwrite */'), 'a wrap orphans the storage instead of overwriting bytes a queued draw reads');
  assert.ok(c.includes('if (src) glBufferSubData(target, (GLintptr)off, (GLsizeiptr)bytes, src);'), 'the upload lands at the ring head');
  assert.ok(c.includes('(const void *)(uintptr_t)(at + (a->client_ptr - base)))'), 'interleaved attributes point at the ring offset');
  assert.ok(c.includes('(const void *)(uintptr_t)(at + off))'), 'separate attributes point at the ring offset');
  assert.ok(c.includes('glDrawElements(mode, count, type, (const void *)(uintptr_t)iat);'), 'the draw reads its indices at the ring offset');
  assert.ok(!c.includes('glBufferSubData(target, 0,'), 'nothing writes at offset 0 any more');
  assert.match(c, /rings orphaned %u \/ %u times/, 'the report counts the orphans');
});

test('round 48: an index block identical to the last upload is drawn from its ring offset, unless the ring storage was replaced', () => {
  const c = readFileSync(join(src, 'src', 'host_gl_clientarrays.c'), 'utf8');
  assert.ok(c.includes('g_idx_gen == g_iring.gen && g_iring.buf'), 'the reuse checks the ring generation (an orphan replaced the storage)');
  assert.ok(c.includes('iat = g_idx_at; ++g_idx_reuse;'), 'the draw reuses the offset');
  assert.ok(/glBufferData\(target, \(GLsizeiptr\)r->cap, 0, GL_STREAM_DRAW\);\s*r->head = 0; \+\+r->gen;/.test(c), 'grow and wrap bump the generation');
  assert.ok(c.includes('%u identical index blocks reused'), 'the census');
});
