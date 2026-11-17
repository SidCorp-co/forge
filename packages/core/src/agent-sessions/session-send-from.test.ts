import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-1268 B4: every `session.send` names who it is from and the authority its words carry, so the
// box frames a master's message by it; a send naming neither is refused at the writer, never guessed.

const answers: unknown[][] = [];
let reads = 0;

/** A query builder whose every step chains, and whose await takes the next scripted answer. */
function chain(): unknown {
  return new Proxy(() => undefined, {
    get(_t, key) {
      if (key === 'then') {
        reads++;
        const next = answers.shift() ?? [];
        return (resolve: (v: unknown) => void) => resolve(next);
      }
      return () => chain();
    },
  });
}

vi.mock('../db/client.js', () => ({
  db: new Proxy({}, { get: () => () => chain() }),
}));
const pushSession = vi.fn();
vi.mock('./push.js', () => ({ pushSession: (p: unknown) => pushSession(p) }));

const { FORGE_SAYS, requestSessionSend } = await import('./session-send.js');

const base = { agentSessionId: 's-1', kind: 'inject' as const, intentId: 'i-1', body: 'hello' };

beforeEach(() => {
  answers.length = 0;
  reads = 0;
  pushSession.mockReset();
});

describe('a send names who it is from', () => {
  it('refuses a send naming no sender by name, before anything is written', async () => {
    const unnamed = { ...base } as unknown as Parameters<typeof requestSessionSend>[0];
    await expect(requestSessionSend(unnamed)).rejects.toThrow(/SESSION_SEND_FROM_MISSING/);
    expect(reads).toBe(0);
    expect(pushSession).not.toHaveBeenCalled();
  });

  it('refuses an authority outside owner, core and peer, and a blank name', async () => {
    const admin = {
      ...base,
      from: { from: 'Chuong', authority: 'admin' },
    } as unknown as Parameters<typeof requestSessionSend>[0];
    await expect(requestSessionSend(admin)).rejects.toThrow(/SESSION_SEND_FROM_MISSING/);
    await expect(
      requestSessionSend({ ...base, from: { from: '  ', authority: 'peer' } }),
    ).rejects.toThrow(/names nobody/);
    expect(reads).toBe(0);
  });

  it('carries the sender and its authority on the frame the box is sent', async () => {
    const row = {
      id: 'r-1',
      seq: 7,
      kind: 'inject',
      body: 'hello',
      sendRequestedAt: new Date(),
      sendOutcome: null,
      appliedAt: null,
    };
    // the session, no earlier row, the seq, the insert, no job
    answers.push([{ id: 's-1', deviceId: 'd-1' }], [], [{ seq: 7 }], [row], []);
    await requestSessionSend({ ...base, from: { from: 'Chuong', authority: 'owner' } });
    expect(pushSession).toHaveBeenCalledTimes(1);
    expect(pushSession.mock.calls[0]?.[0]).toMatchObject({
      event: 'session.send',
      data: { sessionId: 's-1', seq: 7, body: 'hello', from: 'Chuong', authority: 'owner' },
    });
    expect(FORGE_SAYS).toEqual({ from: 'Forge', authority: 'core' });
  });
});
