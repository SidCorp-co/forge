import { putWhatsNewDigestRequestSchema, PUT_WHATS_NEW_DIGEST_SHAPE } from '@forge/contracts/whats-new';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { platformProjectId, timeZoneOf, weekOf } from './guards.js';
import { readWhatsNew, readWhatsNewWeek } from './read.js';
import { notPlatformRefusal } from './rules.js';
import { writeWhatsNewDigest } from './service.js';

const feedQuery = zValidator(
  'query',
  z.object({
    since: z.iso.datetime({ offset: true }).optional(),
    tz: z.string().min(1).max(64).optional(),
  }),
  invalid('invalid query: since is an ISO 8601 date-time, tz an IANA time zone'),
);

/** A person's What's new: Forge's own released changes since their last look. */
export const whatsNewRoutes = new Hono<{ Variables: AuthVars }>();

whatsNewRoutes.use('/whats-new', requireAuth());

whatsNewRoutes.get('/whats-new', feedQuery, async (c) => {
  const { since, tz } = c.req.valid('query');
  const timeZone = timeZoneOf(tz);
  return c.json(
    await readWhatsNew({
      projectId: platformProjectId(),
      userId: c.get('userId'),
      since: since ? new Date(since) : undefined,
      timeZone,
      now: new Date(),
    }),
  );
});

const weekParam = zValidator(
  'param',
  z.object({ id: z.uuid(), week: z.string().min(1).max(16) }),
  invalid('invalid path: a project uuid and a week'),
);

function platformOr(c: Context, projectId: string) {
  const refusal = notPlatformRefusal(projectId, platformProjectId());
  return refusal ? refused(c, [refusal], 'WHATS_NEW_REFUSED') : null;
}

/** The platform project's weeks: the entries an agent writes the week's digest over, and the write. */
export const whatsNewProjectRoutes = new Hono<{ Variables: AuthVars }>();

whatsNewProjectRoutes.use('/:id/whats-new/*', requireAuth(), assertEmailVerified());

whatsNewProjectRoutes.get('/:id/whats-new/weeks/:week', weekParam, async (c) => {
  const { id, week } = c.req.valid('param');
  await requireCan(actorFor(c.get('userId')), 'project.read', projectResource(id));
  const other = platformOr(c, id);
  if (other) return other;
  return c.json(await readWhatsNewWeek(id, weekOf(week, new Date())));
});

whatsNewProjectRoutes.put(
  '/:id/whats-new/weeks/:week/digest',
  weekParam,
  strictBody(putWhatsNewDigestRequestSchema, PUT_WHATS_NEW_DIGEST_SHAPE),
  async (c) => {
    const { id, week } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'whats-new.write', projectResource(id));
    const other = platformOr(c, id);
    if (other) return other;
    const agency = c.get('agency');
    if (!agency) throw new Error('whats-new: a request reached its handler without an auth gate');
    const outcome = await writeWhatsNewDigest({
      projectId: id,
      week: weekOf(week, new Date()),
      request: c.req.valid('json'),
      actor: { userId, agency },
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'WHATS_NEW_REFUSED');
    return c.json({ act: outcome.act, digest: outcome.digest });
  },
);
