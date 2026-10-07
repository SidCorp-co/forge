// The reads a storefront release's verification makes of Forge's own record: each claimed issue's
// mark and verdicts, whether it is the build of a workflow, and the approvals of design revisions.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { activeIssuePrefix, listCriteriaOf } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { approvedDesignRevisions, buildIssuesAmong } from '../workflows/index.js';
import { designRefParts, type RosterIssue } from './provider-landings.js';

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

/** Each claimed issue of the project, keyed as a person reads it, with its mark and verdicts. */
export async function readProviderRoster(
  projectId: string,
  issueIds: readonly string[],
): Promise<RosterIssue[]> {
  const ids = [...issueIds];
  const [rows, built, prefix, criteria] = await Promise.all([
    db
      .select({
        id: issues.id,
        seq: issues.issSeq,
        mergedAt: issues.mergedAt,
        landing: issues.mergedLanding,
        artifacts: issues.mergedArtifacts,
      })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.id, ids))),
    buildIssuesAmong(ids),
    activeIssuePrefix(projectId),
    listCriteriaOf(db, ids),
  ]);
  return rows.map((r) => ({
    key: r.seq != null ? formatIssueRef(prefix, r.seq) : r.id,
    criteria: criteria.get(r.id) ?? [],
    mergedAt: iso(r.mergedAt),
    landing: r.landing,
    artifacts: r.artifacts,
    builds: built.has(r.id),
  }));
}

/** When each design revision named (`<flow>@rev<n>`) was approved in the project; absent where it was not. */
export async function readDesignApprovals(
  projectId: string,
  refs: readonly string[],
): Promise<Map<string, string>> {
  const flows = refs.flatMap((r) => designRefParts(r)?.flow ?? []);
  const approved = await approvedDesignRevisions(projectId, flows);
  return new Map([...approved].map(([ref, at]) => [ref, at.toISOString()]));
}
