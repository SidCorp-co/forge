/**
 * ISS-868 — the one read of `issue_dependencies` for a single issue, shared by
 * REST `GET /api/issues/:id/dependencies` and the issue read. Both
 * endpoints of every edge are joined so a caller can render the OTHER side as
 * `ISS-<seq>` without N extra round-trips (ISS-331).
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import {
  type IssueDependencyKind,
  issueDependencies,
  issueDependencyKinds,
  issues,
} from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { blockingEdgesIn } from './blocked-by.js';
import { DISPATCH_GATING_KIND } from './dependency-effects.js';
import { designHoldPhrase } from './design-delivery.js';
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
  /** `valid_until` has passed: the edge is retracted, shown as such and counted as nothing. */
  expired: boolean;
  /** A live `blocks` edge whose blocker still holds this issue back (`blocked-by.ts:blockingEdgesIn`). */
  holds: boolean;
  fromTitle: string | null;
  fromStatus: string | null;
  fromMergedAt: Date | null;
  fromDesignHold: string | null;
  toTitle: string | null;
  toStatus: string | null;
  toMergedAt: Date | null;
  fromDisplayId: string | null;
  toDisplayId: string | null;
};

type IssueDependencyEdges = {
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

  const [prefixOf, live] = await Promise.all([
    readPrefixes(rows.flatMap((r) => [r.fromProjectId, r.toProjectId]).concat(projectId)),
    blockingEdgesIn(db, projectId, ids).then((edges) => new Map(edges.map((e) => [e.edgeId, e]))),
  ]);
  const now = Date.now();
  const enrich = <
    T extends {
      id: string;
      validUntil: Date | null;
      fromIssueId: string;
      fromStatus: string | null;
      kind: IssueDependencyKind;
      fromIssSeq: number | null;
      toIssSeq: number | null;
      fromProjectId: string | null;
      toProjectId: string | null;
    },
  >(
    edge: T,
  ) => {
    const { fromIssSeq, toIssSeq, fromProjectId, toProjectId, ...rest } = edge;
    const expired = rest.validUntil != null && rest.validUntil.getTime() <= now;
    const blocking = live.get(rest.id);
    return {
      ...rest,
      expired,
      holds: blocking?.holds === true,
      fromDesignHold: blocking?.fromDesign.length ? designHoldPhrase(blocking.fromDesign) : null,
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

type IssueRelationDigest = {
  edgeId: string;
  kind: IssueDependencyKind;
  fromIssueId: string;
  toIssueId: string;
  otherIssueId: string;
  otherDisplayId: string | null;
  otherStatus: string | null;
  otherMergedAt: Date | null;
  otherDesignHold: string | null;
  validUntil: Date | null;
  expired: boolean;
  /** Whether this edge's KIND gates dispatch — only `blocks` does, whatever list it sits in. */
  gatesDispatch: boolean;
  /** A live edge of the gating kind: the only edge anything may call blocking. */
  blocking: boolean;
};

function digest(edge: IssueDependencyEdge, issueId: string): IssueRelationDigest {
  const outgoing = edge.fromIssueId === issueId;
  const gatesDispatch = edge.kind === DISPATCH_GATING_KIND;
  return {
    edgeId: edge.id,
    kind: edge.kind,
    fromIssueId: edge.fromIssueId,
    toIssueId: edge.toIssueId,
    otherIssueId: outgoing ? edge.toIssueId : edge.fromIssueId,
    otherDisplayId: outgoing ? edge.toDisplayId : edge.fromDisplayId,
    otherStatus: outgoing ? edge.toStatus : edge.fromStatus,
    otherMergedAt: outgoing ? edge.toMergedAt : edge.fromMergedAt,
    otherDesignHold: outgoing ? null : edge.fromDesignHold,
    validUntil: edge.validUntil,
    expired: edge.expired,
    gatesDispatch,
    blocking: gatesDispatch && !edge.expired,
  };
}

/** One kind's edges at an issue: `outgoing` from it, `incoming` to it. For `blocks`, outgoing is
 *  what this issue holds back and incoming is what holds this issue back. */
type IssueRelationDirections = {
  outgoing: IssueRelationDigest[];
  incoming: IssueRelationDigest[];
};

/** An issue's relations keyed by kind, every kind present, so a `relates` edge can never be read
 *  out of a list named for blocking. */
type IssueRelations = Record<IssueDependencyKind, IssueRelationDirections> & {
  /** Legacy: the live gating edges into this issue, for readers still on the old shape. */
  blockedBy: IssueRelationDigest[];
};

function emptyIssueRelations(): IssueRelations {
  const byKind = Object.fromEntries(
    issueDependencyKinds.map((kind) => [kind, { outgoing: [], incoming: [] }]),
  ) as unknown as Record<IssueDependencyKind, IssueRelationDirections>;
  return { ...byKind, blockedBy: [] };
}

/** Every edge of every kind and direction, for a reader that walks them all. */
export function allRelationDigests(relations: IssueRelations): IssueRelationDigest[] {
  return issueDependencyKinds.flatMap((kind) => [
    ...relations[kind].outgoing,
    ...relations[kind].incoming,
  ]);
}

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
  const out = new Map<string, IssueRelations>();
  for (const [issueId, { outgoing, incoming }] of edges) {
    const relations = emptyIssueRelations();
    for (const e of outgoing) relations[e.kind].outgoing.push(digest(e, issueId));
    for (const e of incoming) relations[e.kind].incoming.push(digest(e, issueId));
    // cm:hack plugin-followups.md "forge_issues get → relations is now keyed by kind" until:forge-plugin reads relations.<kind> (plugin-followups.md) — the pinned plugin reads `relations.blockedBy ?? []`, so its absence reads as "nothing blocks"; it holds ONLY live `blocks` edges, so the old key now tells the truth. A legacy `relations.blocks` array cannot be emitted: that key is the new shape's `blocks` kind, and no plugin reader reads it.
    relations.blockedBy = relations.blocks.incoming.filter((e) => e.blocking);
    out.set(issueId, relations);
  }
  return out;
}
/** One dependency edge by id, or null. */
export async function dependencyEdgeById(edgeId: string) {
  const [edge] = await db
    .select()
    .from(issueDependencies)
    .where(eq(issueDependencies.id, edgeId))
    .limit(1);
  return edge ?? null;
}

/** The live `blocks` edges out of the named blockers, each with its dependent's sequence number. */
export async function liveBlockedDependentsOf(blockerIds: string[]) {
  if (blockerIds.length === 0) return [];
  return db
    .select({
      fromIssueId: issueDependencies.fromIssueId,
      toIssueId: issueDependencies.toIssueId,
      depProjectId: issueDependencies.projectId,
      toIssSeq: issues.issSeq,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.toIssueId))
    .where(
      and(
        inArray(issueDependencies.fromIssueId, blockerIds),
        eq(issueDependencies.kind, 'blocks'),
        sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
      ),
    );
}
