import { holdReleasesItself } from '../jobs/index.js';
import { describePause } from '../pipeline/index.js';
import {
  type Derived,
  iso,
  isReleaseRun,
  NO_WAIT,
  type RunFacts,
  runWait,
  type StandingContext,
  TERMINAL_SESSION,
} from './standing-types.js';

type Need = 'write' | 'admin' | 'approve';

const NEEDED_BY: Record<Need, string> = {
  write: 'A project writer',
  admin: 'A project admin',
  approve: 'A holder of releases.approve',
};

function personWho(ctx: StandingContext, need: Need) {
  const v = ctx.viewer;
  const isViewer = !!(need === 'approve'
    ? v?.mayApprove
    : need === 'admin'
      ? v?.isAdmin
      : v?.canWrite);
  return { who: isViewer ? 'You' : NEEDED_BY[need], isViewer };
}

function person(
  ctx: StandingContext,
  w: {
    need: Need;
    act: string;
    ref: string;
    issueKey?: string | null;
    since: Date | null;
    rule: string;
  },
): Derived {
  return {
    state: 'waiting_person',
    since: w.since,
    rule: w.rule,
    outcome: null,
    waitingOn: (() => {
      const p = personWho(ctx, w.need);
      return runWait(p.isViewer ? 'you' : 'person', p.who, w.act, `${w.rule} (${w.ref})`, {
        ref: w.issueKey ?? null,
      });
    })(),
  };
}

function gate(w: {
  gate: string;
  resumesAt: Date | null;
  since: Date | null;
  rule: string;
}): Derived {
  return {
    state: 'waiting_gate',
    since: w.since,
    rule: w.rule,
    outcome: null,
    waitingOn: { kind: 'gate', gate: w.gate, resumesAt: iso(w.resumesAt), rule: w.rule },
  };
}

/** The deploy lock another run holds that this release's deploy waits behind: one per environment
 *  the project locks, and the release reaches them all, so it resumes once the last one ends. Read
 *  only while the release holds no lock of its own and has not reached its verify stage. */
export function lockAheadOf(f: RunFacts): RunFacts['foreignLocks'][number] | null {
  if (!isReleaseRun(f) || f.deployLocks.some((l) => l.held)) return null;
  if (f.releaseAttempt?.stage === 'verify') return null;
  return f.foreignLocks.reduce<RunFacts['foreignLocks'][number] | null>(
    (last, l) => (last === null || l.expiresAt.getTime() > last.expiresAt.getTime() ? l : last),
    null,
  );
}

function personWaitOf(f: RunFacts, ctx: StandingContext): Derived | null {
  const key = f.issue?.key ?? null;
  if (f.question) {
    return person(ctx, {
      need: f.question.admin ? 'admin' : 'write',
      act: 'answer the question',
      ref: `question ${f.question.id}${f.question.issueKey ? ` on ${f.question.issueKey}` : ''} (blocker_kind human)`,
      issueKey: f.question.issueKey,
      since: f.question.createdAt,
      rule: 'an open question with blocker_kind human: only a person can answer it',
    });
  }
  if (f.approval) {
    return person(ctx, {
      need: 'approve',
      act: 'approve the release',
      ref: 'release_approvals: no decision (RELEASE_AWAITING_APPROVAL)',
      since: f.approval.requestedAt,
      rule: 'the release waits on a pending approval, which a holder of releases.approve decides',
    });
  }
  if (f.run.status === 'paused') {
    const pause = describePause(f.run.pauseReason);
    if (pause.resumer === 'operator') {
      return person(ctx, {
        need: 'write',
        act: 'resume the run',
        ref: f.run.pauseReason ? `pauseReason ${f.run.pauseReason}` : 'paused by a person',
        since: f.run.updatedAt,
        rule: 'the run is paused, and only a person resumes this pause',
      });
    }
    return gate({
      gate: pause.kind ?? 'paused',
      resumesAt: null,
      since: f.run.updatedAt,
      rule: `the run is paused (${f.run.pauseReason}); the ${pause.resumer} resumes it, and no deadline is recorded`,
    });
  }
  const job = f.job;
  if (job?.status === 'held' && job.hold && !holdReleasesItself(job.hold)) {
    return person(ctx, {
      need: 'write',
      act: 'resume the job',
      ref: `job held: ${job.hold.reason}`,
      since: new Date(job.hold.heldAt),
      rule: `the job is held (${job.hold.reason}), a hold that does not resume itself`,
    });
  }
  if (f.ledger?.work === 'blocked' && f.ledger.blockerKind === 'human') {
    return person(ctx, {
      need: 'write',
      act: f.ledger.waitingOn ?? 'answer the run',
      ref: 'run ledger: work blocked, blockerKind human',
      since: f.ledger.observedAt,
      rule: 'the box reports the run blocked on a person',
    });
  }
  if (key && f.issue && (f.issue.status === 'needs_info' || f.issue.status === 'on_hold')) {
    return person(ctx, {
      need: 'write',
      act: f.issue.status === 'needs_info' ? 'answer a question' : 'resume it',
      ref: `${key} at ${f.issue.status}`,
      issueKey: key,
      since: f.issue.statusSince,
      rule: `the issue is parked at ${f.issue.status} while its run is live; a person moves it next${
        f.issue.statusSince ? '' : ' (no kernel transition records when it moved there)'
      }`,
    });
  }
  return null;
}

/** The dispatch barriers pipeline health names that clear without a person (agent-run-standing,
 *  `waiting_gate`): the issue's other work ends, or a fresh, new-enough box comes online. */
const DISPATCH_GATES: Record<string, string> = {
  issue_busy: 'another session or job is live on this issue: dispatch takes this one once it ends',
  contract_wait_unsettled:
    'CONTRACT_WAIT_UNSETTLED: the issue waits on a contract version no approved version reaches yet: the approval releases it',
  runner_stale: 'no box serving this project has beaten recently: dispatch takes it once one does',
  runner_too_old:
    'no box serving this project runs a build that can take it: dispatch takes it once one is updated',
};

function gateWaitOf(f: RunFacts, ctx: StandingContext): Derived | null {
  const job = f.job;
  if (job?.status === 'held' && job.hold && holdReleasesItself(job.hold)) {
    const heldAt = new Date(job.hold.heldAt);
    return gate({
      gate: job.hold.reason,
      resumesAt: job.retryAfterAt,
      since: heldAt,
      rule: job.retryAfterAt
        ? `held ${job.hold.reason}: the release sweep retries it once jobs.retry_after_at has passed`
        : `held ${job.hold.reason}: it re-queues when its condition clears, which has no deadline`,
    });
  }
  if (
    job?.status === 'queued' &&
    job.retryAfterAt &&
    job.retryAfterAt.getTime() > ctx.now.getTime()
  ) {
    return gate({
      gate: 'retry_cooldown',
      resumesAt: job.retryAfterAt,
      since: job.queuedAt,
      rule: 'jobs.retry_after_at is in the future: dispatch skips the job until then',
    });
  }
  const barrier = job?.status === 'queued' ? ctx.queuedGates.get(job.id) : undefined;
  if (job && barrier && DISPATCH_GATES[barrier]) {
    return gate({
      gate: barrier,
      resumesAt: null,
      since: job.queuedAt,
      rule: `pipeline health reads ${barrier}: ${DISPATCH_GATES[barrier]}, which has no deadline`,
    });
  }
  const lock = lockAheadOf(f);
  if (lock) {
    return gate({
      gate: 'deploy_locked',
      resumesAt: lock.expiresAt,
      since: lock.acquiredAt,
      rule: `DEPLOY_ENVIRONMENT_LOCKED: pipeline run ${lock.runId} holds the ${lock.environment} environment, deploying ${lock.subject} since ${lock.acquiredAt.toISOString()}; this release's deploy is refused until that deploy ends or its hold expires at ${lock.expiresAt.toISOString()}, when the next deploy reclaims it`,
    });
  }
  if (f.ledger?.work === 'blocked' && f.ledger.blockerKind && f.ledger.blockerKind !== 'human') {
    return gate({
      gate: `blocked_on_${f.ledger.blockerKind}`,
      resumesAt: null,
      since: f.ledger.observedAt,
      rule: `the box reports the run blocked on ${f.ledger.blockerKind}${f.ledger.waitingOn ? ` (${f.ledger.waitingOn})` : ''}, which no person clears`,
    });
  }
  return null;
}

export function liveOf(f: RunFacts, ctx: StandingContext): Derived {
  const waited = personWaitOf(f, ctx) ?? gateWaitOf(f, ctx);
  if (waited) return waited;
  const job = f.job;
  const s = f.session;
  const running = (since: Date | null, rule: string): Derived => ({
    state: 'running',
    since,
    rule,
    outcome: null,
    waitingOn: NO_WAIT('running: its holder is working it'),
  });
  const claimed = (since: Date | null, rule: string): Derived => ({
    state: 'claimed',
    since,
    rule,
    outcome: null,
    waitingOn: NO_WAIT('claimed: its holder has not started it'),
  });
  if (job?.status === 'dispatched' && job.sessionStatus === 'running')
    return running(
      job.sessionStartedAt ?? job.ackedAt ?? job.dispatchedAt,
      'jobs.status dispatched and its agent session running',
    );
  if (job?.status === 'dispatched')
    return claimed(job.dispatchedAt, 'jobs.status dispatched: a box took it and has not acked');
  if (job?.status === 'queued' && job.heldBy) {
    return claimed(job.heldAt, 'jobs.held_by: a master prepared it and has not started it');
  }
  if (job?.status === 'queued' || (s?.status === 'queued' && !job)) {
    const since = job?.queuedAt ?? s?.createdAt ?? f.run.startedAt;
    const full = ctx.slots !== null && ctx.slots.inUse >= ctx.slots.max;
    return {
      state: 'queued',
      since,
      rule: 'admitted, and no box or master has taken it',
      outcome: null,
      waitingOn:
        full && ctx.slots
          ? runWait(
              'machine',
              'Machine',
              `no free slot · ${ctx.slots.inUse} of ${ctx.slots.max} in use`,
              `no free slot: ${ctx.slots.inUse} of ${ctx.slots.max} in use (masters/standing.slots)`,
            )
          : runWait(
              'master',
              f.master?.name ?? 'Master',
              'dispatches it',
              'queued: the project master takes it in a pass',
            ),
    };
  }
  if (s && !TERMINAL_SESSION.includes(s.status)) {
    if (s.runtimeState === 'starting' || f.ledger?.incarnation === 'starting') {
      return claimed(
        s.startedAt ?? s.createdAt,
        'the run session is starting (runtimeState or ledger incarnation starting)',
      );
    }
    return running(s.startedAt ?? s.createdAt, `the run session is ${s.status}`);
  }
  if (!job && !s) {
    return {
      state: 'queued',
      since: f.run.startedAt,
      rule: 'the run is open and nothing has been dispatched on it yet',
      outcome: null,
      waitingOn: runWait(
        'master',
        f.master?.name ?? 'Master',
        'dispatches it',
        'queued: nothing is dispatched on the run',
      ),
    };
  }
  return running(
    f.run.startedAt,
    `the pipeline run is ${f.run.status} with ${f.liveJobs} live job(s) and no live session; ISS-109 decides whether that is stuck`,
  );
}
