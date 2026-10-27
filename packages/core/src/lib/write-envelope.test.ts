// A revisioned document is written whole: `{ baseRevision, document }`. `{ base, patch }` is the
// natural reading of a revisioned write and another door's shape, so it is refused naming the one
// this door takes (CONFIG_WRITE_SHAPE), not as two unknown keys.

import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { envelopeOf } from './write-envelope.js';

function refusal(raw: unknown): { message: string; code: unknown } {
  try {
    envelopeOf(raw);
  } catch (err) {
    if (err instanceof HTTPException) {
      return { message: err.message, code: (err.cause as { code?: unknown })?.code };
    }
    throw err;
  }
  throw new Error('the envelope was taken');
}

describe('the write envelope', () => {
  it('takes the whole document at the revision it was read at, or null for a first write', () => {
    expect(envelopeOf({ baseRevision: 3, document: { a: 1 } })).toEqual({
      baseRevision: 3,
      document: { a: 1 },
    });
    expect(envelopeOf({ baseRevision: null, document: {} }).baseRevision).toBeNull();
  });

  it('refuses { base, patch } by naming the shape it takes and that the document is written whole', () => {
    const r = refusal({ base: { delivery: {} }, patch: { delivery: { judgedOn: 'dev' } } });
    expect(r.code).toBe('CONFIG_WRITE_SHAPE');
    expect(r.message).toContain('{ baseRevision, document }');
    expect(r.message).toContain('written whole, not patched');
  });

  it('refuses an unknown key, and a missing revision, by name', () => {
    expect(refusal({ baseRevision: 1, document: {}, extra: 1 }).message).toContain(
      'unknown body key(s) extra',
    );
    expect(refusal({ document: {} }).message).toContain('baseRevision is required');
  });
});
