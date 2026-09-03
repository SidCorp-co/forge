/**
 * ISS-868 — the one read of `issue_dependencies` for a single issue, shared by
 * REST `GET /api/issues/:id/dependencies` and MCP `forge_issues get`. Both
 * endpoints of every edge are joined so a caller can render the OTHER side as
 * `ISS-<seq>` without N extra round-trips (ISS-331).
 */

import { and, eq, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { type IssueDependencyKind, issueDependencies, issues } from '../db/schema.js';
import { isBlockerSatisfied } from './dependency-satisfaction.js';

export type IssueDependencyEdge = {
  id: string;
  projectId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: IssueDependencyKind;
  reason: string | null;
  createdById: string | null;
  createdAt: Date;
  validUntil: Date | null;
  fromTitle: string | null;
  fromStatus: string | null;
  fromMergedAt: Date | null;
  toTitle: string | null;
  toStatus: string | null;
  toMergedAt: Date | null;
  fromDisplayId: string | null;
  toDisplayId: string | null;
};

// cm:guard `outgoing` is the edges where this issue is `from` — under the repo's `from BLOCKS to` convention that is "this issue blocks others", and `incoming` is "this issue is blocked-by others"; a UI or tool that labels outgoing as "Depends on" inverts the whole graph the reader acts on
export type IssueDependencyEdges = {
  outgoing: IssueDependencyEdge[];
  incoming: IssueDependencyEdge[];
};

// cm:guard `projectId` is REQUIRED and must stay in the WHERE clause — `issue_dependencies` carries only the composite indexes `(project_id, from_issue_id)` and `(project_id, to_issue_id)` (schema.ts), so filtering on an endpoint alone constrains the NON-leading column and Postgres degrades to scanning every edge in the table. This read runs on `forge_issues get`, i.e. every agent turn. Measured 2026-08-28 on a 399-edge fixture: with `project_id` the plan is a BitmapOr over both indexes; on the endpoint alone it is a Seq Scan, 398 rows removed by filter.
export async function loadIssueDependencyEdges(
  issueId: string,
  projectId: string,
): Promise<IssueDependencyEdges> {
  const fromIssue = alias(issues, 'from_issue');
  const toIssue = alias(issues, 'to_issue');
  const rows = await db
    .select({
      id: issueDependencies.id,
      projectId: issueDependencies.projectId,
      fromIssueId: issueDependencies.fromIssueId,
      toIssueId: issueDependencies.toIssueId,
      kind: issueDependencies.kind,
      reason: issueDependencies.reason,
      createdById: issueDependencies.createdById,
      createdAt: issueDependencies.createdAt,
      validUntil: issueDependencies.validUntil,
      fromIssSeq: fromIssue.issSeq,
      fromTitle: fromIssue.title,
      fromStatus: fromIssue.status,
      fromMergedAt: fromIssue.mergedAt,
      toIssSeq: toIssue.issSeq,
      toTitle: toIssue.title,
      toStatus: toIssue.status,
      toMergedAt: toIssue.mergedAt,
    })
    .from(issueDependencies)
    .leftJoin(fromIssue, eq(fromIssue.id, issueDependencies.fromIssueId))
    .leftJoin(toIssue, eq(toIssue.id, issueDependencies.toIssueId))
    .where(
      and(
        eq(issueDependencies.projectId, projectId),
        or(eq(issueDependencies.fromIssueId, issueId), eq(issueDependencies.toIssueId, issueId)),
      ),
    );

  const enrich = <T extends { fromIssSeq: number | null; toIssSeq: number | null }>(edge: T) => {
    const { fromIssSeq, toIssSeq, ...rest } = edge;
    return {
      ...rest,
      fromDisplayId: fromIssSeq != null ? `ISS-${fromIssSeq}` : null,
      toDisplayId: toIssSeq != null ? `ISS-${toIssSeq}` : null,
    };
  };

  const outgoing: IssueDependencyEdge[] = [];
  const incoming: IssueDependencyEdge[] = [];
  for (const row of rows) {
    (row.fromIssueId === issueId ? outgoing : incoming).push(enrich(row));
  }
  return { outgoing, incoming };
}

export type IssueRelationDigest = {
  edgeId: string;
  kind: IssueDependencyKind;
  fromIssueId: string;
  toIssueId: string;
  otherIssueId: string;
  otherDisplayId: string | null;
  otherStatus: string | null;
  otherMergedAt: Date | null;
  validUntil: Date | null;
  expired: boolean;
  gatesDispatch: boolean;
};

const isExpired = (edge: IssueDependencyEdge, now: number): boolean =>
  edge.validUntil != null && edge.validUntil.getTime() <= now;

// cm:guard `gatesDispatch` answers "is this edge holding me RIGHT NOW", and it is three conditions, not one: incoming + kind `blocks` + unexpired + the blocker unsatisfied. Drop any of them and it lies in the ordinary case — a `decomposes` parent also lands in `blockedBy` while L2 never gates the child on it, and every satisfied dependency in the project would report a live blocker forever once its blocker merged.
// cm:edge lockstep -> packages/core/src/issues/dependency-satisfaction.ts — the merged/reopen/closed half of the rule lives there, shared with pipeline-health.ts; the valid_until half is inline here because it is the only part `expired` also needs
function digest(edge: IssueDependencyEdge, issueId: string, now: number): IssueRelationDigest {
  const outgoing = edge.fromIssueId === issueId;
  const expired = isExpired(edge, now);
  return {
    edgeId: edge.id,
    kind: edge.kind,
    fromIssueId: edge.fromIssueId,
    toIssueId: edge.toIssueId,
    otherIssueId: outgoing ? edge.toIssueId : edge.fromIssueId,
    otherDisplayId: outgoing ? edge.toDisplayId : edge.fromDisplayId,
    otherStatus: outgoing ? edge.toStatus : edge.fromStatus,
    otherMergedAt: outgoing ? edge.toMergedAt : edge.fromMergedAt,
    validUntil: edge.validUntil,
    expired,
    gatesDispatch:
      !outgoing &&
      edge.kind === 'blocks' &&
      !expired &&
      !isBlockerSatisfied({ status: edge.fromStatus, mergedAt: edge.fromMergedAt }),
  };
}

/**
 * Agent-facing projection of {@link loadIssueDependencyEdges}: ids, kind and
 * expiry only. Titles and `reason` are deliberately omitted — they are
 * caller-authored text from a DIFFERENT issue, and this payload is inlined
 * into an agent's context without the untrusted-data framing `serialize()`
 * applies to the issue's own fields.
 */
export async function loadIssueRelations(
  issueId: string,
  projectId: string,
): Promise<{ blocks: IssueRelationDigest[]; blockedBy: IssueRelationDigest[] }> {
  const { outgoing, incoming } = await loadIssueDependencyEdges(issueId, projectId);
  const now = Date.now();
  return {
    blocks: outgoing.map((e) => digest(e, issueId, now)),
    blockedBy: incoming.map((e) => digest(e, issueId, now)),
  };
}
