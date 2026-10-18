import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateReturning, updateSet, insertValues } = vi.hoisted(() => ({
  updateReturning: vi.fn(),
  updateSet: vi.fn(),
  insertValues: vi.fn(),
}));

vi.mock('../db/client.js', () => {
  const tx = {
    execute: vi.fn(async () => []),
    update: () => ({
      set: (v: unknown) => {
        updateSet(v);
        return { where: () => ({ returning: updateReturning }) };
      },
    }),
    insert: () => ({ values: insertValues }),
  };
  return { db: { ...tx, transaction: async (fn: (t: unknown) => unknown) => fn(tx) } };
});

import { endChatTurn } from './turn-end.js';

const ACTOR = { type: 'user' as const, id: 'u1', agency: 'human' as const };
const row = (kind: string, status: string) => ({ id: 's1', kind, status }) as never;

async function refusal(
  call: Promise<unknown>,
): Promise<{ status: number; code: unknown; message: string }> {
  try {
    await call;
  } catch (err) {
    if (err instanceof HTTPException) {
      return {
        status: err.status,
        code: (err.cause as { code?: unknown })?.code,
        message: err.message,
      };
    }
    throw err;
  }
  throw new Error('endChatTurn answered where it was to refuse');
}

beforeEach(() => {
  updateReturning.mockReset();
  updateSet.mockReset();
  insertValues.mockReset();
});

// ISS-1228 round 15 (judge-39): End this turn on a run session set it idle, so it read "Not started"
// while its agent ran on and its reaper never ended it; the box ends a chat's turn and nothing else.
describe('endChatTurn', () => {
  it.each([
    ['a live run session', 'run_session', 'running'],
    ['an ended run session', 'run_session', 'failed'],
    ['a live master', 'master', 'running'],
    ['a pipeline session', 'pipeline', 'running'],
  ])(
    'refuses %s with 409 TURN_NOT_ENDABLE, naming its kind, and writes nothing',
    async (_n, kind, status) => {
      const r = await refusal(endChatTurn(row(kind, status), ACTOR));
      expect(r).toMatchObject({ status: 409, code: 'TURN_NOT_ENDABLE' });
      expect(r.message).toContain(`This is a ${kind} session, not a chat`);
      expect(updateSet).not.toHaveBeenCalled();
    },
  );

  it('refuses an ended chat with 409 SESSION_ENDED and writes nothing', async () => {
    expect(await refusal(endChatTurn(row('chat', 'completed'), ACTOR))).toMatchObject({
      status: 409,
      code: 'SESSION_ENDED',
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('refuses with SESSION_ENDED where the chat ended between the read and the write', async () => {
    updateReturning.mockResolvedValueOnce([]);
    expect(await refusal(endChatTurn(row('chat', 'running'), ACTOR))).toMatchObject({
      code: 'SESSION_ENDED',
    });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('leaves a running chat idle and records the move from the status it read', async () => {
    updateReturning.mockResolvedValueOnce([{ id: 's1', kind: 'chat', status: 'idle' }]);
    const out = await endChatTurn(row('chat', 'running'), ACTOR);
    expect(out.status).toBe('idle');
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'idle' }));
    expect(insertValues).toHaveBeenCalledWith([
      expect.objectContaining({
        entity: 'session',
        entityId: 's1',
        fromStatus: 'running',
        toStatus: 'idle',
        source: 'session-abort',
      }),
    ]);
  });

  it('records no move for a chat already idle', async () => {
    updateReturning.mockResolvedValueOnce([{ id: 's1', kind: 'chat', status: 'idle' }]);
    await endChatTurn(row('chat', 'idle'), ACTOR);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
