// menu_overlay.mjs -- the save-select screen's EDIT FILE menu, drawn by the
// page with the game's own art, font and sounds (page-assets/, see
// scripts/recomp/assets/page_assets.py), driven by the game's own keys.
// Round 52.
//
// The engine's Menu_Save::Update is about to show its "ARE YOU SURE?" prompt
// for the file the cursor is on; the lifted block at 0x9d9d59 asks the host
// gate first, which asks window.isaacEditFile(slot): this module opens the
// menu instead. Its entries: EXPORT FILE, IMPORT FILE, DELETE FILE, BACK.
// The FPS readout is a key, not an entry: N flips it (play.mjs), a corner
// text in the same font, remembered by this browser only. Delete hands the flow back to the engine (the
// page sets window.isaacEditFileDelete and presses confirm again, so the
// game's own prompt and deletion run untouched). Export and import are the
// page's saves store; the fps viewer is a corner readout in the same font.
//
// Drawing: one canvas over the game's, 960x540 (the game's 480x270 at 2x,
// pixelated), the prompt paper crop of the save-select sheet where the
// engine draws its own prompt, the Team Meat 16-bold bitmap font (BMFont v3
// binary, the atlas tinted with the strip's ink), the sheet's cursor, and
// the engine's menu sounds through the page's AudioContext.

const GAME_W = 480, GAME_H = 270, SCALE = 2;

function parseBmfont(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (!(b[0] === 66 && b[1] === 77 && b[2] === 70 && b[3] === 3)) throw new Error('not a BMFont v3 binary');
  const font = { chars: new Map(), kern: new Map(), lineHeight: 0, base: 0, pages: [] };
  let i = 4;
  while (i < b.length) {
    const t = b[i], n = dv.getUint32(i + 1, true), at = i + 5;
    if (t === 2) { font.lineHeight = dv.getUint16(at, true); font.base = dv.getUint16(at + 2, true); }
    else if (t === 4) {
      for (let k = 0; k + 20 <= n; k += 20) {
        const p = at + k;
        font.chars.set(dv.getUint32(p, true), { x: dv.getUint16(p + 4, true), y: dv.getUint16(p + 6, true), w: dv.getUint16(p + 8, true), h: dv.getUint16(p + 10, true),
          xo: dv.getInt16(p + 12, true), yo: dv.getInt16(p + 14, true), xa: dv.getInt16(p + 16, true) });
      }
    } else if (t === 5) {
      for (let k = 0; k + 10 <= n; k += 10) { const p = at + k; font.kern.set(dv.getUint32(p, true) * 4294967296 + dv.getUint32(p + 4, true), dv.getInt16(p + 8, true)); }
    }
    i = at + n;
  }
  return font;
}

function tintAtlas(img, ink) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = `rgb(${ink[0]},${ink[1]},${ink[2]})`;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---- the shared half: the game's own art, font and sounds -------------------
// Both menus below draw with these. opts: { assetsUrl, readAsset(name), log,
// audioContext() }. readAsset (round 70) is how a build with no server hands
// over its own files.
function menuAssets(opts) {
  const { assetsUrl, readAsset } = opts;
  const log = opts.log || (() => {});
  const A = { menu: null, sheet: null, paper: null, cursor: null, font: null, atlas: null, sounds: new Map() };
  const st = { ready: false, loading: null };

  const fetchAsset = async (name, kind) => {
    let blob = null;
    if (readAsset) {
      const bytes = await readAsset(name);
      if (!bytes) throw new Error(`${name}: not in the payload`);
      if (kind === 'json') return JSON.parse(new TextDecoder().decode(bytes));
      if (kind === 'buffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      blob = new Blob([bytes]);
    }
    if (!blob) {
      const r = await fetch(`${assetsUrl}/${name}`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      if (kind === 'json') return r.json();
      if (kind === 'buffer') return r.arrayBuffer();
      blob = await r.blob();
    }
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(`${name}: not an image`)); img.src = URL.createObjectURL(blob); });
    return img;
  };
  const load = () => {
    if (st.loading) return st.loading;
    st.loading = (async () => {
      A.menu = await fetchAsset('menu.json', 'json');
      [A.sheet, A.paper, A.cursor, A.atlasImg] = await Promise.all([
        fetchAsset(A.menu.sheet, 'image'), fetchAsset(A.menu.paper, 'image'), fetchAsset(A.menu.cursor, 'image'), fetchAsset(A.menu.font.png, 'image')]);
      A.font = parseBmfont(await fetchAsset(A.menu.font.fnt, 'buffer'));
      A.atlas = tintAtlas(A.atlasImg, A.menu.colours.ink);
      A.atlasLight = tintAtlas(A.atlasImg, [140, 120, 120]);
      A.atlasWhite = tintAtlas(A.atlasImg, [255, 255, 255]);
      st.ready = true;
      // the sounds decode lazily on the first open (the AudioContext exists once the engine runs)
      const ctx = opts.audioContext && opts.audioContext();
      if (ctx) {
        for (const [role, file] of Object.entries(A.menu.sounds)) {
          try { A.sounds.set(role, await ctx.decodeAudioData(await fetchAsset(file, 'buffer'))); } catch (e) { log(`[menu] sound ${file}: ${e.message}`); }
        }
      }
    })().catch((e) => { log(`[menu] assets: ${e.message}`); st.loading = null; throw e; });
    return st.loading;
  };
  const play = (role) => {
    try {
      const ctx = opts.audioContext && opts.audioContext(), buf = A.sounds.get(role);
      if (!ctx || !buf) return;
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start();
    } catch (e) { /* sound is decoration */ }
  };
  // text in the font at game scale: returns the width drawn (game px)
  const measure = (text) => { let w = 0, prev = null; for (const ch of text) { const c = A.font.chars.get(ch.codePointAt(0)); if (!c) { w += 6; prev = null; continue; } if (prev !== null) w += A.font.kern.get(prev * 4294967296 + ch.codePointAt(0)) || 0; w += c.xa; prev = ch.codePointAt(0); } return w; };
  const drawText = (ctx, text, x, y, atlas) => {
    let cx = x, prev = null;
    for (const ch of text) {
      const cp = ch.codePointAt(0), c = A.font.chars.get(cp);
      if (!c) { cx += 6; prev = null; continue; }
      if (prev !== null) cx += A.font.kern.get(prev * 4294967296 + cp) || 0;
      ctx.drawImage(atlas, c.x, c.y, c.w, c.h, (cx + c.xo) * SCALE, (y + c.yo) * SCALE, c.w * SCALE, c.h * SCALE);
      cx += c.xa; prev = cp;
    }
    return cx - x;
  };
  // a line clipped to a width, with an ellipsis where it was cut
  const clip = (text, width) => {
    if (measure(text) <= width) return text;
    let t = text;
    while (t.length > 1 && measure(t + '...') > width) t = t.slice(0, -1);
    return t + '...';
  };
  const surface = (stage, id, w, h) => {
    const el = document.createElement('canvas');
    el.id = id;
    el.width = w; el.height = h;
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;';
    el.hidden = true;
    stage.appendChild(el);
    const ctx = el.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return { el, ctx };
  };
  return { A, load, play, measure, drawText, clip, surface, isReady: () => st.ready };
}

export function createEditFileMenu(opts) {
  // opts: { stage, canvas, assetsUrl, readAsset(name), audioContext(), actions: { export(slot), import(slot), delete(slot) }, injectKey(name, down), log }
  // readAsset (round 70) is how a build with no server hands over its own files
  const { stage, canvas, assetsUrl, readAsset, actions, injectKey } = opts;
  const log = opts.log || (() => {});
  const state = { open: false, slot: 0, cursor: 0, message: null, fps: null, fpsOn: false, closing: false };
  const M = menuAssets(opts);
  const { A, load, play, measure, drawText } = M;
  // Off on every load. N flips it for this visit only: it used to be remembered,
  // so one press left a readout over the game for good.

  const overlay = document.createElement('canvas');
  overlay.id = 'menu-overlay';
  overlay.width = GAME_W * SCALE; overlay.height = GAME_H * SCALE;
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;';
  overlay.hidden = true;
  stage.appendChild(overlay);
  const g = overlay.getContext('2d');
  g.imageSmoothingEnabled = false;

  const fpsEl = document.createElement('canvas');
  fpsEl.id = 'fps-viewer';
  fpsEl.width = 120 * SCALE; fpsEl.height = 28 * SCALE;
  fpsEl.style.cssText = 'position:absolute;left:1%;top:1.5%;width:12.5%;height:auto;pointer-events:none;image-rendering:pixelated;image-rendering:crisp-edges;';
  fpsEl.hidden = true;
  stage.appendChild(fpsEl);

  // MODS is here because the import row in the game's own list is a mod, and a
  // mod loaded makes the run a modded one. This menu is the page's already.
  const items = () => (actions.mods ? ['EXPORT FILE', 'IMPORT FILE', 'DELETE FILE', 'MODS', 'BACK']
                                    : ['EXPORT FILE', 'IMPORT FILE', 'DELETE FILE', 'BACK']);
  // the FPS readout is a key, not a setting: N flips it (play.mjs), this browser remembers it
  const toggleFps = () => {
    state.fpsOn = !state.fpsOn;
    fpsEl.hidden = !state.fpsOn;
    if (state.fpsOn && !M.isReady()) load().then(() => { fpsEl.hidden = !state.fpsOn; drawFps(); }).catch(() => {});
    else if (state.fpsOn) drawFps();
    return state.fpsOn;
  };
  const draw = () => {
    if (!state.open || !M.isReady()) return;
    const R = A.menu.rects, [px0, py0] = R.prompt_at, [sx, sy, sw, sh0] = R.prompt_paper;
    // the seed paper (blank) where the engine draws its own prompt, the prompt
    // paper's width and taller by however many entries there are: a title, the
    // rows at lineH, and room under them for the message
    const sh = sh0 + 24 + (items().length - 4) * 17, px = px0, py = py0 - 12;
    g.clearRect(0, 0, overlay.width, overlay.height);
    g.drawImage(A.paper, 0, 0, A.paper.width, A.paper.height, px * SCALE, py * SCALE, sw * SCALE, sh * SCALE);
    const title = `FILE ${state.slot + 1}`;
    drawText(g, title, px + (sw - measure(title)) / 2, py + 10, A.atlas);
    const list = items();
    const lineH = 17, top = py + 40;
    list.forEach((label, i) => {
      const y = top + i * lineH, w = measure(label), x = px + (sw - w) / 2;
      drawText(g, label, x, y, i === state.cursor ? A.atlas : A.atlasLight);
      if (i === state.cursor) {
        const [cx, cy, cw, ch] = R.cursor;
        g.drawImage(A.sheet, cx, cy, cw, ch, (x - cw - 4) * SCALE, (y - 4) * SCALE, cw * SCALE, ch * SCALE);
      }
    });
    if (state.message) drawText(g, state.message, px + (sw - measure(state.message)) / 2, py + sh - 24, A.atlas);
  };
  const drawFps = () => {
    if (!M.isReady()) return;
    const gg = fpsEl.getContext('2d');
    gg.imageSmoothingEnabled = false;
    gg.clearRect(0, 0, fpsEl.width, fpsEl.height);
    if (state.fps == null) return;
    // just the number, white, in the game's font, a dark shadow a pixel down-right for the light rooms
    const text = `${Math.round(state.fps)}`;
    drawText(gg, text, 3, 3, A.atlas);
    drawText(gg, text, 2, 2, A.atlasWhite);
  };

  const open = async (slot) => {
    if (state.open) return;
    state.slot = slot; state.cursor = 0; state.message = null; state.open = true; state.closing = false;
    try { await load(); } catch (e) { state.open = false; return; }
    if (!state.open) return;
    overlay.hidden = false;
    play('open');
    draw();
    log(`[menu] EDIT FILE open for file ${slot + 1}`);
  };
  const close = (sound) => {
    if (!state.open) return;
    state.open = false; overlay.hidden = true;
    if (sound) play(sound);
    log('[menu] EDIT FILE closed');
  };
  const select = async () => {
    const i = state.cursor, rows = items();
    if (rows[i] === 'BACK') { close('back'); return; }
    if (rows[i] === 'MODS') { play('select'); close(null); actions.mods(); return; }
    if (i === 2) {
      // the engine's own prompt: the gate lets the transition through when the
      // page has named the slot, and the confirm is pressed for the player
      play('delete');
      close(null);
      window.isaacEditFileDelete = state.slot;
      injectKey('enter', true);
      setTimeout(() => injectKey('enter', false), 80);
      return;
    }
    play('select');
    state.message = i === 0 ? 'EXPORTING...' : 'CHOOSE A FILE...';
    log(`[menu] ${items()[i]} for file ${state.slot + 1}`);
    draw();
    try {
      const r = await (i === 0 ? actions.export(state.slot) : actions.import(state.slot));
      state.message = r || (i === 0 ? 'EXPORTED' : 'IMPORTED');
    } catch (e) { state.message = (e && e.message ? e.message : 'FAILED').toUpperCase().slice(0, 28); }
    log(`[menu] ${state.message}`);
    draw();
  };
  const onKey = (ev, down) => {
    if (!state.open) return false;
    // key-ups always reach the engine: the confirm that opened this menu went
    // down in the engine's eyes, and its release must follow (a held confirm
    // would swallow the press the Delete entry makes for the player)
    if (!down) return false;
    const code = ev.code;
    if (code === 'ArrowUp' || code === 'KeyW') { state.cursor = (state.cursor + items().length - 1) % items().length; play('move'); draw(); }
    else if (code === 'ArrowDown' || code === 'KeyS') { state.cursor = (state.cursor + 1) % items().length; play('move'); draw(); }
    else if (code === 'Enter' || code === 'Space' || code === 'KeyE') { select(); }
    else if (code === 'Escape' || code === 'Backspace') { close('back'); }
    return true;
  };

  return {
    open, close, onKey, draw, toggleFps,
    isOpen: () => state.open,
    message: () => state.message,
    fpsViewer: () => state.fpsOn,
    // what the menu is showing, so a driver can walk to a row by name rather
    // than by counting presses (the entries are not always the same four)
    rows: () => items(),
    current: () => items()[state.cursor] || null,
    setFps: (fps) => { state.fps = fps; if (state.fpsOn) { if (!M.isReady()) load().then(() => { fpsEl.hidden = false; drawFps(); }).catch(() => {}); else { fpsEl.hidden = false; drawFps(); } } },
    preload: load,
    element: overlay,
  };
}

// ---- a paper menu of arbitrary rows (round 76) --------------------------------
// The mods menus use this. opts: { stage, assetsUrl, readAsset, audioContext,
// log }. open(model, { onKey }) takes a function returning the model, so the
// caller can change what it shows and call redraw().
export function createPaperMenu(opts) {
  const M = menuAssets(opts);
  const { A, load, play, measure, drawText, clip } = M;
  const log = opts.log || (() => {});
  const { el: overlay, ctx: g } = M.surface(opts.stage, 'paper-menu', GAME_W * SCALE, GAME_H * SCALE);
  const st = { open: false, cursor: 0, top: 0, model: null, get: null, onKey: null };

  // Everything below is in game pixels (480x270) and comes off the font: a row
  // is one line of it, and the panel is the header, the rows and the two lines
  // under them. PAD is the paper's own torn margin, which nothing is drawn in.
  // The paper is a torn sheet with a soft edge, so the margin the text keeps is
  // wider than the rect it is drawn into -- SIDE at the sides, TAIL under the
  // last line, both found by looking at it.
  // Round 84: the sheet is torn, and its right corner is torn further in than its
  // left, so anything right-aligned to SIDE sat on the tear or past it -- the
  // browser's "3/33" was drawn outside the paper entirely. RIGHT is the margin
  // that side keeps; it is wider than SIDE by exactly what the tear takes.
  const PANEL_W = 392, PAD = 16, SIDE = 26, RIGHT = 46, TAIL = 30, MAX_ROWS = 7;
  const metrics = () => {
    const lh = Math.max(12, (A.font && A.font.lineHeight) || 16);
    const head = PAD + lh + 4;
    const foot = lh * 2 + TAIL;
    return { lh, head, foot };
  };
  const rowsOf = () => (st.model && st.model.rows) || [];
  const visible = () => {
    const { lh } = metrics();
    return Math.max(1, Math.min(MAX_ROWS, rowsOf().length, Math.floor((GAME_H - 24 - metrics().head - metrics().foot) / lh)));
  };

  const draw = () => {
    if (!st.open || !M.isReady()) return;
    const rows = rowsOf(), { lh, head, foot } = metrics();
    const hasSearch = !!(st.model && st.model.search !== undefined && st.model.search !== null);
    const span = visible();
    const panelH = head + (hasSearch ? lh : 0) + span * lh + foot + PAD;
    const px = Math.round((GAME_W - PANEL_W) / 2), py = Math.round((GAME_H - panelH) / 2);
    g.clearRect(0, 0, overlay.width, overlay.height);
    g.drawImage(A.paper, 0, 0, A.paper.width, A.paper.height, px * SCALE, py * SCALE, PANEL_W * SCALE, panelH * SCALE);

    const title = (st.model && st.model.title) || '';
    drawText(g, title, px + (PANEL_W - measure(title)) / 2, py + PAD, A.atlas);
    // Round 84: there was a "3/33" up here beside the title. The sheet's top-right
    // corner is torn away, so it was drawn on nothing and read as a number
    // floating outside the menu -- and the list already says how long it is on the
    // line at the bottom.
    const n = rows.length;

    let top = py + head;
    if (hasSearch) {
      const q = st.model.search ? `> ${st.model.search}` : `> ${st.model.searchHint || ''}`;
      drawText(g, clip(q, PANEL_W - SIDE * 2), px + SIDE, top, st.model.search ? A.atlas : A.atlasLight);
      top += lh;
    }
    // the window of rows around the cursor
    if (st.cursor < st.top) st.top = st.cursor;
    if (st.cursor >= st.top + span) st.top = st.cursor - span + 1;
    if (st.top > Math.max(0, n - span)) st.top = Math.max(0, n - span);
    if (st.top < 0) st.top = 0;
    const [cx, cy, cw, ch] = A.menu.rects.cursor;
    const textX = px + SIDE + 10;
    for (let i = st.top; i < Math.min(n, st.top + span); i++) {
      const row = rows[i], y = top + (i - st.top) * lh;
      const noteW = row.note ? measure(row.note) : 0;
      const label = clip(row.label, PANEL_W - SIDE - RIGHT - 14 - (noteW ? noteW + 10 : 0));
      drawText(g, label, textX, y, i === st.cursor ? A.atlas : (row.dim ? A.atlasLight : A.atlas));
      if (row.note) drawText(g, row.note, px + PANEL_W - RIGHT - noteW, y, A.atlasLight);
      if (i === st.cursor) g.drawImage(A.sheet, cx, cy, cw, ch, (textX - cw - 3) * SCALE, (y + (lh - ch) / 2 - 2) * SCALE, cw * SCALE, ch * SCALE);
    }
    const msg = st.model && st.model.message;
    const footY = py + panelH - TAIL - lh;
    if (msg) drawText(g, clip(msg, PANEL_W - SIDE * 2), px + SIDE, footY - lh, A.atlas);
    const hint = st.model && st.model.footer;
    if (hint) drawText(g, clip(hint, PANEL_W - SIDE * 2), px + SIDE, footY, A.atlasLight);
  };

  const redraw = () => { st.model = st.get ? st.get() : st.model; draw(); };

  const open = async (get, o) => {
    st.get = get; st.onKey = (o && o.onKey) || null; st.onClose = (o && o.onClose) || null;
    st.cursor = 0; st.top = 0; st.model = null;
    // The art is fetched, and on a served page that takes long enough for a key
    // to arrive in between. Nothing calls itself open until it has rows to show:
    // a keypress in the gap would have found an empty list and done nothing.
    try { await load(); } catch (e) { log(`[mods] the menu art: ${e.message}`); return; }
    st.open = true;
    overlay.hidden = false;
    play('open');
    redraw();
  };
  const close = (sound) => {
    if (!st.open) return;
    st.open = false; overlay.hidden = true;
    if (sound) play(sound);
    if (st.onClose) st.onClose();
  };
  const onKey = (ev, down) => {
    if (!st.open) return false;
    if (!down) return true;                      // the menu owns the keys while it is up
    if (!st.model) return true;                  // drawn but not yet filled: swallow, do not guess
    const rows = rowsOf(), n = rows.length;
    const code = ev.code;
    if (st.onKey && st.onKey(code, ev.key)) return true;
    if (code === 'ArrowUp' || code === 'KeyW') { if (n) { st.cursor = (st.cursor + n - 1) % n; play('move'); redraw(); } }
    else if (code === 'ArrowDown' || code === 'KeyS') { if (n) { st.cursor = (st.cursor + 1) % n; play('move'); redraw(); } }
    else if (code === 'Enter' || code === 'Space') {
      const row = rows[st.cursor];
      if (row && row.action) { play('select'); Promise.resolve(row.action()).then(redraw, redraw); }
    } else if (code === 'Escape' || code === 'Backspace') { close('back'); }
    return true;
  };
  return {
    open, close, onKey, redraw,
    isOpen: () => st.open,
    currentRow: () => rowsOf()[st.cursor] || null,
    cursor: () => st.cursor,
    element: () => overlay,
    preload: load,
  };
}
