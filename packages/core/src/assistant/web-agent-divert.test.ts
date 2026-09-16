// The one fork, and what it hands the session it forks onto.
//
// `agent` mode runs a FRESH Claude Code session per turn, and the door it runs
// under invites a follow-up question. So the room's earlier turns have to travel
// with the dispatch: without them a person answering "the second one" reaches a
// session that never saw the first, and the reply reads as a non-sequitur nobody
// can trace (ISS-1039, commit consult F4).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../conversations/collect-inbound.js', () => ({ collectInboundMessage: () => undefined }));
vi.mock('../conversations/route-window.js', () => ({ routeWindow: () => undefined }));
vi.mock('../conversations/windows.js', () => ({
  claimDueWindows: () => [],
  claimOf: () => null,
  releaseWindow: () => undefined,
}));
vi.mock('../conversations/handles.js', () => ({ resolveProjectHandle: () => undefined }));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('./tools/registry.js', () => ({ buildProjectToolset: () => ({ tools: [] }) }));
vi.mock('./tools/principal.js', () => ({ buildChatToolContext: (a: unknown) => a }));

const startConversationAgentTurn = vi.fn(
  async (_args: { conversationContext: string | null; question: string }) => ({
    started: true,
    sessionId: 's1',
  }),
);
vi.mock('../agent-sessions/conversation-agent.js', () => ({
  startConversationAgentTurn: (a: unknown) => startConversationAgentTurn(a as never),
}));

const { webConversationTurn } = await import('./conversation-send.js');

const turn = (over: { mode: 'assistant' | 'agent'; conversationContext?: string | null }) =>
  webConversationTurn({
    project: { id: 'p1', slug: 'forge-dev', name: 'Forge', repoPath: '/repo' },
    handleName: 'Babo',
    askedBy: 'Alice',
    window: {
      venue: { adapter: 'web', externalId: 'v1', shape: 'direct', projectId: 'p1' },
      conversationId: 'c1',
      windowId: 'w1',
      deliveryKey: 'k1',
      mode: over.mode,
      question: 'the second one',
      conversationContext: async () => over.conversationContext ?? null,
      reserve: async () => true,
    },
  });

const divert = (t: ReturnType<typeof webConversationTurn>) =>
  t.divertBeforeTurn?.({ setPhase: () => undefined } as never);

describe('the fork a web conversation takes', () => {
  it('hands the room own earlier turns to the session it dispatches', async () => {
    await divert(
      turn({ mode: 'agent', conversationContext: 'Alice: which file?\nAssistant: a.ts or b.ts' }),
    );
    expect(startConversationAgentTurn).toHaveBeenCalledTimes(1);
    const args = startConversationAgentTurn.mock.calls[0]?.[0];
    expect(args?.conversationContext).toContain('a.ts or b.ts');
    // cm:guard the current question is NOT repeated into the context: the prompt builder already
    // prints it as the question being answered, and a second copy reads as it having been asked twice.
    expect(args?.conversationContext).not.toContain('the second one');
  });

  it('sends no context where the room has no earlier turn, rather than an empty block', async () => {
    startConversationAgentTurn.mockClear();
    await divert(turn({ mode: 'agent' }));
    const args = startConversationAgentTurn.mock.calls[0]?.[0];
    expect(args?.conversationContext).toBeNull();
  });

  // cm:guard the whole of the other branch: `assistant` must reach none of this, because the in-core
  // turn reads the room for itself and a dispatch here would be a second answer to one question.
  it('dispatches nothing at all in Assistant mode', async () => {
    startConversationAgentTurn.mockClear();
    expect(await divert(turn({ mode: 'assistant' }))).toBeNull();
    expect(startConversationAgentTurn).not.toHaveBeenCalled();
  });
});
