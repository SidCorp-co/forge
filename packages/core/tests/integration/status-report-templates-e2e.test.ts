import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { app } from '../../src/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A template run is kept in the project's report history beside the project status reads: saved by a
// person with the narrative they wrote, or stored by a schedule that names the template, whose
// narrative a model writes (status-report-narrative-e2e) and which, with no model configured here, is
// kept empty with the reason named. It exports as Markdown, is removed by its author or a project
// admin, and a share of it freezes the narrative as it was kept (REQ-32 criterion 8, B3).

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code ?? res.body.code;
const detail = (res: { body: Body }) => String(res.body.detail);

let w: World;
let author: { id: string; token: string };
let other: { id: string; token: string };

beforeAll(async () => {
  w = await world();
  const make = async () => {
    const u = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, u.id, 'member');
    return { id: u.id, token: await userToken(u.id) };
  };
  author = await make();
  other = await make();
}, 120_000);

const base = () => `/api/projects/${w.projectId}`;
const runProgress = async (token: string) => {
  const res = await api(token, 'POST', `${base()}/report-templates/progress/runs`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ((res.body.document as Body).runs as Body[]).map((r) => String(r.runId));
};
const save = (token: string, runIds: string[], narrative?: Body) =>
  api(token, 'POST', `${base()}/status/reports`, {
    templateId: 'progress',
    runIds,
    ...(narrative ? { narrative } : {}),
  });
const list = async () =>
  (await api(w.token, 'GET', `${base()}/status/reports`)).body.reports as Body[];

describe('saving a template run', () => {
  let reportId: string;

  it('saves it with the narrative, lists it beside the project status reads, and opens it as kept', async () => {
    const status = await api(w.token, 'POST', `${base()}/status/reports`, {});
    expect(status.status, JSON.stringify(status.body)).toBe(201);
    const runIds = await runProgress(author.token);
    const saved = await save(author.token, runIds, { summary: 'Work is under way.' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    reportId = String(saved.body.id);
    expect(saved.body).toMatchObject({
      days: null,
      template: { id: 'progress', version: 2, title: expect.any(String) },
      producer: { kind: 'person', user: { id: author.id } },
    });
    const history = await list();
    expect(history.map((r) => (r.template as Body | null)?.id ?? null).sort()).toEqual([
      null,
      'progress',
    ]);
    const opened = await api(w.token, 'GET', `${base()}/status/reports/${reportId}`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.status).toBeNull();
    const document = opened.body.document as Body;
    expect((document.narrative as Body).summary).toBe('Work is under way.');
    expect((document.runs as Body[]).map((r) => r.runId)).toEqual(runIds);
  });

  it('exports it as Markdown: the narrative, then the blocks as text, with unwritten slots named', async () => {
    const res = await api(w.token, 'GET', `${base()}/status/reports/${reportId}/export`);
    expect(res.status).toBe(200);
    const text = String(res.body.text ?? res.body);
    expect(text).toContain('## Summary\n\nWork is under way.');
    expect(text).toContain(
      '_Narrative not written: risks, recommendations (left empty when the report was saved)._',
    );
    expect(text).not.toContain('Summary written');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="progress-\d{4}-\d{2}-\d{2}\.md"$/,
    );
    const doc = (await api(w.token, 'GET', `${base()}/status/reports/${reportId}`)).body
      .document as Body;
    const { blockToText, UTC_READING } = await import('@forge/contracts/visual-blocks');
    for (const block of doc.blocks as Body[]) {
      expect(text).toContain(blockToText(block as never, UTC_READING));
    }
  });

  it('states every date of the Markdown export, and of the run text, in UTC and never as raw ISO (REQ-32 BC-17)', async () => {
    const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const res = await api(w.token, 'GET', `${base()}/status/reports/${reportId}/export`);
    const text = String(res.body.text ?? res.body);
    expect(text).not.toMatch(ISO);
    expect(text).toMatch(/_As of [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC_/);
    expect(text).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC/);
    const run = await api(author.token, 'POST', `${base()}/report-templates/progress/runs`, {});
    const runText = String((run.body as Body).text ?? '');
    expect(runText).not.toMatch(ISO);
  });

  it('exports one table block as CSV: the BOM, a heading row of its labels, CRLF records', async () => {
    // the bytes as sent: a text decoder drops the byte order mark this asserts
    const res = await app.fetch(
      new Request(
        `http://forge.test${base()}/status/reports/${reportId}/export?format=csv&block=3`,
        {
          headers: { authorization: `Bearer ${w.token}` },
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="progress-\d{4}-\d{2}-\d{2}-block-4\.csv"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1);
    const doc = (await api(w.token, 'GET', `${base()}/status/reports/${reportId}`)).body
      .document as Body;
    const block = (doc.blocks as Body[])[3] as { columns: string[]; frame: { fields: Body[] } };
    // a number column's heading carries its unit, since its cells carry none
    const labels = block.columns.map((c) => {
      const f = block.frame.fields.find((x) => x.name === c) as Body;
      return f.unit && f.type === 'number' ? `${f.label} (${f.unit})` : String(f.label);
    });
    expect(text.split('\r\n')[0]).toBe(labels.join(','));
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('refuses a CSV export of no table, of a block that is not one, and of a block that is not there, by name', async () => {
    const at = (query: string) =>
      api(w.token, 'GET', `${base()}/status/reports/${reportId}/export?${query}`);
    const none = await at('format=csv');
    expect(code(none)).toBe('STATUS_REPORT_REFUSED');
    expect(detail(none)).toContain("this report's table blocks are 3, 4");
    const chart = await at('format=csv&block=1');
    expect(code(chart)).toBe('STATUS_REPORT_REFUSED');
    expect(detail(chart)).toContain('block 1 is a chart, not a table');
    const missing = await at('format=csv&block=9');
    expect(detail(missing)).toContain('block 9 is not in this report, which holds 5 block(s)');
    const markdownBlock = await at('block=2');
    expect(detail(markdownBlock)).toContain('only ?format=csv exports');
    const unknown = await at('format=xlsx');
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain('?format=csv&block=<index of a table block');
  });

  it('refuses a narrative that states a figure no run returned, and keeps nothing', async () => {
    const before = (await list()).length;
    const res = await save(author.token, await runProgress(author.token), {
      summary: 'There are 98765 requirements.',
    });
    expect(code(res)).toBe('REPORT_NARRATIVE_REFUSED');
    expect(detail(res)).toContain('states 98765');
    expect((await list()).length).toBe(before);
  });

  it('refuses a project status export, by name', async () => {
    const status = (await list()).find((r) => r.template === null) as Body;
    const res = await api(w.token, 'GET', `${base()}/status/reports/${status.id}/export`);
    expect(code(res)).toBe('STATUS_REPORT_REFUSED');
  });

  it('refuses a person who may not write', async () => {
    const reader = await createTestUser({ verified: true });
    const res = await save(await userToken(reader.id), await runProgress(w.token));
    expect(res.status).toBe(403);
  });
});

// QA of ISS-422 on dev.185: asked to save a template report, the Assistant said it had and saved
// nothing, because it had no act that saves one. forge_template_save is that act, over the same
// service as the route above
describe("the Assistant's forge_template_save", () => {
  const chat = (userId: string) =>
    ({
      principal: {
        kind: 'pat',
        agency: 'human',
        agentUserId: null,
        userId,
        tokenId: 'chat-turn',
        scopes: [],
        projectIds: null,
        boundProjectId: null,
        permissions: ['*'],
      },
      projectSlug: null,
      turn: { conversationId: 'c-1', speakerUserId: userId, handleUserId: null },
    }) as never;
  const saveInChat = async (userId: string, runIds: string[], narrative?: Body) => {
    const { forgeTemplateSaveTool } = await import('../../src/status-reports/tool.js');
    return forgeTemplateSaveTool(chat(userId)).handler({
      projectId: w.projectId,
      templateId: 'progress',
      runIds,
      ...(narrative ? { narrative } : {}),
    }) as Promise<Body>;
  };

  it('keeps the run in the report history as the person who asked, with its narrative', async () => {
    const before = (await list()).length;
    const runIds = await runProgress(author.token);
    const saved = await saveInChat(author.id, runIds, { summary: 'Work is under way.' });
    expect(saved).toMatchObject({
      template: { id: 'progress' },
      producer: { kind: 'person', user: { id: author.id } },
    });
    expect((await list()).length).toBe(before + 1);
    const opened = await api(w.token, 'GET', `${base()}/status/reports/${saved.id}`);
    expect(((opened.body.document as Body).narrative as Body).summary).toBe('Work is under way.');
  });

  it('refuses a narrative figure no block shows, and a person who may not write, keeping nothing', async () => {
    const before = (await list()).length;
    const runIds = await runProgress(author.token);
    const invented = await saveInChat(author.id, runIds, {
      summary: 'There are 98765 requirements.',
    }).catch((e: unknown) => e);
    expect(String((invented as Error).message)).toContain('states 98765');
    const reader = await createTestUser({ verified: true });
    const refused = await saveInChat(reader.id, runIds).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((await list()).length).toBe(before);
  });
});

describe('removing a saved template report', () => {
  const remove = (token: string, id: string) =>
    api(token, 'DELETE', `${base()}/status/reports/${id}`);

  it('refuses a member who is neither its author nor a project admin, by name, and keeps it', async () => {
    const saved = await save(author.token, await runProgress(author.token));
    const id = String(saved.body.id);
    const res = await remove(other.token, id);
    expect([res.status, code(res)]).toEqual([403, 'STATUS_REPORT_DELETE_FORBIDDEN']);
    expect((await list()).map((r) => r.id)).toContain(id);
  });

  it('lets its author, and a project admin, remove it', async () => {
    const mine = String((await save(author.token, await runProgress(author.token))).body.id);
    expect((await remove(author.token, mine)).status).toBe(200);
    const theirs = String((await save(author.token, await runProgress(author.token))).body.id);
    expect((await remove(w.token, theirs)).status).toBe(200);
    expect((await list()).map((r) => r.id)).not.toContain(theirs);
  });
});

describe('a schedule that names a template', () => {
  const schedule = (params: Body) =>
    api(w.token, 'POST', '/api/schedules', {
      projectId: w.projectId,
      name: 'Weekly progress',
      cron: '0 9 * * 1',
      kind: 'status_report',
      timeZone: 'UTC',
      params,
    });

  it('refuses an unknown template, a param it does not take, and a window beside a template, by name', async () => {
    const unknown = await schedule({ recipients: [w.userId], templateId: 'weekly' });
    expect([unknown.status, code(unknown)]).toEqual([422, 'STATUS_REPORT_REFUSED']);
    expect(detail(unknown)).toContain('no report template "weekly"');
    const param = await schedule({
      recipients: [w.userId],
      templateId: 'progress',
      templateParams: { stat: 'active' },
    });
    expect(detail(param)).toContain('takes no param "stat"');
    const days = await schedule({ recipients: [w.userId], templateId: 'progress', days: 7 });
    expect(detail(days)).toContain('not days');
  });

  it('stores a template report for its owner on each fire; with no model configured the slots stay empty and the notice says why', async () => {
    const created = await schedule({ recipients: [w.userId, author.id], templateId: 'progress' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const fired = await api(w.token, 'POST', `/api/schedules/${created.body.id}/run`);
    expect(fired.status, JSON.stringify(fired.body)).toBe(202);
    const stored = (await list()).filter(
      (r) => (r.producer as Body).kind === 'schedule' && r.template !== null,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      template: { id: 'progress' },
      producer: { kind: 'schedule', user: { id: w.userId }, schedule: { id: created.body.id } },
    });
    const opened = await api(w.token, 'GET', `${base()}/status/reports/${stored[0]?.id}`);
    expect((opened.body.document as Body).narrative).toEqual({
      summary: '',
      risks: '',
      recommendations: '',
    });
    const told = await db.execute<{ body: string }>(sql`
      SELECT body FROM notifications WHERE status_report_id = ${String(stored[0]?.id)}
    `);
    expect([...told].length).toBeGreaterThan(0);
    expect(opened.body.narrative).toEqual({
      path: 'not_written',
      reason: 'no chat model is configured on this instance',
      model: null,
      calls: 0,
    });
    for (const n of told)
      expect(n.body).toContain(
        'Summary not written: no chat model is configured on this instance.',
      );
    // a period is stored once: the same slot again is refused by name and stores nothing
    const again = await api(w.token, 'POST', `/api/schedules/${created.body.id}/run`);
    expect(again.status).toBe(409);
    expect(
      (await list()).filter((r) => (r.producer as Body).kind === 'schedule' && r.template !== null),
    ).toHaveLength(1);
  });
});

describe('sharing a saved template report', () => {
  it('freezes the narrative that was kept, and refuses a project status read by name', async () => {
    const saved = await save(author.token, await runProgress(author.token), {
      summary: 'Work is under way.',
      risks: 'None are known.',
    });
    const id = String(saved.body.id);
    const created = await api(w.token, 'POST', `${base()}/shares`, {
      subjectKind: 'status-report',
      subjectId: id,
      audience: 'members',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const url = String(created.body.url);
    const opened = await api(other.token, 'POST', '/api/shares/open/member', {
      token: url.slice(url.indexOf('/s/') + 3),
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect((opened.body.document as Body).narrative).toEqual({
      summary: 'Work is under way.',
      risks: 'None are known.',
      recommendations: '',
    });
    const status = (await list()).find((r) => r.template === null) as Body;
    const refused = await api(w.token, 'POST', `${base()}/shares`, {
      subjectKind: 'status-report',
      subjectId: String(status.id),
      audience: 'members',
    });
    expect([refused.status, code(refused)]).toEqual([422, 'SHARE_SUBJECT_UNSUPPORTED']);
    const gone = await api(w.token, 'POST', `${base()}/shares`, {
      subjectKind: 'status-report',
      subjectId: 'not-a-report',
      audience: 'members',
    });
    expect([gone.status, code(gone)]).toEqual([404, 'SHARE_SUBJECT_NOT_FOUND']);
  });
});
