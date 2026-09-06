/* host_shims_fs.c -- in-memory guest filesystem for the wasm port.
 *
 * The game's bootstrap demands a real filesystem in the first seconds of
 * main(): it probes the save-data directory (getenv USERPROFILE), creates it
 * with CreateDirectoryA, scans it with FindFirstFileA, opens options/config
 * with fopen, and later writes logs. There is no host filesystem inside WASM
 * yet, so this module provides a self-consistent RAM FS:
 *
 *   - entries: a flat table of {canonical key, is_dir, bytes}
 *   - keys: '/' separators, lowercase, no leading "./", no trailing '/';
 *     "" is the root. Relative paths resolve against "." (the virtual cwd;
 *     the game runs with its data next to it, so cwd == root).
 *   - the root exists at boot (the game's save dir, resolved to "." by the
 *     USERPROFILE default in host_shims_misc.c, is the root)
 *   - FILE* is a guest 32-byte _iobuf from the guest heap with the host
 *     file-table token in the `file` slot (+0x10).
 *   - FindFirstFileA/Next hand out snapshot handles (0x200+idx).
 *
 * Everything written here is readable back within the same session; nothing
 * persists. The future work unit replaces the backing store with a real
 * host mapping (and IndexedDB for saves) without changing these handlers.
 */
#include "isaac_host.h"
#define FS_WIN_SLOTS 32           /* round 41: LRU windows per windowed file (see fs_window_read) */
#include "shim_decls.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include <time.h>

#define ERRNO_CELL_VA     (ISAAC_TEB_VA + 0x800u)

/* Capacity. The instance is a ResourceExtractor dump: 10,725 loose files
 * (208 MB of png/anm2/xml/fnt/stb/wav) + ~600 dirs at the install root, the
 * 485-file resources/ subtree, the packed archives, and the game's own
 * save-dir entries. 512 slots overflowed at boot round 10 (resources/ only);
 * 8192 would overflow the whole tree (round 11). Widest directory is
 * gfx/characters/costumes with 1,675 children (per-scan cap below). */
#define FS_SLOTS      16384u
#define FS_FILE_RG    64u
#define FS_FIND_RG    8u
#define FS_FIND_MAX   2048u
#define FILE_TOKEN(x) ((x) + 0x100u)
#define FIND_TOKEN(x) ((x) + 0x200u)

typedef struct {
    char     key[160];
    uint8_t  is_dir;
    uint8_t  live;            /* slot in use (a file may be empty or lazy: data == NULL) */
    uint8_t  lazy;            /* bytes not loaded yet: src names the host file */
    uint8_t  windowed;        /* round 24e: never loaded whole; reads go to the host file */
    uint8_t *data;            /* file bytes (host heap) */
    uint32_t size, cap;
    char    *src;             /* lazy entries: the seed path the loader reads */
    uint8_t *win[FS_WIN_SLOTS]; /* windowed entries: FS_WIN-byte caches of the host file, LRU (round 41) */
    uint32_t win_off[FS_WIN_SLOTS], win_len[FS_WIN_SLOTS], win_tick[FS_WIN_SLOTS];
    uint8_t  win_last;        /* the slot used last */
} fs_entry;

static fs_entry g_fs[FS_SLOTS];

/* Round 12f: key -> slot hash index (open addressing, FNV-1a). fs_find was a
 * strcmp over all 16384 slots per lookup -- 1 s of a 12 s boot once the
 * allocator stopped hiding it. Deletes rebuild the index (rare). */
#define FS_HASH 65536u
static uint32_t g_fs_hash[FS_HASH];          /* slot index + 1, 0 = empty */
static uint32_t fs_hash_key(const char *k) {
    uint32_t h = 2166136261u;
    for (; *k; ++k) { h ^= (uint8_t)*k; h *= 16777619u; }
    return h;
}
static void fs_hash_insert(uint32_t slot) {
    uint32_t h = fs_hash_key(g_fs[slot].key) & (FS_HASH - 1u);
    while (g_fs_hash[h]) h = (h + 1u) & (FS_HASH - 1u);
    g_fs_hash[h] = slot + 1u;
}
static void fs_hash_rebuild(void) {
    memset(g_fs_hash, 0, sizeof g_fs_hash);
    for (uint32_t i = 0; i < FS_SLOTS; ++i) if (g_fs[i].live) fs_hash_insert(i);
}
static uint32_t g_file_used[FS_FILE_RG];       /* 0 = free */
/* open-file registry: guest FILE* -> token -> file index */
static uint32_t g_file_idx[FS_FILE_RG];
static uint64_t g_file_pos[FS_FILE_RG];
static uint8_t  g_file_w[FS_FILE_RG], g_file_app[FS_FILE_RG];
/* find snapshots */
static uint32_t g_find_used[FS_FIND_RG];
static uint32_t g_find_dir[FS_FIND_RG];        /* entry index */
static uint32_t g_find_cur[FS_FIND_RG];
static uint32_t g_find_n[FS_FIND_RG];
static uint32_t g_find_ids[FS_FIND_RG][FS_FIND_MAX];

/* ISAAC_FS_TRACE=1 logs every path this layer is asked about and what it
 * answered.  The guest builds an in-memory index of its data directories and
 * then resolves archives against that index, so "Failed to open archive file"
 * says nothing about which probe actually failed -- or whether one happened
 * at all.  Off by default: the boot makes thousands of FS calls. */
static int fs_trace(void) {
    static int v = -1;
    if (v < 0) { const char *e = getenv("ISAAC_FS_TRACE"); v = (e && *e && *e != '0'); }
    return v;
}

__attribute__((unused))
static uint32_t fs_err_last(void) { return isaac_r32(ISAAC_TEB_VA + 0x34u); }
static void fs_err_set(uint32_t e) { isaac_w32(ISAAC_TEB_VA + 0x34u, e); }

/* ---- key normalisation ------------------------------------------------- */
/* Returns 1 on success, 0 if the path is unusable (empty key is the root). */
static int fs_key(const char *p, char *out, size_t cap) {
    char tmp[256];
    size_t n = 0, i = 0;
    /* strip leading "./" sequences */
    while (p[i] == '.' && p[i + 1] == '/' && p[i + 2]) i += 2;
    /* collapse separators: both / and \ */
    for (; p[i] && n + 1 < sizeof tmp; ++i) {
        char c = p[i];
        if (c == '\\') c = '/';
        if (c == '/') {
            while (p[i + 1] == '/' || p[i + 1] == '\\') ++i;
            if (n && tmp[n - 1] != '/') tmp[n++] = '/';
        } else {
            tmp[n++] = (char)tolower((unsigned char)c);
        }
    }
    /* drop a single trailing "/" */
    while (n > 1 && tmp[n - 1] == '/') --n;
    tmp[n] = 0;
    /* drop "." segments.  The leading-"./" strip above cannot handle "./" on
     * its own (nothing follows it) or a "." in the middle, and the game does
     * probe the bare cwd -- GetFileAttributesA("./") was landing on the key
     * "c:/isaac/." and missing. */
    {
        size_t base = (n && tmp[0] == '/') ? 1u : 0u;   /* keep a leading '/' */
        size_t r = base, w = base;
        while (r < n) {
            size_t seg = r;
            while (seg < n && tmp[seg] != '/') ++seg;
            int dot = (seg - r == 1 && tmp[r] == '.');
            if (!dot) {
                if (w > base) tmp[w++] = '/';
                memmove(tmp + w, tmp + r, seg - r);
                w += seg - r;
            }
            r = (seg < n) ? seg + 1 : n;
        }
        n = w;
        tmp[n] = 0;
    }
    /* resolve relative paths against the virtual cwd (the game's data root).
     * On Windows the save dir "." IS the cwd, so both spellings must land on
     * the same key. */
    char cleaned[256];
    size_t cn = 0;
    int absolute = (tmp[0] == '/');
    if (!absolute && !(n >= 3 && tmp[1] == ':')) {
        static const char cwd[] = "c:/isaac";
        if (n) {
            memcpy(cleaned, cwd, sizeof cwd - 1);
            cn = sizeof cwd - 1;
            cleaned[cn++] = '/';
        } else {
            memcpy(cleaned, cwd, sizeof cwd);
            cn = sizeof cwd - 1;
        }
        if (n) { memcpy(cleaned + cn, tmp, n + 1); cn += n; }
    } else {
        memcpy(cleaned, tmp, n + 1);
        cn = n;
    }
    if (cn >= cap) return 0;
    memcpy(out, cleaned, cn + 1);
    return 1;
}

static fs_entry *fs_find(const char *key) {
    uint32_t h = fs_hash_key(key) & (FS_HASH - 1u);
    for (uint32_t n = 0; n < FS_HASH && g_fs_hash[h]; ++n, h = (h + 1u) & (FS_HASH - 1u)) {
        fs_entry *e = &g_fs[g_fs_hash[h] - 1u];
        if (e->live && strcmp(e->key, key) == 0) return e;
    }
    return NULL;
}

static uint32_t g_fs_next_free;              /* rotating hint for fs_new */
static fs_entry *fs_new(const char *key, int is_dir) {
    fs_entry *e = fs_find(key);
    if (e) return e;
    for (unsigned n = 0; n < FS_SLOTS; ++n) {
        uint32_t i = (g_fs_next_free + n) % FS_SLOTS;
        if (!g_fs[i].live) {
            memset(&g_fs[i], 0, sizeof g_fs[i]);
            strncpy(g_fs[i].key, key, sizeof g_fs[i].key - 1);
            g_fs[i].is_dir = (uint8_t)is_dir;
            g_fs[i].live = 1;
            fs_hash_insert(i);
            g_fs_next_free = (i + 1u) % FS_SLOTS;
            return &g_fs[i];
        }
    }
    return NULL;
}

static void fs_free_entry(fs_entry *e) {
    if (e->data) free(e->data);
    if (e->src) free(e->src);
    for (unsigned wk = 0; wk < FS_WIN_SLOTS; ++wk) if (e->win[wk]) free(e->win[wk]);
    memset(e, 0, sizeof *e);
    fs_hash_rebuild();                        /* deletes are rare; keep the index exact */
}

/* ---- lazy bytes (round 12f) -------------------------------------------- */
/* The boot seeds 10,725 files (208 MB) before main(); reading and copying
 * them all cost ~3 s of a 12 s boot and 208 MB of host heap for files the
 * run never opens. A lazy entry carries its size and its seed path; the
 * bytes are fetched on the first access through the loader below, which
 * the driver supplies (boot_integration.mjs: Module.isaacLazyRead). The
 * selftest installs a C reader instead. */
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(int, isaac_fs_lazy_read_js, (const char *src, uint8_t *dst, uint32_t len), {
    if (typeof Module.isaacLazyRead !== "function") return 0;
    var s = "";
    for (var i = src; HEAPU8[i]; i++) s += String.fromCharCode(HEAPU8[i]);
    return Module.isaacLazyRead(s, dst, len) ? 1 : 0;
});
#else
static int isaac_fs_lazy_read_js(const char *src, uint8_t *dst, uint32_t len) {
    (void)src; (void)dst; (void)len; return 0;
}
#endif
typedef int (*isaac_fs_lazy_reader)(const char *src, uint8_t *dst, uint32_t len);
static isaac_fs_lazy_reader g_lazy_reader = isaac_fs_lazy_read_js;
void isaac_fs_set_lazy_reader(isaac_fs_lazy_reader fn) { g_lazy_reader = fn ? fn : isaac_fs_lazy_read_js; }
static uint32_t g_lazy_loads, g_lazy_failures, g_lazy_windowed;

/* ---- windowed lazy files (round 24e) ----------------------------------
 * The DLC archives (afterbirth.a 145 MB, afterbirthp.a 604 MB,
 * repentance.a 385 MB) cannot be loaded whole: with music.a and videos.a
 * that is 1.5 GB of file bytes in a wasm32 heap that also holds the game.
 * A lazy entry at or above ISAAC_FS_WINDOW_MIN MiB (default 32) is never
 * materialised when the driver offers Module.isaacLazyPread(src, dst, off,
 * len): fread serves it through one FS_WIN-byte window per file, refilled
 * from the host file at the offset the game asks for. The engine reads
 * every archive front to back at mount (its per-entry checksum), so the
 * window turns ~1.5 million 1 KB freads into ~1,500 host reads. */
#define FS_WIN (1u << 20)
/* Round 41: windows per file. Two windows served the mount loop (table +
 * data) but thrashed on a level load: the engine reads a level's resources
 * scattered over a few dozen MB of the archive, alternating between
 * neighbouring windows, and the two-slot cache refetched 827 MB (831
 * windows) for one run start -- 712 MB of afterbirthp.a alone -- as 1 MB
 * XHR bodies that peaked the renderer at 2.4 GB before the GC caught up.
 * 32 slots (32 MB per windowed file, only while touched) hold the working
 * set; a miss evicts the least recently used. The fill/hit census is in
 * isaac_fs_window_stats(). */
static uint32_t g_win_tick, g_win_fills, g_win_hits;
#ifdef __EMSCRIPTEN__
EM_JS(int, isaac_fs_lazy_pread_avail, (void), {
    return (typeof Module.isaacLazyPread === "function") ? 1 : 0;
});
EM_JS(int, isaac_fs_lazy_pread_js, (const char *src, uint8_t *dst, uint32_t off, uint32_t len), {
    if (typeof Module.isaacLazyPread !== "function") return -1;
    var s = "";
    for (var i = src; HEAPU8[i]; i++) s += String.fromCharCode(HEAPU8[i]);
    var n = Module.isaacLazyPread(s, dst, off, len);
    /* Round 56: a promise suspends the wasm stack (this is a JSPI import,
     * build_boot.py JSPI_IMPORTS) until the page's reader Worker has put the
     * bytes in place; a number is the answer at once. */
    return (typeof n === "number" || (n && typeof n.then === "function")) ? n : -1;
});
#else
static int isaac_fs_lazy_pread_avail(void) { return 0; }
static int isaac_fs_lazy_pread_js(const char *src, uint8_t *dst, uint32_t off, uint32_t len) {
    (void)src; (void)dst; (void)off; (void)len; return -1;
}
#endif
static uint32_t g_window_min_override;            /* selftest: bytes, 0 = env/default */
void isaac_fs_set_window_min(uint32_t bytes) { g_window_min_override = bytes; }
static uint32_t fs_window_min(void) {
    static uint32_t v;
    if (g_window_min_override) return g_window_min_override;
    if (!v) {
        const char *s = getenv("ISAAC_FS_WINDOW_MIN");
        unsigned long mib = (s && *s) ? strtoul(s, NULL, 10) : 32ul;
        v = mib ? (uint32_t)(mib << 20) : 0xFFFFFFFFu;   /* 0 = never window */
    }
    return v;
}
/* A C positional reader (the selftest installs one; the drivers answer
 * through Module.isaacLazyPread instead). */
typedef int (*isaac_fs_lazy_preader)(const char *src, uint8_t *dst, uint32_t off, uint32_t len);
static isaac_fs_lazy_preader g_lazy_preader;
void isaac_fs_set_lazy_preader(isaac_fs_lazy_preader fn) { g_lazy_preader = fn; }

/* Round 31: saves persist. A file the guest opened for writing is handed to
 * the host when it is closed, and a deleted one is announced: the node
 * driver writes it under ISAAC_SAVE_DIR, the browser page into IndexedDB,
 * and both seed it back at the next boot (the persistentgamedata*.dat the
 * game writes on every game over live under Documents/My Games/...). The C
 * hooks are the selftest's; the JS ones are Module.isaacPersist(key, src,
 * dataPtr, len) and Module.isaacUnlink(key, src); `src` is the seed path the
 * file was registered with (verbatim case), "" for a file the game created. */
typedef int (*isaac_fs_persist_fn)(const char *key, const char *src, const uint8_t *data, uint32_t len);
typedef int (*isaac_fs_unlink_fn)(const char *key, const char *src);
static isaac_fs_persist_fn g_persist_hook;
static isaac_fs_unlink_fn g_unlink_hook;
static uint32_t g_persisted, g_unlinked;
void isaac_fs_set_persist_hooks(isaac_fs_persist_fn p, isaac_fs_unlink_fn u) { g_persist_hook = p; g_unlink_hook = u; }
uint32_t isaac_fs_persisted(void) { return g_persisted; }
uint32_t isaac_fs_unlinked(void) { return g_unlinked; }
#ifdef __EMSCRIPTEN__
EM_JS(int, isaac_fs_persist_js, (const char *key, const char *src, const uint8_t *data, uint32_t len), {
    if (typeof Module.isaacPersist !== "function") return 0;
    var k = "", s = "";
    for (var i = key; HEAPU8[i]; i++) k += String.fromCharCode(HEAPU8[i]);
    for (var j = src; HEAPU8[j]; j++) s += String.fromCharCode(HEAPU8[j]);
    return Module.isaacPersist(k, s, data, len) ? 1 : 0;
});
EM_JS(int, isaac_fs_unlink_js, (const char *key, const char *src), {
    if (typeof Module.isaacUnlink !== "function") return 0;
    var k = "", s = "";
    for (var i = key; HEAPU8[i]; i++) k += String.fromCharCode(HEAPU8[i]);
    for (var j = src; HEAPU8[j]; j++) s += String.fromCharCode(HEAPU8[j]);
    return Module.isaacUnlink(k, s) ? 1 : 0;
});
#else
static int isaac_fs_persist_js(const char *key, const char *src, const uint8_t *data, uint32_t len) {
    (void)key; (void)src; (void)data; (void)len; return 0;
}
static int isaac_fs_unlink_js(const char *key, const char *src) { (void)key; (void)src; return 0; }
#endif
static void fs_persist(fs_entry *e) {
    static const uint8_t empty[1] = { 0 };
    if (!e || e->is_dir || e->windowed) return;
    const char *src = e->src ? e->src : "";
    const uint8_t *data = e->data ? e->data : empty;
    int r = g_persist_hook ? g_persist_hook(e->key, src, data, e->size)
                           : isaac_fs_persist_js(e->key, src, data, e->size);
    if (r > 0) ++g_persisted;
}
static void fs_unpersist(const fs_entry *e) {
    if (!e || e->is_dir || e->windowed) return;
    const char *src = e->src ? e->src : "";
    int r = g_unlink_hook ? g_unlink_hook(e->key, src) : isaac_fs_unlink_js(e->key, src);
    if (r > 0) ++g_unlinked;
}
static int fs_pread_avail(void) { return g_lazy_preader ? 1 : isaac_fs_lazy_pread_avail(); }
static int fs_pread(const char *src, uint8_t *dst, uint32_t off, uint32_t len) {
    return g_lazy_preader ? g_lazy_preader(src, dst, off, len) : isaac_fs_lazy_pread_js(src, dst, off, len);
}
/* Copy [pos, pos+want) of a windowed entry into dst; returns the bytes copied.
 * The mount loop alternates between the entry table at the END of an archive
 * and each entry's data near its start (one window thrashed: 4.7 GB of host
 * reads for 1.5 GB of archives); a level load walks a few dozen MB of
 * scattered resources (two windows thrashed: 827 MB for one run start). The
 * slots are an LRU set; the window used last is tried first. */
static uint32_t fs_window_read(fs_entry *e, uint64_t pos, uint32_t want, uint8_t *dst) {
    uint32_t done = 0;
    while (done < want) {
        uint64_t p = pos + done;
        unsigned k, hit = FS_WIN_SLOTS;
        if (p >= e->size) break;
        k = e->win_last;
        if (e->win[k] && p >= e->win_off[k] && p < (uint64_t)e->win_off[k] + e->win_len[k]) hit = k;
        else for (k = 0; k < FS_WIN_SLOTS; ++k)
            if (e->win[k] && p >= e->win_off[k] && p < (uint64_t)e->win_off[k] + e->win_len[k]) { hit = k; break; }
        if (hit == FS_WIN_SLOTS) {
            uint64_t start = p & ~(uint64_t)(FS_WIN - 1u);
            uint32_t len = (uint32_t)((e->size - start) < FS_WIN ? (e->size - start) : FS_WIN);
            int n;
            unsigned oldest = 0;
            for (k = 0; k < FS_WIN_SLOTS; ++k) {          /* an empty slot, else the least recently used */
                if (!e->win[k]) { oldest = k; break; }
                if (e->win_tick[k] < e->win_tick[oldest]) oldest = k;
            }
            k = oldest;
            if (!e->win[k]) e->win[k] = (uint8_t *)malloc(FS_WIN);
            if (!e->win[k]) break;
            n = fs_pread(e->src ? e->src : e->key, e->win[k], (uint32_t)start, len);
            ++g_win_fills;
            if (n <= 0) {
                isaac_log("[isaac][fs] windowed read of '%s' at %llu (%u bytes) FAILED (%d)",
                          e->src ? e->src : e->key, (unsigned long long)start, len, n);
                e->win_len[k] = 0;
                break;
            }
            e->win_off[k] = (uint32_t)start; e->win_len[k] = (uint32_t)n;
            if (p >= (uint64_t)e->win_off[k] + e->win_len[k]) break;
            hit = k;
        } else ++g_win_hits;
        e->win_tick[hit] = ++g_win_tick;
        e->win_last = (uint8_t)hit;
        {
            uint32_t o = (uint32_t)(p - e->win_off[hit]);
            uint32_t chunk = e->win_len[hit] - o;
            if (chunk > want - done) chunk = want - done;
            memcpy(dst + done, e->win[hit] + o, chunk);
            done += chunk;
        }
    }
    return done;
}
static void fs_window_drop(fs_entry *e) {
    unsigned k;
    for (k = 0; k < FS_WIN_SLOTS; ++k) {
        if (e->win[k]) { free(e->win[k]); e->win[k] = NULL; }
        e->win_off[k] = e->win_len[k] = e->win_tick[k] = 0;
    }
    e->win_last = 0; e->windowed = 0;
}
uint32_t isaac_fs_lazy_windowed(void) { return g_lazy_windowed; }
/* the window census: host reads (fills) and reads served from a resident window */
void isaac_fs_window_stats(uint32_t *fills, uint32_t *hits) { *fills = g_win_fills; *hits = g_win_hits; }

/* Round 26: the engine verifies every archive entry at mount (a checksum
 * over the whole payload, 1.5 GB with the DLC set). The archives are
 * verified offline, so the lifted mount skips that pass (lift_patches.py
 * BLOCK_PATCHES 0x00a17cee) unless ISAAC_ARCHIVE_VERIFY=1. Called once per
 * entry, so the answer is cached. */
int isaac_archive_verify_on(void) {
    static int v = -1;
    if (v < 0) {
        const char *e = getenv("ISAAC_ARCHIVE_VERIFY");
        v = (e && *e && *e != '0') ? 1 : 0;
        isaac_log(v ? "[isaac][fs] ISAAC_ARCHIVE_VERIFY=1: the mount reads and checksums every archive entry"
                    : "[isaac][fs] archive mount trusts the entry tables (ISAAC_ARCHIVE_VERIFY=1 to checksum every entry)");
    }
    return v;
}

static int fs_materialise(fs_entry *e) {
    if (!e || !e->lazy) return 1;
    if (e->size >= fs_window_min() && fs_pread_avail()) {
        e->lazy = 0; e->windowed = 1;
        ++g_lazy_windowed;
        isaac_log("[isaac][fs] '%s' (%u bytes) is served through a %u KB window, never loaded whole",
                  e->src ? e->src : e->key, e->size, FS_WIN >> 10);
        return 1;
    }
    e->lazy = 0;
    if (!e->size) return 1;
    uint8_t *buf = (uint8_t *)malloc(e->size);
    if (!buf || !g_lazy_reader(e->src ? e->src : e->key, buf, e->size)) {
        ++g_lazy_failures;
        isaac_log("[isaac][fs] lazy load of '%s' (%u bytes) FAILED -- the file reads as empty",
                  e->src ? e->src : e->key, e->size);
        free(buf);
        e->size = 0;
        return 0;
    }
    e->data = buf; e->cap = e->size;
    ++g_lazy_loads;
    return 1;
}
uint32_t isaac_fs_lazy_loads(void) { return g_lazy_loads; }
uint32_t isaac_fs_lazy_failures(void) { return g_lazy_failures; }

/* parent key of a key; "" if none */
static void fs_parent_key(const char *key, char *out, size_t cap) {
    size_t n = strlen(key);
    if (!n) { out[0] = 0; return; }
    const char *slash = strrchr(key, '/');
    size_t m = slash ? (size_t)(slash - key) : 0;
    if (m >= cap) m = cap - 1;
    memcpy(out, key, m);
    out[m] = 0;
}

/* ---- boot-time asset seeding ------------------------------------------- */
/* The RAM-FS starts empty, so the game's first LoadImage on the HUD path
 * (Manager::LoadImage "gfx/ui/coop menu.png" -> KAGE archive get) returns
 * NULL and the lifted code dereferences it (guest fault at 0x009a26c2).
 * The fix is to make the packed archives real files the game opens and
 * parses itself (KAGE reads resources/packed/ .a archives via fopen/fread) — NOT to
 * fake LoadImage. The boot harness calls isaac_fs_seed() for each archive
 * before main(); paths normalize exactly as fopen's argument does, so a
 * relative "resources/packed/graphics.a" lands on the same key the game
 * later opens (c:/isaac/resources/packed/graphics.a).
 *
 * Bytes are copied into the entry's own host-heap buffer (like a written
 * file), so the caller's source buffer can be freed after the call.
 * Parent directories are materialised so FindFirstFileA/dir scans see the
 * file. Returns 1 on success, 0 on bad path / table full / OOM. */
static int fs_ensure_dirs(const char *key) {
    /* create every ancestor directory entry of `key` (idempotent). */
    char dir[256];
    fs_parent_key(key, dir, sizeof dir);
    if (!dir[0]) return 1;
    /* build ancestors front-to-back so each parent exists first. */
    for (size_t i = 1; dir[i]; ++i) {
        if (dir[i] == '/') {
            char save = dir[i];
            dir[i] = 0;
            if (!fs_find(dir) && !fs_new(dir, 1)) return 0;
            dir[i] = save;
        }
    }
    if (!fs_find(dir) && !fs_new(dir, 1)) return 0;
    return 1;
}

int isaac_fs_seed(const char *path, const uint8_t *data, uint32_t len) {
    char key[256];
    if (!path || !fs_key(path, key, sizeof key) || !key[0]) return 0;
    if (!fs_ensure_dirs(key)) return 0;
    fs_entry *e = fs_new(key, 0);
    if (!e) return 0;
    if (e->is_dir) return 0;              /* a dir already owns this key */
    uint8_t *buf = NULL;
    if (len) {
        buf = (uint8_t *)malloc(len);
        if (!buf) return 0;
        if (data) memcpy(buf, data, len);
        else memset(buf, 0, len);
    }
    if (e->data) free(e->data);
    if (e->src) { free(e->src); e->src = NULL; }
    fs_window_drop(e);
    e->lazy = 0;
    e->data = buf;
    e->size = len;
    e->cap = len;
    return 1;
}

/* Lazy seed: the entry exists with its size (directory scans, stat and
 * GetFileSize see it); the bytes come through the lazy reader on first use.
 * `path` is kept verbatim as the loader's argument, so case and separators
 * are the driver's own, not the normalised key's. */
int isaac_fs_seed_lazy(const char *path, uint32_t len) {
    char key[256];
    if (!path || !fs_key(path, key, sizeof key) || !key[0]) return 0;
    if (!fs_ensure_dirs(key)) return 0;
    fs_entry *e = fs_new(key, 0);
    if (!e || e->is_dir) return 0;
    if (e->data) { free(e->data); e->data = NULL; }
    fs_window_drop(e);
    if (e->src) free(e->src);
    e->src = strdup(path);
    if (!e->src) return 0;
    e->size = len; e->cap = 0; e->lazy = 1;
    return 1;
}

/* Round 14f: _access() and friends ask whether a guest path exists. */
int isaac_fs_exists_guest_path(uint32_t path_va) {
    char p[512], key[256];
    (void)isaac_guest_cstr(path_va, p, sizeof p, "_access");
    if (!fs_key(p, key, sizeof key)) return 0;
    return fs_find(key) != NULL;
}

/* ---- guest helpers ----------------------------------------------------- */
static uint32_t fs_iobuf_alloc(uint32_t token) {
    uint32_t fp = isaac_guest_alloc(0x20u);
    if (!fp) return 0;
    for (unsigned k = 0; k < 0x20; k += 4) isaac_w32(fp + k, 0);
    isaac_w32(fp + 0x10u, token);               /* _iobuf.file slot */
    return fp;
}

/* ---- directory / file lifecycle (kernel32) ----------------------------- */

void imp_kernel32__GetFileAttributesA(CpuState *restrict cpu) {
    char p[512], key[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "GetFileAttributesA");
    if (!fs_key(p, key, sizeof key)) { fs_err_set(2u); cpu->EAX = 0xFFFFFFFFu; return; }
    fs_entry *e = fs_find(key);
    if (fs_trace())
        isaac_log("[isaac][fs] GetFileAttributesA('%s') key='%s' -> %s", p, key,
                  e ? (e->is_dir ? "DIR" : "FILE") : "MISS");
    if (!e) { fs_err_set(2u); cpu->EAX = 0xFFFFFFFFu; return; } /* INVALID_FILE_ATTRIBUTES */
    cpu->EAX = e->is_dir ? 0x10u : 0x80u;
}

void imp_kernel32__CreateDirectoryA(CpuState *restrict cpu) {
    char p[512], key[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "CreateDirectoryA");
    (void)isaac_arg(cpu, 1);
    if (!fs_key(p, key, sizeof key)) { fs_err_set(3u); cpu->EAX = 0; return; }
    if (fs_find(key)) { fs_err_set(183u); cpu->EAX = 0; return; }   /* already exists */
    char parent[256];
    fs_parent_key(key, parent, sizeof parent);
    if (parent[0] && !fs_find(parent)) { fs_err_set(3u); cpu->EAX = 0; return; } /* path not found */
    if (!fs_new(key, 1)) { fs_err_set(5u); cpu->EAX = 0; return; }
    fs_err_set(0);
    cpu->EAX = 1;
}

void imp_kernel32__DeleteFileA(CpuState *restrict cpu) {
    char p[512], key[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "DeleteFileA");
    if (!fs_key(p, key, sizeof key)) { fs_err_set(2u); cpu->EAX = 0; return; }
    fs_entry *e = fs_find(key);
    if (!e || e->is_dir) { fs_err_set(2u); cpu->EAX = 0; return; }
    fs_unpersist(e);
    fs_free_entry(e);
    fs_err_set(0);
    cpu->EAX = 1;
}

void imp_kernel32__RemoveDirectoryA(CpuState *restrict cpu) {
    char p[512], key[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "RemoveDirectoryA");
    if (!fs_key(p, key, sizeof key)) { fs_err_set(3u); cpu->EAX = 0; return; }
    if (!key[0] || key[0] == 0) { fs_err_set(5u); cpu->EAX = 0; return; }
    fs_entry *e = fs_find(key);
    if (!e) { fs_err_set(3u); cpu->EAX = 0; return; }
    if (!e->is_dir) { fs_err_set(5u); cpu->EAX = 0; return; }
    /* empty check */
    size_t pref = strlen(key);
    for (unsigned i = 0; i < FS_SLOTS; ++i) {
        if (!g_fs[i].live) continue;
        if (strncmp(g_fs[i].key, key, pref) == 0 && g_fs[i].key[pref] == '/') {
            fs_err_set(145u); cpu->EAX = 0; return;      /* ERROR_DIR_NOT_EMPTY */
        }
    }
    fs_free_entry(e);
    fs_err_set(0);
    cpu->EAX = 1;
}

/* ---- FindFirst/Next/Close ---------------------------------------------- */

static void fs_find_fill(CpuState *cpu, uint32_t findbuf, fs_entry *e) {
    /* WIN32_FIND_DATAA: attr +0, ctime +4, atime +0xc, wtime +0x14,
     * nSizeHigh +0x1c, nSizeLow +0x20, res0 +0x24, res1 +0x28,
     * cFileName +0x2c (260). */
    isaac_w32(findbuf + 0x00u, e->is_dir ? 0x10u : 0x80u);
    isaac_w32(findbuf + 0x04u, 0); isaac_w32(findbuf + 0x08u, 0);
    isaac_w32(findbuf + 0x0cu, 0); isaac_w32(findbuf + 0x10u, 0);
    isaac_w32(findbuf + 0x14u, 0); isaac_w32(findbuf + 0x18u, 0);
    isaac_w32(findbuf + 0x1cu, 0); isaac_w32(findbuf + 0x20u, 0);
    isaac_w32(findbuf + 0x24u, 0); isaac_w32(findbuf + 0x28u, 0);
    isaac_w32(findbuf + 0x130u, 0); isaac_w32(findbuf + 0x134u, 0);
    isaac_w32(findbuf + 0x138u, 0); isaac_w32(findbuf + 0x13cu, 0);
    const char *base = strrchr(e->key, '/');
    const char *nm = base ? base + 1 : e->key;
    uint32_t dst = findbuf + 0x2cu;
    while (*nm) {
        *(uint8_t *)isaac_g(dst) = (uint8_t)*nm;
        ++nm; ++dst;
    }
    *(uint8_t *)isaac_g(dst) = 0;
}

/* Strip a trailing wildcard segment (backslash-star or slash-star) in place.
 * Both Find flavours receive "<dir>" + separator + "*" from the game; the
 * RAM-FS enumerates the directory itself. */
static void fs_strip_wildcard(char *p) {
    size_t n = strlen(p);
    if (n >= 2 && p[n - 1] == '*' && (p[n - 2] == '/' || p[n - 2] == '\\'))
        p[n - 2] = 0;
}

/* Open a directory snapshot for `key` (children only, one level).
 * Returns the snapshot id, or -1 when the key is not a directory (caller
 * sets ERROR_FILE_NOT_FOUND) / -2 when the directory has no entries or the
 * snapshot table is full (ERROR_NO_MORE_FILES). Shared by the A and W
 * FindFirstFile shims so both see exactly the same tree. */
static int fs_find_open(const char *key) {
    fs_entry *dir = fs_find(key);
    if (!dir || !dir->is_dir) return -1;
    uint32_t sid = 0xFFFFFFFFu;
    for (unsigned s = 0; s < FS_FIND_RG; ++s) if (!g_find_used[s]) { sid = s; break; }
    if (sid == 0xFFFFFFFFu) return -2;
    size_t pref = strlen(key);
    uint32_t cnt = 0;
    for (unsigned i = 0; i < FS_SLOTS && cnt < FS_FIND_MAX; ++i) {
        if (!g_fs[i].live) continue;
        const char *k = g_fs[i].key;
        if (strncmp(k, key, pref) == 0 && k[pref] == '/' &&
            !strchr(k + pref + 1, '/'))
            g_find_ids[sid][cnt++] = i;
    }
    if (!cnt) return -2;
    if (fs_trace()) {
        /* what the scan will actually hand back, which is the only way to tell a
         * file that is missing from one the caller chose to ignore */
        char names[512]; size_t at = 0; names[0] = 0;
        for (uint32_t j = 0; j < cnt && at + 2 < sizeof names; ++j) {
            const char *k = g_fs[g_find_ids[sid][j]].key;
            const char *b = strrchr(k, '/');
            int w = snprintf(names + at, sizeof names - at, "%s%s", at ? " " : "", b ? b + 1 : k);
            if (w < 0) break;
            at += (size_t)w;
        }
        isaac_log("[isaac][fs] scan '%s' -> %u entries: %s", key, cnt, names);
    }
    g_find_used[sid] = 1;
    g_find_dir[sid] = 0; g_find_cur[sid] = 0; g_find_n[sid] = cnt;
    return (int)sid;
}

void imp_kernel32__FindFirstFileA(CpuState *restrict cpu) {
    char p[512]; uint32_t findbuf = isaac_arg(cpu, 1);
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "FindFirstFileA");
    fs_strip_wildcard(p);
    char key[256];
    if (!fs_key(p, key, sizeof key)) { fs_err_set(2u); cpu->EAX = 0xFFFFFFFFu; return; }
    int sid = fs_find_open(key);
    if (fs_trace())
        isaac_log("[isaac][fs] FindFirstFileA('%s') key='%s' -> %s", p, key,
                  sid >= 0 ? "DIR" : (sid == -1 ? "MISS" : "DIR (empty)"));
    if (sid == -1) { fs_err_set(2u); cpu->EAX = 0xFFFFFFFFu; return; }
    if (sid == -2) { fs_err_set(18u); cpu->EAX = 0xFFFFFFFFu; return; } /* no files -> exhausted */
    fs_find_fill(cpu, findbuf, &g_fs[g_find_ids[sid][0]]);
    fs_err_set(0);
    cpu->EAX = FIND_TOKEN((uint32_t)sid);
}

void imp_kernel32__FindNextFileA(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0), findbuf = isaac_arg(cpu, 1);
    uint32_t sid = h - FIND_TOKEN(0);
    if (sid >= FS_FIND_RG || !g_find_used[sid]) { fs_err_set(6u); cpu->EAX = 0; return; }
    uint32_t c = g_find_cur[sid] + 1;
    if (c >= g_find_n[sid]) { fs_err_set(18u); cpu->EAX = 0; return; }
    g_find_cur[sid] = c;
    fs_find_fill(cpu, findbuf, &g_fs[g_find_ids[sid][c]]);
    fs_err_set(0);
    cpu->EAX = 1;
}

void imp_kernel32__FindClose(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0);
    uint32_t sid = h - FIND_TOKEN(0);
    if (sid < FS_FIND_RG && g_find_used[sid]) g_find_used[sid] = 0;
    cpu->EAX = 1;
}

/* ---- the WIDE pair: KAGE's directory scan -------------------------------
 * The engine's readdir (0x00a172e0 over the opendir at 0x00a16f50) does
 * mbstowcs_s(dir) -> GetFullPathNameW -> append "\*" -> FindFirstFileW, then
 * FindNextFileW through a register-held import (mov edx,[0xb1825c] -- which
 * is why the call-site census recorded FindNextFileW as "never called"), and
 * brings each cFileName back with wcstombs_s. The mount-root index that
 * resolves EVERY relative path (0x00a16c60) is built from that scan at KAGE
 * init (0x00a710a0 -> 0x00a15f10 -> vtable+0x18 = 0x00a687f0). With this pair
 * stubbed, the root's std::map stayed empty and all 18 packed archives
 * failed to open before any fopen (boot round 9, recomp-architecture.md §18).
 *
 * WIN32_FIND_DATAW: attr +0, ctime +4, atime +0xc, wtime +0x14, nSizeHigh
 * +0x1c, nSizeLow +0x20, res0 +0x24, res1 +0x28, cFileName WCHAR[260] +0x2c,
 * cAlternateFileName WCHAR[14] +0x234 (struct 0x250). The game reads the
 * attribute (0x10 dir / 0x40 device / else file), cFileName at DIR+0x244
 * and cAlternateFileName at DIR+0x44c with the find data at DIR+0x218. */
static void fs_guest_wcstr(uint32_t va, char *p, size_t cap) {
    /* NUL-terminated UTF-16 guest string -> UTF-8 host string (RAM-FS keys
     * are ASCII; anything else is carried through as UTF-8 and lowercased
     * by fs_key like any other byte). */
    size_t n = 0;
    while (n + 4 < cap && isaac_is_guest_va(va + 1)) {
        uint16_t u = isaac_r16(va);
        va += 2;
        if (!u) break;
        if (u < 0x80) p[n++] = (char)u;
        else if (u < 0x800) { p[n++] = (char)(0xC0u | (u >> 6)); p[n++] = (char)(0x80u | (u & 0x3Fu)); }
        else { p[n++] = (char)(0xE0u | (u >> 12)); p[n++] = (char)(0x80u | ((u >> 6) & 0x3Fu)); p[n++] = (char)(0x80u | (u & 0x3Fu)); }
    }
    p[n] = 0;
}

static void fs_find_fill_w(uint32_t findbuf, const fs_entry *e) {
    isaac_w32(findbuf + 0x00u, e->is_dir ? 0x10u : 0x80u);
    for (uint32_t k = 4; k < 0x2cu; k += 4) isaac_w32(findbuf + k, 0);
    if (!e->is_dir) isaac_w32(findbuf + 0x20u, e->size);   /* nFileSizeLow */
    const char *base = strrchr(e->key, '/');
    const char *nm = base ? base + 1 : e->key;
    uint32_t dst = findbuf + 0x2cu;
    for (unsigned i = 0; nm[i] && i < 259; ++i, dst += 2)
        isaac_w16(dst, (uint16_t)(uint8_t)nm[i]);        /* keys are ASCII */
    isaac_w16(dst, 0);
    isaac_w16(findbuf + 0x234u, 0);                      /* cAlternateFileName = "" */
}

void imp_kernel32__FindFirstFileW(CpuState *restrict cpu) {
    char p[512]; uint32_t findbuf = isaac_arg(cpu, 1);
    fs_guest_wcstr(isaac_arg(cpu, 0), p, sizeof p);
    fs_strip_wildcard(p);
    char key[256];
    if (!fs_key(p, key, sizeof key)) { fs_err_set(2u); cpu->EAX = 0xFFFFFFFFu; return; }
    int sid = fs_find_open(key);
    if (fs_trace())
        isaac_log("[isaac][fs] FindFirstFileW('%s') key='%s' -> %s", p, key,
                  sid >= 0 ? "DIR" : (sid == -1 ? "MISS" : "DIR (empty)"));
    if (sid == -1) { fs_err_set(2u); cpu->EAX = 0xFFFFFFFFu; return; }
    if (sid == -2) { fs_err_set(18u); cpu->EAX = 0xFFFFFFFFu; return; }
    fs_find_fill_w(findbuf, &g_fs[g_find_ids[sid][0]]);
    fs_err_set(0);
    cpu->EAX = FIND_TOKEN((uint32_t)sid);
}

void imp_kernel32__FindNextFileW(CpuState *restrict cpu) {
    uint32_t h = isaac_arg(cpu, 0), findbuf = isaac_arg(cpu, 1);
    uint32_t sid = h - FIND_TOKEN(0);
    if (sid >= FS_FIND_RG || !g_find_used[sid]) { fs_err_set(6u); cpu->EAX = 0; return; }
    uint32_t c = g_find_cur[sid] + 1;
    if (c >= g_find_n[sid]) { fs_err_set(18u); cpu->EAX = 0; return; }
    g_find_cur[sid] = c;
    fs_find_fill_w(findbuf, &g_fs[g_find_ids[sid][c]]);
    fs_err_set(0);
    cpu->EAX = 1;
}

/* ---- stdio FILE family -------------------------------------------------- */
static int fs_token_module(uint32_t v) { return v; }   /* _fileno passthrough */

static uint32_t fs_tok_to_idx(uint32_t tok) {
    if (tok < FILE_TOKEN(0)) return 0xFFFFFFFFu;
    uint32_t i = tok - FILE_TOKEN(0);
    if (i >= FS_FILE_RG || !g_file_used[i]) return 0xFFFFFFFFu;
    return i;
}

static fs_entry *fs_file_entry(uint32_t idx) {
    uint32_t ei = g_file_idx[idx];
    if (ei >= FS_SLOTS) return NULL;
    fs_materialise(&g_fs[ei]);                /* lazy bytes arrive on first use */
    return &g_fs[ei];
}

void imp_api_ms_win_crt_stdio__fopen(CpuState *restrict cpu) {
    char p[512], key[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "fopen");
    if (!fs_key(p, key, sizeof key)) { isaac_w32(ERRNO_CELL_VA, 2u); cpu->EAX = 0; return; }
    /* empty key (root) is never a file */
    if (!key[0]) { isaac_w32(ERRNO_CELL_VA, 2u); cpu->EAX = 0; return; }
    char mode[16];
    (void)isaac_guest_cstr(isaac_arg(cpu, 1), mode, sizeof mode, "fopen mode");
    fs_entry *e = fs_find(key);
    if (fs_trace())
        isaac_log("[isaac][fs] fopen('%s') key='%s' -> %s", p, key,
                  e ? (e->is_dir ? "DIR" : "hit") : "MISS");
    int reading = 0, writing = 0, append = 0;
    for (const char *m = mode; *m; ++m) {
        char c = *m;
        if (c == 'r') reading = 1;
        else if (c == 'w') writing = 1;
        else if (c == 'a') { writing = 1; append = 1; }
        else if (c == '+') { writing = 1; reading = 1; }
    }
    (void)reading; (void)fs_token_module;
    if (!e && writing) {
        e = fs_new(key, 0);
        if (!e) { isaac_w32(ERRNO_CELL_VA, 13u); cpu->EAX = 0; return; }
    }
    if (!e || e->is_dir) { isaac_w32(ERRNO_CELL_VA, 2u); cpu->EAX = 0; return; }
    uint32_t fi = 0xFFFFFFFFu;
    for (unsigned i = 0; i < FS_FILE_RG; ++i) if (!g_file_used[i]) { fi = i; break; }
    if (fi == 0xFFFFFFFFu) { isaac_w32(ERRNO_CELL_VA, 24u); cpu->EAX = 0; return; } /* EMFILE */
    if (writing && !append) e->size = 0;        /* "w": truncate */
    g_file_used[fi] = 1; g_file_idx[fi] = (uint32_t)(e - g_fs);
    g_file_pos[fi] = append ? e->size : 0;
    g_file_w[fi] = (uint8_t)(writing ? 1 : 0);
    g_file_app[fi] = (uint8_t)(append ? 1 : 0);
    uint32_t fp = fs_iobuf_alloc(FILE_TOKEN(fi));
    if (!fp) { g_file_used[fi] = 0; isaac_w32(ERRNO_CELL_VA, 12u); cpu->EAX = 0; return; }
    cpu->EAX = fp;
}

void imp_api_ms_win_crt_stdio__fclose(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0);
    if (!fp) { cpu->EAX = 0; return; }
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi != 0xFFFFFFFFu) {
        if (g_file_w[fi]) fs_persist(fs_file_entry(fi));   /* round 31: a written file reaches the host store */
        g_file_used[fi] = 0;
    }
    isaac_guest_free(fp);
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio__fflush(CpuState *restrict cpu) {
    (void)cpu;
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio__fread(CpuState *restrict cpu) {
    uint32_t dst = isaac_arg(cpu, 0), sz = isaac_arg(cpu, 1),
             nm = isaac_arg(cpu, 2), fp = isaac_arg(cpu, 3);
    uint64_t want = (uint64_t)sz * nm;
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    uint32_t got = 0;
    if (fi != 0xFFFFFFFFu) {
        fs_entry *e = fs_file_entry(fi);
        uint64_t pos = g_file_pos[fi];
        uint64_t avail = (pos < e->size) ? e->size - pos : 0;
        got = (uint32_t)(avail < want ? avail : want);
        if (got) {
            if (e->windowed) got = fs_window_read(e, pos, got, (uint8_t *)isaac_g(dst));
            else memcpy(isaac_g(dst), e->data + (size_t)pos, got);
            g_file_pos[fi] = pos + got;
        }
    }
    /* ISAAC_FS_READ_TRACE=<substring>: log the reads of the files whose key
     * contains it, with offset and length. The open trace alone cannot tell a
     * file that is merely opened from one whose payload is actually pulled --
     * round 16 needed to know which of those the game does to sfx.a. */
    {
        static const char *pat = (const char *)1;
        if (pat == (const char *)1) pat = getenv("ISAAC_FS_READ_TRACE");
        if (pat && *pat && fi != 0xFFFFFFFFu) {
            fs_entry *e = fs_file_entry(fi);
            if (e && strstr(e->key, pat))
                isaac_log("[isaac][fs] fread('%s') off=%llu want=%llu got=%u",
                          e->key, (unsigned long long)(g_file_pos[fi] - got),
                          (unsigned long long)want, got);
        }
    }
    cpu->EAX = sz ? got / sz : 0;
}

void imp_api_ms_win_crt_stdio__fwrite(CpuState *restrict cpu) {
    uint32_t src = isaac_arg(cpu, 0), sz = isaac_arg(cpu, 1),
             nm = isaac_arg(cpu, 2), fp = isaac_arg(cpu, 3);
    uint64_t want = (uint64_t)sz * nm;
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    uint32_t got = 0;
    if (fi != 0xFFFFFFFFu && g_file_w[fi] && fs_file_entry(fi)->windowed) {
        isaac_log("[isaac][fs] fwrite to the windowed file '%s': refused (archives are read-only here)",
                  fs_file_entry(fi)->key);
        fi = 0xFFFFFFFFu;
    }
    if (fi != 0xFFFFFFFFu && g_file_w[fi]) {
        fs_entry *e = fs_file_entry(fi);
        uint64_t pos = g_file_pos[fi], end = pos + want;
        if (end > e->cap) {
            uint64_t ncap = end + 4096u;
            uint8_t *nd = realloc(e->data, (size_t)ncap);
            if (!nd) { cpu->EAX = 0; return; }
            e->data = nd; e->cap = (uint32_t)ncap;
        }
        if (end > e->size) e->size = (uint32_t)end;
        memcpy(e->data + (size_t)pos, isaac_g(src), (size_t)want);
        g_file_pos[fi] = end;
        got = (uint32_t)nm;
    }
    cpu->EAX = sz ? got : 0;
}

void imp_api_ms_win_crt_stdio__fgetc(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    int c = -1;
    if (fi != 0xFFFFFFFFu) {
        fs_entry *e = fs_file_entry(fi);
        if (g_file_pos[fi] < e->size) {
            if (e->windowed) {
                uint8_t b = 0;
                c = fs_window_read(e, g_file_pos[fi], 1u, &b) == 1u ? (int)b : -1;
            } else {
                c = e->data[(size_t)g_file_pos[fi]];
            }
            ++g_file_pos[fi];
        }
    }
    cpu->EAX = (uint32_t)c;
}

void imp_api_ms_win_crt_stdio__fputc(CpuState *restrict cpu) {
    uint32_t ch = isaac_arg(cpu, 0), fp = isaac_arg(cpu, 1);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi == 0xFFFFFFFFu || !g_file_w[fi]) { cpu->EAX = 0xFFFFFFFFu; return; }
    fs_entry *e = fs_file_entry(fi);
    uint64_t pos = g_file_pos[fi];
    if (e->windowed) { cpu->EAX = 0xFFFFFFFFu; return; }   /* archives are read-only here */
    if (pos + 1 > e->cap) {
        uint64_t ncap = pos + 4096u;
        uint8_t *nd = realloc(e->data, (size_t)ncap);
        if (!nd) { cpu->EAX = 0xFFFFFFFFu; return; }
        e->data = nd; e->cap = (uint32_t)ncap;
    }
    e->data[(size_t)pos] = (uint8_t)ch;
    if (pos + 1 > e->size) e->size = (uint32_t)(pos + 1);
    ++g_file_pos[fi];
    cpu->EAX = ch;
}

void imp_api_ms_win_crt_stdio__ungetc(CpuState *restrict cpu) {
    (void)isaac_arg(cpu, 0);
    uint32_t fp = isaac_arg(cpu, 1);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi != 0xFFFFFFFFu && g_file_pos[fi] > 0) --g_file_pos[fi];
    cpu->EAX = (uint32_t)-1;
}

void imp_api_ms_win_crt_stdio__fseek(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0);
    int32_t off = (int32_t)isaac_arg(cpu, 1);
    uint32_t whence = isaac_arg(cpu, 2);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi == 0xFFFFFFFFu) { cpu->EAX = (uint32_t)-1; return; }
    fs_entry *e = fs_file_entry(fi);
    int64_t base = 0;
    if (whence == 1) base = (int64_t)g_file_pos[fi];
    else if (whence == 2) base = (int64_t)e->size;
    int64_t np = base + off;
    if (np < 0) { cpu->EAX = (uint32_t)-1; return; }
    g_file_pos[fi] = (uint64_t)np;
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio___fseeki64(CpuState *restrict cpu) {
    /* _fseeki64(fp, __int64 off, int whence): off = edx:eax pair */
    uint32_t fp = isaac_arg(cpu, 0), lo = isaac_arg(cpu, 1), hi = isaac_arg(cpu, 2);
    uint32_t whence = isaac_arg(cpu, 3);
    int64_t off = (int64_t)((uint64_t)lo | ((uint64_t)hi << 32));
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi == 0xFFFFFFFFu) { cpu->EAX = (uint32_t)-1; return; }
    fs_entry *e = fs_file_entry(fi);
    int64_t base = 0;
    if (whence == 1) base = (int64_t)g_file_pos[fi];
    else if (whence == 2) base = (int64_t)e->size;
    int64_t np = base + off;
    if (np < 0) { cpu->EAX = (uint32_t)-1; return; }
    g_file_pos[fi] = (uint64_t)np;
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio__ftell(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    cpu->EAX = (fi == 0xFFFFFFFFu) ? 0xFFFFFFFFu : (uint32_t)g_file_pos[fi];
    cpu->EDX = 0;
}

void imp_api_ms_win_crt_stdio__fgetpos(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0), ppos = isaac_arg(cpu, 1);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi == 0xFFFFFFFFu) { cpu->EAX = (uint32_t)-1; return; }
    uint64_t v = g_file_pos[fi];
    isaac_w32(ppos, (uint32_t)v);
    isaac_w32(ppos + 4, (uint32_t)(v >> 32));
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio__fsetpos(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0), ppos = isaac_arg(cpu, 1);
    uint32_t tok = isaac_r32(fp + 0x10u);
    uint32_t fi = fs_tok_to_idx(tok);
    if (fi == 0xFFFFFFFFu) { cpu->EAX = (uint32_t)-1; return; }
    uint64_t v = (uint64_t)isaac_r32(ppos) | ((uint64_t)isaac_r32(ppos + 4) << 32);
    fs_entry *e = fs_file_entry(fi);
    if (v > e->size) { cpu->EAX = (uint32_t)-1; return; }
    g_file_pos[fi] = v;
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio__setvbuf(CpuState *restrict cpu) {
    (void)cpu;
    cpu->EAX = 0;
}

void imp_api_ms_win_crt_stdio___fileno(CpuState *restrict cpu) {
    uint32_t fp = isaac_arg(cpu, 0);
    cpu->EAX = fp ? isaac_r32(fp + 0x10u) : (uint32_t)-1;
}

void imp_api_ms_win_crt_stdio___get_osfhandle(CpuState *restrict cpu) {
    cpu->EAX = isaac_arg(cpu, 0);               /* token doubles as the HANDLE */
}

void imp_api_ms_win_crt_filesystem___lock_file(CpuState *restrict cpu) {
    (void)cpu;
}
void imp_api_ms_win_crt_filesystem___unlock_file(CpuState *restrict cpu) {
    (void)cpu;
}

void imp_api_ms_win_crt_filesystem__remove(CpuState *restrict cpu) {
    char p[512], key[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), p, sizeof p, "remove");
    if (!fs_key(p, key, sizeof key)) { isaac_w32(ERRNO_CELL_VA, 2u); cpu->EAX = (uint32_t)-1; return; }
    fs_entry *e = fs_find(key);
    if (!e || e->is_dir) { isaac_w32(ERRNO_CELL_VA, 2u); cpu->EAX = (uint32_t)-1; return; }
    fs_unpersist(e);
    fs_free_entry(e);
    isaac_w32(ERRNO_CELL_VA, 0);
    cpu->EAX = 0;
}

void imp_kernel32__MoveFileExA(CpuState *restrict cpu) {
    char a[512], b[512], ka[256], kb[256];
    (void)isaac_guest_cstr(isaac_arg(cpu, 0), a, sizeof a, "MoveFileExA");
    (void)isaac_guest_cstr(isaac_arg(cpu, 1), b, sizeof b, "MoveFileExA");
    (void)isaac_arg(cpu, 2);
    if (!fs_key(a, ka, sizeof ka) || !fs_key(b, kb, sizeof kb)) { cpu->EAX = 0; return; }
    fs_entry *e = fs_find(ka);
    if (!e) { fs_err_set(2u); cpu->EAX = 0; return; }
    fs_entry *d = fs_find(kb);
    if (d) fs_free_entry(d);
    strncpy(e->key, kb, sizeof e->key - 1);
    e->key[sizeof e->key - 1] = 0;
    fs_err_set(0);
    cpu->EAX = 1;
}

void imp_kernel32__LockFileEx(CpuState *restrict cpu) {
    (void)cpu;
    cpu->EAX = 1;
}
void imp_kernel32__UnlockFileEx(CpuState *restrict cpu) {
    (void)cpu;
    cpu->EAX = 1;
}

void imp_kernel32__GetFileTime(CpuState *restrict cpu) {
    uint32_t f = isaac_arg(cpu, 0), ct = isaac_arg(cpu, 1),
             at = isaac_arg(cpu, 2), wt = isaac_arg(cpu, 3);
    (void)f;
    uint64_t now = (uint64_t)time(NULL) + 11644473600ull;  /* epoch->1601 */
    uint64_t ft = now * 10000000ull;
    if (ct) { isaac_w32(ct, (uint32_t)ft); isaac_w32(ct + 4, (uint32_t)(ft >> 32)); }
    if (at) { isaac_w32(at, (uint32_t)ft); isaac_w32(at + 4, (uint32_t)(ft >> 32)); }
    if (wt) { isaac_w32(wt, (uint32_t)ft); isaac_w32(wt + 4, (uint32_t)(ft >> 32)); }
    cpu->EAX = 1;
}
