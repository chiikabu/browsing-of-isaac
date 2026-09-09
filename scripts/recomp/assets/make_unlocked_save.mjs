// Turn a save the game wrote into a fully-unlocked one.
//
// The file-select screen rejects an edited save ("CORRUPT DATA") because the
// LAST four bytes are a checksum over [0x10, len-4) -- not the word at 16,
// which is the pre-section word and is itself inside the checksummed range.
// The fold is CRC-shaped but its table is NOT standard CRC-32: the generator
// uses an arithmetic shift on rounds 2..8, so the top byte of every entry
// differs. scripts/decomp/pgd-pure-model.mjs already models it; use that
// rather than a second, divergent implementation.
import { readFileSync, writeFileSync } from 'node:fs';
import { pgdChecksumInit, pgdChecksumUpdate } from '../../decomp/pgd-pure-model.mjs';

const [SRC, DST] = process.argv.slice(2);
const buf = readFileSync(SRC);
const magic = buf.subarray(0, 16).toString('latin1');
if (!magic.startsWith('ISAACNGSAVE')) throw new Error('not a persistentgamedata file: ' + magic);

// section 1: id at 20, capacity at 24, count at 28, then `count` bytes
const id = buf.readUInt32LE(20), cap = buf.readUInt32LE(24), count = buf.readUInt32LE(28);
if (id !== 1) throw new Error('first section is not the achievements (id ' + id + ')');
const start = 32;
console.log(`achievements: id ${id}, cap ${cap}, count ${count}, payload ${start}..${start + count - 1}`);

// the reader normalises with `cmp byte,0 ; setg` -- a SIGNED int8 > 0 means
// unlocked, so 0x80..0xFF would read as locked. 1 is the value the writer emits.
let already = 0;
for (let i = 0; i < count; i++) { if (buf[start + i] > 0) already += 1; buf[start + i] = 1; }
console.log(`unlocked ${count} achievements (${already} were already set)`);

if (process.argv.includes('--items')) {
  // section 4 is the item collection (1 byte per collectible); its header sits
  // right after the achievements payload, so walk the sections to find it
  let off = start + count;
  for (let guard = 0; guard < 16; guard++) {
    const sid = buf.readUInt32LE(off), scap = buf.readUInt32LE(off + 4), scnt = buf.readUInt32LE(off + 8);
    if (sid < 2 || sid > 11) break;
    const payload = off + 12;
    const width = [4, 4, 1, 1, 1, 1, 4, 4, 1][sid - 2] || 1;
    if (sid === 4) {
      for (let i = 0; i < scnt; i++) buf[payload + i] = 1;
      console.log(`item collection: ${scnt} entries marked seen`);
    }
    off = payload + scnt * width;
  }
}

// checksum: the trailing dword, over [0x10, len-4)
const body = buf.subarray(0x10, buf.length - 4);
const st = pgdChecksumInit(1);
pgdChecksumUpdate(st, body, body.length);
const value = st.acc;   // the update folds into the state and returns it
buf.writeUInt32LE(value >>> 0, buf.length - 4);
console.log(`checksum over [0x10, ${buf.length - 4}) = 0x${(value >>> 0).toString(16)} (was 0x${readFileSync(SRC).readUInt32LE(buf.length - 4).toString(16)})`);
writeFileSync(DST, buf);
console.log('wrote ' + DST);
