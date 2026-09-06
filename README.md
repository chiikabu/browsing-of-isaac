# the browsing of isaac

*The Binding of Isaac: Repentance* runs in a browser here, at 60 fps, with the
original x86 code translated ahead of time. There is no interpreter and no
emulator, and none of the gameplay has been rewritten. The Windows build's
executable is lifted to C and compiled to WebAssembly, and a host layer answers
the Win32, OpenGL, OpenAL and CRT calls the engine makes.

**No game data and no compiled binary is in this repository.** What is here is
the build system, the host layer, the tests, and the notes taken while it was
built. You point it at your own copy of the game and it produces the rest on
your machine.

## How it works

Ghidra lifts the executable to p-code, a lifter turns that into C, and
Emscripten compiles it with the host layer. The engine's own code is not
touched. Where the original has a bug, so does this: reproducing the binary is
the point, and a "fix" that changes behaviour is a defect.

Three parts are worth reading on their own.

`scripts/recomp/host` is about 25,000 lines of C sitting behind the Windows
surfaces the engine uses, plus hand-written fast paths for the dozen functions
the profiler kept naming. `scripts/recomp/assets` is a reimplementation of
Isaac's KAGE archive format, checked against 27,236 entries across 22 archives,
used to unpack, repack and re-lay-out the game's data. `scripts/recomp/web` is
the page itself and about a dozen drivers that measure it: boot time, memory,
frame rate, save round trips, floor sweeps, mod imports.

What is deliberately absent is the instruments. A PE census produced the
function and import counts quoted below, an x86 emulator and a differential
harness checked lifted functions against real execution while the lift was
happening, and a set of Windows-native samplers predates the browser drivers.
None of them is needed to build this, run it or check it, so none of them is
here. Where a comment credits one for a finding, the finding itself is in the
notes.

## What the work was

Everything below was measured on one machine, in Chrome, with a 4x CPU throttle
standing in for a slower laptop and a fresh profile each time. "First visit"
counts the archive traffic before the title screen appears.

| | at the start | now |
|---|---|---|
| first visit, archive traffic | 442 windows, 440 MB | 177 windows, 176 MB |
| title screen on a 50 Mbit link | 80.5 s | 54.6 s |
| shipping bundle | 734 MB | 587 MB |
| committed WebAssembly memory | 1,088 MiB | 704 MiB |
| renderer private bytes | about 1.5 GB | 1,088 MB |
| gameplay | 60 fps | 60 fps |

Most of that came from five changes.

**The archive was laid out in the order the boot reads it.** The engine
preloads its entire sound catalogue before the title screen, in `sounds.xml`
document order, and the shipped archive scatters those entries across the file.
Reading them walked backwards 246 times and refetched windows the cache had
already dropped. Taking the order from the engine's own `fread` trace and
laying the entries out that way made every window a single forward fetch.

**Half the sound catalogue was describing silence.** 976 of the 1,553 preloaded
WAVs carry less than 0.5% of their energy above 11 kHz. Those are filtered and
decimated 2:1. The 577 with real treble, coin drops and chain breaks and the
like, are left alone. The catalogue went from 265 MB to 163.

**The guest heap was three times the size the game uses.** The allocator's own
high-water mark reads 249 MiB after 6,000 frames and the arena was 768 MiB.
A WebAssembly memory is committed the moment it is created, so that was
resident on every machine that opened the page. It is 384 MiB now.

**Most of the archive inflate was Huffman tables, not bytes.** The format cuts
every entry into 1 KiB pieces and flushes each one, so each kilobyte carried its
own Huffman header and cost the decoder a table build. On 20 MB of real entries,
decoded the way the engine decodes them, dynamic Huffman managed 189.7 MB/s and
static Huffman 862.7. Both halves of the fix were needed, and finding that out
took a second measurement: zlib keeps the fixed tables precomputed, but the
engine's inflater is miniz, which rebuilds them for a static block as well. So
the packer emits static blocks and the decoder keeps the tables the first one
builds. The loading window went from 54.5 to 45.1 ms per frame at a
4x CPU throttle and the inflater from 23.3% of the profile to 9.4%, for 5.4 MB
on a 587 MB download. The frames it draws are hash-identical to the ones before
the change.

**Some things measured worse than doing nothing.** Those are written down so
nobody tries them twice: batching draw calls (3 merges in 50,515 draws, because
the engine binds a different sheet between three of every four), compressing
the halved sample data (28 MB saved against 163 MB pushed through the
inflater), PNG palette reduction (the engine's image loader takes 8-bit
RGB/RGBA and traps on anything else), and storing PNG entries instead of
deflating them (1.1% of the inflate for 3.7 MB).

## Building it

You need a copy of the game, Python 3.11 or newer, Node 20 or newer, the
Emscripten SDK and Ghidra. Everything derived from the executable is produced
on your machine, because none of it can be distributed. Budget a couple of
hours for the first build; most of that is the lifter and the compiler.

```
git clone <this repo> && cd browsing-of-isaac
npm install

# 1. tables and the memory image, read out of your own copy of the exe
python scripts/recomp/host/boot_tables.py
python scripts/recomp/host/memimage.py
python scripts/recomp/host/verify_memimage.py     # 26 checks against the PE
python scripts/recomp/host/gen_shims.py           # the import table becomes shim_table.c

# 2. lift the executable through Ghidra's p-code (the long one)
python scripts/recomp/lift/lift.py
python scripts/recomp/lift/lift_patches.py --dir output/recomp/lift/gu

# 3. the host layer's own checks, before anything larger
python scripts/recomp/host/build_selftest.py

# 4. the asset bundle and the shipping dist
python scripts/recomp/assets/bundle.py build <your-game-dir> .scratch/game-bundle --strict
python scripts/recomp/assets/ship.py build

# 5. the module, and a server for it
python scripts/recomp/lift/build_boot.py --web --fast
node scripts/recomp/web/serve_dist.mjs .scratch/game-dist 8000
```

The asset passes in step 4 are optional and worth running once, in this order:

```
python scripts/recomp/assets/optimize.py music <in.a> <out.a> --quality 2
python scripts/recomp/assets/optimize.py halve-sfx <in.a> <out.a>
python scripts/recomp/assets/optimize.py layout <in.a> <out.a> --order <order.txt>
python scripts/recomp/assets/optimize.py huffman <in.a> <out.a>
```

`docs/HANDOFF.md` is a one-page orientation. `docs/recomp-architecture.md` is
the long version, written round by round as the work happened, including the
measurements that said no.

### A page that carries the game

`scripts/recomp/assets/portable.py` turns a finished dist into one of two
shapes:

```
# one .html with the whole payload inline and no network at all
python scripts/recomp/assets/portable.py offline .scratch/game-dist out/isaac.html

# a 289 KB page plus the payload beside it, for any static host
python scripts/recomp/assets/portable.py chunks .scratch/game-dist out/ --chunks 33 \
    --base https://cdn.jsdelivr.net/gh/you/your-payload-repo@v1/c
```

The single file came out at 825 MB here and reaches the title screen in about
15 seconds off a local disk. The chunked build is 33 files; `--chunks 33` is
what keeps every piece under 20 MB, which is the largest file jsDelivr will
serve.

By default the chunks are scrambled with a seekable keystream and the inlined
modules are minified, so a file sitting on a CDN is noise rather than a
recognisable game archive. It is obscurity and not secrecy: the key is in the
page, because the page has to read its own payload. `--plain` turns both off.
While it loads, the status line says which chunk it is on.

The payload is split by how it is read, not by size. Everything the boot reads
whole is gzipped and fetched whole. The four archives the engine reads as 1 MiB
windows are stored raw, laid out on the window boundary, and fetched as HTTP
ranges, with the range carried in the URL fragment so that no server ever sees
it. A host that ignores `Range` is noticed on the first request and gets whole
chunks from then on, which is slower but works.

The payload is the game, so it is not in this repository and there is nothing
here to point a CDN at. Build it from your own copy and host it yourself.

### Mods

The game's own mods list has a row called IMPORT MOD, which is itself a mod the
page seeds. Enter on it opens a menu drawn on the game's own paper, in the
game's own font, with the game's own cursor and menu sounds. From there a .zip
or a folder is read in the browser and kept there, so the file you picked can be
deleted afterwards. Mods live in a database of their own, separate from the
saves, and the engine finds them on its next start through its own directory
scan. RAR and 7z are refused with a message rather than half-read, because no
browser can open either.

Turning a mod off is the page's job, not the engine's. The engine writes a
`disable.it` into the mod's folder and greys the row, and then ignores that file
at the next start; the fs layer's trace shows the scan handing the file back and
the mod loading anyway. So the page reads that write for what it means, keeps the
flag itself, and a mod that is off is simply not seeded.

There is also a mod browser. `scripts/recomp/assets/modpack.py` turns a folder of
mods into a catalogue and the parts that back it, every part under jsDelivr's
20 MB ceiling:

```
python scripts/recomp/assets/modpack.py <your-mods-folder> out/mods --base https://cdn.example.com/mods
```

Nothing is bundled: the page fetches the catalogue when the browser is opened,
and a mod only when it is asked for. On a folder of 33 mods that came to 32 mods
and 89.8 MB in 34 parts; the 33rd was a 371 MB music pack, left out because the
page can only seed 96 MB into the guest heap.

## Tests

```
npm test
python scripts/recomp/host/build_selftest.py
```

That is about 4,000 assertions over the lifter, the host layer, the
archive format and the page, plus 391 checks inside the compiled host itself.
The drivers under `scripts/recomp/web` are the other half of it: they run the
real thing in a real browser and report what it did.

## A disclaimer

*The Binding of Isaac: Repentance* is the property of Nicalis, Inc. and Edmund
McMillen. This project is not affiliated with them and is not endorsed by them.
It contains no game code and no game assets. The tools here work on a copy you
already own, on your own machine, and what they produce is not redistributable.

This is a personal project with no warranty of any kind. It reproduces the
original binary's behaviour, bugs included, on purpose.
