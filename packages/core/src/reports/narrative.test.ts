import type { ReportFrame, ReportRun } from '@forge/contracts/report-queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReportQueries } from '../report-queries/register.js';
import { getReportQuery, listReportQueries } from '../report-queries/registry.js';

// The roadmap's narrative through the real writer and judge, the model stubbed at `completeOnce`
// (ISS-490 c2, ISS-488 c5). J7 on 0.4.0-dev.223 saw the model repeat the ISO it was handed, cut one
// off after its day, and put three requirements at a fourth one's time. What must hold: the model is
// handed no ISO, each of those answers is refused by name and retried, and a clean answer is kept
// with every time its requirement's own.
// @direct-test-of packages/core/src/reports/narrative-instants.ts

const answers: string[] = [];
const asked: { role: string; content: string }[][] = [];
vi.mock('../integrations/llm/index.js', async (original) => ({
  ...(await original<typeof import('../integrations/llm/index.js')>()),
  completeOnce: async (_scope: unknown, messages: { role: string; content: string }[]) => {
    asked.push(messages.map((m) => ({ ...m })));
    const text = answers.shift();
    if (text === undefined) throw new Error('the model was asked once more than this test planted');
    return { ok: true, text, model: 'stub-model', usage: { promptTokens: 1, completionTokens: 1 } };
  },
}));
vi.mock('../agent-sessions/index.js', async (original) => ({
  ...(await original<typeof import('../agent-sessions/index.js')>()),
  recordModelCallUsage: async () => undefined,
}));
vi.mock('../project-config/index.js', async (original) => ({
  ...(await original<typeof import('../project-config/index.js')>()),
  readContentLanguage: async () => ({
    contentLanguage: 'en',
    keepTermsInEnglish: [],
    source: 'default',
    revision: null,
  }),
}));
const runReport = vi.fn();
vi.mock('./runs.js', async (original) => ({
  ...(await original<typeof import('./runs.js')>()),
  runReport: (...args: unknown[]) => runReport(...args),
}));

const { provideReportsPorts } = await import('./ports.js');
const { runTemplate } = await import('./templates.js');

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

const T = (hhmm: string) => `2026-10-10T${hhmm}:33.076Z`;
/** J7's run 2 forecast: REQ-34 04:33, REQ-30 05:14, REQ-31 06:49, REQ-43 10:46 (p50). */
const FORECAST = [
  ['REQ-40', T('02:19'), T('07:17')],
  ['REQ-34', T('04:33'), T('09:58')],
  ['REQ-30', T('05:14'), T('16:01')],
  ['REQ-31', T('06:49'), T('12:30')],
  ['REQ-43', T('10:46'), T('14:47')],
] as const;

const roadmapRun = (): ReportRun => {
  const frame: ReportFrame = {
    fields: [...getReportQuery('roadmap-eta').descriptor.output],
    rows: FORECAST.map(([key, p50At, p85At]) => ({
      lane: 'open',
      key,
      title: 'text',
      state: 'open',
      p50At,
      p85At,
      basis: 'read from 19 issues landed in the last 60 days',
    })),
  };
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    queryId: 'roadmap-eta',
    version: 1,
    params: {},
    projectId: 'p1',
    actor: { kind: 'human', id: 'asker' },
    asOf: '2026-10-10T01:30:00.000Z',
    frame,
  };
};

const answer = (summary: string, findings = ['', '']) =>
  JSON.stringify({
    summary,
    risks: 'REQ-30 has the widest forecast range.',
    recommendations: 'Keep REQ-40 first.',
    findings,
  });

const run = () =>
  runTemplate({
    projectId: 'p1',
    templateId: 'roadmap',
    asker: { userId: 'asker', agency: 'human', access: {} } as never,
    surface: 'rest',
  });

beforeEach(() => {
  answers.length = 0;
  asked.length = 0;
  runReport.mockReset();
  runReport.mockImplementation(async () => roadmapRun());
});

describe("the roadmap narrative's dates and times", () => {
  it('are handed to the model as UTC words, never as ISO, with the rule to copy them', async () => {
    answers.push(answer('REQ-40 is forecast first, at Oct 10, 02:19 UTC.'));
    await run();
    const [system, input] = asked[0] ?? [];
    expect(input?.content).toContain('"p50At":"Oct 10, 04:33 UTC"');
    expect(input?.content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(system?.content).toContain('Write a date or time exactly as its row shows it');
  });

  it("refuse J7's run 1 (a cut-off instant) and run 2 (REQ-34 at REQ-43's time), then keep the retry", async () => {
    answers.push(
      answer(
        'REQ-40 is forecast first at Oct 10, 02:19 UTC. REQ-34, REQ-30, REQ-31, and REQ-43 follow on 2026-10-10T.',
      ),
      answer(
        'Forecasts place REQ-40 at Oct 10, 02:19 UTC, followed by REQ-34, REQ-30, REQ-31, and REQ-43 at Oct 10, 10:46 UTC.',
      ),
    );
    const failed = await run();
    expect(failed.narrative).toMatchObject({ path: 'not_written', calls: 2 });
    expect(asked[1]?.at(-1)?.content).toContain(
      'states "2026-10-10T", an instant cut off after its day',
    );
    expect(failed.narrative.reason).toContain('puts REQ-34, REQ-30, REQ-31 at Oct 10, 10:46 UTC');
    expect(failed.document.narrative.summary).toBe('');

    answers.push(
      answer(
        'Forecasts place REQ-40 at Oct 10, 02:19 UTC, followed by REQ-34, REQ-30, REQ-31, and REQ-43 at Oct 10, 10:46 UTC.',
      ),
      answer(
        'REQ-40 lands first at Oct 10, 02:19 UTC; REQ-34 follows at Oct 10, 04:33 UTC and REQ-43 at Oct 10, 10:46 UTC.',
      ),
    );
    const kept = await run();
    expect(kept.narrative).toMatchObject({ path: 'retried', calls: 2 });
    expect(asked.at(-1)?.at(-1)?.content).toContain(
      'puts REQ-34, REQ-30, REQ-31 at Oct 10, 10:46 UTC',
    );
    expect(kept.document.narrative.summary).toBe(
      `REQ-40 lands first at ${T('02:19')}; REQ-34 follows at ${T('04:33')} and REQ-43 at ${T('10:46')}.`,
    );
    expect(kept.text).toContain(
      'Summary: REQ-40 lands first at Oct 10, 02:19 UTC; REQ-34 follows at Oct 10, 04:33 UTC and REQ-43 at Oct 10, 10:46 UTC.',
    );
  });

  // Several runs, each worded as a model words the forecast: every one is kept on its first call
  // with each time its requirement's own, and no run text carries ISO.
  it.each([
    'Forecast windows begin with REQ-40 at Oct 10, 02:19 UTC, REQ-34 at Oct 10, 04:33 UTC, REQ-30 at Oct 10, 05:14 UTC, REQ-31 at Oct 10, 06:49 UTC, and REQ-43 at Oct 10, 10:46 UTC.',
    'REQ-40 is likely by Oct 10, 02:19 UTC. REQ-30 is almost surely done by Oct 10, 16:01 UTC, the latest.',
    'REQ-40, then REQ-34, REQ-30 and REQ-31 land on Oct 10; REQ-43 is last at Oct 10, 10:46 UTC.',
  ])('holds over several runs: %s', async (summary) => {
    answers.push(answer(summary, ['', `REQ-30 has the latest forecast end, Oct 10, 16:01 UTC.`]));
    const out = await run();
    expect(out.narrative).toMatchObject({ path: 'written', calls: 1 });
    expect(out.document.blocks[1]?.finding).toBe(
      `REQ-30 has the latest forecast end, ${T('16:01')}.`,
    );
    expect(out.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
