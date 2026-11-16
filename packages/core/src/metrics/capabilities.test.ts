// ISS-1251 §7: the capabilities page's door reports read each door report's signal key as its door
// and verdict, add a door's verdicts together, and drop a key that is no door report.

import { describe, expect, it } from 'vitest';
import { doorReportKey, freshnessFor, tallyReports } from './capabilities.js';

describe('a door report key', () => {
  it('reads the door and verdict, a REST door with its spaces and colons kept', () => {
    expect(doorReportKey('door:unclear:support.member')).toEqual({
      door: 'support.member',
      verdict: 'unclear',
    });
    expect(doorReportKey('door:did_not_help:POST /api/projects/:id/feedback')).toEqual({
      door: 'POST /api/projects/:id/feedback',
      verdict: 'did_not_help',
    });
  });

  it('is no door report under another prefix, an unknown verdict or no door', () => {
    expect(doorReportKey('room:unclear:support.member')).toBeNull();
    expect(doorReportKey('door:loved_it:support.member')).toBeNull();
    expect(doorReportKey('door:unclear:')).toBeNull();
  });
});

describe('the door report tally', () => {
  it('adds a door’s verdicts, keeps its latest report, and puts the most reported first', () => {
    const rows = tallyReports([
      { key: 'door:unclear:support.member', n: 2, last_at: '2026-11-15T01:00:00.000Z' },
      { key: 'door:did_not_help:support.member', n: 1, last_at: new Date('2026-11-16T01:00:00Z') },
      { key: 'door:missing:guide:agent-setup', n: 1, last_at: '2026-11-14T01:00:00.000Z' },
      { key: 'other:thing', n: 9, last_at: '2026-11-16T01:00:00.000Z' },
    ]);
    expect(rows).toEqual([
      {
        door: 'support.member',
        reports: 3,
        byVerdict: { unclear: 2, did_not_help: 1 },
        lastAt: '2026-11-16T01:00:00.000Z',
      },
      {
        door: 'guide:agent-setup',
        reports: 1,
        byVerdict: { missing: 1 },
        lastAt: '2026-11-14T01:00:00.000Z',
      },
    ]);
  });
});

describe("a card's freshness as a project reads it", () => {
  const at = '2026-11-16T01:00:00.000Z';
  const delta = (projectId: string | null, text: string) => ({
    id: text,
    field: 'redFlag' as const,
    op: 'add' as const,
    text,
    replaces: null,
    fromLesson: 'L-1',
    projectId,
    at,
  });

  it('keeps the re-check and the scenarios, and only the deltas this project proposed', () => {
    const rows = freshnessFor('p1', [
      {
        cardId: 'support.member',
        recheckOwed: { since: at, by: 'ISS-75 changed card:support.member' },
        scenarios: [
          { name: 'stranger writes', passed: false, change: 'L-3 fold', reason: 'r', at },
        ],
        proposedDeltas: [delta('p1', 'ours'), delta('p2', 'theirs'), delta(null, 'nobody')],
      },
    ]);
    expect(rows).toEqual([
      {
        card: 'support.member',
        recheckOwed: { since: at },
        scenarios: [{ name: 'stranger writes', passed: false, at }],
        proposed: [{ field: 'redFlag', text: 'ours' }],
      },
    ]);
  });

  it('leaves out a card with nothing left to say for this project', () => {
    const rows = freshnessFor('p1', [
      {
        cardId: 'support.rule',
        recheckOwed: null,
        scenarios: [],
        proposedDeltas: [delta('p2', 'theirs')],
      },
    ]);
    expect(rows).toEqual([]);
  });
});
