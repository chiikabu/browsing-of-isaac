/* host_shims_msvcp.c -- the MSVC C++ standard library (msvcp140.dll) subset
 * the game reaches: basic_streambuf / basic_ios / basic_istream / basic_ostream
 * / basic_iostream members, the locale odds and ends they touch, and the
 * exception throwers.
 *
 * Why a re-implementation and not the DLL: the game's OWN template code is
 * lifted (basic_stringbuf::overflow/underflow/seekoff live in the game's
 * vtable at 0xb1b190; std::string and vector are inline), and it manipulates
 * the stream objects' FIELDS directly. So every function here operates on the
 * exact MSVC x86 object layout, dispatches the streambuf virtuals through the
 * object's real vtable (into lifted game code via isaac_guest_call), and
 * treats the base-class virtuals -- which the game's vtables reach through
 * IAT jump thunks -- as the DLL would.
 *
 * Every layout and behaviour below was transcribed from the 32-bit
 * C:\Windows\SysWOW64\msvcp140.dll (14.44.35211.0); the disassembly-tagged
 * notes are output/decomp/_scratch/msvcp140/abi-notes.md and the game-side
 * evidence is the stringstream constructor 0x00684ce0 (its six `**` writes
 * land exactly on _IGfirst/_IGnext/_IGcount/_IPfirst/_IPnext/_IPcount).
 *
 * basic_streambuf<char> (0x38):
 *   +0x00 vptr           +0x04 _Gfirst   +0x08 _Pfirst
 *   +0x0c _IGfirst=&_Gfirst  +0x10 _IPfirst=&_Pfirst
 *   +0x14 _Gnext         +0x18 _Pnext
 *   +0x1c _IGnext=&_Gnext    +0x20 _IPnext=&_Pnext
 *   +0x24 _Gcount        +0x28 _Pcount
 *   +0x2c _IGcount=&_Gcount  +0x30 _IPcount=&_Pcount   +0x34 locale* _Plocale
 *   vtable: +0 dtor, +4 _Lock, +8 _Unlock, +0xc overflow, +0x10 pbackfail,
 *           +0x14 showmanyc, +0x18 underflow, +0x1c uflow, +0x20 xsgetn,
 *           +0x24 xsputn, +0x28 seekoff, +0x2c seekpos, +0x30 setbuf,
 *           +0x34 sync, +0x38 imbue
 *   ALWAYS go through the indirection pointers: a basic_stringbuf redirects
 *   them with setg/setp.
 * ios_base (0x38): +0 vptr, +8 _Stdstr, +0xc _Mystate, +0x10 _Except,
 *   +0x14 _Fmtfl (default 0x201 = skipws|dec), +0x18 int64 _Prec (6),
 *   +0x20 int64 _Wide, +0x28 _Arr, +0x2c _Calls, +0x30 locale* _Ploc.
 * basic_ios (0x48) = ios_base + 0x38 _Mystrbuf + 0x3c _Tiestr + 0x40 _Fillch.
 * basic_istream/ostream/iostream: vbptr at +0 -> vbtable {0, disp}; the
 *   basic_ios virtual base is ALWAYS located as this + [[this]+4] (never by a
 *   constant), which is what lets the game's own stringstream layout
 *   (basic_ios at +0x68) work. basic_istream keeps int64 _Chcount at +8.
 *   The virtual destructors receive a vbase-adjusted `this`
 *   (iostream: obj+0x20, ostream: obj+8).
 *
 * Calling convention: every method is __thiscall (this in ECX, callee pops the
 * stack args); the free functions (_X*, uncaught_exception) are __cdecl. The
 * shim table (gen_shims.py) carries the purge per symbol.
 */
#include "isaac_host.h"
#include "shim_decls.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>

extern uint32_t isaac_guest_alloc(uint32_t n);
extern void     isaac_guest_free(uint32_t p);
extern void     isaac_guest_call(uint32_t va, CpuState *restrict cpu);

/* ---- layouts ----------------------------------------------------------- */
enum {
    SB_GFIRST = 0x04, SB_PFIRST = 0x08, SB_IGFIRST = 0x0c, SB_IPFIRST = 0x10,
    SB_GNEXT = 0x14, SB_PNEXT = 0x18, SB_IGNEXT = 0x1c, SB_IPNEXT = 0x20,
    SB_GCOUNT = 0x24, SB_PCOUNT = 0x28, SB_IGCOUNT = 0x2c, SB_IPCOUNT = 0x30,
    SB_PLOCALE = 0x34, SB_SIZE = 0x38,
};
enum {
    VS_LOCK = 0x04, VS_UNLOCK = 0x08, VS_OVERFLOW = 0x0c, VS_PBACKFAIL = 0x10,
    VS_SHOWMANYC = 0x14, VS_UNDERFLOW = 0x18, VS_UFLOW = 0x1c, VS_XSGETN = 0x20,
    VS_XSPUTN = 0x24, VS_SETBUF = 0x30, VS_SYNC = 0x34, VS_IMBUE = 0x38,
};
enum {
    IOS_STDSTR = 0x08, IOS_STATE = 0x0c, IOS_EXCEPT = 0x10, IOS_FMTFL = 0x14,
    IOS_PREC = 0x18, IOS_WIDE = 0x20, IOS_ARR = 0x28, IOS_CALLS = 0x2c,
    IOS_PLOC = 0x30, BIOS_STRBUF = 0x38, BIOS_TIE = 0x3c, BIOS_FILL = 0x40,
};
enum { ST_GOOD = 0, ST_EOF = 1, ST_FAIL = 2, ST_BAD = 4, ST_MASK = 0x17 };
enum {
    FL_SKIPWS = 0x001, FL_UNITBUF = 0x002, FL_UPPERCASE = 0x004, FL_SHOWBASE = 0x008,
    FL_SHOWPOS = 0x020, FL_LEFT = 0x040, FL_RIGHT = 0x080, FL_INTERNAL = 0x100,
    FL_DEC = 0x200, FL_OCT = 0x400, FL_HEX = 0x800, FL_BASEFIELD = 0xe00,
    FL_ADJUSTFIELD = 0x1c0,
};
/* The DLL's own vtable addresses (image base 0x10000000 + RVA). They are what
 * the real ctors write; the game overwrites them with its own vtables right
 * after each base ctor returns, and nothing in this environment dereferences
 * them -- but they keep the object bytes identical to a real construction. */
enum {
    VP_IOS_BASE = 0x10002f24u, VP_BASIC_IOS = 0x10002f84u, VP_BIOS_IN_OSTREAM = 0x10002f8cu,
    VP_BIOS_IN_ISTREAM = 0x10003060u, VP_BIOS_IN_IOSTREAM = 0x100053f4u, VP_STREAMBUF = 0x10002f9cu,
};
/* The game's basic_streambuf vtable slots 1,2,5,7,8,9,12,13,14 are IAT jump
 * thunks (`jmp dword ptr [msvcp140 slot]`) packed at 0x00aef065..0x00aef0a1:
 * a slot pointing there means "the base-class implementation". */
#define IAT_THUNK_LO 0x00aef065u
#define IAT_THUNK_HI 0x00aef0a1u

static void msvcp_fatal(const char *what, uint32_t msg_va) {
    char msg[256] = "";
    if (msg_va) (void)isaac_guest_cstr(msg_va, msg, sizeof msg, what);
    isaac_log("[isaac][msvcp] %s(\"%s\") -- C++ exception raised by the game's standard "
              "library; there is no unwinder here, stopping.", what, msg);
    abort();
}

/* ---- locale stand-ins ----------------------------------------------------
 * The DLL allocates an 8-byte `locale {pad, _Locimp* _Ptr}` for every
 * streambuf and every ios_base. The game copies locales (getloc) and reads
 * `_Ptr`; it never looks inside the _Locimp on the paths reached so far
 * (whitespace and widen are answered here with "C"-locale semantics). One
 * guest-resident fake _Locimp (0x20 bytes) with a large refcount serves all. */
static uint32_t g_locimp;                /* fake locale::_Locimp */
static uint32_t g_vbt_iostream_is, g_vbt_iostream_os, g_vbt_ostream;   /* {0, disp} */
static uint32_t g_locale_id_next = 1;

static uint32_t fake_locimp(void) {
    if (!g_locimp) {
        g_locimp = isaac_guest_alloc(0x20u);
        if (g_locimp) {
            for (uint32_t k = 0; k < 0x20u; k += 4) isaac_w32(g_locimp + k, 0);
            isaac_w32(g_locimp + 4u, 0x7fffffffu);     /* _Refs: never freed */
            isaac_w32(g_locimp + 0x10u, 0x3fu);        /* _Catmask = all */
        }
    }
    return g_locimp;
}
static uint32_t new_locale(void) {
    uint32_t p = isaac_guest_alloc(8u);
    if (p) { isaac_w32(p, 0); isaac_w32(p + 4u, fake_locimp()); }
    return p;
}
static uint32_t vbtable(uint32_t *slot, uint32_t disp) {
    if (!*slot) {
        *slot = isaac_guest_alloc(8u);
        if (*slot) { isaac_w32(*slot, 0); isaac_w32(*slot + 4u, disp); }
    }
    return *slot;
}

/* ---- object accessors -------------------------------------------------- */
static inline uint32_t bios_of(uint32_t stream) {          /* this + [[this]+4] */
    return stream + isaac_r32(isaac_r32(stream) + 4u);
}
static inline uint32_t sb_gnext(uint32_t sb)  { return isaac_r32(isaac_r32(sb + SB_IGNEXT)); }
static inline int32_t  sb_gcount(uint32_t sb) { return (int32_t)isaac_r32(isaac_r32(sb + SB_IGCOUNT)); }
static inline uint32_t sb_pnext(uint32_t sb)  { return isaac_r32(isaac_r32(sb + SB_IPNEXT)); }
static inline int32_t  sb_pcount(uint32_t sb) { return (int32_t)isaac_r32(isaac_r32(sb + SB_IPCOUNT)); }
static inline void sb_set_gnext(uint32_t sb, uint32_t v)  { isaac_w32(isaac_r32(sb + SB_IGNEXT), v); }
static inline void sb_set_gcount(uint32_t sb, int32_t v)  { isaac_w32(isaac_r32(sb + SB_IGCOUNT), (uint32_t)v); }
static inline void sb_set_pnext(uint32_t sb, uint32_t v)  { isaac_w32(isaac_r32(sb + SB_IPNEXT), v); }
static inline void sb_set_pcount(uint32_t sb, int32_t v)  { isaac_w32(isaac_r32(sb + SB_IPCOUNT), (uint32_t)v); }
static inline int is_ws(int c) { return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r'; }

/* ---- calling into the guest -------------------------------------------- */
/* Invoke a __thiscall virtual on a guest object through its real vtable. The
 * callee runs as lifted code on a fresh window below the current guest stack
 * and pops its own arguments; a return address of 0 ends the call. */
static uint32_t vcall(CpuState *cpu, uint32_t self, uint32_t slot,
                      unsigned nargs, const uint32_t *args, uint32_t *edx_out) {
    uint32_t fn = isaac_r32(isaac_r32(self) + slot);
    CpuState c;
    memset(&c, 0, sizeof c);
    c.FS_OFFSET = cpu->FS_OFFSET ? cpu->FS_OFFSET : ISAAC_TEB_VA;
    c.ESP = cpu->ESP - 0x100u;
    for (unsigned i = nargs; i-- > 0;) { c.ESP -= 4u; isaac_w32(c.ESP, args[i]); }
    c.ESP -= 4u;
    isaac_w32(c.ESP, 0);
    c.ECX = self;
    isaac_guest_call(fn, &c);
    if (edx_out) *edx_out = c.EDX;
    return c.EAX;
}
static int slot_is_base(uint32_t self, uint32_t slot) {
    uint32_t fn = isaac_r32(isaac_r32(self) + slot);
    return fn >= IAT_THUNK_LO && fn < IAT_THUNK_HI;
}
/* Call a __cdecl guest function pointer with one pointer argument. */
static uint32_t ccall1(CpuState *cpu, uint32_t fn, uint32_t arg) {
    CpuState c;
    memset(&c, 0, sizeof c);
    c.FS_OFFSET = cpu->FS_OFFSET ? cpu->FS_OFFSET : ISAAC_TEB_VA;
    c.ESP = cpu->ESP - 0x100u;
    c.ESP -= 4u; isaac_w32(c.ESP, arg);
    c.ESP -= 4u; isaac_w32(c.ESP, 0);
    isaac_guest_call(fn, &c);
    return c.EAX;
}

/* ---- streambuf primitives (base semantics, virtual fallbacks) ----------- */
static int32_t sb_underflow_v(CpuState *cpu, uint32_t sb) {
    if (slot_is_base(sb, VS_UNDERFLOW)) return -1;            /* base: EOF */
    return (int32_t)vcall(cpu, sb, VS_UNDERFLOW, 0, NULL, NULL);
}
static int32_t sb_uflow_base(CpuState *cpu, uint32_t sb) {
    int32_t c = sb_underflow_v(cpu, sb);
    if (c != -1) { sb_set_gcount(sb, sb_gcount(sb) - 1); sb_set_gnext(sb, sb_gnext(sb) + 1u); }
    return c;
}
static int32_t sb_uflow_v(CpuState *cpu, uint32_t sb) {
    if (slot_is_base(sb, VS_UFLOW)) return sb_uflow_base(cpu, sb);
    return (int32_t)vcall(cpu, sb, VS_UFLOW, 0, NULL, NULL);
}
static int32_t sb_overflow_v(CpuState *cpu, uint32_t sb, int32_t ch) {
    if (slot_is_base(sb, VS_OVERFLOW)) return -1;
    uint32_t a[1] = { (uint32_t)ch };
    return (int32_t)vcall(cpu, sb, VS_OVERFLOW, 1, a, NULL);
}
static int32_t sb_sync_v(CpuState *cpu, uint32_t sb) {
    if (slot_is_base(sb, VS_SYNC)) return 0;
    return (int32_t)vcall(cpu, sb, VS_SYNC, 0, NULL, NULL);
}
static int32_t sb_sgetc(CpuState *cpu, uint32_t sb) {
    uint32_t gn = sb_gnext(sb);
    if (gn && sb_gcount(sb) > 0) return isaac_r8(gn);
    return sb_underflow_v(cpu, sb);
}
static int32_t sb_sbumpc(CpuState *cpu, uint32_t sb) {
    uint32_t gn = sb_gnext(sb);
    if (gn && sb_gcount(sb) > 0) {
        sb_set_gcount(sb, sb_gcount(sb) - 1);
        sb_set_gnext(sb, gn + 1u);
        return isaac_r8(gn);
    }
    return sb_uflow_v(cpu, sb);
}
static int32_t sb_snextc(CpuState *cpu, uint32_t sb) {
    uint32_t gn = sb_gnext(sb);
    if (gn && sb_gcount(sb) > 1) {
        sb_set_gcount(sb, sb_gcount(sb) - 1);
        sb_set_gnext(sb, gn + 1u);
        return isaac_r8(gn + 1u);
    }
    if (sb_sbumpc(cpu, sb) == -1) return -1;
    return sb_sgetc(cpu, sb);
}
static int32_t sb_sputc(CpuState *cpu, uint32_t sb, uint8_t ch) {
    uint32_t pn = sb_pnext(sb);
    int32_t avail = pn ? sb_pcount(sb) : 0;
    if (avail > 0) {
        sb_set_pcount(sb, avail - 1);
        *(uint8_t *)isaac_g(pn) = ch;
        sb_set_pnext(sb, pn + 1u);
        return ch;
    }
    return sb_overflow_v(cpu, sb, ch);
}
static int64_t sb_xsputn_base(CpuState *cpu, uint32_t sb, uint32_t src, int64_t n) {
    int64_t left = n;
    while (left > 0) {
        uint32_t pn = sb_pnext(sb);
        int32_t avail = pn ? sb_pcount(sb) : 0;
        if (avail > 0) {
            int64_t k = avail < left ? avail : left;
            memcpy(isaac_g(pn), isaac_g(src), (size_t)k);
            sb_set_pcount(sb, avail - (int32_t)k);
            sb_set_pnext(sb, pn + (uint32_t)k);
            src += (uint32_t)k; left -= k;
        } else {
            if (sb_overflow_v(cpu, sb, isaac_r8(src)) == -1) break;
            ++src; --left;
        }
    }
    return n - left;
}
static int64_t sb_xsgetn_base(CpuState *cpu, uint32_t sb, uint32_t dst, int64_t n) {
    int64_t left = n;
    while (left > 0) {
        uint32_t gn = sb_gnext(sb);
        int32_t avail = gn ? sb_gcount(sb) : 0;
        if (avail > 0) {
            int64_t k = avail < left ? avail : left;
            memcpy(isaac_g(dst), isaac_g(gn), (size_t)k);
            sb_set_gcount(sb, avail - (int32_t)k);
            sb_set_gnext(sb, gn + (uint32_t)k);
            dst += (uint32_t)k; left -= k;
        } else {
            int32_t c = sb_uflow_v(cpu, sb);
            if (c == -1) break;
            *(uint8_t *)isaac_g(dst) = (uint8_t)c;
            ++dst; --left;
        }
    }
    return n - left;
}
static int64_t sb_sputn_v(CpuState *cpu, uint32_t sb, uint32_t src, int64_t n) {
    if (slot_is_base(sb, VS_XSPUTN)) return sb_xsputn_base(cpu, sb, src, n);
    uint32_t a[3] = { src, (uint32_t)n, (uint32_t)((uint64_t)n >> 32) };
    uint32_t hi = 0, lo = vcall(cpu, sb, VS_XSPUTN, 3, a, &hi);
    return (int64_t)(((uint64_t)hi << 32) | lo);
}

/* ---- ios_base / basic_ios state ----------------------------------------- */
static void ios_clear(uint32_t B, uint32_t state) {
    if (isaac_r32(B + BIOS_STRBUF) == 0) state |= ST_BAD;
    isaac_w32(B + IOS_STATE, state & ST_MASK);
    if (state & isaac_r32(B + IOS_EXCEPT)) msvcp_fatal("ios_base::failure", 0);
}
static void ios_setstate(uint32_t B, uint32_t state) {
    ios_clear(B, isaac_r32(B + IOS_STATE) | state);
}
/* basic_istream::_Ipfx: the input sentry. Returns 1 when the stream is good
 * and (unless noskip) whitespace has been consumed up to the next token. */
static int istream_ipfx(CpuState *cpu, uint32_t is, uint32_t noskip) {
    uint32_t B = bios_of(is);
    uint32_t sb = isaac_r32(B + BIOS_STRBUF);
    if (isaac_r32(B + IOS_STATE) != 0) {
        ios_setstate(B, ST_FAIL);            /* clear(state|failbit[|badbit if !rdbuf]) */
        return 0;
    }
    /* tie()->flush() is skipped: nothing in this game ties an istream. */
    if (!noskip && (isaac_r32(B + IOS_FMTFL) & FL_SKIPWS)) {
        int32_t c = sb_sgetc(cpu, sb);
        while (c != -1 && is_ws(c)) c = sb_snextc(cpu, sb);
        if (c == -1) { ios_setstate(B, ST_EOF | ST_FAIL); return 0; }
    }
    return 1;
}
static void ios_base_init(uint32_t B) {
    isaac_w32(B + IOS_FMTFL, FL_SKIPWS | FL_DEC);
    isaac_w32(B + IOS_PLOC, 0);
    isaac_w32(B + IOS_STDSTR, 0);
    isaac_w32(B + IOS_EXCEPT, 0);
    isaac_w32(B + IOS_PREC, 6);      isaac_w32(B + IOS_PREC + 4u, 0);
    isaac_w32(B + IOS_WIDE, 0);      isaac_w32(B + IOS_WIDE + 4u, 0);
    isaac_w32(B + IOS_ARR, 0);
    isaac_w32(B + IOS_CALLS, 0);
    isaac_w32(B + IOS_STATE, 0);     /* clear(0): _Mystrbuf not yet set -> no badbit here */
    isaac_w32(B + IOS_PLOC, new_locale());
}
static int msvcp_trace(void) {
    static int v = -1;
    if (v < 0) { const char *e = getenv("ISAAC_MSVCP_TRACE"); v = e && e[0] && e[0] != '0'; }
    return v;
}
static void basic_ios_init(uint32_t B, uint32_t sb) {
    ios_base_init(B);
    isaac_w32(B + BIOS_STRBUF, sb);
    isaac_w32(B + BIOS_TIE, 0);
    *(uint8_t *)isaac_g(B + BIOS_FILL) = ' ';        /* widen(' ') */
    if (!sb) ios_clear(B, ST_BAD);
    if (msvcp_trace())
        isaac_log("[isaac][msvcp] basic_ios_init B=0x%08x sb=0x%08x -> _Mystrbuf@0x%08x=0x%08x",
                  B, sb, B + BIOS_STRBUF, isaac_r32(B + BIOS_STRBUF));
}

/* ===================================================================== */
/*                              exports                                   */
/* ===================================================================== */

/* basic_streambuf::basic_streambuf() (protected, thiscall, ret) */
void imp_msvcp140____0__basic_streambuf_DU__char_traits_D_std___std__IAE_XZ(CpuState *restrict cpu) {
    uint32_t sb = cpu->ECX;
    isaac_w32(sb, VP_STREAMBUF);
    for (uint32_t k = 4; k < SB_SIZE; k += 4) isaac_w32(sb + k, 0);
    isaac_w32(sb + SB_PLOCALE, new_locale());
    /* _Init(): indirection pointers at the in-object slots, slots zeroed */
    isaac_w32(sb + SB_IGFIRST, sb + SB_GFIRST); isaac_w32(sb + SB_IPFIRST, sb + SB_PFIRST);
    isaac_w32(sb + SB_IGNEXT, sb + SB_GNEXT);   isaac_w32(sb + SB_IPNEXT, sb + SB_PNEXT);
    isaac_w32(sb + SB_IGCOUNT, sb + SB_GCOUNT); isaac_w32(sb + SB_IPCOUNT, sb + SB_PCOUNT);
    cpu->EAX = sb;
}
/* basic_streambuf::_Init() (protected, thiscall, ret) */
void imp_msvcp140____Init___basic_streambuf_DU__char_traits_D_std___std__IAEXXZ(CpuState *restrict cpu) {
    uint32_t sb = cpu->ECX;
    isaac_w32(sb + SB_IGFIRST, sb + SB_GFIRST); isaac_w32(sb + SB_IPFIRST, sb + SB_PFIRST);
    isaac_w32(sb + SB_IGNEXT, sb + SB_GNEXT);   isaac_w32(sb + SB_IPNEXT, sb + SB_PNEXT);
    isaac_w32(sb + SB_IGCOUNT, sb + SB_GCOUNT); isaac_w32(sb + SB_IPCOUNT, sb + SB_PCOUNT);
    isaac_w32(sb + SB_GFIRST, 0); isaac_w32(sb + SB_PFIRST, 0);
    isaac_w32(sb + SB_GNEXT, 0);  isaac_w32(sb + SB_PNEXT, 0);
    isaac_w32(sb + SB_GCOUNT, 0); isaac_w32(sb + SB_PCOUNT, 0);
}
/* basic_streambuf::~basic_streambuf() (virtual, thiscall, ret) */
void imp_msvcp140____1__basic_streambuf_DU__char_traits_D_std___std__UAE_XZ(CpuState *restrict cpu) {
    uint32_t sb = cpu->ECX;
    isaac_w32(sb, VP_STREAMBUF);
    uint32_t loc = isaac_r32(sb + SB_PLOCALE);
    if (loc) { isaac_guest_free(loc); isaac_w32(sb + SB_PLOCALE, 0); }
}

/* basic_ios::basic_ios() (protected, thiscall, ret): ios_base() then own fields */
void imp_msvcp140____0__basic_ios_DU__char_traits_D_std___std__IAE_XZ(CpuState *restrict cpu) {
    uint32_t B = cpu->ECX;
    isaac_w32(B, VP_IOS_BASE);
    for (uint32_t k = 8; k <= IOS_PLOC; k += 4) isaac_w32(B + k, 0);
    isaac_w32(B, VP_BASIC_IOS);
    isaac_w32(B + BIOS_STRBUF, 0);
    isaac_w32(B + BIOS_TIE, 0);
    *(uint8_t *)isaac_g(B + BIOS_FILL) = 0;
    cpu->EAX = B;
}
/* basic_ios::~basic_ios() (virtual, thiscall, ret; this = the basic_ios itself) */
void imp_msvcp140____1__basic_ios_DU__char_traits_D_std___std__UAE_XZ(CpuState *restrict cpu) {
    uint32_t B = cpu->ECX;
    isaac_w32(B, VP_IOS_BASE);
    /* _Ios_base_dtor: not a std stream -> _Tidy (iword/pword arrays: unused
       by the game, left alone) and free _Ploc */
    uint32_t loc = isaac_r32(B + IOS_PLOC);
    if (loc) { isaac_guest_free(loc); isaac_w32(B + IOS_PLOC, 0); }
}

/* basic_iostream::basic_iostream(streambuf*, bool most_derived) (thiscall, ret 8) */
void imp_msvcp140____0__basic_iostream_DU__char_traits_D_std___std__QAE_PAV__basic_streambuf_DU__char_traits_D_std___1__Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, sb = isaac_arg(cpu, 0), most = isaac_arg(cpu, 1) & 0xffu;
    if (msvcp_trace())
        isaac_log("[isaac][msvcp] basic_iostream ctor self=0x%08x sb=0x%08x most=%u disp=0x%x",
                  self, sb, most, isaac_r32(isaac_r32(self) + 4u));
    if (most) {
        isaac_w32(self, vbtable(&g_vbt_iostream_is, 0x20u));
        isaac_w32(self + 0x10u, vbtable(&g_vbt_iostream_os, 0x10u));
        CpuState c = *cpu; c.ECX = self + 0x20u;
        imp_msvcp140____0__basic_ios_DU__char_traits_D_std___std__IAE_XZ(&c);
    }
    /* basic_istream(sb, isstd=false, most_derived=false) */
    uint32_t d = isaac_r32(isaac_r32(self) + 4u), B = self + d;
    isaac_w32(B, VP_BIOS_IN_ISTREAM);
    isaac_w32(B - 4u, d - 0x18u);
    isaac_w32(self + 8u, 0); isaac_w32(self + 0xcu, 0);      /* _Chcount */
    basic_ios_init(B, sb);
    /* basic_ostream part through the vbptr at +0x10 */
    uint32_t d2 = isaac_r32(isaac_r32(self + 0x10u) + 4u), B2 = self + 0x10u + d2;
    isaac_w32(B2, VP_BIOS_IN_OSTREAM);
    isaac_w32(B2 - 4u, d2 - 8u);
    isaac_w32(B, VP_BIOS_IN_IOSTREAM);
    isaac_w32(B - 4u, d - 0x20u);
    cpu->EAX = self;
}
/* basic_iostream::~basic_iostream() (virtual, thiscall, ret; ecx = object+0x20) */
void imp_msvcp140____1__basic_iostream_DU__char_traits_D_std___std__UAE_XZ(CpuState *restrict cpu) {
    uint32_t D = cpu->ECX - 0x20u;
    uint32_t d = isaac_r32(isaac_r32(D) + 4u);
    isaac_w32(D + d, VP_BIOS_IN_IOSTREAM); isaac_w32(D + d - 4u, d - 0x20u);
    uint32_t d2 = isaac_r32(isaac_r32(D + 0x10u) + 4u);
    isaac_w32(D + 0x10u + d2, VP_BIOS_IN_OSTREAM); isaac_w32(D + 0x10u + d2 - 4u, d2 - 8u);
    isaac_w32(D + d, VP_BIOS_IN_ISTREAM); isaac_w32(D + d - 4u, d - 0x18u);
}
/* basic_ostream::basic_ostream(streambuf*, bool isstd, bool most_derived) (thiscall, ret 0xc) */
void imp_msvcp140____0__basic_ostream_DU__char_traits_D_std___std__QAE_PAV__basic_streambuf_DU__char_traits_D_std___1__N_Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, sb = isaac_arg(cpu, 0), most = isaac_arg(cpu, 2) & 0xffu;
    if (most) {
        isaac_w32(self, vbtable(&g_vbt_ostream, 8u));
        CpuState c = *cpu; c.ECX = self + 8u;
        imp_msvcp140____0__basic_ios_DU__char_traits_D_std___std__IAE_XZ(&c);
    }
    uint32_t d = isaac_r32(isaac_r32(self) + 4u), B = self + d;
    isaac_w32(B, VP_BIOS_IN_OSTREAM);
    isaac_w32(B - 4u, d - 8u);
    basic_ios_init(B, sb);
    cpu->EAX = self;
}
/* basic_ostream::~basic_ostream() (virtual, thiscall, ret; ecx = object+8) */
void imp_msvcp140____1__basic_ostream_DU__char_traits_D_std___std__UAE_XZ(CpuState *restrict cpu) {
    uint32_t D = cpu->ECX - 8u;
    uint32_t d = isaac_r32(isaac_r32(D) + 4u);
    isaac_w32(D + d, VP_BIOS_IN_OSTREAM); isaac_w32(D + d - 4u, d - 8u);
}

/* basic_istream::_Ipfx(bool noskip) (thiscall, ret 4; bool in al) */
void imp_msvcp140____Ipfx___basic_istream_DU__char_traits_D_std___std__QAE_N_N_Z(CpuState *restrict cpu) {
    if (msvcp_trace())
        isaac_log("[isaac][msvcp] _Ipfx  ESP=0x%08x ESI=0x%08x EDI=0x%08x EBX=0x%08x ret=0x%08x",
                  cpu->ESP, cpu->ESI, cpu->EDI, cpu->EBX, isaac_retaddr(cpu));
    cpu->EAX = (uint32_t)istream_ipfx(cpu, cpu->ECX, isaac_arg(cpu, 0) & 0xffu);
}
/* basic_ios::setstate(int, bool) (thiscall, ret 8; this = basic_ios) */
void imp_msvcp140___setstate___basic_ios_DU__char_traits_D_std___std__QAEXH_N_Z(CpuState *restrict cpu) {
    ios_setstate(cpu->ECX, isaac_arg(cpu, 0));
}
/* ios_base::exceptions(int) (thiscall, ret 4) */
void imp_msvcp140___exceptions_ios_base_std__QAEXH_Z(CpuState *restrict cpu) {
    uint32_t B = cpu->ECX;
    isaac_w32(B + IOS_EXCEPT, isaac_arg(cpu, 0) & ST_MASK);
    ios_clear(B, isaac_r32(B + IOS_STATE));
}
/* basic_ios::widen(char) const (thiscall, ret 4): "C" locale -> identity */
void imp_msvcp140___widen___basic_ios_DU__char_traits_D_std___std__QBEDD_Z(CpuState *restrict cpu) {
    cpu->EAX = isaac_arg(cpu, 0) & 0xffu;
}
/* basic_streambuf::getloc() const (thiscall, ret 4: hidden return slot) */
void imp_msvcp140___getloc___basic_streambuf_DU__char_traits_D_std___std__QBE_AVlocale_2_XZ(CpuState *restrict cpu) {
    uint32_t slot = isaac_arg(cpu, 0), loc = isaac_r32(cpu->ECX + SB_PLOCALE);
    isaac_w32(slot, 0);
    isaac_w32(slot + 4u, loc ? isaac_r32(loc + 4u) : fake_locimp());
    cpu->EAX = slot;
}

/* ---- streambuf public/protected primitives ------------------------------ */
void imp_msvcp140___sgetc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)sb_sgetc(cpu, cpu->ECX);
}
void imp_msvcp140___sbumpc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)sb_sbumpc(cpu, cpu->ECX);
}
void imp_msvcp140___snextc___basic_streambuf_DU__char_traits_D_std___std__QAEHXZ(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)sb_snextc(cpu, cpu->ECX);
}
/* _Pninc(): --*_IPcount; return (*_IPnext)++ (thiscall, ret) */
void imp_msvcp140____Pninc___basic_streambuf_DU__char_traits_D_std___std__IAEPADXZ(CpuState *restrict cpu) {
    uint32_t sb = cpu->ECX, pn = sb_pnext(sb);
    sb_set_pcount(sb, sb_pcount(sb) - 1);
    sb_set_pnext(sb, pn + 1u);
    cpu->EAX = pn;
}
/* sputc(char) (thiscall, ret 4) */
void imp_msvcp140___sputc___basic_streambuf_DU__char_traits_D_std___std__QAEHD_Z(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)sb_sputc(cpu, cpu->ECX, (uint8_t)isaac_arg(cpu, 0));
}
/* sputn(const char*, __int64) (thiscall, ret 0xc; edx:eax) */
void imp_msvcp140___sputn___basic_streambuf_DU__char_traits_D_std___std__QAE_JPBD_J_Z(CpuState *restrict cpu) {
    int64_t n = (int64_t)(((uint64_t)isaac_arg(cpu, 2) << 32) | isaac_arg(cpu, 1));
    isaac_ret64(cpu, (uint64_t)sb_sputn_v(cpu, cpu->ECX, isaac_arg(cpu, 0), n));
}
/* xsgetn / xsputn base virtuals (thiscall, ret 0xc; edx:eax) */
void imp_msvcp140___xsgetn___basic_streambuf_DU__char_traits_D_std___std__MAE_JPAD_J_Z(CpuState *restrict cpu) {
    int64_t n = (int64_t)(((uint64_t)isaac_arg(cpu, 2) << 32) | isaac_arg(cpu, 1));
    isaac_ret64(cpu, (uint64_t)sb_xsgetn_base(cpu, cpu->ECX, isaac_arg(cpu, 0), n));
}
void imp_msvcp140___xsputn___basic_streambuf_DU__char_traits_D_std___std__MAE_JPBD_J_Z(CpuState *restrict cpu) {
    int64_t n = (int64_t)(((uint64_t)isaac_arg(cpu, 2) << 32) | isaac_arg(cpu, 1));
    isaac_ret64(cpu, (uint64_t)sb_xsputn_base(cpu, cpu->ECX, isaac_arg(cpu, 0), n));
}
/* base virtuals reached through the game's vtable thunks */
void imp_msvcp140___uflow___basic_streambuf_DU__char_traits_D_std___std__MAEHXZ(CpuState *restrict cpu) {
    cpu->EAX = (uint32_t)sb_uflow_base(cpu, cpu->ECX);
}
void imp_msvcp140___showmanyc___basic_streambuf_DU__char_traits_D_std___std__MAE_JXZ(CpuState *restrict cpu) {
    isaac_ret64(cpu, 0);
}
void imp_msvcp140___sync___basic_streambuf_DU__char_traits_D_std___std__MAEHXZ(CpuState *restrict cpu) {
    cpu->EAX = 0;
}
void imp_msvcp140___setbuf___basic_streambuf_DU__char_traits_D_std___std__MAEPAV12_PAD_J_Z(CpuState *restrict cpu) {
    cpu->EAX = cpu->ECX;                       /* base: no buffer change, return this */
}
void imp_msvcp140___imbue___basic_streambuf_DU__char_traits_D_std___std__MAEXABVlocale_2__Z(CpuState *restrict cpu) {
    (void)cpu;                                 /* base: no-op */
}
void imp_msvcp140____Lock___basic_streambuf_DU__char_traits_D_std___std__UAEXXZ(CpuState *restrict cpu) { (void)cpu; }
void imp_msvcp140____Unlock___basic_streambuf_DU__char_traits_D_std___std__UAEXXZ(CpuState *restrict cpu) {
    if (msvcp_trace())
        isaac_log("[isaac][msvcp] _Unlock ESP=0x%08x ESI=0x%08x EDI=0x%08x EBX=0x%08x ret=0x%08x",
                  cpu->ESP, cpu->ESI, cpu->EDI, cpu->EBX, isaac_retaddr(cpu));
}

/* ---- ostream operations -------------------------------------------------- */
static void ostream_osfx(CpuState *cpu, uint32_t B) {
    uint32_t sb = isaac_r32(B + BIOS_STRBUF);
    if (isaac_r32(B + IOS_STATE) == 0 && (isaac_r32(B + IOS_FMTFL) & FL_UNITBUF) && sb) {
        if (sb_sync_v(cpu, sb) == -1) ios_setstate(B, ST_BAD);
    }
}
void imp_msvcp140____Osfx___basic_ostream_DU__char_traits_D_std___std__QAEXXZ(CpuState *restrict cpu) {
    ostream_osfx(cpu, bios_of(cpu->ECX));
}
void imp_msvcp140___flush___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_XZ(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, B = bios_of(self), sb = isaac_r32(B + BIOS_STRBUF);
    if (sb) {
        if (isaac_r32(B + IOS_STATE) == 0) {                 /* sentry ok */
            uint32_t st = sb_sync_v(cpu, sb) == -1 ? ST_BAD : 0;
            ios_setstate(B, st);
        }
        ostream_osfx(cpu, B);
    }
    cpu->EAX = self;
}
void imp_msvcp140___put___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_D_Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, B = bios_of(self), sb = isaac_r32(B + BIOS_STRBUF);
    uint32_t st;
    if (isaac_r32(B + IOS_STATE) != 0) st = ST_BAD;
    else st = sb_sputc(cpu, sb, (uint8_t)isaac_arg(cpu, 0)) == -1 ? ST_BAD : 0;
    ios_setstate(B, st);
    ostream_osfx(cpu, B);
    cpu->EAX = self;
}
void imp_msvcp140___write___basic_ostream_DU__char_traits_D_std___std__QAEAAV12_PBD_J_Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, B = bios_of(self), sb = isaac_r32(B + BIOS_STRBUF);
    int64_t n = (int64_t)(((uint64_t)isaac_arg(cpu, 2) << 32) | isaac_arg(cpu, 1));
    uint32_t st = 0;
    if (isaac_r32(B + IOS_STATE) != 0) st = ST_BAD;
    else if (n > 0) st = sb_sputn_v(cpu, sb, isaac_arg(cpu, 0), n) != n ? ST_BAD : 0;
    ios_setstate(B, st);
    ostream_osfx(cpu, B);
    cpu->EAX = self;
}
/* operator<<(ostream& (*pf)(ostream&)) : return pf(*this) */
void imp_msvcp140____6__basic_ostream_DU__char_traits_D_std___std__QAEAAV01_P6AAAV01_AAV01__Z_Z(CpuState *restrict cpu) {
    cpu->EAX = ccall1(cpu, isaac_arg(cpu, 0), cpu->ECX);
}
/* operator<<(ios_base& (*pf)(ios_base&)) : pf(basic_ios); return *this */
void imp_msvcp140____6__basic_ostream_DU__char_traits_D_std___std__QAEAAV01_P6AAAVios_base_1_AAV21__Z_Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX;
    (void)ccall1(cpu, isaac_arg(cpu, 0), bios_of(self));
    cpu->EAX = self;
}
/* operator<<(unsigned __int64) (thiscall, ret 8): num_put::do_put for the
 * basefield/uppercase/showbase/width/fill/adjustfield the game may have set. */
void imp_msvcp140____6__basic_ostream_DU__char_traits_D_std___std__QAEAAV01__K_Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, B = bios_of(self), sb = isaac_r32(B + BIOS_STRBUF);
    uint64_t v = ((uint64_t)isaac_arg(cpu, 1) << 32) | isaac_arg(cpu, 0);
    uint32_t st = 0;
    if (isaac_r32(B + IOS_STATE) == 0) {
        uint32_t fl = isaac_r32(B + IOS_FMTFL);
        char digits[32], prefix[4] = "";
        unsigned base = (fl & FL_BASEFIELD) == FL_HEX ? 16 : (fl & FL_BASEFIELD) == FL_OCT ? 8 : 10;
        const char *alpha = (fl & FL_UPPERCASE) ? "0123456789ABCDEF" : "0123456789abcdef";
        int nd = 0;
        do { digits[nd++] = alpha[v % base]; v /= base; } while (v);
        if (fl & FL_SHOWBASE) {
            if (base == 16) { prefix[0] = '0'; prefix[1] = (fl & FL_UPPERCASE) ? 'X' : 'x'; prefix[2] = 0; }
            else if (base == 8) { prefix[0] = '0'; prefix[1] = 0; }
        } else if (base == 10 && (fl & FL_SHOWPOS)) { prefix[0] = '+'; prefix[1] = 0; }
        int np = (int)strlen(prefix);
        int32_t width = (int32_t)isaac_r32(B + IOS_WIDE);
        int pad = width > nd + np ? width - nd - np : 0;
        uint8_t fill = isaac_r8(B + BIOS_FILL);
        uint32_t adj = fl & FL_ADJUSTFIELD;
        int ok = 1;
        if (adj != FL_LEFT && adj != FL_INTERNAL) for (int i = 0; i < pad && ok; ++i) ok = sb_sputc(cpu, sb, fill) != -1;
        for (int i = 0; i < np && ok; ++i) ok = sb_sputc(cpu, sb, (uint8_t)prefix[i]) != -1;
        if (adj == FL_INTERNAL) for (int i = 0; i < pad && ok; ++i) ok = sb_sputc(cpu, sb, fill) != -1;
        for (int i = nd; i-- > 0 && ok;) ok = sb_sputc(cpu, sb, (uint8_t)digits[i]) != -1;
        if (adj == FL_LEFT) for (int i = 0; i < pad && ok; ++i) ok = sb_sputc(cpu, sb, fill) != -1;
        isaac_w32(B + IOS_WIDE, 0); isaac_w32(B + IOS_WIDE + 4u, 0);
        if (!ok) st = ST_BAD;
    }
    ios_setstate(B, st);
    ostream_osfx(cpu, B);
    cpu->EAX = self;
}

/* ---- istream operations -------------------------------------------------- */
/* operator>>(unsigned __int64&) (thiscall, ret 4): sentry + num_get::do_get */
void imp_msvcp140____5__basic_istream_DU__char_traits_D_std___std__QAEAAV01_AA_K_Z(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX, ref = isaac_arg(cpu, 0), B = bios_of(self);
    uint32_t st = 0;
    if (istream_ipfx(cpu, self, 0)) {
        uint32_t sb = isaac_r32(B + BIOS_STRBUF);
        uint32_t fl = isaac_r32(B + IOS_FMTFL);
        unsigned base = (fl & FL_BASEFIELD) == FL_HEX ? 16 : (fl & FL_BASEFIELD) == FL_OCT ? 8 :
                        (fl & FL_BASEFIELD) == FL_DEC ? 10 : 0;
        int32_t c = sb_sgetc(cpu, sb);
        int neg = 0, nd = 0, overflow = 0;
        uint64_t v = 0;
        if (c == '+' || c == '-') { neg = c == '-'; c = sb_snextc(cpu, sb); }
        if (base == 0) {                                   /* auto: 0x / 0 prefixes */
            if (c == '0') {
                c = sb_snextc(cpu, sb); nd = 1;
                if (c == 'x' || c == 'X') { base = 16; c = sb_snextc(cpu, sb); nd = 0; }
                else base = 8;
            } else base = 10;
        }
        for (;;) {
            int dv;
            if (c >= '0' && c <= '9') dv = c - '0';
            else if (c >= 'a' && c <= 'f') dv = 10 + c - 'a';
            else if (c >= 'A' && c <= 'F') dv = 10 + c - 'A';
            else break;
            if ((unsigned)dv >= base) break;
            if (v > (UINT64_MAX - (uint64_t)dv) / base) overflow = 1;
            else v = v * base + (uint64_t)dv;
            ++nd;
            c = sb_snextc(cpu, sb);
        }
        if (c == -1) st |= ST_EOF;
        if (nd == 0) { st |= ST_FAIL; v = 0; }
        else if (overflow) { st |= ST_FAIL; v = UINT64_MAX; }
        else if (neg) v = (uint64_t)(-(int64_t)v);
        if (nd) { isaac_w32(ref, (uint32_t)v); isaac_w32(ref + 4u, (uint32_t)(v >> 32)); }
    }
    ios_setstate(B, st);
    cpu->EAX = self;
}

/* ---- locale / support ------------------------------------------------------ */
void imp_msvcp140____0_Lockit_std__QAE_H_Z(CpuState *restrict cpu) {
    isaac_w32(cpu->ECX, isaac_arg(cpu, 0));      /* _Locktype; single-threaded: no lock */
    cpu->EAX = cpu->ECX;
}
void imp_msvcp140____1_Lockit_std__QAE_XZ(CpuState *restrict cpu) { (void)cpu; }
void imp_msvcp140___uncaught_exception_std__YA_NXZ(CpuState *restrict cpu) { cpu->EAX = 0; }
void imp_msvcp140___Thrd_yield(CpuState *restrict cpu) { (void)cpu; }
void imp_msvcp140____Getgloballocale_locale_std__CAPAV_Locimp_12_XZ(CpuState *restrict cpu) {
    cpu->EAX = fake_locimp();
}
/* locale::id::operator size_t() (thiscall, ret): lazily numbered ids. The
 * data import `codecvt<char>::id` is bound to a shim token rather than an
 * object, so a non-guest `this` gets a fixed id. */
void imp_msvcp140____Bid_locale_std__QAEIXZ(CpuState *restrict cpu) {
    uint32_t self = cpu->ECX;
    if (!isaac_is_guest_va(self)) { cpu->EAX = 1; return; }
    uint32_t id = isaac_r32(self);
    if (!id) { id = ++g_locale_id_next; isaac_w32(self, id); }
    cpu->EAX = id;
}
/* the throwers: there is no C++ unwinder in the lifted image */
void imp_msvcp140____Xbad_alloc_std__YAXXZ(CpuState *restrict cpu) { (void)cpu; msvcp_fatal("_Xbad_alloc", 0); }
void imp_msvcp140____Xlength_error_std__YAXPBD_Z(CpuState *restrict cpu) { msvcp_fatal("_Xlength_error", isaac_arg(cpu, 0)); }
void imp_msvcp140____Xout_of_range_std__YAXPBD_Z(CpuState *restrict cpu) { msvcp_fatal("_Xout_of_range", isaac_arg(cpu, 0)); }
void imp_msvcp140____Xinvalid_argument_std__YAXPBD_Z(CpuState *restrict cpu) { msvcp_fatal("_Xinvalid_argument", isaac_arg(cpu, 0)); }

/* Not yet implemented (left to the loud weak defaults): _Fiopen and the
 * codecvt facet family (_Getcat, always_noconv, in, out, unshift, id) --
 * the basic_filebuf path behind the fstream constructor 0x009e8010. */
