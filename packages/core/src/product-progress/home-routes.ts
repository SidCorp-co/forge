// `GET /api/me/home` and `GET /api/me/home/find` (ISS-919): a person's home across every project
// they read. Each project is read only where the caller holds `project.read` on it, checked per
// project as the attention read does; orgId narrows that set and admits nothing more. It composes
// the reads Forge already serves (feedback with progress, the issue list and standing, the runs,
// the release list) so the browser makes one call, not one per project.

import { inActiveOrg } from '@forge/contracts/org-scope';
import {
  HOME_FIND_LIMIT,
  HOME_MOVING_LIMIT,
  type HomeFindResponse,
  type HomeLiveRelease,
  type HomeResponse,
} from '@forge/contracts/owner-home';
import { Hono } from 'hono';
import { z } from 'zod';
import { withObservedReads } from '../db/observed-reads.js';
import { withQueryLeg } from '../db/query-timing.js';
import { readAcross } from '../db/read-memo.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requiresSelf } from '../permissions/index.js';
import { listVisibleProjectsWithRole } from '../projects/index.js';
import { findIn, rankFound } from './home-find.js';
import { liveOf, liveReleasesOf, releasesOf } from './home-live.js';
import {
  carriersOf,
  type HomeProject,
  type HomeViewer,
  homeItemsOf,
  readHomeProject,
} from './home-moving.js';
import { byLastMove } from './home-stage.js';

/** The projects in scope the caller holds `project.read` on. */
async function readableProjects(userId: string, orgId: string | null): Promise<HomeProject[]> {
  const visible = (await listVisibleProjectsWithRole(userId)).filter((p) => inActiveOrg(p, orgId));
  // each project's access read side by side, as the reads after it are (`db/read-memo.ts:readAcross`)
  const checked = await readAcross(
    visible,
    (p) => p.id,
    async (p) => {
      const access = await effectiveProjectRole(userId, p.id);
      return access && holds(access, 'project.read')
        ? { id: p.id, slug: p.slug, name: p.name }
        : null;
    },
    'home-access',
  );
  return checked.filter((p): p is HomeProject => p !== null);
}

function viewerOf(c: {
  get(key: 'userId'): string;
  get(key: 'agency'): AuthVars['agency'];
}): HomeViewer {
  const agency = c.get('agency');
  if (!agency) throw new Error('me/home: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

const ENV_ORDER = { production: 0, testing: 1 } as const;
const byEnvThenNewest = (one: HomeLiveRelease, other: HomeLiveRelease) =>
  ENV_ORDER[one.environment] - ENV_ORDER[other.environment] || other.at.localeCompare(one.at);

export const meHomeRoutes = new Hono<{ Variables: AuthVars }>();
meHomeRoutes.use('/home', requireAuth(), assertEmailVerified());
meHomeRoutes.use('/home/*', requireAuth(), assertEmailVerified());

meHomeRoutes.get(
  '/home',
  requiresSelf(
    'the caller’s own items and releases over only the projects the caller can read; orgId narrows that set and admits nothing more',
  ),
  zValidator('query', z.strictObject({ orgId: z.uuid().optional() })),
  async (c) => {
    const { orgId } = c.req.valid('query');
    const viewer = viewerOf(c);
    const now = new Date();
    const projects = await withQueryLeg('home-projects', () =>
      readableProjects(viewer.userId, orgId ?? null),
    );
    // every project read side by side, each fact read once for all of them (`db/read-memo.ts:readAcross`),
    // as a person's read: what a platform answered a moment ago, said so (`db/observed-reads.ts`)
    const parts = await withObservedReads(() =>
      readAcross(
        projects,
        (p) => p.id,
        async (p) => {
          const [part, releases] = await Promise.all([
            readHomeProject(viewer, p.id, now),
            withQueryLeg('home-live', () => liveReleasesOf(p.id)),
          ]);
          const mine = new Set([
            ...part.issues.map((i) => i.key),
            ...part.feedback.flatMap(({ s }) => carriersOf(s, part.reads)),
          ]);
          const items = await withQueryLeg('home-items', () => homeItemsOf(p, part, now));
          return { ...items, live: liveOf(p, releases, mine) };
        },
        'home',
      ),
    );
    const moving = parts.flatMap((p) => p.moving).sort(byLastMove);
    const response: HomeResponse = {
      generatedAt: now.toISOString(),
      moving: moving.slice(0, HOME_MOVING_LIMIT),
      movingTotal: moving.length,
      movingTruncated: moving.length > HOME_MOVING_LIMIT,
      // at most two a project (its latest on production and on testing), so it is never cut
      live: parts.flatMap((p) => p.live).sort(byEnvThenNewest),
    };
    return c.json(response);
  },
);

meHomeRoutes.get(
  '/home/find',
  requiresSelf(
    'items of only the projects the caller can read, by key or title word; orgId narrows that set and admits nothing more',
  ),
  zValidator(
    'query',
    z.strictObject({ q: z.string().trim().min(2).max(120), orgId: z.uuid().optional() }),
  ),
  async (c) => {
    const { q, orgId } = c.req.valid('query');
    const viewer = viewerOf(c);
    const projects = await readableProjects(viewer.userId, orgId ?? null);
    const found = await withObservedReads(() =>
      readAcross(
        projects,
        (p) => p.id,
        async (p) => {
          const [part, releases] = await Promise.all([
            readHomeProject(viewer, p.id),
            releasesOf(p.id),
          ]);
          return findIn(p, part, releases, q);
        },
        'home-find',
      ),
    );
    const items = found.flatMap((f) => f.items);
    const total = found.reduce((n, f) => n + f.total, 0);
    const response: HomeFindResponse = {
      q,
      items: rankFound(q, items),
      total,
      truncated: total > HOME_FIND_LIMIT,
    };
    return c.json(response);
  },
);
