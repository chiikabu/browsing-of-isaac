"""Source-level overrides applied to the GENERATED lifted C after every lift.

Why this exists: the canonical target `tools/isaac-ng.unpacked.exe` carries
19 runs / 172 bytes of this project's own emulator-era hand patches (diff it
against `tools/isaac-ng.unpacked.exe.pre-coinit`). Round 10 believed one of
them fatal for the recompiled boot -- `0x009ab970`, the KAGE function that
mounts the "resources/" VFS root, has its prologue `push ebp; mov ebp, esp`
(55 8b ec) overwritten with `xor eax, eax; ret` (33 c0 c3); the lifter
faithfully lifts the stub and Ghidra keeps the orphaned body as
FUN_009ab973 -- and restored the prologue from here. Round 11 showed the
patch is load-bearing for THIS instance (a ResourceExtractor dump; see the
PATCHES comment) and removed the override again; the mechanism stays for
the other patches (recomp-architecture.md §19.5, §21).

Re-lifting from a re-patched binary would change the canonical hash that
every decomp tool pins, so the fix is applied HERE: build_boot.py rewrites
the affected function body in the lifted TU (idempotent; a marker comment
prevents double application) and drops that TU's object so it recompiles.
Each entry documents the pristine bytes it restores.

Usage (build_boot.py calls apply_lift_patches automatically):
    python scripts/recomp/lift/lift_patches.py --dir output/recomp/lift/gu [--check]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MARKER = "/* LIFT-PATCH"

# va -> (reason, replacement function body text). The replacement MUST keep a
# RECOMP_VA(<va>u) marker: mkdispatch.py / patch_reentry.py scan the lifted C
# for those markers to build the dispatch table.
PATCHES: dict[int, tuple[str, str]] = {
    # Round 10 restored 0x009ab970's pristine prologue here so a "resources/"
    # mount root was created. Round 11 REVERTED that: the instance is a
    # ResourceExtractor dump with the archives' contents at the install
    # ROOT, and KAGE's resolver (0x00a16c60) tries the archive index before a
    # root's loose map, so a "resources/" root made the stale small archives
    # (config.a = Afterbirth+ players.xml) shadow the extracted Repentance+
    # files. With only the "" root, relative keys miss the archive index
    # (keyed "resources/...") and resolve through the root scan.
    #
    # Round 24e brings it BACK, because that same miss is why the port was
    # silent: the sound effects and the music exist only inside the archives
    # (the dump has no sfx/ or music/ tree), and the archive index is keyed
    # "resources/<path>" -- with no "resources/" root nothing ever hits it.
    # The shadowing that round 11 saw is gone with it: the instance now
    # mounts the whole archive set (afterbirth.a, afterbirthp.a,
    # repentance.a; boot_integration.mjs LAZY_ARCHIVES), and the mount loop
    # (0x00a179c0) overwrites an equal-hash entry, so the last-mounted
    # archive -- repentance.a -- wins, exactly as it does in the real game.
    0x009ab970: (
        "restore `push ebp; mov ebp, esp` (pristine 55 8b ec; project patch 33 c0 c3 = "
        "xor eax,eax; ret) so the resources/ mount root is created and scanned",
        """void sub_009ab970(CpuState *restrict s) {
  /* LIFT-PATCH 0x009ab970: the canonical exe carries an emulator-era hand patch
     that turned this function's prologue into `xor eax, eax; ret`; the pristine
     bytes (tools/isaac-ng.unpacked.exe.pre-coinit) are `push ebp; mov ebp, esp`
     and the rest of the body is lifted as sub_009ab973 (Ghidra's orphaned
     FUN_009ab973). Emulate the two lost instructions and fall into the body,
     which ends with the function's own `mov esp, ebp; pop ebp; ret`. */
  RECOMP_VA(0x9ab970u);
  {
    uint32_t ESP = s->ESP;
    ESP = (uint32_t)(ESP - ((uint32_t)0x4u));
    MEMW32(ESP, s->EBP);
    s->ESP = ESP;
    s->EBP = ESP;
  }
  sub_009ab973(s);
}
""",
    ),
}

# --- block-level overrides ---------------------------------------------
# A PATCHES entry replaces a whole lifted function. Some of the project's
# hand patches (recomp-architecture.md §19.5) sit in the MIDDLE of a function
# whose body is far too big to re-express by hand; these rewrite one block.
# Each entry: (marker, old text, new text). `marker` names the entry for the
# log and the idempotence check (the new text must contain "LIFT-PATCH
# <marker>"); the old text is matched with either line ending.
#
# Round 24e: 0x00a2b5c2, the "branch forced" patch in the sound manager's
# create-source function (0x00a2b1e0, mixer vtable slot +0x24). Pristine bytes
# 80 7d 14 00 74 19 = `cmp byte [ebp+0x14], 0; je 0xa2b5e1`; the patch wrote
# e9 17 01 00 00 = `jmp 0xa2b6de` over the first five and left the je's rel8
# (0x19) as an orphan byte. The skipped code is the open of every sound
# source right after its construction (vt+0x20 preload probe, then
# vt+0x1c Open(path), "Failed to open %s \"%s\"" on failure) -- the reason
# the WAV loader and the ogg opener were never called in rounds 16-24.
# Ghidra saw the orphaned tail as its own function starting at the orphan
# byte (FUN_00a2b5c7: `sbb` swallowing `mov ecx, [ebp+0x10]; test ecx, ecx`),
# so the fix is three edits: the branch becomes a tail jump into that
# function, its first block is re-decoded from 0xa2b5c8, and both targets
# get a case in its re-entry switch.
BLOCK_PATCHES: list[tuple[str, str, str]] = [
    # Round 85: mods. The leading slashes on every mod path (see the marker).
    ("0x00a171a5",
     '  RECOMP_VA(0xa171a5u);\n  u3300_4 = (uint32_t)(EBP + ((uint32_t)0x8u));\n  uba00_4 = MEMR32(u3300_4);\n  ESI = uba00_4;\n',
     "  RECOMP_VA(0xa171a5u);\n  u3300_4 = (uint32_t)(EBP + ((uint32_t)0x8u));\n  uba00_4 = MEMR32(u3300_4);\n  ESI = uba00_4;\n  /* LIFT-PATCH 0x00a171a5 (round 85): mods, all of them.\n     This is the resolver every mod file goes through -- metadata, main.lua,\n     every sprite and sound -- and it answers from an index of strings, never\n     from a filesystem. This port builds a mod's path off an empty base, so it\n     asks for //mods/<id>/... while the index holds mods/<id>/... . Two\n     characters, and nothing of any mod was ever found: the loader saw no\n     main.lua and skipped every mod whole. Step over the leading slashes. */\n  while (ESI && MEMR8(ESI) == (uint8_t)0x2fu) ESI = (uint32_t)(ESI + 1u);\n"),
    # Round 81: achievements keep unlocking with mods on (see the marker text).
    ("0x009299e4",
     '  RECOMP_VA(0x9299e4u);\n  u3300_4 = (uint32_t)(EBP + ((uint32_t)0x8u));\n  ub900_1 = MEMR8(u3300_4);\n',
     '  RECOMP_VA(0x9299e4u);\n  /* LIFT-PATCH 0x009299e4 (round 81): PersistentGameData::SetReadOnly reads its\n     argument here and stores it at [this+1]. That byte is the whole achievement\n     gate: TryUnlock (0x00929a20) tests it first and returns, and past it the\n     next thing it does is record the unlock. The game sets it while mods are\n     loaded, which is why a modded run earns nothing. Read the argument as\n     false: the flag is recorded, the log line still says what happened, and\n     nothing else about the save changes. */\n  u3300_4 = (uint32_t)(EBP + ((uint32_t)0x8u));\n  ub900_1 = ((uint8_t)0x0u);\n'),
    # Round 52: the save-select screen's EDIT FILE menu (see the marker text).
    ("0x009d9d59",
     '  RECOMP_VA(0x9d9d59u);\n  u43f80_4 = ((uint32_t)0x0u);\n  ESP = (uint32_t)(ESP - ((uint32_t)0x4u));\n  MEMW32(ESP, u43f80_4);\n  RECOMP_VA(0x9d9d5bu);\n  u44180_4 = ((uint32_t)0xb7fb20u);\n  ESP = (uint32_t)(ESP - ((uint32_t)0x4u));\n  MEMW32(ESP, u44180_4);\n  RECOMP_VA(0x9d9d60u);\n  u5280_4 = ((uint32_t)0x2u);\n  MEMW32(EDI, u5280_4);\n',
     '  RECOMP_VA(0x9d9d59u);\n  /* LIFT-PATCH 0x009d9d59 (round 52): the EDIT FILE menu. The confirm on a\n     file in delete mode is about to play "DeleteConfirmationAppear" and set\n     state 2; the page\'s menu opens instead (isaac_editfile_gate), and the\n     engine\'s own prompt runs only once that menu chose Delete. Skipping is\n     the exit the other branches take, with nothing pushed and no register\n     changed; the node build has no page, so the gate always says go. */\n  if (!isaac_editfile_gate(EDI)) {\n    goto L_009da447;\n  }\n  u43f80_4 = ((uint32_t)0x0u);\n  ESP = (uint32_t)(ESP - ((uint32_t)0x4u));\n  MEMW32(ESP, u43f80_4);\n  RECOMP_VA(0x9d9d5bu);\n  u44180_4 = ((uint32_t)0xb7fb20u);\n  ESP = (uint32_t)(ESP - ((uint32_t)0x4u));\n  MEMW32(ESP, u44180_4);\n  RECOMP_VA(0x9d9d60u);\n  u5280_4 = ((uint32_t)0x2u);\n  MEMW32(EDI, u5280_4);\n'),
    ("0x00a2b5c2",
     """  RECOMP_VA(0xa2b5c2u);
L_00a2b5c2: ;
  goto L_00a2b6de;
""",
     """  RECOMP_VA(0xa2b5c2u);
L_00a2b5c2: ;
  /* LIFT-PATCH 0x00a2b5c2: pristine `cmp byte [ebp+0x14], 0; je 0xa2b5e1`
     (80 7d 14 00 74 19). The project's emulator-era patch forced `jmp 0xa2b6de`
     here, skipping the open of every sound source after its construction.
     Both successors live in sub_00a2b5c7 (Ghidra split the tail off as its own
     function), so this is a tail jump through that function's re-entry switch. */
  u24d00_4 = (uint32_t)MEMR8((uint32_t)(EBP + ((uint32_t)0x14u)));
  ZF = (uint8_t)(u24d00_4 == ((uint32_t)0x0u));
  CF = ((uint8_t)0x0u);
  OF = ((uint8_t)0x0u);
  SF = ((uint8_t)0x0u);
  PF = (uint8_t)(ZF ? 0x1u : 0x0u);
  s->EBP = EBP;
  s->ESP = ESP;
  s->FS_OFFSET = FS_OFFSET;
  s->EAX = EAX;
  s->EBX = EBX;
  s->ESI = ESI;
  s->EDI = EDI;
  s->ECX = ECX;
  s->CF = CF;
  s->OF = OF;
  s->SF = SF;
  s->ZF = ZF;
  s->PF = PF;
  recomp_jmp_target = ZF ? 0xa2b5e1u : 0xa2b5c8u; recomp_jmp_pending = 1u; return;
"""),
    # Round 86b: this used to anchor on `RECOMP_VA(0xa2b5c7u);`. Adding the 117
    # code-pointer-only functions (orphan_starts.py) repartitioned the TUs, and
    # 0xa2b5c7 gained an `L_00a2b5c7: ;` label between that line and the body --
    # so the match failed and the build stopped. The anchor is the sbb sequence
    # itself now, which is unmistakable and carries no label of its own; what
    # the lifter emits before it is left alone.
    ("0x00a2b5c8",
     """  u3400_4 = (uint32_t)(EBX + ((uint32_t)0xc985104du));
  u24700_4 = (uint32_t)CF;
  u5280_4 = MEMR32(u3400_4);
  CF = (uint8_t)(u5280_4 < ECX);
  u5280_4 = MEMR32(u3400_4);
  OF = (uint8_t)recomp_sborrow32(u5280_4, ECX);
  u5280_4 = MEMR32(u3400_4);
  u24900_4 = (uint32_t)(u5280_4 - ECX);
  u24980_1 = (uint8_t)(u24900_4 < u24700_4);
  CF = (uint8_t)((CF) | (u24980_1));
  u24a80_1 = (uint8_t)recomp_sborrow32(u24900_4, u24700_4);
  OF = (uint8_t)((OF) ^ (u24a80_1));
  u5280_4 = (uint32_t)(u24900_4 - u24700_4);
  MEMW32(u3400_4, u5280_4);
  u5280_4 = MEMR32(u3400_4);
  SF = (uint8_t)(((int32_t)u5280_4) < ((int32_t)((uint32_t)0x0u)));
  u5280_4 = MEMR32(u3400_4);
  ZF = (uint8_t)(u5280_4 == ((uint32_t)0x0u));
  u5280_4 = MEMR32(u3400_4);
  u24d00_4 = (uint32_t)(u5280_4 & ((uint32_t)0xffu));
  u24d80_1 = (uint8_t)recomp_popcount32(u24d00_4);
  u24e00_1 = (uint8_t)(u24d80_1 & ((uint8_t)0x1u));
  PF = (uint8_t)(u24e00_1 == ((uint8_t)0x0u));
  RECOMP_VA(0xa2b5cdu);
""",
     """  /* LIFT-PATCH 0x00a2b5c8: Ghidra started this orphaned tail one byte early
     (0x19 is the rel8 of the pristine `je` at 0xa2b5c6) and decoded an `sbb`
     that swallowed `mov ecx, [ebp+0x10]; test ecx, ecx`. Re-decoded from
     0xa2b5c8, which sub_00a2b1e0's restored branch enters. */
L_00a2b5c8: ;
  RECOMP_VA(0xa2b5c8u);
  u3300_4 = (uint32_t)(EBP + ((uint32_t)0x10u));
  ECX = MEMR32(u3300_4);
  RECOMP_VA(0xa2b5cbu);
  CF = ((uint8_t)0x0u);
  OF = ((uint8_t)0x0u);
  u57480_4 = (uint32_t)(ECX & ECX);
  SF = (uint8_t)(((int32_t)u57480_4) < ((int32_t)((uint32_t)0x0u)));
  ZF = (uint8_t)(u57480_4 == ((uint32_t)0x0u));
  u24d00_4 = (uint32_t)(u57480_4 & ((uint32_t)0xffu));
  u24d80_1 = (uint8_t)recomp_popcount32(u24d00_4);
  u24e00_1 = (uint8_t)(u24d80_1 & ((uint8_t)0x1u));
  PF = (uint8_t)(u24e00_1 == ((uint8_t)0x0u));
  RECOMP_VA(0xa2b5cdu);
"""),
    ("0x00a2b5c7-reentry",
     """    switch (_rva) {
    case 0x00a2b5ddu: goto L_00a2b5dd;
""",
     """    switch (_rva) {
    case 0x00a2b5c8u: goto L_00a2b5c8;   /* LIFT-PATCH 0x00a2b5c7-reentry */
    case 0x00a2b5e1u: goto L_00a2b5e1;
    case 0x00a2b5ddu: goto L_00a2b5dd;
"""),
    # The dispatcher's index holds function entries and CALL continuations
    # only (mkdispatch.py, call_cont.txt); a block another function jumps
    # INTO must be declared, or the tail jump above dies as "resolves to
    # neither a host shim nor a lifted function" (round 24e, first run).
    # mkdispatch.py treats a RECOMP_VA line carrying this marker as a
    # re-entry block. These two apply on top of the block above, so a fresh
    # lift and an already-patched tree end up identical.
    ("REENTRY 0x00a2b5c8",
     """  RECOMP_VA(0xa2b5c8u);
""",
     """  RECOMP_VA(0xa2b5c8u); /* LIFT-PATCH REENTRY 0x00a2b5c8 */
"""),
    ("REENTRY 0x00a2b5e1",
     """  RECOMP_VA(0xa2b5e1u);
""",
     """  RECOMP_VA(0xa2b5e1u); /* LIFT-PATCH REENTRY 0x00a2b5e1 */
"""),
    # Round 26: the archive mount (0x00a179c0) verifies every entry at mount
    # -- it reads each entry's whole payload through the entry stream in
    # 0x200-byte chunks and folds a checksum (0x00a17cee..0x00a17d8b) before
    # inserting the entry into the hash table at 0x00a17dc1. With the DLC set
    # that is 1.5 GB through the RAM-FS windows before the first frame (~65 s
    # in the debug profile, and every byte of it over HTTP in the browser).
    # The archives are verified offline (scripts/recomp/assets), so the
    # runtime skips the pass unless ISAAC_ARCHIVE_VERIFY=1: the skip does
    # what the skipped instructions would have left behind for 0x00a17dc1 --
    # the memset's cdecl purge (`add esp, 0xc` at 0x00a17cf4) and
    # `mov edi, [ebp-0xe6c]` (0x00a17d91, the entry record).
    # Round 26 diagnostic (ISAAC_PROBE=1 only): the .sta loader (0x00a26f20)
    # reads the whole stream into a NUL-terminated buffer, then parses it.
    # With the resources/ root back the table comes from afterbirthp.a and the
    # parse returns 0 although the offline decoder yields the loose file
    # byte-for-byte. Print the buffer's head and tail right after the
    # terminator is written (0x00a26fac), buffer at [ebp-0x10090], size in esi.
    ("0x00a26fb0-probe",
     """  RECOMP_VA(0xa26fb0u);
  uba00_4 = MEMR32(EDI);
""",
     """  RECOMP_VA(0xa26fb0u);
  { /* LIFT-PATCH 0x00a26fb0-probe */
    extern int isaac_probe_on(void);
    extern void isaac_probe_str(uint32_t tag, const char *label, uint32_t p);
    extern void isaac_probe_hit(uint32_t tag, uint32_t a, uint32_t b, uint32_t c);
    if (isaac_probe_on()) {
      uint32_t b_ = MEMR32((uint32_t)(EBP + ((uint32_t)0xfffefe70u)));
      isaac_probe_hit(0xa26fb0u, b_, ESI, MEMR32(b_));
      isaac_probe_str(0xa26fb0u, "sta buffer head", b_);
      isaac_probe_str(0xa26fb1u, "sta buffer tail", (uint32_t)(b_ + ESI - 48u));
    } }
  uba00_4 = MEMR32(EDI);
"""),
    # ... and the stream object itself (edi): its address, vtable and read
    # position, to see whether it overlaps the buffer.
    # After the .sta parse: the parser's error message (a static string in
    # [0xc7de4c], NULL when the parse succeeded) and the cursor it stopped at
    # (the callee-cleaned argument slot, still intact below ESP), as an offset
    # into the buffer (esi) with the 64 bytes before it.
    ("0x00a26fe0-probe",
     """L_00a26fe0: ;
  RECOMP_VA(0xa26fe0u);
  EAX = MEMR32(0xc7de4cu);
""",
     """L_00a26fe0: ;
  RECOMP_VA(0xa26fe0u);
  EAX = MEMR32(0xc7de4cu);
  { /* LIFT-PATCH 0x00a26fe0-probe */
    extern int isaac_probe_on(void);
    extern void isaac_probe_str(uint32_t tag, const char *label, uint32_t p);
    extern void isaac_probe_hit(uint32_t tag, uint32_t a, uint32_t b, uint32_t c);
    if (isaac_probe_on()) {
      uint32_t cur_ = MEMR32((uint32_t)(ESP - 4u));
      isaac_probe_hit(0xa26fe0u, EAX, cur_, (uint32_t)(cur_ - ESI));
      if (EAX) isaac_probe_str(0xa26fe0u, "sta parse error", EAX);
      isaac_probe_str(0xa26fe1u, "sta cursor-64", cur_ > ESI + 64u ? cur_ - 64u : ESI);
    } }
"""),
    # The 0x00a26fb0 probe read [ebp-0x10190] (a typo for the buffer's slot
    # [ebp-0x10090]) and showed a spilled stream pointer as "the buffer";
    # this corrects the slot in the applied text.
    ("0x00a26fb0-probe-fix",
     """      uint32_t b_ = MEMR32((uint32_t)(EBP + ((uint32_t)0xfffefe70u)));
""",
     """      uint32_t b_ = MEMR32((uint32_t)(EBP + ((uint32_t)0xfffeff70u)));   /* LIFT-PATCH 0x00a26fb0-probe-fix: [ebp-0x10090] */
"""),
    ("0x00a26fb0-probe2",
     """      isaac_probe_str(0xa26fb1u, "sta buffer tail", (uint32_t)(b_ + ESI - 48u));
""",
     """      isaac_probe_str(0xa26fb1u, "sta buffer tail", (uint32_t)(b_ + ESI - 48u));
      isaac_probe_hit(0xa26fb2u, EDI, MEMR32(EDI), MEMR32((uint32_t)(EDI + 0x18u)));   /* LIFT-PATCH 0x00a26fb0-probe2: stream, vtable, pos */
      { uint32_t q_; for (q_ = 0u; q_ < 48u; q_ += 12u)
          isaac_probe_hit(0xa26fb3u, MEMR32(b_ + q_), MEMR32(b_ + q_ + 4u), MEMR32(b_ + q_ + 8u));
        for (q_ = 0u; q_ < 48u; q_ += 12u)
          isaac_probe_hit(0xa26fb4u, MEMR32(EDI + q_), MEMR32(EDI + q_ + 4u), MEMR32(EDI + q_ + 8u)); }
"""),
    ("0x00a17cee",
     """L_00a17cee: ;
  RECOMP_VA(0xa17ceeu);
  u3400_4 = (uint32_t)(EBP + ((uint32_t)0xfffff1c8u));
""",
     """L_00a17cee: ;
  RECOMP_VA(0xa17ceeu);
  /* LIFT-PATCH 0x00a17cee: skip the mount's per-entry checksum pass unless
     ISAAC_ARCHIVE_VERIFY=1 (host_shims_fs.c). Leaves esp and edi as
     0x00a17dc1 expects them. */
  { extern int isaac_archive_verify_on(void);
    if (!isaac_archive_verify_on()) {
      ESP = (uint32_t)(ESP + ((uint32_t)0xcu));
      EDI = MEMR32((uint32_t)(EBP + ((uint32_t)0xfffff194u)));
      goto L_00a17dc1;
    } }
  u3400_4 = (uint32_t)(EBP + ((uint32_t)0xfffff1c8u));
"""),
]


def apply_block_patches(lift_dir: Path, check_only: bool = False) -> list[Path]:
    """Apply BLOCK_PATCHES (idempotent: the marker in the new text). Returns the
    TUs modified. A missing old text with no marker present is fatal -- a
    re-lift that changed the block must be re-read, not silently skipped."""
    touched: list[Path] = []
    tus = sorted(lift_dir.glob("lifted_*.c"))
    for marker, old, new in BLOCK_PATCHES:
        tag = "LIFT-PATCH %s" % marker
        if tag not in new:
            raise SystemExit("block patch %s: new text lacks its marker" % marker)
        hit = None
        for tu in tus:
            text = tu.read_text(encoding="utf-8")
            if tag in text:
                hit = (tu, None)
                break
            crlf = "\r\n" in text
            old_t = old.replace("\n", "\r\n") if crlf else old
            if old_t in text:
                hit = (tu, (text, old_t, new.replace("\n", "\r\n") if crlf else new))
                break
        if hit is None:
            raise SystemExit("block patch %s: old text not found in any TU of %s" % (marker, lift_dir))
        tu, todo = hit
        if todo is None:
            print("block-patch %s: already applied in %s" % (marker, tu.name))
            continue
        text, old_t, new_t = todo
        if text.count(old_t) != 1:
            raise SystemExit("block patch %s: old text occurs %d times in %s" % (marker, text.count(old_t), tu.name))
        if check_only:
            touched.append(tu)
            continue
        tu.write_text(text.replace(old_t, new_t, 1), encoding="utf-8", newline="")
        print("block-patch %s: applied in %s" % (marker, tu.name))
        touched.append(tu)
    return touched
# --- baked host-import stack purges to correct ---------------------------
# The lifter bakes each direct host-import call's stack purge INTO THE CALLER
# at lift time, read from the shim table: `imp_X(s); s->EIP = MEMR32(s->ESP);
# s->ESP += 4u + <purge>u;`. When a purge is corrected in gen_shims.py after
# the lift (the push-count sweep miscounts __thiscall ctors whose args are set
# inline at the caller), the baked value is stale and the caller over- or
# under-pops -- corrupting the guest stack for the NEXT call. Re-lifting the
# whole image to change a 4-byte constant per call site is wasteful, so
# build_boot.py rewrites the baked constant in place, per call site, and drops
# the touched TU's object.
#
# Each entry: imp_ C identifier -> (wrong baked purge, correct purge). Verify a
# value with `pequery.py`/the decorated name (bytes popped by the callee's ret;
# 0 for a @@XZ no-arg thiscall; 4 per pointer/int/bool arg). Measured wrong
# values come from output/recomp/host/shim-table.json BEFORE the gen_shims fix.
PURGE_PATCHES: dict[str, tuple[int, int]] = {
    # __thiscall msvcp140 ctors: the sweep counted the caller's inlined arg
    # setup as pushes (boot round 10, recomp-architecture.md).
    "imp_msvcp140____0__basic_ios_DU__char_traits_D_std___std__IAE_XZ": (32, 0),
    # Round 10b mis-curated these two as the decorated-name sum and patched the
    # (correct) measured 8 / 12 down to 4 / 8; constructors of classes with a
    # virtual base pop a hidden trailing `most_derived` int as well. These
    # entries undo that on a tree lifted before the correction (a fresh lift
    # bakes 8 / 12 from gen_shims.py and matches nothing here).
    "imp_msvcp140____0__basic_iostream_DU__char_traits_D_std___std__QAE_PAV__basic_streambuf_DU__char_traits_D_std___1__Z": (4, 8),
    "imp_msvcp140____0__basic_ostream_DU__char_traits_D_std___std__QAE_PAV__basic_streambuf_DU__char_traits_D_std___1__N_Z": (8, 12),
    "imp_msvcp140____0_Lockit_std__QAE_H_Z": (36, 4),
    "imp_msvcp140___widen___basic_ios_DU__char_traits_D_std___std__QBEDD_Z": (12, 4),
}


# --- host fastpath wrappers ---------------------------------------------
# The boot profile (recomp-architecture.md §21.12) is dominated by three
# deterministic leaf functions: libpng's row unfilter (37%), zlib's adler32
# (8.7%) and the engine's texture premultiply (8%). host_fastpath.c
# re-implements them exactly on guest memory. Rather than replace the lifted
# bodies, each is RENAMED to sub_X__lifted and a wrapper sub_X takes its
# place: it runs the host version (default), the lifted one (ISAAC_FASTPATH=0)
# or both with a byte compare of the touched range (ISAAC_FASTPATH_VERIFY=1),
# so the equivalence is measured on the game's own data, not assumed.
# Each entry: va -> wrapper body text; the wrapper owns the callee's ret.
WRAP_PATCHES: dict[int, str] = {
    # stb_vorbis inverse_mdct (round 50): buffer in ecx, n in edx, (f,
    # blocktype) on the stack, plain ret; writes the n floats at buffer.
    0x00aa38a0: """void sub_00aa38a0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00aa38a0: host inverse_mdct (host_fastpath.c) */
  RECOMP_VA(0xaa38a0u);
  uint32_t buf = s->ECX, n = s->EDX, f = MEMR32(s->ESP + 4u), bt = MEMR32(s->ESP + 8u);
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_inverse_mdct_ok(buf, n, f, bt)) { isaac_fastpath_count(0xaa38a0u, 1); sub_00aa38a0__lifted(s); return; }
  if (mode == 2) {
    uint32_t len = n * 4u;
    uint8_t *snap = (uint8_t *)malloc(len);
    uint8_t *host = (uint8_t *)malloc(len);
    if (!snap || !host) { free(snap); free(host); isaac_fastpath_count(0xaa38a0u, 1); sub_00aa38a0__lifted(s); return; }
    memcpy(snap, RECOMP_PTR(buf), len);
    isaac_fast_inverse_mdct(buf, n, f, bt);
    memcpy(host, RECOMP_PTR(buf), len);
    memcpy(RECOMP_PTR(buf), snap, len);
    sub_00aa38a0__lifted(s);
    if (!isaac_fast_verify_equal(host, buf, len)) isaac_fastpath_mismatch("inverse_mdct", n, bt);
    isaac_fastpath_count(0xaa38a0u, 2);
    free(snap); free(host);
    return;
  }
  isaac_fast_inverse_mdct(buf, n, f, bt);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # stb_vorbis imdct_step3_inner_r_loop (round 49): lim in ecx, e in edx,
    # (d0, k_off, A, k1) on the stack, plain ret. Touches two runs of
    # 8 * (lim >> 2) floats (host_fastpath.c has the exact range).
    0x00aa3270: """void sub_00aa3270(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00aa3270: host imdct butterfly (host_fastpath.c) */
  RECOMP_VA(0xaa3270u);
  uint32_t lim = s->ECX, e = s->EDX, d0 = MEMR32(s->ESP + 4u), koff = MEMR32(s->ESP + 8u),
           a = MEMR32(s->ESP + 12u), k1 = MEMR32(s->ESP + 16u);
  int mode = isaac_fastpath_mode();
  uint32_t lo = 0u, len = 0u;
  if (mode == 0 || !isaac_fast_imdct_r_loop_ok(lim, e, d0, koff, a, k1, &lo, &len)) {
    isaac_fastpath_count(0xaa3270u, 1); sub_00aa3270__lifted(s); return;
  }
  if (mode == 2) {
    uint8_t *snap = (uint8_t *)malloc(len);
    uint8_t *host = (uint8_t *)malloc(len);
    if (!snap || !host) { free(snap); free(host); isaac_fastpath_count(0xaa3270u, 1); sub_00aa3270__lifted(s); return; }
    memcpy(snap, RECOMP_PTR(lo), len);
    isaac_fast_imdct_r_loop(lim, e, d0, koff, a, k1);
    memcpy(host, RECOMP_PTR(lo), len);
    memcpy(RECOMP_PTR(lo), snap, len);
    sub_00aa3270__lifted(s);
    if (!isaac_fast_verify_equal(host, lo, len)) isaac_fastpath_mismatch("imdct_r_loop", lim, len);
    isaac_fastpath_count(0xaa3270u, 2);
    free(snap); free(host);
    return;
  }
  isaac_fast_imdct_r_loop(lim, e, d0, koff, a, k1);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # the engine's path hash: thiscall, string in ecx, hash in eax. The hot
    # leaf of resource lookup (round 18).
    0x00a159d0: """void sub_00a159d0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a159d0: host path hash (host_fastpath.c) */
  RECOMP_VA(0xa159d0u);
  uint32_t str = s->ECX;
  int mode = isaac_fastpath_mode();
  if (mode == 0) { sub_00a159d0__lifted(s); return; }
  uint32_t r = isaac_fast_pathhash(str);
  if (mode == 2) {
    sub_00a159d0__lifted(s);
    if (s->EAX != r) isaac_fastpath_mismatch("pathhash", s->EAX, r);
    return;
  }
  s->EAX = r;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # png_read_filter_row (SSE2 build): edx = png_row_info*, stack = (row,
    # prev_row, filter); caller cleans (plain ret). Touches rowbytes bytes at
    # row.
    0x00ab2d80: """void sub_00ab2d80(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00ab2d80: host PNG unfilter (host_fastpath.c) */
  RECOMP_VA(0xab2d80u);
  uint32_t info = s->EDX, row = MEMR32(s->ESP + 4u), prev = MEMR32(s->ESP + 8u),
           filter = MEMR32(s->ESP + 12u);
  int mode = isaac_fastpath_mode();
  if (mode == 0 || filter > 4u) { sub_00ab2d80__lifted(s); return; }
  if (mode == 2) {
    uint32_t rb = MEMR32(info + 4u);
    uint8_t *snap = (uint8_t *)malloc(rb ? rb : 1u);
    if (snap && rb) memcpy(snap, RECOMP_PTR(row), rb);
    isaac_fast_unfilter(info, row, prev, filter);
    uint8_t *host = (uint8_t *)malloc(rb ? rb : 1u);
    if (host && rb) memcpy(host, RECOMP_PTR(row), rb);
    if (snap && rb) memcpy(RECOMP_PTR(row), snap, rb);
    sub_00ab2d80__lifted(s);
    if (host && rb && !isaac_fast_verify_equal(host, row, rb))
      isaac_fastpath_mismatch("unfilter", filter, rb);
    free(snap); free(host);
    return;
  }
  isaac_fast_unfilter(info, row, prev, filter);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # zlib adler32(adler, buf, len): cdecl, result in eax.
    0x00aaddd0: """void sub_00aaddd0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00aaddd0: host adler32 (host_fastpath.c) */
  RECOMP_VA(0xaaddd0u);
  uint32_t adler = MEMR32(s->ESP + 4u), buf = MEMR32(s->ESP + 8u), len = MEMR32(s->ESP + 12u);
  int mode = isaac_fastpath_mode();
  if (mode == 0) { sub_00aaddd0__lifted(s); return; }
  uint32_t r = isaac_fast_adler32(adler, buf, len);
  if (mode == 2) {
    sub_00aaddd0__lifted(s);
    if (s->EAX != r) isaac_fastpath_mismatch("adler32", s->EAX, r);
    return;
  }
  s->EAX = r;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # texture premultiply: ecx = pixels, edx = rows, stack = (width); count =
    # rows * width; caller cleans; table chosen by [0x00c798e4] & 8.
    0x00a663c0: """void sub_00a663c0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a663c0: host premultiply (host_fastpath.c) */
  RECOMP_VA(0xa663c0u);
  uint32_t pixels = s->ECX, count = s->EDX * MEMR32(s->ESP + 4u);
  uint32_t table = (MEMR8(0x00c798e4u) & 8u) ? 0x00c13640u : 0x00c23640u;
  int mode = isaac_fastpath_mode();
  if (mode == 0) { sub_00a663c0__lifted(s); return; }
  if (mode == 2) {
    uint32_t n = count * 4u;
    uint8_t *snap = (uint8_t *)malloc(n ? n : 1u);
    if (snap && n) memcpy(snap, RECOMP_PTR(pixels), n);
    isaac_fast_premultiply(pixels, count, table);
    uint8_t *host = (uint8_t *)malloc(n ? n : 1u);
    if (host && n) memcpy(host, RECOMP_PTR(pixels), n);
    if (snap && n) memcpy(RECOMP_PTR(pixels), snap, n);
    sub_00a663c0__lifted(s);
    if (host && n && !isaac_fast_verify_equal(host, pixels, n))
      isaac_fastpath_mismatch("premultiply", count, table);
    free(snap); free(host);
    return;
  }
  isaac_fast_premultiply(pixels, count, table);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # ---- round 27: the leaves of the fast profile's dispatch census -------
    # (recomp-architecture.md 21.42). Two rules on top of the round-12 contract,
    # pinned by tests/recomp-fastpath.test.js: the host path's purge equals the
    # callee's `ret N`, and a verify path runs the trampoline after the lifted
    # body, because these bodies end in tail jumps (the ISAAC core's jump-table
    # cases, AddRef's jump into Unlock) that are only parked when the body
    # returns. Every wrapper decides host-or-lifted BEFORE any side effect.
    #
    # Bob Jenkins' isaac() -- the v2 archive keystream refill: thiscall, ecx =
    # the 0x810-byte context, no arguments, plain ret; ebx/esi/edi saved and
    # restored, ecx untouched (its caller relies on that). Its per-iteration
    # `switch (i & 3)` is a jump table, so each of its 256 iterations was one
    # dispatch: 71 M of the 93 M dispatches of a 3,000-frame run.
    0x00aa94a0: """void sub_00aa94a0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00aa94a0: host ISAAC keystream refill (host_fastpath.c) */
  RECOMP_VA(0xaa94a0u);
  uint32_t ctx = s->ECX, edx = 0u;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_guest_range(ctx, 0x810u)) { isaac_fastpath_count(0xaa94a0u, 1); sub_00aa94a0__lifted(s); return; }
  if (mode == 2) {
    uint8_t *snap = (uint8_t *)malloc(0x810u), *host = (uint8_t *)malloc(0x810u);
    if (snap) memcpy(snap, RECOMP_PTR(ctx), 0x810u);
    isaac_fast_isaac(ctx, &edx);
    if (host) memcpy(host, RECOMP_PTR(ctx), 0x810u);
    if (snap) memcpy(RECOMP_PTR(ctx), snap, 0x810u);
    sub_00aa94a0__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);     /* the jump-table cases are parked tail jumps */
    isaac_fastpath_count(0xaa94a0u, 2);
    if (host && !isaac_fast_verify_equal(host, ctx, 0x810u)) isaac_fastpath_mismatch("isaac", ctx, MEMR32(ctx + 0x804u));
    if (s->EAX != MEMR32(ctx + 0x808u) || s->EDX != edx) isaac_fastpath_mismatch("isaac regs", s->EAX, s->EDX);
    free(snap); free(host);
    return;
  }
  isaac_fast_isaac(ctx, &edx);
  s->EAX = MEMR32(ctx + 0x808u);   /* the loop's last b, as the lifted body leaves it */
  s->EDX = edx;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # The keystream consumer above it: thiscall, [ecx] -> the context, stack =
    # (buf, len); ret 8. XORs len bytes with the r[] words and calls isaac()
    # when r[255] is taken. Its byte loop runs over every stored piece of the
    # DLC archives (a 3,000-frame run decodes ~280 MB of PCM through it).
    # The archive stream's inflate_fast (round 57): ecx = lenbits, edx =
    # distbits, stack = (lcode, dcode, st, in), plain ret, the result in eax.
    # The verify mode snapshots the whole ring window, the state and the
    # input struct, and compares eax as well.
    # miniz tinfl_decompress (round 58): ecx = r, edx = pIn_buf_next, stack =
    # (pIn_buf_size, pOut_buf_start, pOut_buf_next, pOut_buf_size, flags),
    # plain ret (the caller drops 0x14), the status in eax. The verify mode
    # snapshots the whole decompressor, the output window (the ring, or the
    # buffer when the caller says it does not wrap), both sizes, and eax.
    0x00a85710: """void sub_00a85710(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a85710: host miniz tinfl_decompress (host_fastpath.c) */
  RECOMP_VA(0xa85710u);
  uint32_t r = s->ECX, in_next = s->EDX, in_size = MEMR32(s->ESP + 4u), out_start = MEMR32(s->ESP + 8u),
           out_next = MEMR32(s->ESP + 12u), out_size = MEMR32(s->ESP + 16u), flags = MEMR32(s->ESP + 20u);
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_tinfl_ok(r, in_next, in_size, out_start, out_next, out_size, flags)) { isaac_fastpath_count(0xa85710u, 1); sub_00a85710__lifted(s); return; }
  if (mode == 2) {
    uint32_t obase = (flags & 4u) ? out_next : out_start;
    uint32_t olen = (flags & 4u) ? MEMR32(out_size) : (out_next - out_start) + MEMR32(out_size);
    uint32_t total = 0x2aedu + olen + 8u;
    uint8_t *snap = (uint8_t *)malloc(total), *host = (uint8_t *)malloc(total);
    if (!snap || !host) { free(snap); free(host); isaac_fastpath_count(0xa85710u, 1); sub_00a85710__lifted(s); return; }
    memcpy(snap, RECOMP_PTR(r), 0x2aedu); memcpy(snap + 0x2aedu, RECOMP_PTR(obase), olen); memcpy(snap + 0x2aedu + olen, RECOMP_PTR(in_size), 4u); memcpy(snap + 0x2aedu + olen + 4u, RECOMP_PTR(out_size), 4u);
    int hr = isaac_fast_tinfl(r, in_next, in_size, out_start, out_next, out_size, flags);
    memcpy(host, RECOMP_PTR(r), 0x2aedu); memcpy(host + 0x2aedu, RECOMP_PTR(obase), olen); memcpy(host + 0x2aedu + olen, RECOMP_PTR(in_size), 4u); memcpy(host + 0x2aedu + olen + 4u, RECOMP_PTR(out_size), 4u);
    memcpy(RECOMP_PTR(r), snap, 0x2aedu); memcpy(RECOMP_PTR(obase), snap + 0x2aedu, olen); memcpy(RECOMP_PTR(in_size), snap + 0x2aedu + olen, 4u); memcpy(RECOMP_PTR(out_size), snap + 0x2aedu + olen + 4u, 4u);
    sub_00a85710__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xa85710u, 2);
    if ((int)s->EAX != hr || !isaac_fast_verify_equal(host, r, 0x2aedu) || !isaac_fast_verify_equal(host + 0x2aedu, obase, olen)
        || !isaac_fast_verify_equal(host + 0x2aedu + olen, in_size, 4u) || !isaac_fast_verify_equal(host + 0x2aedu + olen + 4u, out_size, 4u))
      isaac_fastpath_mismatch("tinfl", (uint32_t)hr, s->EAX);
    free(snap); free(host);
    return;
  }
  s->EAX = (uint32_t)isaac_fast_tinfl(r, in_next, in_size, out_start, out_next, out_size, flags);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    0x00adb9c0: """void sub_00adb9c0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00adb9c0: host archive inflate_fast (host_fastpath.c) */
  RECOMP_VA(0xadb9c0u);
  uint32_t lenbits = s->ECX, distbits = s->EDX, lcode = MEMR32(s->ESP + 4u), dcode = MEMR32(s->ESP + 8u),
           st = MEMR32(s->ESP + 12u), in = MEMR32(s->ESP + 16u);
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_inflate_ring_ok(lenbits, distbits, lcode, dcode, st, in)) { isaac_fastpath_count(0xadb9c0u, 1); sub_00adb9c0__lifted(s); return; }
  if (mode == 2) {
    uint32_t base = MEMR32(st + 0x28u), wlen = MEMR32(st + 0x2cu) - base, total = wlen + 0x38u + 0x1cu;
    uint8_t *snap = (uint8_t *)malloc(total), *host = (uint8_t *)malloc(total);
    if (!snap || !host) { free(snap); free(host); isaac_fastpath_count(0xadb9c0u, 1); sub_00adb9c0__lifted(s); return; }
    memcpy(snap, RECOMP_PTR(base), wlen); memcpy(snap + wlen, RECOMP_PTR(st), 0x38u); memcpy(snap + wlen + 0x38u, RECOMP_PTR(in), 0x1cu);
    int hr = isaac_fast_inflate_ring(lenbits, distbits, lcode, dcode, st, in);
    memcpy(host, RECOMP_PTR(base), wlen); memcpy(host + wlen, RECOMP_PTR(st), 0x38u); memcpy(host + wlen + 0x38u, RECOMP_PTR(in), 0x1cu);
    memcpy(RECOMP_PTR(base), snap, wlen); memcpy(RECOMP_PTR(st), snap + wlen, 0x38u); memcpy(RECOMP_PTR(in), snap + wlen + 0x38u, 0x1cu);
    sub_00adb9c0__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xadb9c0u, 2);
    if ((int)s->EAX != hr || !isaac_fast_verify_equal(host, base, wlen) || !isaac_fast_verify_equal(host + wlen, st, 0x38u)
        || !isaac_fast_verify_equal(host + wlen + 0x38u, in, 0x1cu))
      isaac_fastpath_mismatch("inflate_ring", (uint32_t)hr, s->EAX);
    free(snap); free(host);
    return;
  }
  s->EAX = (uint32_t)isaac_fast_inflate_ring(lenbits, distbits, lcode, dcode, st, in);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    0x00a89d70: """void sub_00a89d70(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a89d70: host archive keystream XOR (host_fastpath.c) */
  RECOMP_VA(0xa89d70u);
  uint32_t self = s->ECX, buf = MEMR32(s->ESP + 4u), len = MEMR32(s->ESP + 8u);
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_keystream_ok(self, buf, len)) { isaac_fastpath_count(0xa89d70u, 1); sub_00a89d70__lifted(s); return; }
  if (mode == 2) {
    uint32_t ctx = MEMR32(self);
    uint8_t *snap = (uint8_t *)malloc(len + 0x810u), *host = (uint8_t *)malloc(len + 0x810u);
    if (snap) { memcpy(snap, RECOMP_PTR(buf), len); memcpy(snap + len, RECOMP_PTR(ctx), 0x810u); }
    isaac_fast_keystream_xor(self, buf, len);
    if (host) { memcpy(host, RECOMP_PTR(buf), len); memcpy(host + len, RECOMP_PTR(ctx), 0x810u); }
    if (snap) { memcpy(RECOMP_PTR(buf), snap, len); memcpy(RECOMP_PTR(ctx), snap + len, 0x810u); }
    sub_00a89d70__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xa89d70u, 2);
    if (host && (!isaac_fast_verify_equal(host, buf, len) || !isaac_fast_verify_equal(host + len, ctx, 0x810u)))
      isaac_fastpath_mismatch("keystream", len, MEMR32(ctx));
    free(snap); free(host);
    return;
  }
  isaac_fast_keystream_xor(self, buf, len);
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u + 8u;
}
""",
    # ArchivedFile::read: thiscall, stack = (buf, size, count); ret 0xc; bytes
    # read in eax. The host serves the window (no refill needed, or eof); a
    # request that needs the refill 0x00a68cf0 runs the lifted body whole.
    0x00a69510: """void sub_00a69510(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a69510: host ArchivedFile::read window copy (host_fastpath.c) */
  RECOMP_VA(0xa69510u);
  uint32_t self = s->ECX, buf = MEMR32(s->ESP + 4u), n = MEMR32(s->ESP + 8u) * MEMR32(s->ESP + 12u), take = 0u;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_read_plan(self, buf, n, &take)) { isaac_fastpath_count(0xa69510u, 1); sub_00a69510__lifted(s); return; }
  if (mode == 2) {
    uint32_t pos = MEMR32(self + 0xc1cu), spos = MEMR32(self + 0x18u), esp0 = s->ESP;
    uint8_t *host = (uint8_t *)malloc(take ? take : 1u);
    if (host && take) memcpy(host, RECOMP_PTR(self + 0x81cu + pos), take);   /* what the host copy delivers */
    sub_00a69510__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xa69510u, 2);
    if (s->EAX != take || MEMR32(self + 0xc1cu) != pos + take || MEMR32(self + 0x18u) != spos + take ||
        s->ESP != esp0 + 16u || (host && take && !isaac_fast_verify_equal(host, buf, take)))
      isaac_fastpath_mismatch("archive_read", s->EAX, take);
    free(host);
    return;
  }
  isaac_fast_read_window(self, buf, take);
  s->EAX = take;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u + 12u;
}
""",
    # Mutex::Lock(timeout): thiscall, ecx = the mutex, stack = (timeout); ret 4;
    # eax = 1. Host: the uncontended INFINITE wait only (EnterCriticalSection's
    # report to the thread slicer, then the locked byte); a set byte or a
    # finite timeout is the lifted body's (Sleep spin / QPC deadline).
    0x00a157f0: """void sub_00a157f0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a157f0: host Mutex::Lock, uncontended INFINITE (host_fastpath.c) */
  RECOMP_VA(0xa157f0u);
  uint32_t self = s->ECX, timeout = MEMR32(s->ESP + 4u);
  int mode = isaac_fastpath_mode();
  if (mode == 0 || timeout != 0xffffffffu || !isaac_fast_mutex_free(self)) { isaac_fastpath_count(0xa157f0u, 1); sub_00a157f0__lifted(s); return; }
  if (mode == 2) {
    uint32_t cs = MEMR32(self + 8u), esp0 = s->ESP;
    sub_00a157f0__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xa157f0u, 2);
    if (s->EAX != 1u || MEMR8(cs + 0x18u) != 1u || s->ESP != esp0 + 8u) isaac_fastpath_mismatch("mutex_lock", s->EAX, s->ESP - esp0);
    return;
  }
  isaac_fast_mutex_take(self);
  s->EAX = 1u;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u + 4u;
}
""",
    # Mutex::Unlock: thiscall, no arguments, plain ret; the locked byte cleared,
    # then LeaveCriticalSection (eax = 0 here).
    0x00a159a0: """void sub_00a159a0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a159a0: host Mutex::Unlock (host_fastpath.c) */
  RECOMP_VA(0xa159a0u);
  uint32_t self = s->ECX;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_mutex_init(self)) { isaac_fastpath_count(0xa159a0u, 1); sub_00a159a0__lifted(s); return; }
  if (mode == 2) {
    uint32_t cs = MEMR32(self + 8u), esp0 = s->ESP;
    sub_00a159a0__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xa159a0u, 2);
    if (s->EAX != 0u || MEMR8(cs + 0x18u) != 0u || s->ESP != esp0 + 4u) isaac_fastpath_mismatch("mutex_unlock", s->EAX, s->ESP - esp0);
    return;
  }
  isaac_fast_mutex_drop(self);
  s->EAX = 0u;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # The refcount handle {vtable, u16 count at +4, an embedded Mutex at +8,
    # owner at +0x14} and its three helpers, each dispatched through a vtable
    # and each locking through the mutex's own vtable (+0xc Lock, +0x10
    # Unlock): AddRef (lock, ++count, tail-jump into Unlock), TryAddRef (lock,
    # unlock, then vt+8 -- which is AddRef -- when the count is nonzero: six
    # dispatches per acquire) and Release (lock, --count, unlock; the count
    # reaching zero disposes through two virtuals and stays lifted). All
    # thiscall, no arguments, plain ret.
    0x0040c690: """void sub_0040c690(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x0040c690: host handle AddRef (host_fastpath.c) */
  RECOMP_VA(0x40c690u);
  uint32_t self = s->ECX, mtx = self + 8u;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_guest_range(self, 0x18u) || !isaac_fast_mutex_std(mtx)) { isaac_fastpath_count(0x40c690u, 1); sub_0040c690__lifted(s); return; }
  if (mode == 2) {
    uint32_t cs = MEMR32(mtx + 8u), esp0 = s->ESP, want = (MEMR16(self + 4u) + 1u) & 0xffffu;
    sub_0040c690__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);     /* the tail jump into Unlock */
    isaac_fastpath_count(0x40c690u, 2);
    if (MEMR16(self + 4u) != want || MEMR8(cs + 0x18u) != 0u || s->EAX != 0u || s->ESP != esp0 + 4u)
      isaac_fastpath_mismatch("addref", MEMR16(self + 4u), want);
    return;
  }
  isaac_fast_mutex_take(mtx);
  MEMW16(self + 4u, (uint16_t)(MEMR16(self + 4u) + 1u));
  isaac_fast_mutex_drop(mtx);
  s->EAX = 0u;   /* Unlock's LeaveCriticalSection result, returned through the tail jump */
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    0x0040c6b0: """void sub_0040c6b0(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x0040c6b0: host handle TryAddRef (host_fastpath.c) */
  RECOMP_VA(0x40c6b0u);
  uint32_t self = s->ECX, mtx = self + 8u, count = 0u, vt = 0u;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_guest_range(self, 0x18u) || !isaac_fast_mutex_std(mtx)) { isaac_fastpath_count(0x40c6b0u, 1); sub_0040c6b0__lifted(s); return; }
  count = MEMR16(self + 4u);
  vt = MEMR32(self);
  if (count != 0u && (!isaac_fast_guest_range(vt, 0xcu) || MEMR32(vt + 8u) != 0x0040c690u)) { isaac_fastpath_count(0x40c6b0u, 1); sub_0040c6b0__lifted(s); return; }
  if (mode == 2) {
    uint32_t cs = MEMR32(mtx + 8u), esp0 = s->ESP, want = count ? (count + 1u) & 0xffffu : 0u;
    sub_0040c6b0__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0x40c6b0u, 2);
    if (MEMR16(self + 4u) != want || MEMR8(cs + 0x18u) != 0u || s->EAX != (count ? 1u : 0u) || s->ESP != esp0 + 4u)
      isaac_fastpath_mismatch("tryaddref", MEMR16(self + 4u), s->EAX);
    return;
  }
  isaac_fast_mutex_take(mtx);
  isaac_fast_mutex_drop(mtx);
  if (count) {                                         /* vt+8 == AddRef: its own lock, increment, unlock */
    isaac_fast_mutex_take(mtx);
    MEMW16(self + 4u, (uint16_t)(MEMR16(self + 4u) + 1u));
    isaac_fast_mutex_drop(mtx);
  }
  s->EAX = count ? 1u : 0u;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    0x0040c630: """void sub_0040c630(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x0040c630: host handle Release, count not reaching zero (host_fastpath.c) */
  RECOMP_VA(0x40c630u);
  uint32_t self = s->ECX, mtx = self + 8u, count = 0u;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_guest_range(self, 0x18u) || !isaac_fast_mutex_std(mtx) || MEMR16(self + 4u) == 1u) { isaac_fastpath_count(0x40c630u, 1); sub_0040c630__lifted(s); return; }
  count = MEMR16(self + 4u);
  if (mode == 2) {
    uint32_t cs = MEMR32(mtx + 8u), esp0 = s->ESP, want = count ? count - 1u : 0u;
    sub_0040c630__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0x40c630u, 2);
    if (MEMR16(self + 4u) != want || MEMR8(cs + 0x18u) != 0u || s->EAX != 1u || s->ESP != esp0 + 4u)
      isaac_fastpath_mismatch("release", MEMR16(self + 4u), want);
    return;
  }
  isaac_fast_mutex_take(mtx);
  if (count) MEMW16(self + 4u, (uint16_t)(count - 1u));
  isaac_fast_mutex_drop(mtx);
  s->EAX = 1u;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
    # The owner check over a handle holder {ptr, handle*}: cdecl (holder on the
    # stack), plain ret. Locks the handle's mutex, reads the count, unlocks,
    # and calls 0x00a121b0 on the pointer when the count is exactly 1 -- that
    # case, and a NULL handle's early return, are the lifted body's.
    0x00a12240: """void sub_00a12240(CpuState *restrict s) {
  /* LIFT-PATCH wrap 0x00a12240: host handle owner check (host_fastpath.c) */
  RECOMP_VA(0xa12240u);
  uint32_t holder = MEMR32(s->ESP + 4u), obj = 0u;
  int mode = isaac_fastpath_mode();
  if (mode == 0 || !isaac_fast_guest_range(holder, 8u)) { isaac_fastpath_count(0xa12240u, 1); sub_00a12240__lifted(s); return; }
  obj = MEMR32(holder + 4u);
  if (obj == 0u || !isaac_fast_guest_range(obj, 0x18u) || !isaac_fast_mutex_std(obj + 8u) || MEMR16(obj + 4u) == 1u) { isaac_fastpath_count(0xa12240u, 1); sub_00a12240__lifted(s); return; }
  if (mode == 2) {
    uint32_t cs = MEMR32(obj + 0x10u), esp0 = s->ESP, count = MEMR16(obj + 4u);
    sub_00a12240__lifted(s);
    if (recomp_jmp_pending) recomp_run_pending(s);
    isaac_fastpath_count(0xa12240u, 2);
    if (MEMR16(obj + 4u) != count || MEMR8(cs + 0x18u) != 0u || s->EAX != 0u || s->ESP != esp0 + 4u)
      isaac_fastpath_mismatch("ownercheck", obj, count);
    return;
  }
  isaac_fast_mutex_take(obj + 8u);
  isaac_fast_mutex_drop(obj + 8u);
  s->EAX = 0u;
  s->EIP = MEMR32(s->ESP);
  s->ESP += 4u;
}
""",
}


# Observe-only wrappers. Contract, pinned by tests/recomp-fastpath.test.js:
# each calls its lifted body exactly once and touches neither EIP nor ESP, so
# the guest cannot tell a probed function from an unprobed one. Logging is off
# unless ISAAC_PROBE=1.
#
# These two answer the standing audio question. The dispatch watch says the WAV
# loader is never dispatched, but its callers reach it directly, so "never
# dispatched" and "never called" are not the same claim -- and the same is true
# of the sounds.xml catalogue reader above it.
PROBE_PATCHES: dict[int, str] = {
    # SFX catalogue: reads sounds.xml and builds the sound records
    0x00952df0: """void sub_00952df0(CpuState *restrict s) {
  RECOMP_VA(0x952df0u);
  if (isaac_probe_on()) isaac_probe_hit(0x952df0u, s->ECX, s->EDX, MEMR32(s->ESP + 4u));
  sub_00952df0__lifted(s);
}
""",
    # the sound class's slot +0x1c: load a WAV by path and attach the sample
    0x00a7b6a0: """void sub_00a7b6a0(CpuState *restrict s) {
  RECOMP_VA(0xa7b6a0u);
  if (isaac_probe_on()) isaac_probe_hit(0xa7b6a0u, s->ECX, MEMR32(s->ESP + 4u), 0u);
  sub_00a7b6a0__lifted(s);
}
""",
    # Round 24d: the ogg stream's slot +0x0c, Queue(path, flag) -- the one
    # call the sound path makes after creating a stream. It resolves the path,
    # opens it in the archive (disk fallback), probes it with stb_vorbis and
    # pushes the decoder on the stream's ring; the watch says the probe is
    # never reached, so one of the two lookups hands back nothing.
    0x00a7c760: """void sub_00a7c760(CpuState *restrict s) {
  RECOMP_VA(0xa7c760u);
  if (isaac_probe_on()) {
    isaac_probe_hit(0xa7c760u, s->ECX, MEMR32(s->ESP + 4u), MEMR32(s->ESP + 8u));
    isaac_probe_str(0xa7c760u, "queue path", MEMR32(s->ESP + 4u));
  }
  sub_00a7c760__lifted(s);
  if (isaac_probe_on()) isaac_probe_hit(0xa7c761u, s->EAX & 0xffu, 0u, 0u);   /* its bool result */
}
""",
    # the path resolver the stream asks first (this = the global at 0xc379e0)
    0x00a17180: """void sub_00a17180(CpuState *restrict s) {
  RECOMP_VA(0xa17180u);
  int on = isaac_probe_on();
  if (on) isaac_probe_str(0xa17180u, "resolve in", MEMR32(s->ESP + 4u));
  sub_00a17180__lifted(s);
  if (on) isaac_probe_str(0xa17181u, "resolve out", s->EAX);
}
""",
    # Round 26: the string table. With the resources/ root back the game reads
    # stringtable.sta out of afterbirthp.a instead of the loose file, and the
    # HUD then shows raw keys (#BASEMENT_NAME). The .sta parser and the
    # by-path stream open it uses, with their results.
    0x00a26f20: """void sub_00a26f20(CpuState *restrict s) {
  RECOMP_VA(0xa26f20u);
  int on = isaac_probe_on();
  if (on) isaac_probe_str(0xa26f20u, "sta parse", MEMR32(s->ESP + 4u));
  sub_00a26f20__lifted(s);
  if (on) isaac_probe_hit(0xa26f21u, s->EAX & 0xffu, 0u, 0u);   /* parse result */
}
""",
    # StringTable::GetString(category, language, key, &error): the lookup
    # behind every '#KEY' in the HUD. Prints its inputs, the options language
    # (Manager+0x4a920) and the string it returns (or its
    # "StringTable::Invalid..." reason).
    0x00a26af0: """void sub_00a26af0(CpuState *restrict s) {
  RECOMP_VA(0xa26af0u);
  int on = isaac_probe_on();
  uint32_t cat_ = MEMR32(s->ESP + 4u), lang_ = MEMR32(s->ESP + 8u), key_ = MEMR32(s->ESP + 12u);
  if (on) {
    uint32_t mgr_ = MEMR32(0x00c7169cu);
    isaac_probe_str(0xa26af0u, "lookup category", cat_);
    isaac_probe_str(0xa26af1u, "lookup key", key_);
    isaac_probe_hit(0xa26af0u, lang_, mgr_ ? MEMR32(mgr_ + 0x4a920u) : 0xffffffffu, s->ECX);
    isaac_probe_hit(0xa26af3u, MEMR32(s->ECX + 4u), MEMR32(s->ECX + 8u), MEMR32(s->ECX + 0xcu));   /* langmap head, size, categories */
  }
  sub_00a26af0__lifted(s);
  if (on) isaac_probe_str(0xa26af2u, "lookup result", s->EAX);
}
""",
    # XmlNode::FirstChild(name) (thiscall: ecx = node, [esp+4] = name): the
    # string-table loader walks "stringtable" / "languages" / "language" /
    # "category" / "key" with it. Prints the name, the node and the answer.
    0x00413c70: """void sub_00413c70(CpuState *restrict s) {
  RECOMP_VA(0x413c70u);
  int on = isaac_probe_on();
  uint32_t node_ = s->ECX, name_ = MEMR32(s->ESP + 4u);
  if (on) isaac_probe_str(0x413c70u, "find child", name_);
  sub_00413c70__lifted(s);
  if (on) isaac_probe_hit(0x413c70u, node_, name_, s->EAX);
}
""",
    0x00a178d0: """void sub_00a178d0(CpuState *restrict s) {
  RECOMP_VA(0xa178d0u);
  int on = isaac_probe_on();
  if (on) isaac_probe_str(0xa178d0u, "stream open", MEMR32(s->ESP + 4u));
  sub_00a178d0__lifted(s);
  if (on) isaac_probe_hit(0xa178d1u, s->EAX, s->EAX ? MEMR32(s->EAX) : 0u, s->EAX ? MEMR32(s->EAX + 0x10u) : 0u);   /* stream, vtable, +0x10 */
}
""",
    # the archive open (this = the global at 0xc37a10): out-pointer gets the stream
    0x00a17f40: """void sub_00a17f40(CpuState *restrict s) {
  RECOMP_VA(0xa17f40u);
  int on = isaac_probe_on();
  uint32_t out = MEMR32(s->ESP + 8u);
  if (on) isaac_probe_str(0xa17f40u, "archive open", MEMR32(s->ESP + 4u));
  sub_00a17f40__lifted(s);
  if (on) isaac_probe_hit(0xa17f41u, s->EAX, out, out ? MEMR32(out) : 0xffffffffu);
}
""",
}


def _drop_objects(tu: Path) -> None:
    """A TU whose text changed must be recompiled in every profile."""
    obj = tu.with_suffix(".o")
    if obj.exists():
        obj.unlink()
    for fast in tu.parent.glob(tu.stem + ".fast.o"):
        fast.unlink()


def apply_wrap_patches(lift_dir: Path, check_only: bool = False) -> list[Path]:
    """Install the fastpath wrappers: rename `void sub_X(` to `void sub_X__lifted(`
    (definition only; call sites keep calling sub_X = the wrapper) and append
    the wrapper after the lifted body. Idempotent via the __lifted name; a
    wrapper whose text changed since it was installed is replaced in place
    (round 27: before that, an edited WRAP_PATCHES entry silently kept the
    stale wrapper in the tree)."""
    touched: list[Path] = []
    tus = sorted(lift_dir.glob("lifted_*.c"))
    for va, body in list(WRAP_PATCHES.items()) + list(PROBE_PATCHES.items()):
        name = "sub_%08x" % va
        for tu in tus:
            text = tu.read_text(encoding="utf-8")
            if ("void %s__lifted(CpuState *restrict s) {" % name) in text:
                cur = find_function(text, name)         # already wrapped: is the wrapper current?
                if cur is None:
                    raise SystemExit("wrap-patch %s: lifted body renamed but no wrapper found in %s" % (name, tu.name))
                if text[cur[0]:cur[1]] != body:
                    if not check_only:
                        tu.write_text(text[:cur[0]] + body + text[cur[1]:], encoding="utf-8")
                        _drop_objects(tu)
                        print("wrap-patch %s: wrapper text changed, replaced in %s" % (name, tu.name))
                    touched.append(tu)
                break
            span = find_function(text, name)
            if span is None:
                continue
            if check_only:
                touched.append(tu)
                break
            start, end = span
            lifted = text[start:end].replace("void %s(CpuState *restrict s) {" % name,
                                             "void %s__lifted(CpuState *restrict s) {" % name, 1)
            decl = "void %s__lifted(CpuState *restrict s);\n" % name
            text = text[:start] + decl + lifted + "\n" + body + text[end:]
            tu.write_text(text, encoding="utf-8")
            obj = tu.with_suffix(".o")
            if obj.exists():
                obj.unlink()
            for fast in tu.parent.glob(tu.stem + ".fast.o"):
                fast.unlink()
            touched.append(tu)
            print("wrap-patch %s: lifted body kept as %s__lifted, host wrapper installed in %s"
                  % (name, name, tu.name))
            break
    # a retired wrapper (round 51): a TU still holding sub_X__lifted for an X
    # no longer in WRAP_PATCHES / PROBE_PATCHES gets its lifted body back under
    # its own name; the wrapper and its forward declaration go (the retired
    # wrapper's host function went with it, and the TU would not compile)
    live = set(WRAP_PATCHES) | set(PROBE_PATCHES)
    for tu in tus:
        text = tu.read_text(encoding="utf-8")
        changed = False
        for m in list(re.finditer(r"void (sub_([0-9a-f]{8}))__lifted\(CpuState \*restrict s\) \{", text)):
            name, va = m.group(1), int(m.group(2), 16)
            if va in live:
                continue
            span = find_function(text, name)
            if span is None:
                raise SystemExit("wrap-patch %s: retired, but its wrapper was not found in %s" % (name, tu.name))
            text = text[:span[0]] + text[span[1]:]
            text = text.replace("void %s__lifted(CpuState *restrict s);\n" % name, "", 1)
            text = text.replace("void %s__lifted(CpuState *restrict s) {" % name,
                                "void %s(CpuState *restrict s) {" % name, 1)
            changed = True
            print("wrap-patch %s: retired, the lifted body is %s again in %s" % (name, name, tu.name))
        if changed:
            touched.append(tu)
            if not check_only:
                tu.write_text(text, encoding="utf-8")
                _drop_objects(tu)
    return touched


def apply_purge_patches(lift_dir: Path, check_only: bool = False) -> list[Path]:
    """Correct stale baked import purges in the generated C. Returns the TUs
    modified (their objects must be recompiled)."""
    touched: set[Path] = set()
    tus = sorted(lift_dir.glob("lifted_*.c"))
    for name, (wrong, right) in PURGE_PATCHES.items():
        old = "%s(s);\n  s->EIP = MEMR32(s->ESP);\n  s->ESP += 4u + %du;" % (name, wrong)
        new = "%s(s);\n  s->EIP = MEMR32(s->ESP);\n  s->ESP += 4u + %du;" % (name, right)
        total = 0
        for tu in tus:
            text = tu.read_text(encoding="utf-8")
            n = text.count(old)
            if not n:
                continue
            total += n
            if check_only:
                touched.add(tu)
                continue
            tu.write_text(text.replace(old, new), encoding="utf-8")
            obj = tu.with_suffix(".o")
            if obj.exists():
                obj.unlink()
            touched.add(tu)
        if total:
            print("purge-patch %s: %d call site(s) %d->%d%s" % (name, total, wrong, right,
                  " (would fix)" if check_only else " corrected"))
    return sorted(touched)


# ---- entry-first (round 26) ------------------------------------------------
# A lifted function whose Ghidra body absorbed a block BELOW its entry (a
# shared epilogue, the target of a jump) was emitted in address order, so the
# goto-shaped C function fell into that lower block first. The string-table
# loader's second half, sub_00a27038, ran the loader's epilogue at 0x00a2701b
# and returned 0 for every '#KEY' -- the HUD's raw "#BASEMENT_NAME". lift.py
# now emits `goto L_<entry>;` itself; this pass gives the already-lifted tree
# the same goto without a re-lift. Dispatch-loop functions (`pc_ = entry`)
# are immune and skipped.
ENTRY_FIRST_MARK = "LIFT-PATCH entry-first"
_RE_ENTRY_FN = re.compile(r"^void sub_([0-9a-f]{8})(?:__lifted)?\(CpuState \*restrict s\) \{$", re.M)
_RE_ENTRY_RV = re.compile(r"RECOMP_VA\(0x([0-9a-f]+)u\);")


def entry_first_text(text: str) -> tuple[str, int, int]:
    """Return (new_text, fixed_now, below_entry): every goto-shaped function
    whose first block is not its entry gets `goto L_<entry>;` as its first
    statement (and the label, if no jump targeted the entry before)."""
    out: list[str] = []
    pos = 0
    fixed = 0
    below = 0
    anchor = "\n  (void)0;\n"
    for m in _RE_ENTRY_FN.finditer(text):
        entry = int(m.group(1), 16)
        end = text.find("\n}\n", m.end())
        if end < 0:
            break
        span = text[m.end():end]
        if "  uint32_t pc_ = " in span:          # dispatch-loop shape
            continue
        a = span.find(anchor)
        if a < 0:                                 # hand-written body
            continue
        rv = _RE_ENTRY_RV.search(span, a)
        if not rv or int(rv.group(1), 16) == entry:
            continue
        below += 1
        if ENTRY_FIRST_MARK in span:
            continue
        entry_line = "\n  RECOMP_VA(0x%xu);\n" % entry
        e = span.find(entry_line, a)
        if e < 0:
            raise SystemExit("entry-first: sub_%08x has no RECOMP_VA line for its entry" % entry)
        label = "L_%08x: ;" % entry
        new_span = span
        if ("\n" + label + "\n") not in span:
            at = e + len(entry_line)              # the lifter's order: trace line, then label
            new_span = new_span[:at] + label + "\n" + new_span[at:]
        new_span = new_span.replace(
            anchor,
            anchor + "  goto L_%08x;   /* %s: the entry block is not the lowest address */\n" % (entry, ENTRY_FIRST_MARK),
            1)
        out.append(text[pos:m.end()])
        out.append(new_span)
        pos = end
        fixed += 1
    out.append(text[pos:])
    return "".join(out), fixed, below


def apply_entry_first(lift_dir: Path, check_only: bool = False) -> list[Path]:
    """Run entry_first_text over every TU. Returns the TUs modified (their
    objects are dropped so the build recompiles them)."""
    touched: list[Path] = []
    total_fixed = total_below = 0
    for tu in sorted(lift_dir.glob("lifted_*.c")):
        text = tu.read_text(encoding="utf-8")
        new_text, fixed, below = entry_first_text(text)
        total_fixed += fixed
        total_below += below
        if not fixed:
            continue
        if check_only:
            print("entry-first: %d function(s) NOT fixed in %s" % (fixed, tu.name))
            touched.append(tu)
            continue
        tu.write_text(new_text, encoding="utf-8")
        obj = tu.with_suffix(".o")
        if obj.exists():
            obj.unlink()
        touched.append(tu)
        print("entry-first: %d function(s) fixed in %s; %s dropped for recompile" % (fixed, tu.name, obj.name))
    print("entry-first: %d goto-shaped function(s) start below their entry, %d fixed now" % (total_below, total_fixed))
    return touched


def find_function(text: str, name: str) -> tuple[int, int] | None:
    """Return (start, end) of `void <name>(CpuState *restrict s) { ... }` at
    column 0, matching the closing brace at column 0 (the lifter's layout)."""
    m = re.search(r"^void %s\(CpuState \*restrict s\) \{\n" % re.escape(name), text, re.M)
    if not m:
        return None
    end = text.find("\n}\n", m.start())
    if end < 0:
        return None
    return m.start(), end + 3


def apply_lift_patches(lift_dir: Path, check_only: bool = False) -> list[Path]:
    """Apply every patch whose function lives in lift_dir. Returns the TUs
    that were modified (their objects must be recompiled)."""
    touched: list[Path] = []
    tus = sorted(lift_dir.glob("lifted_*.c"))
    for va, (reason, body) in PATCHES.items():
        name = "sub_%08x" % va
        if ("RECOMP_VA(0x%xu);" % va) not in body:
            raise SystemExit("lift patch %s lacks its RECOMP_VA marker" % name)
        hit = None
        for tu in tus:
            text = tu.read_text(encoding="utf-8")
            span = find_function(text, name)
            if span:
                hit = (tu, text, span)
                break
        if not hit:
            print("lift-patch %s: function not found in %s (nothing to do)" % (name, lift_dir))
            continue
        tu, text, (a, b) = hit
        current = text[a:b]
        if current.startswith(body.split("\n", 1)[0]) and MARKER in current:
            print("lift-patch %s: already applied in %s" % (name, tu.name))
            continue
        if check_only:
            print("lift-patch %s: NOT applied in %s (%s)" % (name, tu.name, reason))
            touched.append(tu)
            continue
        new_text = text[:a] + body + text[b:]
        tu.write_text(new_text, encoding="utf-8")
        obj = tu.with_suffix(".o")
        if obj.exists():
            obj.unlink()
        touched.append(tu)
        print("lift-patch %s: applied in %s (%s); %s dropped for recompile" % (
            name, tu.name, reason, obj.name))
    return touched


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dir", type=Path, required=True, help="lift output dir (lifted_*.c)")
    ap.add_argument("--check", action="store_true", help="report only; exit 1 if any patch is missing")
    ap.add_argument("--entry-first", action="store_true",
                    help="run only the entry-first pass (every goto-shaped function starts at its entry block)")
    args = ap.parse_args()
    if args.entry_first:
        touched = apply_entry_first(args.dir, check_only=args.check)
        if args.check:
            return 1 if touched else 0
        return 0
    touched = apply_lift_patches(args.dir, check_only=args.check)
    touched += apply_purge_patches(args.dir, check_only=args.check)
    if args.check:
        return 1 if touched else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
