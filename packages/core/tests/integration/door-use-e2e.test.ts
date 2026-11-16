/**
 * ISS-1251: what agents do with the doors Forge gives them. A project's door use counts each logged
 * call against the catalog and lists the doors no agent called with 0; it says what each agent kind
 * read; a box session's turn token reads on its own session's record; an agent reports a door or a
 * piece of teaching that failed it, and that becomes feedback about Forge naming the door and its
 * feature; and each pile a prompt carries reads against its cap. Through the app's own routes
 * against real Postgres.
 *
 * @direct-test-of packages/core/src/metrics/door-use.ts
 * @direct-test-of packages/core/src/metrics/piles.ts
 * @direct-test-of packages/core/src/metrics/routes.ts
 * @direct-test-of packages/core/src/mcp/door-catalog.ts
 * @direct-test-of packages/core/src/forge-door/door-report.ts
 * @direct-test-of packages/core/src/forge-door/routes.ts
 * @direct-test-of packages/core/src/forge-door/tool.ts
 * @direct-test-of packages/core/src/run-context-ports.ts
 * @direct-test-of packages/core/src/run-context/hook.ts
 */

import { randomUUID } from 'node:crypto';
import type { DoorUseRow, DoorUseView, PilesView } from '@forge/contracts/door-use';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@door-use.test';
});

import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestDevice,
  createTestProject,
  createTestRunSession,
  createTestUser,
  rows,
} from '../helpers/factories.js';

const w = { owner: '', agent: '', project: '', other: '', home: '', device: '', session: '' };
const t = { owner: '', agent: '', box: '', turn: '', agentToken: '', boxToken: '' };

const mint = async (userId: string, name: string, more: Record<string, unknown> = {}) =>
  mintPat({ permissions: ['*'], userId, name, grantEpoch: PAT_GRANT_EPOCH, ...more });

/** One logged call, as the MCP door and the REST write recorder write it. */
async function plant(row: {
  tool: string;
  action: string | null;
  tokenId: string;
  userId: string;
  projectId?: string | null;
  resultCode?: string;
  at?: Date;
}) {
  await db.execute(sql`
    INSERT INTO mcp_audit_log (user_id, token_id, tool, action, project_id, result_code, created_at)
    VALUES (${row.userId}, ${row.tokenId}, ${row.tool}, ${row.action}, ${row.projectId ?? null},
      ${row.resultCode ?? 'ok'}, ${(row.at ?? new Date()).toISOString()})`);
}

const doorsOf = async (query = '') => {
  const res = await api(t.owner, 'GET', `/api/projects/${w.project}/metrics/doors${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as DoorUseView;
};
const door = (view: DoorUseView, id: string) => view.doors.find((d) => d.door === id) as DoorUseRow;

beforeAll(async () => {
  testEnv();
  const operator = (await createTestUser({ email: 'operator@door-use.test', verified: true })).id;
  w.owner = (await createTestUser({ verified: true })).id;
  w.agent = (await createTestUser({ kind: 'agent' })).id;
  w.project = (await createTestProject(w.owner)).id;
  w.other = (await createTestProject(w.owner)).id;
  w.home = (await createTestProject(w.owner)).id;
  await addProjectMember(w.project, w.agent);
  w.device = await createTestDevice(w.owner);
  const run = await createTestRunSession(w.project, w.device, new Date(), null);
  // a second live run on the box: a read naming no run is no one run's, so only the token names it
  await createTestRunSession(w.project, w.device, new Date(), null);
  w.session =
    (
      await rows<{ id: string }>(sql`SELECT id FROM agent_sessions WHERE pipeline_run_id = ${run}`)
    )[0]?.id ?? '';
  t.owner = await userToken(w.owner);
  const agent = await mint(w.agent, 'agent', { projectIds: [w.project] });
  t.agent = agent.plaintext;
  t.agentToken = agent.row.id;
  const box = await mint(w.agent, `device:${w.device}`, {
    projectIds: [w.project],
    deviceId: w.device,
  });
  t.box = box.plaintext;
  t.boxToken = box.row.id;
  t.turn = (
    await mint(w.agent, `turn:${w.session}`, { projectIds: [w.project], deviceId: w.device })
  ).plaintext;
  const named = await api(await userToken(operator), 'PATCH', '/api/admin/instance-settings', {
    baseRevision: 0,
    patch: { forgeHomeProjectId: w.home },
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);
});

describe("a project's door use counts each call against the catalog, the never-called doors listed with 0", () => {
  it('counts a planted call by its agent kind and lists a door no agent called with 0', async () => {
    await plant({
      tool: 'forge_support',
      action: 'member',
      tokenId: t.agentToken,
      userId: w.agent,
    });
    await plant({
      tool: 'forge_support',
      action: 'member',
      tokenId: t.boxToken,
      userId: w.agent,
      resultCode: 'forbidden',
    });
    await plant({
      tool: 'rest',
      action: `POST /api/projects/${w.project}/feedback`,
      tokenId: t.boxToken,
      userId: w.agent,
      projectId: w.project,
    });
    // another project's call, an old one and a name the catalog holds no door for
    await plant({
      tool: 'forge_support',
      action: 'member',
      tokenId: t.boxToken,
      userId: w.agent,
      projectId: w.other,
    });
    await plant({
      tool: 'forge_support',
      action: 'member',
      tokenId: t.agentToken,
      userId: w.agent,
      at: new Date(Date.now() - 40 * 86_400_000),
    });
    await plant({ tool: 'forge_gone', action: 'old', tokenId: t.agentToken, userId: w.agent });

    const view = await doorsOf();
    expect(door(view, 'support.member')).toMatchObject({
      surface: 'mcp',
      calls: 2,
      refused: 1,
      refusedBy: { forbidden: 1 },
      byAgent: { 'agent-account': 1, box: 1 },
    });
    expect(door(view, 'support.member').feature).toContain('forge_support');
    expect(door(view, 'support.member').tiers).toEqual({});
    // a card's door is in each audience's map it teaches, at Tier 0 (carried) or Tier 1 (found)
    expect(Object.keys(door(view, 'feedback.door').tiers).sort()).toEqual(['bot', 'master', 'run']);
    // a REST write that does an MCP action's act counts on that act's one row, under its one card
    expect(door(view, 'project_feedback.submit')).toMatchObject({
      surface: 'mcp',
      twins: ['POST /api/projects/:id/feedback'],
      calls: 1,
      viaTwins: 1,
      byAgent: { box: 1 },
      card: { id: 'POST /api/projects/:id/feedback' },
    });
    expect(view.doors.some((d) => d.door === 'POST /api/projects/:id/feedback')).toBe(false);
    // the catalog is the denominator: a door nobody called is listed, with 0
    expect(door(view, 'support.rule')).toMatchObject({ calls: 0, refused: 0, byAgent: {} });
    expect(view.totals.neverUsed).toBeGreaterThan(0);
    expect(view.totals.doors).toBe(view.doors.length);
    expect(view.unmatched).toEqual([{ door: 'forge_gone.old', calls: 1 }]);
    // every day of the window, today holding the planted calls of this project
    expect(view.days).toHaveLength(31);
    expect(view.days.at(-1)).toMatchObject({
      day: new Date().toISOString().slice(0, 10),
      calls: 4,
      refused: 1,
    });
    expect(view.days.slice(0, -1).every((d) => d.calls === 0)).toBe(true);
    expect(view.limits.length).toBeGreaterThan(0);
  });

  it('narrows to the doors never used, or to one surface', async () => {
    const never = await doorsOf('?used=never&surface=mcp');
    expect(never.doors.every((d) => d.calls === 0 && d.surface === 'mcp')).toBe(true);
    expect(never.doors.some((d) => d.door === 'support.member')).toBe(false);
    expect(never.doors.some((d) => d.door === 'support.rule')).toBe(true);
    const wide = await api(t.owner, 'GET', `/api/projects/${w.project}/metrics/doors?days=91`);
    expect(wide.status).toBe(400);
  });
});

describe('what each agent kind read is told apart by its session', () => {
  it("records a session's turn token's knowledge read on that session, and reads it by agent kind", async () => {
    const put = await api(t.owner, 'PUT', `/api/projects/${w.project}/knowledge/door-use-guide`, {
      kind: 'guide',
      title: 'Door use guide',
      body: 'Before answering someone, read who they are.',
      source: 'ISS-1251',
      scope: 'this test project',
      recheckWhen: 'the member act changes',
    });
    expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);
    const got = await api(t.turn, 'GET', `/api/projects/${w.project}/knowledge/door-use-guide`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    let reached: { agent_session_id: string; how: string }[] = [];
    for (let i = 0; i < 50 && reached.length === 0; i += 1) {
      reached = await rows(
        sql`SELECT agent_session_id, how FROM run_context_reaches WHERE ref = 'door-use-guide'`,
      );
      if (reached.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(reached).toEqual([{ agent_session_id: w.session, how: 'get' }]);
    const view = await doorsOf();
    expect(view.reads).toContainEqual(
      expect.objectContaining({
        agent: 'session:run_session',
        kind: 'knowledge',
        how: 'get',
        reaches: 1,
        top: [{ ref: 'door-use-guide', reaches: 1 }],
      }),
    );
  });
});

const refusalOf = (body: Body) =>
  ((body.error as { refusals?: { code: string; detail: string }[] })?.refusals ?? [])[0];

describe('an agent reports a door or teaching that failed it, as feedback on the feature that owns it', () => {
  const filed = async (key: string) =>
    (
      await rows<{ where_seen: string; body: string; kind: string; signal_key: string }>(
        sql`SELECT where_seen, body, kind, signal_key FROM feedback
          WHERE project_id = ${w.home} AND fb_seq = ${Number(key.slice(3))}`,
      )
    )[0];

  it('files a door that did not help, naming it and its feature, and adds a repeat to the same item', async () => {
    const report = {
      verdict: 'did_not_help',
      door: 'support.member',
      what: 'I recorded who wrote, and the next turn still did not know them.',
    };
    const first = await api(t.agent, 'POST', '/api/forge/feedback/doors', report);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const key = (first.body.feedback as { key: string }).key;
    expect(await filed(key)).toMatchObject({
      where_seen: 'tool support.member',
      kind: 'bug',
      signal_key: 'door:did_not_help:support.member',
    });
    expect((await filed(key))?.body).toContain('Feature: forge_support');
    const again = await api(t.agent, 'POST', '/api/forge/feedback/doors', report);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ created: false, feedback: { key } });
  });

  it('files teaching that was unclear, and a missing door with no door named, over MCP too', async () => {
    const res = await api(
      t.agent,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'forge_call',
          arguments: {
            action: 'feedback.door',
            args: {
              verdict: 'unclear',
              door: 'guide:agent-setup',
              what: 'It names the routes but not when to read memory first.',
            },
          },
        },
      },
      { accept: 'application/json, text/event-stream' },
    );
    const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
      .result;
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    const key = (JSON.parse(result.content[0]?.text ?? '{}') as { feedback: { key: string } })
      .feedback.key;
    expect(await filed(key)).toMatchObject({
      where_seen: 'guide agent-setup',
      kind: 'change_request',
    });
    const missing = await api(t.agent, 'POST', '/api/forge/feedback/doors', {
      verdict: 'missing',
      what: 'No door tells me who a chat member is before I answer them.',
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(201);
    expect(missing.body.door).toBeNull();
  });

  it('refuses a door Forge does not serve by name, with the actions its door serves, filing nothing', async () => {
    const before = (await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM feedback`))[0]?.n;
    const res = await api(t.agent, 'POST', '/api/forge/feedback/doors', {
      verdict: 'did_not_help',
      door: 'support.membr',
      what: 'The member act did not record anything at all.',
    });
    expect(res.status).toBe(400);
    expect(refusalOf(res.body)?.code).toBe('DOOR_REPORT_UNKNOWN_DOOR');
    expect(refusalOf(res.body)?.detail).toContain('support.member');
    const unnamed = await api(t.agent, 'POST', '/api/forge/feedback/doors', {
      verdict: 'unclear',
      what: 'It did not say when to use it at all.',
    });
    expect(refusalOf(unnamed.body)?.code).toBe('DOOR_REPORT_DOOR_REQUIRED');
    expect((await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM feedback`))[0]?.n).toBe(
      before,
    );
  });
});

describe('each pile a prompt carries reads against its cap', () => {
  it('reports always-on knowledge, the lessons map and each skill with size and cap', async () => {
    await db.execute(sql`
      INSERT INTO skills (name, description, scope, project_id, prompt, source, content_hash)
      VALUES (${`door-use-skill-${randomUUID().slice(0, 6)}`}, ${'x'.repeat(1100)}, 'project',
        ${w.project}, 'p', 'user', 'h')`);
    const res = await api(t.owner, 'GET', `/api/projects/${w.project}/metrics/piles`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { piles } = res.body as unknown as PilesView;
    expect(piles.find((p) => p.pile === 'always_knowledge')).toMatchObject({
      cap: 6000,
      over: false,
    });
    expect(piles.find((p) => p.pile === 'lessons_map')).toMatchObject({ cap: 1200, items: 0 });
    // the Tier-0 map of each audience, rendered from the cards that teach it
    const master = piles.find((p) => p.name === 'map (master)');
    expect(master).toMatchObject({ pile: 'tier0_map', cap: 2500 });
    // more cards teach a master than its map holds: the most used are carried whole, the rest are
    // Tier 1, and each door's row says which
    expect(master?.items).toBeGreaterThan(master?.carried ?? 0);
    expect(master?.carried).toBeGreaterThan(0);
    expect(master?.over).toBe(true);
    const view = await doorsOf();
    const atTier = (n: 0 | 1) => view.doors.filter((d) => d.tiers.master === n).length;
    expect(atTier(0)).toBe(master?.carried);
    expect(atTier(0) + atTier(1)).toBe(master?.items);
    // the one carded door this project called ranks into the map
    expect(door(view, 'project_feedback.submit').tiers.master).toBe(0);
    expect(piles.find((p) => p.name === 'map (bot)')?.items).toBeGreaterThan(0);
    expect(piles.find((p) => p.pile === 'skill_always_on' && p.size === 1100)).toMatchObject({
      cap: 1024,
      over: true,
    });
  });
});
