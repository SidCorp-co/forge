/**
 * ISS-1053 - one planted row per mode the history grader can name, a clean row that earns none,
 * and the two places history judges differently from the benchmark: a repair is read off the
 * row's query, and links are left unjudged unless lookups were made.
 */

import { describe, expect, it } from 'vitest';
import { CORRECTIVE_PREFIX, emptyFallbackReply } from '../../../conversations/fallback-replies.js';
import { gradeRow, HISTORY_MODES } from './grade-row.js';
import type { HistoryRow } from './row.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const OPTS = { budgetSeconds: 60, maxIterations: 8 };

const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  id: 'log-1',
  sessionId: 'room-1',
  query: 'How many open issues are there?',
  reply: 'There are 3 open issues.',
  model: 'm',
  source: 'web-chat-reply',
  toolCalls: [
    {
      name: 'forge',
      arguments: '{"argv":["issue","--status","open"]}',
      isError: false,
      durationMs: 5,
    },
  ],
  iterations: 2,
  durationMs: 4000,
  error: null,
  createdAt: '2026-09-16T00:00:00.000Z',
  ...over,
});
const forge = (...argv: string[]) => ({
  name: 'forge',
  arguments: JSON.stringify({ argv }),
  isError: false,
  durationMs: 1,
});

describe('gradeRow', () => {
  it('a clean row earns no mode', () => {
    expect(gradeRow(row(), OPTS)).toEqual({ modes: [], evidence: [] });
  });

  it('fallback_sent for a reply that is the door fallback', () => {
    expect(gradeRow(row({ reply: emptyFallbackReply('Forge') }), OPTS).modes).toEqual([
      'fallback_sent',
    ]);
  });

  it('unanswered for no reply, and for an error whether or not a reply is present', () => {
    expect(gradeRow(row({ reply: null }), OPTS).modes).toEqual(['unanswered']);
    expect(gradeRow(row({ reply: '' }), OPTS).modes).toEqual(['unanswered']);
    expect(gradeRow(row({ reply: ' \n ' }), OPTS).modes).toEqual(['unanswered']);
    expect(gradeRow(row({ reply: null, error: 'provider timeout' }), OPTS).modes).toEqual([
      'unanswered',
    ]);
    const both = gradeRow(row({ error: 'tool failed after the reply' }), OPTS);
    expect(both.modes).toEqual(['unanswered']);
    expect(both.evidence[0]?.fact).toBe('error: tool failed after the reply');
  });

  it('screen_repair for a row whose query is the corrective instruction, not for a reply mentioning one', () => {
    expect(
      gradeRow(
        row({ query: `${CORRECTIVE_PREFIX} Your previous reply cannot be sent as-is: x.` }),
        OPTS,
      ).modes,
    ).toEqual(['screen_repair']);
    expect(gradeRow(row({ reply: 'The system check passed.' }), OPTS).modes).toEqual([]);
  });

  it('help_roundtrip, placeholder_argument and repeated_call from the forge argv', () => {
    expect(gradeRow(row({ toolCalls: [forge('issue', '-h')] }), OPTS).modes).toEqual([
      'help_roundtrip',
    ]);
    expect(gradeRow(row({ toolCalls: [forge('issue', 'ISS-<n>')] }), OPTS).modes).toEqual([
      'placeholder_argument',
    ]);
    expect(
      gradeRow(row({ toolCalls: [forge('issue', 'ISS-7'), forge('issue', 'ISS-7')] }), OPTS).modes,
    ).toEqual(['repeated_call']);
  });

  it('wrong_link_shape for a bad link; dead_link only with lookups, a UUID link unjudged without', () => {
    expect(gradeRow(row({ reply: 'see /projects/qa/issues/ISS-7' }), OPTS).modes).toEqual([
      'wrong_link_shape',
    ]);
    expect(gradeRow(row({ reply: `see #/projects/qa/issues/${UUID}` }), OPTS).modes).toEqual([
      'wrong_link_shape',
    ]);
    expect(gradeRow(row({ reply: `see /projects/qa/issues/${UUID}` }), OPTS).modes).toEqual([]);
    expect(
      gradeRow(row({ reply: `see /projects/qa/issues/${UUID}` }), {
        ...OPTS,
        lookups: { [UUID]: 'dead' },
      }).modes,
    ).toEqual(['dead_link']);
    expect(
      gradeRow(row({ reply: `see /projects/qa/issues/${UUID}` }), {
        ...OPTS,
        lookups: { [UUID]: 'resolves' },
      }).modes,
    ).toEqual([]);
  });

  it('language_mismatch for a Vietnamese question answered with no Vietnamese word, not for English', () => {
    // cm:ignore CM001 - a Vietnamese question is the fixture the rule is about
    const vi = 'Dự án này có bao nhiêu issue đang mở?'; // i18n-allow: test fixture
    expect(gradeRow(row({ query: vi, reply: 'There are 3 open issues.' }), OPTS).modes).toEqual([
      'language_mismatch',
    ]);
    // cm:ignore CM001 - the Vietnamese answer that passes
    expect(
      gradeRow(row({ query: vi, reply: 'Dự án hiện có 3 issue đang mở.' }), OPTS).modes, // i18n-allow: test fixture
    ).toEqual([]);
    expect(
      gradeRow(row({ query: 'Nguyễn asked: how many?', reply: 'Three.' }), OPTS).modes, // i18n-allow: test fixture
    ).toEqual([]);
  });

  it('over_budget by duration or by iterations at the values given', () => {
    expect(gradeRow(row({ durationMs: 61_000 }), OPTS).modes).toEqual(['over_budget']);
    expect(gradeRow(row({ iterations: 9 }), OPTS).modes).toEqual(['over_budget']);
    expect(
      gradeRow(row({ durationMs: 61_000 }), { budgetSeconds: 120, maxIterations: 8 }).modes,
    ).toEqual([]);
  });

  it('every history mode has a planted row above that produces it', () => {
    const produced = new Set([
      ...gradeRow(row({ reply: emptyFallbackReply('b') }), OPTS).modes,
      ...gradeRow(row({ reply: null }), OPTS).modes,
      ...gradeRow(row({ query: `${CORRECTIVE_PREFIX} x` }), OPTS).modes,
      ...gradeRow(row({ toolCalls: [forge('-h'), forge('ISS-?'), forge('a'), forge('a')] }), OPTS)
        .modes,
      ...gradeRow(row({ reply: '/projects/qa/issues/ISS-7' }), OPTS).modes,
      ...gradeRow(row({ reply: `/projects/qa/issues/${UUID}` }), {
        ...OPTS,
        lookups: { [UUID]: 'dead' },
      }).modes,
      ...gradeRow(row({ query: 'Dự án này có bao nhiêu issue đang mở?', reply: 'Three.' }), OPTS) // i18n-allow: test fixture
        .modes,
      ...gradeRow(row({ iterations: 99 }), OPTS).modes,
    ]);
    expect([...produced].sort()).toEqual([...HISTORY_MODES].sort());
  });
});
