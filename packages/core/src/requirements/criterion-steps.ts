/**
 * A business criterion's trace onto the steps and edges of a linked design (REQ-17 BC-10): written
 * whole per criterion and design, read beside the criteria, and refused by name where it names a
 * node the design's latest revision does not hold.
 */

import type { PutCriterionStepsRequest } from '@forge/contracts/workflow-health';
import { and, eq, isNull } from 'drizzle-orm';
import {
  requirementCriteria,
  requirementCriterionSteps,
  requirementWorkflows,
} from '../db/schema-requirements.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { designNodesIn, nodeSetRefusals } from '../workflows/index.js';
import { notFound, type RequirementActor, rowIn } from './read.js';
import type { RequirementRefusal } from './rules.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './service.js';

export async function putCriterionSteps(input: {
  projectId: string;
  ref: string;
  code: string;
  actor: RequirementActor;
  request: PutCriterionStepsRequest;
}): Promise<RequirementOutcome> {
  const { projectId, ref, code, actor, request } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  let id = '';
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    const row = await rowIn(tx, projectId, ref);
    id = row.id;
    const [live] = await tx
      .select({ id: requirementCriteria.id })
      .from(requirementCriteria)
      .where(
        and(
          eq(requirementCriteria.requirementId, row.id),
          eq(requirementCriteria.code, code),
          isNull(requirementCriteria.retiredRevision),
        ),
      );
    if (!live) throw notFound(`requirement ${ref} has no live criterion ${code}`);
    const nodes = await designNodesIn(tx, projectId, request.workflow);
    if (!nodes) throw notFound(`project ${projectId} holds no workflow ${request.workflow}`);
    const [linked] = await tx
      .select({ w: requirementWorkflows.workflowId })
      .from(requirementWorkflows)
      .where(
        and(
          eq(requirementWorkflows.requirementId, row.id),
          eq(requirementWorkflows.workflowId, nodes.workflowId),
        ),
      );
    if (!linked) {
      return [
        {
          code: 'REQUIREMENT_DESIGN_UNLINKED',
          path: '/workflow',
          detail: `workflow ${nodes.flow} is not linked to ${ref}; a criterion traces only the designs its requirement serves. Link it first (POST …/requirements/${ref}/workflows).`,
        },
      ];
    }
    const wrong = nodeSetRefusals(nodes, request) as RequirementRefusal[];
    if (wrong.length) return wrong;
    await tx
      .delete(requirementCriterionSteps)
      .where(
        and(
          eq(requirementCriterionSteps.requirementId, row.id),
          eq(requirementCriterionSteps.code, code),
          eq(requirementCriterionSteps.workflowId, nodes.workflowId),
        ),
      );
    const base = {
      projectId,
      requirementId: row.id,
      code,
      workflowId: nodes.workflowId,
      createdBy: actor.userId,
    };
    const values = [
      ...[...new Set(request.steps ?? [])].map((s) => ({ ...base, stepId: s })),
      ...(request.edges ?? []).map((e) => ({
        ...base,
        edgeFrom: e.from,
        edgeTo: e.to,
        edgeLabel: e.label ?? null,
      })),
    ];
    if (values.length) await tx.insert(requirementCriterionSteps).values(values);
    return null;
  });
  return answer(projectId, id || ref, actor, refusals);
}
