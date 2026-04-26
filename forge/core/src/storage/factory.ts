import { env } from '../config/env.js';
import { LocalFsStorage } from './local-fs.js';
import { S3Storage } from './s3.js';
import type { StorageAdapter } from './types.js';

let cached: StorageAdapter | null = null;

/**
 * Returns the singleton storage adapter selected by `STORAGE_DRIVER`.
 * `local` (default) writes to `UPLOADS_DIR`. `s3` returns the (currently
 * stubbed) S3 adapter — calls throw until the implementation lands.
 */
export function getStorage(): StorageAdapter {
  if (cached) return cached;
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET || !env.S3_REGION) {
      throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET and S3_REGION');
    }
    cached = new S3Storage(env.S3_BUCKET, env.S3_REGION);
    return cached;
  }
  cached = new LocalFsStorage(env.UPLOADS_DIR);
  return cached;
}

/** Test-only: drop the cached adapter so a fresh env can take effect. */
export function resetStorageForTests(): void {
  cached = null;
}
