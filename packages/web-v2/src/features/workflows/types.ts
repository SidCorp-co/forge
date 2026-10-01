export type WorkflowKind = "flow" | "state";
export type WorkflowStatus = "writing" | "current" | "rechecking";

export interface WorkflowCoverage {
  reading: "walked" | "not_walked" | "unmeasured";
  atSha: string | null;
}

export interface WorkflowEvidence {
  file: string;
  symbol?: string;
  annotation?: string;
  coverage: WorkflowCoverage;
}

export interface WorkflowStep {
  id: string;
  title?: string;
  does: string;
  status: WorkflowStatus;
  after: string[];
  evidence: WorkflowEvidence | null;
}

export interface WorkflowDocument {
  id: string;
  project: string;
  flow: string;
  kind: WorkflowKind;
  title: string;
  summary: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  drift: { sha: string; steps: string[]; reason: string } | null;
  writtenBy: { runId?: string; sessionId?: string; sha: string };
  refreshedAtSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  revision: number;
  writer: string;
  writerName: string;
  document: WorkflowDocument;
}

/** `GET /api/projects/:id/workflows`. */
export interface WorkflowList {
  workflows: WorkflowRecord[];
  returned: number;
}
