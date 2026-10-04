import { eq } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { pipelineRuns } from '../../db/schema.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { recordDelivery, updateDelivery } from '../deliveries.js';
import { SourceHostUnavailable } from './errors.js';
import { markPullRequestMerged } from './projection.js';
import { sourceHostForBinding } from './resolve.js';
import type { SourceHost } from './types.js';

/** The delivery event every merge, refusal and already-merged reading is logged under. */
export const MERGE_EVENT = 'pull_request.merge';

/** Every merge method any host has. A host that lacks one refuses it by name (`words.mergeMethods`). */
export const CHANGE_REQUEST_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type ChangeRequestMergeMethod = (typeof CHANGE_REQUEST_MERGE_METHODS)[number];

/**
 * Writes the issue's merge stamp in the transaction that marks the projection row, and answers whether
 * it wrote. Supplied by the caller, which owns the stamp; the adapter owns only the row.
 */
export type IssueMergeStamp = (
  tx: Tx,
  args: { issueId: string; commitSha: string; mergedAt: Date },
) => Promise<{ wrote: boolean }>;

export interface MergeRequest {
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
 * The caller, checked before anything is read and long before anything is sent: a nameless merge is
 * refused, and so is a run belonging to another project — otherwise a caller authorised on one
 * project could hand any run id over and have it recorded as the authority for a merge on another.
 */
async function assertCaller(req: MergeRequest, projectId: string): Promise<void> {
  if (!req.requestedBy.trim()) {
    throw new MergeInputError(
      'merge: a merge needs `requestedBy` — the identity this merge is made for. Forge merges as ' +
        'its own credential and records who asked; a merge with nobody on it is refused rather ' +
        'than attributed to the credential alone.',
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
      `merge: \`runId\` ${req.runId} names no pipeline run, so there is no run this merge is made for`,
    );
  }
  if (run.projectId !== projectId) {
    throw new MergeInputError(
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
  stampIssue: IssueMergeStamp;
}): Promise<{ stamped: boolean }> {
  const { row, host, commitSha, mergedAt, stampIssue } = args;
  try {
    return await db.transaction(async (tx) => {
      const stamp = row.issueId
        ? await stampIssue(tx, { issueId: row.issueId, commitSha, mergedAt })
        : { wrote: false };
      await markPullRequestMerged(tx, row.id, { commitSha, mergedAt });
      return { stamped: stamp.wrote };
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
    status: 'failed',
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
      issueId: row.issueId,
      requestedBy: req.requestedBy,
      runId: req.runId ?? null,
      expectedHeadSha: req.expectedHeadSha ?? null,
      method: req.method ?? 'merge',
    },
    status: 'pending',
  });

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

  const { stamped } = await writeEvidence({
    row,
    host,
    commitSha: result.commitSha,
    mergedAt: result.mergedAt,
    stampIssue,
  });
  await updateDelivery(deliveryId, {
    status: 'ok',
    response:
      result.kind === 'already-merged'
        ? { alreadyMerged: true, commitSha: result.commitSha, stamped }
        : { commitSha: result.commitSha, requestedBy: req.requestedBy, stamped },
    completedAt: new Date(),
  });
  return {
    kind: result.kind,
    deliveryId,
    commitSha: result.commitSha,
    mergedAt: result.mergedAt,
    stamped,
  };
}
