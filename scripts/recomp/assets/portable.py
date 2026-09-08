#!/usr/bin/env python3
"""Portable builds of the shipping dist: one page that carries the game.

Two shapes:

  chunks   a small page plus the payload in a handful of large files, so it can be
           served from any static host -- a GitHub repo through jsDelivr, an object
           store, a directory. The payload is split by how it is read, not by size:

             part A   the module, the memory image and the archives the boot seeds
                      whole. Always read entire, so each piece is stored gzipped and
                      fetched whole (the module alone is 49 MB raw, 7 MB gzipped).
             part B   the four archives the engine reads as 1 MiB windows. Stored
                      raw in a few large chunks and read with HTTP range requests,
                      so a window costs a window however big the chunk is.

           If a host ignores the range and sends the whole chunk the page notices
           (200 rather than 206), slices it itself and stops asking for ranges.

  offline  one .html with the whole payload inline as base64 and no network at all.
           The pieces are small there because the count costs nothing, and they are
           spread over several scripts: V8 will not compile a source longer than
           about 512 MB and says nothing when it declines.

Neither build changes the engine or the module: the page takes its bytes from
`window.isaacPortable` instead of a server (play.mjs, round 70).

usage:
  portable.py chunks  <dist> <out-dir> [--base URL] [--chunks 12] [--skip videos.a]
  portable.py offline <dist> <out.html>             [--piece-mib 8] [--skip videos.a]
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import re
import shutil
import sys

MIB = 1 << 20
PAGE = "play.html"
TOP_FILES = ("boot.wasm", "isaac.segs.bin", "boot-trail.json")
MODULES = ("boot.mjs", "boot_web.mjs", "menu_overlay.mjs", "zip.mjs", "mods.mjs", "play.mjs")
# the archives the engine reads as 1 MiB windows (boot_web.mjs LAZY_ARCHIVES)
WINDOWED = ("resources/packed/music.a", "resources/packed/videos.a",
            "resources/packed/afterbirth.a", "resources/packed/afterbirthp.a")
SCRIPT_BYTES = 48 << 20        # one inline script's worth of base64
WINDOW = MIB                   # the engine's window, and the range granularity


def keystream_key(seed: bytes) -> bytes:
    """A 256-byte table from a build seed. Not a cipher: a way to stop a chunk on
    a CDN from announcing what it is."""
    import hashlib
    out = bytearray()
    h = seed
    while len(out) < 256:
        h = hashlib.sha256(h).digest()
        out += h
    return bytes(out[:256])


def catalogue_script(args) -> str:
    """Round 81: where the mod browser looks.

    `createModsMenu` offers the MOD BROWSER row only when it has a catalogue base,
    which it takes from `?catalogue=` or from `window.isaacModCatalogue`. A built
    page had neither, so the row was never there -- the browser worked and was
    unreachable. `--catalogue` writes the second one in.
    """
    url = getattr(args, "catalogue", None)
    if not url:
        return ""
    return "<script>window.isaacModCatalogue = %s;</script>\n" % json.dumps(url.rstrip("/"))


def scramble(data: bytes, pos: int, key: bytes) -> bytes:
    """XOR `data`, which starts at `pos` in its stream. Reversible from any
    offset, which a range read needs."""
    if not key:
        return data
    out = bytearray(data)
    for i in range(len(out)):
        at = pos + i
        out[i] ^= key[at & 0xFF] ^ ((at >> 8) & 0xFF)
    return bytes(out)


def minify_js(src: str) -> str:
    """Comments and the whitespace between tokens, gone. Nothing renamed.

    A mode stack rather than a regex or a counter: `//` inside a string is not a
    comment, a `/` after a value is division and after an operator is a regular
    expression, and a template substitution may contain an object literal, a
    string with a brace in it, or another template. Counting braces gets that
    wrong; a stack does not.
    """
    ID = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$")
    VALUE_END = ID | set(")]}\"'`")          # after one of these, `/` is division
    out = []
    stack = []                                # 'tpl' = inside a template, 'sub' = inside its ${}
    i, n = 0, len(src)
    prev = ""

    def emit(text, last=None):
        out.append(text)
        return last if last is not None else (text[-1] if text else prev)

    while i < n:
        c = src[i]
        # inside a template literal, everything is verbatim until ` or ${
        if stack and stack[-1] == "tpl":
            if c == "\\":
                prev = emit(src[i:i + 2], "`"); i += 2; continue
            if c == "`":
                stack.pop(); prev = emit(c, "`"); i += 1; continue
            if c == "$" and src[i + 1:i + 2] == "{":
                stack.append("sub"); prev = emit("${", "{"); i += 2; continue
            prev = emit(c, "`"); i += 1; continue
        two = src[i:i + 2]
        if two == "//":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if two == "/*":
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "\"'":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == c:
                    break
                j += 1
            prev = emit(src[i:j + 1], c); i = j + 1; continue
        if c == "`":
            stack.append("tpl"); prev = emit(c, "`"); i += 1; continue
        if c == "}" and stack and stack[-1] == "sub":
            stack.pop(); prev = emit("}", "}"); i += 1; continue
        if c == "/":
            if prev in VALUE_END:
                prev = emit(c); i += 1; continue
            j, cls = i + 1, False
            while j < n:
                if src[j] == "\\":
                    j += 2; continue
                if src[j] == "[":
                    cls = True
                elif src[j] == "]":
                    cls = False
                elif src[j] == "/" and not cls:
                    break
                elif src[j] == "\n":
                    break
                j += 1
            while j + 1 < n and src[j + 1] in "gimsuyd":
                j += 1
            prev = emit(src[i:j + 1], "/"); i = j + 1; continue
        if c in " \t\r\n":
            j = i
            while j < n and src[j] in " \t\r\n":
                j += 1
            nxt = src[j] if j < n else ""
            if prev in ID and nxt in ID:
                out.append(" ")
            elif "\n" in src[i:j] and prev and nxt and prev not in "{(,;=+-*/%&|!?:<>~^[" and nxt not in "})],;.=+*/%&|?:<>":
                out.append("\n")
            i = j
            continue
        prev = emit(c); i += 1
    return "".join(out)


def human(n: int) -> str:
    return "%.1f MB" % (n / 1048576.0) if n >= 1048576 else "%.1f KB" % (n / 1024.0)


def read(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def plan(dist: str, skip: set[str]) -> list[dict]:
    """Every payload file the page can ask for, keyed by the engine's own name.

    play.mjs strips the `instance/` prefix off a pipeline URL before it asks, so the
    key is `resources/packed/x.a`; dist.json's own path is kept beside it.
    """
    out = []
    for rel in TOP_FILES:
        p = os.path.join(dist, rel)
        if os.path.isfile(p):
            out.append({"rel": rel, "path": p, "size": os.path.getsize(p), "dist": rel})
    index = json.loads(read(os.path.join(dist, "instance_index.json")).decode("utf-8"))
    for e in index:
        if os.path.basename(e["p"]) in skip:
            continue
        p = os.path.join(dist, "instance", e["p"].replace("/", os.sep))
        if os.path.isfile(p):
            out.append({"rel": e["p"], "path": p, "size": os.path.getsize(p),
                        "dist": "instance/" + e["p"], "instance": e["p"]})
    # The menus' own art. ship.py keeps page-assets out of the index on purpose,
    # because the pipeline must not seed the page's files into the guest file
    # system -- but the page still asks for them by name through readAsset, and a
    # build without them has menus that open onto nothing.
    assets = os.path.join(dist, "instance", "page-assets")
    have = {f["rel"] for f in out}
    if os.path.isdir(assets):
        for name in sorted(os.listdir(assets)):
            q = os.path.join(assets, name)
            rel = "page-assets/" + name
            if os.path.isfile(q) and rel not in have:
                out.append({"rel": rel, "path": q, "size": os.path.getsize(q),
                            "dist": "instance/" + rel, "instance": rel})
    return out


def split_parts(files: list[dict]) -> tuple[list[dict], list[dict]]:
    """(read whole, read as windows)."""
    return ([f for f in files if f["rel"] not in WINDOWED],
            [f for f in files if f["rel"] in WINDOWED])


def lay_out(part: list[dict], table: dict, stream: int, align: int = 1) -> int:
    """Give every file its offset in `stream`'s byte run. Returns the run's length.

    A windowed file is aligned to the window, so a 1 MiB read at a 1 MiB offset is
    always inside one chunk and can be fetched as a plain range. The padding is under
    3 MB across the four archives.
    """
    at = 0
    for f in part:
        if align > 1 and at % align:
            at += align - (at % align)
        f["at"] = at
        table[f["rel"]] = {"size": f["size"], "s": stream, "at": at}
        at += f["size"]
    return at


def cut(part: list[dict], size: int, emit) -> int:
    """Walk the part's byte run and hand it out `size` bytes at a time."""
    buf, n = bytearray(), 0
    at = 0
    for f in part:
        if "at" in f and f["at"] > at:                 # the alignment gap, as zeroes
            buf += b"\0" * (f["at"] - at)
            at = f["at"]
        with open(f["path"], "rb") as fh:
            while True:
                b = fh.read(1 << 20)
                if not b:
                    break
                buf += b
                at += len(b)
                while len(buf) >= size:
                    emit(n, bytes(buf[:size])); n += 1
                    del buf[:size]
    if buf:
        emit(n, bytes(buf)); n += 1
    return n


class WindowPacker:
    """Round 89: a chunk whose windows are each compressed on their own.

    The ranged half shipped raw because a window is a byte range inside a large
    chunk and a range cannot be taken out of a deflate stream. Compressing each
    1 MiB window SEPARATELY keeps both properties: the chunk still holds a whole
    number of windows and still rebuilds to exactly the bytes it used to hold,
    and a single window is still one contiguous range -- just a shorter one.

    What the page needs is the length of each compressed window, in order; every
    offset follows from that. `z` says which of them are really compressed: a
    window of Theora or Vorbis gives back 100.0% of what it is handed, so it is
    stored as it is rather than paying an inflate on every read for nothing.
    """

    def __init__(self, per_chunk: int, key: bytes, out_dir: str, tag: str, gzfn):
        self.per_chunk = per_chunk
        self.key = key
        self.out_dir = out_dir
        self.tag = tag
        self.gzfn = gzfn
        self.lens: list[int] = []          # compressed length of every window, in order
        self.flags: list[str] = []         # '1' where that window really is compressed
        self.chunks = 0
        self._buf = bytearray()
        self._in_chunk = 0
        self._phys = 0                     # where this chunk starts in the stored stream
        self.written = 0

    def add(self, _i: int, window: bytes) -> None:
        packed = self.gzfn(window)
        use = len(packed) <= len(window) - (len(window) >> 6)     # at least 1.6% off
        body = packed if use else window
        self.lens.append(len(body))
        self.flags.append("1" if use else "0")
        self._buf += body
        self._in_chunk += 1
        if self._in_chunk == self.per_chunk:
            self.flush()

    def flush(self) -> None:
        if not self._buf:
            return
        body = scramble(bytes(self._buf), self._phys, self.key)
        with open(os.path.join(self.out_dir, "%s%d.bin" % (self.tag, self.chunks)), "wb") as f:
            f.write(body)
        self.written += len(body)
        self._phys += len(self._buf)
        self._buf = bytearray()
        self._in_chunk = 0
        self.chunks += 1


def index_for(dist: str, files: list[dict]) -> list[dict]:
    have = {f["instance"] for f in files if "instance" in f}
    index = json.loads(read(os.path.join(dist, "instance_index.json")).decode("utf-8"))
    return [e for e in index if e["p"] in have]


def _strip_local(node):
    """Anything that names where this was built, gone.

    dist.json records the directories it was assembled from -- the bundle, the
    module, the segs, the web sources -- as absolute paths. Those are useful in
    a build log and have no business in a page served to the public: they carry
    the account name of whoever ran the build. This drops the `sources` block
    and any remaining absolute path, wherever it sits.
    """
    if isinstance(node, dict):
        return {k: _strip_local(v) for k, v in node.items()
                if k not in ("sources", "dir", "root", "cwd", "out")}
    if isinstance(node, list):
        return [_strip_local(v) for v in node]
    if isinstance(node, str) and re.match(r"^(?:[A-Za-z]:[\\/]|[\\/]{1,2}[^\\/])", node):
        return os.path.basename(node.replace("\\", "/").rstrip("/")) or "(path)"
    return node


def manifest_for(dist: str, files: list[dict]) -> dict:
    try:
        m = json.loads(read(os.path.join(dist, "dist.json")).decode("utf-8"))
    except Exception:
        m = {}
    keep = {f["dist"] for f in files}
    m["files"] = [f for f in (m.get("files") or []) if f.get("path") in keep]
    return _strip_local(m)


def page_source(dist: str) -> str:
    return read(os.path.join(dist, PAGE)).decode("utf-8")


PROVIDER_JS = r"""
(function () {
  var P = window.__isaacPortableData;
  var S = P.streams;                                  // one per byte run: {tag,size,gz}
  var WIN = 1048576;                                  // the engine's window (FS_WIN), and the read granularity
  var cache = new Map(), inline = P.blobs || null, ranges = true;
  // Round 89f: this Map had no ceiling. Every chunk it held was a rebuilt
  // ~19.9 MB array and nothing ever left, so a session that saw the payload sat
  // on 631 MB of JS heap -- measured, and a forced GC did not move it. It is an
  // LRU with a byte budget now. Evicting is safe whenever: a caller has already
  // awaited its chunk and copies out of it, and the array lives as long as that
  // reference does, whether or not the Map still names it.
  var CACHE_MAX = 160 * 1048576, cacheBytes = 0;
  function remember(key, u) {
    var old = cache.get(key);
    if (old) { cache.delete(key); cacheBytes -= old.length; }
    cache.set(key, u); cacheBytes += u.length;
    while (cacheBytes > CACHE_MAX && cache.size > 1) {
      var oldest = cache.keys().next().value;
      if (oldest === key) break;                    // never the one just put in
      cacheBytes -= cache.get(oldest).length;
      cache.delete(oldest);
    }
    return u;
  }
  // a hit moves the chunk to the young end, which is what makes it an LRU
  function touch(key) {
    var v = cache.get(key);
    if (v !== undefined) { cache.delete(key); cache.set(key, v); }
    return v;
  }
  // round 77: the chunks are XORed with a seekable keystream so a file on a CDN
  // is not a recognisable archive. Reversible from any offset, which is what a
  // range read needs. The key is in this page, as it has to be.
  var KEY = P.key ? (function () {
    var b = atob(P.key), a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  })() : null;
  function unscramble(bytes, pos) {
    if (!KEY) return bytes;
    for (var i = 0; i < bytes.length; i++) {
      var at = pos + i;
      bytes[i] ^= KEY[at & 255] ^ ((at >> 8) & 255);
    }
    return bytes;
  }
  var loaded = Object.create(null), loadedN = 0;
  // Round 89d: the bar counts what the first frame is waiting for. That used to
  // be every chunk; now it is the ones the boot trail names, and the ones that
  // come down afterwards must not push the count past its own total or keep
  // writing "loading 21 / 32" over the status line while the game is running.
  var awaiting = 0, quiet = false;
  function note(s, i) {
    var k = s + ':' + i;
    if (loaded[k]) return;
    loaded[k] = 1; loadedN += 1;
    if (quiet || !P.onChunk) return;
    var tot = awaiting || P.chunks || 0;
    try { P.onChunk(Math.min(loadedN, tot), tot); } catch (e) { /* the readout is decoration */ }
  }
  function decode(b) {
    return (typeof Uint8Array.fromBase64 === 'function')
      ? Uint8Array.fromBase64(b)
      : (function () { var s = atob(b), a = new Uint8Array(s.length); for (var k = 0; k < s.length; k++) a[k] = s.charCodeAt(k); return a; })();
  }
  // the pieces a read of [a,b) in stream s touches
  function span(s, a, b) {
    var st = S[s], parts = [], o = 0;
    for (var pos = a; pos < b;) {
      var i = Math.floor(pos / st.size), within = pos % st.size;
      var take = Math.min(st.size - within, b - pos);
      parts.push({ s: s, i: i, within: within, take: take, at: o });
      o += take; pos += take;
    }
    return parts;
  }
  // the token comes from the chunk's own bytes, so a chunk that changed has a
  // URL that changed and a browser holding the old one under a week-long
  // max-age cannot splice it into this build (round 86d)
  function name(s, i) {
    var v = S[s].v && S[s].v[i];
    return P.base + '/' + S[s].tag + i + '.bin' + (v ? '?v=' + v : '');
  }
  // Is chunk i of stream s actually compressed? A stream may be gzipped and
  // still hold raw chunks: a window of Theora or Vorbis gives nothing back, so
  // it is stored as it is and costs no inflate here (round 89). Without the
  // per-chunk mark the whole stream is compressed, which is what part A is.
  function packed(s, i) {
    if (!S[s].gz) return false;
    var z = S[s].z;
    return z ? z.charAt(i) === '1' : true;
  }
  // Round 89: a window-compressed stream. `wl` is the stored length of every
  // window in order, so every offset follows from a prefix sum; `wz` says which
  // of them really are compressed. The chunk still holds a whole number of
  // windows and still rebuilds to the bytes it always held.
  var WOFF = null;
  function woff(s) {
    if (WOFF) return WOFF;
    var wl = S[s].wl, a = new Array(wl.length + 1);
    a[0] = 0;
    for (var k = 0; k < wl.length; k++) a[k + 1] = a[k] + wl[k];
    WOFF = a;
    return a;
  }
  function perChunk(s) { return S[s].size / S[s].win; }
  async function inflate(bytes) {
    return new Uint8Array(await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  // one window, from its own stored bytes
  async function window1(s, k, stored) {
    return S[s].wz.charAt(k) === '1' ? await inflate(stored) : stored;
  }
  // a whole chunk, rebuilt from the windows it holds
  async function rebuild(s, i, stored) {
    var off = woff(s), per = perChunk(s), base = i * per;
    var first = off[base], parts = [], total = 0;
    for (var k = base; k < off.length - 1 && k < base + per; k++) {
      var b = stored.subarray(off[k] - first, off[k + 1] - first);
      var w = await window1(s, k, b);
      parts.push(w); total += w.length;
    }
    var out = new Uint8Array(total), at = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], at); at += parts[j].length; }
    return out;
  }
  // Round 89d: two callers can want the same chunk at once now -- the boot
  // reading it and the background prefetch pulling it -- and each was a whole
  // 19 MB GET of its own. One request, both waiters.
  var flight = new Map();
  // `pre` marks a call made by the streamer rather than by a read. The
  // difference matters only to the pacing below: a chunk nobody has read yet is
  // what the streamer is not allowed to pile up.
  function piece(s, i, pre) {
    var key = s + ':' + i, hit = touch(key);
    if (hit) { if (!pre) markRead(key); return Promise.resolve(hit); }
    var busy = flight.get(key);
    if (busy) return pre ? busy : busy.then(function (u) { markRead(key); return u; });
    var pr = piece1(s, i);
    flight.set(key, pr);
    pr = pr.then(function (u) { flight.delete(key); return u; },
                 function (e) { flight.delete(key); throw e; });
    if (pre) { pr.then(function () { markUnread(key); }, function () {}); return pr; }
    return pr.then(function (u) { markRead(key); return u; });
  }
  // How far the streamer may run ahead of the reader. Chunks it has fetched
  // that nothing has read yet are the only ones that MUST stay resident, so
  // this number, times ~19.9 MB, is what running ahead costs.
  var AHEAD = 4, HEAD_ARCHIVE = 3;
  var unread = Object.create(null), unreadN = 0, waiting = [];
  function markUnread(k) { if (!unread[k]) { unread[k] = 1; unreadN += 1; } }
  function markRead(k) {
    if (!unread[k]) return;
    delete unread[k]; unreadN -= 1;
    var w = waiting; waiting = [];
    for (var j = 0; j < w.length; j++) w[j]();
  }
  // resolves when there is room to fetch another, or after a second regardless:
  // the trail is the LAST boot's reads and this one may not want all of them,
  // in which case nothing would ever mark them read and the stream would stop.
  function room() {
    if (unreadN < AHEAD) return Promise.resolve();
    return new Promise(function (res) {
      var done = false;
      var go = function () { if (!done) { done = true; res(); } };
      waiting.push(go);
      setTimeout(go, 1000);
    });
  }
  async function piece1(s, i) {
    var key = s + ':' + i;
    var r = await fetch(name(s, i));
    if (!r.ok) throw new Error('piece ' + key + ': HTTP ' + r.status);
    note(s, i);
    var at = S[s].wl ? woff(s)[i * perChunk(s)] : i * S[s].size;
    var raw = unscramble(new Uint8Array(await r.arrayBuffer()), at);
    var u = S[s].wl ? await rebuild(s, i, raw)
      : (packed(s, i)
        ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
        : raw);
    remember(key, u);
    return u;
  }
  // where a read lands when the chunk's windows are compressed one by one:
  // which window, how far into it, and where that window is stored
  function inWindow(p) {
    var st = S[p.s];
    if (!st.wl) return null;
    var per = perChunk(p.s), k = p.i * per + Math.floor(p.within / st.win);
    var at = p.within % st.win;
    if (at + p.take > st.win) return null;          // straddles two windows
    var off = woff(p.s), base = off[p.i * per];
    return { k: k, at: at, from: off[k] - base, to: off[k + 1] - base - 1, abs: off[k] };
  }
  async function ranged(p) {
    // a window is a byte range inside a large chunk, so the chunk's size costs
    // nothing; a host that ignores Range answers 200 and we slice it ourselves
    if (!ranges) return (await piece(p.s, p.i)).subarray(p.within, p.within + p.take);
    var w = inWindow(p);
    if (w) {
      var rw = await fetch(name(p.s, p.i), { headers: { Range: 'bytes=' + w.from + '-' + w.to } });
      if (!rw.ok) throw new Error('range ' + p.s + ':' + p.i + ': HTTP ' + rw.status);
      note(p.s, p.i);
      var stored = unscramble(new Uint8Array(await rw.arrayBuffer()), w.abs);
      var win = await window1(p.s, w.k, stored);
      return win.subarray(w.at, w.at + p.take);
    }
    var r = await fetch(name(p.s, p.i), { headers: { Range: 'bytes=' + p.within + '-' + (p.within + p.take - 1) } });
    if (!r.ok) throw new Error('range ' + p.s + ':' + p.i + ': HTTP ' + r.status);
    var u = new Uint8Array(await r.arrayBuffer());
    note(p.s, p.i);
    // the total the host puts in Content-Range has to be the chunk's length: on a
    // host that answers ranges with the wrong bytes that is the only tell, and the
    // length of the answer is right even when its contents are not
    var claim = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
    var told = claim ? Number(claim[1]) : -1;
    var mine = chunkLen(p.s, p.i);
    if (r.status === 206 && u.length === p.take && (mine < 0 || told === mine)) {
      return unscramble(u, p.i * S[p.s].size + p.within);
    }
    // Round 83: the answer is not the window that was asked for. A host that
    // ignores Range sends the whole chunk (200, the chunk's length) and that can
    // be sliced; one that answers 206 with the wrong bytes cannot, and slicing it
    // returned nothing -- and left that short buffer in the cache under the
    // chunk's key, so every later window in the chunk came back empty too.
    ranges = false;
    var whole = chunkLen(p.s, p.i);
    if (r.status === 200 && whole >= 0 && u.length === whole) {
      u = unscramble(u, p.i * S[p.s].size);
      remember(p.s + ':' + p.i, u);
      return u.subarray(p.within, p.within + p.take);
    }
    if (cache.has(p.s + ':' + p.i)) { cacheBytes -= cache.get(p.s + ':' + p.i).length; cache.delete(p.s + ':' + p.i); }
    return (await piece(p.s, p.i)).subarray(p.within, p.within + p.take);
  }
  async function gather(parts) {
    var total = parts.reduce(function (n, p) { return n + p.take; }, 0);
    var out = new Uint8Array(total), next = 0;
    async function worker() {
      for (;;) {
        var k = next++;
        if (k >= parts.length) return;
        var p = parts[k];
        var bytes = S[p.s].gz ? (await piece(p.s, p.i)).subarray(p.within, p.within + p.take) : await ranged(p);
        out.set(bytes, p.at);
      }
    }
    var crew = [];
    for (var w = 0; w < Math.min(6, parts.length); w++) crew.push(worker());
    await Promise.all(crew);
    return out;
  }
  function locate(rel, off, len) {
    var f = P.files[rel];
    if (!f) return null;
    var end = len ? Math.min(off + len, f.size) : f.size;
    return span(f.s, f.at + off, f.at + end);
  }
  // How long chunk i of stream s is on disk. Only meaningful for a raw stream:
  // a gzipped one is compressed per chunk and its length is not arithmetic.
  function chunkLen(s, i) {
    var st = S[s];
    if (st.wl) {                       // stored length: the windows it holds
      var off = woff(s), per = perChunk(s);
      var a = i * per, b = Math.min(off.length - 1, a + per);
      return off[b] - off[a];
    }
    if (st.gz || typeof st.bytes !== 'number') return -1;
    var left = st.bytes - i * st.size;
    return left > st.size ? st.size : left;
  }
  // Round 78: one question before any window is handed out as a range, and it has
  // to be a question a lying host fails. A host that ignores Range answers with a
  // whole chunk, which the old probe (206 and two bytes) caught. jsDelivr does
  // worse: it answers 206 with a Content-Range, then returns bytes from the wrong
  // offset (4 bytes early at 1 MiB; unrelated at 5 MiB) and claims a total 37
  // bytes over the file. A prefix length check passes. The page already knows
  // how long the chunk is, so the probe requires that the total in Content-Range
  // equals that length. Missing the header, or a mismatch, drops to whole GETs,
  // which are exact on that host.
  // Round 89d: a probe is only worth asking where the answer holds. Measured on
  // this project's CDN: every ranged read comes back FOUR bytes short of what
  // was asked for -- 64 -> 60, 65536 -> 65532, every chunk, wrong bytes -- and
  // half an hour later, from another edge, the same probe returns its 64 bytes
  // and the right Content-Range total and passes. A pass therefore says nothing
  // about the read that follows it, and the run pays for that discovery in the
  // middle of a room. Where the host is known to do this, do not ask.
  var NO_RANGES = /(^|\.)jsdelivr\.net$/i;
  function hostOf(u) {
    try { return new URL(u, typeof location !== 'undefined' ? location.href : undefined).hostname; }
    catch (e) { return ''; }
  }
  // ?noranges=1 forces the whole-chunk path, which is what the CDN build runs.
  // Without it that path can only be tested by deploying, and it is the half
  // that the trail-driven prefetch lives in.
  function forcedOff() {
    try { return new URLSearchParams(location.search).get('noranges') === '1'; }
    catch (e) { return false; }
  }
  async function probeRanges() {
    if (!P.base) return false;
    if (forcedOff()) { ranges = false; P.rangesWhy = 'ranges turned off by ?noranges=1'; return false; }
    if (NO_RANGES.test(hostOf(P.base))) {
      ranges = false;
      P.rangesWhy = 'this CDN answers ranges four bytes short, and not every time (rounds 84, 89d)';
      return false;
    }
    var b = S.findIndex(function (st) { return !st.gz; });
    if (b < 0) return false;
    // Round 84: four chunks, not one. jsDelivr answers a range with the wrong
    // bytes and a total a few dozen over the file -- and not consistently: the
    // same chunk gave the right total an hour before it gave a wrong one. One
    // question is a coin toss; every one of these has to come back right.
    var n = count(b), picks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]
      .filter(function (v, i, a) { return v >= 0 && v < n && a.indexOf(v) === i; });
    try {
      for (var k = 0; k < picks.length; k++) {
        var i = picks[k], want = chunkLen(b, i);
        if (want < 0) { ranges = false; P.rangesWhy = 'chunk length unknown'; return false; }
        // 1 KiB, not 64 bytes: the deficit that gave this away was four bytes,
        // and a 64-byte answer that is four short still looks like a plausible
        // read. The bigger ask costs nothing and fails louder.
        var r = await fetch(name(b, i), { headers: { Range: 'bytes=0-1023' } });
        if (r.status !== 206) { ranges = false; P.rangesWhy = 'the host answered ' + r.status + ' for a range'; return false; }
        var head = new Uint8Array(await r.arrayBuffer());
        var cr = r.headers.get('content-range') || '';
        var total = /\/(\d+)\s*$/.exec(cr);
        var claimed = total ? Number(total[1]) : -1;
        if (head.length !== 1024 || claimed !== want) {
          ranges = false;
          P.rangesWhy = 'chunk ' + i + ': a 1024-byte range came back as ' + head.length + ' byte(s)'
            + (claimed >= 0 ? ' and the host calls that file ' + claimed + ' bytes, not ' + want : ' with no Content-Range total');
          return false;
        }
        // and the same bytes have to come back from a range that merely
        // overlaps them. A host serving from the wrong offset answers both
        // with the right LENGTH and disagrees with itself about the contents.
        var r2 = await fetch(name(b, i), { headers: { Range: 'bytes=512-1535' } });
        if (r2.status !== 206) { ranges = false; P.rangesWhy = 'the host answered ' + r2.status + ' for the second range'; return false; }
        var mid = new Uint8Array(await r2.arrayBuffer());
        if (mid.length !== 1024) {
          ranges = false;
          P.rangesWhy = 'chunk ' + i + ': an overlapping 1024-byte range came back as ' + mid.length + ' byte(s)';
          return false;
        }
        for (var q = 0; q < 512; q++) {
          if (mid[q] !== head[512 + q]) {
            ranges = false;
            P.rangesWhy = 'chunk ' + i + ': two ranges over the same bytes disagree at ' + (512 + q);
            return false;
          }
        }
      }
      ranges = true;
    } catch (e) { ranges = false; P.rangesWhy = e.message; }
    return ranges;
  }
  function count(s) {
    var st = S[s];
    if (typeof st.n === 'number') return st.n;
    if (typeof st.bytes === 'number' && st.size) return Math.ceil(st.bytes / st.size);
    return 0;
  }
  // When ranges cannot be trusted every window is a whole GET of a 19 MB piece,
  // so the pieces are pulled up front rather than one per stall in a room.
  function fetchList(jobs, width, paced) {
    var next = 0;
    async function worker() {
      for (;;) {
        var k = next++;
        if (k >= jobs.length) return;
        // paced: never hold more than AHEAD chunks nothing has read yet
        if (paced) await room();
        try { await piece(jobs[k][0], jobs[k][1], paced); } catch (e) { /* a later read asks again */ }
      }
    }
    var crew = [], w;
    for (w = 0; w < Math.min(width, jobs.length); w++) crew.push(worker());
    return Promise.all(crew);
  }
  // Which chunks the boot itself reads. The trail is the list of reads the last
  // boot made, in order, and the layout puts them near each other -- so this is
  // a real subset, not a formality: 15 chunks of 28 on the build that added it.
  function trailChunks() {
    var t = P.trail;
    if (!t || !t.length || !P.files) return null;
    var need = [], seen = {}, j, i;
    // Part A first, whatever the trail says. It is read whole, it holds the
    // module, and nothing runs until it is here -- it must not be queued behind
    // the archive at the background width.
    for (j = 0; j < S.length; j++) {
      if (!S[j].gz || S[j].size <= WIN) continue;
      for (i = 0; i < count(j); i++) { seen[j + ':' + i] = 1; need.push([j, i]); }
    }
    for (j = 0; j < t.length; j++) {
      var f = P.files[t[j][0]];
      if (!f) continue;
      var st = S[f.s];
      if (!st || st.size <= WIN) continue;
      var a = f.at + t[j][1], b = a + t[j][2] - 1;
      for (i = Math.floor(a / st.size); i <= Math.floor(b / st.size); i++) {
        var k = f.s + ':' + i;
        if (!seen[k] && i < count(f.s)) { seen[k] = 1; need.push([f.s, i]); }
      }
    }
    return need.length ? { need: need, seen: seen } : null;
  }
  // Round 89d: this used to pull every chunk before the first frame -- 532 MB
  // of stream b to serve the 175 MB the boot actually reads. The trail says
  // which 285 MB of that the boot will touch; those are what the first frame
  // waits for. The rest is what a run might later wander into, and it comes
  // down behind the game rather than in front of it.
  async function prefetchAll() {
    var all = [], s, i, n;
    for (s = 0; s < S.length; s++) {
      // Round 89: a stream whose piece IS a window has nothing to amortise -- a
      // whole GET costs exactly what the read wanted. Pulling all of those
      // would fetch the entire payload to serve the ~180 windows a boot
      // touches: measured at 724 MB against 175.
      if (S[s].size <= WIN) continue;
      n = count(s);
      for (i = 0; i < n; i++) all.push([s, i]);
    }
    var t = trailChunks();
    if (!t) { await fetchList(all, 6); return null; }
    var rest = [];
    for (i = 0; i < all.length; i++) if (!t.seen[all[i][0] + ':' + all[i][1]]) rest.push(all[i]);

    // Round 89f: 89d had the first frame wait for all 19 trail chunks, which is
    // 380 MB that has to be RESIDENT at once because nothing has read any of it
    // yet -- half of the 631 MB heap this build was measured holding. The boot
    // does not need them all at once; it needs them in order, a little ahead of
    // where it is reading. So only the head is waited on -- part A, because the
    // module is in it and nothing runs otherwise, and the first few archive
    // chunks so the early reads hit -- and the remainder streams behind the
    // reader, never more than AHEAD chunks in front of it.
    var head = [], tail = [];
    for (i = 0; i < t.need.length; i++) {
      var st = S[t.need[i][0]];
      if (st.gz || head.length < HEAD_ARCHIVE + partACount()) head.push(t.need[i]);
      else tail.push(t.need[i]);
    }
    P.prefetch = { head: head.length, stream: tail.length, rest: rest.length, of: all.length };
    awaiting = head.length;
    await fetchList(head, 6);
    // the wait is over: say so once, then stop talking. What follows is not
    // something the player is waiting on and must not read as loading.
    if (P.onChunk) { try { P.onChunk(awaiting, awaiting); } catch (e) { /* decoration */ } }
    quiet = true;
    return function (which) {
      // the trail's remainder feeds the boot and starts at once; the chunks no
      // boot reads are for a run that wanders, and wait for an idle moment
      if (which === 'stream') return tail.length ? fetchList(tail, 3, true) : Promise.resolve();
      return rest.length ? fetchList(rest, 2, true) : Promise.resolve();
    };
  }
  function partACount() {
    var n = 0;
    for (var j = 0; j < S.length; j++) if (S[j].gz && S[j].size > WIN) n += count(j);
    return n;
  }
  window.isaacPortable = {
    manifest: P.manifest,
    index: P.index,
    trail: P.trail || null,
    status: P.status,
    ready: (async function () {
      // Round 84: only a build that fetches. The single-file build carries its
      // payload inline and has no base, and prefetching it asked the page for
      // `null/a0.bin` -- eight of those, no frames, a build that did not run.
      if (!P.base) return ranges;
      await probeRanges();
      // Pull the pieces the boot reads before the engine starts. jsDelivr's
      // ranges lie, so a window is a 19 MB GET; doing that mid-room is the
      // freeze. What the boot does NOT read follows it down in the background.
      var more = await prefetchAll();
      if (more) {
        // the rest of the boot's own chunks, behind the reader and paced
        more('stream');
        // Round 89d: and the ones no boot reads not before the game is up.
        // Between ready and the first frame the module still has to compile and
        // the engine still has to mount its archives, and a 19 MB GET with
        // nineteen window inflates behind it takes main-thread time in the
        // middle of exactly that -- a white screen for as long as it lasts.
        // requestIdleCallback fires once the frame loop is yielding, which is
        // the game running; the timeout is the backstop for a page that never
        // goes idle.
        var later = function () { more('rest'); };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(later, { timeout: 60000 });
        else setTimeout(later, 20000);
      }
      return ranges;
    })(),
    ranges: function () { return ranges; },
    prefetch: function () { return P.prefetch || null; },
    key: KEY,
    chunks: P.chunks || 0,
    rangesWhy: function () { return P.rangesWhy || null; },
    loaded: function () { return loadedN; },
    // a window inside one raw chunk is a URL with the range in its fragment; the
    // reader Worker strips it and sends a Range header (boot_web.mjs)
    urlFor: P.base ? function (rel, off, len) {
      if (!len) return null;
      var parts = locate(rel, off, len);
      if (!parts || parts.length !== 1) return null;
      var p = parts[0];
      // Round 89: a gzipped chunk is one window, so there is no range to ask
      // for -- the Worker takes the whole file, unscrambles it from the chunk's
      // own start, gunzips, and cuts the slice the read wanted. `@pos` is what
      // the keystream needs; the range before it is inside the WINDOW, not
      // inside the chunk, which is why this is a different fragment from #r=.
      if (S[p.s].gz) return null;   // part A is read whole by the page itself
      if (!ranges) return null;
      // Round 89: the window's own stored bytes are a range like any other --
      // shorter, and the Worker unwraps them. `!z` says whether this particular
      // window is compressed at all, and `*at-take` is the cut inside it.
      if (S[p.s].wl) {
        var w = P.workerWindows ? inWindow(p) : null;
        if (w) {
          return name(p.s, p.i) + '#w=' + w.from + '-' + w.to + '@' + w.abs
            + '!' + (S[p.s].wz.charAt(w.k) === '1' ? 1 : 0)
            + '*' + w.at + '-' + p.take;
        }
        return null;              // the bytes path rebuilds the chunk instead
      }
      // the range rides in the fragment, which no server sees; `@pos` after it is
      // where those bytes start in the stream, which is what unscrambles them
      // `!len` is the chunk's own length: the Worker has nothing else to check a
      // Content-Range against, and on this host that check is the whole defence
      return name(p.s, p.i) + '#r=' + p.within + '-' + (p.within + p.take - 1)
        + '@' + (p.i * S[p.s].size + p.within) + '!' + chunkLen(p.s, p.i);
    } : null,
    bytesFor: P.base
      ? function (rel, off, len) { var p = locate(rel, off, len); return p ? gather(p) : null; }
      : function (rel, off, len) {
          var parts = locate(rel, off, len);
          if (!parts) return null;
          var total = parts.reduce(function (n, q) { return n + q.take; }, 0);
          var out = new Uint8Array(total);
          for (var k = 0; k < parts.length; k++) {
            var q = parts[k], key = q.s + ':' + q.i, u = cache.get(key);
            if (!u) { u = decode(inline[S[q.s].first + q.i]); cache.set(key, u); if (cache.size > 24) cache.delete(cache.keys().next().value); }
            out.set(u.subarray(q.within, q.within + q.take), q.at);
          }
          return out;
        },
  };
})();
"""

MODULE_LOADER_JS = r"""
(function () {
  // The page's modules import each other by relative path. Inline, each one is a
  // blob URL, and a blob's imports do not resolve relative to the page -- so the
  // sources are rewritten to import from the map before they are turned into blobs.
  var src = window.__isaacModules, url = {};
  var order = ['boot.mjs', 'menu_overlay.mjs', 'zip.mjs', 'mods.mjs', 'boot_web.mjs', 'play.mjs'];
  for (var i = 0; i < order.length; i++) {
    var name = order[i];
    var text = src[name].replace(/(["'])\.\/([A-Za-z0-9_.-]+\.mjs)\1/g, function (_m, _q, dep) {
      return JSON.stringify(url[dep] || './' + dep);
    });
    url[name] = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  }
  var s = document.createElement('script');
  s.type = 'module';
  s.src = url['play.mjs'];
  document.body.appendChild(s);
})();
"""


def inject(html: str, head: str) -> str:
    i = html.index('<script type="module"')
    return html[:i] + head + "\n" + html[i:]


def inject_at_end(html: str, tail: str) -> str:
    i = html.rindex("</body>")
    return html[:i] + tail + "\n" + html[i:]


def cmd_chunks(args) -> int:
    files = plan(args.dist, set(args.skip or []))
    whole, windowed = split_parts(files)
    table = {}
    a_len = lay_out(whole, table, 0)
    b_len = lay_out(windowed, table, 1, WINDOW)
    out_dir = os.path.abspath(args.out)
    data_dir = os.path.join(out_dir, "c")
    os.makedirs(data_dir, exist_ok=True)
    if not args.html_only:
        for old in os.listdir(data_dir):
            os.remove(os.path.join(data_dir, old))

    # part A is fetched whole, so its pieces may be gzipped; part B is read by
    # range, so its chunks stay raw. The counts land on `--chunks` between them.
    a_pieces = max(1, min(max(1, args.chunks // 4), 4))
    b_pieces = max(1, args.chunks - a_pieces)
    a_size = ((a_len + a_pieces - 1) // a_pieces + MIB - 1) // MIB * MIB
    b_size = ((b_len + b_pieces - 1) // b_pieces + WINDOW - 1) // WINDOW * WINDOW
    if args.part_mib:
        # Round 78: cut part B to a fixed size instead of to a file count. At 1 the
        # chunk IS the window, so nothing is ever fetched by range and a host whose
        # ranges cannot be trusted -- jsDelivr answers them with the wrong bytes --
        # costs nothing extra. The price is a lot of files.
        b_size = max(WINDOW, args.part_mib * MIB // WINDOW * WINDOW)
    # Round 89: a chunk that IS one window can be compressed, because the reader
    # takes it whole and never asks for a range inside it. That is worth 19.3 MB
    # over the ranged half -- the archives are deflate inside, but the windows
    # still hold 5% they never had a chance to remove, and the engine's own
    # inflate is not involved: this layer is unwrapped before the engine sees a
    # byte. It is only offered when the chunk is exactly a window, because a
    # bigger compressed chunk could not be entered at an offset.
    # The chunk keeps its size and its logical contents; only the way it is
    # stored changes, so the file count does not move.
    b_wingz = bool(args.window_gz)
    b_gz = False
    written = [0]

    # Round 80: the seed is the two stream lengths, so a build that adds one file
    # to part A re-scrambles part B as well -- half a gigabyte of chunks that
    # differ only in their keystream. --key-b64 takes the key off an earlier
    # build's page instead: part B is then byte for byte what is already
    # uploaded, and only the chunks whose contents really moved need sending
    # again. `chunks --key-of <index.html>` reads it out of one.
    if args.plain:
        key = b""
    elif args.key_b64:
        key = base64.b64decode(args.key_b64)
        if len(key) != 256:
            raise SystemExit("--key-b64: expected 256 bytes, got %d" % len(key))
    else:
        key = keystream_key(
            ("isaac-portable/%d/%d/%d" % (a_len, b_len, args.chunks)).encode("ascii"))

    # Round 88: zopfli emits a gzip stream any decoder reads -- the page still
    # calls DecompressionStream('gzip') and nothing about the runtime changes --
    # it just spends much longer choosing the encoding. Measured on the module,
    # the largest thing in part A: 10.98 -> 10.55 MB, 3.9%, for 282 s. Across
    # part A that is ~0.55 MB for about six minutes of build, which is why it is
    # a flag and not the default.
    def _gzip(b):
        if not args.zopfli:
            return gzip.compress(b, 9, mtime=0)
        try:
            import zopfli.gzip
        except ImportError:
            raise SystemExit("--zopfli needs the zopfli package (pip install zopfli)")
        return zopfli.gzip.compress(b)

    # Round 89: which chunks of a compressed stream actually ARE compressed. A
    # window of Theora or Vorbis gives back 100.0% of what it is handed, so
    # compressing it buys nothing and costs an inflate on every read of it --
    # about 150 MB of the payload is exactly that. Such a window is stored raw
    # and marked here, rather than sniffed at read time: a raw window can begin
    # with the gzip magic by chance, and 522 windows make that a 1-in-125 bet.
    zflag = {}

    def emit_for(tag, gz, size):
        def emit(i, b):
            body = b
            if gz:
                packed = _gzip(b)
                if len(packed) <= len(b) - (len(b) >> 6):      # at least 1.6% off
                    body = packed
                zflag.setdefault(tag, []).append(1 if body is not b else 0)
            body = scramble(body, i * size, key)
            with open(os.path.join(data_dir, "%s%d.bin" % (tag, i)), "wb") as f:
                f.write(body)
            written[0] += len(body)
        return emit

    if args.html_only:
        n_a = (a_len + a_size - 1) // a_size
        n_b = (b_len + b_size - 1) // b_size
        written[0] = sum(os.path.getsize(os.path.join(data_dir, n))
                         for n in os.listdir(data_dir) if n.endswith(".bin"))
    else:
        n_a = cut(whole, a_size, emit_for("a", True, a_size))
        if b_wingz:
            packer = WindowPacker(b_size // WINDOW, key, data_dir, "b", _gzip)
            cut(windowed, WINDOW, packer.add)
            packer.flush()
            n_b = packer.chunks
            written[0] += packer.written
        else:
            n_b = cut(windowed, b_size, emit_for("b", b_gz, b_size))
    # Round 86d: a token per chunk, from that chunk's own bytes, which rides in
    # its URL. jsDelivr answers these with `max-age=604800`, so a returning
    # visitor keeps chunks for a week -- and a rebuild that changes only part A
    # leaves that visitor splicing new chunks onto cached old ones. The module
    # spans four of them, and a spliced module is not a module:
    #   WebAssembly.instantiate(): size 8760567 > maximum function size 7654321
    # A per-chunk token (not one per build) is what makes this cheap: a chunk
    # whose bytes did not change keeps its URL and stays cached, so a module-only
    # rebuild re-fetches the four part-A chunks and none of the other 29.
    def chunk_tokens(tag, count):
        out = []
        for i in range(count):
            p = os.path.join(data_dir, "%s%d.bin" % (tag, i))
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
            out.append(h.hexdigest()[:8])
        return out

    streams = [{"tag": "a", "size": a_size, "gz": True, "n": n_a, "bytes": a_len,
                "v": chunk_tokens("a", n_a)},
               {"tag": "b", "size": b_size, "gz": b_gz, "n": n_b, "bytes": b_len,
                "v": chunk_tokens("b", n_b)}]
    # a compressed stream carries which of its chunks really are compressed
    for st in streams:
        if st["gz"] and zflag.get(st["tag"]):
            st["z"] = "".join(str(x) for x in zflag[st["tag"]])
    # a window-compressed stream carries the length of every window instead: the
    # chunk still holds `size / WINDOW` of them and still rebuilds to the same
    # bytes, so nothing else about the layout moves
    if b_wingz and not args.html_only:
        streams[1]["wl"] = packer.lens
        streams[1]["wz"] = "".join(packer.flags)
        streams[1]["win"] = WINDOW
    data = {"streams": streams, "files": table, "base": args.base or "./c",
            "index": index_for(args.dist, files), "manifest": manifest_for(args.dist, files),
            "chunks": n_a + n_b, "status": "loading"}
    if key:
        data["key"] = base64.b64encode(key).decode("ascii")
    # the boot trail is small and boot_web.mjs asks for it by name: inline it so the
    # page needs nothing beside itself
    trail = os.path.join(args.dist, "boot-trail.json")
    if os.path.isfile(trail):
        data["trail"] = json.loads(read(trail).decode("utf-8"))
    head = ('<script>window.__isaacPortableData = ' + json.dumps(data, separators=(",", ":")) + ';</script>\n'
            + catalogue_script(args) +
            '<script>' + PROVIDER_JS + '</script>')
    mods = {rel: read(os.path.join(args.dist, rel)).decode("utf-8") for rel in MODULES}
    if not args.plain:
        before = sum(len(v) for v in mods.values())
        mods = {k: minify_js(v) for k, v in mods.items()}
        after = sum(len(v) for v in mods.values())
        print("  modules minified: %s -> %s" % (human(before), human(after)))
    tail = ('\n<script>window.__isaacModules = ' + json.dumps(mods) + ';</script>\n'
            '<script>' + MODULE_LOADER_JS + '</script>')
    html = page_source(args.dist).replace('<script type="module" src="./play.mjs"></script>', "")
    html = inject_at_end(inject_at_end(html, head), tail)
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    raw = a_len + b_len
    print("chunks: %d files in %s (%s on disk, %s raw)" % (n_a + n_b, data_dir, human(written[0]), human(raw)))
    print("  read whole, gzipped : %d x %s  (%s)" % (n_a, human(a_size), human(a_len)))
    print("  read by range, raw  : %d x %s  (%s)" % (n_b, human(b_size), human(b_len)))
    print("  page %s (%s) -- the modules and the boot trail are in it, nothing else is needed"
          % (os.path.join(out_dir, "index.html"), human(len(html.encode("utf-8")))))
    print("  base URL: %s" % data["base"])
    if n_a + n_b > 64:
        print("  %d files: no range is needed at this size, which suits a host whose ranges cannot be trusted"
              % (n_a + n_b))
    print("  %s" % ("plain: the chunks are the payload as it is"
                    if args.plain else "the chunks are scrambled and the page is minified"))
    if max(a_size, b_size) > 20 * MIB:
        print("  note: jsDelivr refuses a file over 20 MB; --chunks %d keeps every piece under it"
              % ((raw + 20 * MIB - 1) // (20 * MIB) + 2))
    return 0


def cmd_offline(args) -> int:
    files = plan(args.dist, set(args.skip or []))
    whole, windowed = split_parts(files)
    table = {}
    a_len = lay_out(whole, table, 0)
    b_len = lay_out(windowed, table, 1, WINDOW)
    piece = args.piece_mib * MIB
    blobs = []

    def emit(_i, b):
        blobs.append(base64.b64encode(b).decode("ascii"))

    n_a = cut(whole, piece, emit)
    n_b = cut(windowed, piece, emit)
    streams = [{"tag": "a", "size": piece, "gz": False, "n": n_a, "first": 0},
               {"tag": "b", "size": piece, "gz": False, "n": n_b, "first": n_a}]
    data = {"streams": streams, "files": table, "base": None,
            "index": index_for(args.dist, files), "manifest": manifest_for(args.dist, files),
            "status": "loading"}
    parts = ['<script>window.__isaacPortableData = ' + json.dumps(data, separators=(",", ":")) + ';',
             'window.__isaacPortableData.blobs = [];</script>\n', catalogue_script(args)]
    state = {"budget": 0, "group": [], "groups": 0}

    def flush():
        if not state["group"]:
            return
        parts.append('<script>window.__isaacPortableData.blobs.push('
                     + ",".join('"%s"' % x for x in state["group"]) + ');</script>\n')
        state["groups"] += 1
        state["budget"], state["group"] = 0, []

    for b in blobs:
        state["group"].append(b)
        state["budget"] += len(b) + 3
        if state["budget"] >= SCRIPT_BYTES:
            flush()
    flush()
    parts.append('<script>' + PROVIDER_JS + '</script>')
    mods = {rel: read(os.path.join(args.dist, rel)).decode("utf-8") for rel in MODULES}
    parts.append('\n<script>window.__isaacModules = ' + json.dumps(mods) + ';</script>\n'
                 '<script>' + MODULE_LOADER_JS + '</script>')
    html = page_source(args.dist).replace('<script type="module" src="./play.mjs"></script>', "")
    html = inject_at_end(html, "".join(parts))
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("offline: %s (%s), %s of payload in %d pieces across %d scripts"
          % (out, human(os.path.getsize(out)), human(a_len + b_len), n_a + n_b, state["groups"]))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("chunks")
    p.add_argument("dist"); p.add_argument("out")
    p.add_argument("--chunks", type=int, default=12, help="how many files the payload becomes (default 12)")
    p.add_argument("--base", help="where the chunks will be served from (default ./c)")
    p.add_argument("--skip", nargs="*", help="archive file names to leave out")
    p.add_argument("--part-mib", type=int, default=0,
                   help="size of each windowed chunk in MiB instead of a file count; 1 makes a chunk "
                        "one window, so no byte range is ever needed (for hosts whose ranges lie)")
    p.add_argument("--plain", action="store_true",
                   help="leave the chunks as they are and the page readable (the default scrambles both)")
    p.add_argument("--html-only", action="store_true",
                   help="rewrite the page without touching the chunk files (the probe, not the payload)")
    p.add_argument("--window-gz", action="store_true",
                   help="compress the ranged half too, one chunk per window (needs --part-mib 1). "
                        "The reader takes such a chunk whole, so it can be gzipped like part A: "
                        "-19.3 MB, and no byte range is ever asked for (round 89)")
    p.add_argument("--zopfli", action="store_true",
                   help="compress the whole-read chunks with zopfli instead of gzip -9 -- the same "
                        "gzip format the page already decodes, ~0.55 MB smaller, ~6 minutes slower "
                        "to build (round 88)")
    p.add_argument("--key-b64", help="scramble with this key instead of one derived from the sizes, so "
                                     "chunks that did not change keep the bytes already uploaded")
    p.add_argument("--key-of", help="take --key-b64 out of an earlier build's index.html")
    p.add_argument("--catalogue", help="where modpack.py's catalogue is served from; without one the "
                                       "page offers no MOD BROWSER row")
    p.set_defaults(fn=cmd_chunks)
    p = sub.add_parser("offline")
    p.add_argument("dist"); p.add_argument("out")
    p.add_argument("--piece-mib", type=int, default=8, help="inline piece size (the count costs nothing here)")
    p.add_argument("--skip", nargs="*", help="archive file names to leave out")
    p.add_argument("--catalogue", help="where modpack.py's catalogue is served from; without one the "
                                       "page offers no MOD BROWSER row")
    p.set_defaults(fn=cmd_offline)
    args = ap.parse_args(argv)
    if getattr(args, "key_of", None) and not args.key_b64:
        page = read(args.key_of).decode("utf-8", "replace")
        m = re.search(r'window\.__isaacPortableData\s*=\s*(\{.*?\});', page, re.S)
        if not m:
            raise SystemExit("--key-of: %s carries no portable data" % args.key_of)
        args.key_b64 = json.loads(m.group(1)).get("key")
        if not args.key_b64:
            raise SystemExit("--key-of: %s was built --plain, it has no key" % args.key_of)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
