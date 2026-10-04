import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { type ImprovementMessage, listImprovementMessages } from '../schedules/index.js';
import { templateSchedulesOf } from './read.js';

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
    if (!r.success) throw badRequest(r.error);
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
    requireHeld(access, 'project.read');

    const enabledRows = await templateSchedulesOf(projectId);

    const byKey = new Map(
      enabledRows.flatMap((r) => (r.templateKey === null ? [] : [[r.templateKey, r] as const])),
    );

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
