/* host_gl_clientarrays.c -- client-side vertex array emulation for WebGL2.
 *
 * THE PROBLEM (measured, not assumed)
 * -----------------------------------
 * The renderer submits geometry with CLIENT-SIDE arrays. Evidence:
 *
 *   - Of the 3,221 libepoxy dispatch slots, the buffer-object family
 *     (glGenBuffers/glBindBuffer/glBufferData/glBufferSubData/glMapBuffer and
 *     every ARB/EXT/OES alias -- 25 exports) has ZERO references from caller
 *     code. The VAO family (12 exports) likewise ZERO. Checked across all
 *     7,430,656 bytes of .text, 2,088,711 decoded instructions.
 *   - glVertexAttribPointer's `pointer` argument comes straight from a caller
 *     parameter at 0x00a24d37:
 *         push ebx                  ; pointer   (caller-supplied)
 *         push [ebp+0x10]           ; stride
 *         push 0                    ; normalized
 *         push 0x1406               ; GL_FLOAT
 *         push eax                  ; size 1..4
 *         push [ebp+8]              ; index (from glGetAttribLocation)
 *         call [epoxy_glVertexAttribPointer]
 *   - glDrawElements' `indices` argument likewise, at 0x00a189f0:
 *         push [ebx+0x14]           ; indices   (caller-supplied)
 *         push 0x1403               ; GL_UNSIGNED_SHORT
 *         push [ebx+0x18]           ; count
 *         push 4                    ; GL_TRIANGLES
 *         call [epoxy_glDrawElements]
 *
 * Because glBindBuffer is never called, ARRAY_BUFFER and ELEMENT_ARRAY_BUFFER
 * are provably always 0, so both pointers are client memory addresses.
 *
 * WebGL2 removed client-side arrays outright: vertexAttribPointer's last
 * argument is a byte offset into the bound ARRAY_BUFFER, and drawElements'
 * last argument is a byte offset into the bound ELEMENT_ARRAY_BUFFER. Passing
 * a heap pointer produces INVALID_OPERATION, not a draw.
 *
 * THE FIX
 * -------
 * Intercept the attribute-pointer calls, remember the client pointers, and at
 * draw time stage the referenced memory into a pool of real buffer objects,
 * then re-issue the draw against buffer offsets.
 *
 * Identity addressing makes the staging cheap: a guest pointer IS a linear
 * memory offset, so the source of the upload is `isaac_g(ptr)` with no
 * translation and no bounce buffer on our side.
 *
 * WHAT IS DERIVABLE AND WHAT IS NOT
 * ---------------------------------
 * derivable  glDrawArrays(mode, first, count): the vertex range is exactly
 *            [first, first+count). Upload stride*(first+count) bytes. Exact.
 *
 * derivable  glDrawElements(mode, count, type, indices): the INDEX range is
 *            exact -- count * sizeof(type) bytes starting at `indices`. So the
 *            index upload is never a guess.
 *
 * NOT derivable without work
 *            glDrawElements' VERTEX range. GL says "read attribute i at
 *            pointer + stride*index" for each index in the index array; there
 *            is no API-level upper bound on index values. The only exact
 *            answer is to SCAN the index array and take max+1. That scan is
 *            O(count) per draw call and is unavoidable -- glDrawRangeElements
 *            exists precisely to supply the bound, and this binary never calls
 *            it (verified: 0 references).
 *
 * NOT derivable at all
 *            The true extent of the client buffer. If the app's array is
 *            shorter than max_index+1 vertices, real GL would read out of
 *            bounds and so would we; we cannot detect it. We clamp uploads to
 *            the guest image/heap bounds and report, rather than fault.
 *
 * PER-FRAME COST
 * --------------
 * Per glDrawElements call:
 *   - index scan: count reads (2 bytes each for GL_UNSIGNED_SHORT).
 *   - index upload: count*2 bytes.
 *   - vertex upload: stride * (max_index+1) bytes per enabled attribute,
 *     or one upload if all attributes are interleaved in one array (the common
 *     case, and detected here so the buffer is uploaded once).
 * With only 2 draw-call sites in the whole binary, the dominant term is the
 * per-frame vertex volume, not call overhead. The scan is the part that scales
 * with geometry and is the thing to profile first.
 *
 * ASSUMPTION ON RECORD: draw-call sites == 2.
 * Both are glDrawElements (0x00a189f0 and 0x00a67e41); glDrawArrays has zero
 * references. That is measured over the whole of .text at the CURRENT lift
 * coverage. If coverage grows and more draw sites appear, the per-call
 * overhead argument weakens and the index scan may need caching (keyed on the
 * index pointer + count, invalidated by any write into that range). Re-run
 *     python scripts/recomp/host/gl_legacy_audit.py
 * and check `constantArguments.glDrawElements` before relying on "only 2".
 */

#include "isaac_host.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <GLES3/gl3.h>
#else
/* Host-test build: the logic is exercised without a GL context. */
typedef unsigned int GLenum; typedef unsigned int GLuint; typedef int GLint;
typedef int GLsizei; typedef unsigned char GLboolean; typedef long GLintptr;
typedef long GLsizeiptr; typedef void GLvoid;
#define GL_ARRAY_BUFFER 0x8892
#define GL_ELEMENT_ARRAY_BUFFER 0x8893
#define GL_STREAM_DRAW 0x88E0
#define GL_STATIC_DRAW 0x88E4
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_SHORT 0x1403
#define GL_UNSIGNED_INT 0x1405
#define GL_FLOAT 0x1406
#define GL_BYTE 0x1400
#define GL_SHORT 0x1402
#define GL_INT 0x1404
extern void glGenBuffers(GLsizei, GLuint *);
extern void glBindBuffer(GLenum, GLuint);
extern void glBufferData(GLenum, GLsizeiptr, const void *, GLenum);
extern void glVertexAttribPointer(GLuint, GLint, GLenum, GLboolean, GLsizei,
                                  const void *);
extern void glDrawElements(GLenum, GLsizei, GLenum, const void *);
extern void glDrawArrays(GLenum, GLint, GLsizei);
#endif

#define ISAAC_MAX_ATTRIBS 16

typedef struct {
    int      enabled;
    int      configured;
    GLint    size;          /* 1..4 components                         */
    GLenum   type;
    GLboolean normalized;
    GLsizei  stride;        /* 0 means tightly packed                  */
    uint32_t client_ptr;    /* guest VA, or 0 if a real VBO was bound  */
} attrib_state;

static attrib_state g_attribs[ISAAC_MAX_ATTRIBS];
/* Round 39: the staging buffers are rings. Every draw used to glBufferSubData
 * its vertices and indices at offset 0 of one VBO and one IBO -- on top of the
 * bytes the previous draw, still queued on the GPU, was reading. ANGLE keeps
 * that correct with a copy or a stall per upload, and the browser profile
 * charged 3.2% of a throttled frame to bufferSubData for 47 draws. A ring
 * appends instead: a write never lands on bytes a queued draw still reads;
 * when the remainder cannot hold a request the storage is orphaned with
 * glBufferData(NULL) (the driver hands out fresh memory and the old block
 * dies with the draws that read it). 4 MB holds ~90 frames of the menus'
 * 45 KB a frame. The head is reported by isaac_gl_ring_head() for the
 * selftest. */
typedef struct { GLuint buf; uint32_t cap, head, orphans, gen; } gl_ring;   /* gen: bumps when the storage is replaced */
/* Round 48: the engine draws quads with the same six-index pattern over and
 * over; an index block identical to the last one uploaded is drawn from the
 * ring offset it already has, as long as that storage is still the one it
 * went into (the ring's generation). */
#define IDX_KEEP 4096
static uint8_t g_idx_last[IDX_KEEP];
static uint32_t g_idx_len, g_idx_at, g_idx_gen, g_idx_reuse;
static int g_idx_valid;

/* Round 53: the canonical quad index buffer. The engine draws its sprites as
 * quads through the client-array path, and a draw's index block is almost
 * always the standard pattern -- six indices per quad over four vertices, the
 * same six offsets repeated with +4 per quad -- so every such block is a
 * prefix of one fixed sequence. One static ELEMENT_ARRAY_BUFFER holding that
 * sequence serves all of them at offset 0: no upload, no ring space, no
 * compare. The six offsets are learnt from the first block whose offsets are
 * all below 4 (the engine's winding, whatever it is); a block that is not the
 * pattern goes through the ring as before. ISAAC_GL_QUAD_IBO=0 turns it off
 * (the A/B); the census counts the draws each way. */
#define QUAD_IBO_MIN_QUADS 4096u
static GLuint g_quad_ibo[2];              /* [0] GL_UNSIGNED_SHORT, [1] GL_UNSIGNED_INT */
static uint32_t g_quad_quads[2];          /* quads the buffer holds */
static uint32_t g_quad_pat[6];
static int g_quad_pat_set, g_quad_mode = -1;
static uint32_t g_quad_draws, g_quad_other;
static GLuint g_bound_ibo;                /* what ELEMENT_ARRAY_BUFFER holds: the ring's or the quad buffer */

static int quad_mode(void) {
    if (g_quad_mode < 0) { const char *e = getenv("ISAAC_GL_QUAD_IBO"); g_quad_mode = (e && *e == '0') ? 0 : 1; }
    return g_quad_mode;
}
static uint32_t idx_at(const uint8_t *src, uint32_t type, uint32_t i) {
    if (type == GL_UNSIGNED_SHORT) { uint16_t v; memcpy(&v, src + i * 2u, 2); return v; }
    { uint32_t v; memcpy(&v, src + i * 4u, 4); return v; }
}
/* the block is the canonical pattern's prefix (the pattern is learnt from the first block whose six offsets are all below 4) */
static int is_quad_block(const uint8_t *src, int count, uint32_t type) {
    int q, i;
    if (count < 6 || (count % 6) != 0 || (type != GL_UNSIGNED_SHORT && type != GL_UNSIGNED_INT)) return 0;
    if (!g_quad_pat_set) {
        uint32_t p[6];
        for (i = 0; i < 6; ++i) { p[i] = idx_at(src, type, (uint32_t)i); if (p[i] > 3u) return 0; }
        memcpy(g_quad_pat, p, sizeof p);
        g_quad_pat_set = 1;
    }
    for (q = 0; q < count / 6; ++q)
        for (i = 0; i < 6; ++i)
            if (idx_at(src, type, (uint32_t)(q * 6 + i)) != g_quad_pat[i] + 4u * (uint32_t)q) return 0;
    return 1;
}
/* the static buffer for `type` holds at least `quads` quads (grown by doubling, bound on return) */
static int quad_ibo_ready(uint32_t type, uint32_t quads) {
    int k = type == GL_UNSIGNED_INT ? 1 : 0;
    uint32_t limit = k ? (1u << 24) : 65536u / 4u;          /* the index type's reach (16 M quads is plenty) */
    if (quads > limit) return 0;
    if (!g_quad_ibo[k] || g_quad_quads[k] < quads) {
        uint32_t n = g_quad_quads[k] ? g_quad_quads[k] * 2u : QUAD_IBO_MIN_QUADS, q, bytes;
        uint8_t *buf;
        while (n < quads) n *= 2u;
        if (n > limit) n = limit;
        bytes = n * 6u * (k ? 4u : 2u);
        buf = (uint8_t *)malloc(bytes);
        if (!buf) return 0;
        for (q = 0; q < n; ++q) {
            int i;
            for (i = 0; i < 6; ++i) {
                uint32_t v = g_quad_pat[i] + 4u * q;
                if (k) memcpy(buf + (q * 6u + (uint32_t)i) * 4u, &v, 4);
                else { uint16_t s = (uint16_t)v; memcpy(buf + (q * 6u + (uint32_t)i) * 2u, &s, 2); }
            }
        }
        if (!g_quad_ibo[k]) glGenBuffers(1, &g_quad_ibo[k]);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_quad_ibo[k]);
        g_bound_ibo = g_quad_ibo[k];
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)bytes, buf, GL_STATIC_DRAW);
        free(buf);
        g_quad_quads[k] = n;
    }
    if (g_bound_ibo != g_quad_ibo[k]) { glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_quad_ibo[k]); g_bound_ibo = g_quad_ibo[k]; }
    return 1;
}
void isaac_gl_quad_census(uint32_t *quad_draws, uint32_t *other_blocks, uint32_t *pattern) {
    if (quad_draws) *quad_draws = g_quad_draws;
    if (other_blocks) *other_blocks = g_quad_other;
    if (pattern) memcpy(pattern, g_quad_pat, sizeof g_quad_pat);
}
static gl_ring g_vring, g_iring;
#define RING_VERTEX_BYTES (4u << 20)
#define RING_INDEX_BYTES  (1u << 20)

/* stats, reported by isaac_gl_report() -- this is a hot path, so it is
 * measured rather than guessed at. */
static uint64_t g_draws, g_indices_scanned, g_vertex_bytes, g_index_bytes;

static unsigned type_size(GLenum t) {
    switch (t) {
    case GL_BYTE: case GL_UNSIGNED_BYTE:   return 1;
    case GL_SHORT: case GL_UNSIGNED_SHORT: return 2;
    case GL_INT: case GL_UNSIGNED_INT: case GL_FLOAT: return 4;
    default: return 4;
    }
}

void isaac_gl_reset_state(void) {
    memset(g_attribs, 0, sizeof g_attribs);
    memset(&g_vring, 0, sizeof g_vring);
    memset(&g_iring, 0, sizeof g_iring);
    g_idx_valid = 0;
}

static void ensure_buffers(void) {
    if (!g_vring.buf) glGenBuffers(1, &g_vring.buf);
    if (!g_iring.buf) glGenBuffers(1, &g_iring.buf);
}

/* Append `bytes` (from `src`, or reserve them when src is NULL) to a ring and
 * return the offset they occupy. Requests are 16-byte aligned so any
 * attribute offset stays aligned to its type. */
static uint32_t ring_put(GLenum target, gl_ring *r, uint32_t initial,
                         const void *src, uint32_t bytes) {
    uint32_t need = (bytes + 15u) & ~15u;
    glBindBuffer(target, r->buf);
    if (r->cap < need) {                       /* a single draw bigger than the ring: grow it */
        r->cap = need + need / 2;
        if (r->cap < initial) r->cap = initial;
        glBufferData(target, (GLsizeiptr)r->cap, 0, GL_STREAM_DRAW);
        r->head = 0; ++r->gen;
    } else if (r->head + need > r->cap) {      /* wrap: orphan, never overwrite */
        glBufferData(target, (GLsizeiptr)r->cap, 0, GL_STREAM_DRAW);
        r->head = 0; ++r->gen;
        ++r->orphans;
    }
    uint32_t off = r->head;
#ifdef __EMSCRIPTEN__
    if (src) glBufferSubData(target, (GLintptr)off, (GLsizeiptr)bytes, src);
#else
    (void)src;
#endif
    r->head += need;
    return off;
}
uint32_t isaac_gl_ring_head(int which) { return which ? g_iring.head : g_vring.head; }
uint32_t isaac_gl_ring_orphans(int which) { return which ? g_iring.orphans : g_vring.orphans; }

/* ------------------------------------------------------- intercepted API -- */

void isaac_gl_enable_vertex_attrib_array(GLuint index) {
    if (index < ISAAC_MAX_ATTRIBS) g_attribs[index].enabled = 1;
}

void isaac_gl_disable_vertex_attrib_array(GLuint index) {
    if (index < ISAAC_MAX_ATTRIBS) g_attribs[index].enabled = 0;
}

void isaac_gl_vertex_attrib_pointer(GLuint index, GLint size, GLenum type,
                                    GLboolean normalized, GLsizei stride,
                                    uint32_t pointer_va) {
    if (index >= ISAAC_MAX_ATTRIBS) {
        isaac_log("[isaac][gl] attrib index %u >= %d; ignoring", index,
                  ISAAC_MAX_ATTRIBS);
        return;
    }
    attrib_state *a = &g_attribs[index];
    a->configured = 1;
    a->size = size;
    a->type = type;
    a->normalized = normalized;
    a->stride = stride ? stride : (GLsizei)(size * (GLint)type_size(type));
    a->client_ptr = pointer_va;
    /* Deliberately NOT forwarded to glVertexAttribPointer here: with no buffer
     * bound WebGL2 would reject it. The real call is issued at draw time once
     * the data is staged. */
}

/* Scan the client index array for its maximum value. This is the one piece of
 * information GL does not give us and cannot be inferred. */
static uint32_t max_index(uint32_t indices_va, GLsizei count, GLenum type,
                          int *ok) {
    uint32_t maxi = 0;
    *ok = 1;
    switch (type) {
    case GL_UNSIGNED_BYTE: {
        const uint8_t *p = (const uint8_t *)isaac_g(indices_va);
        for (GLsizei i = 0; i < count; ++i) if (p[i] > maxi) maxi = p[i];
        break;
    }
    case GL_UNSIGNED_SHORT: {
        const uint16_t *p = (const uint16_t *)isaac_g(indices_va);
        for (GLsizei i = 0; i < count; ++i) if (p[i] > maxi) maxi = p[i];
        break;
    }
    case GL_UNSIGNED_INT: {
        const uint32_t *p = (const uint32_t *)isaac_g(indices_va);
        for (GLsizei i = 0; i < count; ++i) if (p[i] > maxi) maxi = p[i];
        break;
    }
    default:
        isaac_log("[isaac][gl] glDrawElements: unsupported index type 0x%x", type);
        *ok = 0;
        return 0;
    }
    g_indices_scanned += (uint64_t)count;
    return maxi;
}

/* Stage every enabled client attribute and point GL at the staged copy.
 * vertex_count is max_index+1 for indexed draws, or first+count for arrays. */
static void stage_attributes(uint32_t vertex_count) {
    /* The common case is a single interleaved array: several attributes with
     * the same stride, pointers a few bytes apart. Detect it so the memory is
     * uploaded once rather than once per attribute. */
    uint32_t base = 0xFFFFFFFFu, top = 0;
    int any = 0, interleaved = 1;
    GLsizei stride0 = 0;
    for (unsigned i = 0; i < ISAAC_MAX_ATTRIBS; ++i) {
        attrib_state *a = &g_attribs[i];
        if (!a->enabled || !a->configured || !a->client_ptr) continue;
        if (!any) { stride0 = a->stride; any = 1; }
        else if (a->stride != stride0) interleaved = 0;
        uint32_t lo = a->client_ptr;
        uint32_t hi = lo + (uint32_t)a->stride * vertex_count;
        if (lo < base) base = lo;
        if (hi > top)  top = hi;
    }
    if (!any) return;

    if (interleaved && (top - base) <= (uint32_t)stride0 * vertex_count + 256) {
        uint32_t bytes = top - base;
        uint32_t at = ring_put(GL_ARRAY_BUFFER, &g_vring, RING_VERTEX_BYTES,
                               isaac_g(base), bytes);
        g_vertex_bytes += bytes;
        for (unsigned i = 0; i < ISAAC_MAX_ATTRIBS; ++i) {
            attrib_state *a = &g_attribs[i];
            if (!a->enabled || !a->configured || !a->client_ptr) continue;
            glVertexAttribPointer(i, a->size, a->type, a->normalized, a->stride,
                                  (const void *)(uintptr_t)(at + (a->client_ptr - base)));
        }
        return;
    }

    /* Fallback: separate arrays. Upload them back to back into one buffer and
     * hand each attribute its own offset. */
    uint32_t total = 0;
    for (unsigned i = 0; i < ISAAC_MAX_ATTRIBS; ++i) {
        attrib_state *a = &g_attribs[i];
        if (!a->enabled || !a->configured || !a->client_ptr) continue;
        total += (uint32_t)a->stride * vertex_count;
    }
    uint32_t at = ring_put(GL_ARRAY_BUFFER, &g_vring, RING_VERTEX_BYTES, 0, total);
    uint32_t off = 0;
    for (unsigned i = 0; i < ISAAC_MAX_ATTRIBS; ++i) {
        attrib_state *a = &g_attribs[i];
        if (!a->enabled || !a->configured || !a->client_ptr) continue;
        uint32_t bytes = (uint32_t)a->stride * vertex_count;
#ifdef __EMSCRIPTEN__
        glBufferSubData(GL_ARRAY_BUFFER, (GLintptr)(at + off), (GLsizeiptr)bytes,
                        isaac_g(a->client_ptr));
#endif
        glVertexAttribPointer(i, a->size, a->type, a->normalized, a->stride,
                              (const void *)(uintptr_t)(at + off));
        off += bytes;
        g_vertex_bytes += bytes;
    }
}

void isaac_gl_draw_elements(GLenum mode, GLsizei count, GLenum type,
                            uint32_t indices_va) {
    if (count <= 0) return;
    ensure_buffers();

    int ok = 0;
    uint32_t maxi = max_index(indices_va, count, type, &ok);
    if (!ok) return;

    stage_attributes(maxi + 1u);

    uint32_t ibytes = (uint32_t)count * type_size(type);
    uint32_t iat;
    const uint8_t *isrc = (const uint8_t *)isaac_g(indices_va);
    if (quad_mode() && is_quad_block(isrc, count, type) && quad_ibo_ready(type, (uint32_t)count / 6u)) {
        glDrawElements(mode, count, type, (const void *)0);   /* the static quad indices, from the start */
        ++g_draws; ++g_quad_draws;
        return;
    }
    if (g_quad_pat_set) ++g_quad_other;
    if (g_idx_valid && ibytes == g_idx_len && ibytes <= IDX_KEEP && g_idx_gen == g_iring.gen && g_iring.buf
        && memcmp(isrc, g_idx_last, ibytes) == 0) {
        iat = g_idx_at; ++g_idx_reuse;               /* the same indices: already in the ring */
        if (g_bound_ibo != g_iring.buf) { glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_iring.buf); g_bound_ibo = g_iring.buf; }
    } else {
        iat = ring_put(GL_ELEMENT_ARRAY_BUFFER, &g_iring, RING_INDEX_BYTES, isrc, ibytes);
        g_bound_ibo = g_iring.buf;                   /* ring_put bound it */
        g_index_bytes += ibytes;
        if (ibytes <= IDX_KEEP) { memcpy(g_idx_last, isrc, ibytes); g_idx_len = ibytes; g_idx_at = iat; g_idx_gen = g_iring.gen; g_idx_valid = 1; }
        else g_idx_valid = 0;
    }

    glDrawElements(mode, count, type, (const void *)(uintptr_t)iat);
    ++g_draws;
}

void isaac_gl_draw_arrays(GLenum mode, GLint first, GLsizei count) {
    if (count <= 0) return;
    ensure_buffers();
    /* Exact: no scan needed, the range is stated by the call. */
    stage_attributes((uint32_t)first + (uint32_t)count);
    glDrawArrays(mode, first, count);
    ++g_draws;
}

void isaac_gl_draw_arrays_instanced(GLenum mode, GLint first, GLsizei count,
                                    GLsizei prims) {
    if (count <= 0 || prims <= 0) return;
    ensure_buffers();
    stage_attributes((uint32_t)first + (uint32_t)count);
#ifdef __EMSCRIPTEN__
    glDrawArraysInstanced(mode, first, count, prims);
#else
    (void)mode;
#endif
    ++g_draws;
}

void isaac_gl_report(void) {
    isaac_log("[isaac][gl] client-array emulation: %llu draws, %llu indices "
              "scanned, %llu vertex bytes staged, %llu index bytes staged; "
              "rings orphaned %u / %u times (vertex %u KB, index %u KB); %u identical index blocks reused; "
              "%u draws on the static quad index buffer (pattern %u %u %u %u %u %u), %u index blocks not the pattern",
              (unsigned long long)g_draws,
              (unsigned long long)g_indices_scanned,
              (unsigned long long)g_vertex_bytes,
              (unsigned long long)g_index_bytes,
              g_vring.orphans, g_iring.orphans, g_vring.cap >> 10, g_iring.cap >> 10, g_idx_reuse,
              g_quad_draws, g_quad_pat[0], g_quad_pat[1], g_quad_pat[2], g_quad_pat[3], g_quad_pat[4], g_quad_pat[5], g_quad_other);
}
