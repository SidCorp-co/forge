import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedProjectDocument,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, routesMod, criteriaMod, activityMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/issues/routes.js'),
    import('../../src/issues/criteria/routes.js'),
    import('../../src/issues/activity-routes.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', routesMod.issueRoutes);
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.route('/api/issues', criteriaMod.issueCriteriaRoutes);
  app.route('/api/issues', activityMod.issueActivityRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

const SHA = '33637c612ef15be6f924520c0d201a0889d8ed7e';

interface World {
  projectId: string;
  humanId: string;
  human: string;
  agent: string;
}

async function world(): Promise<World> {
  const human = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const agent = await createTestUser(harness.db, { kind: 'agent' });
  const project = await createTestProject(harness.db, human.id);
  await createTestProjectMember(harness.db, { userId: agent.id, projectId: project.id });
  await seedProjectDocument(harness.db, project.id, human.id, { environments: {} });
  const h = await mintPat({ userId: human.id, name: 'person', boundProjectId: project.id });
  const a = await mintPat({ userId: agent.id, name: 'agent', boundProjectId: project.id });
  return { projectId: project.id, humanId: human.id, human: h.plaintext, agent: a.plaintext };
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-Forge-Lifecycle': '10',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function inProgress(w: World, criteria: string[] = []): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status, merged_at)
    VALUES (${w.projectId}::uuid, 'an issue', ${w.humanId}::uuid, 'in_progress', now())
    RETURNING id
  `);
  const id = (rows[0] as { id: string }).id;
  if (criteria.length > 0) {
    const res = await call('PUT', `/api/issues/${id}/criteria`, w.human, {
      criteria: criteria.map((statement, i) => ({ n: i + 1, statement })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return id;
}

async function pass(w: World, issueId: string, criterion: number) {
  return call('POST', `/api/issues/${issueId}/verdicts`, w.agent, {
    criterion,
    verdict: 'pass',
    identity: { kind: 'commit', sha: SHA },
    evidence: ['judge-log.txt'],
  });
}

interface Row {
  id: string;
  action: string;
  payload: { writer?: string; fields?: Array<{ key: string; value: string }> };
}

async function records(issueId: string, kind: string): Promise<Row[]> {
  return (await harness.db.execute(sql`
    SELECT id, action, payload FROM activity_log
     WHERE issue_id = ${issueId} AND action = ${`record.${kind}`}
     ORDER BY created_at, id
  `)) as unknown as Row[];
}

const fieldsOf = (row: Row | undefined) =>
  Object.fromEntries((row?.payload.fields ?? []).map((f) => [f.key, f.value]));

async function statusOf(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`SELECT status FROM issues WHERE id = ${issueId}`);
  return String((rows[0] as { status: unknown }).status);
}

function expectRefused(
  res: { status: number; body: Record<string, unknown> },
  http: number,
  code: string,
) {
  expect(res.body.code, JSON.stringify(res.body)).toBe(code);
  expect(res.status).toBe(http);
}

describe('EVENT_KIND_KERNEL_ONLY: a caller cannot post kernel evidence', () => {
  for (const kind of ['transition', 'park', 'verdict']) {
    it(`refuses a client-posted \`${kind}\` by name and stores nothing`, async () => {
      const w = await world();
      const id = await inProgress(w, ['the export carries every row']);
      const res = await call('POST', `/api/issues/${id}/events`, w.agent, {
        kind,
        contract: 1,
        fields: [
          { key: 'from', value: 'in_progress' },
          { key: 'to', value: 'closed' },
          { key: 'criterion', value: '1' },
          { key: 'verdict', value: 'pass' },
          { key: 'commit', value: SHA },
          { key: 'evidence', value: 'judge-log.txt' },
        ],
      });
      expectRefused(res, 422, 'EVENT_KIND_KERNEL_ONLY');
      expect(String(res.body.message)).toContain(`\`${kind}\` is kernel evidence`);
      expect(await records(id, kind)).toEqual([]);
      expect(await statusOf(id)).toBe('in_progress');
    });
  }

  it('still takes a kind a caller authors, marked as a client write', async () => {
    const w = await world();
    const id = await inProgress(w);
    const res = await call('POST', `/api/issues/${id}/events`, w.agent, {
      kind: 'landing',
      contract: 1,
      fields: [{ key: 'commit', value: SHA }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.writer).toBe('client');
  });
});

describe('in_progress → closed runs the verdict guard on an issue never reopened', () => {
  it('refuses a close with no criteria as NO_WORK_EVIDENCE, and writes no transition record', async () => {
    const w = await world();
    const id = await inProgress(w);
    expectRefused(
      await call('POST', `/api/issues/${id}/transition`, w.human, { toStatus: 'closed' }),
      409,
      'NO_WORK_EVIDENCE',
    );
    expect(await statusOf(id)).toBe('in_progress');
    expect(await records(id, 'transition')).toEqual([]);
  });

  it('refuses a close with a criterion unjudged, naming it', async () => {
    const w = await world();
    const id = await inProgress(w, ['rows are kept', 'order is kept']);
    expect((await pass(w, id, 1)).status).toBe(201);
    const res = await call('POST', `/api/issues/${id}/transition`, w.human, {
      toStatus: 'closed',
    });
    expectRefused(res, 409, 'NO_WORK_EVIDENCE');
    expect((res.body.details as { unpassed: unknown }).unpassed).toEqual([
      { criterion: 2, verdict: null },
    ]);
    expect(await statusOf(id)).toBe('in_progress');
  });

  it('closes once every criterion holds a passing verdict, and core records both acts', async () => {
    const w = await world();
    const id = await inProgress(w, ['rows are kept', 'order is kept']);
    const first = await pass(w, id, 1);
    const second = await pass(w, id, 2);
    const res = await call('POST', `/api/issues/${id}/transition`, w.human, {
      toStatus: 'closed',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(id)).toBe('closed');

    const verdicts = await records(id, 'verdict');
    expect(verdicts.map((v) => v.payload.writer)).toEqual(['core', 'core']);
    expect(verdicts.map((v) => fieldsOf(v)['verdict-id'])).toEqual([
      first.body.verdictId,
      second.body.verdictId,
    ]);
    expect(fieldsOf(verdicts[0])).toMatchObject({
      criterion: '1',
      verdict: 'pass',
      identity: 'commit',
      commit: SHA,
      evidence: 'judge-log.txt',
    });

    const [moved] = await records(id, 'transition');
    expect(moved?.payload.writer).toBe('core');
    expect(fieldsOf(moved)).toMatchObject({ from: 'in_progress', to: 'closed' });
  });

  it('a verdict the table refuses leaves no verdict record behind', async () => {
    const w = await world();
    const id = await inProgress(w, ['rows are kept']);
    const res = await pass(w, id, 7);
    expect(res.status).toBe(400);
    expect(await records(id, 'verdict')).toEqual([]);
  });
});

describe('a park move records itself in its own transaction', () => {
  it('writes record.transition and record.park as core, served by GET /events', async () => {
    const w = await world();
    const id = await inProgress(w);
    const res = await call('POST', `/api/issues/${id}/transition`, w.agent, {
      toStatus: 'needs_info',
      waitingKind: 'needs_decision',
      reason: 'which tenant keeps the legacy order?',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const listed = await call('GET', `/api/issues/${id}/events`, w.human);
    const items = listed.body.items as Array<{
      kind: string;
      writer: string;
      fields: Array<{ key: string; value: string }>;
    }>;
    const kinds = items.map((e) => `${e.kind}:${e.writer}`).sort();
    expect(kinds).toEqual(['park:core', 'transition:core']);
    const parked = items.find((e) => e.kind === 'park');
    const park = Object.fromEntries((parked?.fields ?? []).map((f) => [f.key, f.value]));
    expect(park).toEqual({
      status: 'needs_info',
      kind: 'needs_decision',
      why: 'which tenant keeps the legacy order?',
      'left-status': 'in_progress',
    });
  });
});

describe('KERNEL_RECORD_IMMUTABLE: kernel evidence is kept as written', () => {
  it('refuses evaluating or deleting a transition record, and leaves it whole', async () => {
    const w = await world();
    const id = await inProgress(w);
    await call('POST', `/api/issues/${id}/transition`, w.human, {
      toStatus: 'on_hold',
      reason: 'paused for the freeze',
    });
    const [moved] = await records(id, 'transition');
    const path = `/api/issues/${id}/activity/${moved?.id}`;
    expectRefused(
      await call('PATCH', `${path}/evaluate`, w.human, { verdict: 'reject' }),
      409,
      'KERNEL_RECORD_IMMUTABLE',
    );
    expectRefused(await call('DELETE', path, w.human), 409, 'KERNEL_RECORD_IMMUTABLE');
    const [kept] = await records(id, 'transition');
    expect(kept).toEqual(moved);
  });
});
