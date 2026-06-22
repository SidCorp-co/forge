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
}

export interface MemorySearchResult {
  hits: MemorySearchHit[];
  model: string;
  took_ms: number;
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

// Memory candidates (continuous-learning observer).

export type MemoryCandidateSignalType =
  | "reopen_loop"
  | "repeated_fix_type"
  | "handoff_gap_rescue";

export type MemoryCandidateStatus = "accruing" | "graduated" | "accepted" | "rejected" | "promoted";

export interface EvidenceRef {
  runId: string;
  issueId: string;
  at: string;
}

export interface MemoryCandidate {
  id: string;
  projectId: string;
  signalType: MemoryCandidateSignalType;
  signalKey: string;
  status: MemoryCandidateStatus;
  confidence: string;
  evidenceCount: number;
  evidence: EvidenceRef[];
  summary: string;
  graduatedAt: string | null;
  reviewedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function signalTypeTone(
  signalType: MemoryCandidateSignalType,
): "neutral" | "accent" | "cobalt" | "green" | "amber" {
  switch (signalType) {
    case "reopen_loop":
      return "amber";
    case "repeated_fix_type":
      return "cobalt";
    case "handoff_gap_rescue":
      return "accent";
    default:
      return "neutral";
  }
}

export function signalTypeLabel(signalType: MemoryCandidateSignalType): string {
  switch (signalType) {
    case "reopen_loop":
      return "Reopen Loop";
    case "repeated_fix_type":
      return "Repeated Fix";
    case "handoff_gap_rescue":
      return "Handoff Gap";
    default:
      return signalType;
  }
}
