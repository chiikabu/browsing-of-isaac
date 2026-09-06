#!/usr/bin/env python3
"""KAGE packed-archive ("ARCH000") library + CLI for the Isaac recomp.

Everything here is a re-implementation of what the engine does at mount and
at entry-open time, read off the binary (VAs refer to tools/isaac-ng.unpacked.exe):

  mount loop        0x00a179c0   header, table, per-entry checksum, hash-table insert
  entry stream      0x00a68a50   ctor: picks the codec from the archive version byte
                    0x00a68c50   init: raw-mode XOR seed (h2 ^ 0xf9524287) | 1, seek to offset
                    0x00a68cf0   refill_buffer: v1 LZW piece, v2 MiniZ piece, v5 static key, else raw XOR
                    0x00a69510   read(buf, elem, count): copies from the 0x400 decoded window
  LZW (version 1)   0x00a850f0 init, 0x00a85320 decode piece, 0x00a85020 emit, 0x00a85090 bit reader
  MiniZ (version 2) 0x00a89c90 init (tinfl state + ISAAC keystream seeded from h2),
                    0x00a89f80 piece: stored switch + tinfl_decompress (0x00a85710), 0x00a89d70 keystream XOR
  keystream         0x00aa93e0 PCG32 fill of randrsl from the seed, 0x00aa9580 ISAAC randinit(TRUE),
                    0x00aa94a0 isaac() regeneration

File layout: 7 bytes "ARCH000", u8 version, u32 table offset, u16 count; entry payloads follow
from offset 14 in table order; the table (count x {u32 h1, u32 h2, u32 offset, u32 size, u32 x})
sits at the table offset, at the end of the file.

  h1 = djb2 (0x1505; h*33 + c), h2 = FNV-1a variant (0x5bb2220e; (h ^ c) * 0x1000193), both over
       "resources/<path>" with ASCII upper-case folded to lower and '\\' folded to '/'.
  size = DECODED byte count; x = the mount checksum of the decoded bytes (see mount_checksum).

Payload encodings, by archive version byte:
  0  raw XOR: dword i is XORed with key_i (key_0 = (h2 ^ 0xf9524287) | 1, xorshift 8/9/23 per
     dword) then byte-permuted by key_i & 0xf (2: reverse, 9: swap pairs, 13: swap halves).
     Entry payloads are padded to a multiple of 4 bytes.
  1  LZW: pieces of u32 len + len bytes (len <= 0x7ff), each decoding to 0x400 bytes (last one
     shorter); variable-width MSB-first codes, 8..12 bits, table reset at 0xfff codes; the code
     table persists across pieces, the bit reader restarts per piece. Decode only.
  2  MiniZ: pieces of u32 (len | final << 31) + len bytes (len <= 0x7ff). While not "stored", a
     non-final piece of exactly 0x400 bytes switches the rest of the entry to stored mode
     (memcpy + ISAAC keystream XOR); other pieces are raw deflate fed to ONE persistent tinfl
     state with a 0x400-byte circular output window, so the packer full-flushes per 0x400 block.

Nothing binary-derived is embedded here: the constants above are read off the code, not the
assets.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import zlib
from dataclasses import dataclass

MAGIC = b"ARCH000"
HEADER_SIZE = 14
TABLE_RECORD = struct.Struct("<IIIII")
MASK32 = 0xFFFFFFFF
CHECKSUM_INIT = 0xABABEB98
RAW_XOR_CONST = 0xF9524287
PIECE_MAX = 0x7FF
BLOCK = 0x400
CHUNK = 0x200
RESOURCE_PREFIX = "resources/"

try:  # optional fast path for the v0 codec
    import numpy as _np  # type: ignore
except Exception:  # pragma: no cover - numpy is optional
    _np = None


# ---------------------------------------------------------------------------
# hashes (mount key)
# ---------------------------------------------------------------------------

def fold_byte(c: int) -> int:
    if 65 <= c <= 90:
        c += 32
    if c == 92:
        c = 47
    return c


def djb2(path: str) -> int:
    h = 0x1505
    for c in path.encode("utf-8"):
        h = (h * 33 + fold_byte(c)) & MASK32
    return h


def fnv1a(path: str) -> int:
    h = 0x5BB2220E
    for c in path.encode("utf-8"):
        h = ((h ^ fold_byte(c)) * 0x1000193) & MASK32
    return h


def key_of(path: str) -> tuple[int, int]:
    """The (h1, h2) pair of an archive key. `path` is the full key, e.g. 'resources/gfx/x.png'."""
    return djb2(path), fnv1a(path)


def resource_key(rel: str) -> str:
    """'gfx/x.png' or 'resources/gfx/x.png' -> 'resources/gfx/x.png' (the key the engine hashes)."""
    rel = rel.replace("\\", "/").lstrip("./")
    if rel.lower().startswith(RESOURCE_PREFIX):
        return rel
    return RESOURCE_PREFIX + rel


# ---------------------------------------------------------------------------
# mount checksum (0x00a17cee..0x00a17d8b)
# ---------------------------------------------------------------------------

def mount_checksum(data: bytes) -> int:
    """The fold the mount loop compares against the table's x.

    h = 0xababeb98; per little-endian u32: h = rotr1(h) + u32. The loop reads the DECODED entry
    in 0x200-byte chunks into one stack buffer that is zeroed ONCE per entry and sums
    ceil(got/4) dwords of it, so the tail bytes of a final partial dword are whatever the
    previous chunk left at those positions (zeros when the entry is shorter than 0x200).
    """
    h = CHECKSUM_INIT
    size = len(data)
    buf = bytearray(CHUNK)
    pos = 0
    remaining = size
    while True:
        want = remaining if remaining < CHUNK else CHUNK
        got = want if pos + want <= size else max(size - pos, 0)
        if got:
            buf[:got] = data[pos:pos + got]
        ndw = (got + 3) >> 2
        if ndw:
            for d in memoryview(buf)[:ndw * 4].cast("I"):
                h = (((h >> 1) | ((h & 1) << 31)) + d) & MASK32
        remaining -= want
        pos += want
        if not (remaining > 0 and got == want):
            break
    return h


# ---------------------------------------------------------------------------
# version 0: raw XOR + byte permutation
# ---------------------------------------------------------------------------

def raw_keys(h2: int, ndw: int) -> list[int]:
    k = ((h2 ^ RAW_XOR_CONST) | 1) & MASK32
    keys = [0] * ndw
    for i in range(ndw):
        keys[i] = k
        k ^= (k << 8) & MASK32
        k ^= k >> 9
        k ^= (k << 23) & MASK32
    return keys


def _permute(buf: bytearray, keys: list[int]) -> None:
    """Apply the per-dword byte permutation in place (it is an involution)."""
    if _np is not None and len(keys) >= 64:
        a = _np.frombuffer(buf, dtype=_np.uint8).reshape(-1, 4)
        sel = _np.fromiter((k & 0xF for k in keys), dtype=_np.uint8, count=len(keys))
        idx = _np.nonzero(sel == 2)[0]
        if idx.size:
            a[idx] = a[idx][:, ::-1]
        idx = _np.nonzero(sel == 9)[0]
        if idx.size:
            a[idx] = a[idx][:, [1, 0, 3, 2]]
        idx = _np.nonzero(sel == 13)[0]
        if idx.size:
            a[idx] = a[idx][:, [2, 3, 0, 1]]
        return
    for i, k in enumerate(keys):
        sel = k & 0xF
        if sel == 2:
            o = i * 4
            buf[o:o + 4] = buf[o:o + 4][::-1]
        elif sel == 9:
            o = i * 4
            b = buf[o:o + 4]
            buf[o:o + 4] = bytes((b[1], b[0], b[3], b[2]))
        elif sel == 13:
            o = i * 4
            b = buf[o:o + 4]
            buf[o:o + 4] = bytes((b[2], b[3], b[0], b[1]))


def _xor_keystream(buf: bytes, keys: list[int]) -> bytearray:
    ks = struct.pack("<%dI" % len(keys), *keys)
    n = len(buf)
    x = int.from_bytes(buf, "little") ^ int.from_bytes(ks[:n], "little")
    return bytearray(x.to_bytes(n, "little"))


def raw_decode(raw: bytes, h2: int, size: int) -> bytes:
    """raw: the padded payload (multiple of 4 bytes). Returns the first `size` decoded bytes."""
    if len(raw) % 4:
        raise ValueError("raw payload is not a multiple of 4 bytes")
    ndw = len(raw) // 4
    if ndw == 0:
        return b""
    keys = raw_keys(h2, ndw)
    out = _xor_keystream(raw, keys)
    _permute(out, keys)
    return bytes(out[:size])


def raw_encode(data: bytes, h2: int) -> bytes:
    """Inverse of raw_decode: zero-pad to 4, permute, XOR. Returns the padded payload."""
    pad = (-len(data)) % 4
    buf = bytearray(data) + b"\0" * pad
    ndw = len(buf) // 4
    if ndw == 0:
        return b""
    keys = raw_keys(h2, ndw)
    _permute(buf, keys)
    return bytes(_xor_keystream(bytes(buf), keys))


# ---------------------------------------------------------------------------
# ISAAC keystream (version 2 stored pieces)
# ---------------------------------------------------------------------------

class IsaacKeystream:
    """0x00aa93e0: randrsl[i] = PCG32 outputs from the seed; then ISAAC randinit(TRUE) + isaac();
    0x00a89d70 consumes randrsl[0..255] one u32 per 4 bytes (low byte first), regenerating with
    isaac() (0x00aa94a0) when the 256 words are used up."""

    MULT = 0x5851F42D4C957F2D
    INC = 0x7F

    def __init__(self, seed: int) -> None:
        seed &= MASK32
        low = ((((seed << 15) ^ seed) << 8) ^ (seed >> 9) ^ seed) & MASK32
        state = (seed << 32) | low
        rsl = [0] * 256
        for i in range(256):
            xs = ((state ^ (state >> 18)) >> 27) & MASK32
            rot = state >> 59
            rsl[i] = ((xs >> rot) | (xs << ((32 - rot) & 31))) & MASK32
            state = (state * self.MULT + self.INC) & 0xFFFFFFFFFFFFFFFF
        self.rsl = rsl
        self.mm = [0] * 256
        self.aa = self.bb = self.cc = 0
        self._randinit()
        self.idx = 0

    @staticmethod
    def _mix(v: list[int]) -> None:
        a, b, c, d, e, f, g, h = v
        a ^= (b << 11) & MASK32; d = (d + a) & MASK32; b = (b + c) & MASK32
        b ^= c >> 2;              e = (e + b) & MASK32; c = (c + d) & MASK32
        c ^= (d << 8) & MASK32;   f = (f + c) & MASK32; d = (d + e) & MASK32
        d ^= e >> 16;             g = (g + d) & MASK32; e = (e + f) & MASK32
        e ^= (f << 10) & MASK32;  h = (h + e) & MASK32; f = (f + g) & MASK32
        f ^= g >> 4;              a = (a + f) & MASK32; g = (g + h) & MASK32
        g ^= (h << 8) & MASK32;   b = (b + g) & MASK32; h = (h + a) & MASK32
        h ^= a >> 9;              c = (c + h) & MASK32; a = (a + b) & MASK32
        v[:] = [a, b, c, d, e, f, g, h]

    def _randinit(self) -> None:
        v = [0x9E3779B9] * 8
        for _ in range(4):
            self._mix(v)
        for src in (self.rsl, self.mm):
            for i in range(0, 256, 8):
                for j in range(8):
                    v[j] = (v[j] + src[i + j]) & MASK32
                self._mix(v)
                self.mm[i:i + 8] = v
        self.isaac()

    def isaac(self) -> None:
        mm, rsl = self.mm, self.rsl
        aa, bb = self.aa, self.bb
        self.cc = (self.cc + 1) & MASK32
        bb = (bb + self.cc) & MASK32
        for i in range(256):
            x = mm[i]
            s = i & 3
            if s == 0:
                aa ^= (aa << 13) & MASK32
            elif s == 1:
                aa ^= aa >> 6
            elif s == 2:
                aa ^= (aa << 2) & MASK32
            else:
                aa ^= aa >> 16
            aa = (aa + mm[(i + 128) & 0xFF]) & MASK32
            y = (mm[(x >> 2) & 0xFF] + aa + bb) & MASK32
            mm[i] = y
            bb = (mm[(y >> 10) & 0xFF] + x) & MASK32
            rsl[i] = bb
        self.aa, self.bb = aa, bb

    def apply(self, data: bytes) -> bytes:
        """XOR `data` with the keystream exactly as one 0x00a89d70 call would."""
        n = len(data)
        if n == 0:
            return b""
        words = []
        need = (n + 3) >> 2
        while need:
            take = min(need, 256 - self.idx)
            words.extend(self.rsl[self.idx:self.idx + take])
            self.idx += take
            need -= take
            if self.idx > 0xFF:
                self.isaac()
                self.idx = 0
        ks = struct.pack("<%dI" % len(words), *words)[:n]
        return (int.from_bytes(data, "little") ^ int.from_bytes(ks, "little")).to_bytes(n, "little")


# ---------------------------------------------------------------------------
# version 2: MiniZ pieces
# ---------------------------------------------------------------------------

class PieceError(ValueError):
    pass


def iter_pieces(buf: bytes, offset: int, size: int):
    """Yield (payload, final, next_offset) for the ceil(size / 0x400) pieces starting at offset."""
    pos = offset
    n = (size + BLOCK - 1) // BLOCK
    for _ in range(n):
        if pos + 4 > len(buf):
            raise PieceError("piece header past end of archive")
        hdr, = struct.unpack_from("<I", buf, pos)
        ln = hdr & 0x7FFFFFFF
        fin = hdr >> 31
        if ln > PIECE_MAX:
            raise PieceError("piece length %d > 0x7ff" % ln)
        pos += 4
        yield buf[pos:pos + ln], fin, pos + ln
        pos += ln


def miniz_decode(buf: bytes, offset: int, size: int, h2: int) -> tuple[bytes, int]:
    """Decode a version-2 entry. Returns (data, raw_length)."""
    out = bytearray()
    d = zlib.decompressobj(-15)
    stored = False
    ks = None
    end = offset
    for payload, fin, end in iter_pieces(buf, offset, size):
        if not stored:
            stored = (fin == 0 and len(payload) == BLOCK)
        if stored:
            if ks is None:
                ks = IsaacKeystream(h2)
            out += ks.apply(payload)
        else:
            out += d.decompress(payload)
    if len(out) < size:
        raise PieceError("decoded %d bytes, table says %d" % (len(out), size))
    return bytes(out[:size]), end - offset


def _deflate_piece(block: bytes, final: bool, level: int, strategy: int = zlib.Z_DEFAULT_STRATEGY) -> bytes:
    c = zlib.compressobj(level, zlib.DEFLATED, -15, 8, strategy)
    return c.compress(block) + c.flush(zlib.Z_FINISH if final else zlib.Z_FULL_FLUSH)


def _piece_ok(piece: bytes, final: bool) -> bool:
    """A piece the format can carry: under 0x7ff, and not a full 0x400 non-final
    block (which is how the reader is told the rest of the entry is stored)."""
    return len(piece) <= PIECE_MAX and (final or len(piece) != BLOCK)


def _best_piece(block: bytes, final: bool, level: int, fixed_cost: int | None) -> bytes:
    """Round 75: static Huffman when it costs at most `fixed_cost` bytes.

    Dynamic Huffman spends a header and, in the decoder, a table build per 0x400
    block; static spends neither and gives a few bytes back. `fixed_cost` is how
    many bytes a block may grow to stop paying for a table -- None keeps the
    dynamic choice zlib would have made on its own."""
    dyn = _deflate_piece(block, final, level)
    if fixed_cost is None:
        return dyn
    fix = _deflate_piece(block, final, level, zlib.Z_FIXED)
    if fix == dyn:
        return dyn                       # incompressible: both emit a stored block
    if len(fix) - len(dyn) <= fixed_cost and _piece_ok(fix, final):
        return fix
    return dyn


def miniz_encode(data: bytes, h2: int, level: int = 9, mode: str = "auto",
                 fixed_cost: int | None = None) -> bytes:
    """Encode a version-2 entry payload. mode: auto (smaller of deflate/stored), deflate, stored.
    fixed_cost (round 75): how many bytes a block may grow to use static Huffman."""
    size = len(data)
    n = (size + BLOCK - 1) // BLOCK
    if n == 0:
        # an empty entry has no pieces: the reader hits EOF (size <= pos) before any refill
        return b""
    blocks = [data[i * BLOCK:(i + 1) * BLOCK] for i in range(n)]
    pieces = None
    if mode in ("auto", "deflate"):
        pieces = []
        for i, block in enumerate(blocks):
            final = i == len(blocks) - 1
            piece = _best_piece(block, final, level, fixed_cost)
            if not final and len(piece) == BLOCK:
                # a non-final piece of exactly 0x400 bytes would flip the engine into stored mode
                for alt in (level - 1, 1, 0, 6, 3):
                    if alt < 0:
                        continue
                    piece = _deflate_piece(block, final, alt)
                    if len(piece) != BLOCK:
                        break
                if len(piece) == BLOCK:
                    raise PieceError("could not avoid a 0x400-byte deflate piece")
            if len(piece) > PIECE_MAX:
                raise PieceError("deflate piece of %d bytes > 0x7ff" % len(piece))
            pieces.append((piece, final))
    stored_ok = size > BLOCK  # the first piece must be a full, non-final block
    if mode == "stored" and not stored_ok:
        raise PieceError("stored mode needs more than 0x400 bytes (the first piece must be full and non-final)")
    if stored_ok and (mode == "stored" or (mode == "auto" and sum(4 + len(p) for p, _ in pieces) > 4 * n + size)):
        ks = IsaacKeystream(h2)
        pieces = [(ks.apply(block), i == n - 1) for i, block in enumerate(blocks)]
    out = bytearray()
    for piece, final in pieces:
        out += struct.pack("<I", len(piece) | (0x80000000 if final else 0))
        out += piece
    return bytes(out)


# ---------------------------------------------------------------------------
# version 1: LZW (decode only)
# ---------------------------------------------------------------------------

class LzwState:
    """0x00a850f0: 4096-entry table {prefix, byte}; next_code 0x100; width 8. Persists per entry."""

    def __init__(self) -> None:
        self.prefix = [-1] * 0x1000
        self.byte = [i & 0xFF for i in range(0x1000)]
        self.next_code = 0x100
        self.width = 8

    def reset(self) -> None:
        self.next_code = 0x100
        self.width = 8

    def emit(self, code: int, out: bytearray) -> int:
        """0x00a85020: append the string of `code`; return its first byte (-1 for code -1)."""
        if code == -1:
            return -1
        chain = []
        c = code
        while c != -1:
            chain.append(self.byte[c])
            c = self.prefix[c]
        chain.reverse()
        out += bytes(chain)
        return chain[0]

    def decode_piece(self, data: bytes) -> bytes:
        """0x00a85320 over one piece. The bit reader (MSB first) restarts per piece."""
        pos = 0
        bitbuf = 0
        nbits = 0
        n = len(data)
        out = bytearray()

        def read(width: int) -> int:
            nonlocal pos, bitbuf, nbits
            while nbits < width:
                b = data[pos] if pos < n else 0
                pos += 1
                bitbuf = ((bitbuf << 8) | b) & MASK32
                nbits += 8
            nbits -= width
            return (bitbuf >> nbits) & ((1 << width) - 1)

        if n == 0:
            return b""
        prev = read(self.width)
        last = self.emit(prev, out)
        while True:
            if self.next_code + 1 > 0xFFF:
                self.reset()
                prev = read(8)
                last = self.emit(prev, out)
            if pos >= n:
                break
            while (1 << self.width) <= self.next_code:
                self.width += 1
            code = read(self.width)
            if code == self.next_code:
                if prev != -1 and self.next_code < 0x1000:
                    self.prefix[self.next_code] = prev
                    self.byte[self.next_code] = last & 0xFF
                    self.next_code += 1
                last = self.emit(code, out)
            else:
                if code > self.next_code:
                    raise PieceError("LZW: wrong code %u" % code)
                last = self.emit(code, out)
                if prev != -1 and self.next_code < 0x1000:
                    self.prefix[self.next_code] = prev
                    self.byte[self.next_code] = last & 0xFF
                    self.next_code += 1
            prev = code
            if pos >= n:
                break
        return bytes(out)


def lzw_decode(buf: bytes, offset: int, size: int) -> tuple[bytes, int]:
    st = LzwState()
    out = bytearray()
    end = offset
    for payload, _fin, end in iter_pieces(buf, offset, size):
        out += st.decode_piece(payload)
    if len(out) < size:
        raise PieceError("LZW decoded %d bytes, table says %d" % (len(out), size))
    return bytes(out[:size]), end - offset


# ---------------------------------------------------------------------------
# archive reader
# ---------------------------------------------------------------------------

@dataclass
class Entry:
    index: int
    h1: int
    h2: int
    offset: int
    size: int
    x: int

    @property
    def key(self) -> tuple[int, int]:
        return self.h1, self.h2

    @property
    def tag(self) -> str:
        return "%08x-%08x" % (self.h1, self.h2)


class Archive:
    """One packed archive. The whole file is memory-mapped/read once (mmap when possible)."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._fh = open(path, "rb")
        try:
            import mmap
            self.buf = mmap.mmap(self._fh.fileno(), 0, access=mmap.ACCESS_READ)
        except Exception:
            self.buf = self._fh.read()
        hdr = self.buf[:HEADER_SIZE]
        if len(hdr) < HEADER_SIZE or hdr[:7] != MAGIC:
            raise ValueError("%s: not an ARCH000 archive" % path)
        self.version = hdr[7]
        self.table_offset, = struct.unpack_from("<I", hdr, 8)
        self.count, = struct.unpack_from("<H", hdr, 12)
        self.entries = []
        for i in range(self.count):
            h1, h2, off, size, x = TABLE_RECORD.unpack_from(self.buf, self.table_offset + TABLE_RECORD.size * i)
            self.entries.append(Entry(i, h1, h2, off, size, x))
        self.by_key = {e.key: e for e in self.entries}

    def close(self) -> None:
        try:
            self.buf.close()
        except Exception:
            pass
        self._fh.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def find(self, path: str) -> Entry | None:
        return self.by_key.get(key_of(resource_key(path)))

    def raw_extent(self, e: Entry) -> tuple[int, int]:
        """(offset, packed length) of the entry's payload, without decoding."""
        if self.version == 0:
            return e.offset, e.size + ((-e.size) % 4)
        if self.version in (1, 2):
            end = e.offset
            for _payload, _fin, end in iter_pieces(self.buf, e.offset, e.size):
                pass
            return e.offset, end - e.offset
        raise PieceError("archive version %d is not supported" % self.version)

    def raw(self, e: Entry) -> bytes:
        off, ln = self.raw_extent(e)
        return bytes(self.buf[off:off + ln])

    def decode(self, e: Entry) -> bytes:
        if self.version == 0:
            off, ln = self.raw_extent(e)
            return raw_decode(bytes(self.buf[off:off + ln]), e.h2, e.size)
        if self.version == 1:
            return lzw_decode(self.buf, e.offset, e.size)[0]
        if self.version == 2:
            return miniz_decode(self.buf, e.offset, e.size, e.h2)[0]
        raise PieceError("archive version %d is not supported" % self.version)

    def verify(self, e: Entry) -> tuple[bool, int]:
        x = mount_checksum(self.decode(e))
        return x == e.x, x


# ---------------------------------------------------------------------------
# archive writer
# ---------------------------------------------------------------------------

def encode_payload(version: int, data: bytes, h2: int, level: int = 9, mode: str = "auto",
                   fixed_cost: int | None = None) -> bytes:
    if version == 0:
        return raw_encode(data, h2)
    if version == 2:
        return miniz_encode(data, h2, level=level, mode=mode, fixed_cost=fixed_cost)
    if version == 1:
        raise PieceError("version 1 (LZW) entries cannot be re-encoded; repack with --version 0 or 2")
    raise PieceError("archive version %d is not supported" % version)


def write_archive(path: str, version: int, items: list[dict], level: int = 9, mode: str = "auto",
                  fixed_cost: int | None = None) -> dict:
    """items, in table order: {'h1','h2', 'raw': packed bytes, 'size', 'x'} (passthrough),
    {'h1','h2', 'src': Archive, 'entry': Entry} (passthrough copied from the source archive at
    write time, so a large archive is never held in memory) or {'h1','h2','data': decoded bytes}
    (encoded here). Deterministic for equal input."""
    if len(items) > 0xFFFF:
        raise ValueError("too many entries (%d > 65535)" % len(items))
    records = []
    encoded = 0
    passthrough = 0
    with open(path, "wb") as f:
        f.write(MAGIC + bytes([version]) + struct.pack("<IH", 0, len(items)))
        pos = HEADER_SIZE
        for it in items:
            h1, h2 = it["h1"] & MASK32, it["h2"] & MASK32
            if "src" in it:
                e = it["entry"]
                off, ln = it["src"].raw_extent(e)
                raw = it["src"].buf[off:off + ln]
                size, x = e.size, e.x
                passthrough += 1
            elif "raw" in it:
                raw = it["raw"]
                size = it["size"]
                x = it["x"]
                passthrough += 1
            else:
                data = it["data"]
                raw = encode_payload(version, data, h2, level=level, mode=it.get("mode", mode),
                                     fixed_cost=it.get("fixed_cost", fixed_cost))
                size = len(data)
                x = mount_checksum(data)
                encoded += 1
            f.write(raw)
            records.append((h1, h2, pos, size, x))
            pos += len(raw)
        table_offset = pos
        for r in records:
            f.write(TABLE_RECORD.pack(*r))
        f.seek(8)
        f.write(struct.pack("<I", table_offset))
    return {"entries": len(items), "encoded": encoded, "passthrough": passthrough,
            "size": table_offset + TABLE_RECORD.size * len(items)}


# ---------------------------------------------------------------------------
# names
# ---------------------------------------------------------------------------

def load_candidates(files: list[str]) -> dict[tuple[int, int], str]:
    """Text files with one relative path per line -> {key: path}."""
    out: dict[tuple[int, int], str] = {}
    for fn in files:
        with open(fn, encoding="utf-8", errors="replace") as f:
            for line in f:
                p = line.strip()
                if not p or p.startswith("#"):
                    continue
                out.setdefault(key_of(resource_key(p)), p)
    return out


def safe_name(rel: str) -> str:
    rel = rel.replace("\\", "/")
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    return "/".join(parts)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _human(n: int) -> str:
    return "%.1f MB" % (n / 1048576) if n >= 1048576 else "%d B" % n


def cmd_list(args) -> int:
    names = load_candidates(args.names) if args.names else {}
    with Archive(args.archive) as a:
        print("%s: version %d, %d entries, table at %d, file %d bytes" % (
            args.archive, a.version, a.count, a.table_offset, len(a.buf)))
        for e in a.entries:
            nm = names.get(e.key, "")
            print("%5d %08x %08x off=%10d size=%9d x=%08x %s" % (e.index, e.h1, e.h2, e.offset, e.size, e.x, nm))
    return 0


def _verify_one(path: str) -> dict:
    ok = 0
    bad = []
    decoded = 0
    with Archive(path) as a:
        for e in a.entries:
            try:
                data = a.decode(e)
                x = mount_checksum(data)
                decoded += len(data)
                if x == e.x:
                    ok += 1
                else:
                    bad.append({"index": e.index, "tag": e.tag, "expected": "%08x" % e.x, "computed": "%08x" % x})
            except Exception as ex:  # a decode failure is a mismatch too
                bad.append({"index": e.index, "tag": e.tag, "error": str(ex)})
        return {"archive": path, "version": a.version, "entries": a.count, "matched": ok,
                "decoded_bytes": decoded, "file_bytes": len(a.buf), "mismatches": bad[:20], "mismatch_count": len(bad)}


def cmd_verify(args) -> int:
    paths = args.archive
    results = []
    if args.jobs > 1 and len(paths) > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            results = list(ex.map(_verify_one, paths))
    else:
        results = [_verify_one(p) for p in paths]
    allok = True
    for r in results:
        allok &= r["matched"] == r["entries"]
        print("%-40s v%d %5d/%5d matched  decoded %s  file %s%s" % (
            os.path.basename(r["archive"]), r["version"], r["matched"], r["entries"],
            _human(r["decoded_bytes"]), _human(r["file_bytes"]),
            "" if r["matched"] == r["entries"] else "  MISMATCH %s" % r["mismatches"][:3]))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=1)
    return 0 if allok else 1


def cmd_extract(args) -> int:
    names = load_candidates(args.names) if args.names else {}
    os.makedirs(args.outdir, exist_ok=True)
    manifest = []
    with Archive(args.archive) as a:
        for e in a.entries:
            data = a.decode(e)
            nm = names.get(e.key)
            rel = safe_name(nm) if nm else "_unnamed/%s.bin" % e.tag
            dst = os.path.join(args.outdir, rel)
            os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
            with open(dst, "wb") as f:
                f.write(data)
            manifest.append({"index": e.index, "h1": "%08x" % e.h1, "h2": "%08x" % e.h2, "size": e.size,
                             "x": "%08x" % e.x, "file": rel, "name": nm})
        with open(os.path.join(args.outdir, "manifest.json"), "w") as f:
            json.dump({"archive": os.path.basename(args.archive), "version": a.version, "entries": manifest}, f, indent=1)
    print("extracted %d entries to %s" % (len(manifest), args.outdir))
    return 0


def cmd_pack(args) -> int:
    """Pack a directory: every file becomes an entry keyed by its path relative to the directory
    (prefixed with 'resources/' unless it already starts with it); table order = sorted keys."""
    items = []
    root = args.dir
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for f in sorted(fn):
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if rel == "manifest.json" and args.skip_manifest:
                continue
            key = resource_key(rel)
            h1, h2 = key_of(key)
            with open(full, "rb") as fh:
                items.append({"h1": h1, "h2": h2, "data": fh.read(), "key": key})
    items.sort(key=lambda it: it["key"].lower())
    if args.order:
        order = [line.strip() for line in open(args.order, encoding="utf-8") if line.strip()]
        pos = {key_of(resource_key(p)): i for i, p in enumerate(order)}
        items.sort(key=lambda it: pos.get((it["h1"], it["h2"]), len(pos)))
    r = write_archive(args.out, args.version, items, level=args.level, mode=args.mode)
    print("packed %d entries -> %s (%d bytes, version %d)" % (r["entries"], args.out, r["size"], args.version))
    return 0


def order_key(line: str) -> tuple[int, int]:
    """A line of an order file: a resource path, or the "h1-h2" tag `Entry.tag` prints (round
    65: a boot trace names entries the catalogues do not, and an archive's names are not all
    recoverable)."""
    if len(line) == 17 and line[8] == "-":
        try:
            return int(line[:8], 16), int(line[9:], 16)
        except ValueError:
            pass
    return key_of(resource_key(line))


def read_order(path: str) -> list[str]:
    """The non-empty, non-comment lines of an order file, in order."""
    with open(path, encoding="utf-8") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]


def entry_order(entries, order_paths):
    """Round 64: the entries the listed paths name, in that order, then the rest in table
    order. Payloads are written in table order, so this IS the file layout: a reader that
    opens the entries in the listed order then sweeps the file forward, and a windowed
    reader (host_shims_fs.c) or an HTTP range reader fetches each window once."""
    pos = {}
    for i, p in enumerate(order_paths):
        pos.setdefault(order_key(p), i)
    lead, rest = [], []
    for e in entries:
        (lead if e.key in pos else rest).append(e)
    lead.sort(key=lambda e: pos[e.key])
    return lead + rest


def cmd_repack(args) -> int:
    """Rebuild an archive keeping its table order. Entries are passed through byte-for-byte unless
    replaced (--replace DIR with --names, or --replace-json {tag|path: file}) or the version changes.
    --order <file> lays the named paths out first, in that order (round 64)."""
    names = load_candidates(args.names) if args.names else {}
    replacements: dict[tuple[int, int], str] = {}
    if args.replace_json:
        with open(args.replace_json, encoding="utf-8") as f:
            for k, fn in json.load(f).items():
                if len(k) == 17 and k[8] == "-":
                    key = (int(k[:8], 16), int(k[9:], 16))
                else:
                    key = key_of(resource_key(k))
                replacements[key] = fn
    if args.replace:
        for dp, _dn, fn in os.walk(args.replace):
            for f in fn:
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, args.replace).replace("\\", "/")
                if rel.startswith("_unnamed/") and rel.endswith(".bin") and len(rel) == len("_unnamed/") + 21:
                    tag = rel[len("_unnamed/"):-4]
                    key = (int(tag[:8], 16), int(tag[9:], 16))
                else:
                    key = key_of(resource_key(rel))
                replacements[key] = full
    drop: set[tuple[int, int]] = set()
    for shadow in args.drop_shadowed_by or []:
        with Archive(shadow) as s:
            drop |= set(s.by_key)
    items = []
    replaced = 0
    dropped = 0
    with Archive(args.archive) as a:
        version = a.version if args.version is None else args.version
        entries = a.entries
        if getattr(args, "order", None):
            entries = entry_order(entries, read_order(args.order))
        for e in entries:
            if e.key in drop:
                dropped += 1
                continue
            fn = replacements.get(e.key)
            if fn is not None:
                with open(fn, "rb") as fh:
                    items.append({"h1": e.h1, "h2": e.h2, "data": fh.read()})
                replaced += 1
            elif version == a.version:
                items.append({"h1": e.h1, "h2": e.h2, "src": a, "entry": e})
            else:
                items.append({"h1": e.h1, "h2": e.h2, "data": a.decode(e)})
        r = write_archive(args.out, version, items, level=args.level, mode=args.mode)
    print("repacked %s -> %s: %d entries (%d replaced, %d dropped, %d passthrough, %d encoded), %d bytes, version %d" % (
        args.archive, args.out, r["entries"], replaced, dropped, r["passthrough"], r["encoded"], r["size"], version))
    return 0


def cmd_names(args) -> int:
    names = load_candidates(args.candidates)
    with Archive(args.archive) as a:
        hit = [(e, names[e.key]) for e in a.entries if e.key in names]
        print("%s: %d of %d entries named" % (args.archive, len(hit), a.count))
        if args.verbose:
            for e, nm in hit:
                print("%5d %s %s" % (e.index, e.tag, nm))
    return 0


def cmd_hash(args) -> int:
    for p in args.path:
        key = resource_key(p) if not args.raw else p
        h1, h2 = key_of(key)
        print("%08x %08x %s" % (h1, h2, key))
    return 0


def cmd_checksum(args) -> int:
    for p in args.file:
        with open(p, "rb") as f:
            print("%08x %s" % (mount_checksum(f.read()), p))
    return 0


def cmd_shadow(args) -> int:
    """Mount-order census: an entry whose key appears in a LATER archive is overwritten in the
    hash table (0x00a17e22) and never served. Prints per-archive dead entries and bytes."""
    seen: dict[tuple[int, int], str] = {}
    arcs = []
    for p in args.archive:
        a = Archive(p)
        arcs.append(a)
    for a in reversed(arcs):
        dead = 0
        dead_bytes = 0
        for e in a.entries:
            if e.key in seen:
                dead += 1
                dead_bytes += a.raw_extent(e)[1]
        for e in a.entries:
            seen.setdefault(e.key, os.path.basename(a.path))
        print("%-22s %5d entries, %5d shadowed by a later archive (%s packed)" % (
            os.path.basename(a.path), a.count, dead, _human(dead_bytes)))
    for a in arcs:
        a.close()
    return 0


def _selftest() -> int:
    import random
    import tempfile
    rnd = random.Random(1234)
    files = {
        "gfx/a.png": bytes(rnd.getrandbits(8) for _ in range(5)),
        "sfx/b.wav": bytes(rnd.getrandbits(8) for _ in range(0x401)),
        "music/c.ogg": b"".join(bytes([i & 0xFF]) * 7 for i in range(700)),
        "empty.txt": b"",
        "x/y/z.xml": b"<xml>" * 2000,
    }
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "src")
        for rel, data in files.items():
            p = os.path.join(src, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
        for version in (0, 2):
            out = os.path.join(td, "t%d.a" % version)
            ns = argparse.Namespace(dir=src, out=out, version=version, level=9, mode="auto", order=None, skip_manifest=True)
            cmd_pack(ns)
            with Archive(out) as a:
                assert a.count == len(files)
                for rel, data in files.items():
                    e = a.find(rel)
                    assert e is not None, rel
                    assert a.decode(e) == data, rel
                    ok, x = a.verify(e)
                    assert ok, (rel, x, e.x)
            # unchanged repack is byte-identical
            out2 = os.path.join(td, "t%d-2.a" % version)
            ns = argparse.Namespace(archive=out, out=out2, names=None, replace=None, replace_json=None,
                                    version=None, level=9, mode="auto", drop_shadowed_by=None, order=None)
            cmd_repack(ns)
            assert open(out, "rb").read() == open(out2, "rb").read()
            # round 64: --order lays the named entries out first, in that order, and changes
            # nothing else -- same keys, same decoded bytes, same checksums, offsets ascending
            # in the requested order (the file layout IS the table order).
            want = ["music/c.ogg", "sfx/b.wav", "gfx/a.png"]
            of = os.path.join(td, "order%d.txt" % version)
            with open(of, "w", encoding="utf-8") as f:
                f.write("# a comment line is ignored\n" + "\n".join(want) + "\nnot/here.bin\n")
            out3 = os.path.join(td, "t%d-3.a" % version)
            ns = argparse.Namespace(archive=out, out=out3, names=None, replace=None, replace_json=None,
                                    version=None, level=9, mode="auto", drop_shadowed_by=None, order=of)
            cmd_repack(ns)
            with Archive(out) as a, Archive(out3) as b:
                assert set(a.by_key) == set(b.by_key) and a.count == b.count
                for rel in files:
                    e, f2 = a.find(rel), b.find(rel)
                    assert b.decode(f2) == files[rel] and f2.size == e.size and f2.x == e.x, rel
                offs = [b.find(w).offset for w in want]
                assert offs == sorted(offs), offs
                assert b.entries[0].key == key_of(resource_key(want[0])), "the first payload is the first listed path"
                rest = [e.offset for e in b.entries[len(want):]]
                assert rest == sorted(rest) and min(rest) > max(offs), "the unlisted entries follow, in table order"
            # entry_order alone: an empty order list leaves the table untouched
            with Archive(out) as a:
                assert [e.key for e in entry_order(a.entries, [])] == [e.key for e in a.entries]
            # round 65: an order file may name an entry by its h1-h2 tag, which is how a boot
            # trace names the entries no catalogue does. Same order, same file.
            with Archive(out) as a:
                tags = [a.find(w).tag for w in want]
            assert all(order_key(t) == key_of(resource_key(w)) for t, w in zip(tags, want))
            of2 = os.path.join(td, "order%d-tags.txt" % version)
            with open(of2, "w", encoding="utf-8") as f:
                f.write("\n".join(tags) + "\n")
            out4 = os.path.join(td, "t%d-4.a" % version)
            ns = argparse.Namespace(archive=out, out=out4, names=None, replace=None, replace_json=None,
                                    version=None, level=9, mode="auto", drop_shadowed_by=None, order=of2)
            cmd_repack(ns)
            assert open(out3, "rb").read() == open(out4, "rb").read(), "tags and paths order alike"
        # stored-mode round trip
        big = bytes(rnd.getrandbits(8) for _ in range(5000))
        payload = miniz_encode(big, 0x12345678, mode="stored")
        buf = payload
        data, ln = miniz_decode(buf, 0, len(big), 0x12345678)
        assert data == big and ln == len(payload)
        # checksum quirk: a final partial dword sees the previous chunk's bytes
        assert mount_checksum(b"") == CHECKSUM_INIT
        assert mount_checksum(b"\x01") == ((CHECKSUM_INIT >> 1) | ((CHECKSUM_INIT & 1) << 31)) + 1
    print("selftest ok")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list", help="print the entry table");
    p.add_argument("archive"); p.add_argument("--names", nargs="*")
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("verify", help="decode every entry and recompute the mount checksum")
    p.add_argument("archive", nargs="+"); p.add_argument("--jobs", type=int, default=1); p.add_argument("--json")
    p.set_defaults(fn=cmd_verify)
    p = sub.add_parser("extract", help="write every decoded entry into a directory (+ manifest.json)")
    p.add_argument("archive"); p.add_argument("outdir"); p.add_argument("--names", nargs="*")
    p.set_defaults(fn=cmd_extract)
    p = sub.add_parser("pack", help="pack a directory of files named by their resource path")
    p.add_argument("dir"); p.add_argument("out"); p.add_argument("--version", type=int, default=0, choices=(0, 2))
    p.add_argument("--level", type=int, default=9); p.add_argument("--mode", default="auto", choices=("auto", "deflate", "stored"))
    p.add_argument("--order", help="text file listing paths in the desired table order")
    p.add_argument("--skip-manifest", action="store_true", default=True)
    p.set_defaults(fn=cmd_pack)
    p = sub.add_parser("repack", help="rebuild an archive, passing entries through unless replaced")
    p.add_argument("archive"); p.add_argument("out"); p.add_argument("--names", nargs="*")
    p.add_argument("--replace", help="directory of replacement files (extract layout)")
    p.add_argument("--replace-json", help="JSON {tag or path: file}")
    p.add_argument("--version", type=int, choices=(0, 2)); p.add_argument("--level", type=int, default=9)
    p.add_argument("--mode", default="auto", choices=("auto", "deflate", "stored"))
    p.add_argument("--drop-shadowed-by", nargs="*", help="archives mounted later: drop entries they override")
    p.add_argument("--order", help="text file listing paths to lay out first, in that order")
    p.set_defaults(fn=cmd_repack)
    p = sub.add_parser("names", help="resolve entry names from candidate path lists")
    p.add_argument("archive"); p.add_argument("candidates", nargs="+"); p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(fn=cmd_names)
    p = sub.add_parser("hash", help="print h1 h2 of resource paths"); p.add_argument("path", nargs="+")
    p.add_argument("--raw", action="store_true", help="hash the string as given (no resources/ prefix)")
    p.set_defaults(fn=cmd_hash)
    p = sub.add_parser("checksum", help="mount checksum of files"); p.add_argument("file", nargs="+")
    p.set_defaults(fn=cmd_checksum)
    p = sub.add_parser("shadow", help="mount-order shadow census (archives in mount order)")
    p.add_argument("archive", nargs="+"); p.set_defaults(fn=cmd_shadow)
    p = sub.add_parser("selftest", help="in-memory round trips"); p.set_defaults(fn=lambda a: _selftest())
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
