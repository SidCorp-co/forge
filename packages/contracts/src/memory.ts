// Contract types for the memory candidates (continuous-learning observer).
// Shapes verified against `packages/core/src/memory/candidates-routes.ts`.
import type { schema } from '@forge/core/public';

export type MemoryCandidate = typeof schema.memoryCandidates.$inferSelect;

export interface MemoryCandidateListResponse {
  items: MemoryCandidate[];
  totalCount: number;
}

export interface AcceptCandidateResponse {
  id: string;
  projectId: string;
  source: string;
  sourceRef: string;
}

export interface RejectCandidateResponse {
  rejected: boolean;
}
