/**
 * Steps 7 and 8: the build's outcome, and what GitHub holds for the tag.
 *
 * The build reaches Forge on a `workflow_run` delivery through the projection
 * door `projection-events.ts` owns, and Forge asks GitHub nothing about a build
 * it is waiting on — no poll, no status read, no timer against the Actions API
 * (ISS-1075 point 2).
 *
 * The correlation contract has four terms and no fallback: the delivery's own
 * binding, the workflow's path, the tag in `head_branch`, and a run that has
 * completed. There is deliberately no match on `head_sha` — see the guard on
 * `attribute` for what a commit cannot say.
 */

import { logger } from '../../logger.js';
import { buildRepoClient, GitHubClientError, type GitHubRepoClient } from './client.js';
import type { DeliveryContext } from './projection-events.js';
import {
  isRunnerReleaseTag,
  judgePublication,
  RUNNER_RELEASE_WORKFLOW_PATH,
  repositoryTruth,
} from './runner-release-preflight.js';
import { RunnerReleaseRepoError, readReleaseForTag } from './runner-release-repo.js';
import {
  appendReading,
  findByBindingAndTag,
  inFlightAtCommit,
  type RunnerReleaseRow,
  settleFailed,
  settlePublished,
} from './runner-release-store.js';

/** What a `workflow_run` delivery carries, of the fields this arm reads. */
export interface WorkflowRunPayload {
  action?: string;
  repository?: { full_name?: string };
  workflow_run?: {
    id?: number;
    name?: string;
    path?: string;
    head_branch?: string | null;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string;
    event?: string;
  };
}

type Reading = { publication: 'absent' | 'incomplete' | 'published' | 'unknown'; detail: string };

/** The release's publication state, read rather than inferred. Never throws. */
async function readPublication(
  ctx: DeliveryContext,
  tag: string,
): Promise<
  Reading & {
    releaseUrl: string | null;
  }
> {
  let client: GitHubRepoClient;
  try {
    client = buildRepoClient({
      bindingId: ctx.bindingId,
      config: ctx.config,
      secrets: ctx.secrets,
    });
  } catch (err) {
    if (!(err instanceof GitHubClientError)) throw err;
    return { publication: 'unknown', detail: err.message, releaseUrl: null };
  }
  try {
    const release = await readReleaseForTag(client, tag);
    const judged = judgePublication(release);
    return { ...judged, releaseUrl: release?.htmlUrl ?? null };
  } catch (err) {
    if (!(err instanceof RunnerReleaseRepoError)) throw err;
    // cm:guard a reading that could not be taken is `unknown` and never `absent`. They are the same row to a careless reader and opposite things to an operator: one says nothing was published, the other says nobody knows, and only the first is a reason to cut again.
    return { publication: 'unknown', detail: err.refusal.message, releaseUrl: null };
  }
}

// cm:guard the tag is the ONLY term that names which release a build belongs to, and there is no fall back to `head_sha` on purpose: a commit does not name a tag, two `runner-v*` tags can point at one commit, and picking between them settles somebody else's release with this one's readings. A delivery carrying no usable tag is written down as unattributed and settles nothing.
async function attribute(
  ctx: DeliveryContext,
  run: NonNullable<WorkflowRunPayload['workflow_run']>,
  repository: string | null,
): Promise<RunnerReleaseRow | null> {
  const tag = run.head_branch ?? '';
  if (!isRunnerReleaseTag(tag)) {
    const stranded = run.head_sha ? await inFlightAtCommit(ctx.bindingId, run.head_sha) : [];
    for (const row of stranded) {
      await appendReading(
        row.id,
        row.attempt,
        `await_build: a ${RUNNER_RELEASE_WORKFLOW_PATH} run completed at ${run.head_sha} (${run.html_url ?? 'no url'}) naming no runner-v* tag, so it was not attributed to this release`,
      );
    }
    logger.error(
      { bindingId: ctx.bindingId, headSha: run.head_sha, headBranch: run.head_branch },
      'runner-release: a release build completed naming no runner-v* tag, so nothing was settled',
    );
    return null;
  }
  const row = await findByBindingAndTag(ctx.bindingId, tag);
  if (!row) {
    logger.info(
      { bindingId: ctx.bindingId, tag },
      'runner-release: a build completed for a tag Forge did not cut',
    );
    return null;
  }
  // cm:guard the repository is one of the four terms and it is compared UNCONDITIONALLY, so a delivery that carries no `repository.full_name` fails the term rather than skipping it. Making the comparison conditional on the field being present is how a payload with the field missing settles a release on three terms — and the shape of a delivery is GitHub's to change, not ours to assume.
  if (row.repository !== repository) {
    logger.error(
      { releaseId: row.id, tag, delivered: repository, held: row.repository },
      "runner-release: the delivery does not name this release's repository, so nothing was settled",
    );
    return null;
  }
  return validate(row, run, tag);
}

/**
 * The two terms that are NOT attribution: they say whether the build the tag
 * matched is this release's own.
 *
 * A tag names a release; it does not prove the build that ran for it is the one
 * this release cut. Between Forge reading the tag absent and cutting it,
 * somebody else can cut the same tag at a different commit, and that build's
 * completion matches on repository, workflow, tag and status alike. Settling on
 * it would record this release published over a commit it never cut — the row
 * saying `commit_sha = A` while everything it reports came from B.
 *
 * This is the opposite of matching by commit: a delivery is still FOUND by its
 * tag and only its tag, and one carrying no `runner-v*` tag settles nothing
 * (criteria 10 and 11). These terms only reject.
 */
// cm:guard `head_sha` appears here and NOWHERE in the lookup. Moving it into `attribute` to find a row would be the fallback criterion 10 refuses — two `runner-v*` tags can point at one commit and picking between them settles the wrong release. Rejecting on it is safe for the same reason it is unsafe to select on: a commit that disagrees is positive evidence, a commit that agrees names nothing.
function validate(
  row: RunnerReleaseRow,
  run: NonNullable<WorkflowRunPayload['workflow_run']>,
  tag: string,
): RunnerReleaseRow | null {
  if (row.step !== 'cut_tag' && row.step !== 'await_build') {
    logger.error(
      { releaseId: row.id, tag, step: row.step },
      'runner-release: a build completed for a tag this release had not cut, so nothing was settled',
    );
    return null;
  }
  if (!row.commitSha || run.head_sha !== row.commitSha) {
    logger.error(
      { releaseId: row.id, tag, delivered: run.head_sha, held: row.commitSha },
      'runner-release: the build ran at a different commit from the one this release cut, so nothing was settled',
    );
    return null;
  }
  return row;
}

/** Settle one release from its build and the publication reading beside it. */
async function settle(
  ctx: DeliveryContext,
  row: RunnerReleaseRow,
  run: NonNullable<WorkflowRunPayload['workflow_run']>,
): Promise<number> {
  const workflowRunId = String(run.id ?? '');
  const workflowUrl = run.html_url ?? null;
  const conclusion = run.conclusion ?? 'unreported';
  const at = new Date();
  const read = await readPublication(ctx, row.tag);

  if (conclusion === 'success' && read.publication === 'published') {
    const moved = await settlePublished(row.id, row.attempt, {
      publicationDetail: read.detail,
      buildConclusion: conclusion,
      workflowRunId,
      workflowUrl,
      releaseUrl: read.releaseUrl,
      buildReportedAt: at,
    });
    if (moved) await appendReading(row.id, row.attempt, `confirm_release: ${read.detail}`);
    return moved ? 1 : 0;
  }

  // cm:guard the lead says what the BUILD did and the truth says what the REPOSITORY holds, and they are two readings rather than one sentence: a failed build over a release that exists anyway, and a successful build over a draft nothing will ingest, are both states this path meets and neither is derivable from the conclusion.
  const lead =
    conclusion === 'success'
      ? `The build for \`${row.tag}\` succeeded (${workflowUrl ?? 'no url'}), and the release it should have produced is not whole.`
      : `The build for \`${row.tag}\` concluded \`${conclusion}\` (${workflowUrl ?? 'no url'}).`;
  const failure = `${lead} ${repositoryTruth({
    tag: row.tag,
    commitSha: row.commitSha,
    tagCommitSha: row.tagCommitSha,
    tagState: 'present',
    publication: read.publication,
    publicationDetail: read.detail,
  })}`;
  const moved = await settleFailed(row.id, row.attempt, {
    step: conclusion === 'success' ? 'confirm_release' : 'await_build',
    failure,
    tagState: 'present',
    publication: read.publication,
    publicationDetail: read.detail,
    buildConclusion: conclusion,
    workflowRunId,
    ...(workflowUrl ? { workflowUrl } : {}),
    ...(read.releaseUrl ? { releaseUrl: read.releaseUrl } : {}),
    buildReportedAt: at,
  });
  if (moved)
    await appendReading(row.id, row.attempt, `await_build: ${conclusion} — ${read.detail}`);
  return moved ? 1 : 0;
}

/**
 * Apply one `workflow_run` delivery, and report how many releases it moved.
 */
export async function applyWorkflowRunEvent(
  ctx: DeliveryContext,
  payload: WorkflowRunPayload,
): Promise<number> {
  const run = payload.workflow_run;
  if (!run) return 0;
  // cm:guard the workflow is matched on its PATH and not on its name: the path is the file this repository owns and a rename of it is a change to the same commit this constant lives in, whereas `name:` is a display string anybody may edit without touching core. Matching on neither is how every workflow's completion reaches this arm.
  if (run.path !== RUNNER_RELEASE_WORKFLOW_PATH) return 0;
  if (payload.action !== 'completed' || run.status !== 'completed') return 0;

  const row = await attribute(ctx, run, payload.repository?.full_name ?? null);
  if (!row) return 0;
  // cm:guard the short circuit is a convenience and NOT the guarantee: `settlePublished` and `settleFailed` are both conditional on `settled_at IS NULL`, which is what makes two deliveries landing milliseconds apart settle once. Reading this as the defence and relaxing the statements is how a re-delivery overwrites a verdict.
  if (row.settledAt !== null) {
    logger.info(
      { releaseId: row.id, tag: row.tag, workflowRunId: run.id },
      'runner-release: a build was reported for a release already settled, so nothing was written',
    );
    return 0;
  }
  return settle(ctx, row, run);
}
