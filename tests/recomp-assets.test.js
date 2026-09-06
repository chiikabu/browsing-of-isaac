// scripts/recomp/assets/archive.py: the KAGE packed-archive ("ARCH000") library.
//
// The engine mounts every archive at boot (0x00a179c0): header, table, then
// (unless the round-26 lift patch skips it) a per-entry pass that decodes the
// whole payload through the entry stream and folds a checksum against the
// table's fifth field. The library re-implements the key hashes, that fold,
// and the three payload codecs the shipped archives use (raw XOR, LZW, MiniZ).
// These pins hold the pure parts: the hashes against a real table entry, the
// checksum fold (including its stale-tail quirk) against an independent JS
// implementation, and the pack -> verify -> extract -> repack round trip on a
// fixture, which must reproduce the packed bytes exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(root, 'scripts', 'recomp', 'assets', 'archive.py');

const PYTHONS = [
  join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe'),
  'python3',
  'python',
];

function findPython() {
  for (const p of PYTHONS) {
    if (!p) continue;
    const r = spawnSync(p, ['-c', 'import zlib, struct, mmap'], { stdio: 'pipe' });
    if (r.status === 0) return p;
  }
  return null;
}

const python = findPython();

function run(args, opts = {}) {
  const r = spawnSync(python, [tool, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 120000, ...opts });
  assert.equal(r.status, 0, `${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// --- JS reference implementations of the pure parts ---------------------
function fold(c) {
  if (c >= 65 && c <= 90) c += 32;
  if (c === 92) c = 47;
  return c;
}
function djb2(s) {
  let h = 0x1505;
  for (const c of Buffer.from(s, 'utf8')) h = (Math.imul(h, 33) + fold(c)) >>> 0;
  return h;
}
function fnv1a(s) {
  let h = 0x5bb2220e;
  for (const c of Buffer.from(s, 'utf8')) h = Math.imul(h ^ fold(c), 0x1000193) >>> 0;
  return h;
}
// The mount fold: h = rotr1(h) + u32 over the decoded bytes, read in 0x200-byte
// chunks into ONE buffer zeroed once per entry, summing ceil(got/4) dwords; the
// tail bytes of a final partial dword are whatever the previous chunk left there.
function mountChecksum(bytes) {
  let h = 0xababeb98;
  const buf = Buffer.alloc(0x200);
  let pos = 0, remaining = bytes.length;
  for (;;) {
    const want = Math.min(remaining, 0x200);
    const got = Math.max(Math.min(want, bytes.length - pos), 0);
    if (got) bytes.copy(buf, 0, pos, pos + got);
    const ndw = (got + 3) >> 2;
    for (let i = 0; i < ndw; i++) {
      h = ((((h >>> 1) | ((h & 1) << 31)) >>> 0) + buf.readUInt32LE(i * 4)) >>> 0;
    }
    remaining -= want; pos += want;
    if (!(remaining > 0 && got === want)) break;
  }
  return h;
}
function naiveChecksum(bytes) { // zero-padded fold, to show the quirk is exercised
  let h = 0xababeb98;
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) h = ((((h >>> 1) | ((h & 1) << 31)) >>> 0) + padded.readUInt32LE(i)) >>> 0;
  return h;
}

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) & 0xff; }; }
function randomBytes(n, seed) { const g = lcg(seed); const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = g(); return b; }

test('archive keys: djb2 + FNV-1a over the folded "resources/<path>", pinned to a real table entry', (t) => {
  // resources/music/Repentance/Genesis Retake Light Loop.ogg is entry 8885 of afterbirthp.a
  // (djb2 f46a43da, fnv 1240ef03), matched against the table by the assets notes.
  const p = 'resources/music/Repentance/Genesis Retake Light Loop.ogg';
  assert.equal(djb2(p), 0xf46a43da);
  assert.equal(fnv1a(p), 0x1240ef03);
  assert.equal(djb2('RESOURCES\\Music\\REPENTANCE\\Genesis Retake Light Loop.OGG'), 0xf46a43da, 'case and slashes fold');
  assert.equal(fnv1a('RESOURCES\\Music\\REPENTANCE\\Genesis Retake Light Loop.OGG'), 0x1240ef03);
  assert.notEqual(djb2('music/Repentance/Genesis Retake Light Loop.ogg'), 0xf46a43da, 'the prefix is part of the key');
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const out = run(['hash', 'music/Repentance/Genesis Retake Light Loop.ogg']);
  assert.match(out, /^f46a43da 1240ef03 resources\/music\/Repentance\/Genesis Retake Light Loop\.ogg/m, 'the tool adds the prefix and agrees');
  const raw = run(['hash', '--raw', 'RESOURCES\\Music\\REPENTANCE\\Genesis Retake Light Loop.OGG']);
  assert.match(raw, /^f46a43da 1240ef03 /m);
});

test('mount checksum: python and the JS reference agree, and the stale-tail quirk is real', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-assets-'));
  try {
    const cases = [0, 1, 3, 4, 0x1ff, 0x200, 0x201, 0x203, 0x3ff, 0x401, 0x600 + 2, 5000, 8191].map((n, i) => randomBytes(n, 0x1234 + i));
    const files = cases.map((b, i) => { const f = join(dir, `c${i}.bin`); writeFileSync(f, b); return f; });
    const out = run(['checksum', ...files]).trim().split(/\r?\n/);
    assert.equal(out.length, cases.length);
    cases.forEach((b, i) => {
      assert.equal(out[i].slice(0, 8), mountChecksum(b).toString(16).padStart(8, '0'), `size ${b.length}`);
    });
    assert.equal(mountChecksum(Buffer.alloc(0)), 0xababeb98, 'an empty entry folds nothing');
    // 0x203 bytes: the last dword's tail byte is byte 3 of the first chunk, not zero
    const q = cases[7];
    assert.equal(q.length, 0x203);
    assert.notEqual(q[3], 0, 'fixture: the stale byte is non-zero');
    assert.notEqual(mountChecksum(q), naiveChecksum(q), 'a zero-padded fold would disagree with the engine');
    // entries shorter than one chunk see zeros in the tail: both folds agree there
    assert.equal(mountChecksum(cases[1]), naiveChecksum(cases[1]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round 67: halve-sfx halves the samples that carry no treble and keeps the ones that do', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-halve-'));
  try {
    // two samples at 44.1 kHz: a 440 Hz tone (nothing above 11 kHz) and a 15 kHz tone
    // (everything above it). sounds.xml names both, so both are candidates.
    const wav = (hz, seconds = 0.5, rate = 44100) => {
      const n = Math.round(rate * seconds);
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(16000 * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
      h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
      h.writeUInt32LE(pcm.length, 40);
      return Buffer.concat([h, pcm]);
    };
    const src = join(dir, 'src');
    const files = {
      'sfx/low.wav': wav(440),
      'sfx/high.wav': wav(15000),
      'sounds.xml': Buffer.from('<sounds root="sfx/"><sound id="1"><sample weight="1" path="low.wav" /></sound>'
        + '<sound id="2"><sample weight="1" path="high.wav" /></sound></sounds>'),
    };
    for (const [rel, data] of Object.entries(files)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), data);
    }
    const a = join(dir, 'in.a');
    run(['pack', src, a, '--version', '0']);
    const out = join(dir, 'out.a');
    const opt = join(root, 'scripts', 'recomp', 'assets', 'optimize.py');
    const r = spawnSync(python, [opt, 'halve-sfx', a, out, '--threshold', '0.005'], { encoding: 'utf8' });
    if (/No module named .numpy./.test(r.stderr || '')) { t.skip('no numpy'); return; }
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 of 2 catalogued samples halved \(1 kept for their treble/);
    // extract both and read their headers back
    const ex = join(dir, 'ex');
    const names = join(dir, 'names.txt');
    writeFileSync(names, Object.keys(files).join('\n') + '\n');
    run(['extract', out, ex, '--names', names]);
    const low = readFileSync(join(ex, 'sfx', 'low.wav'));
    const high = readFileSync(join(ex, 'sfx', 'high.wav'));
    assert.equal(low.readUInt32LE(24), 22050, 'the 440 Hz tone came down to 22,050 Hz');
    assert.equal(high.readUInt32LE(24), 44100, 'the 15 kHz tone kept its rate');
    assert.ok(high.equals(files['sfx/high.wav']), 'a kept sample is byte-for-byte what it was');
    assert.equal(low.readUInt16LE(22), 1, 'still mono');
    assert.equal(low.readUInt16LE(34), 16, 'still 16-bit');
    const seconds = (b) => b.readUInt32LE(40) / (b.readUInt32LE(24) * b.readUInt16LE(22) * (b.readUInt16LE(34) / 8));
    assert.ok(Math.abs(seconds(low) - 0.5) < 0.002, `the halved sample is still half a second (${seconds(low)})`);
    // and it is still a 440 Hz tone at roughly its old level
    let peak = 0;
    for (let i = 44; i + 1 < low.length; i += 2) peak = Math.max(peak, Math.abs(low.readInt16LE(i)));
    assert.ok(peak > 14000 && peak < 18000, `the level survived (peak ${peak})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('round 64: repack --order lays the named entries out first, and changes nothing else', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-layout-'));
  try {
    const src = join(dir, 'src');
    const files = {
      'gfx/ui/a.png': randomBytes(600, 7),
      'sfx/one.wav': randomBytes(0x401, 8),
      'sfx/two.wav': randomBytes(0x801, 9),
      'music/loop.ogg': Buffer.from('OggS'.repeat(900)),
      'xml/z.xml': Buffer.from('<z/>'),
    };
    for (const [rel, data] of Object.entries(files)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), data);
    }
    for (const version of [0, 2]) {
      const a = join(dir, `t${version}.a`);
      run(['pack', src, a, '--version', String(version)]);
      const want = ['sfx/two.wav', 'music/loop.ogg', 'sfx/one.wav'];
      const order = join(dir, `order${version}.txt`);
      writeFileSync(order, '# the boot order\n' + want.join('\n') + '\nnot/in/the/archive.bin\n');
      const b = join(dir, `t${version}-laid.a`);
      run(['repack', a, b, '--order', order]);
      // the entry set, the sizes and the checksums are untouched: only the offsets moved
      const before = run(['list', a]).split(/\r?\n/).filter((l) => l.includes('size='));
      const after = run(['list', b]).split(/\r?\n/).filter((l) => l.includes('size='));
      assert.equal(after.length, before.length);
      const strip = (l) => l.replace(/^\s*\d+ /, '').replace(/off=\s*\d+/, 'off=');   // the row index and the offset are what a layout moves
      assert.deepEqual(new Set(after.map(strip)), new Set(before.map(strip)), 'same keys, sizes and checksums');
      assert.match(run(['verify', b]), new RegExp(`${Object.keys(files).length}/\\s*${Object.keys(files).length} matched`));
      // and the payloads sit in the requested order, ahead of everything else
      const ex = join(dir, `ex${version}`);
      const names = join(dir, 'names.txt');
      writeFileSync(names, Object.keys(files).join('\n') + '\n');
      run(['extract', b, ex, '--names', names]);
      for (const [rel, data] of Object.entries(files)) assert.ok(readFileSync(join(ex, rel)).equals(data), rel);
      const offOf = (rel) => {
        const h1 = djb2('resources/' + rel).toString(16).padStart(8, '0');
        const h2 = fnv1a('resources/' + rel).toString(16).padStart(8, '0');
        const line = run(['list', b]).split(/\r?\n/).find((l) => l.includes(`${h1} ${h2}`));
        return Number(/off=\s*(\d+)/.exec(line)[1]);
      };
      const offs = want.map(offOf);
      assert.deepEqual(offs, [...offs].sort((x, y) => x - y), 'the listed paths are laid out in the listed order');
      assert.ok(offs[0] === 14, 'the first listed path is the first payload in the file');
      for (const rel of ['gfx/ui/a.png', 'xml/z.xml']) assert.ok(offOf(rel) > offs[2], `${rel} follows the listed ones`);
      // round 65: the same order written as h1-h2 tags (how a boot trace names an entry
      // whose path nothing records) lays the archive out identically
      const tags = want.map((rel) => `${djb2('resources/' + rel).toString(16).padStart(8, '0')}-${fnv1a('resources/' + rel).toString(16).padStart(8, '0')}`);
      const orderTags = join(dir, `order${version}-tags.txt`);
      writeFileSync(orderTags, tags.join('\n') + '\n');
      const c = join(dir, `t${version}-tags.a`);
      run(['repack', a, c, '--order', orderTags]);
      assert.ok(readFileSync(c).equals(readFileSync(b)), 'an order file of tags lays the archive out like one of paths');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('round 75: huffman re-encodes the blocks and not the bytes', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-huffman-'));
  try {
    const src = join(dir, 'src');
    // compressible text, so the blocks are real deflate blocks with real Huffman
    // headers rather than the stored blocks incompressible bytes get
    const text = (n, seed) => {
      const words = ['isaac', 'room', 'entity', 'sprite', 'layer', 'anm2', 'gfx', 'null'];
      let out = '', r = seed;
      while (out.length < n) { r = (r * 1103515245 + 12345) >>> 0; out += words[r % words.length] + ' '; }
      return Buffer.from(out.slice(0, n));
    };
    // and a skewed byte stream with few matches, which is where a dynamic table
    // earns its header and static Huffman does not
    const skewed = (n, seed) => {
      const out = Buffer.alloc(n);
      let r = seed;
      for (let i = 0; i < n; i++) {
        r = (r * 1103515245 + 12345) >>> 0;
        let v = 0, x = (r >>> 8) & 0xffff;
        while (v < 200 && x > 8000) { x = (x * 3) >>> 2 & 0xffff; v += 7; }
        out[i] = v & 0xff;
      }
      return out;
    };
    const files = {
      'gfx/ui/a.png': skewed(30000, 3),
      'xml/entities.xml': text(40000, 4),
      'sfx/one.wav': randomBytes(0x401, 8),         // incompressible: stays as it is
      'xml/z.xml': Buffer.from('<z/>'),             // under one block
    };
    for (const [rel, data] of Object.entries(files)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), data);
    }
    const a = join(dir, 'v2.a');
    run(['pack', src, a, '--version', '2']);
    const before = run(['list', a]).split(/\r?\n/).filter((l) => l.includes('size='));
    const opt = join(root, 'scripts', 'recomp', 'assets', 'optimize.py');
    const sizes = {};
    for (const cost of ['0', '128', '1000000']) {
      const b = join(dir, `v2-c${cost}.a`);
      const r = spawnSync(python, [opt, 'huffman', a, b, '--cost', cost], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /0 verify failures/, `cost ${cost}: every entry decodes to the same bytes`);
      // the table is untouched: same keys, same sizes, same mount checksums
      const after = run(['list', b]).split(/\r?\n/).filter((l) => l.includes('size='));
      const strip = (l) => l.replace(/^\s*\d+ /, '').replace(/off=\s*\d+/, 'off=');
      assert.deepEqual(new Set(after.map(strip)), new Set(before.map(strip)), `cost ${cost}: same keys, sizes and checksums`);
      assert.match(run(['verify', b]), new RegExp(`${Object.keys(files).length}/\\s*${Object.keys(files).length} matched`));
      // and the payloads still come back
      const ex = join(dir, `ex${cost}`);
      const names = join(dir, 'names.txt');
      writeFileSync(names, Object.keys(files).join('\n') + '\n');
      run(['extract', b, ex, '--names', names]);
      for (const [rel, data] of Object.entries(files)) assert.ok(readFileSync(join(ex, rel)).equals(data), `cost ${cost}: ${rel}`);
      sizes[cost] = statSync(b).size;
    }
    // the budget does what it says: more allowance, more static blocks, more bytes
    assert.ok(sizes['0'] <= sizes['128'], `cost 0 (${sizes['0']}) is no larger than cost 128 (${sizes['128']})`);
    assert.ok(sizes['128'] <= sizes['1000000'], `cost 128 (${sizes['128']}) is no larger than all static (${sizes['1000000']})`);
    // and the knob is a knob: the two ends do not produce the same file
    assert.ok(!readFileSync(join(dir, 'v2-c0.a')).equals(readFileSync(join(dir, 'v2-c1000000.a'))),
      'the budget changes the encoding, not just the report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pack -> verify -> extract -> repack reproduces the archive byte for byte (versions 0 and 2)', (t) => {
  if (!python) { t.skip('no python 3 on PATH'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'isaac-assets-'));
  try {
    const src = join(dir, 'src');
    const files = {
      'gfx/ui/tiny.png': randomBytes(5, 1),
      'sfx/Feedback/noise.wav': randomBytes(0x401, 2),        // > 0x400 of noise: the v2 packer stores it
      'music/loop.ogg': Buffer.from('OggS'.repeat(1500)),        // compressible: deflate pieces
      'scripts/main.lua': Buffer.from('-- lua\n'.repeat(700)),   // 4900 bytes, several pieces
      'xml/empty.xml': Buffer.alloc(0),
      'xml/one.xml': Buffer.from('x'),
    };
    for (const [rel, data] of Object.entries(files)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), data);
    }
    for (const version of [0, 2]) {
      const a = join(dir, `t${version}.a`);
      run(['pack', src, a, '--version', String(version)]);
      const packed = readFileSync(a);
      assert.equal(packed.subarray(0, 7).toString('latin1'), 'ARCH000');
      assert.equal(packed[7], version);
      assert.equal(packed.readUInt16LE(12), Object.keys(files).length);
      const tableOff = packed.readUInt32LE(8);
      assert.equal(packed.length, tableOff + 20 * Object.keys(files).length, 'the table is the tail of the file');
      // determinism: packing again gives the same bytes
      const a2 = join(dir, `t${version}-again.a`);
      run(['pack', src, a2, '--version', String(version)]);
      assert.ok(readFileSync(a2).equals(packed), 'pack is deterministic');
      // every table x is the fold of the decoded entry, and the tool agrees
      const v = run(['verify', a]);
      assert.match(v, new RegExp(`v${version}\\s+${Object.keys(files).length}/\\s*${Object.keys(files).length} matched`));
      const listing = run(['list', a]);
      for (const [rel, data] of Object.entries(files)) {
        const h1 = djb2('resources/' + rel).toString(16).padStart(8, '0');
        const h2 = fnv1a('resources/' + rel).toString(16).padStart(8, '0');
        const line = listing.split(/\r?\n/).find((l) => l.includes(`${h1} ${h2}`));
        assert.ok(line, `${rel} is in the table`);
        assert.match(line, new RegExp(`size=\\s*${data.length} x=${mountChecksum(data).toString(16).padStart(8, '0')}`), rel);
      }
      // extract gives the bytes back
      const ex = join(dir, `ex${version}`);
      const names = join(dir, 'names.txt');
      writeFileSync(names, Object.keys(files).join('\n') + '\n');
      run(['extract', a, ex, '--names', names]);
      for (const [rel, data] of Object.entries(files)) {
        assert.ok(readFileSync(join(ex, rel)).equals(data), `${rel} round-trips through version ${version}`);
      }
      const manifest = JSON.parse(readFileSync(join(ex, 'manifest.json'), 'utf8'));
      assert.equal(manifest.entries.length, Object.keys(files).length);
      // repack unchanged is byte-identical
      const b = join(dir, `t${version}-repack.a`);
      run(['repack', a, b]);
      assert.ok(readFileSync(b).equals(packed), `version ${version}: unchanged repack is byte-identical`);
      // repack with one replaced entry: still 100% verified, the new bytes come back out
      const rep = join(dir, `rep${version}`);
      mkdirSync(join(rep, 'music'), { recursive: true });
      const replaced = randomBytes(3001, 99);
      writeFileSync(join(rep, 'music', 'loop.ogg'), replaced);
      const c = join(dir, `t${version}-replaced.a`);
      run(['repack', a, c, '--replace', rep]);
      assert.match(run(['verify', c]), /\s6\/\s*6 matched/);
      const ex2 = join(dir, `ex${version}-replaced`);
      run(['extract', c, ex2, '--names', names]);
      assert.ok(readFileSync(join(ex2, 'music', 'loop.ogg')).equals(replaced));
      assert.ok(readFileSync(join(ex2, 'scripts', 'main.lua')).equals(files['scripts/main.lua']), 'untouched entries pass through');
    }
    // a version-0 archive re-encoded as version 2 (and back) keeps every entry
    const v2 = join(dir, 'cross.a');
    run(['repack', join(dir, 't0.a'), v2, '--version', '2']);
    assert.match(run(['verify', v2]), /v2\s+6\/\s*6 matched/);
    const back = join(dir, 'cross-back.a');
    run(['repack', v2, back, '--version', '0']);
    assert.ok(readFileSync(back).equals(readFileSync(join(dir, 't0.a'))), 'v0 -> v2 -> v0 is the identity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
