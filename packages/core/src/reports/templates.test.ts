import type { ReportFrame, ReportRun } from '@forge/contracts/report-queries';
import { BUILTIN_REPORT_TEMPLATES } from '@forge/contracts/report-template-builtins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import { registerReportQueries } from '../report-queries/register.js';
import { getReportQuery, listReportQueries } from '../report-queries/registry.js';

// A template is data; running it runs its queries as the asker, draws its layout over their frames and
// leaves the words to the model. A narrative may cite only the figures of the template's own runs.

const runReport = vi.fn();
const readReportRun = vi.fn();
vi.mock('./runs.js', async (original) => ({
  ...(await original<typeof import('./runs.js')>()),
  runReport: (...args: unknown[]) => runReport(...args),
  readReportRun: (...args: unknown[]) => readReportRun(...args),
}));

const { provideReportsPorts } = await import('./ports.js');
const { checkTemplateNarrative, documentOf, listReportTemplates, runTemplate, templateNamed } =
  await import('./templates.js');

registerReportQueries();
provideReportsPorts({
  runQuery: () => Promise.reject(new Error('not run here')),
  describeQuery: (id) => getReportQuery(id).descriptor,
  listQueries: () => listReportQueries().map((q) => q.descriptor),
  roomOf: () => Promise.reject(new Error('not read here')),
  messageOf: () => Promise.reject(new Error('not read here')),
  postAnswer: () => Promise.reject(new Error('not posted here')),
});

const CELL = {
  number: 7,
  string: 'text',
  ref: 'REQ-12',
  status: 'open',
  date: '2026-10-08',
} as const;
const frameOf = (queryId: string, rows: number): ReportFrame => {
  const fields = getReportQuery(queryId).descriptor.output;
  return {
    fields: [...fields],
    rows: Array.from({ length: rows }, () =>
      Object.fromEntries(fields.map((f) => [f.name, CELL[f.type as keyof typeof CELL] ?? null])),
    ),
  };
};
let seq = 0;
let empty = new Set<string>();
const runOf = (queryId: string, params: unknown = {}): ReportRun => ({
  runId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  queryId,
  version: 1,
  params: params as Record<string, unknown>,
  projectId: 'p1',
  actor: { kind: 'human', id: 'asker' },
  asOf: '2026-10-08T09:30:00.000Z',
  frame: frameOf(queryId, empty.has(queryId) ? 0 : 3),
});
const asker = { userId: 'asker', agency: 'human', access: {} } as never;
const stored = new Map<string, ReportRun>();

beforeEach(() => {
  seq = 0;
  empty = new Set();
  stored.clear();
  runReport.mockReset();
  runReport.mockImplementation(async (a: { queryId: string; params: unknown }) => {
    const run = runOf(a.queryId, a.params);
    stored.set(run.runId, run);
    return run;
  });
  readReportRun.mockReset();
  readReportRun.mockImplementation(async (a: { runId: string }) => stored.get(a.runId));
});

const go = (templateId: string, params?: Record<string, unknown>) =>
  runTemplate({ projectId: 'p1', templateId, params, asker, surface: 'chat' });

describe('the built-in templates', () => {
  it('are progress, release and roadmap, each holding the three narrative slots', () => {
    expect(listReportTemplates().map((t) => t.id)).toEqual(['progress', 'release', 'roadmap']);
    for (const t of BUILTIN_REPORT_TEMPLATES) {
      expect(t.narrative.map((n) => n.slot)).toEqual(['summary', 'risks', 'recommendations']);
    }
  });

  it('run as written over the registered queries, every layout block drawn from its own run', async () => {
    for (const t of BUILTIN_REPORT_TEMPLATES) {
      const out = await go(t.id);
      expect(out.notDrawn).toEqual([]);
      expect(out.document.blocks).toHaveLength(t.layout.length);
      const ids = out.document.runs.map((r) => r.runId);
      for (const block of out.document.blocks) {
        expect(ids).toContain((block.source as { runId: string }).runId);
      }
      expect(out.slots.map((s) => s.slot)).toEqual(['summary', 'risks', 'recommendations']);
      expect(out.document.narrative).toEqual({ summary: '', risks: '', recommendations: '' });
    }
  });
});

describe('running a template', () => {
  it('runs each query as the asker on the surface, with the template param bound to the query param', async () => {
    await go('progress', { state: 'active' });
    expect(runReport).toHaveBeenCalledTimes(2);
    expect(runReport.mock.calls[0]?.[0]).toMatchObject({
      queryId: 'progress-by-requirement',
      params: { state: 'active' },
      surface: 'chat',
      asker,
    });
    expect(runReport.mock.calls[1]?.[0]).toMatchObject({
      queryId: 'criteria-coverage',
      params: {},
    });
  });

  it('passes no param a template param left unset', async () => {
    await go('progress');
    expect(runReport.mock.calls[0]?.[0].params).toEqual({});
  });

  it('refuses a param the template does not declare, naming those it does', async () => {
    const err = await go('progress', { stat: 'active' }).catch((e: unknown) => e);
    expect(isRefusal(err, 'REPORT_TEMPLATE_PARAM_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('takes no param "stat"; it takes: state');
    expect(runReport).not.toHaveBeenCalled();
  });

  it('refuses a param of the wrong type before any query is read', async () => {
    const err = await go('progress', { state: 3 }).catch((e: unknown) => e);
    expect(isRefusal(err, 'REPORT_TEMPLATE_PARAM_REFUSED')).toBe(true);
    expect(runReport).not.toHaveBeenCalled();
  });

  it('refuses an unknown template, naming the ones that exist', async () => {
    const err = await go('weekly').catch((e: unknown) => e);
    expect(isRefusal(err, 'REPORT_TEMPLATE_NOT_FOUND')).toBe(true);
    expect((err as Error).message).toContain('templates: progress, release, roadmap');
  });

  it('says which blocks a frame with no rows could not fill, and draws the rest', async () => {
    empty = new Set(['release-readiness']);
    const out = await go('release');
    expect(out.notDrawn).toEqual([
      expect.objectContaining({ index: 0, kind: 'kpi', as: 'release' }),
    ]);
    expect(out.notDrawn[0]?.why).toContain('release-readiness returned no rows');
    expect(out.document.blocks.map((b) => b.kind)).toEqual(['table', 'status-list']);
  });

  it('refuses a layout block its frame cannot hold, by name, rather than drawing less', async () => {
    runReport.mockImplementation(async (a: { queryId: string }) => {
      const run = runOf(a.queryId);
      return { ...run, frame: { ...run.frame, fields: run.frame.fields.slice(0, 1) } };
    });
    const err = await go('release').catch((e: unknown) => e);
    expect(isRefusal(err, 'REPORT_BLOCK_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('template "release" layout.');
  });

  it('reads the template params back from the runs it made', async () => {
    const out = await go('progress', { state: 'active' });
    const again = documentOf(templateNamed('progress'), out.document.runs, out.document.narrative);
    expect(again.document.params).toEqual({ state: 'active' });
  });
});

describe('a narrative cites only the template runs', () => {
  const ran = async () => {
    const out = await go('release');
    return out.document.runs.map((r) => r.runId);
  };
  const check = (runIds: string[], narrative: Record<string, string>) =>
    checkTemplateNarrative({
      projectId: 'p1',
      templateId: 'release',
      runIds,
      narrative,
      userId: 'asker',
      agency: 'human' as never,
    });

  it('keeps a slot whose figures the runs returned', async () => {
    const doc = await check(await ran(), { summary: 'REQ-12 is open with 7 issues, 3 rows read.' });
    expect(doc.narrative.summary).toContain('7 issues');
    expect(doc.narrative.risks).toBe('');
  });

  it('refuses a figure no run returned, naming it and the runs it may use', async () => {
    const ids = await ran();
    const err = await check(ids, { risks: 'Three of the 41 issues are late.' }).catch(
      (e: unknown) => e,
    );
    expect(isRefusal(err, 'REPORT_NARRATIVE_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('slot "risks" states 41');
    expect((err as Error).message).toContain(ids[0]);
  });

  it('refuses a slot over its word cap and a slot the template does not declare', async () => {
    const ids = await ran();
    const long = Array.from({ length: 81 }, () => 'word').join(' ');
    const err = (await check(ids, { summary: long, verdict: 'ship' }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain('slot "summary" is 81 words and the template allows 80');
    expect(err.message).toContain('slot "verdict" is not one template "release" declares');
  });

  it('refuses runs that are not the template own, in its order', async () => {
    const ids = await ran();
    const swapped = await check([ids[1] as string, ids[0] as string], { summary: 'ok' }).catch(
      (e: unknown) => e,
    );
    expect(isRefusal(swapped, 'REPORT_TEMPLATE_RUNS_MISMATCH')).toBe(true);
    expect((swapped as Error).message).toContain("the template's own runs only");
    const short = await check([ids[0] as string], { summary: 'ok' }).catch((e: unknown) => e);
    expect((short as Error).message).toContain('runs 2 queries');
  });
});
