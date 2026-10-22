import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings } from '../db/schema.js';

/**
 * Writes `installationId` into a binding's config and nothing else of it. With `onlyWhereNone` it
 * fills only a binding holding none, so of two installs racing for one, one fills it (ISS-1421 r22).
 */
export async function recordInstallation(
  bindingId: string,
  installationId: number,
  onlyWhereNone: boolean,
): Promise<boolean> {
  const config = integrationBindings.config;
  const filled = await db
    .update(integrationBindings)
    .set({
      config: sql`jsonb_set(${config}, '{installationId}', to_jsonb(${installationId}::bigint))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationBindings.id, bindingId),
        onlyWhereNone ? sql`${config}->'installationId' IS NULL` : undefined,
      ),
    )
    .returning({ id: integrationBindings.id });
  return filled.length > 0;
}
