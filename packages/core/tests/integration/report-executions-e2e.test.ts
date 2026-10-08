import type { ExecutionRequest, Executor } from '@forge/contracts/report-executions';
import { ReportRunSchema } from '@forge/contracts/report-queries';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { db } from '../../src/db/client.js';
import { screenReplyAtDoor } from '../../src/messaging/reply-screen.js';
import {
  registerExecutor,
  sweepExpiredExecutions,
  unregisterExecutorForTest,
} from '../../src/reports/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// The Executor port over its two doors (REQ-32 C1). With no adapter enabled every computation is
// refused by name. With one (a fake, registered here and nowhere in production) a computation reads
// only the asker's own runs, is refused without assistant.exec, where the project has not turned
// computation on, past a turn's cap and where the project's data may not leave it, all before the
// adapter is called; what it returns is kept, drawn as a computed block, read back by its asker and
// grounds a reply's figure as a run's frame does.

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const detail = (res: { body: Body }) => String(res.body.detail);

const SHARE = 43.75;
let durationMs = 40;
const execute = vi.fn(async (request: ExecutionRequest) => ({
  executionId: `fake-${execute.mock.calls.length}`,
  adapter: 'fake-sandbox',
  exit: 0,
  durationMs,
  frames: [
    {
      fields: [
        { name: 'inputs', type: 'number' as const, label: 'Inputs' },
        { name: 'share', type: 'number' as const, label: 'Share', unit: '%' },
      ],
      rows: [{ inputs: request.inputs.length, share: SHARE }],
    },
  ],
  logs: { stdout: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 done', stderr: '' },
}));
const fake: Executor = {
  id: 'fake-sandbox',
  mode: 'invoked',
  isolation: 'a test double in this process',
  network: 'none',
  dataLeavesTo: 'forge',
  zdrEligible: true,
  availableFor: () => true,
  execute,
};

let w: World;
let member: { id: string; token: string };
let roomId: string;

const runQuery = async (projectId = w.projectId, token = w.token) => {
  const res = await api(
    token,
    'POST',
    `/api/projects/${projectId}/report-queries/progress-by-requirement/runs`,
    {},
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ReportRunSchema.parse(res.body);
};
const compute = (body: Body, token = w.token, projectId = w.projectId) =>
  api(token, 'POST', `/api/projects/${projectId}/executions`, body);
const script = 'import json\nprint(len(json.load(open("inputs.json"))))';

beforeAll(async () => {
  w = await world();
  const user = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, user.id, 'member');
  member = { id: user.id, token: await userToken(user.id) };
  await seedProjectDocument(w.projectId, w.userId, {
    environments: {},
    extra: { compute: { enabled: true } },
  });
  const opened = await api(w.token, 'POST', '/api/conversations', {
    projectId: w.projectId,
    title: 'what the runs do not say',
    people: [member.id],
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  roomId = String(opened.body.id);
}, 120_000);

beforeEach(() => {
  execute.mockClear();
  durationMs = 40;
});

describe('with no executor enabled', () => {
  it('refuses every computation by name while no executor is enabled on this deployment', async () => {
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect([res.status, code(res)]).toEqual([503, 'EXECUTOR_UNAVAILABLE']);
    expect(detail(res)).toContain('no sandbox executor is enabled on this deployment');
  });
});

describe('a computation an executor ran', () => {
  beforeAll(() => registerExecutor(fake));
  afterAll(() => unregisterExecutorForTest(fake.id));

  it('keeps what the executor returned, scrubbed, and draws it as a computed block', async () => {
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      language: 'python',
      script,
      inputs: [run.frame],
      limits: { wallMs: 30_000, outputBytes: 256_000 },
    });
    const executionId = String(res.body.executionId);
    expect(res.body.source).toEqual({ executionId });
    expect(res.body.computed).toBe(true);
    expect(res.body.frames).toEqual([
      {
        fields: [
          { name: 'inputs', type: 'number', label: 'Inputs' },
          { name: 'share', type: 'number', label: 'Share', unit: '%' },
        ],
        rows: [{ inputs: 1, share: SHARE }],
      },
    ]);
    expect(JSON.stringify(res.body.logs)).not.toContain('ghp_');

    const kept = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/executions/${executionId}`,
    );
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body).toMatchObject({
      executionId,
      adapter: 'fake-sandbox',
      askedBy: w.userId,
      inputRunIds: [run.runId],
      exit: 0,
      stopped: null,
    });
    const byMember = await api(
      member.token,
      'GET',
      `/api/projects/${w.projectId}/executions/${executionId}`,
    );
    expect([byMember.status, code(byMember)]).toEqual([403, 'EXECUTION_READ_FORBIDDEN']);

    const shown = await api(w.token, 'POST', `/api/conversations/${roomId}/blocks`, {
      projectId: w.projectId,
      block: {
        kind: 'kpi',
        figures: [
          { field: 'inputs', label: 'Inputs' },
          { field: 'share', label: 'Share' },
        ],
        source: { executionId },
      },
    });
    expect(shown.status, JSON.stringify(shown.body)).toBe(201);
    expect(String(shown.body.text)).toContain(`Computed by execution ${executionId}`);
    const messages = (await api(w.token, 'GET', `/api/conversations/${roomId}`)).body
      .messages as Body[];
    const posted = messages.find((m) => m.id === shown.body.messageId) as Body;
    expect(posted.blocks).toEqual([
      {
        type: 'visual',
        visual: expect.objectContaining({
          kind: 'kpi',
          source: { executionId },
          frame: (res.body.frames as Body[])[0],
        }),
        execution: {
          executionId,
          adapter: 'fake-sandbox',
          language: 'python',
          at: kept.body.createdAt,
        },
      },
    ]);
  });

  it('stores the same fingerprint for one script however it is spaced', async () => {
    const run = await runQuery();
    const spaced = `\n${script.replace('\n', '   \r\n\n')}  \n`;
    const a = await compute({ language: 'python', script, inputs: [run.runId] });
    const b = await compute({ language: 'python', script: spaced, inputs: [run.runId] });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.scriptFingerprint).toBe(a.body.scriptFingerprint);
    expect(String(a.body.scriptFingerprint)).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db.execute<{ script_fingerprint: string; script: string }>(sql`
      SELECT script_fingerprint, script FROM report_executions WHERE id = ${String(b.body.executionId)}
    `);
    expect(row).toEqual({ script_fingerprint: a.body.scriptFingerprint, script: spaced });
    const other = await compute({
      language: 'python',
      script: `${script}\nprint(2)`,
      inputs: [run.runId],
    });
    expect(other.body.scriptFingerprint).not.toBe(a.body.scriptFingerprint);
  });

  it('grounds a reply figure on the execution frame, and nothing once it is past its keep', async () => {
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const screen = () =>
      screenReplyAtDoor('web-agent-completion', {
        projectId: w.projectId,
        segments: [`The share is ${SHARE}%.`],
        toolCalls: [],
        progress: null,
        question: 'What share of the work does that come to?',
        restResults: [JSON.stringify(res.body)],
      });
    const figureRules = (v: Awaited<ReturnType<typeof screen>>) =>
      v.ok ? [] : v.refusals.filter((r) => r.rule === 'figures-grounded');
    expect(figureRules(await screen())).toEqual([]);
    await db.execute(sql`
      UPDATE report_executions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
      WHERE id = ${String(res.body.executionId)}
    `);
    expect(figureRules(await screen()).map((r) => r.quote)).toEqual([`${SHARE}%`]);
    const gone = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/executions/${String(res.body.executionId)}`,
    );
    expect([gone.status, code(gone)]).toEqual([404, 'EXECUTION_EXPIRED']);
    expect((await sweepExpiredExecutions()).reportExecutions).toBeGreaterThanOrEqual(1);
  });
});

describe('a computation refused before the executor sees it', () => {
  beforeAll(() => registerExecutor(fake));
  afterAll(() => unregisterExecutorForTest(fake.id));

  it('refuses a member without assistant.exec, and a named grant that does not name it', async () => {
    const run = await runQuery(w.projectId, member.token);
    const res = await compute({ language: 'python', script, inputs: [run.runId] }, member.token);
    expect([res.status, code(res)]).toEqual([403, 'PERMISSION_FORBIDDEN']);
    expect(detail(res)).toContain('assistant.exec');
    const routesOnly = (
      await mintPat({
        permissions: ['projects:read', 'projects:write'],
        userId: w.userId,
        name: 'routes',
        projectIds: [w.projectId],
      })
    ).plaintext;
    const byToken = await compute({ language: 'python', script, inputs: [] }, routesOnly);
    expect([byToken.status, code(byToken)]).toEqual([403, 'PERMISSION_FORBIDDEN']);
    expect(detail(byToken)).toContain(
      'A named token grant holds assistant.exec only where it names it',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a project that has not turned computation on, and a run that is not the asker’s', async () => {
    const off = await world();
    const offRun = await runQuery(off.projectId, off.token);
    const res = await compute(
      { language: 'python', script, inputs: [offRun.runId] },
      off.token,
      off.projectId,
    );
    expect([res.status, code(res)]).toEqual([403, 'EXECUTION_DISABLED']);
    expect(detail(res)).toContain('compute.enabled is unset');
    const memberRun = await runQuery(w.projectId, member.token);
    const notMine = await compute({ language: 'python', script, inputs: [memberRun.runId] });
    expect([notMine.status, code(notMine)]).toEqual([403, 'REPORT_RUN_READ_FORBIDDEN']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a sandbox the project setting does not admit, naming why, and never routes on', async () => {
    const zdr = await world();
    const zdrRun = await runQuery(zdr.projectId, zdr.token);
    await seedProjectDocument(zdr.projectId, zdr.userId, {
      environments: {},
      extra: { compute: { enabled: true, thirdParty: false } },
    });
    const thirdParty = { ...fake, id: 'third-party-sandbox', dataLeavesTo: 'vendor.example' };
    unregisterExecutorForTest(fake.id);
    registerExecutor(thirdParty);
    try {
      const res = await compute(
        { language: 'bash', script: 'cat inputs.json', inputs: [zdrRun.runId] },
        zdr.token,
        zdr.projectId,
      );
      expect([res.status, code(res)]).toEqual([403, 'EXECUTION_NO_ADAPTER_ALLOWED']);
      expect(detail(res)).toContain('third-party-sandbox sends the data to vendor.example');
    } finally {
      unregisterExecutorForTest(thirdParty.id);
      registerExecutor(fake);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('applies the project data policy before the executor sees any of it', async () => {
    const closed = await world();
    const closedRun = await runQuery(closed.projectId, closed.token);
    await seedProjectDocument(closed.projectId, closed.userId, {
      environments: {},
      extra: { compute: { enabled: true }, sensitiveData: 'no_egress' },
    });
    const res = await compute(
      { language: 'python', script, inputs: [closedRun.runId] },
      closed.token,
      closed.projectId,
    );
    expect([res.status, code(res)]).toEqual([403, 'CONTENT_EGRESS_FORBIDDEN']);
    expect(detail(res)).toContain('report.exec');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('a turn’s caps', () => {
  beforeAll(() => registerExecutor(fake));
  afterAll(() => unregisterExecutorForTest(fake.id));

  it('refuses a call past the turn’s wall-time cap, naming the cap and what is left', async () => {
    const capped = (
      await mintPat({
        permissions: ['*'],
        userId: w.userId,
        name: 'one turn',
        projectIds: [w.projectId],
      })
    ).plaintext;
    const run = await runQuery(w.projectId, capped);
    durationMs = 50_000;
    for (let i = 0; i < 2; i++) {
      const ok = await compute({ language: 'python', script, inputs: [run.runId] }, capped);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    }
    const over = await compute({ language: 'python', script, inputs: [run.runId] }, capped);
    expect([over.status, code(over)]).toEqual([422, 'EXECUTION_TURN_CAP_REACHED']);
    expect(detail(over)).toContain('this turn has 20000 ms of its 120000 ms wall-time cap left');
    const within = await compute(
      { language: 'python', script, inputs: [run.runId], limits: { wallMs: 20_000 } },
      capped,
    );
    expect(within.status, JSON.stringify(within.body)).toBe(201);
    const tooBig = await compute(
      { language: 'python', script, inputs: [], limits: { wallMs: 60_001 } },
      capped,
    );
    expect([tooBig.status, code(tooBig)]).toEqual([400, 'EXECUTION_LIMIT_REFUSED']);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
