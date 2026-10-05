// What a suggestion is about: a requirement, issue, feedback item or workflow of the project, resolved by uuid or key.

import type { SuggestionTargetType } from '@forge/contracts/suggestions';
import { db } from '../db/client.js';
import { rowIn as feedbackRowIn } from '../feedback/index.js';
import { resolveIssueRouteRef } from '../issues/index.js';
import { notFound } from '../middleware/route-errors.js';
import { rowIn } from '../requirements/index.js';
import { designNodesIn } from '../workflows/index.js';

export type SuggestionTargetRef =
  | { requirement: string }
  | { issue: string }
  | { feedback: string }
  | { workflow: string };
export interface SuggestionTarget {
  type: SuggestionTargetType;
  id: string;
}

/** A target of `projectId` by requirement, issue or feedback uuid or key, or a workflow by uuid or flow; 404 otherwise. */
export async function resolveTarget(
  projectId: string,
  target: SuggestionTargetRef,
  userId: string,
): Promise<SuggestionTarget> {
  if ('requirement' in target) {
    return { type: 'requirement', id: (await rowIn(db, projectId, target.requirement)).id };
  }
  if ('feedback' in target) {
    return { type: 'feedback', id: (await feedbackRowIn(db, projectId, target.feedback)).id };
  }
  if ('workflow' in target) {
    const nodes = await designNodesIn(db, projectId, target.workflow);
    if (!nodes) throw notFound(`project ${projectId} holds no workflow ${target.workflow}`);
    return { type: 'workflow', id: nodes.workflowId };
  }
  const issue = await resolveIssueRouteRef(target.issue, projectId, userId);
  if (issue.projectId !== projectId) {
    throw notFound(`issue ${target.issue} is not an issue of project ${projectId}`);
  }
  return { type: 'issue', id: issue.id };
}
