import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function dir(): string {
  const d = process.env.ISOLATION_DIR;
  if (!d)
    throw new Error(
      'file-isolation: ISOLATION_DIR is unset; only file-database-isolation-e2e runs these files',
    );
  return d;
}

export const MARKER = (): string => `row-of-${process.env.ISOLATION_MARKER ?? 'unset'}`;

export function leave(name: string, value: string): void {
  writeFileSync(join(dir(), name), value);
}

/** Wait for the file the other fixture leaves, and answer what it holds. */
export async function waitFor(name: string, timeoutMs = 20_000): Promise<string> {
  const path = join(dir(), name);
  const until = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`file-isolation: ${name} never appeared in ${dir()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  return readFileSync(path, 'utf8');
}
