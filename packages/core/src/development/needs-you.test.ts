import { describe, expect, it } from 'vitest';
import { areaOf, untriaged } from './needs-you.js';

type Row = { group: string; act: string };
const you = (r: Row) => r.group === 'you';
const act = (r: Row) => r.act;

describe('areaOf', () => {
  it('counts only the rows the list groups under waiting on you', () => {
    const rows: Row[] = [
      { group: 'you', act: 'accept r2' },
      { group: 'moving', act: 'running' },
      { group: 'you', act: 'break down' },
    ];
    expect(areaOf(rows, you, act).you).toBe(2);
  });

  it('names each act once, most frequent first, ties in alphabetical order', () => {
    const rows: Row[] = [
      { group: 'you', act: 'triage it' },
      { group: 'you', act: 'approve' },
      { group: 'you', act: 'triage it' },
      { group: 'you', act: 'answer' },
    ];
    expect(areaOf(rows, you, act).acts).toEqual([
      { act: 'triage it', count: 2 },
      { act: 'answer', count: 1 },
      { act: 'approve', count: 1 },
    ]);
  });

  it('reads an empty list as nothing waiting, with no act invented', () => {
    expect(areaOf([], you, act)).toEqual({ you: 0, acts: [] });
  });

  it('keeps the acts summing to the count, so the tooltip never disagrees with the number', () => {
    const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
      group: i % 3 === 0 ? 'you' : 'done',
      act: `act ${i % 4}`,
    }));
    const area = areaOf(rows, you, act);
    expect(area.acts.reduce((n, a) => n + a.count, 0)).toBe(area.you);
    expect(area.you).toBe(17);
  });
});

describe('untriaged', () => {
  it('reads new and reopened feedback as still to triage', () => {
    expect(untriaged('new')).toBe(true);
    expect(untriaged('reopened')).toBe(true);
  });

  it('reads routed, shipped and closed feedback as triaged', () => {
    for (const phase of ['triaged', 'planned', 'resolved', 'verified', 'declined'] as const) {
      expect(untriaged(phase)).toBe(false);
    }
  });
});
