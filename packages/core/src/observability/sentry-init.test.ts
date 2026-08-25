import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

function firstImportLine(file: string): string {
  return (
    readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('import ')) ?? ''
  );
}

describe('sentry init ordering', () => {
  // cm:guard position IS the mechanism, so position is what this asserts. ESM evaluates every imported module before any statement in the importing one, so the `initSentry()` call that sat among index.ts's imports ran after all 170 of them — an import-time crash went unreported by the thing meant to report it. Nothing at runtime distinguishes the fixed order from the broken one until a module actually throws at import, which is why a reordering has to fail here instead.
  it('index.ts imports the side-effect module before anything else', () => {
    expect(firstImportLine('index.ts')).toBe("import './observability/sentry-init.js';");
  });

  // cm:guard a bare `initSentry()` back in index.ts is the exact regression, and it would leave the import above in place while making it pointless — so the position assertion alone cannot catch it.
  it('index.ts does not call initSentry itself', () => {
    const src = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*initSentry\(\)/m);
  });

  it('the side-effect module calls it at module scope', () => {
    const src = readFileSync(join(SRC, 'observability', 'sentry-init.ts'), 'utf8');
    expect(src).toMatch(/^initSentry\(\);$/m);
  });
});
