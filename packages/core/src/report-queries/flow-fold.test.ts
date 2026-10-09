import { describe, expect, it } from 'vitest';
import type { IssueFlow } from '../issues/index.js';
import { movesByIssue, periodPair, statusAt, timeInStatus } from './flow-fold.js';
import { provenKeys } from './period-progress.js';

const H = 3_600_000;
const T0 = new Date('2026-10-01T00:00:00Z').getTime();
const at = (hours: number) => new Date(T0 + hours * H);

const flow: IssueFlow = {
  issues: [
    { id: 'a', key: 'ISS-1', title: 'a', createdAt: at(0), status: 'closed', requirementId: 'r1' },
    { id: 'b', key: 'ISS-2', title: 'b', createdAt: at(5), status: 'open', requirementId: null },
  ],
  moves: [
    { issueId: 'a', from: 'open', to: 'in_progress', at: at(2) },
    { issueId: 'a', from: 'in_progress', to: 'awaiting_release', at: at(6) },
    { issueId: 'a', from: 'awaiting_release', to: 'closed', at: at(8) },
  ],
};

describe('where an issue stood', () => {
  const moves = movesByIssue(flow);
  const a = flow.issues[0] as IssueFlow['issues'][number];
  const b = flow.issues[1] as IssueFlow['issues'][number];

  it('is nothing before it was filed, the first move left status before it moved, then each move', () => {
    expect(statusAt(b, [], at(4))).toBeNull();
    expect(statusAt(a, moves.get('a') ?? [], at(1))).toBe('open');
    expect(statusAt(a, moves.get('a') ?? [], at(2))).toBe('in_progress');
    expect(statusAt(a, moves.get('a') ?? [], at(9))).toBe('closed');
  });

  it('is its status now where it never moved', () => {
    expect(statusAt(b, [], at(9))).toBe('open');
  });
});

describe('time in each status', () => {
  it('sums each status over the window, clipped to it, leaving out the statuses work is over at', () => {
    const held = timeInStatus(flow, { from: at(1), until: at(10) });
    expect(Object.fromEntries(held)).toEqual({
      open: 1 * H + 5 * H, // a 1h..2h, b 5h..10h
      in_progress: 4 * H,
      awaiting_release: 2 * H,
    });
  });

  it('pairs a period with the one before it, end to end', () => {
    const { current, previous } = periodPair(7, at(24 * 14));
    expect(previous.until).toEqual(current.from);
    expect(current.from.getTime() - previous.from.getTime()).toBe(7 * 24 * H);
  });
});

describe('proven against its criteria', () => {
  const coverage = (code: string, verdict: string, issues: string[]) => ({
    code,
    body: code,
    verdict,
    issues: issues.map((displayId) => ({ displayId })),
    uncoveredReason: null,
  });
  const list = [
    {
      id: 'r1',
      key: 'REQ-1',
      title: 'r',
      standing: {
        coverage: [
          coverage('BC-1', 'passing', ['ISS-1', 'ISS-2']),
          coverage('BC-2', 'failing', ['ISS-2']),
          coverage('BC-3', 'passing', ['ISS-3']),
        ],
      },
    },
  ] as never;

  it('is an issue every criterion it traces reads passing; one failing criterion is enough to fall short', () => {
    expect([...provenKeys(list)].sort()).toEqual(['ISS-1', 'ISS-3']);
  });
});
