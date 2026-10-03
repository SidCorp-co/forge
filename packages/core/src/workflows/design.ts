import { createHash } from 'node:crypto';
import {
  bandOfNode,
  LEGACY_V2_TEMPLATE,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import type { OrgMemberRole, ProjectMemberRole } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { agencyMiss, approverRule } from '../lib/agency-gate.js';
import type { DesignApprover } from '../project-config/schema.js';
import { impliedKind } from './edges.js';
import { stepsOf, type WorkflowWrite } from './schema.js';

export const DESIGN_STATUSES = ['draft', 'proposed', 'approved', 'returned'] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const DESIGN_DECISIONS = ['approve', 'return'] as const;
export type DesignDecision = (typeof DESIGN_DECISIONS)[number];

export const DESIGN_REASON_MAX = 2000;

export type DesignRefusalCode =
  | 'WORKFLOW_DESIGN_APPROVER_NOT_PERSON'
  | 'WORKFLOW_DESIGN_APPROVER_NOT_ADMIN'
  | 'WORKFLOW_DESIGN_APPROVER_NOT_PROJECT'
  | 'WORKFLOW_DESIGN_NOT_PROPOSED'
  | 'WORKFLOW_DESIGN_REVISION_STALE'
  | 'WORKFLOW_DESIGN_REASON_MISSING'
  | 'WORKFLOW_DESIGN_ALREADY_PROPOSED'
  | 'WORKFLOW_DESIGN_ALREADY_APPROVED'
  | 'WORKFLOW_DESIGN_UNCHANGED'
  | 'WORKFLOW_DESIGN_NOT_APPROVED'
  | 'WORKFLOW_DESIGN_ISSUE_IS_BUILD'
  | 'WORKFLOW_BUILD_ALREADY_LINKED'
  | 'WORKFLOW_BUILD_NOT_LINKED';

export interface DesignRefusal {
  code: DesignRefusalCode;
  path: string;
  detail: string;
}

/**
 * The part of a workflow its approver decides: the template it is drawn in, the steps, their order,
 * their nodes (business labels and bands included) and the edge contracts, return edges included.
 * Written defaults fingerprint as absent — an edge of the kind its endpoint types imply, a node in its
 * type's home band, a design in `operational-flow@1` — so a design stored before kinds, bands or
 * templates keeps the fingerprint it was approved at when its writer spells the default out.
 * Status, evidence, coverage, drift and the commit a reading was taken at are the code's reading
 * of itself, so a refresh after the build moves none of this and needs no new approval.
 */
export function designFingerprint(doc: WorkflowWrite, template: WorkflowTemplate | null): string {
  const nodeShape = (
    node: NonNullable<Extract<WorkflowWrite, { version: 2 }>['steps'][number]['node']>,
  ) => {
    if (!template || node.band === undefined) return node;
    const home = bandOfNode(template, { type: node.type });
    if (home !== node.band) return node;
    const { band, ...rest } = node;
    void band;
    return rest;
  };
  const steps = stepsOf(doc).map((s) => ({
    id: s.id,
    title: s.title ?? null,
    does: s.does,
    after: [...s.after].sort(),
    node: 'node' in s && s.node ? nodeShape(s.node) : null,
  }));
  const implied = (e: { from: string; to: string }) => {
    if (doc.version !== 2 || !template) return null;
    const k = impliedKind(doc, template, e.from, e.to);
    return 'kind' in k ? k.kind : null;
  };
  const edges =
    doc.version === 2
      ? [...(doc.edges ?? [])]
          .map(({ kind, ...e }) => (kind === undefined || kind === implied(e) ? e : { kind, ...e }))
          .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
      : [];
  const legacy =
    doc.version !== 2 ||
    (doc.template.id === LEGACY_V2_TEMPLATE.id &&
      doc.template.version === LEGACY_V2_TEMPLATE.version);
  const shape = {
    kind: doc.kind,
    title: doc.title,
    summary: doc.summary,
    steps,
    edges,
    ...(legacy || doc.version !== 2 ? {} : { template: doc.template }),
    ...(doc.version === 2 && doc.lanes ? { lanes: doc.lanes } : {}),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/** A new document on a workflow in the lifecycle: a design change after a decision is proposed again. */
export function designStatusAfterWrite(
  status: DesignStatus | null,
  designChanged: boolean,
): { status: DesignStatus | null; proposes: boolean } {
  if (!designChanged || status === null || status === 'draft') return { status, proposes: false };
  return { status: 'proposed', proposes: true };
}

/** The lifecycle a workflow enters when it is first written: a version 2 document is a design. */
export const designStatusAtCreate = (doc: WorkflowWrite): DesignStatus | null =>
  doc.version === 2 ? 'draft' : null;

export function proposeRefusal(
  status: DesignStatus | null,
  workflowId: string,
): DesignRefusal | null {
  if (status === null || status === 'draft') return null;
  const detail: Record<Exclude<DesignStatus, 'draft'>, [DesignRefusalCode, string]> = {
    proposed: [
      'WORKFLOW_DESIGN_ALREADY_PROPOSED',
      `workflow ${workflowId} is already awaiting its approver; a revised design is proposed by writing it (PUT), which supersedes the one waiting.`,
    ],
    approved: [
      'WORKFLOW_DESIGN_ALREADY_APPROVED',
      `workflow ${workflowId}'s design is approved as it stands; a change to it is proposed by writing it (PUT), and goes back to its approver.`,
    ],
    returned: [
      'WORKFLOW_DESIGN_UNCHANGED',
      `workflow ${workflowId}'s design was returned and has not changed since; revise it by writing it (PUT), which proposes the revision.`,
    ],
  };
  const [code, text] = detail[status];
  return { code, path: '/design/status', detail: text };
}

export interface ApproverFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
  orgRole: OrgMemberRole | null;
}

// cm:why the owner approves a design before anything is built from it, and may later hand that to the project's own master (`workflows.designApprover: master`); a person deciding is an org admin, so a person approving a proposal is never a member waving work through
export function designApproverRefusal(
  facts: ApproverFacts,
  projectId: string,
  approver: DesignApprover,
): DesignRefusal | null {
  const miss = agencyMiss(facts, approverRule(approver === 'master'));
  if (!miss) return null;
  switch (miss.kind) {
    case 'agent-not-allowed':
      return {
        code: 'WORKFLOW_DESIGN_APPROVER_NOT_PERSON',
        path: '',
        detail: `agent ${facts.userId} acts as an agent; project ${projectId} declares workflows.designApprover "owner", so only an org admin person decides its designs. The owner sets it to "master" (PUT /api/projects/${projectId}/config) to let the project's master decide.`,
      };
    case 'agent-below-member':
      return {
        code: 'WORKFLOW_DESIGN_APPROVER_NOT_PROJECT',
        path: '',
        detail: `agent ${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; with workflows.designApprover "master" a design is decided by that project's own master, never another project's agent.`,
      };
    default:
      return {
        code: 'WORKFLOW_DESIGN_APPROVER_NOT_ADMIN',
        path: '',
        detail: `${facts.userId} holds ${facts.orgRole ?? 'no role'} in project ${projectId}'s organization; a person deciding a workflow design is an org owner or admin.`,
      };
  }
}

export function decisionRefusals(input: {
  status: DesignStatus | null;
  proposedRevision: number | null;
  revision: number;
  decision: DesignDecision;
  reason: string | null;
}): DesignRefusal[] {
  if (input.status !== 'proposed' || input.proposedRevision === null) {
    return [
      {
        code: 'WORKFLOW_DESIGN_NOT_PROPOSED',
        path: '/revision',
        detail: `this design is ${input.status ?? 'not in a design lifecycle'}; only a proposed design is approved or returned.`,
      },
    ];
  }
  const out: DesignRefusal[] = [];
  if (input.revision !== input.proposedRevision) {
    out.push({
      code: 'WORKFLOW_DESIGN_REVISION_STALE',
      path: '/revision',
      detail: `revision ${input.revision} is not the one awaiting a decision; revision ${input.proposedRevision} is. Read it, then decide that one.`,
    });
  }
  if (input.decision === 'return' && !input.reason?.trim()) {
    out.push({
      code: 'WORKFLOW_DESIGN_REASON_MISSING',
      path: '/reason',
      detail: 'a returned design says why, so its master knows what to revise.',
    });
  }
  return out;
}

export function designNotApprovedDetail(args: {
  issue: string;
  workflowId: string;
  flow: string;
  status: DesignStatus | null;
}): string {
  return `${args.issue} builds workflow "${args.flow}" (${args.workflowId}), whose design is ${args.status ?? 'not in a design lifecycle'}; work that builds a flow starts only once its design is approved. Propose it (POST …/workflows/${args.workflowId}/design/propose) and wait for its approver.`;
}

/** Dispatch of an issue that builds a workflow whose design is not approved, refused by name. */
export class WorkflowDesignNotApprovedError extends Error {
  readonly code = 'WORKFLOW_DESIGN_NOT_APPROVED' as const;
  readonly blocked: { issue: string; workflowId: string; flow: string; status: string | null }[];

  constructor(
    blocked: { issue: string; workflowId: string; flow: string; status: DesignStatus | null }[],
  ) {
    super(`WORKFLOW_DESIGN_NOT_APPROVED: ${blocked.map(designNotApprovedDetail).join(' ')}`);
    this.name = 'WorkflowDesignNotApprovedError';
    this.blocked = blocked;
  }
}
