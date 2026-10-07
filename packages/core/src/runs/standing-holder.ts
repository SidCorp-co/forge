import type { IssueLeaseVerdict } from '@forge/contracts/issue-standing';
import { type Said, say, sayEn } from '@forge/contracts/said';
import type {
  RunDevice,
  RunDispatchedBy,
  RunExpiry,
  RunHolder,
  RunState,
} from '@forge/contracts/run-standing';
import { isPipelineSessionKind } from '../agent-sessions/index.js';
import { classifyLease } from '../issues/index.js';
import {
  after,
  foreignClaimTree,
  iso,
  none,
  type RunFacts,
  type StandingContext,
} from './standing-types.js';

const named = (name: string) => say('standing.who.named', { name });

function verdictAt(at: Date, now: Date, lapsed: IssueLeaseVerdict): IssueLeaseVerdict {
  return at.getTime() > now.getTime() ? 'live' : lapsed;
}

const expiry = (e: Omit<RunExpiry, 'rule' | 'says'>, rule: Said): RunExpiry => ({
  ...e,
  rule: sayEn(rule),
  says: { rule },
});

function claimExpiry(f: RunFacts, now: Date): Clock {
  const lease = f.workState?.lease;
  if (lease === null || lease === undefined) return { expiry: null, detail: null };
  const read = classifyLease({ lease, now, fanout: 1 });
  if (read.verdict === 'none') return { expiry: null, detail: null };
  const foreign = foreignClaimTree(f);
  if (foreign !== null) {
    return {
      expiry: null,
      detail: say('runs.holder.foreignClaim', {
        key: String(f.issue?.key),
        holder: read.holder ?? 'no holder',
        tree: foreign,
        worktree: String(f.ledger?.worktreePath),
      }),
    };
  }
  if (!read.expiresAt) {
    return {
      expiry: null,
      detail: say('runs.holder.claimIs', {
        key: String(f.issue?.key),
        verdict: read.verdict,
        detail: read.detail,
      }),
    };
  }
  if (read.expiresAt.getTime() < f.run.startedAt.getTime()) return { expiry: null, detail: null };
  return {
    expiry: expiry(
      { source: 'claim', at: read.expiresAt.toISOString(), verdict: read.verdict },
      say(read.stopped ? 'runs.holder.claimRuleStopped' : 'runs.holder.claimRule', {
        holder: read.holder ?? 'no holder',
      }),
    ),
    detail: null,
  };
}

type Clock = { expiry: RunExpiry | null; detail: Said | null };

function clock(at: Date, now: Date, rule: Said): Clock {
  return {
    expiry: expiry(
      { source: 'silence_reap', at: at.toISOString(), verdict: verdictAt(at, now, 'abandoned') },
      rule,
    ),
    detail: null,
  };
}

// Predicts jobs/loop-monitor.ts reapAckMisses: a dispatch with no ack and no job event is failed at ackMs, and the kill gate adds one grace before the fail lands.
function ackClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock {
  if (!job.dispatchedAt)
    return {
      expiry: null,
      detail: say('runs.holder.noDispatchedAt'),
    };
  if (job.hasEvents) {
    return {
      expiry: null,
      detail: say('runs.holder.reportedNoAck'),
    };
  }
  const at = after(job.dispatchedAt, ctx.jobAckMs + ctx.killGraceMs);
  return clock(
    at,
    ctx.now,
    say('runs.holder.ackClock', {
      mins: ctx.jobAckMs / 60_000,
      grace: ctx.killGraceMs / 1000,
      at: job.dispatchedAt.toISOString(),
    }),
  );
}

// The heartbeat reaper (jobs/zombie-session-reaper.ts) fails only a running session of a reaped kind, not awaiting input; its beat is `heartbeatBeatSql`, read here as `sessionHeartbeatBeat`.
function heartbeatClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock {
  if (job.sessionStatus !== 'running') {
    return {
      expiry: null,
      detail: say('runs.holder.sessionNotRunning', { status: job.sessionStatus ?? 'not linked' }),
    };
  }
  if (job.sessionRuntimeState === 'awaiting_input') {
    return {
      expiry: null,
      detail: say('runs.holder.awaitingInput'),
    };
  }
  if (!job.sessionHeartbeatReaped) {
    return {
      expiry: null,
      detail: say('runs.holder.notReaped'),
    };
  }
  const beat = job.sessionHeartbeatBeat;
  if (!beat)
    return {
      expiry: null,
      detail: say('runs.holder.noBeat'),
    };
  const at = after(beat, ctx.jobHeartbeatMs);
  return clock(
    at,
    ctx.now,
    say('runs.holder.heartbeatClock', {
      mins: ctx.jobHeartbeatMs / 60_000,
      at: beat.toISOString(),
    }),
  );
}

// Predicts jobs/queue-hop.ts reapQueueHop: a queued pipeline session no worker claimed fails at queueMs (queue_timeout); one that beat once and went quiet fails at heartbeatMs (turn_never_reported).
function queueClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock {
  const kind = job.sessionKind as Parameters<typeof isPipelineSessionKind>[0] | null;
  if (!kind || !isPipelineSessionKind(kind)) {
    return {
      expiry: null,
      detail: say('runs.holder.notPipeline'),
    };
  }
  if (job.sessionBeat) {
    return clock(
      after(job.sessionBeat, ctx.jobHeartbeatMs),
      ctx.now,
      say('runs.holder.turnClock', {
        mins: ctx.jobHeartbeatMs / 60_000,
        at: job.sessionBeat.toISOString(),
      }),
    );
  }
  const since = job.sessionDispatchedAt ?? job.sessionCreatedAt;
  if (!since)
    return { expiry: null, detail: say('runs.holder.noQueueTime') };
  return clock(
    after(since, ctx.jobQueueMs),
    ctx.now,
    say('runs.holder.queueClock', { mins: ctx.jobQueueMs / 60_000, at: since.toISOString() }),
  );
}

// Predicts jobs/loop-monitor.ts reapResultMisses (its query is `quietJobCandidateQuery`): a job quiet (no event, no run phase) for RESULT_QUIET_MINUTES is failed after the kill grace, unless parked or already holding its result.
function resultClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock | null {
  if (job.sessionRuntimeState === 'awaiting_input') return null;
  if (job.hasResult && job.sessionRuntimeState === null) return null;
  if (!job.lastProgressAt) return null;
  return clock(
    after(job.lastProgressAt, ctx.resultQuietMs + ctx.killGraceMs),
    ctx.now,
    say('runs.holder.resultClock', {
      mins: ctx.resultQuietMs / 60_000,
      grace: ctx.killGraceMs / 1000,
      at: job.lastProgressAt.toISOString(),
    }),
  );
}

/** The clock that fires first; a clock with no expiry yields to one that has one. */
function earlierOf(a: Clock, b: Clock | null): Clock {
  if (!b?.expiry) return a;
  if (!a.expiry) return b;
  return a.expiry.at <= b.expiry.at ? a : b;
}

function silenceExpiry(f: RunFacts, ctx: StandingContext): Clock {
  const s = f.session;
  if (f.run.rawLane === 'run_session' && s?.status === 'running') {
    const beat = s.lastHeartbeatAt ?? s.startedAt ?? s.createdAt;
    return clock(
      after(beat, ctx.silenceReapMs),
      ctx.now,
      say('runs.holder.boxSilentClock', {
        mins: ctx.silenceReapMs / 60_000,
        at: beat.toISOString(),
      }),
    );
  }
  const job = f.job;
  if (job && job.status === 'dispatched') {
    const session =
      job.status === 'dispatched' && !job.ackedAt
        ? ackClock(job, ctx)
        : job.sessionStatus === 'queued'
          ? queueClock(job, ctx)
          : heartbeatClock(job, ctx);
    return earlierOf(session, resultClock(job, ctx));
  }
  if (job?.status === 'queued' && job.heldBy && f.master?.lastBeatAt) {
    return clock(
      after(f.master.lastBeatAt, ctx.silenceReapMs),
      ctx.now,
      say('runs.holder.masterClock', {
        mins: ctx.silenceReapMs / 60_000,
        at: f.master.lastBeatAt.toISOString(),
      }),
    );
  }
  return { expiry: null, detail: null };
}

function dispatchedByOf(f: RunFacts): RunDispatchedBy {
  if (!f.master) {
    return none(say('runs.holder.noMasterRoot'));
  }
  if (f.pass) {
    return {
      source: 'pass',
      masterSessionId: f.master.sessionId,
      passId: f.pass.id,
      verb: f.pass.verb,
      startedAt: f.pass.startedAt.toISOString(),
    };
  }
  return {
    source: 'master',
    masterSessionId: f.master.sessionId,
    passId: null,
    detail: sayEn(say('runs.holder.passUnknown')),
    says: { detail: say('runs.holder.passUnknown') },
  };
}

export function holderOf(f: RunFacts, ctx: StandingContext, state: RunState): RunHolder {
  if (['done', 'failed', 'cancelled', 'handed_back'].includes(state)) {
    return none(say('runs.holder.finished'));
  }
  const s = f.session;
  const job = f.job;
  const held = f.deployLocks.filter((l) => l.held);
  let identity: {
    kind: 'run' | 'master';
    name: Said;
    sessionId: string | null;
    device: RunDevice | null;
    acquiredAt: Date | null;
  } | null = null;
  if (f.run.rawLane === 'run_session' && s?.status === 'running') {
    const first = f.fleetKeys.map((k) => k.acquiredAt).sort((a, b) => a.getTime() - b.getTime())[0];
    identity = {
      kind: 'run',
      name: s.name ? named(s.name) : say('runs.holder.runSession'),
      sessionId: s.id,
      device: s.device,
      acquiredAt: first ?? s.startedAt,
    };
  } else if (job && job.status === 'dispatched') {
    identity = {
      kind: 'run',
      name: say('runs.holder.job', { type: job.type }),
      sessionId: job.agentSessionId,
      device: job.device,
      acquiredAt: job.dispatchedAt,
    };
  } else if (job?.status === 'queued' && job.heldBy) {
    identity = {
      kind: 'master',
      name: f.master?.name ? named(f.master.name) : say('standing.who.master'),
      sessionId: job.heldBy,
      device: null,
      acquiredAt: job.heldAt,
    };
  } else if (held[0]) {
    identity = {
      kind: 'run',
      name: named(held[0].subject),
      sessionId: null,
      device: null,
      acquiredAt: held[0].acquiredAt,
    };
  }
  if (!identity) {
    if (state === 'queued') return none(say('runs.holder.queued'));
    if (state === 'waiting_person') return none(say('runs.holder.parked'));
    if (state === 'waiting_gate') return none(say('runs.holder.gate'));
    return none(say('runs.holder.nothing'));
  }
  const expiries: RunExpiry[] = [];
  for (const lock of held) {
    expiries.push(
      expiry(
        {
          source: 'deploy_lock',
          at: lock.expiresAt.toISOString(),
          verdict: verdictAt(lock.expiresAt, ctx.now, 'expired'),
        },
        say('runs.holder.lockRule', { environment: lock.environment }),
      ),
    );
  }
  const claim = claimExpiry(f, ctx.now);
  if (claim.expiry) expiries.push(claim.expiry);
  const silence = silenceExpiry(f, ctx);
  if (silence.expiry) expiries.push(silence.expiry);
  const first = expiries[0] ?? null;
  const expiryDetail = first
    ? null
    : (claim.detail ?? silence.detail ?? say('runs.holder.noClock'));
  return {
    source: 'held',
    kind: identity.kind,
    name: sayEn(identity.name),
    sessionId: identity.sessionId,
    device: identity.device,
    acquiredAt: iso(identity.acquiredAt),
    expiresAt: first?.at ?? null,
    expirySource: first?.source ?? null,
    verdict: first?.verdict ?? null,
    expiryDetail: expiryDetail ? sayEn(expiryDetail) : null,
    expiries,
    dispatchedBy: dispatchedByOf(f),
    says: { name: identity.name, expiryDetail },
  };
}
