import { describe, expect, it } from 'vitest';
import { limitHeld, type MasterJudged, masterVerdict, nudgeDue } from './verdict.js';

// ADR 0009, What core takes over: Placement and Retirement were the runner's ensure_master and sweep;
// each case below is one branch of the verdict the box now asks core for and obeys.

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
    outdated: null,
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

const online = { runnerStatus: 'online', passOpen: false };
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
const noWork = { admissible: 0, owed: 0, poolWaits: false, jobPanes: 0 };
const quietHour = {
  noWorkForSeconds: HOUR,
  pane: { doing: 'idle' as const, lastEvent: 'stop', lastEventAgoSeconds: HOUR },
  children: { total: 2, unfinished: [], lastClosedAgoSeconds: HOUR + 1 },
};

describe('withhold: the gates before any pane is looked at', () => {
  it('an unreadable standing withholds before everything, a pane up or not', () => {
    for (const pane of ['absent', 'alive'] as const) {
      expect(
        masterVerdict(facts({ standing: 'unreadable', pane, restarting: 'x' }), online),
      ).toMatchObject({
        act: 'withhold',
        reason: 'standing_unreadable',
      });
    }
  });

  it('a stood-down project with a pane up leaves it, ahead of a restart or a draining runner', () => {
    const v = masterVerdict(facts({ standing: 'stood_down', pane: 'alive', restarting: 'x' }), {
      ...online,
      runnerStatus: 'draining',
    });
    expect(v).toMatchObject({ act: 'leave', reason: 'stood_down' });
  });

  it('a restarting box withholds, and says the cause', () => {
    const v = masterVerdict(facts({ restarting: 'update to 1.2.3' }), online);
    expect(v).toMatchObject({ act: 'withhold', reason: 'restarting' });
    expect(v.because).toContain('update to 1.2.3');
  });

  it('a draining or disabled runner withholds; online and offline do not', () => {
    for (const runnerStatus of ['draining', 'disabled']) {
      expect(masterVerdict(facts(), { ...online, runnerStatus })).toMatchObject({
        act: 'withhold',
        reason: 'runner_not_accepting',
      });
    }
    for (const runnerStatus of ['online', 'offline']) {
      expect(masterVerdict(facts(), { ...online, runnerStatus }).act).toBe('place');
    }
  });

  it('a stood-down project with no pane withholds, and a box without tmux withholds', () => {
    expect(masterVerdict(facts({ standing: 'stood_down' }), online)).toMatchObject({
      act: 'withhold',
      reason: 'stood_down',
    });
    expect(masterVerdict(facts({ terminal: false }), online)).toMatchObject({
      act: 'withhold',
      reason: 'no_terminal',
    });
  });
});

describe('place: no pane is up', () => {
  it('places nothing where nothing is owed', () => {
    expect(masterVerdict(facts({ work: noWork }), online)).toMatchObject({
      act: 'withhold',
      reason: 'nothing_owed',
    });
  });

  it('a waiting pool job alone places a master, whose brief owes no pass', () => {
    expect(masterVerdict(facts({ work: { ...noWork, poolWaits: true } }), online)).toMatchObject({
      act: 'place',
      nudge: false,
    });
  });

  it('owed items alone place a master whose brief is the pass', () => {
    expect(masterVerdict(facts({ work: { ...noWork, owed: 2 } }), online)).toMatchObject({
      act: 'place',
      nudge: true,
    });
  });

  it('withholds while its conversation runs elsewhere, or the box cannot tell', () => {
    const conv = (elsewhere: 'running' | 'unreadable') => ({
      id: 'c',
      transcript: 'present' as const,
      elsewhere,
    });
    expect(masterVerdict(facts({ conversation: conv('running') }), online)).toMatchObject({
      reason: 'conversation_elsewhere',
    });
    expect(masterVerdict(facts({ conversation: conv('unreadable') }), online)).toMatchObject({
      reason: 'conversation_unaskable',
    });
  });

  it('resumes a conversation whose transcript is on the box, and starts cold otherwise', () => {
    expect(masterVerdict(facts(), online)).toMatchObject({ act: 'place', resume: 'conv-1' });
    for (const transcript of ['absent', 'unlocatable'] as const) {
      const v = masterVerdict(
        facts({ conversation: { id: 'conv-1', transcript, elsewhere: 'none' } }),
        online,
      );
      expect(v).toMatchObject({ act: 'place', resume: null });
    }
    expect(
      masterVerdict(
        facts({ conversation: { id: null, transcript: 'absent', elsewhere: 'none' } }),
        online,
      ),
    ).toMatchObject({ act: 'place', resume: null });
  });
});

describe('retire: an idle master', () => {
  it('retires a master with no work, no job pane and an hour of quiet on every signal', () => {
    const v = masterVerdict(alive({ work: noWork, idle: quietHour }), online);
    expect(v.act).toBe('retire');
    expect(v.because).toContain('all 2 child run(s) it declared are closed');
  });

  it('keeps it for each signal that is not quiet', () => {
    const stays: Partial<MasterJudged>[] = [
      { idle: { ...quietHour, noWorkForSeconds: HOUR - 1 } },
      { idle: { ...quietHour, noWorkForSeconds: null } },
      { idle: { ...quietHour, children: { ...quietHour.children, unfinished: ['r1'] } } },
      { idle: { ...quietHour, pane: null } },
      { idle: { ...quietHour, pane: { ...quietHour.pane, doing: 'awaiting_children' } } },
      { idle: { ...quietHour, pane: { ...quietHour.pane, lastEventAgoSeconds: HOUR - 1 } } },
      {
        idle: { ...quietHour, children: { ...quietHour.children, lastClosedAgoSeconds: 60 } },
      },
      { work: { ...noWork, jobPanes: 1 }, idle: quietHour },
      { work: { ...noWork, poolWaits: true }, idle: quietHour },
    ];
    for (const over of stays) {
      expect(masterVerdict(alive({ work: noWork, ...over }), online).act).not.toBe('retire');
    }
  });
});

describe('outdated: replace once nothing it holds is working', () => {
  const outdated = 'placed under 1.0.0, this box runs 1.1.0';

  it('replaces, resuming its conversation, and names the runs its successor inherits', () => {
    const v = masterVerdict(alive({ outdated, holding: holds([], ['r1 (ISS-1)']) }), online);
    expect(v).toMatchObject({ act: 'replace', reason: 'outdated', resume: 'conv-1', nudge: true });
    expect(v.because).toContain('r1 (ISS-1)');
  });

  it('keeps it, naming every reason its replacement waits on', () => {
    const v = masterVerdict(
      alive({
        outdated,
        work: noWork,
        idle: { ...quietHour, noWorkForSeconds: 0 },
        holding: holds(['r2 (ISS-2)'], ['r1']),
        turn: { kind: 'in_turn', what: 'its hooks say a turn is running' },
        conversation: { id: null, transcript: 'absent', elsewhere: 'none' },
      }),
      online,
    );
    expect(v).toMatchObject({ act: 'keep', nudge: false, drain: false });
    for (const said of [
      'no admissible work',
      'r2 (ISS-2)',
      'a turn is running',
      'recorded no conversation',
    ]) {
      expect(v.because).toContain(said);
    }
    expect(v.because).not.toContain('r1');
  });

  it('keeps it where what it holds or its turn cannot be read', () => {
    expect(
      masterVerdict(alive({ outdated, holding: { kind: 'unknown', why: 'mid-carry' } }), online),
    ).toMatchObject({ act: 'keep', drain: true });
    expect(masterVerdict(alive({ outdated, turn: { kind: 'unknown' } }), online)).toMatchObject({
      act: 'keep',
      drain: true,
    });
  });
});

// forge-dev 2026-10-07: forge-master-forge was placed under an older runner and dispatched back to
// back, so every sweep found it holding a run; "left running, not nudged" for two hours while FB-86..91
// sat untriaged. Being outdated decides replacement only: a kept pane is driven like a current one.
describe('outdated: kept and driven while it holds runs, draining toward its replacement', () => {
  const outdated = 'placed under 1.0.0, this box runs 1.1.0';
  const busy = {
    outdated,
    work: { ...noWork, owed: 6 },
    holding: holds(['r7 (ISS-7)']),
  };

  it('owed feedback reaches an outdated master that holds a working run: kept and nudged', () => {
    const v = masterVerdict(alive(busy), online);
    expect(v).toMatchObject({ act: 'keep', nudge: true, drain: true });
    expect(v.because).toContain(outdated);
    expect(v.because).toContain('r7 (ISS-7)');
  });

  it('is nudged on the timing a current master is, an open pass holding a changed digest', () => {
    const changed = {
      digest: 'd2',
      last: { digest: 'd1', agoSeconds: 0 },
      since: 'working' as const,
    };
    expect(
      masterVerdict(alive({ ...busy, nudge: changed }), { ...online, passOpen: true }),
    ).toMatchObject({ act: 'keep', nudge: false, drain: true });
    expect(masterVerdict(alive({ ...busy, nudge: changed }), online)).toMatchObject({
      act: 'keep',
      nudge: true,
    });
  });

  it('a turn still running holds the replacement but not the nudge', () => {
    const v = masterVerdict(
      alive({ ...busy, holding: { kind: 'nothing' }, turn: { kind: 'in_turn', what: 'busy' } }),
      online,
    );
    expect(v).toMatchObject({ act: 'keep', nudge: true, drain: true });
  });

  it('does not drain a pane whose successor would start cold, since nothing would replace it', () => {
    const v = masterVerdict(
      alive({ ...busy, conversation: { id: null, transcript: 'absent', elsewhere: 'none' } }),
      online,
    );
    expect(v).toMatchObject({ act: 'keep', nudge: true, drain: false });
    expect(v.because).toContain('recorded no conversation');
  });

  it('a current master is never drained', () => {
    expect(masterVerdict(alive({ work: { ...noWork, owed: 1 } }), online)).toMatchObject({
      act: 'keep',
      drain: false,
    });
  });

  it('once its runs are over and its turn ended it is replaced, its successor nudged', () => {
    expect(masterVerdict(alive({ ...busy, holding: holds([], ['r7']) }), online)).toMatchObject({
      act: 'replace',
      reason: 'outdated',
      nudge: true,
    });
  });
});

describe('holding: whether a held run is over is read by core from its subagent evidence', () => {
  const outdated = 'placed under 1.0.0, this box runs 1.1.0';
  const held = (subagent: {
    kind: 'turn_ended' | 'awaiting_reply' | 'no_turn_end';
    silentMs: number;
  }) =>
    masterVerdict(
      alive({ outdated, holding: { kind: 'these', runs: [{ name: 'r1 (ISS-1)', subagent }] } }),
      online,
    );

  it('a subagent silent past the hour after its turn or an unanswered entry is over', () => {
    for (const kind of ['turn_ended', 'awaiting_reply'] as const) {
      expect(held({ kind, silentMs: HOUR * 1000 - 1 })).toMatchObject({ act: 'keep' });
      const v = held({ kind, silentMs: HOUR * 1000 });
      expect(v).toMatchObject({ act: 'replace', reason: 'outdated' });
      expect(v.because).toContain('r1 (ISS-1) — its subagent ended a turn');
    }
  });

  it('a subagent that has ended no turn is working however long ago it was declared', () => {
    expect(held({ kind: 'no_turn_end', silentMs: 9 * HOUR * 1000 })).toMatchObject({ act: 'keep' });
  });
});

describe('deaf: a pane the box cannot hear', () => {
  it('is replaced where a successor would be placed', () => {
    expect(masterVerdict(alive({ capability: 'stale' }), online)).toMatchObject({
      act: 'replace',
      reason: 'deaf',
      resume: 'conv-1',
    });
  });

  it('is left with no work, unreadable servers, or its conversation possibly elsewhere', () => {
    for (const over of [
      { work: noWork },
      { serversReadable: false },
      {
        conversation: { id: 'c', transcript: 'present' as const, elsewhere: 'unreadable' as const },
      },
    ]) {
      expect(masterVerdict(alive({ capability: 'stale', ...over }), online)).toMatchObject({
        act: 'leave',
        reason: 'deaf',
      });
    }
  });

  it('an outdated pane left for its running work is still replaced when it cannot be heard', () => {
    const v = masterVerdict(
      alive({
        capability: 'stale',
        outdated: 'old build',
        turn: { kind: 'in_turn', what: 'busy' },
      }),
      online,
    );
    expect(v).toMatchObject({ act: 'replace', reason: 'deaf' });
    expect(
      masterVerdict(
        alive({ outdated: 'old build', turn: { kind: 'in_turn', what: 'busy' } }),
        online,
      ),
    ).toMatchObject({ act: 'keep', drain: true });
  });

  it('an unreadable capability map is no evidence about the pane: kept and driven', () => {
    expect(masterVerdict(alive({ capability: 'unknown' }), online)).toMatchObject({
      act: 'keep',
      nudge: true,
    });
  });
});

describe('keep: when a driven master is nudged', () => {
  const last = (digest: string, agoSeconds: number) => ({ digest, agoSeconds });
  const due = (
    over: Partial<MasterJudged['nudge']>,
    extra: Partial<MasterJudged> = {},
    open = false,
  ) =>
    nudgeDue(alive({ nudge: { digest: 'd1', last: null, since: 'ran', ...over }, ...extra }), open)
      .due;

  it('nudges a master never nudged about owed work, and not one owed nothing', () => {
    expect(due({})).toBe(true);
    expect(due({}, { work: { ...noWork, poolWaits: true } })).toBe(false);
  });

  it('a changed digest waits for the open pass to close', () => {
    expect(due({ last: last('d0', 0) }, {}, true)).toBe(false);
    expect(due({ last: last('d0', 0) }, {}, false)).toBe(true);
  });

  it('the same work is asked again only past the window and only where the last nudge did not run', () => {
    expect(due({ last: last('d1', 299), since: 'no_turn' })).toBe(false);
    for (const since of ['unreported', 'no_turn', 'failed'] as const) {
      expect(due({ last: last('d1', 300), since })).toBe(true);
    }
    for (const since of ['working', 'awaiting_permission', 'ran'] as const) {
      expect(due({ last: last('d1', 300), since })).toBe(false);
    }
  });

  it('a limited master is asked every window, even with no work and a pass open', () => {
    const limited = {
      work: noWork,
      limit: {
        refusal: { reason: 'usage_limit' as const, agoMs: 60_000 },
        hooks: 'same' as const,
        turnStartedAgoMs: null,
      },
    };
    expect(due({ last: last('d0', 300) }, limited, true)).toBe(true);
    expect(due({ last: last('d0', 299) }, limited, true)).toBe(false);
  });

  it('the verdict carries the decision', () => {
    expect(
      masterVerdict(alive({ nudge: { digest: 'd1', last: last('d1', 0), since: 'ran' } }), online),
    ).toMatchObject({
      act: 'keep',
      nudge: false,
    });
  });
});

describe('limit: whether the pane sits behind its account refusal', () => {
  const refused = (reason: 'usage_limit' | 'rate_limit' | 'auth', agoMs: number) => ({
    reason,
    agoMs,
  });

  it('a quota refusal holds the pane however old, while its hooks do not contradict it', () => {
    for (const reason of ['usage_limit', 'rate_limit'] as const) {
      expect(
        limitHeld({
          refusal: refused(reason, 9 * HOUR * 1000),
          hooks: 'unheard',
          turnStartedAgoMs: null,
        }),
      ).toBe(true);
    }
    expect(
      limitHeld({ refusal: refused('usage_limit', 1000), hooks: 'same', turnStartedAgoMs: 1000 }),
    ).toBe(true);
  });

  it('a credential refusal, an answered account, or nothing read holds nothing', () => {
    expect(
      limitHeld({ refusal: refused('auth', 1000), hooks: 'same', turnStartedAgoMs: null }),
    ).toBe(false);
    expect(limitHeld({ refusal: null, hooks: 'same', turnStartedAgoMs: null })).toBe(false);
  });

  it('hooks naming another conversation, or a turn begun after the refusal, release it', () => {
    expect(
      limitHeld({ refusal: refused('usage_limit', 1000), hooks: 'other', turnStartedAgoMs: null }),
    ).toBe(false);
    expect(
      limitHeld({ refusal: refused('usage_limit', 1000), hooks: 'same', turnStartedAgoMs: 999 }),
    ).toBe(false);
  });
});
