import { and, count, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type AgentSessionKind,
  type AgentSessionStatus,
  agentSessions,
  agentSessionTurns,
  issues,
  projects,
  usageRecords,
} from '../db/schema.js';
import { extractTurnPreview } from './chat-preview.js';
import { ownerPrivateChatSql } from './session-access.js';
import { transcriptLength } from './turns-helpers.js';
import {
  canonicalSessionId,
  EMPTY_USAGE_TOTALS,
  usageSessionMatch,
  usageTotalsSelection,
} from './usage-rollup.js';

/**
 * `agentSessionListColumns` is the one definition of "an agent session row" for a read; the
 * transcript lives in `agent_session_turns`, often multi-MB, and a LIST never joins it (ISS-428).
 */
const agentSessionListColumns = {
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

const agentSessionMcpListColumns = {
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
  failureReason: agentSessionListColumns.failureReason,
  dispatchedAt: agentSessionListColumns.dispatchedAt,
  startedAt: agentSessionListColumns.startedAt,
  lastHeartbeatAt: agentSessionListColumns.lastHeartbeatAt,
  createdAt: agentSessionListColumns.createdAt,
  updatedAt: agentSessionListColumns.updatedAt,
} as const;

type AgentSessionQuery = {
  projectId: string;
  status?: AgentSessionStatus | undefined;
  issueId?: string | undefined;
  /** Whose person-opened chats the rows hold besides project-wide sessions; null holds everyone's. */
  privateChatsOf: string | null;
  limit: number;
};

/** The lean rows an agent lists sessions with, newest first. */
export async function listAgentSessionsForMcp(q: AgentSessionQuery) {
  const conds: SQL[] = [eq(agentSessions.projectId, q.projectId)];
  if (q.status) conds.push(eq(agentSessions.status, q.status));
  if (q.issueId) conds.push(sql`${agentSessions.metadata}->>'issueId' = ${q.issueId}`);
  if (q.privateChatsOf !== null) {
    conds.push(sql`(NOT ${ownerPrivateChatSql} OR ${agentSessions.userId} = ${q.privateChatsOf})`);
  }

  return db
    .select(agentSessionMcpListColumns)
    .from(agentSessions)
    .where(and(...conds))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(q.limit);
}

/** How many messages a detail read returns. */
const MESSAGE_TAIL = 20;

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
      totalMessages: transcriptLength,
      messages: sql<unknown[]>`coalesce((
        SELECT jsonb_agg(x.e ORDER BY x.turn_index)
        FROM (
          SELECT t.content->'value' AS e, t.turn_index
          FROM agent_session_turns t
          WHERE t.agent_session_id = "agent_sessions"."id"
          ORDER BY t.turn_index DESC
          LIMIT ${sql.raw(String(MESSAGE_TAIL))}
        ) x
      ), '[]'::jsonb)`,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** Where a session lives and which device it was dispatched to, or null when it does not exist. */
export async function sessionPlacement(sessionId: string) {
  const [row] = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
      userId: agentSessions.userId,
      kind: agentSessions.kind,
      metadata: agentSessions.metadata,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}
/** A project's `{ id, slug }` by id. */
export async function projectHandle(projectId: string) {
  const [row] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** The issue a pipeline session is linked to, as a retry needs it. */
export async function linkedIssueOf(issueId: string) {
  const [row] = await db
    .select({ id: issues.id, status: issues.status, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}
/** A session's usage totals and its per-model breakdown, ordered by spend. */
export async function sessionCost(sessionId: string) {
  const sessionMatch = usageSessionMatch(sql`= ${canonicalSessionId(sessionId)}`);
  const [totals] = await db.select(usageTotalsSelection()).from(usageRecords).where(sessionMatch);
  const models = await db
    .select({
      model: usageRecords.model,
      cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
    })
    .from(usageRecords)
    .where(sessionMatch)
    .groupBy(usageRecords.model)
    .orderBy(desc(sql`sum(${usageRecords.estimatedCost})`));
  return { totals: totals ?? EMPTY_USAGE_TOTALS, models };
}

/** Queued and running session counts per device in a project. */
export async function sessionQueueDepth(projectId: string) {
  return db
    .select({
      deviceId: agentSessions.deviceId,
      status: agentSessions.status,
      count: count(),
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.status, ['queued', 'running']),
      ),
    )
    .groupBy(agentSessions.deviceId, agentSessions.status);
}

export type AgentSessionListFilter = {
  /** One project, or the caller-visible projects (optionally narrowed to one device). */
  scope: { projectId: string } | { visibleProjectIds: string[]; deviceId?: string | undefined };
  status?: AgentSessionStatus | undefined;
  kind?: AgentSessionKind | undefined;
  issueId?: string | undefined;
  /** Whose person-opened chats the page holds besides project-wide sessions; null holds everyone's. */
  privateChatsOf: string | null;
  archived: boolean;
  page: number;
  pageSize: number;
};

/**
 * One page of sessions, newest first, each with its dollar cost and last message preview, both
 * rolled up in one bounded query over the page's ids (ISS-391).
 */
export async function listAgentSessionsPage(f: AgentSessionListFilter) {
  const conditions: SQL[] = [];
  if ('projectId' in f.scope) {
    conditions.push(eq(agentSessions.projectId, f.scope.projectId));
  } else {
    if (f.scope.deviceId) conditions.push(eq(agentSessions.deviceId, f.scope.deviceId));
    conditions.push(inArray(agentSessions.projectId, f.scope.visibleProjectIds));
  }
  if (f.status) conditions.push(eq(agentSessions.status, f.status));
  if (f.kind) conditions.push(eq(agentSessions.kind, f.kind));
  if (f.issueId) conditions.push(sql`${agentSessions.metadata}->>'issueId' = ${f.issueId}`);
  if (f.privateChatsOf !== null) {
    conditions.push(
      sql`(NOT ${ownerPrivateChatSql} OR ${agentSessions.userId} = ${f.privateChatsOf})`,
    );
  }
  // ISS-465 — `IS DISTINCT FROM` keeps rows whose metadata has no `archived` key.
  if (f.archived) {
    conditions.push(sql`${agentSessions.metadata}->>'archived' = 'true'`);
  } else {
    conditions.push(sql`(${agentSessions.metadata}->>'archived') IS DISTINCT FROM 'true'`);
  }
  const where = and(...conditions);

  const [totalRow] = await db.select({ n: count() }).from(agentSessions).where(where);
  const rows = await db
    .select(agentSessionListColumns)
    .from(agentSessions)
    .where(where)
    .orderBy(desc(agentSessions.updatedAt))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);

  // usage_records.session_id = agent_sessions.id; each id goes in through `canonicalSessionId` so
  // the IN list is canonical text and the column stays uncast and index-served.
  const costById = new Map<string, number>();
  const previewById = new Map<string, string>();
  const pageIds = rows.map((r) => r.id);
  if (pageIds.length > 0) {
    const idList = sql.join(
      pageIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const sessionIdList = sql.join(
      pageIds.map((id) => canonicalSessionId(id)),
      sql`, `,
    );
    const costRows = await db
      .select({
        sessionId: usageRecords.sessionId,
        estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
      })
      .from(usageRecords)
      .where(usageSessionMatch(sql`IN (${sessionIdList})`))
      .groupBy(usageRecords.sessionId);
    for (const cr of costRows) {
      if (cr.sessionId) costById.set(cr.sessionId, cr.estimatedCost);
    }

    const previewRows = (await db.execute(sql`
      SELECT DISTINCT ON (${agentSessionTurns.agentSessionId}) ${agentSessionTurns.agentSessionId} AS session_id, ${agentSessionTurns.content} AS content
      FROM ${agentSessionTurns}
      WHERE ${agentSessionTurns.agentSessionId} IN (${idList}) AND ${agentSessionTurns.role} <> 'tool'
      ORDER BY ${agentSessionTurns.agentSessionId}, ${agentSessionTurns.turnIndex} DESC
    `)) as unknown as Array<{ session_id: string; content: unknown }>;
    for (const pr of previewRows) {
      // Turn rows wrap the message entry as `{ value: entry }`; the text is at `value.content`.
      const entryValue = (pr.content as { value?: unknown } | null)?.value;
      const entryContent =
        entryValue && typeof entryValue === 'object'
          ? (entryValue as { content?: unknown }).content
          : undefined;
      const preview = extractTurnPreview(entryContent);
      if (preview) previewById.set(pr.session_id, preview);
    }
  }

  const items = rows.map((r) => ({
    ...r,
    estimatedCost: costById.get(r.id) ?? 0,
    lastMessagePreview: previewById.get(r.id) ?? null,
  }));
  return { items, total: totalRow?.n ?? 0 };
}
