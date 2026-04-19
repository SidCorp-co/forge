/**
 * Zip Utilities
 *
 * Pure zip file construction using Node's built-in zlib.
 * No external zip dependencies needed.
 */

/** CRC32 lookup table. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

export function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export async function deflateBuffer(data: Buffer): Promise<Buffer> {
    const { deflateRawSync } = await import('node:zlib');
    return deflateRawSync(data);
}

export async function zipEntry(path: string, data: Buffer) {
    const compressed = await deflateBuffer(data);
    return { path, data, compressed, crc: crc32(data) };
}

export function assembleZip(
    entries: Array<{ path: string; data: Buffer; compressed: Buffer; crc: number }>,
): Buffer {
    const localHeaders: Buffer[] = [];
    const centralHeaders: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const pathBuf = Buffer.from(entry.path, 'utf-8');

        // Local file header (30 bytes + path + compressed data)
        const local = Buffer.alloc(30 + pathBuf.length);
        local.writeUInt32LE(0x04034b50, 0); // signature
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0, 6); // flags
        local.writeUInt16LE(8, 8); // compression: deflate
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0, 12); // mod date
        local.writeUInt32LE(entry.crc, 14); // crc32
        local.writeUInt32LE(entry.compressed.length, 18); // compressed size
        local.writeUInt32LE(entry.data.length, 22); // uncompressed size
        local.writeUInt16LE(pathBuf.length, 26); // filename length
        local.writeUInt16LE(0, 28); // extra field length
        pathBuf.copy(local, 30);

        localHeaders.push(local);
        localHeaders.push(entry.compressed);

        // Central directory header (46 bytes + path)
        const central = Buffer.alloc(46 + pathBuf.length);
        central.writeUInt32LE(0x02014b50, 0); // signature
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0, 8); // flags
        central.writeUInt16LE(8, 10); // compression: deflate
        central.writeUInt16LE(0, 12); // mod time
        central.writeUInt16LE(0, 14); // mod date
        central.writeUInt32LE(entry.crc, 16); // crc32
        central.writeUInt32LE(entry.compressed.length, 20); // compressed size
        central.writeUInt32LE(entry.data.length, 24); // uncompressed size
        central.writeUInt16LE(pathBuf.length, 28); // filename length
        central.writeUInt16LE(0, 30); // extra field length
        central.writeUInt16LE(0, 32); // file comment length
        central.writeUInt16LE(0, 34); // disk number start
        central.writeUInt16LE(0, 36); // internal attrs
        central.writeUInt32LE(0, 38); // external attrs
        central.writeUInt32LE(offset, 42); // local header offset
        pathBuf.copy(central, 46);

        centralHeaders.push(central);
        offset += local.length + entry.compressed.length;
    }

    const centralDirOffset = offset;
    const centralDir = Buffer.concat(centralHeaders);

    // End of central directory (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // signature
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // central dir start disk
    eocd.writeUInt16LE(entries.length, 8); // entries on this disk
    eocd.writeUInt16LE(entries.length, 10); // total entries
    eocd.writeUInt32LE(centralDir.length, 12); // central dir size
    eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
    eocd.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...localHeaders, centralDir, eocd]);
}
