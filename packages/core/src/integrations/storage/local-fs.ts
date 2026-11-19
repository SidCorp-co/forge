import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isEnoent, type StorageAdapter } from './types.js';

/** A path the s3 driver stored is refused by name, never read as a missing file on this disk. */
function onDisk(path: string): string {
  if (path.startsWith('s3://')) {
    throw new Error(
      `stored path ${path} was written by STORAGE_DRIVER=s3; the local driver cannot read it, so run with STORAGE_DRIVER=s3 and the S3_* settings it was stored under`,
    );
  }
  return path;
}

export class LocalFsStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer | Uint8Array, _mime: string): Promise<{ path: string }> {
    const path = resolve(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { path };
  }

  async get(path: string): Promise<Buffer> {
    return readFile(onDisk(path));
  }

  async delete(path: string): Promise<void> {
    try {
      await unlink(onDisk(path));
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }
}
