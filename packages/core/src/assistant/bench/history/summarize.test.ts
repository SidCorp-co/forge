/**
 * ISS-1053 - grouping by model and source, every rate beside its count, thin under thirty rows,
 * medians, the flagged rows newest first, the bench rooms dropped by session id, and the file
 * refused when a key is missing.
 */

import { describe, expect, it } from 'vitest';
import { gradeRow } from './grade-row.js';
import { type HistoryResult, readHistoryResult, serializeHistory } from './result.js';
import type { HistoryRow } from './row.js';
import { summarize, THIN_ROWS } from './summarize.js';

const OPTS = { budgetSeconds: 60, maxIterations: 8 };
let n = 0;
const row = (over: Partial<HistoryRow> = {}): HistoryRow => {
  n += 1;
  return {
    id: `log-${String(n).padStart(3, '0')}`,
    sessionId: `room-${n % 3}`,
    query: 'q',
    reply: 'a',
    model: 'm1',
    source: 'web-chat-reply',
    toolCalls: [{ name: 'forge', arguments: '{"argv":["issue"]}', isError: false, durationMs: 1 }],
    iterations: 2,
    durationMs: 1000 * n,
    error: null,
    createdAt: `2026-09-16T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    ...over,
  };
};
const graded = (rows: HistoryRow[]) => rows.map((r) => ({ row: r, grade: gradeRow(r, OPTS) }));

describe('summarize', () => {
  it('groups by model and source with counts, rates beside them, sessions and medians', () => {
    const rows = [row(), row({ reply: null }), row({ model: 'm2' }), row({ source: 'rocketchat' })];
    const s = summarize(graded(rows));
    expect(s.groups.map((g) => [g.model, g.source, g.rows])).toEqual([
      ['m1', 'web-chat-reply', 2],
      ['m1', 'rocketchat', 1],
      ['m2', 'web-chat-reply', 1],
    ]);
    const first = s.groups[0];
    expect(first?.modes.unanswered).toEqual({ count: 1, rate: 0.5 });
    expect(first?.modes.fallback_sent).toEqual({ count: 0, rate: 0 });
    expect(first?.sessions).toBe(2);
    expect(first?.medians).toEqual({ ms: 1500, calls: 1, iterations: 2 });
  });

  it('marks a group under thirty rows thin and a larger one not', () => {
    const many = Array.from({ length: THIN_ROWS }, () => row());
    const s = summarize(graded([...many, row({ model: 'm2' })]));
    expect(s.groups.find((g) => g.model === 'm1')?.thin).toBe(false);
    expect(s.groups.find((g) => g.model === 'm2')?.thin).toBe(true);
  });

  it('drops rows of excluded sessions before grouping and counts them', () => {
    const rows = [
      row({ sessionId: 'bench-1' }),
      row({ sessionId: 'bench-1', reply: null }),
      row({ sessionId: 'real' }),
    ];
    const s = summarize(graded(rows), new Set(['bench-1']));
    expect(s.excludedRows).toBe(2);
    expect(s.groups[0]?.rows).toBe(1);
    expect(s.flagged).toEqual([]);
  });

  it('lists flagged rows newest first with the fact behind each mode', () => {
    const older = row({ reply: null, createdAt: '2026-09-16T00:00:01.000Z' });
    const newer = row({
      toolCalls: [{ name: 'forge', arguments: '{"argv":["-h"]}' }],
      createdAt: '2026-09-16T00:00:09.000Z',
    });
    const s = summarize(graded([older, row({ createdAt: '2026-09-16T00:00:05.000Z' }), newer]));
    expect(s.flagged.map((f) => [f.chatLogId, f.modes])).toEqual([
      [newer.id, ['help_roundtrip']],
      [older.id, ['unanswered']],
    ]);
    expect(s.flagged[0]).toMatchObject({
      sessionId: newer.sessionId,
      model: 'm1',
      source: 'web-chat-reply',
    });
    expect(s.flagged[0]?.evidence[0]?.fact).toBe('forge -h');
  });

  it('carries no total or score key', () => {
    const s = summarize(graded([row()]));
    expect(Object.keys(s).sort()).toEqual(['excludedRows', 'flagged', 'groups']);
    for (const g of s.groups) expect(Object.keys(g)).not.toContain('score');
  });
});

describe('the history file', () => {
  const file = (): HistoryResult => ({
    at: 'now',
    api: 'https://api.test',
    commit: 'abc',
    version: '0.3.0',
    window: { projectSlug: 'qa', from: '2026-09-01', to: '2026-09-16', source: null },
    budgetSeconds: 60,
    maxIterations: 8,
    resolved: false,
    excludedSessions: [],
    excludedSessionsByTask: [],
    excludedRowsByTask: 0,
    ...summarize(graded([row(), row({ reply: null })])),
  });

  it('reads back what it wrote', () => {
    const back = readHistoryResult(serializeHistory(file()));
    expect(back.groups[0]?.rows).toBe(2);
    expect(back.flagged).toHaveLength(1);
  });

  it('refuses a file missing a key, by name', () => {
    const { flagged: _f, ...missing } = file();
    expect(() => readHistoryResult(JSON.stringify(missing), 'h.json')).toThrow(
      'h.json lacks flagged',
    );
    expect(() => readHistoryResult('[]')).toThrow('history is not an object');
  });
});
