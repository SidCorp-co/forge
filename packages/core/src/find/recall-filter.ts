// Recall as a filter of the find door (ISS-1256): what `POST /api/projects/:id/knowledge/search` and
// `forge_knowledge search` answer is the door's own knowledge filter and memory filter, in the door's
// order, each list cut to `topK`, in the shape those callers read (two lists, never blended). No
// strategy is taken: the door ranks every search one way, its keyword and dense arms fused by rank.

import type { FindType } from '@forge/contracts/find';
import type { ProjectReader } from '../lib/authz.js';
import { clampTopK } from '../lib/search-fusion.js';
import type { KnowledgeRecallHit } from './arms-knowledge.js';
import type { MemoryFound } from './arms-memory.js';
import type { Fused } from './rank.js';
import { runFind } from './service.js';

/** The types a knowledge recall answers: the project's entries and lessons, its org's rulings. */
export const KNOWLEDGE_FIND_TYPES = [
  'term',
  'rule',
  'lesson',
  'knowledge',
] as const satisfies readonly FindType[];

/** The types a memory recall answers: curated notes, policies, knowledge copies and decisions. */
export const MEMORY_FIND_TYPES = ['memory', 'decision'] as const satisfies readonly FindType[];

export interface FindRecallInput {
  projectId: string;
  /** Who reads: a memory hit's cite in a project they may not read is never read (REQ-30 BC-10). */
  reader: ProjectReader;
  query: string;
  scope: 'knowledge' | 'memory' | 'all';
  topK?: number;
}

/** A glossary term the query named by one of its aliases alone, which no store read returned. */
interface AliasTerm {
  id: string;
  origin: 'project';
  projectId: string;
  slug: string;
  kind: 'glossary';
  title: string;
  body: string;
}

/** A hit carries the door's fused score: read the order, never the value. */
type KnowledgeRecalled = (KnowledgeRecallHit | AliasTerm) & { score: number };
type MemoryRecalled = MemoryFound & { origin: 'memory'; score: number };

export interface FindRecall {
  knowledge: KnowledgeRecalled[];
  memory: MemoryRecalled[];
  degraded?: boolean;
}

/**
 * A term the glossary named by its alias alone carries no store hit: it is answered from the
 * candidate the alias arm made, as the project's own glossary entry.
 */
function knowledgeOf(c: Fused): KnowledgeRecalled {
  const held = c.native as KnowledgeRecallHit | undefined;
  if (held) return { ...held, score: c.score };
  return {
    id: c.ref,
    origin: 'project',
    projectId: c.projectId ?? '',
    slug: c.key ?? c.ref,
    kind: 'glossary',
    title: c.title,
    body: c.text,
    score: c.score,
  };
}

/** One list: the door's filter over `types`, its kept hits. */
async function filtered(input: FindRecallInput, types: readonly FindType[], limit: number) {
  return runFind({
    projectId: input.projectId,
    projectIds: [input.projectId],
    query: { q: input.query, type: [...types], limit },
    reader: input.reader,
    askedBy: 'agent',
    filterOnly: true,
  });
}

/** The project's knowledge, its org's rulings and its curated memory, recalled for one query. */
export async function recallThroughFind(input: FindRecallInput): Promise<FindRecall> {
  const k = clampTopK(input.topK);
  const [knowledge, memory] = await Promise.all([
    input.scope !== 'memory' ? filtered(input, KNOWLEDGE_FIND_TYPES, k) : null,
    input.scope !== 'knowledge' ? filtered(input, MEMORY_FIND_TYPES, k) : null,
  ]);
  const degraded = [knowledge, memory].some((f) => f?.result.degraded === true);
  return {
    knowledge: knowledge?.kept.map(knowledgeOf) ?? [],
    memory:
      memory?.kept.map((c) => ({
        ...(c.native as MemoryFound),
        origin: 'memory' as const,
        score: c.score,
      })) ?? [],
    ...(degraded ? { degraded: true } : {}),
  };
}
