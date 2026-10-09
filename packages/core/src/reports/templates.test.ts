import type { ReportFrame, ReportRun } from '@forge/contracts/report-queries';
import { BUILTIN_REPORT_TEMPLATES } from '@forge/contracts/report-template-builtins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRefusal } from '../lib/refusal.js';
import { registerReportQueries } from '../report-queries/register.js';
import { getReportQuery, listReportQueries } from '../report-queries/registry.js';

// A template is data; running it runs its queries as the asker, draws its layout over their frames and
// has the narrative writer word it, judged by this file. A narrative may cite only the figures of the
// template's own runs, and a block's finding only those of its own block.

const runReport = vi.fn();
const readReportRun = vi.fn();
const writeNarrative = vi.fn();
vi.mock('./runs.js', async (original) => ({
  ...(await original<typeof import('./runs.js')>()),
  runReport: (...args: unknown[]) => runReport(...args),
  readReportRun: (...args: unknown[]) => readReportRun(...args),
}));
vi.mock('./narrative.js', () => ({
  writeTemplateNarrative: (...args: unknown[]) => writeNarrative(...args),
}));
const NOT_ASKED = { path: 'not_written', reason: 'no model is asked here', model: null, calls: 0 };

const { provideReportsPorts } = await import('./ports.js');
const { checkTemplateNarrative, documentOf, listReportTemplates, runTemplate, templateNamed } =
  await import('./templates.js');

registerReportQueries();
provideReportsPorts({
  runQuery: () => Promise.reject(new Error('not run here')),
  describeQuery: (id) => getReportQuery(id).descriptor,
  listQueries: () => listReportQueries().map((q) => q.descriptor),
  roomOf: () => Promise.reject(new Error('not read here')),
  turnOf: () => Promise.reject(new Error('not read here')),
  postAnswer: () => Promise.reject(new Error('not posted here')),
  restTurnOf: () => Promise.reject(new Error('not read here')),
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
  writeNarrative.mockReset();
  writeNarrative.mockImplementation(async (a: { document: unknown }) => ({
    document: a.document,
    narrative: NOT_ASKED,
  }));
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
      expect(out.narrative).toEqual(NOT_ASKED);
    }
  });
});

describe('running a template', () => {
  it('runs each query as the asker on the surface, with the template param bound to the query param', async () => {
    await go('progress', { days: 7 });
    expect(runReport.mock.calls.map((c) => [c[0].queryId, c[0].params])).toEqual([
      ['period-flow', { days: 7 }],
      ['issue-flow', { bucket: 'day', periods: 7 }],
      ['status-time', { days: 7 }],
      ['closed-by-requirement', { days: 7 }],
      ['progress-by-requirement', {}],
    ]);
    expect(runReport.mock.calls[0]?.[0]).toMatchObject({ surface: 'chat', asker });
  });

  it('runs the progress template over its default period when none is given', async () => {
    await go('progress');
    expect(runReport.mock.calls[0]?.[0].params).toEqual({ days: 14 });
  });

  it('passes no param a template param left unset', async () => {
    await go('roadmap');
    expect(runReport.mock.calls[0]?.[0].params).toEqual({});
  });

  it('refuses a param the template does not declare, naming those it does', async () => {
    const err = await go('progress', { state: 'active' }).catch((e: unknown) => e);
    expect(isRefusal(err, 'REPORT_TEMPLATE_PARAM_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('takes no param "state"; it takes: days');
    expect(runReport).not.toHaveBeenCalled();
  });

  it('refuses a param of the wrong type before any query is read', async () => {
    const err = await go('progress', { days: 'seven' }).catch((e: unknown) => e);
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
      expect.objectContaining({ index: 1, kind: 'kpi', as: 'release' }),
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
    const out = await go('progress', { days: 7 });
    const again = documentOf(templateNamed('progress'), out.document.runs, out.document.narrative);
    expect(again.document.params).toEqual({ days: 7 });
  });

  it('hands the narrative writer a judge over its own runs, and answers what the writer kept', async () => {
    writeNarrative.mockImplementation(
      async (a: { judge: (x: unknown) => unknown; title: string; what: string }) => ({
        document: await a.judge({
          narrative: { summary: 'REQ-12 holds 7 issues.' },
          findings: ['The next release holds 7 issues.'],
        }),
        narrative: { path: 'written', reason: null, model: 'm', calls: 1 },
      }),
    );
    const out = await go('release');
    expect(writeNarrative.mock.calls[0]?.[0]).toMatchObject({
      title: 'Release readiness',
      what: 'a release report run through chat',
    });
    expect(out.narrative).toMatchObject({ path: 'written' });
    expect(out.document.narrative.summary).toBe('REQ-12 holds 7 issues.');
    expect(out.document.blocks[0]?.finding).toBe('The next release holds 7 issues.');
    expect(out.document.blocks[1]?.finding).toBeUndefined();
    expect(out.text).toContain('Summary: REQ-12 holds 7 issues.');
    expect(out.text).toContain('The next release holds 7 issues.');
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

  // ISS-419 on dev.185: the progress narrative said "12 issue to do" and "2 awaiting_release", which
  // the progress run held in fields the drawn blocks did not show, and it passed
  it('refuses a figure a run holds in a field no block of the template shows', async () => {
    const ids = await ran();
    const progress = stored.get(ids[1] as string) as ReportRun;
    (progress.frame.rows[0] as Record<string, unknown>).criteriaProven = 13;
    const err = await check(ids, { summary: 'REQ-12 has 13 criteria proven.' }).catch(
      (e: unknown) => e,
    );
    expect(isRefusal(err, 'REPORT_NARRATIVE_REFUSED')).toBe(true);
    expect((err as Error).message).toContain('slot "summary" states 13');
    expect((err as Error).message).toContain('status-list "Requirements"');
  });

  it('keeps a figure the same field holds where a block of the template draws it', async () => {
    const ids = await ran();
    const release = stored.get(ids[0] as string) as ReportRun;
    (release.frame.rows[0] as Record<string, unknown>).toDo = 12;
    const doc = await check(ids, { risks: 'The next release still has 12 issues to do.' });
    expect(doc.narrative.risks).toContain('12 issues');
  });

  describe("a block's finding", () => {
    const withFindings = (runIds: string[], findings: string[]) =>
      checkTemplateNarrative({
        projectId: 'p1',
        templateId: 'release',
        runIds,
        narrative: {},
        findings,
        userId: 'asker',
        agency: 'human' as never,
      });

    it('is kept on its block when it states only figures its own block shows; an empty one leaves none', async () => {
      const ids = await ran();
      const doc = await withFindings(ids, ['', 'The window shipped 7 releases.']);
      expect(doc.blocks[0]?.finding).toBeUndefined();
      expect(doc.blocks[1]?.finding).toBe('The window shipped 7 releases.');
    });

    it('is refused when it states a figure only another block shows, naming its block', async () => {
      const ids = await ran();
      const release = stored.get(ids[0] as string) as ReportRun;
      (release.frame.rows[0] as Record<string, unknown>).toDo = 12;
      // block 0 (the next release) shows toDo; block 1 (shipped in the window) does not
      const err = (await withFindings(ids, ['', '12 issues are left.']).catch(
        (e: unknown) => e,
      )) as Error;
      expect(isRefusal(err, 'REPORT_NARRATIVE_REFUSED')).toBe(true);
      expect(err.message).toContain(
        'finding 2 (kpi "Shipped in the window") states 12, which its own block does not show',
      );
    });

    it('is refused past one line, and past one finding per block', async () => {
      const ids = await ran();
      const multi = (await withFindings(ids, ['Two\nlines.']).catch((e: unknown) => e)) as Error;
      expect(multi.message).toContain('finding 1 (kpi "The next release") is not one line');
      const many = (await withFindings(ids, ['a', 'b', 'c', 'd', 'e']).catch(
        (e: unknown) => e,
      )) as Error;
      expect(many.message).toContain(
        '5 findings were given and template "release" draws 4 block(s)',
      );
    });
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
