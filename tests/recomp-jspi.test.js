// The browser build yields to the event loop (recomp round 25). The guest's
// frame loop lives inside main() and never returns, so until this round no
// DOM event could reach the game and the canvas did not repaint until the run
// ended. JavaScript Promise Integration lets an import park the whole wasm
// stack: the web profile links with -sJSPI, the run entries become
// promise-returning exports, and the SwapBuffers shim calls
// emscripten_sleep(0) once per presented frame when ISAAC_YIELD=1 (a macrotask
// boundary -- events are delivered, the canvas is composited). Two rules keep
// it working and are pinned here:
//   - a JSPI suspension cannot cross a JavaScript frame, and the default
//     setjmp/longjmp puts invoke_* JS trampolines around every call made by a
//     function that uses setjmp (isaac_guest_call_inner in dispatch_tbl.c,
//     Lua's luaD_rawrunprotected). The web profile therefore compiles every
//     setjmp/longjmp user -- host TUs, dispatch_tbl.c AND Lua -- with the
//     Wasm-EH implementation, and JSPI_EXPORTS names WASM exports (no leading
//     underscore: emscripten matches the pattern against the wasmExports keys);
//   - the round-24 slice runner runs the guest thread jobs inside the frame
//     present; a sliced job's Sleep must not suspend (it would park the frame
//     loop for the job's delay, three times per frame) -- it yields instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, 'scripts', 'recomp', 'host');
const hostSrc = join(host, 'src');
const lift = join(root, 'scripts', 'recomp', 'lift');
const web = join(root, 'scripts', 'recomp', 'web');

test('build_boot.py: the web profile links with JSPI and Wasm-EH setjmp/longjmp; the node profile does not', () => {
  const src = readFileSync(join(lift, 'build_boot.py'), 'utf8');
  const webBlock = src.slice(src.indexOf('    if args.web:'), src.indexOf('    if args.fast:'));
  assert.ok(webBlock.length > 0, 'the web profile block exists before the fast profile block');
  for (const flag of ['"-sJSPI"', '"-sJSPI_IMPORTS=emscripten_sleep,__asyncjs__isaac_yield_js,isaac_fs_lazy_pread_js"', '"-sSUPPORT_LONGJMP=wasm"'])
    assert.ok(webBlock.includes(flag), `web LDFLAGS carry ${flag}`);
  // JSPI_EXPORTS names wasm exports: 'isaac_run_main', never '_isaac_run_main'
  const m = webBlock.match(/"-sJSPI_EXPORTS=([A-Za-z0-9_,]+)"/);
  assert.ok(m, 'JSPI_EXPORTS is set');
  const names = m[1].split(',');
  assert.ok(names.includes('isaac_run_main'), 'the run entry returns a promise');
  assert.ok(names.includes('isaac_run_boot'), 'the boot entry too: a Sleep reached during the CRT boot must have a suspender');
  for (const n of names) assert.ok(!n.startsWith('_'), `${n}: a wasm export name, not the JS-side _name`);
  // the Wasm-EH sjlj reaches every setjmp/longjmp user: host TUs, dispatch_tbl.c, Lua
  assert.ok(webBlock.includes('SJLJ_CFLAGS = ["-sSUPPORT_LONGJMP=wasm"]') && webBlock.includes('HOST_CFLAGS = HOST_CFLAGS + SJLJ_CFLAGS'),
    'host TUs compile with the Wasm-EH sjlj');
  assert.ok(webBlock.includes('LUA_LIB = LUA_LIB_WASM_SJLJ'), 'the web profile links the wasm-sjlj Lua archive');
  assert.ok(src.includes('LUA_LIB_WASM_SJLJ = OUT_HOST / "lua-wasmsjlj" / "liblua.a"'), 'which lives beside the default one');
  assert.ok(src.includes('"boot_integration.c", "recomp_rt.c") else LIFT_CFLAGS + SJLJ_CFLAGS) + inc_lift'),
    'dispatch_tbl.c (compiled with the lifted flags) gets it too: isaac_guest_call_inner is the setjmp under every guest call');
  assert.ok(src.includes('r = run(py_cmd(str(HOST / "lua_build.py"), "--build", "--sjlj", "wasm"))'),
    'a missing wasm-sjlj Lua is built, not silently substituted');
  // the lifted objects stay shared with the node profiles: their fingerprint
  // does not see the sjlj flag (they never call setjmp/longjmp themselves)
  assert.ok(src.includes('dep_fp.update(repr(LIFT_CFLAGS + inc_lift).encode())'), 'lifted-TU fingerprint unchanged');
  assert.ok(!src.includes('LIFT_CFLAGS = LIFT_CFLAGS + SJLJ_CFLAGS'), 'LIFT_CFLAGS itself is untouched');
  // nothing JSPI-related leaks into the node profile's flags
  const outsideWeb = src.slice(0, src.indexOf('    if args.web:')) + src.slice(src.indexOf('    if args.fast:'));
  assert.ok(!/-sJSPI/.test(outsideWeb.replace(/#[^\n]*/g, '')), 'JSPI is web-only (comments aside)');
  const lua = readFileSync(join(host, 'lua_build.py'), 'utf8');
  assert.ok(lua.includes('ap.add_argument("--sjlj", choices=("emscripten", "wasm"), default="emscripten"'), 'lua_build.py --sjlj');
  assert.ok(lua.includes('return ["-sSUPPORT_LONGJMP=wasm"] if sjlj == "wasm" else []'), 'the wasm variant compiles with the Wasm-EH sjlj');
  assert.ok(lua.includes('BUILD_WASM_SJLJ = OUT_DIR / "lua-wasmsjlj"') && lua.includes('return BUILD_WASM_SJLJ if sjlj == "wasm" else BUILD'),
    'and into its own directory, so the default archive is untouched');
  assert.ok(lua.includes('cmd = [emcc, "-c"] + CFLAGS + sjlj_cflags(args.sjlj)'), 'the flag reaches the compile');
});

test('SwapBuffers hands the frame to the browser: one JSPI suspension per present, only with ISAAC_YIELD=1', () => {
  const win = readFileSync(join(hostSrc, 'host_shims_win.c'), 'utf8');
  const fn = win.slice(win.indexOf('void imp_gdi32__SwapBuffers(CpuState *restrict cpu) {'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(/#ifdef ISAAC_WEB\s*\/\*[^]*?\*\/\s*if \(isaac_web_yield_enabled\(\)\) isaac_yield_js\(\);\s*#endif\s*\}$/.test(body),
    'the yield is the last thing SwapBuffers does, under ISAAC_WEB, gated on the runtime switch');
  assert.ok(body.indexOf('isaac_threads_slice(cpu); }') < body.indexOf('emscripten_sleep(0)'),
    'the thread slices run before the frame is handed over');
  assert.ok(body.indexOf('cpu->EAX = 1;') < body.indexOf('emscripten_sleep(0)'), 'the return value is set before suspending');
  // the switch: ISAAC_YIELD=1 also selects wall-clock time, once
  const sw = win.slice(win.indexOf('int isaac_web_yield_enabled(void) {'));
  assert.ok(sw.length > 0 && win.lastIndexOf('#ifdef ISAAC_WEB', win.indexOf('int isaac_web_yield_enabled(void) {')) > 0,
    'isaac_web_yield_enabled exists in the web build');
  assert.ok(/getenv\("ISAAC_YIELD"\)/.test(sw.slice(0, 600)), 'it reads ISAAC_YIELD');
  assert.ok(/v = \(e && \*e && \*e != '0'\) \? 1 : 0;/.test(sw.slice(0, 600)), 'any value but 0 enables it');
  assert.ok(/if \(v\) \{\s*extern void isaac_time_set_mode\(int mode\);\s*isaac_time_set_mode\(1\);/.test(sw.slice(0, 700)),
    'interactive mode paces on the wall clock (QPC = performance.now)');
  assert.ok(sw.slice(0, 600).includes('static int v = -1;'), 'decided once');
});

test('Sleep is a real wall-clock wait when interactive, never from a thread slice, and still yields last', () => {
  const fwd = readFileSync(join(hostSrc, 'host_shims_forward.c'), 'utf8');
  const helper = fwd.slice(fwd.indexOf('static void sleep_yield_web(uint32_t ms) {'));
  assert.ok(helper.length > 0, 'the helper exists');
  assert.ok(fwd.lastIndexOf('#ifdef ISAAC_WEB', fwd.indexOf('static void sleep_yield_web')) > fwd.indexOf('void imp_kernel32__QueryPerformanceFrequency'),
    'the helper is under ISAAC_WEB');
  assert.ok(/if \(ms && isaac_web_yield_enabled\(\) && !isaac_threads_slicing\(\)\)\s*emscripten_sleep\(ms > 50u \? 50u : ms\);/.test(helper.slice(0, 400)),
    'guarded on the runtime switch AND on not being inside a slice; capped at 50 ms');
  assert.ok(fwd.includes('#define sleep_yield_web(ms) ((void)(ms))'), 'a no-op in the node profile');
  const sleep = fwd.slice(fwd.indexOf('void imp_kernel32__Sleep(CpuState *restrict cpu) {'));
  const body = sleep.slice(0, sleep.indexOf('\n}') + 2);
  assert.ok(body.includes('sleep_yield_web(ms);'), 'the Sleep shim calls it');
  assert.ok(body.indexOf('cpu->EAX = 0;') < body.indexOf('sleep_yield_web(ms);'), 'after the return value is set');
  assert.ok(body.indexOf('sleep_yield_web(ms);') < body.indexOf('isaac_threads_yield();'), 'and before the slice yield');
  assert.ok(/isaac_threads_yield\(\); \}\s*\}$/.test(body), 'isaac_threads_yield() is still the last statement of Sleep (round 24)');
  const mod = readFileSync(join(hostSrc, 'host_shims_module.c'), 'utf8');
  assert.ok(mod.includes('int isaac_threads_slicing(void) { return g_slicing; }'), 'the guard reads the slice runner state');
});

test('run_web.mjs: interactive=1 implies serve and puts ISAAC_YIELD=1 on the page', () => {
  const src = readFileSync(join(web, 'run_web.mjs'), 'utf8');
  assert.ok(src.includes("const INTERACTIVE = (process.argv.slice(4).find((a) => a.startsWith('interactive=')) || 'interactive=0').slice(12) !== '0';"),
    'interactive= is parsed');
  assert.ok(src.includes("const SERVE = INTERACTIVE || (process.argv.slice(4).find((a) => a.startsWith('serve=')) || 'serve=0').slice(6) !== '0';"),
    'it implies serve=1');
  assert.ok(src.includes("if (INTERACTIVE) qs.set('ISAAC_YIELD', '1');"), 'ISAAC_YIELD=1 goes into the query string (the page copies ISAAC_* into ENV)');
  assert.ok(src.includes("&& !a.startsWith('interactive=')).map("), 'interactive= is not forwarded as an ENV pair');
  const page = readFileSync(join(web, 'boot_web.mjs'), 'utf8');
  assert.ok(page.includes("for (const [k, v] of params) if (k.startsWith('ISAAC_')) cfg.ENV[k] = v;"), 'the page forwards ISAAC_* params to ENV');
});

test('the interactive driver is state-driven: Enter until the game logs a run, then walk', () => {
  // in interactive mode the game paces on the wall clock, so a frame-keyed
  // timeline lands on whatever screen is up (round 26: it parked on the
  // main menu once the boot got fast)
  const drv = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_interactive.mjs'), 'utf8');
  assert.ok(drv.includes("const startRe = /Room 1\\.2\\(Start Room\\)|Starting room transition/;"), 'the run-started marker is the game\'s own log');
  assert.ok(drv.includes("await page.keyboard.down('Enter'); await sleep(120); await page.keyboard.up('Enter');"),
    'real key events through Playwright, held across frames (a tap lands between two per-frame samples)');
  assert.ok(drv.includes("summary.shotsDiffer = !a.equals(b);"), 'walking must change the picture');
  assert.ok(/process\.exit\(ok \? 0 : 1\)/.test(drv), 'the exit code is the verdict');
});

test('boot_web.mjs: every stage is awaited (the run entries return promises under JSPI), live input first', () => {
  const page = readFileSync(join(web, 'boot_web.mjs'), 'utf8');
  assert.ok(/async function stageOk\(name, fn\) \{\s*log\(`=== \$\{name\} ===`\);\s*try \{\s*return await fn\(\);/.test(page),
    'stageOk awaits the stage inside its try, so a rejected promise is a TRAP like a thrown one');
  assert.ok(page.includes("done.mainRc = await stageOk('main @ 0x00931050'"), 'main is awaited');
  assert.ok(page.includes("done.bootRc = await stageOk('host boot (IAT + TEB + TLS + _initterm)', () => m._isaac_run_boot(1));"), 'boot is awaited');
  assert.equal((page.match(/(?<!await )stageOk\('/g) || []).length, 0, 'no stage is called without await');
  assert.ok(page.includes("typeof r.then === 'function' ? 'promise (JSPI)' : 'value (synchronous)'"), 'the log says which kind the entry returned');
  // live DOM input is queued and served ahead of the scripted timeline
  const poll = page.slice(page.indexOf('cfg.isaacInputPoll = (frame, out) => {'));
  assert.ok(poll.indexOf('if (live.length) {') > 0 && poll.indexOf('if (live.length) {') < poll.indexOf('timeline[0].frame > frame'),
    'the live queue is drained before the timeline');
  for (const s of ["window.addEventListener('keydown', (ev) => { resumeAudio(); onKey(ev, true); });", "window.addEventListener('keyup', (ev) => onKey(ev, false));",
                   "canvasEl.addEventListener('mousemove'", "canvasEl.addEventListener('mousedown'", "canvasEl.addEventListener('mouseup'",
                   'if (ev.repeat) { ev.preventDefault(); return; }', 'live.push([1, vk, sc | (ext << 8), down ? 1 : 0]);'])
    assert.ok(page.includes(s), `live input: ${s}`);
  assert.ok(page.includes("if (/^Key[A-Z]$/.test(c)) return c[3].toLowerCase();"), 'event.code KeyA..KeyZ map through the shared KEYS table');
  assert.ok(page.includes('window.isaacFrame = n;'), 'the host frame counter is live on window (a driver paces real key events on it)');
});
