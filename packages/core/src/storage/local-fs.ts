import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { StorageAdapter } from './types.js';

export class LocalFsStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer | Uint8Array, _mime: string): Promise<{ path: string }> {
    const path = resolve(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return { path };
  }

  async get(path: string): Promise<Buffer> {
    return readFile(path);
  }
}
