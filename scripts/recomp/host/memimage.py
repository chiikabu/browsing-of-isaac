"""Build the initial wasm linear-memory image from the PE.

Addressing model is IDENTITY: guest VA == wasm linear-memory byte offset. The
image therefore occupies [imageBase, imageBase+SizeOfImage) of linear memory and
nothing has to be relocated or marshalled.

Produces three shippable forms so the size/complexity tradeoff is a measurement
rather than an opinion:

  A. flat      isaac.mem            one contiguous span, memcpy'd at boot
  B. segmented isaac.segs.bin       zero runs >= threshold elided, + index
  C. wasm data isaac.data.wasm      segments wrapped in a passive-data wasm module

Each is also compressed with gzip and brotli, because what ships is the
compressed bytes, not the raw ones.

Run:  python scripts/recomp/host/memimage.py
"""

import gzip
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, hexva  # noqa: E402

# A zero run shorter than this costs more in index bytes than it saves.
ZERO_RUN_THRESHOLD = 256

# .reloc is 379,392 bytes that nothing reads once the image is mapped at its
# preferred base. Dropping it is the single largest free win in the image.
DROP_SECTIONS = {".reloc"}


def try_brotli(data, quality=11):
    try:
        import brotli  # type: ignore
        return brotli.compress(data, quality=quality)
    except ImportError:
        pass
    # Fall back to node, which has brotli in core.
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "in.bin"
        dst = Path(td) / "out.br"
        src.write_bytes(data)
        js = (
            "const fs=require('fs'),z=require('zlib');"
            "const b=fs.readFileSync(process.argv[1]);"
            "fs.writeFileSync(process.argv[2], z.brotliCompressSync(b,{params:{"
            "[z.constants.BROTLI_PARAM_QUALITY]:11,"
            "[z.constants.BROTLI_PARAM_SIZE_HINT]:b.length}}));"
        )
        r = subprocess.run(["node", "-e", js, str(src), str(dst)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            return None
        return dst.read_bytes()


def build_image(pe, drop=DROP_SECTIONS):
    """Materialise the loader's view of the image into one bytearray.

    Mirrors what the Windows loader does: zero the whole reservation, then copy
    each section's raw bytes to its RVA. Bytes beyond a section's raw size (the
    BSS-like tail) stay zero, which is exactly the semantics .data needs.
    """
    size = pe.size_of_image
    img = bytearray(size)
    placed = []

    # PE headers. __scrt_is_managed_app() dereferences __ImageBase and reads the
    # COM descriptor directory out of the optional header, so the headers are
    # load-bearing, not decoration.
    hdr = min(pe.size_of_headers, len(pe.data))
    img[0:hdr] = pe.data[0:hdr]
    placed.append({"name": "(headers)", "rva": 0, "bytes": hdr, "zeroTail": 0})

    for s in pe.sections:
        if s.name in drop:
            placed.append({"name": s.name, "rva": s.rva, "bytes": 0,
                           "zeroTail": s.virtual_span, "dropped": True})
            continue
        n = min(s.raw_size, s.virtual_span)
        if n:
            img[s.rva:s.rva + n] = pe.data[s.raw_offset:s.raw_offset + n]
        placed.append({"name": s.name, "rva": s.rva, "bytes": n,
                       "zeroTail": s.virtual_span - n, "dropped": False})
    return img, placed


def segment(img, threshold=ZERO_RUN_THRESHOLD):
    """Split into non-zero segments, eliding zero runs >= threshold."""
    segs = []
    i, n = 0, len(img)
    while i < n:
        while i < n and img[i] == 0:
            i += 1
        if i >= n:
            break
        start = i
        run0 = 0
        j = i
        while j < n:
            if img[j] == 0:
                run0 += 1
                if run0 >= threshold:
                    break
            else:
                run0 = 0
            j += 1
        end = j - run0 if run0 >= threshold else j
        segs.append((start, bytes(img[start:end])))
        i = j
    return segs


def pack_segments(segs, image_base):
    """Simple self-describing container:
         magic 'ISMG' u32 | version u32 | count u32 | imageBase u32
         then count * (vaddr u32, len u32) then the payloads back to back.
    """
    head = bytearray()
    head += b"ISMG"
    head += struct.pack("<III", 1, len(segs), image_base)
    for rva, blob in segs:
        head += struct.pack("<II", image_base + rva, len(blob))
    body = b"".join(blob for _, blob in segs)
    return bytes(head) + body


# --- wasm passive-data module ------------------------------------------------
def uleb(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def sleb(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        done = (n == 0 and not (b & 0x40)) or (n == -1 and (b & 0x40))
        out.append(b | (0 if done else 0x80))
        if done:
            return bytes(out)


def build_data_wasm(segs, image_base, mem_pages):
    """Emit a wasm module whose only job is to carry the image as ACTIVE data
    segments against an imported memory. Instantiating it against the runtime's
    memory places every byte at its guest VA with no JS-side copy loop.
    """
    def section(sid, payload):
        return bytes([sid]) + uleb(len(payload)) + payload

    # type: () -> ()
    types = uleb(1) + b"\x60" + uleb(0) + uleb(0)
    # import: (memory "env" "memory" min=mem_pages)
    imp = bytearray()
    imp += uleb(1)
    imp += uleb(3) + b"env" + uleb(6) + b"memory" + b"\x02" + b"\x00" + uleb(mem_pages)
    # data section: active, memidx 0, offset i32.const VA
    data = bytearray()
    data += uleb(len(segs))
    for rva, blob in segs:
        data += uleb(0)                                   # active, memory 0
        data += b"\x41" + sleb(image_base + rva) + b"\x0b"  # i32.const VA; end
        data += uleb(len(blob)) + blob
    mod = bytearray(b"\x00asm\x01\x00\x00\x00")
    mod += section(1, types)
    mod += section(2, bytes(imp))
    mod += section(11, bytes(data))
    return bytes(mod)


def fmt(n):
    return "{:,}".format(n)


def main():
    pe = PE()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    img, placed = build_image(pe)
    full, placed_full = build_image(pe, drop=set())

    # Trim the trailing zeros of the flat form -- shipping them is pure waste.
    end = len(img)
    while end > 0 and img[end - 1] == 0:
        end -= 1
    flat = bytes(img[:end])

    segs = segment(img)
    packed = pack_segments(segs, pe.image_base)
    mem_pages = (pe.image_base + pe.size_of_image + 0xFFFF) // 0x10000
    dwasm = build_data_wasm(segs, pe.image_base, mem_pages)

    variants = {}
    for name, blob in (("flat", flat), ("segmented", packed), ("data-wasm", dwasm),
                       ("flat-with-reloc", bytes(full))):
        gz = gzip.compress(blob, 9)
        br = try_brotli(blob)
        variants[name] = {
            "raw": len(blob),
            "gzip": len(gz),
            "brotli": len(br) if br else None,
            "gzipRatio": round(len(gz) / len(blob), 4),
            "brotliRatio": round(len(br) / len(blob), 4) if br else None,
        }
        if name == "flat":
            (OUT_DIR / "isaac.mem").write_bytes(blob)
            if br:
                (OUT_DIR / "isaac.mem.br").write_bytes(br)
        elif name == "segmented":
            (OUT_DIR / "isaac.segs.bin").write_bytes(blob)
            if br:
                (OUT_DIR / "isaac.segs.bin.br").write_bytes(br)
        elif name == "data-wasm":
            (OUT_DIR / "isaac.data.wasm").write_bytes(blob)
            if br:
                (OUT_DIR / "isaac.data.wasm.br").write_bytes(br)

    nonzero = sum(1 for b in img if b)
    seg_bytes = sum(len(b) for _, b in segs)

    meta = {
        "addressingModel": "identity: guest VA == wasm linear memory offset",
        "imageBase": pe.image_base,
        "imageBaseHex": hexva(pe.image_base),
        "sizeOfImage": pe.size_of_image,
        "imageSpanVa": [hexva(pe.image_base),
                        hexva(pe.image_base + pe.size_of_image)],
        "minimumWasmMemoryPages": mem_pages,
        "minimumWasmMemoryBytes": mem_pages * 65536,
        "droppedSections": sorted(DROP_SECTIONS),
        "zeroRunThreshold": ZERO_RUN_THRESHOLD,
        "materialisedBytesNonZero": nonzero,
        "flatTrimmedLength": len(flat),
        "segmentCount": len(segs),
        "segmentPayloadBytes": seg_bytes,
        "placement": placed,
        "placementWithReloc": placed_full,
        "variants": variants,
        "segments": [{"va": hexva(pe.image_base + rva), "len": len(b)}
                     for rva, b in segs],
    }
    (OUT_DIR / "memimage.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")

    print("addressing      : identity (guest VA == linear-memory offset)")
    print("image span      : %s .. %s  (SizeOfImage %s)" % (
        hexva(pe.image_base), hexva(pe.image_base + pe.size_of_image),
        fmt(pe.size_of_image)))
    print("wasm memory min : %d pages = %s bytes" % (mem_pages, fmt(mem_pages * 65536)))
    print()
    print("placement:")
    for p in placed:
        print("  %-10s rva 0x%06x  copied %10s  zero-tail %9s %s" % (
            p["name"], p["rva"], fmt(p["bytes"]), fmt(p["zeroTail"]),
            "  <-- DROPPED" if p.get("dropped") else ""))
    print()
    print("non-zero bytes in materialised image: %s" % fmt(nonzero))
    print("segments (zero runs >= %d elided): %d, payload %s" % (
        ZERO_RUN_THRESHOLD, len(segs), fmt(seg_bytes)))
    print()
    print("%-18s %>12s %>12s %>12s" .replace(">", "") % (
        "variant", "raw", "gzip", "brotli"))
    for k, v in variants.items():
        print("  %-16s %12s %12s %12s   (br %.1f%% of raw)" % (
            k, fmt(v["raw"]), fmt(v["gzip"]),
            fmt(v["brotli"]) if v["brotli"] else "n/a",
            100.0 * v["brotliRatio"] if v["brotliRatio"] else 0))
    print()
    print("wrote %s" % (OUT_DIR / "isaac.mem"))
    print("wrote %s" % (OUT_DIR / "isaac.segs.bin"))
    print("wrote %s" % (OUT_DIR / "isaac.data.wasm"))
    print("wrote %s" % (OUT_DIR / "memimage.json"))


if __name__ == "__main__":
    main()
