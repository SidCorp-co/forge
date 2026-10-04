import { describe, expect, it } from 'vitest';
import { at, ctx, facts, flip, job, jobLane, session } from './standing.fixture.js';
import { runStandingOf, STUCK_NOT_COMPUTED } from './standing.js';

describe('runStandingOf: one state per fixture, from the rows the design names', () => {
  it('queued: a queued job nobody holds waits on the master', () => {
    const r = runStandingOf(
      jobLane(job({ status: 'queued', dispatchedAt: null, ackedAt: null })),
      ctx(),
    );
    expect(r.state).toBe('queued');
    expect(r.waitingOn).toMatchObject({ kind: 'master', who: 'master-forge' });
    expect(r.holder).toMatchObject({ source: 'none' });
  });

  it('queued on the machine when every slot is in use', () => {
    const r = runStandingOf(
      jobLane(job({ status: 'queued', dispatchedAt: null, ackedAt: null })),
      ctx({ slots: { inUse: 3, max: 3 } }),
    );
    expect(r.waitingOn).toMatchObject({ kind: 'machine', slots: { inUse: 3, max: 3 } });
  });

  it('claimed: a job a master prepared names the master as holder, reaped on its silence', () => {
    const r = runStandingOf(
      jobLane(
        job({ status: 'queued', heldBy: 'm-1', heldAt: at(-2), dispatchedAt: null, ackedAt: null }),
      ),
      ctx(),
    );
    expect(r.state).toBe('claimed');
    expect(r.holder).toMatchObject({
      source: 'held',
      kind: 'master',
      sessionId: 'm-1',
      expirySource: 'silence_reap',
      expiresAt: at(9).toISOString(),
    });
  });

  it('claimed: a dispatched job a box has not acked', () => {
    expect(runStandingOf(jobLane(job({ status: 'dispatched', ackedAt: null })), ctx()).state).toBe(
      'claimed',
    );
  });

  it('running: a run session beating holds the fleet key until last beat + 10 min', () => {
    const r = runStandingOf(facts(), ctx());
    expect(r.state).toBe('running');
    expect(r.step).toEqual({ source: 'work_state', step: 'build', since: at(-10).toISOString() });
    expect(r.attempt).toEqual({ source: 'runs', n: 2, retryOf: 'r-0', of: 'ISS-7' });
    expect(r.holder).toMatchObject({
      source: 'held',
      kind: 'run',
      sessionId: 's-1',
      expirySource: 'silence_reap',
      expiresAt: at(9).toISOString(),
      verdict: 'live',
    });
  });
});

describe('runStandingOf: the waiting states name who or what moves next', () => {
  it('waiting_person: an open human question names the viewer when they may answer it', () => {
    const r = runStandingOf(
      facts({ question: { id: 'q-1', createdAt: at(-5), admin: false, issueKey: 'ISS-7' } }),
      ctx(),
    );
    expect(r.state).toBe('waiting_person');
    expect(r.waitingOn).toMatchObject({
      kind: 'person',
      who: 'You',
      isViewer: true,
      since: at(-5).toISOString(),
    });
    expect(r.needsViewer).toBe(true);
  });

  it('waiting_person names a project writer, not the viewer, for a reader who cannot write', () => {
    const r = runStandingOf(
      facts({ question: { id: 'q-1', createdAt: at(-5), admin: false, issueKey: null } }),
      ctx({ viewer: { canWrite: false, isAdmin: false } }),
    );
    expect(r.waitingOn).toMatchObject({ kind: 'person', who: 'A project writer', isViewer: false });
    expect(r.needsViewer).toBe(false);
  });

  it('waiting_person: a parked issue waits since the transition that parked it, and says when none is recorded', () => {
    const parked = runStandingOf(
      facts({
        issue: { id: 'i-7', key: 'ISS-7', title: 'Seven', status: 'on_hold', statusSince: at(-6) },
      }),
      ctx(),
    );
    expect(parked.state).toBe('waiting_person');
    expect(parked.since).toBe(at(-6).toISOString());
    expect(parked.waitingOn).toMatchObject({ act: 'resume it', since: at(-6).toISOString() });
    const unknown = runStandingOf(
      facts({
        issue: { id: 'i-7', key: 'ISS-7', title: 'Seven', status: 'needs_info', statusSince: null },
      }),
      ctx(),
    );
    expect(unknown.since).toBeNull();
    expect(unknown.rule).toMatch(/no kernel transition records when it moved there/);
  });

  it('waiting_person: a pending release approval waits on a project admin', () => {
    const r = runStandingOf(
      facts(
        {
          issue: null,
          issues: [],
          session: null,
          fleetKeys: [],
          approval: { id: 'a-1', requestedAt: at(-3) },
        },
        {
          rawLane: 'system',
          releaseVersion: 'v1.2.0',
        },
      ),
      ctx(),
    );
    expect(r.lane).toBe('release');
    expect(r.waitingOn).toMatchObject({ kind: 'person', who: 'A project admin', isViewer: false });
  });

  it('waiting_gate: a self-resuming hold with no deadline serves resumesAt null', () => {
    const r = runStandingOf(
      jobLane(
        job({
          status: 'held',
          hold: {
            reason: 'all_devices_exhausted',
            heldAt: at(-4).toISOString(),
            autoRelease: true,
          },
        }),
      ),
      ctx(),
    );
    expect(r.state).toBe('waiting_gate');
    expect(r.waitingOn).toMatchObject({
      kind: 'gate',
      gate: 'all_devices_exhausted',
      resumesAt: null,
    });
  });

  it('waiting_gate: a retry cooldown resumes at retry_after_at', () => {
    const r = runStandingOf(
      jobLane(job({ status: 'queued', retryAfterAt: at(5), dispatchedAt: null })),
      ctx(),
    );
    expect(r.waitingOn).toMatchObject({
      kind: 'gate',
      gate: 'retry_cooldown',
      resumesAt: at(5).toISOString(),
    });
  });

  it('waiting_person, not a gate: a hold that does not resume itself', () => {
    const r = runStandingOf(
      jobLane(
        job({
          status: 'held',
          hold: {
            reason: 'retry_rounds_exhausted',
            heldAt: at(-4).toISOString(),
            autoRelease: false,
          },
        }),
      ),
      ctx(),
    );
    expect(r.state).toBe('waiting_person');
  });
});

describe('runStandingOf: a finished run names its outcome', () => {
  it('done: a session closed ended with its issue moved on to an outcome', () => {
    const r = runStandingOf(
      facts(
        {
          session: session({ status: 'completed' }),
          sessionFlip: flip({ reason: 'run_session_ended' }),
          endStatuses: { 'ISS-7': 'awaiting_release' },
        },
        { status: 'completed', finishedAt: at(-2) },
      ),
      ctx(),
    );
    expect(r.state).toBe('done');
    expect(r.outcome).toMatchObject({ kind: 'done', at: at(-2).toISOString() });
    expect(r.holder).toMatchObject({ source: 'none' });
  });

  it('failed: names its FAILURE_CAUSES cause, and unclassified when none was recorded', () => {
    const named = runStandingOf(
      jobLane(job({ status: 'failed', sessionFailureReason: 'provider_usage_limit' }), {
        status: 'failed',
      }),
      ctx(),
    );
    expect(named.outcome).toMatchObject({
      kind: 'failed',
      cause: 'provider_usage_limit',
      classified: true,
    });
    const blank = runStandingOf(jobLane(job({ status: 'failed' }), { status: 'failed' }), ctx());
    expect(blank.outcome).toMatchObject({
      kind: 'failed',
      cause: 'unclassified',
      classified: false,
    });
  });

  it('failed: the run-session reaper fails a silent box (runner_unreachable)', () => {
    const r = runStandingOf(
      facts(
        {
          session: session({ status: 'failed', failureReason: 'runner_unreachable' }),
          sessionFlip: flip({ toStatus: 'failed', reason: 'run_session_box_silent' }),
        },
        { status: 'failed' },
      ),
      ctx(),
    );
    expect(r.outcome).toMatchObject({ kind: 'failed', cause: 'runner_unreachable' });
  });

  it('cancelled: names the actor from kernel_transitions', () => {
    const r = runStandingOf(jobLane(job({ status: 'cancelled' }), { status: 'cancelled' }), ctx());
    expect(r.outcome).toMatchObject({ kind: 'cancelled', by: { source: 'none' } });
    const named = runStandingOf(
      {
        ...jobLane(job({ status: 'cancelled' }), { status: 'cancelled' }),
        runFlip: flip({
          toStatus: 'cancelled',
          actorType: 'user',
          agency: 'human',
          userId: 'u-1',
          name: 'Lan',
        }),
      },
      ctx(),
    );
    expect(named.outcome).toMatchObject({ kind: 'cancelled', by: { type: 'user', name: 'Lan' } });
  });

  it('handed_back: a session closed killed_idle names its close and where the issue stood', () => {
    const r = runStandingOf(
      facts(
        {
          session: session({ status: 'completed' }),
          sessionFlip: flip({ reason: 'run_session_killed_idle' }),
          endStatuses: { 'ISS-7': 'open' },
        },
        { status: 'completed' },
      ),
      ctx(),
    );
    expect(r.state).toBe('handed_back');
    expect(r.outcome).toMatchObject({
      kind: 'handed_back',
      close: 'killed_idle',
      returnedTo: [{ issueKey: 'ISS-7', status: 'open' }],
    });
  });

  it('handed_back: a session closed ended while its issue stood where the run took it', () => {
    const r = runStandingOf(
      facts(
        {
          session: session({ status: 'completed' }),
          sessionFlip: flip({ reason: 'run_session_ended' }),
          endStatuses: { 'ISS-7': 'open' },
        },
        { status: 'completed' },
      ),
      ctx(),
    );
    expect(r.outcome).toMatchObject({ kind: 'handed_back', close: 'ended' });
  });

  it('handed_back: a died close is a hand-back, not a failure', () => {
    const r = runStandingOf(
      facts(
        {
          session: session({ status: 'failed', failureReason: 'agent_exited_without_result' }),
          sessionFlip: flip({ toStatus: 'failed', reason: 'run_session_died' }),
          endStatuses: { 'ISS-7': 'open' },
        },
        { status: 'failed' },
      ),
      ctx(),
    );
    expect(r.outcome).toMatchObject({ kind: 'handed_back', close: 'died' });
  });
});

describe('done never reads as cancelled', () => {
  it('a completed run reads done even when a sweeper wrote its last flip, and a cancelled one never reads done', () => {
    const done = runStandingOf(
      {
        ...jobLane(job({ status: 'done' }), { status: 'completed' }),
        runFlip: flip({ actorType: 'sweeper' }),
      },
      ctx(),
    );
    expect(done.state).toBe('done');
    expect(done.outcome?.kind).toBe('done');
    const cancelled = runStandingOf(
      jobLane(job({ status: 'done' }), { status: 'cancelled' }),
      ctx(),
    );
    expect(cancelled.state).toBe('cancelled');
  });
});

describe('the stuck slot', () => {
  it('reads not_computed with its reason, on every run', () => {
    expect(runStandingOf(facts(), ctx()).stuck).toEqual({
      source: 'not_computed',
      detail: STUCK_NOT_COMPUTED,
    });
  });
});
