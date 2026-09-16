/**
 * ISS-1055 - candidates from judged rows: what is written, what is skipped and why, the scrub
 * over every text the module carries, the coverage threshold either side, the provenance header,
 * the refusal of a file with no judge or no query, and a candidate refused by validateTasks.
 */

import { describe, expect, it } from 'vitest';
import {
  COVERED_SHARE,
  contentWords,
  coverage,
  harvest,
  harvestLines,
  MIN_QUERY_WORDS,
  scrubQuery,
} from './harvest.js';
import type { HistoryResult, JudgedRow } from './history/result.js';
import type { JudgeResult } from './judge.js';
import { type Task, validateTasks } from './task.js';
import { SHIPPED_TASKS } from './tasks/index.js';

const verdict = (
  served: 'yes' | 'partial' | 'no',
  intent: string,
  reason = 'because',
): JudgeResult => ({ intent, served, reason, quote: '' });

const row = (over: Partial<JudgedRow> & { judge: JudgeResult }): JudgedRow => ({
  chatLogId: '8646c47d-0000-4000-8000-000000000001',
  sessionId: 'room-1',
  createdAt: '2026-09-16T03:00:00.000Z',
  model: 'm',
  source: 'web',
  modes: [],
  query: 'Run the test suite for this project and tell me whether it passes.',
  askedBy: null,
  ...over,
});

const file = (rows: JudgedRow[], judge = true): HistoryResult =>
  ({
    at: 'x',
    api: 'a',
    commit: 'c',
    version: 'v',
    window: { projectSlug: 'qa', from: '2026-09-01', to: '2026-09-02', source: null },
    budgetSeconds: 60,
    maxIterations: 8,
    resolved: false,
    excludedSessions: [],
    excludedRows: 0,
    groups: [],
    flagged: [],
    ...(judge
      ? {
          judge: {
            model: 'cx/judge',
            sample: rows.length,
            rows,
            groups: [],
            agreement: { ruleFailed: { judged: 0, no: 0 }, clean: { judged: 0, yes: 0 } },
          },
        }
      : {}),
  }) as HistoryResult;

/** A task set whose intents are known, so coverage is planted rather than inherited. */
const linked: Task = {
  id: 'open-issues-linked',
  capability: 'method',
  intent: 'List all open issues in the project, one line each, with a link to each issue.',
  budgetSeconds: 60,
  turns: [{ message: 'm', checks: [{ kind: 'notFallback' }] }],
};
const tasks: Task[] = [linked];

describe('what is written and what is skipped', () => {
  it('writes a candidate for a no and for an uncovered partial, and skips yes, covered, unreadable and short rows with the reason', () => {
    const out = harvest(
      file([
        row({
          judge: verdict('no', 'Run the repository test suite and report whether it passes.'),
        }),
        row({
          chatLogId: '2222aaaa-0000-4000-8000-000000000002',
          judge: verdict('partial', 'Archive the room and prove the message survived.'),
          query: 'Archive this room and show me the message is still there.',
        }),
        row({ chatLogId: '3333aaaa-0000-4000-8000-000000000003', judge: verdict('yes', 'x') }),
        row({
          chatLogId: '4444aaaa-0000-4000-8000-000000000004',
          judge: verdict('partial', 'List all open issues in the project with a link to each.'),
        }),
        row({ chatLogId: '5555aaaa-0000-4000-8000-000000000005', judge: { error: 'no json' } }),
        row({
          chatLogId: '6666aaaa-0000-4000-8000-000000000006',
          judge: verdict('no', 'Greet the person.'),
          query: 'hi there',
        }),
        row({
          chatLogId: '7777aaaa-0000-4000-8000-000000000007',
          judge: verdict('partial', 'Rewrite the previous reply for a non-technical stakeholder.'),
          query:
            '[SYSTEM CHECK — not from the user] Your previous reply cannot be sent as-is: reply cites "ISS-538" which was not verified this turn. Rewrite it now.',
        }),
      ]),
      tasks,
    );
    expect(out.candidates.map((c) => c.file)).toEqual([
      'repository-test-suite-report-passes-8646c47d.ts',
      'archive-room-prove-message-survived-2222aaaa.ts',
    ]);
    expect(out.skipped).toEqual([
      { chatLogId: '3333aaaa-0000-4000-8000-000000000003', reason: 'judged yes' },
      {
        chatLogId: '4444aaaa-0000-4000-8000-000000000004',
        reason: 'intent covered by open-issues-linked (100%)',
      },
      { chatLogId: '5555aaaa-0000-4000-8000-000000000005', reason: 'unreadable verdict' },
      { chatLogId: '6666aaaa-0000-4000-8000-000000000006', reason: 'query too short' },
      {
        chatLogId: '7777aaaa-0000-4000-8000-000000000007',
        reason: "retry row, not a person's query",
      },
    ]);
    expect(MIN_QUERY_WORDS).toBe(3);
    expect(harvestLines(out, '/tmp/c')).toEqual([
      'wrote 2 candidate(s) to /tmp/c',
      '  repository-test-suite-report-passes-8646c47d.ts — Run the repository test suite and report whether it passes.',
      '  archive-room-prove-message-survived-2222aaaa.ts — Archive the room and prove the message survived.',
      'skipped 5:',
      '  3333aaaa — judged yes',
      '  4444aaaa — intent covered by open-issues-linked (100%)',
      '  5555aaaa — unreadable verdict',
      '  6666aaaa — query too short',
      "  7777aaaa — retry row, not a person's query",
    ]);
  });

  it('the source carries the provenance header and exports a Task with the scrubbed query, the intent and checks: []', () => {
    const [c] = harvest(
      file([row({ judge: verdict('no', 'Run the tests.', 'it declined to run them') })]),
      tasks,
    ).candidates;
    if (!c) throw new Error('no candidate');
    expect(c.source).toContain('// chat_logs id: 8646c47d-0000-4000-8000-000000000001');
    expect(c.source).toContain('// room (session_id): room-1');
    expect(c.source).toContain('// created at: 2026-09-16T03:00:00.000Z');
    expect(c.source).toContain('// judge cx/judge said no: it declined to run them');
    expect(c.source).toContain("import type { Task } from '../task.js';");
    expect(c.source).toContain('export const tests8646c47d: Task = {');
    expect(c.source).toContain('  id: "tests-8646c47d",');
    expect(c.source).toContain('  intent: "Run the tests.",');
    expect(c.source).toContain(
      '  turns: [{ message: "Run the test suite for this project and tell me whether it passes.", checks: [] }],',
    );
  });

  it('a candidate read back as a Task is refused by validateTasks for carrying no check', () => {
    const [c] = harvest(file([row({ judge: verdict('no', 'Run the tests.') })]), tasks).candidates;
    if (!c) throw new Error('no candidate');
    const task: Task = {
      id: c.id,
      capability: 'method',
      intent: c.intent,
      budgetSeconds: 90,
      turns: [{ message: 'm', checks: [] }],
    };
    expect(() => validateTasks([task])).toThrow(/turn 1 carries no check/);
  });

  it('refuses by name a file with no judge and a judged file whose rows carry no query, naming history --judge', () => {
    expect(() => harvest(file([], false), tasks, 'h.json')).toThrow(
      'h.json carries no judge; run history --judge on the window first',
    );
    const old = row({ judge: verdict('no', 'x') });
    delete (old as { query?: string }).query;
    expect(() => harvest(file([old]), tasks, 'h.json')).toThrow(
      'h.json was judged before ISS-1055 and its rows carry no query; run history --judge on the window again',
    );
  });
});

describe('the scrub', () => {
  it('replaces an e-mail, a handle, the asker, an issue key, a uuid and a url host by typed placeholders', () => {
    const text =
      'Ask alice@example.com or @bob and Minh Tran about ISS-538 at https://forge.example.com/projects/qa/issues/6b696e90-99aa-452f-88f7-3bfeb6af8810';
    expect(scrubQuery(text, { askedBy: 'Minh Tran' })).toBe(
      'Ask <email> or <person> and <person> about ISS-<n> at https://<host>/projects/qa/issues/<uuid>',
    );
    expect(scrubQuery('nothing to scrub here', { askedBy: null })).toBe('nothing to scrub here');
  });

  it('the same e-mail, handle and asker planted in the query, the intent and the reason leave no trace in the source', () => {
    const planted = 'alice@example.com asked @bob for Minh Tran';
    const [c] = harvest(
      file([
        row({
          askedBy: 'Minh Tran',
          query: `Tell ${planted} about the deploy window please`,
          judge: verdict('no', `Deploy window for ${planted}`, `Nothing said to ${planted}`),
        }),
      ]),
      tasks,
    ).candidates;
    if (!c) throw new Error('no candidate');
    for (const secret of ['alice@example.com', '@bob', 'Minh Tran']) {
      expect(c.source).not.toContain(secret);
      expect(c.file).not.toContain(secret);
    }
    expect(c.source).toContain('<email>');
    expect(c.source).toContain('<person>');
  });
});

describe('coverage', () => {
  it('covers an intent at the threshold and not one under it, and names the constant', () => {
    expect(COVERED_SHARE).toBe(0.6);
    // five content words: list, open, issues, link, show -> 3 of 5 is 60%, on the threshold
    const at = coverage('list open issues link show', [
      { ...linked, intent: 'list open issues nothing more' },
    ]);
    expect(at).toEqual({ task: 'open-issues-linked', share: 0.6 });
    const under = coverage('list open issues link show', [
      { ...linked, id: 'other-task', intent: 'list open nothing more here' },
    ]);
    expect(under).toEqual({ task: 'other-task', share: 0.4 });
    expect(coverage('', tasks)).toBeNull();
  });

  it('content words are lowercase letters-only words of four or more letters, once each, minus the stopwords', () => {
    expect(contentWords('The Person wanted 3 things: Links, links and a LINK!')).toEqual([
      'things',
      'links',
      'link',
    ]);
  });

  it('every shipped task carries an intent no other shipped task covers', () => {
    for (const task of SHIPPED_TASKS) {
      const others = SHIPPED_TASKS.filter((t) => t.id !== task.id);
      const best = coverage(task.intent, others);
      expect(
        best === null || best.share < COVERED_SHARE,
        `${task.id} is covered by ${best?.task}`,
      ).toBe(true);
    }
  });
});
