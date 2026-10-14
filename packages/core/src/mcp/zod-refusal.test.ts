import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodRefusalMessage } from './zod-refusal.js';

const schema = z
  .object({
    metric: z.enum(['cost', 'throughput']),
    nested: z.object({ n: z.number() }).optional(),
  })
  .strict();

const refusal = (input: unknown) => {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected the schema to refuse');
  return zodRefusalMessage(r.error);
};

describe('zodRefusalMessage', () => {
  it('names the field and what is wrong with it, in one line', () => {
    const text = refusal({ metric: 'vibes' });
    expect(text).toMatch(/^BAD_REQUEST: invalid arguments — `metric`: /);
    expect(text).not.toContain('\n');
    expect(text).not.toMatch(/"code"|"path"/);
    expect(text).toMatch(/cost/);
    expect(text).toMatch(/throughput/);
  });

  it('names a nested field by its dotted path', () => {
    expect(refusal({ metric: 'cost', nested: { n: 'x' } })).toContain('`nested.n`: ');
  });

  it('names every refused field, not only the first', () => {
    expect(refusal({ metric: 'vibes', nested: { n: 'x' } })).toMatch(/`metric`: .*; `nested\.n`: /);
  });

  it('says an unknown key without a field prefix', () => {
    expect(refusal({ metric: 'cost', extra: 1 })).toMatch(/invalid arguments — Unrecognized key/);
  });

  it('leaves any other error to the caller', () => {
    expect(zodRefusalMessage(new Error('boom'))).toBeNull();
    expect(zodRefusalMessage(null)).toBeNull();
    expect(zodRefusalMessage({ name: 'ZodError' })).toBeNull();
  });
});
