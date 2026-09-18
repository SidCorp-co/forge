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

// cm:guard NEVER add `messages` to either projection. It is the whole reason they exist — a transcript is unbounded, it is the one column a list has no use for, and `messageCount` answers the only question a list actually asks of it. A caller that needs the transcript is fetching ONE session and has `agent-sessions/:id` for it.
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
  diff: agentSessions.diff,
  pipelineControl: agentSessions.pipelineControl,
  pipelineTelemetry: agentSessions.pipelineTelemetry,
  pipelineHealth: agentSessions.pipelineHealth,
  // cm:guard ISS-1023 — counted off the TURN LEDGER, and `null` where the ledger holds nothing.
  // `jsonb_array_length(messages)` forced a detoast of the transcript for every row of every list
  // page: beta's `messages` averages 233 KB and peaks at 35 MB under a 5.58 GB TOAST, for one
  // integer per row.
  //
  // It is `null` and NOT `0` for a session with no turn rows, and that is the load-bearing part.
  // Measured on beta 2026-09-17: 19,817 sessions hold a non-empty `messages` array and 2,339 of
  // them have no turn row at all — every one created between April and June 2026, before the
  // ledger existed. Reporting `0` for those would be a list asserting a session is empty when it
  // holds hundreds of messages, which is the silent substitution this count was supposed to avoid,
  // not a cheaper way to get the same answer. `null` says "not known from the ledger", which is
  // true, and the one session shape that reads `null` while genuinely empty is honest too.
  //
  // cm:guard write `"agent_sessions"."id"` LITERALLY and qualified — drizzle renders a column
  // reference interpolated into a raw template UNQUALIFIED, and a bare `id` inside
  // `FROM agent_session_turns t` binds to `t.id`, making the correlation `t.agent_session_id = t.id`:
  // never true, every count `null`, and nothing goes red.
  // cm:edge contract -> packages/core/src/db/schema.ts — served by
  // `agent_session_turns_session_index_unique (agent_session_id, turn_index)` as a reverse index
  // scan; dropping or reordering that index turns this into a per-row aggregate over 3.4M rows.
  messageCount: sql<number | null>`(
    SELECT max(t.turn_index) + 1
    FROM agent_session_turns t
    WHERE t.agent_session_id = "agent_sessions"."id"
  )`,
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

// cm:guard narrower than the REST projection ON PURPOSE, and it must stay that way: `diff`, `usage` and the three `pipeline*` jsonb columns are unbounded too, and an MCP result that overflows the token cap does not truncate — it crashes the agent mid-turn. The web list renders those fields; an agent listing sessions is choosing which ONE to fetch, and `.get` is where the detail lives.
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
  messageCount: agentSessionListColumns.messageCount,
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
// cm:guard the claim this makes is that no transcript crosses the WIRE, not that the database
// never detoasts. A jsonb value has no partial detoast — reading the last element costs the same
// read as reading all of them — so the server-side cost stands and only the transfer goes. Do not
// restate this as "the detail route no longer detoasts": that would be a stronger claim than the
// code earns.
export async function readAgentSession(sessionId: string) {
  const [row] = await db
    .select({
      ...agentSessionListColumns,
      // cm:guard the detail total is the TRANSCRIPT's own length, deliberately not the nullable
      // ledger count above. A reader who opened one session is owed the real number, and here the
      // row is already being read for its tail, so there is nothing to save by approximating it.
      totalMessages: sql<number>`coalesce(jsonb_array_length(${agentSessions.messages}), 0)`,
      // cm:guard ORDER BY ordinality DESC then LIMIT, never a jsonpath `$[last-19 to last]` — a
      // negative subscript on an array shorter than the tail is an error rather than a short
      // answer, so the jsonpath form fails exactly on the new sessions it is most often asked for.
      // The inner ordinality is kept so the tail comes back in transcript order, not reversed.
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
