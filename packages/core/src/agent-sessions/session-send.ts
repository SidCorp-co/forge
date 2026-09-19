/**
 * RFC 0003 — the durable half of `session.send`.
 *
 * Core does not sit on a socket waiting for a process to answer. It stamps an
 * episode, publishes, and decides later — the shape `jobs/kill-gate.ts` already
 * had to adopt for the same question ("did my command reach the runner, and may
 * I act on not knowing?"). The draft of this RFC claimed no pending state was
 * needed; that is exactly the property the kill gate gave up in order to be
 * correct.
 *
 * `requestSessionSend` opens the episode, `confirmSessionSend` records what the
 * runner answered, `resolveSessionSend` decides whether silence is now an
 * answer, and `markSessionSendApplied` records the only event that means the
 * agent actually read the message.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, jobs, runners, terminalAgentSessionStatuses } from '../db/schema.js';
import {
  type SessionInboxKind,
  type SessionSendOutcome,
  sessionInbox,
} from '../db/schema-session-inbox.js';
import { insertInterventionEvent } from '../jobs/intervention-event.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';

export type SessionInboxRow = typeof sessionInbox.$inferSelect;

const SEND_ACK_MS_DEFAULT = 10_000;
const SEND_ACK_MS_FLOOR = 2_000;

export function sendGraceMs(): number {
  const raw = process.env.SESSION_SEND_ACK_MS;
  if (!raw) return SEND_ACK_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= SEND_ACK_MS_FLOOR ? n : SEND_ACK_MS_DEFAULT;
}

/** How long one send stays the CURRENT episode. Two grace windows, matching the kill gate. */
export function sendEpisodeWindowMs(): number {
  return sendGraceMs() * 2;
}

export function isSendEpisodeLive(row: SessionInboxRow, now: number = Date.now()): boolean {
  return now - row.sendRequestedAt.getTime() <= sendEpisodeWindowMs();
}

export interface SessionSendActor {
  userId: string;
  reason: string;
  source: 'rest' | 'mcp';
}

export interface SessionSendRequest {
  agentSessionId: string;
  kind: SessionInboxKind;
  /** Idempotency key. Stable across redeliveries of ONE intent — a comment id, a job id. */
  intentId: string;
  body?: string;
  /** Present for human-originated kinds; drives the audited `job_events` row. */
  actor?: SessionSendActor;
}

export interface SessionSendRequestResult {
  row: SessionInboxRow;
  /** False when the session has no device to publish to — resolve() will call it `gone`. */
  published: boolean;
  /** True when this intent already had a row, i.e. this call is a redelivery. */
  duplicate: boolean;
}

async function allocateSeq(agentSessionId: string): Promise<number> {
  const [row] = await db
    .update(agentSessions)
    .set({ lastInboxSeq: sql`${agentSessions.lastInboxSeq} + 1` })
    .where(eq(agentSessions.id, agentSessionId))
    .returning({ seq: agentSessions.lastInboxSeq });
  if (!row) throw new Error(`session not found: ${agentSessionId}`);
  return row.seq;
}

async function existingRow(req: SessionSendRequest): Promise<SessionInboxRow | undefined> {
  const [row] = await db
    .select()
    .from(sessionInbox)
    .where(
      and(
        eq(sessionInbox.agentSessionId, req.agentSessionId),
        eq(sessionInbox.kind, req.kind),
        eq(sessionInbox.intentId, req.intentId),
      ),
    )
    .limit(1);
  return row;
}

async function auditSend(req: SessionSendRequest, actor: SessionSendActor): Promise<void> {
  const [job] = await db
    .select({ id: jobs.id, issueId: jobs.issueId, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.agentSessionId, req.agentSessionId))
    .limit(1);
  if (!job) return;
  await db.transaction(async (tx) => {
    await insertInterventionEvent(tx, {
      jobId: job.id,
      issueId: job.issueId,
      action: req.kind === 'inject' ? 'inject' : 'answer',
      actorUserId: actor.userId,
      reason: actor.reason,
      source: actor.source,
      previousStatus: job.status,
    });
  });
}

async function jobKeyOf(agentSessionId: string): Promise<string | undefined> {
  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.agentSessionId, agentSessionId))
    .limit(1);
  return job?.id;
}

export async function requestSessionSend(
  req: SessionSendRequest,
): Promise<SessionSendRequestResult> {
  const [session] = await db
    .select({ id: agentSessions.id, deviceId: agentSessions.deviceId })
    .from(agentSessions)
    .where(eq(agentSessions.id, req.agentSessionId))
    .limit(1);
  if (!session) throw new Error(`session not found: ${req.agentSessionId}`);

  let row = await existingRow(req);
  const duplicate = row !== undefined;

  if (row?.appliedAt) return { row, published: false, duplicate };

  if (!row) {
    const seq = await allocateSeq(req.agentSessionId);
    const inserted = await db
      .insert(sessionInbox)
      .values({
        agentSessionId: req.agentSessionId,
        seq,
        kind: req.kind,
        intentId: req.intentId,
        body: req.body ?? null,
      })
      .onConflictDoNothing({
        target: [sessionInbox.agentSessionId, sessionInbox.kind, sessionInbox.intentId],
      })
      .returning();
    row = inserted[0] ?? (await existingRow(req));
    if (!row) throw new Error(`send row vanished: ${req.agentSessionId}/${req.intentId}`);
    if (req.actor) await auditSend(req, req.actor);
  }

  if (!isSendEpisodeLive(row)) {
    const [refreshed] = await db
      .update(sessionInbox)
      .set({ sendRequestedAt: new Date(), sendConfirmedAt: null, sendOutcome: null })
      .where(eq(sessionInbox.id, row.id))
      .returning();
    if (refreshed) row = refreshed;
  }

  if (!session.deviceId) return { row, published: false, duplicate };

  roomManager.publish(deviceRoom(session.deviceId), {
    event: 'session.send',
    data: {
      sessionId: req.agentSessionId,
      seq: row.seq,
      kind: row.kind,
      body: row.body ?? undefined,
      deadlineMs: sendGraceMs(),
      jobId: await jobKeyOf(req.agentSessionId),
    },
  });
  return { row, published: true, duplicate };
}

/** Record the runner's own answer for one episode. Called by the ack route. */
export async function confirmSessionSend(
  agentSessionId: string,
  seq: number,
  outcome: Exclude<SessionSendOutcome, 'unknown'>,
): Promise<void> {
  await db
    .update(sessionInbox)
    .set({ sendConfirmedAt: new Date(), sendOutcome: outcome })
    .where(and(eq(sessionInbox.agentSessionId, agentSessionId), eq(sessionInbox.seq, seq)));
}

/**
 * The commit point: a COMPLETED turn consumed this seq. Only after this may a
 * caller stand down the durable path it armed when it sent.
 */
export async function markSessionSendApplied(
  agentSessionId: string,
  seq: number,
  turn: number,
): Promise<void> {
  await db
    .update(sessionInbox)
    .set({ appliedAt: new Date(), appliedTurn: turn })
    .where(and(eq(sessionInbox.agentSessionId, agentSessionId), eq(sessionInbox.seq, seq)));
}

export interface SendResolution {
  outcome: SessionSendOutcome;
  /** True once the message is known to have reached the model, not merely the CLI. */
  applied: boolean;
}

export async function resolveSessionSend(
  row: SessionInboxRow,
  now: number = Date.now(),
): Promise<SendResolution> {
  const applied = row.appliedAt !== null;
  if (row.sendConfirmedAt && row.sendOutcome && isSendEpisodeLive(row, now)) {
    return { outcome: row.sendOutcome, applied };
  }
  if (isSendEpisodeLive(row, now)) return { outcome: 'unknown', applied };

  const [session] = await db
    .select({ deviceId: agentSessions.deviceId, status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, row.agentSessionId))
    .limit(1);
  if (!session || (terminalAgentSessionStatuses as readonly string[]).includes(session.status))
    return { outcome: 'gone', applied };
  if (!session.deviceId) return { outcome: 'gone', applied };

  const [runner] = await db
    .select({ lastSeenAt: runners.lastSeenAt })
    .from(runners)
    .where(eq(runners.deviceId, session.deviceId))
    .limit(1);
  const lastSeen = runner?.lastSeenAt ? new Date(runner.lastSeenAt).getTime() : null;
  if (lastSeen === null || now - lastSeen > dispatchLivenessMs()) {
    return { outcome: 'gone', applied };
  }
  return { outcome: 'unknown', applied };
}
