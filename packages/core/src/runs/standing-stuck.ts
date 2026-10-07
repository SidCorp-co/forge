// where a live run stands still (design agent-run-standing rev 1, state stuck; ISS-109): core reads one
// rule per run from the rows `runs/facts.ts` gathered, so no screen computes stuck. Stuck is the early,
// reversible signal at `RUN_STUCK_AFTER_MS`; failing a silent run stays the reapers' at their own clocks
// each rule names the one row it stands on; a rule that cannot name its row does not fire

import type {
  RunDisagreement,
  RunHolder,
  RunStuck,
  RunStuckEvidence,
  RunStuckRule,
} from '@forge/contracts/run-standing';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { classifyLease } from '../issues/index.js';
import { lockAheadOf } from './standing-live.js';
import {
  after,
  type Derived,
  foreignClaimTree,
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
  detail: Said;
}

const BOX_LIVE = ['live', 'starting'];

const evidence = (
  table: string,
  id: string,
  column: string,
  value: string | null,
  at: Date | null,
): RunStuckEvidence => ({ table, id, column, value, at: iso(at) });

const mins = (ms: number) => ms / 60_000;

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
      detail: say('runs.stuck.boxLive', {
        incarnation: f.ledger.incarnation,
        session: s.status,
        status: f.run.status,
      }),
    };
  }
  return {
    rule: 'disagreement',
    disagreement: 'run-live-root-ended',
    since: derived.since ?? f.run.updatedAt,
    evidence: evidence('pipeline_runs', f.run.id, 'status', f.run.status, f.run.updatedAt),
    detail: say('runs.stuck.rootEnded', { status: f.run.status, rule: derived.rule }),
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
    detail: say('runs.stuck.boxExited'),
  };
}

function leaseOf(f: RunFacts, ctx: StandingContext): StuckReading | null {
  const lease = f.workState?.lease;
  if (lease === null || lease === undefined || !f.issue || foreignClaimTree(f) !== null)
    return null;
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
      detail: say('runs.stuck.abandoned', { key: f.issue.key, holder }),
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
    detail: say(read.stopped ? 'runs.stuck.claimStopped' : 'runs.stuck.claimLapsed', {
      key: f.issue.key,
      holder,
      at: read.expiresAt.toISOString(),
    }),
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
    detail: say('runs.stuck.silent', {
      column: `${sign.table}.${sign.column}`,
      at: sign.at.toISOString(),
      mins: mins(ctx.stuckAfterMs),
    }),
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
    detail: say('runs.stuck.stranded', {
      key: f.issue.key,
      status: strand.status,
      reason: strand.reason,
    }),
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
    detail: say('runs.stuck.lockOverdue', {
      environment: lock.environment,
      at: lock.expiresAt.toISOString(),
      mins: mins(ctx.stuckAfterMs),
    }),
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
      detail: say('runs.stuck.refusalOverdue', {
        environment: refusal.environment,
        at: refusal.refusedUntil.toISOString(),
        run: String(refusal.holderRunId),
        mins: mins(ctx.stuckAfterMs),
      }),
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
    detail: say('runs.stuck.gateOverdue', {
      gate,
      at: resumesAt.toISOString(),
      mins: mins(ctx.stuckAfterMs),
    }),
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

const CLEAR: Record<string, Said> = {
  queued: say('runs.stuck.clearQueued'),
  claimed: say('runs.stuck.clearClaimed'),
  waiting_person: say('runs.stuck.clearPerson'),
  waiting_gate: say('runs.stuck.clearGate'),
};

export function stuckField(
  reading: StuckReading | null,
  derived: Derived,
  holder: RunHolder,
  ctx: StandingContext,
): RunStuck {
  if (!reading) {
    if (derived.outcome !== null) return none(say('runs.stuck.finished'));
    const detail =
      CLEAR[derived.state] ?? say('runs.stuck.clearMoved', { mins: mins(ctx.stuckAfterMs) });
    return { source: 'clear', detail: sayEn(detail), says: { detail } };
  }
  const reap =
    holder.source === 'held' ? holder.expiries.find((e) => e.source === 'silence_reap') : undefined;
  const failsBy = reap ? reap.says.rule : say('runs.stuck.noReaper');
  const detail = say('runs.stuck.after', { mins: mins(ctx.stuckAfterMs), detail: reading.detail });
  return {
    source: 'stuck',
    rule: reading.rule,
    disagreement: reading.disagreement,
    since: reading.since.toISOString(),
    evidence: reading.evidence,
    failsAt: reap?.at ?? null,
    failsBy: sayEn(failsBy),
    detail: sayEn(detail),
    says: { failsBy, detail },
  };
}
