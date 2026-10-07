import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import type { StatedPatGrant } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { personalAccessTokens } from '../../src/db/schema.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

// A token whose grant is NULL or empty was minted before a token stated what it may reach. It is
// refused by name at every door, never read as the whole menu, and mint never writes that shape.

let ownerId = '';
let projectId = '';

async function tokenWithGrant(name: string, permissions: string[] | null) {
  const minted = await mintPat({ permissions: ['*'], userId: ownerId, name, projectIds: null });
  await db
    .update(personalAccessTokens)
    .set({ permissions })
    .where(eq(personalAccessTokens.id, minted.row.id));
  return minted;
}

beforeAll(async () => {
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'owner');
}, 120_000);

describe('a token stating no grant', () => {
  it('is refused PAT_GRANT_UNSTATED on a guarded route when its grant is NULL', async () => {
    const { plaintext, row } = await tokenWithGrant('unstated-null', null);
    const res = await api(plaintext, 'GET', `/api/projects/${projectId}/labels`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('PAT_GRANT_UNSTATED');
    expect(JSON.stringify(res.body)).toContain(row.tokenPrefix);
  });

  it('is refused PAT_GRANT_UNSTATED when its grant is empty', async () => {
    const { plaintext } = await tokenWithGrant('unstated-empty', []);
    const res = await api(plaintext, 'GET', `/api/projects/${projectId}/labels`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('PAT_GRANT_UNSTATED');
  });

  it('is not marked used by the request it was refused on', async () => {
    const { plaintext, row } = await tokenWithGrant('unstated-unused', null);
    await api(plaintext, 'GET', `/api/projects/${projectId}/labels`);
    const [after] = await db
      .select({ lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, row.id));
    expect(after?.lastUsedAt ?? null).toBeNull();
  });

  it('a stated full grant still reaches the same route', async () => {
    const { plaintext } = await tokenWithGrant('stated-full', ['*']);
    const res = await api(plaintext, 'GET', `/api/projects/${projectId}/labels`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('is listed as unstated, so the listing says it reaches nothing', async () => {
    const { row } = await tokenWithGrant('unstated-listed', null);
    const res = await api(await userToken(ownerId), 'GET', '/api/pat');
    expect(res.status).toBe(200);
    const listed = (res.body.tokens as { id: string; grant: string }[]).find(
      (t) => t.id === row.id,
    );
    expect(listed?.grant).toBe('unstated');
  });
});

describe('mintPat', () => {
  it('refuses a grant naming nothing rather than writing NULL', async () => {
    await expect(
      mintPat({
        permissions: [] as unknown as StatedPatGrant,
        userId: ownerId,
        name: 'mint-empty',
      }),
    ).rejects.toThrow(/states no grant/);
    await expect(
      mintPat({
        permissions: undefined as unknown as StatedPatGrant,
        userId: ownerId,
        name: 'mint-omitted',
      }),
    ).rejects.toThrow(/states no grant/);
    const names = await db
      .select({ name: personalAccessTokens.name })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, ownerId));
    expect(names.map((n) => n.name)).not.toContain('mint-empty');
    expect(names.map((n) => n.name)).not.toContain('mint-omitted');
  });
});
