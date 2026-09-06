"""x86-32 -> C static recompiler prototype, driven by Ghidra SLEIGH p-code.

Mechanical, general, no per-function hand-authored logic.

Pipeline:
  PE32 (read-only)  ->  pypcode/SLEIGH raw p-code  ->  C  ->  emcc  ->  wasm

Design notes
------------
* Register file: p-code register-space varnodes are mapped to *root*
  registers (the maximal named register covering a byte range).  Each
  lifted function caches the roots it touches in plain C locals, so
  LLVM's SROA/mem2reg promotes them to SSA values and dead flag
  computations get DCE'd.  Locals are spilled to the shared CpuState
  around calls (and at return) so callees observe the guest register
  state.
* Memory: identity addressing.  Guest VA == wasm linear-memory offset,
  which is what the existing hand-translated helpers in native/decomp
  already assume (`reinterpret_cast<uint8_t*>(addr)`).
* Control flow: every instruction address that is a branch target gets a
  C label; intra-instruction p-code-relative branches get sub-labels.
* CALL -> direct call of the target's C function.  CALLIND/BRANCHIND ->
  a runtime dispatcher (address -> function pointer table).
"""

import argparse
import os
import struct
import sys
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pypcode                       # noqa: E402
from pypcode import OpCode           # noqa: E402
from pe import PE32                  # noqa: E402

LANG = "x86:LE:32:default"

UTYPE = {1: "uint8_t", 2: "uint16_t", 4: "uint32_t", 8: "uint64_t"}
STYPE = {1: "int8_t", 2: "int16_t", 4: "int32_t", 8: "int64_t"}
MASK = {1: "0xffu", 2: "0xffffu", 4: "0xffffffffu", 8: "0xffffffffffffffffull"}


class LiftError(Exception):
    pass


# --------------------------------------------------------------------------
# register map


class RegMap:
    """Maps (register-space offset, size) to a root register + bit range."""

    def __init__(self, ctx):
        regs = ctx.registers
        # name -> (offset, size)
        byoff = {}
        for name, vn in regs.items():
            byoff.setdefault((vn.offset, vn.size), name)
        entries = sorted(((vn.offset, vn.size, name) for name, vn in regs.items()),
                         key=lambda t: (t[0], -t[1]))
        # root = maximal register covering each byte
        cover = {}          # byte offset -> (root_off, root_size, root_name)
        for off, size, name in entries:
            for b in range(off, off + size):
                cur = cover.get(b)
                if cur is None or size > cur[1]:
                    cover[b] = (off, size, name)
        self.cover = cover
        self.roots = OrderedDict()
        for b in sorted(cover):
            r = cover[b]
            self.roots.setdefault(r[0], r)

    def resolve(self, off, size):
        """Return (root_name, root_size, byte_offset_within_root)."""
        r = self.cover.get(off)
        if r is None:
            raise LiftError("unknown register offset %#x size %d" % (off, size))
        root_off, root_size, root_name = r
        if off + size > root_off + root_size:
            raise LiftError("register varnode %#x:%d straddles root %s"
                            % (off, size, root_name))
        return root_name, root_size, off - root_off


# --------------------------------------------------------------------------
# function body discovery (recursive descent over direct control flow)


class Decoder:
    def __init__(self, pe, ctx):
        self.pe = pe
        self.ctx = ctx
        self.cache = {}

    def at(self, va):
        """Decode one instruction at va -> (length, [ops]).  Raises on bad."""
        got = self.cache.get(va)
        if got is not None:
            return got
        try:
            code = self.pe.read(va, 16)
        except ValueError:
            raise LiftError("VA %#x outside image" % va)
        tx = self.ctx.translate(code, base_address=va, max_bytes=16,
                                max_instructions=1)
        if getattr(tx, "error", None) is not None:
            raise LiftError("sleigh: %s at %#x" % (tx.error, va))
        ops = list(tx.ops)
        if not ops or ops[0].opcode != OpCode.IMARK:
            raise LiftError("no IMARK at %#x" % va)
        length = ops[0].inputs[0].size
        body = [o for o in ops[1:] if o.opcode != OpCode.IMARK]
        got = (length, body)
        self.cache[va] = got
        return got


def discover_body(dec, start, func_starts, text_lo, text_hi, max_insns=20000,
                  jt=None, extent=None, bad=None):
    """Walk direct control flow from `start`.

    Returns (body, jumps) where body is {va: (len, ops)} in address order and
    jumps is {va: (kind, targets)} for every computed jump encountered.

    A direct `jmp` whose target is a known function start (or outside the
    text section) is treated as a tail call, not an internal edge.  Computed
    jumps are classified by `jt` (jumptables.JumpTables); recovered switch
    targets become internal edges so their blocks get lifted.
    """
    body = {}
    jumps = {}
    work = [start]
    seen = set()
    lo, hi = extent if extent else (start, text_hi)
    pending_jt = []
    # the entry itself must decode: a start that is data is a real failure
    length, ops = dec.at(start)
    while work or pending_jt:
        if not work:
            # resolve computed jumps only once the linear body is known,
            # so the `cmp reg,N` bound search has instructions to look at
            va, ops = pending_jt.pop()
            kind, targets = ("unknown", [])
            if jt is not None:
                kind, targets = jt.classify(va, list(body.keys()), lo, hi)
            jumps[va] = (kind, targets)
            if kind == "table":
                for t in targets:
                    if text_lo <= t < text_hi and t not in func_starts:
                        work.append(t)
            continue
        va = work.pop()
        if va in seen:
            continue
        seen.add(va)
        if not (text_lo <= va < text_hi):
            raise LiftError("control flow left .text at %#x" % va)
        try:
            length, ops = dec.at(va)
        except Exception as e:          # LiftError or pypcode.BadDataError
            # Data in the code stream: a jump table after a noreturn call, a
            # byte-index table, alignment padding. It is not part of the
            # function; end THIS path here rather than failing the whole
            # function (round 14c: every remaining lift failure but the
            # size cap was one of these, e.g. the entity family around
            # 0x00626xxx all absorbing the table at 0x0062a838). The emitter
            # renders a fall-through into a missing address as
            # recomp_unreachable() and a branch to it as a weak aborting
            # stub, so an executed path still stops loudly.
            if bad is not None:
                bad[va] = str(e)
            continue
        body[va] = (length, ops)
        if len(body) > max_insns:
            raise LiftError("function at %#x exceeds %d instructions"
                            % (start, max_insns))
        falls = True
        for op in ops:
            oc = op.opcode
            if oc == OpCode.RETURN:
                falls = False
            elif oc == OpCode.BRANCH:
                tgt_vn = op.inputs[0]
                if tgt_vn.space.name == "const":
                    continue        # p-code relative, stays inside instr
                t = tgt_vn.offset
                falls = False
                if t != start and t in func_starts:
                    continue        # tail call
                if not (text_lo <= t < text_hi):
                    continue
                work.append(t)
            elif oc == OpCode.CBRANCH:
                tgt_vn = op.inputs[0]
                if tgt_vn.space.name == "const":
                    continue
                t = tgt_vn.offset
                if t != start and t in func_starts:
                    continue
                if text_lo <= t < text_hi:
                    work.append(t)
            elif oc == OpCode.BRANCHIND:
                falls = False
                if va not in jumps:
                    pending_jt.append((va, ops))
        if falls:
            work.append(va + length)
    return OrderedDict(sorted(body.items())), jumps


def block_starts(body):
    """Addresses that begin a basic block (branch targets + post-branch)."""
    starts = set()
    addrs = list(body.keys())
    if addrs:
        starts.add(addrs[0])
    for va, (length, ops) in body.items():
        ends_block = False
        for op in ops:
            oc = op.opcode
            if oc in (OpCode.BRANCH, OpCode.CBRANCH):
                t = op.inputs[0]
                if t.space.name != "const" and t.offset in body:
                    starts.add(t.offset)
            if oc in (OpCode.BRANCH, OpCode.CBRANCH, OpCode.BRANCHIND,
                      OpCode.RETURN):
                ends_block = True
        if ends_block and (va + length) in body:
            starts.add(va + length)
    return starts


# --------------------------------------------------------------------------
# emitter


def packed_shift_defect(ops):
    """Ghidra's x86 SLEIGH gives PSLLD/PSLLQ (xmm) a PER-LANE shift count:

        XmmReg1[0,32]  = XmmReg1[0,32]  << XmmReg2[0,32]
        XmmReg1[32,32] = XmmReg1[32,32] << XmmReg2[32,32]
        ...

    The hardware shifts every lane by the SAME count, the low 64 bits of the
    source, and produces zero when that count exceeds the lane width.  The
    right shifts in the same spec file save the count into a local first and
    are correct; only the left shifts are wrong.  The game binary has twelve
    real `pslld xmm, xmm` sites (0x926623.., 0xad18a7..), all in vectorised
    index arithmetic where lanes 1..3 of the count register happen to be
    zero -- so the defect silently leaves three lanes unshifted instead of
    trapping.  Found by scripts/recomp/oracle/wideops.py.

    Returns the count varnode whose low 8 bytes are the real count, or None.
    VPSLLV* is genuinely per-lane, but SLEIGH models it as a pcodeop
    (CALLOTHER), not INT_LEFT, so it cannot match this shape.
    """
    if len(ops) not in (2, 4, 8):
        return None
    if any(o.opcode != OpCode.INT_LEFT for o in ops):
        return None
    outs = [o.output for o in ops]
    srcs = [o.inputs[0] for o in ops]
    cnts = [o.inputs[1] for o in ops]
    vs = outs + srcs + cnts
    if any(v is None or v.space.name != "register" for v in vs):
        return None
    sz = outs[0].size
    if sz not in (4, 8) or len(ops) * sz not in (16, 32):
        return None
    if any(v.size != sz for v in vs):
        return None
    for k in range(len(ops)):
        if outs[k].offset != outs[0].offset + k * sz:
            return None
        if srcs[k].offset != outs[k].offset:
            return None
        if cnts[k].offset != cnts[0].offset + k * sz:
            return None
    return cnts[0]


def vnkey(vn):
    return (vn.space.name, vn.offset, vn.size)


PCVAR = "pc_"


class FuncEmitter:
    def __init__(self, regmap, name, start, body, opts, jumps=None):
        self.rm = regmap
        self.name = name
        self.start = start
        self.body = body
        self.opts = opts
        self.jumps = jumps or {}
        # The dispatch loop opens with `pc_ = start`, so the entry MUST have a
        # case label. block_starts() only marks branch targets and the lowest
        # address in the body, and a function whose body absorbed a lower
        # address range does not have its entry among those: `switch (pc_)`
        # then fell straight to `default:`, which parks a jump to the entry and
        # re-enters -- an infinite park/dispatch cycle executing no guest
        # instruction at all. That was the room-entry "crawl" (round 15c:
        # 3.8 billion dispatches of sub_0093805f, whose body starts at
        # 0x00937d63).
        self.blocks = (block_starts(body) | {start}) if opts.get("dispatch") else set()
        self.jtmps = []
        self.jt_tables = 0
        self.jt_entries = 0
        self.jt_tailcalls = 0
        self.jt_unresolved = 0
        self.callind_const = 0
        self.imports_used = set()
        self.const_ptr = {}
        self.pshift_count = None
        self.uniques = OrderedDict()      # (off,size) -> cname
        self.roots = OrderedDict()        # root_name -> root_size (<=8)
        self.bigs = OrderedDict()         # (off,size) -> cname  (unique >8)
        self.bigroots = OrderedDict()     # root_name -> size    (>8)
        self.tmps = []
        self.lines = []
        self.labels = set()
        self.sublabels = set()
        self.callother = []
        self.callother_wide = []
        self.callind = 0
        self.branchind = 0
        self.direct_calls = set()
        self.tailcalls = set()
        self.soft_traps = []           # (va, reason): instructions lowered as traps
        self.stats = {}

    # --- varnode access -------------------------------------------------
    def uname(self, vn):
        key = (vn.offset, vn.size)
        n = self.uniques.get(key)
        if n is None:
            if vn.size not in UTYPE:
                raise LiftError("unique size %d unsupported" % vn.size)
            n = "u%x_%d" % (vn.offset, vn.size)
            self.uniques[key] = n
        return n

    def rd(self, vn):
        """C rvalue expression for a varnode (unsigned, of vn.size)."""
        sp = vn.space.name
        if sp == "const":
            if vn.size not in UTYPE:
                raise LiftError("const size %d unsupported" % vn.size)
            v = vn.offset & ((1 << (vn.size * 8)) - 1)
            sfx = "ull" if vn.size == 8 else "u"
            return "((%s)%#x%s)" % (UTYPE[vn.size], v, sfx)
        if sp == "unique":
            return self.uname(vn)
        if sp == "register":
            root, rsize, boff = self.rm.resolve(vn.offset, vn.size)
            if vn.size not in UTYPE:
                raise LiftError("subreg size %d unsupported" % vn.size)
            if rsize not in UTYPE:
                # wide root (SSE / x87): live in the shared state, no cache
                self.bigroots[root] = rsize
                return "recomp_rd%d(&s->%s[%d])" % (vn.size * 8, root, boff)
            self.roots[root] = rsize
            base = root if not self.opts.get("state_only") else "s->" + root
            if boff == 0 and vn.size == rsize:
                return base
            return "((%s)(%s >> %d))" % (UTYPE[vn.size], base, boff * 8)
        if sp == "ram":
            # SLEIGH materialises constant-address memory operands as plain
            # ram varnodes (no LOAD op), e.g. `u = ram[b18894:4]`.
            if vn.size not in UTYPE:
                raise LiftError("ram varnode size %d unsupported" % vn.size)
            return "MEMR%d(%#xu)" % (vn.size * 8, vn.offset)
        raise LiftError("read from space %r" % sp)

    def wr(self, vn, expr):
        sp = vn.space.name
        if sp == "unique":
            self.emit("%s = %s;" % (self.uname(vn), expr))
            return
        if sp == "register":
            root, rsize, boff = self.rm.resolve(vn.offset, vn.size)
            if vn.size not in UTYPE:
                raise LiftError("subreg size %d unsupported" % vn.size)
            if rsize not in UTYPE:
                self.bigroots[root] = rsize
                self.emit("recomp_wr%d(&s->%s[%d], %s);"
                          % (vn.size * 8, root, boff, expr))
                return
            self.roots[root] = rsize
            base = root if not self.opts.get("state_only") else "s->" + root
            if boff == 0 and vn.size == rsize:
                self.emit("%s = %s;" % (base, expr))
            else:
                if vn.size not in UTYPE:
                    raise LiftError("subreg size %d unsupported" % vn.size)
                bits = vn.size * 8
                m = ((1 << bits) - 1) << (boff * 8)
                rt = UTYPE[rsize]
                sfx = "ull" if rsize == 8 else "u"
                self.emit("%s = (%s)((%s & ~(%s)%#x%s) | ((%s)(%s) << %d));"
                          % (base, rt, base, rt, m, sfx, rt, expr, boff * 8))
            return
        if sp == "ram":
            if vn.size not in UTYPE:
                raise LiftError("ram varnode size %d unsupported" % vn.size)
            self.emit("MEMW%d(%#xu, %s);" % (vn.size * 8, vn.offset, expr))
            return
        raise LiftError("write to space %r" % sp)

    def emit(self, s):
        self.lines.append("  " + s)

    # --- op lowering ----------------------------------------------------
    def bin_op(self, op, c_op, signed=False):
        a, b = op.inputs[0], op.inputs[1]
        out = op.output
        sz = a.size
        if signed:
            ea = "((%s)%s)" % (STYPE[sz], self.rd(a))
            eb = "((%s)%s)" % (STYPE[sz], self.rd(b))
        else:
            ea, eb = self.rd(a), self.rd(b)
        self.wr(out, "(%s)(%s %s %s)" % (UTYPE[out.size], ea, c_op, eb))

    def cmp_op(self, op, c_op, signed=False):
        a, b = op.inputs[0], op.inputs[1]
        sz = a.size
        if signed:
            ea = "((%s)%s)" % (STYPE[sz], self.rd(a))
            eb = "((%s)%s)" % (STYPE[sz], self.rd(b))
        else:
            ea, eb = self.rd(a), self.rd(b)
        self.wr(op.output, "(uint8_t)(%s %s %s)" % (ea, c_op, eb))

    # --- wide (>8 byte) varnodes: SSE / x87 --------------------------
    def bigptr(self, vn, mutable=False):
        """C expression yielding a uint8_t* to a wide varnode's storage."""
        sp = vn.space.name
        if sp == "unique":
            key = (vn.offset, vn.size)
            n = self.bigs.get(key)
            if n is None:
                n = "b%x_%d" % (vn.offset, vn.size)
                self.bigs[key] = n
            return n
        if sp == "register":
            root, rsize, boff = self.rm.resolve(vn.offset, vn.size)
            self.bigroots[root] = rsize
            return "(&s->%s[%d])" % (root, boff)
        if sp == "ram":
            return "((uint8_t *)RECOMP_PTR(%#xu))" % vn.offset
        raise LiftError("wide varnode in space %r" % sp)

    def lower_wide(self, op):
        """Handle ops whose output or an input exceeds 8 bytes."""
        oc = op.opcode
        o = op.output
        ins = op.inputs
        if oc == OpCode.COPY:
            self.emit("memcpy(%s, %s, %d);"
                      % (self.bigptr(o, True), self.bigptr(ins[0]), o.size))
        elif oc == OpCode.LOAD:
            self.emit("memcpy(%s, RECOMP_PTR(%s), %d);"
                      % (self.bigptr(o, True), self.rd(ins[1]), o.size))
        elif oc == OpCode.STORE:
            self.emit("memcpy(RECOMP_PTR(%s), %s, %d);"
                      % (self.rd(ins[1]), self.bigptr(ins[2]), ins[2].size))
        elif oc == OpCode.SUBPIECE and o.size > 8:
            # wide slice of a wider varnode (e.g. the xmm half of a ymm)
            self.emit("memcpy(%s, %s + %d, %d);"
                      % (self.bigptr(o, True), self.bigptr(ins[0]),
                         ins[1].offset, o.size))
        elif oc == OpCode.SUBPIECE and o.size <= 8:
            off = ins[1].offset
            self.wr(o, "recomp_rd%d(%s + %d)"
                    % (o.size * 8, self.bigptr(ins[0]), off))
        elif oc == OpCode.PIECE:
            hi, lo = ins[0], ins[1]
            dst = self.bigptr(o, True)
            self.emit("recomp_piece(%s, %s, %d, %s, %d);"
                      % (dst, self.anyptr(lo), lo.size, self.anyptr(hi), hi.size))
        elif oc == OpCode.INT_ZEXT:
            dst = self.bigptr(o, True)
            self.emit("recomp_zext(%s, %d, %s, %d);"
                      % (dst, o.size, self.anyptr(ins[0]), ins[0].size))
        elif oc == OpCode.INT_NEGATE:
            self.emit("recomp_wide_not(%s, %s, %d);"
                      % (self.bigptr(o, True), self.bigptr(ins[0]), o.size))
        elif oc == OpCode.INT_2COMP:
            self.emit("recomp_wide_2comp(%s, %s, %d);"
                      % (self.bigptr(o, True), self.bigptr(ins[0]), o.size))
        elif oc in (OpCode.INT_XOR, OpCode.INT_AND, OpCode.INT_OR):
            kind = {OpCode.INT_XOR: 0, OpCode.INT_AND: 1, OpCode.INT_OR: 2}[oc]
            self.emit("recomp_bitop(%s, %s, %s, %d, %d);"
                      % (self.bigptr(o, True), self.bigptr(ins[0]),
                         self.bigptr(ins[1]), o.size, kind))
        elif oc in (OpCode.INT_EQUAL, OpCode.INT_NOTEQUAL):
            eq = "==" if oc == OpCode.INT_EQUAL else "!="
            self.wr(o, "(uint8_t)(memcmp(%s, %s, %d) %s 0)"
                    % (self.bigptr(ins[0]), self.bigptr(ins[1]),
                       ins[0].size, eq))
        elif oc in (OpCode.INT_LEFT, OpCode.INT_RIGHT, OpCode.INT_SRIGHT) \
                and o.size <= 8:
            # Small (<=8B) result routed here only because the shift-COUNT
            # operand is a wide register -- e.g. SSE packed shifts psrad/
            # psrlq/psllq, whose count is the low qword of an XMM. Each lane
            # is a scalar shift; p-code INT_* shift already saturates when the
            # count >= the operand's bit width, which matches x86's packed-
            # shift clamp, so the low 64 bits of the count are sufficient.
            fn = {OpCode.INT_LEFT: "shl", OpCode.INT_RIGHT: "shr",
                  OpCode.INT_SRIGHT: "sar"}[oc]
            cnt = ("recomp_rd64(%s)" % self.bigptr(ins[1])) if ins[1].size > 8 \
                else self.rd(ins[1])
            bits = o.size * 8
            self.wr(o, "recomp_%s%d(%s, (%s)((%s) >= %d ? %d : (%s)))"
                    % (fn, bits, self.rd(ins[0]), UTYPE[o.size],
                       cnt, bits, bits, cnt))
        elif oc in (OpCode.INT_LEFT, OpCode.INT_RIGHT):
            d = "l" if oc == OpCode.INT_LEFT else "r"
            self.emit("recomp_wide_sh%s(%s, %s, %d, %s);"
                      % (d, self.bigptr(o, True), self.bigptr(ins[0]),
                         o.size, self.rd(ins[1])))
        # ---- x87 80-bit: modelled as double, as remill does ----
        elif oc == OpCode.FLOAT_FLOAT2FLOAT and o.size > 8:
            self.emit("recomp_set80(%s, %s);"
                      % (self.bigptr(o, True), self.f64_of(ins[0])))
        elif oc == OpCode.FLOAT_FLOAT2FLOAT:
            self.wr(o, "recomp_f64_to_%s(%s)" % (ftype(o.size),
                                                 self.f64_of(ins[0])))
        elif oc == OpCode.FLOAT_INT2FLOAT and o.size > 8:
            self.emit("recomp_set80(%s, (double)(%s)%s);"
                      % (self.bigptr(o, True), STYPE[ins[0].size],
                         self.rd(ins[0])))
        elif oc == OpCode.FLOAT_TRUNC:
            self.wr(o, "(%s)(%s)%s" % (UTYPE[o.size], STYPE[o.size],
                                       self.f64_of(ins[0])))
        elif oc in FLOAT_BIN and o.size > 8:
            sym = {"fadd": "+", "fsub": "-", "fmul": "*", "fdiv": "/"}.get(
                FLOAT_BIN[oc])
            if sym is None:
                raise LiftError("wide float op %s" % oc)
            self.emit("recomp_set80(%s, %s %s %s);"
                      % (self.bigptr(o, True), self.f64_of(ins[0]), sym,
                         self.f64_of(ins[1])))
        elif oc in FLOAT_BIN:
            sym = {"feq": "==", "fne": "!=", "flt": "<", "fle": "<="}.get(
                FLOAT_BIN[oc])
            if sym is None:
                raise LiftError("wide float cmp %s" % oc)
            self.wr(o, "(uint8_t)(%s %s %s)"
                    % (self.f64_of(ins[0]), sym, self.f64_of(ins[1])))
        elif oc in FLOAT_UN and o.size > 8:
            fn = {"fneg": "-", "fabsv": "fabs", "fsqrt": "sqrt",
                  "fceil": "ceil", "ffloor": "floor",
                  "fround": "nearbyint"}[FLOAT_UN[oc]]
            e = ("-(%s)" % self.f64_of(ins[0])) if fn == "-" \
                else "%s(%s)" % (fn, self.f64_of(ins[0]))
            self.emit("recomp_set80(%s, %s);" % (self.bigptr(o, True), e))
        elif oc == OpCode.FLOAT_NAN:
            e = self.f64_of(ins[0])
            self.wr(o, "(uint8_t)((%s) != (%s))" % (e, e))
        else:
            raise LiftError("wide op %s size %d unsupported"
                            % (oc, o.size if o is not None else ins[0].size))

    def lower_callother_wide(self, op):
        """CALLOTHER with a >8-byte operand: the SSE/AVX pcodeops.

        The by-value `recomp_other_*` convention is uint32_t-shaped and
        cannot carry an XMM/YMM operand, so wide sites get a parallel
        `recomp_otherw_*` namespace passing every operand as
        (pointer, byte size).  Small operands are materialised into temps,
        so one shape covers mixed-width intrinsics -- the imm8 of pshuflw,
        or vcvttss2usi's 4-byte output from a 16-byte input.

        Callees must be alias-safe: `XMM0 = pshuflw(XMM0, XMM0, imm)`
        hands the same pointer as both output and input.
        """
        name = self.callother_name(op)
        o = op.output
        ins = op.inputs
        args = ["%s, %d" % (self.anyptr(v), v.size) for v in ins[1:]]
        outt = None
        if o is None:
            outp, outsz = "(uint8_t *)0", 0
        elif o.size > 8:
            outp, outsz = self.bigptr(o, True), o.size
        else:
            outt = "t%d_%d" % (len(self.tmps), o.size)
            self.tmps.append((outt, o.size))
            outp, outsz = "(uint8_t *)&%s" % outt, o.size
        self.callother_wide.append((name, len(ins) - 1))
        self.spill()
        self.emit("recomp_otherw_%s(s, %s, %d%s);"
                  % (name, outp, outsz, (", " + ", ".join(args)) if args else ""))
        self.reload()
        if outt is not None:
            self.wr(o, outt)

    def f64_of(self, vn):
        """Read any float varnode as a C double (80-bit becomes double)."""
        if vn.size > 8:
            return "recomp_get80(%s)" % self.bigptr(vn)
        if vn.size == 8:
            return "recomp_bits2f64(%s)" % self.rd(vn)
        if vn.size == 4:
            return "((double)recomp_bits2f32(%s))" % self.rd(vn)
        raise LiftError("float size %d unsupported" % vn.size)

    def anyptr(self, vn):
        """Pointer to a varnode's bytes; materialises small ones in a temp."""
        if vn.size > 8:
            return self.bigptr(vn)
        t = "t%d_%d" % (len(self.tmps), vn.size)
        self.tmps.append((t, vn.size))
        self.emit("%s = %s;" % (t, self.rd(vn)))
        return "(uint8_t *)&%s" % t

    def lower(self, va, idx, op, next_va):
        oc = op.opcode
        o = op.output
        ins = op.inputs

        wide = (o is not None and o.size > 8) or \
            any(v.space.name != "const" and v.size > 8 for v in ins)
        if wide:
            if oc == OpCode.CALLOTHER:
                self.lower_callother_wide(op)
            else:
                self.lower_wide(op)
            return

        if oc == OpCode.COPY:
            self.wr(o, self.rd(ins[0]))
        elif oc == OpCode.LOAD:
            addr = self.rd(ins[1])
            if o.size not in UTYPE:
                raise LiftError("load size %d unsupported" % o.size)
            self.wr(o, "MEMR%d(%s)" % (o.size * 8, addr))
        elif oc == OpCode.STORE:
            addr = self.rd(ins[1])
            val = ins[2]
            if val.size not in UTYPE:
                raise LiftError("store size %d unsupported" % val.size)
            self.emit("MEMW%d(%s, %s);" % (val.size * 8, addr, self.rd(val)))
        elif oc == OpCode.BRANCH:
            t = ins[0]
            if t.space.name == "const":
                d = struct.unpack("<i", struct.pack("<I", t.offset & 0xffffffff))[0]
                self.emit("goto %s;" % self.sublabel(va, idx + d))
            else:
                self.branch_to(t.offset)
        elif oc == OpCode.CBRANCH:
            t, cond = ins[0], ins[1]
            c = self.rd(cond)
            if t.space.name == "const":
                d = struct.unpack("<i", struct.pack("<I", t.offset & 0xffffffff))[0]
                self.emit("if (%s) goto %s;" % (c, self.sublabel(va, idx + d)))
            else:
                self.emit("if (%s) {" % c)
                self.branch_to(t.offset, indent=True)
                self.emit("}")
        elif oc == OpCode.BRANCHIND:
            self.branchind += 1
            self.emit_branchind(va, self.rd(ins[0]))
        elif oc == OpCode.CALL:
            t = ins[0].offset
            self.direct_calls.add(t)
            self.spill()
            # the callee may have parked a tail jump: run it from this frame
            self.emit("sub_%08x(s); if (recomp_jmp_pending) recomp_run_pending(s);" % t)
            self.reload()
        elif oc == OpCode.CALLIND:
            slot = self.const_ptr.get(vnkey(ins[0]))
            entry = self.opts.get("imports", {}).get(slot) if slot else None
            if entry is not None:
                # `call dword ptr [IAT slot]` -> direct call to the host shim.
                # The host imp_* functions do NOT pop: the shim-table path
                # (isaac_indirect_call) pops for them, and this direct path
                # must mirror that exactly -- otherwise every direct import
                # call leaves its return address on the guest stack and the
                # next callee-saved restore reads a shifted frame.
                name, arg_bytes, token = entry
                self.imports_used.add(name)
                self.spill()
                if arg_bytes == 0xFFFF:
                    self.emit("recomp_call_indirect(s, 0x%08xu); if (recomp_jmp_pending) recomp_run_pending(s);" % token)
                else:
                    self.emit("%s(s);" % name)
                    self.emit("s->EIP = MEMR32(s->ESP);")
                    self.emit("s->ESP += 4u + %du;" % arg_bytes)
                self.reload()
            else:
                self.callind += 1
                if slot is not None:
                    self.callind_const += 1
                e = self.rd(ins[0])
                self.spill()
                # the callee may have parked a tail jump: run it from this frame
                self.emit("recomp_call_indirect(s, %s); if (recomp_jmp_pending) recomp_run_pending(s);" % e)
                self.reload()
        elif oc == OpCode.CALLOTHER:
            name = self.callother_name(op)
            self.callother.append((name, len(ins) - 1))
            args = ", ".join("(uint32_t)(%s)" % self.rd(v) for v in ins[1:])
            self.spill()
            if o is not None:
                self.wr(o, "(%s)recomp_other_%s(s%s)"
                        % (UTYPE[o.size], name, (", " + args) if args else ""))
            else:
                self.emit("recomp_other_%s(s%s);"
                          % (name, (", " + args) if args else ""))
            self.reload()
        elif oc == OpCode.RETURN:
            self.spill()
            self.emit("return;")
        elif oc == OpCode.INT_EQUAL:
            self.cmp_op(op, "==")
        elif oc == OpCode.INT_NOTEQUAL:
            self.cmp_op(op, "!=")
        elif oc == OpCode.INT_LESS:
            self.cmp_op(op, "<")
        elif oc == OpCode.INT_LESSEQUAL:
            self.cmp_op(op, "<=")
        elif oc == OpCode.INT_SLESS:
            self.cmp_op(op, "<", signed=True)
        elif oc == OpCode.INT_SLESSEQUAL:
            self.cmp_op(op, "<=", signed=True)
        elif oc == OpCode.INT_ZEXT:
            self.wr(o, "(%s)%s" % (UTYPE[o.size], self.rd(ins[0])))
        elif oc == OpCode.INT_SEXT:
            self.wr(o, "(%s)(%s)((%s)%s)"
                    % (UTYPE[o.size], STYPE[o.size], STYPE[ins[0].size],
                       self.rd(ins[0])))
        elif oc == OpCode.INT_ADD:
            self.bin_op(op, "+")
        elif oc == OpCode.INT_SUB:
            self.bin_op(op, "-")
        elif oc == OpCode.INT_CARRY:
            sz = ins[0].size
            self.wr(o, "(uint8_t)((%s)(%s + %s) < %s)"
                    % (UTYPE[sz], self.rd(ins[0]), self.rd(ins[1]), self.rd(ins[0])))
        elif oc == OpCode.INT_SCARRY:
            sz = ins[0].size
            st = STYPE[sz]
            a, b = self.rd(ins[0]), self.rd(ins[1])
            self.wr(o, "(uint8_t)recomp_scarry%d(%s, %s)" % (sz * 8, a, b))
        elif oc == OpCode.INT_SBORROW:
            sz = ins[0].size
            a, b = self.rd(ins[0]), self.rd(ins[1])
            self.wr(o, "(uint8_t)recomp_sborrow%d(%s, %s)" % (sz * 8, a, b))
        elif oc == OpCode.INT_2COMP:
            sz = ins[0].size
            self.wr(o, "(%s)(-(%s)%s)" % (UTYPE[sz], UTYPE[sz], self.rd(ins[0])))
        elif oc == OpCode.INT_NEGATE:
            sz = ins[0].size
            self.wr(o, "(%s)(~%s)" % (UTYPE[sz], self.rd(ins[0])))
        elif oc == OpCode.INT_XOR:
            self.bin_op(op, "^")
        elif oc == OpCode.INT_AND:
            self.bin_op(op, "&")
        elif oc == OpCode.INT_OR:
            self.bin_op(op, "|")
        elif oc == OpCode.INT_LEFT:
            sz = o.size
            self.wr(o, "recomp_shl%d(%s, %s)"
                    % (sz * 8, self.rd(ins[0]),
                       self.shift_count(ins[1], sz)))
        elif oc == OpCode.INT_RIGHT:
            sz = o.size
            self.wr(o, "recomp_shr%d(%s, %s)"
                    % (sz * 8, self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.INT_SRIGHT:
            sz = o.size
            self.wr(o, "recomp_sar%d(%s, %s)"
                    % (sz * 8, self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.INT_MULT:
            self.bin_op(op, "*")
        elif oc == OpCode.INT_DIV:
            self.wr(o, "recomp_divu%d(%s, %s)"
                    % (o.size * 8, self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.INT_REM:
            self.wr(o, "recomp_remu%d(%s, %s)"
                    % (o.size * 8, self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.INT_SDIV:
            self.wr(o, "recomp_divs%d(%s, %s)"
                    % (o.size * 8, self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.INT_SREM:
            self.wr(o, "recomp_rems%d(%s, %s)"
                    % (o.size * 8, self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.BOOL_NEGATE:
            self.wr(o, "(uint8_t)(!%s)" % self.rd(ins[0]))
        elif oc == OpCode.BOOL_XOR:
            self.wr(o, "(uint8_t)((%s) ^ (%s))" % (self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.BOOL_AND:
            self.wr(o, "(uint8_t)((%s) & (%s))" % (self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.BOOL_OR:
            self.wr(o, "(uint8_t)((%s) | (%s))" % (self.rd(ins[0]), self.rd(ins[1])))
        elif oc == OpCode.POPCOUNT:
            self.wr(o, "(%s)recomp_popcount%d(%s)"
                    % (UTYPE[o.size], ins[0].size * 8, self.rd(ins[0])))
        elif oc == OpCode.LZCOUNT:
            self.wr(o, "(%s)recomp_lzcount%d(%s)"
                    % (UTYPE[o.size], ins[0].size * 8, self.rd(ins[0])))
        elif oc == OpCode.SUBPIECE:
            shift = ins[1].offset * 8
            src = self.rd(ins[0])
            if shift:
                src = "(%s >> %d)" % (src, shift)
            self.wr(o, "(%s)%s" % (UTYPE[o.size], src))
        elif oc == OpCode.PIECE:
            hi, lo = ins[0], ins[1]
            self.wr(o, "(%s)(((%s)%s << %d) | (%s)%s)"
                    % (UTYPE[o.size], UTYPE[o.size], self.rd(hi), lo.size * 8,
                       UTYPE[o.size], self.rd(lo)))
        elif oc in FLOAT_BIN:
            ft = ftype(ins[0].size)
            self.wr(o, "recomp_%s_%s(%s, %s)"
                    % (FLOAT_BIN[oc], ft, self.rd(ins[0]), self.rd(ins[1])))
        elif oc in FLOAT_UN:
            ft = ftype(ins[0].size)
            self.wr(o, "recomp_%s_%s(%s)" % (FLOAT_UN[oc], ft, self.rd(ins[0])))
        elif oc == OpCode.FLOAT_INT2FLOAT:
            self.wr(o, "recomp_int2float_%s_%d(%s)"
                    % (ftype(o.size), ins[0].size * 8, self.rd(ins[0])))
        elif oc == OpCode.FLOAT_FLOAT2FLOAT:
            self.wr(o, "recomp_float2float_%s_%s(%s)"
                    % (ftype(o.size), ftype(ins[0].size), self.rd(ins[0])))
        elif oc == OpCode.FLOAT_TRUNC:
            self.wr(o, "(%s)recomp_trunc_%s_%d(%s)"
                    % (UTYPE[o.size], ftype(ins[0].size), o.size * 8,
                       self.rd(ins[0])))
        else:
            raise LiftError("unhandled p-code op %s" % oc)

    def shift_count(self, vn, sz):
        """Shift count for a narrow shift, correcting the PSLLD/PSLLQ defect.

        `packed_shift_defect` flagged the whole instruction, so every lane
        reads the same 64-bit count.  Clamping to the lane width reproduces
        the hardware's zero-on-overshift (recomp_shl* saturates there), and
        it is the same idiom lower_wide uses for the SSE packed shifts.
        """
        cv = self.pshift_count
        if cv is None:
            return self.rd(vn)
        root, rsize, boff = self.rm.resolve(cv.offset, cv.size)
        if rsize < 8 or boff + 8 > rsize:
            return self.rd(vn)
        self.bigroots[root] = rsize
        c = "recomp_rd64(&s->%s[%d])" % (root, boff)
        bits = sz * 8
        return "(%s)((%s) >= %d ? %d : (%s))" % (UTYPE[sz], c, bits, bits, c)

    def callother_name(self, op):
        txt = pypcode.PcodePrettyPrinter.fmt_op(op)
        nm = None
        if "(" in txt:
            nm = txt.split("(")[0].split("=")[-1].strip()
        if not nm:
            nm = "op%d" % op.inputs[0].offset
        return "".join(ch if ch.isalnum() else "_" for ch in nm)

    # --- labels / calls -------------------------------------------------
    def label(self, va):
        self.labels.add(va)
        return "L_%08x" % va

    def sublabel(self, va, idx):
        self.sublabels.add((va, idx))
        return "P_%08x_%d" % (va, idx)

    def branch_to(self, target, indent=False):
        pre = "  " if indent else ""
        if target in self.body:
            self.emit(pre + "goto %s;" % self.label(target))
        else:
            # tail call / jump out of the function: park the target and
            # return; the caller runs it (round 14d trampoline -- a nested
            # `sub_T(s); return;` grew one native frame per loop iteration)
            self.tailcalls.add(target)
            self.spill(pre)
            self.emit(pre + "recomp_jmp_target = %#xu; recomp_jmp_pending = 1u; return;" % target)

    def note_const_ptr(self, op):
        """Track `unique = *[ram]CONST` so an indirect call through a
        constant slot (the IAT) can be turned into a direct shim call."""
        oc = op.opcode
        o = op.output
        if o is None or o.space.name != "unique":
            return
        if oc == OpCode.COPY and op.inputs[0].space.name == "ram":
            self.const_ptr[vnkey(o)] = op.inputs[0].offset
        elif oc == OpCode.LOAD and op.inputs[1].space.name == "const":
            self.const_ptr[vnkey(o)] = op.inputs[1].offset
        else:
            self.const_ptr.pop(vnkey(o), None)

    def emit_branchind(self, va, expr):
        """Lower a computed jump.

        table   -> inline switch to a `goto` per recovered target (LLVM
                   lowers a dense switch to br_table; unaffected blocks pay
                   nothing).
        iat/dyn -> indirect TAIL CALL: the callee's `ret` consumes our
                   caller's return address, so we just return afterwards.
        else    -> dispatch loop if enabled, otherwise a runtime trap.
        """
        kind, targets = self.jumps.get(va, ("unknown", []))
        if kind == "table" and targets:
            self.jt_tables += 1
            self.jt_entries += len(targets)
            tmp = "jt%x" % va
            self.jtmps.append(tmp)
            self.emit("%s = %s;" % (tmp, expr))
            self.emit("switch (%s) {" % tmp)
            seen = set()
            for t in targets:
                if t in seen:
                    continue
                seen.add(t)
                if t in self.body:
                    self.emit("  case %#xu: goto %s;" % (t, self.label(t)))
                else:
                    self.tailcalls.add(t)
                    self.emit("  case %#xu:" % t)
                    self.spill("  ")
                    self.emit("    recomp_jmp_target = %#xu; recomp_jmp_pending = 1u; return;" % t)
            self.emit("  default: break;")
            self.emit("}")
            self.spill()
            self.emit("recomp_jump_indirect(s, %s); return;" % tmp)
            return
        if kind == "iat":
            entry = self.opts.get("imports", {}).get(targets[0] if targets else None)
            self.jt_tailcalls += 1
            self.spill()
            if entry is not None:
                # jmp [IAT] is a tail call into the real callee, which pops
                # the return address its own caller pushed. The host imp_*
                # functions do not pop, so mirror the callee's `ret` here.
                name, arg_bytes, token = entry
                self.imports_used.add(name)
                if arg_bytes == 0xFFFF:
                    self.emit("recomp_jump_indirect(s, 0x%08xu);" % token)
                else:
                    self.emit("%s(s);" % name)
                    self.emit("s->EIP = MEMR32(s->ESP);")
                    self.emit("s->ESP += 4u + %du;" % arg_bytes)
                self.emit("return;")
            else:
                # a tail jump: park it (round 14d), the caller runs it
                self.emit("recomp_jump_indirect(s, %s); return;" % expr)
            return
        if kind == "dynamic":
            self.jt_tailcalls += 1
            self.spill()
            self.emit("recomp_jump_indirect(s, %s); return;" % expr)
            return
        # unresolved
        self.jt_unresolved += 1
        if self.opts.get("dispatch"):
            self.emit("%s = %s;" % (PCVAR, expr))
            self.emit("continue;")
        else:
            self.spill()
            self.emit("recomp_jump_indirect(s, %s); return;" % expr)

    def spill(self, pre=""):
        if self.opts.get("state_only"):
            return
        for r, sz in self.roots.items():
            if self.opts["local_flags"] and r in FLAG_REGS:
                continue
            self.emit(pre + "s->%s = %s;" % (r, r))

    def reload(self, pre=""):
        if self.opts.get("state_only"):
            return
        for r, sz in self.roots.items():
            if self.opts["local_flags"] and r in FLAG_REGS:
                continue
            self.emit(pre + "%s = s->%s;" % (r, r))

    # --- driver ---------------------------------------------------------
    def run(self):
        addrs = list(self.body.keys())
        # First pass: discover which registers are touched and which labels
        # are actually referenced (spill/reload need the full register set
        # before we emit any call site; labels must not be emitted unused).
        probe = FuncEmitter(self.rm, self.name, self.start, self.body,
                            self.opts, self.jumps)
        probe.opts = dict(self.opts)
        probe._emit_all(addrs)
        self.roots = probe.roots
        self.need_labels = set(probe.labels)
        self.need_sublabels = set(probe.sublabels)
        # Round 26: a body may hold blocks BELOW its entry -- Ghidra absorbs a
        # shared tail, or the target of a jump, into the function that reaches
        # it. Blocks are emitted in address order, so the goto-shaped function
        # used to fall into its lowest block first: the string-table loader's
        # second half (0x00a27038) ran the loader's own epilogue at 0x00a2701b
        # and returned 0 for every '#KEY' (819 functions in the tree, 778 of
        # them thunks in the CRT region). The dispatch-loop shape is immune
        # (`pc_ = start`); the goto shape now jumps to the entry block first.
        self.entry_goto = bool(addrs) and addrs[0] != self.start and not self.opts.get("dispatch")
        if self.entry_goto:
            self.need_labels.add(self.start)
        self.uniques = OrderedDict()
        self.bigs = OrderedDict()
        self.bigroots = OrderedDict()
        self.tmps = []
        self.jtmps = []
        self.jt_tables = 0
        self.jt_entries = 0
        self.jt_tailcalls = 0
        self.jt_unresolved = 0
        self.callind_const = 0
        self.imports_used = set()
        self.const_ptr = {}
        self.pshift_count = None
        self.lines = []
        self.labels = set()
        self.sublabels = set()
        self.callother = []
        self.callother_wide = []
        self.callind = 0
        self.branchind = 0
        self.direct_calls = set()
        self.tailcalls = set()
        self._emit_all(addrs)
        self.stats = dict(
            insns=len(self.body),
            pcode_ops=sum(len(v[1]) for v in self.body.values()),
            regs=len(self.roots),
            uniques=len(self.uniques),
            callother=len(self.callother),
            callind=self.callind,
            branchind=self.branchind,
            calls=len(self.direct_calls),
            tailcalls=len(self.tailcalls),
            soft_traps=len(self.soft_traps),
            jt_tables=self.jt_tables,
            jt_entries=self.jt_entries,
            jt_tailcalls=self.jt_tailcalls,
            jt_unresolved=self.jt_unresolved,
            callind_const=self.callind_const,
            imports=len(self.imports_used),
            dispatch=1 if self.opts.get("dispatch") else 0,
        )
        return self.render()

    def _emit_all(self, addrs):
        need_l = getattr(self, "need_labels", None)
        need_p = getattr(self, "need_sublabels", None)
        blocks = self.blocks if self.opts.get("dispatch") else ()
        for i, va in enumerate(addrs):
            length, ops = self.body[va]
            next_va = va + length
            if self.opts.get("trace_va"):
                self.lines.append("  RECOMP_VA(%#xu);" % va)
            if va in blocks:
                self.lines.append("  case %#xu: ;" % va)
            if need_l is None or va in need_l:
                self.lines.append("L_%08x: ;" % va)
            self.const_ptr = {}
            self.pshift_count = packed_shift_defect(ops)
            for idx, op in enumerate(ops):
                if need_p is None or (va, idx) in need_p:
                    self.lines.append("P_%08x_%d: ;" % (va, idx))
                self.note_const_ptr(op)
                try:
                    self.lower(va, idx, op, next_va)
                except LiftError as e:
                    # An instruction the lifter cannot lower (round 14c: the
                    # `les`/`lds` that jump-table bytes decode to, "load size
                    # 6"). It used to fail the whole function; now it becomes
                    # a loud trap at that instruction and the block ends,
                    # so the function's real paths are still lifted. The
                    # trap fires only if the path executes; soft_traps in
                    # the stats keeps the list visible.
                    self.soft_traps.append((va, "%s" % e))
                    self.emit("recomp_unreachable(s, %#xu); return;" % va)
                    break
            tail_needed = (need_p is None or (va, len(ops)) in need_p)
            if tail_needed:
                self.lines.append("P_%08x_%d: ;" % (va, len(ops)))
            # implicit fallthrough
            terminated = (not tail_needed) and self._last_terminates()
            if terminated:
                continue
            if i + 1 < len(addrs) and addrs[i + 1] != next_va:
                if next_va in self.body:
                    self.emit("goto %s;" % self.label(next_va))
                else:
                    self.emit("recomp_unreachable(s, %#xu); return;" % next_va)
            elif i + 1 == len(addrs):
                self.emit("recomp_unreachable(s, %#xu); return;" % next_va)

    def _last_terminates(self):
        for ln in reversed(self.lines):
            t = ln.strip()
            if not t or t == "(void)0;":
                continue
            return t == "return;" or t.startswith("goto ") or \
                t.endswith("return;")
        return False

    _RELOAD = __import__("re").compile(r"^\s*([A-Za-z_]\w*) = s->\1;$")
    _SPILL = __import__("re").compile(r"^\s*s->([A-Za-z_]\w*) = \1;$")

    def _peephole(self, lines):
        """Drop a reload block immediately followed by an identical spill
        block (back-to-back call sites)."""
        out = []
        i = 0
        n = len(lines)
        while i < n:
            j = i
            rl = []
            while j < n and self._RELOAD.match(lines[j]):
                rl.append(self._RELOAD.match(lines[j]).group(1))
                j += 1
            if rl:
                k = j
                sp = []
                while k < n and self._SPILL.match(lines[k]):
                    sp.append(self._SPILL.match(lines[k]).group(1))
                    k += 1
                if sp and set(sp) <= set(rl):
                    out.extend(lines[i:j])          # keep reload
                    i = k                            # drop the spill block
                    continue
                out.extend(lines[i:j])
                i = j
                continue
            out.append(lines[i])
            i += 1
        return out

    def render(self):
        out = []
        out.append("void %s(CpuState *restrict s) {" % self.name)
        if not self.opts.get("state_only"):
            for r, sz in self.roots.items():
                out.append("  %s %s = s->%s;" % (UTYPE[sz], r, r))
        for (off, size), n in self.uniques.items():
            out.append("  %s %s = 0;" % (UTYPE[size], n))
        for (off, size), n in self.bigs.items():
            out.append("  uint8_t %s[%d] = {0};" % (n, size))
        for n, size in self.tmps:
            out.append("  %s %s = 0;" % (UTYPE[size], n))
        for n in self.jtmps:
            out.append("  uint32_t %s = 0;" % n)
        body = self._peephole(self.lines)
        if self.opts.get("dispatch"):
            # per-function pc dispatch loop: an unresolved intra-function
            # computed jump becomes `pc_ = t; continue;`
            out.append("  uint32_t %s = %#xu;" % (PCVAR, self.start))
            out.append("  for (;;) { switch (%s) {" % PCVAR)
            out.extend(body)
            out.append("  default: ;")
            self.spill_into(out, "    ")
            out.append("    recomp_jump_indirect(s, %s); return;" % PCVAR)
            out.append("  } }")
        else:
            out.append("  (void)0;")
            if getattr(self, "entry_goto", False):
                out.append("  goto L_%08x;   /* the entry block is not the lowest address */" % self.start)
            out.extend(body)
        out.append("}")
        return "\n".join(out)

    def spill_into(self, out, pre):
        if self.opts.get("state_only"):
            return
        for r, sz in self.roots.items():
            if self.opts["local_flags"] and r in FLAG_REGS:
                continue
            out.append(pre + "s->%s = %s;" % (r, r))


FLAG_REGS = {"CF", "ZF", "SF", "OF", "AF", "PF", "TF", "IF", "DF", "NT", "RF",
             "VM", "AC", "VIF", "VIP", "ID"}

FLOAT_BIN = {
    OpCode.FLOAT_ADD: "fadd", OpCode.FLOAT_SUB: "fsub",
    OpCode.FLOAT_MULT: "fmul", OpCode.FLOAT_DIV: "fdiv",
    OpCode.FLOAT_EQUAL: "feq", OpCode.FLOAT_NOTEQUAL: "fne",
    OpCode.FLOAT_LESS: "flt", OpCode.FLOAT_LESSEQUAL: "fle",
}
FLOAT_UN = {
    OpCode.FLOAT_NEG: "fneg", OpCode.FLOAT_ABS: "fabsv",
    OpCode.FLOAT_SQRT: "fsqrt", OpCode.FLOAT_CEIL: "fceil",
    OpCode.FLOAT_FLOOR: "ffloor", OpCode.FLOAT_ROUND: "fround",
    OpCode.FLOAT_NAN: "fnan",
}


def ftype(size):
    if size == 4:
        return "f32"
    if size == 8:
        return "f64"
    raise LiftError("float size %d unsupported" % size)


# --------------------------------------------------------------------------


