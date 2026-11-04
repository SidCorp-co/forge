import { saidDisagreements, sayEn } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { finalOf as finalOf_ } from './standing-final.js';
import type { RunFacts } from './standing-types.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const finalOf = ((...a: Parameters<typeof finalOf_>) => checked(finalOf_(...a))) as typeof finalOf_;

// epod ISS-1 2026-10-06: the builder landed the change (merge mark 01:30:22Z) and its CLI's moves to an
// outcome were refused, so the session closed with ISS-1 at in_progress. The run stays handed_back by the
// design's rule, and the reading says the work landed rather than reading as work given back unfinished.

const at = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00Z`);

function closed(landedAt: Record<string, Date>): RunFacts {
  return {
    run: {
      id: 'run-iss-1',
      rawLane: 'run_session',
      status: 'completed',
      startedAt: at('01:11'),
      finishedAt: at('01:33'),
    },
    session: { id: 's', status: 'completed', failureReason: null },
    sessionFlip: { reason: 'run_session_ended', at: at('01:33') },
    runFlip: null,
    job: null,
    issues: ['ISS-1'],
    statuses: { 'ISS-1': 'in_progress' },
    openingStatuses: { 'ISS-1': 'open' },
    endStatuses: { 'ISS-1': 'in_progress' },
    landedAt,
  } as unknown as RunFacts;
}

describe('agent-run-standing handed_back: a carried issue that landed is named as landed', () => {
  it('says the issue landed inside the run and no move to an outcome followed', () => {
    const d = finalOf(closed({ 'ISS-1': at('01:30') }));
    expect(d?.state).toBe('handed_back');
    expect(d && sayEn(d.rule)).toBe(
      'the session closed (ended) with ISS-1 at in_progress (it landed at 2026-10-06T01:30:00.000Z, and no move to an outcome followed), short of an outcome',
    );
  });

  it('says nothing of landing where no merge mark fell inside the run', () => {
    const d = finalOf(closed({}));
    expect(d && sayEn(d.rule)).toBe(
      'the session closed (ended) with ISS-1 at in_progress, short of an outcome',
    );
    // the vi run page read this English (live QA, 2026-10-08): it goes out as a key with its values
    expect(d?.rule).toEqual({
      key: 'runs.final.shortOf',
      vars: {
        close: { key: 'runs.final.close', vars: { close: 'ended' } },
        missed: [
          { key: 'runs.final.missed', vars: { key: 'ISS-1', status: 'in_progress', landed: null } },
        ],
      },
    });
    expect(d?.outcome).toMatchObject({ kind: 'handed_back', says: { detail: d?.rule } });
  });
});

// forge-dev run 813b9556, 2026-11-03T08:24Z: a system run the sweeper failed. No job, no session; its
// close recorded `metadata.failure` {heartbeat_timeout}, and the finished view read it unclassified
// (ISS-932).
function swept(failure: { code: string; detail: string } | null): RunFacts {
  return {
    run: {
      id: '813b9556',
      rawLane: 'system',
      status: 'failed',
      startedAt: new Date('2026-11-03T08:19:59Z'),
      finishedAt: new Date('2026-11-03T08:24:32Z'),
      failure,
    },
    session: null,
    sessionFlip: null,
    runFlip: null,
    job: null,
    issues: [],
    statuses: {},
    openingStatuses: {},
    endStatuses: {},
    landedAt: {},
  } as unknown as RunFacts;
}

describe('a failed run with no job or session names the failure its own close recorded', () => {
  it('reads the recorded cause and its detail, not unclassified', () => {
    const detail =
      'its sessions stopped heartbeating and the sweeper failed them; none had completed';
    const d = finalOf(swept({ code: 'heartbeat_timeout', detail }));
    expect(d?.state).toBe('failed');
    expect(d && sayEn(d.rule)).toBe('failed: heartbeat_timeout');
    expect(d?.outcome).toMatchObject({ cause: 'heartbeat_timeout', classified: true, detail });
  });

  it('still reads unclassified where nothing recorded a cause', () => {
    const d = finalOf(swept(null));
    expect(d && sayEn(d.rule)).toBe('failed with no FAILURE_CAUSES cause recorded: unclassified');
  });
});
