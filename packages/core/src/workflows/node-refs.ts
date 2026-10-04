/**
 * Whether the steps and edges a record names are nodes of a design's latest revision: the one check
 * every write naming a node runs (criterion traces, feedback, design_change suggestions, build links,
 * node decisions), so none of them can hold a node the design does not.
 */

import type { EdgeRef, NodeRef, NodeSet } from '@forge/contracts/workflow-health';
import { and, eq } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { isUuid } from '../issues/issue-route-ref.js';
import type { Refusal } from '../lib/refusal.js';
import { readStoredWorkflow, type WorkflowWrite } from './schema.js';

export interface DesignNodes {
  workflowId: string;
  flow: string;
  revision: number;
  steps: ReadonlySet<string>;
  edges: readonly { from: string; to: string; label?: string | undefined }[];
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

const edgeText = (e: EdgeRef) => `${e.from}>${e.to}${e.label ? ` "${e.label}"` : ''}`;

/** The edges an edge reference names: those with its ends, narrowed by its label when given. */
export function edgesMatching(nodes: DesignNodes, e: EdgeRef) {
  return nodes.edges.filter(
    (x) => x.from === e.from && x.to === e.to && (e.label === undefined || x.label === e.label),
  );
}

export function edgeRefusal(nodes: DesignNodes, e: EdgeRef, path: string): Refusal | null {
  const hits = edgesMatching(nodes, e);
  if (hits.length === 1) return null;
  if (hits.length === 0) {
    return {
      code: 'WORKFLOW_NODE_UNKNOWN',
      path,
      detail: `workflow ${nodes.flow} r${nodes.revision} draws no edge ${edgeText(e)}; name an edge of its latest revision by from, to and, where several share both ends, label.`,
    };
  }
  return {
    code: 'WORKFLOW_NODE_AMBIGUOUS',
    path,
    detail: `workflow ${nodes.flow} r${nodes.revision} draws ${hits.length} edges ${e.from}>${e.to} (labels: ${hits.map((h) => h.label ?? '(none)').join(', ')}); name the one meant by its label.`,
  };
}

export function stepRefusal(nodes: DesignNodes, step: string, path: string): Refusal | null {
  if (nodes.steps.has(step)) return null;
  return {
    code: 'WORKFLOW_NODE_UNKNOWN',
    path,
    detail: `workflow ${nodes.flow} r${nodes.revision} holds no step "${step}"; name a step of its latest revision.`,
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
