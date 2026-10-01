import { describe, expect, it } from 'vitest';
import { exampleProblem, indexContract } from './elements.js';
import { boundedFormats, FORMAT_MAX_LENGTH, unsafePatterns } from './safe-regex.js';

const tool = (inputSchema: object) =>
  indexContract('mcp-tools', { tools: [{ name: 'forge_x', description: 'd', inputSchema }] });
const check = (inputSchema: object, payload: unknown) =>
  exampleProblem(tool(inputSchema), { element: 'forge_x', direction: 'tool-input', payload });
const timed = <T>(fn: () => T): [T, number] => {
  const t = performance.now();
  const out = fn();
  return [out, performance.now() - t];
};

const id = (schema: object) => ({ type: 'object', properties: { id: schema } });

describe('a provider pattern runs in time linear in the input', () => {
  it('checks a catastrophic-backtracking pattern against the input that stalls a backtracking engine, in milliseconds', () => {
    const [out, ms] = timed(() =>
      check(id({ type: 'string', pattern: '^(a+)+$' }), { id: `${'a'.repeat(5000)}!` }),
    );
    expect(out).toMatchObject({
      code: 'EXAMPLE_NOT_IN_CONTRACT',
      detail: expect.stringContaining('must match pattern'),
    });
    expect(ms).toBeLessThan(1000);
    expect(check(id({ type: 'string', pattern: '^(a+)+$' }), { id: 'aaaa' })).toBeNull();
  });

  it('runs patternProperties on the same engine', () => {
    const schema = { type: 'object', patternProperties: { '^(x+)+y$': { type: 'integer' } } };
    const [out, ms] = timed(() => check(schema, { [`${'x'.repeat(5000)}y`]: 'not an integer' }));
    expect(out?.code).toBe('EXAMPLE_NOT_IN_CONTRACT');
    expect(ms).toBeLessThan(1000);
  });
});

describe('a pattern the linear engine cannot run is refused by name (CONTRACT_PATTERN_UNSAFE)', () => {
  it.each([
    ['a backreference', id({ type: 'string', pattern: '^(a+)\\1$' }), '/properties/id/pattern'],
    ['a lookahead', id({ type: 'string', pattern: '^(?=a)a+$' }), '/properties/id/pattern'],
    [
      'a lookahead in patternProperties',
      { type: 'object', patternProperties: { '^(?!x)': {} } },
      '/patternProperties/^(?!x)',
    ],
  ])('%s, naming where it is', (_n, schema, path) => {
    const out = check(schema, { id: 'a' });
    expect(out?.code).toBe('CONTRACT_PATTERN_UNSAFE');
    expect(out?.detail).toContain(`at ${path} holds the pattern`);
  });

  it('reads a pattern as data under enum, const and default, not as a pattern', () => {
    expect(unsafePatterns({ enum: [{ pattern: '(?=x)' }], default: { pattern: '\\1' } })).toEqual(
      [],
    );
  });
});

describe('formats run on RE2 where it can hold them and on a bounded string everywhere', () => {
  const formats = boundedFormats();
  const fn = (name: string) => {
    const f = formats[name];
    if (typeof f === 'function') return f;
    if (f && typeof f === 'object') return f.validate;
    throw new Error(`${name} is not a checked format`);
  };

  it('refuses a string past the bound, for a format that stays on the native engine', () => {
    expect(fn('hostname')('forge.example.com')).toBe(true);
    expect(fn('url')(`https://e.com/${'a'.repeat(FORMAT_MAX_LENGTH)}`)).toBe(false);
  });

  it('answers the native expressions on adversarial input inside the bound, quickly', () => {
    const [, ms] = timed(() => fn('url')(`http://${'a.'.repeat(1500)}!`));
    expect(ms).toBeLessThan(1000);
  });

  it('keeps a number format checking numbers', () => {
    expect(fn('int32')((2 ** 40) as unknown as string)).toBe(false);
    expect(fn('int32')(7 as unknown as string)).toBe(true);
  });

  it('still refuses a payload a format refuses', () => {
    expect(check(id({ type: 'string', format: 'email' }), { id: 'not an address' })?.code).toBe(
      'EXAMPLE_NOT_IN_CONTRACT',
    );
    expect(check(id({ type: 'string', format: 'email' }), { id: 'a@forge.dev' })).toBeNull();
  });
});
