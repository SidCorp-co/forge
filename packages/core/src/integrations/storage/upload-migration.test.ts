import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MigrationTarget,
  migrateUploads,
  migrationSummary,
  type StoredReference,
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
    describe: () => 'mem://',
  };
  return { target, objects, puts };
}

let root: string;
/** A row the local driver wrote: the absolute path of `key` under UPLOADS_DIR. */
const row = (key: string, id = `row-${key}`): StoredReference => ({
  column: 'issue_attachments.path',
  id,
  path: join(root, key),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iss1365-uploads-'));
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

describe('the upload migration moves only the files a row references (ISS-1365)', () => {
  it('moves each referenced file once, drops the rest uncopied and on disk, and counts both', async () => {
    const { target, objects, puts } = memoryTarget();
    const refs = [row('issues/i1/a.png'), row('feedback/f1/c.bin'), row('issues/i1/a.png', 'r2')];
    const report = await migrateUploads(root, target, refs);
    expect(report).toEqual({
      migrated: { files: 2, bytes: 300 },
      dropped: { files: 1, bytes: 3, keys: ['issues/i1/b.txt'] },
      resolved: 3,
    });
    expect(puts).toEqual(['feedback/f1/c.bin', 'issues/i1/a.png']);
    expect([...objects.keys()].sort()).toEqual(['feedback/f1/c.bin', 'issues/i1/a.png']);
    expect(existsSync(join(root, 'issues/i1/b.txt'))).toBe(true);
    expect(migrationSummary(report, root, target)).toBe(
      `migrated 2 files, 300 bytes, and dropped 1 files, 3 bytes (unreferenced), from ${root} to mem://: count and bytes verified, and all 3 stored paths resolve in the bucket`,
    );
  });

  it('refuses, before copying anything, a row whose key has no file on disk, naming the row and key', async () => {
    const { target, puts } = memoryTarget();
    const run = migrateUploads(root, target, [
      row('issues/i1/a.png'),
      row('issues/i1/gone.png', 'r-gone'),
    ]);
    await expect(run).rejects.toBeInstanceOf(UploadMigrationAborted);
    await expect(run).rejects.toThrow(
      `upload migration aborted at ${join(root, 'issues/i1/gone.png')}: issue_attachments.path of row r-gone references issues/i1/gone.png, which has no file under UPLOADS_DIR ${root}`,
    );
    expect(puts).toEqual([]);
  });

  it('refuses a row stored outside UPLOADS_DIR, and an s3:// row outside the bucket prefix', async () => {
    const outside: StoredReference = { column: 'mockups.storage_path', id: 'm1', path: '/elsewhere/x.png' };
    await expect(migrateUploads(root, memoryTarget().target, [outside])).rejects.toThrow(
      `upload migration aborted at /elsewhere/x.png: mockups.storage_path of row m1 is neither a file under UPLOADS_DIR ${root} nor a path under mem://`,
    );
    const foreign: StoredReference = { column: 'mockups.storage_path', id: 'm2', path: 's3://other/x.png' };
    await expect(migrateUploads(root, memoryTarget().target, [foreign])).rejects.toThrow(
      'mockups.storage_path of row m2 is neither a file under UPLOADS_DIR',
    );
  });

  it('counts a row already stored in the bucket as resolving, and refuses one the bucket lacks', async () => {
    const { target, objects } = memoryTarget();
    objects.set('later/new.png', Buffer.from('new'));
    const inBucket: StoredReference = { column: 'issue_attachments.path', id: 'n1', path: 'mem://later/new.png' };
    const report = await migrateUploads(root, target, [row('issues/i1/b.txt'), inBucket]);
    expect(report.migrated).toEqual({ files: 1, bytes: 3 });
    expect(report.resolved).toBe(2);

    const lost: StoredReference = { column: 'issue_attachments.path', id: 'n2', path: 'mem://later/lost.png' };
    await expect(migrateUploads(root, memoryTarget().target, [lost])).rejects.toThrow(
      "upload migration aborted at mem://later/lost.png: issue_attachments.path of row n2: the bucket's listing does not hold later/lost.png",
    );
  });

  it('aborts naming the first needed file whose put fails, and copies nothing after it', async () => {
    const { target, puts } = memoryTarget({ refuse: 'issues/i1/a.png' });
    const refs = [row('issues/i1/a.png'), row('issues/i1/b.txt'), row('feedback/f1/c.bin')];
    const run = migrateUploads(root, target, refs);
    await expect(run).rejects.toBeInstanceOf(UploadMigrationAborted);
    await expect(run).rejects.toThrow(
      `upload migration aborted at ${join(root, 'issues/i1/a.png')}: the server answered 503 (1 of 3 files copied before it)`,
    );
    expect(puts).toEqual(['feedback/f1/c.bin', 'issues/i1/a.png']);
  });

  it('aborts naming a file whose stored bytes differ from the disk', async () => {
    const { target } = memoryTarget({ corrupt: 'issues/i1/b.txt' });
    await expect(migrateUploads(root, target, [row('issues/i1/b.txt')])).rejects.toThrow(
      `upload migration aborted at ${join(root, 'issues/i1/b.txt')}: read back 4 bytes that differ from the 3 on disk`,
    );
  });

  it("aborts naming a file the bucket's listing does not count", async () => {
    const { target } = memoryTarget({ unlisted: 'issues/i1/a.png' });
    await expect(migrateUploads(root, target, [row('issues/i1/a.png')])).rejects.toThrow(
      `aborted at ${join(root, 'issues/i1/a.png')}: the bucket's listing does not hold issues/i1/a.png`,
    );
  });

  it('refuses an entry that is no regular file, and an UPLOADS_DIR that is not there, never skipping', async () => {
    symlinkSync(join(root, 'issues/i1/a.png'), join(root, 'issues/i1/link.png'));
    const { target, puts } = memoryTarget();
    await expect(migrateUploads(root, target, [])).rejects.toThrow(
      `aborted at ${join(root, 'issues/i1/link.png')}: it is not a regular file or a directory`,
    );
    expect(puts).toEqual([]);
    await expect(migrateUploads(join(root, 'absent'), memoryTarget().target, [])).rejects.toThrow(
      /aborted at .*absent: UPLOADS_DIR cannot be read/,
    );
  });
});
