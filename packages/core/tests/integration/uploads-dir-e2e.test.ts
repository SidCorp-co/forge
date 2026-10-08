/**
 * The integration suite stores uploads outside the checkout. A server started with no UPLOADS_DIR
 * writes them under `./uploads` (`lib/env.ts`), and the suite once did exactly that, leaving
 * `packages/core/uploads/` untracked in the tree after every run (REQ-32, lane A8d). Each file now
 * stores into a directory of its own (`tests/helpers/file-database.ts`), removed when it ends.
 */

import { existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getStorage } from '../../src/integrations/storage/factory.js';
import { env } from '../../src/lib/env.js';
import { FILE_UPLOADS_DIR } from '../helpers/file-database.js';

/** The checkout this suite runs in: two directories above `packages/core`. */
const CHECKOUT = fileURLToPath(new URL('../../../..', import.meta.url));
const inside = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

describe('where the suite stores an upload', () => {
  it('stores it in the file own directory, outside the checkout, and nowhere in the tree', async () => {
    const root = resolve(env.UPLOADS_DIR);
    expect(root).toBe(FILE_UPLOADS_DIR);
    expect(inside(CHECKOUT, root), `${root} is inside the checkout ${CHECKOUT}`).toBe(false);

    const stored = await getStorage().put(
      'uploads-dir-e2e/note.txt',
      Buffer.from('kept'),
      'text/plain',
    );
    expect(inside(FILE_UPLOADS_DIR, stored.path)).toBe(true);
    expect(statSync(stored.path).isFile()).toBe(true);
    expect(existsSync(resolve(CHECKOUT, 'packages/core/uploads/uploads-dir-e2e'))).toBe(false);
    await getStorage().delete(stored.path);
  });
});
