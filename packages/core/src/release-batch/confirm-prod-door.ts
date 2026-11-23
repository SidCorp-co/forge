// The production confirm door, one service for each way a person gives it (ISS-1441): the release
// page's press (`POST /api/projects/:projectId/integrations/:id/confirm-prod-deploy`) and the owner's
// word in his room (`support/owner-confirm-deploy-act.ts`). Both check the same things before the
// gate flips: the binding is the project's own, and it reaches the production environment; the
// caller has checked project.admin, the door's permission. The project's integrations then read it
// changed, as they did when the route alone confirmed.

import { findBindingWithConnectionById } from '../integrations/index.js';
import { announceIntegrationChanged } from '../project-config/index.js';
import { type ConfirmProdResult, confirmPendingProdDeploy } from './coolify-prod-gate.js';
import { bindingReachesProduction } from './release-coolify.js';

/** What the door answers: confirmed, or why this binding has no production deploy to confirm. */
export type ProdConfirmOutcome =
  | { ok: true; result: ConfirmProdResult }
  | { ok: false; why: 'unknown_binding' | 'not_production' };

/** The words a refusal of `not_production` gives, the route's and the room's alike. */
export const NOT_PRODUCTION_BINDING =
  "confirm-prod-deploy is only valid on a deploy binding that reaches the project document's production environment — this one does not, so there is no production deploy for a human to confirm";

/** Confirm the production deploy parked on `bindingId` as `userId`, citing his message where he gave it in a room. */
export async function confirmProdDeployOf(input: {
  projectId: string;
  bindingId: string;
  userId: string;
  cited?: { message: string; thread: string; rid: string };
}): Promise<ProdConfirmOutcome> {
  const existing = await findBindingWithConnectionById(input.bindingId);
  if (!existing || existing.binding.projectId !== input.projectId) {
    return { ok: false, why: 'unknown_binding' };
  }
  if (!(await bindingReachesProduction(input.projectId, existing.binding))) {
    return { ok: false, why: 'not_production' };
  }
  // who confirmed it is recorded on the gate and named to the release run it carries on (ISS-1096)
  const result = await confirmPendingProdDeploy(input.bindingId, input.userId, input.cited);
  await announceIntegrationChanged(input.projectId, {
    bindingId: input.bindingId,
    connectionId: existing.connection.id,
  });
  return { ok: true, result };
}
