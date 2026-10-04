// The criterion traces of a requirement as its reads serve them (REQ-17 BC-10).

import type { CriterionTraceView, EdgeRef } from '@forge/contracts/workflow-health';
import { asc, eq } from 'drizzle-orm';
import type { db, Tx } from '../db/client.js';
import { requirementCriterionSteps } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';

export interface CodedTrace extends CriterionTraceView {
  code: string;
}

/** Every criterion trace of a requirement, one entry per code and design, codes in BC order. */
export async function tracesOf(executor: Tx | typeof db, requirementId: string) {
  const rows = await executor
    .select({
      code: requirementCriterionSteps.code,
      workflowId: requirementCriterionSteps.workflowId,
      flow: projectWorkflows.flow,
      stepId: requirementCriterionSteps.stepId,
      edgeFrom: requirementCriterionSteps.edgeFrom,
      edgeTo: requirementCriterionSteps.edgeTo,
      edgeLabel: requirementCriterionSteps.edgeLabel,
    })
    .from(requirementCriterionSteps)
    .innerJoin(projectWorkflows, eq(projectWorkflows.id, requirementCriterionSteps.workflowId))
    .where(eq(requirementCriterionSteps.requirementId, requirementId))
    .orderBy(asc(requirementCriterionSteps.createdAt));
  const by = new Map<string, CodedTrace>();
  for (const r of rows) {
    const key = `${r.code}|${r.workflowId}`;
    const t = by.get(key) ?? {
      code: r.code,
      workflowId: r.workflowId,
      flow: r.flow,
      steps: [],
      edges: [],
    };
    if (r.stepId) t.steps.push(r.stepId);
    else if (r.edgeFrom && r.edgeTo) {
      const e: EdgeRef = { from: r.edgeFrom, to: r.edgeTo };
      if (r.edgeLabel) e.label = r.edgeLabel;
      t.edges.push(e);
    }
    by.set(key, t);
  }
  return [...by.values()].sort(
    (a, b) => Number(a.code.slice(3)) - Number(b.code.slice(3)) || a.flow.localeCompare(b.flow),
  );
}
