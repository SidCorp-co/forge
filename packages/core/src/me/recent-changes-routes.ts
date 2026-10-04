import { Hono } from 'hono';
import { z } from 'zod';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readRecentChanges } from './read.js';

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
// web-v2's overview screen over-fetches at `RECENT_CHANGES_LIMIT * 5` (=60) to
// client-filter by active org (this route isn't org-scoped) — keep this at or
// above that product. Bump both sides together if either changes:
// packages/web-v2/src/features/overview/components/overview-screen.tsx.
export const MAX_LIMIT = 60;

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export const meRecentChangesRoutes = new Hono<{ Variables: AuthVars }>();
meRecentChangesRoutes.use('/recent-changes', requireAuth(), assertEmailVerified());

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

    const response: RecentChangesResponse = { items: await readRecentChanges(visibleIds, limit) };
    return c.json(response);
  },
);
