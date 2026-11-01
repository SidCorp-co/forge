// ISS-857: what a room is shown when an Agent turn left no reply is a last resort, so it is short and
// in the words a person uses: what happened and what to do, no operator's vocabulary. The cause in
// full stays on the turn's record (`reason`), where the people who run the boxes read it.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../jobs/index.js', () => ({
  getLoopThresholds: () => ({ queueMs: 120_000, heartbeatMs: 180_000, ackFastMs: 90_000 }),
}));

const { AGENT_TURN_NEXT_STEP, agentTurnFailure, agentTurnFailureText } = await import(
  './conversation-agent-failure.js'
);

const MIN = 60_000;
const ended = (failureReason: string, waitedMs = 0, acked = false) => ({
  status: 'failed',
  failureReason,
  metadata: { acked },
  createdAt: new Date(0),
  dispatchedAt: new Date(0),
  updatedAt: new Date(waitedMs),
});

/** Words a person reading the room should never need: they name our machinery, not their turn. */
const JARGON =
  /forge-runner|\brunner\b|\bbox\b|\bdevice\b|\bpaired\b|\bbwrap\b|bubblewrap|\bdoctor\b|heartbeat|session|`/i;

const READINGS = [
  ['a crash', ended('agent_killed')],
  ['a box that stopped answering', ended('runner_unreachable')],
  ['a timeout', ended('queue_timeout', 3 * MIN)],
  ['a turn that never reached its box', ended('no_client_ack', 400)],
  ['a box that cannot confine a chat', ended('box_cannot_confine_chat')],
] as const;

describe('the line a room is shown for an Agent turn that left no reply', () => {
  it.each(READINGS)('names %s in plain words, with no operator jargon', (_name, session) => {
    const failure = agentTurnFailure(session);
    if (!failure) throw new Error('the cause was not read');
    const text = agentTurnFailureText(failure);
    expect(text).not.toMatch(JARGON);
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it('keeps the cause in full on the record', () => {
    expect(agentTurnFailure(ended('queue_timeout', 3 * MIN))?.reason).toBe(
      'the Agent turn timed out: no box picked it up within 2 minutes',
    );
  });

  it('every next step reads without operator jargon', () => {
    for (const next of Object.values(AGENT_TURN_NEXT_STEP)) expect(next).not.toMatch(JARGON);
  });
});
