/**
 * Whether the steps and edges a record names are nodes of a design: of its latest revision for every
 * write naming a node (criterion traces, feedback, design_change suggestions, build links), and of its
 * approved revision or its latest observation for a node decision, so none of them can hold a node
 * the design or the code does not.
 */

import type { EdgeRef, NodeDecision, NodeRef, NodeSet } from '@forge/contracts/workflow-health';
import { and, desc, eq } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import { projectWorkflowObservations, projectWorkflows } from '../db/schema-workflows.js';
import { isUuid } from '../issues/index.js';
import type { Refusal } from '../lib/refusal.js';
import { observationDocumentSchema } from './observation-schema.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';
import { designsOf } from './store.js';

interface DesignNodes {
  workflowId: string;
  flow: string;
  revision: number;
  steps: ReadonlySet<string>;
  edges: readonly { from: string; to: string; label?: string | undefined }[];
  /** What the nodes are read from, and what a refusal tells the caller to name instead. */
  of?: string;
  hint?: string;
}

export function nodesOfDocument(
  workflowId: string,
  flow: string,
  revision: number,
  doc: WorkflowWrite | null,
): DesignNodes {
  const edges = doc && 'edges' in doc ? (doc.edges ?? []) : [];
  return {
    workflowId,
    flow,
    revision,
    steps: new Set((doc?.steps ?? []).map((s) => s.id)),
    edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
  };
}

/** The latest revision of a workflow of `projectId`, by uuid or flow; null when there is none. */
export async function designNodesIn(
  tx: Tx | typeof db,
  projectId: string,
  ref: string,
): Promise<DesignNodes | null> {
  const [row] = await tx
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      revision: projectWorkflows.revision,
      document: projectWorkflows.document,
    })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        isUuid(ref) ? eq(projectWorkflows.id, ref) : eq(projectWorkflows.flow, ref.trim()),
      ),
    );
  if (!row) return null;
  return nodesOfDocument(row.id, row.flow, row.revision, readStoredWorkflow(row.document));
}

const ofText = (n: DesignNodes) => n.of ?? `workflow ${n.flow} r${n.revision}`;
const hintText = (n: DesignNodes) => n.hint ?? 'its latest revision';

const edgeText = (e: EdgeRef) => `${e.from}>${e.to}${e.label ? ` "${e.label}"` : ''}`;

/** The edges an edge reference names: those with its ends, narrowed by its label when given. */
function edgesMatching(nodes: DesignNodes, e: EdgeRef) {
  return nodes.edges.filter(
    (x) => x.from === e.from && x.to === e.to && (e.label === undefined || x.label === e.label),
  );
}

function edgeRefusal(nodes: DesignNodes, e: EdgeRef, path: string): Refusal | null {
  const hits = edgesMatching(nodes, e);
  if (hits.length === 1) return null;
  if (hits.length === 0) {
    return {
      code: 'WORKFLOW_NODE_UNKNOWN',
      path,
      detail: `${ofText(nodes)} draws no edge ${edgeText(e)}; name an edge of ${hintText(nodes)} by from, to and, where several share both ends, label.`,
    };
  }
  return {
    code: 'WORKFLOW_NODE_AMBIGUOUS',
    path,
    detail: `${ofText(nodes)} draws ${hits.length} edges ${e.from}>${e.to} (labels: ${hits.map((h) => h.label ?? '(none)').join(', ')}); name the one meant by its label.`,
  };
}

function stepRefusal(nodes: DesignNodes, step: string, path: string): Refusal | null {
  if (nodes.steps.has(step)) return null;
  return {
    code: 'WORKFLOW_NODE_UNKNOWN',
    path,
    detail: `${ofText(nodes)} holds no step "${step}"; name a step of ${hintText(nodes)}.`,
  };
}

/** Every step and edge of `set` the design does not hold, each refused at its own path under `base`. */
export function nodeSetRefusals(nodes: DesignNodes, set: NodeSet, base = ''): Refusal[] {
  const out: Refusal[] = [];
  (set.steps ?? []).forEach((s, i) => {
    const r = stepRefusal(nodes, s, `${base}/steps/${i}`);
    if (r) out.push(r);
  });
  (set.edges ?? []).forEach((e, i) => {
    const r = edgeRefusal(nodes, e, `${base}/edges/${i}`);
    if (r) out.push(r);
  });
  return out;
}

export function nodeRefRefusal(nodes: DesignNodes, ref: NodeRef, base = ''): Refusal | null {
  return 'step' in ref
    ? stepRefusal(nodes, ref.step, `${base}/step`)
    : edgeRefusal(nodes, ref.edge, `${base}/edge`);
}

async function workflowIn(tx: Tx, projectId: string, ref: string) {
  const [row] = await tx
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      revision: projectWorkflows.revision,
      approvedRevision: projectWorkflows.approvedRevision,
      document: projectWorkflows.document,
    })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        isUuid(ref) ? eq(projectWorkflows.id, ref) : eq(projectWorkflows.flow, ref.trim()),
      ),
    );
  return row ?? null;
}

/** The nodes of a workflow's approved revision; null when it has none. */
async function approvedNodesOf(
  tx: Tx,
  wf: NonNullable<Awaited<ReturnType<typeof workflowIn>>>,
): Promise<DesignNodes | null> {
  const n = wf.approvedRevision;
  if (n === null) return null;
  const stored =
    n === wf.revision
      ? wf.document
      : (await designsOf(tx, wf.id)).find((d) => d.revision === n)?.document;
  if (stored === undefined) return null;
  return {
    ...nodesOfDocument(wf.id, wf.flow, n, readStoredWorkflow(stored)),
    of: `workflow ${wf.flow} r${n} (approved)`,
    hint: 'its approved revision, or an observed node with layer observed',
  };
}

/** The nodes of a workflow's latest observation; null when the code has not been observed. */
async function observedNodesOf(
  tx: Tx,
  wf: NonNullable<Awaited<ReturnType<typeof workflowIn>>>,
): Promise<DesignNodes | null> {
  const [row] = await tx
    .select({
      atSha: projectWorkflowObservations.atSha,
      revision: projectWorkflowObservations.revision,
      document: projectWorkflowObservations.document,
    })
    .from(projectWorkflowObservations)
    .where(eq(projectWorkflowObservations.workflowId, wf.id))
    .orderBy(desc(projectWorkflowObservations.createdAt))
    .limit(1);
  if (!row) return null;
  const doc = observationDocumentSchema.parse(row.document);
  return {
    workflowId: wf.id,
    flow: wf.flow,
    revision: row.revision,
    steps: new Set(doc.steps.map((s) => s.id)),
    edges: doc.edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
    of: `the latest observation of ${wf.flow} (at ${row.atSha.slice(0, 12)})`,
    hint: 'that observation',
  };
}

/** The nodes of the latest observation of a workflow of `projectId`; null when it has none. */
export async function observedNodesIn(
  tx: Tx,
  projectId: string,
  ref: string,
): Promise<DesignNodes | null> {
  const wf = await workflowIn(tx, projectId, ref);
  return wf ? observedNodesOf(tx, wf) : null;
}

/**
 * Why a node decision names no node it may decide (design-reconciliation `decision`): a planned node
 * is a step or edge of the approved revision, an observed one a node of the latest observation, so a
 * Not in design node can be decided. Null when it names one, or when the workflow is not found.
 */
export async function decisionNodeRefusal(
  tx: Tx,
  projectId: string,
  workflowRef: string,
  node: NodeDecision,
  base: string,
): Promise<Refusal | null> {
  const wf = await workflowIn(tx, projectId, workflowRef);
  if (!wf) return null;
  const observed = node.layer === 'observed';
  const nodes = observed ? await observedNodesOf(tx, wf) : await approvedNodesOf(tx, wf);
  if (!nodes) {
    return {
      code: 'WORKFLOW_NODE_UNKNOWN',
      path: `${base}/${'step' in node ? 'step' : 'edge'}`,
      detail: observed
        ? `workflow ${wf.flow} has no observation yet, so no observed node can be decided; decide a node of its approved revision, or wait for the code to be observed.`
        : `workflow ${wf.flow} has no approved revision, so no planned node can be decided; a holder of workflow-designs.approve approves a revision first, or decide an observed node with layer observed.`,
    };
  }
  const ref: NodeRef = 'step' in node ? { step: node.step } : { edge: node.edge };
  return nodeRefRefusal(nodes, ref, base);
}
