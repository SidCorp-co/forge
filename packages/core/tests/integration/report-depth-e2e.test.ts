import { randomUUID } from 'node:crypto';
import { checkBlock, VISUAL_BLOCK_VERSION } from '@forge/contracts/visual-blocks';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { register } from '../../src/integrations/llm/registry.js';
import type { ChatMessage, ChatStreamEvent } from '../../src/integrations/llm/types.js';
import type { McpContext } from '../../src/lib/tool.js';
import { forgeReportTool, forgeTemplateTool } from '../../src/reports/tool.js';
import { api, type Body } from '../helpers/api.js';
import { DAY, issue, moved, requirement, type World, world } from '../helpers/forecast-world.js';

// REQ-32 r8, the three criteria QA failed on dev.213 (lane report-depth). BC-3: a line and a burndown
// chart are drawn from registered report queries, run through the same doors as every other query,
// not refused for want of a report. BC-7: a template run by name carries its summary, risks and
// recommendations whichever door ran it, the REST route the status page calls and the chat's
// forge_template alike. BC-15: the progress template reads a chosen period against the one before
// (work closed, filed, verified, sent back, linked and proven, hours per status) and each block
// carries a one-line finding held to its own figures. The model is faked at the provider seam.

const asked: ChatMessage[][] = [];
let answers: string[] = [];

register('anthropic', () => ({
  id: 'scripted',
  defaultModel: 'scripted-model',
  async *stream(req): AsyncIterable<ChatStreamEvent> {
    asked.push(req.messages);
    yield { type: 'chunk', text: answers.shift() ?? '' };
    yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 20 } };
    yield { type: 'done' };
  },
}));

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let w: World;
let req: { id: string; key: string };
const ids: Record<string, string> = {};

/**
 * The seeded week, read with a 7-day period: A closed in the period before; B (REQ-1) and C closed
 * in this one, C was sent back after; D is open; E was dropped.
 */
beforeAll(async () => {
  w = await world();
  req = await requirement(w, 'Reports read work over time');
  const a = await issue(w, {
    status: 'closed',
    createdAt: ago(10),
    mergedAt: ago(8.5),
    requirementId: req.id,
  });
  await moved(w, a.id, 'open', 'in_progress', ago(9));
  await moved(w, a.id, 'in_progress', 'awaiting_release', ago(8.5));
  await moved(w, a.id, 'awaiting_release', 'closed', ago(8));
  const b = await issue(w, {
    status: 'closed',
    createdAt: ago(5),
    mergedAt: ago(3),
    requirementId: req.id,
  });
  await moved(w, b.id, 'open', 'in_progress', ago(4));
  await moved(w, b.id, 'in_progress', 'awaiting_release', ago(3));
  await moved(w, b.id, 'awaiting_release', 'closed', ago(1.5));
  const c = await issue(w, { status: 'reopen', createdAt: ago(4) });
  await moved(w, c.id, 'open', 'in_progress', ago(3.5));
  await moved(w, c.id, 'in_progress', 'awaiting_release', ago(3));
  await moved(w, c.id, 'awaiting_release', 'closed', ago(0.8));
  await moved(w, c.id, 'closed', 'reopen', ago(0.5));
  const d = await issue(w, { status: 'open', createdAt: ago(2) });
  const e = await issue(w, { status: 'dropped', createdAt: ago(3) });
  await moved(w, e.id, 'open', 'dropped', ago(1));
  Object.assign(ids, { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id });
}, 120_000);

beforeEach(() => {
  asked.length = 0;
  answers = [];
});

const runQuery = (queryId: string, params?: Body) =>
  api(w.token, 'POST', `/api/projects/${w.projectId}/report-queries/${queryId}/runs`, { params });

const chat = () => ({ principal: { userId: w.userId, agency: 'human' } }) as unknown as McpContext;

const sum = (rows: Body[], field: string) => rows.reduce((n, r) => n + Number(r[field]), 0);

describe('BC-3: a line chart and a burndown chart are drawn from registered reports', () => {
  it('issue-flow answers one row per day with what was filed, verified, closed and sent back, and draws as a line', async () => {
    const res = await runQuery('issue-flow', { bucket: 'day', periods: 7 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const frame = res.body.frame as { rows: Body[] };
    expect(frame.rows).toHaveLength(7);
    expect(sum(frame.rows, 'created')).toBe(4);
    expect(sum(frame.rows, 'verified')).toBe(2);
    expect(sum(frame.rows, 'closed')).toBe(2);
    expect(sum(frame.rows, 'sentBack')).toBe(1);
    expect(frame.rows.at(-1)?.open).toBe(2);
    const line = checkBlock({
      v: VISUAL_BLOCK_VERSION,
      kind: 'chart',
      variant: 'line',
      x: 'start',
      y: ['closed'],
      source: { runId: res.body.runId },
      frame: res.body.frame,
    });
    expect(line.ok, JSON.stringify(line)).toBe(true);
  });

  it('burndown answers what was left of a requirement day by day, and draws as a burndown', async () => {
    const res = await runQuery('burndown', { requirement: req.key, days: 14 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = (res.body.frame as { rows: Body[] }).rows;
    expect(rows).toHaveLength(14);
    expect(rows[0]).toMatchObject({ remaining: 0, done: 0, scope: 0 });
    expect(rows.at(-1)).toMatchObject({ remaining: 0, done: 2, scope: 2 });
    expect(rows.some((r) => Number(r.remaining) > 0)).toBe(true);
    const chart = checkBlock({
      v: VISUAL_BLOCK_VERSION,
      kind: 'chart',
      variant: 'burndown',
      x: 'day',
      y: ['remaining'],
      source: { runId: res.body.runId },
      frame: res.body.frame,
    });
    expect(chart.ok, JSON.stringify(chart)).toBe(true);
  });

  it("burndown of a release reads the release run's roster; the project's leaves out what was dropped", async () => {
    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
      VALUES (${randomUUID()}, ${w.projectId}, 'system', 'running', now(), '0.9.0',
              ${JSON.stringify({ source: 'release-batch', issueIds: [ids.b, ids.c] })}::jsonb)
    `);
    const release = await runQuery('burndown', { release: '0.9.0', days: 3 });
    expect(release.status, JSON.stringify(release.body)).toBe(200);
    expect((release.body.frame as { rows: Body[] }).rows.at(-1)).toMatchObject({
      remaining: 1,
      done: 1,
      scope: 2,
    });
    const project = await runQuery('burndown', { days: 3 });
    expect((project.body.frame as { rows: Body[] }).rows.at(-1)).toMatchObject({
      remaining: 2,
      done: 2,
      scope: 4,
    });
  });

  it('refuses two scopes at once, and a requirement or release the project does not hold, by name', async () => {
    const both = await runQuery('burndown', { requirement: req.key, release: '0.9.0' });
    expect([both.status, code(both)]).toEqual([400, 'REPORT_PARAMS_REFUSED']);
    expect(String(both.body.detail)).toContain('name one, or neither');
    const none = await runQuery('burndown', { requirement: 'REQ-999' });
    expect([none.status, code(none)]).toEqual([400, 'REPORT_PARAMS_REFUSED']);
    expect(String(none.body.detail)).toContain('holds no requirement REQ-999');
    const unknown = await runQuery('burndown', { release: '9.9.9' });
    expect(String(unknown.body.detail)).toContain('no release of project');
  });

  it("the chat's forge_report runs both, as it runs any registered query", async () => {
    const tool = forgeReportTool(chat());
    expect(tool.description).toContain('issue-flow');
    expect(tool.description).toContain('burndown');
    const run = (await tool.handler({
      projectId: w.projectId,
      queryId: 'burndown',
      params: { requirement: req.key, days: 7 },
    })) as Body;
    expect(run.queryId).toBe('burndown');
    expect((run.frame as { rows: Body[] }).rows).toHaveLength(7);
  });
});

/** A clean narrative for the progress template's five blocks, every figure one its block shows. */
const PROGRESS_NARRATIVE = {
  summary: 'Closed work rose by 1 on the period before.',
  risks: 'Work was sent back after it closed.',
  recommendations: 'Find why the closed work came back before closing more.',
  findings: [
    'Closed rose by 1, and 1 issue was sent back.',
    'Filing ran ahead of closing on most days.',
    'In progress held the most hours.',
    'REQ-1 is the only requirement whose work closed.',
    'REQ-1 is still a draft, so it has no forecast.',
  ],
};
const { findings: FINDINGS, ...SLOTS } = PROGRESS_NARRATIVE;

describe('BC-7: a template run by name carries its summary, risks and recommendations at every door', () => {
  it('the REST door the status page calls answers the written narrative and a finding per block', async () => {
    answers = [JSON.stringify(PROGRESS_NARRATIVE)];
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-templates/progress/runs`,
      { params: { days: 7 } },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.narrative).toEqual({
      path: 'written',
      reason: null,
      model: 'scripted-model',
      calls: 1,
    });
    const document = res.body.document as Body;
    expect(document.narrative).toEqual(SLOTS);
    expect((document.blocks as Body[]).map((b) => b.finding)).toEqual(FINDINGS);
    expect(String(res.body.text)).toContain(`Summary: ${SLOTS.summary}`);
  });

  it('any template, run with no params, answers its narrative written: the release template too', async () => {
    const release = {
      summary: 'A release is on its way.',
      risks: 'Nothing in these rows holds it back.',
      recommendations: 'Ship the release in flight.',
      findings: [
        'No issue is left to do.',
        'Nothing shipped in the window.',
        'One stage.',
        'REQ-1 waits.',
      ],
    };
    answers = [JSON.stringify(release)];
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-templates/release/runs`,
      {},
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.document as Body).narrative).toEqual({
      summary: release.summary,
      risks: release.risks,
      recommendations: release.recommendations,
    });
    expect(res.body.narrative).toMatchObject({ path: 'written', calls: 1 });
  });

  it("the chat's forge_template answers the same narrative, written once, without the chat writing it", async () => {
    answers = [JSON.stringify(PROGRESS_NARRATIVE)];
    const out = (await forgeTemplateTool(chat()).handler({
      projectId: w.projectId,
      templateId: 'progress',
      params: { days: 7 },
    })) as Body;
    expect((out.narrative as Body).path).toBe('written');
    expect((out.document as Body).narrative).toEqual(SLOTS);
    expect(((out.document as Body).blocks as Body[]).map((b) => b.finding)).toEqual(FINDINGS);
    expect(asked).toHaveLength(1);
  });

  it('a kept report saved from the run keeps its narrative and findings, and exports them', async () => {
    answers = [JSON.stringify(PROGRESS_NARRATIVE)];
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-templates/progress/runs`,
      { params: { days: 7 } },
    );
    const document = res.body.document as Body;
    const saved = await api(w.token, 'POST', `/api/projects/${w.projectId}/status/reports`, {
      templateId: 'progress',
      runIds: (document.runs as Body[]).map((r) => r.runId),
      narrative: document.narrative,
      findings: (document.blocks as Body[]).map((b) => b.finding),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const kept = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/status/reports/${saved.body.id}`,
    );
    const keptDocument = kept.body.document as Body;
    expect(keptDocument.narrative).toEqual(SLOTS);
    expect((keptDocument.blocks as Body[]).map((b) => b.finding)).toEqual(FINDINGS);
    const exported = await api(
      w.token,
      'GET',
      `/api/projects/${w.projectId}/status/reports/${saved.body.id}/export`,
    );
    expect(String(exported.body.text)).toContain(SLOTS.risks);
    expect(String(exported.body.text)).toContain(FINDINGS[2]);
    expect(String(exported.body.text)).not.toContain('Narrative not written');
  });
});

describe('BC-15: the progress report reads a chosen period against the one before', () => {
  const progress = async (days: number) => {
    answers = [JSON.stringify(PROGRESS_NARRATIVE)];
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-templates/progress/runs`,
      { params: { days } },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };

  it('shows work closed, filed, verified, sent back, linked and proven, each against the period before', async () => {
    const body = await progress(7);
    const document = body.document as Body;
    expect((document.runs as Body[]).map((r) => r.queryId)).toEqual([
      'period-flow',
      'issue-flow',
      'status-time',
      'closed-by-requirement',
      'progress-by-requirement',
    ]);
    expect(document.params).toEqual({ days: 7 });
    const [kpi, line, bar, table, roadmap] = document.blocks as [Body, Body, Body, Body, Body];
    const period = ((kpi.frame as Body).rows as Body[])[0];
    expect(period).toMatchObject({
      closed: 2,
      closedPrevious: 1,
      closedChange: 1,
      created: 4,
      createdPrevious: 1,
      verified: 2,
      verifiedPrevious: 1,
      sentBack: 1,
      sentBackPrevious: 0,
      closedLinked: 1,
      closedLinkedPrevious: 1,
      closedProven: 0,
    });
    expect([line.variant, ((line.frame as Body).rows as Body[]).length]).toEqual(['line', 7]);
    const hours = (bar.frame as Body).rows as Body[];
    const inProgress = hours.find((r) => r.status === 'in_progress');
    // B held in_progress for 1 day, C for 0.5 day, both inside the period; A's day was before it
    expect(inProgress).toMatchObject({ hours: 36, previousHours: 12, change: 24 });
    expect(hours.some((r) => r.status === 'closed' || r.status === 'dropped')).toBe(false);
    expect((table.frame as Body).rows).toEqual([
      {
        requirement: req.key,
        title: 'Reports read work over time',
        closed: 1,
        previousClosed: 1,
        proven: 0,
        sentBack: 0,
      },
      {
        requirement: null,
        title: 'No requirement',
        closed: 1,
        previousClosed: 0,
        proven: 0,
        sentBack: 1,
      },
    ]);
    // REQ-33 BC-3: where each requirement stands on the roadmap is still read in the progress report
    expect(roadmap.columns).toEqual(['key', 'title', 'lane', 'p50At', 'p85At', 'basis']);
  });

  it('a shorter period counts only its own days', async () => {
    const body = await progress(1);
    const kpi = ((body.document as Body).blocks as Body[])[0] as Body;
    const period = ((kpi.frame as Body).rows as Body[])[0];
    expect(period).toMatchObject({ closed: 1, closedPrevious: 1, sentBack: 1, created: 0 });
  });

  it('refuses a finding that states a number its own block does not show, and the one retry keeps a clean one', async () => {
    const stray = {
      ...PROGRESS_NARRATIVE,
      findings: [
        'Closed rose by 1.',
        'Filing ran ahead.',
        'In progress held 98765 hours.',
        'Fine.',
        'Fine.',
      ],
    };
    answers = [JSON.stringify(stray), JSON.stringify(PROGRESS_NARRATIVE)];
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-templates/progress/runs`,
      { params: { days: 7 } },
    );
    expect((res.body.narrative as Body).path).toBe('retried');
    expect(String(asked[1]?.at(-1)?.content)).toContain(
      'finding 3 (chart "Hours spent in each status") states 98765',
    );
    expect(((res.body.document as Body).blocks as Body[]).map((b) => b.finding)).toEqual(FINDINGS);
  });

  it('refuses an answer with no finding per block, and names how many it gave', async () => {
    answers = [JSON.stringify(SLOTS), JSON.stringify(SLOTS)];
    const res = await api(
      w.token,
      'POST',
      `/api/projects/${w.projectId}/report-templates/progress/runs`,
      { params: { days: 7 } },
    );
    expect(res.body.narrative).toMatchObject({ path: 'not_written', calls: 2 });
    expect(String((res.body.narrative as Body).reason)).toContain(
      '"findings" holds 0 finding(s), and the report draws 5 block(s)',
    );
  });
});
