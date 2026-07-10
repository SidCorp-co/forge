import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publishSpy = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: publishSpy },
}));

const {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnEdited,
  broadcastTurnTruncated,
  flushPendingTurnBroadcasts,
} = await import('./broadcast.js');

const SESSION = {
  id: 'session-1',
  projectId: 'proj-1',
  deviceId: 'dev-1',
  status: 'running',
};

beforeEach(() => {
  publishSpy.mockClear();
  flushPendingTurnBroadcasts();
});

afterEach(() => {
  flushPendingTurnBroadcasts();
});

describe('broadcastSession', () => {
  it('publishes to project + device rooms with the supplied event/extra', () => {
    broadcastSession(SESSION, 'agent-session.updated', { foo: 'bar' });
    const rooms = publishSpy.mock.calls.map((c) => c[0]);
    expect(rooms).toEqual(['project:proj-1', 'device:dev-1']);
    const payload = publishSpy.mock.calls[0]?.[1] as {
      event: string;
      data: Record<string, unknown>;
    };
    expect(payload.event).toBe('agent-session.updated');
    expect(payload.data.foo).toBe('bar');
    expect(payload.data.sessionId).toBe('session-1');
  });

  it('skips device room when deviceId is null', () => {
    broadcastSession({ ...SESSION, deviceId: null }, 'agent-session.created');
    const rooms = publishSpy.mock.calls.map((c) => c[0]);
    expect(rooms).toEqual(['project:proj-1']);
  });
});

describe('broadcastTurnAppended', () => {
  it('fires immediately for a non-streaming append', () => {
    broadcastTurnAppended(SESSION, { turnId: 't1', turnIndex: 0, role: 'user' });
    const events = publishSpy.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toEqual(['agent-session.turn.appended', 'agent-session.turn.appended']); // project+device
  });

  it('debounces streaming-tail appends to the trailing one', async () => {
    vi.useFakeTimers();
    broadcastTurnAppended(
      SESSION,
      { turnId: 't2', turnIndex: 1, role: 'assistant' },
      { isStreamingTail: true },
    );
    broadcastTurnAppended(
      SESSION,
      { turnId: 't3', turnIndex: 2, role: 'assistant' },
      { isStreamingTail: true },
    );
    expect(publishSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    const ids = publishSpy.mock.calls.map(
      (c) => (c[1] as { data: { turnId: string } }).data.turnId,
    );
    expect(ids).toContain('t3');
    expect(ids).not.toContain('t2');
    vi.useRealTimers();
  });
});

describe('broadcastTurnEdited / broadcastTurnTruncated', () => {
  it('emit the right event names', () => {
    broadcastTurnEdited(SESSION, 't9');
    broadcastTurnTruncated(SESSION, 4);
    const events = publishSpy.mock.calls.map((c) => (c[1] as { event: string }).event);
    expect(events).toContain('agent-session.turn.edited');
    expect(events).toContain('agent-session.turn.truncated');
  });
});
