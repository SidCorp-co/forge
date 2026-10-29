import {
  MCP_OAUTH_ACCESS_TTL_SECONDS,
  MCP_OAUTH_CODE_TTL_SECONDS,
  MCP_OAUTH_REFRESH_TTL_DAYS,
  type McpOAuthScope,
} from '@forge/contracts/mcp-auth';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import {
  type McpOauthClientRow,
  type McpOauthGrantRow,
  mcpOauthClients,
  mcpOauthCodes,
  mcpOauthGrants,
  personalAccessTokens,
} from '../db/schema.js';
import { digestToken } from '../lib/token-digest.js';
import { mintSecret, pkceAnswers } from './mcp-oauth-shape.js';
import { lockPatName, mintPat, revokeLiveTokens } from './pat.js';
import { mcpOauthTokenNameFor } from './pat-format.js';
import { patGrantIsStated } from './pat-permissions.js';

/**
 * The writes of the MCP OAuth flow. A code is redeemed once for a grant; a grant's refresh token
 * rotates on every use, superseding the hour-long personal access token it carries. Every way a
 * grant ends — a refresh token presented twice, a code redeemed twice, the access token revoked
 * on the tokens page, a newer consent for the same client — revokes the grant and its token
 * together, so nothing the grant minted outlives it.
 */

const REFRESH_TTL_MS = MCP_OAUTH_REFRESH_TTL_DAYS * 24 * 60 * 60_000;

/** What a token request gets back: the tokens, or the OAuth error and the sentence saying why. */
export type TokenOutcome =
  | {
      accessToken: string;
      refreshToken: string;
      scopes: McpOAuthScope[];
    }
  | { error: 'invalid_grant' | 'invalid_scope'; description: string };

export async function registerClient(input: {
  clientName: string;
  redirectUris: string[];
  createdIp: string | null;
}): Promise<McpOauthClientRow> {
  const [row] = await db.insert(mcpOauthClients).values(input).returning();
  if (!row) throw new Error('registerClient: insert returned no row');
  return row;
}

/** The registered client a live OAuth grant handed `tokenId` to, or null for a token minted by hand. */
export async function clientOfToken(
  tokenId: string,
): Promise<Pick<McpOauthClientRow, 'clientName' | 'redirectUris'> | null> {
  const [row] = await db
    .select({ clientName: mcpOauthClients.clientName, redirectUris: mcpOauthClients.redirectUris })
    .from(mcpOauthGrants)
    .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientId))
    .where(eq(mcpOauthGrants.currentTokenId, tokenId))
    .limit(1);
  return row ?? null;
}

export async function findClient(id: string): Promise<McpOauthClientRow | null> {
  const [row] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, id));
  return row ?? null;
}

/** End a grant and the access token it carries, naming why. */
async function endGrant(tx: Tx, grant: McpOauthGrantRow, reason: string): Promise<void> {
  await tx
    .update(mcpOauthGrants)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(mcpOauthGrants.id, grant.id), isNull(mcpOauthGrants.revokedAt)));
  await revokeLiveTokens({ name: mcpOauthTokenNameFor(grant.id) }, tx);
}

/**
 * Mint the grant's access token for the hour, superseding the one it held, under the token name's
 * lock so two refreshes cannot both leave a live token behind.
 */
async function mintAccess(
  tx: Tx,
  grant: McpOauthGrantRow,
  scopes: readonly McpOAuthScope[],
): Promise<{ tokenId: string; plaintext: string }> {
  const permissions = grant.permissions;
  // the consent that made the grant refused a reach it did not state (`mintableGrant`)
  if (!patGrantIsStated(permissions)) throw new Error(`MCP grant ${grant.id} states no reach`);
  const name = mcpOauthTokenNameFor(grant.id);
  await lockPatName(tx, name);
  await revokeLiveTokens({ name }, tx);
  const { row, plaintext } = await mintPat(
    {
      userId: grant.userId,
      name,
      scopes: [...scopes],
      projectIds: grant.projectIds,
      permissions,
      grantEpoch: grant.grantEpoch,
      expiresAt: new Date(Date.now() + MCP_OAUTH_ACCESS_TTL_SECONDS * 1000),
    },
    tx,
  );
  return { tokenId: row.id, plaintext };
}

/** Issue the single-use code a consent answers with; codes past their expiry go with it. */
export async function issueCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scopes: McpOAuthScope[];
  projectIds: string[] | null;
  permissions: string[];
  grantEpoch: number;
}): Promise<string> {
  const { plaintext, hash } = mintSecret('code');
  await db.transaction(async (tx) => {
    await tx
      .delete(mcpOauthCodes)
      .where(lt(mcpOauthCodes.expiresAt, sql`now() - interval '1 day'`));
    await tx.insert(mcpOauthCodes).values({
      ...input,
      codeHash: hash,
      expiresAt: new Date(Date.now() + MCP_OAUTH_CODE_TTL_SECONDS * 1000),
    });
  });
  return plaintext;
}

const invalidGrant = (description: string): TokenOutcome => ({
  error: 'invalid_grant',
  description,
});

/**
 * Redeem a code for a grant. The code must be this client's, unexpired, unredeemed, asked for
 * from this redirect URI, and answered by the verifier of its challenge. A code redeemed a second
 * time was intercepted, and the grant the first redemption made ends (RFC 6749 §4.1.2).
 */
export async function redeemCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenOutcome> {
  return db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(mcpOauthCodes)
      .where(eq(mcpOauthCodes.codeHash, digestToken(input.code)))
      .for('update');
    if (!code) return invalidGrant('this code was never issued');
    if (code.consumedAt) {
      if (code.grantId) {
        const [grant] = await tx
          .select()
          .from(mcpOauthGrants)
          .where(eq(mcpOauthGrants.id, code.grantId));
        if (grant) await endGrant(tx, grant, 'its code was redeemed a second time');
      }
      return invalidGrant('this code was already redeemed; the grant it made is revoked');
    }
    if (code.expiresAt.getTime() <= Date.now()) return invalidGrant('this code expired');
    if (code.clientId !== input.clientId)
      return invalidGrant('this code was issued to another client');
    if (code.redirectUri !== input.redirectUri)
      return invalidGrant('redirect_uri differs from the one this code was asked for');
    if (!pkceAnswers(input.codeVerifier, code.codeChallenge))
      return invalidGrant('code_verifier does not answer this code’s challenge');

    // a newer consent for the same client replaces the earlier one: the client keeps only the
    // tokens it was just given, so the earlier grant would otherwise wait out its month unheld
    const earlier = await tx
      .select()
      .from(mcpOauthGrants)
      .where(
        and(
          eq(mcpOauthGrants.userId, code.userId),
          eq(mcpOauthGrants.clientId, code.clientId),
          isNull(mcpOauthGrants.revokedAt),
        ),
      );
    for (const grant of earlier) await endGrant(tx, grant, 'replaced by a newer consent');

    const refresh = mintSecret('refresh');
    const [grant] = await tx
      .insert(mcpOauthGrants)
      .values({
        clientId: code.clientId,
        userId: code.userId,
        scopes: code.scopes,
        projectIds: code.projectIds,
        permissions: code.permissions,
        grantEpoch: code.grantEpoch,
        resource: code.resource,
        refreshHash: refresh.hash,
        refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      })
      .returning();
    if (!grant) throw new Error('redeemCode: grant insert returned no row');
    const scopes = grant.scopes as McpOAuthScope[];
    const access = await mintAccess(tx, grant, scopes);
    await tx
      .update(mcpOauthGrants)
      .set({ currentTokenId: access.tokenId })
      .where(eq(mcpOauthGrants.id, grant.id));
    await tx
      .update(mcpOauthCodes)
      .set({ consumedAt: sql`now()`, grantId: grant.id })
      .where(eq(mcpOauthCodes.id, code.id));
    return { accessToken: access.plaintext, refreshToken: refresh.plaintext, scopes };
  });
}

/**
 * Exchange a refresh token for a new pair. The token rotates: the one presented is spent, and
 * presented again it ends the grant, since only a thief holds a spent token. A grant whose access
 * token was revoked on the tokens page ends here too, which is how revoking there signs the client
 * out.
 */
export async function refreshGrant(input: {
  refreshToken: string;
  clientId: string;
  scopes: McpOAuthScope[] | null;
}): Promise<TokenOutcome> {
  const hash = digestToken(input.refreshToken);
  return db.transaction(async (tx) => {
    const [grant] = await tx
      .select()
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.refreshHash, hash))
      .for('update');
    if (!grant) {
      const [spent] = await tx
        .select()
        .from(mcpOauthGrants)
        .where(eq(mcpOauthGrants.previousRefreshHash, hash))
        .for('update');
      if (!spent) return invalidGrant('this refresh token was never issued');
      await endGrant(tx, spent, 'a spent refresh token was presented again');
      return invalidGrant('this refresh token was already used; the grant is revoked');
    }
    if (grant.revokedAt) return invalidGrant(`this grant is revoked: ${grant.revokedReason}`);
    if (grant.clientId !== input.clientId)
      return invalidGrant('this refresh token was issued to another client');
    if (grant.refreshExpiresAt.getTime() <= Date.now()) {
      await endGrant(tx, grant, 'its refresh token expired');
      return invalidGrant('this refresh token expired; sign in again');
    }
    if (await accessRevokedByHolder(tx, grant)) {
      await endGrant(tx, grant, 'its access token was revoked on the tokens page');
      return invalidGrant('its access token was revoked on the tokens page; sign in again');
    }
    const held = grant.scopes as McpOAuthScope[];
    const scopes = input.scopes ?? held;
    const beyond = scopes.find((s) => !held.includes(s));
    if (beyond) {
      return { error: 'invalid_scope', description: `this grant does not hold ${beyond}` };
    }

    const access = await mintAccess(tx, grant, scopes);
    const refresh = mintSecret('refresh');
    await tx
      .update(mcpOauthGrants)
      .set({
        currentTokenId: access.tokenId,
        refreshHash: refresh.hash,
        previousRefreshHash: grant.refreshHash,
        refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        refreshedAt: sql`now()`,
      })
      .where(eq(mcpOauthGrants.id, grant.id));
    return { accessToken: access.plaintext, refreshToken: refresh.plaintext, scopes };
  });
}

/**
 * Whether the person revoked the grant's access token themselves: it is gone, or revoked while
 * the grant still pointed at it. Core revokes a grant's token only in the same transaction that
 * moves the grant past it, so a revoked current token was revoked by someone else.
 */
async function accessRevokedByHolder(tx: Tx, grant: McpOauthGrantRow): Promise<boolean> {
  if (!grant.currentTokenId) return true;
  const [token] = await tx
    .select({ revokedAt: personalAccessTokens.revokedAt })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.id, grant.currentTokenId));
  return !token || token.revokedAt !== null;
}

/**
 * The person's grants whose refresh token expired unused end, so the access tokens they hold
 * stop counting against the person's token limit.
 */
export async function endLapsedGrants(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const lapsed = await tx
      .select()
      .from(mcpOauthGrants)
      .where(
        and(
          eq(mcpOauthGrants.userId, userId),
          isNull(mcpOauthGrants.revokedAt),
          lt(mcpOauthGrants.refreshExpiresAt, sql`now()`),
        ),
      );
    for (const grant of lapsed) await endGrant(tx, grant, 'its refresh token expired');
  });
}
