import { env } from '../../config/env.js';
import { LocalFsStorage } from './local-fs.js';
import type { StorageAdapter } from './types.js';

let cached: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (cached) return cached;
  cached = new LocalFsStorage(env.UPLOADS_DIR);
  return cached;
}
