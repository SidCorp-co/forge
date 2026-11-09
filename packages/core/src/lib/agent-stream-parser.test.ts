import { describe, expect, it } from 'vitest';
import { parseStreamMessages } from './agent-stream-parser.js';

function resultOf(line: Record<string, unknown>) {
  let n = 0;
  const [message] = parseStreamMessages({ type: 'result', ...line }, () => `m${++n}`, 1).messages;
  return message;
}

describe('parseStreamMessages: a result line', () => {
  it('keeps the cost a pane could not read, and why, so it never reads as a free turn', () => {
    const message = resultOf({
      num_turns: 10,
      duration_ms: 51006,
      forge_pane: {
        tokens: 'transcript',
        cost: { unread: 'no status line stood before the turn to measure from' },
      },
    });
    expect(message?.totals?.totalCostUsd).toBeUndefined();
    expect(message?.totals?.costUnread).toBe(
      'no status line stood before the turn to measure from',
    );
    expect(message?.content).toBe(
      'Cost unread: no status line stood before the turn to measure from',
    );
  });

  it('reads a figure the line carries unchanged, with no unread reason', () => {
    const message = resultOf({
      total_cost_usd: 0.0042,
      num_turns: 1,
      forge_pane: { cost: 'status line: running total after the Stop, less the one before' },
    });
    expect(message?.totals?.totalCostUsd).toBe(0.0042);
    expect(message?.totals?.costUnread).toBeUndefined();
    expect(message?.content).toBe('Cost: $0.0042');
  });
});
