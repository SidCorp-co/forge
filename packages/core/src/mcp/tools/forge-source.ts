/**
 * ISS-50 — `forge_source`, the way an agent reads and writes a change request on the project's
 * source host, whichever host that is: a GitHub pull request or a GitLab merge request.
 *
 * ISS-1074 built it for GitHub as `forge_github`. Before it, an agent that needed a diff or a
 * failing job's log shelled out to `gh` under a person's account and wrote its verdict into the
 * tracker only. The point of the tool is what it does NOT hand back: the host credential is resolved
 * server-side and the call is made from core, through `integrations/source-host/resolve.ts`.
 *
 * The action list and what each one returns live in the `description` below — it is what a model
 * actually reads, and a second copy here is one that goes stale.
 *
 * Authorization is membership-level, raised to writer for the four actions that change something on
 * the host. On top of that every action but `list` asks the binding's `agent_access`.
 */

import { z } from 'zod';
import {
  OpenedPullRequestIncomplete,
  projectOpenedPullRequest,
} from '../../integrations/github/opened-pull-request.js';
import { noteReviewOnIssue } from '../../integrations/github/review-note.js';
import { listIntegrations } from '../../integrations/registry.js';
import {
  SourceHostCallError,
  SourceHostInputRefusal,
  SourceHostUnavailable,
} from '../../integrations/source-host/errors.js';
import { resolveSourceHost } from '../../integrations/source-host/resolve.js';
import type { ReviewEvent, SourceHost } from '../../integrations/source-host/types.js';
import { logger } from '../../logger.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

/**
 * The verbs this face refuses BY NAME rather than by schema. Nothing an agent does through it can
 * merge, and a `z.enum` that merely omitted `merge` would read as a missing verb rather than as the
 * boundary it is.
 */
export const KERNEL_VERBS: ReadonlySet<string> = new Set([
  'merge',
  'merge-pull-request',
  'merge-request-merge',
  'squash',
  'rebase',
  'close',
  'close-pull-request',
  'delete-branch',
]);

export function kernelVerbRefusal(action: string): string {
  return (
    `\`${action}\` is not one of this tool's actions and will not become one. Merging a pull or ` +
    'merge request is a kernel transition on the DISPATCH face, where the same operation that merges ' +
    'also stamps `merged_at` and the commit it landed at — one writer for one truth — so it happens ' +
    'without an agent present and is recorded whether or not one was. It is served there as the ' +
    'outbound verb `pull_request.merge` and as POST /api/issues/:id/merge-pull-request, not here. ' +
    "What this face carries is the judgement: read the diff, read a failing check's log, comment, " +
    'open a change request, request a review, submit a verdict. Opening one does reach a writer, the ' +
    "same one a webhook delivery reaches: it is stored on Forge's projection of the repository as it " +
    'is created, which is what leaves the kernel a change request it can be asked to merge later.'
  );
}

const inputSchema = z
  .object({
    action: z.enum([
      'list',
      'diff',
      'check-log',
      'comment',
      'open-change-request',
      'request-review',
      'review',
    ]),
    projectId: z.uuid().optional(),
    /** The pull request number or merge request iid as the host shows it, never a row id. */
    pullRequest: z.coerce.number().int().positive().optional(),
    /** A GitHub `check_run.id`, or a GitLab CI job id. */
    checkRunId: z.coerce.number().int().positive().optional(),
    /** check-log: how many trailing lines to keep. Rejected outside 1..1000, never clamped. */
    lines: z.coerce.number().int().min(1).max(1000).optional(),
    body: z.string().min(1).max(60_000).optional(),
    title: z.string().min(1).max(500).optional(),
    /** open-change-request: the branch carrying the change, and the branch it lands on. */
    head: z.string().min(1).max(300).optional(),
    base: z.string().min(1).max(300).optional(),
    draft: z.boolean().optional(),
    reviewers: z.array(z.string().min(1).max(100)).max(25).optional(),
    teamReviewers: z.array(z.string().min(1).max(100)).max(25).optional(),
    verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** A field this action cannot be performed without. Refused by name, never guessed. */
function require$<K extends keyof Input>(
  input: Input,
  field: K,
  action: string,
): NonNullable<Input[K]> {
  const value = input[field];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${action} needs \`${String(field)}\``);
  }
  return value as NonNullable<Input[K]>;
}

const GRANTS = {
  byAction: {
    list: 'projects:read',
    diff: 'projects:read',
    'check-log': 'projects:read',
    comment: 'projects:write',
    'open-change-request': 'projects:write',
    'request-review': 'projects:write',
    review: 'projects:write',
  },
} as const;

const DESCRIPTION =
  "Read and write this project's change requests on its source host — a GitHub pull request or a " +
  'GitLab merge request, whichever host the project document declares its repository on. Actions: ' +
  'list | diff | check-log | comment | open-change-request | request-review | review. ' +
  'MODEL: the credential is held by Forge (a GitHub App, or a GitLab access token), never by you — ' +
  "core resolves the project's binding and makes the call itself, so there is no token to fetch and " +
  'none is returned. Do NOT shell out to `gh` or `glab`: that runs under whoever configured the box, ' +
  "which is unattributable and unrevocable. Cloning, committing and pushing are still git's job. " +
  'NOTHING HERE MERGES. Merging is a kernel transition on the dispatch face (the outbound verb ' +
  '`pull_request.merge`, or POST /api/issues/:id/merge-pull-request), where the same operation that ' +
  'merges also stamps the issue as landed with the commit it landed at; naming `merge`, `close` or ' +
  '`delete-branch` is refused with that sentence. ' +
  '`pullRequest` is the number the host shows: a pull request number on GitHub, a merge request IID ' +
  '(the `!12`) on GitLab. ' +
  "list: the project's source host bindings, each with `provider` and what Forge knows of its " +
  'health and inbound webhook door; it contacts no host and answers the same whether or not agents ' +
  'are granted, so it is where you find out WHY another action was refused. An empty array means ' +
  'this project has bound no repository host. ' +
  'diff: { number, repository, bytes, truncated, diff } — the diff of one change request. `bytes` ' +
  'is the size of the WHOLE diff, so `truncated: true` with a large `bytes` means read files ' +
  'individually. ' +
  'check-log: the log of a failing check — { checkRunId, name, app, status, conclusion, detailsUrl, ' +
  'summary, log, truncated, refusal }. `checkRunId` is a GitHub check run id or a GitLab CI job id; ' +
  '`lines` defaults to 100 and is REJECTED outside 1..1000. Secret-shaped values are redacted. A ' +
  'log Forge cannot fetch comes back `log: null` with a `refusal` saying why — never an empty log. ' +
  'comment: needs `pullRequest` and `body`; returns { commentId, url }. ' +
  'open-change-request: needs `head`, `base` and `title`, optionally `body` and `draft`; returns ' +
  '{ number, url, title, state, draft, headRef, headSha, baseRef, baseSha, updatedAt } AND ' +
  '`projection` (recorded | superseded | not-recorded) — what Forge opens it records on its ' +
  'projection, so it can be asked to merge it later. A `not-recorded` is NOT a failed open; opening ' +
  'again makes a second one. Push the branch with git first. ' +
  'request-review: needs `pullRequest` and `reviewers` (host usernames) and/or `teamReviewers` ' +
  '(GitHub team slugs; GitLab has no team reviewers and refuses them by name). ' +
  'review: needs `pullRequest`, `verdict` (APPROVE | REQUEST_CHANGES | COMMENT) and `body`. On ' +
  'GitLab APPROVE is an approval plus a note, COMMENT a note, and REQUEST_CHANGES is refused by name ' +
  '(GitLab REST has no such verdict). Returns the review AND `issueComment`: the verdict is written ' +
  'onto the Forge issue the head branch names, once. ' +
  'Refusals name their cause: no source host binding, a binding on another host than the declared ' +
  'repository, a binding switched off, a binding no agent may use, and a missing credential are ' +
  'different messages. Project scope comes from the X-Forge-Project-Slug header (or projectId). ' +
  'Authorization: project membership; comment, open-change-request, request-review and review need ' +
  'writer, and every action but list also needs the binding granted to agents.';

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const named = (args as { action?: unknown } | null)?.action;
  if (typeof named === 'string' && KERNEL_VERBS.has(named)) {
    throw new Error(`BAD_REQUEST: ${kernelVerbRefusal(named)}`);
  }
  const input = inputSchema.parse(args);
  try {
    return await dispatchAction(input, ctx);
  } catch (err) {
    if (err instanceof SourceHostUnavailable || err instanceof SourceHostInputRefusal) {
      throw new Error(`BAD_REQUEST: ${err.message}`);
    }
    if (err instanceof SourceHostCallError) {
      const said = err.detail ? ` The host said: ${err.detail}` : '';
      throw new Error(`BAD_REQUEST: ${err.message}.${said}`);
    }
    throw err;
  }
}

export const forgeSourceTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_source',
  reach: 'project',
  route: '/api/projects',
  grant: GRANTS,
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});

/** Every source host binding's report, from each host provider's own reader. */
async function listSourceBindings(projectId: string): Promise<unknown[]> {
  const readers = listIntegrations().flatMap((d) =>
    d.sourceHost?.listBindings ? [d.sourceHost.listBindings] : [],
  );
  const reports = await Promise.all(readers.map((read) => read(projectId)));
  return reports.flat();
}

async function dispatchAction(input: Input, ctx: McpContext): Promise<unknown> {
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const { principal } = ctx;

  if (input.action === 'list') {
    await assertPrincipalIsMember(principal, projectId);
    return listSourceBindings(projectId);
  }

  const reading = input.action === 'diff' || input.action === 'check-log';
  if (reading) await assertPrincipalIsMember(principal, projectId);
  else await assertPrincipalIsWriter(principal, projectId);

  const host = await resolveSourceHost(projectId, 'agent');

  switch (input.action) {
    case 'diff':
      return host.diff({ number: require$(input, 'pullRequest', 'diff') });

    case 'check-log':
      return host.checkLog({
        checkRunId: require$(input, 'checkRunId', 'check-log'),
        ...(input.lines === undefined ? {} : { lines: input.lines }),
      });

    case 'comment':
      return host.comment({
        number: require$(input, 'pullRequest', 'comment'),
        body: require$(input, 'body', 'comment'),
      });

    case 'open-change-request':
      return openAndProject(host, input, projectId);

    case 'request-review': {
      const number = require$(input, 'pullRequest', 'request-review');
      if (!input.reviewers?.length && !input.teamReviewers?.length) {
        throw new Error(
          'BAD_REQUEST: request-review needs `reviewers` (host usernames) or `teamReviewers` (team slugs), or both — nobody is guessed',
        );
      }
      return host.requestReview({
        number,
        ...(input.reviewers ? { reviewers: input.reviewers } : {}),
        ...(input.teamReviewers ? { teamReviewers: input.teamReviewers } : {}),
      });
    }

    case 'review':
      return submitAndNote(host, input, projectId);
  }
}

/**
 * Open the change request, then record it on Forge's projection of the repository. The write runs
 * AFTER the host created it and its failure is REPORTED rather than thrown: the change request exists
 * by then, and raising would tell the caller the one thing that is certainly false.
 */
async function openAndProject(host: SourceHost, input: Input, projectId: string): Promise<unknown> {
  const opened = await host.openChangeRequest({
    head: require$(input, 'head', 'open-change-request'),
    base: require$(input, 'base', 'open-change-request'),
    title: require$(input, 'title', 'open-change-request'),
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
      'forge_source open-change-request: the change request reached the host and the projection row did not',
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
 * Submit the verdict, then write it onto the issue — one record rather than two. The note's failure
 * is reported rather than thrown: the review exists on the host by then.
 */
async function submitAndNote(host: SourceHost, input: Input, projectId: string): Promise<unknown> {
  const review = await host.submitReview({
    number: require$(input, 'pullRequest', 'review'),
    event: require$(input, 'verdict', 'review') as ReviewEvent,
    body: require$(input, 'body', 'review'),
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
        body: input.body ?? null,
      },
    });
    return { ...review, issueComment: noted };
  } catch (err) {
    logger.error(
      { projectId, reviewId: review.reviewId, err },
      'forge_source review: the verdict reached the host and the issue comment did not',
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
