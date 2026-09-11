// recomp-portable.test.js -- the two portable shapes (round 70).
//
// The shipping page reads its bytes from a server. A portable build gives it a
// provider instead: `window.isaacPortable`, set before the module runs, which
// answers a window either with a URL (the chunked build, so the reader Worker
// keeps fetching in parallel) or with bytes (the single-file build, which has
// them inline). These pin the seam and the chunk arithmetic -- the parts that
// are quiet when they break, because the page falls back to a fetch that a
// static host answers with 404 and the engine walks off the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
const bootWeb = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
const portable = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'portable.py'), 'utf8');

test('the page takes a provider, and falls back to the server without one', () => {
  assert.match(play, /const portable = \(typeof window !== 'undefined' && window\.isaacPortable\) \|\| null;/);
  // every path that reads bytes asks the provider first
  assert.match(play, /if \(portable\) manifest = portable\.manifest \|\| null;\s*\n\s*else try \{/,
    'the manifest comes from the provider, or from dist.json as before');
  assert.match(play, /if \(portable\) \{\s*\n\s*index = portable\.index \|\| \[\];/, 'so does the instance index');
  assert.match(play, /if \(len\) return \(portable\.urlFor && portable\.urlFor\(rel, off, len\)\) \|\| null;/,
    'a window may be answered with a URL, and a provider that cannot serve it says so');
  assert.match(play, /const bytes = await portable\.bytesFor\(q\.rel, q\.off, q\.len\);/, 'or with bytes');
  assert.match(play, /const bytes = await portable\.bytesFor\('boot\.wasm', 0, 0\);/, 'the module too');
  // and with no provider nothing about the served dist changes
  assert.ok(play.includes("await fetch(rewrite('/boot.wasm'))"), 'the served path still streams the module');
  assert.ok(play.includes('WebAssembly.instantiateStreaming(res, info)'), "round 40's code cache is still used when there is a server");
});

test('a build with no URLs does not start the reader Worker', () => {
  // the Worker overlaps the network with the engine's work; inline, there is no
  // network, and every URL it was given would fail to resolve
  assert.match(play, /hooks\.noReader = !!\(portable && !portable\.urlFor\);/);
  assert.match(bootWeb, /function startReader\(\) \{[\s\S]{0,400}?if \(hooks\.noReader\) return;/);
});

test('a window is a byte range inside a large chunk, and the payload is a dozen files', () => {
  // The first cut gave every 1 MiB window its own chunk, which is correct and
  // useless: 559 files, and a cold start that spent 23 s fetching them one at a
  // time. The chunks are coarse now and a window is a Range inside one, so the
  // chunk's size costs nothing -- but only where the host honours the range.
  assert.match(portable, /p\.add_argument\("--chunks", type=int, default=12,/);
  assert.match(portable, /if \(!ranges\) return null;/, 'no range support, no URL: the bytes path serves it');
  assert.match(portable, /if \(!parts \|\| parts\.length !== 1\) return null;/,
    'a window that straddles two chunks is not a range');
  // Round 89 kept this shape and changed only how a chunk is stored: its
  // windows are compressed one by one, so a window is still one contiguous
  // range, just a shorter one. Part A is still read whole by the page.
  assert.match(portable, /if \(S\[p\.s\]\.gz\) return null;   \/\/ part A is read whole by the page itself/);
  assert.match(portable, /return name\(p\.s, p\.i\) \+ '#r=' \+ p\.within \+ '-' \+ \(p\.within \+ p\.take - 1\)/,
    'the range rides in the fragment, which no server ever sees');
  // windowed archives are padded up to the window so a read never crosses a cut
  assert.match(portable, /def lay_out\(part: list\[dict\], table: dict, stream: int, align: int = 1\) -> int:/);
  assert.match(portable, /b_len = lay_out\(windowed, table, 1, WINDOW\)/, 'part B is laid out on window boundaries');
  // and the host is asked once, before the first window goes out as a range.
  // Round 78: jsDelivr answers 206 with a plausible Content-Range and the wrong
  // bytes (4 bytes early at 1 MiB) plus a total 37 bytes over the file. A probe
  // that only checks "206 and two bytes" passes. The page knows the chunk
  // length, so the probe requires Content-Range's total to match it.
  assert.match(portable, /async function probeRanges\(\) \{/);
  // round 89d: a kilobyte, then a second range overlapping it that must agree --
  // jsDelivr's answers four bytes short passed a probe that asked only once
  assert.match(portable, /Range: 'bytes=0-1023'/);
  assert.match(portable, /Range: 'bytes=512-1535'/);
  // round 84: one question is a coin toss on a host whose answers vary, so the
  // probe asks about four chunks and every one has to come back right
  assert.match(portable, /var n = count\(b\), picks = \[0, Math\.floor\(n \/ 3\), Math\.floor\(\(2 \* n\) \/ 3\), n - 1\]/);
  assert.match(portable, /if \(head\.length !== 1024 \|\| claimed !== want\) \{/);
  assert.match(portable, /ranges = true;/);
  assert.match(portable, /"bytes": b_len/, 'the page carries the raw stream length so the probe has a number to check');
  assert.match(portable, /--part-mib/, 'a 1 MiB cut exists for a host whose ranges cannot be trusted');
});

test('the pieces of a read are fetched in parallel', () => {
  // 49 MB of module in 1 MiB pieces, one at a time, was 23.2 s to the first frame
  assert.match(portable, /for \(var w = 0; w < Math\.min\(6, parts\.length\); w\+\+\) crew\.push\(worker\(\)\);/);
  assert.match(portable, /if \(r\.status === 206 && u\.length === p\.take && \(mine < 0 \|\| told === mine\)\) \{/,
    'the window, when the answer is the window and about the right file');
  assert.match(portable, /ranges = false;/, 'and a host that ignores Range is noticed and not asked again');
});

test('round 83: an answer that is not the window is not treated as the chunk', () => {
  // It used to slice whatever came back and cache it under the chunk's key: right
  // for a host that ignores Range (200, the whole chunk), and for one that answers
  // 206 with the wrong bytes it returned nothing AND left a short buffer behind,
  // so every later window in that chunk came back empty too.
  assert.match(portable, /if \(r\.status === 200 && whole >= 0 && u\.length === whole\) \{/);
  assert.match(portable, /cache\.delete\(p\.s \+ ':' \+ p\.i\);/, 'the bad answer does not stay in the cache');
  assert.match(portable, /return \(await piece\(p\.s, p\.i\)\)\.subarray\(p\.within, p\.within \+ p\.take\);/,
    'and the window comes from the chunk fetched whole');
});

test('round 83: one failed fetch does not end the run', () => {
  // `lazy pread FAILED ... the reader had no bytes` on a window the host answered
  // correctly the moment it was asked again: a blip, and the Worker's answer to
  // any failure was to hand the engine nothing, which returns -1 and traps.
  assert.match(bootWeb, /for \(let a = 0; a < 3; a\+\+\) \{/, 'three tries');
  assert.match(bootWeb, /await new Promise\(\(res\) => setTimeout\(res, 120 \* a \* a\)\);/, 'with a backoff');
  assert.match(bootWeb, /const r = await fetch\(url\);\s*\n\s*if \(!r\.ok\) throw new Error\('whole chunk: HTTP ' \+ r\.status\);/,
    'and then the whole chunk, which needs no Range');
  // async since round 89: a whole-chunk window is gunzipped here before the
  // slice is cut, and DecompressionStream is a stream
  assert.match(bootWeb, /tries\(\)\.then\(async \(buf\) => \{/);
});

test('round 78: a host whose ranges lie does not start the reader Worker', () => {
  // the Worker is what sends Range; once the probe has said no, every window
  // is a whole GET through preadBytes
  assert.match(play, /if \(portable\.ranges && !portable\.ranges\(\)\) \{\s*\n\s*hooks\.noReader = true;/);
});

test('round 78: whole-chunk mode fetches every piece once and keeps them', () => {
  // 6 cached 19 MB pieces with FIFO eviction is the freeze: a new room misses,
  // downloads 19 MB on the engine's read, and drops a piece it will need again.
  assert.match(portable, /async function prefetchAll\(\)/);
  assert.match(portable, /await prefetchAll\(\);/);
  assert.doesNotMatch(portable, /if \(cache\.size > 6\) cache\.delete/,
    'dropping a 19 MB piece is the freeze; keep every chunk');
  assert.match(play, /onChunk = \(got, total\) => \{[\s\S]*?if \(portable && portable\.ready\)/,
    'the status hook is installed before ready waits on the prefetch');
});

test('the provider is keyed by the engine\'s own name for a file', () => {
  // play.mjs strips `instance/` off a pipeline URL before it asks; a plan that
  // kept the prefix missed every lookup and fell through to a 404
  assert.match(play, /rel: inInstance \? rel\.slice\('instance\/'\.length\) : rel,/);
  assert.match(portable, /out\.append\(\{"rel": e\["p"\], "path": p, "size": os\.path\.getsize\(p\),/);
  assert.match(portable, /"dist": "instance\/" \+ e\["p"\], "instance": e\["p"\]\}\)/);
});

test('the single-file build inlines the payload in pieces, not one string', () => {
  // a JavaScript string tops out near 512 MB and the payload is larger, so the
  // chunks are separate literals and decoded on demand
  assert.match(portable, /window\.__isaacPortableData\.blobs = \[\];<\/script>/);
  assert.match(portable, /SCRIPT_BYTES = 48 << 20/, 'one script holds 48 MB of base64: V8 stops compiling near 512 MB, silently');
  assert.match(portable, /if state\["budget"\] >= SCRIPT_BYTES:/, 'the pieces are grouped into scripts by that budget');
  assert.match(portable, /typeof Uint8Array\.fromBase64 === 'function'/, 'the native decoder when the browser has it');
  assert.match(portable, /if \(cache\.size > 24\) cache\.delete\(cache\.keys\(\)\.next\(\)\.value\);/, 'decoded chunks are dropped again');
  // the page's modules import each other by relative path: inline they are blobs,
  // whose imports do not resolve against the page
  assert.ok(portable.includes(String.raw`var text = src[name].replace(/(["'])\.\/([A-Za-z0-9_.-]+\.mjs)\1/g,`),
    'a blob URL resolves no relative import, so each module\'s imports are rewritten to the map first');
});

test('the inline loader builds each module after everything it imports', () => {
  // a blob URL resolves no relative import, so each source is rewritten to import
  // from the map of blobs built so far. A module built before one it imports gets
  // './dep.mjs' left in it, which resolves against nothing and fails at load.
  const web = join(root, 'scripts', 'recomp', 'web');
  const order = /var order = \[([^\]]+)\];/.exec(portable)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  const at = new Map(order.map((n, i) => [n, i]));
  for (const name of order) {
    if (name === 'boot.mjs') continue;                    // the build output, not in this tree
    const src = readFileSync(join(web, name), 'utf8');
    for (const m of src.matchAll(/from '\.\/([A-Za-z0-9_.-]+\.mjs)'/g)) {
      const dep = m[1];
      assert.ok(at.has(dep), `${name} imports ${dep}, which the loader never builds`);
      assert.ok(at.get(dep) < at.get(name), `${name} is built before ${dep}, which it imports`);
    }
  }
  // and the list the payload carries is the list the loader builds
  const modules = /MODULES = \(([^)]+)\)/.exec(portable)[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  assert.deepEqual(new Set(modules), new Set(order), 'every inlined module is built, and nothing else is');
});

// ---- round 77: the payload stops announcing what it is -----------------------
const python = ['python3', 'python'].find((p) => {
  try { return spawnSync(p, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' }).stdout.trim() === '3'; }
  catch { return false; }
});
const runPy = (code) => {
  const r = spawnSync(python, ['-c', code], { encoding: 'utf8', cwd: root });
  if (r.status !== 0) throw new Error(r.stderr || 'python failed');
  return r.stdout.trim();
};

test('round 77: the keystream is reversible from any offset', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  // a window is fetched as a byte range and put back where it lands, so the
  // stream has to be seekable: unscrambling bytes [k, k+n) needs only k
  const out = runPy([
    'import sys; sys.path.insert(0, "scripts/recomp/assets"); import portable as P',
    'key = P.keystream_key(b"pin")',
    'data = bytes((i * 37 + 11) & 0xff for i in range(5000))',
    'whole = P.scramble(data, 0, key)',
    'print(whole != data)',
    // any slice unscrambles on its own, from its own offset
    'print(all(P.scramble(whole[a:b], a, key) == data[a:b] for a, b in ((0, 100), (256, 300), (999, 4096), (4096, 5000))))',
    // and the key changes the bytes
    'print(P.scramble(data, 0, P.keystream_key(b"other")) != whole)',
    // no key, no change
    'print(P.scramble(data, 0, b"") == data)',
  ].join('\n'));
  assert.deepEqual(out.split(/\r?\n/), ['True', 'True', 'True', 'True']);
});

test('round 77: the minifier walks the source rather than pattern-matching it', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  // the three things a regex-based stripper gets wrong: `//` inside a string, a
  // regular expression that looks like division, and a template literal that may
  // contain any of it
  const out = runPy([
    'import sys, json; sys.path.insert(0, "scripts/recomp/assets"); import portable as P',
    'src = open("scripts/recomp/web/zip.mjs", encoding="utf-8").read()',
    'm = P.minify_js(src)',
    'print(len(m) < len(src))',
    'print("//" not in m.split("export")[0])',
    'cases = ["const u = \'https://x/y\';", "const r = /a\\\\/b/g;", "const t = `a ${x} // b`;", "const d = a / b; // gone"]',
    'print(json.dumps([P.minify_js(c) for c in cases]))',
  ].join('\n')).split(/\r?\n/);
  assert.equal(out[0], 'True', 'it does shrink the source');
  assert.equal(out[1], 'True', 'and the comments are gone');
  const kept = JSON.parse(out[2]);
  assert.ok(kept[0].includes("'https://x/y'"), 'a URL inside a string is not a comment');
  assert.ok(kept[1].includes('/a\\/b/g'), 'a regular expression survives');
  assert.ok(kept[2].includes('`a ${x} // b`'), 'a template literal is passed through whole');
  assert.ok(kept[3].includes('a/b') && !kept[3].includes('gone'), 'division is division, and the comment goes');
});

test('round 77: both sides of the seam agree what the keystream is called', () => {
  // the job messages already carry `key` -- the cache key of the window wanted --
  // so a handler that greeted every one of those as a new keystream answered no
  // reads at all, and the game stopped at its first frame
  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.ok(b.includes('if (d.xorKey) { xorKey = new Uint8Array(d.xorKey); return; }'), 'the Worker takes it under its own name');
  assert.ok(b.includes("w.postMessage({ xorKey: hooks.chunkKey });"), 'and the page sends it under that name');
  assert.ok(!/if \(d\.key\)/.test(b), 'nothing keys off the field a job already uses');
  assert.match(portable, /if \(!xorKey \|\| pos < 0\) return buf;|if \(!KEY\) return bytes;/);
  // the position rides beside the range, because that is what unscrambles it
  assert.match(portable, /\+ '@' \+ \(p\.i \* S\[p\.s\]\.size \+ p\.within\)/);
  assert.ok(b.includes("let frag = url.slice(h + 3);") && b.includes("const cut = frag.indexOf('@');"), 'the Worker reads it back');
  // round 84: and the chunk's own length after it, which is the only thing a
  // Content-Range total can be checked against
  assert.match(portable, /\+ '!' \+ chunkLen\(p\.s, p\.i\)/);
  assert.ok(b.includes("const bang = frag.indexOf('!');"));
});

test('round 77: the loading screen says which chunk it is on', () => {
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(play.includes('window.__isaacPortableData.onChunk = (got, total) => {'), 'the page listens');
  // round 89d: it counts what the first frame is waiting for, not every chunk,
  // and goes quiet once that wait is over
  assert.match(portable, /if \(quiet \|\| !P\.onChunk\) return;/, 'the provider counts until the wait is over');
  assert.match(portable, /P\.onChunk\(Math\.min\(loadedN, tot\), tot\);/, 'never past its own total');
  assert.match(portable, /"chunks": n_a \+ n_b,/, 'and the page is told how many there are');
});

test('round 90f: the cache evicts what has been read, not the boot\'s next chunk', () => {
  // The prefetch inserts the boot's chunks in trail order and a read moves its
  // chunk to the young end, so the OLDEST entries are the ones the boot has not
  // reached. Oldest-first eviction took exactly those: on the CDN the title came
  // 232 s after the first frame. Run the provider's own cache code to show it.
  const js = portable.slice(portable.indexOf('PROVIDER_JS = r"""'));
  const cut = (from, to) => {
    const a = js.indexOf(from), b = js.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `provider section ${from.trim()}`);
    return js.slice(a, b);
  };
  const src = 'var cache = new Map();\n'
    + cut('  var CACHE_STEADY', '  // round 77: the chunks are XORed')
    + cut('  var unread = Object.create(null)', '  // resolves when there is room to fetch another')
    + 'return { cache, trim, remember, touch, wasRead, evicted, headLeft, max: (n) => { CACHE_MAX = n; }, bootOver: BOOT_OVER_FRAME };';
  const C = new Function('window', src)({ isaacFrame: 0 });
  C.max(1000);                                          // the boot's budget: the whole head
  for (const k of ['0:0', '0:1', '1:0', '1:1', '1:2', '1:3']) C.remember(k, new Uint8Array(10));
  for (const k of ['0:0', '0:1', '1:0']) { C.touch(k); C.wasRead(k); }
  C.max(35); C.trim();                                  // room for three
  assert.deepEqual([...C.cache.keys()].sort(), ['1:1', '1:2', '1:3'],
    'the three the boot has not read survive; the three it has are the ones evicted');
  // round 90g: and it says what it dropped and why -- the instrument that
  // closed 90g's two hypotheses (recomp-architecture §21.115)
  assert.deepEqual(C.evicted.map((e) => e.replace(/ @\d+$/, '')), ['0:0 read', '0:1 read', '1:0 read']);
  // the boot's budget is its head, uncapped: summing stored sizes undercounted
  // part A (stored gzipped) and evicted it during the prefetch itself
  assert.match(portable, /CACHE_MAX = Infinity;/);
  assert.doesNotMatch(portable, /CACHE_MAX = want \+ S\[head\[0\]\[0\]\]\.size/);
  // a prefetch is not a read, or the head's own fetches would look finished
  assert.match(portable, /piece\(jobs\[k\]\[0\], jobs\[k\]\[1\], paced \? 2 : 1\)/);
  assert.match(portable, /if \(pre === 2\) markUnread\(key\);/, 'and only the paced stream counts toward its pacing');
  // the budget drops, and the leftovers start, when the boot is over -- the
  // frame boot_web.mjs itself calls the end of the boot, not the first one
  assert.equal(C.bootOver, Number(/READER_CLEAR_FRAME = (\d+)/.exec(bootWeb)[1]));
  assert.match(portable, /if \(\(window\.isaacFrame \|\| 0\) >= BOOT_OVER_FRAME \|\| Date\.now\(\) - t0 > 300000\) \{/);
  // and it happens whether or not anything is left to stream: under `if (more)`
  // a trail that touched every chunk would have kept the boot uncapped for good
  assert.doesNotMatch(portable, /var more = await prefetchAll\(\);\s*\n\s*if \(more\) \{/);
  assert.match(portable, /var later = function \(\) \{ if \(more\) more\(\); \};/);
});

test('round 90f: a chunked page is never built without its boot trail', () => {
  // Rounds 90 to 90e shipped a dist built without ship.py --trail. The page then
  // prefetched the whole payload before its first frame, through a cache sized
  // for the steady state, and nothing in either build said so.
  const ship = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'ship.py'), 'utf8');
  assert.match(ship, /"trail": os\.path\.join\(ROOT, "scripts", "recomp", "assets", TRAIL_NAME\),/,
    'ship.py ships the recorded trail by default');
  assert.match(ship, /p\.add_argument\("--trail", default=DEFAULTS\["trail"\]/);
  assert.match(ship, /no boot trail at %s/, 'and a missing trail file is an error, not a skip');
  assert.match(portable, /if not has_trail and not args\.no_trail:\s*\n\s*raise SystemExit/,
    'portable.py refuses a chunked build whose dist has no trail');
  assert.doesNotMatch(portable, /-- the modules and the boot trail are in it, nothing else is needed"\s*\n\s*% \(/,
    'and its summary only claims a trail when the page has one');
  // the recorded trail is in the tree, parses, and names only windowed archives
  const trail = JSON.parse(readFileSync(join(root, 'scripts', 'recomp', 'assets', 'boot-trail.json'), 'utf8'));
  assert.ok(Array.isArray(trail) && trail.length > 100, `a real trail (${trail.length} reads)`);
  const windowed = new Set([.../"(resources\/packed\/[a-z]+\.a)"/g[Symbol.matchAll](/WINDOWED = \(([^)]*)\)/.exec(portable)[1])].map((m) => m[1]));
  assert.equal(windowed.size, 4, 'the four windowed archives');
  for (const [f, off, len] of trail) {
    assert.ok(windowed.has(f), `${f}: a windowed archive`);
    assert.ok(Number.isInteger(off) && off >= 0 && Number.isInteger(len) && len > 0, `${f}@${off}: offset and length`);
    assert.ok((off % 1048576) + len <= 1048576, `${f}@${off}+${len}: a read inside one window`);
  }
});

test('round 90f: part B can be served from its own pinned base', () => {
  // one base pinned per deploy moved all 32 URLs every time, and a returning
  // visitor re-fetched 512 MB of unchanged part B
  assert.match(portable, /return \(S\[s\]\.base \|\| P\.base\) \+ '\/' \+ S\[s\]\.tag \+ i \+ '\.bin'/);
  assert.match(portable, /streams\[1\]\["base"\] = args\.base_b\.rstrip\("\/"\)/);
  assert.match(portable, /p\.add_argument\("--base-b"/);
  const check = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'check_deployed.mjs'), 'utf8');
  assert.match(check, /baseOf\[`\$\{s\.tag\}\$\{i\}`\] = s\.base \|\| `\$\{CDN\}\/c`;/, 'check_deployed reads each stream where the page does');
  assert.match(check, /await fetch\(`\$\{baseOf\[n\]\}\/\$\{n\}\.bin`/);
});

test('round 77: every page module parses, before and after minifying', async (t) => {
  // A backtick in a comment inside the reader Worker -- which is one big template
  // literal -- ended that template early, and the pipeline module stopped parsing
  // at all. The page failed with "Unexpected identifier" and no first frame, and
  // nothing in the suite noticed, because nothing was reading the file as code.
  // `node --check` parses a file without running it, and needs no flag the
  // family does not already pass
  const parses = (file) => spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const names = ['boot.mjs', 'boot_web.mjs', 'play.mjs', 'mods.mjs', 'zip.mjs', 'menu_overlay.mjs'];
  const web = join(root, 'scripts', 'recomp', 'web');
  for (const name of names) {
    const file = join(web, name);
    if (name === 'boot.mjs') continue;                 // the build's output, not in this tree
    const src = readFileSync(file, 'utf8');
    const first = parses(file);
    assert.equal(first.status, 0, `${name} parses: ${first.stderr}`);
    if (!python) continue;
    // through a file rather than stdout: the sources are UTF-8 and a pipe on
    // Windows is not, and a mangled byte would look like a minifier bug
    const tmp = join(tmpdir(), `isaac-min-${name}`);
    runPy([
      'import io, sys; sys.path.insert(0, "scripts/recomp/assets"); import portable as P',
      `src = io.open("scripts/recomp/web/${name}", encoding="utf-8").read()`,
      `io.open(${JSON.stringify(tmp.replace(/\\/g, '/'))}, "w", encoding="utf-8", newline="").write(P.minify_js(src))`,
    ].join('\n'));
    const min = readFileSync(tmp, 'utf8');
    assert.ok(min.length < src.length, `${name} does shrink`);
    const after = parses(tmp);
    assert.equal(after.status, 0, `${name} still parses minified: ${after.stderr}`);
  }
});

test('round 78: a portable build carries the menus own art', () => {
  // ship.py keeps page-assets out of instance_index.json (the pipeline must not
  // seed the page's files into the guest FS), and plan() walks that index -- so
  // the payload had no menu.json, no font, no cursor. readAsset returned null,
  // menuAssets.load() threw, and IMPORT MOD did nothing at all. Silently.
  assert.match(portable, /assets = os\.path\.join\(dist, "instance", "page-assets"\)/);
  assert.match(portable, /rel = "page-assets\/" \+ name/, 'keyed the way readAsset asks');
  const play = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  const asks = [...play.matchAll(/portable\.bytesFor\(`page-assets\/\$\{name\}`/g)].length;
  assert.ok(asks >= 2, 'both menus read their art through the provider');
});

test('round 80: a rebuild can keep the key the uploaded chunks were scrambled with', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  // The default seed is the two stream lengths, so adding one file to part A
  // re-scrambles part B too: half a gigabyte of chunks that differ only in their
  // keystream, all of which would have to be uploaded again.
  assert.match(portable, /--key-b64/);
  assert.match(portable, /--key-of/);
  const out = runPy([
    'import base64, sys; sys.path.insert(0, "scripts/recomp/assets"); import portable as P',
    'k = P.keystream_key(b"pin")',
    'b64 = base64.b64encode(k).decode("ascii")',
    // what the CLI does with --key-b64, and that it round trips
    'print(base64.b64decode(b64) == k)',
    'print(len(k) == 256)',
    // and --key-of finds it in a page built with that key
    'page = "<script>window.__isaacPortableData = " + __import__("json").dumps({"key": b64, "chunks": 33}) + ";</script>"',
    'import re',
    'm = re.search(r"window\\.__isaacPortableData\\s*=\\s*(\\{.*?\\});", page, re.S)',
    'print(__import__("json").loads(m.group(1))["key"] == b64)',
  ].join('\n'));
  assert.deepEqual(out.split(/\r?\n/), ['True', 'True', 'True']);
});

test('round 84: the single-file build fetches nothing, because it has everything', () => {
  // Round 78 made `ready` prefetch every chunk, for a host whose ranges lie. It
  // was not gated on there being a host: the single-file build has its payload
  // inline and no base, so it asked the page for `null/a0.bin` -- eight of those,
  // no frames, a build that did not run. Every offline build from 820f7d2 to
  // round 84 was broken this way, and nothing was driving it to notice.
  assert.match(portable, /if \(!P\.base\) return ranges;/);
  const ready = portable.slice(portable.indexOf('ready: (async function'), portable.indexOf('ranges: function'));
  assert.ok(ready.indexOf('if (!P.base) return ranges;') < ready.indexOf('await probeRanges();'),
    'and it returns before either of the things that fetch');
  assert.ok(ready.indexOf('if (!P.base) return ranges;') < ready.indexOf('await prefetchAll();'));
});

test('round 86d: a chunk carries a token from its own bytes into its URL', () => {
  // jsDelivr answers chunks with max-age=604800, so a returning visitor holds
  // them for a week. With one stable URL per chunk, a rebuild that changes only
  // part A leaves that visitor free to mix new chunks with cached old ones --
  // by cache, by a revalidated Range, or by a fetch that straddled a purge --
  // and a mixed module is not a module:
  //   WebAssembly.instantiate(): size 8760567 > maximum function size 7654321
  // The token is per CHUNK rather than per build on purpose: a chunk whose
  // bytes did not change keeps its URL and stays cached, so a module-only
  // rebuild re-fetches four chunks instead of all thirty-three.
  const p = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'portable.py'), 'utf8');
  assert.match(p, /def chunk_tokens\(tag, count\)/, 'the tokens are computed per chunk');
  assert.match(p, /h\.hexdigest\(\)\[:8\]/, 'and they come from that chunk\'s own bytes');
  assert.match(p, /"v": chunk_tokens\("a", n_a\)/, 'part A carries them');
  assert.match(p, /"v": chunk_tokens\("b", n_b\)/, 'and so does part B');
  // the query has to sit before the #r= fragment the reader Worker strips off
  assert.match(p, /\.bin' \+ \(v \? '\?v=' \+ v : ''\)/, 'the URL carries the token');
  assert.match(p, /var v = S\[s\]\.v && S\[s\]\.v\[i\];/, 'read out of the stream the chunk belongs to');
});

test('round 88: the whole-read chunks may be zopfli, and it stays gzip', () => {
  // Part A is gzipped before it is scrambled, so its wire form is ours. Zopfli
  // is the same gzip format -- the page still calls DecompressionStream('gzip')
  // -- for about 0.55 MB across part A and six more minutes of build, which is
  // why it is a flag. It must never become the default silently.
  const p = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'portable.py'), 'utf8');
  assert.match(p, /if not args\.zopfli:\s*\n\s*return gzip\.compress\(b, 9, mtime=0\)/,
    'gzip -9 stays the default');
  assert.match(p, /import zopfli\.gzip/, 'and zopfli is imported only when asked for');
  assert.match(p, /--zopfli needs the zopfli package/, 'with a clear word when it is missing');
  assert.match(p, /"--zopfli", action="store_true"/, 'it is opt-in');
});

test('round 89: a chunk stores its windows compressed one by one', () => {
  // The chunk keeps its size, its window count and the bytes it rebuilds to;
  // only the way it is stored changes, so the file count does not move -- 32
  // chunks, not 525. A window is still one contiguous range, just shorter.
  const p = readFileSync(join(root, 'scripts', 'recomp', 'assets', 'portable.py'), 'utf8');
  assert.match(p, /class WindowPacker:/, 'the packer that compresses each window on its own');
  assert.match(p, /use = len\(packed\) <= len\(window\) - \(len\(window\) >> 6\)/,
    'a window is only stored compressed when it saves at least 1.6%');
  assert.match(p, /streams\[1\]\["wl"\] = packer\.lens/, 'the page gets every window length');
  assert.match(p, /streams\[1\]\["wz"\] = ""\.join\(packer\.flags\)/,
    'and which are really compressed -- Theora and Vorbis give nothing back');
  assert.match(p, /function inWindow\(p\)/, 'the page maps a read to its window');
  assert.match(p, /async function rebuild\(s, i, stored\)/,
    'and rebuilds a whole chunk where ranges are not to be trusted');

  const b = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  assert.match(b, /const g = url\.indexOf\('#w='\);/, 'the Worker knows the window fragment');
  assert.match(b, /if \(winPacked\) \{/, 'and only inflates a window that really is compressed');
});