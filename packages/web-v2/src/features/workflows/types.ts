export type WorkflowKind = "flow" | "state";
export type WorkflowStatus = "writing" | "current" | "rechecking" | "designed";
export type DesignStatus = "draft" | "proposed" | "approved" | "returned";

export interface WorkflowCoverage {
  reading: "walked" | "not_walked" | "unmeasured";
  atSha: string | null;
}

export interface RepoEvidence {
  kind?: "repo";
  file: string;
  symbol?: string;
  annotation?: string;
  coverage: WorkflowCoverage;
}

export interface StorefrontEvidence {
  kind: "storefront";
  provider: string;
  ref: "workflow" | "route" | "node";
  id: string;
  coverage?: WorkflowCoverage;
}

export type WorkflowEvidence = RepoEvidence | StorefrontEvidence;

export type NodeType =
  | "EVENT"
  | "CONTEXT"
  | "RULE"
  | "STATE"
  | "EXPECTATION"
  | "CASE"
  | "TASK"
  | "ATTENTION"
  | "ACTION"
  | "OUTCOME"
  | "STEP";

export interface WorkflowNode {
  type: NodeType;
  purpose?: string;
  inputs?: string[];
  outputs?: string[];
  owner?: string;
  sla?: string;
}

export interface WorkflowStep {
  id: string;
  title?: string;
  does: string;
  status: WorkflowStatus;
  after: string[];
  evidence: WorkflowEvidence | null;
  node?: WorkflowNode;
}

export interface WorkflowEdgeContract {
  /** `flow` (the default) is a line `after` draws; `feedback` returns from a later step to an earlier one. */
  kind?: "flow" | "feedback";
  from: string;
  to: string;
  /** A feedback edge's re-evaluation: what the return recomputes at the earlier step. */
  reevaluates?: string;
  condition?: string;
  action?: string;
  mapping?: Record<string, string>;
  idempotency?: string;
  onFailure?: string;
}

export interface WorkflowBody {
  version: 1 | 2;
  project: string;
  flow: string;
  kind: WorkflowKind;
  title: string;
  summary: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  edges?: WorkflowEdgeContract[];
  drift: { sha: string; steps: string[]; reason: string } | null;
  writtenBy: { runId?: string; sessionId?: string; sha?: string };
  refreshedAtSha: string | null;
}

export interface WorkflowDocument extends WorkflowBody {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  revision: number;
  writer: string;
  writerName: string;
  design: { status: DesignStatus | null; approvedRevision: number | null };
  document: WorkflowDocument;
}

/** `GET /api/projects/:id/workflows`. */
export interface WorkflowList {
  workflows: WorkflowRecord[];
  returned: number;
}

export interface DesignRevision {
  revision: number;
  document: WorkflowBody;
  proposedBy: string;
  proposedByName: string | null;
  proposedAt: string;
  decision: "approve" | "return" | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  reason: string | null;
}

/** `GET /api/projects/:id/workflows/:workflow/design`. */
export interface WorkflowDesign {
  workflowId: string;
  flow: string;
  status: DesignStatus | null;
  revision: number;
  proposedRevision: number | null;
  approvedRevision: number | null;
  approver: "owner" | "master";
  canDecide: boolean;
  revisions: DesignRevision[];
  builds: { issueId: string; displayId: string; title: string; status: string }[];
}

export type DesignDecisionBody =
  | { revision: number; decision: "approve" }
  | { revision: number; decision: "return"; reason: string };
