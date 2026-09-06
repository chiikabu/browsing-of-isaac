// Round 34: the shipping page and the hostable dist.
//
// ship.py assembles a folder somebody can host (the page, the fast web module,
// the memory image, the bundle under instance/, the index the page registers,
// precompressed siblings, a manifest) and prints a size table; serve_dist.mjs
// serves it with the contract the page depends on (byte slices, base64 text,
// content negotiation, Range, immutable caching by hash); play.html/play.mjs
// wrap the unchanged pipeline (boot_web.mjs) in a loading screen, a Play
// button and a saves menu. These pins hold all three on a synthetic tree (no
// game bytes near a test) and on the source of the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, unlinkSync, truncateSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ship = join(root, 'scripts', 'recomp', 'assets', 'ship.py');
const bundleTool = join(root, 'scripts', 'recomp', 'assets', 'bundle.py');
const serve = join(root, 'scripts', 'recomp', 'web', 'serve_dist.mjs');
const web = join(root, 'scripts', 'recomp', 'web');
const rd = (...p) => readFileSync(join(root, ...p), 'utf8');

const PYTHONS = [
  join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
  'python3',
  'python',
];
function findPython() {
  for (const p of PYTHONS) {
    if (!p) continue;
    const r = spawnSync(p, ['-c', 'import json, hashlib, gzip, zlib'], { stdio: 'pipe' });
    if (r.status === 0) return p;
  }
  return null;
}
const python = findPython();
function run(tool, args, opts = {}) {
  return spawnSync(python, [tool, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 180000, ...opts });
}
function ok(tool, args, opts) {
  const r = run(tool, args, opts);
  assert.equal(r.status, 0, `${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) & 0xff; }; }
function noise(n, seed) { const g = lcg(seed); const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = g(); return b; }
// text that compresses (a 4 KB pattern of numbered words, repeated)
function prose(n, seed) {
  const g = lcg(seed);
  let pat = '';
  while (pat.length < 4096) pat += `word${g()} sub_${(g() << 8 | g()).toString(16)} = call(${g()}, ${g()});\n`;
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += pat.length) b.write(pat.slice(0, Math.min(pat.length, n - i)), i, 'latin1');
  return b;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const walk = (d, rel = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory()
  ? walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]);

// --- the synthetic tree ---------------------------------------------------------
// instance names follow the bundle's rule set (the bundle tool builds a real
// manifest over them); sizes are chosen for the compression rules: sfx.a is
// 2 MB of prose (a sibling under instance/), afterbirthp.a 3.5 MB of prose but
// windowed by --window-min (no sibling), graphics.a 1.2 MB of noise (probed,
// does not compress), the rest small. The module is 6 MB of prose (a row above
// 5 MB, siblings), the image 1.5 MB of noise (no sibling).
const MOUNTED = ['animations', 'config', 'fonts', 'graphics', 'music', 'rooms', 'sfx', 'videos', 'afterbirth', 'afterbirthp'];
const WINDOW_MIN = 3000000;
function makeInstance(dir) {
  const files = {};
  const put = (rel, b) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), b); files[rel] = b; };
  let seed = 7;
  for (const n of MOUNTED) {
    const rel = `resources/packed/${n}.a`;
    if (n === 'sfx') put(rel, prose(2000000, seed++));
    else if (n === 'afterbirthp') put(rel, prose(3500000, seed++));
    else if (n === 'graphics') put(rel, noise(1200000, seed++));
    else put(rel, noise(300 + seed * 11, seed++));
  }
  put('resources/scripts/main.lua', prose(700, seed++));
  put('resources/scripts/enums.lua', prose(900, seed++));
  put('resources/scripts/bom.lua', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), prose(200, seed++)]));
  put('resources/scripts/socket/url.lua', prose(120, seed++));
  put('resources/scripts/licenses', prose(90, seed++));
  put('savedatapath.txt', Buffer.from('Documents/My Games/Binding of Isaac Repentance+\n'));
  return files;
}
function makeModule(dir) {
  mkdirSync(dir, { recursive: true });
  const files = { 'boot.mjs': Buffer.from('export default function Module(cfg) { return Promise.resolve(cfg); }\n'), 'boot.wasm': prose(6291456, 99) };
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
  writeFileSync(join(dir, 'build_boot.json'), JSON.stringify({ emccVersion: 'emcc test', wasmBytes: files['boot.wasm'].length, mjsBytes: files['boot.mjs'].length, link_s: 1.5, ok: true }));
  return files;
}
function makeTree(dir) {
  const inst = join(dir, 'instance'), bundle = join(dir, 'bundle'), mod = join(dir, 'module'), segs = join(dir, 'isaac.segs.bin');
  const instFiles = makeInstance(inst);
  ok(bundleTool, ['build', inst, bundle, '--copy', '--strict']);
  const modFiles = makeModule(mod);
  const segsBytes = noise(1500000, 1234);
  writeFileSync(segs, segsBytes);
  return { inst, bundle, mod, segs, instFiles, modFiles, segsBytes };
}
const buildArgs = (t, dist, extra = []) => ['build', '--bundle', t.bundle, '--module', t.mod, '--segs', t.segs, '--dist', dist,
  '--window-min', String(WINDOW_MIN), '--brotli-quality', '5', '--gzip-level', '6', ...extra];

function parseTable(text) {
  const rows = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+([\d,]+)\s+([\d,]+|-)\s+([\d,]+|-)\s+([\d,]+)\s+(.*)$/);
    if (m) {
      const num = (s) => (s === '-' ? null : Number(s.replace(/,/g, '')));
      rows[m[1]] = { raw: num(m[2]), gzip: num(m[3]), brotli: num(m[4]), transfer: num(m[5]), note: m[6].trim() };
    }
  }
  const small = text.match(/^\((\d+) files of 5 MB or less\)\s+([\d,]+)\s+-\s+-\s+([\d,]+)/m);
  const dist = text.match(/^dist: (\d+) files, ([\d,]+) bytes raw; (\d+) precompressed sibling\(s\), ([\d,]+) bytes; ([\d,]+) bytes on disk$/m);
  const transfer = text.match(/^transfer with the best encoding: ([\d,]+) bytes = ([\d.]+)% of raw$/m);
  const n = (s) => Number(s.replace(/,/g, ''));
  return {
    rows,
    small: small ? { files: Number(small[1]), raw: n(small[2]), transfer: n(small[3]) } : null,
    dist: dist ? { files: Number(dist[1]), raw: n(dist[2]), siblings: Number(dist[3]), siblingBytes: n(dist[4]), onDisk: n(dist[5]) } : null,
    transfer: transfer ? { bytes: n(transfer[1]), pct: transfer[2] } : null,
  };
}

test('ship.py build: the dist tree, the index shape, the siblings, the manifest and the size table arithmetic', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-ship-'));
  try {
    const tree = makeTree(dir);
    const dist = join(dir, 'dist');
    const text = ok(ship, buildArgs(tree, dist));
    const hasBr = !/brotli: the python module is not importable/.test(text);
    // the tree: the page, the module, the image, the bundle under instance/, the index, the manifest, the siblings
    const got = walk(dist).sort();
    const bundleFiles = walk(tree.bundle).map((p) => `instance/${p}`);
    const expected = ['play.html', 'play.mjs', 'boot_web.mjs', 'menu_overlay.mjs', 'zip.mjs', 'mods.mjs', 'boot.mjs', 'boot.wasm', 'isaac.segs.bin', 'instance_index.json', 'dist.json', ...bundleFiles,
      'boot.wasm.gz', 'instance/resources/packed/sfx.a.gz', ...(hasBr ? ['boot.wasm.br', 'instance/resources/packed/sfx.a.br'] : [])].sort();
    assert.deepEqual(got, expected);
    for (const f of ['play.html', 'play.mjs', 'boot_web.mjs', 'menu_overlay.mjs', 'zip.mjs', 'mods.mjs']) assert.ok(readFileSync(join(dist, f)).equals(readFileSync(join(web, f))), `${f} is the page's file`);
    assert.ok(readFileSync(join(dist, 'boot.wasm')).equals(tree.modFiles['boot.wasm']), 'the module is copied');
    assert.ok(readFileSync(join(dist, 'isaac.segs.bin')).equals(tree.segsBytes), 'the image is copied');
    assert.ok(readFileSync(join(dist, 'instance', '.bundle.json')).equals(readFileSync(join(tree.bundle, '.bundle.json'))), 'the bundle manifest travels along');
    // the index: the shape boot_web.mjs consumes -- an array of {p, s}, the bundle's non-dot files with their sizes, sorted
    const index = JSON.parse(readFileSync(join(dist, 'instance_index.json'), 'utf8'));
    assert.ok(Array.isArray(index) && index.every((e) => Object.keys(e).sort().join() === 'p,s' && typeof e.p === 'string' && Number.isInteger(e.s)), 'array of {p, s}');
    assert.deepEqual(index.map((e) => e.p), Object.keys(tree.instFiles).sort(), 'every bundle file, no dot file, no sibling');
    for (const e of index) assert.equal(e.s, tree.instFiles[e.p].length, `${e.p} size`);
    assert.ok(index.some((e) => e.p === 'resources/packed/afterbirthp.a'), 'resources/packed is in (only the top-level packed/ is skipped)');
    // the siblings decode to their source; the windowed and the incompressible have none
    assert.ok(gunzipSync(readFileSync(join(dist, 'boot.wasm.gz'))).equals(tree.modFiles['boot.wasm']), 'boot.wasm.gz');
    if (hasBr) assert.ok(brotliDecompressSync(readFileSync(join(dist, 'boot.wasm.br'))).equals(tree.modFiles['boot.wasm']), 'boot.wasm.br');
    assert.ok(gunzipSync(readFileSync(join(dist, 'instance/resources/packed/sfx.a.gz'))).equals(tree.instFiles['resources/packed/sfx.a']), 'sfx.a.gz');
    assert.match(text, /afterbirthp\.a: windowed \(3,500,000 bytes >= 3,000,000\): served as byte slices, no sibling/);
    assert.match(text, /graphics\.a: does not compress \(sampled ratio [\d.]+\), no sibling/);
    assert.match(text, /isaac\.segs\.bin: does not compress/);
    assert.match(text, /boot\.wasm: 6,291,456 bytes -> (br [\d,]+, )?gz [\d,]+/);
    // the manifest
    const man = JSON.parse(readFileSync(join(dist, 'dist.json'), 'utf8'));
    assert.equal(man.format, 'isaac-recomp-dist/1');
    assert.equal(man.page, 'play.html');
    assert.equal(man.window_min, WINDOW_MIN);
    assert.equal(man.sources.bundle.totals.files, Object.keys(tree.instFiles).length);
    assert.equal(man.sources.module.build.emccVersion, 'emcc test');
    const byPath = Object.fromEntries(man.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), got.filter((p) => p !== 'dist.json' && !/\.(br|gz)$/.test(p)).sort(), 'every file but the manifest and the siblings is listed');
    for (const f of man.files) {
      const b = readFileSync(join(dist, f.path));
      assert.equal(f.size, b.length, `${f.path} size`);
      assert.equal(f.sha256, sha256(b), `${f.path} sha256`);
      for (const [enc, size] of Object.entries(f.encodings || {})) assert.equal(size, statSync(join(dist, `${f.path}.${enc}`)).size, `${f.path}.${enc} size`);
    }
    assert.equal(byPath['boot.wasm'].kind, 'module');
    assert.equal(byPath['instance/resources/packed/sfx.a'].kind, 'instance');
    assert.equal(byPath['instance/resources/packed/afterbirthp.a'].windowed, true);
    assert.deepEqual(byPath['instance/resources/packed/afterbirthp.a'].encodings, {});
    assert.deepEqual(byPath['isaac.segs.bin'].encodings, {});
    assert.equal(byPath['isaac.segs.bin'].probed, true);
    assert.deepEqual(Object.keys(byPath['boot.wasm'].encodings).sort(), hasBr ? ['br', 'gz'] : ['gz']);
    // the size table adds up
    const raw = man.files.reduce((s, f) => s + f.size, 0);
    const best = (f) => Math.min(f.size, ...Object.values(f.encodings || {}));
    const transfer = man.files.reduce((s, f) => s + best(f), 0);
    const sibBytes = man.files.reduce((s, f) => s + Object.values(f.encodings || {}).reduce((a, b) => a + b, 0), 0);
    const sibFiles = man.files.reduce((s, f) => s + Object.keys(f.encodings || {}).length, 0);
    assert.deepEqual(man.totals, { files: man.files.length, bytes: raw, transfer, siblings: { files: sibFiles, bytes: sibBytes }, on_disk: raw + sibBytes });
    const tab = parseTable(text);
    assert.deepEqual(tab.rows['boot.wasm'], { raw: 6291456, gzip: byPath['boot.wasm'].encodings.gz, brotli: hasBr ? byPath['boot.wasm'].encodings.br : null,
      transfer: best(byPath['boot.wasm']), note: hasBr ? 'br' : 'gz' }, 'the row of the one file above 5 MB');
    assert.equal(Object.keys(tab.rows).length, 1, 'only files above 5 MB get a row');
    const small = man.files.filter((f) => f.size <= 5000000);
    assert.deepEqual(tab.small, { files: small.length, raw: small.reduce((s, f) => s + f.size, 0), transfer: small.reduce((s, f) => s + best(f), 0) });
    assert.deepEqual(tab.dist, { files: man.files.length, raw, siblings: sibFiles, siblingBytes: sibBytes, onDisk: raw + sibBytes });
    assert.deepEqual(tab.transfer, { bytes: transfer, pct: (100 * transfer / raw).toFixed(2) });
    assert.equal(tab.rows['boot.wasm'].raw + tab.small.raw, tab.dist.raw, 'rows + the small group = the raw total');
    assert.equal(tab.rows['boot.wasm'].transfer + tab.small.transfer, tab.transfer.bytes, 'rows + the small group = the transfer total');
    // a second build reuses the siblings and refreshes the copies; --no-compress makes none
    const again = ok(ship, buildArgs(tree, dist));
    assert.match(again, /boot\.wasm: siblings reused \(unchanged since the last build\)/);
    assert.deepEqual(walk(dist).sort(), expected, 'the tree is the same after a rebuild');
    ok(ship, buildArgs(tree, join(dir, 'plain'), ['--no-compress', '--copy']));
    assert.ok(!walk(join(dir, 'plain')).some((p) => /\.(br|gz)$/.test(p)), '--no-compress: no siblings');
    assert.equal(JSON.parse(readFileSync(join(dir, 'plain', 'dist.json'), 'utf8')).linked, 0, '--copy: nothing hard-linked');
    // check passes on both
    assert.match(ok(ship, ['check', dist]), /dist check OK: \d+ files, [\d,]+ bytes raw, [\d,]+ bytes transfer with the best encoding, every sha256 matches, every sibling decodes to its source/);
    assert.match(ok(ship, ['check', dist, '--quick']), /\(sizes only\)/);
    assert.match(ok(ship, ['table', dist]), /transfer with the best encoding/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ship.py check names each way a dist can be broken', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-ship-'));
  try {
    const tree = makeTree(dir);
    const dist = join(dir, 'dist');
    ok(ship, buildArgs(tree, dist, ['--copy']));
    const fails = (re, what) => { const r = run(ship, ['check', dist]); assert.equal(r.status, 1, `${what}: check fails`); assert.match(r.stdout, re, what); };
    // 1. a byte flipped in the module: the hash
    const wasm = join(dist, 'boot.wasm'), pristine = readFileSync(wasm);
    const flipped = Buffer.from(pristine); flipped[100] ^= 0xff; writeFileSync(wasm, flipped);
    fails(/hash: boot\.wasm does not match its manifest sha256/, 'flipped byte');
    assert.equal(run(ship, ['check', dist, '--quick']).status, 0, 'a size-only check passes the flipped byte');
    writeFileSync(wasm, pristine);
    // 2. a sibling missing
    const gz = join(dist, 'boot.wasm.gz'), gzBytes = readFileSync(gz);
    unlinkSync(gz);
    fails(/missing sibling: boot\.wasm\.gz/, 'missing sibling');
    writeFileSync(gz, gzBytes);
    // 3. a sibling that does not decode to its source (truncated: the size disagrees; padded: the decode disagrees)
    truncateSync(gz, gzBytes.length - 10);
    fails(/size: sibling boot\.wasm\.gz is \d+ bytes, manifest says \d+/, 'truncated sibling');
    writeFileSync(gz, Buffer.concat([gunzipSync(gzBytes).length ? gzBytes.subarray(0, gzBytes.length - 8) : gzBytes, Buffer.alloc(8)]));
    fails(/sibling: boot\.wasm\.gz does not decode/, 'corrupted sibling');
    writeFileSync(gz, gzBytes);
    // 4. an extra file
    writeFileSync(join(dist, 'instance', 'extra.bin'), 'x');
    fails(/extra: instance\/extra\.bin is not in the manifest/, 'extra file');
    unlinkSync(join(dist, 'instance', 'extra.bin'));
    // 5. the index out of step with instance/
    const ip = join(dist, 'instance_index.json'), idx = readFileSync(ip, 'utf8');
    const edited = JSON.parse(idx); edited[0].s += 1; writeFileSync(ip, JSON.stringify(edited));
    let r = run(ship, ['check', dist]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /index: .* is in instance_index\.json but not under instance\/ with that size/);
    assert.match(r.stdout, /hash: instance_index\.json does not match/);
    writeFileSync(ip, idx);
    // 6. the page missing
    const page = join(dist, 'play.html'), pageBytes = readFileSync(page);
    unlinkSync(page);
    fails(/missing: play\.html/, 'missing page');
    writeFileSync(page, pageBytes);
    // 7. the manifest's totals
    const mp = join(dist, 'dist.json'), man = JSON.parse(readFileSync(mp, 'utf8'));
    man.totals.transfer += 1; writeFileSync(mp, JSON.stringify(man));
    fails(/totals: the manifest's totals do not add up to its file list/, 'totals');
    // 8. no manifest
    r = run(ship, ['check', tree.bundle]);
    assert.equal(r.status, 1); assert.match(r.stdout, /no dist\.json/);
    // 9. a bundle that fails its own check is refused as an input
    writeFileSync(join(tree.bundle, 'resources', 'packed', 'stray.a'), 'x');
    r = run(ship, buildArgs(tree, join(dir, 'dist2')));
    assert.equal(r.status, 1); assert.match(r.stdout, /does not pass bundle\.py check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the server ------------------------------------------------------------------
function startServer(dist, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serve, dist, 'port=0', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/serve_dist: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (m) resolve({ child, origin: m[1], output: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`serve_dist exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`serve_dist did not start: ${out}`)), 15000).unref();
  });
}
function get(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serve_dist.mjs: types, slices, base64, negotiation, Range, caching by hash, 404s, the transfer census', async (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-ship-'));
  let srv = null;
  try {
    const tree = makeTree(dir);
    const dist = join(dir, 'dist');
    ok(ship, buildArgs(tree, dist, ['--copy']));
    const man = JSON.parse(readFileSync(join(dist, 'dist.json'), 'utf8'));
    const hasBr = existsSync(join(dist, 'boot.wasm.br'));
    const statsFile = join(dir, 'stats.json');
    srv = await startServer(dist, [`stats=${statsFile}`]);
    const { origin } = srv;
    const wasm = tree.modFiles['boot.wasm'];
    // types, and / is the page
    let r = await get(`${origin}/play.html`);
    assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(r.body.equals(readFileSync(join(dist, 'play.html'))));
    r = await get(`${origin}/`);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8'); assert.ok(r.body.equals(readFileSync(join(dist, 'play.html'))), '/ is play.html');
    r = await get(`${origin}/play.mjs`);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    r = await get(`${origin}/instance_index.json`);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8'); assert.ok(r.body.equals(readFileSync(join(dist, 'instance_index.json'))));
    r = await get(`${origin}/isaac.segs.bin`, { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(r.headers['content-type'], 'application/octet-stream'); assert.equal(r.headers['content-encoding'], undefined, 'no sibling: identity');
    assert.ok(r.body.equals(tree.segsBytes));
    // negotiation on the module
    r = await get(`${origin}/boot.wasm`);
    assert.equal(r.headers['content-type'], 'application/wasm'); assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(Number(r.headers['content-length']), wasm.length); assert.ok(r.body.equals(wasm), 'no Accept-Encoding: the raw bytes');
    assert.equal(r.headers['accept-ranges'], 'bytes'); assert.equal(r.headers.vary, 'Accept-Encoding');
    r = await get(`${origin}/boot.wasm`, { 'accept-encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip'); assert.equal(Number(r.headers['content-length']), statSync(join(dist, 'boot.wasm.gz')).size);
    assert.ok(gunzipSync(r.body).equals(wasm), 'the gzip sibling, verbatim');
    if (hasBr) {
      r = await get(`${origin}/boot.wasm`, { 'accept-encoding': 'gzip, deflate, br' });
      assert.equal(r.headers['content-encoding'], 'br', 'br wins when both are accepted');
      assert.ok(brotliDecompressSync(r.body).equals(wasm));
      r = await get(`${origin}/boot.wasm`, { 'accept-encoding': 'br;q=1.0, gzip;q=0.5' });
      assert.equal(r.headers['content-encoding'], 'br');
    }
    r = await get(`${origin}/boot.wasm`, { 'accept-encoding': 'deflate' });
    assert.equal(r.headers['content-encoding'], undefined, 'an encoding with no sibling: identity');
    r = await get(`${origin}/boot.wasm`, { 'accept-encoding': 'gzip' }, 'HEAD');
    assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], 'gzip'); assert.equal(r.body.length, 0, 'HEAD: headers only');
    // ?off=&len= is a 200 byte slice of the raw file, never encoded, even for a file with siblings
    const sfx = tree.instFiles['resources/packed/sfx.a'];
    r = await get(`${origin}/instance/resources/packed/sfx.a?off=1000&len=500`, { 'accept-encoding': 'gzip, br' });
    assert.equal(r.status, 200); assert.equal(r.headers['content-encoding'], undefined); assert.equal(Number(r.headers['content-length']), 500);
    assert.ok(r.body.equals(sfx.subarray(1000, 1500)), 'the slice');
    r = await get(`${origin}/instance/resources/packed/sfx.a?off=${sfx.length - 100}&len=1048576`);
    assert.equal(r.body.length, 100, 'a slice past the end is short');
    // ?b64=1: base64 text, on a slice and on a whole file; a BOM survives
    r = await get(`${origin}/instance/resources/packed/sfx.a?off=1000&len=500&b64=1`);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8'); assert.ok(Buffer.from(r.body.toString('ascii'), 'base64').equals(sfx.subarray(1000, 1500)));
    r = await get(`${origin}/instance/resources/scripts/bom.lua?b64=1`);
    const bom = Buffer.from(r.body.toString('ascii'), 'base64');
    assert.ok(bom.equals(tree.instFiles['resources/scripts/bom.lua']) && bom[0] === 0xef, 'the BOM-prefixed file comes back whole');
    // Range
    r = await get(`${origin}/boot.wasm`, { range: 'bytes=10-19', 'accept-encoding': 'br, gzip' });
    assert.equal(r.status, 206); assert.equal(r.headers['content-range'], `bytes 10-19/${wasm.length}`); assert.equal(r.headers['content-encoding'], undefined);
    assert.ok(r.body.equals(wasm.subarray(10, 20)));
    r = await get(`${origin}/boot.wasm`, { range: 'bytes=-5' });
    assert.equal(r.status, 206); assert.ok(r.body.equals(wasm.subarray(wasm.length - 5)));
    r = await get(`${origin}/boot.wasm`, { range: `bytes=${wasm.length + 10}-` });
    assert.equal(r.status, 416); assert.equal(r.headers['content-range'], `bytes */${wasm.length}`);
    // caching: immutable only with the file's hash prefix; ETag + no-cache otherwise; 304 on a match
    const hash = man.files.find((f) => f.path === 'boot.wasm').sha256;
    r = await get(`${origin}/boot.wasm?v=${hash.slice(0, 16)}`, { 'accept-encoding': 'gzip' });
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    r = await get(`${origin}/instance/resources/packed/sfx.a?off=0&len=10&v=${man.files.find((f) => f.path === 'instance/resources/packed/sfx.a').sha256.slice(0, 16)}`);
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', 'a versioned slice is immutable too');
    r = await get(`${origin}/boot.wasm?v=deadbeef`);
    assert.equal(r.headers['cache-control'], 'no-cache', 'a wrong version is not immutable');
    r = await get(`${origin}/boot.wasm`);
    assert.equal(r.headers['cache-control'], 'no-cache'); assert.equal(r.headers.etag, `"${hash.slice(0, 32)}"`);
    r = await get(`${origin}/boot.wasm`, { 'if-none-match': `"${hash.slice(0, 32)}"` });
    assert.equal(r.status, 304); assert.equal(r.body.length, 0);
    // no COOP/COEP by default
    r = await get(`${origin}/play.html`);
    assert.equal(r.headers['cross-origin-opener-policy'], undefined); assert.equal(r.headers['cross-origin-embedder-policy'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    // 404s: a missing file, a directory, a traversal, a Windows drive
    for (const p of ['/nope.bin', '/instance', '/%2e%2e/%2e%2e/package.json', '/c:/windows/win.ini', '/instance/..%2fdist.json']) {
      r = await get(`${origin}${p}`);
      assert.equal(r.status, 404, `${p} is 404`);
    }
    r = await get(`${origin}/play.html`, {}, 'POST');
    assert.equal(r.status, 405);
    // the census: bytes by encoding, slices and b64 counted, per path
    r = await get(`${origin}/__stats`);
    const st = JSON.parse(r.body.toString());
    assert.ok(st.bytes.gzip > 0 && st.bytes.identity > 0, 'gzip and identity bytes counted');
    if (hasBr) assert.ok(st.bytes.br > 0, 'br bytes counted');
    assert.equal(st.slices.requests, 3, 'three plain slices'); assert.equal(st.b64.requests, 2, 'a base64 slice counts as base64, plus the whole file'); assert.equal(st.ranges.requests, 2);
    assert.equal(st.byPath['boot.wasm'].requests > 0, true);
    assert.ok(st.notFound >= 5);
    assert.equal(st.wireTotal, st.bytes.identity + st.bytes.gzip + st.bytes.br);
    assert.ok(st.rawBytes >= st.wireTotal, 'raw is never less than the wire');
  } finally {
    if (srv) srv.child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the page --------------------------------------------------------------------
test('play.html + play.mjs wrap the pipeline: the hooks, the Play click unlocks audio, the progress accounting, the saves menu, the defaults', () => {
  const html = rd('scripts', 'recomp', 'web', 'play.html');
  const page = rd('scripts', 'recomp', 'web', 'play.mjs');
  const pipe = rd('scripts', 'recomp', 'web', 'boot_web.mjs');
  // the elements the pipeline needs (#canvas is where the host creates the WebGL2 context; #log is its text sink)
  for (const s of ['<canvas id="canvas" width="960" height="540"', '<pre id="log">', 'id="play"', 'id="overlay"', 'id="error"', '<dialog id="saves">',
    'image-rendering: pixelated', 'aspect-ratio: 16 / 9', 'id="bar-fill"', '<div id="fps" hidden></div>', 'id="saves-btn" type="button" hidden',
    '<script type="module" src="./play.mjs"></script>'])
    assert.ok(html.includes(s), `play.html: ${s}`);
  assert.ok(!html.includes('<header') && !html.includes('<footer') && !html.includes('fullscreen-btn'),
    'round 51: the page is the game alone -- no header, no key hints, no fullscreen button; ?stats=1 and ?saves=1 opt in');
  // the hooks: set before the pipeline is imported, read by it
  assert.ok(page.includes('window.isaacPageHooks = hooks;'), 'the page publishes its hooks');
  assert.ok(page.indexOf('window.isaacPageHooks = hooks;') < page.indexOf("import('./boot_web.mjs')"), 'before importing the pipeline');
  assert.ok(pipe.includes("const hooks = (typeof window !== 'undefined' && window.isaacPageHooks) || {};"), 'the pipeline reads them');
  for (const s of ['if (hooks.url) url = hooks.url(url);', 'const fetchBytes = hooks.fetchBytes || (async (url) => fetchSync(url));',
    'instantiateWasm: hooks.instantiateWasm,', 'if (hooks.onLog) hooks.onLog(String(line));', 'if (hooks.beforeMain) await hooks.beforeMain(m);',
    "const blob = await fetchBytes('/isaac.segs.bin');", "await stageOk('seed packed archives', async () => {", "await stageOk('lua scripts into MEMFS', async () => {"])
    assert.ok(pipe.includes(s), `boot_web.mjs: ${s}`);
  assert.ok(pipe.indexOf('if (hooks.beforeMain) await hooks.beforeMain(m);') < pipe.indexOf("done.mainRc = await stageOk('main @ 0x00931050'"), 'beforeMain is awaited before main');
  assert.ok(pipe.includes('fetchSync(`/instance/${src}?off=${off}&len=${len}`)'), 'the windowed reads stay synchronous');
  // the Play click: a user gesture that creates/resumes the AudioContext and focuses the canvas, then main
  assert.ok(page.includes("playBtn.addEventListener('click', start, { once: true });"), 'the click starts');
  const start = page.slice(page.indexOf('const start = () => {'), page.indexOf('resolve();', page.indexOf('const start = () => {')));
  assert.ok(start.includes('unlockAudio(m);'), 'start unlocks audio before resolving beforeMain');
  const unlock = page.slice(page.indexOf('function unlockAudio(m) {'), page.indexOf('\n}', page.indexOf('function unlockAudio(m) {')));
  for (const s of ['m.isaacAudio = { ctx: null, buffers: new Map(), sources: new Map() };', 'm.isaacAudio.ctx = new C();',
    "if (m.isaacAudio.ctx.state === 'suspended') m.isaacAudio.ctx.resume();", 'canvas.focus();'])
    assert.ok(unlock.includes(s), `unlockAudio: ${s}`);
  // round 36: the AL shim adopts that page-made object (its ctx, buffers and
  // sources) instead of making its own, and adds the master node and helpers
  const al = rd('scripts', 'recomp', 'host', 'src', 'host_audio_web.c');
  for (const s of ['if (!A) A = Module.isaacAudio = {};', 'A.ctx = A.ctx || null;', 'A.buffers = A.buffers || new Map();',
    'A.sources = A.sources || new Map();', 'if (A.master) return true;', 'if (!A.ctx) {'])
    assert.ok(al.includes(s), `the AL shim adopts the shape the page creates: ${s}`);
  assert.ok(page.includes("if (AUTOPLAY) { start(); return; }"), 'autoplay skips the button');
  assert.ok(page.includes("const AUTOPLAY = params.get('autoplay') !== '0';"), 'round 51: the page starts on its own; autoplay=0 keeps the Play button');
  // round 82: ?stats=1 also brings back the named stages and their byte counts,
  // which the loading screen no longer shows
  assert.ok(page.includes("const STATS = params.get('stats') === '1';")
    && page.includes("if (STATS) { $('fps').hidden = false; $('stages').hidden = false; }")
    && page.includes("if (params.get('saves') === '1') $('saves-btn').hidden = false;"),
    'the instruments and the saves button are opt-in');
  assert.ok(page.includes("$('bar-fill').style.width = `${pct.toFixed(1)}%`;"), 'one bar for the three fetch stages and the boot');
  assert.ok(page.includes("if (ev.code === 'KeyF' && !ev.repeat && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !$('saves').open && !(window.isaacEditFileMenu && window.isaacEditFileMenu.isOpen())) toggleFullscreen();"), 'F toggles fullscreen (not while the EDIT FILE menu is up)');
  assert.ok(page.includes("stage.requestFullscreen().then(() => canvas.focus())"), 'fullscreen keeps the keyboard on the canvas');
  // the progress accounting: module and image from dist.json, archives + scripts from the index, streamed while the module is compiled
  for (const s of ["stages.module.total = sizeOf('boot.wasm');", "stages.image.total = sizeOf('isaac.segs.bin');",
    "stages.archives.total = EAGER_ARCHIVES.reduce((s, n) => s + (indexSize.get(`resources/packed/${n}`) || 0), 0)",
    "index.filter((e) => e.p.startsWith('resources/scripts/')).reduce((s, e) => s + e.s, 0)",
    "WebAssembly.instantiateStreaming(res, info)", "const counted = res.clone().body.getReader();",
    'st.received += value.length; render();', 'if (st) { st.received += value.length; render(); }'])
    assert.ok(page.includes(s), `progress: ${s}`);
  // the eager list is the pipeline's
  const m = pipe.match(/for \(const name of \[([^\]]*)\]\) \{\s*const rel = `resources\/packed\/\$\{name\}`;/);
  assert.ok(m, 'the seed loop of boot_web.mjs');
  const eager = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const pm = page.match(/const EAGER_ARCHIVES = \[([^\]]*)\];/);
  assert.deepEqual([...pm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), eager, 'play.mjs seeds the same six archives into its total');
  // the sync fetches are rewritten (root, ?v= from dist.json) and the streamed bytes counted
  assert.ok(page.includes('hooks.url = (url) => {') && page.includes('return rewrite(url);'), 'the url hook');
  assert.ok(page.includes("const v = versionOf(rel);") && page.includes('v=${v}'), 'a version from the manifest hash');
  assert.ok(page.includes("const ROOT = new URL('.', location.href).pathname.replace(/\\/$/, '');"), 'the page directory is the root');
  // the saves menu shares the pipeline's store
  const store = pipe.match(/const SAVE_DB = '([^']+)', SAVE_STORE = '([^']+)';/);
  assert.ok(page.includes(`const SAVE_DB = '${store[1]}', SAVE_STORE = '${store[2]}';`), 'the same IndexedDB names');
  for (const s of ["$('export-zip').addEventListener('click'", "$('export-json').addEventListener('click'", "$('import-file').addEventListener('change'",
    "$('reset-saves').addEventListener('click'", "import { zipStore, unzip } from './zip.mjs';", "format: 'isaac-recomp-saves/1'",
    "st.put({ src: it.src, bytes: it.bytes }, it.key);", 'if (clear) st.clear();'])
    assert.ok(page.includes(s), `saves: ${s}`);
  // round 74: the zip reader is a module of its own, because the mods menu reads
  // zips too and one reader is better than two
  const zip = rd('scripts', 'recomp', 'web', 'zip.mjs');
  assert.ok(zip.includes('export function zipStore(entries) {') && zip.includes('export async function unzip(buf) {'), 'and it is there');
  assert.ok(page.includes("const entryName = (key, src) => (src || key.replace(/^c:\\/isaac\\//i, '')).replace(/^\\/+/, '');"),
    'a save travels under its seed path, else its key without the fake cwd root (the node driver\'s rule)');
  // defaults: a live page (ISAAC_YIELD=1) with no frame budget, persist on
  // round 76: the default reaches the pipeline through the hooks, and the address
  // bar is left as the player found it
  assert.ok(page.includes("if (!params.has('ISAAC_YIELD')) { params.set('ISAAC_YIELD', '1'); pageDefaults.ISAAC_YIELD = '1'; }")
    && page.includes('hooks.params = pageDefaults;') && !page.includes('history.replaceState(null'),
    'the live-page default is applied without being written into the URL');
  assert.ok(pipe.includes('for (const [k, v] of Object.entries((hooks && hooks.params) || {})) {') && pipe.includes("if (!params.has(k)) params.set(k, String(v));"),
    'and the pipeline takes it, with a real query still winning');
  assert.ok(!/params\.set\('frames'/.test(page), 'no frames= is set: the pipeline takes an unlimited budget under ISAAC_YIELD=1');
  assert.ok(pipe.includes("cfg.ENV.ISAAC_MAX_FRAMES = params.get('frames') || (params.get('ISAAC_YIELD') === '1' ? '100000000' : '5');"), 'which it does');
  // the error panel shows the log tail only when something went wrong; a normal end is not an error
  assert.ok(page.includes("$('errlog').textContent = (window.isaacLog || []).slice(-24).join('\\n');"), 'the last log lines');
  assert.ok(page.includes("if (done.error || done.mainRc !== 0) showError('The run ended with an error'"), 'an error end');
  assert.ok(page.includes("else showError('The run ended', `main returned 0 after ${done.presented} frames"), 'a budget end is reported as an end');
  assert.ok(page.includes("if (/^\\s*TRAP in |^RESULT: aborted|module instantiation failed|lazy (read|pread) FAILED/.test(line)) showError("), 'the log triggers');
  // the grave key reaches the game (the console key), agreeing with the node table
  assert.ok(pipe.includes("grave: [0xC0, 0x29, 0],") && pipe.includes("Backquote: 'grave'"), 'Backquote -> grave');
  assert.ok(rd('scripts', 'recomp', 'lift', 'explore.mjs').includes('grave: [0xC0, 0x29, 0],'), 'the same row in explore.mjs');
});

test('ship.py ships the three page files and mirrors the runner\'s index policy', () => {
  const py = rd('scripts', 'recomp', 'assets', 'ship.py');
  assert.ok(py.includes('PAGE_FILES = ("play.html", "play.mjs", "boot_web.mjs", "menu_overlay.mjs", "zip.mjs", "mods.mjs")'),
    'the page, the pipeline it imports, the EDIT FILE menu, the zip reader and the mods menu');
  assert.ok(py.includes('MODULE_FILES = ("boot.mjs", "boot.wasm")') && py.includes('SEGS_NAME = "isaac.segs.bin"'));
  assert.ok(py.includes('SKIP_DIRS = {"packed", "mods"}') && py.includes('SKIP_EXT = re.compile(r"\\.(exe|dll|so|ogv)$", re.IGNORECASE)'), 'the index policy of run_web.mjs');
  const runner = rd('scripts', 'recomp', 'web', 'run_web.mjs');
  assert.ok(runner.includes("const SKIP_DIRS = new Set(['packed', 'mods']);") && runner.includes('const SKIP_EXT = /\\.(exe|dll|so|ogv)$/i;'), 'which is this');
  assert.ok(py.includes('WINDOW_MIN_DEFAULT = 32 << 20'), 'the host\'s window rule');
  assert.ok(rd('scripts', 'recomp', 'host', 'src', 'host_shims_fs.c').includes('getenv("ISAAC_FS_WINDOW_MIN")'), 'ISAAC_FS_WINDOW_MIN is the host\'s knob');
  assert.ok(py.includes('add(f, os.path.join(module_dir, f), "module", link=False)'), 'the module is copied, never linked (it is relinked in place)');
  const srv = rd('scripts', 'recomp', 'web', 'serve_dist.mjs');
  assert.ok(srv.includes("if (COI) { headers['Cross-Origin-Opener-Policy'] = 'same-origin'; headers['Cross-Origin-Embedder-Policy'] = 'require-corp'; }"), 'COOP/COEP only on request');
  assert.ok(srv.includes("const positionalPort = argv.slice(1).find((a) => /^\\d+$/.test(a));") && srv.includes('?? 8200'), 'port 8200 by default');
});

test('round 45: the dist server re-reads dist.json when it changes, so a rebuilt dist is served with matching hashes', () => {
  const s = readFileSync(join(root, 'scripts', 'recomp', 'web', 'serve_dist.mjs'), 'utf8');
  assert.ok(s.includes('if (st.mtimeMs === manifestMtime) return;'), 'the manifest is re-read on an mtime change');
  assert.ok(/createServer\([^\n]*=>[^\n]*\n  refreshManifest\(\);/.test(s), 'every request checks it first');
});

test('round 46: the shipping page shows a frame-rate readout once the engine runs', () => {
  const page = readFileSync(join(root, 'scripts', 'recomp', 'web', 'play.mjs'), 'utf8');
  assert.ok(page.includes("const line = `${fps.toFixed(0)} fps (median of the last ${recent.length} s: ${med.toFixed(0)}) -- frame ${f}${note}`;"), 'fps and the median of the last ten seconds in the status line');
  assert.ok(page.includes('const f = window.isaacFrame || 0, t = performance.now();'), 'sampled from the host frame counter');
  assert.ok(page.includes("machine = ` -- ${navigator.hardwareConcurrency || '?'} cores, ${navigator.deviceMemory || '?'} GB, ${renderer}`;"), 'the line names the machine: cores, memory, GPU renderer');
});
