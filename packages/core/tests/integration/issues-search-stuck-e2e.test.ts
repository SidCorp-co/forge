/**
 * ISS-1229 r14, judge-35: Needs you listed five of six stuck issues and sent the sixth to an Issues
 * list that marks nothing as stuck. `stuck=true` keeps exactly the issues a stuck-issue notice stands
 * for, by the condition the project page's stuck count reads, so the link lands on what it counted.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let viewer: string;
let projectId: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  viewer = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${viewer}`);
  projectId = (await createTestProject(harness.db, viewer)).id;
  await createTestProjectMember(harness.db, { userId: viewer, projectId, role: 'admin' });
});

async function issue(status: string): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${viewer}, now(), now())
  `);
  return id;
}

/** A stuck-issue notice on the issue, standing or long resolved. */
async function notice(issueId: string, kind: string, resolved = false): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key, resolved_at)
    VALUES (${projectId}, ${issueId}, 'issue_stranded', 'condition', 'ticket',
            ${resolved ? 'resolved' : 'firing'}, 'stuck', ${`issue:${issueId}:${kind}`},
            ${resolved ? sql`now()` : null})
  `);
}

async function search(query: string) {
  const res = await app.request(`/api/projects/${projectId}/issues/search?${query}`, {
    headers: { authorization: `Bearer ${await signUserToken(viewer)}` },
  });
  return { status: res.status, body: (await res.json()) as { items?: Array<{ id: string }> } };
}

describe('the Issues list of the stuck issues', () => {
  it('lists exactly the issues a stuck-issue notice stands for', async () => {
    const idle = await issue('open');
    const orphan = await issue('in_progress');
    const recovered = await issue('open');
    await issue('open');
    await notice(idle, 'idle');
    await notice(orphan, 'run-assertion-orphaned');
    await notice(recovered, 'idle', true);

    const { status, body } = await search('stuck=true');

    expect(status).toBe(200);
    expect((body.items ?? []).map((i) => i.id).sort()).toEqual([idle, orphan].sort());
    expect((await search('')).body.items).toHaveLength(4);
  });

  it('refuses a stuck value that is not true or false, by name', async () => {
    const { status, body } = await search('stuck=sometimes');

    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('stuck');
  });
});
