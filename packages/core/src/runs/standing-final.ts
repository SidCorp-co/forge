import { resolveFailureCause } from '@forge/contracts/failure-causes';
import type {
  RunActor,
  RunHandbackClose,
  RunNone,
  RunReturned,
} from '@forge/contracts/run-standing';
import { type Said, say, sayEn } from '@forge/contracts/said';
import {
  type AgentSessionStatus,
  CANCELLED_AGENT_SESSION_STATUSES,
} from '@forge/contracts/session-machine';
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

function actorOf(flip: KernelFlip | null, missing: Said): RunActor | RunNone {
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
        ? say('runs.final.unclassified')
        : say('runs.final.failed', { cause }),
    outcome: { kind: 'failed', at: iso(at), cause, classified: cause !== 'unclassified', detail },
    waitingOn: NO_WAIT(say('runs.rule.finished')),
  };
}

function cancelledOutcome(f: RunFacts, flip: KernelFlip | null, rule: Said): Derived {
  const at = finished(f);
  return {
    state: 'cancelled',
    since: at,
    rule,
    outcome: {
      kind: 'cancelled',
      at: iso(at),
      by: actorOf(flip, say('runs.final.noStopRecord')),
    },
    waitingOn: NO_WAIT(say('runs.rule.finished')),
  };
}

// a merge mark inside the run with no move to an outcome after it: the work landed and the issue was
// never moved on (epod ISS-1 2026-10-06, its CLI's moves refused), which the reader is told rather than
// left to read as work given back unfinished
function landedNote(f: RunFacts, key: string): Said | null {
  const at = f.landedAt[key];
  return at ? say('runs.final.landedNote', { at: at.toISOString() }) : null;
}

// a run-session run is done when every issue it carried left it at a status no run owes from where it
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
  const closeWord = close ? say('runs.final.close', { close }) : say('runs.final.unrecordedClose');
  if (close === 'ended' || close === null) {
    if (missed.length === 0 && read > 0) {
      return {
        state: 'done',
        since: at,
        rule: say('runs.final.closedDone', { close: closeWord }),
        outcome: {
          kind: 'done',
          at: iso(at),
          by: actorOf(f.sessionFlip, say('runs.final.noCloseRecord')),
        },
        waitingOn: NO_WAIT(say('runs.rule.finished')),
      };
    }
  }
  const detail =
    read === 0
      ? f.issues.length > 0
        ? say('runs.final.unreadable', { close: closeWord, keys: f.issues.join(', ') })
        : say('runs.final.unreadableNone', { close: closeWord })
      : missed.length === 0
        ? say('runs.final.gaveBack', { close: closeWord })
        : say('runs.final.shortOf', {
            close: closeWord,
            missed: missed.map((m) =>
              say('runs.final.missed', {
                key: m.issueKey,
                status: m.status,
                landed: landedNote(f, m.issueKey),
              }),
            ),
          });
  return {
    state: 'handed_back',
    since: at,
    rule: detail,
    outcome: {
      kind: 'handed_back',
      at: iso(at),
      close,
      returnedTo: missed,
      detail: sayEn(detail),
      says: { detail },
    },
    waitingOn: NO_WAIT(say('runs.rule.finished')),
  };
}

export function finalOf(f: RunFacts): Derived | null {
  const s = f.session;
  if (f.run.status === 'cancelled') {
    return cancelledOutcome(f, f.runFlip ?? f.sessionFlip, say('runs.final.runCancelled'));
  }
  const sessionEnded = s !== null && TERMINAL_SESSION.includes(s.status);
  if (s && sessionEnded) {
    if (
      CANCELLED_AGENT_SESSION_STATUSES.includes(s.status as AgentSessionStatus) ||
      CANCEL_CAUSES.includes(s.failureReason ?? '')
    ) {
      return cancelledOutcome(
        f,
        f.sessionFlip,
        say('runs.final.sessionEnded', { why: s.failureReason ?? s.status }),
      );
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
      rule: say('runs.final.completed'),
      outcome: {
        kind: 'done',
        at: iso(at),
        by: actorOf(f.runFlip, say('runs.final.noCompletionRecord')),
      },
      waitingOn: NO_WAIT(say('runs.rule.finished')),
    };
  }
  if (f.run.status === 'failed') {
    const raw = f.job?.sessionFailureReason ?? f.job?.failureReason ?? s?.failureReason ?? null;
    return failedOutcome(f, raw, f.job?.sessionFailureDetail ?? s?.failureDetail ?? null);
  }
  return null;
}
