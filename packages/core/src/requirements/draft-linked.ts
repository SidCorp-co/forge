// A draft requirement linked to the workflow designs its wish relates to (REQ-30 BC-4: the record
// links the existing requirement, feedback or design the restatement named). One path for both
// doors: the Assistant's forge_requirement_draft and the REST draft an Agent session posts, so a
// draft held for the person's agreement lands linked whichever door proposed it.

import { designIdsOf, linkWorkflow } from './issue-links.js';
import type { RequirementActor } from './read.js';
import type { RevisionWrite } from './revision-write.js';
import type { RequirementRefusal } from './rules.js';
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

/** The ids of the designs `names` names, or the refusal naming those the project does not hold. */
export async function designsNamed(
  projectId: string,
  names: readonly string[],
): Promise<{ ok: true; ids: string[] } | { ok: false; refusal: RequirementRefusal }> {
  const linked = await designIdsOf(projectId, names);
  return linked.ok ? linked : { ok: false, refusal: designUnknown(linked.missing) };
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
