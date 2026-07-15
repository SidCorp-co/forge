import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the escalation dispatcher — dedup, device resolution, and the
// dispatch-failure safety net. Mocks the exact chat-turn machinery
// `schedules/dispatch.ts` also drives, so behaviour stays in lockstep with
// that precedent without pulling in its DB/WS graph.

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const createChatSessionRow = vi.fn();
const dispatchChatTurn = vi.fn();
const resolveChatDevice = vi.fn();
vi.mock('../../agent-sessions/chat-turn.js', () => ({
  createChatSessionRow: (...args: unknown[]) => createChatSessionRow(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurn(...args),
  resolveChatDevice: (...args: unknown[]) => resolveChatDevice(...args),
}));

const applyKernelTransition = vi.fn();
vi.mock('../../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransition(...args),
}));

const { buildEscalationPrompt, hasInFlightEscalation, startEscalation } = await import(
  './escalation.js'
);

const BASE_ARGS = {
  projectId: 'proj-1',
  project: { id: 'proj-1', slug: 'proj', repoPath: '/repo' },
  connectionId: 'conn-1',
  rid: 'room-1',
  tmid: undefined,
  botName: 'Babo',
  question: 'How does the pipeline dispatcher work?',
  askedByUsername: 'alice',
};

describe('hasInFlightEscalation', () => {
  beforeEach(() => {
    selectLimit.mockReset();
  });

  it('is true when a running escalation session exists for the room', async () => {
    selectLimit.mockResolvedValue([{ id: 'session-1' }]);
    await expect(hasInFlightEscalation('proj-1', 'room-1')).resolves.toBe(true);
  });

  it('is false when no row matches', async () => {
    selectLimit.mockResolvedValue([]);
    await expect(hasInFlightEscalation('proj-1', 'room-1')).resolves.toBe(false);
  });
});

describe('startEscalation', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    createChatSessionRow.mockReset();
    dispatchChatTurn.mockReset();
    resolveChatDevice.mockReset();
    applyKernelTransition.mockReset();
  });

  it('dedupes against an in-flight escalation for the same room without creating a session', async () => {
    selectLimit.mockResolvedValue([{ id: 'existing-session' }]);
    const result = await startEscalation(BASE_ARGS);
    expect(result).toEqual({ started: false, reason: 'deduped' });
    expect(resolveChatDevice).not.toHaveBeenCalled();
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('reports no-device without creating a session when no runner is available', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: null, isLocal: false });
    const result = await startEscalation(BASE_ARGS);
    expect(result).toEqual({ started: false, reason: 'no-device' });
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('creates a system session pinned to the product lens and dispatches the escalation prompt', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: 'device-1', isLocal: false });
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-1' });

    const result = await startEscalation(BASE_ARGS);

    expect(result).toEqual({ started: true, sessionId: 'session-1' });
    expect(createChatSessionRow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        runKind: 'system',
        metadata: expect.objectContaining({
          escalation: expect.objectContaining({
            connectionId: 'conn-1',
            rid: 'room-1',
            botName: 'Babo',
            deliveredAt: null,
          }),
          lensOverride: ['product'],
        }),
      }),
    );
    expect(dispatchChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        forceLenses: ['product'],
        broadcastEvent: 'agent-session.created',
      }),
    );
    expect(applyKernelTransition).not.toHaveBeenCalled();
  });

  it('marks the session failed via applyKernelTransition when the dispatch throws, so the bridge still fires', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: 'device-1', isLocal: false });
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockRejectedValue(new Error('ws publish failed'));
    applyKernelTransition.mockResolvedValue([{ id: 'session-1', status: 'failed' }]);

    const result = await startEscalation(BASE_ARGS);

    expect(result).toEqual({ started: false, reason: 'dispatch-failed' });
    expect(applyKernelTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity: 'session',
        to: 'failed',
        reason: 'ws-publish-failed',
      }),
    );
  });
});

describe('buildEscalationPrompt', () => {
  it('instructs the runner to curate durable understanding and answer in business language', () => {
    const prompt = buildEscalationPrompt('How does X work?');
    expect(prompt).toContain('How does X work?');
    expect(prompt).toMatch(/forge_knowledge/);
    expect(prompt).toMatch(/stable kebab-case slug/);
    expect(prompt).toMatch(/NEVER write volatile numbers/);
    expect(prompt).toMatch(/business-language/);
  });
});
