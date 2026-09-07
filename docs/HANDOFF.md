# Handoff — read this first (2026-09-06, recomp rounds 26-86c: fixes, video, bundle, automated player, console, saves, music, the Chromebook budget, portable builds, mods, the giant functions split, below the cap)

One page to orient a fresh session. Everything below is committed on
`codex/decomp`. Do the two session-start steps in AGENTS.md, then pick a front.

## Orient in two commands

```
node scripts/decomp/status.mjs          # live family ABIs, open boundaries, verification freshness, tree-consistency ERRORS/WARNINGS
node scripts/decomp/brief.mjs <VA|idx>  # one-call orientation for a specific Update boundary (+ live-bridge lane delivery)
```

If status prints an **ERRORS** block, the tree holds somebody's unfinished
unit (stranded mutant, JSON drift, header/model ABI skew) — repair that
before anything else; the unit gate refuses such a tree.

Censuses go through the prebuilt PE index — never hand-roll a decoder:
`python scripts/decomp/tools/pequery.py batch "body 0x.. ;; callers 0x.. ;; writers 0x.. ;; fieldrefs 0x<disp> 0x<func>"`
(`npm run decomp:index`, ≈50 s; decode config **v2** carries the object-field
`fld` table). The whole unit gate is `node scripts/decomp/verify-unit.mjs`
(preflight → slice build → everything in parallel; `--handoff` adds strict
preflight + `npm test`; sets up the emsdk env itself). Standalone suites still
REQUIRE emsdk on PATH:
`export EMSDK=$HOME/emsdk; export PATH=$HOME/emsdk:$HOME/emsdk/upstream/emscripten:$PATH`.

## Verified state at handoff

- Update slice **ABI 101** (idx-3 leaf-5 `0x74f090` fold landed; count still
  24 open / 27 resolved). `decomp:verify-slice` differential **5392 cases
  pass**, `leaf5=2p/4h` (both 0x74f090 verdicts exercised), 210 s.
- Slice suite **864/864**; `npm test` **3923/3923** (warm ~84 s).
- Tree consistency (`verify-unit.mjs --preflight`) clean: no literal ABI pins
  in any suite, JSON canonical and in sync with the model layout, no
  stranded mutants.
- recomp host selftest **130/0**, `tests/recomp-host.test.js` **35/35**
  (two new pins: vbase-ctor purges + `PURGE_PATCHES` vs the shim table;
  every `missing_fns.c` body pops its return address); boot module relinks
  clean at `-O0` (~2.5 min host-only; `--opt-link` for shipping).
- Boot (from the instance dir) seeds the whole extracted instance tree
  (11,197 files, 243 MB) + 6 small archives, parses `players.xml` and the
  other xml tables, loads every UI anm2, prints `Viewport: 960x540` and the
  framebuffer/window metrics, and enters mods-init. **It then plays**: a
  scripted run reaches a Basement and walks between rooms; one 30-minute
  soak presented **142,680 frames (79 fps)**, 1.12 billion dispatches, 0
  misses, no stall. **That run was lucky**: two later runs both hung
  shortly after the first room containing enemies, once after the game's
  own `CellSpace::insert: x1 > x2` assertion and once in an entity-trail
  ring-buffer loop at `0x00942c0e` whose capacity field is zero
  (§21.32). That is the next unit of work. See front B below.
- **Audio runs end to end, in node and in the browser** (§21.39,
  2026-09-04): with the DLC archives mounted, the `resources/` root back
  and the sound-source open un-patched, a 240-s debug-profile node run
  uploads **92 PCM buffers (5.7 MB, 33.8 s of audio), plays 17,
  queues/unqueues 85/61 music stream buffers**, peaks at 354 MiB of guest
  heap and exits clean after 3,540 frames; the fast browser module under
  headless Chromium uploads **329 buffers (42 MB, 385 s of audio), plays
  102**, WebAudio context running, **1,501 frames in 67.6 s wall**. The
  boot spends ~65 s (debug profile) mounting 1.2 GB of archives through
  the windowed reader before the first real frame.
- The browser build is **interactive** (§21.39 round 25): JSPI, live
  keyboard/mouse, 41 fps overall / 49-59 in play under headless Chromium;
  `drive_interactive.mjs` reaches a run with held Enters and walks (§21.40).
- **Round 26**: the mount no longer checksums every archive entry
  (`ISAAC_ARCHIVE_VERIFY=1` restores it): the debug boot's second frame at
  2.9 s instead of 65 s, the browser's 1,500 frames in 48.7 s instead of
  67.6. **Video plays** (`ISAAC_CUTSCENE`, the Epilogue's `.ogv` decoded,
  shown and finished; twelve SSE intrinsics implemented and oracle-checked).
  The archive toolchain (`scripts/recomp/assets/`) reverses all three
  container versions with a 27,236/27,236 checksum proof; lossless PNG and
  Vorbis q3 music shrink the mounted set 1,070 → 750 MB, validated in-engine.
  The raw string-table keys (`#BASEMENT_NAME`) turned out to be the
  entry-first lifter bug (§21.41), fixed the same day: the banner reads
  "Basement".
- **Round 28: the shipping bundle** (§21.43, 2026-09-04). `.scratch/game-bundle`
  is **733,800,939 bytes in 22 files, 37.87 % of the 1,937,711,471-byte
  instance**: the ten archives the engine mounts (1,069,689,641 →
  733,456,838 bytes: lossless PNG, music at Vorbis **q4** -- q3 is 9.8 %
  smaller, outside the 5 % rule -- and the 2,453 entries a later mount
  shadows dropped, last-mount-wins read off the 0x00a17dc1 insert), the Lua
  under `resources/scripts` and `savedatapath.txt`. Dropped by census
  (`ISAAC_FS_TRACE=1` + a host-level fs hook + `run_web.mjs`'s new
  `served_files.json`): `repentance.a`, the 11 language packs, the loose tree
  (read 0 times), the executables and run-time state. Built and checked by
  `scripts/recomp/assets/bundle.py` (manifest `.bundle.json` with sha256s;
  `tests/recomp-bundle.test.js` 5/5). **Proven from the bundle**: node
  timeline (Basement, 3,000 frames, 0 asserts, 39 PCM uploads / 11 plays),
  node cutscene (the Epilogue `finished playing`), browser (3,001 frames,
  Basement, 314 uploads / 14 plays, 76.8 s wall) -- and the engine's own log
  is line-for-line identical to the pre-bundle run (523/523, 750/750).
  The fast browser module itself is 50,769,868 bytes (code section 49.2 MB,
  name section 0.4 MB) and **11,341,999 bytes gzipped** -- serve it with
  `Content-Encoding` and it is 1.5 % of the bundle.
- **Round 27 (2026-09-04, §21.42): the fast profile's dispatch census had
  a wrong name on its top entry.** The four 17.75 M-dispatch fragments were
  not the CRT memcpy (a vcruntime import) but the `switch (i & 3)` cases
  of Bob Jenkins' `isaac()` -- the v2 archive keystream refill, 256
  dispatches per call, 71 M of 93 M. Nine exact host wrappers
  (`host_fastpath.c`, `WRAP_PATCHES`): `isaac()`, the keystream XOR,
  `ArchivedFile::read`'s window path, `Mutex::Lock/Unlock`, the handle
  `AddRef/TryAddRef/Release` and the owner check. **Verified: 16,169,397
  calls compared, 0 mismatches** (`ISAAC_FASTPATH_VERIFY=1`; the stub
  report now prints a per-wrapper census). Dispatches **92.55 M -> 11.25 M**;
  on one module, A/B medians of three pairs: boot to frame 3 **4,615 ->
  2,913 ms**, steady gameplay 30 -> 27 ms per 60 frames, whole module run
  **10,979 -> 9,597 ms**; the floor-load window alone is 0.7 s slower
  (§21.42 says what was tested: with V8 tier-up off the host wins every
  phase, 11,137 -> 8,938 ms, so it is the compiler's timing). Browser
  (`web-r27`, fast module, headless Chromium): 3,000 frames, Basement,
  `main` 0, 0 asserts, WebAudio running, 77.4 s including the archive
  fetch -- GL-bound at ~50 fps in play, as before. `node --test
  tests/recomp-*.test.js` **122/122**; selftest **229/0** (seven mutants
  killed through `mutate.mjs`).
- **Everything together** (2026-09-04): the automated player on the fast
  profile with the round-27 fastpaths, booted from the shipping bundle
  (`ISAAC_INSTANCE_DIR=.scratch/game-bundle`), 20,000 frames: the same
  census as the debug profile on the original instance (8 rooms incl. a
  Lust miniboss room, 11 transitions, 5 runs, 4 deaths, 3 pickups), 0
  asserts, 0 raw string keys, **0 fastpath mismatches**, 1,694 PCM uploads /
  1,518 plays, 61 M dispatches (200 M before the fastpaths), main 0.
- **Round 30 (2026-09-04, §21.45): a floor descent and a boss through the
  game's own debug console.** `ISAAC_CONSOLE="cmd1;cmd2"` on the node
  driver seeds `options.ini` (`EnableDebugConsole=1`, `SaveCommandHistory=1`,
  `VSync=0` -- with a file present `OptionsConfig::SetVSync(1)` asks for a
  monitor the headless host has not got) and `cmd_history.txt` into the
  RAM-FS only, opens the console with the grave key (GLFW key 0x60) once the
  explorer's run has started, recalls each command from the history with
  UP -- typed characters cannot reach it: the console reads text through
  GLFW's char callback, i.e. WM_CHAR, which the host never builds
  (`TranslateMessage` is a stub); a host change of one of two shapes is
  written up in §21.45 -- verifies the input line's text in guest memory,
  Enter, and closes. Debug profile, epoch 1700000000: `stage 2` ran at
  frame 488 (`Level::Init m_Stage 2, m_StageType 0 Seed 1037090446` that
  frame; the explorer's room list reset to Basement II, three rooms walked,
  3,000 frames, 0 asserts); `debug 3; debug 4; goto s.boss.1010` put the
  explorer in **`Room 5.1010(Monstro)`** (room -3, `bosses 1`, the NPC
  census reading `t20.0` at the centre), 295 frames of hunting later
  **`TriggerBossDeath: 0 bosses remaining`**, the boss item `5.100.659`
  spawned, the door reopened, 4,000 frames, 0 asserts, main 0. **No trapdoor
  in a `goto`'d boss room by the engine's own rule** (Room::Update's clear
  path branches on room index -3; the trapdoor spawns belong to the floor's
  real boss room). The explorer now knows the floor, the room config's
  type/variant, the live-boss counter, the trapdoor's vtable in the grid
  (it walks onto one it sees) and suspend/resume; `tests/recomp-console.test.js`
  (9) + four explorer tests. Both runs went quiet for **474 s at the music
  restart** (frames 360-420; the first boss attempt sat >10 min there and
  was killed): round 14j's node-on-Windows heap class, not the game.
- **Round 31: saves persist** (§21.46). A file the game writes reaches the
  host when it is closed: `ISAAC_SAVE_DIR=<dir>` on the node driver keeps
  the `persistentgamedata*.dat` as real files and seeds them back at the
  next boot; the browser page keeps them in IndexedDB and restores them
  before main (`persist=0` turns it off; `drive_persist.mjs` proves a
  reload restores them). Node: two boots of the automated player (6,000 frames, epoch 1700000000, fast profile): boot 1 persisted 36 file closes (persistentgamedata1..3.dat, their save_backups, gamestate1.dat, options.ini, log.txt), boot 2 restored 10 files, the game found every save (0 misses, no 'No Repentance save found'), same 3 runs / 2 deaths, main 0. Browser: one Chromium profile, the headless timeline to 1,500 frames then a reload: load 1 persisted 24 closes, load 2 restored 10 files before main and ran its 1,500 frames, main 0, 0 asserts (drive_persist.mjs OK). The first attempt aborted on load 2 in the game's VSync setter: with the written options.ini read back it asks GLFW for the primary monitor, and EnumDisplayDevicesW enumerated nothing -- the shims now describe one adapter, one monitor and one 1280x720@60 mode (selftest 241/0).
- **Round 34: a hostable dist and a player page** (§21.49).
  `python scripts/recomp/assets/ship.py build` -> `.scratch/game-dist`
  (30 files, 793,418,516 bytes raw, **744,521,328 bytes transfer** with the
  brotli/gzip siblings; `ship.py check` re-verifies), served by
  `node scripts/recomp/web/serve_dist.mjs .scratch/game-dist 8200`; the
  page (`play.html`) starts on its own -- one bar, then the game (`?stats=1` shows the fps line, `?saves=1` the saves button, `?autoplay=0` a Play button; F toggles fullscreen)
  that unlocks audio, fullscreen, key hints and a saves menu. Driven under
  headless Chromium: Play at 0.9 s, the run started, ~40 fps, main 0.
- **Round 32: typed console text** (§21.47). `TranslateMessage` is real:
  a WM_KEYDOWN of a printable key posts the US-layout WM_CHAR (Shift,
  CapsLock, Ctrl) at the head of the queue, so `ISAAC_CONSOLE="stage
  2;goto s.boss.1010"` is typed (`ISAAC_CONSOLE_MODE=typed`, the default):
  `Level::Init m_Stage 2` and `Room 5.1010(Monstro)` on the fast profile,
  0 asserts. Selftest 296/0, console tests 14/14.
- **Round 36: music plays** (§21.51). The WebAudio backend was handed ONE
  buffer at `alSourcePlay` -- and the engine starts its music stream with
  an EMPTY source (play first, then four 64 KiB chunks queued by the
  OpenAL thread, then one per processed chunk), so the title theme never
  had a node; `alSourceQueueBuffers` had no backend hook at all. Now every
  queue/unqueue reaches the backend, a stream is a chain of
  `AudioBufferSourceNode`s started back to back on the context clock, and
  the model follows OpenAL Soft (play with nothing queued stops at once,
  stop marks the queue processed, play from stopped restarts at the head).
  Measured on the master output (`drive_audio.mjs`, `window.isaacAudioLevel()`):
  before **20/20 samples at 0.0000 RMS**; after **20/20 above 0.005,
  median 0.0442 RMS, peaks 0.21**, two streams, ~5.9 chunks/s scheduled;
  the headless timeline schedules 201 chunks, scheduled == queued per
  stream, 0 refusals, `main` 0.
  `ISAAC_AUDIO_TRACE=1` traces every source (host and JS sides);
  `tests/recomp-audio.test.js` 10 (the EM_JS bodies run in node against a
  fake AudioContext), selftest 316 (20 `audio:` checks on a fake clock).
- **A push is not a deploy.** After every push:
  ode scripts/recomp/assets/check_deployed.mjs\ -- it hashes what the CDN and
  Pages actually serve against what was built here. The module lives in the
  part-A chunks (\c/a*.bin\), so a stale one of those is a stale ENGINE however
  current the page is: round 86b was reported as shipped while jsDelivr served
  the round-85 module for nine hours, and the trap that came back was identical
  to the original down to the last dispatch count, because it was the same
  build. Purge what it calls STALE, then run it again.
- **Round 86c: all thirty-two of them** (§21.102).
  85 and 86b were each signed off on ONE mod, and neither bug would have been
  caught by the other's. `drive_modpack.mjs` walks the whole catalogue: each mod
  in its own context, installed through the page's own file input, reload, boot,
  Enter until the engine says a run started, then played. The witness is the
  engine -- its `LOADED MOD` line, its `Running Lua Script` line, and its own
  files opened under `ISAAC_FS_TRACE=1`. Mods that only redraw one thing get
  that thing spawned through the game's debug console (which needs
  `EnableDebugConsole=1` seeded on a page that is **not** the game, and keys
  held longer than a frame, or the engine never sees them).
  **32/32 loaded, 17/17 ran their Lua, 28/28 with resources had their own files
  read, 0 traps, 0 errors**; fps 59.7-60.3 against a 60.0 baseline, and under a
  4x CPU throttle 51.2-53.9 against 52.9.
  Found on the way: `indexedDB.open(name)` with **no version** creates the
  database empty, after which the page's `open(name, 1)` never upgrades it, its
  stores are never made, and **every import fails for the life of the origin**
  (saves silently stop persisting on the same fault). All three openers probe
  and repair now; `--breakdb=1` reproduces the poisoning.
- **Round 86b: the functions only a mod ever calls** (§21.101).
  A mod's `main.lua` ran and the module stopped: `indirect call to 0x0086fc60
  ... was not lifted`. That address is `mov eax,[0xc71678]; ret`, an inline
  getter emitted out of line because somebody took its address -- **nothing
  calls it**, so Ghidra never made a function of it and the lifter never saw
  it. The game does not need it; a mod does.
  `scripts/recomp/lift/orphan_starts.py` censuses the class instead of the
  address: every `kind='addr'` escape into .text that is 16-aligned, int3
  preceded, an instruction boundary, and **strictly** outside every known
  function -- **117**, all one-line accessors. Starts 26,241 -> 26,358, lifted
  23,238 -> 23,353, dispatch 23,245 -> 23,362. Adding starts repartitions the
  TUs: 0xa2b5c7 gained a label and round 24e's block patch, anchored on a
  `RECOMP_VA` line, stopped matching -- never anchor a block patch there.
  The mod now reaches the title menu. Family **4105**, mods 37/37, saves 15/15.
- **Round 86: the two characters the template ate** (§21.100).
  `Uncaught SyntaxError: Unexpected token 'if'` -- reported twice, checked twice,
  found nothing, because both checks read the template's **source text**. The
  reader Worker's source is a template literal, so the Worker gets the *cooked*
  value and cooking eats backslashes: round 84's `/\/(\d+)\s*$/` arrives as
  `//(d+)s*$/`, a line comment that swallows the `const m =` before it. **The
  reader Worker had not started for anyone since round 84** -- every read
  synchronous, and round 83's retries never ran. The total is read with
  `lastIndexOf`/`slice` now, and a test cooks the template and parses it as the
  classic script a Worker is handed. Family **4105 pass / 0 fail**.
- **Round 85: two characters, and no mod had ever run** (§21.99).
  Every mod in this port was inert since round 74 -- no sprite, no sound, no
  Lua. `sub_00a17180` resolves every mod file from an index of **strings** and
  never touches a filesystem, and this port builds a mod's path off an empty
  base: it asked for `//mods/<id>/...` while the index holds `mods/<id>/...`.
  The loader asked whether there was a main.lua, was told no, and skipped every
  mod whole. The patch steps over the leading slashes. Then Lua answered
  `cannot open //mods/<id>/main.lua` -- it reads through MEMFS, where only the
  game's own scripts were copied -- so a mod's `.lua` goes there too. On a real
  run: **the mod's main.lua runs and 19 of its files are read, against 0**.
- **Round 84: the host's ranges are wrong, and not always the same way** (§21.98).
  Round 83 read a failed window as a blip. It was not: fetched whole, a chunk on
  jsDelivr is byte for byte what was uploaded; fetched as a **range**, the same
  file comes back with different bytes from the first one and a length **+37,
  +36, +40, +13, +5** over the truth depending on the chunk -- and not
  consistently, which is why one probe passed. The probe asks about four chunks
  now and every one has to be right, and each window carries its chunk's length
  in the fragment so a mismatched Content-Range is refused for the whole chunk.
  Mods: **EnableMods is turned on at the first boot that finds one installed**
  (round 82 only did it on a new install, so a browser that already had a mod
  kept round 76's 0 and the mod never ran), one **IMPORT MOD** row with a folder
  or .zip **dropped on the window**, **REMOVE MOD** for the list, and the torn
  right margin that had the browser's counter drawn outside the paper.
- **Round 83: one fetch failed and the run ended** (§21.97).
  `lazy pread FAILED ... the reader had no bytes` on the last window of the last
  chunk -- a window the host answers correctly the moment it is asked again. The
  reader had no retry and a pread that returns -1 traps, so a blip ended the
  run: **three tries with a backoff, then the whole chunk**, which carries no
  Range. The provider also treated any non-window answer as the whole chunk,
  slicing it and caching it under the chunk's key, which returned nothing and
  poisoned every later window in that chunk. And the loading screen: the stage
  grid was being put back by the chunk hook on exactly the build that should not
  show it, and the bar is a hairline rather than pips.
- **Round 82: the row that cost the achievements, and two quiet failures** (§21.96).
  Round 81's unlock patch did not clear the indicator because the gate was
  upstream of it: `mods/ import mod/` **is a mod**, so every run was a modded
  run on a save with nothing installed. It is seeded only once the player has a
  mod of their own; with none the way in is the EDIT FILE menu's **MODS** row,
  which is the page's own and costs no mod. **EnableMods=0** was the quietest
  failure yet -- round 76's default, kept because options are written once, so
  the mod imported, seeded, listed, and never ran; installing one turns it on
  now. A download reports bytes rather than finished parts (a one-part 19 MB mod
  showed nothing at all), and the loading screen is black, one segmented bar and
  one line in caps, with the stages under `?stats=1`.
- **Round 81: the row nobody could reach, and the byte that stopped the unlocks** (§21.95).
  Round 77b's mod browser shipped twice unreachable: the MOD BROWSER row is
  offered only with a catalogue base and no build ever carried one.
  `portable.py --catalogue URL` writes it in, and `drive_mods.mjs` now serves a
  catalogue of its own and installs a two-part mod out of it -- the check whose
  absence let it ship. **Achievements survive mods**: `TryUnlock`
  (`0x00929a20`) gates on `PGD+1`, the readonly byte, and past it records the
  unlock; the only writer is `SetReadOnly` (`0x009299e0`), which the game calls
  while mods are loaded, so the block patch at `0x009299e4` reads its argument
  as false. The FPS readout no longer survives a reload, the mods menu's key
  hints are gone, and a menu closed with a new mod reloads the page, because the
  engine scans `mods/` once before `main`.
- **Round 80: a rebuild that does not invalidate the upload** (§21.94).
  The keystream seed was the two stream lengths, so adding page assets to part
  A re-scrambled part B too -- 559 MB of identical plaintext with different
  bytes. `portable.py chunks --key-of <index.html>` reuses a deployed page's
  key: the 29 windowed chunks come out byte for byte what is already hosted and
  only the four part-A chunks need sending.
- **Rounds 78-79: the chunked build stops trusting the CDN** (§21.93).
  Four things that only broke once it was served from jsDelivr. `page-assets/`
  is kept out of the dist index on purpose, and `plan()` read that index, so a
  chunked build had no menu art and **IMPORT MOD did nothing, silently**. The
  range probe now reads 64 bytes and checks the `Content-Range` total, because
  jsDelivr answers 206 with the **wrong bytes** and a total 37 over the file; on
  a failure the reader Worker stays off, every window is a whole GET, and the
  window cache stops evicting (dropping a 19 MB piece was the freeze).
  `--part-mib` sizes pieces for a host with a per-file limit. The loading bar
  has a `chunks` row and takes whichever of bytes and chunks is further along.
  Escape stays in fullscreen through `navigator.keyboard.lock` (a held Escape
  still leaves). The mods menu waits for its art before calling itself open.
  Chunked build: **saves 15/15, mods 20/20, edit 11/11**.
- **Rounds 76-77: the mods menu is the game's, the payload is nobody's** (§§21.90-21.92).
  The add/remove UI is drawn on the game's own paper sheet with its own font --
  `menu_overlay.mjs` grew a shared `menuAssets` and a `createPaperMenu` the EDIT
  FILE menu already used. A mod cannot be added twice, X removes one, and
  disabling is the page's flag rather than a `disable.it` the engine never reads
  back. Mods default to **off**, because achievements are locked with them on
  until Mom is beaten, and nothing is appended to a file name any more -- the
  yield is applied silently. The chunk files are scrambled with a seekable
  keystream and the page's modules are minified, so neither announces what it
  is, and `modpack.py` puts a folder of mods on the same CDN as a catalogue plus
  parts (**32 mods, 89.8 MB in 34 parts**) that the page fetches on demand.
- **Round 75: a Huffman table per kilobyte, on both sides** (§21.89).
  The format cuts an entry into 0x400-byte blocks and full-flushes each one, so
  every kilobyte carries its own dynamic Huffman header and costs the decoder a
  table build. On 20.1 MB of afterbirthp.a, decoded per entry: dynamic 189.7
  MB/s, **static Huffman 862.7 MB/s** for +6.75% of size, and one stream with no
  flushes at all only 278.2 -- so **77.6% of the inflate was tables**, not bytes.
  Both halves were needed: zlib has the fixed tables precomputed and miniz does
  not, so the packer change alone would have saved the header and paid for the
  tables anyway. `optimize.py huffman` re-encodes each block (`--cost N` bounds
  what a block may grow; the default is no bound, and stored entries and the
  round-64 layout order are untouched), and `isaac_fast_tinfl` keeps the tables
  the first static block builds and copies them into every one after. Re-encoding
  at level 9 is itself worth 7.0 MB, which static Huffman spends back and a
  little more: the bundle goes 581.7 -> 587.3 MB (+0.98%).
  The loading window at a 4x throttle, three runs each side:
  **54.8/54.5/54.5 -> 45.1/45.1/45.2 ms/frame**, `isaac_fast_tinfl` **23.3% ->
  9.3-9.5%**, idle 23.6 -> 28-30%, frame 300 at 19.0 -> **13.6 s**. A 901-frame
  explored run decodes 220,223 static blocks, 220,222 of them off the kept
  tables, with **frame hashes identical to the baseline** and 0 checksum
  failures. run_web.mjs also serves page modules by shape now: round 74's
  `mods.mjs` import was a 404 there, which is a module graph that never resolves
  and a run that waits out its 20-minute timeout with an empty log.
- **Round 74: mods from the device, in the game's own list** (§21.88).
  The game scans `mods/` itself through the FS shim's `FindFirstFileA`, so a
  mod seeded before `main` is a mod on disk: `LOADED MOD //mods/...` from the
  engine's own log, no patch anywhere. The import row is itself a mod --
  `mods/ import mod/`, one metadata.xml, listed by folder name, leading space
  so a sorted list keeps it on top -- and Enter on it makes the engine write a
  `disable.it` the page claims through the round-31 persist hook and answers
  with its own menu. Mods live in **`isaac-mods`**, saves in `isaac-saves`,
  and everything the game writes under `mods/` is routed to the first, so an
  import cannot reach a save. A .zip (`DecompressionStream`) or a folder; the
  bytes are copied, so the file can go. Single roots are peeled until
  metadata.xml is at the top, a mod without one gets one, and **RAR and 7z are
  named and refused** -- no browser can open either. Every seeded path is
  built from an id and a relative name that were checked first: `..`, a drive
  letter, an empty segment and control characters are dropped, because
  `mods/` and `Documents/My Games/` share one key space.
  `drive_mods.mjs` **17/17** through the engine (import, reload, the engine's
  own load line, removal, a save witness byte-checked throughout);
  `tests/recomp-mods.test.js` 12. The zip reader moved out of play.mjs into
  `zip.mjs`, imported by both menus.
- **Round 73: the two screens before the title are settings** (§21.87).
  The public-beta notice and the data-collection disclaimer are
  `AcceptedPublicBeta_v1.9.7.17` and `AcceptedDataCollectionDisclaimer` in
  options.ini, not screens the port added. A first visit gets a default
  options.ini with both accepted -- **only when the save store has none**, so
  a returning player's settings and saves are untouched. Nothing is patched.
  There is no telemetry to consent to: the Steam and Epic entry points are
  stubs and nothing in the host layer opens a socket.
- **Round 72: the images stored rather than deflated, and put back** (§21.86).
  PNGs are already compressed and deflating them again wins by 3.5 MB while
  costing a full inflate pass over 56.5 MB per boot. Storing them bought
  **1.1%** of the inflater (108.0 -> 106.8 MB out) for **+3.7 MB** of bundle,
  and tinfl's own time did not move. Reverted; `optimize.py store` stays, off.
- **Round 71: the premultiply four pixels at a time** (§21.85).
  A wash, and the interesting part is why the first answer said otherwise.
  Census: 53.6 M pixels in 13.4 M groups -- 870,372 all opaque, 5,538,579 all
  clear, 6,995,209 mixed -- so 52% pay for the test and do the scalar work
  anyway, against a premultiply that is 3.6% of the loading window. The first
  A/B claimed **12% slower**, four times the size of the thing being changed:
  five `run_web.mjs` servers from earlier rounds were still resident. Clean,
  three runs: **54.8/54.5/54.5 ms/frame at 4x, 23.6-24.4% idle** against
  54.6/54.0 and 23.8-24.2% before. **Check the process list before profiling.**
- **Round 70: the page carries the game -- two portable builds** (§21.84).
  `portable.py` turns a finished dist into either one .html with the payload
  inline, or a small page plus a dozen large files for a static host. The page
  takes bytes from `window.isaacPortable` instead of a server; with no
  provider nothing about the served dist changes. Part A (read whole) is
  gzipped, part B (the 1 MiB windowed archives) is raw and laid out on window
  boundaries so a window is one `Range`, carried in the URL fragment. Four
  wrong first attempts are recorded in §21.84: one chunk per window (559
  files, 23.2 s to the first frame), gzipping the windowed archives, a single
  707.8 MB `<script>` (V8 stops near 512 MB and says nothing), and keying the
  provider by the dist path rather than the engine's own name.
- **Round 69: the arena follows the catalogue down** (§21.83).
  Halving the sound catalogue took the guest heap's high-water mark from
  350.1 MiB to 249.4, so the arena went 512 -> **384 MiB** and
  `-sINITIAL_MEMORY` 832 -> **704** (1,088 three rounds ago). The map moved
  down another 0x08000000; `r69_shrink.py` reads the current values, so the
  next move is one argument. The renderer's private bytes fall to **1,088 MB** (1,227 at 512 MiB, ~1.5 GB before round 66); peak live is still 249.4 MiB with 0 allocation failures.
- **Round 68: the music at q2, and the textures the engine will not take** (§21.82).
  Music re-encoded from the pristine archives at q2 (167 of 179 tracks):
  bundle 619.3 -> **581.7 MB**, off the total download rather than the boot.
  The textures gave nothing: oxipng's lossless reductions are worth 20 % and
  the engine's loader **takes 8-bit RGB/RGBA only** -- it refuses the rest,
  carries on with no surface and traps. 8 images in 400 can drop an opaque
  alpha, worth 0.00 %. Every offline check passed on the broken build; what
  caught it was rendering 1,500 frames and hashing them.
- **Round 67: half the sound catalogue, where half is all there was** (§21.81).
  976 of 1,553 preloaded WAVs carry under 0.5 % of their energy above 11 kHz,
  so `optimize.py halve-sfx` filters and decimates those by two (44,100 ->
  22,050) and leaves the 577 with real treble alone. Catalogue PCM 265.5 ->
  **163.1 MB**, bundle 733.8 -> **619.3 MB**, a first visit 277 -> **173 MB**,
  the title screen at 50 Mbit/s 72.9 -> **55.4 s**, the guest arena's
  high-water mark 350.1 -> **249.4 MiB**. Proved three ways: the surviving
  band differs by 1.06 % median, the browser's master output is 100 % above
  the RMS threshold, and every drive passes.
- **Round 66: the guest arena down to what the engine actually uses** (§21.80).
  The wasm memory is committed on creation, and the engine's own high-water
  report reads 350.1 MiB after 900, 4,000 and 6,000 frames -- the arena was
  768. It is 512 now, the whole guest map moved down by 0x10000000 (host
  base `0x24000000`), and `-sINITIAL_MEMORY` fell from 1,088 MiB to **832**.
  The generated shim table and the oracle harness's fixed addresses had to
  move with it; the lifted objects rebuilt themselves off the header
  fingerprint. The renderer's private bytes fall from ~1.5 GB to **1,227 MB**; peak live is still 350.1 MiB with 0 allocation failures.
- **Round 65: the same layout, from the boot's own trace** (§21.79).
  `ISAAC_FS_READ_TRACE=packed` names every `fread` by file and offset, and
  the entry table turns an offset into an entry: one boot gives the real
  access order, 1,450 entries against the 1,218 `sounds.xml` names. Order
  files take `h1-h2` tags now, so unnamed entries can be ordered too. A
  first visit fetches **279 windows / 277.2 MB against 442 / 440 as
  shipped** -- 37 % of the archive traffic gone, misses 136 -> 2, frame 300
  -3.2 s at 200 Mbit/s and -7.7 s at 50. Every window is fetched once, in
  order: the boot reads a prefix of each archive.
- **Round 64: the archive laid out in the order the boot reads it** (§21.78).
  The boot's inflater decodes 35.6 MB to frame 300 -- the traffic is the
  sound catalogue's 218 MB of *stored* PCM. The engine preloads it in
  `sounds.xml` order, which reproduces the recorded trail exactly; the
  shipped archive scatters it, so the walk steps backwards 246 times and
  costs 457 window fetches. `optimize.py layout` rewrites the archive in
  that order (bytes, keys, sizes and checksums verified unchanged): a first
  visit fetches **305 windows / 303 MB instead of 442 / 440 MB**, every one
  forward-adjacent, and the reader's misses fall from 136-142 to 8-9. The
  time to the title screen moves 0.6-2.4 s only: the trail already hid the
  latency, so this is a bandwidth win, not a seconds win.
- **Round 63: quad draws batched, and unbatched again** (§21.77).
  Consecutive same-state quad draws merged into one draw: built, pixel-
  identical, and pointless -- of 50,515 draws 3 merged; the engine binds a
  different sheet between three draws in four (37,761 flushes by
  glBindTexture) and sends a per-draw uniform (5,990). Reverted; recorded.
- **Round 62: the keystream in v128** (§21.76). One `v128.xor` per sixteen
  bytes where the build has SIMD, the refill exactly where the scalar
  loop puts it; the selftest (SIMD too, forty bytes across the refill)
  and the verify mode (263,360 calls) are the proof. keystream 7.3 -> 5.6 % of the loading window (1.4 -> 1.0 s), the window 19.7 -> 18.2 s, first-visit frame 300 at 20.5 s. hidden from frame 63 for 10 s mid-loading: 30 frames on the 250 ms path, then frame 300 at 32.1 s, 0 errors. The
  browser's dispatch cache hits 99.85 % (the 17 % profiles were cold-
  module attribution); the one pending GL error is the engine's own
  `glDeleteProgram` of a dead name, reproduced.
- **Round 61: wasm SIMD for the host TUs** (§21.75). A 600 s soak of the
  round-60 module first: 60 fps median, renderer working set 1,239 -> 1,022
  MB, nothing growing. Then `-msimd128` on the fast profile's host TUs
  (auto-vectorised byte loops; the lifted TUs stay scalar): nothing measurable by itself (loading window 19.7 s against 19.8, play 18.8-21.2 ms against 19.8-22.5); verify mode clean; the flag stays for a hand-written v128 keystream next.
- **Round 60: the memory map** (§21.74). `drive_memory.mjs` (new): OS
  figures for the renderer and GPU processes, a memory-infra dump by
  allocator, a texture-upload census -- after three forced garbage
  collections (a raw reading is the collector's timing, +540 MB once).
  Renderer 1.06-1.10 GB working set at stage 2, GPU 510-520 MB; the dump
  attributes 560 MB (wasm memory and code are not in it). The reader
  Worker drops its cache at frame 600 (was up to 128 MB held for the
  page's life). Large texture uploads go in 4 MB bands: pixels identical (frames 100-399 hash the same on/off), renderer working set 1,090 -> 1,002-1,004 MB, GPU process 511 -> 409-410 MB (its private bytes 607 -> 764: committed, not resident).
- **Round 59: the saves round trip, the shipped boot trail** (§21.73).
  `drive_saves.mjs`: export on file 1 (a zip, byte-exact), import into file
  2 (exact before and after the page's reload), a bare .dat into file 3:
  15/15 (the engine's `save_backups/` copies were the false duplicates).
  `ship.py build --trail <drive_boot's boot-trail.json>` ships the trail;
  a first visit hits 306/442 windows. Under a 200 Mbit/s cap (`drive_boot
  net=200`) frame 300 comes 10-12 s sooner; with the prefetch deferred to the first frame, 32 s against 46.5 (the first frame unchanged at 6 s); `drive_memory.mjs`
  (new) dumps the renderer's allocators through memory-infra.
- **Round 58: tinfl on the host, the host at -O3** (§21.72). `sub_00a85710`
  is miniz 1.x's `tinfl_decompress` (the archive stream's inflater, 10 %
  of the loading window): ported from the public source with the 1.x
  details the disassembly settles, coroutine states kept; selftest on
  zlib-made streams (391 checks), verify mode 39,902 calls byte-exact
  after one caught divergence (the byte-align skip). The host TUs go -O3
  in the fast profile (they were -O1): play frame 21.0 to 19.8 ms at 4x,
  the host share 25 % to 14 %. Frame 300 at 4x: 22.3 s cold, 18.9 s warm.
- **Round 57: the loading work profiled** (§21.71). `profile_play.mjs
  phase=start` (first frame to frame 300, at 4x): 25 % idle, then the
  keystream XOR 11.8 %, miniz tinfl 9.5 %, zlib inflate_fast 5.8 %. The
  keystream goes a word at a time (2.9 s to 1.4 s); inflate_fast
  (0x00adb9c0, the ring-buffer variant) is on the host, verified over
  93,653 calls with 0 mismatches -- and no faster than the lifted body
  (it was C already). Frame 300 at 4x: 24.0 s cold, 22.3 s warm. Selftest
  381. Next: tinfl (0x00a85710, miniz 1.x, 10 %).
- **Round 56: the archive reads are a Worker's** (§21.70). The lazy read
  is a JSPI import: a promise parks the engine mid-read while a Worker of
  this origin fetches the raw bytes (no base64, no synchronous XHR) and
  transfers them; read-ahead along a file and along the boot trail. Frame
  300 at a 4x throttle: 27.6 s cold, 23.6 s warm, against 40.0 s with
  `?reader=0`; the engine waits 1-3 s for windows in all now. The rest of
  the cold start is loading work (`profile_play.mjs phase=start` next).
  The node profile links again (the EDIT FILE gate stub). edges 22 ok / 0 fail, EDIT FILE PASS 11/11, page 1 ok / 0 fail, floors PASS 21/21, the node explorer census md5 unchanged (r43 pin).
- **Round 55: the cold start** (§21.69). 442 archive windows (440 MB) are
  read synchronously before frame 300: 44-51 s at a 4x throttle. A boot
  trail (localStorage, written at frame 300 by the host frame counter -- the
  present hook never fires on the served page) is fetched ahead by a Worker
  on the next visit, and the synchronous read decodes with
  `Uint8Array.fromBase64` (3 ms a window against 17): 37.9 s cold, 33.8 s
  warm (138 of 442 windows hit; deliveries land only when the main thread
  yields). `drive_boot.mjs <url> <out> cpu=4 visits=2` and
  `bench_decode.mjs <origin>` are the drivers. Negative: x-user-defined
  sync text (70-75 s against 50). Next: the reads under JSPI, answered by
  the Worker with raw bytes and read-ahead.
- **Round 54: three edge hunts, nothing found** (§21.68). A 600 s browser
  soak at full speed (60 fps median, renderer working set flat at ~1,075
  MB, GPU ~503 MB, no errors); the tab hidden for 330 s and back (22/22;
  the forged flag covers the port's path, not Chrome's real throttling);
  `drive_floors.mjs <url> <out> options=<ini>`: every stage 2-13 plus the
  alternate 1c-4c by console, 59-60 fps each, memory flat, 21/21.
- **Round 53: one static index buffer for every quad** (§21.67). The
  engine's draws are quads in one fixed index pattern (0 2 1 1 2 3 stepping
  by four), so the client-array emulation draws them from one static
  ELEMENT_ARRAY_BUFFER: 90,760 of 90,760 draws over 3,000 browser frames, 0
  index bytes uploaded (`ISAAC_GL_QUAD_IBO=0` is the A/B; interleaved 6x
  profiles off 28.5 / 30.9 against on 27.2 / 26.1 ms a frame, bufferSubData 3.5 / 3.4 % against 3.1 / 2.7 % (the machine was in a slow hour; the pairs are what count)). A 20,000-frame node soak: heap peak
  352.7 MiB, touched span 355.2 MiB, no growth with play.
- **Round 52: EDIT FILE** (§21.66). The save-select screen's DELETE FILE
  strip reads EDIT FILE (the sheet reset in the Team Meat font, repacked
  into the bundle's `afterbirthp.a` by `page_assets.py`, run by `bundle.py
  build`); confirming on a file in that mode opens the page's menu -- EXPORT
  FILE, IMPORT FILE, DELETE FILE, BACK; N flips the FPS readout (white, the number alone) -- drawn with the game's
  paper, font, cursor and sounds (`page-assets/`, `menu_overlay.mjs`) and
  driven by the game's keys. The hook is a block patch at 0x9d9d59 in
  `Menu_Save::Update` asking `isaac_editfile_gate`; Delete hands the flow
  back to the engine's own prompt. `drive_editfile.mjs <dist-url> <out>`
  proves it on the shipping page. The bundle's `afterbirthp.a` is a compact
  repack (442 MB for the instance's 604, every entry verified).
- **Round 51: the page is the game, the memory map, a leaf not worth it**
  (§21.65). The loading panel had never hidden (`#overlay`'s own `display:
  flex` outranked the `hidden` attribute; a global `[hidden] { display:
  none !important }` fixes it). The shipping page is now the game alone:
  autoplay by default, one bar over black, no header / hints / buttons;
  `?stats=1` shows the fps line, `?saves=1` the saves button, `?autoplay=0`
  a Play button. Memory-infra: renderer private 1.47 GB = 1,088 MiB of
  committed wasm memory + ~450 MB of Blink/GPU-mapped/malloc; the guest
  heap's touched span is 355 MiB (reported now) against a 352 MiB peak; the
  GPU process holds the textures (~520 MB). A host `std::map::find` leaf
  verified bit-exact (124,622 calls) but gained nothing (0.8-1.2 % vs
  1.0-1.1 %): reverted, and the patch pass now retires a wrapper whose
  entry is gone (the stale stub had broken the build). `check_page.mjs`
  opens the shipping page as a player does and reports what is on screen.
- **Round 50: the whole inverse_mdct on the host** (§21.64). sub_00aa38a0
  with its iter0 / s / ld654 helpers, transcribed from the decompile
  statement by statement (the helper register arguments from the
  disassembly); the scratch goes where the original's `temp_alloc` puts it
  (the engine installs an `alloc_buffer` -- the first gate refused all
  2,114 calls, which the census showed as `0 verified`). Verify mode:
  2,114 calls, 0 mismatches; census identical; selftest 372; edges 22/22.
  Interleaved 6x profiles r49 25.2 / 21.1 -> r50 24.3 / 19.3 ms a frame
  (about 2 % of the frame; the node clock cannot see it, node decodes one
  block a frame). Left in the decoder: residue (0.8 %) and codebook
  (0.6 %). `readPixels` (the engine's probe) would need an asynchronous
  readback -- a one-frame-late pixel, opt-in only if ever.
- **Round 49: -O3 for the lifted TUs, the imdct butterfly on the host,
  save + continue** (§21.63). The 38 lifted TUs compile at -O3 in the fast
  profile: +0.38 % module, the same compile time, an identical explorer
  census, 1.5 % less node wall time over 3,000 frames (every pair of three
  alternating passes); the browser's 10x A/B cannot resolve changes under
  about 10 % (the same build measured 28.0 and 37.3 fps in consecutive
  passes) -- use the node clock or the 6x profile for those. stb_vorbis's
  `imdct_step3_inner_r_loop` (0x00aa3270, scalar SSE, plain ret) runs on
  the host, bit-exact: 36,056 calls verified, 0 mismatches; the 6x profile
  is 18.9 ms a frame (21.0 in round 47). `drive_edges.mjs hidden_s=60` and,
  with `options=`, a reload + continue that must resume the same run (the
  `RNG Start Seed ... [Continue, n]` line with the pre-reload seed), and a
  visible page whose `requestAnimationFrame` never fires (the desktop app's
  occluded browser pane does this with `document.hidden` false; the yield
  hung on it -- it now races a 250 ms timer, counted and named in the
  status line): 22/22. Next: the whole inverse_mdct (sub_00aa38a0 with its iter0 / s / ld654
  helpers), about 4 % of a frame.
- **Round 45: the cold start** (§21.60). `profile_play.mjs phase=boot`:
  first frame at 4.5 s at the 4x throttle served locally (fetchSync 30 %,
  shader compiles 7 %, atob 6 %); the first visit is the download. The
  dist server re-reads `dist.json` on change (a stale manifest had made
  the module `no-cache`). Neither browser here reuses the HTTP cache
  across navigations, so the wasm code cache remains unverified.
- **Rounds 47-48: edge cases and three more GL redundancies** (§21.61-62).
  `drive_edges.mjs` (typed console, forged hidden tab, resume, music RMS):
  16/16; it found and fixed the page's missing punctuation keys. The
  engine's own `glReadPixels` is a 1x1 probe at (60, 227) every dozen
  frames (a probe under the player, `sub_007b8cb0` through the graphics layer -- kept). Identical index blocks, redundant attribute
  enables and uniform re-sends are skipped (107 uniform re-sends and 10 index uploads a frame gone; seeded 10x A/B 35.1/36.4 -> 38.4/37.1 fps).
- **Round 44: below the cap** (§21.59). A 6x throttle measures throughput
  under the 60 fps pacing: at 10x (below the cap) round 43's module runs 33.6-34.2 fps, with the GL state filter 33.5-36.7; the 4x-5x range of a Chromebook core holds 60. The web GL wrappers skip
  redundant `glUseProgram` / `glActiveTexture` / `glBindTexture` /
  `glBlendFuncSeparate` / `glViewport` (about 230 skipped native calls a frame).
- **Round 43: the giant functions, split** (§21.58). The transient was
  the baseline compiler on 338,000-line lifted functions (quadratic in
  labels x locals; 1.1 GB with tier-up, 2.5 GB without).
  `split_giants.py` rewrites functions over 60,000 lines into trampolined
  ~25,000-line parts at build time (10 functions, 6 TUs). Run-start V8 transient gone (allocators 631 MB at +3 s, was 1,895; Liftoff-only 448, was 2,503), renderer peak 1.22 GB (was 2.4-2.9), steady 1.05 GB; explorer run frame-identical to round 41; 58-60 fps; the six TUs compile in 56 s.
- **Round 42: the run-start transient is V8's compiler** (§21.57).
  `drive_perf.mjs memdump=1` (memory-infra dumps) attributes what is left
  of the run-start spike after rounds 38-41 to `v8/main/malloc` -- the
  optimiser's compile zones while hundreds of big lifted functions tier up
  at once (1.1 GB for ~10 s on 16 cores; the same 1.1 GB with two compile threads and 2.5 GB with TurboFan off: the baseline compiler on the giant lifted functions (quadratic in labels x locals) -- round 43 splits them). Steady state
  after a run start: renderer 1.1 GB + GPU process 0.5 GB working set.
  Levers left: smaller lifted functions, a working code cache.
- **Round 41: the archive windows** (§21.56). A run start fetched 812
  1 MB windows (808 MB, 712 MB of `afterbirthp.a`) because a level load
  walks scattered resources and the two-window cache of round 24e
  thrashed; the renderer peaked at 2.4 GB. 32 LRU windows per file:
  812 -> 466 windows (327 distinct) per run start; the bodies are detached after the copy, so the renderer peak fell from 2.8 GB to 1.9 GB (steady 1.1 GB). Selftest 356/0.
- **Round 40: the wasm code cache** (§21.55). Cold runs are bimodal
  because of V8's tier-up (Liftoff first, TurboFan on background threads
  -- minutes on a Chromebook); the code cache that skips it needs a
  cacheable response and `instantiateStreaming` on the fetch Response
  itself, and both were broken (`no-store` on the dev server, a synthetic
  Response in `play.mjs`). Fixed; `drive_perf.mjs`/`profile_play.mjs
  profile_dir=<dir>` measure the warm start: cold 60.0 / warm 59.9 fps at 4x; Chrome stores the chunks (155-214 MB in Code Cache/wasm) but no reload deserialises them yet; the memory timeline found an 808 MB window-fetch burst per run start (round 41).
- **Round 39: rings and a two-way cache** (§21.54). The client-array
  staging buffers are rings (append, orphan on wrap: no `bufferSubData`
  ever lands on bytes a queued draw reads), and the dispatch cache is
  16,384 x 2 ways with a hit census (99.85 % in the menus, 99.35 % in a scripted run). 4x throttle: play
  58.2 fps, frame work about 15 ms at the 4x throttle; profile: steady state `isaac_lifted_dispatch` 7.5 %, `bufferSubData` 1.7 %; cold runs are bimodal (V8 tier-up, round 40).
- **Round 38: the dispatcher's cache** (§21.53). `recomp_call_indirect`
  tries a 4096-slot direct-mapped (va, id) cache before the shim check and
  the 18 MB index (`isaac_lifted_dispatch` was 10.9 % of a throttled
  frame; 7.3 % after); a hidden document ticks on a slow timer
  instead of stalling on requestAnimationFrame. 4x throttle: play 59.0
  fps; 32.4 M dispatches in 3,000 frames still counted exactly.
- **Round 37: the Chromebook budget** (§21.52). The web GL wrappers answer
  renderbuffer parameters, framebuffer completeness and uniform/attrib
  locations from a host-side cache of what the game set
  (`host_gl_cache.c`; 3,000 frames: renderbuffer params 26,922/0, framebuffer status 7,450/8, locations 1,230,948/32 answered by the host), the present path
  drains `glGetError` every 64th frame, and the per-frame yield is a
  MessageChannel message paced by `requestAnimationFrame` when the frame
  had spare time (was `setTimeout(0)`, clamped to 4 ms). `drive_perf.mjs`
  at a 4x CPU throttle: play **60.0 fps** (was 28), SwiftShader 35.6
  (was 27); memory renderer 1.2 GB + GPU process 0.5 GB working set. Selftest 354/0.
- `node scripts/check-repo-safety.mjs` passes; no binary-derived material tracked.

## What changed this round (rounds 22-25: audio root cause, threads, JSPI)

The port was silent for three reasons, none of them audio code, all of
them ours (§21.39):

1. **The sounds were not in the instance.** Every Repentance sample and
   the title theme live in `afterbirth.a` / `afterbirthp.a` /
   `repentance.a` (1.2 GB), never seeded. They are in
   `.scratch/game-instance/resources/packed/` now, registered lazily and
   served through 1 MB windows (`host_shims_fs.c`, `isaacLazyPread` in
   both drivers) -- never loaded whole.
2. **The archive index was unreachable.** Its keys are `resources/<path>`
   and the project's own `0x009ab970` patch had removed the `resources/`
   mount root. The round-10 override is back (`lift_patches.py PATCHES`).
3. **The open itself was patched out.** `0x00a2b5c2` ("branch forced" in
   §19.5) skips the open of every sound source after construction. Undone
   by a block-level lift patch (`BLOCK_PATCHES`, plus `LIFT-PATCH REENTRY`
   markers mkdispatch honours).

Around it: guest thread jobs run as per-frame slices with a join on
thread-handle waits (host_shims_module.c); the guest heap is 768 MiB (the
catalogue is 269 MB of PCM) and the host base moved to `0x34000000`
(isaac_host.h, build flags, `gen_shims.py` reads the shim base from the
header); observe-only probes and string probes; `RaiseException`
0x406D1388 swallowed; the browser build is interactive under JSPI
(round 25, `run_web.mjs interactive=1`).

New pins: `tests/recomp-threads.test.js` (6), `tests/recomp-archives.test.js`
(6), `tests/recomp-memory.test.js` (2), `tests/recomp-jspi.test.js` (5);
selftest 196 checks (two stale pins fixed: the import canary is 728, the
adopted-thread contract runs with slices off).

## Try it yourself

**Drive the edge cases (round 47):**
```
node scripts/recomp/web/drive_edges.mjs http://127.0.0.1:8102/ output/recomp/web-edges options=<options.ini with EnableDebugConsole=1> hidden_s=8
```
The typed console (`stage 2`, `goto s.boss.1010`), a forged hidden period,
the return, the music across it; 16 checks, exit 0 when all pass.

**Measure the browser under a Chromebook-class budget (round 37):**
```
node scripts/recomp/web/run_web.mjs output/recomp/web-live 100000000 serve=1 interactive=1 port=8102 fast=1 instance=.scratch/game-bundle
node scripts/recomp/web/drive_perf.mjs http://127.0.0.1:8102/ output/recomp/web-perf cpu=4 gl=hw seconds=30
node scripts/recomp/web/profile_play.mjs http://127.0.0.1:8102/ output/recomp/web-profile cpu=4 gl=hw seconds=12
```
`cpu=4` is the DevTools CPU throttle, `gl=swiftshader` takes the GPU away,
`profile_dir=<dir>` keeps a browser profile so the second run is the warm
start (V8's code cache, round 40), `fresh_saves=1` drops the IndexedDB saves
first so a warm run still starts a new run, `trace_wasm=1` reports Chrome's
`v8.wasm` trace events, `js_flags=<flags>` reaches V8 (e.g.
`--wasm-num-compilation-tasks=2` for a four-core machine's compiler); the
perf driver also prints the lazy-read census (windows fetched / distinct,
bytes per archive, the first offsets) and a memory timeline every 5 s;
the perf driver prints the fps medians and the memory census, the profiler
the self time by group and the top 40 functions. Measure on an idle machine
and from a snapshot copy of the module (`boot=<dir>`): a relink overwrites
`boot-web-fast/` under a running page.

```
node scripts/recomp/web/run_web.mjs output/recomp/web-live 4000 serve=1 port=8099 fast=1     "input=420:Enter,470:Enter,520:Enter,580:Enter,640:Enter,700:Enter,760:Enter,900:d:150,1150:w:150" keep=200
```

Interactive (round 25; the module yields to the event loop every frame and
takes real keyboard/mouse input):

```
node scripts/recomp/web/run_web.mjs output/recomp/web-live 4000 interactive=1 port=8099 fast=1
```

Ship it (round 34, §21.49): assemble the dist once, serve it, open the page:

```
python scripts/recomp/assets/ship.py build
node scripts/recomp/web/serve_dist.mjs .scratch/game-dist 8200
```

The automated player (round 29, §21.44): 20,000 frames of rooms, pickups,
hunting, deaths and restarts on a pinned floor, with a census at the end
(`explorer: {...}` -- transitions, rooms, runs, deaths, pickups, counters):

```
cd .scratch/game-instance && ISAAC_EPOCH=1700000000 ISAAC_MAX_FRAMES=20000 ISAAC_DRIVE=explore node ../../output/recomp/lift/boot-fast/boot_integration.mjs ../../output/recomp/host/isaac.segs.bin main
```

The debug console (round 30, §21.45): `ISAAC_CONSOLE="cmd1;cmd2"` runs the
game's own commands once the run has started (a floor: `stage 2`; a boss:
`debug 3;debug 4;goto s.boss.1010`), by history recall -- nothing is written
to the instance; `console: {...}` at the end says what ran and when:

```
cd .scratch/game-instance && ISAAC_EPOCH=1700000000 ISAAC_MAX_FRAMES=4000 ISAAC_DRIVE=explore ISAAC_EXPLORE_CENSUS=1 ISAAC_CONSOLE="debug 3;debug 4;goto s.boss.1010" node ../../output/recomp/lift/boot/boot_integration.mjs ../../output/recomp/host/isaac.segs.bin main
```

To drive that page with real key presses under Playwright (state-driven:
Enter, held, until the game's own log says a run started, then walk; exit 0
only if the picture changed and `main` returned 0):

```
node scripts/recomp/web/drive_interactive.mjs "http://127.0.0.1:8099/boot_web.html?frames=1500&ISAAC_YIELD=1" output/recomp/web-drive
```

`serve=1` holds the local server open and prints the URL instead of driving a
headless browser; `fast=1` serves the speed-profile module (`build_boot.py
--web --fast`), which is the one that renders gameplay at ~50 fps. It loads
~300 MB of assets before the first frame.

The shipping bundle (round 28, §21.43): build it from the optimised instance,
check it, and run either driver from it (`ISAAC_INSTANCE_DIR=<dir>` on the
node driver, `instance=<dir>` on the web runner; the cwd rule still applies):

```
python scripts/recomp/assets/optimize.py layout <packed>/afterbirthp.a <tmp>/afterbirthp.a --catalogue <packed>/afterbirthp.a   # round 64, then the same for afterbirth.a and sfx.a, moved back over <packed>
python scripts/recomp/assets/bundle.py build .scratch/game-instance-opt .scratch/game-bundle --original .scratch/game-instance --strict
python scripts/recomp/assets/bundle.py check .scratch/game-bundle
cd .scratch/game-bundle && ISAAC_INSTANCE_DIR=C:/Users/Luca/Desktop/isaac/.scratch/game-bundle ISAAC_EPOCH=1700000000 ISAAC_MAX_FRAMES=3000     ISAAC_INPUT="420:Enter,470:Enter,520:Enter,580:Enter,640:Enter,700:Enter,760:Enter,900:d:150,1150:w:150"     node ../../output/recomp/lift/boot-fast/boot_integration.mjs ../../output/recomp/host/isaac.segs.bin main
node scripts/recomp/web/run_web.mjs output/recomp/web-bundle 3000 fast=1 instance=.scratch/game-bundle     "input=420:Enter,470:Enter,520:Enter,580:Enter,640:Enter,700:Enter,760:Enter,900:d:150,1150:w:150" keep=500
```

`bundle.py classify <instance> --all` shows every file's verdict and rule;
`run_web.mjs` writes `served_files.json` (every file it served, requests and
bytes) next to `web-run.log`.

**Boot cost in the browser:** the DLC archives (1.2 GB) are fetched as 1 MB
byte slices while the engine verifies every entry at mount, so the first
frame takes a while; the node driver does the same from disk. Shrinking that
(skipping the per-entry checksum pass, or repacking only the entries the
game uses) is optimisation work, not correctness.

## What the port does NOT do yet (front B)

The engine loop is no longer the blocker -- a 30-minute session runs clean.
What is missing is feature surface and verification depth, and none of it
is started:

- ~~Browser gameplay is unverified.~~ **It is verified** (§21.38): the fast
  browser module (`build_boot.py --web --fast`, served by `run_web.mjs
  fast=1`) runs **1,500 frames in 44.9 s** under headless Chromium with
  software WebGL2, delivers every scripted input, returns 0 from `main`,
  and `output/recomp/web-gameplay/frame_1500.png` shows a Basement room
  with Isaac, the HUD, the minimap and two enemies. The old 1-fps figure
  was the debug module.
- ~~No audio yet.~~ **Audio plays, in node and in the browser** (§21.39);
  **music too, since round 36** (§21.51: the stream queue is scheduled as a
  chain of nodes; before that only the census said it played).
  Samples decode, bind and play; the title music streams. Headless
  Chromium, fast module, the HANDOFF timeline: **329 PCM uploads (42 MB,
  385 s of audio), 102 plays, 308/76 stream buffers queued/unqueued,
  WebAudio context running, 1,501 frames in 67.6 s wall** including the
  1.2 GB archive mount over `?off=&len=` byte slices, `main` returned 0.
  Node (debug profile, 240 s): 92-99 uploads, 17-23 plays, peak guest heap
  354 MiB.
- ~~Video is unverified.~~ **Video plays** (§21.40): `ISAAC_CUTSCENE=300:3`
  makes the frame present call `Manager::ShowCutscene(3)` (the Epilogue:
  anm2, then `001_Epilogue.ogv`, then the credits); the clip is decoded by
  the theoraplayer worker slice, uploaded frame by frame, logs `finished
  playing`, and the game returns to the title menu. It needed libtheora's
  `emms; ret` (a hand-written body) and twelve SSE intrinsics that had been
  aborting stubs, each now oracle-checked against Unicorn.
- ~~The start-room ping-pong (open, floor-dependent).~~ **Resolved
  (2026-09-04, §21.40): it was our square root.** `recomp_fsqrt_f64` was
  declared `double(double)` while the lifter passes bit patterns, so the
  game's `sqrtf` wrapper (0x00435a50) returned 0 for every vector length
  and the door-touch check fired for the first open door in slot order
  every frame; the `CellSpace::insert: x1 > x2` grind and the
  `Invalid entity position: inf/-nan` asserts were the same zero. With the
  bits-typed helper, epochs 1700000000/1/2 do **zero** transitions and
  zero asserts before any movement key (the "one transition" the old
  timeline expected was the defect stopping early). Replay a floor with
  `ISAAC_EPOCH=<unix seconds>`; `ISAAC_ROOM_PROBE=1` dumps the door-check
  inputs at every engine log line, `ISAAC_ROOM_TEST=1` runs the lifted
  door check in situ (far player must not fire, near player must).
- ~~The string table shows raw keys.~~ **Resolved (§21.41): 813 lifted
  functions started at their lowest block instead of their entry** (Ghidra
  bodies that absorbed a lower block; the string-table loader's second
  half returned through the loader's own epilogue). `lift.py` emits
  `goto L_<entry>` first now; `lift_patches.py --entry-first` gives the
  existing tree the same goto at build time; the HUD reads "The Sad
  Onion" instead of `#THE_SAD_ONION_NAME`. Any lifter change that
  reorders blocks must keep `tests/recomp-entry-first.test.js` green.
- **Round 29: gameplay is exercised by an automated player** (§21.44).
  `ISAAC_DRIVE=explore` on the node driver reads room, doors, players and
  the pooled NPC objects from the guest heap and plays: doors, hunting,
  sidesteps, death, the next run. 20,000 frames on one seed: **62 room
  transitions, 9 distinct rooms (shop, treasure, curse), 10 runs, 9
  deaths, 0 asserts**; enemies spawn, move, take damage and die; the
  player is killed (`Game Over. Killed by (244.0)`) and the game-over
  screen leads to the next run. The rendered browser run shows the head
  turn and the tears (`drive_interactive.mjs` holds ArrowLeft and keeps
  `shot_fire.png`).
- Pickups too: the explorer walks into keys, hearts, bombs and coins
  (a key raised the counter at `Entity_Player+0x135c` from 0 to 1; pedestal
  items in a shop are abandoned with no coins), and door choice spreads
  over the least-used door so a floor is walked, not bounced.
- ~~**Gameplay depth beyond that is untested**: pedestal collectibles, the
  trapdoor and floor descent, bosses, save/load.~~ **Round 30 (§21.45)
  exercised a floor change (`stage 2`: Level::Init, the new floor's rooms)
  and a boss fight (`goto s.boss.1010`: Monstro, its death, the reopened
  door, the boss item) through the debug console.** Still open: the real
  descent (the trapdoor spawns only in the floor's own boss room, which
  the explorer must reach by walking -- a door preference toward the
  level's boss-room index is the next unit), pedestal collectibles (the
  explorer now tries them after the other pickups), save/load.
- ~~**Gameplay depth is untested.**~~ The scripted input is a timeline keyed
  to presented frames, not a player: combat, damage, item pickup, floor
  descent, bosses and save/load have never been exercised. A run so far
  walks between two or three rooms.
- **Online is stubbed** (Steam, EOS), by choice.
- ~~The instance is missing DLC archives.~~ They are mounted (lazy,
  windowed). The **language packs stay unmounted on purpose**: the mount
  loop overwrites an equal-hash entry, so a mounted pack would shadow
  English assets; the log's "Failed to open archive file 'packed/*.a'"
  lines are those.
- ~~No shipping build has been measured.~~ **It has, and it is 20x faster**
  (§21.37): the same 1,380-frame gameplay scenario runs in **26 s with
  `--fast` against 525 s with the default profile**, i.e. **53 fps** with
  room transitions and enemies. Every gameplay "grind" and "stall"
  measured before this was the debug instrumentation -- a bounds check and
  a VA-trace store per guest access. Measure with `--fast`; debug with the
  default and read its wall times as roughly 20x inflated.

## Two work fronts

### A. Hand-decomp boundaries (the verified per-boundary track)
The Update slice is `Game::Update` translated to a zero-import wasm slice with a
JS oracle + 5392-case differential. **The free boundary removals are
exhausted** — idx 2/3/4/5/8/11/22/35 are assessed and pinned (read them with
`brief.mjs <idx>`; verdicts are the `assessment20260831*` keys). All remaining
open boundaries are stays-host or narrowed; genuine removal needs shipped-path
capture blobs or depth-translation of standing blockers (entity-list
`0x4186c0`, player-entry stores `0x7abe20`, ANM2::Load, rain-create).
**Highest-value count-neutral unit:** wire the 92f1c0 receiver capture
(`opaque0092f1c0Ready/Mode/Counter/Limit/Field14/GameType0`) into
`web/js/native-update-bridge.js` `captureUpdateLanes` + the bridge suite, so
the v86→v101 narrows actually run live; then re-measure the tick. Other ready
narrow: idx 4 mode-3 `0x82eb90` fold. Rules + measured lessons: `AGENTS.md`;
unit procedure: `docs/unit-runbook.md`; archived narratives:
`docs/decomp-history.md`.

### B. Recomp machine track (the path to a running port — higher leverage)
`scripts/recomp/` statically recompiles the whole PE to wasm (**96.73%** of
.text lifted, 26 lift failures left and none of them a wide-varnode gap). A
seeded boot gets through win32 init → CRT → Steam → **EOS** → GL "4.6.0" →
libtheora/libvorbis → **two `SwapBuffers`** → 31,423 guest heap allocs (peak
53.5 MiB) → the version banner `Repentance+ v1.9.7.17.J460`, guard intact
after `main`. Reproduce:
`cd output/recomp/lift/boot && node boot_integration.mjs ../../host/isaac.segs.bin main`
(logs: `run-fix1.log` traced, `run-gu2.log` untraced).

**Round 10 (2026-09-01): the archive/asset wall is down.** Three defects,
none in the archive code: the KAGE mount-root index is a **directory scan**
over `GetFullPathNameW → FindFirstFileW/FindNextFileW → wcstombs_s` and four
of those shims were wrong (size-query returned 0; W pair stubbed; unknown
stdcall purge on the register-held `FindNextFileW`); the install's 476 loose
`resources/` files (`.anm2`, shaders, Lua, xml) had never been seeded (only
archives), and the RAM-FS capacity could not hold them; and `0x009ab970` —
the function that creates the `resources/` mount root — was one of **this
project's own emulator-era hand patches** (`push ebp; mov ebp,esp` →
`xor eax,eax; ret`; pristine bytes in `tools/isaac-ng.unpacked.exe.pre-coinit`),
now undone by the re-applicable lift patch `scripts/recomp/lift/lift_patches.py`.
Boot now: 2 mount roots, 6 archives loaded (`[0x00c37b14]=6`), **0 `Could not
open`**, all shaders init, renderbuffers, OpenAL/theora, `enums.lua`+`main.lua`
run. Run it **from the instance dir** (the host Lua's libc is NODERAWFS):
`cd .scratch/game-instance && ISAAC_FS_TRACE=1 node ../../output/recomp/lift/boot/boot_integration.mjs ../../output/recomp/host/isaac.segs.bin main`.
Host-only relink is now **~2 min** (`build_boot.py` links at `-O0` by default:
474 s → 8 s; `--opt-link` for shipping).

**Round 10b (2026-09-01): the msvcp140 iostream layer.** `host_shims_msvcp.c`
re-implements the streambuf / basic_ios / istream / ostream / iostream members
on the real MSVC x86 object layout (54 imports; abi-notes at
`output/decomp/_scratch/msvcp140/abi-notes.md`). It also found the GENERAL
baked-purge class: the lifter bakes each host-import call's stack purge into
the caller at lift time, so a purge corrected in `gen_shims.py` after a lift
needs a `PURGE_PATCHES` entry in `scripts/recomp/lift/lift_patches.py`
(`--check` lists stale sites; `build_boot.py` recompiles only the touched TUs).

**Round 11 (2026-09-02): four walls, three of them round-10 misdiagnoses
(recomp-architecture.md §20.3, §21; the rules are now in AGENTS.md).**
(1) The "callee-saved register leak" was round 10b's own curation:
`??0basic_iostream` / `??0basic_ostream` are vbase constructors and pop a
hidden `most_derived` int, so their purges are the measured 8 / 12, not the
decorated-name 4 / 8; the lifted stringstream ctor under-popped and its
epilogue restored ebx/esi/edi one slot low (`edi == cookie ^ ebp` was the
tell). (2) The instance is a ResourceExtractor dump, not a Steam layout, and
KAGE tries the archive index before a root's loose map, so round 10's restored
`resources/` root made the stale small archives (config.a's Afterbirth+
`players.xml`) shadow the Repentance+ files: the `0x009ab970` lift patch is
gone (canonical stub), the boot seeds the whole extracted tree, RAM-FS
16,384 slots. (3) The six hand-written callees in `missing_fns.c` never
emulated `ret`; each call left its return address on the guest stack
(`rc_ret(s)`, test-pinned). (4) Every `SteamXxx()` accessor other than the two init-dance slots
(`0x00bf93c8`, `0x00c5c510`) now reads NULL (`steam_fake_slots` allow-list in
`host_shims_steam.c`): the fake 16-slot vtable cannot serve real interfaces
— `ISteamUGC` +0x128 was a NULL call, and `ISteamApps::BIsDlcInstalled`
(+0x1c, pops 4) served by `CSteamAPIContext_ReleaseInterface` (pops 8)
drifted the stack and returned `edi = esi`, which is what the "dead Sprite
string" in Menu Save Init really was. Selftest-pinned and mutation-checked. New tool: the
CRT noreturn shim prints the last 512 VAs, live registers and the guest stack
from ESP (`isaac_dump_trap_context`); `recomp_mem_fault` walks the stack
too; `ISAAC_LOG_TIME=1` stamps log lines; `ISAAC_WATCH=0xLO:0xHI[:w]` is a
runtime guest-memory watch (prints writer VA + value). A full boot takes
~11-12 min of wall time, 567 s of it PNG decoding in lifted code (the
4096² font atlases dominate; §21.7) — a host PNG decode is the fix when it
matters. The guest heap layout moves between runs (time-seeded RNG): never
compare a register image from one run with a dump from another.

**Round 11c / 12 (2026-09-02, commits f9dc764, 13c1488, + frame cap):** the
import census now counts register-held loads of an IAT slot (`mov r32,[slot]`
… `call r32`), which is how `LoadImageA`, `SendMessageA` and 25 other
imports are reached; each has a signature-derived purge and a running
verdict (`tests/recomp-host.test.js` refuses a reachable NEVER_CALLED /
unknown-purge import; mutation-checked). With them the boot leaves engine
init: every menu initialises (Title … Online Awards) and the game's frame
loop runs. Its first frames re-created the render target every frame because
the GL shim answered 0 to `GL_RENDERBUFFER_WIDTH/HEIGHT`; the shim now
remembers renderbuffer storage per name (selftest 134). Because the loop only
ends on window close, `ISAAC_MAX_FRAMES=N` posts one `WM_QUIT` through
`PeekMessageW` after N presented frames (`SwapBuffers` counts and stamps
every 60th) so a run returns from `main` normally (§21.10; selftest 136).

**Measured (round 12, 5-frame bounded run):** the main loop runs at
**~135 ms per frame** in the debug build (frames 4–6: 143/137/132 ms);
frames 1–2 are the loading screen during init, frame 3 comes 418 s later
(menu init + first-frame asset loads). The cap ends the run cleanly
(`WM_QUIT` → `Isaac is shutting down...`); the first shutdown trapped on an
unlifted adjustor thunk `0x0069d1f0` (hand-written now) and the host atexit
table was silently dropping destructors past 64 (now 1024). Per-frame shim
traffic: ~40k `Enter/LeaveCriticalSection` stub calls per frame (the
biggest single cost candidate), one `_EOS_Platform_Tick`.

**Round 12d (commit bb53dfd) — the measurement that changed the plan.**
The guest-instruction profiler (`ISAAC_PROFILE=1`) blamed PNG unfilter
37% / inflate_fast 27% / adler32 8.7% / premultiply 8%. Exact host versions
of three of them (`host_fastpath.c`, installed by `lift_patches.py`
`WRAP_PATCHES` as wrappers: `ISAAC_FASTPATH=0` lifted, `ISAAC_FASTPATH_VERIFY=1`
both + byte compare, default host) verified **0 mismatches over 533 PNG
decodes** — and frame 3 still came at 416 s (418–470 s before). 54% of the
lifted instructions gone, 0 s saved: the boot's minutes are **host-side
wall time** (shims, FS, allocator, JS glue) that a tick profiler cannot
see. Shutdown now passes `~Thread` (adoption sets the done flag) and then
reached the unlifted 6-byte element destructor `0x00a67fd0` through the
CRT's `__ehvec_dtor` (hand-written in `missing_fns.c`).

**Round 12e (the profile answered):** `node --cpu-prof` on the boot put
**95.4% of wall time in `guest_malloc`** -- the round-2 first-fit walk
over every block. Replaced by segregated explicit free lists with
two-way coalescing (same header, footer added, same guards and meter;
mutation-checked pins in the selftest). **Boot to frame 3: 416 s -> 10.6 s;
frame loop 135 ms -> 1-3 ms per frame; clean shutdown, main returned 0.**
Rule added to AGENTS.md: speed units start from a wall-time profile of the
whole process, never from the guest-instruction histogram (it was off by
30x here).

**Round 12f:** the RAM-FS got a hash index (fs_find was a strcmp over
all 16,384 slots) and lazy file bytes (the driver registers the 11,197
instance files with their sizes; bytes are read on first open through
`Module.isaacLazyRead`). A 5-frame boot reads 643 files (31 MB) and takes
**12.4 s start to exit**; the host heap no longer carries the 208 MB copy.

**Round 13 (2026-09-02): THE GAME RENDERS.** `build_boot.py --web` links
the same lifted objects for the browser (host TUs rebuilt with
`-DISAAC_WEB=1`, MEMFS, WebGL2); `host_gl_webgl.c` forwards the whole
opengl32 surface to WebGL2 (the census of §21.17 showed nothing needed
translation beyond a GLSL ES precision header); `scripts/recomp/web/run_web.mjs`
runs it under Playwright's headless Chromium (SwiftShader), serving the
instance from a local HTTP server, and writes the presented frames as
PNGs. 5-frame run: main returned 0, 0 GL errors, 36 draws, frame 4 = the
main menu's paper backdrop; frame 120 of a 120-frame run = the Repentance+
Beta welcome popup, text and fonts intact. Run it:
`python scripts/recomp/lift/build_boot.py --web && node scripts/recomp/web/run_web.mjs output/recomp/web-run 120`
then open `output/recomp/web-run/frame_*.png`. `ISAAC_GL_CHECK=1` as a
trailing `K=V` argument names any GL error's caller.

**Round 14a (2026-09-02): INPUT WORKS, the menus are navigable.** Scripted
key/mouse timelines (`input=420:Enter,470:Enter,520:Enter` on the web
runner, `ISAAC_INPUT=...` on the node driver) become Win32 messages in a
real queue that GLFW's own pump and WndProc consume (§21.18). Enter x3
takes the game from the beta notice through the title to FILE SELECT and
the main menu. Gotchas recorded: the DirectInput "Message" window is
created last (keys must target the GLFW30 window), and the focus messages
must be sent before any key.

**Rounds 14b-14c (2026-09-02): the run starts.** Enter x7 (beta notice,
title, file select, NEW RUN, character select) starts a new run under
the web build. Three lifter gaps fell on the way in, each fixed in the
lifter and re-lifted (a lifter change is a whole-tree re-lift + full
recompile, ~25 min; keep gu-prev*/ for rollback): the jump-table bound
took a bare `cmp` as the table size (§21.19, censused over all 785 table
jumps), the 20k-instruction cap dropped the entity-spawn factory
`0x005d4380`, and jump tables embedded in `.text` failed whole functions
(§21.20; now soft stops). With the cap raised and the soft stops in, the tree lifts with 0 failures (23,238 functions, 42 TUs) and the spawn factory runs: the first entity spawns (Type 6, Variant 19) -- and both builds then hit V8's 'Maximum call stack size exceeded' with a flat guest stack, the subject of round 14d.

**Rounds 14d-14e:** the run's first entity spawn exposed two more
walls: guest tail jumps compiled as nested native calls (V8's "Maximum
call stack size exceeded" with a flat guest stack; fixed by the tail-jump
trampoline, §21.21 -- the loop lives only in caller frames) and the x87
register-convention CRT helpers `_CIfmod`/`_CIatan2` (§21.22). With the trampoline, the x87 helpers and the gap shims, the headless play run passes the first entity spawn with no native stack growth and no trap: the start room loads, its entities spawn, and the run is then inside a room-entry crawl -- a 20-second rapidxml attribute-parse stall (FUN_004165a0, parse_node/parse_element recursion over a document in the guest heap) with slow asset loads around it and no frame for minutes. That crawl is round 14h's wall; the V8 profile of it is the next measurement.

**Exact next unit (B):** read the first gameplay frames (web run
`input=420:Enter,470:Enter,520:Enter,580:Enter,640:Enter,700:Enter,760:Enter keep=50`,
1100 frames) and drive the player (`frame:w:30` holds W for 30 frames;
arrows shoot). Then: compare Game::Update under lifted code with the
hand-decomp slices, audio (OpenAL -> Web Audio), the per-job thread
design of §21.16, a live view (worker + OffscreenCanvas), and the PNG
chain as the remaining boot-speed unit.
walls (both index-verified, 2026-09-01): the only `CreateThread` is the
theoraplayer worker (`0x00aab120`); nothing on the init chain waits on it, so
the stub costs only video decode. **The frame loop** lives inside `main` at
`0x931231..0x931453` (entered after `0x9aa040` engine init returns): per frame
`glfwGetTime` (QPC) → `0x9ab6d0` (Steam `RunCallbacks`, EOS tick,
`push 1; call 0x954cd0` update+input: half-rate on `[Manager+0x4abbc]` parity,
`pollEvents` = `PeekMessageW`/`DispatchMessageW` loop, `GetCursorPos`, gamepad
`0xa6de60` via XInput/DirectInput COM) → `0x9555c0` render → inline
`glfwSwapBuffers` (`0xa7fb00`, `SwapBuffers` @`0xa7fb73`) → two `lua_gc` →
exit test `[window+0x1c]` (`glfwWindowShouldClose`) → pacing `Sleep(ms)`
@`0x9313cc` + spin `0x931438` until `glfwGetTime()-start ≥ 1/60`. Two spin
risks: `QueryPerformanceFrequency` must be non-zero (0 → NaN →
`Sleep(0x7fffffff)`); and `0x8fb120` mods-init starts a `_beginthreadex`
worker and renders `loading.anm2` until it joins — only when the mods vector
is non-empty (empty `mods/` skips it). GL goes through epoxy `.data` slots
(e.g. `epoxy_glClear [0xc0f960]`), not the IAT. Full analysis:
`docs/recomp-architecture.md §19`, `docs/recomp-boot.md §10`.

**Debugging tools (use these before adding a printf):**
- `ISAAC_EPOCH=<unix seconds>` — pins the run RNG seed: the same floor,
  every run (§21.40). `ISAAC_HEAP_TRACE=1` — every guest heap call with
  its result and the guest return address (§21.41). `ISAAC_ROOM_PROBE=1`
  — the door-touch inputs at every engine log line.
- `python scripts/recomp/lift/lift_patches.py --dir output/recomp/lift/gu
  --entry-first --check` — exit 1 if any goto-shaped lifted function would
  start below its entry (§21.41; `build_boot.py` applies the fix itself).
- A PROBE wrapper's "result" line is EAX when the lifted body returns to
  the wrapper — for a tail jump that is before the jump runs (§21.41).
- `ISAAC_DRIVE=explore` (node) — the automated player (§21.44);
  `ISAAC_EXPLORE_CENSUS=1` adds the NPC census; `ISAAC_INPUT_WATCH=1`
  (timeline mode) prints the engine's key-state tables every 30 frames.
  `ISAAC_DISPATCH_WATCH` counts DISPATCHED entries only (indirect calls,
  tail jumps): a direct callee reads 0 there even when it runs every frame.
- `ISAAC_SAVE_DIR=<dir>` (node) — written files persist there and seed
  back at boot (§21.46); the page's `persist=0` disables its IndexedDB store.
- `ISAAC_FS_TRACE=1` — logs every FS probe the shim answers, and how.
- `ISAAC_DUMP32=0xc379e8:4,0xc37b14:2` — prints guest dwords after `main`
  traps. Guest memory is identity-mapped into the wasm heap and the harness
  still holds the module after the abort, so an engine static costs nothing
  to read. A relink is ~7 minutes; this is free.
- `python scripts/recomp/oracle/wideops.py` — one x86 instruction at a time
  vs Unicorn. Run it before any ~17-minute full rebuild after a lifter
  change; it is what caught the Ghidra SLEIGH `PSLLD`/`PSLLQ` per-lane-count
  defect that had been silently miscompiling 12 real sites.

**Rebuilding** (only if you change the lifter): `lift_parallel.py --jobs 12
<the emit.py argv recorded in output/recomp/lift/gu/summary.json → argv>`
(**80 s on 12 cores**, byte-identical to the 1,460-s sequential `emit.py`,
recomp-architecture.md §21.26) → `patch_reentry.py --dir output/recomp/lift/gu
--exe tools/isaac-ng.unpacked.exe --cont output/recomp/lift/gu/call_cont.txt`
→ `build_boot.py --dir output/recomp/lift/gu` (recompiles only the TUs whose
text changed, §21.24; a full compile is ~576 s, the -O0 link ~8 s). `--trace-va` and
`--hand-written` are both load-bearing — without `--trace-va`
`dispatch_tbl.c` does not even compile. **A host-only change needs no
re-lift**: `build_boot.py` reuses the lifted objects (~16 s + ~355 s link).

**Rounds 14h-14i (2026-09-02): the crawl measured, the lift parallel.**
The room-entry crawl (nothing logged for 20 s at a time after the first
spawn) is *not* the dispatcher's table (census: 24.4 M dispatches, 0 misses;
bench `ISAAC_BENCH_DISPATCH`: 0.11 us per dispatch) and *not* V8 lazy
compilation (`--trace-wasm-compilation-times`: Liftoff 1.1 s total by the
first room, TurboFan 20.6 s on background threads), yet the V8 profile puts
61 s of *self* time in `isaac_lifted_dispatch` under one per-room reset
(`sub_007f2800`). **Round 14j then found it is not guest work at all** (§21.27): a V8
`--prof` tick log of the silent window puts 65% of ticks in ntdll.dll
directly under the `call_indirect`, the process at 100% CPU and not
paging, no compile churn, and the phase's wall time nondeterministic (two
runs exit after ~100 s with identical dispatch counts, four sit for hours).
Symbolized (`scripts/recomp/profile/prof_ntdll.py`, then capstone on
ntdll): 3,312 of the 3,587 ntdll ticks sit on ONE instruction of an
unexported free-list walk in the Windows NT heap allocator (a linked-list
loop checking encoded block headers, ntdll RVA 0x102da), i.e. node's
malloc/free on the main thread, called by V8 under the call_indirect (lazy
compiles, code publishing). A fragmented NT heap walks O(n) per call, which
is why the wall time depends on allocation history. This is Windows-node
specific: Chrome (PartitionAlloc) and Linux (glibc) do not have that walk.
**Round 15c (2026-09-03): THE GAME PLAYS -- the room-entry crawl was a
missing `case` label** (§21.30). A lifted function's dispatch loop starts
`pc_ = <entry>`, but the block set that gets `case` labels came from
`block_starts()`, which marks branch targets and the lowest address in the
body -- so a function whose body absorbed a lower range had no case for its
own entry, fell to `default:`, parked a jump to itself and was dispatched
again forever, executing no guest instruction (3.8 billion dispatches of
`sub_0093805f` at 20 M/s, found with the new `ISAAC_HEARTBEAT=<n>`). Six
functions had it. The fix is `block_starts(body) | {start}` in `lift.py`;
`check_lifted.py` now enforces the invariant inside `build_boot.py`, and
`recomp_run_pending` aborts on a no-progress park cycle instead of
spinning. The same scripted run now presents **13,860 frames at a median
4 ms**, does **654 room transitions**, and exits on its budget. Next: one
45-s stall that remains early in the engine `Mutex` path (`0x00a157f0`),
which recovers.

**Rounds 15d-15e:** the game opens `music.a` and `videos.a` once it is
playing, so both drivers now seed them lazily (registered by size, read on
first open). That pushes the module past `INITIAL_MEMORY`, and growing a
wasm memory copies the whole heap -- a 200-s play run went from 7,980
frames to **900** until the default was raised. It is **768 MiB** now
(`--initial-memory` overrides; 1536 MiB buys another ~10%). Also: the
stub-hit recorder was a linear scan run on all 66.5 M stub calls of a
ten-minute run and is now an import-index table.

**Round 15a claimed `--no-wasm-tier-up` was 41x; round 15b withdrew it**
(§21.28-21.29). The baseline's ~4,400-s silent phase is real; the flag
run's 145 s was this session killing it, and an independent run with the
flag stayed silent past 250 s. What survives: both runs log the same
1,577 stamped lines, and menu frames were a median 33 ms with the flag
against 38 without.

**Two harness defects made that measurement unfalsifiable, both now
fixed** -- and both are worth knowing before you measure anything:
- The `RECOMP_VA` tick was every 2^20 lifted instructions, which inside
  the crawl is minutes, so no wall-clock deadline (`ISAAC_EXIT_AFTER`,
  the stall watchdog, `ISAAC_PROFILE`) could fire there. Now
  `RECOMP_TICK_MASK`, 2^16.
- `build_boot.py` hashed only each TU's own text, so a `recomp_rt.h` edit
  rebuilt nothing. The hash now folds in all headers + the flags and
  prints `lift : dependency fingerprint <hex>`.

**Next:** the fair A/B is equal wall budget, not time-to-finish -- same
`ISAAC_EXIT_AFTER` with and without `ISAAC_V8_FLAGS=--no-wasm-tier-up`,
comparing how far the guest got. Then the same in Chromium (`tierup=0`),
which is the one that matters for the port. If both crawl, split the giant
lifted functions (`0x005d4380` is 42,671 instructions). **Next:** the flag batch
(`--no-wasm-tier-up`, `--no-wasm-dynamic-tiering`, `--no-wasm-inlining`)
via `scripts/recomp/profile/prof_stuck.ps1 -NodeFlags ...`, eager
compilation with a long wait, and splitting the giant lifted functions.
The lift is parallel and byte-identical (above, §21.25-21.26).

## Ground rules that bite (from AGENTS.md, do not relearn the hard way)
- The tree wins over any doc "checkpoint" number — status.mjs is truth.
- Counts are exact index censuses, never `~`; zero-at-load `.data` is constant
  only with an empty writer census bounded to the censused range.
- Green can lie six ways (see AGENTS.md); mutation-check every new assertion
  **through `mutate.mjs`**, never by hand-editing a tracked file.
- Never hardcode the ABI number in a test — pin against the family's
  `*_ABI_VERSION` and `HEADER_ABI_VERSION`; the preflight refuses literals.
- `decomp/game-update-slice.json` is written only by `slice-json.mjs sync`.
- Commit a landed unit before the session ends; an uncommitted unit is
  invisible to the next session's orientation.
- Original-binary defects are reproduced and pinned, never "fixed".
- A curated import purge must equal the callee's `ret N` (hidden MSVC
  params: vbase `most_derived`, by-value class returns), and every
  hand-written guest callee must emulate its `ret`. A callee-saved register
  holding `cookie ^ ebp` names the frame whose epilogue popped one slot low.
- The instance is an extracted tree; the canonical exe's `0x009ab970` patch
  (no `resources/` root) is load-bearing. Do not restore it.
- Tooling note for Claude Code sessions on this machine: heredocs through the
  Bash tool lose backslashes (`\s` → `s`) — a C `"
"` written that way
  became a raw newline and broke a build; write such files with the Write
  tool or spell backslashes as `String.fromCharCode(92)`.
