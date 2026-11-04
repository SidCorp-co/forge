// ISS-961: the one reading of the gate issues a release run still claims after it ended. agenfold's
// 0.123.0 cut passed over ISS-137, ISS-139 and ISS-141, which the failed 0.122.0 run still claimed,
// and no read said its abort was owed. Each case here is a run the reading must tell apart: ended and
// keeping its claims for an abort, ended with claims the sweep lets go of, still live, shipped, and none.
// @direct-test-of packages/core/src/release-batch/ended-claims.ts
// @direct-test-of packages/core/src/release-batch/blocker-sentences.ts

import { describe, expect, it } from 'vitest';
import { releaseBlockerSentence } from './blocker-sentences.js';
import { endedRunHolds, type HoldingRun, heldIssues, type ShippedAfter } from './ended-claims.js';

const PROJECT = 'p-1';
const FAILED = 'run-0122';
const LIVE = 'run-0124';
const SHIPPED = 'run-0121';

type Claimed = Parameters<typeof endedRunHolds>[1][number];

const claimed = (id: string, key: string, runId: string, runEnded: boolean): Claimed => ({
  id,
  key,
  standing: 'claimed',
  runId,
  runEnded,
  claimer: 'batch',
  status: 'awaiting_release',
  releasing: true,
});

const run = (id: string, over: Partial<HoldingRun> = {}): [string, HoldingRun] => [
  id,
  {
    id,
    status: 'failed',
    version: '0.122.0',
    cutAt: new Date('2026-11-04T10:00:00Z'),
    shipped: false,
    ...over,
  },
];

const agenfold = [
  claimed('i137', 'ISS-137', FAILED, true),
  claimed('i139', 'ISS-139', FAILED, true),
  claimed('i141', 'ISS-141', FAILED, true),
];

describe('the gate issues an ended release run still claims', () => {
  it('names the run, its issues in order, and the abort it owes, with the URL of that abort', () => {
    const holds = endedRunHolds(
      PROJECT,
      agenfold,
      new Set(['i137', 'i139', 'i141']),
      new Map([run(FAILED)]),
      [],
    );

    expect(holds).toEqual([
      expect.objectContaining({
        runId: FAILED,
        version: '0.122.0',
        runStatus: 'failed',
        act: 'abort',
        shippedIn: null,
        issues: [
          { issueId: 'i137', key: 'ISS-137' },
          { issueId: 'i139', key: 'ISS-139' },
          { issueId: 'i141', key: 'ISS-141' },
        ],
      }),
    ]);
    const sentence = holds[0]?.sentence ?? '';
    expect(sentence).toContain('ISS-137, ISS-139, ISS-141 are waiting at the release gate');
    expect(sentence).toContain('release 0.122.0 (run run-0122), which ended `failed`');
    expect(sentence).toContain('POST /api/projects/p-1/release-batches/run-0122/abort');
    expect(sentence).toContain('"promotedRoster":"return-to-gate"');
    expect(sentence).toContain('`carried`');
    expect(sentence).not.toContain('shippedIn');
    expect(heldIssues(holds).map((i) => i.key)).toEqual(['ISS-137', 'ISS-139', 'ISS-141']);
  });

  it('names the release that shipped after the run was cut as the shippedIn of its abort', () => {
    const later: ShippedAfter[] = [
      { runId: SHIPPED, version: '0.121.0', cutAt: new Date('2026-11-03T10:00:00Z') },
      { runId: 'run-0123', version: '0.123.0', cutAt: new Date('2026-11-04T13:03:00Z') },
    ];
    const [hold] = endedRunHolds(
      PROJECT,
      agenfold,
      new Set(['i137']),
      new Map([run(FAILED)]),
      later,
    );

    expect(hold?.act).toBe('abort');
    expect(hold?.shippedIn).toBe('0.123.0');
    expect(hold?.sentence).toContain('"shippedIn":{"version":"0.123.0"');
  });

  it('never names a live run: its claims are its own roster, owing nothing', () => {
    const holds = endedRunHolds(
      PROJECT,
      [claimed('i150', 'ISS-150', LIVE, false)],
      new Set(['i150']),
      new Map([run(LIVE, { status: 'running', version: '0.124.0' })]),
      [],
    );

    expect(holds).toEqual([]);
  });

  it('names an ended run the sweep lets go of as the sweep, owing no abort', () => {
    const [hold] = endedRunHolds(
      PROJECT,
      [claimed('i150', 'ISS-150', FAILED, true)],
      new Set(),
      new Map([run(FAILED, { status: 'cancelled' })]),
      [{ runId: 'run-0123', version: '0.123.0', cutAt: new Date('2026-11-04T13:03:00Z') }],
    );

    expect(hold).toMatchObject({ act: 'sweep', shippedIn: null, runStatus: 'cancelled' });
    expect(hold?.sentence).toContain('the pipeline sweep lets go of that claim within a minute');
    expect(hold?.sentence).not.toContain('/abort');
  });

  it('owes no abort for a run that shipped, whatever its claims say', () => {
    const [hold] = endedRunHolds(
      PROJECT,
      [claimed('i150', 'ISS-150', SHIPPED, true)],
      new Set(['i150']),
      new Map([run(SHIPPED, { status: 'completed', version: '0.121.0', shipped: true })]),
      [],
    );

    expect(hold?.act).toBe('sweep');
  });

  it('names nothing where no claim stands, and nothing for an issue barred by its status', () => {
    expect(endedRunHolds(PROJECT, [], new Set(), new Map(), [])).toEqual([]);
    expect(
      endedRunHolds(
        PROJECT,
        [{ id: 'i9', key: 'ISS-9', standing: 'status', status: 'closed' }],
        new Set(),
        new Map(),
        [],
      ),
    ).toEqual([]);
  });

  it('is one entry per run, each with its own act, the order the claims came in', () => {
    const holds = endedRunHolds(
      PROJECT,
      [
        claimed('i137', 'ISS-137', FAILED, true),
        claimed('i150', 'ISS-150', 'run-0120', true),
        claimed('i139', 'ISS-139', FAILED, true),
      ],
      new Set(['i137']),
      new Map([run(FAILED), run('run-0120', { status: 'cancelled', version: '0.120.0' })]),
      [],
    );

    expect(holds.map((h) => [h.runId, h.act, h.issues.map((i) => i.key)])).toEqual([
      [FAILED, 'abort', ['ISS-137', 'ISS-139']],
      ['run-0120', 'sweep', ['ISS-150']],
    ]);
  });
});

describe('RELEASE_HELD_BY_ENDED_RUN, as a door refuses with it', () => {
  it('says each run in its own words, then why the cut waits', () => {
    const holds = endedRunHolds(PROJECT, agenfold, new Set(['i137']), new Map([run(FAILED)]), []);
    const sentence = releaseBlockerSentence('RELEASE_HELD_BY_ENDED_RUN', {
      issueIds: ['i137', 'i139', 'i141'],
      displayIds: ['ISS-137', 'ISS-139', 'ISS-141'],
      holds,
    });

    expect(sentence.startsWith(holds[0]?.sentence ?? '?')).toBe(true);
    expect(sentence).toContain('A cut waits until no ended run claims an issue at the gate');
  });

  it('falls back to its remedy, naming the issues, where the details carry no run', () => {
    const sentence = releaseBlockerSentence('RELEASE_HELD_BY_ENDED_RUN', {
      issueIds: ['i137'],
      displayIds: ['ISS-137'],
    });

    expect(sentence).toContain('1 issue named here (`ISS-137`) waits at the release gate');
    expect(sentence).toContain('release-batches/:runId/abort');
  });
});
