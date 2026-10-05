import type { IssueLeaseVerdict } from '@forge/contracts/issue-standing';
import type {
  RunDevice,
  RunDispatchedBy,
  RunExpiry,
  RunHolder,
  RunState,
} from '@forge/contracts/run-standing';
import { classifyLease } from '../issues/index.js';
import { isPipelineSessionKind } from '../jobs/index.js';
import { after, iso, none, type RunFacts, type StandingContext } from './standing-types.js';

function verdictAt(at: Date, now: Date, lapsed: IssueLeaseVerdict): IssueLeaseVerdict {
  return at.getTime() > now.getTime() ? 'live' : lapsed;
}

function claimExpiry(f: RunFacts, now: Date): { expiry: RunExpiry | null; detail: string | null } {
  const lease = f.workState?.lease;
  if (lease === null || lease === undefined) return { expiry: null, detail: null };
  const read = classifyLease({ lease, now, fanout: 1 });
  if (read.verdict === 'none') return { expiry: null, detail: null };
  if (!read.expiresAt) {
    return {
      expiry: null,
      detail: `the claim on ${f.issue?.key} is ${read.verdict}: ${read.detail}`,
    };
  }
  if (read.expiresAt.getTime() < f.run.startedAt.getTime()) return { expiry: null, detail: null };
  return {
    expiry: {
      source: 'claim',
      at: read.expiresAt.toISOString(),
      verdict: read.verdict,
      rule: `issue_work_state.lease by ${read.holder ?? 'no holder'}: renewedAt + minutes${read.stopped ? ', stopped' : ''}`,
    },
    detail: null,
  };
}

type Clock = { expiry: RunExpiry | null; detail: string | null };

function clock(at: Date, now: Date, rule: string): Clock {
  return {
    expiry: {
      source: 'silence_reap',
      at: at.toISOString(),
      verdict: verdictAt(at, now, 'abandoned'),
      rule,
    },
    detail: null,
  };
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a || !b) return a ?? b;
  return a.getTime() >= b.getTime() ? a : b;
}

// cm: mirrors jobs/loop-monitor.ts reapAckMisses: a dispatch with no ack and no job event is failed at ackMs, and the kill gate adds one grace before the fail lands.
function ackClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock {
  if (!job.dispatchedAt)
    return {
      expiry: null,
      detail:
        'the job is dispatched but carries no dispatched_at, so the ack reaper has no clock to start',
    };
  if (job.hasEvents) {
    return {
      expiry: null,
      detail:
        'the job is dispatched with job events but no ack: the ack reaper skips a job that has reported, and the heartbeat reaper needs a running session',
    };
  }
  const at = after(job.dispatchedAt, ctx.jobAckMs + ctx.killGraceMs);
  return clock(
    at,
    ctx.now,
    `the loop monitor fails a dispatch no runner acked within ${ctx.jobAckMs / 60_000} min, after a ${ctx.killGraceMs / 1000} s kill grace (dispatch_unclaimed); dispatched ${job.dispatchedAt.toISOString()}`,
  );
}

// cm: mirrors jobs/loop-monitor.ts reapZombieSessions: only a running session of a reaped kind, not awaiting input, is failed for silence, and its beat falls back as the reaper's does.
function heartbeatClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock {
  if (job.sessionStatus !== 'running') {
    return {
      expiry: null,
      detail: `the job's session is ${job.sessionStatus ?? 'not linked'}, and the heartbeat reaper only fails a running session`,
    };
  }
  if (job.sessionRuntimeState === 'awaiting_input') {
    return {
      expiry: null,
      detail:
        "the job's session is awaiting input, which the heartbeat reaper exempts, so no silence clock runs",
    };
  }
  if (!job.sessionHeartbeatReaped) {
    return {
      expiry: null,
      detail:
        "the job's session is not of a kind the heartbeat reaper sweeps, so no silence clock runs",
    };
  }
  const beat =
    job.sessionBeat ??
    (job.sessionStartedAt
      ? laterOf(job.sessionStartedAt, job.sessionUpdatedAt)
      : laterOf(job.sessionUpdatedAt, job.sessionCreatedAt));
  if (!beat)
    return {
      expiry: null,
      detail: "the job's session carries no beat, start or update time, so no silence clock runs",
    };
  const at = after(beat, ctx.jobHeartbeatMs);
  return clock(
    at,
    ctx.now,
    `the loop monitor fails a running session silent for ${ctx.jobHeartbeatMs / 60_000} min (heartbeat_timeout); last beat ${beat.toISOString()}`,
  );
}

// cm: mirrors jobs/queue-hop.ts reapQueueHop: a queued pipeline session no worker claimed fails at queueMs (queue_timeout); one that beat once and went quiet fails at heartbeatMs (turn_never_reported).
function queueClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock {
  const kind = job.sessionKind as Parameters<typeof isPipelineSessionKind>[0] | null;
  if (!kind || !isPipelineSessionKind(kind)) {
    return {
      expiry: null,
      detail:
        "the job's session is queued but not a pipeline session, so the queue hop does not sweep it",
    };
  }
  if (job.sessionBeat) {
    return clock(
      after(job.sessionBeat, ctx.jobHeartbeatMs),
      ctx.now,
      `the loop monitor fails a queued session that beat once and reported no turn for ${ctx.jobHeartbeatMs / 60_000} min (turn_never_reported); last beat ${job.sessionBeat.toISOString()}`,
    );
  }
  const since = job.sessionDispatchedAt ?? job.sessionCreatedAt;
  if (!since)
    return { expiry: null, detail: "the job's queued session carries no dispatch or create time" };
  return clock(
    after(since, ctx.jobQueueMs),
    ctx.now,
    `the loop monitor fails a queued session no worker claimed within ${ctx.jobQueueMs / 60_000} min (queue_timeout); queued ${since.toISOString()}`,
  );
}

// cm: mirrors jobs/loop-monitor.ts reapResultMisses: a job quiet (no event, no run phase) for RESULT_QUIET_MINUTES is failed after the kill grace, unless parked or already holding its result.
function resultClock(job: NonNullable<RunFacts['job']>, ctx: StandingContext): Clock | null {
  if (job.sessionRuntimeState === 'awaiting_input') return null;
  if (job.hasResult && job.sessionRuntimeState === null) return null;
  if (!job.lastProgressAt) return null;
  return clock(
    after(job.lastProgressAt, ctx.resultQuietMs + ctx.killGraceMs),
    ctx.now,
    `the loop monitor fails a job with no event or phase for ${ctx.resultQuietMs / 60_000} min, after a ${ctx.killGraceMs / 1000} s kill grace (stale); last progress ${job.lastProgressAt.toISOString()}`,
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
      `the run-session reaper fails a session silent for ${ctx.silenceReapMs / 60_000} min (run_session_box_silent); last beat ${beat.toISOString()}`,
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
      `the master reaper clears the holds of a master silent for ${ctx.silenceReapMs / 60_000} min; last beat ${f.master.lastBeatAt.toISOString()}`,
    );
  }
  return { expiry: null, detail: null };
}

function dispatchedByOf(f: RunFacts): RunDispatchedBy {
  if (!f.master) {
    return none(
      'no master owns this run: it opened as a root, with no live master on its box and no master hold',
    );
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
    detail:
      'no stored pass of this master spans the moment the run opened, so the pass that took it is not known',
  };
}

export function holderOf(f: RunFacts, ctx: StandingContext, state: RunState): RunHolder {
  if (['done', 'failed', 'cancelled', 'handed_back'].includes(state)) {
    return none('a finished run holds nothing: its lease went with its end');
  }
  const s = f.session;
  const job = f.job;
  const held = f.deployLocks.filter((l) => l.held);
  let identity: {
    kind: 'run' | 'master';
    name: string;
    sessionId: string | null;
    device: RunDevice | null;
    acquiredAt: Date | null;
  } | null = null;
  if (f.run.rawLane === 'run_session' && s?.status === 'running') {
    const first = f.fleetKeys.map((k) => k.acquiredAt).sort((a, b) => a.getTime() - b.getTime())[0];
    identity = {
      kind: 'run',
      name: s.name ?? 'Run session',
      sessionId: s.id,
      device: s.device,
      acquiredAt: first ?? s.startedAt,
    };
  } else if (job && job.status === 'dispatched') {
    identity = {
      kind: 'run',
      name: `${job.type} job`,
      sessionId: job.agentSessionId,
      device: job.device,
      acquiredAt: job.dispatchedAt,
    };
  } else if (job?.status === 'queued' && job.heldBy) {
    identity = {
      kind: 'master',
      name: f.master?.name ?? 'Master',
      sessionId: job.heldBy,
      device: null,
      acquiredAt: job.heldAt,
    };
  } else if (held[0]) {
    identity = {
      kind: 'run',
      name: held[0].subject,
      sessionId: null,
      device: null,
      acquiredAt: held[0].acquiredAt,
    };
  }
  if (!identity) {
    if (state === 'queued')
      return none('no holder yet: the run is queued and no box or master has taken it');
    if (state === 'waiting_person')
      return none('parked: the run holds no box while a person owes the next act');
    if (state === 'waiting_gate')
      return none('no holder: the run waits on a gate with no box taken');
    return none('no live session, job or deploy lock holds this run');
  }
  const expiries: RunExpiry[] = [];
  for (const lock of held) {
    expiries.push({
      source: 'deploy_lock',
      at: lock.expiresAt.toISOString(),
      verdict: verdictAt(lock.expiresAt, ctx.now, 'expired'),
      rule: `deploy_locks.expires_at on ${lock.environment}: the next deploy reclaims the environment after it`,
    });
  }
  const claim = claimExpiry(f, ctx.now);
  if (claim.expiry) expiries.push(claim.expiry);
  const silence = silenceExpiry(f, ctx);
  if (silence.expiry) expiries.push(silence.expiry);
  const first = expiries[0] ?? null;
  return {
    source: 'held',
    kind: identity.kind,
    name: identity.name,
    sessionId: identity.sessionId,
    device: identity.device,
    acquiredAt: iso(identity.acquiredAt),
    expiresAt: first?.at ?? null,
    expirySource: first?.source ?? null,
    verdict: first?.verdict ?? null,
    expiryDetail: first
      ? null
      : (claim.detail ??
        silence.detail ??
        'no claim, deploy lock or beat is readable for this holder, so no clock ends its hold'),
    expiries,
    dispatchedBy: dispatchedByOf(f),
  };
}
