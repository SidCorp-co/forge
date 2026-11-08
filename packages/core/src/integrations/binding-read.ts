// A binding with its connection, by the binding's id, as a read asks it: every project's production
// binding a person's read weighs (`release-batch/gate.ts:productionBindings`, each environment's
// deployment record) is asked before the quiet point and read in one statement
// (`db/read-memo.ts:onePerId`, ISS-1070 r12), where each was one statement a project and an ask.
// A write reads its own through `store.ts:findBindingWithConnectionById`.

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { onePerId } from '../db/read-memo.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import type { BindingWithConnection } from './store.js';

/** The binding and its connection, regardless of active state; null where none is held. */
export async function heldBindingWithConnection(id: string): Promise<BindingWithConnection | null> {
  const pair = await onePerId('bindingWithConnection', id, async (ids) => {
    const rows = await db
      .select({ binding: integrationBindings, connection: integrationConnections })
      .from(integrationBindings)
      .innerJoin(
        integrationConnections,
        eq(integrationBindings.connectionId, integrationConnections.id),
      )
      .where(inArray(integrationBindings.id, [...ids]));
    return new Map(rows.map((r) => [r.binding.id, r]));
  });
  return pair ?? null;
}
