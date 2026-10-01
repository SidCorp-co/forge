import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classify } from './diff.js';
import { DifferUnavailable, IMAGE_OASDIFF, OASDIFF_RELEASES, requireOasdiff } from './oasdiff.js';
import { elementOf, fromChangelog, fromStructural, kindOf } from './openapi-diff.js';

const entry = (level: number, id = 'x') => ({
  id,
  text: id,
  level,
  operation: 'GET',
  path: '/api/a',
});

describe('oasdiff levels map onto the classification, never down', () => {
  it.each([
    ['ERR present', [entry(3), entry(2), entry(1)], 'breaking'],
    ['WARN only', [entry(2), entry(1)], 'unknown'],
    ['INFO only', [entry(1)], 'non-breaking'],
    ['a level this pin does not know', [entry(7)], 'unknown'],
  ])('%s → %s', (_n, entries, want) => {
    expect(classify(fromChangelog(entries))).toBe(want);
  });

  it('names an element by its method and path, and a kind by the check id', () => {
    expect(elementOf({ operation: 'post', path: '/api/x' })).toBe('POST /api/x');
    expect(elementOf({ section: 'components' })).toBe('components');
    expect(kindOf('api-path-removed-without-deprecation')).toBe('removed');
    expect(kindOf('new-required-request-property')).toBe('changed');
    expect(kindOf('endpoint-added')).toBe('added');
    expect(kindOf('endpoint-deprecated')).toBe('deprecated');
  });

  it('an x- extension oasdiff has no check for is unknown, unless it only describes a schema oasdiff judged', () => {
    const diff = {
      paths: {
        modified: {
          '/api/a': {
            operations: {
              modified: {
                GET: {
                  extensions: { added: ['x-forge-auth'], modified: { 'x-forge-validated': {} } },
                },
              },
            },
          },
        },
      },
    };
    const out = fromStructural(diff);
    expect(out.map((c) => `${c.element} ${c.level} ${c.kind}`).sort()).toEqual([
      'GET /api/a info changed',
      'GET /api/a warning added',
    ]);
  });
});

describe('the pinned oasdiff', () => {
  it('is pinned for every platform the image and the boxes build on, and the image pins the same release', () => {
    for (const p of ['linux-x64', 'linux-arm64', 'darwin-arm64'])
      expect(OASDIFF_RELEASES[p]).toMatch(/^[0-9a-f]{64}$/);
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('oasdiff-fetch.js');
    expect(dockerfile).toContain(IMAGE_OASDIFF);
  });

  it('refuses by name when the binary is absent, rather than measuring with nothing', async () => {
    await expect(requireOasdiff({ OASDIFF_BIN: '/nonexistent/oasdiff' })).rejects.toThrow(
      DifferUnavailable,
    );
    await expect(requireOasdiff({ OASDIFF_BIN: '/nonexistent/oasdiff' })).rejects.toThrow(
      /oasdiff is not at \/nonexistent\/oasdiff/,
    );
  });
});
