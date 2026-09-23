import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { insertComment } from '../comments/service.js';
import { db } from '../db/client.js';
import { agentSessions, jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { requestSessionSend } from './session-send.js';

export class SteerError extends Error {
  constructor(
    public readonly code: 'NO_LIVE_SESSION' | 'SESSION_PARKED' | 'NO_DEVICE',
    message: string,
  ) {
    super(message);
    this.name = 'SteerError';
  }
}

export interface SteerOptions {
  /** User id of the acting principal — recorded in the audit event. */
  actorUserId: string;
  /**
   * Who was at the keyboard. A steer is usually a person reaching into a
   * running agent, but a master steering through MCP is not, and the comment
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
    throw new SteerError('NO_LIVE_SESSION', 'no live agent session is working this issue');
  }
  if (session.runtimeState === 'awaiting_input') {
    throw new SteerError(
      'SESSION_PARKED',
      'the session is waiting on an answer, not running — on an autonomous project a comment on the issue delivers it',
    );
  }

  const { row: comment } = await insertComment({
    issueId,
    authorId: opts.actorUserId,
    authorDeviceId: null,
    body,
    parentId: null,
  });

  const { row, published, duplicate } = await requestSessionSend({
    agentSessionId: session.agentSessionId,
    kind: 'inject',
    intentId: comment.id,
    body,
    actor: { userId: opts.actorUserId, reason: opts.reason, source: opts.source },
  });

  if (!published) {
    throw new SteerError('NO_DEVICE', 'the session has no device to deliver to');
  }

  return {
    agentSessionId: session.agentSessionId,
    jobId: session.jobId,
    commentId: comment.id,
    seq: row.seq,
    duplicate,
  };
}
