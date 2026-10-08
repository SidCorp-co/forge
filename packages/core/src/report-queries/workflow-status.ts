// workflow-status: per workflow design, its steps and edges with the health markers each carries.
// Built over `projectHealthAs`, the read the workflows list and Needs you draw, so a marker here is
// the marker there. The rows hold the design graph: a `step` row is a node, an `edge` row names its
// `from` and `to`, and a `design` row carries the design's own totals.

import {
  defineReportQuery,
  type ReportCell,
  type ReportFrame,
} from '@forge/contracts/report-queries';
import { HEALTH_MARKER_LABELS, type WorkflowHealth } from '@forge/contracts/workflow-health';
import { z } from 'zod';
import { projectHealthAs } from '../workflows/index.js';
import { checkedFrame, defineAdapter } from './adapter.js';

const descriptor = defineReportQuery({
  id: 'workflow-status',
  version: 1,
  title: 'Workflow status',
  params: z.object({ flow: z.string().min(1).max(120).optional() }),
  output: [
    { name: 'flow', type: 'string', label: 'Workflow' },
    { name: 'kind', type: 'status', label: 'Row' },
    { name: 'node', type: 'string', label: 'Step or edge' },
    { name: 'from', type: 'string', label: 'From' },
    { name: 'to', type: 'string', label: 'To' },
    { name: 'provenance', type: 'status', label: 'Provenance' },
    { name: 'markers', type: 'string', label: 'Markers' },
    { name: 'markerCount', type: 'number', unit: 'markers', label: 'Marker count' },
    { name: 'rewrite', type: 'status', label: 'Rewrite' },
    { name: 'needsYou', type: 'number', label: 'Needs a person' },
  ],
  permission: 'project.read',
  egress: 'product',
  surfaces: ['rest', 'chat', 'cli'],
});

type Health = Pick<WorkflowHealth, 'flow' | 'counts' | 'needsYou' | 'nodes' | 'markers'>;

const sumOf = (counts: Health['counts']) => Object.values(counts).reduce((n, c) => n + c, 0);

/** A `design` row, then one row per node of it in the read's own order. */
export function workflowStatusFrame(designs: readonly Health[], only?: string): ReportFrame {
  const rows: Record<string, ReportCell>[] = [];
  const chosen = only === undefined ? designs : designs.filter((d) => d.flow === only);
  for (const d of [...chosen].sort((a, b) => a.flow.localeCompare(b.flow, 'en'))) {
    const labelled = Object.entries(d.counts)
      .filter(([, n]) => n > 0)
      .map(
        ([kind, n]) => `${HEALTH_MARKER_LABELS[kind as keyof typeof HEALTH_MARKER_LABELS]} ${n}`,
      );
    rows.push({
      flow: d.flow,
      kind: 'design',
      node: null,
      from: null,
      to: null,
      provenance: null,
      markers: labelled.join(', '),
      markerCount: sumOf(d.counts),
      rewrite: null,
      needsYou: d.needsYou,
    });
    for (const n of d.nodes) {
      const t = n.target;
      rows.push({
        flow: d.flow,
        kind: t.kind,
        node: t.kind === 'step' ? t.step : `${t.from} -> ${t.to}`,
        from: t.kind === 'edge' ? t.from : null,
        to: t.kind === 'edge' ? t.to : null,
        provenance: n.provenance,
        markers: n.kinds.map((k) => HEALTH_MARKER_LABELS[k]).join(', '),
        markerCount: n.kinds.length,
        rewrite: n.rewrite,
        needsYou: null,
      });
    }
  }
  return checkedFrame(descriptor.id, { fields: [...descriptor.output], rows });
}

export const workflowStatus = defineAdapter({
  descriptor,
  reads: ['workflows:projectHealthAs'],
  async run({ projectId, viewer }, params) {
    const designs = [...(await projectHealthAs(viewer, projectId)).values()];
    if (params.flow !== undefined && !designs.some((d) => d.flow === params.flow)) {
      throw new Error(
        `report query "workflow-status": project ${projectId} holds no workflow design ${params.flow}; params.flow is the flow name of one of this project's designs`,
      );
    }
    return workflowStatusFrame(designs, params.flow);
  },
});
