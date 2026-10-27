// ISS-1421 r36: a Clear leaves a record of what it deleted, so a later read is told it was cleared
// (`reach.ts:unreachedRefusal`) rather than that the connection is not one the reader can reach.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  integrationBindings,
  integrationConnectionClears,
  integrationConnections,
} from '../db/schema.js';

/**
 * Clears a removed connection from the list: the row goes, and its bindings with it (cascade). The
 * caller has read it removed (`held-key.ts`), and it goes only while it still holds the secrets read
 * then: a key saved since keeps it. Says whether it went (ISS-1421 r22). What went is recorded in the
 * same transaction, which is what lets a later read say it was cleared.
 */
export async function clearRemovedConnection(read: {
  id: string;
  secretsEnc: Buffer | null;
}): Promise<boolean> {
  const secrets = integrationConnections.secretsEnc;
  return db.transaction(async (tx) => {
    const shared = await tx
      .select({ projectId: integrationBindings.projectId })
      .from(integrationBindings)
      .where(eq(integrationBindings.connectionId, read.id));
    const [gone] = await tx
      .delete(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, read.id),
          eq(integrationConnections.active, false),
          read.secretsEnc === null ? isNull(secrets) : eq(secrets, read.secretsEnc),
        ),
      )
      .returning({
        provider: integrationConnections.provider,
        ownerType: integrationConnections.ownerType,
        ownerId: integrationConnections.ownerId,
      });
    if (!gone) return false;
    await tx
      .insert(integrationConnectionClears)
      .values({
        connectionId: read.id,
        ...gone,
        projectIds: [...new Set(shared.map((row) => row.projectId))],
      })
      .onConflictDoNothing();
    return true;
  });
}
