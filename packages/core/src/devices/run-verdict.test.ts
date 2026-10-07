import type { RunFacts } from '@forge/contracts/run-verdict';
import { describe, expect, it } from 'vitest';
import { exitCause, type RunIssues, runVerdict } from './run-verdict.js';

// ADR 0009, What core takes over: Recovery verdict was the runner's recovery::reconcile; each case
// below is one branch of the verdict the box now asks core for and obeys.

const MIN = 60_000;
const HOUR = 60 * MIN;

function facts(over: Partial<RunFacts> = {}): RunFacts {
  return {
    issueKeys: ['ISS-1'],
    parkedOnHuman: false,
    master: 'alive',
    liveMasterInProject: false,
    thisBoot: true,
    bootEnded: false,
    bound: true,
    process: 'alive',
    ledgerDead: false,
    host: 'not_read',
    hostEnded: null,
    ended: false,
    declaredAgoMs: MIN,
    checkoutGone: null,
    hasSession: true,
    activity: null,
    sessionOverForMs: null,
    subagent: { kind: 'no_turn_end', silentMs: MIN },
    transcript: { kind: 'none' },
    releaseDecided: false,
    releaseRefused: false,
    close: null,
    ...over,
  };
}

const live: RunIssues = { over: [false], rests: [false] };
const over: RunIssues = { over: [true], rests: [true] };
const unknown: RunIssues = { over: [null], rests: [null] };
const subagent = (o: Partial<RunFacts> = {}) =>
  facts({ process: 'none', subagent: { kind: 'turn_ended', silentMs: HOUR }, ...o });
const closed = (o: Partial<NonNullable<RunFacts['close']>> = {}) => ({
  sessionTerminal: true,
  checkoutReturned: false,
  leasesReturned: 1,
  leasesTotal: 1,
  ...o,
});

describe('a run parked on a person', () => {
  it('is kept and beaten whatever else reads, and moved onto a live master when its own is gone', () => {
    expect(
      runVerdict(
        facts({ parkedOnHuman: true, master: 'gone', liveMasterInProject: true, ledgerDead: true }),
        live,
      ),
    ).toMatchObject({
      act: 'keep',
      beat: true,
      reparent: true,
    });
  });
  it('stays with a master tmux could not answer for, and is not beaten without a session', () => {
    expect(
      runVerdict(
        facts({
          parkedOnHuman: true,
          master: 'unanswered',
          liveMasterInProject: true,
          hasSession: false,
        }),
        live,
      ),
    ).toMatchObject({
      act: 'keep',
      beat: false,
      reparent: false,
    });
  });
});

describe('a declaration ended before anything else is read', () => {
  it('ends a declaration bound to nothing for the whole hour', () => {
    const v = runVerdict(subagent({ bound: false, declaredAgoMs: HOUR }), live);
    expect(v).toMatchObject({ act: 'close' });
    expect(v.act === 'close' && v.end).toContain('never bound');
  });
  it('leaves one a minute short of the hour, and one of another boot, to the rest of the verdict', () => {
    expect(runVerdict(subagent({ bound: false, declaredAgoMs: HOUR - 1 }), live)).toMatchObject({
      act: 'keep',
    });
    expect(
      runVerdict(subagent({ bound: false, declaredAgoMs: 2 * HOUR, thisBoot: false }), live),
    ).toMatchObject({
      act: 'close',
      end: null,
    });
  });
  it('ends a run declared under a boot that has ended, whose master and agent ended with it', () => {
    for (const o of [{ bound: true }, { bound: false }, { process: 'gone' as const }]) {
      const v = runVerdict(subagent({ ...o, thisBoot: false, bootEnded: true }), live);
      expect(v).toMatchObject({ act: 'close' });
      expect(v.act === 'close' && v.end).toContain('rebooted');
    }
  });
  it('ends nothing for its boot where the box cannot tell that boot ended, or the run is parked', () => {
    expect(runVerdict(subagent({ thisBoot: false, bootEnded: false }), live)).toMatchObject({
      act: 'close',
      end: null,
    });
    expect(
      runVerdict(subagent({ thisBoot: false, bootEnded: true, parkedOnHuman: true }), live),
    ).toMatchObject({ act: 'keep' });
    expect(
      runVerdict(subagent({ thisBoot: false, bootEnded: true, ended: true }), live),
    ).toMatchObject({ act: 'close', end: null });
  });
  it('ends a stale declaration whose checkout is gone and whose every issue rests', () => {
    const v = runVerdict(subagent({ checkoutGone: true, issueKeys: ['ISS-1', 'ISS-2'] }), {
      over: [true, false],
      rests: [true, true],
    });
    expect(v.act === 'close' && v.end).toContain('stale declaration: ISS-1, ISS-2');
  });
  it('does not call it stale while one issue is not known to rest, or the checkout stands', () => {
    expect(
      runVerdict(subagent({ checkoutGone: true, issueKeys: ['ISS-1', 'ISS-2'] }), {
        over: [true, null],
        rests: [true, null],
      }),
    ).toMatchObject({
      act: 'keep',
    });
    expect(runVerdict(subagent({ checkoutGone: false }), over)).toMatchObject({
      act: 'close',
      end: null,
    });
  });
  it('holds no issue, so nothing is concluded', () => {
    expect(
      runVerdict(subagent({ checkoutGone: true, issueKeys: [] }), { over: [], rests: [] }),
    ).toMatchObject({
      act: 'keep',
      sayKept: true,
    });
  });
});

describe('a run under a live master', () => {
  it('keeps a subagent and says once why, never ending it on its own silence', () => {
    expect(
      runVerdict(
        subagent({ activity: { doing: 'idle', lastEventAgoMs: 5 * HOUR, writtenAgoMs: 5 * HOUR } }),
        unknown,
      ),
    ).toMatchObject({
      act: 'keep',
      beat: true,
      sayKept: true,
    });
  });
  it('says why it keeps a subagent only once its evidence reads over or unreadable', () => {
    const kept = (kind: RunFacts['subagent']['kind'], silentMs: number | null) =>
      runVerdict(subagent({ subagent: { kind, silentMs } }), unknown);
    for (const kind of ['turn_ended', 'awaiting_reply'] as const) {
      expect(kept(kind, HOUR - 1)).toMatchObject({ act: 'keep', sayKept: false });
      expect(kept(kind, HOUR)).toMatchObject({ act: 'keep', sayKept: true });
    }
    expect(kept('host_ended', 0)).toMatchObject({ act: 'keep', sayKept: true });
    expect(kept('unreadable', null)).toMatchObject({ act: 'keep', sayKept: true });
    expect(kept('no_turn_end', 9 * HOUR)).toMatchObject({ act: 'keep', sayKept: false });
  });
  it('closes a subagent whose every issue is over at core', () => {
    expect(runVerdict(subagent(), over)).toMatchObject({ act: 'close', end: null });
  });
  it('reads a pane tmux could not answer for as the pane last seen', () => {
    expect(runVerdict(facts({ master: 'unanswered' }), live)).toMatchObject({
      act: 'keep',
      sayKept: false,
    });
  });
  it('keeps an open subagent hosted outside its pane, and calls its master unknown when its process is not read', () => {
    expect(runVerdict(subagent({ master: 'gone', host: 'alive' }), live)).toMatchObject({
      act: 'keep',
      sayKept: true,
    });
    expect(runVerdict(subagent({ master: 'gone', host: 'unreadable' }), live)).toMatchObject({
      act: 'close',
    });
  });
  it('exits a run whose agent ended its turn fifteen minutes ago, and not one minute sooner', () => {
    expect(
      runVerdict(
        facts({ activity: { doing: 'idle', lastEventAgoMs: 15 * MIN, writtenAgoMs: null } }),
        live,
      ),
    ).toMatchObject({
      act: 'exit',
      cause: 'idle',
    });
    expect(
      runVerdict(
        facts({ activity: { doing: 'idle', lastEventAgoMs: 14 * MIN, writtenAgoMs: null } }),
        live,
      ),
    ).toMatchObject({
      act: 'keep',
      beat: true,
    });
  });
  it('keeps a run with no session unbeaten, whatever its activity says', () => {
    expect(
      runVerdict(
        facts({
          hasSession: false,
          activity: { doing: 'idle', lastEventAgoMs: HOUR, writtenAgoMs: null },
        }),
        live,
      ),
    ).toMatchObject({
      act: 'keep',
      beat: false,
    });
  });
});

describe('exitCause: the activity a run reports', () => {
  it('ends a working turn only on an hour of transcript silence, and never without a transcript', () => {
    expect(exitCause({ doing: 'working', lastEventAgoMs: 2 * HOUR, writtenAgoMs: HOUR })).toBe(
      'lead_silent',
    );
    expect(
      exitCause({ doing: 'working', lastEventAgoMs: 2 * HOUR, writtenAgoMs: HOUR - 1 }),
    ).toBeNull();
    expect(
      exitCause({ doing: 'working', lastEventAgoMs: 9 * HOUR, writtenAgoMs: null }),
    ).toBeNull();
  });
  it('counts the later of the last hook and the last write', () => {
    expect(
      exitCause({ doing: 'awaiting_children', lastEventAgoMs: HOUR - 1, writtenAgoMs: 3 * HOUR }),
    ).toBeNull();
    expect(
      exitCause({ doing: 'awaiting_children', lastEventAgoMs: HOUR, writtenAgoMs: null }),
    ).toBe('children_silent');
  });
  it('times an ended turn from its last hook alone, a later transcript write notwithstanding', () => {
    expect(exitCause({ doing: 'idle', lastEventAgoMs: 15 * MIN, writtenAgoMs: MIN })).toBe('idle');
  });
  it('never ends one awaiting a person, and knows nothing of a run that never reported', () => {
    expect(
      exitCause({
        doing: 'awaiting_permission',
        lastEventAgoMs: 99 * HOUR,
        writtenAgoMs: 99 * HOUR,
      }),
    ).toBeNull();
    expect(exitCause(null)).toBeNull();
  });
});

describe('settle: what the close loop left owed', () => {
  it('releases a run whose process is gone once core calls its session over', () => {
    const v = runVerdict(facts({ ledgerDead: true, close: closed() }), live);
    expect(v).toMatchObject({ act: 'settle', deathReport: false, standing: null });
    expect(v.act === 'settle' && v.release).toEqual({
      reason: "the run's process is gone and core's session row is terminal",
      notice: null,
    });
  });
  it('reports the death, and does not release, while core still holds the session', () => {
    expect(
      runVerdict(facts({ ledgerDead: true, close: closed({ sessionTerminal: false }) }), live),
    ).toMatchObject({
      release: null,
      deathReport: true,
    });
  });
  it('releases an unanswered run only after an hour over and silent, saying so once', () => {
    const base = subagent({
      master: 'unknown',
      sessionOverForMs: HOUR,
      transcript: { kind: 'written', agoMs: HOUR },
    });
    const v = runVerdict({ ...base, close: closed() }, live);
    expect(v.act === 'settle' && v.release?.notice).toEqual({ kind: 'unanswered', overMs: HOUR });
    expect(v.act === 'settle' && v.release?.reason).toContain('wrote nothing for the whole bound');
    expect(
      runVerdict(
        { ...base, transcript: { kind: 'written', agoMs: HOUR - 1 }, close: closed() },
        live,
      ),
    ).toMatchObject({
      release: null,
      standing: 'unanswered',
    });
    expect(
      runVerdict({ ...base, sessionOverForMs: HOUR - 1, close: closed() }, live),
    ).toMatchObject({ standing: 'unanswered' });
  });
  it('says the clock alone decided where no transcript could be read, and says nothing again in a refusal streak', () => {
    const v = runVerdict(
      subagent({
        master: 'unknown',
        sessionOverForMs: HOUR,
        transcript: { kind: 'unreadable' },
        releaseRefused: true,
        close: closed(),
      }),
      live,
    );
    expect(v.act === 'settle' && v.release).toEqual({
      reason: expect.stringContaining('the clock alone decided'),
      notice: null,
    });
  });
  it('releases a subagent whose host process ended, naming how its pane read', () => {
    const v = runVerdict(
      subagent({ master: 'gone', host: 'gone', hostEnded: 'pane_gone', close: closed() }),
      live,
    );
    expect(v.act === 'settle' && v.release?.notice).toEqual({ kind: 'host', how: 'pane_gone' });
    expect(v.act === 'settle' && v.release?.reason).toContain("so is its master's pane");
  });
  it('releases on every issue over even before core calls the session over', () => {
    const v = runVerdict(subagent({ close: closed({ sessionTerminal: false }) }), over);
    expect(v.act === 'settle' && v.release?.reason).toContain('every issue this run holds');
  });
  it('stands decided, foreign or awaiting core, and stands not at all once closed', () => {
    const gone = { ledgerDead: true, close: closed({ checkoutReturned: true, leasesReturned: 0 }) };
    expect(runVerdict(facts({ ...gone, releaseDecided: true }), live)).toMatchObject({
      standing: 'decided',
    });
    expect(
      runVerdict(facts({ ledgerDead: true, releaseDecided: true, close: closed() }), live),
    ).toMatchObject({
      release: null,
      standing: 'decided',
    });
    expect(runVerdict(facts({ ...gone, thisBoot: false }), live)).toMatchObject({
      standing: 'foreign_boot',
      release: null,
    });
    expect(runVerdict(facts({ ...gone, ended: true }), live)).toMatchObject({
      standing: 'awaiting_core',
    });
    expect(
      runVerdict(facts({ ...gone, close: closed({ checkoutReturned: true }) }), live),
    ).toMatchObject({ standing: null });
  });
  it('never ends a declaration a second time once the close loop has run', () => {
    expect(
      runVerdict(
        subagent({
          bound: false,
          declaredAgoMs: 2 * HOUR,
          ended: true,
          ledgerDead: true,
          close: closed(),
        }),
        live,
      ),
    ).toMatchObject({
      act: 'settle',
    });
  });
});
