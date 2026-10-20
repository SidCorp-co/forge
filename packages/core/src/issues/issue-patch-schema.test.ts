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

// Judge-23 read `forge_issues update` answering `updated` for an unchanged status (ISS-1229 r10).
// This door never took a status at all: a status moves through `/transition`.
describe('an issue update carrying a status', () => {
  it('is refused naming `status`, alone or beside a field', () => {
    for (const body of [{ status: 'open' }, { title: 'a title', status: 'open' }]) {
      const parsed = issuePatchSchema.safeParse(body);
      expect(parsed.success).toBe(false);
      const keys = parsed.success
        ? []
        : parsed.error.issues.flatMap((i) => ('keys' in i ? i.keys : []));
      expect(keys).toEqual(['status']);
    }
  });
});

// Judge-28 sent `status: 'releasing'` here and was told only that the key is unknown (ISS-1421 r2).
describe('an issue update carrying a status is told where a status moves', () => {
  it('says an update writes no status and names POST /api/issues/:id/transition', () => {
    expect(refusals({ title: 'a title', status: 'releasing' })).toEqual([
      'An issue update never writes a status, so this one wrote nothing. A status moves through POST /api/issues/:id/transition, or `forge_issues` `transition`, and only starting a release puts an issue at Releasing.',
    ]);
  });

  it('keeps the plain refusal for any other unknown key', () => {
    expect(refusals({ title: 'a title', colour: 'red' })).toEqual(['Unrecognized key: "colour"']);
  });
});
