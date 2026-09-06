/* host_gl_webgl.c -- the WEB build's GL backend (round 13c).
 *
 * Every opengl32 entry point the game resolves through wglGetProcAddress is
 * forwarded to the real GLES3 function emscripten binds to the page's WebGL2
 * context (created by wglCreateContext in host_shims_gl.c). The node build
 * keeps the headless fake in host_shims_gl.c; this file compiles only with
 * -DISAAC_WEB=1 (build_boot.py --web).
 *
 * Calling convention on the guest side: __stdcall, arguments on the guest
 * stack (isaac_arg), floats as raw IEEE bits, doubles as two slots, pointers
 * as guest VAs. Guest memory is the wasm heap, so a guest pointer becomes a
 * host pointer with isaac_g() and can be handed to GL directly (input arrays,
 * output arrays, strings).
 *
 * What the census (round 13a, 60 frames) says the game passes, and how it
 * maps:
 *   textures      glTexImage2D(RGBA|RGB, RGBA|RGB, UNSIGNED_BYTE), NEAREST /
 *                 LINEAR filters, CLAMP_TO_EDGE / REPEAT wrap   -> 1:1
 *   targets       renderbuffer DEPTH_COMPONENT24, color attachment 0 texture,
 *                 GL_FRAMEBUFFER_BINDING read back                 -> 1:1
 *   state         BLEND / DEPTH_TEST / CULL_FACE, GREATER, BACK/FRONT,
 *                 FUNC_ADD, (ONE, ONE_MINUS_SRC_ALPHA) premultiplied -> 1:1
 *   geometry      client-side arrays, TRIANGLES + UNSIGNED_SHORT
 *                 -> host_gl_clientarrays.c stages them into VBOs
 *   shaders       23 programs, GLSL ES 1.00 style sources
 *                 (attribute/varying, precision highp) -> 1:1
 *   desktop-only  glClearDepth(double) -> glClearDepthf; glDrawArraysInstancedEXT
 *                 -> glDrawArraysInstanced; NV/ATI/ARB oddities -> no-ops
 * Nothing needed enum translation. Unknown values are still passed through
 * and would surface as GL errors, which isaac_web_present() polls once per
 * frame (glGetError) and logs. */
#ifdef ISAAC_WEB
#include "isaac_host.h"
#include "shim_decls.h"

#include <GLES3/gl3.h>
#include <stdlib.h>                    /* round 60: getenv for the band switch, ahead of the report */

/* Round 60: a large upload goes in bands. Chrome's GL client stages every
 * texImage2D through a mapped transfer chunk sized for the upload, and keeps
 * the chunk: one 4096x4096 RGBA sheet (64 MB) left a 64 MB and a 32 MB chunk
 * resident in the renderer and, as shared memory, in the GPU process for the
 * page's life (memory-infra, drive_memory.mjs). The same texels arrive as a
 * null allocation plus glTexSubImage2D rows of at most TEX_BAND_BYTES, so the
 * chunk never grows past that. RGBA / RGB / LUMINANCE(_ALPHA) UNSIGNED_BYTE
 * only (all the engine uses); the unpack alignment is the default 4 (the
 * engine never sets it). ISAAC_GL_TEX_BAND=0 keeps the whole uploads (the A/B). */
#define TEX_BAND_BYTES (4u << 20)
static int g_tex_band_mode = -1;
static uint32_t g_tex_uploads, g_tex_banded, g_tex_bands;
static int tex_band_mode(void) {
    if (g_tex_band_mode < 0) { const char *e = getenv("ISAAC_GL_TEX_BAND"); g_tex_band_mode = (e && *e == '0') ? 0 : 1; }
    return g_tex_band_mode;
}
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdlib.h>
#include <string.h>

#define A(i)      isaac_arg(cpu, (i))
#define AF(i)     arg_f(cpu, (i))
#define AP(i)     arg_p(cpu, (i))
#define RET0      do { cpu->EAX = 0; return; } while (0)

static float arg_f(CpuState *restrict cpu, unsigned i) {
    uint32_t bits = isaac_arg(cpu, i);
    float f;
    memcpy(&f, &bits, 4);
    return f;
}
static void *arg_p(CpuState *restrict cpu, unsigned i) {
    uint32_t va = isaac_arg(cpu, i);
    return va ? isaac_g(va) : NULL;
}

/* client-array emulation (host_gl_clientarrays.c) */
void isaac_gl_enable_vertex_attrib_array(GLuint index);
void isaac_gl_disable_vertex_attrib_array(GLuint index);
void isaac_gl_vertex_attrib_pointer(GLuint index, GLint size, GLenum type,
                                    GLboolean normalized, GLsizei stride,
                                    uint32_t pointer_va);
void isaac_gl_draw_elements(GLenum mode, GLsizei count, GLenum type, uint32_t indices_va);
void isaac_gl_draw_arrays_instanced(GLenum mode, GLint first, GLsizei count, GLsizei prims);
int  isaac_web_gl_ready(void);
static int gl_check_mode(void);
/* the host-side GL cache (host_gl_cache.c, round 37) */
void isaac_glc_rb_bind(uint32_t name);
void isaac_glc_rb_storage(uint32_t fmt, uint32_t w, uint32_t h, uint32_t samples);
void isaac_glc_rb_delete(uint32_t name);
int  isaac_glc_rb_param(uint32_t pname, uint32_t *out);
void isaac_glc_tex_active(uint32_t unit);
void isaac_glc_tex_bind(uint32_t target, uint32_t name);
void isaac_glc_tex_image(uint32_t target);
void isaac_glc_tex_delete(uint32_t name);
void isaac_glc_fbo_bind(uint32_t target, uint32_t name);
void isaac_glc_fbo_attach(uint32_t target, uint32_t attachment, uint8_t kind, uint32_t name, uint32_t extra);
void isaac_glc_fbo_delete(uint32_t name);
int  isaac_glc_fbo_status(uint32_t target, uint32_t *status);
void isaac_glc_fbo_set_status(uint32_t target, uint32_t status);
int  isaac_glc_loc_get(uint32_t prog, uint8_t kind, const char *name, int32_t *loc);
void isaac_glc_loc_put(uint32_t prog, uint8_t kind, const char *name, int32_t loc);
void isaac_glc_loc_flush(uint32_t prog);
void isaac_glc_count_readpixels(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t fmt, uint32_t bpp);
void isaac_glc_report(void);

static uint32_t g_gl_calls, g_gl_errors;
static uint32_t g_present_count;

/* Round 44: redundant state calls are not forwarded. The engine re-issues
 * the same glUseProgram (73 a frame), glActiveTexture(GL_TEXTURE0) (30),
 * glBindTexture (30), glBlendFuncSeparate (32, four distinct tuples in a
 * run) and glViewport (9, eight distinct) every frame; each is a wasm->JS->
 * native round trip. The state below mirrors what GL holds, is updated on
 * every forwarded call, and a call that would set what is already set is
 * skipped (counted; the report prints the census). A program or texture
 * deletion clears what referred to it; a name GL is still using cannot be
 * handed out again, so an equal name always is the same object. */
#define GLS_UNITS 32
static uint32_t gls_prog, gls_unit, gls_tex2d[GLS_UNITS], gls_texcube[GLS_UNITS];
static uint32_t gls_blend[4], gls_blend_eq, gls_vp[4];
static uint8_t gls_prog_ok, gls_unit_ok, gls_blend_ok, gls_blend_eq_ok, gls_vp_ok;
static uint32_t gls_skip_prog, gls_skip_unit, gls_skip_tex, gls_skip_blend, gls_skip_vp;
/* Round 48: the same idea for the vertex-attribute enables (the engine
 * enables its attributes before every draw) and for uniforms: the current
 * program's (location -> last value) is mirrored, and a glUniform* that
 * would set what the program already holds is skipped. Uniform values live
 * in the program object and reset on a link, so a link or a delete forgets
 * that program's entries; a call with no current program is forwarded (GL
 * reports the error). */
#define GLS_ATTRIBS 16
static uint8_t gls_attrib_on[GLS_ATTRIBS], gls_attrib_known[GLS_ATTRIBS];
static uint32_t gls_skip_attrib, gls_skip_uniform;
#define GLU_SLOTS 1024
typedef struct { uint32_t prog; int32_t loc; uint8_t kind, n, live; uint32_t v[16]; } glu_ent;
static glu_ent g_glu[GLU_SLOTS];
static glu_ent *glu_slot(int32_t loc) {
    uint32_t h = (gls_prog * 2654435761u) ^ ((uint32_t)loc * 40503u);
    return &g_glu[(h ^ (h >> 16)) & (GLU_SLOTS - 1u)];
}
/* 1 when the current program already holds these n words at loc (kind tells the call apart) */
static int glu_same(int32_t loc, uint8_t kind, const void *vals, unsigned n) {
    if (!gls_prog_ok || n > 16u) return 0;
    glu_ent *e = glu_slot(loc);
    if (e->live && e->prog == gls_prog && e->loc == loc && e->kind == kind && e->n == n && memcmp(e->v, vals, n * 4u) == 0) return 1;
    e->live = 1; e->prog = gls_prog; e->loc = loc; e->kind = kind; e->n = (uint8_t)n;
    memcpy(e->v, vals, n * 4u);
    return 0;
}
static void glu_forget(uint32_t prog) {
    for (unsigned i = 0; i < GLU_SLOTS; ++i) if (g_glu[i].live && g_glu[i].prog == prog) g_glu[i].live = 0;
}

/* ---- context capability answers the shared shim delegates here ---------- */
void isaac_web_get_integerv(uint32_t pname, uint32_t out) {
    GLint v[4] = {0, 0, 0, 0};
    if (isaac_web_gl_ready()) glGetIntegerv((GLenum)pname, v);
    if (isaac_is_guest_va(out)) isaac_w32(out, (uint32_t)v[0]);
    if (pname == 0x0D3Au && isaac_is_guest_va(out + 4)) isaac_w32(out + 4, (uint32_t)v[1]);
}

/* ---- frame presentation --------------------------------------------------- */
EM_JS(void, isaac_present_js, (const uint8_t *px, int w, int h), {
    if (typeof Module.isaacPresent === "function") Module.isaacPresent(px, w, h);
});
/* The canvas already shows every frame; the readback exists only so the
 * runner can keep PNGs. Reading a 960x540 frame back is 2 MB through
 * glReadPixels, which stalls the GL pipeline, so ask the page first and skip
 * the whole thing for the frames it does not want (round 17). A page that
 * defines no hook keeps the old behaviour and gets every frame. */
EM_JS(int, isaac_wants_frame_js, (unsigned n), {
    if (typeof Module.isaacWantsFrame !== "function") return 1;
    try { return Module.isaacWantsFrame(n) ? 1 : 0; } catch (e) { return 1; }
});
static uint8_t *g_present_buf;
static uint32_t g_present_cap;
void isaac_web_present(void) {
    if (!isaac_web_gl_ready()) return;
    ++g_present_count;
    /* Round 37: glGetError was 1% of a throttled frame. GL errors are sticky
     * until read, so draining every 64th present still catches any (the
     * count is a lower bound); ISAAC_GL_CHECK=1 drains every present. */
    if (gl_check_mode() || (g_present_count & 63u) == 1u) {
        GLenum err;
        while ((err = glGetError()) != GL_NO_ERROR) {
            ++g_gl_errors;
            if (g_gl_errors <= 20)
                isaac_log("[isaac][gl] GL error 0x%x pending at present #%u", err, g_present_count);
        }
    }
    if (!isaac_wants_frame_js(g_present_count)) return;   /* no PNG wanted: no readback */
    int w = 0, h = 0;
    emscripten_webgl_get_drawing_buffer_size(emscripten_webgl_get_current_context(), &w, &h);
    if (w <= 0 || h <= 0) return;
    uint32_t need = (uint32_t)w * (uint32_t)h * 4u;
    if (need > g_present_cap) {
        free(g_present_buf);
        g_present_buf = (uint8_t *)malloc(need);
        g_present_cap = g_present_buf ? need : 0;
    }
    if (!g_present_buf) return;
    GLint prev = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &prev);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, g_present_buf);
    glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)prev);
    isaac_present_js(g_present_buf, w, h);
}
void isaac_web_gl_report(void) {
    isaac_log("[isaac][gl] web backend: %u GL calls, %u GL errors, %u frames presented",
              g_gl_calls, g_gl_errors, g_present_count);
    isaac_glc_report();
    isaac_log("[isaac][gl] texture uploads: %u, %u of them in bands of %u MB (%u bands)%s",
              g_tex_uploads, g_tex_banded, TEX_BAND_BYTES >> 20, g_tex_bands, tex_band_mode() ? "" : " -- ISAAC_GL_TEX_BAND=0");
    isaac_log("[isaac][gl] redundant state calls skipped: useProgram %u, activeTexture %u, bindTexture %u, blend %u, viewport %u, "
              "attrib enables %u, uniforms %u",
              gls_skip_prog, gls_skip_unit, gls_skip_tex, gls_skip_blend, gls_skip_vp, gls_skip_attrib, gls_skip_uniform);
}

/* ---- the entry points ------------------------------------------------------ */
/* ISAAC_GL_CHECK=1: glGetError after every forwarded call, naming it. */
static int gl_check_mode(void) {
    static int v = -1;
    if (v < 0) { const char *e = getenv("ISAAC_GL_CHECK"); v = (e && *e && *e != '0') ? 1 : 0; }
    return v;
}
static void gl_check(const char *fn) {
    if (!gl_check_mode()) return;
    GLenum err;
    while ((err = glGetError()) != GL_NO_ERROR) {
        ++g_gl_errors;
        if (g_gl_errors <= 50) isaac_log("[isaac][gl] %s -> GL error 0x%x", fn, err);
    }
}
#define GLFN(name) void imp_opengl32__##name(CpuState *restrict cpu)
#define ENTER      const char *gl_fn_name = __func__; do { ++g_gl_calls; } while (0)
#undef RET0
#define RET0       do { gl_check(gl_fn_name); cpu->EAX = 0; return; } while (0)
#define RETV(v)    do { cpu->EAX = (uint32_t)(v); gl_check(gl_fn_name); return; } while (0)

/* Shader types by name, for the precision default below. */
#define GL_SHADER_NAMES 4096
static uint8_t g_shader_is_frag[GL_SHADER_NAMES];

GLFN(glClear)                { ENTER; glClear(A(0)); RET0; }
GLFN(glActiveTexture) {
    ENTER;
    isaac_glc_tex_active(A(0));
    if (gls_unit_ok && gls_unit == A(0)) { ++gls_skip_unit; RET0; }
    gls_unit = A(0); gls_unit_ok = 1;
    glActiveTexture(A(0));
    RET0;
}
GLFN(glAttachShader)         { ENTER; glAttachShader(A(0), A(1)); RET0; }
GLFN(glBindFramebuffer)      { ENTER; isaac_glc_fbo_bind(A(0), A(1)); glBindFramebuffer(A(0), A(1)); RET0; }
GLFN(glBindRenderbuffer)     { ENTER; isaac_glc_rb_bind(A(1)); glBindRenderbuffer(A(0), A(1)); RET0; }
GLFN(glBindTexture) {
    ENTER;
    isaac_glc_tex_bind(A(0), A(1));
    {
        uint32_t u = gls_unit_ok ? gls_unit - 0x84C0u : 0u;          /* GL_TEXTURE0 */
        uint32_t *slot = u < GLS_UNITS ? (A(0) == 0x0DE1u ? &gls_tex2d[u] : A(0) == 0x8513u ? &gls_texcube[u] : NULL) : NULL;
        if (slot && *slot == A(1) + 1u) { ++gls_skip_tex; RET0; }    /* stored as name + 1: 0 means unknown */
        if (slot) *slot = A(1) + 1u;
    }
    glBindTexture(A(0), A(1));
    RET0;
}
GLFN(glBlendEquation) {
    ENTER;
    if (gls_blend_eq_ok && gls_blend_eq == A(0)) { ++gls_skip_blend; RET0; }
    gls_blend_eq = A(0); gls_blend_eq_ok = 1;
    glBlendEquation(A(0));
    RET0;
}
GLFN(glBlendFuncSeparate) {
    ENTER;
    if (gls_blend_ok && gls_blend[0] == A(0) && gls_blend[1] == A(1) && gls_blend[2] == A(2) && gls_blend[3] == A(3)) { ++gls_skip_blend; RET0; }
    gls_blend[0] = A(0); gls_blend[1] = A(1); gls_blend[2] = A(2); gls_blend[3] = A(3); gls_blend_ok = 1;
    glBlendFuncSeparate(A(0), A(1), A(2), A(3));
    RET0;
}
GLFN(glCheckFramebufferStatus) {
    ENTER;
    uint32_t st;                     /* round 37: remembered until an attachment changes */
    if (isaac_glc_fbo_status(A(0), &st)) RETV(st);
    st = glCheckFramebufferStatus(A(0));
    isaac_glc_fbo_set_status(A(0), st);
    RETV(st);
}
GLFN(glClampColorARB)        { ENTER; RET0; }
GLFN(glClearColor)           { ENTER; glClearColor(AF(0), AF(1), AF(2), AF(3)); RET0; }
GLFN(glClearDepth) {
    ENTER;
    uint32_t lo = A(0), hi = A(1);
    uint64_t bits = ((uint64_t)hi << 32) | lo;
    double d;
    memcpy(&d, &bits, 8);
    glClearDepthf((float)d);
    RET0;
}
GLFN(glCompileShader)        { ENTER; glCompileShader(A(0)); RET0; }
GLFN(glCreateProgram)        { ENTER; RETV(glCreateProgram()); }
GLFN(glCreateShader) {
    ENTER;
    GLuint sh = glCreateShader(A(0));
    if (sh < GL_SHADER_NAMES) g_shader_is_frag[sh] = (A(0) == 0x8B30u);
    RETV(sh);
}
GLFN(glCullFace)             { ENTER; glCullFace(A(0)); RET0; }
GLFN(glDeleteFramebuffers) {
    ENTER;
    const GLuint *names = (const GLuint *)AP(1);
    for (uint32_t i = 0; names && i < A(0); ++i) isaac_glc_fbo_delete(names[i]);
    glDeleteFramebuffers((GLsizei)A(0), names);
    RET0;
}
GLFN(glDeleteProgram)        { ENTER; isaac_glc_loc_flush(A(0)); glu_forget(A(0)); if (gls_prog_ok && gls_prog == A(0)) gls_prog_ok = 0; glDeleteProgram(A(0)); RET0; }
GLFN(glDeleteRenderbuffers) {
    ENTER;
    const GLuint *names = (const GLuint *)AP(1);
    for (uint32_t i = 0; names && i < A(0); ++i) isaac_glc_rb_delete(names[i]);
    glDeleteRenderbuffers((GLsizei)A(0), names);
    RET0;
}
GLFN(glDeleteShader)         { ENTER; glDeleteShader(A(0)); RET0; }
GLFN(glDeleteTextures) {
    ENTER;
    const GLuint *names = (const GLuint *)AP(1);
    for (uint32_t i = 0; names && i < A(0); ++i) {
        isaac_glc_tex_delete(names[i]);
        for (unsigned u = 0; u < GLS_UNITS; ++u) {
            if (gls_tex2d[u] == names[i] + 1u) gls_tex2d[u] = 0;
            if (gls_texcube[u] == names[i] + 1u) gls_texcube[u] = 0;
        }
    }
    glDeleteTextures((GLsizei)A(0), names);
    RET0;
}
GLFN(glDepthFunc)            { ENTER; glDepthFunc(A(0)); RET0; }
GLFN(glDisable)              { ENTER; glDisable(A(0)); RET0; }
GLFN(glDisableVertexAttribArray) {
    ENTER;
    isaac_gl_disable_vertex_attrib_array(A(0));
    if (A(0) < GLS_ATTRIBS) {
        if (gls_attrib_known[A(0)] && !gls_attrib_on[A(0)]) { ++gls_skip_attrib; RET0; }
        gls_attrib_known[A(0)] = 1; gls_attrib_on[A(0)] = 0;
    }
    glDisableVertexAttribArray(A(0));
    RET0;
}
GLFN(glDrawArraysInstancedEXT) {
    ENTER;
    isaac_gl_draw_arrays_instanced(A(0), (GLint)A(1), (GLsizei)A(2), (GLsizei)A(3));
    RET0;
}
GLFN(glDrawElements) {
    ENTER;
    isaac_gl_draw_elements(A(0), (GLsizei)A(1), A(2), A(3));
    RET0;
}
GLFN(glEnable)               { ENTER; glEnable(A(0)); RET0; }
GLFN(glEnableVertexAttribArray) {
    ENTER;
    isaac_gl_enable_vertex_attrib_array(A(0));
    if (A(0) < GLS_ATTRIBS) {
        if (gls_attrib_known[A(0)] && gls_attrib_on[A(0)]) { ++gls_skip_attrib; RET0; }
        gls_attrib_known[A(0)] = 1; gls_attrib_on[A(0)] = 1;
    }
    glEnableVertexAttribArray(A(0));
    RET0;
}
GLFN(glFramebufferRenderbuffer) { ENTER; isaac_glc_fbo_attach(A(0), A(1), 0, A(3), 0); glFramebufferRenderbuffer(A(0), A(1), A(2), A(3)); RET0; }
GLFN(glFramebufferTexture2D) { ENTER; isaac_glc_fbo_attach(A(0), A(1), 1, A(3), (A(2) << 8) ^ A(4)); glFramebufferTexture2D(A(0), A(1), A(2), A(3), (GLint)A(4)); RET0; }
GLFN(glGenFramebuffers)      { ENTER; glGenFramebuffers((GLsizei)A(0), (GLuint *)AP(1)); RET0; }
GLFN(glGenRenderbuffers)     { ENTER; glGenRenderbuffers((GLsizei)A(0), (GLuint *)AP(1)); RET0; }
GLFN(glGenTextures)          { ENTER; glGenTextures((GLsizei)A(0), (GLuint *)AP(1)); RET0; }
GLFN(glGetAttribLocation) {
    ENTER;
    const char *name = (const char *)AP(1);
    int32_t loc;                     /* round 37: one lookup per (program, name) per link */
    if (isaac_glc_loc_get(A(0), 0, name, &loc)) RETV((uint32_t)loc);
    loc = glGetAttribLocation(A(0), name);
    isaac_glc_loc_put(A(0), 0, name, loc);
    RETV((uint32_t)loc);
}
GLFN(glGetCombinerInputParameterivNV) { ENTER; RET0; }
GLFN(glGetProgramInfoLog)    { ENTER; glGetProgramInfoLog(A(0), (GLsizei)A(1), (GLsizei *)AP(2), (GLchar *)AP(3)); RET0; }
GLFN(glGetProgramiv)         { ENTER; glGetProgramiv(A(0), A(1), (GLint *)AP(2)); RET0; }
GLFN(glGetRenderbufferParameteriv) {
    ENTER;
    uint32_t v;                      /* round 37: answered from the storage call */
    GLint *out = (GLint *)AP(2);
    if (out && A(0) == GL_RENDERBUFFER && isaac_glc_rb_param(A(1), &v)) { *out = (GLint)v; RET0; }
    glGetRenderbufferParameteriv(A(0), A(1), out);
    RET0;
}
GLFN(glGetShaderInfoLog)     { ENTER; glGetShaderInfoLog(A(0), (GLsizei)A(1), (GLsizei *)AP(2), (GLchar *)AP(3)); RET0; }
GLFN(glGetShaderiv)          { ENTER; glGetShaderiv(A(0), A(1), (GLint *)AP(2)); RET0; }
GLFN(glGetUniformLocation) {
    ENTER;
    const char *name = (const char *)AP(1);
    int32_t loc;
    if (isaac_glc_loc_get(A(0), 1, name, &loc)) RETV((uint32_t)loc);
    loc = glGetUniformLocation(A(0), name);
    isaac_glc_loc_put(A(0), 1, name, loc);
    RETV((uint32_t)loc);
}
GLFN(glLinkProgram) {
    ENTER;
    GLuint prog = A(0);
    isaac_glc_loc_flush(prog);
    glu_forget(prog);                /* a link resets the program's uniforms */
    glLinkProgram(prog);
    GLint ok = 0;
    glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) {
        char buf[512];
        GLsizei n = 0;
        glGetProgramInfoLog(prog, (GLsizei)sizeof buf - 1, &n, buf);
        buf[n < 0 ? 0 : n] = 0;
        isaac_log("[isaac][gl] program %u failed to link: %s", prog, buf);
    }
    RET0;
}
GLFN(glMultiDrawArraysIndirectEXT) { ENTER; RET0; }
GLFN(glProgramUniform1ivEXT) { ENTER; RET0; }
/* Round 48: the first three of the game's own glReadPixels log the wasm stack
 * (the names come from the module's name section): the engine reads pixels
 * back in play, one call every dozen frames, each a GPU pipeline drain. */
EM_JS(void, isaac_readpixels_stack_js, (int x, int y, int w, int h), {
    var st = (new Error().stack || "").split("\n").slice(2, 12).map(function (l) { var t = l.trim(); if (t.indexOf("at ") === 0) t = t.slice(3); return t.split(" ")[0]; }).join(" < ");
    err("[isaac][gl] glReadPixels " + w + "x" + h + " at " + x + "," + y + " from: " + st);
});
static uint32_t g_rp_logged;
GLFN(glReadPixels) {
    ENTER;
    isaac_glc_count_readpixels(A(0), A(1), A(2), A(3), A(4), A(4) == 0x1908u ? 4u : A(4) == 0x1907u ? 3u : 1u);   /* GL_RGBA / GL_RGB */
    if (g_rp_logged < 3u) { ++g_rp_logged; isaac_readpixels_stack_js((int)A(0), (int)A(1), (int)A(2), (int)A(3)); }
    glReadPixels((GLint)A(0), (GLint)A(1), (GLsizei)A(2), (GLsizei)A(3), A(4), A(5), AP(6));
    RET0;
}
GLFN(glRenderbufferStorage)  { ENTER; isaac_glc_rb_storage(A(1), A(2), A(3), 0); glRenderbufferStorage(A(0), A(1), (GLsizei)A(2), (GLsizei)A(3)); RET0; }
GLFN(glShaderSource) {
    ENTER;
    GLuint shader = A(0);
    GLsizei count = (GLsizei)A(1);
    uint32_t strings_va = A(2), lengths_va = A(3);
    if (count <= 0 || count > 64 || !isaac_is_guest_va(strings_va)) RET0;
    /* Concatenate the pieces into one host string so a GLSL ES header can be
     * prepended: desktop GLSL needs no default precision, GLSL ES rejects a
     * fragment shader without one ("No precision specified for (float)"),
     * and a desktop `#version 1xx` line would be rejected outright. */
    size_t total = 0;
    for (GLsizei i = 0; i < count; i++) {
        uint32_t sva = isaac_r32(strings_va + 4u * (uint32_t)i);
        if (!sva) continue;
        GLint len = lengths_va ? (GLint)isaac_r32(lengths_va + 4u * (uint32_t)i) : -1;
        total += len >= 0 ? (size_t)len : strlen((const char *)isaac_g(sva));
    }
    int frag = shader < GL_SHADER_NAMES && g_shader_is_frag[shader];
    static const char header[] = "precision highp float;\nprecision highp int;\n";
    char *src = (char *)malloc(total + sizeof header + 16);
    if (!src) RET0;
    size_t off = 0;
    if (frag) { memcpy(src, header, sizeof header - 1); off = sizeof header - 1; }
    for (GLsizei i = 0; i < count; i++) {
        uint32_t sva = isaac_r32(strings_va + 4u * (uint32_t)i);
        if (!sva) continue;
        GLint len = lengths_va ? (GLint)isaac_r32(lengths_va + 4u * (uint32_t)i) : -1;
        size_t n = len >= 0 ? (size_t)len : strlen((const char *)isaac_g(sva));
        memcpy(src + off, isaac_g(sva), n);
        off += n;
    }
    src[off] = 0;
    /* a source that already declares a precision keeps its own; drop the
     * header again in that case (it would only be redundant, but keep the
     * bytes exactly the game's) */
    const char *body = src;
    if (frag && strstr(src + sizeof header - 1, "precision ")) body = src + sizeof header - 1;
    /* strip a desktop #version line */
    char *ver = strstr((char *)body, "#version");
    if (ver) { char *nl = strchr(ver, '\n'); if (nl) memmove(ver, nl + 1, strlen(nl + 1) + 1); else *ver = 0; }
    const GLchar *one = body;
    glShaderSource(shader, 1, &one, NULL);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char buf[512];
        GLsizei n = 0;
        glGetShaderInfoLog(shader, (GLsizei)sizeof buf - 1, &n, buf);
        buf[n < 0 ? 0 : n] = 0;
        isaac_log("[isaac][gl] shader %u (%s) failed to compile: %s", shader,
                  frag ? "fragment" : "vertex", buf);
        isaac_log("[isaac][gl]   source head: %.300s", body);
    }
    free(src);
    RET0;
}
GLFN(glTexImage2D) {
    ENTER;
    isaac_glc_tex_image(A(0));
    ++g_tex_uploads;
    {
        GLenum target = A(0), format = A(6), type = A(7);
        GLsizei w = (GLsizei)A(3), h = (GLsizei)A(4);
        const uint8_t *px = (const uint8_t *)AP(8);
        uint32_t bpp = type != GL_UNSIGNED_BYTE ? 0u : format == GL_RGBA ? 4u : format == GL_RGB ? 3u :
                       format == GL_LUMINANCE_ALPHA ? 2u : (format == GL_LUMINANCE || format == GL_ALPHA) ? 1u : 0u;
        if (tex_band_mode() && px && bpp && w > 0 && h > 1 && (uint64_t)w * (uint64_t)h * bpp > (uint64_t)TEX_BAND_BYTES) {
            uint32_t row = ((uint32_t)w * bpp + 3u) & ~3u;
            uint32_t rows = TEX_BAND_BYTES / row;
            GLsizei y;
            if (rows < 1u) rows = 1u;
            glTexImage2D(target, (GLint)A(1), (GLint)A(2), w, h, (GLint)A(5), format, type, NULL);
            for (y = 0; y < h; y += (GLsizei)rows) {
                GLsizei n = (h - y) < (GLsizei)rows ? (h - y) : (GLsizei)rows;
                glTexSubImage2D(target, (GLint)A(1), 0, y, w, n, format, type, px + (size_t)y * row);
                ++g_tex_bands;
            }
            ++g_tex_banded;
            RET0;
        }
    }
    glTexImage2D(A(0), (GLint)A(1), (GLint)A(2), (GLsizei)A(3), (GLsizei)A(4), (GLint)A(5),
                 A(6), A(7), AP(8));
    RET0;
}
GLFN(glTexParameteri)        { ENTER; glTexParameteri(A(0), A(1), (GLint)A(2)); RET0; }
GLFN(glTexSubImage2D) {
    ENTER;
    glTexSubImage2D(A(0), (GLint)A(1), (GLint)A(2), (GLint)A(3), (GLsizei)A(4), (GLsizei)A(5),
                    A(6), A(7), AP(8));
    RET0;
}
GLFN(glUniform1fv)           { ENTER; if (A(1) == 1u && AP(2) && glu_same((GLint)A(0), 1, AP(2), 1)) { ++gls_skip_uniform; RET0; } glUniform1fv((GLint)A(0), (GLsizei)A(1), (const GLfloat *)AP(2)); RET0; }
GLFN(glUniform1i)            { ENTER; { uint32_t v = A(1); if (glu_same((GLint)A(0), 2, &v, 1)) { ++gls_skip_uniform; RET0; } } glUniform1i((GLint)A(0), (GLint)A(1)); RET0; }
GLFN(glUniform1iv)           { ENTER; glUniform1iv((GLint)A(0), (GLsizei)A(1), (const GLint *)AP(2)); RET0; }
GLFN(glUniform1uiv)          { ENTER; glUniform1uiv((GLint)A(0), (GLsizei)A(1), (const GLuint *)AP(2)); RET0; }
GLFN(glUniform2fv)           { ENTER; if (A(1) == 1u && AP(2) && glu_same((GLint)A(0), 3, AP(2), 2)) { ++gls_skip_uniform; RET0; } glUniform2fv((GLint)A(0), (GLsizei)A(1), (const GLfloat *)AP(2)); RET0; }
GLFN(glUniform2iv)           { ENTER; glUniform2iv((GLint)A(0), (GLsizei)A(1), (const GLint *)AP(2)); RET0; }
GLFN(glUniform2uiv)          { ENTER; glUniform2uiv((GLint)A(0), (GLsizei)A(1), (const GLuint *)AP(2)); RET0; }
GLFN(glUniform3fv)           { ENTER; if (A(1) == 1u && AP(2) && glu_same((GLint)A(0), 4, AP(2), 3)) { ++gls_skip_uniform; RET0; } glUniform3fv((GLint)A(0), (GLsizei)A(1), (const GLfloat *)AP(2)); RET0; }
GLFN(glUniform3iv)           { ENTER; glUniform3iv((GLint)A(0), (GLsizei)A(1), (const GLint *)AP(2)); RET0; }
GLFN(glUniform3uiv)          { ENTER; glUniform3uiv((GLint)A(0), (GLsizei)A(1), (const GLuint *)AP(2)); RET0; }
GLFN(glUniform4fv)           { ENTER; if (A(1) == 1u && AP(2) && glu_same((GLint)A(0), 5, AP(2), 4)) { ++gls_skip_uniform; RET0; } glUniform4fv((GLint)A(0), (GLsizei)A(1), (const GLfloat *)AP(2)); RET0; }
GLFN(glUniform4iv)           { ENTER; glUniform4iv((GLint)A(0), (GLsizei)A(1), (const GLint *)AP(2)); RET0; }
GLFN(glUniform4uiv)          { ENTER; glUniform4uiv((GLint)A(0), (GLsizei)A(1), (const GLuint *)AP(2)); RET0; }
#define UMAT(name, fn) GLFN(name) { ENTER; fn((GLint)A(0), (GLsizei)A(1), (GLboolean)A(2), (const GLfloat *)AP(3)); RET0; }
UMAT(glUniformMatrix2fv, glUniformMatrix2fv)
UMAT(glUniformMatrix2x3fv, glUniformMatrix2x3fv)
UMAT(glUniformMatrix2x4fv, glUniformMatrix2x4fv)
UMAT(glUniformMatrix3fv, glUniformMatrix3fv)
UMAT(glUniformMatrix3x2fv, glUniformMatrix3x2fv)
UMAT(glUniformMatrix3x4fv, glUniformMatrix3x4fv)
GLFN(glUniformMatrix4fv) {          /* round 48: the projection matrix is re-sent per draw */
    ENTER;
    if (A(1) == 1u && AP(3) && glu_same((GLint)A(0), (uint8_t)(A(2) ? 7 : 6), AP(3), 16)) { ++gls_skip_uniform; RET0; }
    glUniformMatrix4fv((GLint)A(0), (GLsizei)A(1), (GLboolean)A(2), (const GLfloat *)AP(3));
    RET0;
}
UMAT(glUniformMatrix4x2fv, glUniformMatrix4x2fv)
UMAT(glUniformMatrix4x3fv, glUniformMatrix4x3fv)
GLFN(glUseProgram) {
    ENTER;
    if (gls_prog_ok && gls_prog == A(0)) { ++gls_skip_prog; RET0; }
    gls_prog = A(0); gls_prog_ok = 1;
    glUseProgram(A(0));
    RET0;
}
GLFN(glVertexAttribPointer) {
    ENTER;
    isaac_gl_vertex_attrib_pointer(A(0), (GLint)A(1), A(2), (GLboolean)A(3), (GLsizei)A(4), A(5));
    RET0;
}
GLFN(glVertexStream2fATI)    { ENTER; RET0; }
GLFN(glViewport) {
    ENTER;
    if (gls_vp_ok && gls_vp[0] == A(0) && gls_vp[1] == A(1) && gls_vp[2] == A(2) && gls_vp[3] == A(3)) { ++gls_skip_vp; RET0; }
    gls_vp[0] = A(0); gls_vp[1] = A(1); gls_vp[2] = A(2); gls_vp[3] = A(3); gls_vp_ok = 1;
    glViewport((GLint)A(0), (GLint)A(1), (GLsizei)A(2), (GLsizei)A(3));
    RET0;
}

#endif /* ISAAC_WEB */
