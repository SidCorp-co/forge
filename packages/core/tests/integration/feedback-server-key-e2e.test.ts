/**
 * A product server files feedback into its one project with a server key (ISS-922). A holder of
 * `project.admin`, person or agent, mints a key; the secret is shown once and never listed. The key
 * files `POST /api/projects/:id/feedback` on its project, the item's reporter recorded as the product,
 * and is refused by name on every other route and project, after revoke, after expiry and over its
 * hourly limit, filing nothing. An actor without the permission cannot mint. Through the app, against
 * real Postgres.
 *
 * @direct-test-of packages/core/src/feedback/server-keys.ts
 * @direct-test-of packages/core/src/feedback/server-key-door.ts
 * @direct-test-of packages/core/src/feedback/server-key-routes.ts
 * @direct-test-of packages/core/src/middleware/bearer.ts
 * @direct-test-of packages/core/src/feedback/service.ts
 * @direct-test-of packages/core/src/feedback/read.ts
 * @direct-test-of packages/contracts/src/feedback-server-keys.ts
 * @direct-test-of packages/core/src/db/schema-feedback-server-keys.ts
 * @direct-test-of packages/core/src/lib/advisory-lock.ts
 */

import { randomBytes } from 'node:crypto';
import { FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR } from '@forge/contracts/feedback-server-keys';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { consumeRateLimit } from '../../src/middleware/rate-limit.js';
import { api, type Body, patToken, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

const HOUR_MS = 60 * 60_000;

/** The code an answer names, whether it is a refusal envelope or a door's problem body. */
const codeOf = (b: Body): string | undefined => {
  const error = b.error as Body | undefined;
  const refusals = error?.refusals as { code: string }[] | undefined;
  return refusals?.[0]?.code ?? (error?.code as string | undefined) ?? (b.code as string);
};

const item = (title: string) => ({ kind: 'bug', title, screen: 'Checkout' });

async function filedOn(projectId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${projectId}`,
  );
  return Number(row?.n ?? 0);
}

let projectId: string;
let otherProjectId: string;
let adminJwt: string;
let memberJwt: string;
let agentPat: string;
let agentWithoutPat: string;

const keys = () => `/api/projects/${projectId}/feedback/server-keys`;

async function mint(token: string, body: Body = { product: 'epod' }) {
  return api(token, 'POST', keys(), body);
}

beforeAll(async () => {
  const admin = await createTestUser({ verified: true });
  const project = await createTestProject(admin.id);
  projectId = project.id;
  await addProjectMember(projectId, admin.id, 'admin');
  adminJwt = await userToken(admin.id);
  otherProjectId = (await createTestProject(admin.id)).id;
  await addProjectMember(otherProjectId, admin.id, 'admin');

  const member = await createTestUser({ verified: true });
  await addProjectMember(projectId, member.id, 'member');
  memberJwt = await userToken(member.id);

  const agent = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, agent.id, 'admin');
  agentPat = await patToken(agent.id, [projectId]);

  const writerAgent = await createTestUser({ kind: 'agent' });
  await addProjectMember(projectId, writerAgent.id, 'member');
  agentWithoutPat = await patToken(writerAgent.id, [projectId]);
}, 180_000);

describe('a feedback server key (ISS-922)', () => {
  it('(a) an admin mints it, the secret is shown once, and the listing never shows it', async () => {
    const minted = await mint(adminJwt, { product: 'epod' });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const secret = minted.body.secret as string;
    expect(secret).toMatch(/^fsk_[A-Za-z0-9_-]{43}$/);
    const key = minted.body.key as Body;
    expect(key.product).toBe('epod');
    expect(secret.startsWith(key.prefix as string)).toBe(true);

    const listed = await api(adminJwt, 'GET', keys());
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    const row = (listed.body.keys as Body[]).find((k) => k.id === key.id);
    expect(row).toMatchObject({ product: 'epod', prefix: key.prefix, revokedAt: null });
    expect(row?.createdBy).toMatchObject({ id: expect.any(String) });

    const [stored] = await rows<{ token_hash: string }>(
      sql`SELECT token_hash FROM feedback_server_keys WHERE id = ${key.id as string}`,
    );
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(secret);
  });

  it('(b) files an item on its project, the reporter recorded as the product', async () => {
    const secret = (await mint(adminJwt, { product: 'epod' })).body.secret as string;
    const before = await filedOn(projectId);
    const filed = await api(
      secret,
      'POST',
      `/api/projects/${projectId}/feedback`,
      item('Cart total wrong'),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(filed.body.reporter).toEqual({ kind: 'product', product: 'epod' });
    const fbKey = (filed.body.feedback as Body).key as string;
    expect(fbKey).toMatch(/^FB-\d+$/);
    expect(await filedOn(projectId)).toBe(before + 1);

    // the key reads nothing back: the item is read by a member
    const read = await api(adminJwt, 'GET', `/api/projects/${projectId}/feedback/${fbKey}`);
    expect(read.status).toBe(200);
    const reporters = (read.body.feedback as Body).reporters as Body[];
    expect(reporters[0]).toMatchObject({ agency: 'agent', product: 'epod', name: 'epod' });

    const listed = await api(adminJwt, 'GET', keys());
    const used = (listed.body.keys as Body[]).filter((k) => k.lastUsedAt !== null);
    expect(used.length).toBeGreaterThan(0);
  });

  it('(c) is refused by name on another project and another route, and files nothing', async () => {
    const secret = (await mint(adminJwt, { product: 'epod' })).body.secret as string;
    const here = await filedOn(projectId);
    const there = await filedOn(otherProjectId);

    const elsewhere = await api(
      secret,
      'POST',
      `/api/projects/${otherProjectId}/feedback`,
      item('x'),
    );
    expect(elsewhere.status).toBe(403);
    expect(codeOf(elsewhere.body)).toBe('FEEDBACK_SERVER_KEY_SCOPE');

    const read = await api(secret, 'GET', `/api/projects/${projectId}/feedback`);
    expect(read.status).toBe(403);
    expect(codeOf(read.body)).toBe('FEEDBACK_SERVER_KEY_SCOPE');

    const report = await api(secret, 'POST', `/api/projects/${projectId}/feedback/report`, {
      sentence: 'broken',
    });
    expect(report.status).toBe(403);
    expect(codeOf(report.body)).toBe('FEEDBACK_SERVER_KEY_SCOPE');

    const issue = await api(secret, 'POST', `/api/projects/${projectId}/issues`, { title: 'x' });
    expect(issue.status).toBe(403);
    expect(codeOf(issue.body)).toBe('FEEDBACK_SERVER_KEY_SCOPE');

    const mintWithKey = await mint(secret);
    expect(mintWithKey.status).toBe(403);
    expect(codeOf(mintWithKey.body)).toBe('FEEDBACK_SERVER_KEY_SCOPE');

    const me = await api(secret, 'GET', '/api/auth/me');
    expect(me.status).toBe(403);
    expect(codeOf(me.body)).toBe('FEEDBACK_SERVER_KEY_SCOPE');

    expect(await filedOn(projectId)).toBe(here);
    expect(await filedOn(otherProjectId)).toBe(there);
  });

  it('(c) is refused by name when unknown, after revoke and after expiry, and files nothing', async () => {
    const before = await filedOn(projectId);
    const unknown = `fsk_${randomBytes(32).toString('base64url')}`;
    const stranger = await api(unknown, 'POST', `/api/projects/${projectId}/feedback`, item('x'));
    expect(stranger.status).toBe(401);
    expect(codeOf(stranger.body)).toBe('FEEDBACK_SERVER_KEY_UNKNOWN');

    const minted = await mint(adminJwt, { product: 'epod' });
    const secret = minted.body.secret as string;
    const keyId = (minted.body.key as Body).id as string;
    const revoked = await api(adminJwt, 'DELETE', `${keys()}/${keyId}`);
    expect(revoked.status).toBe(200);
    expect((revoked.body.key as Body).revokedAt).not.toBeNull();
    const again = await api(adminJwt, 'DELETE', `${keys()}/${keyId}`);
    expect(again.status).toBe(409);
    expect(codeOf(again.body)).toBe('FEEDBACK_SERVER_KEY_REVOKED_ALREADY');
    const afterRevoke = await api(secret, 'POST', `/api/projects/${projectId}/feedback`, item('x'));
    expect(afterRevoke.status).toBe(401);
    expect(codeOf(afterRevoke.body)).toBe('FEEDBACK_SERVER_KEY_REVOKED');

    const past = await mint(adminJwt, { product: 'epod', expiresAt: '2020-01-01T00:00:00Z' });
    expect(past.status).toBe(422);
    expect(codeOf(past.body)).toBe('FEEDBACK_SERVER_KEY_EXPIRY_PAST');

    const soon = await mint(adminJwt, {
      product: 'epod',
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    expect(soon.status).toBe(201);
    const soonId = (soon.body.key as Body).id as string;
    await db.execute(
      sql`UPDATE feedback_server_keys SET expires_at = now() - interval '1 minute' WHERE id = ${soonId}`,
    );
    const expired = await api(
      soon.body.secret as string,
      'POST',
      `/api/projects/${projectId}/feedback`,
      item('x'),
    );
    expect(expired.status).toBe(401);
    expect(codeOf(expired.body)).toBe('FEEDBACK_SERVER_KEY_EXPIRED');

    const missing = await api(adminJwt, 'DELETE', `${keys()}/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(codeOf(missing.body)).toBe('FEEDBACK_SERVER_KEY_NOT_FOUND');

    expect(await filedOn(projectId)).toBe(before);
  });

  it('(d) over its hourly limit it is refused 429 by name and files nothing', async () => {
    const minted = await mint(adminJwt, { product: 'epod' });
    const secret = minted.body.secret as string;
    const keyId = (minted.body.key as Body).id as string;
    for (let i = 0; i < FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR; i++) {
      await consumeRateLimit(
        `feedbackServerKey:key:${keyId}`,
        FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR,
        HOUR_MS,
      );
    }
    const before = await filedOn(projectId);
    const over = await api(
      secret,
      'POST',
      `/api/projects/${projectId}/feedback`,
      item('one too many'),
    );
    expect(over.status).toBe(429);
    expect(codeOf(over.body)).toBe('FEEDBACK_SERVER_KEY_RATE_LIMITED');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await filedOn(projectId)).toBe(before);

    // the limit is the key's: another key of the same product still files
    const fresh = (await mint(adminJwt, { product: 'epod' })).body.secret as string;
    const ok = await api(fresh, 'POST', `/api/projects/${projectId}/feedback`, item('fresh key'));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('(e) an agent token holding project.admin mints; an actor without it is refused by name', async () => {
    const byAgent = await mint(agentPat, { product: 'epod-agent' });
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(201);
    expect(byAgent.body.secret).toMatch(/^fsk_/);

    const byMember = await mint(memberJwt);
    expect(byMember.status).toBe(403);
    expect(codeOf(byMember.body)).toMatch(/FORBIDDEN|PERMISSION/);

    const byWriterAgent = await mint(agentWithoutPat);
    expect(byWriterAgent.status).toBe(403);
    expect(codeOf(byWriterAgent.body)).toMatch(/FORBIDDEN|PERMISSION/);

    const listByMember = await api(memberJwt, 'GET', keys());
    expect(listByMember.status).toBe(403);
  });
});
