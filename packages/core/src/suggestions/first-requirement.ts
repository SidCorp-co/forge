// The facts a first-requirement guard reads, in the caller's transaction: the designs it links and
// any requirement_draft already proposed or accepted on its journey.

import { SUGGESTION_PAYLOADS } from '@forge/contracts/suggestions';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { Refusal } from '../lib/refusal.js';
import { firstRequirementRefusals, linkedDesignIds } from './first-requirement-rules.js';
import type { SuggestionTarget } from './read.js';

export async function firstRequirementRefusalsIn(
  tx: Tx,
  projectId: string,
  target: SuggestionTarget,
  payload: unknown,
  /** The row being accepted or revised, never its own twin. */
  self: string | null,
): Promise<Refusal[]> {
  const { designs: named } = SUGGESTION_PAYLOADS.requirement_draft.schema.parse(payload);
  if (target.type !== 'workflow')
    return firstRequirementRefusals({ target, named, designs: [], journeyTwin: null });
  const ids = linkedDesignIds(target.id, named);
  const [designs, twins] = await Promise.all([
    tx
      .select({
        id: projectWorkflows.id,
        flow: projectWorkflows.flow,
        designStatus: projectWorkflows.designStatus,
      })
      .from(projectWorkflows)
      .where(and(eq(projectWorkflows.projectId, projectId), inArray(projectWorkflows.id, ids))),
    tx
      .select({ id: suggestions.id, status: suggestions.status })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.workflowId, target.id),
          eq(suggestions.kind, 'requirement_draft'),
          inArray(suggestions.status, ['proposed', 'accepted']),
          self ? ne(suggestions.id, self) : undefined,
        ),
      )
      .limit(1),
  ]);
  return firstRequirementRefusals({ target, named, designs, journeyTwin: twins[0] ?? null });
}
