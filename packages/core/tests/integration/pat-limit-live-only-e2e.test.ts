import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { countActivePatsForUser, mintPat, revokePat } from '../../src/credentials/pat.js';
import { assertUnderTokenLimit } from '../../src/credentials/pat-grant-checks.js';
import { db } from '../../src/db/client.js';
import { personalAccessTokens } from '../../src/db/schema.js';
import { env } from '../../src/lib/env.js';
import { createTestUser } from '../helpers/factories.js';

// @direct-test-of packages/core/src/credentials/pat.ts
// @direct-test-of packages/core/src/credentials/pat-grant-checks.ts
//
// ISS-1124: the personal access token cap counts only live tokens. An expired token, never revoked
// (an MCP-OAuth or turn token that ran out), and a revoked one hold no seat; the refusal says how
// many live tokens it counted.

const PAST = new Date(Date.now() - 24 * 60 * 60_000);
const FUTURE = new Date(Date.now() + 24 * 60 * 60_000);

async function mintMany(userId: string, n: number, prefix: string, expiresAt: Date | null) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const minted = await mintPat({
      permissions: ['*'],
      userId,
      name: `${prefix}-${i}`,
      projectIds: null,
      expiresAt,
    });
    ids.push(minted.row.id);
  }
  return ids;
}

async function refusal(userId: string): Promise<{ code?: string; text: string } | null> {
  try {
    await assertUnderTokenLimit(userId);
    return null;
  } catch (err) {
    const e = err as { refusals?: { code: string }[]; message?: string; getResponse?: unknown };
    return { code: e.refusals?.[0]?.code, text: JSON.stringify(e.refusals ?? e.message) };
  }
}

describe('ISS-1124: the token cap counts live tokens only', () => {
  let expiredOnly = '';
  let atCap = '';

  beforeAll(async () => {
    expiredOnly = (await createTestUser({ verified: true })).id;
    atCap = (await createTestUser({ verified: true })).id;
    await mintMany(expiredOnly, env.PAT_MAX_PER_USER, 'expired', PAST);
  }, 120_000);

  it('lets a person holding only expired tokens, as many as the cap, mint a new one', async () => {
    expect(await refusal(expiredOnly)).toBeNull();
    expect(await countActivePatsForUser(expiredOnly)).toBe(0);
  });

  it('refuses a person at the cap of live tokens PAT_LIMIT, naming the live count', async () => {
    // one short of the cap live, plus expired and revoked ones that hold no seat
    const live = await mintMany(atCap, env.PAT_MAX_PER_USER - 1, 'live', FUTURE);
    await mintMany(atCap, 3, 'gone', PAST);
    const [revoked] = await mintMany(atCap, 1, 'revoked', null);
    await revokePat(revoked as string, atCap);
    expect(await countActivePatsForUser(atCap)).toBe(env.PAT_MAX_PER_USER - 1);
    expect(await refusal(atCap)).toBeNull();
    // the boundary: one more live token fills the cap
    await mintMany(atCap, 1, 'last', null);
    const refused = await refusal(atCap);
    expect(refused?.code).toBe('PAT_LIMIT');
    expect(refused?.text).toContain(`you hold ${env.PAT_MAX_PER_USER} live personal access tokens`);
    // and a live one running out frees its seat
    await db
      .update(personalAccessTokens)
      .set({ expiresAt: PAST })
      .where(eq(personalAccessTokens.id, live[0] as string));
    expect(await refusal(atCap)).toBeNull();
  });
});
