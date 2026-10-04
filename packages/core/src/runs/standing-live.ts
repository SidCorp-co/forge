import { holdReleasesItself } from '../jobs/hold.js';
import { describePause } from '../pipeline/run-pause.js';
import {
  type Derived,
  iso,
  NO_WAIT,
  type RunFacts,
  runWait,
  type StandingContext,
  TERMINAL_SESSION,
} from './standing-types.js';

const gateLabel = (gate: string) => {
  const words = gate.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function personWho(ctx: StandingContext, admin: boolean) {
  const isViewer = admin ? !!ctx.viewer?.isAdmin : !!ctx.viewer?.canWrite;
  return { who: isViewer ? 'You' : admin ? 'A project admin' : 'A project writer', isViewer };
}

function person(
  ctx: StandingContext,
  w: {
    admin: boolean;
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
      const p = personWho(ctx, w.admin);
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
    waitingOn: runWait(
      'gate',
      gateLabel(w.gate),
      w.resumesAt ? 'resumes at its deadline' : 'resumes itself',
      `${w.gate}: ${w.rule}`,
      { ref: w.gate, dueAt: iso(w.resumesAt) },
    ),
  };
}

function personWaitOf(f: RunFacts, ctx: StandingContext): Derived | null {
  const key = f.issue?.key ?? null;
  if (f.question) {
    return person(ctx, {
      admin: f.question.admin,
      act: 'answer the question',
      ref: `question ${f.question.id}${f.question.issueKey ? ` on ${f.question.issueKey}` : ''} (blocker_kind human)`,
      issueKey: f.question.issueKey,
      since: f.question.createdAt,
      rule: 'an open question with blocker_kind human: only a person can answer it',
    });
  }
  if (f.approval) {
    return person(ctx, {
      admin: true,
      act: 'approve the release',
      ref: 'release_approvals: no decision (RELEASE_AWAITING_APPROVAL)',
      since: f.approval.requestedAt,
      rule: 'the release waits on a pending approval, which takes a project admin person',
    });
  }
  if (f.run.status === 'paused') {
    const pause = describePause(f.run.pauseReason);
    if (pause.resumer === 'operator') {
      return person(ctx, {
        admin: false,
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
      admin: false,
      act: 'resume the job',
      ref: `job held: ${job.hold.reason}`,
      since: new Date(job.hold.heldAt),
      rule: `the job is held (${job.hold.reason}), a hold that does not resume itself`,
    });
  }
  if (f.ledger?.work === 'blocked' && f.ledger.blockerKind === 'human') {
    return person(ctx, {
      admin: false,
      act: f.ledger.waitingOn ?? 'answer the run',
      ref: 'run ledger: work blocked, blockerKind human',
      since: f.ledger.observedAt,
      rule: 'the box reports the run blocked on a person',
    });
  }
  if (key && f.issue && (f.issue.status === 'needs_info' || f.issue.status === 'on_hold')) {
    return person(ctx, {
      admin: false,
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
  if (job?.status === 'running')
    return running(job.ackedAt ?? job.dispatchedAt, 'jobs.status running');
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
