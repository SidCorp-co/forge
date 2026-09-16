/**
 * ISS-1056 — the weekly comment from plain objects: the first line carries the window and the
 * thin mark, the per-door counts, the judge tally and agreement, the compare block (or the line
 * that says the comparison starts next week), the candidate list and its files.
 */

import { describe, expect, it } from 'vitest';
import type { Candidate } from '../harvest.js';
import { failureLine, reportFirstLine, reportHead, weeklyReport } from './report.js';
import type { HistoryJudge, HistoryResult } from './result.js';
import type { Group } from './summarize.js';

const modes = (over: Partial<Record<string, { count: number; rate: number | null }>> = {}) =>
  ({
    fallback_sent: { count: 0, rate: 0 },
    unanswered: { count: 0, rate: 0 },
    screen_repair: { count: 0, rate: 0 },
    help_roundtrip: { count: 0, rate: 0 },
    placeholder_argument: { count: 0, rate: 0 },
    repeated_call: { count: 0, rate: 0 },
    wrong_link_shape: { count: 0, rate: 0 },
    dead_link: { count: 0, rate: 0 },
    language_mismatch: { count: 0, rate: 0 },
    over_budget: { count: 0, rate: 0 },
    ...over,
  }) as Group['modes'];

const group = (model: string, rows: number, over: Partial<Group> = {}): Group => ({
  model,
  source: 'web-chat-reply',
  rows,
  sessions: 3,
  thin: rows < 30,
  modes: modes(),
  medians: { ms: 4000, calls: 2, iterations: 2 },
  ...over,
});

const yes = { intent: 'count', served: 'yes' as const, reason: 'r', quote: '' };
const no = { intent: 'find the blocked issues', served: 'no' as const, reason: 'r', quote: '' };

const result = (groups: Group[], over: Partial<HistoryResult> = {}): HistoryResult => ({
  at: '2026-09-14T04:00:00.000Z',
  api: 'in-process',
  commit: 'abc1234',
  version: '0.3.0',
  window: { projectSlug: 'qa', from: '2026-09-07', to: '2026-09-14', source: null },
  budgetSeconds: 60,
  maxIterations: 8,
  resolved: true,
  excludedSessions: ['room-1'],
  excludedSessionsByTask: [],
  excludedRowsByTask: 0,
  excludedRows: 4,
  groups,
  flagged: [],
  ...over,
});

const judged = (): HistoryJudge => ({
  model: 'judge-x',
  sample: 40,
  rows: [
    {
      chatLogId: 'log-1',
      sessionId: 's1',
      createdAt: '2026-09-08T00:00:00.000Z',
      model: 'm1',
      source: 'web-chat-reply',
      modes: [],
      judge: yes,
      query: 'how many open issues',
      askedBy: null,
    },
    {
      chatLogId: 'log-2',
      sessionId: 's2',
      createdAt: '2026-09-09T00:00:00.000Z',
      model: 'm1',
      source: 'web-chat-reply',
      modes: ['unanswered'],
      judge: no,
      query: 'which issues are blocked right now',
      askedBy: null,
    },
  ],
  groups: [
    {
      model: 'm1',
      source: 'web-chat-reply',
      tally: { judged: 2, yes: 1, partial: 0, no: 1, unreadable: 0 },
    },
  ],
  agreement: { ruleFailed: { judged: 1, no: 1 }, clean: { judged: 1, yes: 1 } },
});

const candidate: Candidate = {
  id: 'blocked-now',
  file: 'blocked-now.ts',
  intent: 'find the blocked issues',
  chatLogId: 'log-2',
  source: '// candidate\nexport const tasks = [];\n',
};

const none = { candidates: [], skipped: [] };

describe('reportFirstLine', () => {
  it('carries the window and the row count, and says thin under 30', () => {
    expect(reportFirstLine('2026-09-07..2026-09-14', 12)).toBe(
      'Assistant weekly reading 2026-09-07..2026-09-14: 12 rows — thin (under 30)',
    );
    expect(reportFirstLine('2026-09-07..2026-09-14', 30)).toBe(
      'Assistant weekly reading 2026-09-07..2026-09-14: 30 rows',
    );
  });

  it('the failure line shares the window but never the head, so the published check skips it', () => {
    const line = failureLine('2026-09-07..2026-09-14', { name: 'TypeError', message: 'boom' });
    expect(line).toBe('Assistant weekly reading 2026-09-07..2026-09-14 failed: TypeError: boom');
    expect(line.startsWith(reportHead('2026-09-07..2026-09-14'))).toBe(false);
  });
});

describe('weeklyReport', () => {
  it('opens with the first line, lists every model/door with its counts, the tally and the agreement', () => {
    const r = result(
      [group('m1', 40, { modes: modes({ unanswered: { count: 4, rate: 0.1 } }) }), group('m2', 5)],
      { judge: judged() },
    );
    const { body } = weeklyReport({
      windowId: '2026-09-07..2026-09-14',
      result: r,
      previous: null,
      harvest: none,
    });
    const lines = body.split('\n');
    expect(lines[0]).toBe('Assistant weekly reading 2026-09-07..2026-09-14: 45 rows');
    expect(body).toContain('**m1 / web-chat-reply**: 40 rows, 3 sessions');
    expect(body).toContain('unanswered 4/40 (10.0%)');
    expect(body).toContain('**m2 / web-chat-reply**: 5 rows, 3 sessions (thin)');
    expect(body).toContain(
      'judge judge-x, 2 of 40 asked: judge yes 1/2, partial 0/2, no 1/2, unreadable 0/2',
    );
    expect(body).toContain('agreement: rule-failed rows judged no 1/1, clean rows judged yes 1/1');
    expect(body).toContain('4 row(s) of 1 bench room(s) excluded');
  });

  it('without a previous file it says the comparison starts next week and attaches only the history', () => {
    const { body, files } = weeklyReport({
      windowId: '2026-09-07..2026-09-14',
      result: result([group('m1', 10)]),
      previous: null,
      harvest: none,
    });
    expect(body).toContain(
      "no previous week's file on this issue; the comparison starts next week",
    );
    expect(body).toContain('no judge ran');
    expect(files.map((f) => f.name)).toEqual(['assistant-history-2026-09-07..2026-09-14.json']);
    expect(JSON.parse(files[0]?.text ?? '').window.from).toBe('2026-09-07');
  });

  it('with a previous file it carries the compare lines and attaches them', () => {
    const previous = result(
      [group('m1', 40, { modes: modes({ unanswered: { count: 8, rate: 0.2 } }) })],
      {
        window: { projectSlug: 'qa', from: '2026-08-31', to: '2026-09-07', source: null },
      },
    );
    const current = result([
      group('m1', 40, { modes: modes({ unanswered: { count: 4, rate: 0.1 } }) }),
    ]);
    const { body, files } = weeklyReport({
      windowId: '2026-09-07..2026-09-14',
      result: current,
      previous,
      harvest: none,
    });
    expect(body).toContain('## What changed since 2026-08-31..2026-09-07');
    expect(body).toMatch(/unanswered/);
    const compare = files.find((f) => f.name === 'assistant-compare-2026-09-07..2026-09-14.txt');
    expect(compare?.mime).toBe('text/plain');
    expect(compare?.text).toMatch(/unanswered/);
  });

  it('lists each candidate with its chat_logs id and verdict, and attaches the module', () => {
    const { body, files } = weeklyReport({
      windowId: '2026-09-07..2026-09-14',
      result: result([group('m1', 40)], { judge: judged() }),
      previous: null,
      harvest: { candidates: [candidate], skipped: [] },
    });
    expect(body).toContain("## Candidates from the judge's no and partial");
    expect(body).toContain('- find the blocked issues — chat_logs log-2 — no');
    const file = files.find((f) => f.name === 'candidate-blocked-now.ts.txt');
    expect(file?.text).toBe(candidate.source);
  });

  it('with no candidate it says none and why, and attaches no candidate file', () => {
    const { body, files } = weeklyReport({
      windowId: '2026-09-07..2026-09-14',
      result: result([group('m1', 40)], { judge: judged() }),
      previous: null,
      harvest: {
        candidates: [],
        skipped: [
          { chatLogId: 'log-2', reason: 'intent covered by blocked-list (80%)' },
          { chatLogId: 'log-3', reason: 'query too short' },
        ],
      },
    });
    expect(body).toContain(
      'none: every no/partial row is covered by a shipped task or skipped (intent covered by blocked-list; query too short)',
    );
    expect(files.some((f) => f.name.startsWith('candidate-'))).toBe(false);
  });
});
