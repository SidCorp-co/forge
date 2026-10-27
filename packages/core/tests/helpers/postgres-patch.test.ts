import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  declaredPatch,
  loadedPostgres,
  markedLines,
  postgresPatchRefusal,
} from './postgres-patch.js';

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the loaded driver, with `edit` applied to it. */
function plantedCopy(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'postgres-patch-'));
  copies.push(dir);
  cpSync(loadedPostgres(), dir, { recursive: true });
  edit(dir);
  return dir;
}

describe('the postgres driver the suites load', () => {
  it('is the patched one in this checkout', () => {
    expect(postgresPatchRefusal()).toBeNull();
  });

  it('reads every file the patch writes, each with the lines that mark it', () => {
    const files = markedLines(readFileSync(declaredPatch().patch, 'utf8'));
    expect([...files.keys()].sort()).toEqual([
      'cjs/src/connection.js',
      'cjs/src/index.js',
      'src/connection.js',
      'src/index.js',
    ]);
    for (const count of files.values()) expect(count).toBeGreaterThan(0);
  });

  it('is refused by name, saying to run pnpm install, where one file lacks the patch', () => {
    const dir = plantedCopy((d) => {
      const file = join(d, 'src/index.js');
      const text = readFileSync(file, 'utf8');
      writeFileSync(
        file,
        text
          .split('\n')
          .filter((l) => !l.includes('forge-core patch'))
          .join('\n'),
      );
    });
    const refusal = postgresPatchRefusal(dir);
    expect(refusal).toMatch(/src\/index\.js carries 0 of the patch's \d+ marked lines/);
    expect(refusal).toContain('Run pnpm install at the repository root');
    expect(refusal).not.toContain('cjs/src/index.js');
  });

  it('is refused by name where the installed version is not the one the patch is for', () => {
    const dir = plantedCopy((d) => {
      const file = join(d, 'package.json');
      writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: '3.4.8' }),
      );
    });
    expect(postgresPatchRefusal(dir)).toMatch(/it is version 3\.4\.8, and .* patches 3\.4\.9/);
  });
});
