// A draft requirement linked to the workflow designs its wish relates to (REQ-30 BC-4: the record
// links the existing requirement, feedback or design the restatement named). One path for both
// doors: the Assistant's forge_requirement_draft and the REST draft an Agent session posts, so a
// draft held for the person's agreement lands linked whichever door proposed it.

import { logger } from '../lib/logger.js';
import { designIdsOf, linkWorkflow } from './issue-links.js';
import { proposePlacement } from './placement.js';
import type { RequirementActor } from './read.js';
import type { RevisionWrite } from './revision-write.js';
import { designWithdrawnRefusal, type RequirementRefusal } from './rules.js';
import { createRequirement } from './service.js';
import type { RequirementOutcome } from './write-tx.js';

/** The refusal of a draft naming a design the project does not hold. */
export function designUnknown(missing: readonly string[]): RequirementRefusal {
  return {
    code: 'REQUIREMENT_DESIGN_UNKNOWN',
    path: '/designs',
    detail: `this project holds no workflow design named ${missing.join(', ')}; name a design by its flow name or id, as the Workflows screen lists them`,
  };
}

/** The ids of the designs `names` names, or the refusals naming those the project does not hold
 *  and each one withdrawn. */
export async function designsNamed(
  projectId: string,
  names: readonly string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; refusals: RequirementRefusal[] }> {
  const linked = await designIdsOf(projectId, names);
  if (linked.ok) return linked;
  return {
    ok: false,
    refusals: [
      ...(linked.missing.length > 0 ? [designUnknown(linked.missing)] : []),
      ...linked.withdrawn.map((w) => designWithdrawnRefusal(w.flow, `/designs/${w.at}`)),
    ],
  };
}

/** Write the draft, then link each design; the outcome as it then reads, still marked created. */
export async function draftLinked(input: {
  projectId: string;
  actor: RequirementActor;
  title: string;
  write: RevisionWrite;
  workflowIds: readonly string[];
}): Promise<RequirementOutcome> {
  const { projectId, actor, title, write } = input;
  const drafted = await createRequirement({ projectId, actor, title, write });
  let latest = drafted;
  for (const workflowId of input.workflowIds) {
    if (!latest.ok) return latest;
    latest = await linkWorkflow({ projectId, ref: latest.requirement.key, actor, workflowId });
  }
  return latest.ok && drafted.ok && drafted.created !== undefined
    ? { ...latest, created: drafted.created }
    : latest;
}

/**
 * A new requirement as `POST /api/projects/:id/requirements` writes it, for every door that drafts
 * one from a person's own words (REST, /mcp): the designs it names resolved, the draft written and
 * linked, then the assistant asked for its area and short name, which a person accepts.
 */
export async function draftRequirement(input: {
  projectId: string;
  actor: RequirementActor;
  title: string;
  write: RevisionWrite;
  designs: readonly string[];
}): Promise<RequirementOutcome> {
  const { projectId, actor, title, write } = input;
  const linked = await designsNamed(projectId, input.designs);
  if (!linked.ok) return linked;
  const outcome = await draftLinked({ projectId, actor, title, write, workflowIds: linked.ids });
  if (outcome.ok) {
    void proposePlacement(projectId, outcome.requirement.id).catch((err: unknown) =>
      logger.warn({ err }, 'requirement placement: the proposal on create failed'),
    );
  }
  return outcome;
}
