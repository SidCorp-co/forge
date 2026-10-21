/**
 * REQ-47, the doors around feedback about Forge: MCP records where a report came from as REST does
 * (BC-4), forge_feedback refuses the project door's call shape by name (BC-7), the retired agent-report
 * doors answer where reports go now (BC-8), and a reporter reads their own items whatever the home
 * project holds (BC-3).
 *
 * @direct-test-of packages/core/src/forge-door/tool.ts
 * @direct-test-of packages/core/src/forge-door/retired.ts
 * @direct-test-of packages/core/src/forge-door/service.ts
 * @direct-test-of packages/core/src/forge-door/reads.ts
 * @direct-test-of packages/core/src/feedback/forge-source.ts
 * @direct-test-of packages/core/src/feedback/forge-reads.ts
 * @direct-test-of packages/core/src/feedback/list-page-read.ts
 * @direct-test-of packages/core/src/forge-door/routes.ts
 * @direct-test-of packages/core/src/mcp/server.ts
 * @direct-test-of packages/core/src/jobs/active-job-context.ts
 */

import { RUN_ISSUES_METADATA_KEY } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@forge-feedback-doors.test';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@forge-feedback-doors.test';
});

import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestIssue,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';

const w = {
  homeOwner: '',
  person: '',
  agent: '',
  home: '',
  homeSlug: '',
  client: '',
  clientSlug: '',
  issue: '',
  run: '',
};
const tokens = { operator: '', person: '', personPat: '', agentPat: '', boxPat: '' };

const counted = async () =>
  Number(
    (await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM feedback_occurrences`))[0]?.n,
  );

const refusalOf = (body: Body) =>
  ((body.error as { refusals?: { code: string; path: string; detail: string }[] })?.refusals ??
    [])[0];

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream', ...headers },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  const text = result.content[0]?.text ?? '';
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { isError: result.isError === true, text, body };
}

let n = 0;
const submit = (extra: Record<string, unknown> = {}) => ({
  action: 'submit',
  kind: 'bug',
  title: `doors report ${++n}`,
  target: { kind: 'tool', ref: 'forge_issues' },
  ...extra,
});

const originOf = (body: Body) => (body.feedback as { origin: Body }).origin;

beforeAll(async () => {
  testEnv();
  const operator = (await createTestUser({ email: OPERATOR, verified: true })).id;
  w.homeOwner = (await createTestUser({ verified: true })).id;
  w.person = (await createTestUser({ verified: true })).id;
  w.agent = (await createTestUser({ kind: 'agent' })).id;
  const home = await createTestProject(w.homeOwner);
  w.home = home.id;
  w.homeSlug = home.slug;
  const clientOwner = (await createTestUser({ verified: true })).id;
  const client = await createTestProject(clientOwner);
  w.client = client.id;
  w.clientSlug = client.slug;
  await addProjectMember(w.client, w.person);
  await addProjectMember(w.client, w.agent);
  w.issue = (
    await createTestIssue(w.client, clientOwner, 7, {
      status: 'in_progress',
      createdAt: new Date(),
    })
  ).id;
  const device = await createTestDevice(clientOwner);
  // a declared run: its session runs no job, and its run carries the issue it works
  w.run = await createTestRunSession(w.client, device, new Date(), null);
  await db.execute(
    sql`UPDATE pipeline_runs SET metadata = jsonb_build_object(${RUN_ISSUES_METADATA_KEY}::text, jsonb_build_array('ISS-7')) WHERE id = ${w.run}`,
  );
  tokens.operator = await userToken(operator);
  tokens.person = await userToken(w.person);
  const mint = async (userId: string, name: string, more: Record<string, unknown>) =>
    (await mintPat({ permissions: ['*'], userId, name, grantEpoch: PAT_GRANT_EPOCH, ...more }))
      .plaintext;
  // a person's own token, fenced to nothing: only the connection says where they work
  tokens.personPat = await mint(w.person, 'person', {});
  // an agent's token fenced to the project it works in, as this box's is
  tokens.agentPat = await mint(w.agent, 'agent', { projectIds: [w.client] });
  // the box's own token, issued to the device the run is live on
  tokens.boxPat = await mint(w.agent, 'box', { projectIds: [w.client], deviceId: device });
  const named = await api(tokens.operator, 'PATCH', '/api/admin/instance-settings', {
    baseRevision: 0,
    patch: { forgeHomeProjectId: w.home },
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);
});

describe('MCP records where a report came from, as REST does (BC-4)', () => {
  it('records the project a fenced credential works in', async () => {
    const filed = await callTool(tokens.agentPat, 'forge_feedback', submit());
    expect(filed.isError, filed.text).toBe(false);
    expect(originOf(filed.body)).toMatchObject({ project: { id: w.client }, run: null });
  });

  it('records the project the connection names (X-Forge-Project-Slug)', async () => {
    const filed = await callTool(tokens.personPat, 'forge_feedback', submit(), {
      'x-forge-project-slug': w.clientSlug,
    });
    expect(filed.isError, filed.text).toBe(false);
    expect(originOf(filed.body)).toMatchObject({ project: { id: w.client, slug: w.clientSlug } });
    const [occ] = await rows<{ source_project_id: string }>(
      sql`SELECT source_project_id FROM feedback_occurrences ORDER BY created_at DESC LIMIT 1`,
    );
    expect(occ?.source_project_id).toBe(w.client);
  });

  it('records the run and issue of the box run it is filed from, over MCP and REST', async () => {
    const mcp = await callTool(tokens.boxPat, 'forge_feedback', submit());
    expect(mcp.isError, mcp.text).toBe(false);
    expect(originOf(mcp.body)).toMatchObject({
      project: { id: w.client },
      issue: { id: w.issue, key: 'ISS-7' },
      run: w.run,
    });
    const rest = await api(tokens.boxPat, 'POST', '/api/forge/feedback', {
      kind: 'bug',
      title: `doors report ${++n}`,
      whereSeen: 'route POST /api/forge/feedback',
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(originOf(rest.body)).toMatchObject({ issue: { id: w.issue }, run: w.run });
  });

  it('refuses a slug no project has, and one naming a project the reporter cannot read, writing nothing', async () => {
    const before = await counted();
    for (const slug of ['no-such-project', w.homeSlug]) {
      const called = await callTool(tokens.personPat, 'forge_feedback', submit(), {
        'x-forge-project-slug': slug,
      });
      expect(called.isError).toBe(true);
      expect(refusalOf(called.body)?.code, called.text).toBe('FORGE_FEEDBACK_SOURCE_UNREADABLE');
      expect(refusalOf(called.body)?.detail).toContain('X-Forge-Project-Slug');
    }
    expect(await counted()).toBe(before);
  });

  it('refuses a body naming another project than the connection does', async () => {
    const before = await counted();
    const called = await callTool(
      tokens.personPat,
      'forge_feedback',
      submit({ from: { project: w.home } }),
      { 'x-forge-project-slug': w.clientSlug },
    );
    expect(refusalOf(called.body), called.text).toMatchObject({
      code: 'FORGE_FEEDBACK_SOURCE_MISMATCH',
      path: '/from/project',
    });
    expect(await counted()).toBe(before);
  });
});

describe('forge_feedback is not the project door (BC-7)', () => {
  it('refuses projectId by name, pointing to project_feedback, and writes nothing', async () => {
    const before = await counted();
    const called = await callTool(tokens.agentPat, 'forge_feedback', {
      ...submit(),
      projectId: w.client,
    });
    expect(called.isError).toBe(true);
    expect(refusalOf(called.body), called.text).toMatchObject({
      code: 'FORGE_FEEDBACK_PROJECT_DOOR',
      path: '/projectId',
    });
    expect(refusalOf(called.body)?.detail).toContain('project_feedback');
    expect(await counted()).toBe(before);
  });

  it('refuses any other wrong argument by name in the envelope, never a validator dump', async () => {
    const called = await callTool(tokens.agentPat, 'forge_feedback', {
      action: 'get',
      feedback: 'ISS-7',
    });
    expect(called.isError).toBe(true);
    expect(refusalOf(called.body), called.text).toMatchObject({
      code: 'BAD_REQUEST',
      path: '/feedback',
    });
    expect(refusalOf(called.body)?.detail).toContain('FB-n');
  });
});

describe('the retired agent-report doors say where reports go now (BC-8)', () => {
  it.each([
    ['GET', '/api/agent-reports'],
    ['POST', '/api/agent-reports'],
    ['POST', '/api/agent-reports/triage'],
    ['POST', '/api/agent-reports/0b6f6a52-4a0e-4b8a-9d2e-2f1f7a0c9f11/triage'],
  ] as const)(
    '%s %s answers AGENT_REPORT_RETIRED naming POST /api/forge/feedback',
    async (method, path) => {
      const res = await api(tokens.agentPat, method, path, method === 'POST' ? {} : undefined);
      expect(res.status).toBe(404);
      expect(refusalOf(res.body)?.code, JSON.stringify(res.body)).toBe('AGENT_REPORT_RETIRED');
      expect(refusalOf(res.body)?.detail).toContain('POST /api/forge/feedback');
    },
  );

  it('answers the MCP tool forge_agent_report with the same refusal, naming forge_feedback', async () => {
    const called = await callTool(tokens.agentPat, 'forge_agent_report', { action: 'submit' });
    expect(called.isError).toBe(true);
    expect(refusalOf(called.body)?.code, called.text).toBe('AGENT_REPORT_RETIRED');
    expect(refusalOf(called.body)?.detail).toContain('forge_feedback');
  });
});

describe('a reporter reads their own items whatever the home project holds (BC-3)', () => {
  const PAST_THE_WINDOW = 501;
  let key = '';
  let signalKey = '';

  beforeAll(async () => {
    const filed = await api(tokens.person, 'POST', '/api/forge/feedback', {
      kind: 'bug',
      title: 'an old report of mine',
      whereSeen: 'page /issues',
      signalKey: 'doors:old-report',
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    key = (filed.body.feedback as { key: string }).key;
    signalKey = 'doors:old-report';
    // more items than the project list's window, every one newer and someone else's
    const cols = (
      await rows<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'feedback' AND is_generated = 'NEVER' AND column_default IS NULL
          AND column_name NOT IN ('id', 'fb_seq', 'created_at', 'updated_at', 'signal_key', 'dedup_key', 'reported_by', 'title')
      `)
    ).map((c) => sql.identifier(c.column_name));
    await db.execute(sql`
      INSERT INTO feedback (${sql.join(cols, sql`, `)}, fb_seq, created_at, updated_at, reported_by, title)
      SELECT ${sql.join(cols, sql`, `)}, f.fb_seq + g, now() + g * interval '1 second',
             now() + g * interval '1 second', ${w.homeOwner}, 'someone else ' || g
      FROM feedback f, generate_series(1, ${PAST_THE_WINDOW}) g
      WHERE f.project_id = ${w.home} AND f.title = 'an old report of mine'
    `);
    const [count] = await rows<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM feedback WHERE project_id = ${w.home} AND reported_by <> ${w.person}`,
    );
    expect(Number(count?.n)).toBeGreaterThanOrEqual(PAST_THE_WINDOW);
  });

  it('still lists the old item', async () => {
    const mine = await api(tokens.person, 'GET', '/api/forge/feedback');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect((mine.body.feedback as Body[]).map((f) => f.key)).toContain(key);
  });

  it('still reads it by its key', async () => {
    const one = await api(tokens.person, 'GET', `/api/forge/feedback/${key}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body).toMatchObject({ key });
  });

  it('answers a report joining it with that item', async () => {
    const joined = await api(tokens.agentPat, 'POST', '/api/forge/feedback', {
      kind: 'bug',
      title: 'the same thing, worded again',
      whereSeen: 'page /issues',
      signalKey,
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body).toMatchObject({ created: false, feedback: { key } });
  });
});
