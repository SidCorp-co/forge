import type { StorageAdapter } from './types.js';

export class S3Storage implements StorageAdapter {
  constructor(
    readonly bucket: string,
    readonly region: string,
  ) {}

  async put(_key: string, _data: Buffer | Uint8Array, _mime: string): Promise<{ path: string }> {
    throw new Error('S3Storage.put is not implemented');
  }

  async get(_path: string): Promise<Buffer> {
    throw new Error('S3Storage.get is not implemented');
  }

  async delete(_path: string): Promise<void> {
    throw new Error('S3Storage.delete is not implemented');
  }
}
