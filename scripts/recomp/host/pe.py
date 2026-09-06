"""Self-contained PE32 reader for the host/boot layer.

Deliberately independent of scripts/recomp/census/pe_model.py: the census tree is
owned by a sibling agent and is read-only from here, so this module re-derives
everything from the file bytes. Every field below is unpacked from the image; no
value is taken on faith from another tool.

VA -> file offset ALWAYS routes through the section table. A .text-relative
formula is off by 0xE00 for .rdata in this image, which is exactly the class of
error that produces plausible-looking garbage.
"""

import struct
from pathlib import Path

IMAGE_SCN_MEM_EXECUTE = 0x20000000
IMAGE_SCN_MEM_WRITE = 0x80000000
IMAGE_SCN_MEM_READ = 0x40000000

DIR_NAMES = [
    "EXPORT", "IMPORT", "RESOURCE", "EXCEPTION", "SECURITY", "BASERELOC",
    "DEBUG", "ARCHITECTURE", "GLOBALPTR", "TLS", "LOAD_CONFIG", "BOUND_IMPORT",
    "IAT", "DELAY_IMPORT", "COM_DESCRIPTOR", "RESERVED",
]

REPO_ROOT = Path(__file__).resolve().parents[3]
TARGET = REPO_ROOT / "tools" / "isaac-ng.unpacked.exe"
OUT_DIR = REPO_ROOT / "output" / "recomp" / "host"
CENSUS_DIR = REPO_ROOT / "output" / "recomp" / "census"


class Section:
    __slots__ = ("name", "virtual_size", "rva", "raw_size", "raw_offset", "characteristics")

    def __init__(self, name, virtual_size, rva, raw_size, raw_offset, characteristics):
        self.name = name
        self.virtual_size = virtual_size
        self.rva = rva
        self.raw_size = raw_size
        self.raw_offset = raw_offset
        self.characteristics = characteristics

    @property
    def is_exec(self):
        return bool(self.characteristics & IMAGE_SCN_MEM_EXECUTE)

    @property
    def is_write(self):
        return bool(self.characteristics & IMAGE_SCN_MEM_WRITE)

    @property
    def virtual_span(self):
        """Bytes the loader reserves: max(virtual, raw). Rounded up by the
        loader to SectionAlignment, but the unrounded span is what carries
        meaning for the BSS-tail computation."""
        return max(self.virtual_size, self.raw_size)

    @property
    def bss_tail(self):
        return max(0, self.virtual_size - self.raw_size)

    def contains_rva(self, rva):
        return self.rva <= rva < self.rva + self.virtual_span


class PE:
    def __init__(self, path=TARGET):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        d = self.data
        if d[:2] != b"MZ":
            raise ValueError("not an MZ image: %s" % path)
        self.pe_off = struct.unpack_from("<I", d, 0x3C)[0]
        if d[self.pe_off:self.pe_off + 4] != b"PE\0\0":
            raise ValueError("not a PE image: %s" % path)
        coff = self.pe_off + 4
        (self.machine, self.n_sections, self.timestamp, _st, _ns,
         self.opt_size, self.characteristics) = struct.unpack_from("<HHIIIHH", d, coff)
        opt = coff + 20
        self.opt_off = opt
        self.magic = struct.unpack_from("<H", d, opt)[0]
        if self.magic != 0x10B:
            raise ValueError("expected PE32 (0x10b), got 0x%x" % self.magic)
        self.size_of_code = struct.unpack_from("<I", d, opt + 4)[0]
        self.size_of_init_data = struct.unpack_from("<I", d, opt + 8)[0]
        self.size_of_uninit_data = struct.unpack_from("<I", d, opt + 12)[0]
        self.entry_rva = struct.unpack_from("<I", d, opt + 16)[0]
        self.image_base = struct.unpack_from("<I", d, opt + 28)[0]
        self.section_align = struct.unpack_from("<I", d, opt + 32)[0]
        self.file_align = struct.unpack_from("<I", d, opt + 36)[0]
        self.size_of_image = struct.unpack_from("<I", d, opt + 56)[0]
        self.size_of_headers = struct.unpack_from("<I", d, opt + 60)[0]
        self.subsystem = struct.unpack_from("<H", d, opt + 68)[0]
        self.dll_characteristics = struct.unpack_from("<H", d, opt + 70)[0]
        self.stack_reserve = struct.unpack_from("<I", d, opt + 72)[0]
        self.stack_commit = struct.unpack_from("<I", d, opt + 76)[0]
        self.heap_reserve = struct.unpack_from("<I", d, opt + 80)[0]
        self.heap_commit = struct.unpack_from("<I", d, opt + 84)[0]
        self.n_dirs = struct.unpack_from("<I", d, opt + 92)[0]
        self.dirs = {}
        for i in range(min(self.n_dirs, 16)):
            rva, size = struct.unpack_from("<II", d, opt + 96 + i * 8)
            self.dirs[DIR_NAMES[i]] = (rva, size)

        sec_off = opt + self.opt_size
        self.sections = []
        for i in range(self.n_sections):
            o = sec_off + i * 40
            name = d[o:o + 8].split(b"\0")[0].decode("ascii", "replace")
            vs, rva, rs, ro = struct.unpack_from("<IIII", d, o + 8)
            ch = struct.unpack_from("<I", d, o + 36)[0]
            self.sections.append(Section(name, vs, rva, rs, ro, ch))

    # --- address translation -------------------------------------------------
    def section_for_rva(self, rva):
        for s in self.sections:
            if s.contains_rva(rva):
                return s
        return None

    def section_for_va(self, va):
        return self.section_for_rva(va - self.image_base)

    def rva_to_off(self, rva):
        s = self.section_for_rva(rva)
        if s is None:
            return None
        delta = rva - s.rva
        if delta >= s.raw_size:
            return None  # inside the BSS-like tail; no bytes on disk
        return s.raw_offset + delta

    def va_to_off(self, va):
        return self.rva_to_off(va - self.image_base)

    def read_at_rva(self, rva, n):
        off = self.rva_to_off(rva)
        if off is None:
            return None
        return self.data[off:off + n]

    def read_at_va(self, va, n):
        return self.read_at_rva(va - self.image_base, n)

    def u32_at_rva(self, rva):
        b = self.read_at_rva(rva, 4)
        if not b or len(b) < 4:
            return None
        return struct.unpack("<I", b)[0]

    def u32_at_va(self, va):
        return self.u32_at_rva(va - self.image_base)

    def u16_at_rva(self, rva):
        b = self.read_at_rva(rva, 2)
        if not b or len(b) < 2:
            return None
        return struct.unpack("<H", b)[0]

    def cstr_at_rva(self, rva, limit=1024):
        off = self.rva_to_off(rva)
        if off is None:
            return None
        end = self.data.find(b"\0", off, off + limit)
        if end < 0:
            end = off + limit
        return self.data[off:end].decode("ascii", "replace")

    def section(self, name):
        for s in self.sections:
            if s.name == name:
                return s
        return None

    # --- convenience ---------------------------------------------------------
    @property
    def entry_va(self):
        return self.image_base + self.entry_rva

    def text_bounds_va(self):
        t = self.section(".text")
        lo = self.image_base + t.rva
        return lo, lo + t.virtual_span

    def is_text_va(self, va):
        lo, hi = self.text_bounds_va()
        return lo <= va < hi

    def is_image_va(self, va):
        return self.image_base <= va < self.image_base + self.size_of_image


def disasm(pe, va, count, detail=False):
    """Disassemble `count` instructions starting at `va`. Returns capstone insns."""
    from capstone import Cs, CS_ARCH_X86, CS_MODE_32
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = detail
    off = pe.va_to_off(va)
    if off is None:
        return []
    out = []
    for insn in md.disasm(pe.data[off:off + count * 16], va):
        out.append(insn)
        if len(out) >= count:
            break
    return out


def hexva(v):
    return "0x%08x" % v if v is not None else None
