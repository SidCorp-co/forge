// Whether a project delivers fast (REQ-79 BC-1): its project document's `delivery.fast`, absent on
// (`@forge/contracts/delivery-policy:fastDeliveryOf`). A project with no document delivers fast too.
// And where a landed change reaches production (REQ-79 r4 BC-5): on land, or by a person's promotion
// (`release-path.ts:deploysOnLandOf`), read from the same document.

import { fastDeliveryOf } from '@forge/contracts/delivery-policy';
import { deploysOnLandOf } from './release-path.js';
import { readProjectDocument } from './service.js';

export async function readFastDelivery(projectId: string): Promise<boolean> {
  const held = await readProjectDocument(projectId);
  return fastDeliveryOf(held?.document.delivery);
}

/** Whether the project delivers fast, and whether its production deploys on land. */
export async function readDeliveryShape(
  projectId: string,
): Promise<{ fast: boolean; onLand: boolean }> {
  const held = await readProjectDocument(projectId);
  return {
    fast: fastDeliveryOf(held?.document.delivery),
    onLand: deploysOnLandOf(held?.document),
  };
}
