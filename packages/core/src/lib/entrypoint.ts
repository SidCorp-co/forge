import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `scripts/lib/entrypoint.mjs`'s rule, for core, whose image does not carry `scripts/` (ISS-1236 r6). */
export function isEntrypoint(
  moduleUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (!entry) return false;
  return realOrNull(entry) === realpathSync(fileURLToPath(moduleUrl));
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
