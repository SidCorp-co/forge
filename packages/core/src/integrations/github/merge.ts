import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pipelineRuns } from '../../db/schema.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { recordIssueMerge } from '../../issues/merge-record.js';
import { logger } from '../../logger.js';
import { hooks } from '../../pipeline/hooks.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { githubBindingCredential } from './binding-credential.js';
import { buildRepoClient, GitHubClientError, type GitHubRepoClient } from './client.js';
import { decideMerge } from './merge-eligibility.js';
import { readHeadChecks, readProtection, readPullRequest } from './merge-read.js';
import { describeMergeRefusal, type MergeCallRefusal } from './merge-refusal.js';

/** The delivery event every merge, refusal and already-merged reading is logged under. */
export const MERGE_EVENT = 'pull_request.merge';

/** GitHub's three ways of landing a branch. Nothing here invents a fourth. */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface MergeRequest {
  /** The `repo_pull_requests` row to merge. */
  pullRequestId: string;
  /** Who asked. A merge with nobody's name on it is refused before anything is read. */
  requestedBy: string;
  /** The pipeline run this merge belongs to, where there is one. */
  runId?: string | null;
  /** The head the caller believed it was merging. A head that moved is refused, never re-aimed. */
  expectedHeadSha?: string | undefined;
  method?: MergeMethod | undefined;
}

export type MergeOutcome =
  | {
      kind: 'merged';
      deliveryId: string;
      commitSha: string;
      mergedAt: Date;
      /** False where the row already carried this evidence — a second reading of one merge. */
      stamped: boolean;
    }
  | {
      kind: 'already-merged';
      deliveryId: string;
      commitSha: string;
      mergedAt: Date;
      stamped: boolean;
    }
  | { kind: 'refused'; deliveryId: string; reason: string; detail: string };

export class MergeInputError extends Error {}

interface StoredRow {
  id: string;
  projectId: string;
  bindingId: string;
  issueId: string | null;
  number: number;
  state: string;
}

async function storedRow(pullRequestId: string): Promise<StoredRow | null> {
  const [row] = await db
    .select({
      id: repoPullRequests.id,
      projectId: repoPullRequests.projectId,
      bindingId: repoPullRequests.bindingId,
      issueId: repoPullRequests.issueId,
      number: repoPullRequests.number,
      state: repoPullRequests.state,
    })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, pullRequestId))
    .limit(1);
  return row ?? null;
}

/**
 * The caller, checked before anything is read and long before anything is sent.
 *
 * ISS-1073's outcome 4 is that the identity of every merge is the App acting for
 * a NAMED run — so a nameless one is refused, and a run belonging to another
 * project is refused too. Without the second check a caller authorised on one
 * project could hand this verb any run id at all and have it recorded as the
 * authority for a merge on another.
 */
async function assertCaller(req: MergeRequest, projectId: string): Promise<void> {
  if (!req.requestedBy.trim()) {
    throw new MergeInputError(
      'github: a merge needs `requestedBy` — the identity this merge is made for. Forge merges as ' +
        'the App and records who asked; a merge with nobody on it is refused rather than attributed ' +
        'to the App alone.',
    );
  }
  if (!req.runId) return;
  const [run] = await db
    .select({ projectId: pipelineRuns.projectId })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, req.runId))
    .limit(1);
  if (!run) {
    throw new MergeInputError(
      `github: \`runId\` ${req.runId} names no pipeline run, so there is no run this merge is made for`,
    );
  }
  if (run.projectId !== projectId) {
    throw new MergeInputError(
      `github: \`runId\` ${req.runId} belongs to another project than the pull request it was sent with — a merge is authorised by a run on its own project, and Forge will not record one project's run as the authority for another's merge`,
    );
  }
}

/** The evidence write: the issue's stamp and the projection row, together or not at all. */
async function writeEvidence(args: {
  row: StoredRow;
  commitSha: string;
  mergedAt: Date;
}): Promise<{ stamped: boolean }> {
  const { row, commitSha, mergedAt } = args;
  try {
    return await db.transaction(async (tx) => {
      const stamp = row.issueId
        ? await recordIssueMerge(tx, {
            issueId: row.issueId,
            evidence: { kind: 'observed', commitSha, mergedAt, via: 'kernel' },
          })
        : { wrote: false };
      await tx
        .update(repoPullRequests)
        .set({ state: 'merged', mergedAt, mergeCommitSha: commitSha, updatedAt: new Date() })
        .where(eq(repoPullRequests.id, row.id));
      return { stamped: stamp.wrote };
    });
  } catch (err) {
    throw new Error(
      `github: pull request #${row.number} MERGED at ${commitSha}, and recording it failed — ` +
        `the commit is on the base branch and Forge's record of it is not. ` +
        `The \`pull_request.closed\` delivery, or another call to this verb, writes the same ` +
        `evidence without merging again. Underlying failure: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** Republish the contract on this issue's OTHER open pull requests; never inside the transaction. */
async function announce(row: StoredRow): Promise<void> {
  if (!row.issueId) return;
  try {
    await hooks.emit('contractInputChanged', {
      projectId: row.projectId,
      issueId: row.issueId,
      reason: 'merged by the kernel',
    });
  } catch (err) {
    logger.warn({ err, pullRequestId: row.id }, 'merge: announcing the contract change failed');
  }
}

async function refuse(deliveryId: string, reason: string, detail: string): Promise<MergeOutcome> {
  await updateDelivery(deliveryId, {
    status: 'failed',
    errorMessage: detail,
    response: { reason },
    completedAt: new Date(),
  });
  return { kind: 'refused', deliveryId, reason, detail };
}

interface MergeAnswer {
  sha?: string;
  merged?: boolean;
  message?: string;
}

/**
 * Merge one stored pull request as the App, and record the landing.
 *
 * `expectBindingId` is how a caller authorised for ONE binding says so — the
 * same guard `contract-check.ts` carries, and it matters more here: a dispatch
 * holding a context for binding A and a row belonging to binding B would
 * validate A and then MERGE on B's repository.
 */
// the annotation sits ON the function and not in the file header, where ISS-1073 first put it: `lib/flow-coverage.mjs:fnHitsAt` resolves a step to the tightest function containing its line (or one declared within 5 lines below), so a `cm:flow` above the imports belongs to no function and reads `nofn` — which the gate reports word for word as "no test enters it at all", whatever the integration suite actually walked.
// cm:flow release/stamp — the merge is the stamp: one operation writes issues.merged_at, issues.merged_commit_sha and the projection row's merged state
export async function mergeStoredPullRequest(
  req: MergeRequest,
  expectBindingId?: string,
): Promise<MergeOutcome | null> {
  const row = await storedRow(req.pullRequestId);
  if (!row) return null;
  if (expectBindingId !== undefined && row.bindingId !== expectBindingId) {
    throw new GitHubClientError(
      'no_binding',
      `pull request ${req.pullRequestId} is stored under GitHub binding ${row.bindingId}, and this merge was authorised for ${expectBindingId} — Forge will not merge on a repository the caller did not name`,
    );
  }
  await assertCaller(req, row.projectId);

  const deliveryId = await recordDelivery({
    bindingId: row.bindingId,
    direction: 'outbound',
    eventName: MERGE_EVENT,
    payload: {
      pullRequestId: row.id,
      number: row.number,
      issueId: row.issueId,
      requestedBy: req.requestedBy,
      runId: req.runId ?? null,
      expectedHeadSha: req.expectedHeadSha ?? null,
      method: req.method ?? 'merge',
    },
    status: 'pending',
  });

  const credential = await githubBindingCredential(row.bindingId);
  if ('refusal' in credential) return refuse(deliveryId, 'no-credential', credential.refusal);

  let client: GitHubRepoClient;
  try {
    client = buildRepoClient({
      bindingId: row.bindingId,
      config: credential.config,
      secrets: credential.secrets,
    });
  } catch (err) {
    if (err instanceof GitHubClientError) return refuse(deliveryId, err.reason, err.message);
    throw err;
  }

  let pull: Awaited<ReturnType<typeof readPullRequest>>;
  try {
    pull = await readPullRequest(client, row.number);
  } catch (err) {
    const refusal: MergeCallRefusal = describeMergeRefusal(err, row.number);
    return refuse(deliveryId, refusal.cause, refusal.message);
  }

  if (pull.merged) {
    const commitSha = pull.mergeCommitSha;
    const mergedAt = pull.mergedAt ? new Date(pull.mergedAt) : null;
    if (!commitSha || !mergedAt || Number.isNaN(mergedAt.getTime())) {
      return refuse(
        deliveryId,
        'merged-without-evidence',
        `GitHub reports #${row.number} merged but sent no merge commit or no merge time, so there is nothing to record as evidence`,
      );
    }
    const { stamped } = await writeEvidence({ row, commitSha, mergedAt });
    await updateDelivery(deliveryId, {
      status: 'ok',
      response: { alreadyMerged: true, commitSha, stamped },
      completedAt: new Date(),
    });
    if (stamped) await announce(row);
    return { kind: 'already-merged', deliveryId, commitSha, mergedAt, stamped };
  }

  let decision: ReturnType<typeof decideMerge>;
  try {
    const [protection, headChecks] = await Promise.all([
      readProtection(client, pull.baseRef),
      readHeadChecks(client, pull.headSha),
    ]);
    decision = decideMerge({
      pull,
      protection,
      headChecks,
      ...(req.expectedHeadSha ? { expectedHeadSha: req.expectedHeadSha } : {}),
    });
  } catch (err) {
    const refusal: MergeCallRefusal = describeMergeRefusal(err, row.number);
    return refuse(deliveryId, refusal.cause, refusal.message);
  }

  if (decision.kind === 'already-merged') {
    return refuse(
      deliveryId,
      'merged-without-evidence',
      `GitHub reported #${row.number} as not merged and then as merged within one decision — nothing here can say which is true`,
    );
  }
  if (decision.kind === 'refuse') return refuse(deliveryId, decision.reason, decision.detail);

  let answer: MergeAnswer;
  try {
    answer = await client.publish<MergeAnswer>({
      op: 'merge',
      method: 'PUT',
      path: `/repos/${client.owner}/${client.repo}/pulls/${row.number}/merge`,
      body: { sha: pull.headSha, merge_method: req.method ?? 'merge' },
    });
  } catch (err) {
    const refusal = describeMergeRefusal(err, row.number);
    logger.warn(
      { pullRequestId: row.id, cause: refusal.cause, status: refusal.status },
      'merge: GitHub refused',
    );
    return refuse(deliveryId, refusal.cause, refusal.message);
  }

  if (answer.merged !== true || !answer.sha) {
    return refuse(
      deliveryId,
      'merge-not-confirmed',
      `GitHub answered the merge of #${row.number} without confirming it — \`merged: ${String(answer.merged)}\`, \`sha: ${answer.sha ?? 'nothing'}\`${answer.message ? `, message: ${answer.message}` : ''}. Forge records a landing only on GitHub's own confirmation of one.`,
    );
  }

  let mergedAt: Date;
  try {
    const after = await readPullRequest(client, row.number);
    const reported = after.mergedAt ? new Date(after.mergedAt) : null;
    if (!reported || Number.isNaN(reported.getTime())) {
      throw new Error(`GitHub reported no \`merged_at\` for #${row.number} after merging it`);
    }
    mergedAt = reported;
  } catch (err) {
    throw new Error(
      `github: pull request #${row.number} MERGED at ${answer.sha}, and reading back when GitHub ` +
        `merged it failed — the commit is on the base branch and Forge's record of it is not. The ` +
        `\`pull_request.closed\` delivery, or another call to this verb, writes the same evidence ` +
        `without merging again. Underlying failure: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const { stamped } = await writeEvidence({ row, commitSha: answer.sha, mergedAt });
  await updateDelivery(deliveryId, {
    status: 'ok',
    response: { commitSha: answer.sha, requestedBy: req.requestedBy, stamped },
    completedAt: new Date(),
  });
  if (stamped) await announce(row);
  return { kind: 'merged', deliveryId, commitSha: answer.sha, mergedAt, stamped };
}
