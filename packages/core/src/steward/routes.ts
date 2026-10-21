// The steward's two doors (REQ-48 BC-1, BC-12): an item's runs, and the undo of one act, which calls
// that act's inverse door with the asking person's own credential.

import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { undoAct } from './acts-store.js';
import { readStewardRuns } from './read.js';

export const stewardRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/steward-runs', '/:id/steward-acts/*']) {
  stewardRoutes.use(path, requireAuth(), assertEmailVerified());
}

const runsQuery = zValidator(
  'query',
  z.strictObject({ subject: z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/) }),
  invalid('the item is named by its key: `?subject=REQ-n`, `FB-n` or an issue key like `ISS-n`'),
);

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const actParam = zValidator(
  'param',
  z.object({ id: z.uuid(), actId: z.uuid() }),
  invalid('invalid path: a project uuid and a steward act uuid'),
);

stewardRoutes.get('/:id/steward-runs', projectParam, runsQuery, async (c) =>
  c.json(
    await readStewardRuns({
      projectId: c.req.valid('param').id,
      userId: c.get('userId'),
      subjectKey: c.req.valid('query').subject,
    }),
  ),
);

/** The credential the request arrived with, forwarded so the inverse door checks the person's own access. */
function credentialOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['authorization', 'cookie']) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

stewardRoutes.post('/:id/steward-acts/:actId/undo', actParam, async (c) => {
  const { id, actId } = c.req.valid('param');
  const outcome = await undoAct({
    projectId: id,
    actId,
    userId: c.get('userId'),
    credential: credentialOf(c.req.raw.headers),
  });
  if (!outcome.ok) {
    // the inverse door refused: answered as it answered, so its refusal names what was wrong
    return c.body(outcome.answer.text, outcome.answer.status as ContentfulStatusCode, {
      'content-type': 'application/json',
    });
  }
  return c.json({ act: outcome.act, undone: outcome.undone });
});
