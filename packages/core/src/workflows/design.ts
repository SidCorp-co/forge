import { createHash } from 'node:crypto';
import type { DesignStatus } from '@forge/contracts/design-status';
import {
  bandOfNode,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import type { DesignRefusalCode } from '@forge/contracts/workflows';
import { RefusalError } from '../lib/refusal.js';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';
import { impliedKind } from './edges.js';
import { stepsOf, type WorkflowWrite } from './schema.js';

export const DESIGN_DECISIONS = ['approve', 'return'] as const;
export type DesignDecision = (typeof DESIGN_DECISIONS)[number];

export interface DesignRefusal {
  code: DesignRefusalCode;
  path: string;
  detail: string;
  /** The facts a decision refusal is worded from, beside its detail, so a client words it in its own language. */
  status?: DesignStatus | null;
  revision?: number;
  proposedRevision?: number;
}

/**
 * The issue the latest revision to name one was drawn under, where it is no longer work: `revision`
 * is that revision and `superseded` the newest, which the write supersedes and which may name none.
 */
export interface LapsedDesignIssue {
  issueId: string;
  key: string;
  status: string;
  revision: number;
  superseded: number;
}

/**
 * A write that proposes a revision and names no issue, where the latest revision to name one was
 * drawn under an issue now closed or dropped: storing none would leave a return nothing to reopen
 * (FB-54). The detail names the revision that carries the issue, which is not the superseded one
 * where later revisions were stored with none (patient-data-flow r8).
 */
export function designIssueLapsedRefusal(
  flow: string,
  lapsed: LapsedDesignIssue,
): DesignRefusal & { code: 'WORKFLOW_DESIGN_ISSUE_REQUIRED' } {
  const drawn = `was drawn under ${lapsed.key}, which is ${lapsed.status}`;
  const history =
    lapsed.revision === lapsed.superseded
      ? `revision ${lapsed.revision}, the one it supersedes, ${drawn}`
      : `revision ${lapsed.superseded}, the one it supersedes, names no issue, and revision ${lapsed.revision}, the latest that named one, ${drawn}`;
  return {
    code: 'WORKFLOW_DESIGN_ISSUE_REQUIRED',
    path: '/issue',
    detail: `this write proposes a new revision of workflow ${flow}'s design and names no issue; ${history}, so the new one would be drawn under no issue and a return would reopen nothing. Name the issue drawing this revision with \`issue\` (beside \`baseRevision\` on a PUT); nothing was written.`,
  };
}

/**
 * The part of a workflow its approver decides: the template it is drawn in, the steps, their order,
 * their nodes (business labels and bands included) and the edge contracts, return edges included.
 * Written defaults fingerprint as absent — an edge of the kind its endpoint types imply, a node in its
 * type's home band — so a design stored before kinds or bands keeps the fingerprint it was approved
 * at when its writer spells the default out.
 * What the code holds is an observation stored apart (observations.ts), so reading the code moves
 * none of this and needs no new approval.
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
    node: s.node ? nodeShape(s.node) : null,
  }));
  const implied = (e: { from: string; to: string }) => {
    if (!template) return null;
    const k = impliedKind(doc, template, e.from, e.to);
    return 'kind' in k ? k.kind : null;
  };
  const edges = [...(doc.edges ?? [])]
    .map(({ kind, ...e }) => (kind === undefined || kind === implied(e) ? e : { kind, ...e }))
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  const shape = {
    kind: doc.kind,
    title: doc.title,
    summary: doc.summary,
    steps,
    edges,
    template: doc.template,
    ...(doc.lanes ? { lanes: doc.lanes } : {}),
    ...(doc.basedOn ? { basedOn: doc.basedOn } : {}),
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

/** The lifecycle a workflow enters when it is first written: every document is a design. */

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

// Deciding a design is an approval (ADR 0007): whoever holds workflow-designs.approve decides,
// the project's master included when its role grants it.
export function designApproverRefusal(facts: PermissionFacts): DesignRefusal | null {
  return permissionRefusal(facts, 'workflow-designs.approve', 'deciding a workflow design');
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
        status: input.status,
      },
    ];
  }
  const out: DesignRefusal[] = [];
  if (input.revision !== input.proposedRevision) {
    out.push({
      code: 'WORKFLOW_DESIGN_REVISION_STALE',
      path: '/revision',
      detail: `revision ${input.revision} is not the one awaiting a decision; revision ${input.proposedRevision} is. Read it, then decide that one.`,
      revision: input.revision,
      proposedRevision: input.proposedRevision,
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

export type DesignBlock = {
  issue: string;
  workflowId: string;
  flow: string;
  status: DesignStatus | null;
};

/**
 * Dispatch of an issue that builds a workflow whose design is not approved, refused by name: one
 * refusal naming every blocked issue, the list itself beside it as `blocked`.
 */
export function designNotApproved(blocked: readonly DesignBlock[]): RefusalError {
  const refusal = {
    code: 'WORKFLOW_DESIGN_NOT_APPROVED',
    path: '',
    detail: blocked.map(designNotApprovedDetail).join(' '),
    blocked,
  };
  return new RefusalError([refusal], 'WORKFLOW_DESIGN_NOT_APPROVED');
}
