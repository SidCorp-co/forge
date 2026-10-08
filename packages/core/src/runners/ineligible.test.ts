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
    deviceName: 'dev1',
    status: 'online',
    lastSeenAt: ago(5),
    limitReason: null,
    rateLimitedUntil: null,
    quarantinedUntil: null,
    provisionStatus: null,
    provisionStatusAt: ago(5),
    workspaceInUse: false,
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
        'provision-stalled',
        'provisioning',
        'quarantined',
        'rate-limited',
        'retired',
        'stale',
      ].sort(),
    );
  });
});

describe('a provision that has stopped advancing (ISS-1359)', () => {
  const STALL = 30 * 60;

  it.each(['queued', 'cloning', 'syncing_skills', 'writing_mcp'] as const)(
    'reads %s older than the window as stalled, with its age, never as in progress',
    (provisionStatus) => {
      const hold = classifyRunnerHold(
        row({ provisionStatus, provisionStatusAt: ago(STALL + 90) }),
        NOW,
        WINDOW,
      );

      expect(hold?.reason).toBe('provision-stalled');
      expect(hold?.detail).toBe(provisionStatus);
      expect(hold?.stalledSeconds).toBe(STALL + 90);
    },
  );

  it('reads the edge of the window the way the SQL does: stalled from exactly one window', () => {
    const at = (seconds: number) =>
      classifyRunnerHold(
        row({ provisionStatus: 'cloning', provisionStatusAt: ago(seconds) }),
        NOW,
        WINDOW,
      )?.reason;

    expect(at(STALL)).toBe('provision-stalled');
    expect(at(STALL - 1)).toBe('provisioning');
  });

  it('keeps a provision inside the window in progress, with no age claimed', () => {
    const hold = classifyRunnerHold(
      row({ provisionStatus: 'cloning', provisionStatusAt: ago(STALL - 60) }),
      NOW,
      WINDOW,
    );

    expect(hold?.reason).toBe('provisioning');
    expect(hold?.stalledSeconds).toBeUndefined();
  });

  // The box said so itself; no age turns its own report into a stall.
  it.each(['needs_manual_setup', 'failed'] as const)(
    'never reads %s as stalled, however old',
    (provisionStatus) => {
      const hold = classifyRunnerHold(
        row({ provisionStatus, provisionStatusAt: ago(90 * 86400) }),
        NOW,
        WINDOW,
      );

      expect(hold?.reason).toBe('provisioning');
      expect(hold?.detail).toBe(provisionStatus);
    },
  );

  it('holds nothing against a stalled provision on a box serving the project from it', () => {
    expect(
      classifyRunnerHold(
        row({
          provisionStatus: 'cloning',
          provisionStatusAt: ago(STALL * 100),
          workspaceInUse: true,
        }),
        NOW,
        WINDOW,
      ),
    ).toBeNull();
  });

  it('does not let a live master excuse a provision that is still inside its window', () => {
    expect(
      classifyRunnerHold(
        row({
          provisionStatus: 'cloning',
          provisionStatusAt: ago(60),
          workspaceInUse: true,
        }),
        NOW,
        WINDOW,
      )?.reason,
    ).toBe('provisioning');
  });

  it('lets the next reading speak where the stalled one is excused', () => {
    expect(
      classifyRunnerHold(
        row({
          provisionStatus: 'cloning',
          provisionStatusAt: ago(STALL * 2),
          workspaceInUse: true,
          deviceAgentVersion: '0.9.0',
        }),
        NOW,
        WINDOW,
      )?.reason,
    ).toBe('below-floor');
  });
});
