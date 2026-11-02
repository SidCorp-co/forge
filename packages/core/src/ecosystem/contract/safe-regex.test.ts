// ISS-910: core runs every provider pattern on re2js, so the pinned re2js is held to what core asks of
// it: a pattern RE2 can hold runs and matches, a pattern it cannot (lookaround, backreference) is
// refused by name before it runs, and every ajv format stays bounded.
// @direct-test-of packages/core/src/ecosystem/contract/safe-regex.ts
// @direct-test-of packages/core/src/ecosystem/contract/elements.ts

import { describe, expect, it } from 'vitest';
import { exampleProblem, indexContract } from './elements.js';
import { boundedFormats, linearRegExp, unsafePatterns } from './safe-regex.js';

const formats = boundedFormats();

function check(name: string, s: string): boolean {
  const f = formats[name];
  if (f === undefined) throw new Error(`no format ${name}`);
  return f === true ? true : typeof f === 'function' ? f(s) : f.validate(s);
}

describe('linearRegExp runs a pattern on RE2', () => {
  it('finds a match anywhere in the input, as ajv expects of a pattern', () => {
    const re = linearRegExp('^[a-z]+-[0-9]{2,4}$');
    expect(re.test('iss-910')).toBe(true);
    expect(re.test('ISS-910')).toBe(false);
    expect(linearRegExp('[0-9]+').test('abc 42 def')).toBe(true);
  });

  it('honours the case-insensitive flag and labels itself like a RegExp', () => {
    const re = linearRegExp('^iss-[0-9]+$', 'i');
    expect(re.test('ISS-910')).toBe(true);
    expect(String(re)).toBe('/^iss-[0-9]+$/i');
  });

  it('matches a classic catastrophic-backtracking shape in linear time', () => {
    const re = linearRegExp('^(a+)+$');
    const input = `${'a'.repeat(50_000)}!`;
    const started = performance.now();
    expect(re.test(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('unsafePatterns names every pattern RE2 cannot hold', () => {
  it('refuses lookahead, lookbehind and a backreference, each at its own path', () => {
    const schema = {
      type: 'object',
      properties: {
        ahead: { type: 'string', pattern: '^(?=a)a$' },
        behind: { type: 'string', pattern: '(?<=a)b' },
        back: { type: 'string', pattern: '(a)\\1' },
        fine: { type: 'string', pattern: '^[a-z]+$' },
      },
      patternProperties: { '^x-(?!internal)': {} },
    };
    const unsafe = unsafePatterns(schema);
    expect(unsafe.map((u) => u.path).sort()).toEqual([
      '/patternProperties/^x-(?!internal)',
      '/properties/ahead/pattern',
      '/properties/back/pattern',
      '/properties/behind/pattern',
    ]);
    for (const u of unsafe) expect(u.why).toMatch(/error parsing regexp/);
  });

  it('reads no pattern out of data keywords, and none out of a schema that holds none', () => {
    expect(
      unsafePatterns({ enum: [{ pattern: '(?=a)' }], examples: [{ pattern: '\\1' }] }),
    ).toEqual([]);
    expect(unsafePatterns({ type: 'string', pattern: '^ok$' })).toEqual([]);
    expect(unsafePatterns(true)).toEqual([]);
  });

  it('walks arrays of subschemas, naming the index', () => {
    expect(unsafePatterns({ anyOf: [{ pattern: '^a$' }, { pattern: '(?=b)' }] })).toMatchObject([
      { path: '/anyOf/1/pattern', pattern: '(?=b)' },
    ]);
  });
});

describe('boundedFormats keeps every ajv format answering, and bounded', () => {
  it('wraps every format ajv-formats ships, and they still judge their values', () => {
    expect(Object.keys(formats).length).toBeGreaterThan(10);
    expect(check('email', 'dev@example.com')).toBe(true);
    expect(check('email', 'not an email')).toBe(false);
    expect(check('date', '2026-11-03')).toBe(true);
    expect(check('date', '2026-13-40')).toBe(false);
    expect(check('uuid', '8d76276a-e0e7-444d-9e59-098d30e1a410')).toBe(true);
  });

  it('refuses a value longer than the bound before any expression runs on it', () => {
    expect(check('email', `${'a'.repeat(5_000)}@example.com`)).toBe(false);
  });
});

describe('exampleProblem checks a payload on RE2, and refuses a pattern RE2 cannot run', () => {
  const index = indexContract('json-schema', {
    type: 'object',
    required: ['key'],
    properties: { key: { type: 'string', pattern: '^ISS-[0-9]+$' } },
  });

  it('passes a payload the pattern matches, and refuses one it does not by name', () => {
    expect(
      exampleProblem(index, { element: '#', direction: 'event', payload: { key: 'ISS-910' } }),
    ).toBeNull();
    expect(
      exampleProblem(index, { element: '#', direction: 'event', payload: { key: 'iss910' } }),
    ).toMatchObject({ code: 'EXAMPLE_NOT_IN_CONTRACT', detail: expect.stringMatching(/\/key/) });
  });

  it('refuses a schema whose pattern needs lookbehind as CONTRACT_PATTERN_UNSAFE, never running it', () => {
    const unsafe = indexContract('json-schema', {
      type: 'object',
      properties: { key: { type: 'string', pattern: '(?<=ISS-)[0-9]+' } },
    });
    expect(
      exampleProblem(unsafe, { element: '#', direction: 'event', payload: { key: 'ISS-1' } }),
    ).toMatchObject({
      code: 'CONTRACT_PATTERN_UNSAFE',
      detail: expect.stringContaining('/properties/key/pattern'),
    });
  });
});
