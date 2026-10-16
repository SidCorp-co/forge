// What a token is, read off its row: whether its holder minted it to act as themselves, and the MCP
// client it was handed to where it is an OAuth access token. An act that takes a person's own word
// reads the first; a record of who acted, and through what, keeps the second.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mcpOauthClients, mcpOauthGrants, personalAccessTokens } from '../db/schema.js';
import { coreTokenNamePrefixOf, mcpOauthGrantIdOf } from './pat-format.js';

/** The MCP client an OAuth access token was handed to, as it registered itself. */
export interface TokenClient {
  id: string;
  name: string;
}

export interface TokenIdentity {
  tokenId: string;
  /**
   * The holder's own: a token they minted for themselves, or the access token an MCP client holds
   * on their consent. False for every token core mints to act for someone (a turn's, an agreed
   * proposal's, a sandbox read's, a probe replay's) and for a box's or a checkout's.
   */
  holdersOwn: boolean;
  /** The MCP client holding it, where it is an OAuth access token; null for every other token. */
  client: TokenClient | null;
}

/** The token by its id, which a request already admitted; a token gone from the table is a broken request and throws. */
export async function tokenIdentityOf(tokenId: string): Promise<TokenIdentity> {
  const [row] = await db
    .select({
      name: personalAccessTokens.name,
      deviceId: personalAccessTokens.deviceId,
      onBehalfOf: personalAccessTokens.onBehalfOf,
    })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.id, tokenId))
    .limit(1);
  if (!row)
    throw new Error(`credentials: token ${tokenId} admitted this request and is not stored`);
  const grantId = mcpOauthGrantIdOf(row.name);
  const client = grantId ? await clientOfGrant(grantId) : null;
  const minted = coreTokenNamePrefixOf(row.name) === null;
  return {
    tokenId,
    holdersOwn: row.deviceId === null && row.onBehalfOf === null && (minted || client !== null),
    client,
  };
}

async function clientOfGrant(grantId: string): Promise<TokenClient> {
  const [row] = await db
    .select({ id: mcpOauthClients.id, name: mcpOauthClients.clientName })
    .from(mcpOauthGrants)
    .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientId))
    .where(eq(mcpOauthGrants.id, grantId))
    .limit(1);
  if (!row)
    throw new Error(`credentials: OAuth grant ${grantId} minted a live token and is not stored`);
  return row;
}
