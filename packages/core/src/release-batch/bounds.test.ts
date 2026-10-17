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
import { BOUND_DEFAULTS, readBounds, stallOrigin } from './bounds.js';
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

describe('the stall bound, from the time a box took the job', () => {
  const readTaken = (rows: ReleaseAttemptRow[], takenAgoMs: number | null) =>
    readBounds(rows, { now: NOW, takenAt: takenAgoMs === null ? null : at(takenAgoMs) });
  const stall = (rows: ReleaseAttemptRow[], takenAgoMs: number | null) =>
    readTaken(rows, takenAgoMs).bounds.find((b) => b.name === 'stall');

  it('is crossed for a run that took a job and wrote nothing, past the threshold', () => {
    const reading = readTaken([], BOUND_DEFAULTS.stall + 1);

    expect(stall([], BOUND_DEFAULTS.stall + 1)).toMatchObject({
      crossed: true,
      measuredMs: BOUND_DEFAULTS.stall + 1,
    });
    expect(reading.holding).toBe(true);
    expect(reading.crossedNames).toEqual(['stall']);
  });

  it('is not crossed inside the threshold, nor at it', () => {
    expect(stall([], BOUND_DEFAULTS.stall - 1)?.crossed).toBe(false);
    expect(stall([], BOUND_DEFAULTS.stall)?.crossed).toBe(false);
  });

  it('measures from the newest write where the ledger holds one newer than the job', () => {
    const rows = [attempt({ stage: 'verify', startedAt: at(60_000) })];

    expect(stall(rows, BOUND_DEFAULTS.stall + 1)).toMatchObject({
      crossed: false,
      measuredMs: 60_000,
    });
  });

  it('measures from the job where it is newer than every write, before any promotion', () => {
    const rows = [attempt({ stage: 'verify', startedAt: at(BOUND_DEFAULTS.stall * 2) })];

    expect(stall(rows, 60_000)).toMatchObject({ crossed: false, measuredMs: 60_000 });
    expect(stall(rows, BOUND_DEFAULTS.stall + 5)?.crossed).toBe(true);
  });

  it('reads as it always did where no job time is given', () => {
    const rows = [attempt({ stage: 'verify', startedAt: at(BOUND_DEFAULTS.stall * 2) })];

    expect(readBounds(rows, { now: NOW }).bounds.find((b) => b.name === 'stall')).toMatchObject({
      crossed: false,
      measuredMs: null,
    });
    expect(
      readBounds(rows, { now: NOW, takenAt: null }).bounds.find((b) => b.name === 'stall')?.crossed,
    ).toBe(false);
  });

  it('says what it said before a job time existed, where none is given', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(BOUND_DEFAULTS.stall * 2) }),
      attempt({ stage: 'verify', startedAt: at(60_000) }),
    ];

    for (const opts of [{ now: NOW }, { now: NOW, takenAt: null }]) {
      expect(readBounds(rows, opts).bounds.find((b) => b.name === 'stall')).toEqual({
        name: 'stall',
        crossed: false,
        measuredMs: 60_000,
        thresholdMs: BOUND_DEFAULTS.stall,
        why: LEDGER_WHY,
      });
    }
  });
});

const LEDGER_WHY = 'time since the newest write to this run’s ledger';
const TAKEN_WHY = 'time since a box took this run’s job, with nothing written to its ledger since';

describe('the moment the stall bound says it measured from', () => {
  const why = (rows: ReleaseAttemptRow[], takenAgoMs: number) =>
    readBounds(rows, { now: NOW, takenAt: at(takenAgoMs) }).bounds.find((b) => b.name === 'stall')
      ?.why;
  const verify = (agoMs: number) => attempt({ stage: 'verify', startedAt: at(agoMs) });

  it('names the job where a box took it after every ledger write, or wrote nothing', () => {
    expect(why([], 60_000)).toBe(TAKEN_WHY);
    expect(why([verify(120_000)], 60_000)).toBe(TAKEN_WHY);
  });

  it('names the newest ledger write where it is newer than the job', () => {
    expect(why([verify(60_000)], 120_000)).toBe(LEDGER_WHY);
  });

  it('names the ledger write where it landed at the same instant as the job', () => {
    expect(why([verify(60_000)], 60_000)).toBe(LEDGER_WHY);
  });

  it('agrees with the reading it explains', () => {
    expect(stallOrigin([verify(60_000)], at(120_000))).toEqual({
      at: NOW - 60_000,
      from: 'ledger',
    });
    expect(stallOrigin([verify(120_000)], at(60_000))).toEqual({ at: NOW - 60_000, from: 'taken' });
    expect(stallOrigin([verify(60_000)], at(60_000))).toEqual({ at: NOW - 60_000, from: 'ledger' });
    expect(stallOrigin([], null)).toBeNull();
  });
});

describe('the regression bound', () => {
  it('says no attempt has settled on a run with none', () => {
    const rows = [attempt({ stage: 'promote', startedAt: at(600_000) })];

    expect(bound(rows, 'regression')).toMatchObject({
      crossed: false,
      why: 'no attempt on this run has settled, so there is no reading to compare',
    });
    expect(bound([], 'regression')?.why).toMatch(/^no attempt on this run has settled/);
  });

  it('says the newest settled reading is up when it is', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'down' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'up' }),
    ];

    expect(bound(rows, 'regression')?.why).toBe(
      'the newest settled attempt reads the application up',
    );
  });

  it('says the newest settled attempt recorded no health reading when it has none', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'up' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000) }),
    ];

    expect(bound(rows, 'regression')).toMatchObject({
      crossed: false,
      why: 'the newest settled attempt recorded no health reading',
    });
  });

  it('says no earlier settled attempt read it up when the newest reads down first', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'down' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'down' }),
    ];

    expect(bound(rows, 'regression')?.why).toBe(
      'the newest settled attempt reads the application down, and no settled attempt before it read it up',
    );
  });

  it('keeps the crossing sentence for a crossed bound', () => {
    const rows = [
      attempt({ stage: 'promote', startedAt: at(600_000), settledAt: at(590_000), health: 'up' }),
      attempt({ startedAt: at(300_000), settledAt: at(290_000), health: 'down' }),
    ];

    expect(bound(rows, 'regression')?.why).toBe(
      'the newest settled attempt reads the application down after an earlier one read it up',
    );
  });

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

describe('the bounds of a run that has ended', () => {
  const takenAt = at(BOUND_DEFAULTS.stall * 3);

  it('holds nothing, though a bound was crossed before it ended', () => {
    const reading = readBounds([], { now: NOW, takenAt, ended: { at: null } });
    expect(reading).toMatchObject({ holding: false, crossedNames: ['stall'] });
  });

  it('measures up to the moment it ended, never up to now', () => {
    const ended = new Date(takenAt.getTime() + 60_000);
    const stall = readBounds([], { now: NOW, takenAt, ended: { at: ended } }).bounds.find(
      (b) => b.name === 'stall',
    );
    expect(stall).toMatchObject({ crossed: false, measuredMs: 60_000 });
  });

  it('still holds, while it is open, once the same bound is crossed', () => {
    expect(readBounds([], { now: NOW, takenAt }).holding).toBe(true);
  });
});
