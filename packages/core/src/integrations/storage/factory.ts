import { env } from '../../lib/env.js';
import { LocalFsStorage } from './local-fs.js';
import { S3Storage, s3SettingsFrom } from './s3.js';
import type { StorageAdapter } from './types.js';

let cached: StorageAdapter | null = null;

/** The one store every upload goes through, chosen by STORAGE_DRIVER (`lib/env.ts`). */
export function getStorage(): StorageAdapter {
  if (cached) return cached;
  cached =
    env.STORAGE_DRIVER === 's3'
      ? new S3Storage(s3SettingsFrom(env), env.UPLOADS_DIR)
      : new LocalFsStorage(env.UPLOADS_DIR);
  return cached;
}
