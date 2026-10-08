// What an Agent turn that left no reply is read as, from the cause its session failed with: a crash,
// a timeout naming the limit it hit, a box that cannot confine a chat, or — only where none of those
// is named — the door's own failure sentence (REQ-30 BC-9; chat-turn steps crash and noconfine).

import { type FailureCause, resolveFailureCause } from '@forge/contracts/failure-causes';
import { getLoopThresholds } from '../jobs/index.js';

export type AgentTurnFailureKind = 'crashed' | 'timed-out' | 'not-reached' | 'box-cannot-confine';

export interface AgentTurnFailure {
  kind: AgentTurnFailureKind;
  /** What happened, as the turn's record keeps it and the thread's failed entry shows it. */
  reason: string;
  /** What the person does next. */
  next: string;
}

/** The session columns a reading needs: how it ended, and when, against the limit that reaped it. */
export interface EndedSession {
  status: string;
  failureReason: string | null;
  metadata: unknown;
  createdAt: Date;
  dispatchedAt: Date | null;
  updatedAt: Date;
}

/** The causes that mean the session or its box died before it answered. */
const CRASHED: Partial<Record<FailureCause, string>> = {
  agent_exited_without_result: 'it exited without writing a result',
  agent_killed: 'it was killed by a signal',
  agent_startup_failed: 'it died while starting',
  session_lost: 'it died without reporting back',
  runner_unreachable: 'its box stopped answering',
};

/** What the person does next after each reading. */
export const AGENT_TURN_NEXT_STEP: Record<AgentTurnFailureKind, string> = {
  crashed:
    "Send your message again: a new turn starts a fresh session. If it crashes again, the session's page in Forge names the cause.",
  'timed-out':
    'Send your message again. If it times out again, check that forge-runner is running and online on the paired box.',
  'not-reached':
    'Send your message again. If it does not reach the box again, check that forge-runner is running and online on the paired box.',
  'box-cannot-confine':
    'The box holder can run `forge-runner doctor` on that box to see what is missing: a chat runs confined only on Linux with bubblewrap (`bwrap`) installed and a current forge-runner (`forge-runner update`). Until then, ask in Assistant mode for anything that does not need the repository.',
};

/** A limit in the words a person reads it in: "90 seconds", "3 minutes". */
export function spanOf(ms: number): string {
  if (ms < 120_000) {
    const s = Math.round(ms / 1000);
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.round(ms / 60_000);
  return `${m} minutes`;
}

/** What the box was given before the reaper took the turn, or null where the cause names no limit. */
function timedOut(
  cause: FailureCause,
  session: EndedSession,
): { clause: string; limitMs: number } | null {
  const { queueMs, heartbeatMs, ackFastMs } = getLoopThresholds();
  const acked = (session.metadata as { acked?: unknown } | null)?.acked === true;
  switch (cause) {
    case 'no_client_ack':
      return acked
        ? {
            clause: `the box took it but did not start its session within ${spanOf(ackFastMs)}`,
            limitMs: ackFastMs,
          }
        : {
            clause: `no box started a session for it within ${spanOf(heartbeatMs)}`,
            limitMs: heartbeatMs,
          };
    case 'queue_timeout':
      return { clause: `no box picked it up within ${spanOf(queueMs)}`, limitMs: queueMs };
    case 'heartbeat_timeout':
      return {
        clause: `its session sent no heartbeat for ${spanOf(heartbeatMs)}`,
        limitMs: heartbeatMs,
      };
    case 'turn_never_reported':
      return {
        clause: `the box claimed it, then reported nothing for ${spanOf(heartbeatMs)}`,
        limitMs: heartbeatMs,
      };
    default:
      return null;
  }
}

/**
 * How a session that left no reply is read, or null where its cause names none of these and the
 * door's own failure sentence is the truth: a session that finished without writing one, a person
 * who stopped it, a provider that refused it.
 */
export function agentTurnFailure(session: EndedSession): AgentTurnFailure | null {
  if (session.status === 'completed') return null;
  const cause = resolveFailureCause(session.failureReason);
  if (cause === 'box_cannot_confine_chat') {
    return {
      kind: 'box-cannot-confine',
      reason:
        'the box that would take this Agent turn cannot confine a chat session, so nothing ran',
      next: AGENT_TURN_NEXT_STEP['box-cannot-confine'],
    };
  }
  const crash = CRASHED[cause];
  if (crash)
    return {
      kind: 'crashed',
      reason: `the Agent session crashed: ${crash}`,
      next: AGENT_TURN_NEXT_STEP.crashed,
    };
  const timeout = timedOut(cause, session);
  if (!timeout) return null;
  const waited = +session.updatedAt - +(session.dispatchedAt ?? session.createdAt);
  // a turn failed under a timeout's cause before its limit ran out was not timed out: the box's
  // socket dropped as the turn was handed over (`agent-sessions/chat-turn.ts:failUndelivered`)
  if (waited < timeout.limitMs) {
    return {
      kind: 'not-reached',
      reason:
        "the Agent turn never reached its box: the box's connection dropped as the turn was handed to it",
      next: AGENT_TURN_NEXT_STEP['not-reached'],
    };
  }
  return {
    kind: 'timed-out',
    reason: `the Agent turn timed out: ${timeout.clause}`,
    next: AGENT_TURN_NEXT_STEP['timed-out'],
  };
}

/** The sentence the room is shown for a reading: what happened, then what to do. */
export function agentTurnFailureText(failure: AgentTurnFailure): string {
  return `${failure.reason.charAt(0).toUpperCase()}${failure.reason.slice(1)}. ${failure.next}`;
}
