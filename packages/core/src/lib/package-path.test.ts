import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolvePackageFile } from './package-path.js';

describe('resolvePackageFile', () => {
  it("resolves a dependency's file from a module's URL to a path on disk", () => {
    const path = resolvePackageFile(import.meta.url, 'forge-plugin/package.json');
    expect(path).toMatch(/forge-plugin\/package\.json$/);
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a package that does not resolve, naming it', () => {
    expect(() => resolvePackageFile(import.meta.url, 'no-such-package-iss-1236/x.json')).toThrow(
      /no-such-package-iss-1236/,
    );
  });
});
