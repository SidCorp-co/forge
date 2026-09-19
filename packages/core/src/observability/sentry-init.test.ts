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
  it('index.ts imports the side-effect module before anything else', () => {
    expect(firstImportLine('index.ts')).toBe("import './observability/sentry-init.js';");
  });

  it('index.ts does not call initSentry itself', () => {
    const src = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*initSentry\(\)/m);
  });

  it('the side-effect module calls it at module scope', () => {
    const src = readFileSync(join(SRC, 'observability', 'sentry-init.ts'), 'utf8');
    expect(src).toMatch(/^initSentry\(\);$/m);
  });
});
