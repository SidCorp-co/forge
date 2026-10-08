import { ReportRunSchema } from '@forge/contracts/report-queries';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { sweepExpiredReportRuns } from '../../src/reports/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A run is kept with its provenance for 30 days and read back only by its asker; a block drawn from
// it is posted into the room with the run's frame and the run's query and read time, and a figure the
// run never read is refused by name (REQ-32, lane A4).

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const detail = (res: { body: Body }) => String(res.body.detail);

describe('report runs and the blocks drawn from them', () => {
  let w: World;
  let member: { id: string; token: string };
  let roomId: string;

  const runQuery = async (token = w.token) => {
    const res = await api(
      token,
      'POST',
      `/api/projects/${w.projectId}/report-queries/progress-by-requirement/runs`,
      {},
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ReportRunSchema.parse(res.body);
  };
  const readRun = (runId: string, token = w.token) =>
    api(token, 'GET', `/api/projects/${w.projectId}/report-runs/${runId}`);
  const show = (block: Body, token = w.token) =>
    api(token, 'POST', `/api/conversations/${roomId}/blocks`, { projectId: w.projectId, block });
  const messages = async () =>
    ((await api(w.token, 'GET', `/api/conversations/${roomId}`)).body.messages as Body[]) ?? [];

  beforeAll(async () => {
    w = await world();
    const user = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, user.id, 'member');
    member = { id: user.id, token: await userToken(user.id) };
    const opened = await api(w.token, 'POST', '/api/conversations', {
      projectId: w.projectId,
      title: 'where it stands',
      people: [member.id],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    roomId = String(opened.body.id);
  }, 120_000);

  it('keeps every run and reads it back to its asker with the query, params and read time', async () => {
    const run = await runQuery();
    const res = await readRun(run.runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ReportRunSchema.parse(res.body)).toEqual(run);
  });

  it('refuses the run to another member of the project, by name', async () => {
    const run = await runQuery();
    const res = await readRun(run.runId, member.token);
    expect([res.status, code(res)]).toEqual([403, 'REPORT_RUN_READ_FORBIDDEN']);
    expect(detail(res)).toContain('only the person it was read as may read or show it');
  });

  it('reads a run older than 30 days as gone, by name, and the sweep then deletes it', async () => {
    const run = await runQuery();
    await db.execute(sql`
      UPDATE report_runs SET as_of = now() - interval '31 days', expires_at = now() - interval '1 day'
      WHERE id = ${run.runId}
    `);
    const res = await readRun(run.runId);
    expect([res.status, code(res)]).toEqual([404, 'REPORT_RUN_EXPIRED']);
    expect(detail(res)).toMatch(/is gone: a run is kept 30 days and this one expired at /);
    expect((await sweepExpiredReportRuns()).reportRuns).toBeGreaterThanOrEqual(1);
    const swept = await readRun(run.runId);
    expect([swept.status, code(swept)]).toEqual([404, 'REPORT_RUN_NOT_FOUND']);
    expect(detail(swept)).toContain('passed its 30-day keep and was swept');
  });

  it('posts a block of the run into the room, holding its frame and its query and read time', async () => {
    const run = await runQuery();
    const res = await show({ kind: 'table', columns: ['key'], source: { runId: run.runId } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const posted = (await messages()).find((m) => m.id === res.body.messageId) as Body;
    expect(posted.role).toBe('assistant');
    expect(posted.blocks).toEqual([
      {
        type: 'visual',
        visual: {
          v: 1,
          kind: 'table',
          columns: ['key'],
          source: { runId: run.runId },
          frame: run.frame,
        },
        run: { runId: run.runId, queryId: 'progress-by-requirement', version: 1, asOf: run.asOf },
      },
    ]);
  });

  it('refuses a block holding a figure its run never read, and posts nothing', async () => {
    const run = await runQuery();
    const before = (await messages()).length;
    const frame = {
      fields: [...run.frame.fields, { name: 'velocity', type: 'number', label: 'Velocity' }],
      rows: run.frame.rows.map((r) => ({ ...r, velocity: 12 })),
    };
    const res = await show({
      kind: 'table',
      columns: ['key'],
      source: { runId: run.runId },
      frame,
    });
    expect([res.status, code(res)]).toEqual([422, 'REPORT_BLOCK_FIGURE_NOT_IN_RUN']);
    expect(detail(res)).toContain('field "velocity" is not one run');
    expect((await messages()).length).toBe(before);
  });

  it('refuses a block of a run the poster may not read, and posts nothing', async () => {
    const run = await runQuery();
    const before = (await messages()).length;
    const res = await show(
      { kind: 'table', columns: ['key'], source: { runId: run.runId } },
      member.token,
    );
    expect([res.status, code(res)]).toEqual([403, 'REPORT_RUN_READ_FORBIDDEN']);
    expect((await messages()).length).toBe(before);
  });
});
