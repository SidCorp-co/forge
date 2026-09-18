/**
 * ISS-1073 — the one module that writes `issues.merged_at` and
 * `issues.merged_commit_sha`.
 *
 * `merged_at` is the Layer-2 dependency gate: NULL means the blocker has not
 * landed, so every `kind=blocks` dependent stays ungated. Until this module
 * there were three writers of it and not one read git — `merged-at.ts` twice
 * and `merge-marker.ts` once — so a merge and a stamp were two operations that
 * could disagree, and `db/schema.ts` carried the cost in its own guard.
 *
 * ## The two arms, and why the predicates differ
 *
 * An OBSERVED merge is one Forge watched happen: the kernel's own
 * `PUT .../merge` answering `merged: true`, or GitHub's `pull_request` event
 * carrying `merged`. It brings a commit sha and the merge's own timestamp, and
 * both are required by the type rather than optional — a sha is the evidence,
 * and a sha with no merge behind it is the testimony this issue exists to
 * delete.
 *
 * An ASSERTED stamp is somebody saying work shipped: `forge record merged`, or
 * the close of an issue whose code Forge never saw land. It carries no sha and
 * cannot be made to carry one.
 *
 * So the predicates are not the same predicate:
 *
 * - an assertion writes under `merged_at IS NULL` — the first stamp wins, which
 *   is the rule every caller already reads back;
 * - evidence writes under `merged_commit_sha IS NULL` — so a merge Forge later
 *   observes REPLACES an assertion, taking the merge's own time, while evidence
 *   already recorded is never replaced.
 */
// cm:guard the asymmetry is the whole design and must not be flattened to one predicate. Flatten it towards `merged_at IS NULL` and an issue somebody marked by hand can never receive the evidence of its own merge — the sha stays NULL forever and the wrong timestamp with it, which is the defect ISS-1027's retraction measured (`unmark` then `mark` re-stamps the CORRECTION's time, and no further correcting recovers the landing's). Flatten it the other way and a second assertion overwrites a first, which is the `already_merged` answer every mark door depends on.
// cm:guard `via` is recorded in what the CALLER writes beside this — an audit comment, a delivery row — and deliberately not in a column. A column would be a fourth thing to keep true about a row whose truth is already the sha: a stamp with a sha was observed and a stamp without one was asserted, and there is no third case for a column to carry.
// cm:edge lockstep -> scripts/check-merged-at-writers.mjs — that checker fails the build on any statement outside this module that writes either column, which is what makes "one writer" a gate rather than a promise

import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';

/** The pool or a caller's open transaction. A close stamps inside one; a mark does not. */
export type MergeRecordExecutor = Pick<Db, 'update' | 'select'>;

/**
 * What this stamp rests on.
 *
 * `observed` is a merge Forge watched happen and REQUIRES both the commit and
 * the time GitHub reported. `asserted` is a claim, and `at` overrides the server
 * clock for a caller that knows better; neither arm admits a sha on the other.
 */
export type MergeEvidence =
  | { kind: 'observed'; commitSha: string; mergedAt: Date; via: 'kernel' | 'event' }
  | { kind: 'asserted'; at?: Date | null; via: 'mark' | 'close' };

export interface MergeRecord {
  /** Whether THIS call moved the row. Every caller has to pass this on. */
  wrote: boolean;
  mergedAt: Date | null;
  commitSha: string | null;
}

async function readBack(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<{ mergedAt: Date | null; commitSha: string | null }> {
  const [row] = await executor
    .select({ mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return { mergedAt: row?.mergedAt ?? null, commitSha: row?.mergedCommitSha ?? null };
}

/**
 * Write the merge onto the issue, or report the stamp that was already there.
 *
 * Call it inside the same transaction as whatever else has to hold with it — the
 * status UPDATE for a close, the projection row for a kernel merge — so a
 * rollback drops both together.
 */
// cm:why the explicit time binds as an ISO string with a `::timestamptz` cast — a bare `sql`${date}`` is an untyped parameter whose type Postgres cannot infer, which was a live 500 on forge-beta for every mergedAt-supplied call (ISS-959)
// cm:guard RETURNING yields the NEW row, so "did this call write" cannot be asked of the returning list — it is answered by whether a row came back at all, which is what the WHERE decided. A `merged_at IS NULL` expression in the returning list is evaluated AFTER the write and is false for every stamp.
export async function recordIssueMerge(
  executor: MergeRecordExecutor,
  args: { issueId: string; evidence: MergeEvidence },
): Promise<MergeRecord> {
  const { issueId, evidence } = args;
  const stampExpr =
    evidence.kind === 'observed'
      ? sql`${evidence.mergedAt.toISOString()}::timestamptz`
      : evidence.at
        ? sql`${evidence.at.toISOString()}::timestamptz`
        : sql`now()`;

  const gate =
    evidence.kind === 'observed' ? isNull(issues.mergedCommitSha) : isNull(issues.mergedAt);

  const [wrote] = await executor
    .update(issues)
    .set({
      mergedAt: stampExpr,
      ...(evidence.kind === 'observed' ? { mergedCommitSha: evidence.commitSha } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(issues.id, issueId), gate))
    .returning({ mergedAt: issues.mergedAt, mergedCommitSha: issues.mergedCommitSha });

  if (wrote) {
    return { wrote: true, mergedAt: wrote.mergedAt, commitSha: wrote.mergedCommitSha };
  }
  const held = await readBack(executor, issueId);
  return { wrote: false, mergedAt: held.mergedAt, commitSha: held.commitSha };
}

/** Clearing the stamp re-blocks every downstream child (ISS-286 AC4). */
// cm:guard the commit is cleared WITH the timestamp — a retracted mark that kept its commit would leave the row claiming a landing the retraction withdrew, and `unmark` then `mark` is the only correction route the audit trail offers
export async function clearIssueMerge(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<void> {
  await executor
    .update(issues)
    .set({ mergedAt: null, mergedCommitSha: null, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

/**
 * The merge Forge actually watched land for this issue, or null.
 *
 * Read off the projection ISS-1062 built, which is written from GitHub's own
 * `pull_request` payloads: a row in `merged` state carrying both the commit and
 * the time GitHub reported. That is the one thing in this deployment that is
 * evidence of a landing rather than somebody's account of one.
 */
// cm:guard the EARLIEST landing wins, not the latest. An issue carries several pull requests over its life — a merged predecessor beside a follow-up is the ordinary case, and it is exactly the shape that made a master misread ISS-1027 on 2026-09-17 (#489 landed the work, #490 was a follow-up whose own title said so). `merged_at` means "this landed", and the landing is the first one.
// cm:guard the read lives here rather than in `integrations/github/` so this module stays the whole of what core knows about a merge, and so `issues/` does not grow an import of the integrations module for one SELECT. `db/schema-repo-projection.ts` is a schema, not a provider.
export async function observedMergeForIssue(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<{ commitSha: string; mergedAt: Date } | null> {
  const [row] = await executor
    .select({ sha: repoPullRequests.mergeCommitSha, at: repoPullRequests.mergedAt })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.issueId, issueId),
        eq(repoPullRequests.state, 'merged'),
        isNotNull(repoPullRequests.mergeCommitSha),
        isNotNull(repoPullRequests.mergedAt),
      ),
    )
    .orderBy(asc(repoPullRequests.mergedAt))
    .limit(1);
  if (!row?.sha || !row.at) return null;
  return { commitSha: row.sha, mergedAt: row.at };
}
