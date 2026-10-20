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
  // ISS-1421 r14 — judge-61 read "invalid arguments — `data.status`: Invalid option: expected one
  // of ..." from forge_issues: lower case, no full stop, and every stored value in the sentence.
  it('says what is wrong in a capitalised sentence, the accepted values on a line of their own', () => {
    const text = refusal({ metric: 'vibes' }) ?? '';
    const [sentence, values, ...rest] = text.split('\n');
    expect(sentence).toBe('BAD_REQUEST: The field `metric` takes one of the values listed below.');
    expect(values).toBe('`metric` takes: "cost", "throughput"');
    expect(rest).toEqual([]);
    expect(text).not.toMatch(/"code"|"path"|invalid arguments/);
  });

  it('names a nested field by its dotted path', () => {
    expect(refusal({ metric: 'cost', nested: { n: 'x' } })).toBe(
      'BAD_REQUEST: The field `nested.n` takes a number, not a string.',
    );
  });

  it('names every refused field, not only the first', () => {
    expect(refusal({ metric: 'vibes', nested: { n: 'x' } })).toMatch(
      /^BAD_REQUEST: The field `metric` takes one of the values listed below\. The field `nested\.n` takes a number, not a string\./,
    );
  });

  it('says a missing field is required', () => {
    const schema = z.object({ name: z.string() });
    const r = schema.safeParse({});
    expect(r.success ? null : zodRefusalMessage(r.error)).toBe(
      'BAD_REQUEST: The field `name` is required.',
    );
  });

  it('names an unknown key as a field this call does not take', () => {
    expect(refusal({ metric: 'cost', extra: 1 })).toBe(
      'BAD_REQUEST: The field `extra` is not one this call takes.',
    );
  });

  it('opens every sentence with a capital and ends it with a full stop', () => {
    for (const input of [
      { metric: 'vibes' },
      {},
      { metric: 'cost', extra: 1, nested: { n: 'x' } },
    ]) {
      const sentence = (refusal(input) ?? '').split('\n')[0]?.replace(/^BAD_REQUEST: /, '') ?? '';
      expect(sentence).toMatch(/^[A-Z]/);
      expect(sentence).toMatch(/\.$/);
    }
  });

  it('leaves any other error to the caller', () => {
    expect(zodRefusalMessage(new Error('boom'))).toBeNull();
    expect(zodRefusalMessage(null)).toBeNull();
    expect(zodRefusalMessage({ name: 'ZodError' })).toBeNull();
  });
});
