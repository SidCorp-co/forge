// An Agent reply is judged by the reads its session made, as an Assistant reply is by its tools
// (REQ-30 BC-1, BC-2; chat-turn design, step `check`). The session reads the project through
// `forge-runner api`, so before this the screen saw only `Bash`: a status claim with no read behind
// it went out, and a figure read from the status grounded nothing. The bridge and the screen run for
// real; the transcript store, the room and the database reads are fakes.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideMessageReads } from '../messaging/reads.js';

const PID = 'd1bb4907-74d9-4228-85ff-76121523af7d';
const delivered: string[] = [];
const held: Array<{ refusals: Array<{ rule: string }> }> = [];
let deliver: ((session: unknown) => Promise<void>) | null = null;
let transcript: unknown[] = [];

vi.mock('../agent-sessions/index.js', async () => {
  const { messageRoleToTurnRole } = await import('../agent-sessions/turns-helpers.js');
  return {
    messageRoleToTurnRole,
    claimSessionMarker: async () => true,
    readTranscript: async () => transcript,
    stampSessionMarker: async () => {},
    setSessionMarkerField: async (_id: string, _key: string, field: string, value: unknown) => {
      if (field === 'held') held.push(value as (typeof held)[number]);
    },
    provideTerminalSessionBridge: (_marker: string, fn: (s: unknown) => Promise<void>) => {
      deliver = fn;
    },
  };
});

vi.mock('./conversation-agent-stage.js', () => ({
  agentTurnOfSession: async () => ({
    found: true,
    answersRoom: true,
    turn: { conversationId: 'c', question: 'q', settled: true, staged: [] },
  }),
}));

vi.mock('./conversation-agent-failover.js', () => ({
  redispatchConversationAgentTurn: async () => ({ ok: false, status: 'exhausted' }),
}));

vi.mock('./transcript.js', () => ({ recordDeliveredReply: async () => {} }));

const { registerConversationAgentBridge } = await import('./conversation-agent-bridge.js');
const { registerConversationTransport } = await import('./ports.js');

registerConversationTransport({
  adapter: 'web',
  deliver: async (_venue, message) => {
    delivered.push(message.text);
    return { messageId: 'm-1' };
  },
  fetchHistory: async () => [],
});
registerConversationAgentBridge();

beforeAll(() => {
  provideMessageReads({
    activeIssuePrefix: async () => 'ISS',
    heldIssuePrefixes: async () => [],
    citedIssues: async () => [
      { id: 'f4a82b24-bb6b-48b4-913f-8ba57f5af4e2', issSeq: 395, mergedAt: null, status: 'draft' },
    ],
    workflowDesign: async () => ({ kind: 'missing', flows: [] }),
    contractHolding: async () => ({ projectSlug: 'p', versions: [], named: false }),
    readsTechnical: async () => true,
    reportRunFrames: async () => [],
    agreedRecords: async () => [],
  });
});

beforeEach(() => {
  delivered.length = 0;
  held.length = 0;
});

function session() {
  return {
    id: '92e53ef1-2ffd-4b4d-bb6e-03213f8f995f',
    projectId: PID,
    status: 'completed',
    failureReason: null,
    createdAt: new Date('2026-10-08T12:00:00.000Z'),
    dispatchedAt: new Date('2026-10-08T12:00:00.000Z'),
    updatedAt: new Date('2026-10-08T12:00:00.000Z'),
    metadata: {
      conversationAgent: {
        door: 'web-agent-completion',
        venue: { adapter: 'web', externalId: 'r-1', shape: 'direct', projectId: PID },
        conversationId: '218168c7-41da-4ec2-9f3a-903d5af29aeb',
        windowId: 'w-1',
        deliveryKey: 'window:w-1',
        question: 'Where does the project stand?',
        asker: { userId: 'u-asker', viaTokenId: null },
        replies: { ack: null, dedup: 'd', failed: 'f', noDevice: 'n' },
      },
    },
  };
}

const STATUS_OUT = JSON.stringify({
  shipped: { releaseCount: 2, releases: [{ version: '0.4.0-dev.209' }] },
  inFlight: { total: 12 },
});

/** A shell call the session made, settled with what it returned. */
const bash = (command: string, output: string, isError = false) => ({
  id: `t-${command.length}`,
  name: 'Bash',
  input: { command },
  output,
  ...(isError ? { isError: true } : {}),
});

const STATUS_READ = bash(`forge-runner api projects/${PID}/status`, STATUS_OUT);

/** A transcript in which the session made `calls`, then wrote `reply`. */
function turn(reply: string, calls: unknown[] = []) {
  transcript = [
    ...(calls.length > 0 ? [{ type: 'assistant', content: '', toolCalls: calls }] : []),
    { type: 'assistant', content: reply, toolCalls: [] },
  ];
}

const heldRules = () => held.flatMap((h) => h.refusals.map((r) => r.rule));

describe('a status claim in Agent mode rests on a read of this turn', () => {
  const CLAIM = 'Release 0.4.0-dev.209 shipped to users yesterday, per the project status.';

  it('is held with no read behind it', async () => {
    turn(CLAIM);
    await deliver?.(session());
    expect(heldRules()).toContain('status-claims-grounded');
    expect(delivered[0]).toMatch(/^The agent wrote a reply, but the reply check held it back\./);
  });

  it('is held when the read was refused, or read something else', async () => {
    turn(CLAIM, [bash(`forge-runner api projects/${PID}/status`, 'refused', true)]);
    await deliver?.(session());
    expect(heldRules()).toContain('status-claims-grounded');
    held.length = 0;
    turn(CLAIM, [bash('git log --oneline -5', 'a7e07ef0a Release dev-v0.4.0-dev.209')]);
    await deliver?.(session());
    expect(heldRules()).toContain('status-claims-grounded');
  });

  it('is delivered once the session read the status over REST', async () => {
    turn(CLAIM, [STATUS_READ]);
    await deliver?.(session());
    expect(held).toEqual([]);
    expect(delivered).toEqual([CLAIM]);
  });

  it("holds an issue's status the session never read, as the Assistant door does", async () => {
    turn('ISS-395 is at draft.', [STATUS_READ]);
    await deliver?.(session());
    expect(heldRules()).toContain('tracker-facts-grounded');
  });
});

describe('a figure in Agent mode', () => {
  it('read from the status over REST, and named, is delivered', async () => {
    const reply = '12 issues are in flight (project status).';
    turn(reply, [STATUS_READ]);
    await deliver?.(session());
    expect(delivered).toEqual([reply]);
  });

  it('read from the status but named nowhere, is held by figures-name-source', async () => {
    turn('12 issues are in flight.', [STATUS_READ]);
    await deliver?.(session());
    expect(heldRules()).toEqual(['figures-name-source']);
  });

  it('with no read behind it, is held by figures-grounded', async () => {
    turn('12 issues are in flight (project status).');
    await deliver?.(session());
    expect(heldRules()).toContain('figures-grounded');
  });
});
