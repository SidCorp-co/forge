/**
 * ISS-1132 — a retired metric is refused by name at both doors, never answered with an empty series.
 *
 * `pass_rate` and `approve_rate` read `issue_step_contexts.verdict`, a column that is gone. A caller
 * still sending either name is told it is retired and which metrics are served, at the REST route
 * and through the real MCP transport, because each is a claim about what a caller receives.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat } from '../helpers/mcp-harness.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let METRICS: typeof import('../../src/metrics/queries.js').METRICS;

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

  const [routesMod, jwtMod, errMod, patMod, queriesMod] = await Promise.all([
    import('../../src/metrics/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
    import('../../src/auth/pat.js'),
    import('../../src/metrics/queries.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  mintPat = patMod.mintPat;
  METRICS = queriesMod.METRICS;
  app = new Hono();
  app.route('/api/projects', routesMod.projectMetricsRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  return {
    projectId: project.id,
    jwt: await signUserToken(owner.id),
    pat: (await mintPat({ userId: owner.id, name: 'test-cli' })).plaintext,
  };
}

const timeseries = (projectId: string, jwt: string, metric: string) =>
  app.request(`/api/projects/${projectId}/metrics/timeseries?metric=${metric}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });

async function callMcp(pat: string, projectId: string, metric: string) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({
      name: 'forge_metrics.project_timeseries',
      arguments: { projectId, metric },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: res.isError === true, text: res.content[0]?.text ?? '' };
  } finally {
    await ctx.close();
  }
}

describe.each(['pass_rate', 'approve_rate'])('the retired metric %s', (metric) => {
  it('is refused 400 at the route, naming it as retired and listing what is served', async () => {
    const { projectId, jwt } = await seed();
    const res = await timeseries(projectId, jwt, metric);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: { fieldErrors: { metric: string[] } } };
    const text = (body.details.fieldErrors.metric ?? []).join(' ');
    expect(text).toContain(`${metric}\` is retired`);
    for (const served of METRICS) expect(text).toContain(served);
    expect(text).not.toContain('"series"');
  });

  it('is refused at the MCP tool, naming it as retired and listing what is served', async () => {
    const { projectId, pat } = await seed();
    const res = await callMcp(pat, projectId, metric);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(`${metric}\` is retired`);
    for (const served of METRICS) expect(res.text).toContain(served);
  });

  it("is refused at the MCP tool as one sentence, not as the validation library's issue array", async () => {
    const { projectId, pat } = await seed();
    const res = await callMcp(pat, projectId, metric);
    expect(res.isError).toBe(true);
    expect(res.text.startsWith('Error: The field `metric` ')).toBe(true);
    expect(res.text).not.toMatch(/"code"|"path"|invalid_value|^Error: \[/);
    expect(() => JSON.parse(res.text.replace(/^Error: /, ''))).toThrow();
  });
});

describe('a name that was never a metric, through the MCP tool', () => {
  it('is refused as not served, in the same one-sentence shape', async () => {
    const { projectId, pat } = await seed();
    const res = await callMcp(pat, projectId, 'vibes');
    expect(res.isError).toBe(true);
    expect(res.text).toContain(
      'The field `metric` takes one of the values listed below. Metric `vibes` is not a metric this project serves.',
    );
    expect(res.text).not.toContain('is retired');
    expect(res.text).not.toMatch(/"code"|invalid_value/);
  });
});

describe('a name that was never a metric', () => {
  it('is refused at the route as not served, not as retired', async () => {
    const { projectId, jwt } = await seed();
    const res = await timeseries(projectId, jwt, 'vibes');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: { fieldErrors: { metric: string[] } } };
    const text = (body.details.fieldErrors.metric ?? []).join(' ');
    expect(text).toContain('vibes');
    expect(text).toContain('is not a metric this project serves');
    expect(text).not.toContain('is retired');
  });
});

describe('a metric that is still served', () => {
  it('answers a series at the route', async () => {
    const { projectId, jwt } = await seed();
    const res = await timeseries(projectId, jwt, 'queue_depth');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { metric: string }).metric).toBe('queue_depth');
  });
});

describe('any other enum-validated MCP input is refused in the same shape', () => {
  it('names `breakdown` and what it accepts, not an issue array', async () => {
    const { projectId, pat } = await seed();
    const ctx = await connectClientAsPat(pat);
    try {
      const res = (await ctx.client.callTool({
        name: 'forge_metrics.project_step_durations',
        arguments: { projectId, breakdown: 'vibes' },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError).toBe(true);
      const text = res.content[0]?.text ?? '';
      expect(text.startsWith('Error: The field `breakdown` ')).toBe(true);
      expect(text).not.toMatch(/"code"|invalid_value/);
    } finally {
      await ctx.close();
    }
  });
});
