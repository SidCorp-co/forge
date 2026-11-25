/**
 * A product server files feedback into its one project with a server key (ISS-922). A holder of
 * `project.admin`, person or agent, mints a key; the secret is shown once and never listed. The key
 * files `POST /api/projects/:id/feedback` on its project, the item's reporter recorded as the product,
 * and is refused by name on every other route and project, after revoke, after expiry and over its
 * hourly limit, filing nothing. An actor without the permission cannot mint. It reads back the phase
 * and chip of an item its product filed, the same the project's feedback page reads (ISS-1287), and is
 * refused by name on an item another reporter filed. A declined item's read names the reason its decline
 * wrote for the reporter, and nothing else of the item (ISS-1412). Through the app, against real Postgres.
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
import { TRIAGE_ANSWERS } from '../helpers/triage-answers.js';

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

    // a member reads the item's reporter: the key reads only where it stands, in (f)
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

describe('a feedback server key reading back (ISS-1287)', () => {
  it('(f) reads the phase and chip of an item its product filed, as the page reads them, and no other item', async () => {
    const secret = (await mint(adminJwt, { product: 'epod' })).body.secret as string;
    const filed = await api(
      secret,
      'POST',
      `/api/projects/${projectId}/feedback`,
      item('Stock off'),
    );
    const fbKey = (filed.body.feedback as Body).key as string;
    const at = (key: string) => `/api/projects/${projectId}/feedback/${key}`;

    const asPage = async () => {
      const page = await api(adminJwt, 'GET', at(fbKey));
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      const view = page.body.feedback as Body;
      return { key: fbKey, phase: view.phase, chip: view.chip };
    };
    const read = await api(secret, 'GET', at(fbKey));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toEqual({ feedback: { ...(await asPage()), declineReason: null, declineReasonWithheld: false } });
    expect(read.body.feedback).toMatchObject({ phase: 'new', chip: 'new' });

    const declined = await api(adminJwt, 'POST', `${at(fbKey)}/triage`, {
      route: 'decline',
      note: 'Stock is counted nightly.',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    const after = await api(secret, 'GET', at(fbKey));
    expect(after.body).toEqual({
      feedback: { ...(await asPage()), declineReason: 'Stock is counted nightly.', declineReasonWithheld: false },
    });
    expect(after.body.feedback).toMatchObject({ phase: 'declined', chip: 'declined' });

    // every key of the product names one reporter, so a re-minted key reads what the old one filed
    const reminted = (await mint(adminJwt, { product: 'epod' })).body.secret as string;
    expect((await api(reminted, 'GET', at(fbKey))).status).toBe(200);

    const byPerson = await api(adminJwt, 'POST', `/api/projects/${projectId}/feedback`, item('y'));
    const personKey = (byPerson.body.feedback as Body).key as string;
    const otherProduct = (await mint(adminJwt, { product: 'shop' })).body.secret as string;
    const byShop = await api(
      otherProduct,
      'POST',
      `/api/projects/${projectId}/feedback`,
      item('z'),
    );
    const shopKey = (byShop.body.feedback as Body).key as string;
    for (const key of [personKey, shopKey]) {
      const theirs = await api(secret, 'GET', at(key));
      expect(theirs.status, JSON.stringify(theirs.body)).toBe(403);
      expect(codeOf(theirs.body)).toBe('FEEDBACK_SERVER_KEY_NOT_ITS_FILING');
      expect(JSON.stringify(theirs.body)).not.toContain('"phase"');
    }

    const closed: ['GET' | 'POST', string][] = [
      ['GET', `${at(fbKey)}/similar`],
      ['POST', `${at(fbKey)}/triage`],
      ['GET', at('endpoints')],
      ['GET', `/api/projects/${otherProjectId}/feedback/${fbKey}`],
    ];
    for (const [method, path] of closed) {
      const out = await api(
        secret,
        method,
        path,
        method === 'POST' ? { route: 'decline' } : undefined,
      );
      expect(out.status, `${method} ${path}`).toBe(403);
      expect(codeOf(out.body), `${method} ${path}`).toBe('FEEDBACK_SERVER_KEY_SCOPE');
    }
  });
});

describe('a feedback server key reading a decline (ISS-1412)', () => {
  it('(g) names the reason the decline holding the item wrote for its reporter, null in every other phase, and the full read is unchanged', async () => {
    const secret = (await mint(adminJwt, { product: 'epod' })).body.secret as string;
    const at = (key: string) => `/api/projects/${projectId}/feedback/${key}`;
    const file = async (title: string) => {
      const filed = await api(secret, 'POST', `/api/projects/${projectId}/feedback`, item(title));
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      return (filed.body.feedback as Body).key as string;
    };
    const asKey = async (key: string) => {
      const read = await api(secret, 'GET', at(key));
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      return read.body;
    };
    const say = async (path: string, body: Body, status = 200) => {
      const out = await api(adminJwt, 'POST', path, body);
      expect(out.status, JSON.stringify(out.body)).toBe(status);
    };

    const root = await file('Labels print blank');
    const twin = await file('Labels come out empty');
    const routed = await file('Price rounds down');
    await say(`${at(twin)}/triage`, {
      answers: TRIAGE_ANSWERS,
      route: 'duplicate',
      duplicateOf: root,
    });
    await say(`${at(routed)}/triage`, { answers: TRIAGE_ANSWERS, route: 'issue', createIssue: {} });
    // an internal note and a triager's message are on the item too; neither reaches the key
    await say(
      `${at(root)}/messages`,
      { audience: 'internal', text: 'Printer driver, not us.' },
      201,
    );

    // not declined yet: every phase but declined reads null
    for (const key of [root, twin, routed]) {
      const body = await asKey(key);
      expect((body.feedback as Body).phase, key).not.toBe('declined');
      expect((body.feedback as Body).declineReason, key).toBeNull();
      expect((body.feedback as Body).declineReasonWithheld, key).toBe(false);
    }

    const fullBefore = await api(adminJwt, 'GET', at(root));
    expect(fullBefore.status).toBe(200);
    await say(`${at(root)}/triage`, { route: 'decline', note: 'The printer driver prints blank.' });

    const declined = await asKey(root);
    expect(declined).toEqual({
      feedback: {
        key: root,
        phase: 'declined',
        chip: 'declined',
        declineReason: 'The printer driver prints blank.',
        declineReasonWithheld: false,
      },
    });
    expect(JSON.stringify(declined)).not.toContain('Printer driver, not us.');

    // the duplicate reads its root's phase, and its reporter was told the root's reason
    const merged = await asKey(twin);
    expect(merged.feedback).toMatchObject({
      phase: 'declined',
      declineReason: 'The printer driver prints blank.',
    });
    expect((await asKey(routed)).feedback).toMatchObject({
      declineReason: null,
      declineReasonWithheld: false,
    });

    // a person's full read gains no field and still holds the reason in its decisions
    const full = await api(adminJwt, 'GET', at(root));
    expect(full.status).toBe(200);
    const view = full.body.feedback as Body;
    expect(view).not.toHaveProperty('declineReason');
    expect(Object.keys(view).sort()).toEqual(Object.keys(fullBefore.body.feedback as Body).sort());
    const reasons = (view.decisions as Body[]).filter((d) => d.decision === 'declined');
    expect(reasons.map((d) => d.reason)).toEqual(['The printer driver prints blank.']);
  });
  it('(h) withholds the reason where the project keeps decision reasons from every agent (no_egress)', async () => {
    const admin = await createTestUser({ verified: true });
    const closed = (await createTestProject(admin.id)).id;
    await addProjectMember(closed, admin.id, 'admin');
    const { seedProjectDocument } = await import('../helpers/release-world.js');
    await seedProjectDocument(closed, admin.id, {
      environments: {},
      extra: { sensitiveData: 'no_egress' },
    });
    const jwt = await userToken(admin.id);
    const minted = await api(jwt, 'POST', `/api/projects/${closed}/feedback/server-keys`, {
      product: 'epod',
    });
    const secret = minted.body.secret as string;
    const filed = await api(secret, 'POST', `/api/projects/${closed}/feedback`, item('Kept in'));
    const key = (filed.body.feedback as Body).key as string;
    const at = `/api/projects/${closed}/feedback/${key}`;
    const declined = await api(jwt, 'POST', `${at}/triage`, {
      route: 'decline',
      note: 'Patient 4411 asked for it.',
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    const read = await api(secret, 'GET', at);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.feedback).toMatchObject({
      phase: 'declined',
      declineReason: null,
      declineReasonWithheld: true,
    });
    expect(JSON.stringify(read.body)).not.toContain('4411');
  });
});
