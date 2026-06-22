import { zValidator } from '@hono/zod-validator';
import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { schedules } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  type ImprovementMessage,
  listImprovementMessages,
} from '../schedules/messages/registry.js';
import { listPendingDrafts, type ImprovementMessageDraftRow } from './drafts-service.js';

const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export interface ImprovementMessageEntry extends ImprovementMessage {
  enablement: {
    enabled: boolean;
    scheduleId: string;
    mode: string;
    cron: string;
  } | null;
}

export const improvementMessageRoutes = new Hono<{ Variables: AuthVars }>();
improvementMessageRoutes.use('*', requireAuth(), assertEmailVerified());

improvementMessageRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const catalog = listImprovementMessages();

    if (!projectId) {
      const entries: ImprovementMessageEntry[] = catalog.map((msg) => ({
        ...msg,
        enablement: null,
      }));
      return c.json(entries);
    }

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    // Left-join: find any enabled schedule rows for this project that have a templateKey.
    const enabledRows = await db
      .select({
        id: schedules.id,
        templateKey: schedules.templateKey,
        mode: schedules.mode,
        cron: schedules.cron,
        enabled: schedules.enabled,
      })
      .from(schedules)
      .where(and(eq(schedules.projectId, projectId), isNotNull(schedules.templateKey)))
      .limit(1000);

    const byKey = new Map(enabledRows.map((r) => [r.templateKey!, r]));

    const entries: ImprovementMessageEntry[] = catalog.map((msg) => {
      const row = byKey.get(msg.key);
      return {
        ...msg,
        enablement: row
          ? {
              enabled: row.enabled,
              scheduleId: row.id,
              mode: row.mode ?? msg.defaultMode,
              cron: row.cron,
            }
          : null,
      };
    });

    return c.json(entries);
  },
);

const draftsQuerySchema = z
  .object({
    projectId: z.string().uuid(),
  })
  .strict();

// GET /api/improvement-messages/drafts?projectId=<uuid>
// Returns pending_review drafts sourced from the given project.
// Requires project membership (viewer+).
improvementMessageRoutes.get(
  '/drafts',
  zValidator('query', draftsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'viewer', 'not a project member');

    const drafts: ImprovementMessageDraftRow[] = await listPendingDrafts(projectId);
    return c.json(drafts);
  },
);
