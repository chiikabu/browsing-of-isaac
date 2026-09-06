// zip.mjs -- the store-only writer and the reader the page has used since round 31.
//
// It lived inside play.mjs while the saves menu was the only thing that wanted it.
// The mods menu (round 74) reads zips too, so it moved here rather than being
// written twice. Nothing about it changed: stored and deflated entries in, a flat
// list of {name, bytes} out, and a writer that stores without compressing because
// a save file is 300 KB and the browser is the one waiting.
//
// Deliberately not handled: zip64 (a mod would need 65,536 files or 4 GB), and
// encryption. Both throw rather than returning something half-read.

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }

export function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function zipStore(entries) {
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const { name, bytes } of entries) {
    const n = enc.encode(name), crc = crc32(bytes);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, bytes.length, true); lh.setUint32(22, bytes.length, true); lh.setUint16(26, n.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), n, bytes);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, bytes.length, true); cd.setUint32(24, bytes.length, true); cd.setUint16(28, n.length, true);
    cd.setUint16(30, 0, true); cd.setUint16(32, 0, true); cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + bytes.length;
  }
  let cdLen = 0;
  for (const c of central) cdLen += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true); eocd.setUint32(12, cdLen, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.slice(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    if (!name.endsWith('/')) out.push({ name, bytes });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// The signature of an archive the browser cannot open by itself. A RAR or a 7z
// needs a decoder this page does not carry, and saying so beats failing at the
// central directory with "not a zip file".
export function archiveKind(bytes) {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'zip';
  if (b.length >= 7 && b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07) return 'rar';
  if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return '7z';
  return 'unknown';
}
