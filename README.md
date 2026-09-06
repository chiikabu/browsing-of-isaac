# the-browsing-of-isaac

Static recompilation of *The Binding of Isaac: Repentance* (Windows x86) to
WebAssembly. Ghidra p-code to C to Emscripten, linked against a host layer that
implements the Win32, OpenGL, OpenAL and CRT calls the engine makes. No
interpreter, no emulator, no gameplay reimplemented. Engine code is not patched;
original bugs are reproduced, not fixed.

**This repo contains no game data, no lifted sources and no compiled module.**
Those are derived from a copyrighted executable and are built locally from your
own copy.

## Layout

| | |
|---|---|
| `scripts/recomp/host` | host layer, ~25k lines of C, plus hand-written fast paths |
| `scripts/recomp/lift` | p-code lifter, codegen, `build_boot.py` |
| `scripts/recomp/assets` | KAGE archive format, bundle/ship/portable/modpack |
| `scripts/recomp/web` | page, boot pipeline, Playwright drivers |
| `tests` | `node:test` suites |
| `docs` | build notes, round by round |

## Requirements

Python 3.11+, Node 20+, emsdk, Ghidra, and a copy of the game. First build is a
couple of hours, mostly lifter and linker.

## Build

```sh
npm install

# tables and memory image, read from your own exe
python scripts/recomp/host/boot_tables.py
python scripts/recomp/host/memimage.py
python scripts/recomp/host/verify_memimage.py
python scripts/recomp/host/gen_shims.py

# lift (slow)
python scripts/recomp/lift/lift.py
python scripts/recomp/lift/lift_patches.py --dir output/recomp/lift/gu

# host selftest before anything bigger
python scripts/recomp/host/build_selftest.py

# assets and dist
python scripts/recomp/assets/bundle.py build <game-dir> .scratch/game-bundle --strict
python scripts/recomp/assets/ship.py build

# module, then serve
python scripts/recomp/lift/build_boot.py --web --fast
node scripts/recomp/web/serve_dist.mjs .scratch/game-dist 8000
```

Optional asset passes, in this order, before `ship.py`:

```sh
python scripts/recomp/assets/optimize.py music     <in.a> <out.a> --quality 2
python scripts/recomp/assets/optimize.py halve-sfx <in.a> <out.a>
python scripts/recomp/assets/optimize.py layout    <in.a> <out.a> --order <order.txt>
python scripts/recomp/assets/optimize.py huffman   <in.a> <out.a>
```

`huffman` packs static-Huffman deflate blocks. The format flushes every 0x400
bytes, so each block carried its own Huffman header; building those tables was
77.6% of archive inflate time. Costs ~1% of bundle size.

## Portable builds

The shipping page (payload on jsDelivr, this repo has no game data):

https://chiikabu.github.io/the-browsing-of-isaac/

```sh
# single .html, payload inline, no network
python scripts/recomp/assets/portable.py offline .scratch/game-dist out/isaac.html

# page + payload beside it, for a static host
python scripts/recomp/assets/portable.py chunks .scratch/game-dist out/ --chunks 33 \
    --base https://cdn.jsdelivr.net/gh/chiikabu/boi-portable@main/c
```

Payload is split by access pattern, not size. Whole-read files are gzipped; the
four windowed archives are stored raw on 1 MiB boundaries and fetched with
`Range`, the range carried in the URL fragment. Hosts that ignore `Range` get
whole chunks instead. `--chunks 33` keeps every file under jsDelivr's 20 MB
limit. Chunks are XOR-scrambled and the inlined modules minified by default;
`--plain` disables both.

## Mods

`IMPORT MOD` in the in-game mods list opens a picker. `.zip` or folder, stored
in IndexedDB (`isaac-mods`, separate from saves) and seeded before `main`, so
the engine's own directory scan finds them. RAR/7z are rejected; no browser can
decode them.

Enabled state is kept by the page, not the engine. The engine writes
`disable.it` and greys the row, then ignores that file on the next start, so a
disabled mod is simply not seeded.

`modpack.py` builds a browsable catalogue for a CDN:

```sh
python scripts/recomp/assets/modpack.py <mods-dir> out/mods --base https://cdn.example.com/mods
```

## Tests

```sh
npm test
python scripts/recomp/host/build_selftest.py
```

Drivers under `scripts/recomp/web` (`drive_boot`, `drive_saves`, `drive_mods`,
`drive_floors`, `profile_play`, ...) run the real page in headless Chrome.

## Notes

`docs/HANDOFF.md` to orient, `docs/recomp-architecture.md` for the long version,
including the changes that measured worse and were reverted.

## Disclaimer

*The Binding of Isaac: Repentance* is property of Nicalis, Inc. and Edmund
McMillen. Not affiliated with or endorsed by them. No game code or assets here;
the tools operate on a copy you already own, and their output is not
redistributable. Personal project, no warranty.
