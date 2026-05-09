import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentAction } from '@/hooks/use-agent-message-state';

// Stub crypto.randomUUID — the error-bubble dispatch carries a fresh assistant
// message id when no streaming message yet exists.
beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'msg-1' });
});

async function loadHandler() {
  const mod = await import('@/hooks/use-agent-ws-handlers');
  return mod.createAgentMessageHandler;
}

function makeOpts() {
  const dispatch = vi.fn<(action: AgentAction) => void>();
  const sessionIdRef = { current: 'sess-1' as string | null };
  return {
    dispatch,
    opts: {
      projectSlug: 'p',
      sessionIdRef,
      dispatch,
      handlePromptBuilt: vi.fn(),
      handlePreviewPrompt: vi.fn(),
    },
  };
}

function findErrorFrame(dispatch: ReturnType<typeof vi.fn>) {
  return dispatch.mock.calls
    .map((c) => c[0] as AgentAction)
    .find(
      (a) =>
        a.type === 'streamFrame' &&
        a.blocks.length === 1 &&
        a.blocks[0].kind === 'textDelta' &&
        a.blocks[0].text.startsWith('Error: '),
    ) as Extract<AgentAction, { type: 'streamFrame' }> | undefined;
}

describe('createAgentMessageHandler — agent:complete error branch', () => {
  it('agent:complete with no error: dispatches isRunningSet(false), no error textDelta', async () => {
    const create = await loadHandler();
    const { dispatch, opts } = makeOpts();
    const handler = create(opts);

    handler({ event: 'agent:complete', data: { sessionId: 'sess-1' } });

    expect(dispatch).toHaveBeenCalledWith({ type: 'streamingDone', completeTodos: true });
    expect(dispatch).toHaveBeenCalledWith({ type: 'isRunningSet', value: false });
    expect(findErrorFrame(dispatch)).toBeUndefined();
  });

  it('agent:complete with data.error: dispatches a streamFrame containing "Error: …" text', async () => {
    const create = await loadHandler();
    const { dispatch, opts } = makeOpts();
    const handler = create(opts);

    handler({ event: 'agent:complete', data: { sessionId: 'sess-1', error: 'boom' } });

    expect(dispatch).toHaveBeenCalledWith({ type: 'isRunningSet', value: false });
    const frame = findErrorFrame(dispatch);
    expect(frame).toBeDefined();
    if (frame && frame.blocks[0].kind === 'textDelta') {
      expect(frame.blocks[0].text).toBe('Error: boom');
    }
    expect(frame?.newAssistantMessage).toBeDefined();
  });

  it('agent:error (defensive branch) with data.error: same outcome as agent:complete error', async () => {
    const create = await loadHandler();
    const { dispatch, opts } = makeOpts();
    const handler = create(opts);

    handler({ event: 'agent:error', data: { sessionId: 'sess-1', error: 'kaboom' } });

    expect(dispatch).toHaveBeenCalledWith({ type: 'isRunningSet', value: false });
    const frame = findErrorFrame(dispatch);
    expect(frame).toBeDefined();
    if (frame && frame.blocks[0].kind === 'textDelta') {
      expect(frame.blocks[0].text).toBe('Error: kaboom');
    }
  });

  it('agent:complete with both claudeSessionId and error: captures session AND surfaces error', async () => {
    const create = await loadHandler();
    const { dispatch, opts } = makeOpts();
    const handler = create(opts);

    handler({
      event: 'agent:complete',
      data: { sessionId: 'sess-1', claudeSessionId: 'claude-xyz', error: 'crashed' },
    });

    expect(dispatch).toHaveBeenCalledWith({ type: 'claudeSessionIdSet', value: 'claude-xyz' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'isRunningSet', value: false });
    expect(findErrorFrame(dispatch)).toBeDefined();
  });

  it('agent:error does NOT capture claudeSessionId (only agent:complete does)', async () => {
    const create = await loadHandler();
    const { dispatch, opts } = makeOpts();
    const handler = create(opts);

    handler({
      event: 'agent:error',
      data: { sessionId: 'sess-1', claudeSessionId: 'should-be-ignored', error: 'kaboom' },
    });

    const captured = dispatch.mock.calls
      .map((c) => c[0] as AgentAction)
      .find((a) => a.type === 'claudeSessionIdSet');
    expect(captured).toBeUndefined();
  });
});
