import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requiresSelf } from '../permissions/index.js';
import { readWhatsNew, readWhatsNewSummary } from './read.js';

/** A person's What's new: the release this instance serves, read from the instance's own product project. */
export const whatsNewRoutes = new Hono<{ Variables: AuthVars }>();

whatsNewRoutes.use('/whats-new', requireAuth());
whatsNewRoutes.use('/whats-new/summary', requireAuth());

const OWN_FEED = requiresSelf('what is new for the caller, read by the caller’s own mark');

/** The rail's dot on every page load: whether the serving release is owed, never its page. */
whatsNewRoutes.get(
  '/whats-new/summary',
  OWN_FEED,
  zValidator('query', z.strictObject({})),
  async (c) => c.json(await readWhatsNewSummary({ userId: c.get('userId') })),
);

whatsNewRoutes.get('/whats-new', OWN_FEED, zValidator('query', z.strictObject({})), async (c) =>
  c.json(await readWhatsNew({ userId: c.get('userId') })),
);
