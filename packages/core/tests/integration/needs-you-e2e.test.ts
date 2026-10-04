// The navigation's waiting-on-you counts, read through the real route over a real database: each
// count moves with a row planted where its list shows it, and always equals that list's own group.

import type { NeedsYouResponse } from '@forge/contracts/needs-you';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
const tokens: Record<'owner' | 'stranger', string> = { owner: '', stranger: '' };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  tokens.owner = await signUserToken(owner.id);
  const stranger = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  tokens.stranger = await signUserToken(stranger.id);
});

type Body = Record<string, unknown>;

async function call(
  who: keyof typeof tokens,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function ok(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<Body> {
  const r = await call('owner', method, path, body);
  expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

const needsYou = async () => (await ok('/needs-you')) as unknown as NeedsYouResponse;

/** Each list as its own screen reads it, counted the way that screen groups it. */
async function listCounts() {
  const requirements = (await ok('/requirements')).requirements as Array<{
    standing: { attentionGroup: string; state: string };
  }>;
  const feedback = (await ok('/feedback')) as {
    counts: { you: number };
    feedback: Array<{ phase: string }>;
  };
  const issues = (await ok('/issues/standing')) as { counts: { needsYou: number } };
  const releases = (await ok('/releases')) as { counts: { you: number } };
  const contracts = (await ok('/contract-standing')).contracts as Array<{ attentionGroup: string }>;
  return {
    requirements: requirements.filter((r) => r.standing.attentionGroup === 'needs_you').length,
    inDelivery: requirements.filter((r) => r.standing.state === 'in_delivery').length,
    feedback: feedback.counts.you,
    untriaged: feedback.feedback.filter((f) => f.phase === 'new' || f.phase === 'reopened').length,
    issues: issues.counts.needsYou,
    releases: releases.counts.you,
    contracts: contracts.filter((c) => c.attentionGroup === 'needs_you').length,
  };
}

function expectAgrees(n: NeedsYouResponse, lists: Awaited<ReturnType<typeof listCounts>>) {
  expect(n.areas.requirements.you).toBe(lists.requirements);
  expect(n.areas.feedback.you).toBe(lists.feedback);
  expect(n.areas.issues.you).toBe(lists.issues);
  expect(n.areas.releases.you).toBe(lists.releases);
  expect(n.areas.contracts.you).toBe(lists.contracts);
  expect(n.requirementsInDelivery).toBe(lists.inDelivery);
  expect(n.untriagedFeedback).toBe(lists.untriaged);
  for (const area of Object.values(n.areas)) {
    expect(area.acts.reduce((sum, a) => sum + a.count, 0)).toBe(area.you);
  }
}

describe('GET /api/projects/:id/needs-you', () => {
  it('reads nothing waiting on a project with nothing in it, as every list does', async () => {
    const n = await needsYou();
    expect(Object.values(n.areas).map((a) => a.you)).toEqual([0, 0, 0, 0, 0]);
    expectAgrees(n, await listCounts());
  });

  it('counts a feedback item the moment the list shows it as waiting on the viewer', async () => {
    await ok('/feedback', 'POST', {
      kind: 'bug',
      title: 'Overdue filter ignores the ward',
      screen: 'Cases',
    });
    const n = await needsYou();
    expect(n.areas.feedback.you).toBe(1);
    expect(n.untriagedFeedback).toBe(1);
    expect(n.areas.feedback.acts).toEqual([{ act: 'triage it', count: 1 }]);
    expectAgrees(n, await listCounts());
  });

  it('counts a requirement from its first draft, and keeps agreeing with the list once proposed', async () => {
    expect((await needsYou()).areas.requirements.you).toBe(0);
    const created = await ok('/requirements', 'POST', {
      title: 'Discharge follow-up',
      reason: 'planted',
      criteria: [{ body: 'A nurse sees the reminder' }],
    });
    const drafted = await needsYou();
    expect(drafted.areas.requirements.you).toBe(1);
    expectAgrees(drafted, await listCounts());
    await ok(`/requirements/${created.key as string}/revisions/1/propose`, 'POST', {});
    const proposed = await needsYou();
    expect(proposed.areas.requirements.acts).not.toEqual(drafted.areas.requirements.acts);
    expectAgrees(proposed, await listCounts());
  });

  it('moves the issue count with an issue the Issues list puts under Needs you', async () => {
    const before = await needsYou();
    await harness.db.execute(sql`
      INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
      VALUES (${projectId}, 1, 'Reminder schedule', 'draft', ${ownerId})`);
    const lists = await listCounts();
    const after = await needsYou();
    expect(lists.issues).toBeGreaterThan(before.areas.issues.you);
    expectAgrees(after, lists);
  });

  it('refuses a caller who is not a member of the project', async () => {
    const r = await call('stranger', 'GET', '/needs-you');
    expect(r.status).toBe(403);
  });

  it('refuses a query it does not read, naming it', async () => {
    const r = await call('owner', 'GET', '/needs-you?area=feedback');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('area');
  });
});
