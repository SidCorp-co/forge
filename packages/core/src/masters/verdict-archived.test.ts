import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
import { type MasterJudged, masterVerdict as masterVerdict_ } from './verdict.js';

/** Every verdict's English is the sentence it says (`saidDisagreements`). */
const masterVerdict = ((...a: Parameters<typeof masterVerdict_>) => {
  const v = masterVerdict_(...a);
  expect(saidDisagreements(v)).toEqual([]);
  return v;
}) as typeof masterVerdict_;

const HOUR = 3600;

function facts(over: Partial<MasterJudged> = {}): MasterJudged {
  return {
    restarting: null,
    terminal: true,
    standing: 'proceed',
    pane: 'absent',
    capability: null,
    serversReadable: true,
    work: { admissible: 1, owed: 0, poolWaits: false, jobPanes: 0 },
    conversation: { id: 'conv-1', transcript: 'present', elsewhere: 'none' },
    placement: null,
    holding: { kind: 'nothing' },
    turn: { kind: 'ended' },
    idle: {
      noWorkForSeconds: 0,
      pane: { doing: 'idle', lastEvent: 'stop', lastEventAgoSeconds: 0 },
      children: { total: 0, unfinished: [], lastClosedAgoSeconds: null },
    },
    limit: { refusal: null, hooks: 'unheard', turnStartedAgoMs: null },
    nudge: { digest: 'd1', last: null, since: 'unreported' },
    ...over,
  };
}

const online = { runnerStatus: 'online', passOpen: false, archivedAt: null };
const working = { kind: 'resumed' as const, silentMs: 0 };
const ended = { kind: 'host_ended' as const, silentMs: 60_000 };
/** A pane holding runs: the first names' subagents still working, the rest read over. */
const holds = (live: string[], over: string[] = []): MasterJudged['holding'] => ({
  kind: 'these',
  runs: [
    ...live.map((name) => ({ name, subagent: working })),
    ...over.map((name) => ({ name, subagent: ended })),
  ],
});
const alive = (over: Partial<MasterJudged> = {}) =>
  facts({ pane: 'alive', capability: 'current', ...over });
const quietHour = {
  noWorkForSeconds: HOUR,
  pane: { doing: 'idle' as const, lastEvent: 'stop', lastEventAgoSeconds: HOUR },
  children: { total: 2, unfinished: [], lastClosedAgoSeconds: HOUR + 1 },
};

// dev Forge 2026-10-28: project `hop` was archived at 10:15:15Z and 45s later core still answered
// `place` ("work waits"), so the box placed its pane again and opened a pass for it.
describe('archived: an archived project drives no master (ISS-353 soft archive)', () => {
  const at = '2026-10-28T10:15:15.000Z';
  const archived = { ...online, archivedAt: at };
  const named = `project archived at ${at}; unarchive to drive it again`;
  /** A busy, current pane a live project keeps and nudges: owed work, never nudged. */
  const busy = alive({ work: { admissible: 2, owed: 1, poolWaits: true, jobPanes: 0 } });

  it('retires a live pane however much work waits, and nudges nothing', () => {
    const v = masterVerdict(busy, archived);
    expect(v, 'an archived project with a pane up is retired').toMatchObject({ act: 'retire' });
    expect(v.because).toBe(`${named}: its master is retired`);
  });

  it('withholds where no pane is up, however much work waits', () => {
    const v = masterVerdict(facts({ work: busy.work }), archived);
    expect(v, 'an archived project with no pane places none').toMatchObject({
      act: 'withhold',
      reason: 'project_archived',
    });
    expect(v.because).toBe(`${named}: no master is placed`);
  });

  it('leaves a pane undriven while it holds runs or job panes, naming each, and retires it after', () => {
    const holding = alive({
      work: { ...busy.work, jobPanes: 1 },
      holding: holds(['run-a'], ['run-b']),
      idle: { ...quietHour, children: { ...quietHour.children, unfinished: ['run-c'] } },
    });
    const v = masterVerdict(holding, archived);
    expect(v, 'a held pane is neither nudged nor ended').toMatchObject({
      act: 'withhold',
      reason: 'project_archived',
    });
    expect(v.because).toContain(named);
    expect(v.because).toContain('child runs whose close has not finished: run-c');
    expect(v.because).toContain(
      'it holds 1 open run(s) whose subagent may still be working: run-a',
    );
    expect(v.because).toContain('1 job pane(s) still running');
    expect(v.because).not.toContain('run-b');
    const unread = alive({ holding: { kind: 'unknown', why: 'the ledger is locked' } });
    expect(masterVerdict(unread, archived).because).toContain('the ledger is locked');
    const released = alive({ holding: holds([], ['run-a', 'run-b']) });
    expect(masterVerdict(released, archived).act).toBe('retire');
  });

  it('is judged ahead of a draining runner and a box without tmux, after the box-integrity gates', () => {
    expect(
      masterVerdict(facts({ terminal: false }), { ...archived, runnerStatus: 'draining' }),
    ).toMatchObject({ act: 'withhold', reason: 'project_archived' });
    expect(masterVerdict(facts({ standing: 'stood_down' }), archived)).toMatchObject({
      reason: 'project_archived',
    });
    expect(masterVerdict(facts({ restarting: 'update' }), archived)).toMatchObject({
      reason: 'restarting',
    });
    expect(masterVerdict(alive({ standing: 'stood_down' }), archived)).toMatchObject({
      act: 'leave',
      reason: 'stood_down',
    });
  });

  it('unarchived, the same facts are placed and driven again', () => {
    expect(masterVerdict(facts({ work: busy.work }), archived).act).toBe('withhold');
    expect(masterVerdict(facts({ work: busy.work }), online)).toMatchObject({
      act: 'place',
      nudge: true,
    });
    expect(masterVerdict(busy, archived).act).toBe('retire');
    expect(masterVerdict(busy, online)).toMatchObject({ act: 'keep', nudge: true });
  });
});
