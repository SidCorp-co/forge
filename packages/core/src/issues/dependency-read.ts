/**
 * ISS-868 — the one read of `issue_dependencies` for a single issue, shared by
 * REST `GET /api/issues/:id/dependencies` and MCP `forge_issues get`. Both
 * endpoints of every edge are joined so a caller can render the OTHER side as
 * `ISS-<seq>` without N extra round-trips (ISS-331).
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { type IssueDependencyKind, issueDependencies, issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { activeIssuePrefix } from './issue-prefix-read.js';

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

export type IssueDependencyEdges = {
  outgoing: IssueDependencyEdge[];
  incoming: IssueDependencyEdge[];
};

/** One prefix read per distinct project across the edge set, never one per row. */
async function readPrefixes(projectIds: Array<string | null>): Promise<Map<string, string | null>> {
  const distinct = [...new Set(projectIds)].filter((id): id is string => typeof id === 'string');
  const pairs = await Promise.all(
    distinct.map(async (id): Promise<[string, string | null]> => [id, await activeIssuePrefix(id)]),
  );
  return new Map(pairs);
}

export async function loadIssueDependencyEdges(
  issueId: string,
  projectId: string,
): Promise<IssueDependencyEdges> {
  const byIssue = await loadIssueDependencyEdgesForIssues([issueId], projectId);
  return byIssue.get(issueId) ?? { outgoing: [], incoming: [] };
}

/**
 * ISS-1017 — the same read over a PAGE of issues, in one query, so the issues
 * list can render its dependency badges from the search response instead of
 * one `GET /issues/:id/dependencies` per row (25 per page). The single-issue
 * function above is this one called with a page of one, so the query, the
 * prefix resolution and the enrichment have exactly one writer.
 */
export async function loadIssueDependencyEdgesForIssues(
  issueIds: string[],
  projectId: string,
): Promise<Map<string, IssueDependencyEdges>> {
  const byIssue = new Map<string, IssueDependencyEdges>(
    issueIds.map((id) => [id, { outgoing: [], incoming: [] }]),
  );
  if (byIssue.size === 0) return byIssue;
  const ids = [...byIssue.keys()];

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
      fromProjectId: fromIssue.projectId,
      fromTitle: fromIssue.title,
      fromStatus: fromIssue.status,
      fromMergedAt: fromIssue.mergedAt,
      toIssSeq: toIssue.issSeq,
      toProjectId: toIssue.projectId,
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
        or(inArray(issueDependencies.fromIssueId, ids), inArray(issueDependencies.toIssueId, ids)),
      ),
    );

  const prefixOf = await readPrefixes(
    rows.flatMap((r) => [r.fromProjectId, r.toProjectId]).concat(projectId),
  );
  const enrich = <
    T extends {
      fromIssSeq: number | null;
      toIssSeq: number | null;
      fromProjectId: string | null;
      toProjectId: string | null;
    },
  >(
    edge: T,
  ) => {
    const { fromIssSeq, toIssSeq, fromProjectId, toProjectId, ...rest } = edge;
    return {
      ...rest,
      fromDisplayId:
        fromIssSeq != null
          ? formatIssueRef(prefixOf.get(fromProjectId ?? '') ?? null, fromIssSeq)
          : null,
      toDisplayId:
        toIssSeq != null ? formatIssueRef(prefixOf.get(toProjectId ?? '') ?? null, toIssSeq) : null,
    };
  };

  for (const row of rows) {
    const edge = enrich(row);
    byIssue.get(row.fromIssueId)?.outgoing.push(edge);
    if (row.toIssueId !== row.fromIssueId) byIssue.get(row.toIssueId)?.incoming.push(edge);
  }
  return byIssue;
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
};

const isExpired = (edge: IssueDependencyEdge, now: number): boolean =>
  edge.validUntil != null && edge.validUntil.getTime() <= now;

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
): Promise<IssueRelations> {
  const byIssue = await loadIssueRelationsForIssues([issueId], projectId);
  return byIssue.get(issueId) ?? { blocks: [], blockedBy: [] };
}

export type IssueRelations = { blocks: IssueRelationDigest[]; blockedBy: IssueRelationDigest[] };

/**
 * ISS-1024 — the same projection over a SET of issues, off the one batched edge query, so
 * `memory/expand-relations.ts` spends one query on five seeds instead of one per seed. The
 * single-issue function above is this one called with a set of one, so `digest()` stays the only
 * writer of what a relation says and the omission its doc promises cannot drift between callers.
 */
export async function loadIssueRelationsForIssues(
  issueIds: string[],
  projectId: string,
): Promise<Map<string, IssueRelations>> {
  const edges = await loadIssueDependencyEdgesForIssues(issueIds, projectId);
  const now = Date.now();
  const out = new Map<string, IssueRelations>();
  for (const [issueId, { outgoing, incoming }] of edges) {
    out.set(issueId, {
      blocks: outgoing.map((e) => digest(e, issueId, now)),
      blockedBy: incoming.map((e) => digest(e, issueId, now)),
    });
  }
  return out;
}
