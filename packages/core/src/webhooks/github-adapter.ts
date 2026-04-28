import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { logger } from '../logger.js';

export interface GitHubAdapterResult {
  actions: number;
}

interface GitHubIssuePayload {
  action?: string;
  issue?: { id?: number; title?: string; body?: string | null };
  pull_request?: { id?: number; title?: string; body?: string | null };
}

async function projectOwnerId(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.ownerId ?? null;
}

async function upsertExternalIssue(
  projectId: string,
  source: 'github',
  externalId: string,
  fields: { title: string; description: string | null; createdById: string },
): Promise<'created' | 'updated' | 'noop'> {
  const [existing] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.source, source),
        eq(issues.externalId, externalId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(issues)
      .set({ title: fields.title, description: fields.description, updatedAt: new Date() })
      .where(eq(issues.id, existing.id));
    return 'updated';
  }

  // INSERT ON CONFLICT DO NOTHING to guard against a racing replay.
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, description, created_by_id, source, external_id)
    VALUES (${projectId}, ${fields.title}, ${fields.description}, ${fields.createdById}, ${source}, ${externalId})
    ON CONFLICT (project_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  return (inserted[0] as { id?: string } | undefined)?.id ? 'created' : 'noop';
}

async function closeExternalIssue(
  projectId: string,
  source: 'github',
  externalId: string,
): Promise<boolean> {
  const updated = await db
    .update(issues)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.source, source),
        eq(issues.externalId, externalId),
      ),
    )
    .returning({ id: issues.id });
  return updated.length > 0;
}

export async function handleGitHubEvent(
  projectId: string,
  eventType: string,
  payload: GitHubIssuePayload,
): Promise<GitHubAdapterResult> {
  const action = payload.action ?? 'unknown';
  const key = `${eventType}.${action}`;

  // System user: fall back to project owner (see risks in F4 plan).
  const ownerId = await projectOwnerId(projectId);
  if (!ownerId) {
    logger.warn({ projectId }, 'github-adapter: project missing owner');
    return { actions: 0 };
  }

  if (eventType === 'issues' && payload.issue) {
    const externalId = String(payload.issue.id ?? '');
    if (!externalId) return { actions: 0 };
    if (action === 'opened' || action === 'edited') {
      const result = await upsertExternalIssue(projectId, 'github', externalId, {
        title: payload.issue.title ?? '(untitled GitHub issue)',
        description: payload.issue.body ?? null,
        createdById: ownerId,
      });
      return { actions: result === 'noop' ? 0 : 1 };
    }
    if (action === 'closed') {
      const ok = await closeExternalIssue(projectId, 'github', externalId);
      return { actions: ok ? 1 : 0 };
    }
  }

  if (eventType === 'pull_request' && payload.pull_request) {
    const externalId = `pr:${payload.pull_request.id ?? ''}`;
    if (externalId === 'pr:') return { actions: 0 };
    if (action === 'opened') {
      const result = await upsertExternalIssue(projectId, 'github', externalId, {
        title: payload.pull_request.title ?? '(untitled PR)',
        description: payload.pull_request.body ?? null,
        createdById: ownerId,
      });
      return { actions: result === 'noop' ? 0 : 1 };
    }
    if (action === 'closed') {
      const ok = await closeExternalIssue(projectId, 'github', externalId);
      return { actions: ok ? 1 : 0 };
    }
  }

  logger.info({ key, projectId }, 'github-adapter: unhandled event');
  return { actions: 0 };
}
