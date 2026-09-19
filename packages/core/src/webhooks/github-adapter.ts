import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  applyProjectedEvent,
  type DeliveryContext,
  isProjectedEvent,
} from '../integrations/github/projection-events.js';
import { admitGithubIssue, finalizeIntake } from '../issues/intake-gate.js';
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

/**
 * ISS-1076 — the door an outside contributor's report enters by, and it opens once.
 *
 * There is no update arm and no second write: the `ON CONFLICT DO NOTHING` is what
 * makes a re-delivered `opened` a no-op over a row Forge may since have retitled,
 * re-described or transitioned. Admission is the project's answer (`admitGithubIssue`),
 * never this file's.
 */
async function createExternalIssue(
  projectId: string,
  source: 'github',
  externalId: string,
  fields: { title: string; description: string | null; createdById: string },
): Promise<'created' | 'noop'> {
  const intake = await admitGithubIssue(projectId);
  if (!intake.admitted) {
    logger.info(
      { projectId, source, externalId, reason: intake.reason },
      'github-adapter: intake closed, no issue created',
    );
    return 'noop';
  }

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

export async function handleGitHubEvent(
  ctx: DeliveryContext,
  eventType: string,
  payload: GitHubEventPayload,
): Promise<GitHubAdapterResult> {
  const projectId = ctx.projectId;
  const action = payload.action ?? 'unknown';
  const key = `${eventType}.${action}`;

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
    if (action === 'opened') {
      const result = await createExternalIssue(projectId, 'github', externalId, {
        title: payload.issue.title ?? '(untitled GitHub issue)',
        description: payload.issue.body ?? null,
        createdById,
      });
      return { actions: result === 'noop' ? 0 : 1 };
    }
    if (action === 'edited' || action === 'closed') {
      logger.info(
        { key, projectId, externalId },
        'github-adapter: the intake door admits once, so this event writes nothing',
      );
      return { actions: 0 };
    }
  }

  logger.info({ key, projectId }, 'github-adapter: unhandled event');
  return { actions: 0 };
}
