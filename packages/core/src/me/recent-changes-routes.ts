import { zValidator } from '@hono/zod-validator';
import { desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

interface RecentChangeItem {
  id: string;
  issSeq: number;
  title: string;
  status: string;
  updatedAt: string;
  projectSlug: string;
  projectName: string;
}

interface RecentChangesResponse {
  items: RecentChangeItem[];
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const meRecentChangesRoutes = new Hono<{ Variables: AuthVars }>();
meRecentChangesRoutes.use('/recent-changes', requireAuth(), assertEmailVerified());

/**
 * `GET /me/recent-changes` — the "what just changed that I should care about"
 * panel (ISS-665, replaces the raw chat-log activity feed): most-recently
 * updated issues across every project the caller can see (explicit membership
 * at any role, or org owner/admin — same visibility rule as `loadVisibleProjectIds`
 * elsewhere). Ordered by `issues.updatedAt` desc.
 *
 * Known limitation: there is no per-transition audit log, so `updatedAt` is a
 * proxy for "changed" — it also bumps on non-status edits (title, priority,
 * etc). A dedicated change-events feed would be a larger follow-up; the
 * common case (status transitions moving through the pipeline) is covered.
 */
meRecentChangesRoutes.get(
  '/recent-changes',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit } = c.req.valid('query');
    const userId = c.get('userId');

    const visibleIds = await loadVisibleProjectIds(userId);
    if (visibleIds.length === 0) {
      const empty: RecentChangesResponse = { items: [] };
      return c.json(empty);
    }

    const rows = await db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(inArray(issues.projectId, visibleIds))
      .orderBy(desc(issues.updatedAt))
      .limit(limit);

    const response: RecentChangesResponse = {
      items: rows.map((r) => ({
        id: r.id,
        issSeq: r.issSeq,
        title: r.title,
        status: r.status,
        updatedAt: r.updatedAt.toISOString(),
        projectSlug: r.projectSlug,
        projectName: r.projectName,
      })),
    };

    return c.json(response);
  },
);
