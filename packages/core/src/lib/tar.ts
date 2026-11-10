/**
 * The tar format, as much of it as a source archive uses: regular files and directories, with a
 * long path carried in a pax header (what `git archive` and GitHub write) or a GNU long-name entry,
 * or split into the ustar prefix. Anything else, a link or a device, is reported as its kind for
 * the caller to refuse; nothing is dropped here.
 */

export type TarKind = 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';

export interface TarEntry {
  /** Relative, `/`-separated; a directory's has no trailing slash. */
  path: string;
  kind: TarKind;
  mode: number;
  /** Seconds since the epoch. */
  mtime: number;
  data: Buffer;
}

const BLOCK = 512;

export class TarUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarUnreadable';
  }
}

function text(h: Buffer, at: number, length: number): string {
  const field = h.subarray(at, at + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(h: Buffer, at: number, length: number, what: string): number {
  const raw = text(h, at, length).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) throw new TarUnreadable(`a tar header's ${what} is not octal: ${raw}`);
  return Number.parseInt(raw, 8);
}

function checksumOf(h: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
  return sum;
}

/** `LEN key=value\n` records, as a pax extended header holds them. */
function paxRecords(body: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(at, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0)
      throw new TarUnreadable('a pax record has no length');
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return out;
}

const KINDS: Record<string, TarKind> = {
  '0': 'file',
  '\0': 'file',
  '7': 'file',
  '5': 'dir',
  '2': 'symlink',
  '1': 'hardlink',
};

export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let longPath: string | null = null;
  while (at + BLOCK <= archive.length) {
    const h = archive.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (octal(h, 148, 8, 'checksum') !== checksumOf(h)) {
      throw new TarUnreadable(`the tar header at byte ${at} fails its checksum`);
    }
    const size = octal(h, 124, 12, 'size');
    const type = String.fromCharCode(h[156] as number);
    const data = archive.subarray(at + BLOCK, at + BLOCK + size);
    if (data.length < size) throw new TarUnreadable(`the tar entry at byte ${at} is cut short`);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'g') continue;
    if (type === 'x') {
      longPath = paxRecords(data).get('path') ?? longPath;
      continue;
    }
    if (type === 'L') {
      longPath = text(data, 0, data.length);
      continue;
    }
    const prefix = text(h, 345, 155);
    const name = text(h, 0, 100);
    const path = (longPath ?? (prefix ? `${prefix}/${name}` : name)).replace(/\/+$/, '');
    longPath = null;
    entries.push({
      path,
      kind: KINDS[type] ?? 'other',
      mode: octal(h, 100, 8, 'mode'),
      mtime: octal(h, 136, 12, 'mtime'),
      data: Buffer.from(data),
    });
  }
  return entries;
}

function field(h: Buffer, at: number, length: number, value: string): void {
  h.write(value, at, length, 'utf8');
}

function octalField(h: Buffer, at: number, length: number, value: number): void {
  field(h, at, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function header(name: string, type: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  field(h, 0, 100, name);
  octalField(h, 100, 8, mode);
  octalField(h, 108, 8, 0);
  octalField(h, 116, 8, 0);
  octalField(h, 124, 12, size);
  octalField(h, 136, 12, mtime);
  field(h, 156, 1, type);
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  field(h, 148, 8, `${checksumOf(h).toString(8).padStart(6, '0')}\0 `);
  return h;
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

/** One pax record, its length counting its own digits. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`, 'utf8');
}

/** A ustar archive of `entries`, files and directories only; a path past 100 bytes rides a pax header. */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    if (e.kind !== 'file' && e.kind !== 'dir') {
      throw new TarUnreadable(
        `${e.path} is a ${e.kind}, and only files and directories are written`,
      );
    }
    const name = e.kind === 'dir' ? `${e.path}/` : e.path;
    if (Buffer.byteLength(name) > 100) {
      const pax = paxRecord('path', name);
      out.push(header('././@PaxHeader', 'x', pax.length, 0o644, e.mtime), ...padded(pax));
    }
    const size = e.kind === 'file' ? e.data.length : 0;
    out.push(header(name, e.kind === 'dir' ? '5' : '0', size, e.mode, e.mtime));
    if (size > 0) out.push(...padded(e.data));
  }
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}
