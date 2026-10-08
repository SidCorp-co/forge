import {
  SHARE_MAX_EXPIRY_DAYS,
  SHARE_SUBJECT_KINDS,
  ShareCreateSchema,
  ShareOpenSchema,
} from '@forge/contracts/shares';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { createShare, listShares, openShare, revokeShare } from './service.js';

const projectParam = z.strictObject({ id: z.uuid() });
const shareParam = z.strictObject({ id: z.uuid(), shareId: z.uuid() });
const CREATE_SHAPE = `invalid body: { subjectKind: ${SHARE_SUBJECT_KINDS.join(' | ')}, subjectId, audience: members | link, expiresInDays?: 1..${SHARE_MAX_EXPIRY_DAYS} (default 7) }`;

/** A share's answers are never cached, never indexed, and never name the page they came from. */
function sealed(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
}

const agencyOf = (agency: AuthVars['agency']) => {
  if (!agency) throw new Error('shares: a request reached its handler without an auth gate');
  return agency;
};

/** Creating, listing and revoking a project's shares, under `/api/projects`. */
export const projectShareRoutes = new Hono<{ Variables: AuthVars }>();
projectShareRoutes.use('/:id/shares', requireAuth(), assertEmailVerified());
projectShareRoutes.use('/:id/shares/*', requireAuth(), assertEmailVerified());

projectShareRoutes.get(
  '/:id/shares',
  zValidator('param', projectParam, invalid('invalid path: /api/projects/<project>/shares')),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    return c.json({ shares: await listShares(projectId) });
  },
);

projectShareRoutes.post(
  '/:id/shares',
  zValidator('param', projectParam, invalid('invalid path: /api/projects/<project>/shares')),
  zValidator('json', ShareCreateSchema, invalid(CREATE_SHAPE)),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const created = await createShare({
      projectId,
      userId,
      agency: agencyOf(c.get('agency')),
      access: await loadProjectAccess(projectId, userId),
      body: c.req.valid('json'),
    });
    sealed(c);
    return c.json(created, 201);
  },
);

projectShareRoutes.post(
  '/:id/shares/:shareId/revoke',
  zValidator(
    'param',
    shareParam,
    invalid('invalid path: /api/projects/<project>/shares/<share id>/revoke'),
  ),
  async (c) => {
    const { id: projectId, shareId } = c.req.valid('param');
    const userId = c.get('userId');
    const share = await revokeShare({
      projectId,
      shareId,
      userId,
      access: await loadProjectAccess(projectId, userId),
    });
    return c.json({ share });
  },
);

const OPEN_SHAPE = 'invalid body: { token: <the share token from its /s/<token> link> }';

/**
 * Opening a share, under `/api/shares`. The token travels in the body, so no path a log or a proxy
 * keeps ever holds it. `open` admits anyone and serves a link share; `open/member` admits a signed-in
 * person and serves a members share to someone who can read its project, as well as a link share.
 */
export const shareOpenRoutes = new Hono<{ Variables: AuthVars }>();
shareOpenRoutes.use(
  '/open',
  rateLimit(() => RULES.shareOpenAddress, { name: 'share-open' }),
);
shareOpenRoutes.use(
  '/open/*',
  rateLimit(() => RULES.shareOpenAddress, { name: 'share-open' }),
);

shareOpenRoutes.post(
  '/open',
  zValidator('json', ShareOpenSchema, invalid(OPEN_SHAPE)),
  async (c) => {
    sealed(c);
    return c.json(await openShare(c.req.valid('json').token, null));
  },
);

shareOpenRoutes.post(
  '/open/member',
  requireAuth(),
  zValidator('json', ShareOpenSchema, invalid(OPEN_SHAPE)),
  async (c) => {
    sealed(c);
    return c.json(await openShare(c.req.valid('json').token, { userId: c.get('userId') }));
  },
);
