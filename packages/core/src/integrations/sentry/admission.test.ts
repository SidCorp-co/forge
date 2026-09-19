import { describe, expect, it } from 'vitest';
import { ADMIN_THRESHOLD_DEFAULTS } from '../../admin/types.js';
import { judgeSentryIssue, sentryDetectorKey } from './admission.js';
import type { SentryIssueDetail } from './types.js';

const POLICY = { minEventCount: 10, minUserCount: 2 };

function issue(over: Partial<SentryIssueDetail> = {}): SentryIssueDetail {
  return {
    id: '4411',
    shortId: 'FORGE-CORE-9K',
    status: 'unresolved',
    substatus: 'ongoing',
    level: 'error',
    count: 17,
    userCount: 3,
    firstSeen: '2026-09-01T00:00:00Z',
    lastSeen: '2026-09-17T09:00:00Z',
    permalink: 'https://logs.canawan.com/organizations/canawan/issues/4411/',
    projectSlug: 'forge-core',
    title: 'TypeError: cannot read x',
    culprit: 'app/chat/send',
    metadataValue: 'cannot read x of undefined',
    ...over,
  };
}

describe('judgeSentryIssue — what it admits', () => {
  it('admits an unresolved error over both thresholds, and answers with the join key and the detector key', () => {
    expect(judgeSentryIssue(issue(), POLICY)).toEqual({
      admit: true,
      externalId: 'FORGE-CORE-9K',
      detectorKey: 'sentry/forge-core-9k',
    });
  });

  it('admits `fatal` as well as `error`', () => {
    expect(judgeSentryIssue(issue({ level: 'fatal' }), POLICY).admit).toBe(true);
  });

  it('admits a count that is exactly the threshold — the boundary is not a refusal', () => {
    expect(judgeSentryIssue(issue({ count: 10, userCount: 2 }), POLICY).admit).toBe(true);
  });
});

describe('judgeSentryIssue — every refusal names itself', () => {
  it('refuses a level below error, naming the level it carried', () => {
    expect(judgeSentryIssue(issue({ level: 'warning' }), POLICY)).toEqual({
      admit: false,
      reason:
        'Sentry issue FORGE-CORE-9K is level warning, and the admission gate admits error and fatal',
    });
  });

  it('refuses an ABSENT level rather than assuming it', () => {
    const verdict = judgeSentryIssue(issue({ level: null }), POLICY);
    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toBe(
      'Sentry issue FORGE-CORE-9K carries no level, and the admission gate admits error and fatal — an absent level is refused rather than assumed',
    );
  });

  it('refuses a Sentry status that is not unresolved, naming the status it carried', () => {
    const verdict = judgeSentryIssue(issue({ status: 'resolved' }), POLICY);
    expect(verdict.admit === false && verdict.reason).toBe(
      'Sentry issue FORGE-CORE-9K is status resolved, and the admission gate admits unresolved',
    );
  });

  it('refuses an event count below the threshold, naming the count AND the threshold', () => {
    const verdict = judgeSentryIssue(issue({ count: 9 }), POLICY);
    expect(verdict.admit === false && verdict.reason).toBe(
      'Sentry issue FORGE-CORE-9K has 9 event(s), below the admission threshold of 10',
    );
  });

  it('refuses a user count below the threshold, naming the count AND the threshold', () => {
    const verdict = judgeSentryIssue(issue({ userCount: 1 }), POLICY);
    expect(verdict.admit === false && verdict.reason).toBe(
      'Sentry issue FORGE-CORE-9K has affected 1 user(s), below the admission threshold of 2',
    );
  });

  it('refuses an ABSENT event count rather than reading it as zero, and says so in the message', () => {
    const verdict = judgeSentryIssue(issue({ count: null }), POLICY);
    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toMatch(
      /Sentry reported no event count for issue FORGE-CORE-9K.*refused rather than read as zero/,
    );
  });

  it('refuses an ABSENT user count rather than reading it as zero, and says so in the message', () => {
    const verdict = judgeSentryIssue(issue({ userCount: null }), POLICY);
    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toMatch(
      /Sentry reported no affected-user count for issue FORGE-CORE-9K.*refused rather than read as zero/,
    );
  });

  it('refuses an issue with no shortId, because there would be no key a second sighting could match on', () => {
    const verdict = judgeSentryIssue(issue({ shortId: null }), POLICY);
    expect(verdict.admit === false && verdict.reason).toBe(
      'Sentry issue 4411 carries no shortId, which is the external id a second sighting is matched on',
    );
  });

  it('refuses a shortId that cannot form a detector key rather than filing without one', () => {
    const verdict = judgeSentryIssue(issue({ shortId: '###' }), POLICY);
    expect(verdict.admit).toBe(false);
    expect(verdict.admit === false && verdict.reason).toMatch(/cannot form a detector key/);
  });
});

describe('judgeSentryIssue — the thresholds are the caller policy, not a constant', () => {
  it('flips its verdict on the same issue when the policy moves', () => {
    const lenient = judgeSentryIssue(issue({ count: 5, userCount: 1 }), {
      minEventCount: 1,
      minUserCount: 1,
    });
    const strict = judgeSentryIssue(issue({ count: 5, userCount: 1 }), {
      minEventCount: 100,
      minUserCount: 50,
    });
    expect(lenient.admit).toBe(true);
    expect(strict.admit).toBe(false);
  });

  it('the shipped defaults are 10 events and 2 users, and they refuse a 9-event issue', () => {
    expect(ADMIN_THRESHOLD_DEFAULTS.sentryMinEventCount).toBe(10);
    expect(ADMIN_THRESHOLD_DEFAULTS.sentryMinUserCount).toBe(2);
    const defaults = {
      minEventCount: ADMIN_THRESHOLD_DEFAULTS.sentryMinEventCount,
      minUserCount: ADMIN_THRESHOLD_DEFAULTS.sentryMinUserCount,
    };
    expect(judgeSentryIssue(issue({ count: 9 }), defaults).admit).toBe(false);
    expect(judgeSentryIssue(issue({ count: 10 }), defaults).admit).toBe(true);
  });
});

describe('sentryDetectorKey', () => {
  it('folds a Sentry shortId to the lowercase slash-separated slug the kernel accepts', () => {
    expect(sentryDetectorKey('FORGE-WEB-3K')).toBe('sentry/forge-web-3k');
  });

  it('folds punctuation to a single separator rather than dropping it silently', () => {
    expect(sentryDetectorKey('FORGE_WEB.3K')).toBe('sentry/forge-web-3k');
  });

  it('answers null for a shortId that folds to nothing, rather than inventing a key', () => {
    expect(sentryDetectorKey('###')).toBeNull();
    expect(sentryDetectorKey('   ')).toBeNull();
  });

  it('answers null for a shortId too long for the kernel key rule', () => {
    expect(sentryDetectorKey('A'.repeat(200))).toBeNull();
  });
});
