import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { forgeReads, recordDelivery, updateDelivery } from '../index.js';
import { SourceHostUnavailable } from './errors.js';
import { readMergedHead } from './merged-head.js';
import { markPullRequestMerged } from './projection.js';
import { projectChecksAfterMerge } from './read-projection.js';
import { issuesOfPullRequest } from './repo-projection.js';
import { sourceHostForBinding } from './resolve.js';
import type { SourceHost } from './types.js';

/** The delivery event every merge, refusal and already-merged reading is logged under. */
const MERGE_EVENT = 'pull_request.merge';

/** Every merge method any host has. A host that lacks one refuses it by name (`words.mergeMethods`). */
export const CHANGE_REQUEST_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
type ChangeRequestMergeMethod = (typeof CHANGE_REQUEST_MERGE_METHODS)[number];

/**
 * Writes the issue's merge stamp in the transaction that marks the projection row, and answers whether
 * it wrote — or why the commit was refused as this issue's landing, which the caller records on the
 * issue. Supplied by the caller, which owns the stamp; the adapter owns only the row.
 */
export type IssueMergeStamp = (
  tx: Tx,
  args: {
    /** The stored request Forge merged, whose links named the issue. */
    pullRequestId: string;
    issueId: string;
    commitSha: string;
    mergedAt: Date;
    target: string;
    /** The request's head and whether its tree is the landing's, read from the host at the merge. */
    head: MergedHead | null;
  },
) => Promise<{ wrote: boolean; refused?: { code: string; detail: string } | null }>;

/** An issue the merged request links whose stamp was refused, and why. */
interface RefusedStamp {
  issueId: string;
  code: string;
  detail: string;
}

interface MergeRequest {
  /** The `repo_pull_requests` row to merge. */
  pullRequestId: string;
  /** Who asked. A merge with nobody's name on it is refused before anything is read. */
  requestedBy: string;
  /** The pipeline run this merge belongs to, where there is one. */
  runId?: string | null;
  /** The head the caller believed it was merging. A head that moved is refused, never re-aimed. */
  expectedHeadSha?: string | undefined;
  method?: ChangeRequestMergeMethod | undefined;
}

/** The checks on the merged request's head, read once it landed, or why they were not. */
type MergeChecks = Awaited<ReturnType<typeof projectChecksAfterMerge>>;

type MergeOutcome =
  | {
      kind: 'merged';
      deliveryId: string;
      commitSha: string;
      mergedAt: Date;
      /** The branch the host merged into, which every stamped issue records as its target. */
      target: string;
      /** False where the row already carried this evidence — a second reading of one merge. */
      stamped: boolean;
      /** Every issue this merge stamped: each one the request delivers (REQ-63 BC-4). */
      stampedIssues: string[];
      /** Every linked issue the commit is not the landing of, refused rather than stamped. */
      refusedStamps: RefusedStamp[];
      checks: MergeChecks;
    }
  | {
      kind: 'already-merged';
      deliveryId: string;
      commitSha: string;
      mergedAt: Date;
      target: string;
      stamped: boolean;
      stampedIssues: string[];
      refusedStamps: RefusedStamp[];
      checks: MergeChecks;
    }
  | { kind: 'refused'; deliveryId: string; reason: string; detail: string };

/** The caller-input faults a merge refuses before anything is read; the route answers each by name. */
export type MergeInputCode =
  | 'MERGE_REQUESTER_MISSING'
  | 'MERGE_RUN_NOT_FOUND'
  | 'MERGE_RUN_OF_ANOTHER_PROJECT';

export class MergeInputError extends Error {
  constructor(
    readonly code: MergeInputCode,
    message: string,
  ) {
    super(message);
    this.name = 'MergeInputError';
  }
}

interface StoredRow {
  id: string;
  projectId: string;
  bindingId: string;
  /** Every issue the request delivers (REQ-63 BC-4); its merge stamps each. */
  issueIds: string[];
  number: number;
  state: string;
  headSha: string;
}

async function storedRow(pullRequestId: string): Promise<StoredRow | null> {
  const [row] = await db
    .select({
      id: repoPullRequests.id,
      projectId: repoPullRequests.projectId,
      bindingId: repoPullRequests.bindingId,
      number: repoPullRequests.number,
      state: repoPullRequests.state,
      headSha: repoPullRequests.headSha,
    })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, pullRequestId))
    .limit(1);
  if (!row) return null;
  return { ...row, issueIds: await issuesOfPullRequest(row.id) };
}

/**
 * The caller, checked before anything is read and long before anything is sent: a nameless merge is
 * refused, and so is a run belonging to another project — otherwise a caller authorised on one
 * project could hand any run id over and have it recorded as the authority for a merge on another.
 */
async function assertCaller(req: MergeRequest, projectId: string): Promise<void> {
  if (!req.requestedBy.trim()) {
    throw new MergeInputError(
      'MERGE_REQUESTER_MISSING',
      'merge: a merge needs `requestedBy` — the identity this merge is made for. Forge merges as ' +
        'its own credential and records who asked; a merge with nobody on it is refused rather ' +
        'than attributed to the credential alone.',
    );
  }
  if (!req.runId) return;
  const runProjectId = await forgeReads().runProjectOf(req.runId);
  if (runProjectId === null) {
    throw new MergeInputError(
      'MERGE_RUN_NOT_FOUND',
      `merge: \`runId\` ${req.runId} names no pipeline run, so there is no run this merge is made for`,
    );
  }
  if (runProjectId !== projectId) {
    throw new MergeInputError(
      'MERGE_RUN_OF_ANOTHER_PROJECT',
      `merge: \`runId\` ${req.runId} belongs to another project than the change request it was sent with — a merge is authorised by a run on its own project, and Forge will not record one project's run as the authority for another's merge`,
    );
  }
}

/** The evidence write: the issue's stamp and the projection row, together or not at all. */
async function writeEvidence(args: {
  row: StoredRow;
  host: SourceHost;
  commitSha: string;
  mergedAt: Date;
  target: string;
  head: MergedHead | null;
  stampIssue: IssueMergeStamp;
}): Promise<{ stamped: boolean; stampedIssues: string[]; refusedStamps: RefusedStamp[] }> {
  const { row, host, commitSha, mergedAt, target, head, stampIssue } = args;
  try {
    return await db.transaction(async (tx) => {
      const stampedIssues: string[] = [];
      const refusedStamps: RefusedStamp[] = [];
      for (const issueId of row.issueIds) {
        const stamp = await stampIssue(tx, {
          pullRequestId: row.id,
          issueId,
          commitSha,
          mergedAt,
          target,
          head,
        });
        if (stamp.wrote) stampedIssues.push(issueId);
        if (stamp.refused) refusedStamps.push({ issueId, ...stamp.refused });
      }
      await markPullRequestMerged(tx, row.id, { commitSha, mergedAt });
      return { stamped: stampedIssues.length > 0, stampedIssues, refusedStamps };
    });
  } catch (err) {
    throw new Error(
      `${host.provider}: ${host.words.changeRequest} ${host.words.sigil}${row.number} MERGED at ${commitSha}, and recording it failed — ` +
        `the commit is on the base branch and Forge's record of it is not. ` +
        `The host's merged delivery, or another call to this verb, writes the same ` +
        `evidence without merging again. Underlying failure: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

async function refuse(deliveryId: string, reason: string, detail: string): Promise<MergeOutcome> {
  await updateDelivery(deliveryId, {
    status: 'refused',
    errorMessage: detail,
    response: { reason },
    completedAt: new Date(),
  });
  return { kind: 'refused', deliveryId, reason, detail };
}

/**
 * Merge one stored change request through the host its binding serves, and record the landing.
 *
 * `expectBindingId` is how a caller authorised for ONE binding says so: a dispatch holding a context
 * for binding A and a row belonging to binding B would validate A and then MERGE on B's repository.
 */
export async function mergeStoredChangeRequest(
  req: MergeRequest,
  stampIssue: IssueMergeStamp,
  expectBindingId?: string,
): Promise<MergeOutcome | null> {
  const row = await storedRow(req.pullRequestId);
  if (!row) return null;
  if (expectBindingId !== undefined && row.bindingId !== expectBindingId) {
    throw new SourceHostUnavailable(
      'no_binding',
      `change request ${req.pullRequestId} is stored under binding ${row.bindingId}, and this merge was authorised for ${expectBindingId} — Forge will not merge on a repository the caller did not name`,
      row.bindingId,
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
      issueIds: row.issueIds,
      requestedBy: req.requestedBy,
      runId: req.runId ?? null,
      expectedHeadSha: req.expectedHeadSha ?? null,
      method: req.method ?? 'merge',
    },
    status: 'pending',
  });

  // A refusal settles the delivery `refused` with its reason. A throw past this point — the host
  // unreachable, a 5xx, evidence that failed to write — settles it `failed` with its message; a merge
  // delivery is never left pending.
  try {
    let host: SourceHost;
    try {
      host = await sourceHostForBinding(row.bindingId);
    } catch (err) {
      if (err instanceof SourceHostUnavailable) return refuse(deliveryId, err.reason, err.message);
      throw err;
    }

    const method = req.method ?? 'merge';
    if (!host.words.mergeMethods.includes(method)) {
      return refuse(
        deliveryId,
        'method-unsupported',
        `${host.provider} has no \`${method}\` merge — it has ${host.words.mergeMethods.map((m) => `\`${m}\``).join(', ')}. It is refused rather than defaulted, because a different method lands a different shape of history on the base branch.`,
      );
    }

    const result = await host.merge({
      number: row.number,
      expectedHeadSha: req.expectedHeadSha,
      method,
    });
    if (result.kind === 'refused') return refuse(deliveryId, result.reason, result.detail);

    const head = await readMergedHead((a, b) => host.sameTree(a, b), result.head, result.commitSha);
    const { stamped, stampedIssues, refusedStamps } = await writeEvidence({
      row,
      host,
      commitSha: result.commitSha,
      mergedAt: result.mergedAt,
      target: result.target,
      head,
      stampIssue,
    });
    // a binding no webhook reaches learns its checks only by asking; the landing is recorded by
    // here, so a read that fails is reported on the outcome and never undoes it
    const checks = await projectChecksAfterMerge(host, {
      id: row.id,
      headSha: result.head ?? row.headSha,
    });
    await updateDelivery(deliveryId, {
      status: 'ok',
      response:
        result.kind === 'already-merged'
          ? {
              alreadyMerged: true,
              commitSha: result.commitSha,
              target: result.target,
              stamped,
              stampedIssues,
              refusedStamps,
            }
          : {
              commitSha: result.commitSha,
              target: result.target,
              requestedBy: req.requestedBy,
              stamped,
              stampedIssues,
              refusedStamps,
            },
      completedAt: new Date(),
    });
    return {
      kind: result.kind,
      deliveryId,
      commitSha: result.commitSha,
      mergedAt: result.mergedAt,
      target: result.target,
      stamped,
      stampedIssues,
      refusedStamps,
      checks,
    };
  } catch (err) {
    await updateDelivery(deliveryId, {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      completedAt: new Date(),
    });
    throw err;
  }
}
