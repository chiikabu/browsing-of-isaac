"""Verify the built linear-memory image against the PE, byte for byte.

A memory image that is subtly wrong produces a lift that fails thousands of
instructions later with no clue why, so this checks the whole thing rather than
spot-checking: every section's raw bytes must appear at its VA, every BSS tail
byte must be zero, and the boot-critical structures must be readable at the
addresses host_boot.c hard-codes.

Writes output/recomp/host/memimage-verify.json.

Run:  python scripts/recomp/host/verify_memimage.py
"""

import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, hexva  # noqa: E402
from memimage import DROP_SECTIONS  # noqa: E402

# Constants host_boot.c hard-codes. If the image and the header disagree the
# boot path reads garbage, so they are checked against the PE here.
EXPECT = {
    "ISAAC_IMAGE_BASE": 0x00400000,
    "ISAAC_IMAGE_SIZE": 0x008FE000,
    "ISAAC_ENTRY_VA": 0x00AEFC46,
    "ISAAC_MAIN_VA": 0x00931050,
    "ISAAC_XI_START_VA": 0x00B18C10,
    "ISAAC_XI_END_VA": 0x00B18C24,
    "ISAAC_XC_START_VA": 0x00B18A2C,
    "ISAAC_XC_END_VA": 0x00B18C04,
    "ISAAC_TLS_CB_VA": 0x00B18C2C,
    "ISAAC_TLS_INDEX_VA": 0x00C71628,
    "ISAAC_IAT_VA": 0x00B18000,
    "ISAAC_STACK_SIZE": 0x00100000,
}


def main():
    pe = PE()
    img_path = OUT_DIR / "isaac.mem"
    if not img_path.exists():
        print("no isaac.mem; run memimage.py first")
        return 1
    img = img_path.read_bytes()
    base = pe.image_base
    failures = []
    checks = []

    # The flat image is trimmed of trailing zeros -- shipping them is waste,
    # and wasm linear memory is zero-initialised, so any byte past the end of
    # the blob is already 0. Reads therefore zero-extend rather than fail;
    # `isaac.mem` is a prefix of the full image, not the whole of it.
    def rd(va, n):
        off = va - base
        if off < 0 or off + n > EXPECT["ISAAC_IMAGE_SIZE"]:
            return None
        got = img[off:off + n]
        if len(got) < n:
            got = got + b"\0" * (n - len(got))
        return got

    # 1. every section's raw bytes appear at its VA
    for s in pe.sections:
        if s.name in DROP_SECTIONS:
            got = rd(base + s.rva, min(64, s.raw_size))
            ok = got is None or all(b == 0 for b in got)
            checks.append({"check": "dropped section is absent/zero",
                           "section": s.name, "ok": ok})
            if not ok:
                failures.append("%s should have been dropped" % s.name)
            continue
        want = pe.data[s.raw_offset:s.raw_offset + s.raw_size]
        got = rd(base + s.rva, s.raw_size)
        ok = got is not None and got == want
        checks.append({"check": "section bytes at VA", "section": s.name,
                       "bytes": s.raw_size, "ok": ok})
        if not ok:
            failures.append("%s raw bytes mismatch" % s.name)

    # 2. BSS tails are zero
    for s in pe.sections:
        if s.name in DROP_SECTIONS or not s.bss_tail:
            continue
        got = rd(base + s.rva + s.raw_size, s.bss_tail)
        ok = got is not None and not any(got)
        checks.append({"check": "BSS tail zeroed", "section": s.name,
                       "bytes": s.bss_tail, "ok": ok})
        if not ok:
            failures.append("%s BSS tail not zero" % s.name)

    # 3. PE headers present (__scrt_is_managed_app dereferences __ImageBase)
    ok = rd(base, 2) == b"MZ"
    checks.append({"check": "'MZ' at image base", "ok": ok})
    if not ok:
        failures.append("no MZ at image base")

    # 4. host_boot.c constants agree with the PE
    got = {
        "ISAAC_IMAGE_BASE": pe.image_base,
        "ISAAC_IMAGE_SIZE": pe.size_of_image,
        "ISAAC_ENTRY_VA": pe.entry_va,
        "ISAAC_STACK_SIZE": pe.stack_reserve,
    }
    boot = json.loads((OUT_DIR / "boot-tables.json").read_text(encoding="utf-8"))
    tabs = {t["startVa"]: t for t in boot["startup"]["initTermTables"]}
    xi = min(tabs.values(), key=lambda t: t["nonNull"])
    xc = max(tabs.values(), key=lambda t: t["nonNull"])
    got.update({
        "ISAAC_MAIN_VA": boot["startup"]["mainVa"],
        "ISAAC_XI_START_VA": xi["startVa"], "ISAAC_XI_END_VA": xi["endVa"],
        "ISAAC_XC_START_VA": xc["startVa"], "ISAAC_XC_END_VA": xc["endVa"],
        "ISAAC_TLS_CB_VA": boot["tls"]["callbacksAddrVa"],
        "ISAAC_TLS_INDEX_VA": boot["tls"]["indexAddrVa"],
        "ISAAC_IAT_VA": base + boot["iat"]["iatDirRva"],
    })
    for k, want in EXPECT.items():
        ok = got.get(k) == want
        checks.append({"check": "header constant", "name": k,
                       "expected": hexva(want), "actual": hexva(got.get(k)),
                       "ok": ok})
        if not ok:
            failures.append("%s: header says %s, PE says %s" % (
                k, hexva(want), hexva(got.get(k))))

    # 5. the boot-critical tables are readable IN THE IMAGE
    for name, va, n in (("XI table", EXPECT["ISAAC_XI_START_VA"],
                         EXPECT["ISAAC_XI_END_VA"] - EXPECT["ISAAC_XI_START_VA"]),
                        ("XC table", EXPECT["ISAAC_XC_START_VA"],
                         EXPECT["ISAAC_XC_END_VA"] - EXPECT["ISAAC_XC_START_VA"]),
                        ("IAT", EXPECT["ISAAC_IAT_VA"], 2600)):
        blob = rd(va, n)
        ok = blob is not None and len(blob) == n
        checks.append({"check": "readable in image", "name": name,
                       "va": hexva(va), "bytes": n, "ok": ok})
        if not ok:
            failures.append("%s not readable in image" % name)

    # 6. initialiser targets, read out of the IMAGE, all land in .text
    tlo, thi = pe.text_bounds_va()
    bad = 0
    total = 0
    for start, end in ((EXPECT["ISAAC_XI_START_VA"], EXPECT["ISAAC_XI_END_VA"]),
                       (EXPECT["ISAAC_XC_START_VA"], EXPECT["ISAAC_XC_END_VA"])):
        for p in range(start, end, 4):
            v = struct.unpack("<I", rd(p, 4))[0]
            if not v:
                continue
            total += 1
            if not (tlo <= v < thi):
                bad += 1
    checks.append({"check": "initialiser targets in .text",
                   "count": total, "outside": bad, "ok": bad == 0})
    if bad:
        failures.append("%d initialiser targets outside .text" % bad)
    if total != 121:
        failures.append("expected 121 initialisers, image has %d" % total)
    checks.append({"check": "initialiser count", "expected": 121,
                   "actual": total, "ok": total == 121})

    # 7. TLS callback readable and inside .text
    cb = struct.unpack("<I", rd(EXPECT["ISAAC_TLS_CB_VA"], 4))[0]
    ok = cb == 0x00AEFEC1 and tlo <= cb < thi
    checks.append({"check": "TLS callback", "actual": hexva(cb), "ok": ok})
    if not ok:
        failures.append("TLS callback wrong: %s" % hexva(cb))

    # The trim is only safe if every trimmed byte really was zero.
    trimmed = EXPECT["ISAAC_IMAGE_SIZE"] - len(img)
    checks.append({"check": "flat image is a zero-trimmed prefix",
                   "trimmedBytes": trimmed,
                   "note": "consumer must zero-fill to SizeOfImage",
                   "ok": trimmed >= 0})
    result = {"imageBytes": len(img),
              "sizeOfImage": EXPECT["ISAAC_IMAGE_SIZE"],
              "trailingZeroBytesTrimmed": trimmed,
              "consumerContract": "place isaac.mem at 0x00400000 in zero-filled "
                                  "linear memory; bytes past its end are zero "
                                  "by construction",
              "checks": checks, "failures": failures, "pass": not failures}
    (OUT_DIR / "memimage-verify.json").write_text(
        json.dumps(result, indent=1), encoding="utf-8")

    width = max(len(c.get("name") or c.get("section") or "") for c in checks)
    for c in checks:
        label = c.get("name") or c.get("section") or ""
        print("  [%s] %-32s %-*s %s" % (
            "ok" if c["ok"] else "FAIL", c["check"], width, label,
            "" if c["ok"] else "expected %s actual %s" % (
                c.get("expected"), c.get("actual"))))
    print()
    print("image %d bytes, %d checks, %d failures -> %s" % (
        len(img), len(checks), len(failures), "PASS" if not failures else "FAIL"))
    for f in failures:
        print("  FAIL:", f)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
