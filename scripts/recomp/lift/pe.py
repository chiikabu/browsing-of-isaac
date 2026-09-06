"""Minimal PE32 reader for the recompilation lifter prototype.

Read-only. Never executes the image. Maps section bytes into a flat
image buffer indexed by virtual address so the lifter can fetch code
bytes at any VA.
"""

import struct
from dataclasses import dataclass


@dataclass
class Section:
    name: str
    vaddr: int          # absolute VA (image_base + rva)
    vsize: int
    raw_off: int
    raw_size: int
    characteristics: int

    @property
    def executable(self) -> bool:
        return bool(self.characteristics & 0x20000000)

    @property
    def writable(self) -> bool:
        return bool(self.characteristics & 0x80000000)


class PE32:
    def __init__(self, path: str):
        with open(path, "rb") as fh:
            self.data = fh.read()
        d = self.data
        if d[:2] != b"MZ":
            raise ValueError("not MZ")
        pe_off = struct.unpack_from("<I", d, 0x3C)[0]
        if d[pe_off:pe_off + 4] != b"PE\0\0":
            raise ValueError("not PE")
        coff = pe_off + 4
        (self.machine, self.nsections, _ts, _sym, _nsym,
         opt_size, self.characteristics) = struct.unpack_from("<HHIIIHH", d, coff)
        opt = coff + 20
        magic = struct.unpack_from("<H", d, opt)[0]
        if magic != 0x10B:
            raise ValueError("not PE32 (magic %#x)" % magic)
        self.entry_rva = struct.unpack_from("<I", d, opt + 16)[0]
        self.image_base = struct.unpack_from("<I", d, opt + 28)[0]
        self.section_align = struct.unpack_from("<I", d, opt + 32)[0]
        self.image_size = struct.unpack_from("<I", d, opt + 56)[0]
        nrva = struct.unpack_from("<I", d, opt + 92)[0]
        self.dirs = []
        for i in range(nrva):
            rva, sz = struct.unpack_from("<II", d, opt + 96 + i * 8)
            self.dirs.append((rva, sz))

        sec_off = opt + opt_size
        self.sections = []
        for i in range(self.nsections):
            o = sec_off + i * 40
            name = d[o:o + 8].rstrip(b"\0").decode("latin1")
            vsize, rva, rawsz, rawoff = struct.unpack_from("<IIII", d, o + 8)
            chars = struct.unpack_from("<I", d, o + 36)[0]
            self.sections.append(
                Section(name, self.image_base + rva, vsize, rawoff, rawsz, chars))

        # Flat image buffer indexed by (VA - image_base).
        self.image = bytearray(self.image_size)
        for s in self.sections:
            rva = s.vaddr - self.image_base
            n = min(s.raw_size, s.vsize)
            self.image[rva:rva + n] = d[s.raw_off:s.raw_off + n]

    @property
    def entry_va(self) -> int:
        return self.image_base + self.entry_rva

    def section_at(self, va: int):
        for s in self.sections:
            if s.vaddr <= va < s.vaddr + s.vsize:
                return s
        return None

    def read(self, va: int, n: int) -> bytes:
        off = va - self.image_base
        if off < 0 or off + n > len(self.image):
            raise ValueError("VA %#x out of image" % va)
        return bytes(self.image[off:off + n])

    def text(self):
        for s in self.sections:
            if s.name == ".text":
                return s
        for s in self.sections:
            if s.executable:
                return s
        raise ValueError("no .text")


if __name__ == "__main__":
    import sys
    pe = PE32(sys.argv[1] if len(sys.argv) > 1 else "tools/isaac-ng.unpacked.exe")
    print("machine %#x base %#x entry %#x image_size %#x" %
          (pe.machine, pe.image_base, pe.entry_va, pe.image_size))
    for s in pe.sections:
        print("  %-8s va %#010x vsize %#09x raw %#09x/%#09x chars %#010x %s%s"
              % (s.name, s.vaddr, s.vsize, s.raw_off, s.raw_size,
                 s.characteristics, "X" if s.executable else "-",
                 "W" if s.writable else "-"))
