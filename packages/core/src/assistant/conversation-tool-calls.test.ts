import { describe, expect, it } from 'vitest';
import { roomToolCalls } from './conversation-tool-calls.js';

const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-10-01T08:00:00Z');

const call = (over: Record<string, unknown>) => ({
  name: 'forge_issues',
  arguments: '{"action":"get"}',
  round: 1,
  isError: false,
  durationMs: 12,
  resultPreview: 'ISS-4 is open',
  resultIssueRefs: ['ISS-4'],
  refusalCode: null,
  ...over,
});

describe('roomToolCalls', () => {
  it('carries the ranAs the audit recorded, and shows the reader the result of a call run as them', () => {
    const [c] = roomToolCalls([{ id: 't1', createdAt: at, toolCalls: [call({ ranAs: ME })] }], ME);
    expect(c).toMatchObject({ ranAsRecorded: true, ranAs: ME, resultPreview: 'ISS-4 is open' });
  });

  it("keeps another member's result theirs, while still naming who the call ran as", () => {
    const [c] = roomToolCalls(
      [{ id: 't1', createdAt: at, toolCalls: [call({ ranAs: THEM })] }],
      ME,
    );
    expect(c).toMatchObject({ ranAs: THEM, resultPreview: null, resultIssueRefs: ['ISS-4'] });
  });

  it('reads a call that acts as nobody as null, recorded', () => {
    const [c] = roomToolCalls(
      [{ id: 't1', createdAt: at, toolCalls: [call({ ranAs: null })] }],
      ME,
    );
    expect(c).toMatchObject({ ranAsRecorded: true, ranAs: null });
  });

  it('says a row audited before ranAs existed is unrecorded, never nobody, and hides its result', () => {
    const [c] = roomToolCalls([{ id: 't1', createdAt: at, toolCalls: [call({})] }], ME);
    expect(c).toMatchObject({ ranAsRecorded: false, ranAs: null, resultPreview: null });
  });

  it('skips what is not a call, and keeps the order turns and calls were made in', () => {
    const rows = [
      {
        id: 't1',
        createdAt: at,
        toolCalls: [call({ name: 'a', ranAs: ME }), 'junk', { round: 2 }],
      },
      { id: 't2', createdAt: at, toolCalls: null },
      { id: 't3', createdAt: at, toolCalls: [call({ name: 'b', ranAs: ME, refusalCode: 'X' })] },
    ];
    expect(roomToolCalls(rows, ME).map((c) => [c.turnId, c.name, c.refusalCode])).toEqual([
      ['t1', 'a', null],
      ['t3', 'b', 'X'],
    ]);
  });
});
