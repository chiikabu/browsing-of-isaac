// Round 28: the shipping bundle (scripts/recomp/assets/bundle.py).
//
// The bundle is what the port needs from an instance dir, decided by census:
// the ten archives the engine mounts, the Lua the host reads at boot and the
// save-path note. Everything else -- repentance.a (never named by this exe),
// the language packs (would shadow English assets), the loose extracted tree
// (read zero times), the executables and run-time state -- is dropped. These
// pins hold the rule set on a synthetic tree (no game bytes anywhere near a
// test), the size table's arithmetic, the manifest, `check` on a bundle broken
// four ways, and the two runner knobs the proof runs need (ISAAC_INSTANCE_DIR
// on the node driver, instance= on the web runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, appendFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(root, 'scripts', 'recomp', 'assets', 'bundle.py');

const PYTHONS = [
  join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
  'python3',
  'python',
];
function findPython() {
  for (const p of PYTHONS) {
    if (!p) continue;
    const r = spawnSync(p, ['-c', 'import json, hashlib, fnmatch'], { stdio: 'pipe' });
    if (r.status === 0) return p;
  }
  return null;
}
const python = findPython();

function run(args, opts = {}) {
  return spawnSync(python, [tool, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 120000, ...opts });
}
function ok(args, opts) {
  const r = run(args, opts);
  assert.equal(r.status, 0, `${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) & 0xff; }; }
function bytes(n, seed) { const g = lcg(seed); const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = g(); return b; }
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// --- the synthetic instance -------------------------------------------------
// Names follow the real layout; contents are a few bytes of noise.
const MOUNTED = ['animations', 'config', 'fonts', 'graphics', 'music', 'rooms', 'sfx', 'videos', 'afterbirth', 'afterbirthp'];
const KEPT = {
  ...Object.fromEntries(MOUNTED.map((n, i) => [`resources/packed/${n}.a`, 100 + i * 37])),
  'resources/scripts/main.lua': 50, 'resources/scripts/enums.lua': 60, 'resources/scripts/socket/url.lua': 12,
  'resources/scripts/licenses': 9, 'savedatapath.txt': 254,
};
const DROPPED = {
  'resources/packed/repentance.a': 900, 'resources/packed/repentance_de.a': 30, 'resources/packed/afterbirth_jp.a': 31,
  'resources/packed/repentance_zh.a': 32, 'resources/packed/readme.txt': 5,
  'resources/scripts/socket/core.dll': 40, 'resources/scripts/linux64/socket/core.so': 41,
  'gfx/ui/x.png': 70, 'font/a.fnt': 71, 'players.xml': 72, 'resources/players.xml': 73, 'animations.b': 74,
  'keeper.a': 75, 'secret.a': 76, 'stringtable.sta': 77, 'packed/graphics.a': 78, 'translationstrings.ini': 79,
  'minigames/gfx/a.png': 80, 'resources/shaders/bg.fs': 81, 'resources/gfx/ui/a.anm2': 82, 'scripts/main.lua': 83,
  'isaac-ng.exe': 90, 'dbghelp.dll': 91, 'run.bat': 92, 'steam_appid.txt': 6,
  'Documents/My Games/Binding of Isaac Repentance+/persistentgamedata1.dat': 20, 'data/x': 1, 'mods/m/main.lua': 2,
  '.extracted.json': 3, 'v8-stuck.log': 4,
};
const UNCLASSIFIED = { 'weird.bin': 11 };
const EXPECTED_RULE = {
  'resources/packed/graphics.a': 'mounted-archive', 'resources/scripts/main.lua': 'lua-scripts',
  'resources/scripts/licenses': 'lua-scripts', 'savedatapath.txt': 'save-path-note',
  'resources/packed/repentance.a': 'repentance-archive', 'resources/packed/repentance_de.a': 'language-pack',
  'resources/packed/afterbirth_jp.a': 'language-pack', 'resources/packed/readme.txt': 'packed-other',
  'resources/scripts/socket/core.dll': 'native-binary', 'resources/scripts/linux64/socket/core.so': 'native-binary',
  'isaac-ng.exe': 'native-binary', 'steam_appid.txt': 'native-binary',
  'Documents/My Games/Binding of Isaac Repentance+/persistentgamedata1.dat': 'runtime-state', 'data/x': 'runtime-state',
  'mods/m/main.lua': 'runtime-state', '.extracted.json': 'runtime-state', 'v8-stuck.log': 'runtime-state',
  'gfx/ui/x.png': 'loose-tree', 'resources/players.xml': 'loose-tree', 'players.xml': 'loose-tree', 'keeper.a': 'loose-tree',
  'secret.a': 'loose-tree', 'packed/graphics.a': 'loose-tree', 'resources/gfx/ui/a.anm2': 'loose-tree',
  'scripts/main.lua': 'loose-tree', 'weird.bin': 'unclassified',
};

function makeTree(dir, files, seed, scale = 1) {
  const out = {};
  let i = 0;
  for (const [rel, n] of Object.entries(files)) {
    const b = bytes(n * scale, seed + i++);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), b);
    out[rel] = b;
  }
  return out;
}
const sum = (o) => Object.values(o).reduce((a, b) => a + b.length, 0);

function parseTable(text) {
  const rows = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\S.*?\S)\s{2,}([\d,]+|-)\s+([\d,]+|-)\s+([\d,]+|-)\s+(\d+)/);
    if (!m) continue;
    const num = (s) => (s === '-' ? null : Number(s.replace(/,/g, '')));
    rows[m[1]] = { original: num(m[2]), instance: num(m[3]), bundle: num(m[4]), files: Number(m[5]) };
  }
  return rows;
}

test('the rule set classifies the synthetic instance file by file', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-bundle-'));
  try {
    const inst = join(dir, 'instance');
    makeTree(inst, { ...KEPT, ...DROPPED, ...UNCLASSIFIED }, 1);
    const out = ok(['classify', inst, '--all']);
    const seen = {};
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(keep|drop) (\S+)\s+([\d,]+)\s+(.+)$/);
      if (m) seen[m[4]] = { verdict: m[1], rule: m[2], size: Number(m[3].replace(/,/g, '')) };
    }
    for (const rel of Object.keys(KEPT)) assert.equal(seen[rel]?.verdict, 'keep', rel);
    for (const rel of [...Object.keys(DROPPED), ...Object.keys(UNCLASSIFIED)]) assert.equal(seen[rel]?.verdict, 'drop', rel);
    for (const [rel, rule] of Object.entries(EXPECTED_RULE)) assert.equal(seen[rel]?.rule, rule, `${rel} matches ${rule}`);
    assert.equal(seen['resources/packed/graphics.a'].size, KEPT['resources/packed/graphics.a']);
    // the rule listing names every mounted archive and every language code
    const rules = ok(['rules']);
    for (const n of MOUNTED) assert.ok(rules.includes(`resources/packed/${n}.a`), `${n} is a mounted archive`);
    for (const c of ['de', 'es', 'fr', 'jp', 'kr', 'ru', 'zh']) assert.ok(rules.includes(`resources/packed/*_${c}.a`), `language pack ${c}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build keeps exactly the kept set, links it, writes a manifest, and the size table adds up', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-bundle-'));
  try {
    const orig = join(dir, 'original'), inst = join(dir, 'instance'), out = join(dir, 'bundle');
    // the "original" holds the same names with archives three times the size (the instance is the optimised set)
    const origFiles = makeTree(orig, { ...KEPT, ...DROPPED, ...UNCLASSIFIED }, 100, 3);
    const instFiles = makeTree(inst, { ...KEPT, ...DROPPED, ...UNCLASSIFIED }, 200, 1);
    const report = join(dir, 'report.json');
    const text = ok(['build', inst, out, '--original', orig, '--json', report]);
    // exactly the kept files, nothing else, plus the manifest
    const walk = (d, rel = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory()
      ? walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]);
    const got = walk(out).filter((p) => p !== '.bundle.json').sort();
    assert.deepEqual(got, Object.keys(KEPT).sort());
    for (const rel of Object.keys(KEPT)) assert.ok(readFileSync(join(out, rel)).equals(instFiles[rel]), `${rel} is the instance's bytes`);
    // hard links by default: same file identity as the source (when the platform reports one)
    const a = statSync(join(out, 'resources/packed/graphics.a')), b = statSync(join(inst, 'resources/packed/graphics.a'));
    if (a.ino && b.ino) assert.equal(String(a.ino), String(b.ino), 'a hard link shares the source inode');
    // the manifest
    const man = JSON.parse(readFileSync(join(out, '.bundle.json'), 'utf8'));
    assert.equal(man.format, 'isaac-recomp-bundle/1');
    assert.deepEqual(man.mount_order, MOUNTED);
    assert.equal(man.files.length, Object.keys(KEPT).length);
    for (const f of man.files) {
      assert.equal(f.size, instFiles[f.path].length, `${f.path} size`);
      assert.equal(f.sha256, sha256(instFiles[f.path]), `${f.path} sha256`);
    }
    assert.equal(man.totals.bytes, sum(Object.fromEntries(Object.keys(KEPT).map((k) => [k, instFiles[k]]))));
    assert.equal(man.totals.files, Object.keys(KEPT).length);
    assert.equal(man.linked + man.copied, Object.keys(KEPT).length);
    assert.deepEqual(man.unclassified, ['weird.bin']);
    assert.equal(man.source.bytes, sum(instFiles));
    assert.equal(man.original.bytes, sum(origFiles));
    // the size table: per-archive rows and the totals are the trees' sums
    const rows = parseTable(text);
    for (const n of MOUNTED) {
      const rel = `resources/packed/${n}.a`;
      assert.deepEqual(rows[rel], { original: origFiles[rel].length, instance: instFiles[rel].length, bundle: instFiles[rel].length, files: 1 }, rel);
    }
    const bundleBytes = man.totals.bytes;
    assert.deepEqual(rows.TOTAL, { original: sum(origFiles), instance: sum(instFiles), bundle: bundleBytes, files: Object.keys(instFiles).length });
    const lang = ['resources/packed/repentance_de.a', 'resources/packed/afterbirth_jp.a', 'resources/packed/repentance_zh.a'];
    assert.deepEqual(rows['language packs'], {
      original: lang.reduce((s, k) => s + origFiles[k].length, 0), instance: lang.reduce((s, k) => s + instFiles[k].length, 0),
      bundle: null, files: lang.length });
    assert.deepEqual(rows['repentance.a'], { original: origFiles['resources/packed/repentance.a'].length,
      instance: instFiles['resources/packed/repentance.a'].length, bundle: null, files: 1 });
    // every group row's three columns add up to the trees' totals
    const groups = Object.entries(rows).filter(([k]) => k !== 'TOTAL');
    for (const col of ['original', 'instance']) {
      assert.equal(groups.reduce((s, [, r]) => s + (r[col] ?? 0), 0), rows.TOTAL[col], `${col} column sums to its total`);
    }
    assert.equal(groups.reduce((s, [, r]) => s + (r.bundle ?? 0), 0), bundleBytes, 'bundle column sums to its total');
    const pct = text.match(/= ([\d.]+)% of the original instance/);
    assert.ok(pct, 'the percent line exists');
    assert.equal(pct[1], (100 * bundleBytes / sum(origFiles)).toFixed(2));
    // the JSON report carries the same totals
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual(rep.totals.bundle, [Object.keys(KEPT).length, bundleBytes]);
    assert.deepEqual(rep.totals.original, [Object.keys(origFiles).length, sum(origFiles)]);
    // --strict refuses the unclassified file; --copy makes independent files
    const strict = run(['build', inst, join(dir, 'strict'), '--strict']);
    assert.notEqual(strict.status, 0, '--strict fails on an unclassified file');
    assert.match(strict.stdout + strict.stderr, /unclassified/);
    ok(['build', inst, join(dir, 'copied'), '--copy']);
    const c = statSync(join(dir, 'copied', 'resources/packed/graphics.a'));
    if (c.ino && b.ino) assert.notEqual(String(c.ino), String(b.ino), '--copy does not share the inode');
    assert.ok(readFileSync(join(dir, 'copied', 'resources/packed/graphics.a')).equals(instFiles['resources/packed/graphics.a']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check passes on a fresh bundle and names each way a bundle can be broken', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-bundle-'));
  try {
    const inst = join(dir, 'instance'), out = join(dir, 'bundle');
    makeTree(inst, { ...KEPT, ...DROPPED }, 300);
    ok(['build', inst, out, '--copy', '--strict']);
    assert.match(ok(['check', out]), /bundle check OK: \d+ files, [\d,]+ bytes, every sha256 matches/);
    assert.match(ok(['check', out, '--quick']), /sizes only/);
    const target = join(out, 'resources/packed/music.a');
    const pristine = readFileSync(target);
    // 1. a byte appended: the size disagrees
    appendFileSync(target, Buffer.from([1]));
    let r = run(['check', out]);
    assert.equal(r.status, 1); assert.match(r.stdout, /size: resources\/packed\/music\.a is \d+ bytes, manifest says \d+/);
    // 2. a byte flipped, same size: the hash disagrees, --quick cannot see it
    const flipped = Buffer.from(pristine); flipped[0] ^= 0xff;
    writeFileSync(target, flipped);
    r = run(['check', out]);
    assert.equal(r.status, 1); assert.match(r.stdout, /hash: resources\/packed\/music\.a does not match/);
    assert.equal(run(['check', out, '--quick']).status, 0, 'a size-only check passes the flipped byte');
    writeFileSync(target, pristine);
    assert.equal(run(['check', out]).status, 0, 'restored');
    // 3. a file missing
    unlinkSync(join(out, 'savedatapath.txt'));
    r = run(['check', out]);
    assert.equal(r.status, 1); assert.match(r.stdout, /missing: savedatapath\.txt/);
    writeFileSync(join(out, 'savedatapath.txt'), readFileSync(join(inst, 'savedatapath.txt')));
    // 4. a file that is not in the manifest
    writeFileSync(join(out, 'resources', 'packed', 'repentance.a'), 'x');
    r = run(['check', out]);
    assert.equal(r.status, 1); assert.match(r.stdout, /extra: resources\/packed\/repentance\.a is not in the manifest/);
    unlinkSync(join(out, 'resources', 'packed', 'repentance.a'));
    assert.equal(run(['check', out]).status, 0, 'clean again');
    // 5. no manifest at all
    r = run(['check', inst]);
    assert.equal(r.status, 1); assert.match(r.stdout, /no \.bundle\.json/);
    // 6. the manifest's own totals are checked against its list
    const mp = join(out, '.bundle.json');
    const man = JSON.parse(readFileSync(mp, 'utf8'));
    man.totals.bytes += 1;
    writeFileSync(mp, JSON.stringify(man));
    r = run(['check', out]);
    assert.equal(r.status, 1); assert.match(r.stdout, /totals: the manifest's totals do not add up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bundle rules keep exactly the archive set the drivers register', () => {
  const py = readFileSync(tool, 'utf8');
  const m = py.match(/MOUNTED_ARCHIVES = \(([^)]*)\)/);
  assert.ok(m, 'MOUNTED_ARCHIVES exists');
  const mounted = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.deepEqual(mounted, MOUNTED, 'mount order: animations .. afterbirthp');
  const drv = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'boot_integration.mjs'), 'utf8');
  const names = (re) => [...drv.match(re)[1].matchAll(/'([^']+)'/g)].map((x) => x[1].replace(/\.a$/, ''));
  const registered = [...names(/const BOOT_ARCHIVES = \[([^\]]*)\]/), ...names(/const LAZY_ARCHIVES = \[([^\]]*)\]/)].sort();
  assert.deepEqual(registered, [...mounted].sort(), 'the node driver registers the same ten archives, no more');
  const web = readFileSync(join(root, 'scripts', 'recomp', 'web', 'boot_web.mjs'), 'utf8');
  for (const n of mounted) assert.ok(web.includes(`'${n}.a'`) || web.includes(`'resources/packed/${n}.a'`), `${n}: the page registers it`);
  assert.ok(!py.includes('"repentance"'), 'repentance.a is not a mounted archive');
});

test('both runners can be pointed at another instance dir, and the web runner records what it served', () => {
  const drv = readFileSync(join(root, 'scripts', 'recomp', 'lift', 'boot_integration.mjs'), 'utf8');
  assert.match(drv, /const INSTANCE_DIR = \(process\.env\.ISAAC_INSTANCE_DIR \|\| 'C:\/Users\/Luca\/Desktop\/isaac\/\.scratch\/game-instance'\)/,
    'ISAAC_INSTANCE_DIR overrides the node driver, the default is unchanged');
  assert.ok(drv.includes("walk(INSTANCE_DIR, '')") && drv.includes('openSync(`${INSTANCE_DIR}/${src}`'),
    'the tree walk and the windowed reads follow the override');
  const web = readFileSync(join(root, 'scripts', 'recomp', 'web', 'run_web.mjs'), 'utf8');
  assert.match(web, /a\.startsWith\('instance='\)/, 'instance=<dir> is an argument');
  assert.ok(web.includes("process.env.ISAAC_INSTANCE_DIR || ''"), 'or the environment');
  assert.ok(web.includes("join(ROOT, '.scratch', 'game-instance')"), 'the default instance is unchanged');
  assert.ok(web.includes("!a.startsWith('instance=')"), 'instance= is not forwarded to the page as ISAAC_ env');
  assert.ok(web.includes("writeFileSync(join(OUT, 'served_files.json')"), 'the served-files index is written next to the log');
  assert.ok(web.includes('recordServed(rel, body.length);'), 'every 200 is recorded before the base64 step');
  assert.ok(/timed out[\s\S]*writeServedIndex\(\)/i.test(web) || web.includes('${writeServedIndex()} distinct); the page never left main'),
    'a timed-out run still writes the index');
});
