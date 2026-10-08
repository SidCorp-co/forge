import { ReportRunSchema } from '@forge/contracts/report-queries';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { CODE_EXECUTOR_ID, createCodeExecutor } from '../../src/integrations/llm/code-execution.js';
import type { McpContext } from '../../src/lib/tool.js';
import { registerExecutor, unregisterExecutorForTest } from '../../src/reports/index.js';
import { forgeComputeTool, forgeReportTool } from '../../src/reports/tool.js';
import { api, type Body } from '../helpers/api.js';
import { fakeCodeExecutionApi } from '../helpers/code-execution-wire.js';
import { requirement, type World, world } from '../helpers/forecast-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

// The in-band executor (REQ-32 C2) behind the reports Executor port, with the provider faked at the
// wire: a project that admits third-party processing runs its script in the provider's container and
// gets frames and a computed block back; a project that has not admitted it, or requires ZDR, is
// refused before anything leaves; a provider error is a named stop and nothing is kept; the inputs
// reach the container scrubbed; and a chat turn's container is its conversation's alone.

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const FRAMES = {
  frames: [
    {
      fields: [{ name: 'share', type: 'number', label: 'Share', unit: '%' }],
      rows: [{ share: 43.75 }],
    },
  ],
};
const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const detail = (res: { body: Body }) => String(res.body.detail);
const script = 'import json\nprint(len(json.load(open("inputs.json"))))';

const wire = fakeCodeExecutionApi();
let w: World;
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
const kept = async () =>
  Number(
    (await db.execute<{ n: string }>(sql`SELECT count(*)::int AS n FROM report_executions`))[0]?.n,
  );

/** A chat turn's tool context in the room `conversationId`, as the turn runner builds one. */
const turn = (conversationId: string, tokenId: string) =>
  ({
    principal: {
      kind: 'pat',
      agency: 'human',
      agentUserId: null,
      userId: w.userId,
      tokenId,
      scopes: [],
      projectIds: null,
      boundProjectId: null,
      permissions: ['*'],
    },
    projectSlug: null,
    turn: { conversationId, speakerUserId: w.userId, handleUserId: null },
  }) as unknown as McpContext;

const openRoom = async (title: string) => {
  const opened = await api(w.token, 'POST', '/api/conversations', {
    projectId: w.projectId,
    title,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return String(opened.body.id);
};

beforeAll(async () => {
  w = await world();
  // agreed, so the progress query lists it: moved inside a transaction that names itself the
  // kernel's, as a seed must (tests/integration/project-status-e2e.test.ts:seeded)
  const title = `Rotate ${SECRET} out of the deploy`;
  const req = await requirement(w, title);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      VALUES (${req.id}, 1, 'current', ${JSON.stringify({ goal: title })}::jsonb, 'seed', ${w.userId}, 'human', ${w.userId}, now())
    `);
    await tx.execute(
      sql`UPDATE requirements SET status = 'agreed', current_revision = 1 WHERE id = ${req.id}`,
    );
  });
  await seedProjectDocument(w.projectId, w.userId, {
    environments: {},
    extra: { compute: { enabled: true, thirdParty: true } },
  });
  roomId = await openRoom('what the runs do not say');
  unregisterExecutorForTest(CODE_EXECUTOR_ID);
  registerExecutor(
    createCodeExecutor({
      baseUrl: 'https://provider.test',
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: wire.fetchImpl,
    }),
  );
}, 120_000);
afterAll(() => unregisterExecutorForTest(CODE_EXECUTOR_ID));

beforeEach(() => {
  wire.calls.length = 0;
  wire.run = { output: { file: 'frames.json', text: JSON.stringify(FRAMES) }, stdout: '1\n' };
});

describe('a computation in the provider container', () => {
  it('uploads the run frames scrubbed, and answers the frames the script wrote as a computed block', async () => {
    const run = await runQuery();
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      adapter: CODE_EXECUTOR_ID,
      exit: 0,
      frames: FRAMES.frames,
      computed: true,
      logs: { stdout: '1\n', stderr: '' },
    });

    const uploads = wire.uploaded().map(([, f]) => f);
    const inputs = uploads.filter((f) => f.filename.endsWith('-inputs.json')).at(-1);
    expect(inputs?.text).toContain('Rotate');
    expect(inputs?.text).not.toContain(SECRET);
    expect(uploads.filter((f) => f.filename.endsWith('-script.py')).at(-1)?.text).toBe(script);
    expect(wire.live()).toEqual([]);

    const executionId = String(res.body.executionId);
    const read = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/executions/${executionId}`,
    );
    expect(read.body).toMatchObject({ adapter: CODE_EXECUTOR_ID, exit: 0, stopped: null });
    const shown = await api(w.token, 'POST', `/api/conversations/${roomId}/blocks`, {
      projectId: w.projectId,
      block: {
        kind: 'table',
        columns: ['share'],
        source: { executionId },
      },
    });
    expect(shown.status, JSON.stringify(shown.body)).toBe(201);
    expect(String(shown.body.text)).toContain(`Computed by execution ${executionId}`);
  });

  it('names a provider error as the executor failing, and keeps nothing', async () => {
    const run = await runQuery();
    const before = await kept();
    wire.next({ status: 529, errorType: 'overloaded_error', errorMessage: 'Overloaded' });
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect([res.status, code(res)]).toEqual([503, 'EXECUTOR_FAILED']);
    expect(detail(res)).toContain('http 529 overloaded_error: Overloaded');
    expect(await kept()).toBe(before);
    expect(wire.live()).toEqual([]);
  });

  it('keeps a run the provider stopped at its time limit, naming the limit', async () => {
    const run = await runQuery();
    wire.next({ toolError: 'execution_time_exceeded' });
    const res = await compute({ language: 'python', script, inputs: [run.runId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      stopped: 'wallMs',
      frames: [],
      error: { name: 'execution_time_exceeded' },
    });
  });

  it('runs an Agent mode call in a fresh container it does not keep', async () => {
    const run = await runQuery();
    for (let i = 0; i < 2; i++) {
      const res = await compute({ language: 'python', script, inputs: [run.runId] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    expect(wire.messageBodies().map((b) => b.container)).toEqual([undefined, undefined]);
  });
});

describe('a chat turn container', () => {
  it('is reused within the conversation and never in another', async () => {
    const asked = async (conversationId: string, tokenId: string) => {
      const ctx = turn(conversationId, tokenId);
      const report = (await forgeReportTool(ctx).handler({
        projectId: w.projectId,
        queryId: 'progress-by-requirement',
      })) as { runId: string };
      const answer = (await forgeComputeTool(ctx).handler({
        projectId: w.projectId,
        language: 'python',
        script,
        inputs: [report.runId],
      })) as Body;
      expect(answer.computed).toBe(true);
    };
    const otherRoom = await openRoom('another question');
    await asked(roomId, 'turn-a');
    await asked(roomId, 'turn-b');
    await asked(otherRoom, 'turn-c');
    const sent = wire.messageBodies().map((b) => b.container);
    expect(sent[0]).toBeUndefined();
    expect(sent[1]).toMatch(/^container_/);
    expect(sent[2]).toBeUndefined();
  });
});

describe('a project the setting does not admit', () => {
  it('is refused without compute.thirdParty, and with compute.zdrOnly, before anything leaves', async () => {
    for (const [compute_, why] of [
      [{ enabled: true }, 'compute.thirdParty is unset'],
      [
        { enabled: true, thirdParty: true, zdrOnly: true },
        `${CODE_EXECUTOR_ID} is not ZDR-eligible`,
      ],
    ] as const) {
      const p = await world();
      const run = await runQuery(p.projectId, p.token);
      await seedProjectDocument(p.projectId, p.userId, {
        environments: {},
        extra: { compute: compute_ },
      });
      const res = await compute(
        { language: 'python', script, inputs: [run.runId] },
        p.token,
        p.projectId,
      );
      expect([res.status, code(res)]).toEqual([403, 'EXECUTION_NO_ADAPTER_ALLOWED']);
      expect(detail(res)).toContain(why);
    }
    expect(wire.calls).toEqual([]);
  });
});
