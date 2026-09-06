"""Bulk differential validation: lifted wasm vs. the Unicorn oracle.

Picks leaf functions (no calls of any kind, so the module is
self-contained), asks the oracle for ground-truth vectors, and writes a
compact binary the wasm harness replays.  Comparing thousands of
functions this way is the only correctness argument that scales; the
hand-written differential harness only ever covered three.

Binary format (little-endian), consumed by oracle_replay.c:

  u32 magic 'ORCL'   u32 n_funcs
  per function:  u32 va   u32 n_vectors
    per vector:  u32 ecx  u32 edx  u32 n_stack  u32 stack[n_stack]
                 u32 n_mem    (u32 addr, u32 len, u8 bytes[len]) * n_mem
                 u32 eax edx ecx ebx esi edi ebp esp_delta
                 u32 n_writes (u32 addr, u32 len, u8 bytes[len]) * n_writes
"""

import argparse
import json
import os
import struct
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "oracle"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def pick_leaves(inv_path, lifted, max_bytes, limit):
    out = []
    with open(inv_path, encoding="utf8") as fh:
        for line in fh:
            d = json.loads(line)
            if not d.get("inText"):
                continue
            va = int(d["va"], 16)
            if va not in lifted:
                continue
            if d.get("directCalls") or d.get("indirectCalls") or \
                    d.get("computedJumps"):
                continue
            n = d.get("bodyBytes", 0)
            if n < 4 or n > max_bytes:
                continue
            out.append((va, n))
    out.sort(key=lambda t: t[0])
    if limit:
        step = max(1, len(out) // limit)
        out = out[::step][:limit]
    return [va for va, _ in out]


def pack(vs):
    buf = bytearray()
    buf += struct.pack("<II", vs["ecx"], vs["edx"])
    st = vs["stack"]
    buf += struct.pack("<I", len(st))
    for v in st:
        buf += struct.pack("<I", v)
    return buf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="lifted module dir")
    ap.add_argument("--inventory",
                    default="output/recomp/export/functions.jsonl")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vas", help="file of VAs to use instead of leaf picking")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--max-bytes", type=int, default=400)
    ap.add_argument("--exe", default="tools/isaac-ng.unpacked.exe")
    args = ap.parse_args()

    import re
    import glob
    lifted = set()
    for f in glob.glob(os.path.join(args.dir, "lifted*.c")):
        with open(f, encoding="utf8") as fh:
            lifted.update(int(m, 16) for m in re.findall(
                r"^void sub_([0-9a-f]{8})\(CpuState", fh.read(), re.M))

    if args.vas:
        vas = [int(l, 16) for l in open(args.vas) if l.strip()]
        vas = [v for v in vas if v in lifted]
    else:
        vas = pick_leaves(args.inventory, lifted, args.max_bytes, args.limit)
    print("candidate leaf functions: %d" % len(vas))

    from api import OracleSession
    body = bytearray()
    nf = 0
    nvec_total = 0
    kept = []
    t0 = time.time()
    with OracleSession(exe=args.exe) as s:
        for i, va in enumerate(vas):
            try:
                r = s.vectors(va, n=args.n, pure_only=True)
            except Exception as e:                     # noqa: BLE001
                continue
            vecs = [v for v in r.vectors if v.get("pure")
                    and v.get("term") == "ret" and not v.get("calls")]
            if not vecs:
                continue
            fb = bytearray()
            for v in vecs:
                rec = bytearray()
                inp = v["in"]
                rec += pack(inp)
                mem = inp.get("mem") or []
                rec += struct.pack("<I", len(mem))
                for m in mem:
                    b = bytes.fromhex(m["d"])
                    rec += struct.pack("<II", m["a"], len(b)) + b
                o = v["out"]
                rec += struct.pack("<8I", o["eax"], o["edx"], o["ecx"],
                                   o["ebx"], o["esi"], o["edi"], o["ebp"],
                                   o["esp_delta"] & 0xFFFFFFFF)
                w = v.get("writes") or []
                rec += struct.pack("<I", len(w))
                for m in w:
                    b = bytes.fromhex(m["d"])
                    rec += struct.pack("<II", m["a"], len(b)) + b
                # flat, self-delimiting: [total_len][va][payload]
                fb += struct.pack("<II", len(rec) + 8, va) + rec
            body += fb
            nvec_total += len(vecs)
            nf += 1
            kept.append(va)
            if (i + 1) % 50 == 0:
                print("  %d/%d  kept %d  %.0fs"
                      % (i + 1, len(vas), nf, time.time() - t0))

    with open(args.out, "wb") as fh:
        fh.write(struct.pack("<III", 0x4C43524F, nf, nvec_total))
        fh.write(body)
    with open(args.out + ".vas", "w") as fh:
        for v in kept:
            fh.write("%#010x\n" % v)
    print("wrote %s: %d functions, %d bytes, %.0fs"
          % (args.out, nf, len(body) + 8, time.time() - t0))


if __name__ == "__main__":
    main()
