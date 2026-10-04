import type { IssueLeaseVerdict } from '@forge/contracts/issue-standing';
import type {
  RunDevice,
  RunDispatchedBy,
  RunExpiry,
  RunHolder,
  RunState,
} from '@forge/contracts/run-standing';
import { classifyLease } from '../issues/index.js';
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
  if (job?.status === 'dispatched' && !job.ackedAt) return ackClock(job, ctx);
  if (job && (job.status === 'running' || job.status === 'dispatched'))
    return heartbeatClock(job, ctx);
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
  } else if (job && (job.status === 'running' || job.status === 'dispatched')) {
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
