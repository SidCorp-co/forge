import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { isTurnTokenName } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import type { Author } from './channel-schema.js';
import type { EcosystemRefusal } from './refusals.js';

export interface Writer {
  userId: string;
  author: Author;
}

/** The credential a channel act arrived with: a browser session, or a token by its id. */
export interface ChannelCredential {
  userId: string;
  agency: ActorAgency;
  tokenId: string | null;
}

// cm:why the credential decides the author, never the body: an agent's token writes via master, a session via web, a turn token via assistant, any other personal token via cli
export async function writerFor(cred: ChannelCredential): Promise<Writer> {
  const { userId } = cred;
  if (cred.agency === 'agent') {
    return { userId, author: { kind: 'agent', id: userId, via: 'master' } };
  }
  if (cred.tokenId === null) return { userId, author: { kind: 'person', id: userId, via: 'web' } };
  const [row] = await db
    .select({ name: personalAccessTokens.name })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.id, cred.tokenId))
    .limit(1);
  if (!row) throw new Error(`channel: token ${cred.tokenId} admitted this act and is not stored`);
  return {
    userId,
    author: { kind: 'person', id: userId, via: isTurnTokenName(row.name) ? 'assistant' : 'cli' },
  };
}

export async function writerOf(c: Context<{ Variables: AuthVars }>): Promise<Writer> {
  const agency = c.get('agency');
  if (!agency) {
    throw new Error(
      'channel: no agency on this request; the route was reached without an auth gate',
    );
  }
  if (c.get('principal') !== 'pat') {
    return writerFor({ userId: c.get('userId'), agency, tokenId: null });
  }
  const tokenId = c.get('patTokenId');
  if (!tokenId) throw new Error('channel: a token request carries no token id');
  return writerFor({ userId: c.get('userId'), agency, tokenId });
}

/** A chat turn's tools hold a token principal; it is the same derivation the REST door makes. */
export const writerOfPrincipal = (principal: McpPrincipal): Promise<Writer> =>
  writerFor({ userId: principal.userId, agency: principal.agency, tokenId: principal.tokenId });

export type ChannelNeed = 'read' | 'write';

// cm:why one rule for both doors: any role on the side reads its channel, member or above writes it, and no role is refused before anything is read
export async function channelRoleRefusal(
  userId: string,
  projectId: string,
  need: ChannelNeed,
): Promise<EcosystemRefusal | null> {
  const role = (await effectiveProjectRole(userId, projectId))?.role ?? null;
  if (!projectRoleAtLeast(role, 'viewer')) {
    return {
      code: 'CHANNEL_NO_ROLE',
      path: '/from',
      detail: `person ${userId} holds no role on project ${projectId}, so nothing of its channel is read or written as them; a project admin can add them.`,
    };
  }
  if (need === 'write' && !projectRoleAtLeast(role, 'member')) {
    return {
      code: 'CHANNEL_WRITE_NOT_AUTHORISED',
      path: '/from',
      detail: `person ${userId} is a ${role} on project ${projectId}; writing in its channel takes member or above, and a viewer reads only.`,
    };
  }
  return null;
}
