import { and, eq, sql } from 'drizzle-orm';
import { type IssueStatus, issues } from '../db/schema.js';
import { projectConfigDocuments } from '../db/schema-project-config.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import { designOnlyMarkSql } from './design-delivery.js';
import { landedSql } from './host-landing.js';
import {
  type LandingShape,
  landingRoute,
  landingShortfall,
  readLandingEvidence,
} from './landing-evidence.js';
import { type MergeMarkKind, mergeMarkKindOf } from './merge-mark-kind.js';
import type { MergeRecordExecutor } from './merge-record.js';

/** What a refusal under the shipped-work rule says, or `null` where the call may proceed. */
interface ShippedRuleRefusal {
  detail: string;
  details: Record<string, unknown>;
}

/** What every refusal under the merge rule ends with: `dropped` for what was not work, and the
 *  route this project's shape has for recording where the work landed. */
function closedMeansShipped(shape: LandingShape | null, held?: MergeMarkKind): string {
  return (
    '`closed` means the work shipped, and `awaiting_release` that it is merged and waits for its ' +
    'release. Use `dropped` for work that turned out not to be work — a note, a question, a ' +
    'duplicate, something already done — which is terminal without the claim and releases every ' +
    `\`blocks\` dependent the same way. ${landingRoute(shape, held)}`
  );
}

/**
 * The `merged` guard (`@forge/contracts/issue-machine:ISSUE_MACHINE`): `awaiting_release` and
 * `closed` are entered only by an issue whose merge is recorded, as this project's shape records
 * one. Recording it moves no status. Null where the merge stands.
 *
 * Whatever the project's shape, a mark that is a design approval's stamp alone — design artifacts and
 * nothing else: no commit, no paths, no landing of code (`merge-mark-kind.ts:designOnlyStamp`,
 * `design-delivery.ts:designOnlyMarkSql`) — stands for the `design_delivered` close and never for
 * `awaiting_release`: that status waits for a release, and no release carries a design-only issue
 * (`release-batch/create.ts:withoutDesignOnly`, REQ-45 BC-4). On git, taken as a merge, it passed a
 * code carrier on to the release before any code was marked (ISS-526, forge-dev, 2026-10-14);
 * outside git, where the approval writes the design landing, it parked the issue at
 * `awaiting_release` for good, every roster skipping it. Refused by name in both, pointing at the close.
 */
export async function mergeNotRecorded(
  executor: MergeRecordExecutor,
  args: { issueId: string; to: IssueStatus },
): Promise<
  | (ShippedRuleRefusal & {
      code: 'CLOSE_REQUIRES_SHIPPED' | 'MERGE_NOT_RECORDED' | 'MERGE_DESIGN_ONLY';
    })
  | null
> {
  const code = args.to === 'closed' ? 'CLOSE_REQUIRES_SHIPPED' : 'MERGE_NOT_RECORDED';
  if (await stampWithoutHostMerge(executor, args.issueId)) {
    if (args.to === 'awaiting_release' && (await changeRequestWaits(executor, args.issueId))) {
      return null;
    }
    return {
      code,
      detail:
        `\`${args.to}\` needs a landing, and on this project only the host's merge of a change request lands: this issue's \`merged_at\` is a local mark the host never merged. ` +
        'Push the branch and open a change request that links this issue: `awaiting_release` waits on it until the release merges it, and that merge records the landing. ' +
        'Use `dropped` for work that turned out not to be work.',
      details: { to: args.to, requires: 'changeRequest', held: 'local', useInstead: 'dropped' },
    };
  }
  const evidence = await readLandingEvidence(executor, args.issueId);
  if (evidence && !landingShortfall(evidence.columns, evidence.shape)) {
    return args.to === 'awaiting_release' ? await designStampOnly(executor, args.issueId) : null;
  }
  if (!evidence || evidence.shape === 'git') {
    if (args.to === 'awaiting_release' && (await changeRequestWaits(executor, args.issueId))) {
      return null;
    }
    return {
      code,
      detail: `\`${args.to}\` needs a recorded merge, and this issue carries no \`merged_at\`. ${closedMeansShipped('git')}`,
      details: { to: args.to, requires: 'mergedAt', useInstead: 'dropped' },
    };
  }
  const { columns, shape } = evidence;
  if (shape === null) {
    return {
      code,
      detail: `${landingShortfall(columns, shape)}. ${closedMeansShipped(shape)}`,
      details: {
        to: args.to,
        requires: 'sourceType',
        held: mergeMarkKindOf(columns),
        useInstead: 'dropped',
      },
    };
  }
  return {
    code,
    detail: `${landingShortfall(columns, shape)}, so nothing on it shows where the work landed. ${closedMeansShipped(shape, mergeMarkKindOf(columns))}`,
    details: {
      to: args.to,
      requires: 'mergedLanding',
      shape,
      held: mergeMarkKindOf(columns),
      useInstead: 'dropped',
    },
  };
}

/**
 * On a project that releases through change requests, an issue waits for its release on an open
 * change request that delivers it: the merge is the release's own act, after the owner approves it,
 * so it cannot be recorded before `awaiting_release` (REQ-63 BC-1).
 */
async function changeRequestWaits(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: repoPullRequests.id })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .innerJoin(issues, eq(issues.id, repoPullRequestIssues.issueId))
    .innerJoin(projectConfigDocuments, eq(projectConfigDocuments.projectId, issues.projectId))
    .where(
      and(
        eq(repoPullRequestIssues.issueId, issueId),
        eq(repoPullRequests.state, 'open'),
        sql`(${projectConfigDocuments.document} -> 'release' ->> 'changeRequests') = 'true'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A merge stamp the host never made, on a project that releases through change requests: there
 * only the host's merge lands (`host-landing.ts:landedSql`, REQ-71), so the stamp does not stand.
 */
async function stampWithoutHostMerge(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({
      off: sql<boolean>`(${issues.mergedAt} IS NOT NULL AND NOT ${landedSql(sql`${issues}`)})`,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row?.off === true;
}

/** Why `unmark` is refused on a `closed` issue, or `null` where it may proceed. `clearIssueMerge`
 *  nulls `merged_at` and leaves `status` alone, so on a `closed` row it makes the one state this
 *  rule forbids. The trigger refuses it too, but names an entry into `closed` nobody attempted. */
export function refuseUnmarkOnClosed(status: IssueStatus): ShippedRuleRefusal | null {
  if (status !== 'closed') return null;
  return {
    detail:
      'this issue is `closed`, and `closed` means the work shipped, so the claim cannot be ' +
      'withdrawn while it stands there: clearing `merged_at` would leave a closed issue with ' +
      'nothing on it saying anything shipped. Move it off `closed` first — `reopen` is the only ' +
      'exit `closed` has — and then `unmark`, or take `dropped` from `reopen` where the work ' +
      'never landed at all.',
    details: { status: 'closed', moveTo: 'reopen', useInstead: 'dropped' },
  };
}

/** Why a design approval's stamp alone does not enter `awaiting_release`, or null where the mark is more. */
async function designStampOnly(
  executor: MergeRecordExecutor,
  issueId: string,
): Promise<(ShippedRuleRefusal & { code: 'MERGE_DESIGN_ONLY' }) | null> {
  const [row] = await executor
    .select({
      designOnly: sql<boolean>`${designOnlyMarkSql(sql`${issues}`)}`,
      artifacts: issues.mergedArtifacts,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row?.designOnly) return null;
  const designs = (row.artifacts ?? []).map((a) => a.ref).join(', ');
  return {
    code: 'MERGE_DESIGN_ONLY',
    detail:
      `\`awaiting_release\` waits for a release, and this issue's only mark is the approval of design ${designs}, ` +
      'which records no commit, no landing of code and no changed paths, so no release carries it. ' +
      'Where the issue delivers code, mark the commit that landed it (`POST /api/issues/:id/merge` with `commit`, ' +
      'or the paths the box read as `changedPaths`), then move it. Where the design is all it delivers, close it ' +
      'through `design_delivered` (move it to `closed`) once its revisions are approved.',
    details: {
      to: 'awaiting_release',
      mark: 'design_only',
      designs: (row.artifacts ?? []).map((a) => a.ref),
      requires: ['commit', 'changedPaths'],
      useInstead: 'closed',
    },
  };
}
