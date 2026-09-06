"""Cheap standalone function-start discovery (direct call/jmp targets).

Not a replacement for the Ghidra inventory the export agent produces; this
exists so the lifter prototype can run without waiting on it.  Method: a
linear capstone sweep of .text collecting `call rel32` targets, which for
MSVC x86 output recovers the large majority of real function entries.
"""

import capstone
from pe import PE32

_CACHE = {}


def call_targets(pe: PE32):
    key = id(pe)
    got = _CACHE.get(key)
    if got is not None:
        return got
    text = pe.text()
    lo, hi = text.vaddr, text.vaddr + text.vsize
    data = pe.read(lo, text.vsize)
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    md.detail = False
    targets = set()
    pos = 0
    n = len(data)
    while pos < n:
        # skip int3 / zero padding fast
        if data[pos] in (0xCC, 0x00):
            pos += 1
            continue
        chunk_end = min(n, pos + 0x4000)
        got_any = False
        for ins in md.disasm(data[pos:chunk_end], lo + pos):
            got_any = True
            if ins.mnemonic == "call" and ins.op_str.startswith("0x"):
                t = int(ins.op_str, 16)
                if lo <= t < hi:
                    targets.add(t)
            pos = ins.address - lo + ins.size
        if not got_any:
            pos += 1
    _CACHE[key] = targets
    return targets


if __name__ == "__main__":
    import sys
    import time
    pe = PE32(sys.argv[1] if len(sys.argv) > 1 else "tools/isaac-ng.unpacked.exe")
    t = time.time()
    ts = call_targets(pe)
    print("call targets: %d  (%.1fs)" % (len(ts), time.time() - t))
    out = sys.argv[2] if len(sys.argv) > 2 else None
    if out:
        with open(out, "w") as fh:
            for t2 in sorted(ts):
                fh.write("%#010x\n" % t2)
        print("wrote", out)
