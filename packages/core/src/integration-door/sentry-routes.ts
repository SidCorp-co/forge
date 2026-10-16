/**
 * The project's Sentry error stream over REST — the door an agent on the forge CLI asks what the
 * product it is building is erroring on. Core's MCP server carries no delivery tool.
 *
 * Read-only by construction: two GETs, and the adapter's status-write call is not imported here. A
 * door that can resolve a Sentry issue is one that can hide a live defect. It files nothing in the
 * tracker either; that is the scheduled `sentry_pull` intake, which applies event and user
 * thresholds a read does not.
 *
 * The credential is the Sentry connection Forge holds: nothing here accepts a Sentry host,
 * organization or token.
 *
 * Reaching Sentry is answered as a value: `{ ok: false, refusal: { reason, message, bindingId,
 * httpStatus } }` with NO `issues` key, so an empty `issues` only ever means Sentry returned none,
 * and a caller switches on `reason` (no_binding, not_granted, credential_rejected, target_ambiguous,
 * confined_out, …) because each sends whoever met it somewhere different. Everything before that —
 * a malformed query, a caller holding no role — is the ordinary refusal envelope, so an
 * authorization refusal is never read as a Sentry condition.
 *
 * Registered ONTO `integrationsRoutes` for the reason coolify-routes.ts gives.
 */

import { SENTRY_AGENT_STATUSES } from '@forge/contracts/integrations';
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  isSentryRefusal,
  readProjectSentryIssue,
  readProjectSentryIssues,
  SENTRY_LIST_MAX_LIMIT,
  type SentryAgentListRequest,
} from '../integrations/sentry/index.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

/** Which declared Sentry target to read; required where the binding declares more than one. */
const targetSchema = z.string().min(1).max(200).optional();

/**
 * Every filter is optional and ANDed. `release` is the source commit core tags every event with;
 * `window` is a relative Sentry period (1h, 24h, 7d, up to 90d) and one Sentry does not take is
 * refused, never replaced by the default; `status` is unresolved by default and `any` drops the
 * term; `query` is raw Sentry search syntax ADDED to the filters.
 */
const listQuerySchema = z
  .object({
    target: targetSchema,
    status: z.enum(SENTRY_AGENT_STATUSES).optional(),
    release: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(500).optional(),
    method: z.string().min(1).max(20).optional(),
    errorCode: z.string().min(1).max(200).optional(),
    requestId: z.string().min(1).max(200).optional(),
    window: z.string().min(1).max(20).optional(),
    query: z.string().min(1).max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(SENTRY_LIST_MAX_LIMIT).optional(),
  })
  .strict();

const getParamSchema = z.object({ issueId: z.string().min(1).max(200) });
const getQuerySchema = z.object({ target: targetSchema }).strict();

const projectMember: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await requireCan(
    actorFor(c.get('userId')),
    'project.read',
    projectResource(c.req.param('projectId') ?? ''),
  );
  await next();
};

/** A Sentry read, or the refusal that says why Sentry could not be read for this project. */
async function sentryAnswer(read: () => Promise<Record<string, unknown>>) {
  try {
    return { ok: true, ...(await read()) };
  } catch (err) {
    if (!isSentryRefusal(err)) throw err;
    return {
      ok: false,
      refusal: {
        reason: err.reason,
        message: err.message,
        bindingId: err.bindingId,
        httpStatus: err.httpStatus,
      },
    };
  }
}

type Routes = Hono<{ Variables: AuthVars }>;

export function registerSentryRoutes(routes: Routes): void {
  // { ok, target, organizationSlug, projectSlug, query, window, issues[], refused[], pages,
  // truncated }. `refused` on a success is the per-issue confinement list, reported not dropped.
  routes.get(
    '/:projectId/integrations/sentry/issues',
    projectMember,
    zValidator('query', listQuerySchema),
    async (c) => {
      const request = listRequest(c.req.valid('query'), c.req.param('projectId'));
      return c.json(
        await sentryAnswer(async () => ({ ...(await readProjectSentryIssues(request)) })),
      );
    },
  );
  // One issue by the id or short id the list gave; one of another project is refused, not shown.
  routes.get(
    '/:projectId/integrations/sentry/issues/:issueId',
    projectMember,
    zValidator('param', getParamSchema),
    zValidator('query', getQuerySchema),
    async (c) => {
      const { issueId } = c.req.valid('param');
      const { target } = c.req.valid('query');
      const projectId = c.req.param('projectId');
      return c.json(
        await sentryAnswer(async () => ({
          issue: await readProjectSentryIssue({
            projectId,
            issueId,
            ...(target ? { target } : {}),
          }),
        })),
      );
    },
  );
}

/**
 * The filters the caller actually passed, as a listing request — built key by key, because
 * `exactOptionalPropertyTypes` tells an absent filter from one explicitly set to undefined.
 */
function listRequest(input: z.infer<typeof listQuerySchema>, projectId: string) {
  const request: SentryAgentListRequest = { projectId };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) Object.assign(request, { [key]: value });
  }
  return request;
}
