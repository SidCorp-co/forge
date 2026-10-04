import type { DesignRevisionState } from "@forge/contracts/design-status";
import type { DesignBuildGate, DesignRequirementLink, DesignWaitingOn } from "@forge/contracts/workflows";

export type { DesignBuildGate, DesignRequirementLink, DesignRevisionState, DesignWaitingOn };

export type WorkflowKind = "flow" | "state";
export type DesignStatus = "draft" | "proposed" | "approved" | "returned";

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
  /** The contracts the step uses. */
  contracts?: { provider: string; slug: string }[];
  /** Steps of the project's other designs this one is. */
  refs?: { template: string; flow: string; step: string }[];
}

export interface WorkflowStep {
  id: string;
  title?: string;
  does: string;
  after: string[];
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
  steps: WorkflowStep[];
  /** Version 2: the diagram template the design is drawn in; a design stored before templates names none. */
  template?: { id: string; version: number };
  lanes?: WorkflowLane[];
  personas?: WorkflowLane[];
  edges?: WorkflowEdgeContract[];
  writtenBy: { runId?: string; sessionId?: string; sha?: string };
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
  approver: "owner" | "master";
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
