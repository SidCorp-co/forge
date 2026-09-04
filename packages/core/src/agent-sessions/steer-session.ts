/**
 * Steer — new instruction into a job that is ALREADY RUNNING (ISS-888 item 2).
 *
 * Before this, "the right decision at the right time" had two moments: before
 * the job was dispatched and after it finished. The 1-3 hours in between had no
 * door, so a job seen going the wrong way in its second hour cost that hour
 * plus a re-run. This is the door, and it is deliberately thin: RFC 0003's
 * `session.send` already carried an `inject` kind that both core and the runner
 * implemented in full and nobody could call.
 *
 * `answer` and `inject` are the same act with different provenance, and they
 * are complementary rather than overlapping: an ANSWER requires the session to
 * be parked (the park is what makes it an answer), a STEER requires it NOT to
 * be (mid-turn is what makes it a steer). One door each, and the rejection
 * below is what keeps them from becoming two doors onto one situation.
 */

import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { insertComment } from '../comments/service.js';
import { db } from '../db/client.js';
import { agentSessions, jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import { requestSessionSend } from './session-send.js';

/**
 * Transport-neutral failure. Callers map `code` to their own surface:
 * REST → HTTP status, MCP → `Error('CODE: message')` — the same contract
 * {@link JobCancelError} defines for cancel.
 */
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
// cm:edge lockstep -> packages/core/src/pipeline/answer-resume.ts — `parkedSessionFor` is this join with the park REQUIRED instead of rejected; the two are the complementary halves of one rule, and widening either one without the other puts both doors onto the same session
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

/**
 * Deliver an instruction to the session working this issue.
 *
 * The text is written to the issue as a comment FIRST, and that comment's id is
 * the send's `intentId`. Two things follow: the steer is on the record where a
 * person can read what was said, and a redelivery of the same intent finds its
 * own row instead of queueing the instruction twice.
 *
 * @throws {SteerError} `NO_LIVE_SESSION` when nothing is running this issue;
 *   `SESSION_PARKED` when the session is waiting on an answer instead;
 *   `NO_DEVICE` when core had nowhere to publish the frame.
 */
// cm:guard `insertComment`, NOT the `commentCreated` hook path. `pipeline/answer-resume.ts` subscribes to that hook and, finding no parked session, FALLS BACK to transitioning the issue and dispatching a fresh job — so routing a steer through it would answer a steer by starting a second agent on the same worktree. The comment here is a record, and this function owns its own delivery; two owners of one delivery is the defect ISS-889 was about.
// cm:guard the actor is REQUIRED and must never become optional. `requestSessionSend` writes the audited `job_events kind='intervention'` row only when one is given, and that row is VISION §1 metric ② via `issue_intervention_events` (`concat('manual_', action)` → `manual_inject`). A steer that delivers without auditing makes the interventions-per-issue number read LOWER while a person reaches into a running agent — the metric moving the wrong way on the exact path it exists to measure.
export async function steerIssue(
  issueId: string,
  body: string,
  opts: SteerOptions,
): Promise<SteerResult> {
  const session = await steerableSessionFor(issueId);
  if (!session) {
    throw new SteerError('NO_LIVE_SESSION', 'no live agent session is working this issue');
  }
  // cm:guard the message says "on an autonomous project" because on a STAGED one it would be a promise nothing keeps: `pipeline/answer-resume.ts` early-returns on `isAutonomousProject`, so a staged duplex session that parks has no answer door at all and a comment reaches nobody. Naming a mechanism that exists in one mode as though it existed in both is the exact defect `scripts/check-injected-doc-modes.mjs` was built to catch one surface earlier — and an error string is not a surface that gate can see, so this comment is the only thing holding it.
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

  // cm:guard report the unpublished send as a FAILURE rather than returning a result the caller reads as success. `published: false` means core had no device room to publish to, so the instruction reached a durable row and nothing else — and a steer silently accepted is exactly the "state-never-lies" violation this issue's item 1 is about, arriving through the door item 2 opened.
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
