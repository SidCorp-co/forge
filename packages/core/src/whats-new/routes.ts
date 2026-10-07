import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { timeZoneOf } from './guards.js';
import { readWhatsNew, readWhatsNewSummary } from './read.js';

const feedQuery = zValidator(
  'query',
  z.object({
    since: z.iso.datetime({ offset: true }).optional(),
    tz: z.string().min(1).max(64).optional(),
  }),
  invalid('invalid query: since is an ISO 8601 date-time, tz an IANA time zone'),
);

/** A person's What's new: Forge's own released changes since their last look, read from this build's changelog. */
export const whatsNewRoutes = new Hono<{ Variables: AuthVars }>();

whatsNewRoutes.use('/whats-new', requireAuth());
whatsNewRoutes.use('/whats-new/summary', requireAuth());

/** The rail's dot on every page load: the unread count, never the entries (the feed is read on open). */
whatsNewRoutes.get('/whats-new/summary', zValidator('query', z.strictObject({})), async (c) =>
  c.json(await readWhatsNewSummary({ userId: c.get('userId'), now: new Date() })),
);

whatsNewRoutes.get('/whats-new', feedQuery, async (c) => {
  const { since, tz } = c.req.valid('query');
  const timeZone = timeZoneOf(tz);
  return c.json(
    await readWhatsNew({
      userId: c.get('userId'),
      since: since ? new Date(since) : undefined,
      timeZone,
      now: new Date(),
    }),
  );
});
