/**
 * The one definition of "an agent session row without its transcript".
 *
 * ISS-428 taught this on the MCP side: `messages` is a full transcript, often
 * multi-MB, and selecting it into a LIST makes every page carry every word
 * ever said. The MCP tool projected around it and left a guard saying never to
 * `select()` here; the REST list did exactly that anyway, so the same lesson
 * held on one transport and not the other. Both read this now.
 */

import { and, desc, eq, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type AgentSessionStatus, agentSessions } from '../db/schema.js';
import type { SessionTranscript } from '../db/session-vocabulary.js';
import { kindTuple, TRANSCRIPTLESS_SESSION_KINDS } from '../jobs/session-kinds.js';
import { buildListEnvelope } from '../mcp/tools/list-envelope.js';
import { encodeSessionCursor, type SessionCursor } from './cursor.js';

/** SQL true for a row whose lane keeps no transcript in core (master, run_session). */
const lanePutsNoTranscriptInCore = sql`${agentSessions.kind} IN ${kindTuple(TRANSCRIPTLESS_SESSION_KINDS)}`;

/** The one count of a session's entries, read by list and detail alike; null only for a lane that records no transcript. */
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
  messageCount: transcriptLength,
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
  /** Resume strictly after this row of the `(updated_at, id)` order. */
  after?: SessionCursor | undefined;
};

/**
 * `updated_at` as the database's own microsecond text, which is what a cursor carries: a JS Date
 * holds milliseconds, so a key round-tripped through one would skip or repeat rows that differ
 * only below the millisecond.
 */
const updatedAtKey = sql<string>`to_char(${agentSessions.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The lean rows an agent lists sessions with, newest first, `limit` of them from `after`. Each row
 * carries its `cursorKey`; {@link sessionListEnvelope} turns the rows into the page and mints the
 * token that resumes it.
 */
export async function listAgentSessionsForMcp(q: AgentSessionQuery) {
  const conds: SQL[] = [eq(agentSessions.projectId, q.projectId)];
  if (q.status) conds.push(eq(agentSessions.status, q.status));
  if (q.issueId) conds.push(sql`${agentSessions.metadata}->>'issueId' = ${q.issueId}`);
  if (q.after) {
    const at = sql`${q.after.updatedAtKey}::timestamptz`;
    conds.push(
      or(
        sql`${agentSessions.updatedAt} < ${at}`,
        and(sql`${agentSessions.updatedAt} = ${at}`, sql`${agentSessions.id} < ${q.after.id}::uuid`),
      ) as SQL,
    );
  }

  return db
    .select({ ...agentSessionMcpListColumns, cursorKey: updatedAtKey })
    .from(agentSessions)
    .where(and(...conds))
    .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id))
    .limit(q.limit);
}

/**
 * The page both surfaces answer with. `rows` is what {@link listAgentSessionsForMcp} read with
 * `limit + 1`; `nextCursor` is set exactly when the read stopped short of the project's rows,
 * whether the limit or the response-size cap stopped it, and `hasMore` is that same fact.
 */
export function sessionListEnvelope(
  rows: Awaited<ReturnType<typeof listAgentSessionsForMcp>>,
  limit: number,
  hint: string,
) {
  const keyById = new Map(rows.map((r) => [r.id, r.cursorKey]));
  const items = rows.map(({ cursorKey: _key, ...row }) => row);
  return buildListEnvelope({
    key: 'sessions',
    items,
    limit,
    hint,
    cursor: {
      more: rows.length > limit,
      of: (item) =>
        encodeSessionCursor({ updatedAtKey: keyById.get(item.id) as string, id: item.id }),
    },
  });
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
      totalMessages: agentSessionListColumns.messageCount,
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
