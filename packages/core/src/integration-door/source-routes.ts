/**
 * ISS-50 — the project's change requests on its source host over REST, whichever host that is: a
 * GitHub pull request or a GitLab merge request. The forge CLI calls these; core's MCP server
 * carries no delivery tool.
 *
 * What the door does NOT hand back is the point: the host credential is resolved server-side and the
 * call is made from core, through `integrations/source-host/resolve.ts`, so there is no token to
 * fetch and none is returned.
 *
 * NOTHING HERE MERGES. Merging is `POST /api/issues/:id/merge-pull-request`, where the operation that
 * merges also records the merge and the commit it landed at — one writer for one truth. No route here
 * closes a change request or deletes a branch either.
 *
 * `:number` is the number the host shows: a pull request number on GitHub, a merge request IID (the
 * `!12`) on GitLab. Authorization is membership, raised to writer for the four routes that change
 * something on the host; every route but the binding list also asks the binding's `agent_access`.
 *
 * Registered ONTO `integrationsRoutes` for the reason coolify-routes.ts gives.
 */

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { noteReviewOnIssue } from '../comments/index.js';
import { listIntegrations } from '../integrations/index.js';
import {
  OpenedPullRequestIncomplete,
  projectOpenedPullRequest,
  resolveSourceHost,
  type SourceHost,
  SourceHostCallError,
  SourceHostInputRefusal,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { refuser } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';

const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

const numberParamSchema = z.object({ number: z.coerce.number().int().positive() });

const checkLogParamSchema = z.object({ checkRunId: z.coerce.number().int().positive() });

/** `lines` is how many trailing lines to keep: rejected outside 1..1000, never clamped. */
const checkLogQuerySchema = z
  .object({ lines: z.coerce.number().int().min(1).max(1000).optional() })
  .strict();

const commentBodySchema = z.object({ body: z.string().min(1).max(60_000) }).strict();

/** The branch carrying the change, and the branch it lands on. Push the branch with git first. */
const openBodySchema = z
  .object({
    head: z.string().min(1).max(300),
    base: z.string().min(1).max(300),
    title: z.string().min(1).max(500),
    body: z.string().min(1).max(60_000).optional(),
    draft: z.boolean().optional(),
  })
  .strict();

/** Host usernames, and GitHub team slugs: GitLab has no team reviewers and refuses them by name. */
const reviewersBodySchema = z
  .object({
    reviewers: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
    teamReviewers: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
  })
  .strict()
  .refine((b) => b.reviewers || b.teamReviewers, {
    message:
      'name `reviewers` (host usernames) or `teamReviewers` (team slugs) — nobody is guessed',
  });

/** On GitLab APPROVE is an approval plus a note, COMMENT a note; REQUEST_CHANGES is refused by name. */
const reviewBodySchema = z
  .object({
    verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: z.string().min(1).max(60_000),
  })
  .strict();

const can =
  (level: 'project.read' | 'project.write'): MiddlewareHandler<{ Variables: AuthVars }> =>
  async (c, next) => {
    await requireCan(
      actorFor(c.get('userId')),
      level,
      projectResource(c.req.param('projectId') ?? ''),
    );
    await next();
  };

/**
 * The project's source host for an agent, then the call. A binding that is missing, switched off,
 * on another host or not granted to agents is refused by name, and so is the host failing: a retry
 * of HOST_UNAVAILABLE may succeed.
 */
async function onHost<T>(projectId: string, call: (host: SourceHost) => Promise<T>): Promise<T> {
  try {
    return await call(await resolveSourceHost(projectId, 'agent'));
  } catch (err) {
    if (err instanceof SourceHostUnavailable) {
      throw refuse('SOURCE_HOST_UNAVAILABLE', `${err.message} (${err.reason})`);
    }
    if (err instanceof SourceHostInputRefusal)
      throw refuse('SOURCE_HOST_INPUT_REFUSED', err.message);
    if (err instanceof SourceHostCallError) {
      const said = err.detail ? ` The host said: ${err.detail}` : '';
      throw refuse('HOST_UNAVAILABLE', `${err.message}.${said}`);
    }
    throw err;
  }
}

type Routes = Hono<{ Variables: AuthVars }>;

const BASE = '/:projectId/integrations/source';

export function registerSourceRoutes(routes: Routes): void {
  registerSourceReads(routes);
  registerSourceWrites(routes);
}

function registerSourceReads(routes: Routes): void {
  // The bindings with their health and inbound door. It contacts no host and answers the same
  // whether or not agents are granted, so it is where a caller finds out WHY another route refused.
  routes.get(BASE, can('project.read'), async (c) =>
    c.json({ bindings: await listSourceBindings(c.req.param('projectId')) }),
  );
  routes.get(
    `${BASE}/change-requests/:number/diff`,
    can('project.read'),
    zValidator('param', numberParamSchema),
    async (c) => {
      const { number } = c.req.valid('param');
      return c.json(await onHost(c.req.param('projectId'), (host) => host.diff({ number })));
    },
  );
  routes.get(
    `${BASE}/checks/:checkRunId/log`,
    can('project.read'),
    zValidator('param', checkLogParamSchema),
    zValidator('query', checkLogQuerySchema),
    async (c) => {
      const { checkRunId } = c.req.valid('param');
      const { lines } = c.req.valid('query');
      return c.json(
        await onHost(c.req.param('projectId'), (host) =>
          host.checkLog({ checkRunId, ...(lines === undefined ? {} : { lines }) }),
        ),
      );
    },
  );
}

function registerSourceWrites(routes: Routes): void {
  routes.post(
    `${BASE}/change-requests`,
    can('project.write'),
    zValidator('json', openBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const body = c.req.valid('json');
      return c.json(await onHost(projectId, (host) => openAndProject(host, body, projectId)));
    },
  );
  routes.post(
    `${BASE}/change-requests/:number/comments`,
    can('project.write'),
    zValidator('param', numberParamSchema),
    zValidator('json', commentBodySchema),
    async (c) => {
      const { number } = c.req.valid('param');
      const { body } = c.req.valid('json');
      return c.json(
        await onHost(c.req.param('projectId'), (host) => host.comment({ number, body })),
      );
    },
  );
  routes.post(
    `${BASE}/change-requests/:number/reviewers`,
    can('project.write'),
    zValidator('param', numberParamSchema),
    zValidator('json', reviewersBodySchema),
    async (c) => {
      const { number } = c.req.valid('param');
      const { reviewers, teamReviewers } = c.req.valid('json');
      return c.json(
        await onHost(c.req.param('projectId'), (host) =>
          host.requestReview({
            number,
            ...(reviewers ? { reviewers } : {}),
            ...(teamReviewers ? { teamReviewers } : {}),
          }),
        ),
      );
    },
  );
  routes.post(
    `${BASE}/change-requests/:number/reviews`,
    can('project.write'),
    zValidator('param', numberParamSchema),
    zValidator('json', reviewBodySchema),
    async (c) => {
      const projectId = c.req.param('projectId');
      const { number } = c.req.valid('param');
      const body = c.req.valid('json');
      return c.json(
        await onHost(projectId, (host) => submitAndNote(host, { number, ...body }, projectId)),
      );
    },
  );
}

/** Every source host binding's report, from each host provider's own reader. */
async function listSourceBindings(projectId: string): Promise<unknown[]> {
  const readers = listIntegrations().flatMap((d) =>
    d.sourceHost?.listBindings ? [d.sourceHost.listBindings] : [],
  );
  const reports = await Promise.all(readers.map((read) => read(projectId)));
  return reports.flat();
}

/**
 * Open the change request, then record it on Forge's projection of the repository, so the kernel
 * can be asked to merge it later. The write runs AFTER the host created it and its failure is
 * REPORTED rather than thrown: the change request exists by then, and raising would tell the caller
 * the one thing that is certainly false.
 */
async function openAndProject(
  host: SourceHost,
  input: z.infer<typeof openBodySchema>,
  projectId: string,
): Promise<unknown> {
  const opened = await host.openChangeRequest({
    head: input.head,
    base: input.base,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.draft === undefined ? {} : { draft: input.draft }),
  });
  try {
    const projection = await projectOpenedPullRequest({
      projectId,
      bindingId: host.bindingId,
      host: host.provider,
      repository: host.fullName,
      opened,
    });
    return { ...opened, projection };
  } catch (err) {
    const why = err instanceof OpenedPullRequestIncomplete ? err.message : String(err);
    logger.error(
      { projectId, number: opened.number, bindingId: host.bindingId, err },
      'source open-change-request: the change request reached the host and the projection row did not',
    );
    return {
      ...opened,
      projection: {
        outcome: 'not-recorded',
        issueId: null,
        reason: `${why} Do NOT open it again — that would put a second ${host.words.changeRequest} on the repository.`,
      },
    };
  }
}

/**
 * Submit the verdict, then write it onto the Forge issue the head branch names — one record rather
 * than two. The note's failure is reported rather than thrown: the review exists on the host by then.
 */
async function submitAndNote(
  host: SourceHost,
  input: z.infer<typeof reviewBodySchema> & { number: number },
  projectId: string,
): Promise<unknown> {
  const review = await host.submitReview({
    number: input.number,
    event: input.verdict,
    body: input.body,
  });
  const ref = `${review.repository}${host.words.sigil}${review.number}`;
  if (!review.headRef) {
    return {
      ...review,
      issueComment: {
        outcome: 'no-issue',
        reason: `${host.provider} did not report a head branch for ${ref}, so there is nothing to resolve an issue from`,
      },
    };
  }
  try {
    const noted = await noteReviewOnIssue({
      projectId,
      headRef: review.headRef,
      repository: review.repository,
      number: review.number,
      review: {
        id: String(review.reviewId),
        reviewer: review.reviewer,
        state: review.state,
        submittedAt: review.submittedAt,
        url: review.url,
        body: input.body,
      },
    });
    return { ...review, issueComment: noted };
  } catch (err) {
    logger.error(
      { projectId, reviewId: review.reviewId, err },
      'source review: the verdict reached the host and the issue comment did not',
    );
    return {
      ...review,
      issueComment: {
        outcome: 'not-recorded',
        reason:
          `the review was accepted by ${host.provider} as ${review.reviewId} and the comment on the Forge ` +
          `issue could not be written: ${err instanceof Error ? err.message : String(err)}. Do NOT ` +
          `submit the verdict again — that would put a second review on the ${host.words.changeRequest}. ` +
          'Say what you decided in a comment on the issue instead.',
      },
    };
  }
}
