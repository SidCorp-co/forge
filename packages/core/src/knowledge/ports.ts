import type { ItemEmbeddingStatus } from '../db/schema-item-embeddings.js';
import type { ProjectReader } from '../lib/authz.js';
import { portSlot } from '../lib/port-slot.js';
import type { RecheckChange } from './recheck.js';

/** A recall request as the knowledge search route and `forge_knowledge search` take it. */
export interface KnowledgeRecallInput {
  projectId: string;
  /** Who reads: a memory hit's cite in a project they may not read is never read. */
  reader: ProjectReader;
  query: string;
  scope: 'knowledge' | 'memory' | 'all';
  topK?: number;
  strategy?: 'semantic' | 'keyword' | 'hybrid';
}

/** What recall answers: knowledge hits and memory hits, two lists never blended. */
export interface KnowledgeRecall {
  knowledge: { slug: string; kind: string; title: string; body: string }[];
  memory: { id: string; asOf: Date; text: string }[];
  degraded?: boolean;
}

/**
 * What knowledge reaches but does not own. Memory imports knowledge, the find door ranks it, and
 * requirements and feedback sit downstream (Product design after Knowledge), so knowledge names what it needs and the
 * composition root fills it at boot.
 */
export interface KnowledgePorts {
  /** Recall, as a filter of the find door (ISS-1256), which ranks knowledge beside every other type. */
  recall(input: KnowledgeRecallInput): Promise<KnowledgeRecall>;
  /** Flags the project's curated memories a change meets (REQ-89 BC-5); how many were flagged. */
  flagMemoryRecheck(projectId: string, change: RecheckChange): Promise<number>;
  /** Re-embeds a requirement from its owner's current head; null when it has none. */
  reembedRequirement(requirementId: string): Promise<ItemEmbeddingStatus | null>;
  /** Re-embeds a feedback item from its stored text; null when it is gone or redacted. */
  reembedFeedback(feedbackId: string): Promise<ItemEmbeddingStatus | null>;
  /** The module label a slug names in the project (ISS-1256); refused by name where none does. */
  moduleIdOf(projectId: string, slug: string): Promise<string>;
}

const slot = portSlot<KnowledgePorts>('knowledge', 'provideKnowledgePorts');
export const provideKnowledgePorts = slot.provide;
export const knowledgePort = slot.port;

/**
 * Recall through the find door (ISS-1256), for a module downstream of knowledge that reaches the door
 * only through knowledge's face: the room's how-to search.
 */
export const recallKnowledge = (input: KnowledgeRecallInput): Promise<KnowledgeRecall> =>
  knowledgePort('recall')(input);
