// What a room is told when an Agent session wrote a reply and the screen held it (dev, 2026-10-08:
// conversation 218168c7 was told the session "ended without an answer" while the reply sat in the
// transcript). The screen runs for real; the database, the transcript store and the room are fakes.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { facts } from '../messaging/facts.js';

const stamps: Array<{ field: string; value: unknown }> = [];
const delivered: string[] = [];
const recorded: string[] = [];
let deliver: ((session: unknown) => Promise<void>) | null = null;
let transcript: unknown[] = [];

vi.mock('../agent-sessions/index.js', async () => {
  const { messageRoleToTurnRole } = await import('../agent-sessions/turns-helpers.js');
  return {
    messageRoleToTurnRole,
    claimSessionMarker: async () => true,
    readTranscript: async () => transcript,
    stampSessionMarker: async (_id: string, _key: string, stamp: Record<string, unknown>) => {
      for (const [field, value] of Object.entries(stamp)) stamps.push({ field, value });
    },
    setSessionMarkerField: async (_id: string, _key: string, field: string, value: unknown) => {
      stamps.push({ field, value });
    },
    provideTerminalSessionBridge: (_marker: string, fn: (s: unknown) => Promise<void>) => {
      deliver = fn;
    },
  };
});

vi.mock('../messaging/gather.js', () => ({
  gatherFacts: async () =>
    facts({
      prefix: 'ISS',
      prefixes: ['ISS'],
      knownIssueIds: new Set(['f4a82b24-bb6b-48b4-913f-8ba57f5af4e2']),
      knownIssueSeqs: new Set([395]),
      issueRows: new Map([[395, { seq: 395, merged: false, status: 'draft' }]]),
      progress: { total: 394, shipped: 345, inFlight: 0, remaining: 44, closedUnshipped: 5 },
    }),
}));

vi.mock('./conversation-agent-failover.js', () => ({
  redispatchConversationAgentTurn: async () => ({ ok: false, status: 'exhausted' }),
}));

vi.mock('./transcript.js', () => ({
  recordDeliveredReply: async (row: { text: string }) => {
    recorded.push(row.text);
  },
}));

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

const HELD = readFileSync(
  new URL('../../tests/fixtures/messaging/held-agent-reply-iss-395.txt', import.meta.url),
  'utf8',
).trim();
const FAILED = 'the session ended without an answer (the door failure sentence)';

function session(status: string) {
  return {
    id: '92e53ef1-2ffd-4b4d-bb6e-03213f8f995f',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    status,
    failureReason: status === 'completed' ? null : 'timeout',
    metadata: {
      conversationAgent: {
        door: 'web-agent-completion',
        venue: { adapter: 'web', externalId: 'r-1', shape: 'direct', projectId: 'p-1' },
        conversationId: '218168c7-41da-4ec2-9f3a-903d5af29aeb',
        windowId: 'w-1',
        deliveryKey: 'window:w-1',
        asker: { userId: 'u-asker', viaTokenId: null },
        replies: { ack: null, dedup: 'd', failed: FAILED, noDevice: 'n' },
      },
    },
  };
}

const said = (content: string) => [{ type: 'assistant', content, toolCalls: [] }];
const stamped = (field: string) => stamps.filter((s) => s.field === field).map((s) => s.value);

beforeEach(() => {
  stamps.length = 0;
  delivered.length = 0;
  recorded.length = 0;
});

describe('a reply the screen holds is never reported as no reply', () => {
  it('tells the room the reply was held and why, and keeps the reply on the session marker', async () => {
    transcript = said('Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.'); // i18n-allow: an empty promise the screen holds
    await deliver?.(session('completed'));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toBe(FAILED);
    expect(delivered[0]).toMatch(/^The agent wrote a reply, but the reply check held it back\./);
    expect(delivered[0]).toContain('(no-empty-promise)');
    expect(delivered[0]).toContain('Show the held reply');
    expect(recorded).toEqual(delivered);

    const [held] = stamped('held') as Array<{ text: string; refusals: Array<{ rule: string }> }>;
    expect(held?.text).toBe('Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.'); // i18n-allow: the held reply, kept as written
    expect(held?.refusals.map((r) => r.rule)).toEqual(['no-empty-promise']);
    expect(stamped('failure')).toEqual([]);
  });

  it('delivers the reply of 2026-10-08 itself, since the screen now passes it', async () => {
    transcript = said(HELD);
    await deliver?.(session('completed'));
    expect(delivered).toEqual([HELD]);
    expect(stamped('held')).toEqual([]);
    expect(stamped('failure')).toEqual([]);
  });

  it('keeps the failure sentence for a session that left no reply at all', async () => {
    transcript = [];
    await deliver?.(session('completed'));
    expect(delivered).toEqual([FAILED]);
    expect(stamped('failure')).toEqual(['the session finished without writing a reply']);

    stamps.length = 0;
    delivered.length = 0;
    await deliver?.(session('timed_out'));
    expect(delivered).toEqual([FAILED]);
    expect(stamped('failure')).toEqual(['the session ended timed_out']);
    expect(stamped('held')).toEqual([]);
  });
});

describe('a held reply reads back as held, and only its asker reads the reply', () => {
  it('reads the marker the bridge stamped as a held turn with its reason', async () => {
    const { readConversationAgentMeta } = await import('./conversation-agent-meta.js');
    const { agentTurnRow } = await import('./conversation-agent-read.js');
    transcript = said('Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.'); // i18n-allow: an empty promise the screen holds
    await deliver?.(session('completed'));
    const base = session('completed').metadata.conversationAgent;
    const meta = readConversationAgentMeta({
      conversationAgent: {
        ...base,
        claimedAt: '2026-10-08T03:48:42.195Z',
        deliveredAt: '2026-10-08T03:48:42.209Z',
        held: stamped('held')[0],
      },
    });
    if (!meta) throw new Error('the stamped marker did not read back');
    const row = { id: 's-1', status: 'completed', runtimeState: null };

    const asker = agentTurnRow(row, meta, 'u-asker');
    expect(asker.state).toBe('held');
    expect(asker.reason).toBeNull();
    expect(asker.held?.reason).toContain('(no-empty-promise)');
    expect(asker.held?.reply).toContain('báo lại bạn sau'); // i18n-allow: the held reply, kept as written

    const other = agentTurnRow(row, meta, 'u-someone-else');
    expect(other.state).toBe('held');
    expect(other.held?.reason).toBe(asker.held?.reason);
    expect(other.held?.reply).toBeNull();
    expect(agentTurnRow(row, meta, null).held?.reply).toBeNull();
  });
});
