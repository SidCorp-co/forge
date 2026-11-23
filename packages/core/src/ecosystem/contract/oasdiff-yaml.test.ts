/**
 * ISS-1435 (catalog-api FB-834): an openapi contract kept in YAML is loaded and measured by the
 * pinned oasdiff as a JSON one is, and a YAML artifact oasdiff cannot load is refused with its YAML
 * error, never the JSON attempt's "invalid character" at the first byte. These run the binary, so
 * they run where OASDIFF_BIN names it (`pnpm --filter @forge/core oasdiff:fetch`); the door's
 * reading of YAML is `tests/integration/contract-version-source-ref-e2e.test.ts`.
 *
 * The whole-tree guard counts any program but git, grep and node as listing the repository, so this
 * file declares it; oasdiff reads only the temporary files written for it.
 * @gate-input whole-tree
 *
 * @direct-test-of packages/core/src/ecosystem/contract/oasdiff.ts
 * @direct-test-of packages/core/src/ecosystem/contract/measure.ts
 */

import { describe, expect, it } from 'vitest';
import { loadArtifact, measureChange } from './measure.js';

const spec = (paths: string) => `openapi: 3.1.0
info:
  title: catalog admin
  version: 11.1.0
paths:
${paths}`;
const products = `  /products:
    get:
      responses:
        "200":
          description: the products
`;
const items = `  /items:
    get:
      responses:
        "200":
          description: the items
`;

describe.skipIf(!process.env.OASDIFF_BIN)('the pinned oasdiff on a YAML openapi artifact', () => {
  it('loads a YAML artifact and measures the change between two YAML versions', async () => {
    await expect(loadArtifact('openapi', spec(products))).resolves.toMatchObject({
      openapi: '3.1.0',
    });

    const diff = await measureChange('openapi', spec(products), spec(products + items));

    expect(diff.tool).toBe('oasdiff');
    expect(diff.classification).toBe('non-breaking');
    expect(diff.changes).toContainEqual(
      expect.objectContaining({ element: 'GET /items', kind: 'added' }),
    );
  });

  it('refuses a YAML artifact oasdiff cannot load with its YAML error', async () => {
    const misplaced = spec(`  /products:
    get:
      responses:
        "200":
          description: the products
          content:
            application/json:
              schema: []
`);

    const refused = await loadArtifact('openapi', misplaced).catch((e: unknown) => e);

    const detail = (refused as { refusals?: { detail: string }[] }).refusals?.[0]?.detail ?? '';
    expect(detail).toContain('yaml error:');
    expect(detail).not.toContain('json error:');
  });
});
