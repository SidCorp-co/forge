/**
 * The four ways a re-cut can be wrong, each planted with the one value it exists to refuse and each
 * asserted on its OWN reason: asserting only that it threw would pass after the rule under test had
 * been deleted and a different one had refused the same call. What the database refuses is in
 * `tests/integration/release-version-e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { ReleaseRecutRefusedError } from './errors.js';
import { type ReleaseRowReading, ruleOnRecut } from './version-store.js';

function highestRow(over: Partial<ReleaseRowReading> = {}): ReleaseRowReading {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    version: { major: 0, minor: 5, patch: 0 },
    status: 'cancelled',
    shipped: false,
    ...over,
  };
}

/** The refusal's own words, so each test names the rule it is standing on. */
function refusalFor(recutOf: string, highest: ReleaseRowReading | null): string {
  try {
    ruleOnRecut(recutOf, highest);
  } catch (err) {
    expect(err).toBeInstanceOf(ReleaseRecutRefusedError);
    return (err as Error).message;
  }
  throw new Error(`ruleOnRecut(${recutOf}) returned instead of refusing`);
}

describe('ruleOnRecut — what it allows', () => {
  it('allows a re-cut of the highest version when that release failed', () => {
    expect(ruleOnRecut('0.5.0', highestRow())).toEqual({ major: 0, minor: 5, patch: 0 });
  });

  it('allows it whichever terminal status the failed run carries', () => {
    for (const status of ['cancelled', 'failed']) {
      expect(ruleOnRecut('0.5.0', highestRow({ status })), status).toEqual({
        major: 0,
        minor: 5,
        patch: 0,
      });
    }
  });

  it('allows a re-cut of a release that was already re-cut once', () => {
    const twice = highestRow({ version: { major: 0, minor: 5, patch: 1 } });
    expect(ruleOnRecut('0.5.1', twice)).toEqual({ major: 0, minor: 5, patch: 1 });
  });
});

describe('ruleOnRecut — what it refuses, each by its own reason', () => {
  it('refuses a `recutOf` that is not a version, naming the shape it wants', () => {
    expect(refusalFor('v0.5', highestRow())).toContain('it is not a version');
    expect(refusalFor('v0.5', highestRow())).toContain('MAJOR.MINOR.PATCH');
  });

  it('refuses a re-cut on a project that has cut nothing, naming the floor', () => {
    expect(refusalFor('0.5.0', null)).toContain('cut no release at all');
    expect(refusalFor('0.5.0', null)).toContain('0.1.0');
  });

  it('refuses a version that is not the highest, naming the one that is', () => {
    // 0.4.0 failed, 0.5.0 was cut afterwards. Re-cutting 0.4.0 would produce 0.4.1, a LOWER
    // version than one already cut, and the sequence would stop being monotonic in cut order.
    const reason = refusalFor('0.4.0', highestRow());
    expect(reason).toContain("this project's highest release is 0.5.0");
    expect(reason).toContain('re-cut of the LAST release');
  });

  it('refuses a release whose run is still open, naming the status', () => {
    for (const status of ['running', 'paused']) {
      const reason = refusalFor('0.5.0', highestRow({ status }));
      expect(reason, status).toContain(`is still ${status}`);
      expect(reason, status).toContain('has not failed yet');
    }
  });

  it('refuses a release that shipped, which is the case a run status cannot see', () => {
    // `cancelled` is what `cancelConcludedRun` leaves on a release that COMPLETED and was aborted
    // afterwards, so ruling on status alone would hand a serving release's number out again.
    const reason = refusalFor('0.5.0', highestRow({ status: 'cancelled', shipped: true }));
    expect(reason).toContain('SHIPPED');
    expect(reason).toContain('reserved for a re-cut after a FAILED release');
  });

  it('refuses an empty or whitespace `recutOf` rather than reading it as none asked for', () => {
    // A caller who sent the field meant to re-cut. Truthiness would read '' as an omission and cut
    // a fresh minor instead, which is the malformed value absorbed rather than refused.
    for (const blank of ['', ' ', '\t']) {
      expect(refusalFor(blank, highestRow()), JSON.stringify(blank)).toContain(
        'it is not a version',
      );
    }
  });

  it('puts the version it refused in the message, so the caller can see what it sent', () => {
    expect(refusalFor('0.4.0', highestRow())).toContain('0.4.0');
    expect(refusalFor('not-a-version', highestRow())).toContain('not-a-version');
  });
});
