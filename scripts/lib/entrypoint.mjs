import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether node was launched with this module, by real path: a raw comparison misses a symlink or a space (ISS-1236 r6). */
export function launched(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  return realOrNull(entry) === realpathSync(fileURLToPath(moduleUrl));
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
