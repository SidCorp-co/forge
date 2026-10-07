import { type Said, say, verbatim } from '@forge/contracts/said';
import { holdersWho, nobodyHoldsAct } from '@forge/contracts/standing';
import { holdReleasesItself } from '../jobs/index.js';
import { describePause } from '../pipeline/index.js';
import {
  type Derived,
  iso,
  isReleaseRun,
  NO_WAIT,
  RUN_NEED_PERMISSION,
  type RunFacts,
  gateWait,
  type RunPersonNeed,
  runWait,
  type StandingContext,
  TERMINAL_SESSION,
} from './standing-types.js';

type Need = RunPersonNeed;

/** Whose a person's act on a run is: the viewer where they hold it, else its holders by name, else nobody and where it is granted. */
function personWait(
  ctx: StandingContext,
  need: Need,
  act: Said,
  rule: Said,
  ref: string | null,
) {
  const v = ctx.viewer;
  const isViewer = !!(need === 'approve'
    ? v?.mayApprove
    : need === 'admin'
      ? v?.isAdmin
      : v?.canWrite);
  if (isViewer) return runWait('you', say('standing.who.you'), act, rule, { ref });
  const holders = ctx.holders[need];
  if (holders.length === 0) {
    return runWait(
      'none',
      holdersWho(holders),
      nobodyHoldsAct(act, RUN_NEED_PERMISSION[need]),
      rule,
      {
        ref,
      },
    );
  }
  return runWait('person', holdersWho(holders), act, rule, { ref });
}

function person(
  ctx: StandingContext,
  w: {
    need: Need;
    act: Said;
    ref: Said;
    issueKey?: string | null;
    since: Date | null;
    rule: Said;
  },
): Derived {
  return {
    state: 'waiting_person',
    since: w.since,
    rule: w.rule,
    outcome: null,
    waitingOn: personWait(
      ctx,
      w.need,
      w.act,
      say('runs.rule.withRef', { rule: w.rule, ref: w.ref }),
      w.issueKey ?? null,
    ),
  };
}

function gate(w: { gate: string; resumesAt: Date | null; since: Date | null; rule: Said }): Derived {
  return {
    state: 'waiting_gate',
    since: w.since,
    rule: w.rule,
    outcome: null,
    waitingOn: gateWait(w.gate, iso(w.resumesAt), w.rule),
  };
}

type LockRefusal = RunFacts['lockRefusals'][number];

/** The refusal this release's own deploy-lock acquire recorded (deploy_lock_refusals), never a
 *  lock another run merely holds: a release that never asked waits on nothing. Read only while the
 *  release holds no lock of its own and has not reached its verify stage. */
export function lockAheadOf(f: RunFacts): LockRefusal | null {
  if (!isReleaseRun(f) || f.deployLocks.some((l) => l.held)) return null;
  if (f.releaseAttempt?.stage === 'verify') return null;
  return f.lockRefusals.reduce<LockRefusal | null>(
    (last, r) => (last === null || r.refusedAt.getTime() > last.refusedAt.getTime() ? r : last),
    null,
  );
}

function refusalRule(r: LockRefusal): Said {
  if (!r.holderRunId) {
    return say('runs.rule.lockNoHolder', {
      environment: r.environment,
      at: r.refusedAt.toISOString(),
    });
  }
  return say('runs.rule.lockHeld', {
    at: r.refusedAt.toISOString(),
    run: r.holderRunId,
    environment: r.environment,
    subject: r.holderSubject ? verbatim(r.holderSubject) : say('runs.rule.lockUnnamedSubject'),
    since: r.holderAcquiredAt
      ? say('runs.rule.lockSince', { at: r.holderAcquiredAt.toISOString() })
      : null,
    until: r.refusedUntil
      ? say('runs.rule.lockUntilExpiry', { at: r.refusedUntil.toISOString() })
      : say('runs.rule.lockUntilEnds'),
  });
}

function personWaitOf(f: RunFacts, ctx: StandingContext): Derived | null {
  const key = f.issue?.key ?? null;
  if (f.question) {
    return person(ctx, {
      need: f.question.admin ? 'admin' : 'write',
      act: say('runs.act.answerQuestion'),
      ref: f.question.issueKey
        ? say('runs.ref.questionOn', { id: f.question.id, key: f.question.issueKey })
        : say('runs.ref.question', { id: f.question.id }),
      issueKey: f.question.issueKey,
      since: f.question.createdAt,
      rule: say('runs.rule.question'),
    });
  }
  if (f.approval) {
    return person(ctx, {
      need: 'approve',
      act: say('issues.standing.act.approveOnReleases'),
      ref: say('runs.ref.approval'),
      since: f.approval.requestedAt,
      rule: say('runs.rule.approval'),
    });
  }
  if (f.run.status === 'paused') {
    const pause = describePause(f.run.pauseReason);
    if (pause.resumer === 'operator') {
      return person(ctx, {
        need: 'write',
        act: say('runs.act.resumeRun'),
        ref: f.run.pauseReason
          ? say('runs.ref.pauseReason', { reason: f.run.pauseReason })
          : say('runs.ref.pausedByPerson'),
        since: f.run.updatedAt,
        rule: say('runs.rule.personPause'),
      });
    }
    return gate({
      gate: pause.kind ?? 'paused',
      resumesAt: null,
      since: f.run.updatedAt,
      rule: say('runs.rule.pausedBy', {
        reason: String(f.run.pauseReason),
        resumer: pause.resumer,
      }),
    });
  }
  const job = f.job;
  if (job?.status === 'held' && job.hold && !holdReleasesItself(job.hold)) {
    return person(ctx, {
      need: 'write',
      act: say('runs.act.resumeJob'),
      ref: say('runs.ref.jobHeld', { reason: job.hold.reason }),
      since: new Date(job.hold.heldAt),
      rule: say('runs.rule.jobHeld', { reason: job.hold.reason }),
    });
  }
  if (job?.status === 'queued' && ctx.queuedGates.get(job.id) === 'checkout_unbound') {
    return person(ctx, {
      need: 'write',
      act: say('runs.act.bindCheckout'),
      ref: say('runs.ref.checkoutUnbound'),
      since: job.queuedAt,
      rule: say('runs.rule.checkoutUnbound'),
    });
  }
  if (
    f.master?.live &&
    f.master.dialog &&
    f.session &&
    !TERMINAL_SESSION.includes(f.session.status)
  ) {
    return person(ctx, {
      need: 'write',
      act: say('runs.act.answerDialog', {
        pane: f.master.name
          ? say('standing.who.named', { name: f.master.name })
          : say('runs.act.itsMasterPane'),
        text: f.master.dialog.text,
      }),
      ref: say('runs.ref.masterDialog', { id: f.master.sessionId }),
      issueKey: key,
      since: f.master.dialog.seenAt,
      rule: say('runs.rule.masterDialog'),
    });
  }
  if (f.ledger?.work === 'blocked' && f.ledger.blockerKind === 'human') {
    return person(ctx, {
      need: 'write',
      act: f.ledger.waitingOn ? verbatim(f.ledger.waitingOn) : say('runs.act.answerRun'),
      ref: say('runs.ref.ledgerBlocked'),
      since: f.ledger.observedAt,
      rule: say('runs.rule.ledgerBlocked'),
    });
  }
  if (key && f.issue && (f.issue.status === 'needs_info' || f.issue.status === 'on_hold')) {
    return person(ctx, {
      need: 'write',
      act: say(
        f.issue.status === 'needs_info' ? 'issues.standing.act.answer' : 'issues.standing.act.resume',
      ),
      ref: say('runs.ref.issueAt', { key, status: f.issue.status }),
      issueKey: key,
      since: f.issue.statusSince,
      rule: say('runs.rule.issueParked', {
        status: f.issue.status,
        unrecorded: f.issue.statusSince ? null : say('runs.rule.noTransition'),
      }),
    });
  }
  return null;
}

/** The dispatch barriers pipeline health names that clear without a person (agent-run-standing,
 *  `waiting_gate`): the issue's other work ends, or a fresh, new-enough box comes online. */
const DISPATCH_GATES: Record<string, Said> = {
  issue_busy: say('runs.gate.issueBusy'),
  contract_wait_unsettled: say('runs.gate.contractWait'),
  runner_stale: say('runs.gate.runnerStale'),
  runner_too_old: say('runs.gate.runnerTooOld'),
};

function gateWaitOf(f: RunFacts, ctx: StandingContext): Derived | null {
  const job = f.job;
  if (job?.status === 'held' && job.hold && holdReleasesItself(job.hold)) {
    const heldAt = new Date(job.hold.heldAt);
    return gate({
      gate: job.hold.reason,
      resumesAt: job.retryAfterAt,
      since: heldAt,
      rule: say(job.retryAfterAt ? 'runs.rule.heldRetry' : 'runs.rule.heldClears', {
        reason: job.hold.reason,
      }),
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
      rule: say('runs.rule.retryCooldown'),
    });
  }
  const barrier = job?.status === 'queued' ? ctx.queuedGates.get(job.id) : undefined;
  const why = barrier ? DISPATCH_GATES[barrier] : undefined;
  if (job && barrier && why) {
    return gate({
      gate: barrier,
      resumesAt: null,
      since: job.queuedAt,
      rule: say('runs.rule.dispatchGate', { gate: barrier, why }),
    });
  }
  const refusal = lockAheadOf(f);
  if (refusal) {
    return gate({
      gate: 'deploy_locked',
      resumesAt: refusal.refusedUntil,
      since: refusal.refusedAt,
      rule: refusalRule(refusal),
    });
  }
  if (f.ledger?.work === 'blocked' && f.ledger.blockerKind && f.ledger.blockerKind !== 'human') {
    return gate({
      gate: `blocked_on_${f.ledger.blockerKind}`,
      resumesAt: null,
      since: f.ledger.observedAt,
      rule: say('runs.rule.blockedOn', {
        kind: f.ledger.blockerKind,
        on: f.ledger.waitingOn ? say('runs.rule.paren', { text: f.ledger.waitingOn }) : null,
      }),
    });
  }
  return null;
}

// A box's declaration core refused: queued, since nothing holds a lease, behind the refusal it was answered with.
function declaredBehindOf(f: RunFacts): Derived | null {
  const refused = f.run.declarationRefusal;
  if (!refused || f.session?.status !== 'queued') return null;
  const rule = say('runs.rule.declarationRefused', {
    code: refused.code,
    attempts: refused.attempts,
    at: refused.at.toISOString(),
    detail: refused.detail,
  });
  return {
    state: 'queued',
    since: f.session.createdAt,
    rule,
    outcome: null,
    waitingOn: gateWait(refused.gate, null, rule),
  };
}

/** The run's master by name, else the master. */
export const masterWho = (f: RunFacts): Said =>
  f.master?.name ? say('standing.who.named', { name: f.master.name }) : say('standing.who.master');

export function liveOf(f: RunFacts, ctx: StandingContext): Derived {
  const waited = declaredBehindOf(f) ?? personWaitOf(f, ctx) ?? gateWaitOf(f, ctx);
  if (waited) return waited;
  const job = f.job;
  const s = f.session;
  const running = (since: Date | null, rule: Said): Derived => ({
    state: 'running',
    since,
    rule,
    outcome: null,
    waitingOn: NO_WAIT(say('runs.rule.running')),
  });
  const claimed = (since: Date | null, rule: Said): Derived => ({
    state: 'claimed',
    since,
    rule,
    outcome: null,
    waitingOn: NO_WAIT(say('runs.rule.claimed')),
  });
  if (job?.status === 'dispatched' && job.sessionStatus === 'running')
    return running(
      job.sessionStartedAt ?? job.ackedAt ?? job.dispatchedAt,
      say('runs.live.dispatchedRunning'),
    );
  if (job?.status === 'dispatched')
    return claimed(job.dispatchedAt, say('runs.live.notAcked'));
  if (job?.status === 'queued' && job.heldBy) {
    return claimed(job.heldAt, say('runs.live.heldByMaster'));
  }
  if (job?.status === 'queued' || (s?.status === 'queued' && !job)) {
    const since = job?.queuedAt ?? s?.createdAt ?? f.run.startedAt;
    const full = ctx.slots !== null && ctx.slots.inUse >= ctx.slots.max;
    return {
      state: 'queued',
      since,
      rule: say('runs.live.admitted'),
      outcome: null,
      waitingOn:
        full && ctx.slots
          ? runWait(
              'machine',
              say('runs.who.machine'),
              say('runs.act.noSlot', { inUse: ctx.slots.inUse, max: ctx.slots.max }),
              say('runs.rule.noSlot', { inUse: ctx.slots.inUse, max: ctx.slots.max }),
            )
          : runWait(
              'master',
              masterWho(f),
              say('runs.act.dispatchIt'),
              say('runs.rule.queuedMaster'),
            ),
    };
  }
  if (s && !TERMINAL_SESSION.includes(s.status)) {
    if (s.runtimeState === 'starting' || f.ledger?.incarnation === 'starting') {
      return claimed(
        s.startedAt ?? s.createdAt,
        say('runs.live.starting'),
      );
    }
    return running(s.startedAt ?? s.createdAt, say('runs.live.sessionIs', { status: s.status }));
  }
  if (!job && !s) {
    return {
      state: 'queued',
      since: f.run.startedAt,
      rule: say('runs.live.openNothing'),
      outcome: null,
      waitingOn: runWait(
        'master',
        masterWho(f),
        say('runs.act.dispatchIt'),
        say('runs.rule.queuedNothing'),
      ),
    };
  }
  return running(
    f.run.startedAt,
    say('runs.live.noSession', { status: f.run.status, n: f.liveJobs }),
  );
}
