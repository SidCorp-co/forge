import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { isTurnTokenName } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import type { AuthVars } from '../middleware/auth.js';
import type { Author } from './channel-schema.js';

export interface Writer {
  userId: string;
  author: Author;
}

// cm:why the credential decides the author, never the body: an agent's token writes via master, a session via web, a turn token via assistant, any other personal token via cli
export async function writerOf(c: Context<{ Variables: AuthVars }>): Promise<Writer> {
  const userId = c.get('userId');
  const agency = c.get('agency');
  if (!agency) {
    throw new Error(
      'channel: no agency on this request; the route was reached without an auth gate',
    );
  }
  if (agency === 'agent') return { userId, author: { kind: 'agent', id: userId, via: 'master' } };
  if (c.get('principal') !== 'pat') {
    return { userId, author: { kind: 'person', id: userId, via: 'web' } };
  }
  const tokenId = c.get('patTokenId');
  if (!tokenId) throw new Error('channel: a token request carries no token id');
  const [row] = await db
    .select({ name: personalAccessTokens.name })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.id, tokenId))
    .limit(1);
  if (!row) throw new Error(`channel: token ${tokenId} admitted this request and is not stored`);
  return {
    userId,
    author: { kind: 'person', id: userId, via: isTurnTokenName(row.name) ? 'assistant' : 'cli' },
  };
}
