"""MSVC x86 jump-table recovery + computed-jump classification.

A computed jump is only a *computed goto* problem when its targets are
basic blocks inside the owning function.  A `jmp [__imp_x]` or `jmp eax`
that lands on a function entry is an indirect tail call and needs nothing
more than the ordinary call_indirect path.  This module separates the two
and recovers the MSVC switch tables so the dangerous class shrinks.

Recognised MSVC x86 forms
-------------------------
  A  jmp dword ptr [reg*4 + TBL]                 one-level table
  B  movzx r2, byte ptr [r1 + IDX]               two-level (byte index)
     jmp dword ptr [r2*4 + TBL]
  C  jmp dword ptr [IMM]                         IAT / global slot -> tail call
  D  jmp reg                                     dynamic tail call / vtable

The bound comes from the dominating `cmp IDX, N` + unsigned `ja/jbe/jae`
pair on the table's index register (both parts required: a bare `cmp` on
the way to the jump is ordinary control flow, not a bound); when it cannot
be found the table is walked until an entry leaves the owning function's
address range (MSVC emits tables contiguously in .text or .rdata, so this
terminates).
"""

import capstone

MAX_TABLE = 4096


class JumpTables:
    def __init__(self, pe):
        self.pe = pe
        text = pe.text()
        self.text_lo = text.vaddr
        self.text_hi = text.vaddr + text.vsize
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
        self.md.detail = True
        self.cache = {}

    def _readable(self, va, n=4):
        try:
            self.pe.read(va, n)
            return True
        except ValueError:
            return False

    def _in_text(self, va):
        return self.text_lo <= va < self.text_hi

    def classify(self, va, body_addrs, lo, hi):
        """Classify the computed jump at `va`.

        Returns (kind, targets) where kind is one of:
          'table'     targets recovered from a switch table
          'iat'       jmp through a constant slot  -> indirect tail call
          'dynamic'   jmp through a register       -> indirect tail call
          'unknown'   could not classify
        """
        key = (va, lo, hi)
        got = self.cache.get(key)
        if got is not None:
            return got
        res = self._classify(va, body_addrs, lo, hi)
        self.cache[key] = res
        return res

    def _classify(self, va, body_addrs, lo, hi):
        try:
            raw = self.pe.read(va, 16)
        except ValueError:
            return ("unknown", [])
        try:
            ins = next(self.md.disasm(raw, va))
        except StopIteration:
            return ("unknown", [])
        if ins.mnemonic != "jmp" or not ins.operands:
            return ("unknown", [])
        op = ins.operands[0]
        if op.type == capstone.x86.X86_OP_REG:
            return ("dynamic", [])
        if op.type != capstone.x86.X86_OP_MEM:
            return ("unknown", [])
        m = op.mem
        base_reg = m.base
        idx_reg = m.index
        disp = m.disp & 0xFFFFFFFF

        # form C: jmp dword ptr [IMM]  (no base, no index)
        if base_reg == 0 and idx_reg == 0:
            return ("iat", [disp])

        # forms A/B: jmp dword ptr [idx*4 + TBL]
        if idx_reg != 0 and m.scale == 4 and base_reg == 0:
            tbl = disp
            # 1. a real range guard on the index register, then on any
            #    register (two-level tables compare the pre-transformed index)
            n = self._bound_before(va, body_addrs, idx_reg)
            if n is None:
                n = self._bound_before(va, body_addrs, 0)
            if n is not None:
                targets = self._read_table(tbl, n, lo, hi)
                if targets:
                    return ("table", targets)
            # 2. no guard: walk the table inside the function, and also take
            #    the legacy nearest-cmp read; the longer of the two wins. The
            #    walk alone misses tables whose first entry is outside the
            #    recorded function range; the legacy read alone truncates
            #    tables whose nearest cmp is ordinary control flow.
            walked = self._read_table(tbl, None, lo, hi)
            legacy_n = self._nearest_cmp_bound(va, body_addrs)
            legacy = self._read_table(tbl, legacy_n, lo, hi) if legacy_n else []
            best = walked if len(walked) >= len(legacy) else legacy
            if best:
                return ("table", best)
            return ("unknown", [])

        # jmp dword ptr [base + idx*4] with a register base: table address
        # is computed (PIC-ish); not seen in this binary but keep it honest.
        return ("unknown", [])

    GUARD_JCC = ("ja", "jae", "jb", "jbe", "jnb", "jnbe", "jnc", "jc")

    def _bound_before(self, va, body_addrs, idx_reg=0):
        """Find the range check that guards the table jump at `va`: a
        `cmp REG, N` on the table's index register, followed by an
        UNSIGNED conditional jump (MSVC's `cmp eax, N; ja default`).

        A bare `cmp` is not a bound. Boot round 14 met a switch whose last
        instructions before the jump were `cmp esi, 2 / je ...` -- ordinary
        control flow on the same register -- and the old rule took N=2 as
        the table size, dropping the fourth case; the game ran off the
        lifted table into an unlifted address during level generation
        (0x009b0d7b, table 0x009b1210, 4 entries). Without a guard the
        table is walked until an entry leaves the function (_read_table)."""
        cands = [a for a in body_addrs if a < va]
        cands.sort()
        window = cands[-12:]
        decoded = []
        for a in window:
            try:
                decoded.append(next(self.md.disasm(self.pe.read(a, 16), a)))
            except (StopIteration, ValueError):
                decoded.append(None)
        for i in range(len(decoded) - 1, -1, -1):
            ins = decoded[i]
            if ins is None or ins.mnemonic != "cmp" or len(ins.operands) != 2:
                continue
            if ins.operands[1].type != capstone.x86.X86_OP_IMM:
                continue
            if ins.operands[0].type != capstone.x86.X86_OP_REG:
                continue
            if idx_reg and ins.operands[0].reg != idx_reg:
                continue
            # the very next decoded instruction must be the unsigned guard
            nxt = decoded[i + 1] if i + 1 < len(decoded) else None
            if nxt is None or nxt.mnemonic not in self.GUARD_JCC:
                continue
            n = ins.operands[1].imm
            if 0 <= n < MAX_TABLE:
                return n + 1
        return None

    def _nearest_cmp_bound(self, va, body_addrs):
        """The pre-round-14 rule, kept only as the fallback's second opinion:
        the nearest `cmp x, N` in the 12 instructions before the jump."""
        cands = [a for a in body_addrs if a < va]
        cands.sort()
        for a in reversed(cands[-12:]):
            try:
                ins = next(self.md.disasm(self.pe.read(a, 16), a))
            except (StopIteration, ValueError):
                continue
            if ins.mnemonic == "cmp" and len(ins.operands) == 2 and \
                    ins.operands[1].type == capstone.x86.X86_OP_IMM:
                n = ins.operands[1].imm
                if 0 <= n < MAX_TABLE:
                    return n + 1
        return None

    def _read_table(self, tbl, n, lo, hi):
        """Read up to n entries; stop at the first implausible target."""
        out = []
        limit = n if n else MAX_TABLE
        for i in range(limit):
            va = tbl + 4 * i
            if not self._readable(va, 4):
                break
            t = int.from_bytes(self.pe.read(va, 4), "little")
            if not self._in_text(t):
                break
            # entries of a real switch table land inside the owning function
            if n is None and not (lo <= t < hi):
                break
            out.append(t)
        if n is not None and len(out) != n:
            # partial read: trust only a full table
            return out if len(out) >= 2 else []
        return out
