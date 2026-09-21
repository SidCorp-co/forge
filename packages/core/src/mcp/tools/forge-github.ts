/**
 * ISS-1074 — `forge_github`, the way an agent reads and writes a pull request.
 *
 * ISS-1062's layer 5. Before it, an agent that needed a diff or a failing job's log shelled out to
 * `gh` under a person's account on the runner box, and wrote its verdict into the tracker only —
 * two parallel records of one review that nothing reconciled. The point of the tool is what it does
 * NOT hand back: the App credential is resolved server-side and the GitHub call is made from core,
 * so no session, prompt or MCP server config ever holds it. Same shape as `forge-google-sheets.ts`,
 * for the same reason.
 *
 * The action list and what each one returns live in the `description` below — it is what a model
 * actually reads, and a second copy here is one that goes stale.
 *
 * Authorization is membership-level like `forge_issues`, raised to writer for the four actions that
 * change something on GitHub. On top of that every action but `list` asks the binding's
 * `agent_access`, which is a different question from RBAC: whether a person may drive this project
 * and whether an agent working it may use this integration are two decisions, and ISS-1071 put the
 * second on the binding.
 */

import { z } from 'zod';
import {
  GitHubAgentCallError,
  GitHubAgentRefusal,
  githubAgentBindings,
  githubAgentClient,
} from '../../integrations/github/agent-client.js';
import {
  isKernelVerb,
  kernelVerbRefusal,
  openPullRequest,
  type ReviewEvent,
  readCheckRunLog,
  readPullRequestDiff,
  requestReview,
  submitReview,
  writePullRequestComment,
} from '../../integrations/github/agent-ops.js';
import { GitHubClientError } from '../../integrations/github/client.js';
import {
  OpenedPullRequestIncomplete,
  projectOpenedPullRequest,
} from '../../integrations/github/opened-pull-request.js';
import { noteReviewOnIssue } from '../../integrations/github/review-note.js';
import { logger } from '../../logger.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum([
      'list',
      'diff',
      'check-log',
      'comment',
      'open-pull-request',
      'request-review',
      'review',
    ]),
    projectId: z.uuid().optional(),
    /** The pull request NUMBER as GitHub shows it, never a row id. */
    pullRequest: z.coerce.number().int().positive().optional(),
    /** `check_run.id`, as the projection and the GitHub payload both spell it. */
    checkRunId: z.coerce.number().int().positive().optional(),
    /** check-log: how many trailing lines to keep. Rejected outside 1..1000, never clamped. */
    lines: z.coerce.number().int().min(1).max(1000).optional(),
    body: z.string().min(1).max(60_000).optional(),
    title: z.string().min(1).max(500).optional(),
    /** open-pull-request: the branch carrying the change, and the branch it lands on. */
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

export const forgeGithubTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_github',
  description:
    "Read and write this project's repository as the Forge GitHub App. Actions: list | diff | " +
    'check-log | comment | open-pull-request | request-review | review. ' +
    'MODEL: the credential is a GitHub App held by Forge, never by you — core resolves the ' +
    "project's binding and makes the GitHub call itself, so there is no token to fetch and none is " +
    'returned. Do NOT shell out to `gh`: that runs under whoever configured the box, which is ' +
    "unattributable and unrevocable. Cloning, committing and pushing are still git's job and are " +
    'not here. ' +
    'NOTHING HERE MERGES. Merging a pull request is a kernel transition on the dispatch face, served ' +
    'there as the outbound verb `pull_request.merge`, where the same operation that merges also ' +
    'stamps the issue as landed with the commit it landed at; naming `merge`, `close` or ' +
    '`delete-branch` is refused with that sentence rather than silently doing something near it. ' +
    "list: the project's GitHub bindings — { bindingId, repository, installed, bindingActive, " +
    'connectionActive, agentGranted, lastHealthStatus, connectionProbeStatus, healthDetail, ' +
    'inboundDoor, inboundReading, expectedWebhookUrl, observedWebhookUrl, inboundDeliveries, ' +
    'lastInboundDeliveryAt, turnedAwayRecords, lastRecordedTurnAwayAt, lastTurnedAwayCode }. ' +
    '`lastHealthStatus` is the binding BOTH ways; `connectionProbeStatus` is what the last probe ' +
    'stored on the connection. `inboundDoor` says where the webhook door stands: `open` (something ' +
    'has come through), `silent` (addressed here and nothing ever has), `elsewhere` (GitHub holds a ' +
    'different address — compare `observedWebhookUrl` with `expectedWebhookUrl`), `unaddressed` ' +
    '(no address, or the hook is switched off on GitHub), `unreadable` (GitHub could not be asked), ' +
    '`unaddressable` (this core resolves no public API origin, so it cannot say what URL this ' +
    'binding needs and the address half is unjudged), `not_expected`. Anything but `open` or ' +
    '`not_expected` demotes `lastHealthStatus`, because a binding that receives nothing, or whose ' +
    'address nothing has checked, is not healthy whatever its outbound calls do. ' +
    '`inboundReading` is the sentence saying what that is and what it is NOT: `turnedAwayRecords` ' +
    'counts RECORDS of calls refused at the door, at most one per code per ten minutes, so it is a ' +
    'FLOOR on the calls rather than the calls; those calls are unauthenticated, so ' +
    'nothing here says GitHub sent them; a `silent` door cannot tell "GitHub called somewhere ' +
    'else" from "GitHub did not call", and the reading names the App\'s Recent Deliveries tab ' +
    'as the read that can. It contacts GitHub not ' +
    'at all and answers ' +
    'the same whether or not agents are granted, so it is where you find out WHY another action was ' +
    'refused. An empty array means this project has bound no repository; that is the answer, not an ' +
    'error. ' +
    'diff: { number, repository, bytes, truncated, diff } — the unified diff of one pull request. ' +
    '`bytes` is the size of the WHOLE diff GitHub sent, not of what came back, so `truncated: true` ' +
    'with a large `bytes` means read the files you care about individually rather than reasoning ' +
    'about a fraction. ' +
    'check-log: the log of a failing check run — { checkRunId, name, app, status, conclusion, ' +
    'detailsUrl, summary, log, truncated, refusal }. Pass `checkRunId` (the projection and the ' +
    'GitHub payload both call it that) and optionally `lines` (default 100, 1..1000, REJECTED ' +
    'outside that range rather than clamped). Secret-shaped values are redacted line by line, the ' +
    'App token included. Forge can fetch a log only for a GitHub Actions job: any other check run ' +
    'comes back with `log: null` and a `refusal` naming which app published it and where its own ' +
    'details are, with whatever the check itself published in `summary`. A null log is never an ' +
    'empty one. ' +
    "comment: write on the pull request's conversation — needs `pullRequest` and `body`, returns " +
    '{ commentId, url }. This is the thread, not a line note on the diff. ' +
    'open-pull-request: needs `head`, `base` and `title`, optionally `body` and `draft`; returns ' +
    '{ number, url, title, state, draft, headRef, headSha, baseRef, baseSha, updatedAt } AND ' +
    '`projection`, because what Forge opens Forge records: the same writer a `pull_request` webhook ' +
    'delivery goes through stores the row the merge path resolves on, so the request you just opened ' +
    'is one Forge can be asked to merge. `projection.outcome` is recorded | superseded | ' +
    'not-recorded, with `issueId` naming the Forge issue the head branch resolved to and `reason` ' +
    'saying why there is no row. A `not-recorded` is NOT a failed open — the pull request exists on ' +
    'GitHub either way and opening it again would put a second one there. Push the branch with git ' +
    'first: this opens the pull request, it does not create the branch. ' +
    'request-review: needs `pullRequest` and at least one of `reviewers` (GitHub logins) or ' +
    '`teamReviewers` (team slugs); returns what GitHub now has requested. ' +
    'review: submit a verdict — needs `pullRequest`, `verdict` (APPROVE | REQUEST_CHANGES | ' +
    'COMMENT) and `body`. Returns the review AND `issueComment`, because the verdict is ONE record: ' +
    "the same review is written onto the Forge issue the pull request's head branch names, by the " +
    "same writer that records a human's review arriving by webhook, keyed on GitHub's review id so " +
    'neither path can write it twice. `issueComment.outcome` is written | already-noted | no-issue ' +
    '| no-author. `no-issue` means the head branch names no issue here and is not an error. ' +
    'Refusals name their cause: no GitHub binding on this project, a binding switched off, a ' +
    'binding no agent may use (its agent access is off — an org owner or admin turns it on under ' +
    'Settings → Integrations), the App not installed, and the connection holding no App credential ' +
    'are five different messages. A call that could not act never returns an empty success. ' +
    'Project scope comes from the X-Forge-Project-Slug header (or an explicit projectId). ' +
    'Authorization: project membership; comment, open-pull-request, request-review and review need ' +
    'writer, and every action but list also needs the binding granted to agents.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const named = (args as { action?: unknown } | null)?.action;
    if (typeof named === 'string' && isKernelVerb(named)) {
      throw new Error(`BAD_REQUEST: ${kernelVerbRefusal(named)}`);
    }
    const input = inputSchema.parse(args);
    try {
      return await dispatchAction(input, ctx);
    } catch (err) {
      if (err instanceof GitHubAgentRefusal || err instanceof GitHubClientError) {
        throw new Error(`BAD_REQUEST: ${err.message}`);
      }
      if (err instanceof GitHubAgentCallError) {
        const said = err.detail ? ` GitHub said: ${err.detail}` : '';
        throw new Error(`BAD_REQUEST: ${err.message}.${said}`);
      }
      throw err;
    }
  },
});

async function dispatchAction(input: Input, ctx: McpContext): Promise<unknown> {
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  const { principal } = ctx;

  if (input.action === 'list') {
    await assertPrincipalIsMember(principal, projectId);
    return githubAgentBindings(projectId);
  }

  const reading = input.action === 'diff' || input.action === 'check-log';
  if (reading) await assertPrincipalIsMember(principal, projectId);
  else await assertPrincipalIsWriter(principal, projectId);

  const client = await githubAgentClient(projectId);

  switch (input.action) {
    case 'diff':
      return readPullRequestDiff(client, { number: require$(input, 'pullRequest', 'diff') });

    case 'check-log':
      return readCheckRunLog(client, {
        checkRunId: require$(input, 'checkRunId', 'check-log'),
        ...(input.lines === undefined ? {} : { lines: input.lines }),
      });

    case 'comment':
      return writePullRequestComment(client, {
        number: require$(input, 'pullRequest', 'comment'),
        body: require$(input, 'body', 'comment'),
      });

    case 'open-pull-request':
      return openAndProject(client, input, projectId);

    case 'request-review': {
      const number = require$(input, 'pullRequest', 'request-review');
      if (!input.reviewers?.length && !input.teamReviewers?.length) {
        throw new Error(
          'BAD_REQUEST: request-review needs `reviewers` (GitHub logins) or `teamReviewers` (team slugs), or both — nobody is guessed',
        );
      }
      return requestReview(client, {
        number,
        ...(input.reviewers ? { reviewers: input.reviewers } : {}),
        ...(input.teamReviewers ? { teamReviewers: input.teamReviewers } : {}),
      });
    }

    case 'review':
      return submitAndNote(client, input, projectId);
  }
}

/**
 * Open the pull request, then record it on Forge's projection of the repository.
 *
 * The second half is the one ISS-1123 was about: `repo_pull_requests` was fed only by webhooks, so
 * a pull request Forge itself opened left no row and the merge route refused it by number. The
 * write runs AFTER GitHub has created the request, and its failure is REPORTED rather than thrown,
 * for the same reason `submitAndNote` reports its own: the pull request exists by then, and raising
 * would tell the caller the one thing that is certainly false. A caller that reads `not-recorded`
 * and opens the request again gets a second pull request, which is why the sentence says so.
 */
async function openAndProject(
  client: Awaited<ReturnType<typeof githubAgentClient>>,
  input: Input,
  projectId: string,
): Promise<unknown> {
  const opened = await openPullRequest(client, {
    head: require$(input, 'head', 'open-pull-request'),
    base: require$(input, 'base', 'open-pull-request'),
    title: require$(input, 'title', 'open-pull-request'),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.draft === undefined ? {} : { draft: input.draft }),
  });
  try {
    const projection = await projectOpenedPullRequest({
      projectId,
      bindingId: client.bindingId,
      repository: client.fullName,
      opened,
    });
    return { ...opened, projection };
  } catch (err) {
    const why = err instanceof OpenedPullRequestIncomplete ? err.message : String(err);
    logger.error(
      { projectId, number: opened.number, bindingId: client.bindingId, err },
      'forge_github open-pull-request: the pull request reached GitHub and the projection row did not',
    );
    return {
      ...opened,
      projection: {
        outcome: 'not-recorded',
        issueId: null,
        reason: `${why} Do NOT open it again — that would put a second pull request on the repository.`,
      },
    };
  }
}

/**
 * Submit the verdict, then write it onto the issue — the second half being what makes the review one
 * record rather than two.
 *
 * The note runs AFTER GitHub has accepted the review and its failure is reported rather than thrown.
 * The review exists on GitHub by then; turning a failed tracker write into an error would tell the
 * caller the verdict did not happen, which is the one thing that is certainly false.
 */
async function submitAndNote(
  client: Awaited<ReturnType<typeof githubAgentClient>>,
  input: Input,
  projectId: string,
): Promise<unknown> {
  const review = await submitReview(client, {
    number: require$(input, 'pullRequest', 'review'),
    event: require$(input, 'verdict', 'review') as ReviewEvent,
    body: require$(input, 'body', 'review'),
  });
  if (!review.headRef) {
    return {
      ...review,
      issueComment: {
        outcome: 'no-issue',
        reason: `GitHub did not report a head branch for ${review.repository}#${review.number}, so there is nothing to resolve an issue from`,
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
      'forge_github review: the verdict reached GitHub and the issue comment did not',
    );
    return {
      ...review,
      issueComment: {
        outcome: 'not-recorded',
        reason:
          `the review was accepted by GitHub as ${review.reviewId} and the comment on the Forge ` +
          `issue could not be written: ${err instanceof Error ? err.message : String(err)}. Do NOT ` +
          'submit the verdict again — that would put a second review on the pull request. Say what ' +
          'you decided in a comment on the issue instead.',
      },
    };
  }
}
