/**
 * ISS-1042 criteria 19–22 — the three readings that say a release run has
 * stopped being a release in progress.
 *
 * Unit, because every one of these is arithmetic over rows and a clock, and
 * both are injected. The row shape is the ledger's, built here rather than
 * read, so a case can put an attempt at an exact millisecond — which is what
 * criterion 22, the boundary, is entirely about.
 */

import { describe, expect, it } from 'vitest';
import { BOUND_DEFAULTS, readBounds } from './bounds.js';
import type { ReleaseAttemptRow } from './ledger.js';

const NOW = 1_800_000_000_000;

let seq = 0;
function attempt(over: Partial<ReleaseAttemptRow> = {}): ReleaseAttemptRow {
  seq += 1;
  return {
    id: `att-${seq}`,
    runId: 'run-1',
    stage: 'deploy',
    idempotencyKey: `k-${seq}`,
    commit: null,
    providerRef: null,
    health: null,
    identity: null,
    verdict: null,
    verdictReason: null,
    readings: null,
    account: null,
    logTail: null,
    logTailTruncated: false,
    logTailReadAt: null,
    logTailReadBy: null,
    startedAt: new Date(NOW),
    settledAt: null,
    ...over,
  } as ReleaseAttemptRow;
}

const at = (ms: number) => new Date(NOW - ms);
const read = (rows: ReleaseAttemptRow[]) => readBounds(rows, { now: NOW });
const bound = (rows: ReleaseAttemptRow[], name: string) =>
  read(rows).bounds.find((b) => b.name === name);

describe('the total bound', () => {
  it('is crossed past the threshold since the run first promoted', () => {
    const rows = [attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.total + 1) })];

    expect(bound(rows, 'total')?.crossed).toBe(true);
  });

  it('is not crossed inside it', () => {
    const rows = [attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.total - 1) })];

    expect(bound(rows, 'total')?.crossed).toBe(false);
  });

  it('is not crossed at exactly the threshold', () => {
    const rows = [attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.total) })];

    expect(bound(rows, 'total')?.crossed).toBe(false);
  });

  it('measures from the FIRST promotion, not the newest', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.total + 60_000) }),
      attempt({ stage: 'promote', startedAt: at(1_000) }),
    ];

    expect(bound(rows, 'total')?.crossed).toBe(true);
  });

  it('is not crossed by a run that has recorded no promotion at all', () => {
    const rows = [attempt({ stage: 'deploy', startedAt: at(BOUND_DEFAULTS.total * 10) })];

    expect(read(rows)).toMatchObject({ holding: false, crossedNames: [] });
  });
});

describe('the stall bound', () => {
  it('is crossed past the threshold since the newest ledger write', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.stall + 1) }),
      attempt({ startedAt: at(BOUND_DEFAULTS.stall + 1) }),
    ];

    expect(bound(rows, 'stall')?.crossed).toBe(true);
  });

  it('is reset by any newer write, including an unsettled one', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.stall + 60_000) }),
      attempt({ startedAt: at(60_000) }),
    ];

    expect(bound(rows, 'stall')?.crossed).toBe(false);
  });

  it('is not crossed at exactly the threshold', () => {
    const rows = [attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.stall) })];

    expect(bound(rows, 'stall')?.crossed).toBe(false);
  });

  it('falls back to the first promotion when the run has written nothing since', () => {
    const rows = [attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.stall + 1) })];

    expect(bound(rows, 'stall')?.measuredMs).toBe(BOUND_DEFAULTS.stall + 1);
  });
});

describe('the regression bound', () => {
  it('is crossed when the newest settled attempt reads down after an earlier one read up', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'up' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'down' }),
    ];

    expect(bound(rows, 'regression')?.crossed).toBe(true);
  });

  it('is not crossed by a run that read down and then up', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'down' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'up' }),
    ];

    expect(bound(rows, 'regression')?.crossed).toBe(false);
  });

  it('is not crossed by a run that has only ever read down', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'down' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'down' }),
    ];

    expect(bound(rows, 'regression')?.crossed).toBe(false);
  });

  it('ignores an attempt that never settled, rather than reading its absent health as down', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'up' }),
      attempt({ startedAt: at(300_000), settledAt: null, health: null }),
    ];

    expect(bound(rows, 'regression')?.crossed).toBe(false);
  });

  it('is crossed on a run with no promotion at all', () => {
    const rows = [
      attempt({ startedAt: at(600_000), settledAt: at(590_000), health: 'up' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'down' }),
    ];

    expect(read(rows)).toMatchObject({ holding: true, crossedNames: ['regression'] });
  });
});

describe('what a crossed bound makes of the run', () => {
  it('reports the run as holding and names every bound it passed', () => {
    const rows = [
      attempt({
        stage: 'promote',
        startedAt: at(BOUND_DEFAULTS.total + 1),
        settledAt: at(BOUND_DEFAULTS.total),
        health: 'up',
      }),
      attempt({
        startedAt: at(BOUND_DEFAULTS.stall + 1),
        settledAt: at(BOUND_DEFAULTS.stall + 1),
        health: 'down',
      }),
    ];

    expect(read(rows)).toMatchObject({
      holding: true,
      crossedNames: ['total', 'stall', 'regression'],
    });
  });

  it('reports a fresh run as holding nothing', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(1_000), settledAt: at(500), health: 'up' }),
    ];

    expect(read(rows)).toMatchObject({ holding: false, crossedNames: [] });
  });

  it('reports all three bounds, crossed or not', () => {
    expect(read([]).bounds.map((b) => b.name)).toEqual(['total', 'stall', 'regression']);
  });
});
