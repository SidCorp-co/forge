// ISS-607: a decision's `until` names a date only where it is an ISO 8601 date or a date-time with
// its zone; any other text is a condition no clock ends. `Date.parse` reads the sentences below as
// dates, which is the guess this reader refuses to make.

import { describe, expect, it } from 'vitest';
import { decisionUntilWarnings, readDecisionUntil } from './decision-until.js';

const NOW = new Date('2026-10-23T05:00:00.000Z');

describe('readDecisionUntil', () => {
  it.each([
    ['2026-11-01', '2026-11-01T00:00:00.000Z'],
    ['2026-11-01T09:00Z', '2026-11-01T09:00:00.000Z'],
    ['2026-11-01T09:00:30.5Z', '2026-11-01T09:00:30.500Z'],
    ['2026-11-01T09:00+07:00', '2026-11-01T02:00:00.000Z'],
    ['  2024-02-29  ', '2024-02-29T00:00:00.000Z'],
  ])('reads %s as a date', (text, iso) => {
    expect(readDecisionUntil(text)).toEqual({ kind: 'date', at: new Date(iso) });
  });

  it.each([
    'the orchestrator declares production for 0.1.0',
    'the owner admits or drops ISS-304',
    'ISS-137 lands',
    'Nov 1 2026',
    '1 November 2026',
    '2026-11-01T09:00',
    '2026-11-01 09:00Z',
    '2026-02-30',
    '2025-02-29',
    '2026-11-01T24:00Z',
    '2026-13-01',
    '20261101',
  ])('reads %s as a condition, never a guessed date', (text) => {
    expect(readDecisionUntil(text)).toEqual({ kind: 'condition', text: text.trim() });
  });
});

describe('decisionUntilWarnings', () => {
  const decision = (until?: string) => [
    { key: 'decision', value: 'waits' },
    { key: 'why', value: 'production is not declared' },
    ...(until === undefined ? [] : [{ key: 'until', value: until }]),
  ];

  it('names a condition read from prose, quoting it', () => {
    const [warning, ...rest] = decisionUntilWarnings(
      'decision',
      decision('the owner admits or drops ISS-304'),
      NOW,
    );
    expect(rest).toEqual([]);
    expect(warning).toMatch(/^DECISION_UNTIL_CONDITION: /u);
    expect(warning).toContain('`the owner admits or drops ISS-304`');
  });

  it('names a date already passed', () => {
    expect(decisionUntilWarnings('decision', decision('2026-10-23T04:59Z'), NOW)).toEqual([
      expect.stringMatching(/^DECISION_UNTIL_PASSED: until 2026-10-23T04:59:00.000Z /u),
    ]);
  });

  it('says nothing of a date still to come, no until, or another kind of record', () => {
    expect(decisionUntilWarnings('decision', decision('2026-10-23T05:01Z'), NOW)).toEqual([]);
    expect(decisionUntilWarnings('decision', decision(), NOW)).toEqual([]);
    expect(decisionUntilWarnings('decision', decision('  '), NOW)).toEqual([]);
    expect(decisionUntilWarnings('routed', decision('some day'), NOW)).toEqual([]);
  });
});
