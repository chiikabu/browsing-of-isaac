// Web build of the recomp boot (round 13): the GL surface has two backends --
// the headless fake in host_shims_gl.c (node profile) and the WebGL2
// forwarder in host_gl_webgl.c (build_boot.py --web). Every opengl32 entry
// point the shim table knows must have a body in BOTH, and the fake bodies
// must be compiled out of the web build, or the web link either fails or
// silently keeps a no-op for a call the game relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostSrc = join(root, 'scripts', 'recomp', 'host', 'src');
const table = join(root, 'scripts', 'recomp', 'host', 'generated', 'shim_table.c');

// entry points the shared fake keeps in both builds (capability gates)
const SHARED = new Set(['wglCreateContext', 'wglDeleteContext', 'wglGetProcAddress',
  'wglGetCurrentDC', 'wglGetCurrentContext', 'wglMakeCurrent', 'wglShareLists',
  'glGetIntegerv', 'glGetString', 'glGetStringi']);

function opengl32Symbols() {
  if (!existsSync(table)) return null;   // generated table not present: nothing to compare
  const t = readFileSync(table, 'utf8');
  const out = new Set();
  for (const m of t.matchAll(/"opengl32\.dll",\s*"([A-Za-z0-9_]+)"/g)) out.add(m[1]);
  return out;
}

test('every opengl32 import has a fake body and a WebGL body', () => {
  const syms = opengl32Symbols();
  if (!syms) return;
  const fake = readFileSync(join(hostSrc, 'host_shims_gl.c'), 'utf8');
  const web = readFileSync(join(hostSrc, 'host_gl_webgl.c'), 'utf8');
  const fakeDefs = new Set([...fake.matchAll(/^void imp_opengl32__(\w+)\(CpuState/gm)].map((m) => m[1]));
  const webDefs = new Set([...web.matchAll(/^GLFN\((\w+)\)|^UMAT\((\w+),/gm)].map((m) => m[1] || m[2]));
  const missingFake = [...syms].filter((s) => !fakeDefs.has(s));
  const missingWeb = [...syms].filter((s) => !SHARED.has(s) && !webDefs.has(s));
  assert.deepEqual(missingFake, [], 'opengl32 imports without a headless body');
  assert.deepEqual(missingWeb, [], 'opengl32 imports without a WebGL body (host_gl_webgl.c)');
});

test('the fake GL bodies are compiled out of the web build', () => {
  const fake = readFileSync(join(hostSrc, 'host_shims_gl.c'), 'utf8');
  const open = fake.indexOf('#ifndef ISAAC_WEB');
  const close = fake.indexOf('#endif /* !ISAAC_WEB */');
  assert.ok(open > 0 && close > open, 'the #ifndef ISAAC_WEB region exists');
  const inside = fake.slice(open, close);
  for (const name of ['glClear', 'glDrawElements', 'glTexImage2D', 'glShaderSource', 'glUseProgram'])
    assert.ok(inside.includes(`imp_opengl32__${name}(`), `${name}: fake body inside the region`);
  const web = readFileSync(join(hostSrc, 'host_gl_webgl.c'), 'utf8');
  assert.ok(web.startsWith('/*') && web.includes('#ifdef ISAAC_WEB') && web.trimEnd().endsWith('#endif /* ISAAC_WEB */'),
    'host_gl_webgl.c is entirely under ISAAC_WEB');
});

test('the web build wires the frame capture and the context', () => {
  const win = readFileSync(join(hostSrc, 'host_shims_win.c'), 'utf8');
  assert.match(win, /imp_gdi32__SwapBuffers[\s\S]{0,200}#ifdef ISAAC_WEB[\s\S]{0,120}isaac_web_present\(\)/,
    'SwapBuffers presents the frame in the web build');
  const gl = readFileSync(join(hostSrc, 'host_shims_gl.c'), 'utf8');
  assert.ok(gl.includes('emscripten_webgl_create_context("#canvas"'), 'wglCreateContext creates the WebGL2 context on #canvas');
  const web = readFileSync(join(hostSrc, 'host_gl_webgl.c'), 'utf8');
  assert.ok(web.includes('Module.isaacPresent'), 'the frame reaches the page through Module.isaacPresent');
  assert.ok(web.includes('isaac_gl_draw_elements(') && web.includes('isaac_gl_vertex_attrib_pointer('),
    'geometry goes through the client-array emulation');
  const page = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  for (const s of ['cfg.isaacPresent', 'cfg.isaacLazyRead', '_isaac_fs_seed_lazy', '_isaac_run_main', 'FS.writeFile'])
    assert.ok(page.includes(s), `boot_web.mjs: ${s}`);
  const build = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'build_boot.py'), 'utf8');
  assert.ok(build.includes('-DISAAC_WEB=1') && build.includes('-sENVIRONMENT=web') && build.includes('"-lGL"'),
    'build_boot.py --web defines ISAAC_WEB and links for the browser with GL');
});

test('scripted input: the page and the node driver agree on the key table, the host has the queue', () => {
  const page = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  // round 30: the node driver's table lives in explore.mjs (`export const KEYS`),
  // shared with the explorer and the console driver, and covers every letter,
  // digit and the US punctuation -- more than the page's; the two must agree on
  // every key both define
  const node = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'explore.mjs'), 'utf8');
  const table = (src, decl) => {
    const out = {};
    const block = src.slice(src.indexOf(decl), src.indexOf('};', src.indexOf(decl)));
    for (const m of block.matchAll(/'?([a-z0-9]+)'?:\s*\[(0x[0-9A-Fa-f]+),\s*(0x[0-9A-Fa-f]+),\s*([01])\]/g))
      out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
    return out;
  };
  const pk = table(page, 'const KEYS = {'), nk = table(node, 'export const KEYS = {');
  assert.ok(Object.keys(pk).length >= 40, 'page key table parsed');
  assert.ok(Object.keys(nk).length >= 60, 'node key table parsed');
  const common = Object.keys(nk).filter((k) => k in pk);
  assert.ok(common.length >= 10, `page and node tables share at least ten keys (${common.length})`);
  for (const k of common)
    assert.deepEqual(pk[k], nk[k], `key '${k}': page and node driver disagree on vk/scancode/extended`);
  for (const k of ['enter', 'escape', 'up', 'down', 'left', 'right', 'a', 'd', 's', 'w'])
    assert.ok(k in nk && k in pk, `key '${k}' in both tables`);
  // GLFW decodes the scancode from lParam bits 16..23 (+24 extended); pin the
  // canonical ones so a typo cannot silently map Enter to another key
  assert.deepEqual(pk.enter, [0x0D, 0x1C, 0]); assert.deepEqual(pk.escape, [0x1B, 0x01, 0]);
  assert.deepEqual(pk.up, [0x26, 0x48, 1]); assert.deepEqual(pk.down, [0x28, 0x50, 1]);
  assert.deepEqual(pk.left, [0x25, 0x4B, 1]); assert.deepEqual(pk.right, [0x27, 0x4D, 1]);
  const win = readFileSync(join(hostSrc, 'host_shims_win.c'), 'utf8');
  for (const s of ['void isaac_input_key(', 'void isaac_input_mouse_move(', 'void isaac_input_mouse_button(',
                   'Module.isaacInputPoll', 'isaac_guest_call(proc, &sub)', 'input_poll_page();'])
    assert.ok(win.includes(s), `host_shims_win.c: ${s}`);
  assert.ok(/msgq_pop_into\(msg\)\) \{ cpu->EAX = 1; return; \}[\s\S]{0,200}frame_cap\(\)/.test(win),
    'PeekMessageW drains the queue before the frame cap posts WM_QUIT');
});

// Round 17: the canvas already shows every frame, so the framebuffer readback
// exists only to hand PNGs to the runner. Reading a 960x540 frame back is 2 MB
// through glReadPixels and it stalls the GL pipeline, so the host asks the page
// which frames it actually wants and skips the rest. Measured over 300 frames:
// 52.3 s with every frame read back, 46.6 s with 13 of them.
test('the web backend asks before reading a frame back, and the page answers', () => {
  const gl = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_gl_webgl.c'), 'utf8');
  assert.ok(gl.includes('EM_JS(int, isaac_wants_frame_js, (unsigned n)'), 'the host has the question');
  assert.ok(gl.includes('if (typeof Module.isaacWantsFrame !== "function") return 1;'),
    'a page without the hook still gets every frame');
  assert.ok(gl.includes('if (!isaac_wants_frame_js(g_present_count)) return;'),
    'the readback is skipped before glReadPixels, not after');
  const page = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(page.includes('cfg.isaacWantsFrame = (n) => {'), 'the page answers');
  assert.ok(page.includes('const frame = { n: wantedFrame || presented, w, h,'),
    'kept frames carry the host frame number, which no longer tracks the capture count');
});

test('a served page is playable from the bare origin: it redirects to the run query, the live page has no 5-frame budget, the type follows the file', () => {
  const r = readFileSync(join(root, 'scripts', 'recomp', 'web', 'run_web.mjs'), 'utf8');
  assert.ok(r.includes("res.writeHead(302, { Location: `/boot_web.html?${qs}`, 'Cache-Control': 'no-store' });"),
    'GET / redirects to the page with the frames budget and ISAAC_YIELD');
  assert.ok(r.includes("'Content-Type': b64 ? 'text/plain' : mime(r.file || rel)"),
    'the content type is the served file\'s, so / is text/html and not a download');
  const w = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(w.includes("cfg.ENV.ISAAC_MAX_FRAMES = params.get('frames') || (params.get('ISAAC_YIELD') === '1' ? '100000000' : '5');"),
    'a live page without frames= plays until it is closed');
});

test('round 37: the web GL wrappers answer from the host cache, the present drains errors sparsely, the yield is not a timer', () => {
  const gl = readFileSync(join(hostSrc, 'host_gl_webgl.c'), 'utf8');
  assert.ok(existsSync(join(hostSrc, 'host_gl_cache.c')), 'host_gl_cache.c holds the tables (compiled into every profile by the src glob)');
  assert.ok(gl.includes('if (out && A(0) == GL_RENDERBUFFER && isaac_glc_rb_param(A(1), &v)) { *out = (GLint)v; RET0; }'),
    'glGetRenderbufferParameteriv answers from the storage call');
  assert.ok(gl.includes('if (isaac_glc_fbo_status(A(0), &st)) RETV(st);'), 'glCheckFramebufferStatus is remembered');
  assert.ok(gl.includes('if (isaac_glc_loc_get(A(0), 1, name, &loc)) RETV((uint32_t)loc);'), 'glGetUniformLocation is remembered');
  assert.ok(gl.includes('if (isaac_glc_loc_get(A(0), 0, name, &loc)) RETV((uint32_t)loc);'), 'glGetAttribLocation is remembered');
  for (const feed of ['isaac_glc_rb_storage(A(1), A(2), A(3), 0);', 'isaac_glc_fbo_attach(A(0), A(1), 0, A(3), 0);',
                      'isaac_glc_fbo_attach(A(0), A(1), 1, A(3), (A(2) << 8) ^ A(4));', 'isaac_glc_tex_image(A(0));', 'isaac_glc_loc_flush(prog);',
                      'isaac_glc_tex_bind(A(0), A(1));', 'isaac_glc_tex_active(A(0));'])
    assert.ok(gl.includes(feed), `the cache is fed by ${feed}`);
  assert.ok(gl.includes('if (gl_check_mode() || (g_present_count & 63u) == 1u) {'),
    'the present drains glGetError every 64th frame unless ISAAC_GL_CHECK=1');
  const win = readFileSync(join(hostSrc, 'host_shims_win.c'), 'utf8');
  assert.ok(win.includes('if (isaac_web_yield_enabled()) isaac_yield_js();'), 'SwapBuffers yields through isaac_yield_js');
  const yieldBody = win.slice(win.indexOf('EM_ASYNC_JS(void, isaac_yield_js, (void), {'), win.indexOf('/* ISAAC_YIELD=1:'));
  assert.ok(yieldBody.includes('new MessageChannel()') && yieldBody.includes('port2.postMessage(0)'),
    'the yield is a MessageChannel message');
  assert.ok(yieldBody.includes('if (work < 15 && typeof requestAnimationFrame === "function") {'),
    'a frame with spare time waits for the next refresh instead (one game frame per display frame)');
  assert.ok(!/scheduler\.yield\(/.test(yieldBody), 'never scheduler.yield() (its continuation starves the other tasks)');
  assert.ok(!/setTimeout\(resolve, 0\)|emscripten_sleep/.test(yieldBody), 'never a zero timer (the 4 ms clamp)');
  assert.ok(yieldBody.includes('if (typeof document !== "undefined" && document.hidden) {') && yieldBody.includes('setTimeout(resolve, 250)'),
    'a hidden document ticks on a slow timer instead of stalling on requestAnimationFrame');
  assert.ok(yieldBody.includes('var timer = setTimeout(function () {') && yieldBody.includes('requestAnimationFrame(function () { if (done) return; done = true; clearTimeout(timer); resolve(); });'),
    'round 49: the animation-frame wait races a 250 ms timer (a visible page can get no frames: an occluded embedded view)');
  assert.ok(yieldBody.includes('Module.isaacYieldNoRaf = (Module.isaacYieldNoRaf | 0) + 1;'), 'the fallback ticks are counted');
  const bb = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'build_boot.py'), 'utf8');
  assert.ok(bb.includes('"-sJSPI_IMPORTS=emscripten_sleep,__asyncjs__isaac_yield_js,isaac_fs_lazy_pread_js"'), 'the yield import suspends the wasm stack, and so does the window read (round 56)');
});

test('round 40: the module is served cacheably and instantiated from the fetch itself, so V8 keeps its optimised code across visits', () => {
  const r = readFileSync(join(root, 'scripts', 'recomp', 'web', 'run_web.mjs'), 'utf8');
  assert.ok(r.includes("const whole = r.file && !u.searchParams.has('off') && !b64;"), 'whole files get a validator');
  assert.ok(r.includes("'Cache-Control': whole ? 'no-cache' : 'no-store' };"), 'whole files are no-cache (revalidate), slices stay no-store');
  assert.ok(r.includes("if (req.headers['if-none-match'] === etag) { res.writeHead(304,"), 'a matching validator answers 304');
  const p = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(p.includes('await WebAssembly.instantiateStreaming(res, info);'), 'the shipping page streams the fetch Response itself');
  assert.ok(!p.includes('new Response(counted'), 'no synthetic Response (it has no cache entry for the code cache)');
  assert.ok(p.includes('const counted = res.clone().body.getReader();'), 'the progress bar reads a clone');
  for (const d of ['drive_perf.mjs', 'profile_play.mjs']) {
    const s = readFileSync(join(root, 'scripts', 'recomp', 'web', d), 'utf8');
    assert.ok(s.includes('chromium.launchPersistentContext(PROFILE_DIR,'), `${d} can measure a warm start (profile_dir=)`);
  }
});

test('round 41: a fetched archive window is detached right after the copy, so the GC never has to catch up with a level load', () => {
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes("if (b && typeof b.transfer === 'function' && !b.detached) b.transfer(0);"), 'transfer(0) frees the backing store at once (guarded for older browsers)');
  assert.ok(/m\.HEAPU8\.set\(bytes, dst\);[\s\S]{0,400}dropBody\(bytes\);[\s\S]{0,400}return n;/.test(b), 'the window is copied, then dropped, and the count returned is the saved one');
  assert.ok(/lazyBytes \+= len;[^\n]*\n\s*dropBody\(bytes\);/.test(b), 'a whole-file lazy read drops its body too');
});

test('round 44: redundant GL state calls are skipped in the web wrappers, and deletions clear the mirrors', () => {
  const gl = readFileSync(join(hostSrc, 'host_gl_webgl.c'), 'utf8');
  assert.ok(gl.includes('if (gls_prog_ok && gls_prog == A(0)) { ++gls_skip_prog; RET0; }'), 'glUseProgram of the current program is skipped');
  assert.ok(gl.includes('if (gls_unit_ok && gls_unit == A(0)) { ++gls_skip_unit; RET0; }'), 'glActiveTexture of the active unit is skipped');
  assert.ok(gl.includes("if (slot && *slot == A(1) + 1u) { ++gls_skip_tex; RET0; }"), 'glBindTexture of the bound texture (per unit and target) is skipped');
  assert.ok(gl.includes('gls_blend[2] == A(2) && gls_blend[3] == A(3)) { ++gls_skip_blend; RET0; }'), 'an identical blend function is skipped');
  assert.ok(gl.includes('gls_vp[2] == A(2) && gls_vp[3] == A(3)) { ++gls_skip_vp; RET0; }'), 'an identical viewport is skipped');
  assert.ok(gl.includes('if (gls_prog_ok && gls_prog == A(0)) gls_prog_ok = 0; glDeleteProgram(A(0));'), 'deleting the current program forgets it');
  assert.ok(gl.includes('if (gls_tex2d[u] == names[i] + 1u) gls_tex2d[u] = 0;'), 'deleting a bound texture forgets the binding');
  assert.ok(/isaac_glc_tex_active\(A\(0\)\);\s*if \(gls_unit_ok/.test(gl) && /isaac_glc_tex_bind\(A\(0\), A\(1\)\);\s*\{/.test(gl),
    'the framebuffer memo is told about the unit and the binding even when the call is skipped');
  assert.ok(gl.includes('redundant state calls skipped: useProgram %u, activeTexture %u, bindTexture %u, blend %u, viewport %u'), 'the census');
});

test('round 48: redundant attribute enables and uniform re-sends are skipped; a link or delete forgets the program', () => {
  const gl = readFileSync(join(hostSrc, 'host_gl_webgl.c'), 'utf8');
  assert.ok(gl.includes('if (gls_attrib_known[A(0)] && gls_attrib_on[A(0)]) { ++gls_skip_attrib; RET0; }'), 'an enable of an enabled attribute is skipped');
  assert.ok(gl.includes('if (gls_attrib_known[A(0)] && !gls_attrib_on[A(0)]) { ++gls_skip_attrib; RET0; }'), 'a disable of a disabled one too');
  assert.ok(gl.includes('glu_same((GLint)A(0), (uint8_t)(A(2) ? 7 : 6), AP(3), 16)'), 'a matrix already held by the program is not re-sent');
  assert.ok(gl.includes('glu_same((GLint)A(0), 2, &v, 1)'), 'nor a sampler unit');
  assert.ok(gl.includes('if (!gls_prog_ok || n > 16u) return 0;'), 'no current program: forwarded (GL reports it)');
  assert.ok(/glu_forget\(prog\);[^\n]*\n\s*glLinkProgram\(prog\);/.test(gl) && gl.includes('glu_forget(A(0)); if (gls_prog_ok && gls_prog == A(0)) gls_prog_ok = 0; glDeleteProgram(A(0));'),
    'a link resets the uniforms, a delete frees the name: both forget');
  assert.ok(gl.includes('attrib enables %u, uniforms %u'), 'the census');
});

test('round 49: the edge suite hides the tab for as long as asked and continues the same run after a reload', () => {
  const drv = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_edges.mjs'), 'utf8');
  assert.ok(drv.includes("const HIDDEN_S = Number(opt.hidden_s || '8');"), 'hidden_s= sets the hidden period');
  assert.ok(drv.includes("'continue after the reload resumes the same run'"), 'the same-run check');
  assert.ok(drv.includes('/RNG Start Seed: .*\\[(Continue|New), \\d+\\]/'), 'a continue is told from a new run by the seed line');
  assert.ok(drv.includes("sa[2] === 'Continue' && sa[1] === sb[1]"), 'the seed must match the run before the reload');
  assert.ok(drv.includes("'the continued run plays at full rate'"), 'and the continued run is measured');
  assert.ok(drv.includes('window.requestAnimationFrame = () => 0;') && drv.includes("'no animation frames: the game ticks on the fallback timer instead of stalling'"),
    'check 5 forges a visible page with no animation frames');
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(play.includes('no animation frames (${nrDelta} timer tick(s) this second: occluded?)'), 'the shipping status line names the fallback');
});

test('round 51: the loading overlay really hides on the first frame, and the live status is an opt-in corner line', () => {
  const html = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.html'), 'utf8');
  assert.ok(html.includes('[hidden] { display: none !important; }'), 'the hidden attribute outranks #overlay/#stages display rules');
  assert.ok(/#overlay \{[^}]*display: flex/.test(html) && /#stages \{[^}]*display: grid/.test(html), 'the rules it has to outrank are still there');
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(play.includes("if (f > 0 && !firstFrameSeen) { firstFrameSeen = true; overlay.hidden = true; canvas.focus(); }"), 'the first frame hides the overlay');
  assert.ok(play.includes("const fpsEl = $('fps'); fpsEl.textContent = line; fpsEl.title = line + machine;"), 'the corner line (?stats=1) carries the status during play, the machine in its tooltip');
  assert.ok(!play.includes("$('fps').textContent = fps > 0 ?"), 'one writer for the header line');
});

test('round 52: the EDIT FILE menu -- the page takes the keys while it is up, presses confirm for Delete, and ships with the page', () => {
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes("if (typeof window.isaacKeyCapture === 'function' && window.isaacKeyCapture(ev, down)) { ev.preventDefault(); return; }"), 'a page menu takes the keys');
  assert.ok(b.includes("window.isaacInjectKey = (name, down) => { const k = KEYS[String(name).toLowerCase()]; if (k) live.push([1, k[0], k[1] | (k[2] << 8), down ? 1 : 0]); };"), 'the page can press a key (by the key table name, any case)');
  const p = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(p.includes("import { createEditFileMenu, createPaperMenu } from './menu_overlay.mjs';"),
    'the menu module, and the paper menu the mods menus are drawn on (round 76)');
  assert.ok(p.includes("window.isaacEditFile = (slot) => { editMenu.open(slot); };")
    && p.includes("window.isaacKeyCapture = (ev, down) => (modsMenu.isOpen() ? modsMenu.onKey(ev, down) : editMenu.onKey(ev, down));"),
    'the host gate reaches the menu; whichever menu is up takes the keys');
  assert.ok(p.includes("assetsUrl: `${ROOT}/instance/page-assets`"), 'the assets come from the dist');
  const m = readFileSync(join(root, 'scripts', 'recomp', 'web', 'menu_overlay.mjs'), 'utf8');
  assert.ok(m.includes("window.isaacEditFileDelete = state.slot;") && m.includes("injectKey('enter', true);"), 'Delete names the slot and presses confirm: the engine prompt');
  assert.ok(m.includes("['EXPORT FILE', 'IMPORT FILE', 'DELETE FILE', 'BACK']"), 'the entries');
  // round 81: it used to be remembered, so one press of N left a readout over
  // the game for good. Off at every load; N still flips it for the visit.
  assert.ok(m.includes('const toggleFps = () => {') && m.includes('fpsOn: false'), 'the fps readout is a toggle');
  assert.ok(!m.includes("localStorage.setItem('isaac-fps-viewer'") && !m.includes("localStorage.getItem('isaac-fps-viewer'"),
    'and it does not survive a reload');
  assert.ok(p.includes("if (ev.code === 'KeyN' && !ev.repeat") && p.includes('window.isaacEditFileMenu.toggleFps();'), 'N flips the FPS readout (unbound in the game)');
  assert.ok(m.includes("const text = `${Math.round(state.fps)}`;") && m.includes('drawText(gg, text, 2, 2, A.atlasWhite);'), 'the readout is the number alone, in white');
  assert.ok(!p.includes('page-settings.json'), 'no page setting in the saves store');
  const pa = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'page_assets.py'), 'utf8');
  assert.ok(pa.includes('render_text(font, atlas, "EDIT FILE", ink)') && pa.includes('items.append({"h1": e.h1, "h2": e.h2, "data": patched})'), 'the sheet is reset in the font and repacked into afterbirthp.a');
  const bp = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'bundle.py'), 'utf8');
  assert.ok(bp.includes('Rule("page-assets", KEEP, ("page-assets/*",), "page assets",') && bp.includes('page_assets.build(out)'), 'the bundle carries the page assets');
});

test('round 53: draws in the standard quad pattern take one static index buffer, no upload', () => {
  const ca = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_gl_clientarrays.c'), 'utf8');
  assert.ok(ca.includes('if (quad_mode() && is_quad_block(isrc, count, type) && quad_ibo_ready(type, (uint32_t)count / 6u)) {'), 'the quad path comes before the ring');
  assert.ok(ca.includes('glDrawElements(mode, count, type, (const void *)0);   /* the static quad indices, from the start */'), 'drawn from offset 0 of the static buffer');
  assert.ok(ca.includes('if (g_bound_ibo != g_iring.buf) { glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_iring.buf); g_bound_ibo = g_iring.buf; }'), 'a reused ring block rebinds the ring after a quad draw');
  assert.ok(ca.includes('getenv("ISAAC_GL_QUAD_IBO")'), 'ISAAC_GL_QUAD_IBO=0 is the A/B');
  assert.ok(ca.includes('%u draws on the static quad index buffer (pattern %u %u %u %u %u %u), %u index blocks not the pattern'), 'the census');
});

test('round 54: the floor sweep driver seeds the console, walks every stage and watches memory per floor', () => {
  const d = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_floors.mjs'), 'utf8');
  assert.ok(d.includes("const STAGES = (opt.stages || '2,3,4,5,6,7,8,9,10,11,12,13,1c,2c,3c,4c')"), 'stages 2-13 and the alternate path by default');
  assert.ok(d.includes('await typeSlow(`stage ${st}`);') && d.includes('m_StageType (') && d.includes("`stage ${st}`"), 'each stage typed and its Level::Init awaited');
  assert.ok(d.includes("await bcdp.send('SystemInfo.getProcessInfo');"), 'the process memory per floor');
  assert.ok(d.includes("'the renderer working set stays within 400 MB of the first floor across the sweep'"), 'the memory check');
});

test('round 55/56: the boot trail, and every archive window read by a Worker with the wasm stack suspended', () => {
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes("const TRAIL_KEY = 'isaac-boot-trail', TRAIL_MAX = 512, READER_PARALLEL = 6, READER_BUDGET = 128 << 20, READ_AHEAD = 4;"), 'the trail, its cap, the parallelism, the byte budget and the read-ahead');
  assert.ok(b.includes("if (n >= 300 && !trailWritten) writeTrail();") && b.includes("if (!trailWritten && (window.isaacFrame | 0) >= 300) writeTrail();") && !b.includes("presented === 300") && b.includes("window.addEventListener('pagehide', () => { writeTrail(); if (reader) reader.terminate(); });"),
    'the trail is written by the host frame counter at frame 300 (isaacPresent never fires on the served page), or when the page goes');
  assert.ok(b.includes("w = new Worker(URL.createObjectURL(new Blob([READER_WORKER], { type: 'text/javascript' })));"), 'the reader is a Worker of this origin');
  // round 83: the fetch is three tries and then the whole chunk, because one
  // failed window returned -1 to the engine and trapped the run
  assert.ok(b.includes('const r = await fetch(url, init);') && b.includes('return await r.arrayBuffer();')
    && b.includes('let xorKey = null;') && b.includes("postMessage({ want: w, buf, hit: why !== 'want', pf: prefetched, ah: ahead }, buf ? [buf] : []);"), 'the Worker fetches raw bytes and transfers each window');
  // round 70: a portable chunk holds many windows, and the range rides in the
  // fragment because a fragment never reaches the server
  assert.ok(b.includes("const h = url.indexOf('#r=');") && b.includes("init = { headers: { Range: 'bytes=' + want0 + '-' + want1 } };")
    && b.includes('if (buf && want0 >= 0 && buf.byteLength > want1 - want0 + 1) buf = unscramble(buf, at >= 0 ? at - want0 : -1).slice(want0, want1 + 1);'),
    'a fragment range becomes a Range header, and a host that ignores it is put back and cut to size here');
  assert.ok(b.includes("return new Promise((resolve) => {") && b.includes("const wantUrl = reader ? windowUrl(src, off, len) : null;")
    && b.includes("reader.postMessage({ want: id, key, url: wantUrl, len, ahead });"), 'a read is a promise the Worker resolves (the wasm stack suspends: JSPI)');
  // round 70: a provider that has the bytes but no URL for them (the single-file
  // build, or a window straddling two chunks) leaves the Worker out of it
  assert.ok(b.includes("if (reader && wantUrl) {"), 'no URL, no Worker: the read falls through to the bytes path');
  assert.ok(b.includes("const forward = off > last && off - last <= READ_AHEAD * FS_WINDOW;") && b.includes("if (o >= size) break;"), 'read-ahead follows a file read forward and stops at its end');
  assert.ok(b.includes("params.get('reader') === '0'") && b.includes("return finishRead(src, off, dst, fetchSync(`/instance/${src}?off=${off}&len=${len}`));"), '?reader=0 and no Worker keep the synchronous read');
  assert.ok(b.includes("const decodeBase64 = (typeof Uint8Array.fromBase64 === 'function')") && b.includes("  return decodeBase64(x.responseText);"), 'the synchronous read decodes with the native decoder where there is one');
  assert.ok(b.includes('prefetched, prefetchHits, prefetchMisses, aheadFetched, readerWaits, readerWaitMs:'), 'the figures reach isaacLazyStats');
  const c = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_shims_fs.c'), 'utf8');
  assert.ok(c.includes('return (typeof n === "number" || (n && typeof n.then === "function")) ? n : -1;'), 'the C side hands a promise through to JSPI');
});

test('the node runner serves every module the pipeline imports', () => {
  // round 74 gave boot_web.mjs a sibling and the runner answered 404 for it: an
  // ES import that 404s is a module graph that never resolves, so window.isaacDone
  // was never set and every run sat on its 20-minute timeout with an empty log.
  // Served by shape now, and this is the pin that says so.
  const runner = readFileSync(join(root, 'scripts', 'recomp', 'web', 'run_web.mjs'), 'utf8');
  assert.ok(runner.includes("if (/^\\/[A-Za-z0-9_.-]+\\.mjs$/.test(rel)) return { file: join(HERE, rel.slice(1)) };"),
    'a page module is served by shape, not by name');
  // and the shape covers what is actually imported, transitively
  const web = join(root, 'scripts', 'recomp', 'web');
  const seen = new Set(['boot_web.mjs']);
  const queue = ['boot_web.mjs'];
  while (queue.length) {
    const f = queue.shift();
    const src = readFileSync(join(web, f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+\.mjs)'/g)) {
      const dep = m[1];
      if (dep === 'boot.mjs') continue;              // the build output, served from BOOT
      assert.match(dep, /^[A-Za-z0-9_.-]+\.mjs$/, `${dep} would not match the runner's rule`);
      assert.ok(existsSync(join(web, dep)), `${f} imports ${dep}, which is not beside it`);
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  assert.ok(seen.has('mods.mjs') && seen.has('zip.mjs'), 'and it does reach the round-74 modules');
});

test('round 59: a first visit gets the trail the dist ships', () => {
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes("const TRAIL_SHIPPED = 'boot-trail.json';") && b.includes("fetch(new URL(url, location.href).href).then((r) => (r.ok ? r.json() : null)).then((shipped) => {"), 'no trail of its own: the page asks for the shipped one');
  assert.ok(b.includes("if (!Array.isArray(shipped) || !shipped.length || reader !== w) return;") && b.includes("trailKept = shipped.length; trailShipped = true;"), 'a Worker that is gone gets nothing; the figures say the trail was shipped');
  assert.ok(b.includes("if (!trailArmed) { trailArmed = true; if (trailJobs) armTrail(trailJobs); }") && b.includes("w.postMessage({ jobs: [], budget: READER_BUDGET, parallel: READER_PARALLEL });"), 'the prefetch starts at the first presented frame, after the boot\'s own downloads');
  const sh = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'ship.py'), 'utf8');
  assert.ok(sh.includes('TRAIL_NAME = "boot-trail.json"') && sh.includes('add(TRAIL_NAME, os.path.abspath(args.trail), "trail", link=False)') && sh.includes('p.add_argument("--trail"'), 'ship.py --trail places it in the dist and the manifest');
  const d = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_boot.mjs'), 'utf8');
  assert.ok(d.includes("if (trailJson) writeFileSync(join(OUT, 'boot-trail.json'), trailJson);"), 'drive_boot.mjs leaves the trail for ship.py');
});

test('round 59: the saves round trip is driven on the shipping page, and the menu says what it does', () => {
  const d = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_saves.mjs'), 'utf8');
  assert.ok(d.includes("page.on('filechooser', (fc) => {") && d.includes('const nextChooser = (ms) =>'), 'one file-chooser listener for the whole drive, a queue behind it (the reloads in between)');
  assert.ok(d.includes("const keyOf = (n) => SAVE_DIR + `persistentgamedata${n}.dat`;") && d.includes('const lookalikes = (all, n) =>'), 'a file is found by the exact key the page writes; the engine\'s save_backups copies are named, not counted');
  assert.ok(d.includes("check(imported.length === 1 && same(imported[0].bytes, before[0].bytes)") && d.includes('a bare .dat imports into file 3 under this file'), 'the import is checked before the page reloads itself, and a bare .dat goes in too');
  const m = readFileSync(join(root, 'scripts', 'recomp', 'web', 'menu_overlay.mjs'), 'utf8');
  assert.ok(m.includes("log(`[menu] ${items()[i]} for file ${state.slot + 1}`);") && m.includes("log(`[menu] ${state.message}`);") && m.includes('message: () => state.message,'), 'the menu logs the choice and its outcome, and exposes the message');
  const pl = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(pl.includes("console.log('[menu] the file chooser was asked for');"), 'the import logs the chooser call');
});

test('round 60: after the boot the reader Worker drops what it fetched ahead and keeps a small read-ahead', () => {
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes('const READER_PLAY_BUDGET = 8 << 20, READER_CLEAR_FRAME = 600;'), 'the play budget and the frame');
  assert.ok(b.includes("if (n === READER_CLEAR_FRAME && reader) { reader.postMessage({ clear: true, budget: READER_PLAY_BUDGET }); trailJobs = null; }"), 'the page tells the Worker at frame 600');
  assert.ok(b.includes("if (d.clear) { cache.clear(); held = inflightBytes; budget = d.budget; jobs = []; ji = 0; return; }"), 'the Worker drops its cache and the trail, keeps what is in flight, takes the new budget');
});

test('round 60: a large texture upload goes in bands, so the GL transfer chunk never grows past 4 MB', () => {
  const g = readFileSync(join(root, 'scripts', 'recomp', 'host', 'src', 'host_gl_webgl.c'), 'utf8');
  assert.ok(g.includes('#define TEX_BAND_BYTES (4u << 20)') && g.includes('getenv("ISAAC_GL_TEX_BAND")'), 'the band size and the A/B switch');
  assert.ok(g.includes('glTexImage2D(target, (GLint)A(1), (GLint)A(2), w, h, (GLint)A(5), format, type, NULL);') && g.includes('glTexSubImage2D(target, (GLint)A(1), 0, y, w, n, format, type, px + (size_t)y * row);'), 'a null allocation, then rows');
  assert.ok(g.includes('uint32_t row = ((uint32_t)w * bpp + 3u) & ~3u;'), 'rows at the default unpack alignment');
  assert.ok(g.includes('texture uploads: %u, %u of them in bands of %u MB (%u bands)%s'), 'the census line');
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes("dropBody(blob);                                           // round 60: this frame lives as long as main() does"), 'the placed image\'s bytes are dropped');
  const d = readFileSync(join(root, 'scripts', 'recomp', 'web', 'drive_memory.mjs'), 'utf8');
  assert.ok(d.includes("await cdp.send('HeapProfiler.collectGarbage')") && d.includes('window.__texUploads = T;'), 'the memory driver collects garbage before its reading and counts the uploads');
});

test('round 86: the reader Worker parses as the script it becomes', () => {
  // This is the test that was missing. READER_WORKER is a template literal, so
  // what the Worker receives is the COOKED value: a backslash in the source is
  // eaten as an escape and never reaches it. Round 84 wrote a Content-Range
  // check as /\/(\d+)\s*$/, which cooked into //(d+)s*$/ -- a line comment that
  // swallowed the assignment before it. Every build from that round on threw
  // `Uncaught SyntaxError: Unexpected token 'if'` the moment the Worker started,
  // so no read was ever prefetched and round 83's retries never ran either.
  // Reading the source text is not enough to catch that; it has to be cooked.
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  const open = b.indexOf('`', b.indexOf('const READER_WORKER'));
  let end = -1, depth = 0;
  for (let i = open + 1; i < b.length; i++) {
    const c = b[i];
    if (c === '\\') { i++; continue; }
    if (depth === 0 && c === '`') { end = i; break; }
    if (c === '$' && b[i + 1] === '{') { depth++; i++; continue; }
    if (depth > 0 && c === '}') depth--;
  }
  assert.ok(end > open, 'the template closes');
  const raw = b.slice(open + 1, end);

  // no backslash: the cooked source is then the source, and this whole class of
  // bug is gone rather than caught one instance at a time
  assert.ok(!raw.includes('\\'), 'no backslash inside the Worker template');
  assert.equal(raw.indexOf('${'), -1, 'and no substitution: the Worker source is a constant');

  // and it parses as a classic script, which is what a Worker is handed
  const cooked = new Function('return `' + raw + '`')();
  assert.equal(cooked.length, raw.length, 'nothing was eaten on the way to the Worker');
  assert.doesNotThrow(() => new Script(cooked), 'the Worker source parses');
});
