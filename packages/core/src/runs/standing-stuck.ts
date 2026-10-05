// cm:why where a live run stands still (design agent-run-standing rev 1, state stuck; ISS-109): core reads one
// rule per run from the rows `runs/facts.ts` gathered, so no screen computes stuck. Stuck is the early,
// reversible signal at `RUN_STUCK_AFTER_MS`; failing a silent run stays the reapers' at their own clocks
// cm:guard each rule names the one row it stands on; a rule that cannot name its row does not fire

import type {
  RunDisagreement,
  RunHolder,
  RunStuck,
  RunStuckEvidence,
  RunStuckRule,
} from '@forge/contracts/run-standing';
import { classifyLease } from '../issues/index.js';
import { lockAheadOf } from './standing-live.js';
import {
  after,
  type Derived,
  iso,
  none,
  type RunFacts,
  type StandingContext,
  TERMINAL_SESSION,
} from './standing-types.js';

export interface StuckReading {
  rule: RunStuckRule;
  disagreement: RunDisagreement | null;
  since: Date;
  evidence: RunStuckEvidence;
  detail: string;
}

const BOX_LIVE = ['live', 'starting'];

const evidence = (
  table: string,
  id: string,
  column: string,
  value: string | null,
  at: Date | null,
): RunStuckEvidence => ({ table, id, column, value, at: iso(at) });

const mins = (ms: number) => `${ms / 60_000} min`;

function endedRootOf(f: RunFacts, derived: Derived): StuckReading | null {
  const s = f.session;
  if (
    s &&
    TERMINAL_SESSION.includes(s.status) &&
    f.ledger &&
    BOX_LIVE.includes(f.ledger.incarnation)
  ) {
    return {
      rule: 'disagreement',
      disagreement: 'box-live-core-terminal',
      since: f.sessionFlip?.at ?? f.ledger.observedAt,
      evidence: evidence(
        'device_run_ledger',
        s.id,
        'incarnation',
        f.ledger.incarnation,
        f.ledger.observedAt,
      ),
      detail: `the box reports the run ${f.ledger.incarnation} while core ended its session ${s.status}, and pipeline_runs.status is still ${f.run.status}`,
    };
  }
  return {
    rule: 'disagreement',
    disagreement: 'run-live-root-ended',
    since: derived.since ?? f.run.updatedAt,
    evidence: evidence('pipeline_runs', f.run.id, 'status', f.run.status, f.run.updatedAt),
    detail: `pipeline_runs.status is still ${f.run.status} while its root ended (${derived.rule})`,
  };
}

function boxExitedOf(f: RunFacts): StuckReading | null {
  const s = f.session;
  if (s?.status !== 'running' || f.ledger?.incarnation !== 'exited') return null;
  return {
    rule: 'disagreement',
    disagreement: 'box-exited-core-running',
    since: f.ledger.observedAt,
    evidence: evidence('device_run_ledger', s.id, 'incarnation', 'exited', f.ledger.observedAt),
    detail: 'the box reports the process gone while core still has the run session running',
  };
}

function leaseOf(f: RunFacts, ctx: StandingContext): StuckReading | null {
  const lease = f.workState?.lease;
  if (lease === null || lease === undefined || !f.issue) return null;
  const read = classifyLease({ lease, now: ctx.now, fanout: 1 });
  if (read.verdict !== 'expired' && read.verdict !== 'abandoned') return null;
  if (!read.expiresAt || read.expiresAt.getTime() < f.run.startedAt.getTime()) return null;
  const holder = read.holder ?? 'no holder';
  if (read.verdict === 'abandoned') {
    const quiet = read.silentMs ?? 0;
    const since = new Date(ctx.now.getTime() - quiet + (read.toleranceMs ?? 0));
    return {
      rule: 'lease_abandoned',
      disagreement: null,
      since,
      evidence: evidence('issue_work_state', f.issue.key, 'lease', `abandoned by ${holder}`, since),
      detail: `the claim on ${f.issue.key} by ${holder} stopped beating past its tolerance, while the run is still live`,
    };
  }
  return {
    rule: 'lease_expired',
    disagreement: null,
    since: read.expiresAt,
    evidence: evidence(
      'issue_work_state',
      f.issue.key,
      'lease',
      `expired${read.stopped ? ' (stopped)' : ''}, held by ${holder}`,
      read.expiresAt,
    ),
    detail: `the claim on ${f.issue.key} by ${holder} ${read.stopped ? 'was stopped' : 'lapsed'} at ${read.expiresAt.toISOString()}, while the run is still live`,
  };
}

interface Sign {
  at: Date;
  table: string;
  id: string;
  column: string;
}

// As devices/run-session-reaper.ts reads it: a run session's beat falls back to its start, then its creation.
function lastSignOf(f: RunFacts): Sign {
  const signs: Sign[] = [];
  const s = f.session;
  if (f.lastBeatAt) {
    signs.push({
      at: f.lastBeatAt,
      table: 'agent_sessions',
      id: s?.id ?? f.job?.agentSessionId ?? f.run.id,
      column: 'last_heartbeat_at',
    });
  }
  if (s) {
    const beat = s.lastHeartbeatAt ?? s.startedAt ?? s.createdAt;
    const column = s.lastHeartbeatAt
      ? 'last_heartbeat_at'
      : s.startedAt
        ? 'started_at'
        : 'created_at';
    signs.push({ at: beat, table: 'agent_sessions', id: s.id, column });
  }
  const j = f.job;
  if (j) {
    const moved = j.finishedAt ?? j.ackedAt ?? j.dispatchedAt ?? j.queuedAt;
    const column = j.finishedAt
      ? 'finished_at'
      : j.ackedAt
        ? 'acked_at'
        : j.dispatchedAt
          ? 'dispatched_at'
          : 'queued_at';
    signs.push({ at: moved, table: 'jobs', id: j.id, column });
  }
  signs.push({ at: f.run.startedAt, table: 'pipeline_runs', id: f.run.id, column: 'started_at' });
  return signs.reduce((a, b) => (b.at.getTime() > a.at.getTime() ? b : a));
}

function silentOf(f: RunFacts, ctx: StandingContext): StuckReading | null {
  if (f.liveJobs > 0) return null;
  const sign = lastSignOf(f);
  const since = after(sign.at, ctx.stuckAfterMs);
  if (since.getTime() >= ctx.now.getTime()) return null;
  return {
    rule: 'silent',
    disagreement: null,
    since,
    evidence: evidence(sign.table, sign.id, sign.column, null, sign.at),
    detail: `no live job, and the last sign of life (${sign.table}.${sign.column} at ${sign.at.toISOString()}) is older than ${mins(ctx.stuckAfterMs)}`,
  };
}

function strandedOf(f: RunFacts): StuckReading | null {
  const strand = f.issue?.strand;
  if (!f.issue || !strand) return null;
  return {
    rule: 'stranded',
    disagreement: null,
    since: strand.at,
    evidence: evidence('issues', f.issue.key, 'session_context.strand', strand.reason, strand.at),
    detail: `the idle-issues sweep found ${f.issue.key} stranded at ${strand.status} (${strand.reason}), while the run is still live`,
  };
}

function lockOverdueOf(f: RunFacts, ctx: StandingContext): StuckReading | null {
  const lock = f.deployLocks.find(
    (l) => l.held && after(l.expiresAt, ctx.stuckAfterMs).getTime() < ctx.now.getTime(),
  );
  if (!lock) return null;
  return {
    rule: 'overdue',
    disagreement: null,
    since: after(lock.expiresAt, ctx.stuckAfterMs),
    evidence: evidence(
      'deploy_locks',
      lock.environment,
      'expires_at',
      lock.subject,
      lock.expiresAt,
    ),
    detail: `the deploy lock on ${lock.environment} expired at ${lock.expiresAt.toISOString()} and nobody reclaimed it in ${mins(ctx.stuckAfterMs)}`,
  };
}

function gateOverdueOf(f: RunFacts, ctx: StandingContext, derived: Derived): StuckReading | null {
  const w = derived.waitingOn;
  if (w.kind !== 'gate' || !w.resumesAt) return null;
  const gate = w.gate;
  const resumesAt = new Date(w.resumesAt);
  const since = after(resumesAt, ctx.stuckAfterMs);
  if (since.getTime() >= ctx.now.getTime()) return null;
  const refusal = gate === 'deploy_locked' ? lockAheadOf(f) : null;
  if (refusal?.refusedUntil) {
    return {
      rule: 'overdue',
      disagreement: null,
      since,
      evidence: evidence(
        'deploy_lock_refusals',
        refusal.environment,
        'refused_until',
        refusal.holderRunId,
        refusal.refusedUntil,
      ),
      detail: `this release's deploy was refused the ${refusal.environment} environment until ${refusal.refusedUntil.toISOString()}, held by pipeline run ${refusal.holderRunId}, and nothing took it in ${mins(ctx.stuckAfterMs)} after`,
    };
  }
  const j = f.job;
  return {
    rule: 'overdue',
    disagreement: null,
    since,
    evidence: j
      ? evidence(
          'jobs',
          j.id,
          gate === 'retry_cooldown' ? 'retry_after_at' : 'payload.__hold',
          gate,
          resumesAt,
        )
      : evidence('pipeline_runs', f.run.id, 'metadata', gate, resumesAt),
    detail: `the ${gate} gate was due to resume at ${resumesAt.toISOString()} and no new attempt came in ${mins(ctx.stuckAfterMs)}`,
  };
}

export function stuckOf(f: RunFacts, ctx: StandingContext, derived: Derived): StuckReading | null {
  const runLive = f.run.status === 'running' || f.run.status === 'paused';
  if (!runLive) return null;
  if (derived.outcome !== null) return endedRootOf(f, derived);
  if (derived.state === 'running') {
    return (
      boxExitedOf(f) ??
      leaseOf(f, ctx) ??
      silentOf(f, ctx) ??
      strandedOf(f) ??
      lockOverdueOf(f, ctx)
    );
  }
  if (derived.state === 'waiting_gate')
    return gateOverdueOf(f, ctx, derived) ?? lockOverdueOf(f, ctx);
  return null;
}

const CLEAR: Record<string, string> = {
  queued: 'queued: nothing has taken it yet, and the stuck rules read a run that started',
  claimed: 'claimed: its holder has not started it, and the start reapers own that window',
  waiting_person: 'waiting on a person is never stuck: a named person owes the next act',
  waiting_gate: 'the gate has not passed its own deadline by the stuck threshold',
};

export function stuckField(
  reading: StuckReading | null,
  derived: Derived,
  holder: RunHolder,
  ctx: StandingContext,
): RunStuck {
  if (!reading) {
    if (derived.outcome !== null) return none('a finished run is never stuck');
    return {
      source: 'clear',
      detail:
        CLEAR[derived.state] ??
        `the root moved inside ${mins(ctx.stuckAfterMs)}, no claim lapsed, the box and core agree, and no stranded finding stands`,
    };
  }
  const reap =
    holder.source === 'held' ? holder.expiries.find((e) => e.source === 'silence_reap') : undefined;
  return {
    source: 'stuck',
    rule: reading.rule,
    disagreement: reading.disagreement,
    since: reading.since.toISOString(),
    evidence: reading.evidence,
    failsAt: reap?.at ?? null,
    failsBy: reap
      ? reap.rule
      : 'no silence reaper times this run out: it has no live session or job to time, so the project master or a person ends it',
    detail: `stuck after ${mins(ctx.stuckAfterMs)}: ${reading.detail}`,
  };
}
