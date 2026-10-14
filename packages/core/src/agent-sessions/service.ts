/**
 * The one definition of "an agent session row without its transcript".
 *
 * ISS-428 taught this on the MCP side: `messages` is a full transcript, often
 * multi-MB, and selecting it into a LIST makes every page carry every word
 * ever said. The MCP tool projected around it and left a guard saying never to
 * `select()` here; the REST list did exactly that anyway, so the same lesson
 * held on one transport and not the other. Both read this now.
 */

import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type AgentSessionStatus, agentSessions } from '../db/schema.js';
import type { SessionTranscript } from '../db/session-vocabulary.js';
import { kindTuple, TRANSCRIPTLESS_SESSION_KINDS } from '../jobs/session-kinds.js';

/** SQL true for a row whose lane keeps no transcript in core (master, run_session). */
const lanePutsNoTranscriptInCore = sql`${agentSessions.kind} IN ${kindTuple(TRANSCRIPTLESS_SESSION_KINDS)}`;

/** A count nobody writes is not a count: null here only for a lane that records no transcript. */
const transcriptLength = sql<number | null>`CASE WHEN ${lanePutsNoTranscriptInCore} THEN NULL
  ELSE coalesce(jsonb_array_length(${agentSessions.messages}), 0) END`;

export const agentSessionListColumns = {
  id: agentSessions.id,
  projectId: agentSessions.projectId,
  userId: agentSessions.userId,
  deviceId: agentSessions.deviceId,
  pipelineRunId: agentSessions.pipelineRunId,
  title: agentSessions.title,
  status: agentSessions.status,
  claudeSessionId: agentSessions.claudeSessionId,
  repoPath: agentSessions.repoPath,
  usage: agentSessions.usage,
  metadata: agentSessions.metadata,
  kind: agentSessions.kind,
  parentSessionId: agentSessions.parentSessionId,
  diff: agentSessions.diff,
  pipelineControl: agentSessions.pipelineControl,
  pipelineTelemetry: agentSessions.pipelineTelemetry,
  pipelineHealth: agentSessions.pipelineHealth,
  // The turn ledger answers without reading the transcript; its length answers only where the ledger has no rows.
  messageCount: sql<number | null>`CASE WHEN ${lanePutsNoTranscriptInCore} THEN NULL ELSE coalesce((
    SELECT max(t.turn_index) + 1
    FROM agent_session_turns t
    WHERE t.agent_session_id = "agent_sessions"."id"
  ), jsonb_array_length(${agentSessions.messages}), 0) END`,
  transcript: sql<SessionTranscript>`CASE WHEN ${lanePutsNoTranscriptInCore} THEN 'not-recorded' ELSE 'recorded' END`,
  failureReason: agentSessions.failureReason,
  failureDetail: agentSessions.failureDetail,
  runtimeState: agentSessions.runtimeState,
  lastInboxSeq: agentSessions.lastInboxSeq,
  dispatchedAt: agentSessions.dispatchedAt,
  startedAt: agentSessions.startedAt,
  lastHeartbeatAt: agentSessions.lastHeartbeatAt,
  createdAt: agentSessions.createdAt,
  updatedAt: agentSessions.updatedAt,
} as const;

export const agentSessionMcpListColumns = {
  id: agentSessionListColumns.id,
  projectId: agentSessionListColumns.projectId,
  userId: agentSessionListColumns.userId,
  deviceId: agentSessionListColumns.deviceId,
  pipelineRunId: agentSessionListColumns.pipelineRunId,
  title: agentSessionListColumns.title,
  status: agentSessionListColumns.status,
  claudeSessionId: agentSessionListColumns.claudeSessionId,
  repoPath: agentSessionListColumns.repoPath,
  metadata: agentSessionListColumns.metadata,
  kind: agentSessionListColumns.kind,
  parentSessionId: agentSessionListColumns.parentSessionId,
  messageCount: agentSessionListColumns.messageCount,
  transcript: agentSessionListColumns.transcript,
  failureReason: agentSessionListColumns.failureReason,
  dispatchedAt: agentSessionListColumns.dispatchedAt,
  startedAt: agentSessionListColumns.startedAt,
  lastHeartbeatAt: agentSessionListColumns.lastHeartbeatAt,
  createdAt: agentSessionListColumns.createdAt,
  updatedAt: agentSessionListColumns.updatedAt,
} as const;

export type AgentSessionQuery = {
  projectId: string;
  status?: AgentSessionStatus | undefined;
  issueId?: string | undefined;
  limit: number;
};

/** The lean rows an agent lists sessions with, newest first. */
export async function listAgentSessionsForMcp(q: AgentSessionQuery) {
  const conds: SQL[] = [eq(agentSessions.projectId, q.projectId)];
  if (q.status) conds.push(eq(agentSessions.status, q.status));
  if (q.issueId) conds.push(sql`${agentSessions.metadata}->>'issueId' = ${q.issueId}`);

  return db
    .select(agentSessionMcpListColumns)
    .from(agentSessions)
    .where(and(...conds))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(q.limit);
}

/** How many messages a detail read returns. Both the REST route and the MCP tool take this tail. */
export const MESSAGE_TAIL = 20;

/**
 * One session with the LAST {@link MESSAGE_TAIL} messages, sliced by the database.
 *
 * ISS-1023 — this was `select()`, which pulled the whole transcript into node so that the two
 * callers could each throw all but the last 20 away. On beta that is 233 KB on average and 35 MB
 * at the tail of the distribution, per detail view, over the wire and into a JS array.
 */
export async function readAgentSession(sessionId: string) {
  const [row] = await db
    .select({
      ...agentSessionListColumns,
      messageCount: transcriptLength,
      totalMessages: transcriptLength,
      messages: sql<unknown[]>`coalesce((
        SELECT jsonb_agg(x.e ORDER BY x.ord)
        FROM (
          SELECT e, ord
          FROM jsonb_array_elements(${agentSessions.messages}) WITH ORDINALITY AS y(e, ord)
          ORDER BY ord DESC
          LIMIT ${sql.raw(String(MESSAGE_TAIL))}
        ) x
      ), '[]'::jsonb)`,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}
