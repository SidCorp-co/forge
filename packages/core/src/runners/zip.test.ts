import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip } from './zip.js';

// Parse a flat ZIP (no ZIP64) built by buildZip back into { path: content }.
function readZip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    out[name] = inflateRawSync(compressed).toString('utf8');
    i = dataStart + compSize;
  }
  return out;
}

describe('buildZip', () => {
  it('round-trips entries through a real ZIP structure', () => {
    const zip = buildZip([
      { path: 'shop-publish/SKILL.md', data: Buffer.from('# Publish\nbody', 'utf8') },
      { path: 'shop-brief/SKILL.md', data: Buffer.from('brief', 'utf8') },
    ]);
    // Ends with the End-Of-Central-Directory signature.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    const parsed = readZip(zip);
    expect(parsed['shop-publish/SKILL.md']).toBe('# Publish\nbody');
    expect(parsed['shop-brief/SKILL.md']).toBe('brief');
  });

  it('is deterministic — identical entries produce byte-identical output', () => {
    const entries = [{ path: 'a/SKILL.md', data: Buffer.from('hello world', 'utf8') }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });

  it('records the correct entry count in the EOCD', () => {
    const zip = buildZip([
      { path: 'a', data: Buffer.from('1') },
      { path: 'b', data: Buffer.from('2') },
      { path: 'c', data: Buffer.from('3') },
    ]);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(3); // total entries
  });

  it('handles binary content (base64-decoded files)', () => {
    const bin = Buffer.from([0x00, 0xff, 0x10, 0x42]);
    const zip = buildZip([{ path: 'x/logo.png', data: bin }]);
    // Re-extract and compare bytes.
    const compStart = 30 + Buffer.from('x/logo.png').length;
    const compSize = zip.readUInt32LE(18);
    expect(inflateRawSync(zip.subarray(compStart, compStart + compSize)).equals(bin)).toBe(true);
  });
});
