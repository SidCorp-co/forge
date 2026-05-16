import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';

export type DerivedAgentStatus = 'running' | 'queued' | 'completed' | 'failed' | null;

export interface HydratedAgentSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  title: string | null;
}

export interface HydratedAgentAttachment {
  agentSessions: HydratedAgentSession[];
  agentStatus: DerivedAgentStatus;
}

// Precedence: running > queued > most-recent terminal (failed wins over
// completed when present). Returns null when the input is empty or contains
// only sessions in unrecognized states (e.g. `idle`).
export function deriveAgentStatus(sessions: HydratedAgentSession[]): DerivedAgentStatus {
  if (sessions.length === 0) return null;
  if (sessions.some((s) => s.status === 'running')) return 'running';
  if (sessions.some((s) => s.status === 'queued')) return 'queued';
  if (sessions.some((s) => s.status === 'failed')) return 'failed';
  if (sessions.some((s) => s.status === 'completed')) return 'completed';
  return null;
}

// Fetch non-`idle` agent_sessions for the given issues within a project, then
// build a map of issueId → { agentSessions, agentStatus }. Sessions are linked
// via `metadata->>'issueId'` (the canonical link written by
// `jobs/agent-session-link.ts`).
export async function hydrateAgentSessionsForIssues(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, HydratedAgentAttachment>> {
  const map = new Map<string, HydratedAgentAttachment>();
  if (issueIds.length === 0) return map;

  const rows = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      metadata: agentSessions.metadata,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
      title: agentSessions.title,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        ne(agentSessions.status, 'idle'),
        sql`${agentSessions.metadata}->>'issueId' IS NOT NULL`,
        inArray(sql<string>`${agentSessions.metadata}->>'issueId'`, [...issueIds]),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt));

  for (const r of rows) {
    const meta = (r.metadata as Record<string, unknown> | null) ?? null;
    const issueId = typeof meta?.issueId === 'string' ? (meta.issueId as string) : null;
    if (!issueId) continue;
    let bucket = map.get(issueId);
    if (!bucket) {
      bucket = { agentSessions: [], agentStatus: null };
      map.set(issueId, bucket);
    }
    bucket.agentSessions.push({
      id: r.id,
      status: r.status,
      metadata: meta,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      title: r.title,
    });
  }

  for (const bucket of map.values()) {
    bucket.agentStatus = deriveAgentStatus(bucket.agentSessions);
  }

  // Ensure all requested issueIds have an entry — caller can graft the empty
  // shape directly without null-checks. `agentStatus = null` is treated as
  // `idle` by the indicator.
  for (const id of issueIds) {
    if (!map.has(id)) {
      map.set(id, { agentSessions: [], agentStatus: null });
    }
  }

  return map;
}
