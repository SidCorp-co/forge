/**
 * ISS-969, proved by watching it: off, then on, then the number moving.
 *
 * The unit suite proves the branch. It cannot prove the two things this phase
 * actually claims — that the column stores the stage the issue was AT, and that
 * the metric moves by exactly one when one qualifying body lands. Both are
 * facts about what Postgres holds afterwards, and the mocked suite is
 * structurally unable to hold an opinion about either.
 *
 * The `format = 'html'` half matters most. A metric that counted body TEXT
 * would pass every assertion below except the one that plants a markdown body
 * mentioning the component by name, which is why that case is here.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const OUTCOME_BODY = '<forge-outcome kind="done"><p>shipped</p></forge-outcome>';

let harness: TestDatabase;
let insertComment: typeof import('../../src/comments/service.js').insertComment;
let updateCommentBody: typeof import('../../src/comments/service.js').updateCommentBody;
let readBodyAdoption: typeof import('../../src/body/adoption.js').readBodyAdoption;
let schema: typeof import('../../src/db/schema.js');

let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let bodyProjectRoutes: typeof import('../../src/body/routes.js')['bodyProjectRoutes'];
// cm:guard every core import in this file is DYNAMIC and happens after the env vars in `beforeAll` are set — `middleware/pat-rest-surface.js` reaches `db/client.ts` at module load, so a static import of it fails the whole suite on `Invalid environment` before a single case runs.
let patSurfaceCovers: typeof import('../../src/middleware/pat-rest-surface.js')['patSurfaceCovers'];
let errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

let userId: string;
let projectId: string;
let deviceId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  ({ insertComment, updateCommentBody } = await import('../../src/comments/service.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ bodyProjectRoutes } = await import('../../src/body/routes.js'));
  ({ patSurfaceCovers } = await import('../../src/middleware/pat-rest-surface.js'));
  ({ errorHandler } = await import('../../src/middleware/error.js'));
  app = new Hono();
  app.onError(errorHandler);
  app.route('/api/projects', bodyProjectRoutes);
  ({ readBodyAdoption } = await import('../../src/body/adoption.js'));
  schema = await import('../../src/db/schema.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  // cm:guard `bodyRoutes` runs `assertEmailVerified()`, so the route cases at the bottom of this file need a VERIFIED owner — the factory's default is deliberately unverified and an unverified one 403s before membership is ever consulted, which reads exactly like the authorization case passing.
  userId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  projectId = (await createTestProject(harness.db, userId)).id;
  deviceId = randomUUID();
  await harness.db.insert(schema.devices).values({
    id: deviceId,
    ownerId: userId,
    name: 'iss-969-box',
    platform: 'linux',
  });
});

async function anIssue(status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.insert(schema.issues).values({
    id,
    projectId,
    title: 'stage policy fixture',
    createdById: userId,
    status: status as 'open',
  });
  return id;
}

async function requireAtStage(stage: string, component: string | null): Promise<void> {
  const states = component ? { [stage]: { bodyPolicy: { requireComponent: component } } } : {};
  await harness.db.execute(sql`
    UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { states } })}::jsonb
    WHERE id = ${projectId}
  `);
}

const asAgent = (issueId: string, body: string, format?: 'html' | 'markdown') => ({
  issueId,
  authorId: userId,
  authorDeviceId: deviceId,
  authorAgency: 'agent' as const,
  body,
  format,
  parentId: null,
});

describe('with no policy declared — every project, on the day this ships', () => {
  it('accepts an agent body that carries no component', async () => {
    const issueId = await anIssue();
    const { row } = await insertComment(asAgent(issueId, 'plain prose, no markup'));
    expect(row.format).toBe('markdown');
    expect(row.template).toBeNull();
  });

  // cm:guard the column is the issue's status AT THE WRITE. If this ever reads the current status instead, every drive comment lands under `closed` and the `open` stage reads empty forever — which looks exactly like nobody adopting.
  it('records the stage the issue was at, not the stage it later reaches', async () => {
    const issueId = await anIssue('open');
    const { row } = await insertComment(asAgent(issueId, 'written at open'));
    expect(row.stage).toBe('open');

    await harness.db.execute(sql`UPDATE issues SET status = 'closed' WHERE id = ${issueId}`);
    const [stored] = await harness.db
      .select({ stage: schema.comments.stage })
      .from(schema.comments)
      .where(sql`${schema.comments.id} = ${row.id}`);
    expect(stored?.stage).toBe('open');
  });
});

describe('with the policy on for one stage', () => {
  it('refuses an agent body that omits the component, naming it and the stage', async () => {
    await requireAtStage('open', 'forge-outcome');
    const issueId = await anIssue('open');

    await expect(insertComment(asAgent(issueId, 'plain prose'))).rejects.toThrow(/forge-outcome/);
    await expect(insertComment(asAgent(issueId, 'plain prose'))).rejects.toThrow(/`open`/);

    const stored = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}`,
    )) as unknown as Array<{ n: number }>;
    expect(stored[0]?.n).toBe(0);
  });

  it('accepts the same body once it carries the component', async () => {
    await requireAtStage('open', 'forge-outcome');
    const issueId = await anIssue('open');
    const { row } = await insertComment(asAgent(issueId, OUTCOME_BODY, 'html'));
    expect(row.template).toBe('forge-outcome');
    expect(row.stage).toBe('open');
  });

  it('accepts a PERSON writing prose, under the same policy', async () => {
    await requireAtStage('open', 'forge-outcome');
    const issueId = await anIssue('open');
    const { row } = await insertComment({
      issueId,
      authorId: userId,
      authorDeviceId: null,
      authorAgency: 'human',
      body: 'a person asking a question',
      format: undefined,
      parentId: null,
    });
    expect(row.id).toBeTruthy();
  });

  it('accepts an agent body at a stage the project did not name', async () => {
    await requireAtStage('open', 'forge-outcome');
    const issueId = await anIssue('needs_info');
    const { row } = await insertComment(asAgent(issueId, 'plain prose at another stage'));
    expect(row.stage).toBe('needs_info');
  });

  // cm:guard the EDIT door. Without it the rule has an obvious way around — post the component, then replace it with prose — and a mandate with a way around it makes the number beside it meaningless.
  it('refuses an edit that replaces the component with prose', async () => {
    const issueId = await anIssue('open');
    const { row } = await insertComment(asAgent(issueId, OUTCOME_BODY, 'html'));
    await requireAtStage('open', 'forge-outcome');

    await expect(updateCommentBody(row.id, { body: 'never mind' })).rejects.toThrow(
      /forge-outcome/,
    );

    const [stored] = await harness.db
      .select({ body: schema.comments.body })
      .from(schema.comments)
      .where(sql`${schema.comments.id} = ${row.id}`);
    expect(stored?.body).toContain('forge-outcome');
  });
});

describe('the adoption number', () => {
  it('moves by exactly one when one qualifying body lands', async () => {
    const issueId = await anIssue('open');
    const before = await readBodyAdoption(projectId);
    const openBefore = before.stages.find((s) => s.stage === 'open');
    expect(openBefore?.byComponent['forge-outcome'] ?? 0).toBe(0);

    await insertComment(asAgent(issueId, OUTCOME_BODY, 'html'));

    const after = await readBodyAdoption(projectId);
    const openAfter = after.stages.find((s) => s.stage === 'open');
    expect(openAfter?.byComponent['forge-outcome']).toBe(1);
    expect(openAfter?.total).toBe(1);
  });

  // cm:guard the whole "counts what is STORED, not what was intended" rule, made falsifiable. A regex over body text passes every other case in this file and fails only this one.
  it('counts nothing for a markdown body that merely says the word', async () => {
    const issueId = await anIssue('open');
    await insertComment(
      asAgent(issueId, 'I would have written a forge-outcome here but I did not'),
    );

    const open = (await readBodyAdoption(projectId)).stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(1);
    expect(open?.byComponent).toEqual({});
  });

  // cm:guard a person's component body is OUT of the denominator. The policy never applies to them, so counting their prose would depress the very figure the mandate decision reads and make a stage look unready forever.
  it('counts a person out of the population the mandate applies to', async () => {
    const issueId = await anIssue('open');
    await insertComment({
      issueId,
      authorId: userId,
      authorDeviceId: null,
      authorAgency: 'human',
      body: OUTCOME_BODY,
      format: 'html',
      parentId: null,
    });

    const open = (await readBodyAdoption(projectId)).stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(0);
    expect(open?.byComponent).toEqual({});
  });

  // cm:guard a DEVICE-marked body with no agency is not an agent's. `author_device_id` says which box a credential belongs to since ISS-932 wave 4, and a driver's `job:` token carries no box at all — a mandate keyed on it would fire for almost nobody while its number read a confident zero. This case is what keeps the two columns from being confused again.
  it('counts a device-marked body with no agency out of the population', async () => {
    const issueId = await anIssue('open');
    await harness.db.insert(schema.comments).values({
      issueId,
      authorId: userId,
      authorDeviceId: deviceId,
      body: OUTCOME_BODY,
      format: 'html',
      template: 'forge-outcome',
      stage: 'open',
    });

    const open = (await readBodyAdoption(projectId)).stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(0);
  });

  // cm:guard a row written before migration 0221 reads `stage = null`, and it must fall out of every stage rather than into one. Folding NULLs into a stage would put 11,684 historical markdown comments into the denominator and pin the fraction near zero forever.
  it('excludes a row written before the column existed', async () => {
    const issueId = await anIssue('open');
    await harness.db.insert(schema.comments).values({
      issueId,
      authorId: userId,
      authorDeviceId: deviceId,
      body: 'a pre-ISS-969 comment',
    });

    const report = await readBodyAdoption(projectId);
    expect(report.stages.reduce((n, s) => n + s.total, 0)).toBe(0);
  });

  it('leaves a body outside the window uncounted', async () => {
    const issueId = await anIssue('open');
    const { row } = await insertComment(asAgent(issueId, OUTCOME_BODY, 'html'));
    await harness.db.execute(
      sql`UPDATE comments SET created_at = now() - interval '30 days' WHERE id = ${row.id}`,
    );

    const open = (await readBodyAdoption(projectId, 14)).stages.find((s) => s.stage === 'open');
    expect(open?.total).toBe(0);
    expect(
      (await readBodyAdoption(projectId, 60)).stages.find((s) => s.stage === 'open')?.total,
    ).toBe(1);
  });

  it('reports the fraction against what the stage requires, once it requires one', async () => {
    const issueId = await anIssue('open');
    await insertComment(asAgent(issueId, OUTCOME_BODY, 'html'));
    await insertComment(asAgent(issueId, 'prose'));
    await requireAtStage('open', 'forge-outcome');

    const open = (await readBodyAdoption(projectId)).stages.find((s) => s.stage === 'open');
    expect(open?.requireComponent).toBe('forge-outcome');
    expect(open?.carryingRequired).toBe(1);
    expect(open?.fractionRequired).toBeCloseTo(0.5);
  });
});

/**
 * The HTTP door, which the service-level cases above cannot reach: who may read
 * the number, and what an out-of-range window does.
 */
describe('GET /api/projects/:id/body-adoption', () => {
  async function read(query: string, token: string): Promise<Response> {
    return app.request(`/api/projects/${projectId}/body-adoption?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('answers a project member with one row per stage', async () => {
    const issueId = await anIssue('open');
    await insertComment(asAgent(issueId, OUTCOME_BODY, 'html'));
    const token = await signUserToken(userId);

    const res = await read('days=14', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      windowDays: number;
      stages: Array<{ stage: string; byComponent: Record<string, number> }>;
    };
    expect(body.windowDays).toBe(14);
    expect(body.stages.map((s) => s.stage)).toEqual([
      'open',
      'in_progress',
      'needs_info',
      'awaiting_release',
    ]);
    expect(body.stages[0]?.byComponent).toEqual({ 'forge-outcome': 1 });
  });

  // cm:guard a project's adoption figure is project-scoped data and the route is NOT behind the `pipelineControl` flag, so membership is the only thing standing between it and any signed-in account on the deployment.
  it('refuses a signed-in stranger', async () => {
    const stranger = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
    const token = await signUserToken(stranger.id);
    const res = await read('', token);
    expect(res.status).toBe(403);
  });

  it('refuses a window wider than the index can serve', async () => {
    const token = await signUserToken(userId);
    expect((await read('days=365', token)).status).toBe(400);
    expect((await read('days=0', token)).status).toBe(400);
  });

  it('refuses a project id that is not a uuid', async () => {
    const token = await signUserToken(userId);
    const res = await app.request('/api/projects/not-a-uuid/body-adoption?days=14', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  // cm:guard the project comes off the PATH, and this is the case that says so. Mounted on a fan-out path with `?projectId=`, `middleware/pat-rest-surface.ts` resolves no project and answers 403 PAT_NOT_PERMITTED to EVERY personal access token — measured live on forge-beta 2026-09-08, before this route moved.
  it('sits under a prefix a personal access token may reach', async () => {
    expect(patSurfaceCovers(`/api/projects/${projectId}/body-adoption`)).toBe(true);
  });
});

/**
 * The REST create door after ISS-969 collapsed it into `insertComment`.
 *
 * The syntax gate used to live in the route as `prepareCommentBody`; it now
 * runs inside the service. A refusal that stopped reaching the transport would
 * surface as a 500 on a bad body, and every unit suite here mocks `db`, so this
 * is the only layer that can tell.
 */
describe('POST /api/issues/:id/comments after the door collapsed', () => {
  let issueRoutes: typeof import('../../src/issues/routes.js')['issueRoutes'];
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let issueApp: any;

  beforeAll(async () => {
    ({ issueRoutes } = await import('../../src/issues/routes.js'));
    issueApp = new Hono();
    issueApp.onError(errorHandler);
    issueApp.route('/api/issues', issueRoutes);
  }, 60_000);

  async function post(issueId: string, body: string, format?: string): Promise<Response> {
    const token = await signUserToken(userId);
    return issueApp.request(`/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(format ? { body, format } : { body }),
    });
  }

  it('stores a plain body and records the stage', async () => {
    const issueId = await anIssue('open');
    const res = await post(issueId, 'a person writing prose');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { stage: string }).stage).toBe('open');
  });

  it('still answers 400 BODY_INVALID naming the offender', async () => {
    const issueId = await anIssue('open');
    const res = await post(
      issueId,
      '<forge-review sha="abc1234" verdict="nope"></forge-review>',
      'html',
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('forge-review@verdict');
  });

  // cm:guard a JWT-authenticated browser caller resolves to `human`, so the tracker's own comment box is never refused by a mandate. An AGENT reaching this same route resolves to `agent` through `restActor` and IS refused — the door decides, not the route.
  it('is never refused by a stage policy, because the door resolved a person', async () => {
    await requireAtStage('open', 'forge-outcome');
    const issueId = await anIssue('open');
    expect((await post(issueId, 'still just prose')).status).toBe(201);
  });
});
