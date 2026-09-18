/**
 * Merging a pull request, which is the operation that stamps the issue.
 * ISS-1073, ISS-1062's layer 3.
 *
 * ## Why this is on the dispatch face and not on `forge_github`
 *
 * Everything `agent-ops.ts` carries needs judgement — which diff matters, what a
 * failing log says, what to write in a review. A merge needs none: the decision
 * is made from what GitHub reports (`merge-eligibility.ts`), and the state it
 * moves is the kernel's. So it happens without an agent present, it is recorded
 * whether or not one was, and `agent-ops.ts:KERNEL_VERBS` refuses the word on
 * the other face by name.
 *
 * ## The one thing this file is for
 *
 * `merged_at` was caller-asserted: a run merged with `gh` under a person's
 * account and then, separately, told the tracker it had. Two operations that can
 * disagree — and `gh pr merge` prints its refusal on stdout and exits 0 while
 * printing nothing on a real merge, so a caller checking the exit status was
 * told the opposite of what happened. Here the merge and the stamp are one
 * operation: GitHub's answer IS the evidence, and it is written in a transaction
 * with the projection row that records the same landing.
 *
 * What that cannot be is atomic with GitHub, and this file does not pretend
 * otherwise. Where the transaction fails after GitHub merged, the failure names
 * the commit that landed and the record is repaired by the next reading of it —
 * the `pull_request.closed` delivery, or another call to this verb, which finds
 * the pull request already merged and writes the evidence without sending a
 * second `PUT`.
 */
// cm:guard NOTHING here retries and nothing falls back to another credential. The App is the only identity on this path, which is ISS-1073's outcome 4, and a refusal is the deliverable rather than a step on the way to trying something else. The queue this verb can be reached through retries with 5x exponential backoff (`jobs/queue-name.ts`), which is why the FIRST thing a merge does after resolving its inputs is ask whether GitHub already merged this pull request: a retry then records the evidence instead of merging again.
// cm:edge lockstep -> packages/core/src/integrations/github/adapter.ts — `MERGE_EVENT` is the outbound verb name that reaches this, and the adapter's refusal lists it; a rename here without one there refuses the verb this file serves.

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
// cm:guard this throws rather than writing a delivery row, and it is the only refusal on this path that does. A delivery row is scoped to a binding and says Forge attempted something against a repository; nothing was attempted here, and a row saying otherwise is a history that did not happen.
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
// cm:guard ONE transaction, and its failure is loud. GitHub has already merged by the time this runs, so a rollback leaves a landed pull request with no record of it — which is recoverable, because the `pull_request.closed` delivery and a second call to this verb both write the same evidence idempotently. What is NOT recoverable is a caller told the merge failed, or told it succeeded when the record did not land: the throw names the commit so whoever reads it knows exactly what is on the base branch.
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
// cm:guard emitted AFTER the commit and never inside it. `HooksBus.emit` awaits every subscriber and one of them calls GitHub (docs/proposals/a-tracker-write-waits-on-github.md), so emitting inside would hold a database transaction open across a network call — on the one path where the transaction has already outlived a merge nobody can undo.
// cm:guard the pull request just merged is no longer open, so this does NOT republish the check on it, and that is the honest shape rather than an oversight: what the stamp moved is the contract answer for every OTHER open pull request of the same issue, which is what `openPullRequestsForIssue` returns.
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
  // cm:guard a refusal is `failed` with its sentence, unlike the contract check's deliberate skips: nothing here is a non-merge Forge chose on the operator's behalf. Every one of them is a merge somebody asked for that did not happen, which is a red row they want to see.
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
// cm:why the annotation sits ON the function and not in the file header, where ISS-1073 first put it: `lib/flow-coverage.mjs:fnHitsAt` resolves a step to the tightest function containing its line (or one declared within 5 lines below), so a `cm:flow` above the imports belongs to no function and reads `nofn` — which the gate reports word for word as "no test enters it at all", whatever the integration suite actually walked.
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

  // cm:guard the already-merged arm is decided from the PULL REQUEST ALONE and before the protection
  // and check reads, which is not an optimisation. This arm is the whole of this path's recovery: a
  // merge whose response was lost, or whose transaction failed after GitHub took it, is repaired by
  // calling this verb again. Reading the checks first put that recovery behind two more calls that
  // can time out or hit a rate limit — so an issue holding every piece of evidence it needs went
  // unstamped because a check-runs request for a pull request nobody is going to merge failed.
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

  // cm:guard `already-merged` is unreachable from here — `pull.merged` was answered above — and the
  // arm stays for the compiler rather than being narrowed away, because the decision function is the
  // one place the answer is defined and a caller that stopped handling one of its cases is a caller
  // that will stop handling the next one somebody adds.
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
    // cm:guard the body carries the head sha and the method and NOTHING else. There is no field here that bypasses branch protection — GitHub has none for an App, and an admin's override is a person's credential, which is exactly the identity this layer removed. `sha` is what makes the merge conditional on the head Forge judged: GitHub answers 409 if it moved, rather than landing commits nobody looked at.
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

  // cm:guard the merge TIME is read back from GitHub and is never this box's clock. The `PUT` answers
  // a sha and no timestamp, so `new Date()` was the obvious filler and it is wrong twice: it differs
  // from GitHub's `merged_at` by the round trip and by whatever the clocks disagree by, and the
  // evidence predicate then stops the `pull_request.closed` delivery from ever correcting it. The
  // row would permanently contradict the one thing this whole path promises — that the time on it is
  // the time the merge happened.
  let mergedAt: Date;
  try {
    const after = await readPullRequest(client, row.number);
    const reported = after.mergedAt ? new Date(after.mergedAt) : null;
    if (!reported || Number.isNaN(reported.getTime())) {
      throw new Error(`GitHub reported no \`merged_at\` for #${row.number} after merging it`);
    }
    mergedAt = reported;
  } catch (err) {
    // cm:guard loud, and in the same shape as a failed transaction: the merge HAPPENED, and what
    // could not be established is when. Writing the server clock here to get past it is the silent
    // substitution — it would look identical to a correct record and could never be corrected.
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
