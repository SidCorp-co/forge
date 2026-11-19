import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MigrationTarget,
  migrateUploads,
  UploadMigrationAborted,
} from './upload-migration.js';

/** A bucket in memory; `corrupt` stores a key's bytes changed, `refuse` throws on its put. */
function memoryTarget(opts: { corrupt?: string; refuse?: string; unlisted?: string } = {}) {
  const objects = new Map<string, Buffer>();
  const puts: string[] = [];
  const target: MigrationTarget = {
    async put(key, data) {
      puts.push(key);
      if (key === opts.refuse) throw new Error('the server answered 503');
      const bytes = Buffer.from(data);
      objects.set(key, key === opts.corrupt ? Buffer.concat([bytes, Buffer.from('!')]) : bytes);
      return { path: `mem://${key}` };
    },
    async get(path) {
      const found = objects.get(path.slice('mem://'.length));
      if (!found) throw new Error(`no ${path}`);
      return found;
    },
    async sizes() {
      return new Map(
        [...objects].filter(([k]) => k !== opts.unlisted).map(([k, v]) => [k, v.length]),
      );
    },
  };
  return { target, objects, puts };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iss1364-uploads-'));
  mkdirSync(join(root, 'issues/i1'), { recursive: true });
  mkdirSync(join(root, 'feedback/f1'), { recursive: true });
  mkdirSync(join(root, 'empty-dir'), { recursive: true });
  writeFileSync(join(root, 'issues/i1/a.png'), Buffer.alloc(300, 1));
  writeFileSync(join(root, 'issues/i1/b.txt'), 'bee');
  writeFileSync(join(root, 'feedback/f1/c.bin'), Buffer.alloc(0));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the upload migration copies UPLOADS_DIR with the same keys and verifies it (ISS-1364)', () => {
  it('copies every file, empty ones too, and reports the count and the bytes', async () => {
    const { target, objects } = memoryTarget();
    const lines: string[] = [];
    const report = await migrateUploads(root, target, (l) => lines.push(l));
    expect(report).toEqual({ files: 3, bytes: 303 });
    expect([...objects.keys()].sort()).toEqual([
      'feedback/f1/c.bin',
      'issues/i1/a.png',
      'issues/i1/b.txt',
    ]);
    expect(objects.get('issues/i1/b.txt')?.toString()).toBe('bee');
    expect(lines).toHaveLength(3);
  });

  it('aborts naming the first file whose put fails, and copies nothing after it', async () => {
    const { target, puts } = memoryTarget({ refuse: 'issues/i1/a.png' });
    const run = migrateUploads(root, target);
    await expect(run).rejects.toBeInstanceOf(UploadMigrationAborted);
    await expect(run).rejects.toThrow(
      `upload migration aborted at ${join(root, 'issues/i1/a.png')}: the server answered 503 (1 of 3 files copied before it)`,
    );
    expect(puts).toEqual(['feedback/f1/c.bin', 'issues/i1/a.png']);
  });

  it('aborts naming a file whose stored bytes differ from the disk', async () => {
    const { target } = memoryTarget({ corrupt: 'issues/i1/b.txt' });
    await expect(migrateUploads(root, target)).rejects.toThrow(
      `upload migration aborted at ${join(root, 'issues/i1/b.txt')}: read back 4 bytes that differ from the 3 on disk`,
    );
  });

  it("aborts naming a file the bucket's listing does not count", async () => {
    const { target } = memoryTarget({ unlisted: 'issues/i1/a.png' });
    await expect(migrateUploads(root, target)).rejects.toThrow(
      `aborted at ${join(root, 'issues/i1/a.png')}: the bucket's listing does not hold issues/i1/a.png`,
    );
  });

  it('refuses an entry that is no regular file, and an UPLOADS_DIR that is not there, never skipping', async () => {
    symlinkSync(join(root, 'issues/i1/a.png'), join(root, 'issues/i1/link.png'));
    const { target, puts } = memoryTarget();
    await expect(migrateUploads(root, target)).rejects.toThrow(
      `aborted at ${join(root, 'issues/i1/link.png')}: it is not a regular file or a directory`,
    );
    expect(puts).toEqual([]);
    await expect(migrateUploads(join(root, 'absent'), memoryTarget().target)).rejects.toThrow(
      /aborted at .*absent: UPLOADS_DIR cannot be read/,
    );
  });
});
