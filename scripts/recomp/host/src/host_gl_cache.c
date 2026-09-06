/* host_gl_cache.c -- what the game asks GL about that GL already told us.
 *
 * Round 37. A CPU profile of the live page at a 4x CPU throttle (a
 * Chromebook-class budget) put 17% of the frame in WebGL's
 * getRenderbufferParameter, 6% in checkFramebufferStatus and 3% in
 * getUniformLocation/getAttribLocation: the engine re-validates every render
 * target each frame (0x00a18750 binds the renderbuffer and asks its width,
 * height and format back) and looks its uniforms up by name per draw. Each
 * of those is a synchronous round trip into the GL driver. Every answer is
 * a function of what the game itself set, so this module keeps that state
 * and the web wrappers (host_gl_webgl.c) answer from it; anything it does
 * not know falls through to the real GL call, so the answers stay exact.
 *
 *   renderbuffers: name -> (width, height, internal format, samples) from
 *     glRenderbufferStorage; GL_RENDERBUFFER_WIDTH/HEIGHT/INTERNAL_FORMAT/
 *     SAMPLES and the component sizes of the sized formats are answered.
 *   framebuffer status: (name, attachment configuration) -> the status GL
 *     returned, remembered until an attached image changes: an attached
 *     renderbuffer gets different storage, an attached texture gets a new
 *     image (the bound 2D texture per unit is tracked for that), an
 *     attached object is deleted, or the framebuffer itself is. Changing an
 *     attachment only changes which configuration is current; the engine
 *     re-attaches the same texture every frame and swaps textures through
 *     one attachment point, and both come back as hits. The default
 *     framebuffer is always complete.
 *   locations: (program, attrib|uniform, name) -> location, forgotten when
 *     the program is linked again or deleted.
 *
 * Pure C over its own tables, no GL: the selftest drives it directly. */
#include "isaac_host.h"
#include <string.h>
#include <stdint.h>

static uint32_t g_rb_hit, g_rb_miss, g_fbo_hit, g_fbo_miss, g_loc_hit, g_loc_miss, g_readpixels;
static uint32_t g_rp_maxw, g_rp_maxh, g_rp_fmt, g_rp_x, g_rp_y;   /* the largest read the game asked for */
static uint64_t g_rp_bytes;
static uint32_t g_att_same, g_att_change, g_sto_same, g_sto_change, g_tex_forget, g_del_forget;

/* ---- renderbuffers ------------------------------------------------------ */
#define GLC_RB 256
typedef struct { uint32_t name, w, h, fmt, samples; uint8_t live; } glc_rb;
static glc_rb g_rb[GLC_RB];
static uint32_t g_rb_bound;
static uint32_t fbo_forget_attachment(uint8_t kind, uint32_t name);

static int rb_find(uint32_t name) {
    if (!name) return -1;
    for (int i = 0; i < GLC_RB; ++i) if (g_rb[i].live && g_rb[i].name == name) return i;
    return -1;
}
void isaac_glc_rb_bind(uint32_t name) { g_rb_bound = name; }
void isaac_glc_rb_storage(uint32_t fmt, uint32_t w, uint32_t h, uint32_t samples) {
    if (!g_rb_bound) return;
    int i = rb_find(g_rb_bound);
    if (i >= 0 && g_rb[i].w == w && g_rb[i].h == h && g_rb[i].fmt == fmt && g_rb[i].samples == samples) {
        ++g_sto_same;                     /* the same storage again: completeness unchanged */
        return;
    }
    g_sto_change += fbo_forget_attachment(0, g_rb_bound);
    if (i < 0) for (int k = 0; k < GLC_RB; ++k) if (!g_rb[k].live) { i = k; break; }
    if (i < 0) return;                    /* table full: the real GL answers */
    g_rb[i].live = 1; g_rb[i].name = g_rb_bound;
    g_rb[i].w = w; g_rb[i].h = h; g_rb[i].fmt = fmt; g_rb[i].samples = samples;
}
void isaac_glc_rb_delete(uint32_t name) {
    int i = rb_find(name);
    if (i >= 0) g_rb[i].live = 0;
    if (g_rb_bound == name) g_rb_bound = 0;
    g_del_forget += fbo_forget_attachment(0, name);
}
/* component sizes of the sized formats (GL ES 3 names) */
static int rb_sizes(uint32_t fmt, uint32_t *r, uint32_t *g, uint32_t *b, uint32_t *a, uint32_t *d, uint32_t *s) {
    *r = *g = *b = *a = *d = *s = 0;
    switch (fmt) {
    case 0x8058u: *r = *g = *b = *a = 8; return 1;              /* GL_RGBA8 */
    case 0x8051u: *r = *g = *b = 8; return 1;                   /* GL_RGB8 */
    case 0x8056u: *r = *g = *b = *a = 4; return 1;              /* GL_RGBA4 */
    case 0x8057u: *r = *g = *b = 5; *a = 1; return 1;           /* GL_RGB5_A1 */
    case 0x8D62u: *r = 5; *g = 6; *b = 5; return 1;             /* GL_RGB565 */
    case 0x81A5u: *d = 16; return 1;                            /* GL_DEPTH_COMPONENT16 */
    case 0x81A6u: *d = 24; return 1;                            /* GL_DEPTH_COMPONENT24 */
    case 0x8CACu: *d = 32; return 1;                            /* GL_DEPTH_COMPONENT32F */
    case 0x88F0u: *d = 24; *s = 8; return 1;                    /* GL_DEPTH24_STENCIL8 */
    case 0x8D48u: *s = 8; return 1;                             /* GL_STENCIL_INDEX8 */
    default: return 0;
    }
}
int isaac_glc_rb_param(uint32_t pname, uint32_t *out) {
    int i = rb_find(g_rb_bound);
    uint32_t r, g, b, a, d, s;
    int ok = 0;
    if (i >= 0) switch (pname) {
    case 0x8D42u: *out = g_rb[i].w; ok = 1; break;              /* GL_RENDERBUFFER_WIDTH */
    case 0x8D43u: *out = g_rb[i].h; ok = 1; break;              /* GL_RENDERBUFFER_HEIGHT */
    case 0x8D44u: *out = g_rb[i].fmt; ok = 1; break;            /* GL_RENDERBUFFER_INTERNAL_FORMAT */
    case 0x8CABu: *out = g_rb[i].samples; ok = 1; break;        /* GL_RENDERBUFFER_SAMPLES */
    case 0x8D50u: case 0x8D51u: case 0x8D52u: case 0x8D53u: case 0x8D54u: case 0x8D55u:
        if (!rb_sizes(g_rb[i].fmt, &r, &g, &b, &a, &d, &s)) break;
        *out = pname == 0x8D50u ? r : pname == 0x8D51u ? g : pname == 0x8D52u ? b
             : pname == 0x8D53u ? a : pname == 0x8D54u ? d : s;
        ok = 1; break;
    default: break;
    }
    if (ok) ++g_rb_hit; else ++g_rb_miss;
    return ok;
}

/* ---- textures (only what the framebuffer memo needs) ---------------------- */
#define GLC_UNITS 32
static uint32_t g_tex_unit;
static uint32_t g_tex_bound[GLC_UNITS];
void isaac_glc_tex_active(uint32_t unit) {
    unit -= 0x84C0u;                                            /* GL_TEXTURE0 */
    if (unit < GLC_UNITS) g_tex_unit = unit;
}
void isaac_glc_tex_bind(uint32_t target, uint32_t name) {
    if (target == 0x0DE1u) g_tex_bound[g_tex_unit] = name;      /* GL_TEXTURE_2D */
}
void isaac_glc_tex_image(uint32_t target) {
    if (target == 0x0DE1u) g_tex_forget += fbo_forget_attachment(1, g_tex_bound[g_tex_unit]);
    else g_tex_forget += fbo_forget_attachment(1, 0);           /* another target: forget every framebuffer */
}
void isaac_glc_tex_delete(uint32_t name) {
    for (unsigned u = 0; u < GLC_UNITS; ++u) if (g_tex_bound[u] == name) g_tex_bound[u] = 0;
    g_del_forget += fbo_forget_attachment(1, name);
}

/* ---- framebuffer status -------------------------------------------------- */
/* A framebuffer's completeness is a function of its attachment configuration
 * (which image sits at which attachment point) and of those images' storage.
 * The engine ping-pongs different textures through one attachment point of
 * one framebuffer within a frame (the census of the first cut: 4,462
 * attachment changes in 3,000 frames, 1.5 a frame), so the memo is keyed by
 * the configuration: each framebuffer remembers the status GL returned for
 * up to GLC_MEMO recent configurations, and a configuration seen before is
 * answered when it comes back. Anything that changes an attached image's
 * storage (new renderbuffer storage, a new texture image, a deletion)
 * forgets every configuration of the framebuffers that reference it. */
#define GLC_FBO 256
#define GLC_ATT 8
#define GLC_MEMO 8
#define GLC_SEEN 16
typedef struct {
    uint32_t name;
    uint8_t live, many, natt, next, nseen;
    uint8_t  skind[GLC_SEEN];         /* images a remembered configuration still refers to but the slots no longer do */
    uint32_t sname[GLC_SEEN];
    uint32_t apoint[GLC_ATT];         /* the attachment point (GL_COLOR_ATTACHMENT0 ...) */
    uint8_t  akind[GLC_ATT];          /* 0 renderbuffer, 1 texture */
    uint32_t aname[GLC_ATT];
    uint32_t aextra[GLC_ATT];         /* textures: target << 8 ^ level */
    uint32_t msig[GLC_MEMO], mstatus[GLC_MEMO];
    uint8_t  mlive[GLC_MEMO];
} glc_fbo;
static glc_fbo g_fbo[GLC_FBO];
static uint32_t g_fbo_draw, g_fbo_read;   /* bound names per target */
static int fbo_find(uint32_t name, int make) {
    for (int i = 0; i < GLC_FBO; ++i) if (g_fbo[i].live && g_fbo[i].name == name) return i;
    if (!make) return -1;
    for (int i = 0; i < GLC_FBO; ++i) if (!g_fbo[i].live) { memset(&g_fbo[i], 0, sizeof g_fbo[i]); g_fbo[i].live = 1; g_fbo[i].name = name; return i; }
    return -1;
}
static uint32_t fbo_bound(uint32_t target) {
    return target == 0x8CA8u ? g_fbo_read : g_fbo_draw;    /* GL_READ_FRAMEBUFFER, else the draw binding */
}
static int fbo_has(const glc_fbo *f, uint8_t kind, uint32_t name) {
    for (unsigned k = 0; k < f->natt; ++k) if (f->akind[k] == kind && f->aname[k] == name) return 1;
    for (unsigned k = 0; k < f->nseen; ++k) if (f->skind[k] == kind && f->sname[k] == name) return 1;
    return 0;
}
static uint32_t fbo_sig(const glc_fbo *f) {          /* the configuration's signature (FNV over the slots) */
    uint32_t h = 2166136261u;
    for (unsigned k = 0; k < f->natt; ++k) {
        uint32_t v[4] = { f->apoint[k], f->akind[k], f->aname[k], f->aextra[k] };
        for (unsigned j = 0; j < 4; ++j) { h ^= v[j]; h *= 16777619u; h ^= h >> 15; }
    }
    return h;
}
static int fbo_memo_valid(const glc_fbo *f) {
    for (unsigned m = 0; m < GLC_MEMO; ++m) if (f->mlive[m]) return 1;
    return 0;
}
static void fbo_memo_clear(glc_fbo *f) { memset(f->mlive, 0, sizeof f->mlive); f->next = 0; f->nseen = 0; }
/* an image leaves a slot while configurations that used it may still be remembered */
static void fbo_seen(glc_fbo *f, uint8_t kind, uint32_t name) {
    if (!name || !fbo_memo_valid(f)) return;
    for (unsigned k = 0; k < f->nseen; ++k) if (f->skind[k] == kind && f->sname[k] == name) return;
    if (f->nseen >= GLC_SEEN) { fbo_memo_clear(f); return; }     /* too many to track: start over */
    f->skind[f->nseen] = kind; f->sname[f->nseen] = name; ++f->nseen;
}
/* name 0: forget every framebuffer (the caller could not tell which). Returns how many were forgotten. */
static uint32_t fbo_forget_attachment(uint8_t kind, uint32_t name) {
    uint32_t n = 0;
    for (int i = 0; i < GLC_FBO; ++i) {
        if (!g_fbo[i].live || !fbo_memo_valid(&g_fbo[i])) continue;
        if (!name || g_fbo[i].many || fbo_has(&g_fbo[i], kind, name)) { fbo_memo_clear(&g_fbo[i]); ++n; }
    }
    return n;
}
void isaac_glc_fbo_bind(uint32_t target, uint32_t name) {
    if (target == 0x8D40u) { g_fbo_draw = g_fbo_read = name; }         /* GL_FRAMEBUFFER */
    else if (target == 0x8CA9u) g_fbo_draw = name;                     /* GL_DRAW_FRAMEBUFFER */
    else if (target == 0x8CA8u) g_fbo_read = name;                     /* GL_READ_FRAMEBUFFER */
}
/* an attachment call on the bound framebuffer: kind 0 renderbuffer, 1 texture;
 * extra is the texture target and level (0 for a renderbuffer). Only the
 * configuration changes; the statuses remembered for other configurations
 * stay good, because no image changed. */
void isaac_glc_fbo_attach(uint32_t target, uint32_t attachment, uint8_t kind, uint32_t name, uint32_t extra) {
    uint32_t fb = fbo_bound(target);
    if (!fb) return;
    int i = fbo_find(fb, 1);
    if (i < 0) return;
    glc_fbo *f = &g_fbo[i];
    for (unsigned k = 0; k < f->natt; ++k) {
        if (f->apoint[k] != attachment) continue;
        if (f->akind[k] == kind && f->aname[k] == name && f->aextra[k] == extra) { ++g_att_same; return; }
        fbo_seen(f, f->akind[k], f->aname[k]);
        f->akind[k] = kind; f->aname[k] = name; f->aextra[k] = extra;
        ++g_att_change;
        return;
    }
    ++g_att_change;
    if (f->natt >= GLC_ATT) { f->many = 1; fbo_memo_clear(f); return; }   /* too many to track: never answered */
    f->apoint[f->natt] = attachment; f->akind[f->natt] = kind; f->aname[f->natt] = name; f->aextra[f->natt] = extra;
    ++f->natt;
}
void isaac_glc_fbo_delete(uint32_t name) {
    int i = fbo_find(name, 0);
    if (i >= 0) g_fbo[i].live = 0;
    if (g_fbo_draw == name) g_fbo_draw = 0;
    if (g_fbo_read == name) g_fbo_read = 0;
}
int isaac_glc_fbo_status(uint32_t target, uint32_t *status) {
    uint32_t name = fbo_bound(target);
    if (!name) { *status = 0x8CD5u; ++g_fbo_hit; return 1; }     /* the default framebuffer: GL_FRAMEBUFFER_COMPLETE */
    int i = fbo_find(name, 0);
    if (i >= 0 && !g_fbo[i].many) {
        uint32_t sig = fbo_sig(&g_fbo[i]);
        for (unsigned m = 0; m < GLC_MEMO; ++m)
            if (g_fbo[i].mlive[m] && g_fbo[i].msig[m] == sig) { *status = g_fbo[i].mstatus[m]; ++g_fbo_hit; return 1; }
    }
    ++g_fbo_miss;
    return 0;
}
void isaac_glc_fbo_set_status(uint32_t target, uint32_t status) {
    uint32_t name = fbo_bound(target);
    if (!name) return;
    int i = fbo_find(name, 1);
    if (i < 0 || g_fbo[i].many) return;
    glc_fbo *f = &g_fbo[i];
    uint32_t sig = fbo_sig(f);
    for (unsigned m = 0; m < GLC_MEMO; ++m)
        if (f->mlive[m] && f->msig[m] == sig) { f->mstatus[m] = status; return; }
    f->msig[f->next] = sig; f->mstatus[f->next] = status; f->mlive[f->next] = 1;   /* round robin */
    f->next = (uint8_t)((f->next + 1u) % GLC_MEMO);
}

/* ---- program locations --------------------------------------------------- */
#define GLC_LOC 4096
#define GLC_NAME 48
typedef struct { uint32_t prog; uint8_t kind, live; char name[GLC_NAME]; int32_t loc; } glc_loc;
static glc_loc g_loc[GLC_LOC];
static glc_loc g_loc_scratch[GLC_LOC];    /* the rebuild buffer for a flush (not the wasm stack) */
static uint32_t loc_hash(uint32_t prog, uint8_t kind, const char *name) {
    uint32_t h = 2166136261u ^ prog ^ ((uint32_t)kind << 24);
    for (; *name; ++name) { h ^= (uint8_t)*name; h *= 16777619u; }
    return h & (GLC_LOC - 1u);
}
int isaac_glc_loc_get(uint32_t prog, uint8_t kind, const char *name, int32_t *loc) {
    if (!name || strlen(name) >= GLC_NAME) { ++g_loc_miss; return 0; }
    uint32_t h = loc_hash(prog, kind, name);
    for (uint32_t n = 0; n < GLC_LOC; ++n, h = (h + 1u) & (GLC_LOC - 1u)) {
        if (!g_loc[h].live) break;
        if (g_loc[h].prog == prog && g_loc[h].kind == kind && strcmp(g_loc[h].name, name) == 0) {
            *loc = g_loc[h].loc; ++g_loc_hit; return 1;
        }
    }
    ++g_loc_miss;
    return 0;
}
void isaac_glc_loc_put(uint32_t prog, uint8_t kind, const char *name, int32_t loc) {
    if (!name || strlen(name) >= GLC_NAME) return;
    uint32_t h = loc_hash(prog, kind, name);
    for (uint32_t n = 0; n < GLC_LOC; ++n, h = (h + 1u) & (GLC_LOC - 1u)) {
        if (!g_loc[h].live || (g_loc[h].prog == prog && g_loc[h].kind == kind && strcmp(g_loc[h].name, name) == 0)) {
            g_loc[h].live = 1; g_loc[h].prog = prog; g_loc[h].kind = kind; g_loc[h].loc = loc;
            strcpy(g_loc[h].name, name);
            return;
        }
    }
}
void isaac_glc_loc_flush(uint32_t prog) {           /* a link or a delete: every name of that program dies */
    unsigned n = 0;
    for (unsigned i = 0; i < GLC_LOC; ++i) if (g_loc[i].live && g_loc[i].prog != prog) g_loc_scratch[n++] = g_loc[i];
    memset(g_loc, 0, sizeof g_loc);
    for (unsigned i = 0; i < n; ++i) isaac_glc_loc_put(g_loc_scratch[i].prog, g_loc_scratch[i].kind, g_loc_scratch[i].name, g_loc_scratch[i].loc);
}

/* ---- census -------------------------------------------------------------- */
void isaac_glc_count_readpixels(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t fmt, uint32_t bpp) {
    ++g_readpixels;
    g_rp_bytes += (uint64_t)w * h * bpp;
    if ((uint64_t)w * h >= (uint64_t)g_rp_maxw * g_rp_maxh) { g_rp_maxw = w; g_rp_maxh = h; g_rp_fmt = fmt; g_rp_x = x; g_rp_y = y; }
}
void isaac_glc_report(void) {
    isaac_log("[isaac][gl] host cache: renderbuffer params %u answered / %u to GL, framebuffer status %u / %u "
              "(forgotten by %u attachment changes, %u storage changes, %u texture images, %u deletes; "
              "%u same-attachment and %u same-storage calls kept it), locations %u / %u; glReadPixels by the game: %u "
              "(largest %ux%u at %u,%u format 0x%x; %llu bytes in all)",
              g_rb_hit, g_rb_miss, g_fbo_hit, g_fbo_miss, g_att_change, g_sto_change, g_tex_forget, g_del_forget,
              g_att_same, g_sto_same, g_loc_hit, g_loc_miss, g_readpixels,
              g_rp_maxw, g_rp_maxh, g_rp_x, g_rp_y, g_rp_fmt, (unsigned long long)g_rp_bytes);
}
void isaac_glc_reset(void) {                        /* the selftest starts clean */
    memset(g_rb, 0, sizeof g_rb); g_rb_bound = 0;
    memset(g_fbo, 0, sizeof g_fbo); g_fbo_draw = g_fbo_read = 0;
    memset(g_loc, 0, sizeof g_loc);
    memset(g_tex_bound, 0, sizeof g_tex_bound); g_tex_unit = 0;
    g_rb_hit = g_rb_miss = g_fbo_hit = g_fbo_miss = g_loc_hit = g_loc_miss = g_readpixels = 0;
    g_att_same = g_att_change = g_sto_same = g_sto_change = g_tex_forget = g_del_forget = 0;
}
