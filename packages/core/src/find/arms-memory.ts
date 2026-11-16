// The dense arms of the find door (ISS-1256), each over the vector store its records already keep:
// curated memory and decisions, and core's copies of the issues (`memories`, through memory's own
// search, its withholding, folding and standing included); requirements and feedback items
// (`item_embeddings`, knowledge's). No second store is written: an item with no vector is found by
// its keyword arm alone.

import { and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { type NearestItem, nearestItems } from '../knowledge/index.js';
import type { ProjectReader } from '../lib/authz.js';
import { env } from '../lib/env.js';
import { SEMANTIC_FLOOR } from '../lib/search-fusion.js';
import { runMemorySearch } from '../memory/index.js';
import {
  FEEDBACK_COLUMNS,
  feedbackCandidate,
  hydrateIssues,
  requirementCandidate,
} from './arms-records.js';
import { type Candidate, hitId } from './candidate.js';

type MemoryResult = Awaited<ReturnType<typeof runMemorySearch>>;
export type MemoryFound = MemoryResult['hits'][number];

/** What one memory read answered: its curated hits, its decisions, and the issues its copies name. */
export interface MemoryArm {
  memory: Candidate[];
  decisions: Candidate[];
  issues: Candidate[];
  degraded: boolean;
  result: MemoryResult | null;
}

/**
 * One project's memory read by both arms of memory's own search, so each arm ranks on its own score:
 * curated notes, policies and knowledge copies are memory, a recorded decision a decision, and core's
 * copy of an issue that issue. A dense hit under `SEMANTIC_FLOOR` is left out.
 */
export async function memoryArm(input: {
  projectId: string;
  query: string;
  queryVec: number[] | null;
  reader: ProjectReader;
  limit: number;
}): Promise<{ keyword: MemoryArm; semantic: MemoryArm | null }> {
  const read = (strategy: 'keyword' | 'semantic') =>
    runMemorySearch({
      projectId: input.projectId,
      query: input.query,
      topK: input.limit,
      strategy,
      ...(strategy === 'semantic' && input.queryVec ? { queryVec: input.queryVec } : {}),
      sourceFilter: ['note', 'knowledge', 'policy', 'decision', 'issue'],
      surface: 'web',
      reader: input.reader,
    });
  const [keyword, semantic] = await Promise.all([
    read('keyword'),
    input.queryVec ? read('semantic') : null,
  ]);
  return {
    keyword: await armOf(keyword, input.projectId, 'keyword'),
    semantic: semantic
      ? await armOf(
          { ...semantic, hits: semantic.hits.filter((h) => h.score >= SEMANTIC_FLOOR) },
          input.projectId,
          'semantic',
        )
      : null,
  };
}

async function armOf(
  result: MemoryResult,
  projectId: string,
  arm: Candidate['arm'],
): Promise<MemoryArm> {
  const curated = result.hits.filter((h) => h.source !== 'issue' && !h.via);
  const issueRefs = result.hits.filter((h) => h.source === 'issue').map((h) => h.sourceRef);
  const rows =
    issueRefs.length === 0
      ? []
      : await db
          .select({
            id: issues.id,
            projectId: issues.projectId,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            releaseBatchRunId: issues.releaseBatchRunId,
          })
          .from(issues)
          .where(inArray(issues.id, issueRefs));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = issueRefs.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const as = (type: 'memory' | 'decision') =>
    curated
      .filter((h) => (h.source === 'decision') === (type === 'decision'))
      .map((h) => ({ ...memoryCandidate(h, type, projectId), arm }));
  return {
    memory: as('memory'),
    decisions: as('decision'),
    issues: (await hydrateIssues(ordered, '')).map((c) => ({ ...c, arm })),
    degraded: result.degraded === true,
    result,
  };
}

function memoryCandidate(
  h: MemoryFound,
  type: 'memory' | 'decision',
  projectId: string,
): Candidate {
  const firstLine = h.text.split('\n')[0] ?? '';
  return {
    id: hitId(type, h.id),
    type,
    ref: h.id,
    key: null,
    title: firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine,
    text: h.text,
    projectId,
    status: h.standing,
    placed: null,
    score: h.score,
    arm: 'semantic',
    native: h,
  };
}

/** One project's requirements and feedback items nearest the query's vector. */
export async function itemArms(
  projectId: string,
  queryVec: number[],
  limit: number,
): Promise<{ requirements: Candidate[]; feedback: Candidate[] }> {
  const by = { projectId, vector: queryVec, model: env.EMBEDDINGS_MODEL, limit };
  const near = (n: { similarity: number }[]) => n.filter((x) => x.similarity >= SEMANTIC_FLOOR);
  const [reqNear, fbNear] = (
    await Promise.all([
      nearestItems({ ...by, kind: 'requirement' }),
      nearestItems({ ...by, kind: 'feedback' }),
    ])
  ).map(near) as [NearestItem[], NearestItem[]];
  const [reqRows, fbRows] = await Promise.all([
    reqNear.length === 0
      ? []
      : db
          .select({
            id: requirements.id,
            projectId: requirements.projectId,
            seq: requirements.reqSeq,
            title: requirements.title,
            status: requirements.status,
          })
          .from(requirements)
          .where(
            and(
              inArray(
                requirements.id,
                reqNear.map((n) => n.itemId),
              ),
            ),
          ),
    fbNear.length === 0
      ? []
      : db
          .select(FEEDBACK_COLUMNS)
          .from(feedback)
          .where(
            inArray(
              feedback.id,
              fbNear.map((n) => n.itemId),
            ),
          ),
  ]);
  const inOrder = <T extends { id: string }>(near: { itemId: string }[], rows: T[]) => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return near.flatMap((n) => {
      const r = byId.get(n.itemId);
      return r ? [r] : [];
    });
  };
  return {
    requirements: inOrder(reqNear, reqRows).map((r) => requirementCandidate(r, 'semantic')),
    feedback: inOrder(fbNear, fbRows).map((r) => feedbackCandidate(r, 'semantic')),
  };
}
