/**
 * ISS-1176 — the two behaviours the end-user help pages state, observed through the doors a person
 * uses rather than restated from the code.
 *
 * "Ask for a change" says a new issue starts at Open, or at Draft with an `intake` label where the
 * project reviews new issues first. "Tell when an issue is done" says the issue page shows the
 * release note, which only holds while the issue read serves `releaseNotes`. Each is a claim the
 * product could stop keeping without any help page noticing, so each is asserted here, through
 * `app.request` with a real credential against real Postgres.
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
let mintPat: typeof import('../../src/auth/pat.js').mintPat;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ mintPat } = await import('../../src/auth/pat.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let personId: string;
let token: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${personId}`);
  ({ plaintext: token } = await mintPat({ userId: personId, name: `help-${randomUUID()}` }));
});

async function projectWith(pipelineConfig: Record<string, unknown>): Promise<string> {
  const project = await createTestProject(harness.db, personId, {
    agentConfig: { pipelineConfig },
  });
  await createTestProjectMember(harness.db, {
    userId: personId,
    projectId: project.id,
    role: 'admin',
  });
  return project.id;
}

/** The body the New issue form's Standard tab sends: no status, so the project decides it. */
async function fileFromTheForm(projectId: string): Promise<{ id: string; status: string }> {
  const res = await app.request(`/api/projects/${projectId}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'The invoice PDF shows the billing address',
      priority: 'medium',
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; status: string };
}

async function labelNames(issueId: string): Promise<string[]> {
  const rows = (await harness.db.execute(sql`
    SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = ${issueId}
  `)) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('"Ask for a change": the status a new issue starts at', () => {
  it('starts at open on a project that does not review new issues first', async () => {
    const projectId = await projectWith({});
    const created = await fileFromTheForm(projectId);
    expect(created.status).toBe('open');
    expect(await labelNames(created.id)).not.toContain('intake');
  });

  it('starts at draft carrying the intake label on a project whose intake gate is on', async () => {
    const projectId = await projectWith({ intakeGate: { enabled: true, notify: false } });
    const created = await fileFromTheForm(projectId);
    expect(created.status).toBe('draft');
    expect(await labelNames(created.id)).toContain('intake');
  });
});

describe('"Tell when an issue is done": the issue read serves the release note the page shows', () => {
  it('returns releaseNotes.userFacing on GET /api/issues/:id', async () => {
    const projectId = await projectWith({});
    const created = await fileFromTheForm(projectId);
    const note = { section: 'Fixed', userFacing: 'The invoice PDF now shows the billing address.' };
    await harness.db.execute(
      sql`UPDATE issues SET release_notes = ${JSON.stringify(note)}::jsonb WHERE id = ${created.id}`,
    );

    const res = await app.request(`/api/issues/${created.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releaseNotes?: { section: string; userFacing: string } | null;
    };
    expect(body.releaseNotes).toMatchObject(note);
  });
});
