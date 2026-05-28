/**
 * Memory feature types — mirror of the core `memories` table shape.
 *
 * The source enum and row shape track `packages/core/src/db/schema.ts`
 * (`memorySources`) and `packages/core/src/memory/get-service.ts` (`MemoryRow`)
 * / `search.ts` (`MemoryHit`). Keep the source order in sync with the core enum.
 */

export const MEMORY_SOURCES = [
  'issue',
  'comment',
  'job',
  'note',
  'knowledge',
  'decision',
  'policy',
] as const;

export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** One row from `GET /api/memory` (mirrors core `MemoryRow`). */
export interface MemoryRow {
  id: string;
  projectId: string;
  source: MemorySource;
  sourceRef: string;
  textContent: string;
  metadata: Record<string, unknown> | null;
  embeddedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** One hit from `POST /api/memory/search` (mirrors core `MemoryHit`). */
export interface MemoryHit {
  id: string;
  source: MemorySource;
  sourceRef: string;
  text: string;
  metadata: Record<string, unknown> | null;
  score: number;
  embeddedAt: string;
}
