// serve_dist.mjs -- a small static server for a shipping dist (round 34:
// scripts/recomp/assets/ship.py build -> .scratch/game-dist).
//
//   node scripts/recomp/web/serve_dist.mjs <dist> [port=8200] [host=127.0.0.1] [stats=<file>] [coi=0] [quiet=1]
//
// What the page (play.html + play.mjs + boot_web.mjs) needs from whoever hosts
// the dist, all of it here:
//   - GET / is play.html; every other path is a file of the dist, typed by its
//     extension (text/html, text/javascript, application/wasm, application/json,
//     application/octet-stream for the rest);
//   - a precompressed sibling (<file>.br / <file>.gz, made by ship.py) is served
//     with Content-Encoding when the client accepts that encoding, the raw file
//     otherwise (Vary: Accept-Encoding);
//   - ?off=N&len=M is a byte slice of the raw file (status 200, identity) and
//     ?b64=1 turns any answer into base64 text -- run_web.mjs's contract, which
//     the page's windowed archive reads and synchronous fetches depend on;
//   - Range: bytes=a-b is honoured with a 206 on plain requests;
//   - Cache-Control is `public, max-age=31536000, immutable` when the request
//     carries ?v=<prefix of the file's dist.json sha256> (the page does that for
//     the module, the image and the archives), `no-cache` with an ETag otherwise;
//   - no COOP/COEP unless coi=1: the module has no threads and JSPI needs no
//     cross-origin isolation (the dev server run_web.mjs sends none either);
//   - GET /__stats answers the live transfer census (requests, bytes by
//     encoding, slices, base64, per path); stats=<file> also writes it every
//     5 s and at exit. port=0 picks a free port; the URL is printed.
import { createServer } from 'node:http';
import { statSync, existsSync, readFileSync, openSync, readSync, closeSync, createReadStream, writeFileSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';

const argv = process.argv.slice(2);
if (!argv[0] || argv[0] === '-h' || argv[0] === '--help') {
  console.log('usage: node serve_dist.mjs <dist> [port=8200] [host=127.0.0.1] [stats=<file>] [coi=0] [quiet=1]');
  process.exit(2);
}
const DIST = resolve(argv[0]);
const kv = Object.fromEntries(argv.slice(1).filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const positionalPort = argv.slice(1).find((a) => /^\d+$/.test(a));
const PORT = Number(kv.port ?? positionalPort ?? 8200);
const HOST = kv.host || '127.0.0.1';
const STATS_FILE = kv.stats || '';
const COI = (kv.coi || '0') !== '0';
const QUIET = (kv.quiet || '1') !== '0';
if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  console.log(`serve_dist: ${DIST} is not a directory (build one with: python scripts/recomp/assets/ship.py build)`);
  process.exit(2);
}

// dist.json: the sha256 of every file (ETags, the ?v= immutable rule) and the totals for the banner
let manifest = null, manifestMtime = -1, hashes = new Map();
// Round 45: re-read when dist.json changes. A dist rebuilt under a running
// server kept serving the old hashes, so the page's fresh ?v= never matched
// and the module went out `no-cache` instead of immutable -- the browser's
// HTTP cache and the wasm code cache both key on that.
function refreshManifest() {
  try {
    const st = statSync(join(DIST, 'dist.json'));
    if (st.mtimeMs === manifestMtime) return;
    manifest = JSON.parse(readFileSync(join(DIST, 'dist.json'), 'utf8'));
    manifestMtime = st.mtimeMs;
    hashes = new Map((manifest?.files || []).map((f) => [f.path, f.sha256]));
  } catch { manifest = null; hashes = new Map(); manifestMtime = -1; }
}
refreshManifest();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};
const typeOf = (file) => TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const stats = {
  started: new Date().toISOString(), dist: DIST, requests: 0, notFound: 0, notModified: 0,
  bytes: { identity: 0, gzip: 0, br: 0 },           // on the wire, by Content-Encoding
  rawBytes: 0,                                       // the logical bytes those stood for
  slices: { requests: 0, bytes: 0 }, b64: { requests: 0, bytes: 0 }, ranges: { requests: 0, bytes: 0 },
  byPath: {},
};
let statsDirty = false;
function account(rel, encoding, wire, raw, kind) {
  stats.bytes[encoding] += wire;
  stats.rawBytes += raw;
  const p = stats.byPath[rel] || (stats.byPath[rel] = { requests: 0, wire: 0, raw: 0 });
  p.requests += 1; p.wire += wire; p.raw += raw;
  if (kind) { stats[kind].requests += 1; stats[kind].bytes += wire; }
  statsDirty = true;
}
function writeStats() {
  if (!STATS_FILE || !statsDirty) return;
  stats.wireTotal = stats.bytes.identity + stats.bytes.gzip + stats.bytes.br;
  try { writeFileSync(STATS_FILE, JSON.stringify(stats, null, 1) + '\n'); statsDirty = false; } catch { /* best effort */ }
}
function summary() {
  const wire = stats.bytes.identity + stats.bytes.gzip + stats.bytes.br;
  return `${stats.requests} requests, ${stats.notFound} not found, ${stats.notModified} not modified; ` +
    `${wire.toLocaleString()} bytes on the wire (identity ${stats.bytes.identity.toLocaleString()}, gzip ${stats.bytes.gzip.toLocaleString()}, ` +
    `br ${stats.bytes.br.toLocaleString()}) for ${stats.rawBytes.toLocaleString()} raw; slices ${stats.slices.requests} / ${stats.slices.bytes.toLocaleString()} bytes, ` +
    `b64 ${stats.b64.requests}, ranges ${stats.ranges.requests}`;
}

// a request path -> a file under DIST, or null (traversal, odd segments)
function safeResolve(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes('\0')) return null;
  const parts = rel.split('/').filter((p) => p.length);
  if (parts.some((p) => p === '..' || /[\\:]/.test(p))) return null;
  if (!parts.length) parts.push('play.html');
  const file = join(DIST, ...parts);
  if (file !== DIST && !file.startsWith(DIST + sep)) return null;
  return { rel: parts.join('/'), file };
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const suffix = Number(m[2]); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return { bad: true };
  return { start, end };
}

let notFoundPrinted = 0;
const server = createServer((req, res) => {
  refreshManifest();
  stats.requests += 1;
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__stats') {
    stats.wireTotal = stats.bytes.identity + stats.bytes.gzip + stats.bytes.br;
    const body = Buffer.from(JSON.stringify(stats, null, 1));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 }); res.end(); return;
  }
  const r = safeResolve(u.pathname);
  let st = null;
  if (r) { try { st = statSync(r.file); } catch { st = null; } }
  if (!r || !st || !st.isFile()) {
    stats.notFound += 1;
    if (notFoundPrinted < 20) { notFoundPrinted += 1; console.log(`[serve_dist] 404 ${u.pathname}`); }
    const body = 'not found';
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  const { rel, file } = r;
  const size = st.size;
  const q = u.searchParams;
  const b64 = q.get('b64') === '1';
  const sliced = q.has('off');
  const hash = hashes.get(rel);
  const v = q.get('v');
  const immutable = !!(v && hash && hash.startsWith(v));
  const etag = hash ? `"${hash.slice(0, 32)}"` : `W/"${size}-${Math.floor(st.mtimeMs)}"`;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': immutable ? IMMUTABLE : 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': b64 ? 'text/plain; charset=utf-8' : typeOf(file),
  };
  if (COI) { headers['Cross-Origin-Opener-Policy'] = 'same-origin'; headers['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    stats.notModified += 1;
    res.writeHead(304, headers); res.end(); return;
  }
  const head = req.method === 'HEAD';
  const log = (status, enc, n) => { if (!QUIET) console.log(`[serve_dist] ${req.method} ${u.pathname}${u.search} ${status} ${enc} ${n}`); };

  // ?off=&len=: a positional read of the raw file, never the whole archive (boot_web.mjs isaacLazyPread)
  if (sliced) {
    const off = Math.max(0, Number(q.get('off')) || 0);
    const len = Math.max(0, Number(q.get('len')) || 0);
    const n = Math.max(0, Math.min(len, size - off));
    let body = Buffer.alloc(n);
    if (n) {
      const fd = openSync(file, 'r');
      try { const got = readSync(fd, body, 0, n, off); body = body.subarray(0, got); } finally { closeSync(fd); }
    }
    const raw = body.length;
    if (b64) body = Buffer.from(body.toString('base64'), 'ascii');
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    if (!head) { account(rel, 'identity', body.length, raw, b64 ? 'b64' : 'slices'); log(200, 'identity slice', body.length); }
    res.end(head ? undefined : body);
    return;
  }
  // ?b64=1 on a whole file: base64 text of the raw bytes
  if (b64) {
    const bytes = readFileSync(file);
    const body = Buffer.from(bytes.toString('base64'), 'ascii');
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    if (!head) { account(rel, 'identity', body.length, bytes.length, 'b64'); log(200, 'identity b64', body.length); }
    res.end(head ? undefined : body);
    return;
  }
  // Range: a 206 of the raw file
  if (req.headers.range) {
    const range = parseRange(req.headers.range, size);
    if (!range || range.bad) {
      headers['Content-Range'] = `bytes */${size}`; headers['Content-Length'] = 0;
      res.writeHead(416, headers); res.end(); return;
    }
    const n = range.end - range.start + 1;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = n;
    res.writeHead(206, headers);
    if (head) { res.end(); return; }
    let sent = 0;
    const s = createReadStream(file, { start: range.start, end: range.end });
    s.on('data', (c) => { sent += c.length; });
    s.on('close', () => { account(rel, 'identity', sent, sent, 'ranges'); log(206, 'identity range', sent); });
    s.pipe(res);
    return;
  }
  // a whole file: the best precompressed sibling the client accepts, else the raw bytes
  const accept = String(req.headers['accept-encoding'] || '');
  let encoding = 'identity', source = file, wire = size;
  for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
    if (!new RegExp(`(^|[,\\s])${enc}(\\s*;|\\s*,|\\s*$)`).test(accept)) continue;
    let ss = null;
    try { ss = statSync(file + suffix); } catch { ss = null; }
    if (ss && ss.isFile()) { encoding = enc; source = file + suffix; wire = ss.size; break; }
  }
  headers['Content-Length'] = wire;
  if (encoding !== 'identity') headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  if (head) { res.end(); return; }
  let sent = 0;
  const s = createReadStream(source);
  s.on('data', (c) => { sent += c.length; });
  s.on('close', () => { account(rel, encoding, sent, sent === wire ? size : Math.round(size * sent / Math.max(1, wire)), null); log(200, encoding, sent); });
  s.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
  s.pipe(res);
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const t = manifest?.totals;
  console.log(`serve_dist: http://${HOST}:${port}/  (${DIST})`);
  if (t) console.log(`  dist.json: ${t.files} files, ${t.bytes.toLocaleString()} bytes raw, ${t.transfer.toLocaleString()} bytes with the best encoding, ${t.siblings.files} sibling(s)`);
  else console.log('  no dist.json here: weak ETags, nothing immutable (a dist built by ship.py has one)');
  console.log(`  play: http://${HOST}:${port}/play.html   stats: http://${HOST}:${port}/__stats${STATS_FILE ? `  (also written to ${STATS_FILE})` : ''}`);
  console.log(`  ${COI ? 'COOP/COEP on' : 'no COOP/COEP (the module has no threads)'}; Ctrl+C to stop`);
});
server.on('error', (e) => { console.log(`serve_dist: ${e.message}`); process.exit(1); });
const timer = setInterval(writeStats, 5000);
timer.unref();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { statsDirty = true; writeStats(); console.log(`\n[serve_dist] ${summary()}`); process.exit(0); });
}
