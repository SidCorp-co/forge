/**
 * REQ-47: feedback about Forge itself is filed by whoever reports it, from any project, into the one
 * project the instance names as Forge's home — as the reporter's own account, with where it came from,
 * joining an open item that holds its signal key, and refused by name with nothing written where no
 * home is named. The retired agent reports are carried in once, one item per signal key.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@forge-feedback.test';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@forge-feedback.test';
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

interface Occurrence {
  feedback_id: string;
  reported_by: string;
  reporter_agency: string;
  source_project_id: string | null;
  source_issue_id: string | null;
  source_run_id: string | null;
  client_version: string | null;
  dedup_key: string | null;
}

const w = {
  operator: '',
  homeOwner: '',
  stranger: '',
  person: '',
  agent: '',
  home: '',
  homeSlug: '',
  client: '',
  issue: '',
  run: '',
};
const tokens = { operator: '', homeOwner: '', stranger: '', person: '', agentPat: '' };

const counted = async (table: 'feedback' | 'feedback_occurrences') =>
  Number(
    (await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`))[0]
      ?.n,
  );

const refusalOf = (body: Body) =>
  ((body.error as { refusals?: { code: string; path: string; detail: string }[] })?.refusals ??
    [])[0];

const fileAs = (token: string, body: Record<string, unknown>) =>
  api(token, 'POST', '/api/forge/feedback', {
    kind: 'bug',
    title: 'forge claim refuses a free lease',
    whereSeen: 'command forge claim --next',
    ...body,
  });

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { accept: 'application/json, text/event-stream' },
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

beforeAll(async () => {
  testEnv();
  w.operator = (await createTestUser({ email: OPERATOR, verified: true })).id;
  w.homeOwner = (await createTestUser({ verified: true })).id;
  w.stranger = (await createTestUser({ verified: true })).id;
  w.person = (await createTestUser({ verified: true })).id;
  w.agent = (await createTestUser({ kind: 'agent' })).id;
  const home = await createTestProject(w.homeOwner);
  w.home = home.id;
  w.homeSlug = home.slug;
  const clientOwner = (await createTestUser({ verified: true })).id;
  w.client = (await createTestProject(clientOwner)).id;
  await addProjectMember(w.client, w.person);
  await addProjectMember(w.client, w.agent);
  w.issue = (
    await createTestIssue(w.client, clientOwner, 4, { status: 'open', createdAt: new Date() })
  ).id;
  const device = await createTestDevice(clientOwner);
  w.run = await createTestRunSession(w.client, device, new Date(), null);
  tokens.operator = await userToken(w.operator);
  tokens.homeOwner = await userToken(w.homeOwner);
  tokens.stranger = await userToken(w.stranger);
  tokens.person = await userToken(w.person);
  // a box's token, fenced to the project it works in, minted as the menu stands now
  tokens.agentPat = (
    await mintPat({
      permissions: ['*'],
      userId: w.agent,
      name: 'box',
      projectIds: [w.client],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;
});

describe('with no home project named (BC-6)', () => {
  it('refuses filing by name and writes nothing', async () => {
    const res = await fileAs(tokens.person, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(refusalOf(res.body)?.code).toBe('FORGE_HOME_NOT_SET');
    expect(await counted('feedback')).toBe(0);
    expect(await counted('feedback_occurrences')).toBe(0);
  });

  it('refuses the MCP door the same way', async () => {
    const called = await callTool(tokens.agentPat, 'forge_feedback', {
      action: 'submit',
      kind: 'bug',
      title: 'x',
      target: { kind: 'tool', ref: 'forge_issues' },
    });
    expect(called.isError).toBe(true);
    expect(called.text).toContain('FORGE_HOME_NOT_SET');
    expect(await counted('feedback')).toBe(0);
  });
});

describe('an instance admin names the home project', () => {
  it('is refused to anyone who is not an instance admin', async () => {
    const res = await api(tokens.homeOwner, 'PATCH', '/api/admin/instance-settings', {
      baseRevision: 0,
      patch: { forgeHomeProjectId: w.home },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a project id naming no project, and a stale revision, writing nothing', async () => {
    const unknown = await api(tokens.operator, 'PATCH', '/api/admin/instance-settings', {
      baseRevision: 0,
      patch: { forgeHomeProjectId: randomUUID() },
    });
    expect(refusalOf(unknown.body)?.code).toBe('INSTANCE_SETTINGS_PROJECT_UNKNOWN');
    const stale = await api(tokens.operator, 'PATCH', '/api/admin/instance-settings', {
      baseRevision: 3,
      patch: { forgeHomeProjectId: w.home },
    });
    expect(stale.status).toBe(409);
    expect(refusalOf(stale.body)?.code).toBe('INSTANCE_SETTINGS_STALE');
    const read = await api(tokens.operator, 'GET', '/api/admin/instance-settings');
    expect(read.body).toMatchObject({ revision: 0, settings: { forgeHomeProject: null } });
  });

  it('writes it against the revision it was read at', async () => {
    const res = await api(tokens.operator, 'PATCH', '/api/admin/instance-settings', {
      baseRevision: 0,
      patch: { forgeHomeProjectId: w.home },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ revision: 1, settings: { forgeHomeProject: { id: w.home } } });
  });
});

describe('filing feedback about Forge (BC-1 to BC-5, BC-7)', () => {
  let key = '';

  it('files into the home project as the reporter, who is no member there, naming where it came from', async () => {
    const res = await fileAs(tokens.person, {
      clientVersion: 'web 0.4.0-dev.258',
      from: { project: w.client, issue: w.issue, run: w.run },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const filed = res.body as { created: boolean; feedback: { key: string } & Body };
    expect(filed.created).toBe(true);
    key = filed.feedback.key;
    expect(filed.feedback).toMatchObject({
      phase: 'new',
      origin: {
        occurrences: 1,
        project: { id: w.client },
        issue: { key: 'ISS-4' },
        run: w.run,
        clientVersion: 'web 0.4.0-dev.258',
        reporter: { id: w.person, agency: 'human' },
      },
    });
    expect(filed.feedback.progress).toHaveProperty('says');

    const [row] = await rows<{ project_id: string; reported_by: string; reporter_agency: string }>(
      sql`SELECT project_id, reported_by, reporter_agency FROM feedback`,
    );
    expect(row).toEqual({ project_id: w.home, reported_by: w.person, reporter_agency: 'human' });
    const [occ] = await rows<Occurrence>(sql`SELECT * FROM feedback_occurrences`);
    expect(occ).toMatchObject({
      reported_by: w.person,
      reporter_agency: 'human',
      source_project_id: w.client,
      source_issue_id: w.issue,
      source_run_id: w.run,
      client_version: 'web 0.4.0-dev.258',
    });
    // the client project's own feedback holds nothing (BC-7)
    expect(await rows(sql`SELECT 1 FROM feedback WHERE project_id = ${w.client}`)).toEqual([]);
    // and the reporter is no member of the home project, whose own door stays closed to them
    const projectDoor = await api(tokens.person, 'GET', `/api/projects/${w.home}/feedback`);
    expect([403, 404]).toContain(projectDoor.status);
  });

  it('lets the reporter read their own items and their progress (BC-3)', async () => {
    const mine = await api(tokens.person, 'GET', '/api/forge/feedback');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({ returned: 1, home: { id: w.home } });
    const [item] = (mine.body.feedback as Body[]) ?? [];
    expect(item).toMatchObject({ key, phase: 'new' });
    expect(item?.progress).toMatchObject({ running: false, says: expect.any(String) });
    const one = await api(tokens.person, 'GET', `/api/forge/feedback/${key}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ key });
  });

  it("adds an agent's report of the same signal as an occurrence, authored by the agent (BC-2, BC-5)", async () => {
    const res = await fileAs(tokens.agentPat, { clientVersion: 'forge-plugin 3.36.542' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      created: false,
      feedback: { key, origin: { occurrences: 2, reporter: { id: w.person } } },
    });
    expect(await counted('feedback')).toBe(1);
    const occ = await rows<Occurrence>(
      sql`SELECT * FROM feedback_occurrences WHERE reported_by = ${w.agent}`,
    );
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({
      reporter_agency: 'agent',
      // the token is fenced to the client project, so that is where it came from
      source_project_id: w.client,
      client_version: 'forge-plugin 3.36.542',
    });
    const agentList = await api(tokens.agentPat, 'GET', '/api/forge/feedback');
    expect((agentList.body.feedback as Body[]).map((f) => f.key)).toEqual([key]);
  });

  it('hides an item from someone who neither reported it nor is a member of the home project', async () => {
    const res = await api(tokens.stranger, 'GET', `/api/forge/feedback/${key}`);
    expect(res.status).toBe(404);
    expect(refusalOf(res.body)?.code).toBe('FORGE_FEEDBACK_NOT_FOUND');
    const member = await api(tokens.homeOwner, 'GET', `/api/forge/feedback/${key}`);
    expect(member.status).toBe(200);
  });

  it('shows the home project the reporter and source project on its own Feedback page', async () => {
    const res = await api(tokens.homeOwner, 'GET', `/api/projects/${w.home}/feedback`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [item] = res.body.feedback as Body[];
    expect(item).toMatchObject({
      key,
      reporter: { id: w.person, agency: 'human' },
      origin: { project: { id: w.client }, occurrences: 2 },
    });
  });

  it('refuses a source project its reporter cannot read, writing nothing', async () => {
    const before = await counted('feedback_occurrences');
    const res = await fileAs(tokens.stranger, { from: { project: w.client } });
    expect(res.status).toBe(403);
    expect(refusalOf(res.body)).toMatchObject({
      code: 'FORGE_FEEDBACK_SOURCE_UNREADABLE',
      path: '/from/project',
    });
    expect(await counted('feedback_occurrences')).toBe(before);
  });

  it('refuses an issue that is not in the project it names', async () => {
    const res = await fileAs(tokens.person, { from: { project: w.home, issue: w.issue } });
    expect(refusalOf(res.body)).toMatchObject({
      code: 'FORGE_FEEDBACK_SOURCE_MISMATCH',
      path: '/from/issue',
    });
  });

  it('files a new item once the one holding the signal key is closed', async () => {
    const declined = await api(
      tokens.homeOwner,
      'POST',
      `/api/projects/${w.home}/feedback/${key}/triage`,
      {
        route: 'decline',
        note: 'Working as designed',
      },
    );
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    const res = await fileAs(tokens.person, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body.feedback as Body).key).not.toBe(key);
    expect(await counted('feedback')).toBe(2);
  });

  it('files over MCP with its one target field, and refuses a submit with none (forge_feedback)', async () => {
    const filed = await callTool(tokens.agentPat, 'forge_feedback', {
      action: 'submit',
      kind: 'idea',
      title: 'forge_issues could take a list of keys',
      target: { kind: 'tool', ref: 'forge_issues' },
    });
    expect(filed.isError, filed.text).toBe(false);
    expect(filed.body).toMatchObject({ created: true, feedback: { phase: 'new' } });
    const [row] = await rows<{ where_seen: string; reported_by: string }>(
      sql`SELECT where_seen, reported_by FROM feedback WHERE title = 'forge_issues could take a list of keys'`,
    );
    expect(row).toEqual({ where_seen: 'tool forge_issues', reported_by: w.agent });
    const none = await callTool(tokens.agentPat, 'forge_feedback', {
      action: 'submit',
      kind: 'idea',
      title: 'no target',
    });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('/target');
  });

  it('lists project_feedback and forge_feedback over MCP, and no agent-report tool', async () => {
    const res = await api(
      tokens.agentPat,
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { accept: 'application/json, text/event-stream' },
    );
    const names = ((res.body.result as { tools: { name: string }[] }).tools ?? []).map(
      (t) => t.name,
    );
    expect(names).toEqual(expect.arrayContaining(['project_feedback', 'forge_feedback']));
    expect(names).not.toContain('forge_agent_report');
  });

  it("refuses a widget binding's own account (FORGE_FEEDBACK_CHANNEL_ACCOUNT)", async () => {
    const widget = (await createTestUser({ verified: true })).id;
    const connection = randomUUID();
    await db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, config)
      VALUES (${connection}, 'user', ${w.homeOwner}, 'widget', '{}'::jsonb)
    `);
    const [binding] = await rows<{ id: string }>(sql`
      INSERT INTO integration_bindings (project_id, connection_id, provider, role, config, label)
      VALUES (${w.client}, ${connection}, 'widget', 'service', ${JSON.stringify({ siteKey: 'site-1' })}::jsonb, 'site')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO widget_principals (binding_id, project_id, user_id) VALUES (${binding?.id}, ${w.client}, ${widget})
    `);
    const before = await counted('feedback_occurrences');
    const res = await fileAs(await userToken(widget), {});
    expect(res.status).toBe(403);
    expect(refusalOf(res.body)?.code).toBe('FORGE_FEEDBACK_CHANNEL_ACCOUNT');
    expect(await counted('feedback_occurrences')).toBe(before);
  });
});

describe('the retired agent reports (BC-8)', () => {
  const report = async (signalKey: string, sessionId: string | null, summary: string) =>
    db.execute(sql`
      INSERT INTO agent_reports (project_id, issue_id, run_id, kind, target, target_ref, summary, detail, signal_key, session_id)
      VALUES (${w.client}, ${w.issue}, ${w.run}, 'skill_gap', 'skill', 'issue-flow', ${summary}, 'detail', ${signalKey}, ${sessionId})
    `);

  it('takes no new report', async () => {
    const failed = await report('skill:x', null, 'refused').then(
      () => null,
      (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
    );
    expect(failed).toMatch(/^AGENT_REPORTS_RETIRED/);
    expect(await rows(sql`SELECT 1 FROM agent_reports`)).toEqual([]);
  });

  it('carries the reports already filed into Forge feedback, once, one item per signal key', async () => {
    const device = await createTestDevice(w.agent);
    const [session] = await rows<{ id: string }>(sql`
      INSERT INTO agent_sessions (project_id, device_id, user_id, pipeline_run_id, kind, status, started_at, created_at)
      VALUES (${w.client}, ${device}, ${w.agent}, ${w.run}, 'run_session', 'completed', now(), now())
      RETURNING id
    `);
    // the rows already there were written before the door was retired
    await db.execute(sql`ALTER TABLE agent_reports DISABLE TRIGGER agent_reports_retired`);
    await report(
      'skill:issue-flow:proof',
      session?.id ?? null,
      'issue-flow never says what proof is',
    );
    await report('skill:issue-flow:proof', session?.id ?? null, 'the proof step is unclear');
    await report('skill:orphan', null, 'a report no session filed');
    await db.execute(sql`ALTER TABLE agent_reports ENABLE TRIGGER agent_reports_retired`);

    const refused = await api(
      tokens.homeOwner,
      'POST',
      '/api/admin/forge-feedback/carry-agent-reports',
      {},
    );
    expect(refused.status).toBe(403);

    const before = await counted('feedback');
    const dry = await api(
      tokens.operator,
      'POST',
      '/api/admin/forge-feedback/carry-agent-reports',
      {
        dryRun: true,
      },
    );
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body).toMatchObject({
      dryRun: true,
      items: [{ signalKey: 'skill:issue-flow:proof', key: null, reports: 2 }],
      refused: [{ signalKey: 'skill:orphan' }],
    });
    expect(await counted('feedback')).toBe(before);

    const carried = await api(
      tokens.operator,
      'POST',
      '/api/admin/forge-feedback/carry-agent-reports',
      {},
    );
    expect(carried.status, JSON.stringify(carried.body)).toBe(200);
    const result = carried.body as {
      items: { key: string; created: boolean; reports: number }[];
      refused: { why: string }[];
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ created: true, reports: 2 });
    expect(result.refused[0]?.why).toMatch(/names no session/);
    const [item] = await rows<{
      id: string;
      reported_by: string;
      signal_key: string;
      kind: string;
    }>(sql`
      SELECT id, reported_by, signal_key, kind FROM feedback WHERE signal_key = 'skill:issue-flow:proof'
    `);
    expect(item).toMatchObject({ reported_by: w.agent, kind: 'change_request' });
    const occ = await rows<Occurrence>(
      sql`SELECT * FROM feedback_occurrences WHERE feedback_id = ${item?.id}`,
    );
    expect(occ).toHaveLength(2);
    expect(occ.every((o) => o.reported_by === w.agent && o.source_project_id === w.client)).toBe(
      true,
    );
    expect(occ.every((o) => o.dedup_key?.startsWith('agent_report:'))).toBe(true);

    const again = await api(
      tokens.operator,
      'POST',
      '/api/admin/forge-feedback/carry-agent-reports',
      {},
    );
    expect(again.body).toMatchObject({ items: [], alreadyCarried: 2 });
    expect(await counted('feedback')).toBe(before + 1);
  });
});
