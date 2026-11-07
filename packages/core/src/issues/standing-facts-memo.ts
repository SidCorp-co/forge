// The facts of the issue standing read that are each issue's own, read once per issue in a request
// however many of its reads ask (`db/read-memo.ts:memoizedPerId`, ISS-1070).

import { db } from '../db/client.js';
import { memoizedPerId } from '../db/read-memo.js';
import { type BlockingEdge, blockingEdgesIn } from './blocked-by.js';
import { type CriteriaRaw, criteriaOf } from './standing-facts-read.js';

/**
 * `criteriaOf` per issue: each issue's live criteria are its own rows, so a request reading two
 * overlapping sets of issues (Needs you's open issues and the issues its requirements trace) reads
 * each issue's once (ISS-1070).
 */
export async function criteriaPerIssue(
  projectId: string,
  ids: readonly string[],
): Promise<CriteriaRaw[]> {
  const byIssue = await memoizedPerId(`standingCriteria:${projectId}`, ids, async (some) => {
    const out = new Map<string, CriteriaRaw[]>();
    for (const c of await criteriaOf(projectId, some))
      out.set(c.issue_id, [...(out.get(c.issue_id) ?? []), c]);
    return out;
  });
  return [...byIssue.values()].flat();
}

/**
 * `blockingEdgesIn` per issue: the live edges with either end among `ids`, each read once in a
 * request however many of its reads ask for it, in the order the statement sorts them (ISS-1070).
 */
export async function edgesPerIssue(
  projectId: string,
  ids: readonly string[],
): Promise<BlockingEdge[]> {
  const byIssue = await memoizedPerId(`blockingEdges:${projectId}`, ids, async (some) => {
    const out = new Map<string, BlockingEdge[]>();
    for (const e of await blockingEdgesIn(db, projectId, some))
      for (const id of new Set([e.fromId, e.toId]))
        if (some.includes(id)) out.set(id, [...(out.get(id) ?? []), e]);
    return out;
  });
  const edges = new Map([...byIssue.values()].flat().map((e) => [e.edgeId, e]));
  return [...edges.values()].sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq);
}
