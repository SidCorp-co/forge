
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
  /** Char budget for the SUM of always-inject bodies (warn-on-overflow). Served
   *  rather than mirrored: core owns the number. */
  maxAlwaysInjectChars: number;
  /** What always-inject does and does not promise, for the owner setting it.
   *  Served rather than copied — core may not value-import `@forge/contracts`
   *  and web-v2 cannot import core, so a string both sides must agree on
   *  otherwise lives twice behind a parity test. */
  alwaysInjectGuarantee: string;
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

/** ISS-950 — the four generated module diagrams. `mermaid` is the whole diagram; there is no partial one. */
export const MODULE_DIAGRAM_KINDS = ["mindmap", "context", "user-flow", "swimlane"] as const;
export type ModuleDiagramKind = (typeof MODULE_DIAGRAM_KINDS)[number];

export interface ModuleDiagram {
  kind: ModuleDiagramKind;
  mermaid: string;
  moduleCount: number;
  generatedAt: string;
}
