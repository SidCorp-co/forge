// web-v2 feature module: knowledge (user-provided sources → edge graph +
// ingest). Shapes verified against `packages/core/src/knowledge-edges/routes.ts`
// and `packages/core/src/knowledge/ingest-routes.ts` for ISS-299.

export interface KnowledgeEdge {
  id: string;
  projectId: string;
  subject: string;
  predicate: string;
  object: string;
  value: string | null;
  sourceMemoryId: string | null;
  confidence: number | null;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
}

/** One document for `POST /api/knowledge/ingest`. `content` ≤ 50KB. */
export interface IngestDocument {
  id: string;
  title: string;
  content: string;
  category?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  ok: boolean;
  processed: number;
  totalChunks: number;
  skipped: Array<{ id: string; reason: string }>;
}
