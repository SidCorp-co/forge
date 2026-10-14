import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const SCHEMA_FILES = [
  'packages/core/biome.json',
  'packages/web-v2/biome.json',
  'scripts/biome.json',
];

/** The version a biome.json's `$schema` names, or null when it names none. */
export function schemaVersion(config) {
  return /\/schemas\/(\d+\.\d+\.\d+)\/schema\.json$/.exec(config.$schema ?? '')?.[1] ?? null;
}

describe('the biome CLI and the schemas the configs name', () => {
  const pinned = read('packages/core/package.json').devDependencies['@biomejs/biome'];

  it('is pinned to one exact version, so the CLI moves only by an edit that can move the schemas too', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(SCHEMA_FILES)('names the pinned version in the schema of %s', (file) => {
    expect(schemaVersion(read(file)), `${file} lags the pinned CLI ${pinned}`).toBe(pinned);
  });

  it('reads a schema version off a url and refuses to guess one from anything else', () => {
    expect(schemaVersion({ $schema: 'https://biomejs.dev/schemas/2.5.15/schema.json' })).toBe(
      '2.5.15',
    );
    expect(schemaVersion({ $schema: 'https://biomejs.dev/schemas/latest/schema.json' })).toBeNull();
    expect(schemaVersion({})).toBeNull();
  });
});
