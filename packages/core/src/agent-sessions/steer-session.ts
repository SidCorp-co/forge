import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import { agentSessionsPorts } from './ports.js';
import { refuseSession } from './refusals.js';
import { requestSessionSend } from './session-send.js';

export interface SteerOptions {
  /** User id of the acting principal — recorded in the audit event. */
  actorUserId: string;
  /**
   * Who was at the keyboard. A steer is usually a person reaching into a
   * running agent, but a master steering over its token is not, and the comment
   * this writes has to say which (ISS-969).
   */
  actorAgency: ActorAgency;
  /** Why the steer was sent — recorded in the audit event. */
  reason: string;
  /** Which surface invoked it. */
  source: 'rest' | 'mcp';
}

export interface SteerResult {
  agentSessionId: string;
  jobId: string;
  /** The comment carrying the steer text — also the send's idempotency key. */
  commentId: string;
  seq: number;
  /** True when a redelivery of an intent that already had a row. */
  duplicate: boolean;
}

export interface SteerableSession {
  agentSessionId: string;
  jobId: string;
  runtimeState: string | null;
}

/**
 * The live session working this issue, whatever state it is in.
 *
 * Deliberately NOT filtered on `runtimeState` — the caller needs to tell "no
 * session" from "a session that is parked" to say which door to use, and a
 * query that dropped the parked row would collapse both into one answer.
 */
export async function steerableSessionFor(issueId: string): Promise<SteerableSession | null> {
  const [row] = await db
    .select({
      agentSessionId: agentSessions.id,
      jobId: jobs.id,
      runtimeState: agentSessions.runtimeState,
    })
    .from(jobs)
    .innerJoin(agentSessions, eq(agentSessions.id, jobs.agentSessionId))
    .where(
      and(
        eq(jobs.issueId, issueId),
        isNotNull(jobs.agentSessionId),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function steerIssue(
  issueId: string,
  body: string,
  opts: SteerOptions,
): Promise<SteerResult> {
  const session = await steerableSessionFor(issueId);
  if (!session) {
    throw refuseSession('NO_LIVE_SESSION', 'no live agent session is working this issue');
  }
  if (session.runtimeState === 'awaiting_input') {
    throw refuseSession(
      'SESSION_PARKED',
      'the session is waiting on an answer, not running — on an autonomous project a comment on the issue delivers it',
    );
  }

  const comment = await agentSessionsPorts().postSteerComment({
    issueId,
    authorId: opts.actorUserId,
    body,
  });

  const { row, published, duplicate } = await requestSessionSend({
    agentSessionId: session.agentSessionId,
    kind: 'inject',
    intentId: comment.id,
    body,
    actor: { userId: opts.actorUserId, reason: opts.reason, source: opts.source },
  });

  if (!published) {
    throw refuseSession('NO_DEVICE', 'the session has no device to deliver to');
  }

  return {
    agentSessionId: session.agentSessionId,
    jobId: session.jobId,
    commentId: comment.id,
    seq: row.seq,
    duplicate,
  };
}
