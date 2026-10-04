import { and, count, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type AgentSessionKind,
  type AgentSessionStatus,
  agentSessions,
  agentSessionTurns,
  devices,
  issues,
  projects,
  runners,
  usageRecords,
} from '../db/schema.js';
import {
  canonicalSessionId,
  EMPTY_USAGE_TOTALS,
  usageSessionMatch,
  usageTotalsSelection,
} from './usage-rollup.js';
import { extractTurnPreview } from './chat-preview.js';
import { agentSessionListColumns } from './service.js';

/** Where a session lives and which device it was dispatched to, or null when it does not exist. */
export async function sessionPlacement(
  sessionId: string,
): Promise<{ id: string; projectId: string; deviceId: string | null } | null> {
  const [row] = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** The project a slug names, as `{ id, slug }`. */
export async function loadProjectBySlug(slug: string) {
  const [row] = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.slug, slug))
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

/** The display refs and titles of the issues a chat is started on. */
export async function issueRefsOf(issueIds: string[]) {
  return db
    .select({ seq: issues.issSeq, prefix: projects.issuePrefix, title: issues.title })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, issueIds));
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

/** A device's liveness and owner, or null when it does not exist. */
export async function deviceLiveness(deviceId: string) {
  const [row] = await db
    .select({ status: devices.status, ownerId: devices.ownerId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  return row ?? null;
}

/** Whether a device serves as a runner for any of these projects. */
export async function deviceServesAnyOf(deviceId: string, projectIds: string[]): Promise<boolean> {
  const [served] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.deviceId, deviceId), inArray(runners.projectId, projectIds)))
    .limit(1);
  return served !== undefined;
}
