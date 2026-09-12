// web-v2 feature module: memory (system breadcrumbs). Shapes verified against
// `packages/core/src/memory/{list-routes,search-routes}.ts` for ISS-299.
export type MemorySource =
  | "issue"
  | "comment"
  | "job"
  | "note"
  | "decision"
  | "policy"
  | "knowledge";

export const MEMORY_SOURCES: MemorySource[] = [
  "issue",
  "comment",
  "job",
  "note",
  "decision",
  "policy",
  "knowledge",
];

/** Row from `GET /api/memory` (the `embedding` vector is omitted client-side). */
export interface MemoryRow {
  id: string;
  projectId: string;
  source: MemorySource;
  sourceRef: string | null;
  textContent: string;
  metadata: Record<string, unknown> | null;
  embeddedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Hit from `POST /api/memory/search` — note `text` (not `textContent`). */
export interface MemorySearchHit {
  id: string;
  source: MemorySource;
  sourceRef: string | null;
  text: string;
  metadata: Record<string, unknown> | null;
  score: number;
  embeddedAt: string | null;
  /** Set on a row relation expansion appended: it neighbours the `from` issue hit rather than matching the query. */
  via?: { relation: "blocks" | "relates"; from: string };
  /** On a chunked project, the passage that matched — shown instead of the head of a long body. */
  matchedChunk?: { index: number; text: string };
}

export interface MemorySearchResult {
  hits: MemorySearchHit[];
  model: string;
  took_ms: number;
  /** True when rows carrying `via` were appended after the ranked hits. */
  expanded?: boolean;
}

/** Badge tone per source — keeps the source legible at a glance. */
export function sourceTone(
  source: MemorySource,
): "neutral" | "accent" | "cobalt" | "green" | "amber" {
  switch (source) {
    case "decision":
    case "policy":
      return "amber";
    case "issue":
    case "comment":
      return "cobalt";
    case "knowledge":
      return "green";
    case "note":
      return "accent";
    default:
      return "neutral";
  }
}
