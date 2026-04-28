import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsStorage } from './local-fs.js';

describe('LocalFsStorage', () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forge-storage-'));
    storage = new LocalFsStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips put/get', async () => {
    const data = Buffer.from('hello-world', 'utf8');
    const { path } = await storage.put('comments/abc/file.txt', data, 'text/plain');
    expect(path.startsWith(root)).toBe(true);

    const out = await storage.get(path);
    expect(out.equals(data)).toBe(true);
  });

  it('creates nested directories on put', async () => {
    const { path } = await storage.put(
      'comments/c1/nested/deep/file.bin',
      Buffer.from([1, 2, 3]),
      'application/octet-stream',
    );
    const out = await storage.get(path);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('propagates ENOENT for missing files', async () => {
    await expect(storage.get(join(root, 'does/not/exist.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
