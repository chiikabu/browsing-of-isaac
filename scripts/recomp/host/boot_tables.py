"""Extract every table the boot path needs, straight from the PE.

Closes the three gaps the census enumerated:
  1. 650 IAT slots that hold unbound name RVAs on disk.
  2. 1 TLS callback.
  3. The two _initterm tables (C then C++) reached from __scrt_common_main_seh.

Everything here is measured from image bytes. Emits:
  output/recomp/host/boot-tables.json   machine-readable, full ordered lists
  output/recomp/host/iat-slots.csv      one row per IAT slot
  output/recomp/host/initializers.csv   one row per static initializer, in run order

Run:  python scripts/recomp/host/boot_tables.py
"""

import csv
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pe import PE, OUT_DIR, disasm, hexva  # noqa: E402

IMAGE_ORDINAL_FLAG32 = 0x80000000


# --------------------------------------------------------------------------
# 1. IAT
# --------------------------------------------------------------------------
def walk_imports(pe):
    """Walk the import directory and describe every IAT slot.

    On disk an unbound IAT slot holds the RVA of an IMAGE_IMPORT_BY_NAME
    (hint + name), or an ordinal with the high bit set. The loader overwrites
    it with the resolved address. Our boot code must do the same, pointing each
    slot at its shim.
    """
    imp_rva, imp_size = pe.dirs["IMPORT"]
    iat_rva, iat_size = pe.dirs["IAT"]
    descs = []
    slots = []
    i = 0
    while True:
        base = imp_rva + i * 20
        oft, ts, fchain, name_rva, first_thunk = struct.unpack(
            "<IIIII", pe.read_at_rva(base, 20))
        if oft == 0 and name_rva == 0 and first_thunk == 0:
            break
        dll = pe.cstr_at_rva(name_rva)
        int_rva = oft or first_thunk  # OriginalFirstThunk preferred; fall back
        n = 0
        dll_slots = []
        while True:
            slot_rva = first_thunk + n * 4
            int_entry = pe.u32_at_rva(int_rva + n * 4)
            disk_val = pe.u32_at_rva(slot_rva)
            if int_entry == 0:
                # Null terminator slot: still occupies 4 bytes of the IAT.
                dll_slots.append({
                    "slotRva": slot_rva,
                    "slotVa": pe.image_base + slot_rva,
                    "dll": dll,
                    "symbol": None,
                    "terminator": True,
                    "byOrdinal": False,
                    "ordinal": None,
                    "hint": None,
                    "diskValue": disk_val,
                })
                n += 1
                break
            if int_entry & IMAGE_ORDINAL_FLAG32:
                sym, hint, by_ord = None, None, True
                ordinal = int_entry & 0xFFFF
            else:
                by_ord, ordinal = False, None
                hint = pe.u16_at_rva(int_entry)
                sym = pe.cstr_at_rva(int_entry + 2)
            dll_slots.append({
                "slotRva": slot_rva,
                "slotVa": pe.image_base + slot_rva,
                "dll": dll,
                "symbol": sym,
                "terminator": False,
                "byOrdinal": by_ord,
                "ordinal": ordinal,
                "hint": hint,
                "diskValue": disk_val,
                "diskValueIsNameRva": (not by_ord) and disk_val == int_entry,
            })
            n += 1
        descs.append({
            "index": i, "dll": dll, "nameRva": name_rva,
            "originalFirstThunk": oft, "firstThunk": first_thunk,
            "timeDateStamp": ts, "forwarderChain": fchain,
            "slots": n, "symbols": n - 1,
            "bound": ts not in (0, 0xFFFFFFFF),
        })
        slots.extend(dll_slots)
        i += 1

    # The IAT data directory should cover exactly the slots we walked.
    lo = min(s["slotRva"] for s in slots)
    hi = max(s["slotRva"] for s in slots) + 4
    return {
        "importDirRva": imp_rva, "importDirSize": imp_size,
        "descriptorCount": i,
        "descriptorBytes": (i + 1) * 20,
        "iatDirRva": iat_rva, "iatDirSize": iat_size,
        "iatSpanRva": [lo, hi],
        "iatSpanBytes": hi - lo,
        "slotsWalked": len(slots),
        "terminatorSlots": sum(1 for s in slots if s["terminator"]),
        "symbolSlots": sum(1 for s in slots if not s["terminator"]),
        "boundDescriptors": sum(1 for d in descs if d["bound"]),
        "ordinalOnlySlots": sum(1 for s in slots if s["byOrdinal"]),
        "slotsWhoseDiskValueIsNameRva": sum(
            1 for s in slots if s.get("diskValueIsNameRva")),
        "descriptors": descs,
        "slots": slots,
    }


# --------------------------------------------------------------------------
# 2. TLS
# --------------------------------------------------------------------------
def read_tls(pe):
    rva, size = pe.dirs.get("TLS", (0, 0))
    if not rva:
        return {"present": False}
    o = pe.rva_to_off(rva)
    (raw_start, raw_end, index_addr, cb_addr,
     zero_fill, characteristics) = struct.unpack_from("<IIIIII", pe.data, o)
    cbs = []
    if cb_addr:
        co = pe.rva_to_off(cb_addr - pe.image_base)
        k = 0
        while True:
            v = struct.unpack_from("<I", pe.data, co + k * 4)[0]
            if not v:
                break
            cbs.append(v)
            k += 1
    tls_bytes = raw_end - raw_start
    init_data = None
    if tls_bytes:
        init_data = pe.read_at_va(raw_start, tls_bytes)
    return {
        "present": True,
        "dirRva": rva, "dirSize": size,
        "rawDataStartVa": raw_start, "rawDataEndVa": raw_end,
        "rawDataBytes": tls_bytes,
        "rawDataHex": init_data.hex() if init_data else None,
        "indexAddrVa": index_addr,
        "callbacksAddrVa": cb_addr,
        "zeroFill": zero_fill,
        "characteristics": characteristics,
        "alignment": 1 << (((characteristics >> 20) & 0xF) - 1)
                     if ((characteristics >> 20) & 0xF) else 0,
        "callbacks": cbs,
    }


# --------------------------------------------------------------------------
# 3. CRT startup: entry -> __scrt_common_main_seh -> _initterm tables -> main
# --------------------------------------------------------------------------
def trace_startup(pe, body_len=200):
    """Follow the entry point and recover, in call order, the two _initterm
    bounds pairs plus the call to main.

    MSVC 2015+ __scrt_common_main_seh does:
        if (_initterm_e(__xi_a, __xi_z) != 0) return 255;   // C   initialisers
        _initterm(__xc_a, __xc_z);                          // C++ initialisers
    __xi_* is .CRT$XI*, __xc_* is .CRT$XC*. Alphabetical section ordering puts
    XC below XI in memory, which is why the *lower* table is the C++ one even
    though it runs *second*.
    """
    entry = pe.entry_va
    head = disasm(pe, entry, 8)
    seh = None
    for ins in head:
        if ins.mnemonic == "jmp" and ins.op_str.startswith("0x"):
            seh = int(ins.op_str, 16)
            break
    if seh is None:
        raise RuntimeError("could not find jmp to __scrt_common_main_seh")

    body = disasm(pe, seh, body_len)
    rd = pe.section(".rdata")
    rd_lo = pe.image_base + rd.rva
    rd_hi = rd_lo + rd.virtual_span

    pushes = []
    events = []            # ordered record of interesting calls
    for ins in body:
        m, o = ins.mnemonic, ins.op_str
        if m == "push" and o.startswith("0x"):
            try:
                pushes.append(int(o, 16))
            except ValueError:
                pushes = []
        elif m == "call":
            target = int(o, 16) if o.startswith("0x") else None
            if len(pushes) >= 2:
                hi, lo = pushes[-2], pushes[-1]   # pushed hi first, then lo
                if (rd_lo <= lo < rd_hi and rd_lo <= hi < rd_hi
                        and 0 < hi - lo < 0x10000):
                    events.append({
                        "kind": "initterm", "atVa": ins.address,
                        "calleeVa": target, "lo": lo, "hi": hi,
                    })
            elif target is not None:
                events.append({"kind": "call", "atVa": ins.address,
                               "calleeVa": target})
            pushes = []
        elif m in ("ret", "retn"):
            break

    # Resolve each callee through an ILT thunk if it is one
    # (`jmp dword ptr [imm32]` = FF 25 xx xx xx xx).
    def resolve_thunk(va):
        if va is None or not pe.is_text_va(va):
            return None
        b = pe.read_at_va(va, 6)
        if b and b[:2] == b"\xff\x25":
            return struct.unpack_from("<I", b, 2)[0]  # IAT slot VA
        return None

    tables = []
    for ev in [e for e in events if e["kind"] == "initterm"]:
        lo, hi = ev["lo"], ev["hi"]
        n = (hi - lo) // 4
        off = pe.va_to_off(lo)
        vals = [struct.unpack_from("<I", pe.data, off + 4 * k)[0] for k in range(n)]
        nz = [v for v in vals if v]
        slot = resolve_thunk(ev["calleeVa"])
        tables.append({
            "startVa": lo, "endVa": hi, "slots": n,
            "nonNull": len(nz), "nullSlots": n - len(nz),
            "calleeVa": ev["calleeVa"],
            "calleeIatSlotVa": slot,
            "callSiteVa": ev["atVa"],
            "allTargetsInText": all(pe.is_text_va(v) for v in nz),
            "targets": vals,          # includes nulls, positional
            "nonNullTargets": nz,     # ordered, exactly what must run
        })

    # main() is the call that follows the argc/argv/envp setup. Identify it as
    # the last plain call before the epilogue whose target is well below the
    # CRT startup region -- but verify rather than assume (see cross-check).
    main_va = None
    for ev in events:
        if ev["kind"] == "call" and ev["calleeVa"] is not None:
            t = ev["calleeVa"]
            if pe.is_text_va(t) and t < min(x["startVa"] for x in tables) - 0x100000:
                main_va = t
                break
    return {
        "entryVa": entry,
        "scrtCommonMainSehVa": seh,
        "mainVa": main_va,
        "initTermTables": tables,
        "startupCalls": [e for e in events if e["kind"] == "call"],
    }


def name_initterm_tables(pe, tables, tls):
    """Label the two tables XI (C) vs XC (C++) using their address order and
    the TLS callback array position, which the linker places in .CRT$XL*.

    Section-name ordering inside the .CRT group is alphabetical:
        XC (C++ init) < XI (C init) < XL (TLS callbacks) < XP < XT (atexit)
    so the table with the lower VA is XC, and the TLS callback array must sit
    above the XI table. Both facts are checked, not assumed.
    """
    if len(tables) != 2:
        return {"ok": False, "reason": "expected 2 initterm tables, got %d" % len(tables)}
    a, b = sorted(tables, key=lambda t: t["startVa"])
    lower, upper = a, b
    lower["crtSection"] = ".CRT$XC* (C++ dynamic initialisers)"
    upper["crtSection"] = ".CRT$XI* (C initialisers)"
    lower["runOrder"] = 2
    upper["runOrder"] = 1
    checks = {
        "lowerIsCxxBySize": lower["nonNull"] > upper["nonNull"],
        "tlsCallbackArrayAboveXi": (
            tls.get("callbacksAddrVa", 0) >= upper["endVa"] if tls.get("present") else None),
        "tlsCallbackArrayImmediatelyAfterXi": (
            tls.get("callbacksAddrVa", 0) - upper["endVa"] if tls.get("present") else None),
        "callOrderMatchesXiFirst": tables[0]["startVa"] == upper["startVa"],
        "distinctCallees": tables[0]["calleeVa"] != tables[1]["calleeVa"],
    }
    return {"ok": True, "checks": checks}


# --------------------------------------------------------------------------
def main():
    pe = PE()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    iat = walk_imports(pe)
    tls = read_tls(pe)
    startup = trace_startup(pe)
    naming = name_initterm_tables(pe, startup["initTermTables"], tls)

    # relocation summary (needed to justify "map at preferred base")
    reloc_rva, reloc_size = pe.dirs["BASERELOC"]
    blocks, entries, by_type = 0, 0, {}
    o = pe.rva_to_off(reloc_rva)
    end = o + reloc_size
    bogus = []
    while o < end:
        page_rva, blk_size = struct.unpack_from("<II", pe.data, o)
        if blk_size == 0:
            break
        blocks += 1
        n = (blk_size - 8) // 2
        for k in range(n):
            e = struct.unpack_from("<H", pe.data, o + 8 + k * 2)[0]
            typ, off12 = e >> 12, e & 0xFFF
            entries += 1
            by_type[typ] = by_type.get(typ, 0) + 1
            if typ == 3:  # HIGHLOW
                tgt = page_rva + off12
                if pe.rva_to_off(tgt) is None:
                    bogus.append(tgt)
                else:
                    v = pe.u32_at_rva(tgt)
                    if v is not None and not (pe.image_base <= v <
                                              pe.image_base + pe.size_of_image):
                        bogus.append(tgt)
        o += blk_size

    result = {
        "target": str(pe.path),
        "fileSize": len(pe.data),
        "imageBase": pe.image_base,
        "sizeOfImage": pe.size_of_image,
        "sectionAlignment": pe.section_align,
        "fileAlignment": pe.file_align,
        "entryVa": pe.entry_va,
        "dllCharacteristics": pe.dll_characteristics,
        "stackReserve": pe.stack_reserve, "stackCommit": pe.stack_commit,
        "heapReserve": pe.heap_reserve, "heapCommit": pe.heap_commit,
        "iat": iat,
        "tls": tls,
        "startup": startup,
        "initTermNaming": naming,
        "relocations": {
            "dirRva": reloc_rva, "dirSize": reloc_size,
            "blocks": blocks, "entries": entries,
            "byType": {str(k): v for k, v in sorted(by_type.items())},
            "suspectHighlowTargets": [hexva(pe.image_base + t) for t in bogus],
            "suspectHighlowTargetRvas": ["0x%08x" % t for t in bogus],
        },
    }

    (OUT_DIR / "boot-tables.json").write_text(
        json.dumps(result, indent=1), encoding="utf-8")

    with (OUT_DIR / "iat-slots.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["slotVa", "slotRva", "dll", "symbol", "terminator",
                    "byOrdinal", "ordinal", "hint", "diskValue"])
        for s in iat["slots"]:
            w.writerow([hexva(s["slotVa"]), "0x%06x" % s["slotRva"], s["dll"],
                        s["symbol"] or "", int(s["terminator"]),
                        int(s["byOrdinal"]), s["ordinal"] if s["ordinal"] is not None else "",
                        s["hint"] if s["hint"] is not None else "",
                        hexva(s["diskValue"])])

    with (OUT_DIR / "initializers.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["runOrder", "table", "indexInTable", "targetVa", "inText"])
        for t in sorted(startup["initTermTables"], key=lambda x: x.get("runOrder", 9)):
            for i, v in enumerate(t["targets"]):
                if not v:
                    continue
                w.writerow([t.get("runOrder"), t.get("crtSection", "?"), i,
                            hexva(v), int(pe.is_text_va(v))])

    # ---- console report ----
    print("target            : %s (%d bytes)" % (pe.path.name, len(pe.data)))
    print("image base        : %s   sizeOfImage %d" % (hexva(pe.image_base), pe.size_of_image))
    print("entry             : %s" % hexva(pe.entry_va))
    print("dllCharacteristics: 0x%04x  (DYNAMIC_BASE=%s NX=%s)" % (
        pe.dll_characteristics, bool(pe.dll_characteristics & 0x40),
        bool(pe.dll_characteristics & 0x100)))
    print("stack reserve/commit: %d / %d   heap: %d / %d" % (
        pe.stack_reserve, pe.stack_commit, pe.heap_reserve, pe.heap_commit))
    print()
    print("IAT: dir rva %s size %d -> %d slots (%d symbols + %d terminators)" % (
        hexva(iat["iatDirRva"]), iat["iatDirSize"], iat["slotsWalked"],
        iat["symbolSlots"], iat["terminatorSlots"]))
    print("     span rva 0x%06x..0x%06x (%d bytes); dir size %d; match=%s" % (
        iat["iatSpanRva"][0], iat["iatSpanRva"][1], iat["iatSpanBytes"],
        iat["iatDirSize"], iat["iatSpanBytes"] == iat["iatDirSize"]))
    print("     descriptors %d, bound %d, ordinal-only %d, disk value == name RVA: %d/%d" % (
        iat["descriptorCount"], iat["boundDescriptors"], iat["ordinalOnlySlots"],
        iat["slotsWhoseDiskValueIsNameRva"], iat["symbolSlots"]))
    print()
    print("TLS: index@%s callbacks@%s raw %s..%s (%d bytes) zeroFill %d" % (
        hexva(tls["indexAddrVa"]), hexva(tls["callbacksAddrVa"]),
        hexva(tls["rawDataStartVa"]), hexva(tls["rawDataEndVa"]),
        tls["rawDataBytes"], tls["zeroFill"]))
    print("     callbacks: %s" % ", ".join(hexva(c) for c in tls["callbacks"]))
    print()
    print("__scrt_common_main_seh : %s" % hexva(startup["scrtCommonMainSehVa"]))
    for t in sorted(startup["initTermTables"], key=lambda x: x.get("runOrder", 9)):
        print("  run#%s %-40s %s..%s  %d slots, %d non-null, allInText=%s  callee %s" % (
            t.get("runOrder"), t.get("crtSection"), hexva(t["startVa"]),
            hexva(t["endVa"]), t["slots"], t["nonNull"], t["allTargetsInText"],
            hexva(t["calleeVa"])))
    print("  naming checks: %s" % json.dumps(naming.get("checks")))
    print("main()                 : %s" % hexva(startup["mainVa"]))
    print()
    print("relocations: %d blocks, %d entries, byType %s" % (
        blocks, entries, result["relocations"]["byType"]))
    print("  HIGHLOW sites whose current dword is NOT an in-image VA: %d %s" % (
        len(bogus), result["relocations"]["suspectHighlowTargetRvas"]))
    print()
    print("wrote %s" % (OUT_DIR / "boot-tables.json"))
    print("wrote %s" % (OUT_DIR / "iat-slots.csv"))
    print("wrote %s" % (OUT_DIR / "initializers.csv"))


if __name__ == "__main__":
    main()
