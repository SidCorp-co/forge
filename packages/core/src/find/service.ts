// The one search door (ISS-1256): every arm of every record type run at once over the projects a
// reader reads, the query expanded through the glossary, the lists fused by reciprocal rank, then
// filtered, faceted and grouped. The REST find, `forge_find` and every search folded into this door
// read `runFind`, so a person and an agent get the same ranks. A find that matches nothing is
// recorded as a gap.

import type { FindQuery, FindResult, FindType } from '@forge/contracts/find';
import type { MemoryAuthoredSource } from '@forge/contracts/memory';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { queryVectorOf } from '../knowledge/index.js';
import type { ProjectReader } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { SEMANTIC_FLOOR } from '../lib/search-fusion.js';
import { recordFindMiss } from '../run-context/index.js';
import { keywordKnowledge, knowledgeCandidate, semanticKnowledge } from './arms-knowledge.js';
import { itemArms, type MemoryArm, memoryArm } from './arms-memory.js';
import {
  decisionArm,
  feedbackArm,
  issueArm,
  referenceArm,
  requirementArm,
} from './arms-records.js';
import { aliasArm, capabilityArm, conversationArm } from './arms-shared.js';
import type { ArmList, Candidate } from './candidate.js';
import { expandedPhrases, expandedText, expandThroughGlossary } from './expand.js';
import { glossaryTerms, moduleTree, type PlacedKind, placementsOf } from './model-reads.js';
import { type Fused, fuseArms, shapeResult } from './rank.js';

/**
 * Who a find reads for: a person or a token, or `own-project` for a filter read for no one person (an
 * issue list's text filter), where a memory hit's cite in another project is never read and no room's
 * transcript can be searched.
 */
export type FindReader = ProjectReader | 'own-project';

export interface FindInput {
  /** The project the find runs in: its hits open there, and a miss is its gap. */
  projectId: string;
  /** Every project searched; the memory, item and transcript arms read `projectId` alone. */
  projectIds: readonly string[];
  query: FindQuery;
  reader: FindReader;
  askedBy: 'person' | 'agent';
  /** False where the find spans projects none of which it ran for, so a miss is no one project's gap. */
  recordsGap?: boolean;
  /**
   * A filter of the door (`recall-filter.ts`, `memory-filter.ts`, `issue-filter.ts`): only the arms that can find a type `query.type` names run, so
   * the kept hits rank exactly as the whole door ranks them (a hit's fused score is summed from the
   * lists it is in, and no list of another type holds it), the facets count those arms alone, and a
   * miss is no gap, since the other types were never asked.
   */
  filterOnly?: boolean;
  /**
   * The curated sources the memory arm reads, where a memory filter names some (`memory-filter.ts`);
   * absent, every curated source and core's issue copies.
   */
  memorySources?: readonly MemoryAuthoredSource[];
}

/** What a find answered, and the fused candidates a filter of the door reads its own shape from. */
export interface FindOutcome {
  result: FindResult;
  fused: Fused[];
  /**
   * The fused candidates the query's type, module and status filters keep, best first, cut to its
   * limit: the hits `result` groups, in the door's order. Every filter of the door answers these.
   */
  kept: Fused[];
  memory: { keyword: MemoryArm; semantic: MemoryArm | null } | null;
  /** What the transcript arm could not show, where it ran. */
  limitation: string | null;
}

/** Each arm reads this many beyond the answer's limit, so the fusion has ranks to weigh. */
const armDepth = (limit: number) => Math.max(limit * 2, 20);

/** The query's vector, or null where no embedding could be made: the dense arms then sit out. */
async function vectorOf(projectId: string, q: string): Promise<number[] | null> {
  const vec = await queryVectorOf(q);
  if (!vec) logger.warn({ projectId }, 'find: embeddings unavailable, the dense arms sit out');
  return vec;
}

/** Every arm's ranked list, the knowledge and record arms over every project. */
/** The types each arm can find: a filter runs an arm only where one of them is asked. */
const ARM_TYPES = {
  knowledge: ['term', 'rule', 'lesson', 'knowledge'],
  issue: ['issue'],
  requirement: ['requirement'],
  feedback: ['feedback'],
  decision: ['decision'],
  reference: ['reference'],
  capability: ['capability'],
  memory: ['memory', 'decision', 'issue'],
  items: ['requirement', 'feedback'],
  conversation: ['conversation'],
  alias: ['term'],
} as const satisfies Record<string, readonly FindType[]>;
type ArmName = keyof typeof ARM_TYPES;

/** Whether an arm runs: always on the whole door, on a filter only where it can find an asked type. */
function runsOf(input: FindInput): (arm: ArmName) => boolean {
  const asked = input.query.type;
  if (!input.filterOnly || !asked?.length) return () => true;
  return (arm) => ARM_TYPES[arm].some((t) => asked.includes(t));
}

/** The arms that read the query's vector: a find running none of them embeds nothing. */
const DENSE_ARMS: readonly ArmName[] = ['knowledge', 'memory', 'items'];

async function armLists(
  input: FindInput,
  text: string,
  phrases: readonly string[],
  vec: number[] | null,
  alias: Candidate[],
): Promise<{
  lists: ArmList[];
  memory: FindOutcome['memory'];
  limitation: string | null;
}> {
  const { projectIds, projectId, query } = input;
  const k = armDepth(query.limit);
  const one = projectIds.length === 1;
  const runs = runsOf(input);
  const [kw, dense, iss, req, fb, dec, ref, mem, items, room] = await Promise.all([
    runs('knowledge') ? keywordKnowledge(projectIds, text, k) : [],
    runs('knowledge') && vec ? semanticKnowledge(projectIds, vec, k, SEMANTIC_FLOOR) : [],
    runs('issue') ? issueArm(projectIds, query.q, phrases, k) : [],
    runs('requirement') ? requirementArm(projectIds, query.q, phrases, k) : [],
    runs('feedback') ? feedbackArm(projectIds, query.q, phrases, k) : [],
    runs('decision') ? decisionArm(projectIds, phrases, k) : [],
    runs('reference') ? referenceArm(projectIds, phrases, k) : [],
    one && runs('memory')
      ? memoryArm({
          projectId,
          query: query.q,
          queryVec: vec,
          reader: input.reader,
          limit: k,
          ...(input.memorySources ? { sources: input.memorySources } : {}),
        })
      : null,
    one && vec && runs('items') ? itemArms(projectId, vec, k) : null,
    query.conversation && runs('conversation')
      ? conversationArm({
          conversationId: query.conversation,
          userId: readerUserId(input.reader, 'a room transcript'),
          projectId,
          query: query.q,
          limit: k,
        })
      : null,
  ]);
  const lists: ArmList[] = [
    { arm: 'keyword', hits: kw.map((h) => knowledgeCandidate(h, 'keyword')) },
    { arm: 'semantic', hits: dense.map((h) => knowledgeCandidate(h, 'semantic')) },
    { arm: 'keyword', hits: iss },
    { arm: 'keyword', hits: req },
    { arm: 'keyword', hits: fb },
    { arm: 'keyword', hits: dec },
    { arm: 'keyword', hits: ref },
    { arm: 'keyword', hits: runs('capability') ? capabilityArm(text, k) : [] },
    ...(mem
      ? [mem.keyword, mem.semantic].flatMap((m, i): ArmList[] => {
          const arm = i === 0 ? 'keyword' : 'semantic';
          return m
            ? [
                { arm, hits: m.memory },
                { arm, hits: m.decisions },
                { arm, hits: m.issues },
              ]
            : [];
        })
      : []),
    ...(items
      ? ([
          { arm: 'semantic', hits: items.requirements },
          { arm: 'semantic', hits: items.feedback },
        ] as ArmList[])
      : []),
    ...(room ? [{ arm: 'keyword' as const, hits: room.hits }] : []),
    { arm: 'alias', hits: runs('alias') ? alias : [] },
  ];
  return { lists, memory: mem, limitation: room?.limitation ?? null };
}

/** The module label each fused candidate is placed in, read per table. */
async function placementsFor(
  fused: readonly Fused[],
  projectId: string,
): Promise<Map<string, string>> {
  const byKind = new Map<PlacedKind, Fused[]>();
  for (const c of fused) {
    if (!c.placed) continue;
    byKind.set(c.placed.kind, [...(byKind.get(c.placed.kind) ?? []), c]);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...byKind].map(async ([kind, cs]) => {
      const ids = [...new Set(cs.map((c) => c.placed?.id ?? ''))];
      const held = await placementsOf(kind, ids, projectId);
      for (const c of cs) {
        const label = c.placed ? held.get(c.placed.id) : undefined;
        if (label) out.set(c.id, label);
      }
    }),
  );
  return out;
}

async function slugsOf(projectIds: readonly string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, [...projectIds]));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

/** The REST path that opens a hit in the project a find ran in. */
export const openPathOf = (projectId: string, id: string) =>
  `/api/projects/${projectId}/find/open?id=${encodeURIComponent(id)}`;

/** The user a reader is; refused by name where a filter read for no one person asks for one. */
function readerUserId(reader: FindReader, what: string): string {
  if (reader === 'own-project') {
    throw new Error(`find: ${what} is read for a person, and this find reads for no one`);
  }
  return reader.userId;
}

/** One find over the door, answered whole. */
export async function runFind(input: FindInput): Promise<FindOutcome> {
  const { projectId, projectIds, query } = input;
  const named = expandThroughGlossary(query.q, await glossaryTerms(projectIds));
  const text = expandedText(query.q, named);
  const phrases = expandedPhrases(query.q, named);
  const runs = runsOf(input);
  const vec = DENSE_ARMS.some(runs) ? await vectorOf(projectId, query.q) : null;
  const alias = aliasArm(named.map((n) => ({ term: n.term, alias: n.expansion.alias })));
  const { lists, memory, limitation } = await armLists(input, text, phrases, vec, alias);
  const fused = fuseArms(lists);
  const [modules, placements, projectSlugs] = await Promise.all([
    moduleTree(projectIds),
    placementsFor(fused, projectId),
    slugsOf(projectIds),
  ]);
  const shaped = shapeResult(fused, query, {
    modules,
    placements,
    projectSlugs,
    openPath: (id) => openPathOf(projectId, id),
  });
  const gap = fused.length === 0;
  if (gap && input.recordsGap !== false && !input.filterOnly) {
    recordFindMiss({
      projectId,
      query: query.q,
      askedBy: input.askedBy,
      userId: input.reader === 'own-project' ? null : input.reader.userId,
    });
  }
  const keptIds = new Set(shaped.groups.flatMap((g) => g.hits.map((h) => h.id)));
  return {
    result: {
      query: query.q,
      expanded: named.map((n) => n.expansion),
      ...shaped,
      degraded: vec === null && DENSE_ARMS.some(runs),
      gap,
    },
    fused,
    kept: fused.filter((c) => keptIds.has(c.id)),
    memory,
    limitation,
  };
}
