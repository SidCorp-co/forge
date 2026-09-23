/**
 * The classifier, judged on the property the sentence rests on: ONE reading per
 * box, chosen by a declared order rather than by whichever condition the SQL
 * happens to mention first, and a freshness that never claims a silent box is
 * reporting (ISS-1127).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyRunnerHold,
  RUNNER_HOLD_PRECEDENCE,
  type RunnerLivenessRow,
} from './ineligible.js';

const NOW = new Date('2026-09-23T10:00:00.000Z');
const WINDOW = 30_000;
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function row(over: Partial<RunnerLivenessRow> = {}): RunnerLivenessRow {
  return {
    name: 'dev1',
    status: 'online',
    lastSeenAt: ago(5),
    limitReason: null,
    rateLimitedUntil: null,
    quarantinedUntil: null,
    provisionStatus: null,
    deviceDisabledAt: null,
    deviceAgentVersion: '0.17.8',
    ...over,
  };
}

describe('classifyRunnerHold', () => {
  it('holds nothing against a box the dispatch filter would take', () => {
    expect(classifyRunnerHold(row(), NOW, WINDOW)).toBeNull();
  });

  it('reads a heartbeating draining box as retired, not as offline', () => {
    const hold = classifyRunnerHold(row({ status: 'draining' }), NOW, WINDOW);

    expect(hold?.reason).toBe('retired');
    expect(hold?.detail).toBe('draining');
    expect(hold?.reporting).toBe(true);
  });

  it('reads a heartbeating disabled box the same way', () => {
    expect(classifyRunnerHold(row({ status: 'disabled' }), NOW, WINDOW)?.reason).toBe('retired');
  });

  it('does not call a retired box that has gone silent a reporting one', () => {
    const hold = classifyRunnerHold(row({ status: 'draining', lastSeenAt: ago(400) }), NOW, WINDOW);

    expect(hold?.reason).toBe('retired');
    expect(hold?.reporting).toBe(false);
    expect(hold?.lastSeenSeconds).toBe(400);
  });

  it('reads an online box past the window as stale, with how long ago', () => {
    const hold = classifyRunnerHold(row({ lastSeenAt: ago(90) }), NOW, WINDOW);

    expect(hold?.reason).toBe('stale');
    expect(hold?.lastSeenSeconds).toBe(90);
    expect(hold?.reporting).toBe(false);
  });

  // `runnerFresh` is `last_seen_at > now() - window`, strictly, so a heartbeat
  // exactly one window old is stale to the dispatch query. Reading it fresh
  // here dropped the box from the holds and left the blocker naming nobody.
  it('reads the edge of the window as the dispatch query reads it', () => {
    expect(classifyRunnerHold(row({ lastSeenAt: ago(30) }), NOW, WINDOW)?.reason).toBe('stale');
    expect(classifyRunnerHold(row({ lastSeenAt: ago(29) }), NOW, WINDOW)).toBeNull();
  });

  it('tells a box that has never reported from one that has disconnected', () => {
    expect(
      classifyRunnerHold(row({ status: 'offline', lastSeenAt: null }), NOW, WINDOW)?.reason,
    ).toBe('never-connected');
    expect(classifyRunnerHold(row({ status: 'offline' }), NOW, WINDOW)?.reason).toBe(
      'disconnected',
    );
  });

  it('reads a rejected credential under its own name rather than as offline', () => {
    expect(classifyRunnerHold(row({ limitReason: 'auth' }), NOW, WINDOW)?.reason).toBe('auth');
  });

  it('reads the three limits and the version floor', () => {
    expect(
      classifyRunnerHold(row({ rateLimitedUntil: new Date(NOW.getTime() + 60_000) }), NOW, WINDOW)
        ?.reason,
    ).toBe('rate-limited');
    expect(
      classifyRunnerHold(row({ quarantinedUntil: new Date(NOW.getTime() + 60_000) }), NOW, WINDOW)
        ?.reason,
    ).toBe('quarantined');
    expect(classifyRunnerHold(row({ provisionStatus: 'cloning' }), NOW, WINDOW)?.reason).toBe(
      'provisioning',
    );
    expect(classifyRunnerHold(row({ deviceAgentVersion: '0.9.0' }), NOW, WINDOW)?.reason).toBe(
      'below-floor',
    );
  });

  it('lets a limit that has already lapsed through', () => {
    const lapsed = new Date(NOW.getTime() - 60_000);
    expect(classifyRunnerHold(row({ rateLimitedUntil: lapsed }), NOW, WINDOW)).toBeNull();
    expect(classifyRunnerHold(row({ quarantinedUntil: lapsed }), NOW, WINDOW)).toBeNull();
  });

  it('reads a ready workspace as no hold at all', () => {
    expect(classifyRunnerHold(row({ provisionStatus: 'ready' }), NOW, WINDOW)).toBeNull();
  });

  // The SQL is a conjunction and ranks nothing, so a row failing several
  // conditions has to be ranked here or the reading is whichever `if` came
  // first. Each pair below fails two, and the earlier one in the declared order
  // is what the operator is told.
  it.each([
    [{ deviceDisabledAt: NOW, status: 'draining' as const }, 'device-disabled'],
    [{ status: 'draining' as const, limitReason: 'auth' }, 'retired'],
    [{ status: 'draining' as const, lastSeenAt: ago(400) }, 'retired'],
    [{ lastSeenAt: ago(400), limitReason: 'auth' }, 'stale'],
    [{ limitReason: 'auth', provisionStatus: 'cloning' }, 'auth'],
    [{ provisionStatus: 'cloning', deviceAgentVersion: '0.9.0' }, 'provisioning'],
  ])('ranks %o by the declared order', (over, expected) => {
    const hold = classifyRunnerHold(row(over), NOW, WINDOW);

    expect(hold?.reason).toBe(expected);
    expect(RUNNER_HOLD_PRECEDENCE).toContain(hold?.reason);
  });

  it('declares every reading it can return', () => {
    expect([...RUNNER_HOLD_PRECEDENCE].sort()).toEqual(
      [
        'auth',
        'below-floor',
        'device-disabled',
        'disconnected',
        'never-connected',
        'provisioning',
        'quarantined',
        'rate-limited',
        'retired',
        'stale',
      ].sort(),
    );
  });
});
