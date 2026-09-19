import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import type { BindingWithConnection } from './store.js';

/** Bindings of one provider an agent here may use: granted, both tiers active, oldest first. */
export async function listAgentGrantedBindings(
  projectId: string,
  provider: string,
): Promise<BindingWithConnection[]> {
  const rows = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationBindings.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationBindings.projectId, projectId),
        eq(integrationBindings.provider, provider),
        eq(integrationBindings.active, true),
        eq(integrationBindings.agentAccess, 'all'),
        eq(integrationConnections.active, true),
      ),
    )
    .orderBy(asc(integrationBindings.createdAt));
  return rows as BindingWithConnection[];
}
