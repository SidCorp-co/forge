// Whether a project delivers fast (REQ-79 BC-1): its project document's `delivery.fast`, absent on
// (`@forge/contracts/delivery-policy:fastDeliveryOf`). A project with no document delivers fast too.

import { fastDeliveryOf } from '@forge/contracts/delivery-policy';
import { readProjectDocument } from './service.js';

export async function readFastDelivery(projectId: string): Promise<boolean> {
  const held = await readProjectDocument(projectId);
  return fastDeliveryOf(held?.document.delivery);
}
