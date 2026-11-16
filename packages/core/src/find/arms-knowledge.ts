// The knowledge arms of the find door (ISS-1256): the projects' own entries and lessons and their
// orgs' rulings (REQ-89 BC-7, ISS-1121), one keyword order and one dense order. A glossary entry is a
// term, a `rule` entry or an org ruling a rule, a lesson a lesson, any other kind knowledge. This is
// the one knowledge recall: the knowledge search route and `forge_knowledge search` read it through
// `recall-filter.ts`, and a retired, superseded or withdrawn entry is never one of its hits.

import {
  type KnowledgeHit,
  keywordOrgRecall,
  keywordSearchKnowledge,
  type OrgRecallHit,
  searchKnowledge,
  semanticOrgRecall,
} from '../knowledge/index.js';
import { fuseHybrid } from '../lib/search-fusion.js';
import { type Candidate, hitId } from './candidate.js';

/** A knowledge hit as recall answers it: the project's own entry or lesson, or its org's ruling. */
export type KnowledgeRecallHit = (KnowledgeHit & { origin: 'project' }) | OrgRecallHit;

const own = (hits: KnowledgeHit[]) => hits.map((h) => ({ ...h, origin: 'project' as const }));

/** Cosine beside cosine is one kind of score: the dense order of both stores is by score. */
const byScore = (a: KnowledgeRecallHit[], b: KnowledgeRecallHit[], k: number) =>
  [...a, ...b].sort((x, y) => y.score - x.score).slice(0, k);

/**
 * Both stores by keyword, merged by rank, since a ts_rank of one store is no measure of the other's
 * (ISS-1142): fusing each store on its own capped a project hit at half an org hit's.
 */
export async function keywordKnowledge(
  projectIds: readonly string[],
  text: string,
  k: number,
): Promise<KnowledgeRecallHit[]> {
  const [mine, org] = await Promise.all([
    keywordSearchKnowledge(projectIds, text, k),
    keywordOrgRecall(projectIds, text, k),
  ]);
  return fuseHybrid<KnowledgeRecallHit>(own(mine), org, k);
}

/** Both stores by cosine to the query's vector, as close as `floor` at least. */
export async function semanticKnowledge(
  projectIds: readonly string[],
  queryVec: number[],
  k: number,
  floor = 0,
): Promise<KnowledgeRecallHit[]> {
  const [mine, org] = await Promise.all([
    searchKnowledge(projectIds, queryVec, k),
    semanticOrgRecall(projectIds, queryVec, k),
  ]);
  return byScore(own(mine), org ?? [], k).filter((h) => h.score >= floor);
}

const TYPE_OF_KIND = { glossary: 'term', rule: 'rule', lesson: 'lesson' } as const;

/** A knowledge hit as the door ranks it. */
export function knowledgeCandidate(h: KnowledgeRecallHit, arm: Candidate['arm']): Candidate {
  const org = h.origin === 'org';
  const type = org ? 'rule' : (TYPE_OF_KIND[h.kind as keyof typeof TYPE_OF_KIND] ?? 'knowledge');
  return {
    id: hitId(type, org ? `org:${h.id}` : h.id),
    type,
    ref: org ? `org:${h.id}` : h.id,
    key: h.slug,
    title: h.title,
    text: h.body,
    projectId: org ? null : h.projectId,
    status: h.recheckDue ? 'recheck owed' : 'in force',
    placed: org ? null : { kind: 'knowledge', id: h.id },
    score: h.score,
    arm,
    native: h,
  };
}
