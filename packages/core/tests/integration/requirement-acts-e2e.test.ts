/**
 * The person acts on a requirement the HOP end-to-end trial (2026-10-04) found missing, against a
 * real database: an accept carries the signer's reason onto the act and the baseline it writes
 * (ISS-84, FB-16); a requirement is deferred out of the current release and undeferred back
 * (ISS-85, FB-17).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
} from '../helpers/index.js';

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read at arbitrary depth
type Doc = Record<string, any>;

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let person: string;
let agent: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const bot = await createTestUser(harness.db, { kind: 'agent' });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await createTestProjectMember(harness.db, { userId: bot.id, projectId, role: 'member' });
  person = await signUserToken(owner.id);
  agent = await signUserToken(bot.id);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Doc };
}

async function ok(token: string, method: string, path: string, body?: unknown) {
  const r = await call(token, method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

/** REQ-n agreed at revision 1 with criteria BC-1 and BC-2. */
async function agreedRequirement(title: string): Promise<string> {
  const created = await ok(person, 'POST', '/requirements', {
    title,
    reason: 'planted',
    criteria: [{ body: 'A nurse sees the reminder' }, { body: 'A doctor sees the report' }],
  });
  const key = created.key as string;
  await ok(person, 'POST', `/requirements/${key}/revisions/1/propose`, {});
  await ok(person, 'POST', `/requirements/${key}/revisions/1/accept`, {});
  await ok(person, 'POST', `/requirements/${key}/agree`, { revision: 1 });
  return key;
}

const DELEGATION = "Test approval under the owner's testing delegation (2026-10-04)";

describe('an accept carries the signer’s reason (ISS-84)', () => {
  it('a suggestion accept keeps its reason on the row and on the decision', async () => {
    const req = await agreedRequirement('Reasons');
    const proposed = await ok(agent, 'POST', '/suggestions', {
      kind: 'readiness',
      requirement: req,
      baseRevision: 1,
      payload: { checks: [{ check: 'criteria are testable', passed: true }] },
    });
    const accepted = await ok(person, 'POST', `/suggestions/${proposed.suggestion.id}/accept`, {
      reason: DELEGATION,
    });
    expect(accepted.suggestion).toMatchObject({ status: 'accepted', reason: DELEGATION });
    const detail = await ok(person, 'GET', `/requirements/${req}`);
    expect(detail.history.map((h: Doc) => h.text)).toContain(
      `Accepted a readiness check: ${DELEGATION}`,
    );
  });

  it('a revision accept keeps the signer’s reason on the revision and the re-baseline, never the author’s', async () => {
    const req = await agreedRequirement('Re-baseline');
    await ok(agent, 'POST', `/requirements/${req}/revisions`, {
      baseRevision: 1,
      reason: 'the author drafted a sharper BC-2',
      criteria: [
        { code: 'BC-1', body: 'A nurse sees the reminder' },
        { code: 'BC-2', body: 'A doctor sees the weekly report' },
      ],
    });
    await ok(agent, 'POST', `/requirements/${req}/revisions/2/propose`, {});
    const accepted = await ok(person, 'POST', `/requirements/${req}/revisions/2/accept`, {
      reason: DELEGATION,
    });
    expect(accepted.revisions[0]).toMatchObject({
      revision: 2,
      reason: 'the author drafted a sharper BC-2',
      acceptReason: DELEGATION,
    });
    expect(accepted.baselines[0]).toMatchObject({ revision: 2, reason: DELEGATION });
  });

  it('an accept with no reason stores none, rather than borrowing the author’s', async () => {
    const req = await agreedRequirement('No reason');
    await ok(agent, 'POST', `/requirements/${req}/revisions`, {
      baseRevision: 1,
      reason: 'author words',
      criteria: [{ code: 'BC-1', body: 'A nurse sees the reminder today' }],
    });
    await ok(agent, 'POST', `/requirements/${req}/revisions/2/propose`, {});
    await ok(person, 'POST', `/requirements/${req}/revisions/2/accept`, {});
    const rows = (await harness.db.execute(sql`
      SELECT rv.accept_reason, b.reason AS baseline_reason
        FROM requirement_revisions rv
        JOIN requirements r ON r.id = rv.requirement_id
        JOIN requirement_baselines b ON b.requirement_id = rv.requirement_id AND b.revision = rv.revision
       WHERE r.project_id = ${projectId} AND r.title = 'No reason' AND rv.revision = 2`)) as unknown as Doc[];
    expect([...rows]).toEqual([{ accept_reason: null, baseline_reason: null }]);
  });
});

describe('a requirement is deferred out of the current release and undeferred (ISS-85)', () => {
  it('a deferred draft waits on nobody, refuses a sign-off and a breakdown, and undefers back to draft', async () => {
    const created = await ok(person, 'POST', '/requirements', {
      title: 'Later scope',
      reason: 'planted',
      criteria: [{ body: 'Someday' }],
    });
    const key = created.key as string;
    await ok(agent, 'POST', `/requirements/${key}/revisions/1/propose`, {});
    const deferred = await ok(person, 'POST', `/requirements/${key}/defer`, {
      reason: 'out of the pilot release',
      targetPhase: 'phase 2',
    });
    expect(deferred).toMatchObject({
      status: 'deferred',
      deferral: { from: 'draft', reason: 'out of the pilot release', targetPhase: 'phase 2' },
      standing: { state: 'deferred', attentionGroup: 'deferred', waitingOn: { kind: 'none' } },
    });
    const accept = await call(person, 'POST', `/requirements/${key}/revisions/1/accept`, {});
    expect(accept.status).toBe(422);
    expect(accept.body.error.code).toBe('REQUIREMENT_DEFERRED');
    const again = await call(person, 'POST', `/requirements/${key}/defer`, { reason: 'again' });
    expect(again.body.error.code).toBe('REQUIREMENT_DEFERRED');
    const undeferred = await ok(person, 'POST', `/requirements/${key}/undefer`, {});
    expect(undeferred).toMatchObject({ status: 'draft', deferral: null });
    expect(undeferred.standing.attentionGroup).not.toBe('deferred');
    const twice = await call(person, 'POST', `/requirements/${key}/undefer`, {});
    expect(twice.body.error.code).toBe('REQUIREMENT_NOT_DEFERRED');
    const texts = undeferred.history.map((h: Doc) => h.text);
    expect(texts).toContain(
      'Deferred out of the current release (for phase 2): out of the pilot release',
    );
    expect(texts).toContain('Undeferred');
  });

  it('an agreed requirement is not deferred while a linked issue is in work, and a deferred one takes no breakdown', async () => {
    const key = await agreedRequirement('Agreed then deferred');
    const issue = await ok(person, 'POST', '/issues', { title: 'In work', status: 'open' });
    await ok(person, 'POST', `/requirements/${key}/issues`, { issue: issue.id });
    const refused = await call(person, 'POST', `/requirements/${key}/defer`, { reason: 'later' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.refusals[0]).toMatchObject({ code: 'REQUIREMENT_HAS_LIVE_ISSUES' });
    expect(refused.body.error.refusals[0].detail).toContain(issue.displayId);
    await ok(person, 'DELETE', `/requirements/${key}/issues/${issue.id}`);
    await ok(person, 'POST', `/requirements/${key}/defer`, { reason: 'later' });
    const breakdown = await call(agent, 'POST', '/suggestions', {
      kind: 'breakdown',
      requirement: key,
      baseRevision: 1,
      payload: { issues: [{ title: 'Should not be proposed' }] },
    });
    expect(breakdown.status).toBe(422);
    expect(breakdown.body.error.refusals[0]).toMatchObject({ code: 'REQUIREMENT_DEFERRED' });
    expect((await ok(person, 'POST', `/requirements/${key}/undefer`, {})).status).toBe('agreed');
  });
});
