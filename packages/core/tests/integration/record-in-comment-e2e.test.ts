/**
 * ISS-1113 — the fence refused at the comment door, and the dormancy that
 * keeps it from firing before the writer in the other repo can obey it.
 *
 * Against real Postgres because the claim is about what a door answers: the
 * status code, the rule id on the cause, and the warnings array the write
 * comes back with. A mocked service can be told to throw and proves nothing
 * about which requests reach the throw.
 *
 * The dormancy half is the whole safety argument. The refusal lands in core on
 * a deploy the plugin did not ask for, so the cases that must stay 201 —
 * no header at all, and a header naming some other capability — are the tests
 * that say this change is safe to ship.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMENT_BODY_MAX_CHARS } from '../../src/comments/body-input.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [issuesMod, commentsMod, jwtMod, errMod] = await Promise.all([
    import('../../src/issues/routes.js'),
    import('../../src/comments/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  app = new Hono();
  app.route('/api/issues', issuesMod.issueRoutes);
  app.route('/api/comments', commentsMod.commentRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const FENCE = '```';

const fenced = (kind: string): string =>
  [
    'Criterion 3 passed at the head the review judged.',
    '',
    `${FENCE}forge-record`,
    'criterion: 3',
    'verdict: pass',
    FENCE,
    '',
    `\`forge-record: ${kind} · contract 1\``,
  ].join('\n');

const PLAIN = 'The run judged criterion 3 and it passed. Nothing structured in this one.';

async function seed() {
  const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'record-target', ${owner.id})
    RETURNING id
  `);
  return {
    issueId: (rows[0] as { id: string }).id,
    jwt: await signUserToken(owner.id),
  };
}

type Written = { id: string; warnings?: string[] };
type Refused = {
  message: string;
  code?: string;
  details?: { door?: string; refusals?: Array<{ rule: string; why: string }> };
};

async function post(
  issueId: string,
  jwt: string,
  body: string,
  capabilities?: string,
): Promise<Response> {
  return app.request(`/api/issues/${issueId}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      ...(capabilities === undefined ? {} : { 'x-forge-capabilities': capabilities }),
    },
    body: JSON.stringify({ body }),
  });
}

describe('a caller that declared it can write a record elsewhere', () => {
  it('is refused 400 under the rule id record-in-comment', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, fenced('verdict'), 'record-route');
    expect(res.status).toBe(400);
    const refused = (await res.json()) as Refused;
    expect(refused.details?.refusals?.map((r) => r.rule)).toEqual(['record-in-comment']);
  });

  it('is told the route its own kind goes to, where a store holds that kind', async () => {
    const { issueId, jwt } = await seed();
    const verdict = (await (
      await post(issueId, jwt, fenced('verdict'), 'record-route')
    ).json()) as Refused;
    expect(verdict.details?.refusals?.[0]?.why).toContain('POST /api/issue-step-contexts');
  });

  it('is told no store holds a kind core cannot represent, rather than a route it would be refused at', async () => {
    const { issueId, jwt } = await seed();
    const baseline = (await (
      await post(issueId, jwt, fenced('baseline'), 'record-route')
    ).json()) as Refused;
    const why = baseline.details?.refusals?.[0]?.why ?? '';
    expect(why).toContain('no store here holds');
    expect(why).toContain('POST /api/issues/:id/attributes');
    expect(why).not.toContain('issue-step-contexts');
  });

  it('writes nothing when it is refused', async () => {
    const { issueId, jwt } = await seed();
    await post(issueId, jwt, fenced('verdict'), 'record-route');
    const rows = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM comments WHERE issue_id = ${issueId}`,
    );
    expect((rows[0] as { n: string }).n).toBe('0');
  });

  it('is not refused for a body carrying no fence', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, PLAIN, 'record-route');
    expect(res.status).toBe(201);
    expect((await res.json()) as Written).not.toHaveProperty('warnings');
  });
});

describe('the dormancy — a caller that declared nothing is not refused', () => {
  it('sending no x-forge-capabilities header at all is written 201', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, fenced('verdict'));
    expect(res.status).toBe(201);
  });

  it('declaring some other capability is written 201', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, fenced('verdict'), 'some-other-capability');
    expect(res.status).toBe(201);
  });

  it('declaring an empty header is written 201', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, fenced('verdict'), '');
    expect(res.status).toBe(201);
  });

  it('is answered with the warning the refusal would have carried', async () => {
    const { issueId, jwt } = await seed();
    const written = (await (await post(issueId, jwt, fenced('verdict'))).json()) as Written;
    const refused = (await (
      await post(issueId, jwt, fenced('verdict'), 'record-route')
    ).json()) as Refused;
    expect(written.warnings).toEqual([refused.details?.refusals?.[0]?.why]);
  });

  it('is pointed at the guide that holds the whole table', async () => {
    const { issueId, jwt } = await seed();
    const written = (await (await post(issueId, jwt, fenced('verdict'))).json()) as Written;
    expect(written.warnings?.[0]).toContain('records-and-comments');
  });

  it('gets no record warning for a body carrying no fence', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, PLAIN);
    expect(res.status).toBe(201);
    expect((await res.json()) as Written).not.toHaveProperty('warnings');
  });
});

describe('a fence that carries no record at all', () => {
  const unreadable = [`${FENCE}forge-record verdict`, 'criterion: 3', FENCE].join('\n');
  const neverClosed = [`${FENCE}forge-record`, 'criterion: 3', 'verdict: pass'].join('\n');

  it('is refused 400 under record-fence-shape with no capability declared', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, unreadable);
    expect(res.status).toBe(400);
    const refused = (await res.json()) as Refused;
    expect(refused.details?.refusals?.map((r) => r.rule)).toEqual(['record-fence-shape']);
  });

  it('is refused the same way when the caller does declare record-route', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, unreadable, 'record-route');
    expect(res.status).toBe(400);
    const refused = (await res.json()) as Refused;
    expect(refused.details?.refusals?.map((r) => r.rule)).toEqual(['record-fence-shape']);
  });

  it('refuses a fence that is never closed', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, neverClosed);
    expect(res.status).toBe(400);
  });

  it('writes nothing when it is refused', async () => {
    const { issueId, jwt } = await seed();
    await post(issueId, jwt, unreadable);
    const rows = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM comments WHERE issue_id = ${issueId}`,
    );
    expect((rows[0] as { n: string }).n).toBe('0');
  });

  it('shows a shape that is valid rather than only naming what was wrong', async () => {
    const { issueId, jwt } = await seed();
    const refused = (await (await post(issueId, jwt, unreadable)).json()) as Refused;
    const why = refused.details?.refusals?.[0]?.why ?? '';
    expect(why).toContain('records-and-comments');
    expect(why).toContain('either carries one or is told it does not');
  });
});

describe('a fence whose tag rides on the fence itself', () => {
  const onTheFence = [
    'Criterion 3 passed at the head the review judged.',
    '',
    `${FENCE}forge-record: verdict · contract 1`,
    'criterion: 3',
    'verdict: pass',
    FENCE,
  ].join('\n');

  it('is refused 400 under record-in-comment, as the other shape already was', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, onTheFence, 'record-route');
    expect(res.status).toBe(400);
    const refused = (await res.json()) as Refused;
    expect(refused.details?.refusals?.map((r) => r.rule)).toEqual(['record-in-comment']);
    expect(refused.details?.refusals?.[0]?.why).toContain('POST /api/issue-step-contexts');
  });

  it('is written 201 with the warning where the caller declared nothing', async () => {
    const { issueId, jwt } = await seed();
    const res = await post(issueId, jwt, onTheFence);
    expect(res.status).toBe(201);
    expect(((await res.json()) as Written).warnings?.[0]).toContain('records-and-comments');
  });
});

describe('the edit door is screened by the same rule', () => {
  const edit = async (id: string, jwt: string, body: string, capabilities?: string) =>
    app.request(`/api/comments/${id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        ...(capabilities === undefined ? {} : { 'x-forge-capabilities': capabilities }),
      },
      body: JSON.stringify({ body }),
    });

  it('refuses a declaring caller that edits a fence in', async () => {
    const { issueId, jwt } = await seed();
    const written = (await (await post(issueId, jwt, PLAIN)).json()) as Written;
    const res = await edit(written.id, jwt, fenced('verdict'), 'record-route');
    expect(res.status).toBe(400);
    expect(((await res.json()) as Refused).details?.refusals?.map((r) => r.rule)).toEqual([
      'record-in-comment',
    ]);
  });

  it('warns a non-declaring caller that edits a fence in', async () => {
    const { issueId, jwt } = await seed();
    const written = (await (await post(issueId, jwt, PLAIN)).json()) as Written;
    const res = await edit(written.id, jwt, fenced('verdict'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Written).warnings?.[0]).toContain('records-and-comments');
  });
});

describe('the character cap is not the lever', () => {
  it('leaves COMMENT_BODY_MAX_CHARS where ISS-1113 found it', () => {
    expect(COMMENT_BODY_MAX_CHARS).toBe(64_000);
  });

  it('writes a long body carrying no fence, whatever the caller declares', async () => {
    const { issueId, jwt } = await seed();
    const long = `A long explanation somebody wanted. ${'reasoning '.repeat(400)}`;
    expect(long.length).toBeGreaterThan(4_000);
    const res = await post(issueId, jwt, long, 'record-route');
    expect(res.status).toBe(201);
  });
});
