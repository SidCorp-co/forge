import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';

/** The plugin version a token with no box last named in `x-forge-plugin`, and when (ISS-1104). */
export async function recordTokenPluginVersion(tokenId: string, version: string): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ pluginVersion: version, pluginSeenAt: sql`now()` })
    .where(eq(personalAccessTokens.id, tokenId));
}
