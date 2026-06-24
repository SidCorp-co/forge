// web-v2 feature module: knowledge (user-provided sources → edge graph +
// ingest). Shapes verified against `packages/core/src/knowledge-edges/routes.ts`
// and `packages/core/src/knowledge/ingest-routes.ts` for ISS-299.
// Knowledge entries (ISS-566/P2): shapes mirrored verbatim from
// `packages/core/src/knowledge/service.ts` (NOT in @forge/contracts).

// --- Knowledge Entries (P1 REST /api/projects/:id/knowledge) ---

export type KnowledgeKind =
  | "overview"
  | "scenario"
  | "workflow"
  | "rule"
  | "guide"
  | "reference"
  | "glossary";

export type KnowledgeInjection = "always" | "on_demand" | "none";
export type KnowledgeConfidence = "verified" | "inferred" | "deprecated";
export type KnowledgeAuthoredBy = "human" | "agent" | "imported";

/** Body-free list row (GET /api/projects/:id/knowledge). */
export interface KnowledgeListRow {
  id: string;
  slug: string;
  kind: string;
  title: string;
  injection: string;
  confidence: string;
  authoredBy: string;
  orderIndex: number;
  updatedAt: string;
}

export interface ListKnowledgeResponse {
  rows: KnowledgeListRow[];
  truncated: boolean;
  returned: number;
  total: number;
}

/** Full entry with body (GET /api/projects/:id/knowledge/:slug). */
export interface KnowledgeEntry extends KnowledgeListRow {
  body: string;
  metadata: unknown;
  archivedAt: string | null;
  createdAt: string;
}

/** PUT /api/projects/:id/knowledge/:slug body. */
export interface UpsertKnowledgeBody {
  title: string;
  body: string;
  kind?: KnowledgeKind;
  injection?: KnowledgeInjection;
  confidence?: KnowledgeConfidence;
  authoredBy?: KnowledgeAuthoredBy;
  orderIndex?: number;
  metadata?: Record<string, unknown>;
}

export interface UpsertKnowledgeResult {
  id: string;
  slug: string;
  degraded: boolean;
  truncated: boolean;
}

// --- Knowledge Edges ---

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
