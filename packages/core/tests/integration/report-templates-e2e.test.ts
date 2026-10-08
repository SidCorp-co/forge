import { beforeAll, describe, expect, it } from 'vitest';
import { api, type Body, userToken } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A report template runs its queries as the asker and keeps each run; its narrative may cite only
// those runs; its output is shared frozen, every run read again as the person sharing (REQ-32, A7).

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const detail = (res: { body: Body }) => String(res.body.detail);

let w: World;
let member: { id: string; token: string };

beforeAll(async () => {
  w = await world();
  const user = await createTestUser({ verified: true });
  await addProjectMember(w.projectId, user.id, 'member');
  member = { id: user.id, token: await userToken(user.id) };
}, 120_000);

const readRun = (runId: string, token = w.token) =>
  api(token, 'GET', `/api/projects/${w.projectId}/report-runs/${runId}`);

describe('a template run', () => {
  const runTemplate = (templateId: string, params?: Body, token = w.token) =>
    api(token, 'POST', `/api/projects/${w.projectId}/report-templates/${templateId}/runs`, {
      params,
    });
  const share = (token: string, subjectId: string) =>
    api(token, 'POST', `/api/projects/${w.projectId}/shares`, {
      subjectKind: 'template-output',
      subjectId,
      audience: 'members',
    });
  const subjectOf = (res: { body: Body }, templateId: string) =>
    `${templateId}:${((res.body.document as Body).runs as Body[]).map((r) => r.runId).join(',')}`;

  it('lists the templates, and runs progress as the asker, keeping a run per query', async () => {
    const list = await api(w.token, 'GET', `/api/projects/${w.projectId}/report-templates`);
    expect((list.body.templates as Body[]).map((t) => t.id)).toEqual([
      'progress',
      'release',
      'roadmap',
    ]);
    const res = await runTemplate('progress');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const document = res.body.document as Body;
    const runs = document.runs as Body[];
    expect(runs.map((r) => r.queryId)).toEqual(['progress-by-requirement', 'criteria-coverage']);
    expect((res.body.slots as Body[]).map((s) => s.slot)).toEqual([
      'summary',
      'risks',
      'recommendations',
    ]);
    for (const run of runs) expect((await readRun(String(run.runId))).status).toBe(200);
    expect(((document.blocks as Body[]) ?? []).length + (res.body.notDrawn as Body[]).length).toBe(
      4,
    );
  });

  it('refuses an unknown template and an undeclared param, by name', async () => {
    const none = await runTemplate('weekly');
    expect([none.status, code(none)]).toEqual([404, 'REPORT_TEMPLATE_NOT_FOUND']);
    const param = await runTemplate('progress', { stat: 'active' });
    expect(code(param)).toBe('REPORT_TEMPLATE_PARAM_REFUSED');
    expect(detail(param)).toContain('takes no param "stat"');
  });

  it('checks a narrative against the template own runs and refuses a figure none returned', async () => {
    const res = await runTemplate('progress');
    const runIds = ((res.body.document as Body).runs as Body[]).map((r) => r.runId);
    const narrative = (text: string, ids = runIds) =>
      api(w.token, 'POST', `/api/projects/${w.projectId}/report-templates/progress/narrative`, {
        runIds: ids,
        narrative: { summary: text },
      });
    const ok = await narrative('Work is under way.');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body.narrative as Body).summary).toBe('Work is under way.');
    const typed = await narrative('There are 98765 requirements.');
    expect(code(typed)).toBe('REPORT_NARRATIVE_REFUSED');
    expect(detail(typed)).toContain('states 98765');
    const foreign = await narrative('Fine.', [String(runIds[1]), String(runIds[0])]);
    expect(code(foreign)).toBe('REPORT_TEMPLATE_RUNS_MISMATCH');
  });

  it('shares a template output frozen from its runs, re-read as the creator', async () => {
    const res = await runTemplate('progress');
    const subject = subjectOf(res, 'progress');
    const created = await share(w.token, subject);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const url = String(created.body.url);
    const token = url.slice(url.indexOf('/s/') + 3);
    const opened = await api(member.token, 'POST', '/api/shares/open/member', { token });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const document = opened.body.document as Body;
    expect(document).toMatchObject({ templateId: 'progress', version: 1 });
    expect((document.runs as Body[]).map((r) => r.runId)).toEqual(
      ((res.body.document as Body).runs as Body[]).map((r) => r.runId),
    );
    expect(document.blocks).toEqual((res.body.document as Body).blocks);
  });

  it('refuses a share of runs another member made, and an id that is no template output', async () => {
    const res = await runTemplate('progress');
    const theirs = await share(member.token, subjectOf(res, 'progress'));
    expect([theirs.status, code(theirs)]).toEqual([403, 'REPORT_RUN_READ_FORBIDDEN']);
    const junk = await share(w.token, 'progress');
    expect([junk.status, code(junk)]).toEqual([404, 'SHARE_SUBJECT_NOT_FOUND']);
    const unknown = await share(w.token, 'weekly:abc');
    expect([unknown.status, code(unknown)]).toEqual([404, 'SHARE_SUBJECT_NOT_FOUND']);
  });
});
