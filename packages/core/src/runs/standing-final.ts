import type {
  RunActor,
  RunHandbackClose,
  RunNone,
  RunReturned,
} from '@forge/contracts/run-standing';
import {
  type AgentSessionStatus,
  CANCELLED_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
import { resolveFailureCause } from '../pipeline/index.js';
import {
  type Derived,
  iso,
  type KernelFlip,
  NO_WAIT,
  none,
  type RunFacts,
  TERMINAL_SESSION,
} from './standing-types.js';

const CANCEL_CAUSES = ['user_cancelled', 'pipeline_cancelled'];
const REAPER_CAUSES = ['runner_unreachable', 'heartbeat_timeout'];
const HANDBACK_CLOSE = /^run_session_(ended|killed_idle|died)$/;
const NOT_AN_OUTCOME: readonly string[] = [
  'in_progress',
  'needs_info',
  'on_hold',
  'open',
  'reopen',
  'draft',
];

function actorOf(flip: KernelFlip | null, missing: string): RunActor | RunNone {
  if (!flip) return none(missing);
  return {
    type: flip.actorType,
    agency: flip.agency,
    userId: flip.userId,
    name: flip.name,
    reason: flip.reason,
    at: flip.at.toISOString(),
  };
}

function finished(f: RunFacts): Date | null {
  return f.run.finishedAt ?? f.sessionFlip?.at ?? f.runFlip?.at ?? f.job?.finishedAt ?? null;
}

function failedOutcome(f: RunFacts, raw: string | null, detail: string | null): Derived {
  const cause = resolveFailureCause(raw);
  const at = finished(f);
  return {
    state: 'failed',
    since: at,
    rule:
      cause === 'unclassified'
        ? 'failed, and no FAILURE_CAUSES cause was recorded on the session or the job, so it reads unclassified'
        : `failed: ${cause}`,
    outcome: { kind: 'failed', at: iso(at), cause, classified: cause !== 'unclassified', detail },
    waitingOn: NO_WAIT('finished'),
  };
}

function cancelledOutcome(f: RunFacts, flip: KernelFlip | null, rule: string): Derived {
  const at = finished(f);
  return {
    state: 'cancelled',
    since: at,
    rule,
    outcome: {
      kind: 'cancelled',
      at: iso(at),
      by: actorOf(flip, 'no kernel_transitions row records who stopped it'),
    },
    waitingOn: NO_WAIT('finished'),
  };
}

// cm:why a run-session run is done when every issue it carried left it at a status no run owes from where it
// stopped (approved, awaiting_release, closed, dropped) and moved off the status it opened at; anything else
// went back — the design's handed_back, final, the next attempt a new run
function sessionClose(f: RunFacts, close: RunHandbackClose | null): Derived {
  const at = finished(f);
  const missed: RunReturned[] = [];
  for (const key of f.issues) {
    const end = f.endStatuses[key];
    if (!end) continue;
    const opened = f.openingStatuses[key];
    if (end === opened || NOT_AN_OUTCOME.includes(end)) missed.push({ issueKey: key, status: end });
  }
  const read = f.issues.filter((k) => f.endStatuses[k]).length;
  const closeWord = close ?? 'an unrecorded close';
  if (close === 'ended' || close === null) {
    if (missed.length === 0 && read > 0) {
      return {
        state: 'done',
        since: at,
        rule: `the box closed the session (${closeWord}) with every issue it carried moved on to an outcome`,
        outcome: {
          kind: 'done',
          at: iso(at),
          by: actorOf(f.sessionFlip, 'no kernel_transitions row records the close of this session'),
        },
        waitingOn: NO_WAIT('finished'),
      };
    }
  }
  const detail =
    read === 0
      ? `the session closed (${closeWord}) and none of ${f.issues.join(', ') || 'its issues'} can be read back, so no outcome is credited`
      : missed.length === 0
        ? `the session closed ${closeWord}: the box gave the work back before its outcome`
        : `the session closed (${closeWord}) with ${missed.map((m) => `${m.issueKey} at ${m.status}`).join(', ')}, short of an outcome`;
  return {
    state: 'handed_back',
    since: at,
    rule: detail,
    outcome: { kind: 'handed_back', at: iso(at), close, returnedTo: missed, detail },
    waitingOn: NO_WAIT('finished'),
  };
}

export function finalOf(f: RunFacts): Derived | null {
  const s = f.session;
  if (f.run.status === 'cancelled') {
    return cancelledOutcome(f, f.runFlip ?? f.sessionFlip, 'the pipeline run is cancelled');
  }
  const sessionEnded = s !== null && TERMINAL_SESSION.includes(s.status);
  if (s && sessionEnded) {
    if (
      CANCELLED_AGENT_SESSION_STATUSES.includes(s.status as AgentSessionStatus) ||
      CANCEL_CAUSES.includes(s.failureReason ?? '')
    ) {
      return cancelledOutcome(f, f.sessionFlip, `its session ended ${s.failureReason ?? s.status}`);
    }
  }
  if (f.run.rawLane === 'run_session' && s && sessionEnded) {
    const close = HANDBACK_CLOSE.exec(f.sessionFlip?.reason ?? '')?.[1] as
      | RunHandbackClose
      | undefined;
    if (close === 'died' || close === 'killed_idle') return sessionClose(f, close);
    if (close === 'ended') return sessionClose(f, close);
    if (s.status === 'failed' || REAPER_CAUSES.includes(s.failureReason ?? '')) {
      return failedOutcome(f, s.failureReason, s.failureDetail);
    }
    return sessionClose(f, null);
  }
  if (f.run.status === 'completed') {
    const at = finished(f);
    return {
      state: 'done',
      since: at,
      rule: 'the pipeline run completed',
      outcome: {
        kind: 'done',
        at: iso(at),
        by: actorOf(f.runFlip, 'no kernel_transitions row records the completion of this run'),
      },
      waitingOn: NO_WAIT('finished'),
    };
  }
  if (f.run.status === 'failed') {
    const raw = f.job?.sessionFailureReason ?? f.job?.failureReason ?? s?.failureReason ?? null;
    return failedOutcome(f, raw, f.job?.sessionFailureDetail ?? s?.failureDetail ?? null);
  }
  return null;
}
