import { describe, expect, it } from 'vitest';
import type { ReleaseHold } from './hold.js';
import { withoutShippedEarlier, withShippedEarlier } from './shipped-earlier-hold.js';

const ABORT: ReleaseHold = {
  code: 'RELEASE_ABORT_BLOCKED',
  reason:
    'Release 0.4.0-dev.75 was aborted by its release run, which named a blocker a person owns.',
  owes: 'human',
  waitingFor: 'record these issues as shipped',
};

const UNREAD = {
  code: 'SHIPPED_EARLIER_UNREAD' as const,
  detail: 'commit abc could not be placed against the releases that shipped: 502 Bad Gateway.',
};

describe('the shipped-earlier clause on a hold', () => {
  it('names a repository that answered but could not place the commit, beside the abort it keeps', () => {
    const held = withShippedEarlier(ABORT, UNREAD);

    expect(held.code).toBe('RELEASE_ABORT_BLOCKED');
    expect(held.owes).toBe('human');
    expect(held.reason.startsWith(ABORT.reason)).toBe(true);
    expect(held.reason).toContain('(SHIPPED_EARLIER_UNREAD): commit abc could not be placed');
    expect(held.reason).toContain('502 Bad Gateway. The next sweep asks the repository again');
    expect(held.reason).not.toContain('Gateway..');
    expect(held.waitingFor).toBe(
      'record these issues as shipped; or, for Forge to settle whether an earlier release shipped ' +
        'it, the repository to answer the comparison on a later sweep',
    );
  });

  it('replaces a clause already there rather than stacking a second', () => {
    const once = withShippedEarlier(ABORT, UNREAD);
    const host = {
      code: 'SHIPPED_EARLIER_HOST_UNAVAILABLE' as const,
      detail: 'this project has no active source host binding (github) — bind its repository',
    };

    expect(withShippedEarlier(once, UNREAD)).toEqual(once);
    const swapped = withShippedEarlier(once, host);
    expect(swapped.reason).toContain('SHIPPED_EARLIER_HOST_UNAVAILABLE');
    expect(swapped.reason).not.toContain('SHIPPED_EARLIER_UNREAD');
    expect(swapped.reason.split('could not settle')).toHaveLength(2);
  });

  it('names a source host or a mark naming its commit for a row with no commit lead, never a box', () => {
    const none = {
      code: 'SHIPPED_EARLIER_NO_COMMIT' as const,
      detail:
        'the repository could not be read; its mark names no commit, so only the commits declaring it can place it, which only a source host reads',
    };
    const held = withShippedEarlier(ABORT, none);

    expect(held.waitingFor).toContain('source host binding');
    expect(held.waitingFor).toContain('its mark naming the commit that landed it');
    expect(`${held.reason} ${held.waitingFor}`).not.toContain('box');
    // ISS-489 r5: said once, through the REST route, and no plugin verb.
    expect(held.reason.split(/names no commit/i)).toHaveLength(2);
    expect(held.reason.split('POST /api/issues/:id/merge')).toHaveLength(2);
    expect(held.reason).not.toMatch(/forge_issues|action=mark/);
    expect(withShippedEarlier(held, none)).toEqual(held);
  });

  it('gives back the hold exactly as its writer worded it where nothing is unsettled', () => {
    expect(withShippedEarlier(ABORT, undefined)).toEqual(ABORT);
    expect(withShippedEarlier(withShippedEarlier(ABORT, UNREAD), undefined)).toEqual(ABORT);
    expect(withoutShippedEarlier(withShippedEarlier(ABORT, UNREAD))).toEqual(ABORT);
  });
});
