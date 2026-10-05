import type { ItemEmbeddingStatus } from '../db/schema-item-embeddings.js';
import { portSlot } from '../lib/port-slot.js';

interface MemorySearchInput {
  projectId: string;
  query: string;
  queryVec?: number[];
  topK: number | undefined;
  strategy: 'semantic' | 'keyword' | 'hybrid';
  surface: 'agent';
}

/**
 * What knowledge reaches but does not own. Memory imports knowledge, and requirements and feedback
 * sit downstream (Product design after Knowledge), so knowledge names what it needs and the
 * composition root fills it at boot.
 */
export interface KnowledgePorts {
  /** Memory search; knowledge labels each hit and reads nothing else of it. */
  searchMemory(input: MemorySearchInput): Promise<{ hits: { id: string }[]; degraded?: boolean }>;
  /** Re-embeds a requirement from its owner's current head; null when it has none. */
  reembedRequirement(requirementId: string): Promise<ItemEmbeddingStatus | null>;
  /** Re-embeds a feedback item from its stored text; null when it is gone or redacted. */
  reembedFeedback(feedbackId: string): Promise<ItemEmbeddingStatus | null>;
}

const slot = portSlot<KnowledgePorts>('knowledge', 'provideKnowledgePorts');
export const provideKnowledgePorts = slot.provide;
export const knowledgePort = slot.port;
