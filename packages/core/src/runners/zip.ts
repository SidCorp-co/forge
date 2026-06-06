/**
 * ISS-387 — minimal, dependency-free ZIP writer.
 *
 * Produces a standard ZIP (PKZIP, DEFLATE method 8) from a set of in-memory
 * entries using only `node:zlib`. We deliberately avoid pulling in `archiver`
 * / `jszip` as a direct dependency (adding to package.json + lockfile trips the
 * monorepo pre-push install gate on merge), and a hand-rolled writer keeps the
 * skills bundle fully deterministic: entries are emitted in caller order with a
 * fixed (zero) timestamp, so identical content always yields byte-identical
 * output — which is what lets `skills-zip` content-hash for cache reuse.
 *
 * Scope: store small UTF-8/binary files (skill SKILL.md + attachments). No ZIP64,
 * no encryption, no streaming — the skills bundle is tiny.
 */

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. `shop-publish/SKILL.md`. */
  path: string;
  data: Buffer;
}

// Standard CRC-32 (IEEE 802.3), table-based.
const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const idx = (crc ^ (buf[i] as number)) & 0xff;
    crc = (CRC_TABLE[idx] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive Buffer from the given entries (caller-ordered). */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);
    const compSize = compressed.length;
    const uncompSize = entry.data.length;

    // Local file header (sig 0x04034b50). DOS time/date = 0 (deterministic).
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method = DEFLATE
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, compressed);

    // Central directory record (sig 0x02014b50).
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  // End of central directory record (sig 0x06054b50).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(centralOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
