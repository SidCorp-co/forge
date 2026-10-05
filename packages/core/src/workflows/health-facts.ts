/**
 * What the workflow health read model reads (workflow-step-health `in-*`) and the helpers every
 * marker decision shares: whose turn a source is, where a record opens, and one marker per source,
 * kind and target.
 */

import { WAITING_KIND_MARKS, type WaitingOn } from '@forge/contracts/standing';
import type { VERDICT_VALUES } from '@forge/contracts/verdict-identity';
import {
  type HealthMarker,
  type HealthMarkerKind,
  type HealthTarget,
  type NodeDecision,
  PROVENANCE_MARKER_KINDS,
  type RewriteThresholdView,
  type WorkflowRootedView,
} from '@forge/contracts/workflow-health';
import type { WorkflowTemplate } from '@forge/contracts/workflow-templates';
import { edgeKey } from './design-diff.js';
import type { ObservationDocument } from './observation-schema.js';
import type { WorkflowWrite } from './schema.js';

export type NodeTarget = Exclude<HealthTarget, { kind: 'workflow' }>;
export type PlannedTarget =
  | { kind: 'step'; step: string }
  | { kind: 'edge'; from: string; to: string; label: string | null };

export interface HealthFacts {
  now: Date;
  workflowId: string;
  flow: string;
  projectSlug: string;
  head: { revision: number; document: WorkflowWrite | null };
  approvedRevision: number | null;
  /** Every stored revision of the design, with its decision. */
  revisions: { revision: number; document: WorkflowWrite | null; decidedAt: Date | null }[];
  proposed: {
    revision: number;
    document: WorkflowWrite;
    proposedAt: Date;
    waitingOn: WaitingOn;
  } | null;
  /** When the latest revision of the design was proposed. */
  lastProposedAt: Date | null;
  template: WorkflowTemplate | null;
  criteria: {
    requirementKey: string;
    code: string;
    sinceRevision: number;
    sinceAcceptedAt: Date | null;
    targets: PlannedTarget[];
    /** The latest verdict any issue criterion carrying it was judged; null when none was judged. */
    proof: (typeof VERDICT_VALUES)[number] | null;
  }[];
  contractPins: {
    provider: string;
    slug: string;
    pinnedVersion: string;
    newestBreaking: { version: string; recordedAt: Date } | null;
  }[];
  feedback: {
    key: string;
    title: string;
    target: PlannedTarget | null;
    waitingOn: WaitingOn;
    createdAt: Date;
  }[];
  suggestions: {
    id: string;
    status: string;
    change: 'change' | 'remove' | 'rewire';
    targets: PlannedTarget[];
    reason: string;
    createdAt: Date;
    decidedAt: Date | null;
  }[];
  builds: {
    issueKey: string;
    status: string;
    reopenCount: number;
    updatedAt: Date;
    linkedAt: Date;
    closedAt: Date | null;
    targets: PlannedTarget[];
    /** The observed steps it removes or rebuilds (`workflow_builds.observed_step_ids`). */
    observedSteps: string[];
    /** The release that carried it; null until a release run takes it. */
    release: { version: string; releasedAt: Date | null } | null;
    failing: { n: number; reason: string | null; at: Date }[];
    /** The design revisions the latest verdicts of its live criteria were judged against. */
    judgedAgainst: { revision: number; at: Date }[];
    run: { id: string; state: string; since: string | null; rule: string } | null;
  }[];
  observation: {
    id: string;
    atSha: string;
    revision: number;
    createdAt: Date;
    writtenBy: string;
    writtenByAgency: 'human' | 'agent';
    document: ObservationDocument;
  } | null;
  /** Node decisions, newest first. */
  decisions: {
    commentId: string;
    node: NodeDecision;
    reason: string;
    by: string | null;
    byName: string | null;
    at: Date;
  }[];
  threshold: RewriteThresholdView;
  rooted: WorkflowRootedView;
}

export const OPEN_ISSUE = (status: string) => status !== 'closed' && status !== 'dropped';
export const PROVENANCE: ReadonlySet<HealthMarkerKind> = new Set(PROVENANCE_MARKER_KINDS);

export const wait = (
  kind: WaitingOn['kind'],
  who: string,
  act: string,
  rule: string,
): WaitingOn => ({
  kind,
  who,
  act,
  rule,
  ref: null,
  dueAt: null,
});
export const masterOwes = (act: string, rule: string) => wait('master', 'Master', act, rule);
export const personDecides = (rule: string) =>
  wait('person', 'A holder of workflow-designs.approve', 'decide keep, rewrite or delete', rule);
export const waitsOnPerson = (w: WaitingOn) => {
  const mark = WAITING_KIND_MARKS[w.kind];
  return mark === 'you' || mark === 'person';
};

export const planned = (t: PlannedTarget): NodeTarget =>
  t.kind === 'step'
    ? { kind: 'step', step: t.step, layer: 'planned' }
    : { kind: 'edge', from: t.from, to: t.to, label: t.label, layer: 'planned' };

export function targetKey(t: HealthTarget): string {
  if (t.kind === 'workflow') return 'workflow';
  return t.kind === 'step'
    ? `step:${t.layer}:${t.step}`
    : `edge:${t.layer}:${edgeKey(t.from, t.to)}`;
}

export function decisionTarget(d: NodeDecision): NodeTarget {
  const layer = d.layer ?? 'planned';
  return 'step' in d
    ? { kind: 'step', step: d.step, layer }
    : { kind: 'edge', from: d.edge.from, to: d.edge.to, label: d.edge.label ?? null, layer };
}

export const short = (sha: string) => sha.slice(0, 7);
export const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function hrefs(f: HealthFacts) {
  const base = `/projects/${f.projectSlug}`;
  return {
    requirement: (key: string) => `${base}/requirements/${key}`,
    issue: (key: string) => `${base}/issues/${key}`,
    feedback: (key: string) => `${base}/feedback/${key}`,
    revision: (n: number) => `${base}/workflows/${f.flow}?revision=${n}`,
    observation: () => `${base}/workflows/${f.flow}?layer=both`,
    run: (id: string) => `${base}/agents/runs?run=${id}`,
    contract: (provider: string) => `${base}/contracts/${provider}`,
  };
}

/** The approved document, read from the stored revision or the head. */
export function approvedDocumentOf(f: HealthFacts): WorkflowWrite | null {
  if (f.approvedRevision === null) return null;
  if (f.approvedRevision === f.head.revision) return f.head.document;
  return f.revisions.find((r) => r.revision === f.approvedRevision)?.document ?? null;
}

export function documentAt(f: HealthFacts, n: number): WorkflowWrite | null {
  if (n === f.head.revision) return f.head.document;
  return f.revisions.find((r) => r.revision === n)?.document ?? null;
}

export class Markers {
  readonly list: HealthMarker[] = [];
  private readonly seen = new Set<string>();
  add(targets: readonly HealthTarget[], m: Omit<HealthMarker, 'target'>): void {
    for (const target of targets.length ? targets : [{ kind: 'workflow' } as const]) {
      const key = `${m.kind}|${targetKey(target)}|${m.source.type}:${m.source.key}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.list.push({ ...m, target });
    }
  }
}
