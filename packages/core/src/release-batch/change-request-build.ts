/**
 * REQ-63 BC-6: the build a verdict counts on for an issue of a project that releases by merging its
 * change requests. Until the request merges, nothing has landed: the request's head is what the
 * release merges, so a verdict counts where it was judged at the head of an open change request
 * linked to the issue, while that head stays unchanged. A head that moved since is a different
 * build, and a verdict at the old one stops counting, named. Once the host merged the request, its
 * merge commit is the landing. Work the host already holds on the target branch with no request
 * (`landed-on-target.ts`) is landed at that commit (`from: 'landed'`), never read as unlanded.
 *
 * One reading, through `landed-build.ts:deliveredBuildsOf`, for the build a verdict defaults to
 * (`judged-build.ts`), the steward's reopen rule (`reopen-guard.ts`) and a requirement's coverage;
 * the release's own admission reads it too, for its approval (`approval-checklist.ts`) and for each
 * merge (`change-request-merge.ts`), through `changeRequestHeadWhy`.
 */

import { verdictEarns } from '@forge/contracts/verdict-identity';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { issueDisplayIds, landingGuardCriteriaOf } from '../issues/index.js';
import {
  label,
  mergeStepsOf,
  openChangeRequestsOf,
  type ReleaseMergeStep,
  type RosterChangeRequest,
} from './change-request-roster.js';
import { alreadyOnPhrase, landedOnTargetOf, type OnTarget } from './landed-on-target.js';

const WHOLE = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

/** An issue's build on a change-request project, or why it has none. */
export type ChangeRequestBuild =
  | {
      sha: string;
      from: 'merge' | 'change-request' | 'landed';
      basis: string;
      /** The request whose head this is (`!12`); null for a merge commit. */
      via: string | null;
      /** The branch that request merges from; null for a merge commit. */
      branch: string | null;
    }
  | { sha: null; why: string; unread?: true };

/**
 * Why a release cut at `cutAt` of the request `via` no longer merges what was approved, or null
 * where its head is still that commit: the one rule for a moved head.
 */
export function changeRequestHeadWhy(via: string, cutAt: string, now: string): string | null {
  if (now.toLowerCase() === cutAt.toLowerCase()) return null;
  return `${via}'s head moved from \`${short(cutAt)}\` to \`${short(now)}\` since the release was cut, so a verdict at \`${short(cutAt)}\` no longer counts and the head the owner would approve is not the one that would merge`;
}

/** Why a verdict at `judged` does not count on the head `build` of the request `via`. */
export function otherHeadWhy(judged: string, build: string, via: string): string {
  return `it was judged at \`${short(judged)}\`, not at \`${short(build)}\`, the head of ${via} it ships through: a verdict counts only at that head while it stays unchanged, so one taken before the head moved does not`;
}

interface Claimed {
  key: string;
  merged: string | null;
  /** Whether a merge is stamped on it, a box's mark among them. */
  stamped: boolean;
  steps: ReleaseMergeStep[] | null;
}

async function claimedOf(ids: readonly string[]): Promise<Map<string, Claimed>> {
  const [rows, shown] = await Promise.all([
    db
      .select({
        id: issues.id,
        merged: issues.mergedCommitSha,
        mergedAt: issues.mergedAt,
        runStatus: pipelineRuns.status,
        metadata: pipelineRuns.metadata,
      })
      .from(issues)
      .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
      .where(inArray(issues.id, [...ids])),
    issueDisplayIds([...ids]),
  ]);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        key: shown.get(r.id) ?? r.id,
        merged: r.merged?.trim().toLowerCase() ?? null,
        stamped: r.mergedAt !== null,
        steps: r.runStatus === 'running' ? mergeStepsOf(r.metadata) : null,
      },
    ]),
  );
}

/** The commit each of an issue's counting verdicts names, by criterion. */
async function judgedAt(ids: readonly string[]): Promise<Map<string, (string | null)[]>> {
  const standing = await landingGuardCriteriaOf(ids);
  const out = new Map<string, (string | null)[]>();
  for (const [id, s] of standing) {
    out.set(
      id,
      s.criteria.map(({ verdict }) =>
        verdict && !verdict.unverified && verdictEarns(verdict.verdict) && verdict.at
          ? verdict.at.value.trim().toLowerCase()
          : null,
      ),
    );
  }
  return out;
}

async function currentHeads(
  ids: readonly string[],
): Promise<Map<string, { sha: string; ref: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: repoPullRequests.id,
      head: repoPullRequests.headSha,
      ref: repoPullRequests.headRef,
    })
    .from(repoPullRequests)
    .where(inArray(repoPullRequests.id, [...ids]));
  return new Map(rows.map((r) => [r.id, { sha: r.head.toLowerCase(), ref: r.ref }]));
}

/** The issue's build in a running release that merges it: the head it was cut at, if unchanged. */
function inRelease(
  key: string,
  runSteps: readonly ReleaseMergeStep[],
  issueId: string,
  heads: ReadonlyMap<string, { sha: string; ref: string }>,
): ChangeRequestBuild | null {
  const step = runSteps.filter((s) => s.issueIds.includes(issueId)).at(-1);
  if (!step) return null;
  const via = label(step);
  const now = heads.get(step.pullRequestId);
  if (!now)
    return { sha: null, why: `${key}'s release merges ${via}, which Forge no longer holds` };
  const moved = changeRequestHeadWhy(via, step.headSha, now.sha);
  if (moved) return { sha: null, why: `${key}: ${moved}` };
  return {
    sha: step.headSha.toLowerCase(),
    from: 'change-request',
    via,
    branch: now.ref,
    basis: `${key} ships through ${via} in the running release, cut at its head \`${short(step.headSha)}\`, which is unchanged`,
  };
}

/** The open request whose head carries the issue's passes, else the latest of them, by name. */
function onOpenRequest(
  key: string,
  open: readonly RosterChangeRequest[],
  judged: readonly (string | null)[],
): ChangeRequestBuild {
  if (open.length === 0) {
    return {
      sha: null,
      why: `${key} has no open change request linked to it and has not merged on its host, so no head carries a verdict that counts`,
    };
  }
  const heads = open.map((cr) => cr.headSha.toLowerCase());
  const passesAt = (head: string) => judged.filter((sha) => sha === head).length;
  const best = [...open].sort(
    (a, b) =>
      passesAt(b.headSha.toLowerCase()) - passesAt(a.headSha.toLowerCase()) || b.number - a.number,
  )[0] as RosterChangeRequest;
  const sha = best.headSha.toLowerCase();
  const via = label(best);
  const stale = [...new Set(judged.filter((s): s is string => !!s && !heads.includes(s)))];
  const moved =
    stale.length > 0
      ? `; a verdict at ${stale.map((s) => `\`${short(s)}\``).join(', ')} no longer counts: that is not the head of any open change request linked to ${key}, so the head moved since it was judged`
      : '';
  return {
    sha,
    from: 'change-request',
    via,
    branch: best.headRef,
    basis: `${key} ships through ${via}, whose head is \`${short(sha)}\`: a verdict counts at that head while it stays unchanged${moved}`,
  };
}

/** Each issue's build on a change-request project (see the module note), or why it has none. */
export async function changeRequestBuildsOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, ChangeRequestBuild>> {
  const ids = [...new Set(issueIds.map((id) => id.toLowerCase()))];
  const out = new Map<string, ChangeRequestBuild>();
  if (ids.length === 0) return out;
  const [claimed, open, judged] = await Promise.all([
    claimedOf(ids),
    openChangeRequestsOf(projectId, ids),
    judgedAt(ids),
  ]);
  const stepIds = [...claimed.values()].flatMap((c) => (c.steps ?? []).map((s) => s.pullRequestId));
  const heads = await currentHeads([...new Set(stepIds)]);
  const onTarget = await onTargetOf(
    projectId,
    ids.filter((id) => {
      const c = claimed.get(id);
      return c?.stamped && !c.merged && !open.some((cr) => cr.issueIds.includes(id));
    }),
  );
  for (const id of ids) {
    const c = claimed.get(id);
    if (!c) continue;
    if (c.merged && WHOLE.test(c.merged)) {
      out.set(id, {
        sha: c.merged,
        from: 'merge',
        via: null,
        branch: null,
        basis: `${c.key} merged on its host as \`${short(c.merged)}\`, so that merge commit is its landing`,
      });
      continue;
    }
    const released = c.steps ? inRelease(c.key, c.steps, id, heads) : null;
    const landed = released || !c.stamped ? null : landedBuild(c.key, onTarget, id);
    if (landed) {
      out.set(id, landed);
      continue;
    }
    out.set(
      id,
      released ??
        onOpenRequest(
          c.key,
          open.filter((cr) => cr.issueIds.includes(id)),
          judged.get(id) ?? [],
        ),
    );
  }
  return out;
}

/** The host's answer on which issues are already on the target branch, or why it could not be read. */
async function onTargetOf(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, OnTarget> | { unread: string }> {
  try {
    return await landedOnTargetOf(projectId, ids);
  } catch (err) {
    return { unread: err instanceof Error ? err.message : String(err) };
  }
}

/** The issue's landing where the host holds its work on the target branch with no request. */
function landedBuild(
  key: string,
  onTarget: Map<string, OnTarget> | { unread: string },
  id: string,
): ChangeRequestBuild | null {
  if (!(onTarget instanceof Map)) {
    return {
      sha: null,
      unread: true,
      why: `${key} has no open change request linked to it, and whether its merge mark's commit is on its target branch could not be read from the host: ${onTarget.unread}`,
    };
  }
  const on = onTarget.get(id);
  if (!on) return null;
  return {
    sha: on.commit,
    from: 'landed',
    via: null,
    branch: on.branch,
    basis: `${alreadyOnPhrase(key, on)}, so that commit is its landing`,
  };
}
