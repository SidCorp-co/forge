import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  POLICY_AT_OPEN_METADATA_KEY,
  policyCopySchema,
  readRunPolicy,
  stampPolicy,
} from './policy-copy.js';

/**
 * The bytes the box puts on the open, asserted on the producing side by
 * `daemon/policy_copy.rs`. Two hand-written literals agree until somebody edits
 * one; this is the same file read from both languages (the way ISS-1192's
 * `gate-report.fixture.json` is).
 */
const fixture = JSON.parse(
  readFileSync(new URL('./policy-copy.fixture.json', import.meta.url), 'utf8'),
) as {
  accepted: Array<{ case: string; body: unknown }>;
  refused: Array<{ case: string; body: unknown; names: string }>;
};

const RUN = '11111111-1111-4111-8111-111111111111';

/** What the route's validator hands back to the box: the field's own messages. */
function refusal(body: unknown): string {
  const parsed = z.object({ policy: policyCopySchema.optional() }).safeParse({ policy: body });
  if (parsed.success) return '';
  return JSON.stringify(z.flattenError(parsed.error));
}

describe('policyCopySchema', () => {
  it.each(fixture.accepted)('reads $case', ({ body }) => {
    expect(policyCopySchema.safeParse(body).success).toBe(true);
  });

  it.each(fixture.refused)('refuses $case, naming $names', ({ body, names }) => {
    const said = refusal(body);
    expect(said, 'the body was accepted').not.toBe('');
    expect(said).toContain(names);
  });

  it('keeps no field a box did not state', () => {
    const read = policyCopySchema.parse({ named: true, plugin: 'forge@f', version: '1.2.3' });
    expect(read).toEqual({ named: true, plugin: 'forge@f', version: '1.2.3' });
    expect(read).not.toHaveProperty('commit');
  });
});

describe('stampPolicy', () => {
  it('stores what the box named exactly', () => {
    const sent = { named: true as const, plugin: 'forge@forge-local', version: '3.36.542' };
    expect(stampPolicy(sent)).toEqual(sent);
  });

  // The ruling of 2026-09-30: a runner too old to send the field records "none
  // named", which is a true answer and not a refusal.
  it('records that a box which sent nothing named none', () => {
    expect(stampPolicy(undefined)).toEqual({ named: false, reason: 'not_reported' });
  });
});

describe('readRunPolicy', () => {
  it('reads a stamp back as the run holds it', () => {
    const stored = { named: true, plugin: 'forge@forge-local', version: '3.36.542' };
    expect(readRunPolicy({ [POLICY_AT_OPEN_METADATA_KEY]: stored }, RUN)).toEqual({
      read: 'ok',
      policy: stored,
    });
    expect(
      readRunPolicy(
        { [POLICY_AT_OPEN_METADATA_KEY]: { named: false, reason: 'not_reported' } },
        RUN,
      ),
    ).toEqual({ read: 'ok', policy: { named: false, reason: 'not_reported' } });
  });

  it('answers null for a run opened before the stamp existed', () => {
    expect(readRunPolicy({ runIssues: ['ISS-1'] }, RUN)).toBeNull();
    expect(readRunPolicy(null, RUN)).toBeNull();
    expect(readRunPolicy('not an object', RUN)).toBeNull();
  });

  // Half a record is worse than none: a version this reader cannot vouch for
  // would read as a copy that ran.
  it('says unreadable for a stored value it cannot read, never as a copy or as none', () => {
    const read = readRunPolicy(
      { [POLICY_AT_OPEN_METADATA_KEY]: { named: true, plugin: 'forge' } },
      RUN,
    );
    expect(read?.read).toBe('unreadable');
    expect(read).toHaveProperty('reason');
    expect(read).not.toHaveProperty('policy');
  });
});
