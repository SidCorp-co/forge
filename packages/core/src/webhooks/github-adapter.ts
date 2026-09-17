import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import {
  applyProjectedEvent,
  type DeliveryContext,
  isProjectedEvent,
} from '../integrations/github/projection-events.js';
import { applyIntakeGate, finalizeIntake } from '../issues/intake-gate.js';
import { logger } from '../logger.js';

export interface GitHubAdapterResult {
  actions: number;
}

interface GitHubIssuePayload {
  action?: string;
  issue?: { id?: number; title?: string; body?: string | null };
}

/**
 * What one delivery carries, whichever of the five events it is.
 *
 * Open on purpose: five event types reach this door and only `issues` has a
 * shape this file reads. The four the projection owns are typed where they are
 * read (`integrations/github/projection.ts`), which is the only place that can
 * say what a `check_run` looks like without this file learning what one is.
 */
export type GitHubEventPayload = GitHubIssuePayload & Record<string, unknown>;

async function projectCreatedById(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy ?? null;
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

  // ISS-606: a gated project parks the webhook-created issue at draft.
  const intake = await applyIntakeGate(projectId, 'open');

  // cm:edge contract -> packages/core/src/issues/creator.ts — stamp created_via or Creator mislabels this row
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, description, created_by_id, source, external_id, status, created_via)
    VALUES (${projectId}, ${fields.title}, ${fields.description}, ${fields.createdById}, ${source}, ${externalId}, ${intake.status}, 'system')
    ON CONFLICT (project_id, source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id
  `);
  const createdId = (inserted[0] as { id?: string } | undefined)?.id;
  if (createdId && intake.gated) {
    await finalizeIntake(projectId, { id: createdId, title: fields.title });
  }
  return createdId ? 'created' : 'noop';
}

async function closeExternalIssue(
  projectId: string,
  source: 'github',
  externalId: string,
): Promise<boolean> {
  // cm:guard close WITHOUT stamping merged_at — `merged_at` releases every `blocks` dependent as if the work had shipped, and GitHub closes an issue for `wontfix`, `duplicate` and `not planned` with the same event as one that was actually fixed. This used to COALESCE a stamp in to mirror `issues/merged-at.ts markMergedOnClose`, which is the state-machine writer's rule for work Forge itself drove to done; a mirror of somebody else's tracker knows only that the row is closed.
  const updated = await db
    .update(issues)
    .set({
      status: 'closed',
      updatedAt: new Date(),
    })
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
  ctx: DeliveryContext,
  eventType: string,
  payload: GitHubEventPayload,
): Promise<GitHubAdapterResult> {
  const projectId = ctx.projectId;
  const action = payload.action ?? 'unknown';
  const key = `${eventType}.${action}`;

  // cm:guard the projection is reached FIRST and returns, so no pull-request, check-run, review or push delivery can fall into the issues mirror below. The two halves answer different questions about different objects and there is no event both should see.
  if (isProjectedEvent(eventType)) {
    return { actions: await applyProjectedEvent(ctx, eventType, payload) };
  }

  // System user: fall back to the project creator (`projects.createdBy`,
  // audit-only — see risks in F4 plan).
  const createdById = await projectCreatedById(projectId);
  if (!createdById) {
    logger.warn({ projectId }, 'github-adapter: project missing creator');
    return { actions: 0 };
  }

  if (eventType === 'issues' && payload.issue) {
    const externalId = String(payload.issue.id ?? '');
    if (!externalId) return { actions: 0 };
    if (action === 'opened' || action === 'edited') {
      const result = await upsertExternalIssue(projectId, 'github', externalId, {
        title: payload.issue.title ?? '(untitled GitHub issue)',
        description: payload.issue.body ?? null,
        createdById,
      });
      return { actions: result === 'noop' ? 0 : 1 };
    }
    if (action === 'closed') {
      const ok = await closeExternalIssue(projectId, 'github', externalId);
      return { actions: ok ? 1 : 0 };
    }
  }

  // cm:guard a `pull_request` event must NEVER create a Forge issue. It did until 2026-09-06, filing one per opened PR: a PR is a change under review, not a unit of work with a deliverable and an owner, so it fails every admission gate in the `what-is-an-issue` guide and arrives in the backlog owned by nobody. Since ISS-1062 it does not even reach this line — `isProjectedEvent` returns it above into the projection, which writes `repo_pull_requests` and touches no issue at all.
  logger.info({ key, projectId }, 'github-adapter: unhandled event');
  return { actions: 0 };
}
