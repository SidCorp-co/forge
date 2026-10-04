import {
  JOB_HEARTBEAT_REAP_DEFAULT_MS,
  RUN_STUCK_AFTER_MS,
  SESSION_SILENCE_REAP_MS,
} from '@forge/contracts/run-standing';
import { describe, expect, it } from 'vitest';
import { SESSION_SILENCE_TIMEOUT_MS } from '../devices/session-silence.js';
import { HOLD_RECHECK_MS } from '../jobs/hold.js';
import { getLoopThresholds } from '../jobs/loop-monitor-thresholds.js';
import { at, ctx, facts, flip, job, jobLane, NOW, session } from './standing.fixture.js';
import { runStandingOf } from './standing.js';

const claim = (renewedMin: number, minutes: number, extra: Record<string, unknown> = {}) => ({
  holder: 'dev-run-7',
  renewedAt: at(renewedMin).toISOString(),
  minutes,
  ...extra,
});

describe('stuck: one fixture per rule, each naming its evidence row', () => {
  it('silent: a run session with no live job and a beat older than 3 min, failed by the reaper at 10', () => {
    const r = runStandingOf(
      facts({ session: session({ lastHeartbeatAt: at(-4) }), lastBeatAt: at(-4) }),
      ctx(),
    );
    expect(r.state).toBe('stuck');
    expect(r.since).toBe(at(-1).toISOString());
    expect(r.outcome).toBeNull();
    expect(r.waitingOn).toMatchObject({ kind: 'master', who: 'master-forge' });
    expect(r.stuck).toMatchObject({
      source: 'stuck',
      rule: 'silent',
      since: at(-1).toISOString(),
      evidence: {
        table: 'agent_sessions',
        id: 's-1',
        column: 'last_heartbeat_at',
        at: at(-4).toISOString(),
      },
      failsAt: at(6).toISOString(),
    });
    if (r.stuck.source !== 'stuck') throw new Error('unreachable');
    expect(r.stuck.detail).toContain('3 min');
    expect(r.stuck.failsBy).toContain('10 min');
  });

  it('silent: a job lane whose last job finished and nothing followed names the job row, with no reaper', () => {
    const r = runStandingOf(
      {
        ...jobLane(job({ status: 'done', finishedAt: at(-5), sessionStatus: 'completed' })),
        lastBeatAt: null,
      },
      ctx(),
    );
    expect(r.state).toBe('stuck');
    expect(r.stuck).toMatchObject({
      rule: 'silent',
      evidence: { table: 'jobs', id: 'j-1', column: 'finished_at' },
      failsAt: null,
    });
  });

  it('lease_expired: the claim lapsed while the run session still beats', () => {
    const r = runStandingOf(
      facts({ workState: { step: 'build', stepStartedAt: at(-10), lease: claim(-20, 10) } }),
      ctx(),
    );
    expect(r.state).toBe('stuck');
    expect(r.stuck).toMatchObject({
      rule: 'lease_expired',
      since: at(-10).toISOString(),
      evidence: { table: 'issue_work_state', id: 'ISS-7', column: 'lease' },
    });
  });

  it('lease_abandoned: the claim heartbeat stopped past its tolerance', () => {
    const lease = claim(-5, 60, { heartbeat: { at: at(-4).toISOString(), everySeconds: 30 } });
    const r = runStandingOf(
      facts({ workState: { step: 'build', stepStartedAt: at(-10), lease } }),
      ctx(),
    );
    expect(r.stuck).toMatchObject({ rule: 'lease_abandoned', evidence: { column: 'lease' } });
    expect(r.state).toBe('stuck');
  });

  it("disagreement box-exited-core-running: the box says the process is gone, core's session runs", () => {
    const r = runStandingOf(
      facts({
        ledger: {
          incarnation: 'exited',
          work: 'runnable',
          blockerKind: null,
          waitingOn: null,
          observedAt: at(-2),
        },
      }),
      ctx(),
    );
    expect(r.stuck).toMatchObject({
      rule: 'disagreement',
      disagreement: 'box-exited-core-running',
      evidence: { table: 'device_run_ledger', id: 's-1', column: 'incarnation', value: 'exited' },
    });
  });

  it('disagreement box-live-core-terminal: core ended the session, the box and the pipeline run are live', () => {
    const r = runStandingOf(
      facts({
        session: session({ status: 'failed', failureReason: 'runner_unreachable' }),
        ledger: {
          incarnation: 'live',
          work: 'runnable',
          blockerKind: null,
          waitingOn: null,
          observedAt: at(-1),
        },
      }),
      ctx(),
    );
    expect(r.state).toBe('stuck');
    expect(r.outcome).toBeNull();
    expect(r.stuck).toMatchObject({
      rule: 'disagreement',
      disagreement: 'box-live-core-terminal',
      evidence: { table: 'device_run_ledger', value: 'live' },
    });
  });

  it('disagreement run-live-root-ended: the root ended while pipeline_runs.status is still running', () => {
    const r = runStandingOf(
      facts({
        session: session({ status: 'completed' }),
        sessionFlip: flip({ reason: 'run_session_ended', at: at(-6) }),
        lastBeatAt: null,
      }),
      ctx(),
    );
    expect(r.state).toBe('stuck');
    expect(r.since).toBe(at(-6).toISOString());
    expect(r.waitingOn.rule).toContain('its root already ended');
    expect(r.stuck).toMatchObject({
      rule: 'disagreement',
      disagreement: 'run-live-root-ended',
      evidence: { table: 'pipeline_runs', id: 'r-1', column: 'status', value: 'running' },
    });
  });

  it('stranded: the idle-issues finding stands on the issue while the run is live', () => {
    const r = runStandingOf(
      facts({
        issue: {
          id: 'i-7',
          key: 'ISS-7',
          title: 'Seven',
          status: 'in_progress',
          statusSince: at(-200),
          strand: { at: at(-30), status: 'in_progress', reason: 'lease malformed past grace' },
        },
      }),
      ctx(),
    );
    expect(r.stuck).toMatchObject({
      rule: 'stranded',
      since: at(-30).toISOString(),
      evidence: { table: 'issues', id: 'ISS-7', column: 'session_context.strand' },
    });
  });

  it('overdue: a self-resuming gate 3 min past its own deadline', () => {
    const heldAt = new Date(NOW.getTime() - HOLD_RECHECK_MS - 4 * 60_000);
    const r = runStandingOf(
      jobLane(
        job({
          status: 'held',
          hold: { reason: 'verify_unavailable', heldAt: heldAt.toISOString(), autoRelease: true },
        }),
      ),
      ctx(),
    );
    expect(r.state).toBe('stuck');
    expect(r.stuck).toMatchObject({
      rule: 'overdue',
      since: at(-1).toISOString(),
      evidence: { table: 'jobs', id: 'j-1', column: 'payload.__hold', value: 'verify_unavailable' },
    });
  });

  it('overdue: a deploy lock that expired and nobody reclaimed', () => {
    const r = runStandingOf(
      facts({
        deployLocks: [
          {
            environment: 'beta',
            subject: 'release 1.2',
            acquiredAt: at(-40),
            expiresAt: at(-5),
            reclaimedFromRunId: null,
            held: true,
          },
        ],
      }),
      ctx(),
    );
    expect(r.stuck).toMatchObject({
      rule: 'overdue',
      evidence: { table: 'deploy_locks', id: 'beta', column: 'expires_at' },
    });
  });
});

describe('stuck is reversible and never claimed of a run something moves', () => {
  it('a run that beats again inside 3 min reads running again', () => {
    const silent = facts({ session: session({ lastHeartbeatAt: at(-4) }), lastBeatAt: at(-4) });
    expect(runStandingOf(silent, ctx()).state).toBe('stuck');
    const beat = facts({ session: session({ lastHeartbeatAt: at(-2) }), lastBeatAt: at(-2) });
    const r = runStandingOf(beat, ctx());
    expect(r.state).toBe('running');
    expect(r.stuck).toMatchObject({ source: 'clear' });
  });

  it('a beat exactly 3 min old is not yet stuck; one ms older is', () => {
    const edge = new Date(NOW.getTime() - RUN_STUCK_AFTER_MS);
    const exact = facts({ session: session({ lastHeartbeatAt: edge }), lastBeatAt: edge });
    expect(runStandingOf(exact, ctx()).state).toBe('running');
    const older = new Date(edge.getTime() - 1);
    const past = facts({ session: session({ lastHeartbeatAt: older }), lastBeatAt: older });
    expect(runStandingOf(past, ctx()).state).toBe('stuck');
  });

  it('silent never fires on a run with a live job: the job heartbeat reaper owns that clock', () => {
    const r = runStandingOf(jobLane(job({ ackedAt: at(-20), sessionBeat: at(-20) })), ctx());
    expect(r.liveJobs).toBe(1);
    expect(r.state).toBe('running');
    expect(r.stuck).toMatchObject({ source: 'clear' });
  });

  it('a person wait is never stuck, however old', () => {
    const r = runStandingOf(
      facts({
        session: session({ lastHeartbeatAt: at(-60) }),
        lastBeatAt: at(-60),
        question: { id: 'q-1', createdAt: at(-50), admin: false, issueKey: 'ISS-7' },
      }),
      ctx(),
    );
    expect(r.state).toBe('waiting_person');
    expect(r.stuck).toMatchObject({ source: 'clear' });
  });

  it('a finished run is never stuck', () => {
    const r = runStandingOf(jobLane(job({ status: 'done' }), { status: 'completed' }), ctx());
    expect(r.state).toBe('done');
    expect(r.stuck).toMatchObject({ source: 'none' });
  });

  it('a claim that lapsed before this run started belongs to an earlier run and is not read', () => {
    const r = runStandingOf(
      facts({ workState: { step: 'build', stepStartedAt: at(-10), lease: claim(-90, 30) } }),
      ctx(),
    );
    expect(r.state).toBe('running');
  });
});

describe('the silence clocks read one source', () => {
  it('stuck sits strictly before the session reap, and both are the declared constants', () => {
    expect(RUN_STUCK_AFTER_MS).toBe(3 * 60_000);
    expect(SESSION_SILENCE_REAP_MS).toBe(10 * 60_000);
    expect(RUN_STUCK_AFTER_MS).toBeLessThan(SESSION_SILENCE_REAP_MS);
    expect(SESSION_SILENCE_TIMEOUT_MS).toBe(SESSION_SILENCE_REAP_MS);
  });

  it("the loop monitor's job heartbeat default is the shared one", () => {
    if (process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS) return;
    expect(getLoopThresholds().heartbeatMs).toBe(JOB_HEARTBEAT_REAP_DEFAULT_MS);
  });
});
