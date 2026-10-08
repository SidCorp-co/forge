// What a room is told when an Agent session wrote a reply and the screen held it (dev, 2026-10-08:
// conversation 218168c7 was told the session "ended without an answer" while the reply sat in the
// transcript), and what becomes of the blocks the session posted over REST meanwhile: released with a
// reply that passes, held with one that is held, dropped by name with none (REQ-32 criteria 5 and 6).
// The screen runs for real; the database, the transcript store and the room are fakes.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedBlock } from '../lib/staged-block.js';
import { facts } from '../messaging/facts.js';

const stamps: Array<{ field: string; value: unknown }> = [];
const delivered: string[] = [];
const released: unknown[][] = [];
let staged: StagedBlock[] = [];
const recorded: string[] = [];
let deliver: ((session: unknown) => Promise<void>) | null = null;
let transcript: unknown[] = [];
let issueLookupFailed = false;

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
      ...(issueLookupFailed ? { issueLookupFailed: true } : {}),
    }),
}));

vi.mock('./conversation-agent-stage.js', () => ({
  agentTurnOfSession: async () => ({
    found: true,
    answersRoom: true,
    turn: { conversationId: 'c', question: 'q', settled: true, staged },
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
  deliver: async (_venue, message, opts) => {
    delivered.push(message.text);
    released.push([...(opts?.blocks ?? [])]);
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

const DISPATCHED = new Date('2026-10-08T12:00:00.000Z');

/** A session that ended `status` under `failureReason`, `waitedMs` after it was dispatched. */
function session(
  status: string,
  failureReason: string | null = status === 'completed' ? null : 'unclassified',
  waitedMs = 0,
  acked = false,
) {
  return {
    id: '92e53ef1-2ffd-4b4d-bb6e-03213f8f995f',
    projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
    status,
    failureReason,
    createdAt: DISPATCHED,
    dispatchedAt: DISPATCHED,
    updatedAt: new Date(+DISPATCHED + waitedMs),
    metadata: {
      ...(acked ? { acked: true } : {}),
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
  released.length = 0;
  staged = [];
  recorded.length = 0;
  issueLookupFailed = false;
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
    await deliver?.(session('failed', 'provider_overloaded'));
    expect(delivered).toEqual([FAILED]);
    expect(stamped('failure')).toEqual(['the session ended failed']);
    expect(stamped('held')).toEqual([]);
  });
});

// REQ-30 BC-9, chat-turn step `crash`: a crash and a timeout are told apart, each with its next step,
// and neither is the door's "ended without an answer" sentence (ISS-440).
describe('a session that left no reply reads as what ended it', () => {
  const MIN = 60_000;

  it.each([
    ['agent_exited_without_result', 'it exited without writing a result'],
    ['agent_killed', 'it was killed by a signal'],
    ['agent_startup_failed', 'it died while starting'],
    ['session_lost', 'it died without reporting back'],
    ['runner_unreachable', 'its box stopped answering'],
  ])('a session failed %s reads as a crash, with the next step', async (cause, how) => {
    transcript = [];
    await deliver?.(session('failed', cause));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toBe(FAILED);
    expect(delivered[0]).not.toMatch(/ended without an answer/);
    expect(delivered[0]).toBe(
      `The Agent session crashed: ${how}. Send your message again: a new turn starts a fresh session. If it crashes again, the session's page in Forge names the cause.`,
    );
    expect(stamped('failure')).toEqual([`the Agent session crashed: ${how}`]);
  });

  it.each([
    ['no_client_ack', 3 * MIN, false, 'no box started a session for it within 3 minutes'],
    [
      'no_client_ack',
      2 * MIN,
      true,
      'the box took it but did not start its session within 90 seconds',
    ],
    ['queue_timeout', 2 * MIN, false, 'no box picked it up within 2 minutes'],
    ['heartbeat_timeout', 3 * MIN, false, 'its session sent no heartbeat for 3 minutes'],
    [
      'turn_never_reported',
      4 * MIN,
      false,
      'the box claimed it, then reported nothing for 3 minutes',
    ],
  ])(
    'a session failed %s after its limit reads as a timeout naming the limit',
    async (cause, waited, acked, clause) => {
      transcript = [];
      await deliver?.(session('failed', cause, waited, acked));
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).not.toBe(FAILED);
      expect(delivered[0]).toBe(
        `The Agent turn timed out: ${clause}. Send your message again. If it times out again, check that forge-runner is running and online on the paired box.`,
      );
      expect(stamped('failure')).toEqual([`the Agent turn timed out: ${clause}`]);
    },
  );

  it('names the limit in force, not a default: a core set to wait 10 minutes says 10 minutes', async () => {
    vi.stubEnv('PIPELINE_HEARTBEAT_TIMEOUT_MS', String(10 * MIN));
    try {
      transcript = [];
      await deliver?.(session('failed', 'no_client_ack', 11 * MIN));
      expect(delivered[0]).toContain('no box started a session for it within 10 minutes');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a timeout cause written before its limit ran out is not called a timeout: the turn never reached the box', async () => {
    transcript = [];
    await deliver?.(session('failed', 'no_client_ack', 400));
    expect(delivered[0]).toMatch(/^The Agent turn never reached its box: /);
    expect(delivered[0]).not.toMatch(/timed out|ended without an answer/);
  });

  it('a box that cannot confine reads as that, with what the box holder can do', async () => {
    transcript = [];
    await deliver?.(session('failed', 'box_cannot_confine_chat'));
    expect(delivered[0]).toMatch(/cannot confine a chat session, so nothing ran/);
    expect(delivered[0]).toContain('The box holder can run `forge-runner doctor`');
    expect(delivered[0]).not.toMatch(/ended without an answer|No paired device is free/);
  });

  it('a reply the screen held is still read as held, whatever cause the session row carries', async () => {
    transcript = said('Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.'); // i18n-allow: an empty promise the screen holds
    await deliver?.({ ...session('completed'), failureReason: 'agent_killed' });
    expect(delivered[0]).toMatch(/^The agent wrote a reply, but the reply check held it back\./);
    expect(stamped('failure')).toEqual([]);
  });
});

// REQ-30 BC-9 as d9ed95b57 words it for Assistant mode: a check that could not run is a failure on
// Forge's side, so the held notice names the check and why, never a rule the reply broke.
describe('a reply held because a check could not run', () => {
  it('names the check and why, and never says the reply broke it', async () => {
    issueLookupFailed = true;
    transcript = said('ISS-395 is merged and closed.');
    await deliver?.(session('completed'));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^The agent wrote a reply, but the reply check held it back./);
    expect(delivered[0]).toContain(
      "check could not run, because the issues it names could not be read from the tracker this turn; this failed on Forge's side and is not about the reply.",
    );
    expect(delivered[0]).not.toMatch(/It broke the rule/);
    const [held] = stamped('held') as Array<{ refusals: Array<{ unchecked?: string }> }>;
    expect(held?.refusals.every((r) => typeof r.unchecked === 'string')).toBe(true);
  });
});

describe('a failed turn row carries the next step its own cause calls for', () => {
  it('a crash, a timeout and a box that cannot confine each name their own; an unnamed ending keeps the generic one', async () => {
    const { readConversationAgentMeta } = await import('./conversation-agent-meta.js');
    const { agentTurnRow } = await import('./conversation-agent-read.js');
    const failedMeta = readConversationAgentMeta({
      conversationAgent: {
        ...session('failed').metadata.conversationAgent,
        claimedAt: '2026-10-08T12:00:01.000Z',
        deliveredAt: '2026-10-08T12:00:01.000Z',
        failure: 'stamped by the bridge',
      },
    });
    if (!failedMeta) throw new Error('the stamped marker did not read back');
    const next = (cause: string, waited = 0) =>
      agentTurnRow(
        { ...session('failed', cause, waited), id: 's-1', runtimeState: null },
        failedMeta,
        null,
      );

    expect(next('agent_killed').state).toBe('failed');
    expect(next('agent_killed').nextStep).toMatch(
      /^Send your message again: a new turn starts a fresh session\./,
    );
    expect(next('queue_timeout', 3 * 60_000).nextStep).toMatch(/If it times out again/);
    expect(next('box_cannot_confine_chat').nextStep).toMatch(
      /^The box holder can run `forge-runner doctor`/,
    );
    expect(next('box_cannot_confine_chat').nextStep).not.toMatch(
      /ask again to start a fresh session/i,
    );
    expect(next('provider_overloaded').nextStep).toBeNull();
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
    const row = { ...session('completed'), id: 's-1', runtimeState: null };

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

const table: StagedBlock = {
  text: '| Requirement |\n| --- |\n| REQ-1 |',
  block: {
    type: 'visual',
    visual: { v: 1, kind: 'table', columns: ['key'], source: { runId: 'run-1' } },
    run: {
      runId: 'run-1',
      queryId: 'progress-by-requirement',
      version: 1,
      asOf: '2026-10-08T09:30:00.000Z',
    },
  },
  kind: 'table',
  runId: 'run-1',
  projectId: 'p-1',
  askerUserId: 'u-asker',
};

describe('the blocks an Agent session posted wait on its reply', () => {
  it('are released with a reply that passes, posted with it and not before', async () => {
    staged = [table];
    transcript = said(HELD);
    await deliver?.(session('completed'));
    expect(delivered).toEqual([HELD]);
    expect(released).toEqual([[table]]);
    expect(stamped('droppedBlocks')).toEqual([]);
  });

  it('are held with a held reply: never posted, kept on the held reply, and read back by its asker alone', async () => {
    const { readConversationAgentMeta } = await import('./conversation-agent-meta.js');
    const { agentTurnRow } = await import('./conversation-agent-read.js');
    staged = [table];
    transcript = said('Mình sẽ kiểm tra lại độ rộng panel và báo lại bạn sau.'); // i18n-allow: an empty promise the screen holds
    await deliver?.(session('completed'));
    expect(released).toEqual([[]]);
    const [held] = stamped('held') as Array<{ blocks: StagedBlock[] }>;
    expect(held?.blocks).toEqual([table]);

    const meta = readConversationAgentMeta({
      conversationAgent: { ...session('completed').metadata.conversationAgent, held, staged },
    });
    if (!meta) throw new Error('the stamped marker did not read back');
    const row = { ...session('completed'), id: 's-1', runtimeState: null };
    expect(agentTurnRow(row, meta, 'u-asker').held?.blocks).toEqual([table.block]);
    expect(agentTurnRow(row, meta, 'u-someone-else').held?.blocks).toBeNull();
    expect(agentTurnRow(row, meta, null).held?.blocks).toBeNull();
  });

  it('are dropped by name when the session left no reply, and never posted', async () => {
    staged = [table];
    transcript = [];
    await deliver?.(session('completed'));
    expect(delivered).toEqual([FAILED]);
    expect(released).toEqual([[]]);
    expect(stamped('droppedBlocks')).toEqual([
      [
        {
          kind: 'table',
          runId: 'run-1',
          why: 'no reply went out: the session finished without writing a reply',
        },
      ],
    ]);
  });
});
