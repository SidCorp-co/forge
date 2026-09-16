/**
 * The one read of the grant.
 *
 * Beside `agent-access.ts` rather than inside it, because that module must stay importable without
 * a database: it is what the capability tests, the declaration checker and the adapter tests ask
 * "may an agent use this?", and an import of `db/client.js` runs core's env validation at module
 * load. A pure predicate living in the same file as a query turns every one of those into a test
 * that needs a live DATABASE_URL.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, integrationConnections } from '../db/schema.js';
import type { BindingWithConnection } from './store.js';

/** Bindings of one provider an agent here may use: granted, both tiers active, oldest first. */
// cm:edge lockstep -> packages/core/src/integrations/mcp-resolver.ts — the dispatch resolver and the
// preview service both take their binding set from here, so neither can drift about which wins.
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
