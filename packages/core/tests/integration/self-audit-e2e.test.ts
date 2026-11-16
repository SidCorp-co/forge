/**
 * ISS-1251 c3 and c4: a master and a run audit their own output with audit.self (MCP) or its REST
 * twin, in the shape a room agent's support.audit takes, and the steward in its done call. Every
 * verdict is kept in the one store, so the capabilities page's misses count reads each agent kind's
 * through the read it already makes. A door the catalog does not serve is refused by name and nothing
 * is kept; a failed verdict becomes a self-audit correction on the issue. Through the app's own routes
 * against real Postgres.
 *
 * @direct-test-of packages/core/src/support/reply-audit/self-audit.ts
 * @direct-test-of packages/core/src/support/reply-audit/route.ts
 * @direct-test-of packages/core/src/support/audit-tool.ts
 * @direct-test-of packages/core/src/metrics/door-use.ts
 * @direct-test-of packages/core/src/db/schema-support-verdicts.ts
 */

import { randomUUID } from 'node:crypto';
import type { DoorUseRow, DoorUseView } from '@forge/contracts/door-use';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { judgeSelfAudit, keepSelfAudit } from '../../src/support/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

const w = { owner: '', agent: '', project: '', issue: '', key: '', other: '' };
const t = { owner: '', agent: '' };

const audit = (body: Record<string, unknown>) =>
  api(t.agent, 'POST', `/api/projects/${w.project}/self-audits`, body);

const refusalOf = (body: Body) =>
  ((body.error as { refusals?: { code: string; path: string; detail: string }[] })?.refusals ??
    [])[0];

const kept = () =>
  rows<{ agent: string; output_ref: string; verdict: string; missed: unknown }>(
    sql`SELECT agent, output_ref, verdict, missed FROM support_reply_verdicts
         WHERE project_id = ${w.project}::uuid ORDER BY audited_at`,
  );

async function callTool(args: Record<string, unknown>) {
  const res = await api(
    t.agent,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_audit', arguments: args },
    },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0]?.text ?? '{}') as Body,
  };
}

const doorsOf = async () => {
  const res = await api(t.owner, 'GET', `/api/projects/${w.project}/metrics/doors`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as DoorUseView;
};
const door = (view: DoorUseView, id: string) => view.doors.find((d) => d.door === id) as DoorUseRow;

beforeAll(async () => {
  testEnv();
  w.owner = (await createTestUser({ verified: true })).id;
  w.agent = (await createTestUser({ kind: 'agent' })).id;
  w.project = (await createTestProject(w.owner)).id;
  await addProjectMember(w.project, w.agent);
  const issue = await createTestIssue(w.project, w.owner, 41, {
    status: 'in_progress',
    createdAt: new Date(),
  });
  w.issue = issue.id;
  w.key = issue.key;
  w.other = (
    await createTestIssue(w.project, w.owner, 42, { status: 'in_progress', createdAt: new Date() })
  ).id;
  t.owner = await userToken(w.owner);
  t.agent = (
    await mintPat({
      permissions: ['*'],
      userId: w.agent,
      name: 'agent',
      grantEpoch: PAT_GRANT_EPOCH,
      projectIds: [w.project],
    })
  ).plaintext;
});

describe('a master or a run audits its own output (ISS-1251 c4)', () => {
  it('refuses a missed door Forge serves none as, by name and where, keeping nothing', async () => {
    const res = await audit({
      as: 'master',
      output: { kind: 'issue', ref: w.key },
      failed: [],
      missed: [
        { door: 'feedback.door', why: 'fine' },
        { door: 'audit.telepathy', why: 'should have read minds' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalOf(res.body)).toMatchObject({
      code: 'SELF_AUDIT_DOOR_UNKNOWN',
      path: '/missed/1/door',
    });
    expect(refusalOf(res.body)?.detail).toContain('audit.telepathy');
    expect(await kept()).toEqual([]);
  });

  it("refuses a line the role's rubric does not hold, and an output that is no issue here", async () => {
    const line = await audit({
      as: 'run',
      output: { kind: 'issue', ref: w.key },
      failed: [{ line: 'tidy', why: 'tidy is a master line' }],
    });
    expect(line.status).toBe(400);
    expect(refusalOf(line.body)).toMatchObject({
      code: 'SELF_AUDIT_LINE_UNKNOWN',
      path: '/failed/0/line',
    });
    expect(refusalOf(line.body)?.detail).toContain('criteria_proven');
    const output = await audit({
      as: 'run',
      output: { kind: 'issue', ref: 'ISS-9999' },
      failed: [],
    });
    expect(output.status).toBe(404);
    expect(refusalOf(output.body)?.code).toBe('SELF_AUDIT_OUTPUT_UNKNOWN');
    expect(await kept()).toEqual([]);
  });

  it('keeps a master’s failed audit, with a tripped red flag, as a correction on the issue', async () => {
    const res = await audit({
      as: 'master',
      output: { kind: 'issue', ref: w.key },
      failed: [
        { line: 'tidy', why: 'left the worktree behind' },
        { redFlag: 'feedback.door', why: 'guessed around a guide and said nothing' },
      ],
      missed: [{ door: 'feedback.door', why: 'should have reported the guide' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      verdict: 'fail',
      failed: ['tidy', 'red_flag:feedback.door'],
      missed: [{ door: 'feedback.door', why: 'should have reported the guide' }],
      already: false,
    });
    const [correction] = await rows<{ id: string; item_id: string; reason: string }>(
      sql`SELECT id, item_id, reason FROM corrections
           WHERE project_id = ${w.project}::uuid AND source = 'self_audit'`,
    );
    expect(correction?.item_id).toBe(w.issue);
    expect(correction?.reason).toContain('red_flag:feedback.door');
    expect(res.body.correctionId).toBe(correction?.id);
    // a second audit of the same output in the same role answers the first, unchanged
    const again = await audit({
      as: 'master',
      output: { kind: 'issue', ref: w.issue },
      failed: [],
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ verdict: 'fail', already: true });
  });

  it('takes a run’s audit through the MCP action, a twin route kept as its act', async () => {
    const out = await callTool({
      action: 'self',
      projectId: w.project,
      as: 'run',
      output: { kind: 'issue', ref: w.key },
      failed: [],
      missed: [
        { door: 'POST /api/projects/:id/feedback', why: 'a defect met was never filed' },
        { door: 'feedback.door', why: 'twice named, counted once per audit' },
      ],
    });
    expect(out.isError, JSON.stringify(out.body)).toBe(false);
    expect(out.body).toMatchObject({
      verdict: 'pass',
      missed: [{ door: 'project_feedback.submit' }, { door: 'feedback.door' }],
      correctionId: null,
    });
    const refused = await callTool({
      action: 'self',
      projectId: w.project,
      as: 'run',
      output: { kind: 'issue', ref: w.other },
      failed: [{ redFlag: 'nothing.here', why: 'no such door' }],
    });
    expect(refused.isError).toBe(true);
    expect(refusalOf(refused.body)?.code).toBe('SELF_AUDIT_DOOR_UNKNOWN');
  });
});

describe("the capabilities page counts every agent kind's misses from the one store (ISS-1251 c3)", () => {
  it('reads a master’s, a run’s and the steward’s misses on the door they named, by kind', async () => {
    // the steward's audit as its done call keeps it, on a run of its own
    const judged = judgeSelfAudit(
      'steward',
      [],
      [{ door: 'feedback.door', why: 'the curator never reported the stale card' }],
    );
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    await keepSelfAudit({
      projectId: w.project,
      agent: 'steward',
      output: { kind: 'steward_run', ref: randomUUID() },
      byUserId: w.agent,
      agency: 'agent',
      judged: judged.value,
      item: null,
    });
    expect((await kept()).map((k) => k.agent)).toEqual(['master', 'run', 'steward']);

    const view = await doorsOf();
    expect(door(view, 'feedback.door')).toMatchObject({
      misses: 3,
      missedBy: { 'session:master': 1, 'session:run_session': 1, steward: 1 },
    });
    expect(door(view, 'project_feedback.submit')).toMatchObject({
      misses: 1,
      missedBy: { 'session:run_session': 1 },
    });
    expect(view.totals.misses).toBe(4);
  });
});
