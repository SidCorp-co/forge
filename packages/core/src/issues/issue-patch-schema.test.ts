import { describe, expect, it } from 'vitest';
import { issuePatchSchema } from './routes-reference.js';

function refusals(body: unknown): string[] {
  const parsed = issuePatchSchema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe('an issue update that writes nothing is refused for what the caller sent (ISS-1229)', () => {
  it('an empty body is told it has no fields, and nothing about an `expect` it did not send', () => {
    const said = refusals({});
    expect(said).toEqual(['no fields to update']);
    expect(said.join(' ')).not.toContain('expect');
  });

  it('a body carrying `expect` alone is still told `expect` needs a field beside it', () => {
    const said = refusals({ expect: { sessionContext: null } });
    expect(said).toEqual([
      '`expect` is a precondition on a write — send the field(s) to write alongside it',
    ]);
  });

  it('a field with `expect` beside it passes', () => {
    expect(refusals({ title: 'a title', expect: { sessionContext: null } })).toEqual([]);
  });
});
