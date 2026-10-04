import type { ApprovalPermission } from "@forge/contracts/approval";
import type { DesignRevisionState } from "@forge/contracts/design-status";
import type {
  Boundary,
  FactRow,
  FocalSystem,
  GraphFacts,
  GraphNode,
  IntegrationState,
  NodeKind,
  Relationship,
  SystemGraph,
} from "@forge/contracts/system-graph";
import type { DesignBuildGate, DesignRequirementLink, DesignWaitingOn } from "@forge/contracts/workflows";

export type { DesignBuildGate, DesignRequirementLink, DesignRevisionState, DesignWaitingOn };
export type { Boundary, FactRow, FocalSystem, GraphFacts, GraphNode, IntegrationState, NodeKind, Relationship, SystemGraph };

/** Where core reads a system-context design's graph: one revision, and one whose removed steps it draws too. */
export interface SystemGraphRef {
  projectId: string;
  workflowId: string;
  revision: number;
  against?: number | null;
}

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

/** A node type is whatever the design's template declares (EVENT, STATE, SCREEN …). */
export type NodeType = string;

export interface WorkflowNode {
  type: NodeType;
  /** The short business title on the card; absent, the step's title. */
  label?: string;
  /** The band (or the design's lane) the step sits in; absent, its type's home band. */
  band?: string;
  purpose?: string;
  inputs?: string[];
  outputs?: string[];
  owner?: string;
  sla?: string;
  conditions?: { when: string; result: string }[];
  tests?: string[];
  expectedOutcome?: string;
  permissions?: string[];
  persona?: string;
  wireframe?: { attachment: string; svg?: string };
  dataShown?: string[];
  actions?: string[];
  trigger?: string;
  validation?: string;
  variant?: "empty" | "loading" | "error" | "success" | "partial";
  event?: string;
  route?: string;
  payload?: string[];
  idempotency?: string;
  values?: string[];
  mapsTo?: string;
  channel?: string;
  /** Steps of the project's other designs this one is. */
  refs?: { template: string; flow: string; step: string }[];
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
  /** One of the template's edge kinds; absent, the one its endpoint types imply. */
  kind?: string;
  from: string;
  to: string;
  /** The short business words on the line; absent, its condition. */
  label?: string;
  /** A return edge's re-evaluation: what it recomputes at the earlier step. */
  reevaluates?: string;
  condition?: string;
  action?: string;
  mapping?: Record<string, string>;
  idempotency?: string;
  onFailure?: string;
  payload?: string[];
  protocol?: string;
}

export interface WorkflowLane {
  id: string;
  label: string;
  tooltip?: string;
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
  /** Version 2: the diagram template the design is drawn in; a design stored before templates names none. */
  template?: { id: string; version: number };
  lanes?: WorkflowLane[];
  personas?: WorkflowLane[];
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
  /** `returnReason` is the approver's word on a returned design; the list only carries it then. */
  design: { status: DesignStatus | null; approvedRevision: number | null; returnReason?: string | null };
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
  state: DesignRevisionState;
}

/** `GET /api/projects/:id/workflows/:workflow/design`. */
export interface WorkflowDesign {
  workflowId: string;
  flow: string;
  status: DesignStatus | null;
  revision: number;
  proposedRevision: number | null;
  approvedRevision: number | null;
  /** The permission that decides this design (`workflow-designs.approve`, ADR 0007). */
  approver: ApprovalPermission;
  canDecide: boolean;
  waitingOn: DesignWaitingOn;
  revisions: DesignRevision[];
  builds: { issueId: string; displayId: string; title: string; status: string }[];
  gate: DesignBuildGate;
  requirements: DesignRequirementLink[];
}

export type DesignDecisionBody =
  | { revision: number; decision: "approve" }
  | { revision: number; decision: "return"; reason: string };

/** `GET /api/projects/:id/workflow-templates`. */
export interface WorkflowTemplateList {
  templates: { origin: "builtin" | "project"; template: import("@forge/contracts/workflow-templates").WorkflowTemplate }[];
  returned: number;
}
