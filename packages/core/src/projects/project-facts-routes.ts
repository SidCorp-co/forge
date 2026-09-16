import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AuthVars } from '../middleware/auth.js';
import {
  RETIRED_PROJECT_FACTS_CONFIG_MESSAGE,
  RETIRED_PROJECT_FACTS_MESSAGE,
} from './project-facts.js';

// ISS-1048 — the retired door to the retired store.
//
// `agentConfig.projectFacts` and `agentConfig.projectFactsConfig` were this
// route's whole subject, and migration 0254 moved every key of both into
// `knowledge_entries`. The route stays as a refusal rather than being deleted
// because deleting it answers the same caller with a routing 404, which says
// "no such project" rather than "that store moved, and here is where" — and
// `forge-plugin`'s `forge project-settings` tool calls both verbs by hand.
//
// Both verbs answer 410, with the message naming what to call instead. A GET
// refusing is deliberate: a reader handed an empty map would conclude the
// project declares nothing.

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const gone = () =>
  new HTTPException(410, {
    message: `${RETIRED_PROJECT_FACTS_MESSAGE} ${RETIRED_PROJECT_FACTS_CONFIG_MESSAGE} Read this project's prose with GET /api/projects/:id/knowledge, one entry with GET /api/projects/:id/knowledge/:slug, and write one with PUT /api/projects/:id/knowledge/:slug.`,
    cause: { code: 'PROJECT_FACTS_RETIRED' },
  });

// cm:guard add NO middleware here: this router is mounted under `projectRoutes`, which already applies `requireAuth()` + `assertEmailVerified()` to every request, so a second copy runs auth and its email-verified DB lookup twice per call.
export const projectFactsRoutes = new Hono<{ Variables: AuthVars }>();

const param = zValidator('param', idParamSchema, (result) => {
  if (!result.success) throw badRequest(z.flattenError(result.error));
});

projectFactsRoutes.get('/:id/project-facts', param, () => {
  throw gone();
});

projectFactsRoutes.patch('/:id/project-facts', param, () => {
  throw gone();
});
