import type { ApprovalPermission } from "@forge/contracts/permissions";
import type { DesignRevisionState } from "@forge/contracts/design-status";
import type { DesignListReading } from "@forge/contracts/workflows";
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
import type { WaitingOn } from "@forge/contracts/standing";
import type { WorkflowHealthSummary } from "@forge/contracts/workflow-health";
import type { DesignApprovalBlock, DesignBuild, DesignBuildGate, DesignLeftStale, DesignRequirementLink, DesignWaitingKind, PinOnlyChange, RevisionChanges } from "@forge/contracts/workflows";

export type { DesignBuildGate, DesignRequirementLink, PinOnlyChange };
export type { RepinActResult, RepinItem, RepinPlan, RepinRefused } from "@forge/contracts/workflows";
export type { Boundary, FactRow, FocalSystem, GraphFacts, GraphNode, IntegrationState, NodeKind, Relationship, SystemGraph };

/** Where core reads a system-context design's graph: one revision, and one whose removed steps it draws too. */
export interface SystemGraphRef {
  projectId: string;
  workflowId: string;
  revision: number;
  against?: number | null;
}

export type WorkflowKind = "flow" | "state";
export type DesignStatus = "draft" | "proposed" | "approved" | "returned";

/** A node type is whatever the design's template declares (EVENT, STATE, SCREEN …). */
type NodeType = string;

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
  /** The contract elements a screen binds (`pins`). */
  binds?: { provider: string; slug: string; element: string }[];
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
  /** The diagram template the design is drawn in. */
  template: { id: string; version: number };
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
  design: DesignListReading & { status: DesignStatus | null; approvedRevision: number | null; returnReason?: string | null };
  document: WorkflowDocument;
  /** The design's marker counts and needs-you figure, from core's health read model (workflow-step-health `d-list-summary`). */
  health: WorkflowHealthSummary;
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
  /** Against the revision before it, as core diffed them; null on the first. */
  changes: RevisionChanges | null;
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
  waitingOn: WaitingOn<DesignWaitingKind>;
  revisions: DesignRevision[];
  builds: DesignBuild[];
  gate: DesignBuildGate;
  requirements: DesignRequirementLink[];
  /** The refusal approving the proposed revision would meet on its bases now, with its facts; null when none. */
  approvalBlocked: DesignApprovalBlock | null;
  /** The designs approving the proposed revision leaves on a stale base. */
  approvalLeavesStale: DesignLeftStale[];
  /** The proposed revision against the approved one, where only the base revisions it pins differ; null otherwise. */
  pinOnly: PinOnlyChange | null;
}

/** `POST …/design/repins`: the base revision the plan was read at, and each design to take at the revision it was read at. */
export interface RepinActBody {
  revision: number;
  designs: { workflowId: string; revision: number }[];
}

/** An approval may carry its approver's note (its conditions); a return always carries its reason. */
export type DesignDecisionBody =
  | { revision: number; decision: "approve"; reason?: string }
  | { revision: number; decision: "return"; reason: string };

/** `GET /api/projects/:id/workflow-templates`. */
export interface WorkflowTemplateList {
  templates: { origin: "builtin" | "project"; template: import("@forge/contracts/workflow-templates").WorkflowTemplate }[];
  returned: number;
}
