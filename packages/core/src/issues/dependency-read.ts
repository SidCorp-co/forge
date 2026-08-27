/**
 * ISS-868 — the one read of `issue_dependencies` for a single issue, shared by
 * REST `GET /api/issues/:id/dependencies` and MCP `forge_issues get`. Both
 * endpoints of every edge are joined so a caller can render the OTHER side as
 * `ISS-<seq>` without N extra round-trips (ISS-331).
 */

import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { type IssueDependencyKind, issueDependencies, issues } from '../db/schema.js';

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
  toTitle: string | null;
  toStatus: string | null;
  fromDisplayId: string | null;
  toDisplayId: string | null;
};

// cm:guard `outgoing` is the edges where this issue is `from` — under the repo's `from BLOCKS to` convention that is "this issue blocks others", and `incoming` is "this issue is blocked-by others"; a UI or tool that labels outgoing as "Depends on" inverts the whole graph the reader acts on
export type IssueDependencyEdges = {
  outgoing: IssueDependencyEdge[];
  incoming: IssueDependencyEdge[];
};

export async function loadIssueDependencyEdges(issueId: string): Promise<IssueDependencyEdges> {
  const fromIssue = alias(issues, 'from_issue');
  const toIssue = alias(issues, 'to_issue');
  const baseQuery = () =>
    db
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
        toIssSeq: toIssue.issSeq,
        toTitle: toIssue.title,
        toStatus: toIssue.status,
      })
      .from(issueDependencies)
      .leftJoin(fromIssue, eq(fromIssue.id, issueDependencies.fromIssueId))
      .leftJoin(toIssue, eq(toIssue.id, issueDependencies.toIssueId));

  const enrich = <T extends { fromIssSeq: number | null; toIssSeq: number | null }>(edge: T) => {
    const { fromIssSeq, toIssSeq, ...rest } = edge;
    return {
      ...rest,
      fromDisplayId: fromIssSeq != null ? `ISS-${fromIssSeq}` : null,
      toDisplayId: toIssSeq != null ? `ISS-${toIssSeq}` : null,
    };
  };

  const [outgoingRows, incomingRows] = await Promise.all([
    baseQuery().where(eq(issueDependencies.fromIssueId, issueId)),
    baseQuery().where(eq(issueDependencies.toIssueId, issueId)),
  ]);

  return { outgoing: outgoingRows.map(enrich), incoming: incomingRows.map(enrich) };
}

export type IssueRelationDigest = {
  edgeId: string;
  kind: IssueDependencyKind;
  fromIssueId: string;
  toIssueId: string;
  otherIssueId: string;
  otherDisplayId: string | null;
  otherStatus: string | null;
  validUntil: Date | null;
  expired: boolean;
  gatesDispatch: boolean;
};

// cm:guard `gatesDispatch` is the answer to "am I blocked", and it is NOT `kind === 'blocks'`: a `decomposes` edge also lands in `blockedBy` (from=parent, to=child) while dispatch-gates.ts L2 gates children on merged_at, not on this edge, so a reader that treats every incoming edge as a blocker sees a live blocker that is not there
// cm:guard `expired` mirrors the dispatcher's own predicate (`valid_until IS NULL OR valid_until > now()` — dispatch-gates.ts L2): an expired `blocks` edge still has a row but gates nothing, so an agent told only that the row exists reads a live blocker where there is none
// cm:edge contract -> packages/core/src/jobs/dispatch-gates.ts — same expiry rule; if L2 stops honouring valid_until, this flag starts lying
function digest(edge: IssueDependencyEdge, issueId: string, now: number): IssueRelationDigest {
  const outgoing = edge.fromIssueId === issueId;
  const expired = edge.validUntil != null && edge.validUntil.getTime() <= now;
  return {
    edgeId: edge.id,
    kind: edge.kind,
    fromIssueId: edge.fromIssueId,
    toIssueId: edge.toIssueId,
    otherIssueId: outgoing ? edge.toIssueId : edge.fromIssueId,
    otherDisplayId: outgoing ? edge.toDisplayId : edge.fromDisplayId,
    otherStatus: outgoing ? edge.toStatus : edge.fromStatus,
    validUntil: edge.validUntil,
    expired,
    gatesDispatch: !outgoing && edge.kind === 'blocks' && !expired,
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
): Promise<{ blocks: IssueRelationDigest[]; blockedBy: IssueRelationDigest[] }> {
  const { outgoing, incoming } = await loadIssueDependencyEdges(issueId);
  const now = Date.now();
  return {
    blocks: outgoing.map((e) => digest(e, issueId, now)),
    blockedBy: incoming.map((e) => digest(e, issueId, now)),
  };
}
